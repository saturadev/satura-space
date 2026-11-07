import { create } from 'zustand'
import {
  buildAgentLaunchCommand,
  buildAgentResumeCommand,
  getAgentEntry,
  isResumableSessionId
} from '@shared/agent-catalog'
import {
  CLAUDE_AGENT_ID,
  claudeRestoreCandidates,
  isClaudeTerminalTab,
  openRowKey,
  otherRowKey,
  planLaunchRestore,
  resolveRestoreChoice,
  type ClaudeRestorePromptState,
  type ClaudeSessionSummary,
  type RestoreCandidate
} from '@shared/claude-sessions'
import type { Tab } from '@shared/types'
import { useAppStore, type AppState } from '../../store'
import { agentRelaunchCommandFor } from '../terminal/agent-relaunch'
import { setPendingCommand } from '../terminal/pending-commands'
import { forgetClaudeSessionTrack } from './session-tracking'
import { censusTrack } from '@shared/census'
import { debugLog } from '@shared/debug-log'

const OTHER_LIMIT = 6
const PICK_LIMIT = 20
const SETTINGS_WAIT_MS = 3000
const LIST_WAIT_MS = 2000

export interface ClaudeSessionRow {
  key: string
  sessionId: string
  title: string
  updatedAt: number
  hint: string
  open?: boolean
}

export interface ClaudePickTarget {
  workspaceId: string
  groupId: string
  worktreeId: string
  projectPath: string
}

export interface ClaudePicker {
  loading: boolean
  rows: ClaudeSessionRow[]
  target: ClaudePickTarget
}

export const useClaudePickerStore = create<{ picker: ClaudePicker | null }>()(() => ({
  picker: null
}))

export type ClaudeRestorePrompt = ClaudeRestorePromptState

export type RestoreSource = 'desktop' | 'phone'

export interface RestoreAnswerResult {
  resume: number
  close: number
  open: number
}

export const useClaudeRestoreStore = create<{ prompts: Record<string, ClaudeRestorePrompt> }>()(
  () => ({ prompts: {} })
)

type Decision = { kind: 'resume'; sessionId: string } | { kind: 'fresh' } | { kind: 'none' }

interface Held {
  promise: Promise<Decision>
  resolve: (decision: Decision) => void
}

interface PendingProject {
  workspaceId: string
  open: RestoreCandidate[]
  others: ClaudeSessionSummary[]
}

let gate: Promise<void> = Promise.resolve()
const autoResume = new Map<string, string>()
censusTrack('launch-restore.autoResume', autoResume)
const held = new Map<string, Held>()
censusTrack('launch-restore.held', held)
const relaunchedHere = new Set<string>()
censusTrack('launch-restore.relaunchedHere', relaunchedHere)
const pendingProjects = new Map<string, PendingProject>()
censusTrack('launch-restore.pendingProjects', pendingProjects)

function hold(): Held {
  let resolve: (decision: Decision) => void = () => {}
  const promise = new Promise<Decision>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function setPrompt(workspaceId: string, prompt: ClaudeRestorePrompt | null): void {
  useClaudeRestoreStore.setState((s) => {
    const prompts = { ...s.prompts }
    if (prompt) prompts[workspaceId] = prompt
    else delete prompts[workspaceId]
    return { prompts }
  })
}

function allTabs(s: AppState): { workspaceId: string; tab: Tab }[] {
  const out: { workspaceId: string; tab: Tab }[] = []
  for (const [workspaceId, tabs] of Object.entries(s.tabsByWorkspace)) {
    for (const tab of tabs) out.push({ workspaceId, tab })
  }
  return out
}

function locate(ptyId: string): { workspaceId: string; tab: Tab } | null {
  return allTabs(useAppStore.getState()).find((e) => e.tab.ptyId === ptyId) ?? null
}

function tabCwd(s: AppState, workspaceId: string, tab: Tab): string {
  return (s.worktreesByWorkspace[workspaceId] ?? []).find((w) => w.id === tab.worktreeId)?.path ?? ''
}

function projectName(s: AppState, workspaceId: string): string {
  return s.workspaces.find((w) => w.id === workspaceId)?.name ?? ''
}

function projectFolders(s: AppState, workspaceId: string): string[] {
  const paths = (s.worktreesByWorkspace[workspaceId] ?? []).map((w) => w.path)
  const workspace = s.workspaces.find((w) => w.id === workspaceId)
  if (workspace?.worktreePath) paths.push(workspace.worktreePath)
  return [...new Set(paths.filter(Boolean))]
}

function claudeConfigDir(): string | undefined {
  return useAppStore.getState().settings?.agents[CLAUDE_AGENT_ID]?.env?.CLAUDE_CONFIG_DIR || undefined
}

function whenSettingsLoaded(): Promise<void> {
  if (useAppStore.getState().settings) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe()
      resolve()
    }, SETTINGS_WAIT_MS)
    const unsubscribe = useAppStore.subscribe((s) => {
      if (!s.settings) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ])
}

