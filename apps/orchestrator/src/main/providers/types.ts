
export type PtySpawnOptions = {
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  sessionId?: string
  isNewSession?: boolean
  shellOverride?: string
  worktreeId?: string
}

export type PtySpawnResult = {
  id: string
  pid?: number | null
  snapshot?: string
  snapshotCols?: number
  snapshotRows?: number
  isReattach?: boolean
  isAlternateScreen?: boolean
}

export type PtyProcessInfo = {
  id: string
  cwd: string
  title: string
  terminalHandle?: string
}

export type IPtyProvider = {
  spawn(opts: PtySpawnOptions): Promise<PtySpawnResult>
  attach(id: string): Promise<void>
  hasPty?: (id: string) => boolean
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void

  getAppliedSize?: (id: string) => Promise<{ cols: number; rows: number } | null>
  getScreenSnapshot?: (id: string) => Promise<{ data: string; cols: number; rows: number } | null>

  shutdown(id: string, opts: { immediate?: boolean }): Promise<void>
  sendSignal(id: string, signal: string): Promise<void>
  getCwd(id: string): Promise<string>
  getInitialCwd(id: string): Promise<string>
  clearBuffer(id: string): Promise<void>
  acknowledgeDataEvent(id: string, charCount: number): void
  hasChildProcesses(id: string): Promise<boolean>
  getForegroundProcess(id: string): Promise<string | null>
  serialize(ids: string[]): Promise<string>
  revive(state: string): Promise<void>
  listProcesses(): Promise<PtyProcessInfo[]>
  getDefaultShell(): Promise<string>
  getProfiles(): Promise<{ name: string; path: string }[]>
  onData(callback: (payload: { id: string; data: string }) => void): () => void
  onReplay(callback: (payload: { id: string; data: string }) => void): () => void
  onExit(callback: (payload: { id: string; code: number }) => void): () => void
}
