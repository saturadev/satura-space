export const RISE = {
  emerge: 120,
  speed: 2.5,
  tMin: 80,
  tMax: 180,
  beat: 30,
  hold: 120,
  linger: 700,
  reducedLinger: 300
} as const

export const SWIM_LEAVE_MS = 220
export const CAP_FIRST_MS = 350
export const CAP_NEXT_MS = 220
const BUDGET_MS = 2000
const REFILL_PER_MS = 0.5
const MIN_MOVE_MS = 60
export const ARRIVAL_SLACK_MS = 50

export interface Plan {
  emerge: number
  travel: number
  beat: number
}

function travelMs(distance: number): number {
  if (!(distance >= 0.5)) return 0
  return Math.round(Math.min(RISE.tMax, Math.max(RISE.tMin, distance / RISE.speed)))
}

export function capFor(first: boolean, budgetLeft: number): number {
  return Math.max(0, Math.min(first ? CAP_FIRST_MS : CAP_NEXT_MS, budgetLeft))
}

export function planTotal(plan: Plan): number {
  return plan.emerge + plan.travel + plan.beat
}

export function planApproach(first: boolean, distance: number): Plan {
  return { emerge: first ? RISE.emerge : 0, travel: travelMs(distance), beat: RISE.beat }
}

function fitPlan(plan: Plan, cap: number): Plan {
  const total = planTotal(plan)
  if (total <= cap) return plan
  if (cap <= 0) return { emerge: 0, travel: 0, beat: 0 }
  const k = cap / total
  return { emerge: Math.floor(plan.emerge * k), travel: Math.floor(plan.travel * k), beat: Math.floor(plan.beat * k) }
}

export function budgetPlan(plan: Plan, cap: number): Plan {
  if (planTotal(plan) <= cap) return plan
  return cap >= MIN_MOVE_MS ? fitPlan(plan, cap) : { emerge: 0, travel: 0, beat: 0 }
}

export class DriftBudget {
  private _tokens: number
  private _at: number

  constructor(
    private readonly _now: () => number = Date.now,
    private readonly _size = BUDGET_MS,
    private readonly _rate = REFILL_PER_MS
  ) {
    this._tokens = _size
    this._at = _now()
  }

  private _refill(to: number): void {
    if (to > this._at) {
      this._tokens = Math.min(this._size, this._tokens + (to - this._at) * this._rate)
      this._at = to
    }
  }

  get left(): number {
    this._refill(this._now())
    return Math.floor(this._tokens)
  }

  cap(first: boolean): number {
    return capFor(first, this.left)
  }

  charge(ms: number): void {
    const now = this._now()
    const spent = Math.max(0, ms)
    this._refill(now - spent)
    this._tokens = Math.max(0, this._tokens - spent)
    this._at = Math.max(this._at, now)
  }
}

export type MoveKind = 'animated' | 'shortened' | 'instant' | 'reduced' | 'hidden'

export function moveKind(r: { ms: number; full: number; shown: boolean; reduced: boolean }): MoveKind {
  if (!r.shown) return 'hidden'
  if (r.reduced) return 'reduced'
  if (r.full > 0 && r.ms <= 0) return 'instant'
  if (r.ms < r.full) return 'shortened'
  return 'animated'
}

export type InputRoute = 'cdp' | 'dom' | 'hold'
export type PressedVia = 'cdp' | 'dom' | null

export function routeInput(o: { scoped: boolean; active: boolean; pressedVia: PressedVia }): InputRoute {
  if (!o.scoped) return 'cdp'
  if (o.pressedVia === 'dom') return 'dom'
  if (o.pressedVia === 'cdp') return o.active ? 'cdp' : 'hold'
  return o.active ? 'cdp' : 'dom'
}

export function inOrder(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn)
    tail = run.catch(() => undefined)
    return run
  }
}

export interface ViewState {
  scoped: boolean
  active: boolean
  rect: { x: number; y: number; width: number; height: number } | null
}

export function userInputCounts(view: ViewState, input: { kind: 'mouse' | 'key'; x?: number; y?: number }): boolean {
  if (!view.scoped) return true
  if (!view.active) return false
  if (input.kind === 'key' || !view.rect) return true
  const x = input.x ?? NaN
  const y = input.y ?? NaN
  const r = view.rect
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height
}

