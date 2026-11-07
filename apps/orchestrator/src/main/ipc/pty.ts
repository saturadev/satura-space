import { ipcMain, webContents } from 'electron'
import type { PtySpawnArgs, PtySpawnResult } from '@shared/api'
import type { IPtyProvider, PtySpawnResult as ProviderPtySpawnResult } from '../providers/types'
import { ensureDaemonPtyProvider, restartDaemon } from '../daemon/daemon-init'
import { listShells } from '../pty/shells'
import { getAgentHookEnv } from '../agent-hooks'
import { censusTrack } from '@shared/census'
import { homedir } from 'node:os'
import type { PtyHoverInfo } from '@shared/hover-info'
import { allowPtyResize, clientOfSender, forgetPty, setPtyResizer } from '../remote/pty-size-owner'

const PTY_BATCH_INTERVAL_MS = 8
const PTY_BATCH_DRAIN_CONTINUE_MS = 1
const PTY_BATCH_FLUSH_CHUNK_CHARS = 16 * 1024
const PTY_BATCH_FLUSH_MAX_WRITES = 2
const PTY_RENDERER_IN_FLIGHT_HIGH_WATER_CHARS = 512 * 1024
const PTY_RENDERER_TOTAL_IN_FLIGHT_HIGH_WATER_CHARS = 8 * 1024 * 1024
const PTY_RENDERER_INTERACTIVE_RESERVE_CHARS = 256 * 1024
const INTERACTIVE_OUTPUT_WINDOW_MS = 100
const INTERACTIVE_OUTPUT_MAX_CHARS = 1024
const PTY_PENDING_MAX_CHARS = 8 * 1024 * 1024
const PTY_PENDING_TRUNCATE_TO_CHARS = 4 * 1024 * 1024
const PTY_PENDING_COMPACT_MIN_HEAD = 1024
const PTY_PENDING_CUT_SEARCH_CHARS = 64 * 1024
const PTY_PENDING_TRUNCATED_WARNING =
  '\x18\x1b[0m\r\n[Satura Space skipped terminal output because the backlog exceeded 8 MB.]\r\n'

type PendingOutput = {
  chunks: string[]
  head: number
  chars: number
}

const owners = new Map<string, number>()
censusTrack('pty.owners', owners)
const pending = new Map<string, PendingOutput>()
censusTrack('pty.pending', pending)
const inFlightByPty = new Map<string, number>()
censusTrack('pty.inFlightByPty', inFlightByPty)
const lastInputAt = new Map<string, number>()
censusTrack('pty.lastInputAt', lastInputAt)
const seqByPty = new Map<string, number>()
censusTrack('pty.seqByPty', seqByPty)
const shellById = new Map<string, string>()
censusTrack('pty.shellById', shellById)
let totalInFlight = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null

let localProvider: IPtyProvider | null = null
const outputTaps = new Set<(id: string, data: string) => void>()
const exitTaps = new Set<(id: string, code: number) => void>()
const resizeTaps = new Set<(id: string, cols: number, rows: number) => void>()
const inputTaps = new Set<(id: string, data: string) => void>()

export function tapPtyInput(fn: (id: string, data: string) => void): () => void {
  inputTaps.add(fn)
  return () => inputTaps.delete(fn)
}

export function tapPtyOutput(fn: (id: string, data: string) => void): () => void {
  outputTaps.add(fn)
  return () => outputTaps.delete(fn)
}

export function tapPtyExit(fn: (id: string, code: number) => void): () => void {
  exitTaps.add(fn)
  return () => exitTaps.delete(fn)
}

export function tapPtyResize(fn: (id: string, cols: number, rows: number) => void): () => void {
  resizeTaps.add(fn)
  return () => resizeTaps.delete(fn)
}

function resizePty(id: string, cols: number, rows: number): void {
  localProvider?.resize(id, cols, rows)
  for (const fn of resizeTaps) fn(id, cols, rows)
}

