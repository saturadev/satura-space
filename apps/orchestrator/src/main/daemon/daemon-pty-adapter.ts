
import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import { DaemonClient } from './client'
import { getMacDaemonSystemResolverHealth } from './daemon-health'
import { SessionCwdStore } from './session-cwd-store'
import { mintPtySessionId } from './pty-session-id'
import {
  PROTOCOL_VERSION,
  type CreateOrAttachResult,
  type DaemonEvent,
  type ListSessionsResult,
  type SessionInfo,
  type TerminalSnapshot
} from './types'
import type {
  IPtyProvider,
  PtyProcessInfo,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/types'
import { censusTrack } from '@shared/census'

const SHELL_PROCESS_NAMES = new Set([
  'zsh',
  'bash',
  'sh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  '-zsh',
  '-bash',
  '-sh',
  '-fish',
  'login'
])
function isShellProcess(name: string): boolean {
  const base = name.split('/').pop() ?? name
  return SHELL_PROCESS_NAMES.has(base.trim())
}

export type DaemonPtyAdapterOptions = {
  socketPath: string
  tokenPath: string
  protocolVersion?: number
  cwdStorePath?: string
  respawn?: () => Promise<void>
}

export type LegacyDaemonOption = {
  socketPath: string
  tokenPath: string
  label: string
  retire: () => Promise<void>
}

type LegacyDaemon = {
  label: string
  client: DaemonClient
  sessionIds: Set<string>
  retire: () => Promise<void>
  removeListeners: (() => void)[]
  retiring: boolean
}

const MAX_TOMBSTONES = 1000

export class TerminalKilledError extends Error {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" was explicitly killed`)
    this.name = 'TerminalKilledError'
  }
}

export class DaemonPtyAdapter implements IPtyProvider {
  readonly protocolVersion: number
  private socketPath: string
  private tokenPath: string
  private client: DaemonClient
  private cwdStore: SessionCwdStore | null
  private respawnFn: (() => Promise<void>) | null
  private respawnPromise: Promise<void> | null = null
  private dataListeners: ((payload: { id: string; data: string }) => void)[] = []
  private exitListeners: ((payload: { id: string; code: number }) => void)[] = []
  private removeEventListener: (() => void) | null = null
  private initialCwds = censusTrack('daemon-pty-adapter.initialCwds', new Map<string, string>())
  private killedSessionTombstones = censusTrack('daemon-pty-adapter.killedSessionTombstones', new Map<string, number>())
  private activeSessionIds = censusTrack('daemon-pty-adapter.activeSessionIds', new Set<string>())
  private pendingKills = censusTrack('daemon-pty-adapter.pendingKills', new Set<string>())
  private legacy: LegacyDaemon[] = []
  private recovering: Promise<void> | null = null
  private flushingKills: Promise<void> | null = null
  private disposed = false
  private removeDisconnectListener: (() => void) | null = null

  constructor(opts: DaemonPtyAdapterOptions) {
    this.protocolVersion = opts.protocolVersion ?? PROTOCOL_VERSION
    this.socketPath = opts.socketPath
    this.tokenPath = opts.tokenPath
    this.client = new DaemonClient({
      socketPath: opts.socketPath,
      tokenPath: opts.tokenPath,
      protocolVersion: opts.protocolVersion
    })
    this.cwdStore = opts.cwdStorePath ? new SessionCwdStore(opts.cwdStorePath) : null
    this.respawnFn = opts.respawn ?? null
    this.removeDisconnectListener = this.client.onDisconnect((reason) =>
      this.handlePrimaryDisconnect(reason)
    )
  }

