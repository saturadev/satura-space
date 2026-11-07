import { powerMonitor } from 'electron'
import { basename, dirname } from 'node:path'
import type { Tab, TabContentType } from '@shared/types'
import type { WorkspaceState } from '@shared/api'
import type { PushLink } from '@shared/remote-push'
import { censusTrack } from '@shared/census'
import { listSessionWindows } from '../session-registry'
import { insideRoot } from '../open-roots'
import { worldStore } from '../unity/world-store'
import { readTunerView } from '../unity/tuner-view'
import { activityPut, activitySettle, notify, resolvePush, type PushWhere } from './phone-push'

const MAC_ACTIVE_S = 60
const TUNER_TAB_WAIT_MS = 6000
const UNITY_REPEAT_MS = 20_000

interface Found {
  workspaceId: string
  workspaceTitle: string
  tab: Tab | null
}

function spaces(): WorkspaceState[] {
  const out: WorkspaceState[] = []
  for (const { snapshot } of listSessionWindows()) if (snapshot.session?.workspace) out.push(snapshot.session.workspace)
  return out
}

function titleOf(ws: WorkspaceState, workspaceId: string): string {
  const w = ws.workspaces.find((x) => x.id === workspaceId)
  if (!w) return ''
  return w.name || basename(w.worktreePath || w.folderPath || '') || ''
}

function tabLabel(t: Tab): string {
  return (t.customLabel || t.generatedLabel || t.label || '').replace(/^[^\p{L}\p{N}]+/u, '').trim()
}

function findPty(ptyId: string): Found | null {
  for (const ws of spaces())
    for (const [workspaceId, tabs] of Object.entries(ws.tabsByWorkspace ?? {})) {
      const tab = (tabs ?? []).find((t) => t.ptyId === ptyId)
      if (tab) return { workspaceId, workspaceTitle: titleOf(ws, workspaceId), tab }
    }
  return null
}

function findProject(projectPath: string): { ws: WorkspaceState; workspaceId: string; worktreeId: string | null } | null {
  let best: { ws: WorkspaceState; workspaceId: string; worktreeId: string | null; len: number } | null = null
  for (const ws of spaces()) {
    for (const w of ws.workspaces ?? []) {
      const trees = ws.worktreesByWorkspace?.[w.id] ?? []
      for (const t of trees)
        if (t.path && insideRoot(t.path, projectPath) && (!best || t.path.length > best.len)) best = { ws, workspaceId: w.id, worktreeId: t.id, len: t.path.length }
      const root = w.worktreePath || w.folderPath || ''
      if (root && insideRoot(root, projectPath) && (!best || root.length > best.len)) best = { ws, workspaceId: w.id, worktreeId: null, len: root.length }
    }
  }
  return best
}

function tabOf(ws: WorkspaceState, workspaceId: string, kind: TabContentType, worktreeId: string | null, also?: (t: Tab) => boolean): Tab | null {
  const tabs = (ws.tabsByWorkspace?.[workspaceId] ?? []).filter((t) => t.contentType === kind && (!also || also(t)))
  return tabs.find((t) => !worktreeId || t.worktreeId === worktreeId) ?? tabs[0] ?? null
}

function projectName(projectPath: string): string {
  return basename(projectPath.replace(/[\\/]+$/, '')) || projectPath
}

function macInUse(): boolean {
  try {
    return powerMonitor.getSystemIdleState(MAC_ACTIVE_S) === 'active'
  } catch {
    return false
  }
}

export interface AgentForPhone {
  kind: 'finished' | 'needs-you'
  pane: string
  agent: string
  status: string
  detail: string
  label: string
  workspace: string
  blocked: string
  failed: boolean
}

