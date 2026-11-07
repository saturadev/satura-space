import type { AgentState, AgentTransition, AgentWait } from './agent-state'

export type AgentNotificationKind = 'finished' | 'needs-you'

export interface AgentPaneInfo {
  ptyId: string
  agentId: string | null
  label: string
  workspace: string
  visible: boolean
}

export interface AgentNotificationRecord {
  at: number
  pane: string
  agent: string
  kind: AgentNotificationKind
  shown: boolean
  reason: string
  title: string
  subtitle: string
  body: string
}

export interface ShownNotification {
  close(): void
}

export interface AgentNotifierDeps {
  now(): number
  enabled(kind: AgentNotificationKind): boolean
  pane(ptyId: string): AgentPaneInfo | null
  focused(ptyId: string): boolean
  state(ptyId: string): { state: AgentState; since: number } | null
  agentLabel(agentId: string): string
  show(n: { pane: string; title: string; subtitle: string; body: string }): ShownNotification | null
  schedule(fn: () => void, ms: number): () => void
  mirror?(n: AgentMirror): void
}

export interface AgentMirror {
  kind: AgentNotificationKind
  pane: string
  agent: string
  status: string
  detail: string
  label: string
  workspace: string
  blocked: string
  failed: boolean
}

const FINISHED_QUIET_MS = 1500
const REPEAT_WINDOW_MS = 5000
const MAX_RECORDS = 50
const BODY_MAX = 180
const SUPERSEDED = 'the agent went on before the quiet period ended'

function clip(text: string, max = BODY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function inputPreview(input: unknown): string {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input : ''
  const o = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'description', 'prompt']) {
    if (typeof o[key] === 'string' && o[key]) return o[key] as string
  }
  return ''
}

function questionText(input: unknown): string {
  const questions = (input as { questions?: unknown } | null | undefined)?.questions
  const first = Array.isArray(questions) ? (questions[0] as { question?: unknown } | undefined) : undefined
  return typeof first?.question === 'string' ? first.question : ''
}

function waitWords(wait: AgentWait | null): { status: string; body: string } {
  if (!wait) return { status: 'needs your input', body: '' }
  if (wait.kind === 'question') return { status: 'has a question', body: questionText(wait.input) || wait.message }
  if (wait.kind === 'input') return { status: 'needs your input', body: wait.message }
  const preview = inputPreview(wait.input)
  const tool = wait.tool
  const body = tool ? (preview ? `${tool}: ${preview}` : `Wants to use ${tool}`) : wait.message
  return { status: wait.child ? 'needs permission for a subagent' : 'needs your permission', body }
}

export class AgentNotifier {
  private records: AgentNotificationRecord[] = []
  private pending = new Map<string, { stop: () => void; t: AgentTransition }>()
  private live = new Map<string, { kind: AgentNotificationKind; n: ShownNotification }>()
  private lastShown = new Map<string, number>()

  constructor(private readonly deps: AgentNotifierDeps) {}

  transition(t: AgentTransition): void {
    if (t.to === 'waiting') {
      this.cancel(t.pane)
      this.emit('needs-you', t)
      return
    }
    if (t.to === 'done' && (t.from === 'working' || t.from === 'waiting')) {
      this.cancel(t.pane)
      this.closeLive(t.pane)
      const since = t.at
      const stop = this.deps.schedule(() => {
        this.pending.delete(t.pane)
        const now = this.deps.state(t.pane)
        if (!now || now.state !== 'done' || now.since !== since) {
          this.record(t, 'finished', false, SUPERSEDED, null)
          return
        }
        this.emit('finished', t)
      }, FINISHED_QUIET_MS)
      this.pending.set(t.pane, { stop, t })
      return
    }
    this.cancel(t.pane)
    if (t.to === 'working' || t.to === 'idle') this.closeLive(t.pane)
  }

  paneVisible(ptyId: string): void {
    this.closeLive(ptyId)
  }

  forget(ptyId: string): void {
    this.cancel(ptyId)
    this.closeLive(ptyId)
    this.lastShown.delete(`${ptyId}:finished`)
    this.lastShown.delete(`${ptyId}:needs-you`)
  }

  recent(): AgentNotificationRecord[] {
    return [...this.records]
  }

  clear(): void {
    this.records = []
  }

  private cancel(pane: string): void {
    const pending = this.pending.get(pane)
    if (!pending) return
    pending.stop()
    this.pending.delete(pane)
    this.record(pending.t, 'finished', false, SUPERSEDED, null)
  }

  private closeLive(pane: string): void {
    const live = this.live.get(pane)
    if (!live) return
    this.live.delete(pane)
    try {
      live.n.close()
    } catch {
    }
  }

  private words(kind: AgentNotificationKind, t: AgentTransition, pane: AgentPaneInfo | null): { title: string; subtitle: string; body: string; agent: string; status: string; detail: string; failed: boolean } {
    const agent = this.deps.agentLabel(pane?.agentId || t.agent || 'agent')
    const head = pane?.workspace ? `${pane.workspace} - ` : ''
    const subtitle = pane?.label ?? ''
    if (kind === 'needs-you') {
      const w = waitWords(t.wait)
      return { title: `${head}${agent} ${w.status}`, subtitle, body: clip(w.body || `${agent} is waiting for you.`), agent, status: w.status, detail: clip(w.body), failed: false }
    }
    const failed = t.reason === 'turn failed'
    return { title: `${head}${agent} ${failed ? 'failed' : 'finished'}`, subtitle, body: clip(t.message || `${agent} ${failed ? 'stopped with an error' : 'finished its turn'}.`), agent, status: failed ? 'failed' : 'finished', detail: clip(t.message), failed }
  }

  private emit(kind: AgentNotificationKind, t: AgentTransition): void {
    const pane = this.deps.pane(t.pane)
    const { agent, status, detail, failed, ...text } = this.words(kind, t, pane)
    const why = this.blocked(kind, t, pane)
    try {
      this.deps.mirror?.({ kind, pane: t.pane, agent, status, detail, failed, label: pane?.label ?? '', workspace: pane?.workspace ?? '', blocked: why })
    } catch {
    }
    if (why) {
      this.record(t, kind, false, why, text)
      return
    }
    const n = this.deps.show({ pane: t.pane, ...text })
    if (!n) {
      this.record(t, kind, false, 'desktop notifications are not supported here', text)
      return
    }
    this.closeLive(t.pane)
    this.live.set(t.pane, { kind, n })
    this.lastShown.set(`${t.pane}:${kind}`, this.deps.now())
    this.record(t, kind, true, 'shown', text)
  }

  private blocked(kind: AgentNotificationKind, t: AgentTransition, pane: AgentPaneInfo | null): string {
    if (!this.deps.enabled(kind)) return `turned off in Settings`
    if (!t.hooked && !pane?.agentId) return 'not an agent terminal'
    if (pane?.visible && this.deps.focused(t.pane)) return 'its tab is visible in the focused window'
    const last = this.lastShown.get(`${t.pane}:${kind}`)
    if (last !== undefined && this.deps.now() - last < REPEAT_WINDOW_MS) return `repeat within ${REPEAT_WINDOW_MS / 1000} s`
    return ''
  }

  private record(t: AgentTransition, kind: AgentNotificationKind, shown: boolean, reason: string, text: { title: string; subtitle: string; body: string } | null): void {
    this.records.push({
      at: this.deps.now(),
      pane: t.pane,
      agent: t.agent,
      kind,
      shown,
      reason,
      title: text?.title ?? '',
      subtitle: text?.subtitle ?? '',
      body: text?.body ?? ''
    })
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS)
  }
}
