import { join } from 'node:path'
import { app } from 'electron'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { fork } from 'node:child_process'
import { connect } from 'node:net'
import {
  DAEMON_SLOT_COUNT,
  DaemonSpawner,
  assignDaemonPipeName,
  forgetDaemonPipeName,
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath,
  parseDaemonRuntimeFileName,
  serializeDaemonPidFile,
  type DaemonConnectionInfo,
  type DaemonLauncher,
  type DaemonProcessHandle,
  type LegacyDaemonInfo
} from './daemon-spawner'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonClient } from './client'
import { PROTOCOL_VERSION, type ListSessionsResult } from './types'
import {
  checkDaemonHealth,
  getProcessStartedAtMs,
  killStaleDaemon,
  readVerifiedDaemonPid,
  type DaemonHealth
} from './daemon-health'
import { computeDaemonBuildId } from './daemon-build-id'
import { rotateLogIfNeeded } from './daemon-log'
import { prepareDaemonLaunchTarget, pruneStaleDaemonRuntimes } from './daemon-runtime'
import {
  setLocalPtyProvider,
  unbindLocalProviderListeners,
  rebindLocalProviderListeners
} from '../ipc/pty'
import { listSessionWindows } from '../session-registry'
import { loadState } from '../persistence'
import type { WindowSession } from '@shared/api'

let spawner: DaemonSpawner | null = null
let adapter: DaemonPtyAdapter | null = null
let restartInFlight: Promise<RestartDaemonResult> | null = null
let initPromise: Promise<void> | null = null
let lastInitError: string | null = null
let orphanReapScheduled = false
let simulatedStartFailuresLeft = app.isPackaged
  ? 0
  : Math.max(0, Number(process.env.SATURA_DEV_DAEMON_FAIL_STARTS) || 0)

const ORPHAN_REAP_DELAY_MS = 60_000

function getRuntimeDir(): string {
  const dir = join(app.getPath('userData'), 'daemon')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getDaemonLogPath(): string {
  return join(getRuntimeDir(), 'daemon.log')
}

function getCwdStorePath(): string {
  rmSync(join(app.getPath('userData'), 'terminal-history'), { recursive: true, force: true })
  return join(app.getPath('userData'), 'terminal-cwds.json')
}

function getDaemonEntryPath(): string {
  const appPath = app.getAppPath()
  const basePath = app.isPackaged ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const directEntryPath = join(basePath, 'daemon-entry.js')
  if (existsSync(directEntryPath)) {
    return directEntryPath
  }
  return join(basePath, 'out', 'main', 'daemon-entry.js')
}

export function getOwnDaemonBuildId(): string {
  return computeDaemonBuildId(app.getVersion(), getDaemonEntryPath())
}

function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' && !existsSync(socketPath)) {
      resolve(false)
      return
    }
    const sock = connect({ path: socketPath })
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    function finish(alive: boolean, destroy?: boolean): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.removeListener('connect', onConnect)
      sock.removeListener('error', onError)
      if (destroy) sock.destroy()
      resolve(alive)
    }
    function onConnect(): void {
      finish(true, true)
    }
    function onError(): void {
      finish(false)
    }
    timer = setTimeout(() => finish(false, true), 1000)
    sock.on('connect', onConnect)
    sock.on('error', onError)
  })
}

async function getAliveDaemonSessionCount(
  socketPath: string,
  tokenPath: string
): Promise<number | null> {
  const client = new DaemonClient({ socketPath, tokenPath })
  try {
    await client.ensureConnected()
    const result = await client.request<ListSessionsResult>('listSessions', undefined)
    return result.sessions.filter((session) => session.isAlive).length
  } catch {
    return null
  } finally {
    client.disconnect()
  }
}

type SlotProbe = {
  slot: number
  socketPath: string
  tokenPath: string
  health: DaemonHealth
  buildId: string | null
  liveCount: number | null
}

function slotHasFiles(runtimeDir: string, slot: number): boolean {
  return (
    existsSync(getDaemonTokenPath(runtimeDir, PROTOCOL_VERSION, slot)) ||
    existsSync(getDaemonPidPath(runtimeDir, PROTOCOL_VERSION, slot)) ||
    (process.platform !== 'win32' && existsSync(getDaemonSocketPath(runtimeDir, PROTOCOL_VERSION, slot)))
  )
}