export const WAIT_LINES = {
  nomatch: "can't find it",
  strict: 'more than one match',
  hidden: "it's hidden",
  offscreen: "it's off screen",
  disabled: "it's disabled",
  moving: "it's still moving",
  readonly: "it's read-only",
  covered: "something's covering it",
  other: 'not ready yet'
} as const

export function waitLine(reason: string): string {
  const r = reason.replace(/^error:/, '')
  if (r === 'nomatch') return WAIT_LINES.nomatch
  if (r === 'strict') return WAIT_LINES.strict
  if (r === 'notvisible' || r === 'not visible') return WAIT_LINES.hidden
  if (r === 'notinviewport') return WAIT_LINES.offscreen
  if (r === 'not enabled') return WAIT_LINES.disabled
  if (r === 'not stable') return WAIT_LINES.moving
  if (r === 'not editable') return WAIT_LINES.readonly
  if (r === 'intercepted') return WAIT_LINES.covered
  return WAIT_LINES.other
}

export function waitWhy(reason: string): string {
  const r = reason.replace(/^error:/, '')
  if (r === 'nomatch') return 'nothing matches the locator yet'
  if (r === 'notvisible') return 'not visible'
  if (r === 'notinviewport') return 'outside the window'
  if (r === 'intercepted') return 'another element is on top of it'
  return r
}

export function failLine(error: { name?: string; message?: string } | null | undefined, lastReason: string | null): string {
  const message = String(error?.message ?? '')
  if (/strict mode violation/i.test(message)) return WAIT_LINES.strict
  if (error?.name !== 'TimeoutError') return ''
  if (lastReason) return waitLine(lastReason)
  return /resolved to/.test(message) ? '' : WAIT_LINES.nomatch
}

export class HiddenClock {
  private _since: number | null = null
  private _total = 0
  private _last = 0
  actions = 0

  get hidden(): boolean {
    return this._since !== null
  }

  update(active: boolean, now: number): 'away' | 'back' | null {
    if (!active && this._since === null) {
      this._since = now
      return 'away'
    }
    if (active && this._since !== null) {
      this._last = now - this._since
      this._total += this._last
      this._since = null
      return 'back'
    }
    return null
  }

  get lastMs(): number {
    return this._last
  }

  ms(now: number): number {
    return this._total + (this._since !== null ? now - this._since : 0)
  }
}

export interface Held {
  what: string
  why: string
  ms: number
}

export interface Asked {
  text: string
  answer: string | null
  ms: number
  how?: string
}

export interface DriftStats {
  moves?: Partial<Record<MoveKind, number>>
  pauses?: { count: number; ms: number }
  hidden?: { ms: number; actions: number }
  held?: Held[]
  felt?: [string, number][]
  said?: string[]
  asked?: Asked[]
  linger?: number
  notes?: string[]
  ended?: string
  lost?: string[]
}

