import { app, sharedTexture, webContents } from 'electron'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { censusTrack } from '@shared/census'
import { debugLog } from '@shared/debug-log'

const nodeRequire = createRequire(import.meta.url)

export const SURFACE_PACKET = 0x53

export interface SurfaceInfo {
  format: number
  handleLow: number
  handleHigh: number
  width: number
  height: number
  generation: number
  stamp: number | null
  seq: number | null
}

export interface PresentResult {
  surfaceId: number | null
  generation: number | null
  error: string | null
  fatal: boolean
  reason?: string
}

export function parseSurfacePacket(msg: Buffer): SurfaceInfo | null {
  if (msg.length < 18 || msg[0] !== SURFACE_PACKET) return null
  return {
    format: msg[1],
    handleLow: msg.readUInt32LE(2),
    handleHigh: msg.readUInt32LE(6),
    width: msg.readUInt16LE(10),
    height: msg.readUInt16LE(12),
    generation: msg.readUInt32LE(14),
    stamp: msg.length >= 26 ? msg.readDoubleLE(18) : null,
    seq: msg.length >= 30 ? msg.readUInt32LE(26) : null
  }
}

export interface ReadbackResult {
  ok: boolean
  distinct: number
  allSame: boolean
  nonBlack: boolean
  keyedMutex: boolean
  samples: number[]
}

interface SurfaceAddon {
  available(): boolean
  lookupIOSurface(id: number, width: number, height: number): { handle?: Buffer; token?: number; error?: string; width?: number; height?: number }
  releaseIOSurface(token: number): boolean
  retainedIOSurfaces?(): number
  duplicateHandle(pid: number, lo: number, hi: number): Buffer | null
  closeHandle(buf: Buffer): void
  launchWithHook?(
    exe: string,
    argv: string[],
    cwd: string,
    envBlock: string,
    dllPath: string
  ): HookLaunchResult | number | null
  readback?(handleBuf: Buffer, width: number, height: number): ReadbackResult | null
  assignToKillJob?(pid: number): boolean
  setJobKillOnClose?(enabled: boolean): boolean
  startMouseDeltas?(cb: (dx: number, dy: number) => void): boolean
}

export function startNativeMouseDeltas(cb: (dx: number, dy: number) => void): boolean {
  if (process.platform !== 'darwin') return false
  const a = loadAddon()
  if (!a || !a.startMouseDeltas) return false
  try {
    const ok = a.startMouseDeltas(cb)
    console.log(`[shared-surface] native mouse delta monitor ${ok ? 'started' : 'unavailable'}`)
    return ok
  } catch (e) {
    console.log(`[shared-surface] startMouseDeltas failed: ${(e as Error).message}`)
    return false
  }
}

export interface HookLaunchResult {
  pid: number
  injected: boolean
}

export function launchWithHook(
  exe: string,
  argv: string[],
  cwd: string,
  envBlock: string,
  dllPath: string
): HookLaunchResult | null {
  const a = loadAddon()
  if (!a || !a.launchWithHook) return null
  try {
    const r = a.launchWithHook(exe, argv, cwd, envBlock, dllPath)
    if (r == null) return null
    if (typeof r === 'number') return { pid: r, injected: true }
    return r
  } catch (e) {
    console.log(`[shared-surface] launchWithHook failed: ${(e as Error).message}`)
    return null
  }
}

export function assignToKillJob(pid: number | undefined): void {
  if (process.platform !== 'win32' || !pid) return
  const a = loadAddon()
  if (!a || !a.assignToKillJob) return
  try {
    a.assignToKillJob(pid)
  } catch (e) {
    console.log(`[shared-surface] assignToKillJob failed: ${(e as Error).message}`)
  }
}

export function setJobKillOnClose(enabled: boolean): void {
  if (process.platform !== 'win32') return
  const a = loadAddon()
  if (!a || !a.setJobKillOnClose) return
  try {
    const ok = a.setJobKillOnClose(enabled)
    debugLog(`[shared-surface] job kill-on-close ${enabled ? 'enabled' : 'disabled'} (ok=${ok})`)
  } catch (e) {
    console.log(`[shared-surface] setJobKillOnClose failed: ${(e as Error).message}`)
  }
}

const ADDON_ERROR =
  'Zero-copy video unavailable: native shared-surface addon failed to load (rebuild with pnpm build:native).'
const API_ERROR =
  'Zero-copy video unavailable: Electron sharedTexture API missing (requires Electron 41+).'