async function probeSlot(runtimeDir: string, slot: number): Promise<SlotProbe | null> {
  if (!slotHasFiles(runtimeDir, slot)) {
    return null
  }
  const socketPath = getDaemonSocketPath(runtimeDir, PROTOCOL_VERSION, slot)
  const tokenPath = getDaemonTokenPath(runtimeDir, PROTOCOL_VERSION, slot)
  const { health, buildId } = await checkDaemonHealth(socketPath, tokenPath)
  const liveCount = await getAliveDaemonSessionCount(socketPath, tokenPath)
  return { slot, socketPath, tokenPath, health, buildId, liveCount }
}

export async function cleanupOlderProtocolDaemons(runtimeDir: string): Promise<void> {
  let names: string[]
  try {
    names = readdirSync(runtimeDir)
  } catch {
    return
  }
  const groups = new Map<string, { protocolVersion: number; slot: number; files: string[] }>()
  for (const name of names) {
    const parsed = parseDaemonRuntimeFileName(name)
    if (!parsed || parsed.protocolVersion === PROTOCOL_VERSION) continue
    const key = `${parsed.protocolVersion}:${parsed.slot}`
    const group = groups.get(key) ?? { protocolVersion: parsed.protocolVersion, slot: parsed.slot, files: [] }
    group.files.push(join(runtimeDir, name))
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const socketPath = getDaemonSocketPath(runtimeDir, group.protocolVersion, group.slot)
    if (await probeSocket(socketPath)) {
      console.log(
        `[daemon] protocol v${group.protocolVersion} daemon (slot ${group.slot}) is still running; leaving its sessions alone`
      )
      continue
    }
    for (const file of group.files) {
      try {
        unlinkSync(file)
      } catch {
      }
    }
    console.log(
      `[daemon] removed stale protocol v${group.protocolVersion} daemon files: ${group.files.map((f) => f.split(/[\\/]/).pop()).join(', ')}`
    )
  }
}

function createSlotHandle(runtimeDir: string, slot: number, legacy: LegacyDaemonInfo[]): DaemonProcessHandle {
  return {
    info: {
      socketPath: getDaemonSocketPath(runtimeDir, PROTOCOL_VERSION, slot),
      tokenPath: getDaemonTokenPath(runtimeDir, PROTOCOL_VERSION, slot),
      slot
    },
    legacy,
    shutdown: async () => {
      await cleanupDaemonSlot(runtimeDir, slot)
    }
  }
}

function openDaemonLogFd(): number | 'ignore' {
  try {
    const logPath = getDaemonLogPath()
    rotateLogIfNeeded(logPath)
    return openSync(logPath, 'a')
  } catch {
    return 'ignore'
  }
}

