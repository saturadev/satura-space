export const USER_IDLE_MS = 1500
const POLL_MS = 100
const OWN_INPUT_GRACE_MS = 60
const OWN_ECHO_MS = 250

export interface UserGateDeps {
  now: () => number
  sleep: (ms: number) => Promise<void>
  idleMs?: number
  onPause?: (paused: boolean, ms: number) => void
  relevant?: () => boolean
}

export interface InputEcho {
  kind: 'mouse' | 'key'
  x?: number
  y?: number
  key?: string
}

export class UserGate {
  private _lastUser = Number.NEGATIVE_INFINITY
  private _inFlight = 0
  private _graceUntil = 0
  private _paused = false
  private _pausedSince = 0
  private _pausedTotal = 0
  private _pauses = 0
  private _echo: (InputEcho & { at: number }) | null = null
  private readonly _idleMs: number

  constructor(private _deps: UserGateDeps) {
    this._idleMs = _deps.idleMs ?? USER_IDLE_MS
  }

  get paused(): boolean {
    return this._paused
  }

  pausedMs(): number {
    return this._pausedTotal + (this._paused ? this._deps.now() - this._pausedSince : 0)
  }

  get pauses(): number {
    return this._pauses
  }

  noteUserInput(input?: InputEcho): boolean {
    const now = this._deps.now()
    if (this._inFlight > 0 || now < this._graceUntil) return false
    if (input && this._isEcho(input, now)) return false
    this._lastUser = now
    return true
  }

  private _isEcho(input: InputEcho, now: number): boolean {
    const echo = this._echo
    if (!echo || now - echo.at > OWN_ECHO_MS || echo.kind !== input.kind) return false
    if (input.kind === 'key') return !!input.key && input.key === echo.key
    return Math.round(input.x ?? NaN) === Math.round(echo.x ?? NaN) && Math.round(input.y ?? NaN) === Math.round(echo.y ?? NaN)
  }

  noteUserAt(at: number): void {
    if (at > this._lastUser) this._lastUser = Math.min(at, this._deps.now())
  }

  userIdleFor(): number {
    return this._deps.now() - this._lastUser
  }

  private _userActive(): boolean {
    return this.userIdleFor() < this._idleMs && (!this._deps.relevant || this._deps.relevant())
  }

  async idle(signal?: AbortSignal): Promise<void> {
    while (this.userIdleFor() < this._idleMs) {
      if (signal?.aborted) break
      if (this._deps.relevant && !this._deps.relevant()) break
      if (!this._paused) {
        this._paused = true
        this._pauses++
        this._pausedSince = this._deps.now()
        this._deps.onPause?.(true, 0)
      }
      await this._deps.sleep(Math.max(10, Math.min(POLL_MS, this._idleMs - this.userIdleFor())))
    }
    if (this._paused) {
      this._paused = false
      const ms = this._deps.now() - this._pausedSince
      this._pausedTotal += ms
      this._deps.onPause?.(false, ms)
    }
  }

  async hold(ms: number, signal?: AbortSignal): Promise<void> {
    let left = Math.max(0, Number(ms) || 0)
    while (left > 0 && !signal?.aborted) {
      if (this._userActive()) {
        await this.idle(signal)
        continue
      }
      const t0 = this._deps.now()
      await this._deps.sleep(Math.min(left, POLL_MS))
      left -= Math.max(1, this._deps.now() - t0)
    }
  }

  async dispatch<T>(echo: InputEcho | null, send: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.idle(signal)
    this._inFlight++
    this._echo = echo ? { ...echo, at: this._deps.now() } : this._echo
    try {
      return await send()
    } finally {
      this._inFlight--
      this._graceUntil = this._deps.now() + OWN_INPUT_GRACE_MS
      if (echo) this._echo = { ...echo, at: this._deps.now() }
    }
  }
}