export function claudeResumeCommand(sessionId: string): string | null {
  const entry = getAgentEntry(CLAUDE_AGENT_ID)
  if (!entry) return null
  return buildAgentResumeCommand(
    entry,
    useAppStore.getState().settings?.agents[CLAUDE_AGENT_ID],
    sessionId
  )
}

export function heldPtyIds(): string[] {
  return [...held.keys()]
}

export function pickTargetFor(workspaceId: string, projectPath?: string): ClaudePickTarget | null {
  const s = useAppStore.getState()
  const workspace = s.workspaces.find((w) => w.id === workspaceId)
  if (!workspace) return null
  const groups = s.groupsByWorkspace[workspaceId] ?? []
  const groupId =
    groups.find((g) => g.id === s.activeGroupIdByWorkspace[workspaceId])?.id ??
    s.ensureWorkbench(workspaceId)
  const group = (useAppStore.getState().groupsByWorkspace[workspaceId] ?? []).find(
    (g) => g.id === groupId
  )
  const tabs = s.tabsByWorkspace[workspaceId] ?? []
  const activeTab = tabs.find((t) => t.id === group?.activeTabId)
  const worktrees = s.worktreesByWorkspace[workspaceId] ?? []
  const worktree =
    (projectPath ? worktrees.find((w) => w.path === projectPath) : undefined) ??
    worktrees.find((w) => w.id === activeTab?.worktreeId) ??
    worktrees.find((w) => w.path === workspace.worktreePath) ??
    worktrees[0]
  if (!worktree?.path) return null
  return { workspaceId, groupId, worktreeId: worktree.id, projectPath: worktree.path }
}

function openSessionIds(): string[] {
  const ids: string[] = []
  for (const { tab } of allTabs(useAppStore.getState())) {
    if (isClaudeTerminalTab(tab) && tab.claudeSessionId) ids.push(tab.claudeSessionId)
  }
  return ids
}

function toRow(key: string, summary: ClaudeSessionSummary, hint = ''): ClaudeSessionRow {
  return { key, sessionId: summary.id, title: summary.title, updatedAt: summary.updatedAt, hint }
}

function openRowHints(candidates: RestoreCandidate[]): string[] {
  const s = useAppStore.getState()
  const located = candidates.map((c) => locate(c.ptyId))
  const worktreeIds = new Set(located.map((l) => l?.tab.worktreeId ?? ''))
  return located.map((l) => {
    if (!l) return ''
    const parts: string[] = []
    if (worktreeIds.size > 1) {
      parts.push(
        (s.worktreesByWorkspace[l.workspaceId] ?? []).find((w) => w.id === l.tab.worktreeId)?.name ?? ''
      )
    }
    if (l.tab.customLabel) parts.push(l.tab.customLabel)
    return parts.filter(Boolean).join(' · ')
  })
}

async function listProjectSessions(
  folders: string[],
  exclude: string[],
  limit: number,
  configDir: string | undefined
): Promise<ClaudeSessionSummary[]> {
  const lists = await Promise.all(
    folders.map((projectPath) =>
      withTimeout(
        window.api.claudeSessions.list({ projectPath, limit, exclude, configDir }),
        LIST_WAIT_MS,
        [] as ClaudeSessionSummary[]
      )
    )
  )
  const seen = new Set<string>()
  return lists
    .flat()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((o) => {
      if (seen.has(o.id)) return false
      seen.add(o.id)
      return true
    })
    .slice(0, limit)
}

