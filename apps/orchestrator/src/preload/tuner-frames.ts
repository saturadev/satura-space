/// <reference lib="dom" />
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { TunerEndedEvent, TunerFrameEvent } from '@shared/tuner'
import { tunerSurfaceKey, surfaceWaitAction } from '@shared/tuner-frame'
import { queueSharedFrame, releaseSharedTexture, sharedSlotReady } from './shared-texture-view'

type FrameCb = (e: TunerFrameEvent) => void

interface Waiting {
  projectPath: string
  session: string
  surfaceId: number
  generation: number
  since: number
  resynced: boolean
}

const subscribers = new Set<FrameCb>()
const waiting = new Map<string, Waiting>()
const active = new Map<string, { projectPath: string; session: string }>()
const dropped = new Map<string, number>()
const unpainted = new Map<string, TunerFrameEvent>()
let installed = false
let watchdog: ReturnType<typeof setInterval> | null = null

const WATCHDOG_MS = 200
const DROPPED_MS = 5000

function emit(e: TunerFrameEvent): void {
  for (const cb of subscribers) {
    try {
      cb(e)
    } catch (err) {
      console.warn(`[tuner] frame subscriber failed: ${(err as Error).message}`)
    }
  }
}

function requestSurface(projectPath: string, session: string): void {
  ipcRenderer.send('tuner:surface', { projectPath, session })
}

function checkWaiting(): void {
  const now = performance.now()
  for (const [key, w] of waiting) {
    if (sharedSlotReady(key, w.surfaceId, w.generation)) {
      waiting.delete(key)
      continue
    }
    const action = surfaceWaitAction(now - w.since, w.resynced)
    if (action === 'resync') {
      w.resynced = true
      console.warn(`[tuner] surface ${w.surfaceId} for ${w.session} not received, asking main to resend`)
      requestSurface(w.projectPath, w.session)
    } else if (action === 'give-up') {
      waiting.delete(key)
      console.warn(`[tuner] surface ${w.surfaceId} for ${w.session} never arrived`)
    }
  }
  if (waiting.size === 0 && watchdog) {
    clearInterval(watchdog)
    watchdog = null
  }
}

function forget(key: string): void {
  waiting.delete(key)
  unpainted.delete(key)
  active.delete(key)
  const now = performance.now()
  for (const [k, at] of dropped) if (now - at >= DROPPED_MS) dropped.delete(k)
  dropped.set(key, now)
  releaseSharedTexture(key)
}

function onFrame(_e: IpcRendererEvent, p: TunerFrameEvent): void {
  const sf = p?.surface
  if (!sf) return
  const key = sf.key
  const droppedAt = dropped.get(key)
  if (droppedAt !== undefined) {
    if (performance.now() - droppedAt < DROPPED_MS) return
    dropped.delete(key)
  }
  active.set(key, { projectPath: p.projectPath, session: p.meta.session })
  const prev = unpainted.get(key)
  if (prev) {
    if (prev.meta.icons && !p.meta.icons) p.meta.icons = prev.meta.icons
    const lost = prev.meta.poses?.filter((x) => x.id[0] === 'o' && !p.meta.poses?.some((y) => y.id === x.id))
    if (lost?.length) p.meta.poses = [...lost, ...(p.meta.poses ?? [])]
  }
  unpainted.set(key, p)
  queueSharedFrame(key, sf.surfaceId, sf.generation, p.meta.width, p.meta.height, () => {
    if (unpainted.get(key) === p) unpainted.delete(key)
    waiting.delete(key)
    emit(p)
  })
  if (sharedSlotReady(key, sf.surfaceId, sf.generation)) return
  const w = waiting.get(key)
  if (w) {
    w.surfaceId = sf.surfaceId
    w.generation = sf.generation
  } else {
    waiting.set(key, {
      projectPath: p.projectPath,
      session: p.meta.session,
      surfaceId: sf.surfaceId,
      generation: sf.generation,
      since: performance.now(),
      resynced: false
    })
  }
  if (!watchdog) watchdog = setInterval(checkWaiting, WATCHDOG_MS)
}

function install(): void {
  if (installed) return
  installed = true
  ipcRenderer.on('tuner:frame', onFrame)
  ipcRenderer.on('tuner:ended', (_e: IpcRendererEvent, p: TunerEndedEvent) => {
    if (p) forget(tunerSurfaceKey(p.projectPath, p.session))
  })
  ipcRenderer.on('gpu:reset', () => {
    waiting.clear()
    for (const a of active.values()) requestSurface(a.projectPath, a.session)
  })
}

export function onTunerFrame(cb: FrameCb): () => void {
  install()
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

export function tunerSurfaceRequest(projectPath: string, session: string): void {
  dropped.delete(tunerSurfaceKey(projectPath, session))
  requestSurface(projectPath, session)
}

export function dropTunerSurface(projectPath: string, session: string): void {
  forget(tunerSurfaceKey(projectPath, session))
}