export function writePtyInput(id: string, data: string): void {
  lastInputAt.set(id, Date.now())
  localProvider?.write(id, data)
  for (const fn of inputTaps) fn(id, data)
}

let providerUnsubscribers: (() => void)[] = []

export function getLocalPtyProvider(): IPtyProvider | null {
  return localProvider
}

export function setLocalPtyProvider(provider: IPtyProvider): void {
  localProvider = provider
}

export function unbindLocalProviderListeners(): void {
  for (const unsub of providerUnsubscribers) {
    unsub()
  }
  providerUnsubscribers = []
}

export function rebindLocalProviderListeners(): void {
  unbindLocalProviderListeners()
  const provider = localProvider
  if (!provider) {
    return
  }
  providerUnsubscribers.push(
    provider.onData(({ id, data }) => {
      if (data.length && outputTaps.size) for (const fn of outputTaps) fn(id, data)
      if (!owners.has(id) || data.length === 0) return
      appendPending(id, data)
      const interactive = isInteractive(id) && data.length <= INTERACTIVE_OUTPUT_MAX_CHARS
      scheduleFlush(interactive ? 0 : PTY_BATCH_INTERVAL_MS)
    })
  )
  providerUnsubscribers.push(
    provider.onExit(({ id, code }) => {
      const entry = pending.get(id)
      const rest = entry ? entry.chunks.slice(entry.head).join('') : ''
      if (rest) send(id, 'pty:data', { id, data: rest, rawLength: rest.length })
      send(id, 'pty:exit', { id, exitCode: code })
      for (const fn of exitTaps) fn(id, code)
      clearPtyState(id)
    })
  )
}

function appendPending(id: string, data: string): void {
  let entry = pending.get(id)
  if (!entry) {
    entry = { chunks: [], head: 0, chars: 0 }
    pending.set(id, entry)
  }
  entry.chunks.push(data)
  entry.chars += data.length
  if (entry.chars > PTY_PENDING_MAX_CHARS) truncatePending(entry)
}

function truncatePending(entry: PendingOutput): void {
  let drop = entry.chars - (PTY_PENDING_TRUNCATE_TO_CHARS - PTY_PENDING_TRUNCATED_WARNING.length)
  while (drop > 0 && entry.head < entry.chunks.length) {
    const first = entry.chunks[entry.head]
    if (first.length <= drop) {
      entry.head++
      entry.chars -= first.length
      drop -= first.length
    } else {
      const cut = cleanCutIndex(first, drop)
      entry.chunks[entry.head] = first.slice(cut)
      entry.chars -= cut
      drop = 0
    }
  }
  const rest = entry.chunks.slice(entry.head)
  rest.unshift(PTY_PENDING_TRUNCATED_WARNING)
  entry.chunks = rest
  entry.head = 0
  entry.chars += PTY_PENDING_TRUNCATED_WARNING.length
}

function cleanCutIndex(text: string, from: number): number {
  const newline = text.indexOf('\n', from)
  if (newline !== -1 && newline - from <= PTY_PENDING_CUT_SEARCH_CHARS) return newline + 1
  const code = text.charCodeAt(from)
  return code >= 0xdc00 && code <= 0xdfff ? from + 1 : from
}

function takePending(entry: PendingOutput, maxChars: number): string {
  let out = ''
  while (out.length < maxChars && entry.head < entry.chunks.length) {
    const next = entry.chunks[entry.head]
    const room = maxChars - out.length
    if (next.length <= room) {
      out += next
      entry.chunks[entry.head] = ''
      entry.head++
    } else {
      out += next.slice(0, room)
      entry.chunks[entry.head] = next.slice(room)
    }
  }
  entry.chars -= out.length
  if (entry.head >= PTY_PENDING_COMPACT_MIN_HEAD && entry.head * 2 >= entry.chunks.length) {
    entry.chunks = entry.chunks.slice(entry.head)
    entry.head = 0
  }
  return out
}

