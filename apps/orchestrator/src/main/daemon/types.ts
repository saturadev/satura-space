import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'


export const PROTOCOL_VERSION = 1

export type SessionState = 'created' | 'spawning' | 'running' | 'exiting' | 'exited'

export type TerminalSnapshot = {
  snapshotAnsi: string
  scrollbackAnsi: string
  oscLinks?: TerminalOscLinkRange[]
  rehydrateSequences: string
  cwd: string | null
  modes: TerminalModes
  cols: number
  rows: number
  scrollbackLines: number
  lastTitle?: string
}

export type TerminalModes = {
  bracketedPaste: boolean
  mouseTracking: boolean
  mouseTrackingMode?: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
  sgrMouseMode?: boolean
  sgrMousePixelsMode?: boolean
  applicationCursor: boolean
  alternateScreen: boolean
}

export type HelloMessage = {
  type: 'hello'
  version: number
  token: string
  clientId: string
  role: 'control' | 'stream'
}

export type HelloResponse = {
  type: 'hello'
  ok: boolean
  error?: string
  buildId?: string
}

export type CreateOrAttachRequest = {
  id: string
  type: 'createOrAttach'
  payload: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    shellOverride?: string
  }
}

export type CancelCreateOrAttachRequest = {
  id: string
  type: 'cancelCreateOrAttach'
  payload: {
    sessionId: string
  }
}

export type WriteRequest = {
  id: string
  type: 'write'
  payload: {
    sessionId: string
    data: string
  }
}

export type ResizeRequest = {
  id: string
  type: 'resize'
  payload: {
    sessionId: string
    cols: number
    rows: number
  }
}

export type KillRequest = {
  id: string
  type: 'kill'
  payload: {
    sessionId: string
    immediate?: boolean
  }
}

export type SignalRequest = {
  id: string
  type: 'signal'
  payload: {
    sessionId: string
    signal: string
  }
}

export type ListSessionsRequest = {
  id: string
  type: 'listSessions'
}

export type DetachRequest = {
  id: string
  type: 'detach'
  payload: {
    sessionId: string
  }
}

export type GetCwdRequest = {
  id: string
  type: 'getCwd'
  payload: {
    sessionId: string
  }
}

export type GetForegroundProcessRequest = {
  id: string
  type: 'getForegroundProcess'
  payload: {
    sessionId: string
  }
}

export type ClearScrollbackRequest = {
  id: string
  type: 'clearScrollback'
  payload: {
    sessionId: string
  }
}

export type ShutdownRequest = {
  id: string
  type: 'shutdown'
  payload: {
    killSessions: boolean
  }
}

export type PingRequest = {
  id: string
  type: 'ping'
}

export type SystemResolverHealthRequest = {
  id: string
  type: 'systemResolverHealth'
}

export type PtySpawnHealthRequest = {
  id: string
  type: 'ptySpawnHealth'
}

export type GetSnapshotRequest = {
  id: string
  type: 'getSnapshot'
  payload: {
    sessionId: string
  }
}

export type GetSizeRequest = {
  id: string
  type: 'getSize'
  payload: {
    sessionId: string
  }
}

export type DaemonRequest =
  | CreateOrAttachRequest
  | CancelCreateOrAttachRequest
  | WriteRequest
  | ResizeRequest
  | KillRequest
  | SignalRequest
  | ListSessionsRequest
  | DetachRequest
  | GetCwdRequest
  | GetForegroundProcessRequest
  | ClearScrollbackRequest
  | ShutdownRequest
  | PingRequest
  | SystemResolverHealthRequest
  | PtySpawnHealthRequest
  | GetSnapshotRequest
  | GetSizeRequest

export type RpcResponseOk<T = unknown> = {
  id: string
  ok: true
  payload: T
}

export type RpcResponseError = {
  id: string
  ok: false
  error: string
}

export type RpcResponse<T = unknown> = RpcResponseOk<T> | RpcResponseError

export type CreateOrAttachResult = {
  isNew: boolean
  snapshot: TerminalSnapshot | null
  pid: number | null
}

export type GetSnapshotResult = {
  snapshot: TerminalSnapshot | null
}

export type ListSessionsResult = {
  sessions: SessionInfo[]
}

export type SystemResolverHealth = 'healthy' | 'unhealthy' | 'unknown'

export type SystemResolverHealthResult = {
  health: SystemResolverHealth
}

export type SessionInfo = {
  sessionId: string
  state: SessionState
  isAlive: boolean
  terminalHandle?: string
  pid: number | null
  cwd: string | null
  cols: number
  rows: number
  createdAt: number
}

export type DataEvent = {
  type: 'event'
  event: 'data'
  sessionId: string
  payload: { data: string }
}

export type ExitEvent = {
  type: 'event'
  event: 'exit'
  sessionId: string
  payload: { code: number }
}

export type TerminalErrorEvent = {
  type: 'event'
  event: 'terminalError'
  sessionId: string
  payload: { message: string }
}

export type DaemonEvent = DataEvent | ExitEvent | TerminalErrorEvent

export const NOTIFY_PREFIX = 'notify_'

export class DaemonProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonProtocolError'
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}