async function forkDaemon(runtimeDir: string, slot: number, buildId: string): Promise<void> {
  const bundledEntryPath = getDaemonEntryPath()
  if (process.platform === 'win32') assignDaemonPipeName(runtimeDir, PROTOCOL_VERSION, slot)
  const socketPath = getDaemonSocketPath(runtimeDir, PROTOCOL_VERSION, slot)
  const tokenPath = getDaemonTokenPath(runtimeDir, PROTOCOL_VERSION, slot)
  const target = await prepareDaemonLaunchTarget(bundledEntryPath)
  const userDataPath = app.getPath('userData')
  const logFd = openDaemonLogFd()
  const child = fork(
    target.entryPath,
    ['--socket', socketPath, '--token', tokenPath, '--log', getDaemonLogPath()],
    {
      execPath: target.execPath,
      cwd: userDataPath,
      detached: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        SATURA_USER_DATA_PATH: userDataPath,
        SATURA_APP_VERSION: app.getVersion()
      }
    }
  )
  if (typeof logFd === 'number') {
    try {
      closeSync(logFd)
    } catch {
    }
  }

  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    function cleanupStartupListeners(): void {
      if (timer) clearTimeout(timer)
      child.off('message', onReadyMessage)
      child.off('error', onStartupError)
      child.off('exit', onStartupExit)
    }
    function fail(error: Error): void {
      if (settled) return
      settled = true
      cleanupStartupListeners()
      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGTERM')
        } catch {
        }
      }
      reject(error)
    }
    function onReadyMessage(msg: unknown): void {
      if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'ready') {
        if (settled) return
        settled = true
        cleanupStartupListeners()
        const reported = (msg as { buildId?: unknown }).buildId
        if (child.pid) {
          writeFileSync(
            getDaemonPidPath(runtimeDir, PROTOCOL_VERSION, slot),
            serializeDaemonPidFile({
              pid: child.pid,
              startedAtMs: getProcessStartedAtMs(child.pid),
              entryPath: target.entryPath,
              appVersion: app.getVersion(),
              buildId: typeof reported === 'string' ? reported : buildId
            }),
            { mode: 0o600 }
          )
        }
        console.log(
          `[daemon] started daemon pid=${child.pid} slot=${slot} build=${typeof reported === 'string' ? reported : buildId}`
        )
        child.disconnect()
        child.unref()
        resolve()
      }
    }
    function onStartupError(err: Error): void {
      fail(err)
    }
    function onStartupExit(code: number | null): void {
      fail(new Error(`Daemon exited during startup with code ${code} (see ${getDaemonLogPath()})`))
    }
    timer = setTimeout(() => fail(new Error('Daemon startup timed out')), 10000)
    child.on('message', onReadyMessage)
    child.on('error', onStartupError)
    child.on('exit', onStartupExit)
  })
}

function createOutOfProcessLauncher(runtimeDir: string): DaemonLauncher {
  return async () => {
    if (simulatedStartFailuresLeft > 0) {
      simulatedStartFailuresLeft--
      throw new Error(
        `simulated daemon startup failure (SATURA_DEV_DAEMON_FAIL_STARTS, ${simulatedStartFailuresLeft} left)`
      )
    }
    const ownBuildId = getOwnDaemonBuildId()
    await cleanupOlderProtocolDaemons(runtimeDir)

    const probes: SlotProbe[] = []
    for (let slot = 0; slot < DAEMON_SLOT_COUNT; slot++) {
      const probe = await probeSlot(runtimeDir, slot)
      if (probe) probes.push(probe)
    }

    let primary: SlotProbe | null = null
    const legacy: LegacyDaemonInfo[] = []
    for (const probe of probes) {
      if (!primary && probe.health === 'healthy' && probe.buildId === ownBuildId) {
        primary = probe
        continue
      }
      const reason =
        probe.health === 'unreachable'
          ? 'unreachable'
          : probe.health === 'pty-spawn-unhealthy'
            ? 'pty spawn unhealthy'
            : probe.buildId === ownBuildId
              ? 'duplicate of the current build'
              : `build ${probe.buildId ?? 'unknown'} differs from ${ownBuildId}`
      if (probe.liveCount !== null && probe.liveCount > 0) {
        console.log(
          `[daemon] slot ${probe.slot} daemon (${reason}) owns ${probe.liveCount} live session(s); keeping it for those, new terminals go elsewhere`
        )
        legacy.push({
          socketPath: probe.socketPath,
          tokenPath: probe.tokenPath,
          slot: probe.slot,
          buildId: probe.buildId,
          reason
        })
        continue
      }
      if (probe.health !== 'unreachable' || probe.liveCount === 0) {
        console.log(`[daemon] slot ${probe.slot} daemon (${reason}) has no live sessions; replacing it`)
      }
      await cleanupDaemonSlot(runtimeDir, probe.slot)
    }

    if (primary) {
      console.log(`[daemon] reusing slot ${primary.slot} daemon build=${primary.buildId}`)
      return createSlotHandle(runtimeDir, primary.slot, legacy)
    }

    const used = new Set(legacy.map((entry) => entry.slot))
    let slot = -1
    for (let candidate = 0; candidate < DAEMON_SLOT_COUNT; candidate++) {
      if (!used.has(candidate)) {
        slot = candidate
        break
      }
    }
    if (slot === -1) {
      throw new Error(`all ${DAEMON_SLOT_COUNT} daemon slots are held by old daemons with live sessions`)
    }
    await killStaleDaemon(
      runtimeDir,
      getDaemonSocketPath(runtimeDir, PROTOCOL_VERSION, slot),
      getDaemonTokenPath(runtimeDir, PROTOCOL_VERSION, slot),
      PROTOCOL_VERSION,
      slot
    )
    await forkDaemon(runtimeDir, slot, ownBuildId)
    return createSlotHandle(runtimeDir, slot, legacy)
  }
}

