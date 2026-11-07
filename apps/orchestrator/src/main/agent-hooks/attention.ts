import { BrowserWindow, Notification, app, ipcMain, webContents } from 'electron'
import type { AgentHookEvent, AgentHookKind, AgentPaneReport } from '@shared/api'
import { getAgentEntry } from '@shared/agent-catalog'
import { DEFAULT_SETTINGS } from '@shared/types'
import { censusTrack } from '@shared/census'
import { notifyPtyOwner, ptyOwnerWebContentsId, tapPtyExit, tapPtyInput, tapPtyOutput } from '../ipc/pty'
import { loadState } from '../persistence'
import { normalizeHookEvent } from './agent-events'
import { AgentStateMachine, type AgentState, type AgentTransition } from './agent-state'
import { AgentNotifier, type AgentNotificationKind, type AgentPaneInfo } from './agent-notifier'
import { TerminalTitleTracker } from './terminal-title'
import { agentSeen, agentSettled, agentToPhone } from '../remote/push-events'
import { inBackground } from '../window/background'

const KIND: Record<AgentState, AgentHookKind> = { working: 'working', waiting: 'attention', done: 'finished', idle: 'idle' }
const MAX_TRANSITIONS = 100
const SHORT_LABEL: Record<string, string> = { claude: 'Claude', grok: 'Grok', cursor: 'Cursor' }

const machine = new AgentStateMachine()
const titles = new TerminalTitleTracker()
const transitions: (AgentTransition & { via: string })[] = []
const panesByWindow = new Map<number, Map<string, AgentPaneReport>>()
censusTrack('agent-attention.panesByWindow', panesByWindow)
const sent = new Map<string, AgentHookKind>()
censusTrack('agent-attention.sent', sent)
let focusOverride: 'focused' | 'blurred' | null = null
let wired = false

function ownerWindow(ptyId: string): BrowserWindow | null {
  const wcId = ptyOwnerWebContentsId(ptyId)
  const wc = wcId === undefined ? null : webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) return null
  return BrowserWindow.fromWebContents(wc)
}

function paneInfo(ptyId: string): AgentPaneInfo | null {
  const wcId = ptyOwnerWebContentsId(ptyId)
  const own = wcId === undefined ? undefined : panesByWindow.get(wcId)?.get(ptyId)
  if (own) return own
  for (const panes of panesByWindow.values()) {
    const found = panes.get(ptyId)
    if (found) return found
  }
  return null
}

function windowFocused(ptyId: string): boolean {
  if (focusOverride) return focusOverride === 'focused'
  const win = ownerWindow(ptyId)
  return !!win && !win.isDestroyed() && win.isFocused() && win.isVisible() && !win.isMinimized()
}

function enabled(kind: AgentNotificationKind): boolean {
  const s = { ...DEFAULT_SETTINGS, ...loadState().settings }
  return kind === 'finished' ? s.notifyAgentFinished !== false : s.notifyAgentNeedsYou !== false
}

function agentLabel(agentId: string): string {
  return SHORT_LABEL[agentId] ?? getAgentEntry(agentId)?.label ?? (agentId === 'agent' ? 'Agent' : agentId)
}

