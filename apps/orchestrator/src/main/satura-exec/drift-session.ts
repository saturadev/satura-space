import { USER_IDLE_MS, UserGate } from './user-gate'
import { HiddenClock, anchorLine, askedLine, driftReport, moveKind, type AnchorWhere, type Asked, type Held, type MoveKind } from './drift-rules'

const USED_TUNER = /^used the .*Tuner.* of \d+ open$/

export interface SessionDeps {
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
  window: number
  workspace: string
  inFront: () => boolean
  resume: () => void
  idleMs?: number
}

export interface MoveResult {
  ms: number
  full: number
  first: boolean
  shown: boolean
  reduced: boolean
  where?: AnchorWhere
}

export const ASK_POLL_MS = 120

export interface AskShown {
  travel: number
  shown: boolean
  text: string
}

export interface AskPoll {
  done: boolean
  label: string | null
  how: string
}

export interface PointShown {
  travel: number
  read: number
  shown: boolean
  text: string
  x?: number
  y?: number
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

export class DriftSession {
  readonly gate: UserGate
  private readonly _hidden = new HiddenClock()
  private readonly _idleMs: number
  private _moves: Partial<Record<MoveKind, number>> = {}
  private _felt = new Map<string, number>()
  private _said: string[] = []
  private _held: Held[] = []
  private _notes: string[] = []
  private _asked: Asked[] = []
  private _askMs = 0
  private _askSince: number | null = null
  private _linger = 0
  private _userAt = Number.NEGATIVE_INFINITY
  private _lost: string[] = []
  private _ended = ''

  constructor(private readonly _d: SessionDeps) {
    this._idleMs = _d.idleMs ?? USER_IDLE_MS
    this.gate = new UserGate({
      now: _d.now,
      sleep: _d.sleep,
      idleMs: this._idleMs,
      relevant: _d.inFront,
      onPause: (paused, ms) => {
        this._d.log(paused ? 'paused for the user' : `resumed after ${seconds(ms)}`)
        if (!paused) this._d.resume()
      }
    })
  }

  get hidden(): boolean {
    return this._hidden.hidden
  }

  userSeen(type: string): void {
    const now = this._d.now()
    if (now - this._userAt >= this._idleMs) this._d.log(`user ${type} in window ${this._d.window}`)
    this._userAt = now
  }

  userAt(at: number, type: string): void {
    this.gate.noteUserAt(at)
    this.userSeen(type)
  }

  view(active: boolean, quiet = false): void {
    const now = this._d.now()
    const change = this._hidden.update(active, now)
    if (quiet) return
    if (change === 'away') this._d.log(`user switched away from workspace ${this._d.workspace}, the script keeps going there`)
    else if (change === 'back') this._d.log(`user is back in workspace ${this._d.workspace} after ${seconds(this._hidden.lastMs)}`)
  }

  action(): void {
    if (this._hidden.hidden) this._hidden.actions++
  }

  move(action: string, at: { x: number; y: number }, r: MoveResult | null, waited: number, left: number): void {
    const kind = r ? moveKind(r) : null
    if (kind) this._moves[kind] = (this._moves[kind] ?? 0) + 1
    const tail =
      kind === 'hidden'
        ? ', not on screen'
        : kind === 'reduced'
          ? ', reduced motion'
          : kind === 'instant'
            ? `, instant: the budget had ${left}ms`
            : kind === 'shortened' && r
              ? `, shortened from ${r.full}ms`
              : ''
    this._d.log(
      `drift ${r?.first ? 'came out' : 'moved'} to (${Math.round(at.x)}, ${Math.round(at.y)}) for ${action || 'input'}: arrived after ${waited}ms (plan ${r ? r.ms : '?'}ms), budget left ${left}ms${tail}`
    )
  }