function addonPath(): string {
  const p = join(app.getAppPath(), 'native', 'shared-surface')
  return app.isPackaged ? p.replace('app.asar', 'app.asar.unpacked') : p
}

let addon: SurfaceAddon | null | undefined
function loadAddon(): SurfaceAddon | null {
  if (addon !== undefined) return addon
  const p = addonPath()
  try {
    const mod = nodeRequire(p) as SurfaceAddon
    if (!mod.available || !mod.available()) {
      console.log(`[shared-surface] addon found but native not built at ${p} (run pnpm build:native)`)
      addon = null
    } else {
      addon = mod
      console.log(`[shared-surface] addon loaded from ${p}`)
    }
  } catch (e) {
    console.log(`[shared-surface] addon unavailable at ${p}: ${(e as Error).message}`)
    addon = null
  }
  return addon
}

function apiAvailable(): boolean {
  return Boolean(sharedTexture && typeof sharedTexture.importSharedTexture === 'function')
}

interface RingTex {
  surfaceId: number
  imported: Electron.SharedTextureImported
  handleBuf: Buffer | null
  token: number | null
  sentTo: Set<string>
  pendingSends: Set<Promise<unknown>>
}

interface InstanceState {
  epoch: number
  width: number
  height: number
  format: number
  ring: Map<number, RingTex>
}

const states = new Map<string, InstanceState>()
censusTrack('shared-surface.states', states)
const reported = new Map<string, Set<string>>()
censusTrack('shared-surface.reported', reported)
const transientFailStreak = new Map<string, number>()
censusTrack('shared-surface.transientFailStreak', transientFailStreak)
const reportedTransient = new Set<string>()
censusTrack('shared-surface.reportedTransient', reportedTransient)
const listenersRaised = new Set<number>()
censusTrack('shared-surface.listenersRaised', listenersRaised)

const TRANSIENT_FAIL_THRESHOLD = 90

function failOnce(instanceKey: string, reason: string, message: string): string | null {
  let s = reported.get(instanceKey)
  if (!s) {
    s = new Set<string>()
    reported.set(instanceKey, s)
  }
  if (s.has(reason)) return null
  s.add(reason)
  console.log(`[shared-surface] ${instanceKey}: ${message}`)
  return message
}

function pixelFormatOf(format: number): 'bgra' | 'rgba' {
  return format === 1 ? 'rgba' : 'bgra'
}

function releaseRingTex(t: RingTex, a: SurfaceAddon): void {
  const finish = (): void => {
    try {
      t.imported.release()
    } catch {
    }
    if (t.token != null) a.releaseIOSurface(t.token)
    else if (t.handleBuf && process.platform !== 'darwin') a.closeHandle(t.handleBuf)
  }
  if (t.pendingSends.size === 0) {
    finish()
    return
  }
  void Promise.allSettled([...t.pendingSends]).then(finish)
}

export function retainedSurfaceCount(): number {
  const a = loadAddon()
  return a?.retainedIOSurfaces?.() ?? -1
}

function releaseState(st: InstanceState, a: SurfaceAddon, key?: string): void {
  if (key && st.ring.size) {
    const pending = [...st.ring.values()].reduce((n, t) => n + t.pendingSends.size, 0)
    debugLog(`[shared-surface] ${key}: releasing gen ${st.epoch} ${st.width}x${st.height} ring (${st.ring.size} slots, ${pending} sends in flight)`)
  }
  for (const t of st.ring.values()) releaseRingTex(t, a)
  st.ring.clear()
}