  async attachLegacyDaemons(list: LegacyDaemonOption[]): Promise<void> {
    for (const opt of list) {
      if (this.disposed || this.legacy.some((entry) => entry.label === opt.label)) {
        continue
      }
      const client = new DaemonClient({
        socketPath: opt.socketPath,
        tokenPath: opt.tokenPath,
        protocolVersion: this.protocolVersion
      })
      const entry: LegacyDaemon = {
        label: opt.label,
        client,
        sessionIds: new Set(),
        retire: opt.retire,
        removeListeners: [],
        retiring: false
      }
      try {
        await client.ensureConnected()
        const result = await client.request<ListSessionsResult>('listSessions', undefined)
        for (const session of result.sessions) {
          if (session.isAlive) entry.sessionIds.add(session.sessionId)
        }
      } catch (err) {
        console.warn(
          `[daemon] old daemon ${opt.label} is unreachable (${err instanceof Error ? err.message : String(err)}); cleaning it up`
        )
        client.disconnect()
        await opt.retire().catch(() => {})
        continue
      }
      entry.removeListeners.push(client.onEvent((raw) => this.handleLegacyEvent(entry, raw)))
      entry.removeListeners.push(client.onDisconnect(() => this.handleLegacyDisconnect(entry)))
      this.legacy.push(entry)
      console.log(
        `[daemon] old daemon ${opt.label} keeps serving ${entry.sessionIds.size} session(s); new terminals start in the current daemon`
      )
      if (entry.sessionIds.size === 0) {
        void this.retireLegacy(entry)
      }
    }
  }

  getSocketPath(): string {
    return this.socketPath
  }

  retarget(socketPath: string, tokenPath: string): void {
    this.removeDisconnectListener?.()
    this.removeEventListener?.()
    this.removeEventListener = null
    this.client.disconnect()
    this.socketPath = socketPath
    this.tokenPath = tokenPath
    this.client = new DaemonClient({ socketPath, tokenPath, protocolVersion: this.protocolVersion })
    this.removeDisconnectListener = this.client.onDisconnect((reason) =>
      this.handlePrimaryDisconnect(reason)
    )
  }

  getLegacyDaemons(): { label: string; sessionIds: string[] }[] {
    return this.legacy.map((entry) => ({ label: entry.label, sessionIds: [...entry.sessionIds] }))
  }

  getPendingKills(): string[] {
    return [...this.pendingKills]
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    if (this.recovering) {
      await this.recovering.catch(() => {})
    }
    const legacy = opts.sessionId ? this.legacyFor(opts.sessionId) : null
    if (legacy && opts.sessionId) {
      const attached = await this.attachOnLegacy(legacy, opts.sessionId)
      if (attached) {
        return attached
      }
    }
    return this.withDaemonRetry(() => this.doSpawn(opts))
  }

  private async attachOnLegacy(entry: LegacyDaemon, sessionId: string): Promise<PtySpawnResult | null> {
    try {
      await entry.client.ensureConnected()
      const result = await entry.client.request<CreateOrAttachResult>('createOrAttach', {
        sessionId,
        cols: 80,
        rows: 24
      })
      if (result.isNew) {
        await entry.client.request('kill', { sessionId, immediate: true }).catch(() => {})
        entry.sessionIds.delete(sessionId)
        this.maybeRetireLegacy(entry)
        return null
      }
      this.activeSessionIds.add(sessionId)
      const pid = typeof result.pid === 'number' && result.pid > 0 ? result.pid : null
      console.log(`[daemon] reattached ${sessionId} on old daemon ${entry.label}`)
      if (!result.snapshot) {
        return { id: sessionId, pid, isReattach: true }
      }
      return {
        id: sessionId,
        pid,
        snapshot: result.snapshot.rehydrateSequences + result.snapshot.snapshotAnsi,
        snapshotCols: result.snapshot.cols,
        snapshotRows: result.snapshot.rows,
        isReattach: true,
        isAlternateScreen: result.snapshot.modes.alternateScreen
      }
    } catch (err) {
      console.warn(
        `[daemon] could not reattach ${sessionId} on old daemon ${entry.label}: ${err instanceof Error ? err.message : String(err)}`
      )
      entry.sessionIds.delete(sessionId)
      this.maybeRetireLegacy(entry)
      return null
    }
  }

  private async doSpawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const sessionId = opts.sessionId ?? mintPtySessionId(opts.worktreeId)

    if (this.killedSessionTombstones.has(sessionId)) {
      throw new TerminalKilledError(sessionId)
    }

    if (opts.isNewSession) {
      await this.replaceUnhealthyMacResolverDaemonBeforeNewPty()
    }

    await this.ensureConnected()

    const savedCwd = this.cwdStore?.get(sessionId)
    const restoredCwd = savedCwd && (await this.getAppliedSize(sessionId)) === null ? savedCwd : undefined
    const effectiveCwd = restoredCwd ?? opts.cwd

    const result = await this.client.request<CreateOrAttachResult>('createOrAttach', {
      sessionId,
      cols: opts.cols,
      rows: opts.rows,
      cwd: effectiveCwd,
      env: opts.env,
      shellOverride: opts.shellOverride
    })