async function runLaunchRestore(restoreId: string): Promise<void> {
  const info = await window.api.session.launchRestore(restoreId)
  if (!info) return
  await whenSettingsLoaded()
  const s = useAppStore.getState()
  const candidates = claudeRestoreCandidates({
    tabs: allTabs(s),
    cwdOf: (workspaceId, tab) => tabCwd(s, workspaceId, tab),
    exitedPtyIds: s.exitedPtyIds,
    livePtyIds: info.livePtyIds
  })
  if (candidates.length === 0) {
    console.log(`[claude-resume] launch restore (${info.kind}): no Claude tabs to resume`)
    return
  }
  const configDir = claudeConfigDir()
  const described = await window.api.claudeSessions.describe({
    items: candidates.map((c) => ({ projectPath: c.projectPath, sessionId: c.sessionId })),
    configDir
  })
  const summaries = new Map<string, ClaudeSessionSummary>()
  const resumable = candidates.filter((c, i) => {
    const summary = described[i]
    if (summary) summaries.set(c.ptyId, summary)
    return Boolean(summary)
  })
  const plan = planLaunchRestore(info.kind, resumable)
  console.log(
    `[claude-resume] launch restore (${info.kind}): ${candidates.length} Claude tab(s), ${resumable.length} resumable, plan=${plan.mode}`
  )
  if (plan.mode === 'auto') {
    for (const c of plan.resume) autoResume.set(c.ptyId, c.sessionId)
    return
  }
  if (plan.mode !== 'ask') return
  for (const project of plan.projects) {
    for (const c of project.open) held.set(c.ptyId, hold())
    pendingProjects.set(project.workspaceId, { workspaceId: project.workspaceId, open: project.open, others: [] })
    debugLog(
      `[claude-resume] project ${project.workspaceId} (${projectName(s, project.workspaceId)}) holds ${project.open.length} session(s): ${project.open.map((c) => c.sessionId).join(' ')}`
    )
  }
  for (const project of plan.projects) void presentProjectPrompt(project.workspaceId, summaries, configDir)
}

async function presentProjectPrompt(
  workspaceId: string,
  summaries: Map<string, ClaudeSessionSummary>,
  configDir: string | undefined
): Promise<void> {
  const others = await listProjectSessions(
    projectFolders(useAppStore.getState(), workspaceId),
    openSessionIds(),
    OTHER_LIMIT,
    configDir
  )
  const entry = pendingProjects.get(workspaceId)
  if (!entry) return
  entry.others = others
  const open = entry.open.filter((c) => held.has(c.ptyId))
  const hints = openRowHints(open)
  const openRows: ClaudeSessionRow[] = []
  open.forEach((c, i) => {
    const summary = summaries.get(c.ptyId)
    if (summary) openRows.push(toRow(openRowKey(c), summary, hints[i]))
  })
  if (openRows.length === 0) {
    pendingProjects.delete(workspaceId)
    return
  }
  const name = projectName(useAppStore.getState(), workspaceId)
  setPrompt(workspaceId, {
    id: `${workspaceId}:${Date.now().toString(36)}`,
    workspaceId,
    projectName: name,
    open: openRows,
    other: others.map((o) => toRow(otherRowKey(o.id), o)),
    checked: openRows.map((r) => r.key)
  })
  console.log(
    `[claude-resume] project ${workspaceId} (${name}) asks which Claude sessions to restore: ${openRows.length} tab(s), ${others.length} other recent session(s)`
  )
}

export function beginLaunchRestore(restoreId: string): void {
  gate = runLaunchRestore(restoreId).catch((err) => {
    console.error('[claude-resume] launch restore failed', err)
    releaseHeld()
  })
}

function releaseHeld(): void {
  for (const h of held.values()) h.resolve({ kind: 'fresh' })
  held.clear()
  pendingProjects.clear()
  useClaudeRestoreStore.setState({ prompts: {} })
}

export function markPtyAttached(ptyId: string): void {
  if (relaunchedHere.has(ptyId)) return
  autoResume.delete(ptyId)
  const h = held.get(ptyId)
  if (!h) return
  h.resolve({ kind: 'none' })
  held.delete(ptyId)
  for (const entry of pendingProjects.values()) {
    if (!entry.open.some((c) => c.ptyId === ptyId)) continue
    entry.open = entry.open.filter((c) => c.ptyId !== ptyId)
    const prompt = useClaudeRestoreStore.getState().prompts[entry.workspaceId]
    if (!prompt) return
    const gone = openRowKey({ ptyId })
    const open = prompt.open.filter((r) => r.key !== gone)
    if (open.length > 0) {
      setPrompt(entry.workspaceId, { ...prompt, open, checked: prompt.checked.filter((k) => k !== gone) })
      return
    }
    pendingProjects.delete(entry.workspaceId)
    setPrompt(entry.workspaceId, null)
    return
  }
}

async function resumeInPlace(ptyId: string, sessionId: string): Promise<string | null> {
  await whenSettingsLoaded()
  const located = locate(ptyId)
  if (!located) return null
  const command = claudeResumeCommand(sessionId)
  if (!command) return agentRelaunchCommandFor(ptyId)
  forgetClaudeSessionTrack(ptyId)
  console.log(
    `[claude-resume] resuming session ${sessionId} in tab ${located.tab.id} (pty ${ptyId}): ${command}`
  )
  return command
}