function importSurface(
  instanceKey: string,
  info: SurfaceInfo,
  unityPid: number | undefined,
  a: SurfaceAddon
): RingTex | string {
  const surfaceId = info.handleLow
  let handleBuf: Buffer | null = null
  let token: number | null = null
  if (process.platform === 'darwin') {
    const r = a.lookupIOSurface(surfaceId, info.width, info.height)
    if (r.error === 'size') {
      debugLog(`[shared-surface] ${instanceKey}: rejected IOSurface ${surfaceId}: it is ${r.width}x${r.height}, the frame says ${info.width}x${info.height} (id reused by another surface)`)
      return ''
    }
    if (!r.handle || r.token == null) return failOnce(instanceKey, `lookup:${surfaceId}`, `IOSurfaceLookup(${surfaceId}) failed`) ?? ''
    handleBuf = r.handle
    token = r.token
  } else if (process.platform === 'win32') {
    if (unityPid == null) return failOnce(instanceKey, 'pid', 'no Unity pid for handle duplication') ?? ''
    handleBuf = a.duplicateHandle(unityPid, info.handleLow, info.handleHigh)
    if (!handleBuf) return failOnce(instanceKey, `dup:${surfaceId}`, 'DuplicateHandle failed') ?? ''
  } else {
    return failOnce(instanceKey, 'platform', `unsupported platform ${process.platform}`) ?? ''
  }

  let imported: Electron.SharedTextureImported
  try {
    imported = sharedTexture.importSharedTexture({
      textureInfo: {
        codedSize: { width: info.width, height: info.height },
        pixelFormat: pixelFormatOf(info.format),
        handle: process.platform === 'darwin' ? { ioSurface: handleBuf } : { ntHandle: handleBuf }
      }
    })
  } catch (e) {
    if (token != null) a.releaseIOSurface(token)
    else if (handleBuf) a.closeHandle(handleBuf)
    return failOnce(instanceKey, `import:${surfaceId}`, `importSharedTexture failed: ${(e as Error).message}`) ?? ''
  }

  debugLog(
    `[shared-surface] imported ${instanceKey} slot id=${surfaceId} ${info.width}x${info.height} ${pixelFormatOf(info.format)} epoch=${info.generation}`
  )
  verifyContentOnce(instanceKey, info, unityPid, a)
  return {
    surfaceId,
    imported,
    handleBuf,
    token,
    sentTo: new Set<string>(),
    pendingSends: new Set<Promise<unknown>>()
  }
}

const contentVerified = new Set<string>()
censusTrack('shared-surface.contentVerified', contentVerified)

const readbackNullLogged = new Set<string>()
censusTrack('shared-surface.readbackNullLogged', readbackNullLogged)
const readbackAttempts = new Map<string, number>()
censusTrack('shared-surface.readbackAttempts', readbackAttempts)
const MAX_READBACK_ATTEMPTS = 8
const CONTENT_VERIFY_ENABLED = Boolean(process.env.SATURA_SS_VERIFY)
function verifyContentOnce(instanceKey: string, info: SurfaceInfo, unityPid: number | undefined, a: SurfaceAddon): void {
  if (!CONTENT_VERIFY_ENABLED) return
  if (process.platform !== 'win32' || !a.readback || unityPid == null || contentVerified.has(instanceKey)) return
  const attempts = readbackAttempts.get(instanceKey) ?? 0
  if (attempts >= MAX_READBACK_ATTEMPTS) return
  readbackAttempts.set(instanceKey, attempts + 1)
  const rbHandle = a.duplicateHandle(unityPid, info.handleLow, info.handleHigh)
  if (!rbHandle) return
  let r: ReadbackResult | null = null
  try {
    r = a.readback(rbHandle, info.width, info.height)
  } catch (e) {
    console.log(`[shared-surface] content readback threw for ${instanceKey}: ${(e as Error).message}`)
    return
  } finally {
    a.closeHandle(rbHandle)
  }
  if (!r || !r.ok) {
    if (!readbackNullLogged.has(instanceKey)) {
      readbackNullLogged.add(instanceKey)
      console.log(`[shared-surface] content readback returned ${r ? 'ok=false' : 'null'} for ${instanceKey} (will retry; see SATURA_SS_LOG)`)
    }
    return
  }
  contentVerified.add(instanceKey)
  const live = r.nonBlack && !r.allSame
  debugLog(
    `[shared-surface] content ${instanceKey} nonBlank=${r.nonBlack} distinct=${r.distinct} allSame=${r.allSame} keyedMutex=${r.keyedMutex} live=${live}`
  )
}