function legacyOptions(runtimeDir: string, list: LegacyDaemonInfo[]) {
  return list.map((entry) => ({
    socketPath: entry.socketPath,
    tokenPath: entry.tokenPath,
    label: `slot ${entry.slot} (${entry.reason})`,
    retire: async () => {
      await cleanupDaemonSlot(runtimeDir, entry.slot)
    }
  }))
}

function buildAdapter(
  runtimeDir: string,
  info: DaemonConnectionInfo,
  currentSpawner: DaemonSpawner
): DaemonPtyAdapter {
  const built: DaemonPtyAdapter = new DaemonPtyAdapter({
    socketPath: info.socketPath,
    tokenPath: info.tokenPath,
    cwdStorePath: getCwdStorePath(),
    respawn: async () => {
      console.warn('[daemon] Daemon process died — respawning')
      currentSpawner.resetHandle()
      const next = await currentSpawner.ensureRunning()
      if (next.socketPath !== built.getSocketPath()) {
        console.warn(`[daemon] respawned daemon listens on ${next.socketPath}; switching to it`)
        built.retarget(next.socketPath, next.tokenPath)
      }
      await built.attachLegacyDaemons(legacyOptions(runtimeDir, currentSpawner.takeLegacy()))
    }
  })
  return built
}

export function initDaemonPtyProvider(signal?: AbortSignal): Promise<void> {
  if (!initPromise) {
    initPromise = doInitDaemonPtyProvider(signal).then(
      () => {
        lastInitError = null
      },
      (err) => {
        lastInitError = err instanceof Error ? err.message : String(err)
        console.error('[daemon] init failed', err)
        initPromise = null
      }
    )
  }
  return initPromise
}

export function whenDaemonReady(): Promise<void> {
  return initPromise ?? Promise.resolve()
}

export function getDaemonInitError(): string | null {
  return adapter ? null : lastInitError
}

export async function ensureDaemonPtyProvider(): Promise<string | null> {
  if (adapter) {
    return null
  }
  if (initPromise) {
    await initPromise
  }
  if (!adapter && !restartInFlight) {
    console.warn('[daemon] no terminal daemon yet; retrying init')
    await initDaemonPtyProvider()
  } else if (restartInFlight) {
    await restartInFlight.catch(() => {})
  }
  return adapter ? null : (lastInitError ?? 'the terminal daemon is not running')
}

async function doInitDaemonPtyProvider(signal?: AbortSignal): Promise<void> {
  const runtimeDir = getRuntimeDir()
  const newSpawner = new DaemonSpawner({
    runtimeDir,
    launcher: createOutOfProcessLauncher(runtimeDir)
  })

  const info = await newSpawner.ensureRunning()
  if (signal?.aborted) {
    return
  }

  const newAdapter = buildAdapter(runtimeDir, info, newSpawner)
  if (signal?.aborted) {
    return
  }

  spawner = newSpawner
  adapter = newAdapter
  setLocalPtyProvider(newAdapter)
  rebindLocalProviderListeners()
  await newAdapter.attachLegacyDaemons(legacyOptions(runtimeDir, newSpawner.takeLegacy()))
  pruneStaleDaemonRuntimes()
  scheduleOrphanReap()
}

export function getDaemonProvider(): DaemonPtyAdapter | null {
  return adapter
}

function tabPtyIds(session: WindowSession | null | undefined, into: Set<string>): void {
  const tabsByWorkspace = session?.workspace?.tabsByWorkspace ?? {}
  for (const tabs of Object.values(tabsByWorkspace)) {
    if (!Array.isArray(tabs)) continue
    for (const tab of tabs) {
      if (tab && typeof tab.ptyId === 'string' && tab.ptyId) into.add(tab.ptyId)
    }
  }
}

