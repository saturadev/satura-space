import { Session, type SubprocessHandle } from './session'
import { normalizePtySize } from './daemon-pty-size'
import { resolveProcessCwd } from '../providers/process-cwd'
import type { SessionInfo, TerminalSnapshot } from './types'
import { SessionNotFoundError } from './types'

const DEFAULT_MAX_TOMBSTONES = 1000

export type CreateOrAttachOptions = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  shellOverride?: string
  streamClient: { onData: (data: string) => void; onExit: (code: number) => void }
}

export type CreateOrAttachResult = {
  isNew: boolean
  snapshot: TerminalSnapshot | null
  pid: number | null
  attachToken: symbol
}

export type TerminalHostOptions = {
  spawnSubprocess: (opts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    shellOverride?: string
  }) => SubprocessHandle
  maxTombstones?: number
}

export class TerminalHost {
  private sessions = new Map<string, Session>()
  private killedTombstones = new Map<string, number>()
  private spawnSubprocess: TerminalHostOptions['spawnSubprocess']
  private maxTombstones: number

  constructor(opts: TerminalHostOptions) {
    this.spawnSubprocess = opts.spawnSubprocess
    this.maxTombstones = opts.maxTombstones ?? DEFAULT_MAX_TOMBSTONES
  }

  async createOrAttach(opts: CreateOrAttachOptions): Promise<CreateOrAttachResult> {
    const existing = this.sessions.get(opts.sessionId)

    if (existing && existing.isAlive && !existing.isTerminating) {
      const snapshot = existing.getSnapshot()
      existing.detachAllClients()
      const token = existing.attachClient(opts.streamClient)
      return {
        isNew: false,
        snapshot,
        pid: existing.pid,
        attachToken: token
      }
    }

    if (existing) {
      existing.dispose()
      this.sessions.delete(opts.sessionId)
    }

    this.killedTombstones.delete(opts.sessionId)
    const size = normalizePtySize(opts.cols, opts.rows)

    const subprocess = this.spawnSubprocess({
      sessionId: opts.sessionId,
      cols: size.cols,
      rows: size.rows,
      cwd: opts.cwd,
      env: opts.env,
      shellOverride: opts.shellOverride
    })

    const session = new Session({
      sessionId: opts.sessionId,
      cols: size.cols,
      rows: size.rows,
      terminalHandle: opts.env?.ORCA_TERMINAL_HANDLE,
      subprocess,
      onExit: () => this.reapSession(opts.sessionId)
    })

    this.sessions.set(opts.sessionId, session)

    const token = session.attachClient(opts.streamClient)

    return {
      isNew: true,
      snapshot: null,
      pid: subprocess.pid,
      attachToken: token
    }
  }

  write(sessionId: string, data: string): void {
    this.getAliveSession(sessionId).write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.getAliveSession(sessionId).resize(cols, rows)
  }

  kill(sessionId: string, opts: { immediate?: boolean } = {}): void {
    const session = this.getAliveSession(sessionId)
    this.recordTombstone(sessionId)
    if (opts.immediate) {
      session.forceKillAndDisposeSubprocess()
      this.reapSession(sessionId)
      return
    }
    session.kill()
  }

  private reapSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.isAlive) {
      return
    }
    session.dispose()
    this.sessions.delete(sessionId)
  }

  signal(sessionId: string, sig: string): void {
    this.getAliveSession(sessionId).signal(sig)
  }

  detach(sessionId: string, token: symbol): void {
    const session = this.sessions.get(sessionId)
    session?.detachClient(token)
  }

  async getCwd(sessionId: string): Promise<string | null> {
    const session = this.getAliveSession(sessionId)
    const tracked = session.getCwd()
    if (tracked) {
      return tracked
    }
    const resolved = await resolveProcessCwd(session.pid)
    return resolved || null
  }

  getForegroundProcess(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    return session.getForegroundProcess()
  }

  clearScrollback(sessionId: string): void {
    this.getAliveSession(sessionId).clearScrollback()
  }

  getSnapshot(sessionId: string): TerminalSnapshot | null {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    return session.getSnapshot()
  }

  getAppliedSize(sessionId: string): { cols: number; rows: number } | null {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    return session.getAppliedSize()
  }

  listSessions(): SessionInfo[] {
    const result: SessionInfo[] = []
    for (const [, session] of this.sessions) {
      if (!session.isAlive) {
        continue
      }
      const size = session.getAppliedSize()
      result.push({
        sessionId: session.sessionId,
        state: session.state,
        isAlive: true,
        ...(session.terminalHandle ? { terminalHandle: session.terminalHandle } : {}),
        pid: session.pid,
        cwd: session.getCwd(),
        cols: size?.cols ?? 0,
        rows: size?.rows ?? 0,
        createdAt: 0
      })
    }
    return result
  }

  dispose(): void {
    for (const [, session] of this.sessions) {
      session.detachAllClients()
      if (session.isAlive) {
        session.forceKillAndDisposeSubprocess()
      } else {
        session.disposeSubprocess()
      }
    }
    this.sessions.clear()
    this.killedTombstones.clear()
  }

  private getAliveSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      throw new SessionNotFoundError(sessionId)
    }
    return session
  }

  private recordTombstone(sessionId: string): void {
    this.killedTombstones.delete(sessionId)
    this.killedTombstones.set(sessionId, Date.now())

    if (this.killedTombstones.size > this.maxTombstones) {
      const oldest = this.killedTombstones.keys().next().value
      if (oldest) {
        this.killedTombstones.delete(oldest)
      }
    }
  }
}