export function presentSurface(
  instanceKey: string,
  info: SurfaceInfo,
  unityPid: number | undefined,
  subscribers: Iterable<[string, number]>
): PresentResult {
  const a = loadAddon()
  if (!a) return { surfaceId: null, generation: null, error: failOnce(instanceKey, 'addon', ADDON_ERROR), fatal: true }
  if (!apiAvailable())
    return { surfaceId: null, generation: null, error: failOnce(instanceKey, 'api', API_ERROR), fatal: true }

  let st = states.get(instanceKey)
  if (
    st &&
    (st.epoch !== info.generation ||
      st.width !== info.width ||
      st.height !== info.height ||
      st.format !== info.format)
  ) {
    releaseState(st, a, instanceKey)
    contentVerified.delete(instanceKey)
    readbackAttempts.delete(instanceKey)
    readbackNullLogged.delete(instanceKey)
    transientFailStreak.delete(instanceKey)
    reportedTransient.delete(instanceKey)
    st = undefined
  }
  if (!st) {
    st = {
      epoch: info.generation,
      width: info.width,
      height: info.height,
      format: info.format,
      ring: new Map<number, RingTex>()
    }
    states.set(instanceKey, st)
    reported.delete(instanceKey)
  }

  const surfaceId = info.handleLow
  let tex = st.ring.get(surfaceId)
  if (!tex) {
    const r = importSurface(instanceKey, info, unityPid, a)
    if (typeof r === 'string') {
      const streak = (transientFailStreak.get(instanceKey) ?? 0) + 1
      transientFailStreak.set(instanceKey, streak)
      if (streak < TRANSIENT_FAIL_THRESHOLD || reportedTransient.has(instanceKey))
        return { surfaceId: null, generation: null, error: null, fatal: false, ...(r ? { reason: r } : {}) }
      reportedTransient.add(instanceKey)
      console.log(
        `[shared-surface] ${instanceKey}: ${streak} consecutive frame-import failures — reporting: ${r}`
      )
      return { surfaceId: null, generation: null, error: r || null, fatal: false }
    }
    tex = r
    st.ring.set(surfaceId, tex)
  }

  transientFailStreak.delete(instanceKey)
  reportedTransient.delete(instanceKey)
  reported.delete(instanceKey)

  for (const [unityId, wcId] of subscribers) {
    const to = `${wcId}:${unityId}`
    if (tex.sentTo.has(to)) continue
    const wc = webContents.fromId(wcId)
    if (!wc || wc.isDestroyed()) continue
    if (!listenersRaised.has(wcId)) {
      listenersRaised.add(wcId)
      wc.setMaxListeners(0)
      wc.once('destroyed', () => listenersRaised.delete(wcId))
    }
    tex.sentTo.add(to)
    const send = sharedTexture
      .sendSharedTexture(
        { frame: wc.mainFrame, importedSharedTexture: tex.imported },
        { id: unityId, surfaceId, width: info.width, height: info.height, generation: info.generation }
      )
      .catch((e: Error) => {
        tex!.sentTo.delete(to)
        console.log(`[shared-surface] sendSharedTexture failed: ${e.message}`)
      })
    tex.pendingSends.add(send)
    void send.finally(() => tex!.pendingSends.delete(send))
  }

  return { surfaceId, generation: info.generation, error: null, fatal: false }
}

function forgetSent(t: RingTex, wcId: number, unityId?: string): void {
  if (unityId != null) {
    t.sentTo.delete(`${wcId}:${unityId}`)
    return
  }
  const prefix = `${wcId}:`
  for (const to of [...t.sentTo]) if (to.startsWith(prefix)) t.sentTo.delete(to)
}

export function resendSurface(instanceKey: string, wcId: number, unityId?: string): void {
  const st = states.get(instanceKey)
  if (!st) return
  for (const t of st.ring.values()) forgetSent(t, wcId, unityId)
}

export function surfaceSnapshot(): Record<string, { epoch: number; size: string; ring: { surfaceId: number; sentTo: string[] }[] }> {
  const out: Record<string, { epoch: number; size: string; ring: { surfaceId: number; sentTo: string[] }[] }> = {}
  for (const [key, st] of states)
    out[key] = {
      epoch: st.epoch,
      size: `${st.width}x${st.height}`,
      ring: [...st.ring.values()].map((t) => ({ surfaceId: t.surfaceId, sentTo: [...t.sentTo] }))
    }
  return out
}

export function clearSentTo(wcId: number): void {
  for (const st of states.values()) {
    for (const t of st.ring.values()) forgetSent(t, wcId)
  }
}

export function releaseAllSurfaces(): void {
  const a = loadAddon()
  const keys = [...states.keys()]
  for (const key of keys) {
    const st = states.get(key)
    states.delete(key)
    reported.delete(key)
    transientFailStreak.delete(key)
    reportedTransient.delete(key)
    contentVerified.delete(key)
    readbackAttempts.delete(key)
    readbackNullLogged.delete(key)
    if (st && a) releaseState(st, a)
  }
  if (keys.length) console.log(`[shared-surface] released ${keys.length} instance(s) for GPU recovery`)
}

export function releaseHeld(instanceKey: string): void {
  reported.delete(instanceKey)
  transientFailStreak.delete(instanceKey)
  reportedTransient.delete(instanceKey)
  contentVerified.delete(instanceKey)
  readbackAttempts.delete(instanceKey)
  readbackNullLogged.delete(instanceKey)
  const st = states.get(instanceKey)
  if (!st) return
  states.delete(instanceKey)
  const a = loadAddon()
  if (!a) return
  releaseState(st, a, instanceKey)
}