export function referencedPtyIds(): Set<string> {
  const ids = new Set<string>()
  for (const { snapshot } of listSessionWindows()) tabPtyIds(snapshot.session, ids)
  for (const snapshot of loadState().session?.windows ?? []) tabPtyIds(snapshot.session, ids)
  return ids
}

export async function reapOrphanSessions(): Promise<string[]> {
  const current = adapter
  if (!current) {
    return []
  }
  const referenced = referencedPtyIds()
  for (const id of current.getActiveSessionIds()) referenced.add(id)
  const sessions = await current.listSessions()
  const orphans = sessions.map((s) => s.sessionId).filter((id) => !referenced.has(id))
  for (const id of orphans) {
    console.warn(`[daemon] killing orphan session ${id}: no restored tab references it`)
    await current.shutdown(id, { immediate: true }).catch((err) => {
      console.warn(`[daemon] orphan kill of ${id} failed`, err)
    })
  }
  console.log(
    `[daemon] orphan check: ${sessions.length} daemon session(s), ${orphans.length} orphan(s) killed`
  )
  return orphans
}

function scheduleOrphanReap(): void {
  if (orphanReapScheduled) {
    return
  }
  orphanReapScheduled = true
  setTimeout(() => {
    void reapOrphanSessions().catch((err) => console.warn('[daemon] orphan check failed', err))
  }, ORPHAN_REAP_DELAY_MS).unref?.()
}

export type RestartDaemonResult = {
  killedCount: number
}

export async function restartDaemon(): Promise<RestartDaemonResult> {
  if (restartInFlight) {
    return restartInFlight
  }
  restartInFlight = runRestartDaemon().finally(() => {
    restartInFlight = null
  })
  return restartInFlight
}

async function runRestartDaemon(): Promise<RestartDaemonResult> {
  if (initPromise && !adapter) {
    await initPromise
  }
  const runtimeDir = getRuntimeDir()
  const currentSpawner = spawner
  const currentAdapter = adapter
  if (!currentSpawner || !currentAdapter) {
    console.warn('[daemon] restart requested with no running provider; cleaning up and starting fresh')
    const cleaned = await cleanupDaemonForProtocol(runtimeDir)
    initPromise = null
    await initDaemonPtyProvider()
    if (!adapter) {
      throw new Error(`Terminal daemon failed to start: ${lastInitError ?? 'unknown error'}`)
    }
    return { killedCount: cleaned.killedCount }
  }

  const killedCount = currentAdapter.getActiveSessionIds().length
  currentAdapter.fanoutSyntheticExits(-1)

  unbindLocalProviderListeners()
  currentAdapter.dispose()
  await cleanupDaemonForProtocol(runtimeDir)

  currentSpawner.resetHandle()
  let info: DaemonConnectionInfo
  try {
    info = await currentSpawner.ensureRunning()
  } catch (err) {
    adapter = null
    spawner = null
    lastInitError = err instanceof Error ? err.message : String(err)
    throw err
  }

  const newAdapter = buildAdapter(runtimeDir, info, currentSpawner)
  adapter = newAdapter
  setLocalPtyProvider(newAdapter)
  rebindLocalProviderListeners()
  await newAdapter.attachLegacyDaemons(legacyOptions(runtimeDir, currentSpawner.takeLegacy()))
  lastInitError = null

  return { killedCount }
}

export async function disconnectDaemon(): Promise<void> {
  await adapter?.disconnectOnly()
  adapter = null
}

const SHUTDOWN_REQUEST_BUDGET_MS = 2_000
const SHUTDOWN_EXIT_WAIT_MS = 1_500
const SHUTDOWN_KILL_WAIT_MS = 1_000

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForPidExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return true
}

