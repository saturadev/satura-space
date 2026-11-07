/// <reference lib="dom" />
import { ipcRenderer, sharedTexture } from 'electron'
import { GenerationLog } from '@shared/unity/stream-state'
import { debugLog } from '@shared/debug-log'
import { RELEASE_TO_MAIN, releaseTexture, type ReleasableTex } from './texture-release'

interface ImportedTex extends ReleasableTex {
  getVideoFrame(): VideoFrame
}

interface Session {
  width: number
  height: number
  generation: number
  slots: Map<number, ImportedTex>
  pending: { surfaceId: number; generation: number; seq?: number; onDrawn?: () => void } | null
  canvas: HTMLCanvasElement | null
  ctx: CanvasRenderingContext2D | null
  arrivedAt: number
  every: number
  paintedAt: number
}

interface SurfaceMeta {
  id: string
  surfaceId: number
  width: number
  height: number
  generation: number
}

const sessions = new Map<string, Session>()
const earlyFrames = new Map<string, { surfaceId: number; generation: number }>()
const liveCallbacks = new Set<(id: string, dt: number) => void>()
const errLogged = new Set<string>()
const lastFrameT = new Map<string, number>()
const failStreak = new Map<string, number>()
const lastSeq = new Map<string, number>()
let staleNotices = 0
let retiredDrops = 0
const gens = new Map<string, GenerationLog>()

function genLog(id: string): GenerationLog {
  let g = gens.get(id)
  if (!g) {
    g = new GenerationLog()
    gens.set(id, g)
  }
  return g
}

function noteRetired(id: string, what: string, gen: number): void {
  retiredDrops++
  if (retiredDrops <= 5 || retiredDrops % 100 === 0)
    debugLog(`[shared-view] ${id}: dropped a ${what} of retired gen ${gen} (${retiredDrops} so far)`)
}
const holds = new Map<string, { gen: number; upTo: number; pending: number; painted: number }>()

function holdOf(id: string): { gen: number; upTo: number; pending: number; painted: number } {
  let h = holds.get(id)
  if (!h) {
    h = { gen: -1, upTo: 0, pending: -1, painted: -1 }
    holds.set(id, h)
  }
  return h
}

function sendHold(id: string): void {
  const h = holds.get(id)
  if (!h) return
  const held = [h.pending, h.painted].filter((sid, i, all) => sid >= 0 && all.indexOf(sid) === i)
  try {
    ipcRenderer.send('unity:sharedHold', { id, gen: h.gen, upTo: h.upTo, held })
  } catch {
  }
}

function notePainted(id: string, surfaceId: number): void {
  const h = holds.get(id)
  if (!h) return
  h.painted = surfaceId
  if (h.pending === surfaceId) h.pending = -1
  sendHold(id)
}
let rafId = 0
let rafAt = 0
let vsync = 1000 / 60

const STUCK_FRAME_THRESHOLD = 30
const ESCALATE_DEBOUNCE_MS = 500
const CONTEXT_LOSS_REPORT_DEBOUNCE_MS = 500
let escalated = false
let escalateTimer: ReturnType<typeof setTimeout> | null = null
let lastContextLossReportAt = 0

function noteFrameSuccess(id: string): void {
  failStreak.delete(id)
}

function escalateGpuStuck(id: string): void {
  if (escalated) return
  escalated = true
  if (escalateTimer) return
  escalateTimer = setTimeout(() => {
    escalateTimer = null
    try {
      ipcRenderer.send('gpu:reportStuck', { id })
    } catch {
    }
  }, ESCALATE_DEBOUNCE_MS)
}

function noteFrameFailure(id: string): void {
  const streak = (failStreak.get(id) ?? 0) + 1
  failStreak.set(id, streak)
  if (streak >= STUCK_FRAME_THRESHOLD) escalateGpuStuck(id)
}

