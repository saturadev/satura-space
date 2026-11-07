export class TimeoutError extends Error {
  override name = 'TimeoutError'
}

export class AbortedError extends Error {
  override name = 'AbortedError'
}

export interface Progress {
  readonly timeout: number
  readonly metadata: Record<string, unknown>
  log(message: string): void
  race<T>(promise: Promise<T> | Promise<T>[]): Promise<T>
  wait(timeout: number): Promise<void>
  setAllowConcurrentOrNestedRaces(allow: boolean): void
}

export interface PauseClock {
  pausedMs(): number
  readonly paused: boolean
}

const PAUSED_RECHECK_MS = 250

export class ProgressController implements Progress {
  readonly timeout: number
  readonly metadata: Record<string, unknown> = {}
  private _logs: string[] = []
  private _failed: Promise<never>
  private _fail!: (error: Error) => void
  private _timer: ReturnType<typeof setTimeout> | undefined
  private _offAbort: () => void = () => {}
  private _error: Error | null = null
  private _credited = 0

  constructor(
    timeout: number,
    signal: AbortSignal | undefined,
    private _title: string,
    private _clock?: PauseClock
  ) {
    this.timeout = timeout
    this._credited = _clock?.pausedMs() ?? 0
    this._failed = new Promise<never>((_, reject) => {
      this._fail = reject
    })
    this._failed.catch(() => {})
    if (timeout > 0) this._arm(timeout)
    if (signal) {
      if (signal.aborted) this._stop(new AbortedError('The script was stopped.'))
      const onAbort = (): void => this._stop(new AbortedError('The script was stopped.'))
      signal.addEventListener('abort', onAbort, { once: true })
      this._offAbort = () => signal.removeEventListener('abort', onAbort)
    }
  }

  log(message: string): void {
    this._logs.push(message)
    if (this._logs.length > 40) this._logs.splice(0, this._logs.length - 40)
  }

  async race<T>(promise: Promise<T> | Promise<T>[]): Promise<T> {
    if (this._error) throw this._error
    const all = Array.isArray(promise) ? promise : [promise]
    for (const p of all) p.catch(() => {})
    return Promise.race([...all, this._failed])
  }

  async wait(timeout: number): Promise<void> {
    await this.race(new Promise<void>((resolve) => setTimeout(resolve, timeout)))
  }

  setAllowConcurrentOrNestedRaces(): void {}

  async run<T>(task: (progress: Progress) => Promise<T>): Promise<T> {
    try {
      return await this.race(task(this))
    } finally {
      this.dispose()
    }
  }

  dispose(): void {
    if (this._timer) clearTimeout(this._timer)
    this._offAbort()
  }

  private _arm(ms: number): void {
    this._timer = setTimeout(() => {
      const paused = this._clock ? this._clock.pausedMs() - this._credited : 0
      if (this._clock?.paused || paused > 0) {
        this._credited += paused
        this._arm(Math.max(paused, PAUSED_RECHECK_MS))
        return
      }
      this._stop(this._timeoutError())
    }, ms)
  }

  private _timeoutError(): Error {
    const log = this._logs.length ? `\nCall log:\n${this._logs.map((l) => `  - ${l.trim()}`).join('\n')}` : ''
    return new TimeoutError(`${this._title}: Timeout ${this.timeout}ms exceeded.${log}`)
  }

  private _stop(error: Error): void {
    if (this._error) return
    this._error = error
    this._fail(error)
  }
}