export async function resolveAgentRelaunch(ptyId: string): Promise<string | null> {
  relaunchedHere.add(ptyId)
  await gate
  const auto = autoResume.get(ptyId)
  if (auto) {
    autoResume.delete(ptyId)
    return resumeInPlace(ptyId, auto)
  }
  const h = held.get(ptyId)
  if (h) {
    const decision = await h.promise
    held.delete(ptyId)
    if (decision.kind === 'none') return null
    if (decision.kind === 'resume') return resumeInPlace(ptyId, decision.sessionId)
  }
  return agentRelaunchCommandFor(ptyId)
}

export function openClaudeSessionTab(target: ClaudePickTarget, sessionId: string): Tab | null {
  if (!isResumableSessionId(sessionId)) return null
  const entry = getAgentEntry(CLAUDE_AGENT_ID)
  const command = claudeResumeCommand(sessionId)
  if (!entry || !command) return null
  const s = useAppStore.getState()
  const groups = s.groupsByWorkspace[target.workspaceId] ?? []
  const groupId = groups.some((g) => g.id === target.groupId)
    ? target.groupId
    : s.ensureWorkbench(target.workspaceId)
  const tab = s.createTab(target.workspaceId, target.worktreeId, {
    groupId,
    label: entry.label,
    agentId: CLAUDE_AGENT_ID,
    claudeSessionId: sessionId
  })
  setPendingCommand(tab.ptyId, command)
  debugLog(`[claude-resume] opening session ${sessionId} in new tab ${tab.id}: ${command}`)
  return tab
}

export function applyRestoreChoice(
  workspaceId: string,
  choice: { restore: boolean; checked: ReadonlySet<string> },
  from: RestoreSource = 'desktop'
): RestoreAnswerResult | null {
  const entry = pendingProjects.get(workspaceId)
  if (!entry) return null
  pendingProjects.delete(workspaceId)
  setPrompt(workspaceId, null)
  const outcome = resolveRestoreChoice(
    entry.open,
    entry.others.map((o) => o.id),
    choice
  )
  console.log(
    `[claude-resume] project ${workspaceId} ${choice.restore ? 'restore' : 'skip'} (answered on the ${from}): resume ${outcome.resume.length}, close ${outcome.close.length}, open ${outcome.open.length}`
  )
  for (const c of outcome.resume) held.get(c.ptyId)?.resolve({ kind: 'resume', sessionId: c.sessionId })
  for (const c of outcome.close) {
    held.get(c.ptyId)?.resolve({ kind: 'none' })
    held.delete(c.ptyId)
    const located = locate(c.ptyId)
    if (located) useAppStore.getState().closeTab(located.tab.id)
  }
  for (const sessionId of outcome.open) {
    const summary = entry.others.find((o) => o.id === sessionId)
    const target = pickTargetFor(workspaceId, summary?.projectPath)
    if (target) openClaudeSessionTab(target, sessionId)
  }
  return { resume: outcome.resume.length, close: outcome.close.length, open: outcome.open.length }
}

export function skipRestore(workspaceId: string): void {
  applyRestoreChoice(workspaceId, { restore: false, checked: new Set() })
}

function livePrompt(workspaceId: string, promptId?: string): ClaudeRestorePrompt {
  const prompt = useClaudeRestoreStore.getState().prompts[workspaceId]
  if (!prompt || !pendingProjects.has(workspaceId) || (promptId && prompt.id !== promptId))
    throw new Error('This question was already answered')
  return prompt
}

export function setRestoreRow(
  workspaceId: string,
  key: string,
  on: boolean,
  from: RestoreSource = 'desktop',
  promptId?: string
): ClaudeRestorePrompt {
  const prompt = livePrompt(workspaceId, promptId)
  const rows = [...prompt.open, ...prompt.other]
  if (!rows.some((r) => r.key === key)) throw new Error('That session is no longer in the list')
  if (prompt.checked.includes(key) === on) return prompt
  const checked = rows.map((r) => r.key).filter((k) => (k === key ? on : prompt.checked.includes(k)))
  const next = { ...prompt, checked }
  setPrompt(workspaceId, next)
  console.log(
    `[claude-resume] ${from} ${on ? 'checked' : 'unchecked'} ${key} in the restore prompt of ${workspaceId}: ${checked.length} of ${rows.length} checked`
  )
  return next
}

