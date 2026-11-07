import type { AgentSignal, AgentWaitKind } from './agent-events'
import { detectAgentStatusFromTitle } from '@shared/agent-title'

export type AgentState = 'working' | 'waiting' | 'done' | 'idle'

export interface AgentWait {
  kind: AgentWaitKind
  tool: string
  id: string
  input: unknown
  child: string
  message: string
  since: number
}

export interface AgentTransition {
  pane: string
  agent: string
  from: AgentState
  to: AgentState
  reason: string
  at: number
  hooked: boolean
  wait: AgentWait | null
  message: string
}

export interface AgentPaneSnapshot {
  pane: string
  agent: string
  state: AgentState
  since: number
  hooked: boolean
  title: string
  wait: { kind: AgentWaitKind; tool: string; child: string; since: number } | null
  lastReason: string
}

interface ToolSeen {
  tool: string
  input: string
  child: string
  at: number
}

interface Pane {
  agent: string
  state: AgentState
  since: number
  hooked: boolean
  wait: AgentWait | null
  tools: Map<string, ToolSeen>
  touched: boolean
  interruptAt: number
  title: string
  lastReason: string
  ended: boolean
}

const SIBLING_GRACE_MS = 1000
const INTERRUPT_CONFIRM_MS = 5000
const MAX_TOOLS = 32
const SUBMIT_KEYS = new Set(['\r', '\n', '\r\n', '\x1b[13u', '\x1b[13;1u'])
const CANCEL_KEYS = new Set(['\x1b', '\x03', '\x1b[27u', '\x1b[27;1u', '\x1b[99;5u'])

function inputKey(input: unknown): string {
  if (input === undefined) return ''
  try {
    return JSON.stringify(input) ?? ''
  } catch {
    return ''
  }
}

function isDigit(data: string): boolean {
  return data.length === 1 && data >= '1' && data <= '9'
}

export function questionAnsweredBy(data: string, input: unknown): boolean {
  const questions = (input as { questions?: unknown } | null | undefined)?.questions
  if (!Array.isArray(questions)) return SUBMIT_KEYS.has(data)
  if (questions.length !== 1) return false
  const q = questions[0] as { multiSelect?: unknown; options?: unknown } | null
  if (!q || q.multiSelect === true) return false
  if (SUBMIT_KEYS.has(data)) return true
  if (!isDigit(data)) return false
  const options = Array.isArray(q.options) ? q.options : []
  if (options.some((o) => o && typeof o === 'object' && 'preview' in o)) return false
  return Number(data) <= options.length
}

export class AgentStateMachine {
  private panes = new Map<string, Pane>()

  constructor(private readonly clock: () => number = Date.now) {}

  hook(pane: string, agent: string, signal: AgentSignal): AgentTransition | null {
    const now = this.clock()
    const p = this.pane(pane, agent, now)
    p.hooked = true
    p.agent = agent
    p.ended = signal.type === 'session' && signal.reason === 'end'
    switch (signal.type) {
      case 'session':
        p.wait = null
        p.tools.clear()
        p.interruptAt = 0
        return this.set(pane, p, 'idle', `session ${signal.reason}`, now)
      case 'prompt':
        p.wait = null
        p.interruptAt = 0
        return this.set(pane, p, 'working', 'prompt submitted', now)
      case 'tool':
        return this.tool(pane, p, signal, now)
      case 'wait':
        return this.waitFor(pane, p, signal, now)
      case 'wait-end':
        if (p.state !== 'waiting' || p.wait?.kind !== 'input' || p.wait.child !== signal.child) return null
        p.wait = null
        return this.set(pane, p, 'working', 'input dialog answered', now)
      case 'batch':
        if (p.state !== 'waiting' || !p.wait?.id || p.wait.child !== signal.child || !signal.ids.includes(p.wait.id)) return null
        p.wait = null
        return this.set(pane, p, 'working', 'tool batch settled the prompt', now)
      case 'stop':
        p.wait = null
        p.interruptAt = 0
        if (signal.interrupted) return this.set(pane, p, 'idle', 'turn interrupted', now)
        return this.set(pane, p, 'done', signal.failed ? 'turn failed' : 'turn finished', now, signal.message)
    }
  }

  input(pane: string, data: string): AgentTransition | null {
    const p = this.panes.get(pane)
    if (!p || !p.hooked) return null
    const now = this.clock()
    if (p.state === 'waiting' && p.wait) {
      if (CANCEL_KEYS.has(data)) {
        p.wait = null
        return this.set(pane, p, 'idle', 'prompt cancelled from the keyboard', now)
      }
      const answers =
        p.wait.kind === 'question' ? questionAnsweredBy(data, p.wait.input) : SUBMIT_KEYS.has(data) || isDigit(data)
      if (answers) {
        p.wait = null
        return this.set(pane, p, 'working', 'prompt answered from the keyboard', now)
      }
      p.touched = true
      return null
    }
    if (p.state === 'working' && CANCEL_KEYS.has(data)) p.interruptAt = now
    return null
  }