export function agentToPhone(n: AgentForPhone): void {
  if (n.blocked === 'not an agent terminal') return
  const hold = n.blocked.startsWith('repeat within') || (n.blocked === 'its tab is visible in the focused window' && macInUse()) ? n.blocked : ''
  const found = findPty(n.pane)
  const label = (found?.tab ? tabLabel(found.tab) : '') || n.label || n.agent
  const workspace = found?.workspaceTitle || n.workspace
  const where: PushWhere | null = found?.tab ? { workspaceId: found.workspaceId, tabId: found.tab.id } : null
  const link: PushLink = { kind: 'agent', ptyId: n.pane, ...(where ? { workspaceId: where.workspaceId, tabId: where.tabId ?? undefined } : {}) }
  const detail = n.detail || (n.kind === 'needs-you' ? `${n.agent} is waiting for you.` : `${n.agent} ${n.failed ? 'stopped with an error' : 'finished its turn'}.`)
  notify({
    cat: n.kind === 'needs-you' ? 'ask' : 'finished',
    tag: `agent:${n.pane}`,
    title: `${label} ${n.status}`,
    body: workspace ? `${workspace}: ${detail}` : detail,
    link,
    where,
    loud: n.kind === 'needs-you',
    urgency: n.kind === 'needs-you' ? 'high' : 'normal',
    who: label,
    hold
  })
}

export function agentSeen(pane: string, why: string): void {
  resolvePush(`agent:${pane}`, why)
}

export function agentSettled(pane: string, word: string): void {
  activitySettle(`agent:${pane}`, word)
}

export function reportOpened(file: string, paneKey: string, projectRoot: string): void {
  const from = paneKey ? findPty(paneKey) : null
  const p = findProject(projectRoot || dirname(file))
  const workspace = (p ? titleOf(p.ws, p.workspaceId) : '') || from?.workspaceTitle || projectName(projectRoot || dirname(file))
  const name = /^report\.[jt]sx?$/i.test(basename(file)) ? basename(dirname(file)) : basename(file)
  activityPut({ id: `report:${file}`, kind: 'report', title: 'Report ready', body: `${name} in ${workspace}`, at: Date.now(), link: { kind: 'report', file, projectPath: projectRoot || dirname(file), ...(p || from ? { workspaceId: p?.workspaceId ?? from?.workspaceId } : {}) } }, 'Report')
}

const tunerTimers = new Set<NodeJS.Timeout>()
censusTrack('remote.pushTunerTimers', tunerTimers)

function tunerTab(projectPath: string, view: string): { where: PushWhere | null; title: string } {
  const p = findProject(projectPath)
  if (!p) return { where: null, title: '' }
  const tab = tabOf(p.ws, p.workspaceId, 'tuner', null, (t) => t.tuner?.filter === view || (!t.tuner?.filter && t.tuner?.id === view))
  return { where: { workspaceId: p.workspaceId, tabId: tab?.id ?? null }, title: titleOf(p.ws, p.workspaceId) }
}

export function tunerHandedOff(req: { projectPath: string; view: string; paneKey?: string }): void {
  const paneKey = String(req.paneKey ?? '')
  if (!paneKey || !req.view) return
  const from = findPty(paneKey)
  const label = (from?.tab ? tabLabel(from.tab) : '') || 'An agent'
  let note = ''
  try {
    note = readTunerView(req.projectPath, req.view)?.note ?? ''
  } catch {
  }
  const started = Date.now()
  const send = (): void => {
    const found = tunerTab(req.projectPath, req.view)
    if (!found.where?.tabId && Date.now() - started < TUNER_TAB_WAIT_MS) {
      const t = setTimeout(() => {
        tunerTimers.delete(t)
        send()
      }, 300)
      tunerTimers.add(t)
      return
    }
    const where = found.where ?? (from ? { workspaceId: from.workspaceId, tabId: null } : null)
    const link: PushLink = { kind: 'tuner', projectPath: req.projectPath, view: req.view, ...(where ? { workspaceId: where.workspaceId, ...(where.tabId ? { tabId: where.tabId } : {}) } : {}) }
    const workspace = found.title || from?.workspaceTitle || projectName(req.projectPath)
    notify({ cat: 'tuner', tag: `tuner:${req.projectPath}:${req.view}`, title: `${label} handed you a Tuner: ${req.view}`, body: note ? `${workspace}: ${note}` : `${workspace}. Tap to open it.`, link, where: where?.tabId ? where : null, loud: true })
  }
  send()
}