export function focusAgentPane(ptyId: string, raise = true): boolean {
  const win = ownerWindow(ptyId)
  if (!win || win.isDestroyed()) return false
  if (raise && !inBackground) {
    if (process.platform === 'darwin') app.focus({ steal: true })
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  notifyPtyOwner(ptyId, 'pty:focusAgent', { id: ptyId })
  return true
}

const notifier = new AgentNotifier({
  now: Date.now,
  enabled,
  pane: paneInfo,
  focused: windowFocused,
  state: (ptyId) => machine.state(ptyId),
  agentLabel,
  show: ({ pane, title, subtitle, body }) => {
    if (!Notification.isSupported()) return null
    const n = new Notification({ title, subtitle: subtitle || undefined, body })
    n.on('click', () => {
      console.log(`[agent-attention] notification clicked: pane=${pane.slice(0, 8)}`)
      focusAgentPane(pane)
    })
    n.show()
    return n
  },
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
  mirror: agentToPhone
})

function forward(pane: string): void {
  const now = machine.state(pane)
  if (!now?.hooked) return
  const kind = KIND[now.state]
  if (sent.get(pane) === kind) return
  sent.set(pane, kind)
  notifyPtyOwner(pane, 'pty:agent-hook', { id: pane, kind } satisfies AgentHookEvent)
}

function apply(pane: string, t: AgentTransition | null, via: string): void {
  if (t) {
    transitions.push({ ...t, via })
    if (transitions.length > MAX_TRANSITIONS) transitions.splice(0, transitions.length - MAX_TRANSITIONS)
    console.log(`[agent-attention] pane=${t.pane.slice(0, 8)} ${t.agent || 'title'} ${t.from} -> ${t.to} (${t.reason}, ${via})`)
  }
  forward(pane)
  if (t) notifier.transition(t)
  if (t?.from === 'waiting') agentSettled(pane, 'asked · answered')
  else if (t && (t.to === 'working' || t.to === 'idle') && t.from !== t.to) agentSeen(pane, t.to === 'working' ? 'the agent went on' : 'the agent is idle')
}

export function onAgentHook(ptyId: string, agent: string, event: string, payload: string): void {
  const signal = normalizeHookEvent(agent, event, payload)
  if (!signal) return
  apply(ptyId, machine.hook(ptyId, agent, signal), `hook ${event || signal.type}`)
}

export function agentAttentionSnapshot(): unknown {
  return {
    panes: machine.snapshot().map((p) => ({ ...p, since: new Date(p.since).toISOString(), info: paneInfo(p.pane), focused: windowFocused(p.pane) })),
    transitions: transitions.slice(-40).map((t) => ({ at: new Date(t.at).toISOString(), pane: t.pane.slice(0, 8), agent: t.agent, from: t.from, to: t.to, reason: t.reason, via: t.via }))
  }
}

export function agentNotifications(opts: { clear?: boolean; focus?: string }): unknown {
  if (opts.focus === 'focused' || opts.focus === 'blurred') focusOverride = opts.focus
  else if (opts.focus === 'real') focusOverride = null
  const records = notifier.recent().map((r) => ({ ...r, at: new Date(r.at).toISOString(), pane: r.pane.slice(0, 8) }))
  if (opts.clear) notifier.clear()
  return { focus: focusOverride ?? 'real', supported: Notification.isSupported(), records }
}

export function registerAgentAttention(): void {
  if (wired) return
  wired = true
  tapPtyInput((id, data) => {
    const t = machine.input(id, data)
    if (t) apply(id, t, 'input')
  })
  tapPtyOutput((id, data) => {
    for (const title of titles.push(id, data)) {
      const t = machine.title(id, title)
      if (t) apply(id, t, 'title')
    }
  })
  tapPtyExit((id) => {
    agentSettled(id, 'asked · terminal closed')
    machine.forget(id)
    sent.delete(id)
    titles.forget(id)
    notifier.forget(id)
  })
  ipcMain.handle('pty:agentStates', (): AgentHookEvent[] =>
    machine
      .snapshot()
      .filter((p) => p.hooked)
      .map((p) => ({ id: p.pane, kind: KIND[p.state] }))
  )
  ipcMain.on('pty:agentPanes', (event, panes: AgentPaneReport[]) => {
    const wcId = event.sender.id
    if (!panesByWindow.has(wcId)) event.sender.once('destroyed', () => panesByWindow.delete(wcId))
    const next = new Map<string, AgentPaneReport>()
    for (const p of Array.isArray(panes) ? panes : []) if (p && typeof p.ptyId === 'string') next.set(p.ptyId, p)
    const before = panesByWindow.get(wcId)
    panesByWindow.set(wcId, next)
    for (const p of next.values()) {
      if (p.visible && !before?.get(p.ptyId)?.visible && windowFocused(p.ptyId)) {
        notifier.paneVisible(p.ptyId)
        agentSeen(p.ptyId, 'its tab showed on the desktop')
      }
    }
  })
}