export async function shutdownDaemon(): Promise<void> {
  adapter?.dispose()
  adapter = null
  const currentSpawner = spawner
  spawner = null
  const runtimeDir = getRuntimeDir()
  if (!currentSpawner) {
    console.log('[daemon] closing terminals on quit with no running provider; cleaning up daemon files')
    await cleanupDaemonForProtocol(runtimeDir)
    return
  }
  const slot = currentSpawner.currentInfo()?.slot ?? 0
  const verifiedPid = readVerifiedDaemonPid(
    runtimeDir,
    getDaemonSocketPath(runtimeDir, PROTOCOL_VERSION, slot),
    getDaemonTokenPath(runtimeDir, PROTOCOL_VERSION, slot),
    PROTOCOL_VERSION,
    slot
  ).catch(() => null)
  await Promise.race([
    currentSpawner.shutdown().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_REQUEST_BUDGET_MS))
  ])
  const daemonPid = (await verifiedPid)?.pid ?? null
  if (daemonPid !== null && !(await waitForPidExit(daemonPid, SHUTDOWN_EXIT_WAIT_MS))) {
    console.warn(`[daemon] daemon ${daemonPid} survived the shutdown request — killing it`)
    try {
      process.kill(daemonPid, 'SIGKILL')
    } catch {
    }
    await waitForPidExit(daemonPid, SHUTDOWN_KILL_WAIT_MS)
  }
  try {
    unlinkSync(getDaemonPidPath(runtimeDir, PROTOCOL_VERSION, slot))
  } catch {
  }
  await cleanupDaemonForProtocol(runtimeDir)
}

export type OrphanedDaemonCleanupResult = {
  cleaned: boolean
  killedCount: number
}

export async function cleanupDaemonSlot(
  runtimeDir: string,
  slot: number
): Promise<OrphanedDaemonCleanupResult> {
  const socketPath = getDaemonSocketPath(runtimeDir, PROTOCOL_VERSION, slot)
  const tokenPath = getDaemonTokenPath(runtimeDir, PROTOCOL_VERSION, slot)
  const pidPath = getDaemonPidPath(runtimeDir, PROTOCOL_VERSION, slot)

  const alive = await probeSocket(socketPath)
  if (!alive) {
    await killStaleDaemon(runtimeDir, socketPath, tokenPath, PROTOCOL_VERSION, slot)
    if (process.platform !== 'win32' && existsSync(socketPath)) {
      try {
        unlinkSync(socketPath)
      } catch {
      }
    }
    try {
      unlinkSync(pidPath)
    } catch {
    }
    try {
      unlinkSync(tokenPath)
    } catch {
    }
    forgetDaemonPipeName(runtimeDir, PROTOCOL_VERSION, slot)
    return { cleaned: false, killedCount: 0 }
  }

  const client = new DaemonClient({ socketPath, tokenPath })
  let killedCount = 0
  let didRequestShutdown = false
  let didKillStaleDaemon = false
  try {
    await client.ensureConnected()
    const sessions = await client
      .request<ListSessionsResult>('listSessions', undefined)
      .catch(() => ({ sessions: [] }))
    killedCount = sessions.sessions.filter((s) => s.isAlive).length
    await client.request('shutdown', { killSessions: true }).catch(() => {})
    didRequestShutdown = true
  } catch {
    didKillStaleDaemon = await killStaleDaemon(runtimeDir, socketPath, tokenPath, PROTOCOL_VERSION, slot)
  } finally {
    client.disconnect()
  }

  if (didRequestShutdown && process.platform !== 'win32' && existsSync(socketPath)) {
    try {
      unlinkSync(socketPath)
    } catch {
    }
  }
  try {
    unlinkSync(pidPath)
  } catch {
  }
  if (didRequestShutdown || didKillStaleDaemon) {
    try {
      unlinkSync(tokenPath)
    } catch {
    }
    forgetDaemonPipeName(runtimeDir, PROTOCOL_VERSION, slot)
  }
  console.log(`[daemon] cleaned up slot ${slot} daemon (${killedCount} session(s) ended)`)

  return { cleaned: didRequestShutdown || didKillStaleDaemon, killedCount }
}

export async function cleanupDaemonForProtocol(
  runtimeDir: string
): Promise<OrphanedDaemonCleanupResult> {
  let cleaned = false
  let killedCount = 0
  for (let slot = 0; slot < DAEMON_SLOT_COUNT; slot++) {
    if (slot > 0 && !slotHasFiles(runtimeDir, slot)) continue
    const result = await cleanupDaemonSlot(runtimeDir, slot)
    cleaned = cleaned || result.cleaned
    killedCount += result.killedCount
  }
  return { cleaned, killedCount }
}
