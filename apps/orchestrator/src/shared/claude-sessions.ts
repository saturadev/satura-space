import type { Tab } from './types'
import { isResumableSessionId } from './agent-catalog'

export const CLAUDE_AGENT_ID = 'claude'

export interface ClaudeSessionSummary {
  id: string
  title: string
  updatedAt: number
  projectPath: string
}

export interface ClaudeSessionRef {
  projectPath: string
  sessionId: string
}

export type LaunchRestoreKind = 'update' | 'normal'

export interface LaunchRestoreInfo {
  kind: LaunchRestoreKind
  livePtyIds: string[]
}

export interface ClaudeSessionEvent {
  id: string
  sessionId: string
  event: string
  source: string
}

const SLUG_MAX = 200

function javaStringHash(value: string): number {
  let h = 0
  for (let i = 0; i < value.length; i++) h = ((h << 5) - h + value.charCodeAt(i)) | 0
  return h
}

export function claudeProjectSlug(projectPath: string): string {
  const slug = projectPath.replace(/[^a-zA-Z0-9]/g, '-')
  if (slug.length <= SLUG_MAX) return slug
  return `${slug.slice(0, SLUG_MAX)}-${Math.abs(javaStringHash(projectPath)).toString(36)}`
}

export function claudeProjectSlugPrefix(projectPath: string): string | null {
  const slug = projectPath.replace(/[^a-zA-Z0-9]/g, '-')
  return slug.length > SLUG_MAX ? `${slug.slice(0, SLUG_MAX)}-` : null
}

export interface ClaudeSessionTrack {
  sessionId: string | null
  live: boolean
  inTool: boolean
  nested: string[]
}

const TOOL_SETTLED = new Set([
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'StopFailure',
  'UserPromptSubmit'
])

const NESTED_MEMORY = 8

export function initialClaudeSessionTrack(sessionId: string | null | undefined): ClaudeSessionTrack {
  return {
    sessionId: isResumableSessionId(sessionId) ? sessionId : null,
    live: false,
    inTool: false,
    nested: []
  }
}

export function nextClaudeSessionTrack(
  cur: ClaudeSessionTrack,
  ev: { sessionId: string; event: string; source?: string }
): ClaudeSessionTrack {
  const id = ev.sessionId
  if (!isResumableSessionId(id)) return cur
  if (cur.nested.includes(id)) {
    return ev.event === 'SessionEnd' ? { ...cur, nested: cur.nested.filter((n) => n !== id) } : cur
  }
  if (ev.event === 'SessionStart') {
    const nestedStart =
      (ev.source ?? 'startup') === 'startup' &&
      cur.live &&
      cur.inTool &&
      cur.sessionId !== null &&
      cur.sessionId !== id
    if (nestedStart) return { ...cur, nested: [...cur.nested, id].slice(-NESTED_MEMORY) }
    return { sessionId: id, live: true, inTool: false, nested: cur.nested }
  }
  if (ev.event === 'SessionEnd') {
    return id === cur.sessionId ? { ...cur, live: false, inTool: false } : cur
  }
  if (id !== cur.sessionId) {
    if (cur.live && cur.sessionId) return cur
    return { sessionId: id, live: true, inTool: ev.event === 'PreToolUse', nested: cur.nested }
  }
  const inTool =
    ev.event === 'PreToolUse' ? true : TOOL_SETTLED.has(ev.event) ? false : cur.inTool
  return { ...cur, live: true, inTool }
}

export interface RestoreCandidate {
  workspaceId: string
  tabId: string
  ptyId: string
  sessionId: string
  projectPath: string
}

export function isClaudeTerminalTab(tab: Tab): boolean {
  return tab.contentType === 'terminal' && tab.agentId === CLAUDE_AGENT_ID
}

export function claudeRestoreCandidates(input: {
  tabs: readonly { workspaceId: string; tab: Tab }[]
  cwdOf: (workspaceId: string, tab: Tab) => string
  exitedPtyIds: readonly string[]
  livePtyIds: readonly string[]
}): RestoreCandidate[] {
  const exited = new Set(input.exitedPtyIds)
  const live = new Set(input.livePtyIds)
  const out: RestoreCandidate[] = []
  for (const { workspaceId, tab } of input.tabs) {
    if (!isClaudeTerminalTab(tab)) continue
    if (!isResumableSessionId(tab.claudeSessionId)) continue
    if (exited.has(tab.ptyId) || live.has(tab.ptyId)) continue
    const projectPath = input.cwdOf(workspaceId, tab)
    if (!projectPath) continue
    out.push({ workspaceId, tabId: tab.id, ptyId: tab.ptyId, sessionId: tab.claudeSessionId, projectPath })
  }
  return out
}