function unityWhere(projectPath: string): { where: PushWhere | null; title: string; link: PushLink } {
  const p = findProject(projectPath)
  if (!p) return { where: null, title: '', link: { kind: 'unity', projectPath } }
  const tab = tabOf(p.ws, p.workspaceId, 'unity-console', p.worktreeId)
  return { where: tab ? { workspaceId: p.workspaceId, tabId: tab.id } : null, title: titleOf(p.ws, p.workspaceId), link: { kind: 'unity', projectPath, workspaceId: p.workspaceId, ...(tab ? { tabId: tab.id } : {}) } }
}

const compileSeen = new Map<string, { state: string; text: string; at: number; refresh: number; broken: boolean }>()
censusTrack('remote.pushCompileSeen', compileSeen)

function firstLines(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n)
    .join('\n')
}

function onObserved(projectPath: string): void {
  const world = worldStore.getWorld(projectPath).observed
  const inst = Object.values(world.instances).find((i) => i.role === 'primary')
  if (!inst) return
  const prev = compileSeen.get(projectPath)
  const text = inst.compileError ?? ''
  const now = { state: inst.compile, text, at: prev?.at ?? 0, refresh: inst.refreshGen, broken: inst.compile === 'error' || (!!prev?.broken && inst.compile !== 'idle') }
  compileSeen.set(projectPath, now)
  while (compileSeen.size > 64) compileSeen.delete(compileSeen.keys().next().value as string)
  if (inst.compile === 'error' && text && (prev?.state !== 'error' || (prev.text !== text && inst.refreshGen > prev.refresh))) {
    if (prev?.text === text && Date.now() - (prev?.at ?? 0) < UNITY_REPEAT_MS) return
    now.at = Date.now()
    const w = unityWhere(projectPath)
    const count = (text.match(/error CS\d+/g) ?? []).length
    notify({
      cat: 'unity',
      tag: `unity:${projectPath}`,
      title: `${count > 1 ? `${count} compile errors` : 'Compile error'} in ${w.title || projectName(projectPath)}`,
      body: firstLines(text, 2),
      link: w.link,
      where: w.where,
      who: `Compile errors in ${w.title || projectName(projectPath)}`
    })
    return
  }
  if (prev?.broken && inst.compile === 'idle') activitySettle(`unity:${projectPath}`, 'fixed')
}

function onPlayBlocked(projectPath: string): void {
  const inst = Object.values(worldStore.getWorld(projectPath).observed.instances).find((i) => i.role === 'primary')
  const w = unityWhere(projectPath)
  const why = firstLines(inst?.compileError ?? '', 1)
  notify({
    cat: 'unity',
    tag: `unity:${projectPath}`,
    title: `Play Mode didn't start in ${w.title || projectName(projectPath)}`,
    body: why ? `Fix the compile errors first. ${why}` : 'Fix the compile errors first.',
    link: w.link,
    where: w.where,
    loud: true,
    who: `Compile errors in ${w.title || projectName(projectPath)}`
  })
}

export function alertFired(a: { project: string; id: string; message: string }): void {
  const p = findProject(a.project)
  const tab = p ? tabOf(p.ws, p.workspaceId, 'dashboard', p.worktreeId) : null
  const where: PushWhere | null = p && tab ? { workspaceId: p.workspaceId, tabId: tab.id } : null
  const link: PushLink = { kind: 'alert', projectPath: a.project, ...(p ? { workspaceId: p.workspaceId } : {}), ...(tab ? { tabId: tab.id } : {}) }
  notify({ cat: 'alert', tag: `alert:${a.project}:${a.id}`, title: `Dashboard alert: ${a.id}`, body: `${p ? titleOf(p.ws, p.workspaceId) || projectName(a.project) : projectName(a.project)}: ${a.message}`, link, where, loud: true })
}

let wired = false

export function registerPushEvents(): void {
  if (wired) return
  wired = true
  worldStore.onObservedChange(onObserved)
  worldStore.onPlayBlocked(onPlayBlocked)
}