function canvasFor(id: string): HTMLCanvasElement | null {
  const safe = id.replace(/["\\]/g, '\\$&')
  return document.querySelector<HTMLCanvasElement>(`canvas[data-unity-session="${safe}"]`)
}

function ctxFor(s: Session, id: string): CanvasRenderingContext2D | null {
  if (s.canvas && s.canvas.isConnected && s.ctx) return s.ctx
  const canvas = canvasFor(id)
  if (!canvas) {
    s.canvas = null
    s.ctx = null
    return null
  }
  if (canvas !== s.canvas || !s.ctx) {
    s.canvas = canvas
    s.ctx = canvas.getContext('2d', { desynchronized: true, alpha: false }) ?? null
  }
  return s.ctx
}

function drawSession(id: string, s: Session): void {
  const pending = s.pending
  if (pending == null) return
  if (pending.generation !== s.generation) {
    s.pending = null
    return
  }
  const imported = s.slots.get(pending.surfaceId)
  if (!imported) return
  s.pending = null
  const ctx = ctxFor(s, id)
  if (!ctx || !s.canvas) return
  if ((ctx as unknown as { isContextLost?: () => boolean }).isContextLost?.()) {
    if (!errLogged.has(id)) {
      errLogged.add(id)
      console.warn(`[shared-view] 2d context lost for ${id} — escalating`)
    }
    s.canvas = null
    s.ctx = null
    noteFrameFailure(id)
    return
  }
  let frame: VideoFrame | null = null
  try {
    frame = imported.getVideoFrame()
  } catch {
    frame = null
  }
  if (!frame) {
    noteFrameFailure(id)
    return
  }
  try {
    if (s.canvas.width !== s.width || s.canvas.height !== s.height) {
      s.canvas.width = s.width
      s.canvas.height = s.height
    }
    ctx.drawImage(frame, 0, 0)
    noteFrameSuccess(id)
    s.canvas.dataset.paintSid = String(pending.surfaceId)
    if (pending.seq != null) s.canvas.dataset.paintSeq = String(pending.seq)
    notePainted(id, pending.surfaceId)
    s.canvas.dataset.paintAt = String(performance.now())
    s.canvas.dispatchEvent(new Event('unitypaint'))
  } finally {
    frame.close()
  }
  if (!pending.onDrawn) return
  try {
    pending.onDrawn()
  } catch (err) {
    console.warn(`[shared-view] frame callback failed for ${id}: ${(err as Error).message}`)
  }
}

function paced(id: string): boolean {
  return id.startsWith('tuner|')
}

function tick(t: number): void {
  rafId = 0
  const gap = t - rafAt
  if (rafAt > 0 && gap > 4 && gap < 40) vsync += (gap - vsync) * 0.1
  rafAt = t
  let held = false
  for (const [id, s] of sessions) {
    if (s.pending == null) continue
    if (paced(id) && s.paintedAt > 0) {
      const slot = Math.max(1, Math.round(s.every / vsync)) * vsync
      if (t - s.paintedAt < slot - vsync * 0.5 && t - s.arrivedAt < vsync) {
        held = true
        continue
      }
    }
    try {
      const before = s.pending
      drawSession(id, s)
      if (paced(id) && s.pending !== before) s.paintedAt = t
    } catch (err) {
      if (!errLogged.has(id)) {
        errLogged.add(id)
        console.warn(`[shared-view] draw error for ${id}: ${(err as Error).message}`)
      }
      s.canvas = null
      s.ctx = null
    }
  }
  if (held) schedule()
}

function schedule(): void {
  if (rafId) return
  rafId = requestAnimationFrame(tick)
}

function releaseNow(slots: ImportedTex[]): void {
  for (const t of slots) {
    try {
      releaseTexture(t)
    } catch {
    }
  }
}

function dropSlots(s: Session): void {
  releaseNow([...s.slots.values()])
  s.slots.clear()
}

export function installSharedTextureView(): void {
  try {
    sharedTexture.setSharedTextureReceiver(async (data, meta?: SurfaceMeta) => {
      if (!meta) return
      const tex = data.importedSharedTexture as unknown as ImportedTex
      const g = genLog(meta.id)
      if (g.admit(meta.generation) === 'retired') {
        noteRetired(meta.id, 'texture', meta.generation)
        releaseNow([tex])
        return
      }
      let s = sessions.get(meta.id)
      if (s && (s.width !== meta.width || s.height !== meta.height || s.generation !== meta.generation)) {
        dropSlots(s)
        s = undefined
      }
      if (!s) {
        s = {
          width: meta.width,
          height: meta.height,
          generation: meta.generation,
          slots: new Map(),
          pending: null,
          canvas: null,
          ctx: null,
          arrivedAt: 0,
          every: 1000 / 60,
          paintedAt: 0
        }
        sessions.set(meta.id, s)
      }
      const prev = s.slots.get(meta.surfaceId)
      if (prev && prev !== tex) releaseNow([prev])
      s.slots.set(meta.surfaceId, tex)
      errLogged.delete(meta.id)
      const early = earlyFrames.get(meta.id)
      if (early && early.generation === s.generation) {
        earlyFrames.delete(meta.id)
        if (s.pending == null) s.pending = { surfaceId: early.surfaceId, generation: early.generation }
      }
      if (s.pending != null) schedule()
    })
  } catch (e) {
    console.warn(`[shared-view] setSharedTextureReceiver unavailable: ${(e as Error).message}`)
  }

  window.addEventListener('unhandledrejection', (e) => {
    const msg = String((e.reason as Error | undefined)?.message ?? e.reason ?? '')
    if (!msg.includes(RELEASE_TO_MAIN)) return
    e.preventDefault()
    debugLog(`[shared-view] late texture release ignored: ${msg.slice(msg.lastIndexOf('Error:') + 7)}`)
  })

  window.addEventListener(
    'webglcontextlost',
    (e) => {
      const target = e.target
      if (!(target instanceof HTMLCanvasElement) || !target.isConnected) return
      const now = performance.now()
      if (now - lastContextLossReportAt < CONTEXT_LOSS_REPORT_DEBOUNCE_MS) return
      lastContextLossReportAt = now
      try {
        ipcRenderer.send('gpu:reportContextLoss')
      } catch {
      }
    },
    true
  )

  ipcRenderer.on('gpu:reset', () => {
    escalated = false
    if (escalateTimer) {
      clearTimeout(escalateTimer)
      escalateTimer = null
    }
    resetAllSharedTextures()
    try {
      ipcRenderer.send('gpu:resetAck')
    } catch {
    }
  })

  try {
    ipcRenderer.send('gpu:resetAck')
  } catch {
  }

  ipcRenderer.on(
    'unity:sharedFrame',
    (_e, payload: { id: string; surfaceId: number; generation?: number; t?: number; seq?: number; useq?: number }) => {
      if (!payload || !payload.id) return
      if (typeof payload.generation === 'number' && genLog(payload.id).admit(payload.generation) === 'retired') {
        noteRetired(payload.id, 'frame notice', payload.generation)
        return
      }
      if (typeof payload.seq === 'number') {
        if (payload.seq <= (lastSeq.get(payload.id) ?? 0)) {
          staleNotices++
          return
        }
        lastSeq.set(payload.id, payload.seq)
      }
      if (typeof payload.useq === 'number' && typeof payload.generation === 'number') {
        const h = holdOf(payload.id)
        if (h.gen !== payload.generation) {
          h.gen = payload.generation
          h.painted = -1
        }
        h.upTo = payload.useq
        h.pending = payload.surfaceId
        sendHold(payload.id)
      }
      const s = sessions.get(payload.id)
      const generation = typeof payload.generation === 'number' ? payload.generation : s?.generation
      if (s && generation === s.generation) {
        earlyFrames.delete(payload.id)
        s.pending = { surfaceId: payload.surfaceId, generation, seq: payload.seq }
        schedule()
      } else if (generation != null) {
        earlyFrames.set(payload.id, { surfaceId: payload.surfaceId, generation })
      }
      const t = typeof payload.t === 'number' ? payload.t : performance.now()
      const prev = lastFrameT.get(payload.id)
      lastFrameT.set(payload.id, t)
      const dt = prev != null ? t - prev : 0
      for (const cb of liveCallbacks) cb(payload.id, dt)
    }
  )
}

export function resetAllSharedTextures(): void {
  for (const s of sessions.values()) {
    dropSlots(s)
    s.pending = null
    s.canvas = null
    s.ctx = null
  }
  sessions.clear()
  gens.clear()
  earlyFrames.clear()
  errLogged.clear()
  lastFrameT.clear()
  failStreak.clear()
}

export function dropSharedTexture(id: string): void {
  earlyFrames.delete(id)
  lastFrameT.delete(id)
  lastSeq.delete(id)
  holds.delete(id)
  gens.delete(id)
  failStreak.delete(id)
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  errLogged.delete(id)
  dropSlots(s)
  s.pending = null
  const canvas = s.canvas && s.canvas.isConnected ? s.canvas : canvasFor(id)
  if (!canvas || !canvas.width) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

export function queueSharedFrame(
  id: string,
  surfaceId: number,
  generation: number,
  width: number,
  height: number,
  onDrawn: () => void
): void {
  if (genLog(id).admit(generation) === 'retired') {
    noteRetired(id, 'tuner frame', generation)
    return
  }
  let s = sessions.get(id)
  if (s && (s.width !== width || s.height !== height || s.generation !== generation)) {
    dropSlots(s)
    sessions.delete(id)
    s = undefined
  }
  if (!s) {
    s = { width, height, generation, slots: new Map(), pending: null, canvas: null, ctx: null, arrivedAt: 0, every: 1000 / 60, paintedAt: 0 }
    sessions.set(id, s)
  }
  const now = performance.now()
  const dt = now - s.arrivedAt
  if (s.arrivedAt > 0 && dt > 0 && dt < 250) s.every += (dt - s.every) * 0.15
  s.arrivedAt = now
  s.pending = { surfaceId, generation, onDrawn }
  schedule()
}

export function sharedSlotReady(id: string, surfaceId: number, generation: number): boolean {
  const s = sessions.get(id)
  return !!s && s.generation === generation && s.slots.has(surfaceId)
}

export function releaseSharedTexture(id: string): void {
  earlyFrames.delete(id)
  lastFrameT.delete(id)
  failStreak.delete(id)
  errLogged.delete(id)
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  dropSlots(s)
  s.pending = null
}

export function sharedTextureStats(): { sessions: number; slots: number; early: number; stale: number; retired: number } {
  let slots = 0
  for (const s of sessions.values()) slots += s.slots.size
  return { sessions: sessions.size, slots, early: earlyFrames.size, stale: staleNotices, retired: retiredDrops }
}

export function onSharedFrame(cb: (id: string, dt: number) => void): () => void {
  liveCallbacks.add(cb)
  return () => liveCallbacks.delete(cb)
}