export interface ProjectRestorePlan {
  workspaceId: string
  open: RestoreCandidate[]
}

export type LaunchRestorePlan =
  | { mode: 'none' }
  | { mode: 'auto'; resume: RestoreCandidate[] }
  | { mode: 'ask'; projects: ProjectRestorePlan[] }

export function splitRestoreByProject(candidates: readonly RestoreCandidate[]): ProjectRestorePlan[] {
  const byProject = new Map<string, RestoreCandidate[]>()
  for (const c of candidates) {
    const list = byProject.get(c.workspaceId)
    if (list) list.push(c)
    else byProject.set(c.workspaceId, [c])
  }
  return [...byProject].map(([workspaceId, open]) => ({ workspaceId, open }))
}

export function planLaunchRestore(
  kind: LaunchRestoreKind | null,
  resumable: RestoreCandidate[]
): LaunchRestorePlan {
  if (!kind || resumable.length === 0) return { mode: 'none' }
  if (kind === 'update') return { mode: 'auto', resume: resumable }
  return { mode: 'ask', projects: splitRestoreByProject(resumable) }
}

export function openRowKey(candidate: { ptyId: string }): string {
  return `tab:${candidate.ptyId}`
}

export function otherRowKey(sessionId: string): string {
  return `session:${sessionId}`
}

export interface RestoreOutcome {
  resume: RestoreCandidate[]
  close: RestoreCandidate[]
  open: string[]
}

export function resolveRestoreChoice(
  open: readonly RestoreCandidate[],
  other: readonly string[],
  choice: { restore: boolean; checked: ReadonlySet<string> }
): RestoreOutcome {
  if (!choice.restore) return { resume: [], close: [...open], open: [] }
  const openIds = new Set(open.map((c) => c.sessionId))
  return {
    resume: open.filter((c) => choice.checked.has(openRowKey(c))),
    close: open.filter((c) => !choice.checked.has(openRowKey(c))),
    open: other.filter((id) => choice.checked.has(otherRowKey(id)) && !openIds.has(id))
  }
}

export interface ClaudeRestoreRow {
  key: string
  sessionId: string
  title: string
  updatedAt: number
  hint: string
}

export interface ClaudeRestorePromptState {
  id: string
  workspaceId: string
  projectName: string
  open: ClaudeRestoreRow[]
  other: ClaudeRestoreRow[]
  checked: string[]
}

export const RESTORE_OPEN_LABEL = 'Tabs open before Satura closed'
export const RESTORE_OTHER_LABEL = 'Other recent sessions'
export const RESTORE_NOTE = 'Checked sessions resume. Unchecked tabs close.'

const RESTORE_PROMPTS_MAX = 32
const RESTORE_ROWS_MAX = 64

function shortText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function restoreRows(raw: unknown): ClaudeRestoreRow[] {
  if (!Array.isArray(raw)) return []
  const out: ClaudeRestoreRow[] = []
  for (const r of raw.slice(0, RESTORE_ROWS_MAX)) {
    const row = (r ?? {}) as Record<string, unknown>
    const key = shortText(row.key, 200)
    if (!key) continue
    out.push({
      key,
      sessionId: shortText(row.sessionId, 128),
      title: shortText(row.title, 200),
      updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
      hint: shortText(row.hint, 200)
    })
  }
  return out
}

export function cleanRestorePrompts(raw: unknown): ClaudeRestorePromptState[] {
  if (!Array.isArray(raw)) return []
  const out: ClaudeRestorePromptState[] = []
  for (const p of raw.slice(0, RESTORE_PROMPTS_MAX)) {
    const prompt = (p ?? {}) as Record<string, unknown>
    const id = shortText(prompt.id, 100)
    const workspaceId = shortText(prompt.workspaceId, 100)
    if (!id || !workspaceId) continue
    const open = restoreRows(prompt.open)
    const other = restoreRows(prompt.other)
    const keys = new Set([...open, ...other].map((r) => r.key))
    const checked = Array.isArray(prompt.checked) ? prompt.checked.filter((k): k is string => typeof k === 'string' && keys.has(k)) : []
    out.push({ id, workspaceId, projectName: shortText(prompt.projectName, 200), open, other, checked: [...new Set(checked)] })
  }
  return out
}

export function describeRestorePrompts(list: readonly ClaudeRestorePromptState[]): string {
  if (!list.length) return 'none'
  return list.map((p) => `${p.projectName || p.workspaceId} (${p.open.length} tab(s), ${p.other.length} other, ${p.checked.length} checked)`).join(', ')
}