function send(id: string, channel: string, payload: unknown): void {
  const wcId = owners.get(id)
  if (wcId == null) return
  const wc = webContents.fromId(wcId)
  if (wc && !wc.isDestroyed()) wc.send(channel, payload)
}

export function notifyPtyOwner(id: string, channel: string, payload: unknown): void {
  send(id, channel, payload)
}

export function ptyOwnerWebContentsId(id: string): number | undefined {
  return owners.get(id)
}

function isInteractive(id: string): boolean {
  return Date.now() - (lastInputAt.get(id) ?? 0) < INTERACTIVE_OUTPUT_WINDOW_MS
}

function canSend(id: string): boolean {
  const perPty = inFlightByPty.get(id) ?? 0
  if (isInteractive(id)) {
    return (
      perPty < PTY_RENDERER_IN_FLIGHT_HIGH_WATER_CHARS + PTY_RENDERER_INTERACTIVE_RESERVE_CHARS &&
      totalInFlight <
        PTY_RENDERER_TOTAL_IN_FLIGHT_HIGH_WATER_CHARS + PTY_RENDERER_INTERACTIVE_RESERVE_CHARS
    )
  }
  return (
    perPty < PTY_RENDERER_IN_FLIGHT_HIGH_WATER_CHARS &&
    totalInFlight < PTY_RENDERER_TOTAL_IN_FLIGHT_HIGH_WATER_CHARS
  )
}

function flushPtyChunk(id: string): boolean {
  const entry = pending.get(id)
  if (!entry || !canSend(id)) return false
  const chunk = takePending(entry, PTY_BATCH_FLUSH_CHUNK_CHARS)
  if (entry.chars <= 0) pending.delete(id)
  if (!chunk) return false
  const seq = (seqByPty.get(id) ?? 0) + 1
  seqByPty.set(id, seq)
  inFlightByPty.set(id, (inFlightByPty.get(id) ?? 0) + chunk.length)
  totalInFlight += chunk.length
  send(id, 'pty:data', { id, data: chunk, seq, rawLength: chunk.length })
  return true
}

function scheduleFlush(delayMs: number): void {
  if (flushTimer) return
  flushTimer = setTimeout(flush, delayMs)
}

function flush(): void {
  flushTimer = null
  let writes = 0
  let progressed = true
  while (writes < PTY_BATCH_FLUSH_MAX_WRITES && progressed) {
    progressed = false
    for (const id of [...pending.keys()]) {
      if (writes >= PTY_BATCH_FLUSH_MAX_WRITES) break
      if (flushPtyChunk(id)) {
        writes++
        progressed = true
      }
    }
  }
  if (writes > 0 && pending.size > 0) {
    scheduleFlush(writes >= PTY_BATCH_FLUSH_MAX_WRITES ? PTY_BATCH_DRAIN_CONTINUE_MS : PTY_BATCH_INTERVAL_MS)
  }
}

function clearPtyState(id: string): void {
  const perPty = inFlightByPty.get(id) ?? 0
  totalInFlight = Math.max(0, totalInFlight - perPty)
  inFlightByPty.delete(id)
  pending.delete(id)
  lastInputAt.delete(id)
  seqByPty.delete(id)
  shellById.delete(id)
  owners.delete(id)
  forgetPty(id)
  if (perPty > 0 && pending.size > 0) scheduleFlush(0)
}

export function reassignPtyOwners(ptyIds: string[], fromWcId: number, toWcId: number): void {
  for (const id of ptyIds) {
    if (owners.get(id) === fromWcId) owners.set(id, toWcId)
  }
}