export function askedLine(a: Asked): string {
  const how = a.answer !== null ? `the user clicked ${JSON.stringify(a.answer)}` : a.how || 'the user closed it'
  return `asked ${JSON.stringify(a.text)}: ${how} after ${seconds(a.ms)}`
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function heldName(what: string): string {
  const w = what.replace(/ at \(.*\)$/, '')
  if (w === 'mousePressed' || w === 'mouseReleased') return 'a press'
  if (w === 'mouseMoved') return 'a mouse move'
  if (w === 'mouseWheel') return 'a scroll'
  if (w === 'text input') return 'typing'
  if (/^(keyDown|rawKeyDown|keyUp|char) /.test(w)) return `the ${w.slice(w.indexOf(' ') + 1)} key`
  if (/^[a-zA-Z]+ on /.test(w)) return w.slice(0, w.indexOf(' on '))
  return w
}

export interface AnchorWhere {
  on: boolean
  shown: boolean
  hand: { x: number; y: number }
  target: string
  box: { x: number; y: number; width: number; height: number } | null
  hit: string
  state: 'ok' | 'gone' | 'hidden' | 'offscreen' | 'none'
  lost: boolean
  follows: number
  refound: number
}

export const LOST_WHY: Record<string, string> = {
  gone: 'it was removed from the page',
  hidden: 'it was hidden or collapsed',
  offscreen: 'it scrolled or moved out of view'
}

export const OFF_PX = 2

export function anchorLine(w: AnchorWhere, at: { x: number; y: number } | null): string {
  const r = Math.round
  const hand = `(${r(w.hand.x)}, ${r(w.hand.y)})`
  if (w.lost) return `lost the target: ${w.state} (${LOST_WHY[w.state] ?? w.state}), Drift stopped at ${hand} and said so`
  if (!w.shown) return 'not on screen, the workspace is in the background'
  if (!w.on) return 'Drift is not out'
  const box = w.box ? `(${r(w.box.x)}, ${r(w.box.y)}, ${r(w.box.width)}x${r(w.box.height)})` : '(no box)'
  const parts = [`ends on ${w.target} ${box} with the hand at ${hand}`, w.hit === 'ok' ? 'hit ok' : w.hit ? `hit ${w.hit}` : 'hit not checked']
  if (w.follows > 0) parts.push(`followed the target ${w.follows}x`)
  if (w.refound > 0) parts.push('re-found the target after a re-render')
  if (at && w.box) {
    const d = Math.hypot(at.x - w.hand.x, at.y - w.hand.y)
    if (d > OFF_PX) parts.push(`the action point (${r(at.x)}, ${r(at.y)}) is ${r(d)}px from the hand`)
  }
  return parts.join(', ')
}

export function driftReport(e: DriftStats): string {
  const parts: string[] = []
  const m = e.moves ?? {}
  const moves = [
    m.animated ? `${m.animated} animated` : '',
    m.shortened ? `${m.shortened} shortened` : '',
    m.instant ? `${m.instant} instant` : '',
    m.reduced ? `${m.reduced} without motion (reduced motion is on)` : ''
  ].filter(Boolean)
  if (moves.length) parts.push(`moves ${moves.join(', ')}`)
  if (e.pauses && e.pauses.count > 0) parts.push(`paused for you ${e.pauses.count}x (${seconds(e.pauses.ms)})`)
  if (e.hidden && (e.hidden.ms >= 100 || e.hidden.actions > 0)) {
    parts.push(`${seconds(e.hidden.ms)} in a hidden workspace, ${plural(e.hidden.actions, 'action')} there`)
  }
  if (e.held?.length) parts.push(`held ${e.held.map((h) => `${heldName(h.what)} ${seconds(h.ms)}${h.why ? ` (${h.why})` : ''}`).join(', ')}`)
  if (e.felt?.length) parts.push(`felt ${e.felt.map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(', ')}`)
  if (e.said?.length) {
    const shown = e.said.slice(0, 6).map((t) => JSON.stringify(t))
    if (e.said.length > 6) shown.push(`${e.said.length - 6} more`)
    parts.push(`said ${shown.join(', ')} (${plural(e.said.length, 'bubble')})`)
  }
  for (const a of e.asked ?? []) parts.push(askedLine(a))
  if (e.linger && e.linger > 0) parts.push(`stays ${seconds(e.linger)} after the script for the last bubble`)
  for (const l of e.lost ?? []) parts.push(`lost the target ${l}`)
  if (e.ended) parts.push(`ended on ${e.ended}`)
  for (const n of e.notes ?? []) parts.push(n)
  return parts.join('; ')
}

export function claimScope(busy: Map<number, Map<string, number>>, window: number, scope: string, runId: number): boolean {
  const holders = busy.get(window) ?? new Map<string, number>()
  for (const [held, owner] of holders) {
    if (owner === runId) continue
    if (held === scope || held === '' || scope === '') return false
  }
  holders.set(scope, runId)
  busy.set(window, holders)
  return true
}

export function releaseScopes(busy: Map<number, Map<string, number>>, runId: number): void {
  for (const [window, holders] of busy) {
    for (const [scope, owner] of holders) if (owner === runId) holders.delete(scope)
    if (holders.size === 0) busy.delete(window)
  }
}

export const TYPE_DELAY_MS = 60
export const TYPE_MAX_DELAY_MS = 250
export const TYPE_TOTAL_MS = 3000

export function typingDelay(text: string, asked?: unknown): number {
  const n = Math.max(1, Array.from(text).length)
  const want = typeof asked === 'number' && Number.isFinite(asked) && asked >= 0 ? asked : TYPE_DELAY_MS
  return Math.max(0, Math.floor(Math.min(want, TYPE_MAX_DELAY_MS, TYPE_TOTAL_MS / n)))
}