    if (effectiveCwd) {
      this.initialCwds.set(sessionId, effectiveCwd)
      if (result.isNew) this.cwdStore?.set(sessionId, effectiveCwd)
    }

    const pid = typeof result.pid === 'number' && result.pid > 0 ? result.pid : null
    this.activeSessionIds.add(sessionId)

    const isReattach = !result.isNew
    if (!isReattach || !result.snapshot) {
      return { id: sessionId, pid, ...(isReattach ? { isReattach: true } : {}) }
    }

    const isAltScreen = result.snapshot.modes.alternateScreen
    const snapshotPayload = result.snapshot.rehydrateSequences + result.snapshot.snapshotAnsi
    return {
      id: sessionId,
      pid,
      snapshot: snapshotPayload,
      snapshotCols: result.snapshot.cols,
      snapshotRows: result.snapshot.rows,
      isReattach: true,
      isAlternateScreen: isAltScreen
    }
  }

  async attach(id: string): Promise<void> {
    const legacy = this.legacyFor(id)
    if (legacy) {
      await this.attachOnLegacy(legacy, id)
      return
    }
    await this.ensureConnected()

    await this.client.request<CreateOrAttachResult>('createOrAttach', {
      sessionId: id,
      cols: 80,
      rows: 24
    })
  }

  hasPty(id: string): boolean {
    return this.activeSessionIds.has(id)
  }

  write(id: string, data: string): void {
    this.clientFor(id).notify('write', { sessionId: id, data })
  }

  resize(id: string, cols: number, rows: number): void {
    this.clientFor(id).notify('resize', { sessionId: id, cols, rows })
  }

  async shutdown(id: string, opts: { immediate?: boolean }): Promise<void> {
    const legacy = this.legacyFor(id)
    const client = legacy?.client ?? this.client
    try {
      await client.request('kill', { sessionId: id, immediate: opts.immediate ?? false })
      if (legacy) {
        legacy.sessionIds.delete(id)
        this.maybeRetireLegacy(legacy)
      }
    } catch (err) {
      if (!isSessionNotFoundError(err)) {
        this.pendingKills.add(id)
        console.warn(
          `[daemon] kill ${id} failed (${err instanceof Error ? err.message : String(err)}); retrying after reconnect`
        )
        throw err
      }
    } finally {
      this.releaseShutdownSession(id)
    }
  }

  private releaseShutdownSession(id: string): void {
    this.activeSessionIds.delete(id)
    this.initialCwds.delete(id)
    this.cwdStore?.delete(id)
    this.killedSessionTombstones.delete(id)
    this.killedSessionTombstones.set(id, Date.now())
    if (this.killedSessionTombstones.size > MAX_TOMBSTONES) {
      const oldest = this.killedSessionTombstones.keys().next().value
      if (oldest) {
        this.killedSessionTombstones.delete(oldest)
      }
    }
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    await this.clientFor(id).request('signal', { sessionId: id, signal })
  }

  async getCwd(id: string): Promise<string> {
    try {
      const result = await this.clientFor(id).request<{ cwd: string | null }>('getCwd', {
        sessionId: id
      })
      return result.cwd ?? ''
    } catch {
      return ''
    }
  }

  async getInitialCwd(id: string): Promise<string> {
    return this.initialCwds.get(id) ?? ''
  }

  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    try {
      const result = await this.clientFor(id).request<{ size: { cols: number; rows: number } | null }>(
        'getSize',
        { sessionId: id }
      )
      return result.size ?? null
    } catch {
      return null
    }
  }

  async getScreenSnapshot(id: string): Promise<{ data: string; cols: number; rows: number } | null> {
    try {
      const result = await this.clientFor(id).request<{ snapshot: TerminalSnapshot | null }>('getSnapshot', { sessionId: id })
      const s = result.snapshot
      return s ? { data: s.rehydrateSequences + s.snapshotAnsi, cols: s.cols, rows: s.rows } : null
    } catch {
      return null
    }
  }

  async clearBuffer(id: string): Promise<void> {
    await this.clientFor(id).request('clearScrollback', { sessionId: id })
  }

  acknowledgeDataEvent(_id: string, _charCount: number): void {
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    const foregroundProcess = await this.getForegroundProcess(id)
    return foregroundProcess !== null && !isShellProcess(foregroundProcess)
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    try {
      const result = await this.clientFor(id).request<{ foregroundProcess: string | null }>(
        'getForegroundProcess',
        { sessionId: id }
      )
      return result.foregroundProcess
    } catch {
      return null
    }
  }

  async serialize(ids: string[]): Promise<string> {
    const sessions: Record<string, { initialCwd?: string }> = {}
    for (const id of ids) {
      sessions[id] = { initialCwd: this.initialCwds.get(id) }
    }
    return JSON.stringify(sessions)
  }

  async revive(_state: string): Promise<void> {
  }

  async listProcesses(): Promise<PtyProcessInfo[]> {
    return (await this.listSessions()).map((s) => ({
      id: s.sessionId,
      cwd: s.cwd ?? '',
      title: 'shell',
      ...(s.terminalHandle ? { terminalHandle: s.terminalHandle } : {})
    }))
  }

  async listSessions(): Promise<SessionInfo[]> {
    await this.ensureConnected()
    const result = await this.client.request<ListSessionsResult>('listSessions', undefined)
    const sessions = result.sessions.filter((s) => s.isAlive)
    for (const entry of this.legacy) {
      try {
        const legacyResult = await entry.client.request<ListSessionsResult>('listSessions', undefined)
        for (const session of legacyResult.sessions) {
          if (session.isAlive && entry.sessionIds.has(session.sessionId)) sessions.push(session)
        }
      } catch {
      }
    }
    return sessions
  }

  getActiveSessionIds(): string[] {
    return [...this.activeSessionIds]
  }

  fanoutSyntheticExits(code: number): void {
    const ids = [...this.activeSessionIds]
    this.activeSessionIds.clear()
    for (const id of ids) {
      for (const listener of [...this.exitListeners]) {
        listener({ id, code })
      }
    }
  }

  async getDefaultShell(): Promise<string> {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'powershell.exe'
    }
    return process.env.SHELL || '/bin/zsh'
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    if (process.platform === 'win32') {
      return [
        { name: 'PowerShell', path: 'powershell.exe' },
        { name: 'Command Prompt', path: 'cmd.exe' }
      ]
    }
    const shells = ['/bin/zsh', '/bin/bash', '/bin/sh']
    return shells.filter((s) => existsSync(s)).map((s) => ({ name: basename(s), path: s }))
  }

  onData(callback: (payload: { id: string; data: string }) => void): () => void {
    this.dataListeners.push(callback)
    return () => {
      const idx = this.dataListeners.indexOf(callback)
      if (idx !== -1) {
        this.dataListeners.splice(idx, 1)
      }
    }
  }

  onReplay(_callback: (payload: { id: string; data: string }) => void): () => void {
    return () => {}
  }

  onExit(callback: (payload: { id: string; code: number }) => void): () => void {
    this.exitListeners.push(callback)
    return () => {
      const idx = this.exitListeners.indexOf(callback)
      if (idx !== -1) {
        this.exitListeners.splice(idx, 1)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.removeDisconnectListener?.()
    this.removeDisconnectListener = null
    this.removeEventListener?.()
    this.removeEventListener = null
    this.client.disconnect()
    this.dropLegacyClients()
  }

  async disconnectOnly(): Promise<void> {
    await this.saveSessionCwds()
    this.dispose()
  }

  private dropLegacyClients(): void {
    for (const entry of this.legacy) {
      for (const remove of entry.removeListeners.splice(0)) remove()
      entry.client.disconnect()
    }
    this.legacy = []
  }

  private legacyFor(id: string): LegacyDaemon | null {
    return this.legacy.find((entry) => entry.sessionIds.has(id)) ?? null
  }

  private clientFor(id: string): DaemonClient {
    return this.legacyFor(id)?.client ?? this.client
  }

  private emitExit(id: string, code: number): void {
    this.activeSessionIds.delete(id)
    this.cwdStore?.delete(id)
    this.initialCwds.delete(id)
    for (const listener of [...this.exitListeners]) {
      listener({ id, code })
    }
  }

  private handlePrimaryDisconnect(reason: string): void {
    if (this.disposed) {
      return
    }
    this.removeEventListener?.()
    this.removeEventListener = null
    const ids = [...this.activeSessionIds].filter((id) => !this.legacyFor(id))
    console.warn(
      `[daemon] connection to the terminal daemon lost (${reason}); ${ids.length} open session(s)`
    )
    if (!this.recovering) {
      this.recovering = this.recoverAfterDisconnect(ids).finally(() => {
        this.recovering = null
      })
    }
  }

  private async recoverAfterDisconnect(ids: string[]): Promise<void> {
    let alive: Set<string> | null = null
    try {
      await this.client.ensureConnected()
      this.setupEventRouting()
      const result = await this.client.request<ListSessionsResult>('listSessions', undefined)
      alive = new Set(result.sessions.filter((s) => s.isAlive).map((s) => s.sessionId))
    } catch {
      alive = null
    }
    if (this.disposed) {
      return
    }
    if (alive) {
      let reattached = 0
      for (const id of ids) {
        if (!alive.has(id)) {
          this.emitExit(id, -1)
          continue
        }
        try {
          const result = await this.client.request<CreateOrAttachResult>('createOrAttach', {
            sessionId: id,
            cols: 80,
            rows: 24
          })
          if (result.isNew) {
            await this.client.request('kill', { sessionId: id, immediate: true }).catch(() => {})
            this.emitExit(id, -1)
          } else {
            reattached++
          }
        } catch {
          this.emitExit(id, -1)
        }
      }
      console.log(`[daemon] reconnected to the running daemon; reattached ${reattached}/${ids.length} session(s)`)
      await this.flushPendingKills()
      return
    }
    console.warn(`[daemon] the terminal daemon is gone; marking ${ids.length} session(s) exited`)
    for (const id of ids) {
      this.emitExit(id, -1)
    }
    if (!this.respawnFn) {
      return
    }
    try {
      await this.respawnShared('[daemon] respawning the terminal daemon after it died')
      console.log('[daemon] terminal daemon respawned; new terminals use it')
    } catch (err) {
      console.error('[daemon] respawn after disconnect failed', err)
    }
  }

  private respawnShared(message?: string): Promise<void> {
    if (!this.respawnPromise) {
      this.respawnPromise = this.doRespawn(message).finally(() => {
        this.respawnPromise = null
      })
    }
    return this.respawnPromise
  }

  private async flushPendingKills(): Promise<void> {
    if (this.flushingKills || this.pendingKills.size === 0) {
      return this.flushingKills ?? undefined
    }
    this.flushingKills = (async () => {
      for (const id of [...this.pendingKills]) {
        const legacy = this.legacyFor(id)
        const client = legacy?.client ?? this.client
        try {
          await client.request('kill', { sessionId: id, immediate: true })
          this.pendingKills.delete(id)
          console.log(`[daemon] retried kill of ${id}: done`)
          if (legacy) {
            legacy.sessionIds.delete(id)
            this.maybeRetireLegacy(legacy)
          }
        } catch (err) {
          if (isSessionNotFoundError(err)) {
            this.pendingKills.delete(id)
            console.log(`[daemon] retried kill of ${id}: session already gone`)
            continue
          }
          console.warn(
            `[daemon] retried kill of ${id} failed (${err instanceof Error ? err.message : String(err)}); will retry again`
          )
          break
        }
      }
    })().finally(() => {
      this.flushingKills = null
    })
    return this.flushingKills
  }

  private handleLegacyEvent(entry: LegacyDaemon, raw: unknown): void {
    const event = raw as DaemonEvent
    if (event.type !== 'event' || !entry.sessionIds.has(event.sessionId)) {
      return
    }
    if (event.event === 'data') {
      if (this.killedSessionTombstones.has(event.sessionId)) {
        return
      }
      for (const listener of [...this.dataListeners]) {
        listener({ id: event.sessionId, data: event.payload.data })
      }
    } else if (event.event === 'exit') {
      entry.sessionIds.delete(event.sessionId)
      this.emitExit(event.sessionId, event.payload.code)
      this.maybeRetireLegacy(entry)
    }
  }

  private handleLegacyDisconnect(entry: LegacyDaemon): void {
    if (this.disposed || entry.retiring) {
      return
    }
    const ids = [...entry.sessionIds]
    console.warn(`[daemon] old daemon ${entry.label} went away; marking ${ids.length} session(s) exited`)
    entry.sessionIds.clear()
    for (const id of ids) {
      this.emitExit(id, -1)
    }
    void this.retireLegacy(entry)
  }

  private maybeRetireLegacy(entry: LegacyDaemon): void {
    if (entry.sessionIds.size === 0) {
      void this.retireLegacy(entry)
    }
  }

  private async retireLegacy(entry: LegacyDaemon): Promise<void> {
    if (entry.retiring || this.disposed) {
      return
    }
    entry.retiring = true
    try {
      if (entry.client.isConnected()) {
        const result = await entry.client.request<ListSessionsResult>('listSessions', undefined)
        const alive = result.sessions.filter((s) => s.isAlive)
        if (alive.length > 0) {
          for (const session of alive) entry.sessionIds.add(session.sessionId)
          entry.retiring = false
          return
        }
      }
    } catch {
    }
    if (this.disposed) {
      return
    }
    for (const remove of entry.removeListeners.splice(0)) remove()
    entry.client.disconnect()
    this.legacy = this.legacy.filter((candidate) => candidate !== entry)
    console.log(`[daemon] old daemon ${entry.label} has no sessions left; retiring it`)
    try {
      await entry.retire()
    } catch (err) {
      console.warn(`[daemon] retiring old daemon ${entry.label} failed`, err)
    }
  }

  private async saveSessionCwds(): Promise<void> {
    const store = this.cwdStore
    if (!store) return
    await Promise.all(
      [...this.activeSessionIds].map(async (id) => {
        const cwd = await this.getCwd(id)
        if (cwd) store.set(id, cwd)
      })
    )
  }

  private async ensureConnected(): Promise<void> {
    await this.client.ensureConnected()
    this.setupEventRouting()
    if (this.pendingKills.size > 0) {
      void this.flushPendingKills()
    }
  }

  private async withDaemonRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (!this.respawnFn || !isDaemonGoneError(err)) {
        throw err
      }
      await this.respawnShared()
      return await fn()
    }
  }

  private async replaceUnhealthyMacResolverDaemonBeforeNewPty(): Promise<void> {
    if (!this.respawnFn) {
      return
    }

    const health = await getMacDaemonSystemResolverHealth(
      this.socketPath,
      this.tokenPath,
      this.protocolVersion
    )
    if (health !== 'unhealthy') {
      return
    }

    const daemonLiveSessionCount = await this.getDaemonLiveSessionCount()
    const liveSessionCount = Math.max(this.activeSessionIds.size, daemonLiveSessionCount ?? 0)
    if (daemonLiveSessionCount === null || liveSessionCount > 0) {
      console.warn(
        daemonLiveSessionCount === null
          ? '[daemon] macOS system resolver unavailable - preserving daemon because live session state could not be verified'
          : `[daemon] macOS system resolver unavailable - preserving daemon because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}`
      )
      return
    }

    this.fanoutSyntheticExits(-1)
    await this.respawnShared('[daemon] macOS system resolver unavailable - respawning daemon')
  }

  private async getDaemonLiveSessionCount(): Promise<number | null> {
    try {
      await this.client.ensureConnected()
      const result = await this.client.request<ListSessionsResult>('listSessions', undefined)
      return result.sessions.filter((session) => session.isAlive).length
    } catch {
      return null
    }
  }

  private async doRespawn(message = '[daemon] Daemon died — respawning'): Promise<void> {
    console.warn(message)
    this.removeEventListener?.()
    this.removeEventListener = null
    this.client.disconnect()
    await this.respawnFn!()
  }

  private setupEventRouting(): void {
    if (this.removeEventListener) {
      return
    }

    this.removeEventListener = this.client.onEvent((raw) => {
      const event = raw as DaemonEvent
      if (event.type !== 'event') {
        return
      }

      if (event.event === 'data') {
        if (this.killedSessionTombstones.has(event.sessionId)) {
          return
        }
        for (const listener of [...this.dataListeners]) {
          listener({ id: event.sessionId, data: event.payload.data })
        }
      } else if (event.event === 'exit') {
        if (this.legacyFor(event.sessionId)) {
          return
        }
        this.emitExit(event.sessionId, event.payload.code)
      }
    })
  }
}

function isSessionNotFoundError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Session not found')
}

function isDaemonGoneError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false
  }
  const errno = err as NodeJS.ErrnoException
  if ((errno.code === 'ENOENT' || errno.code === 'ECONNREFUSED') && errno.syscall === 'connect') {
    return true
  }
  const msg = err.message
  return msg === 'Connection lost' || msg === 'Not connected'
}
