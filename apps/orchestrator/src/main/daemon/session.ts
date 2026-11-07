import { HeadlessEmulator } from './headless-emulator'
import { isValidPtySize, normalizePtySize } from './daemon-pty-size'
import type { SessionState, TerminalSnapshot } from './types'

const KILL_TIMEOUT_MS = 5_000

export type SubprocessHandle = {
  pid: number
  getForegroundProcess(): string | null
  write(data: string): void
  resize(cols: number, rows: number): void

  clear?(): void
  kill(): void
  forceKill(): void
  signal(sig: string): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number) => void): void

  dispose(): void
}

export type SessionOptions = {
  sessionId: string
  cols: number
  rows: number
  terminalHandle?: string
  subprocess: SubprocessHandle
  scrollback?: number
  onExit?: (code: number) => void
}

type AttachedClient = {
  token: symbol
  onData: (data: string) => void
  onExit: (code: number) => void
}

export class Session {
  readonly sessionId: string
  readonly terminalHandle: string | null
  private _state: SessionState = 'running'
  private _exitCode: number | null = null
  private _isTerminating = false
  private _disposed = false
  private emulator: HeadlessEmulator
  private subprocess: SubprocessHandle
  private readonly onSessionExit?: (code: number) => void
  private attachedClients: AttachedClient[] = []
  private killTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId
    this.terminalHandle = opts.terminalHandle ?? null
    this.subprocess = opts.subprocess
    this.onSessionExit = opts.onExit
    const size = normalizePtySize(opts.cols, opts.rows)
    this.emulator = new HeadlessEmulator({
      cols: size.cols,
      rows: size.rows,
      scrollback: opts.scrollback
    })

    this.subprocess.onData((data) => this.handleSubprocessData(data))
    this.subprocess.onExit((code) => this.handleSubprocessExit(code))
  }

  get state(): SessionState {
    return this._state
  }

  get exitCode(): number | null {
    return this._exitCode
  }

  get isAlive(): boolean {
    return this._state !== 'exited'
  }

  get isTerminating(): boolean {
    return this._isTerminating
  }

  get pid(): number {
    return this.subprocess.pid
  }

  write(data: string): void {
    if (this._state === 'exited' || this._disposed) {
      return
    }

    this.subprocess.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this._state === 'exited' || this._disposed) {
      return
    }
    if (!isValidPtySize(cols, rows)) {
      return
    }
    this.emulator.resize(cols, rows)
    this.subprocess.resize(cols, rows)
  }

  kill(): void {
    if (this._state === 'exited' || this._isTerminating) {
      return
    }
    this._isTerminating = true

    this.subprocess.kill()

    this.killTimer = setTimeout(() => {
      if (this._state !== 'exited') {
        this.forceDispose()
      }
    }, KILL_TIMEOUT_MS)
  }

  signal(sig: string): void {
    if (this._state === 'exited') {
      return
    }
    this.subprocess.signal(sig)
  }

  attachClient(client: { onData: (data: string) => void; onExit: (code: number) => void }): symbol {
    const token = Symbol('attach')
    this.attachedClients.push({ token, ...client })
    return token
  }

  detachClient(token: symbol): void {
    const idx = this.attachedClients.findIndex((c) => c.token === token)
    if (idx !== -1) {
      this.attachedClients.splice(idx, 1)
    }
  }

  detachAllClients(): void {
    this.attachedClients.length = 0
  }

  getSnapshot(): TerminalSnapshot | null {
    if (this._disposed) {
      return null
    }
    return this.emulator.getSnapshot()
  }

  getAppliedSize(): { cols: number; rows: number } | null {
    if (this._disposed) {
      return null
    }
    return this.emulator.getAppliedSize()
  }

  getCwd(): string | null {
    return this.emulator.getCwd()
  }

  getForegroundProcess(): string | null {
    return this.subprocess.getForegroundProcess()
  }

  clearScrollback(): void {
    if (this._disposed) {
      return
    }
    this.emulator.clearScrollback()
    this.subprocess.clear?.()
  }

  dispose(): void {
    if (this._disposed) {
      return
    }

    const wasTerminating = this._isTerminating && this._state !== 'exited'
    const clientsToNotify = wasTerminating ? this.attachedClients.slice() : []
    if (wasTerminating) {
      try {
        this.subprocess.forceKill()
      } catch {
      }
      this._exitCode = -1
      this._isTerminating = false
    }

    this.#teardownSubprocess()
    this._state = 'exited'

    this.attachedClients = []
    this.emulator.dispose()

    for (const client of clientsToNotify) {
      client.onExit(-1)
    }
  }

  disposeSubprocess(): void {
    this.#teardownSubprocess()
    this._state = 'exited'
  }

  forceKillAndDisposeSubprocess(): void {
    try {
      this.subprocess.forceKill()
    } catch {
    }
    this.#teardownSubprocess()
    this._state = 'exited'
    this.emulator.dispose()
  }

  #teardownSubprocess(): void {
    if (this._disposed) {
      return
    }
    this._disposed = true
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
    try {
      this.subprocess.dispose()
    } catch (err) {
      console.warn('[Session] subprocess.dispose() threw:', err)
    }
  }

  private handleSubprocessData(data: string): void {
    if (this._disposed) {
      return
    }

    if (data.length === 0) {
      return
    }

    this.emulator.write(data)

    for (const client of this.attachedClients) {
      client.onData(data)
    }
  }

  private handleSubprocessExit(code: number): void {
    if (this._disposed) {
      return
    }

    this._exitCode = code
    this._state = 'exited'

    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }

    try {
      this.subprocess.dispose()
    } catch {
    }

    for (const client of this.attachedClients) {
      client.onExit(code)
    }

    this.onSessionExit?.(code)
  }

  private forceDispose(): void {
    if (this._state === 'exited') {
      return
    }
    try {
      this.subprocess.forceKill()
    } catch {
    }
    this._exitCode = -1
    this._isTerminating = false

    this.#teardownSubprocess()
    this._state = 'exited'

    const clients = this.attachedClients
    this.attachedClients = []
    this.emulator.dispose()

    for (const client of clients) {
      client.onExit(-1)
    }

    this.onSessionExit?.(-1)
  }
}