export function answerRestore(
  workspaceId: string,
  promptId: string,
  restore: boolean,
  checked: readonly string[],
  from: RestoreSource
): RestoreAnswerResult {
  const prompt = livePrompt(workspaceId, promptId)
  const keys = new Set([...prompt.open, ...prompt.other].map((r) => r.key))
  const result = applyRestoreChoice(
    workspaceId,
    { restore, checked: new Set(checked.filter((k) => keys.has(k))) },
    from
  )
  if (!result) throw new Error('This question was already answered')
  return result
}

export function syncRestorePromptsToPhones(): () => void {
  let sent = ''
  const push = (prompts: Record<string, ClaudeRestorePrompt>): void => {
    const list = Object.values(prompts)
    const text = JSON.stringify(list)
    if (text === sent) return
    sent = text
    window.api.remote.setRestorePrompts(list)
  }
  push(useClaudeRestoreStore.getState().prompts)
  return useClaudeRestoreStore.subscribe((s) => push(s.prompts))
}

function openTabForSession(sessionId: string): { workspaceId: string; tab: Tab } | null {
  return (
    allTabs(useAppStore.getState()).find(
      (e) => isClaudeTerminalTab(e.tab) && e.tab.claudeSessionId === sessionId
    ) ?? null
  )
}

function pickerRow(summary: ClaudeSessionSummary): ClaudeSessionRow {
  const open = openTabForSession(summary.id)
  const label = open ? open.tab.customLabel || 'Open in a tab' : ''
  return { ...toRow(otherRowKey(summary.id), summary, label), open: Boolean(open) }
}

export function openClaudeSessionPicker(target: ClaudePickTarget): void {
  useClaudePickerStore.setState({ picker: { loading: true, rows: [], target } })
  void window.api.claudeSessions
    .list({
      projectPath: target.projectPath,
      limit: PICK_LIMIT,
      exclude: [],
      configDir: claudeConfigDir()
    })
    .catch(() => [] as ClaudeSessionSummary[])
    .then((sessions) => {
      const picker = useClaudePickerStore.getState().picker
      if (!picker || picker.target !== target) return
      const rows = sessions.map(pickerRow)
      rows.sort((a, b) => Number(Boolean(b.open)) - Number(Boolean(a.open)))
      useClaudePickerStore.setState({ picker: { ...picker, loading: false, rows } })
    })
}

export function pickClaudeSession(sessionId: string): void {
  const picker = useClaudePickerStore.getState().picker
  if (!picker) return
  useClaudePickerStore.setState({ picker: null })
  const open = openTabForSession(sessionId)
  if (open) {
    const s = useAppStore.getState()
    if (s.activeWorkspaceId !== open.workspaceId) s.setActiveWorkspace(open.workspaceId)
    s.activateTab(open.tab.id)
    return
  }
  openClaudeSessionTab(picker.target, sessionId)
}

export function dismissClaudePicker(): void {
  if (useClaudePickerStore.getState().picker) useClaudePickerStore.setState({ picker: null })
}

export function canRestartAgentTab(tab: Tab): boolean {
  return tab.contentType === 'terminal' && Boolean(tab.agentId && getAgentEntry(tab.agentId))
}

export function restartAgentTab(tabId: string): void {
  const s = useAppStore.getState()
  const tab = allTabs(s).find((e) => e.tab.id === tabId)?.tab
  if (!tab || !canRestartAgentTab(tab) || !tab.agentId) return
  const entry = getAgentEntry(tab.agentId)
  if (!entry) return
  const sessionId = isClaudeTerminalTab(tab) && tab.claudeSessionId && isResumableSessionId(tab.claudeSessionId)
    ? tab.claudeSessionId
    : null
  const command = sessionId
    ? claudeResumeCommand(sessionId)
    : buildAgentLaunchCommand(entry, s.settings?.agents[tab.agentId])
  const oldPtyId = tab.ptyId
  forgetClaudeSessionTrack(oldPtyId)
  autoResume.delete(oldPtyId)
  held.get(oldPtyId)?.resolve({ kind: 'none' })
  held.delete(oldPtyId)
  void window.api.pty.kill(oldPtyId)
  const ptyId = useAppStore.getState().replaceTabPty(tabId)
  if (!ptyId) return
  if (command) setPendingCommand(ptyId, command)
  console.log(`[claude-resume] restarted tab ${tabId} (pty ${oldPtyId} -> ${ptyId}): ${command ?? 'shell'}`)
}