  anchor(what: string, w: AnchorWhere | null | undefined, at: { x: number; y: number } | null): void {
    if (!w || !w.target) return
    this._d.log(`drift anchor ${w.target} for ${what}: ${anchorLine(w, at)}`)
    if (w.lost) {
      const lost = `${w.target} (${w.state})`
      if (!this._lost.includes(lost)) this._lost.push(lost)
      this._ended = ''
    } else if (w.on && w.shown && w.box) this._ended = `${w.target} at (${Math.round(w.hand.x)}, ${Math.round(w.hand.y)})${w.hit ? `, hit ${w.hit}` : ''}`
  }

  held(what: string, why: string, ms: number): void {
    this._held.push({ what, why, ms })
  }

  events(fired: string[], said: string[]): void {
    const felt = fired.filter((e) => e !== 'blink')
    if (felt.length) this._d.log(`drift felt ${felt.join(', ')}`)
    for (const e of felt) this._felt.set(e, (this._felt.get(e) ?? 0) + 1)
    for (const t of said) if (this._said[this._said.length - 1] !== t) this._said.push(t)
  }

  note(text: string): void {
    if (text && !this._notes.includes(text)) {
      if (USED_TUNER.test(text)) this._notes = this._notes.filter((n) => !USED_TUNER.test(n))
      this._notes.push(text)
      this._d.log(text)
    }
  }

  async say<T extends { text: string }>(show: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.gate.idle(signal)
    const r = await show()
    if (r.text) this._d.log(`drift says "${r.text}"`)
    return r
  }

  get asking(): boolean {
    return this._askSince !== null
  }

  askedMs(): number {
    return this._askMs + (this._askSince !== null ? this._d.now() - this._askSince : 0)
  }

  async ask(
    text: string,
    buttons: string[],
    show: () => Promise<AskShown | null>,
    poll: () => Promise<AskPoll | null>,
    signal?: AbortSignal,
    pollMs = ASK_POLL_MS
  ): Promise<string | null> {
    const first = await show()
    const said = first?.text || text
    const t0 = this._d.now()
    this._askSince = t0
    this._d.log(`drift asks "${said}" with ${buttons.map((b) => JSON.stringify(b)).join(', ')}${first?.shown === false ? ', the workspace is hidden: the bubble waits for the user' : ''}`)
    let answer: AskPoll | null = null
    try {
      while (!signal?.aborted) {
        const r = await poll()
        if (r === null) await show()
        else if (r.done) {
          answer = r
          break
        }
        await this._d.sleep(pollMs)
      }
    } finally {
      this._askMs += this._d.now() - t0
      this._askSince = null
    }
    const ms = this._d.now() - t0
    this._asked.push({ text: said, answer: answer ? answer.label : null, ms, how: answer ? answer.how : 'the script stopped before an answer' })
    this._d.log(`drift ${askedLine(this._asked[this._asked.length - 1])}`)
    if (!answer) throw new Error('The script was stopped.')
    return answer.label
  }

  linger(ms: number): void {
    this._linger = Math.max(0, ms)
  }

  async point(show: () => Promise<PointShown>, at: { x: number; y: number }, wait: boolean, signal?: AbortSignal): Promise<PointShown> {
    await this.gate.idle(signal)
    const r = await show()
    const ms = wait ? r.travel + r.read : 0
    const to = typeof r.x === 'number' && typeof r.y === 'number' ? { x: r.x, y: r.y } : at
    this._d.log(`drift points at (${Math.round(to.x)}, ${Math.round(to.y)})${r.text ? ` and says "${r.text}"` : ''}${r.shown ? `, holds ${ms}ms` : ', not on screen'}`)
    if (ms > 0) await this.gate.hold(ms, signal)
    return r
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return this.gate.hold(ms, signal)
  }

  report(): string {
    const now = this._d.now()
    return driftReport({
      moves: this._moves,
      pauses: { count: this.gate.pauses, ms: this.gate.pausedMs() },
      hidden: { ms: this._hidden.ms(now), actions: this._hidden.actions },
      held: this._held,
      felt: [...this._felt],
      said: this._said,
      asked: this._asked,
      linger: this._linger,
      notes: this._notes,
      ended: this._ended,
      lost: this._lost
    })
  }
}