  title(pane: string, title: string): AgentTransition | null {
    const kind = detectAgentStatusFromTitle(title)
    const existing = this.panes.get(pane)
    if (!existing && kind === null) return null
    const now = this.clock()
    const p = existing ?? this.pane(pane, '', now)
    p.title = title
    if (p.hooked && p.ended) {
      p.hooked = false
      p.ended = false
      p.agent = ''
    }
    if (p.hooked) {
      if (p.state === 'working' && p.interruptAt && kind !== 'working') {
        const armed = now - p.interruptAt <= INTERRUPT_CONFIRM_MS
        p.interruptAt = 0
        if (armed) return this.set(pane, p, 'idle', 'interrupted from the keyboard', now)
        return null
      }
      if (p.state === 'waiting' && p.touched && kind === 'working') {
        p.wait = null
        return this.set(pane, p, 'working', 'agent resumed after input at the prompt', now)
      }
      return null
    }
    if (kind === 'working') return this.set(pane, p, 'working', 'title shows work', now)
    if (kind === 'needs-input') {
      if (p.state === 'waiting') return null
      p.wait = { kind: 'permission', tool: '', id: '', input: undefined, child: '', message: '', since: now }
      return this.set(pane, p, 'waiting', 'title asks for input', now)
    }
    if (p.state === 'working' || p.state === 'waiting') {
      p.wait = null
      return this.set(pane, p, 'done', 'title went quiet', now)
    }
    return null
  }

  forget(pane: string): void {
    this.panes.delete(pane)
  }

  state(pane: string): { state: AgentState; since: number; hooked: boolean } | null {
    const p = this.panes.get(pane)
    return p ? { state: p.state, since: p.since, hooked: p.hooked } : null
  }

  snapshot(): AgentPaneSnapshot[] {
    return [...this.panes].map(([pane, p]) => ({
      pane,
      agent: p.agent,
      state: p.state,
      since: p.since,
      hooked: p.hooked,
      title: p.title,
      wait: p.wait ? { kind: p.wait.kind, tool: p.wait.tool, child: p.wait.child, since: p.wait.since } : null,
      lastReason: p.lastReason
    }))
  }

  private pane(pane: string, agent: string, now: number): Pane {
    let p = this.panes.get(pane)
    if (!p) {
      p = { agent, state: 'idle', since: now, hooked: false, wait: null, tools: new Map(), touched: false, interruptAt: 0, title: '', lastReason: '', ended: false }
      this.panes.set(pane, p)
    }
    return p
  }

  private tool(pane: string, p: Pane, signal: Extract<AgentSignal, { type: 'tool' }>, now: number): AgentTransition | null {
    const seen = signal.id ? p.tools.get(signal.id) : undefined
    if (signal.phase === 'start' && signal.id) {
      p.tools.set(signal.id, { tool: signal.tool, input: inputKey(signal.input), child: signal.child, at: now })
      if (p.tools.size > MAX_TOOLS) p.tools.delete(p.tools.keys().next().value as string)
    }
    if (!signal.child) p.interruptAt = 0
    if (p.state === 'waiting' && p.wait) {
      if (!this.settles(p.wait, signal, seen, now)) return null
      p.wait = null
      return this.set(pane, p, 'working', `${signal.tool || 'tool'} ${signal.phase === 'start' ? 'started' : 'ended'} after the prompt`, now)
    }
    if (signal.child) return null
    return this.set(pane, p, 'working', `${signal.tool || 'tool'} ${signal.phase === 'start' ? 'started' : 'ended'}`, now)
  }

  private settles(wait: AgentWait, signal: Extract<AgentSignal, { type: 'tool' }>, seen: ToolSeen | undefined, now: number): boolean {
    if (signal.child !== wait.child) return false
    if (signal.phase === 'end') {
      if (wait.id && signal.id === wait.id) return true
      if (wait.kind === 'question' && signal.tool === wait.tool) return true
      if (!wait.id && signal.tool === wait.tool && inputKey(signal.input) === inputKey(wait.input)) return true
      return !!seen && seen.at > wait.since + SIBLING_GRACE_MS
    }
    if (wait.id && signal.id === wait.id) return false
    return now > wait.since + SIBLING_GRACE_MS
  }

  private waitFor(pane: string, p: Pane, signal: Extract<AgentSignal, { type: 'wait' }>, now: number): AgentTransition | null {
    const id = signal.id || this.matchTool(p, signal)
    if (p.state === 'waiting' && p.wait && p.wait.child === signal.child && p.wait.kind === signal.kind && (p.wait.id === id || p.wait.tool === signal.tool)) {
      if (!p.wait.id && id) p.wait.id = id
      return null
    }
    p.wait = { kind: signal.kind, tool: signal.tool, id, input: signal.input, child: signal.child, message: signal.message, since: now }
    p.touched = false
    p.interruptAt = 0
    const what = signal.kind === 'permission' ? `permission for ${signal.tool || 'a tool'}` : signal.kind === 'question' ? 'a question' : 'input'
    return this.set(pane, p, 'waiting', `asks for ${what}${signal.child ? ' (subagent)' : ''}`, now)
  }

  private matchTool(p: Pane, signal: Extract<AgentSignal, { type: 'wait' }>): string {
    const want = inputKey(signal.input)
    let found = ''
    for (const [id, t] of p.tools) {
      if (t.tool === signal.tool && t.child === signal.child && (!want || t.input === want)) found = id
    }
    return found
  }

  private set(pane: string, p: Pane, to: AgentState, reason: string, now: number, message = ''): AgentTransition | null {
    p.lastReason = reason
    if (p.state === to) return null
    const from = p.state
    p.state = to
    p.since = now
    if (to !== 'waiting') p.touched = false
    return { pane, agent: p.agent, from, to, reason, at: now, hooked: p.hooked, wait: to === 'waiting' ? p.wait : null, message }
  }
}