export function killPtysForWebContents(webContentsId: number): void {
  const provider = localProvider
  for (const [id, wcId] of [...owners.entries()]) {
    if (wcId !== webContentsId) continue
    void provider?.shutdown(id, { immediate: true }).catch((err) => {
      console.warn(`[pty] kill ${id} on window close failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    clearPtyState(id)
  }
}

function toSpawnResult(res: ProviderPtySpawnResult): PtySpawnResult {
  const isReattach = res.isReattach ?? false
  return {
    pid: typeof res.pid === 'number' ? res.pid : -1,
    attached: isReattach,
    snapshot: res.snapshot ?? null,
    ...(res.snapshotCols !== undefined ? { snapshotCols: res.snapshotCols } : {}),
    ...(res.snapshotRows !== undefined ? { snapshotRows: res.snapshotRows } : {}),
    ...(res.isReattach !== undefined ? { isReattach: res.isReattach } : {}),
    ...(res.isAlternateScreen !== undefined ? { isAlternateScreen: res.isAlternateScreen } : {})
  }
}

let wired = false

export function registerPtyHandlers(): void {
  rebindLocalProviderListeners()

  if (wired) return
  wired = true

  ipcMain.handle('pty:spawn', async (event, args: PtySpawnArgs): Promise<PtySpawnResult> => {
    owners.set(args.id, event.sender.id)
    const perPty = inFlightByPty.get(args.id) ?? 0
    totalInFlight = Math.max(0, totalInFlight - perPty)
    inFlightByPty.delete(args.id)
    seqByPty.delete(args.id)
    if (perPty > 0 && pending.size > 0) scheduleFlush(0)
    const initError = await ensureDaemonPtyProvider()
    const provider = localProvider
    if (!provider) {
      const error = initError ?? 'the terminal daemon is not running'
      console.error(`[pty] spawn ${args.id}: no terminal provider (${error})`)
      return { pid: -1, attached: false, snapshot: null, error }
    }
    if (args.shell) shellById.set(args.id, args.shell)
    else shellById.delete(args.id)
    try {
      const res = await provider.spawn({
        sessionId: args.id,
        cols: args.cols,
        rows: args.rows,
        cwd: args.cwd,
        shellOverride: args.shell,
        env: { ...args.env, ...getAgentHookEnv(args.id) }
      })
      return toSpawnResult(res)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.error(`[pty] spawn ${args.id} failed: ${error}`)
      return { pid: -1, attached: false, snapshot: null, error }
    }
  })
  ipcMain.handle('pty:restartDaemon', async (): Promise<{ killedCount: number }> => {
    const res = await restartDaemon()
    return { killedCount: res.killedCount }
  })
  ipcMain.handle('pty:listShells', () => listShells())
  ipcMain.handle('pty:info', async (_event, { id }: { id: string }): Promise<PtyHoverInfo> => {
    const provider = localProvider
    const home = homedir()
    if (!provider || !id) return { cwd: '', process: null, shell: null, home }
    const [cwd, initial, proc, shell] = await Promise.all([
      provider.getCwd(id).catch(() => ''),
      provider.getInitialCwd(id).catch(() => ''),
      provider.getForegroundProcess(id).catch(() => null),
      shellById.get(id) ?? provider.getDefaultShell().catch(() => null)
    ])
    return { cwd: cwd || initial, process: proc, shell: shell || null, home }
  })
  ipcMain.on('pty:write', (_event, { id, data }: { id: string; data: string }) => writePtyInput(id, data))
  setPtyResizer(resizePty)
  ipcMain.on('pty:resize', (event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    if (!allowPtyResize(id, clientOfSender(event.sender), cols, rows)) return
    resizePty(id, cols, rows)
  })
  ipcMain.on('pty:ackData', (_event, { id, charCount }: { id: string; charCount: number }) => {
    if (!inFlightByPty.has(id)) {
      if (pending.size > 0) scheduleFlush(0)
      return
    }
    const cur = inFlightByPty.get(id) ?? 0
    const next = Math.max(0, cur - charCount)
    inFlightByPty.set(id, next)
    totalInFlight = Math.max(0, totalInFlight - (cur - next))
    if (pending.size > 0) scheduleFlush(0)
  })
  ipcMain.handle('pty:kill', async (_event, { id }: { id: string }) => {
    await localProvider?.shutdown(id, { immediate: true }).catch((err) => {
      console.warn(`[pty] kill ${id} failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    clearPtyState(id)
    return true
  })
}
