import { webContents } from 'electron'
import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { ControlEvent, ControlResult } from '@shared/control-protocol'
import { openedTargets, parseTunerUnsaved, TUNER_PRIMITIVES } from '@shared/tuner'
import type {
  Quat,
  TunerButtonResult,
  TunerCamera,
  TunerClearViewRequest,
  TunerCanvas,
  TunerEdit,
  TunerEntryTarget,
  TunerHierarchyAdded,
  TunerHierarchyRequest,
  TunerHierarchyResult,
  TunerLiveEvent,
  TunerObject,
  TunerOpened,
  TunerParticles,
  TunerParticlesOp,
  TunerPose,
  TunerReset,
  TunerRestore,
  TunerResult,
  TunerSaveResult,
  TunerShadow,
  TunerState,
  TunerTransform,
  TunerTreeRequest,
  TunerView,
  Vec3
} from '@shared/tuner'
import { UnityControlClient } from './unity-control-client'
import {
  cleanTunerAnimatorRequest,
  parseTunerAnimator,
  type TunerAnimatorRequest,
  type TunerAnimatorResult
} from '@shared/tuner-animator'
import { cleanTunerStagingRequest, parseTunerStaging, type TunerStagingRequest } from '@shared/tuner-staging'
import { unityProvider } from './unity-instance-provider'
import { setTunerStateProbe } from './tuner-open'
import { EDITOR_REVEALED_ERROR, HEADLESS_GRAPHICS_ERROR } from '@shared/tuner-ready'
import { assetTunerView } from '@shared/unity-assets'
import { ensureSspaceForSync } from '../sspace'
import { editorNotRunningError } from './scratchpad-store'
import {
  cleanTunerEntryTarget,
  cleanTunerRestore,
  parseTunerCanvases,
  readTunerView,
  tunerStartArgs,
  tunerViewHasObjects,
  tunerViewsDir
} from './tuner-view'
import {
  endTunerSurface,
  resetTunerSurfaceMisses,
  routeTunerFrame,
  tunerSurfaceResync,
  type TunerFrameTarget
} from './tuner-surface'
import { cleanTunerRectRequest, cleanTunerRectsRequest, parseTunerRectInfo, parseTunerRectInfos, type TunerRectInfo, type TunerRectRequest, type TunerRectsRequest } from '@shared/tuner-rect'
import { cleanTunerHandlesRequest, parseTunerHandlesState, type TunerHandlesRequest, type TunerHandlesState } from '@shared/tuner-handles'
import {
  isTunerSceneSettings,
  isTunerTheme,
  parsePickResult,
  tunerSceneSettingsArgs,
  type TunerPickRectRequest,
  type TunerPickRectResult,
  type TunerPickRequest,
  type TunerPickResult,
  type TunerSceneSelection,
  type TunerSceneSettings,
  type TunerSceneStats,
  type TunerTheme
} from '@shared/tuner-sceneview'
import { censusGauge, censusTrack } from '@shared/census'
import { cleanTunerAnnotationsRequest, parseTunerAnnotations, type TunerAnnotations, type TunerAnnotationsRequest } from '@shared/tuner-annotations'
import { debugLog } from '@shared/debug-log'

const POLL_MS = 250
const RETRY_START_MS = 2000
const CONNECT_WAIT_MS = 3000
const START_TIMEOUT_MS = 15_000
const EDIT_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 3000
const FRAME_RETRY_MS = 1000
const FRAME_MISSES = 6
const BUTTON_TIMEOUT_MS = 60_000
const SAVE_TIMEOUT_MS = 120_000
const PICK_TIMEOUT_MS = 5000
const CANVASES_SESSION = '_canvases'
const DISCARD_SESSION = '_discard'
const MAX_TRANSFORM_ITEMS = 512
const MAX_IDS = 512
const MAX_TREE_OPEN = 20000
const MAX_FOCUS_IDS = 8192

interface ViewWatch {
  watcher: FSWatcher | null
  subscribers: Map<number, number>
  timer: NodeJS.Timeout | null
}

interface ViewsWatchRegistry {
  watch: (projectPath: string, wcId: number) => void
  unwatch: (projectPath: string, wcId: number) => void
  unwatchAll: (wcId: number) => void
  releaseUnder: (dir: string) => void
}

function createViewsWatchRegistry(
  dirFor: (projectPath: string) => string,
  channel: string,
  tag: string
): ViewsWatchRegistry {
  const watches = new Map<string, ViewWatch>()

  const notify = (projectPath: string, w: ViewWatch): void => {
    for (const wcId of w.subscribers.keys()) {
      const wc = webContents.fromId(wcId)
      if (wc && !wc.isDestroyed()) wc.send(channel, { projectPath })
    }
  }

  const watchViews = (projectPath: string, wcId: number): void => {
    let w = watches.get(projectPath)
    if (!w) {
      w = { watcher: null, subscribers: new Map(), timer: null }
      watches.set(projectPath, w)
      const dir = dirFor(projectPath)
      if (!existsSync(projectPath)) {
        w.subscribers.set(wcId, (w.subscribers.get(wcId) ?? 0) + 1)
        return
      }
      try {
        ensureSspaceForSync(dir)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const entry = w
        entry.watcher = watch(dir, () => {
          if (entry.timer) clearTimeout(entry.timer)
          entry.timer = setTimeout(() => {
            entry.timer = null
            notify(projectPath, entry)
          }, 120)
        })
        entry.watcher.on('error', () => {
        })
      } catch (e) {
        console.log(`[${tag}] views watch failed for ${projectPath}: ${(e as Error).message}`)
      }
    }
    w.subscribers.set(wcId, (w.subscribers.get(wcId) ?? 0) + 1)
  }

  const unwatchViews = (projectPath: string, wcId: number, all = false): void => {
    const w = watches.get(projectPath)
    if (!w) return
    const left = all ? 0 : (w.subscribers.get(wcId) ?? 0) - 1
    if (left > 0) w.subscribers.set(wcId, left)
    else w.subscribers.delete(wcId)
    if (w.subscribers.size > 0) return
    if (w.timer) clearTimeout(w.timer)
    try {
      w.watcher?.close()
    } catch {
    }
    watches.delete(projectPath)
  }

  return {
    watch: watchViews,
    unwatch: unwatchViews,
    unwatchAll: (wcId) => {
      for (const projectPath of [...watches.keys()]) unwatchViews(projectPath, wcId, true)
    },
    releaseUnder: (dir) => {
      const root = resolve(dir).toLowerCase()
      for (const [projectPath, w] of [...watches]) {
        const p = resolve(projectPath).toLowerCase()
        if (p !== root && !p.startsWith(root + sep)) continue
        if (w.timer) clearTimeout(w.timer)
        w.timer = null
        try {
          w.watcher?.close()
        } catch {
        }
        w.watcher = null
      }
    }
  }
}

const viewWatches = createViewsWatchRegistry(tunerViewsDir, 'tuner:viewsChanged', 'tuner')

export const watchTunerViews = viewWatches.watch
export const unwatchTunerViews = viewWatches.unwatch
export const unwatchAllTunerViews = viewWatches.unwatchAll
export const releaseTunerViewsUnder = viewWatches.releaseUnder

const SESSION_RE = /^[\w.-]{1,64}$/
const PROP_RE = /^[A-Za-z_](?:[\w.[\]]| (?=[\w[]))*$/
const ID_RE = /^[\w.#-]{1,64}$/
const COMPONENT_RE = /^[A-Za-z_][\w.+]*(?:#\d+)?$/
const STATE_RE = /^[A-Za-z0-9._-]{1,64}$/

function cleanIds(v: unknown, max = MAX_IDS): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of v) {
    if (out.length >= max) break
    if (typeof x === 'string' && ID_RE.test(x) && !seen.has(x)) {
      seen.add(x)
      out.push(x)
    }
  }
  return out
}

const HIERARCHY_OPS: TunerHierarchyRequest['op'][] = ['create', 'delete', 'duplicate', 'rename', 'move']

function hierarchyRef(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 1024 && !/[\r\n\0]/.test(v)
}

function parseHierarchyAdded(v: unknown): TunerHierarchyAdded[] {
  if (!Array.isArray(v)) return []
  const out: TunerHierarchyAdded[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object') continue
    const o = x as Record<string, unknown>
    if (typeof o.id !== 'string' || !ID_RE.test(o.id) || !hierarchyRef(o.path) || !o.path) continue
    out.push({ id: o.id, path: o.path, scene: hierarchyRef(o.scene) ? o.scene : '' })
  }
  return out
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function vec(v: unknown, n: 3): Vec3 | undefined
function vec(v: unknown, n: 4): Quat | undefined
function vec(v: unknown, n: number): number[] | undefined {
  return Array.isArray(v) && v.length === n && v.every(isNum) ? [...v] : undefined
}

function cameraArgs(c: TunerCamera): Record<string, unknown> | null {
  const position = vec(c?.position, 3)
  const rotation = vec(c?.rotation, 4)
  if (!position || !rotation || !isNum(c.fov) || !isNum(c.width) || !isNum(c.height)) return null
  const ortho = isNum(c.ortho) && c.ortho > 0 ? c.ortho : 0
  const clip = Array.isArray(c.clip) && c.clip.length === 2 && isNum(c.clip[0]) && isNum(c.clip[1]) && c.clip[0] > 0 && c.clip[1] > c.clip[0] ? { near: c.clip[0], far: c.clip[1] } : {}
  const cseq = isNum(c.cseq) && c.cseq > 0 ? { cseq: Math.round(c.cseq) } : {}
  const points = isNum(c.points) && c.points >= 1 ? { points: c.points } : {}
  return { position, rotation, fov: c.fov, ortho, ...clip, width: Math.round(c.width), height: Math.round(c.height), ...points, ...cseq }
}

const PARTICLE_OPS: readonly TunerParticlesOp[] = ['play', 'pause', 'restart', 'stop', 'speed']

function parseTunerParticles(v: unknown): TunerParticles | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.name !== 'string' || typeof o.path !== 'string') return null
  return {
    name: o.name,
    path: o.path,
    mode: o.mode === 'play' ? 'play' : 'edit',
    playing: o.playing === true,
    time: isNum(o.time) ? o.time : 0,
    duration: isNum(o.duration) ? o.duration : 0,
    count: isNum(o.count) ? o.count : 0,
    speed: isNum(o.speed) ? o.speed : 1
  }
}

function resultError(r: ControlResult | null, fallback: string): string {
  if (!r) return 'The Unity editor did not answer in time. It may be compiling, importing or showing a dialog.'
  return typeof r.error === 'string' && r.error ? r.error : fallback
}

interface TreeAsk {
  ids: string[]
  query?: string
  path?: string
  scene?: string
  at: number
}

let treeSeq = 0

interface Session {
  key: string
  projectKey: string
  projectPath: string
  session: string
  view: TunerView
  wcId: number
  port: number
  client: UnityControlClient
  offEvent: () => void
  poll: NodeJS.Timeout
  wasConnected: boolean
  active: boolean
  starting: boolean
  lastStartAt: number
  camera: Record<string, unknown> | null
  watch: string | null
  watchIds: string[]
  tree: Record<string, unknown> | null
  trees: Map<string, TreeAsk>
  hidden: boolean
  sceneSelection: Record<string, unknown> | null
  theme: Record<string, unknown> | null
  settings: TunerSceneSettings | null
  lastState: TunerState | null
  merged: TunerState | null
  restore: TunerRestore | null
  target: TunerFrameTarget | null
  frameRetry: NodeJS.Timeout | null
  frameTrouble: boolean
}

function frameTroubleText(reason: string): string {
  if (/GPU is not available/i.test(reason)) return "the app's GPU process isn't running. Restart Satura Space"
  if (/IOSurfaceLookup/i.test(reason)) return "the app can't read Unity's frames"
  return reason || "the app can't draw Unity's frames"
}

class TunerService {
  private readonly sessions = censusTrack('tuner.sessions', new Map<string, Session>())
  private readonly remoteViewers = censusTrack('tuner.remoteViewers', new Map<string, Set<string>>())

  constructor() {
    censusGauge('tuner.rendering', () => [...this.sessions.values()].filter((s) => s.active && !this.hiddenNow(s)).length)
    censusGauge('tuner.remoteViewerCount', () => [...this.remoteViewers.values()].reduce((n, v) => n + v.size, 0))
    unityProvider.onRevealChange((projectKey, revealed) => {
      if (revealed) this.endForReveal(projectKey)
    })
  }

  private endForReveal(projectKey: string): void {
    for (const s of [...this.sessions.values()]) {
      if (s.projectKey !== projectKey) continue
      console.log(`[tuner] editor revealed, ending session=${s.session} project=${s.projectKey}`)
      this.send(s, 'tuner:ended', { projectPath: s.projectPath, session: s.session, reason: 'revealed' })
      void this.dispose(s, true)
    }
  }

  private keyFor(projectKey: string, session: string): string {
    return `${projectKey}\n${session}`
  }

  private find(projectPath: string, session: string): Session | undefined {
    const ctl = unityProvider.primaryControl(projectPath)
    return this.sessions.get(this.keyFor(ctl?.projectKey ?? projectPath, session))
  }

  private send(s: Session, channel: string, payload: unknown): void {
    const wc = webContents.fromId(s.wcId)
    if (!wc || wc.isDestroyed()) {
      void this.dispose(s, false)
      return
    }
    wc.send(channel, payload)
  }

  private emitState(s: Session, state: TunerState): void {
    s.lastState = state
    s.merged = s.merged && s.merged.session === state.session ? { ...s.merged, ...state } : state
    if (Array.isArray(state.overrides))
      s.restore = { activeState: state.activeState, overrides: state.overrides, opened: openedTargets(state) }
    this.send(s, 'tuner:state', { projectPath: s.projectPath, state })
  }

  private emitDown(s: Session): void {
    const base = s.lastState ?? { session: s.session, playing: false, graphics: true, objects: [] }
    this.emitState(s, { ...base, session: s.session, offline: true })
  }

  private attachClient(s: Session, port: number): void {
    s.offEvent()
    s.client.close()
    s.port = port
    s.client = new UnityControlClient(port)
    s.offEvent = s.client.onEvent((e) => this.onEvent(s, e))
    s.wasConnected = false
    s.active = false
  }

  private onEvent(s: Session, e: ControlEvent): void {
    if (e.session !== s.session || this.sessions.get(s.key) !== s) return
    if (e.event === 'tuner/frame') {
      routeTunerFrame(this.frameTarget(s), e)
    } else if (e.event === 'tuner/live') {
      const live: TunerLiveEvent = { projectPath: s.projectPath, session: s.session }
      if (Array.isArray(e.poses)) live.poses = e.poses as TunerPose[]
      if (e.object && typeof e.object === 'object') live.object = e.object as TunerObject
      if (Array.isArray(e.objects)) live.objects = (e.objects as unknown[]).filter((o): o is TunerObject => !!o && typeof o === 'object')
      if ('shadow' in e) live.shadow = e.shadow && typeof e.shadow === 'object' ? (e.shadow as TunerShadow) : null
      if ('particles' in e) live.particles = parseTunerParticles(e.particles)
      if ('animator' in e) live.animator = parseTunerAnimator(e.animator)
      if ('staging' in e) live.staging = parseTunerStaging(e.staging)
      this.send(s, 'tuner:live', live)
    } else if (e.event === 'tuner/state') {
      if (e.state && typeof e.state === 'object') this.emitState(s, e.state as TunerState)
    } else if (e.event === 'tuner/ended') {
      s.active = false
      endTunerSurface(s.key, false)
      const reason = typeof e.reason === 'string' ? e.reason : 'ended'
      console.log(`[tuner] ended session=${s.session} reason=${reason} project=${s.projectKey}`)
      this.send(s, 'tuner:ended', { projectPath: s.projectPath, session: s.session, reason })
    }
  }

  private frameTarget(s: Session): TunerFrameTarget {
    const pid = unityProvider.primaryControl(s.projectKey)?.pid
    const t = s.target
    if (t && t.projectPath === s.projectPath && t.pid === pid) return t
    s.target = {
      key: s.key,
      projectPath: s.projectPath,
      session: s.session,
      wcId: s.wcId,
      pid,
      send: (channel, payload) => this.send(s, channel, payload),
      onMiss: (misses, reason) => this.frameMissed(s, misses, reason),
      onShown: () => this.frameShown(s)
    }
    return s.target
  }

  private frameMissed(s: Session, misses: number, reason: string): void {
    if (s.frameTrouble || s.frameRetry || this.sessions.get(s.key) !== s) return
    if (misses > FRAME_MISSES) {
      s.frameTrouble = true
      console.warn(`[tuner] no frame of session=${s.session} could be shown after ${misses} tries (${reason || 'import failed'}) project=${s.projectKey}`)
      this.send(s, 'tuner:live', { projectPath: s.projectPath, session: s.session, frameTrouble: frameTroubleText(reason) })
      return
    }
    console.log(`[tuner] frame ${misses} of session=${s.session} could not be shown (${reason || 'import failed'}), asking Unity for another project=${s.projectKey}`)
    s.frameRetry = setTimeout(() => {
      s.frameRetry = null
      if (this.sessions.get(s.key) === s && s.active && s.camera) s.client.notify('tuner/camera', { session: s.session, ...s.camera })
    }, FRAME_RETRY_MS)
  }

  private frameShown(s: Session): void {
    if (!s.frameTrouble) return
    s.frameTrouble = false
    console.log(`[tuner] frames of session=${s.session} show again project=${s.projectKey}`)
    this.send(s, 'tuner:live', { projectPath: s.projectPath, session: s.session, frameTrouble: null })
  }

  surface(projectPath: string, session: string): void {
    const s = this.find(projectPath, session)
    if (!s) return
    tunerSurfaceResync(this.frameTarget(s))
  }

  private async sendStart(s: Session): Promise<TunerResult<TunerState>> {
    s.starting = true
    s.lastStartAt = Date.now()
    s.frameTrouble = false
    resetTunerSurfaceMisses(s.key)
    const client = s.client
    try {
      const args = tunerStartArgs(s.session, s.view, s.restore)
      const r = await client.command('tuner/start', args, START_TIMEOUT_MS)
      if (this.sessions.get(s.key) !== s || client !== s.client)
        return { ok: false, error: 'The tuner session was replaced' }
      if (!r || r.status !== 'completed') {
        s.active = false
        return { ok: false, error: resultError(r, 'The tuner could not start') }
      }
      s.active = true
      const state = r.state as TunerState | undefined
      if (s.camera) client.notify('tuner/camera', { session: s.session, ...s.camera })
      if (s.watch || s.watchIds.length) client.notify('tuner/watch', { session: s.session, id: s.watch ?? '', ids: s.watchIds })
      if (this.hiddenNow(s)) client.notify('tuner/visibility', { session: s.session, hidden: true })
      if (s.tree) client.notify('tuner/tree', { session: s.session, ...s.tree })
      if (s.theme) client.notify('tuner/theme', { session: s.session, ...s.theme })
      if (s.settings) client.notify('tuner/sceneSettings', { session: s.session, ...tunerSceneSettingsArgs(s.settings) })
      if (s.sceneSelection) client.notify('tuner/sceneSelection', { session: s.session, ...s.sceneSelection })
      if (!state) return { ok: false, error: 'The Unity editor returned no tuner state' }
      this.emitState(s, state)
      return { ok: true, data: state }
    } finally {
      s.starting = false
    }
  }

  private tick(s: Session): void {
    if (this.sessions.get(s.key) !== s) return
    const ctl = unityProvider.primaryControl(s.projectKey)
    if (!ctl || !ctl.alive) {
      console.log(`[tuner] editor gone, ending session=${s.session} project=${s.projectKey}`)
      this.send(s, 'tuner:ended', { projectPath: s.projectPath, session: s.session, reason: 'editor-exited' })
      void this.dispose(s, false)
      return
    }
    if (ctl.port !== s.port) {
      debugLog(`[tuner] control port changed ${s.port} -> ${ctl.port} session=${s.session}`)
      this.attachClient(s, ctl.port)
      this.emitDown(s)
      return
    }
    const connected = s.client.isConnected
    if (connected !== s.wasConnected) {
      s.wasConnected = connected
      if (!connected) {
        s.active = false
        console.log(`[tuner] control socket down session=${s.session} project=${s.projectKey}`)
        this.emitDown(s)
        return
      }
      if (s.starting) return
      console.log(`[tuner] control socket up, restarting session=${s.session} project=${s.projectKey}`)
      void this.sendStart(s)
      return
    }
    if (connected && !s.active && !s.starting && Date.now() - s.lastStartAt >= RETRY_START_MS) void this.sendStart(s)
  }

  private async waitConnected(client: UnityControlClient, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (!client.isConnected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    return client.isConnected
  }

  async start(
    wcId: number,
    projectPath: string,
    session: string,
    viewName: string,
    restore?: unknown
  ): Promise<TunerResult<TunerState>> {
    if (typeof session !== 'string' || !SESSION_RE.test(session)) return { ok: false, error: 'Invalid session id' }
    const view = assetTunerView(viewName) ?? readTunerView(projectPath, viewName)
    if (!view) return { ok: false, error: `Tuner view '${viewName}' was not found` }
    if (!tunerViewHasObjects(view)) return { ok: false, error: `Tuner view '${viewName}' has no objects` }
    const ctl = unityProvider.primaryControl(projectPath)
    if (!ctl || !ctl.alive)
      return { ok: false, error: editorNotRunningError(projectPath) }
    if (unityProvider.isEditorRevealed(projectPath)) return { ok: false, error: EDITOR_REVEALED_ERROR }
    if (unityProvider.activeUnityMode(projectPath) === 'headless-graphics') return { ok: false, error: HEADLESS_GRAPHICS_ERROR }
    const key = this.keyFor(ctl.projectKey, session)
    let s = this.sessions.get(key)
    while (s && (s.wcId !== wcId || s.port !== ctl.port)) {
      await this.dispose(s, s.port === ctl.port)
      s = this.sessions.get(key)
    }
    if (s) {
      s.view = view
      s.projectPath = projectPath
    } else {
      const client = new UnityControlClient(ctl.port)
      const created: Session = {
        key,
        projectKey: ctl.projectKey,
        projectPath,
        session,
        view,
        wcId,
        port: ctl.port,
        client,
        offEvent: () => {},
        poll: setInterval(() => this.tick(created), POLL_MS),
        wasConnected: false,
        active: false,
        starting: false,
        lastStartAt: Date.now(),
        camera: null,
        watch: null,
        watchIds: [],
        tree: null,
        trees: new Map(),
        hidden: false,
        sceneSelection: null,
        theme: null,
        settings: null,
        lastState: null,
        merged: null,
        restore: null,
        target: null,
        frameRetry: null,
        frameTrouble: false
      }
      created.offEvent = client.onEvent((e) => this.onEvent(created, e))
      this.sessions.set(key, created)
      s = created
    }
    s.restore = cleanTunerRestore(restore) ?? s.restore
    const picked = view.ui ? `ui:${view.ui.path}` : view.kind === 'scene' ? `scene:${view.scene ?? '*'}` : view.objects.length
    console.log(
      `[tuner] start session=${session} view=${view.name} kind=${view.kind} objects=${picked} states=${view.states?.length ?? 0} ` +
        `restore=${s.restore?.overrides.length ?? 0} port=${s.port}`
    )
    s.starting = true
    const connected = await this.waitConnected(s.client, CONNECT_WAIT_MS)
    s.starting = false
    s.lastStartAt = Date.now()
    if (this.sessions.get(key) !== s) return { ok: false, error: 'The tuner session was replaced' }
    if (!connected)
      return { ok: false, error: 'The Unity editor control socket is not reachable yet. It may be reloading.' }
    s.wasConnected = true
    return this.sendStart(s)
  }

  attached(projectPath: string, session: string): TunerResult<TunerState> {
    const s = this.find(projectPath, session)
    if (s?.merged) return { ok: true, data: s.merged }
    const ctl = unityProvider.primaryControl(projectPath)
    if (!ctl || !ctl.alive) return { ok: false, error: editorNotRunningError(projectPath) }
    if (unityProvider.isEditorRevealed(projectPath)) return { ok: false, error: EDITOR_REVEALED_ERROR }
    if (unityProvider.activeUnityMode(projectPath) === 'headless-graphics') return { ok: false, error: HEADLESS_GRAPHICS_ERROR }
    return { ok: false, error: 'This Tuner is not open on the desktop yet' }
  }

  async stop(projectPath: string, session: string, wcId?: number): Promise<void> {
    const s = this.find(projectPath, session)
    if (s && (wcId == null || s.wcId === wcId)) await this.dispose(s, true)
  }

  startedState(projectPath: string, viewName: string, since: number): TunerState | null {
    const want = resolve(projectPath)
    for (const s of this.sessions.values())
      if (s.view.name === viewName && resolve(s.projectPath) === want && s.active && !s.starting && s.lastStartAt >= since && s.lastState)
        return s.lastState
    return null
  }

  stopAllFor(wcId: number): void {
    for (const s of [...this.sessions.values()]) if (s.wcId === wcId) void this.dispose(s, true)
  }

  private async dispose(s: Session, tellEngine: boolean): Promise<void> {
    if (this.sessions.get(s.key) !== s) return
    this.sessions.delete(s.key)
    clearInterval(s.poll)
    if (s.frameRetry) clearTimeout(s.frameRetry)
    s.offEvent()
    endTunerSurface(s.key, true)
    console.log(`[tuner] stop session=${s.session} project=${s.projectKey}`)
    const client = s.client
    try {
      if (tellEngine && client.isConnected) await client.command('tuner/stop', { session: s.session }, STOP_TIMEOUT_MS)
    } finally {
      client.close()
    }
  }

  async refresh(projectPath: string, session: string): Promise<TunerResult<TunerState>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The tuner session is not running' }
    if (!s.active) return this.sendStart(s)
    const r = await s.client.command('tuner/refresh', { session: s.session }, START_TIMEOUT_MS)
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, 'refresh failed') }
    const state = r.state as TunerState | undefined
    if (!state) return { ok: false, error: 'The Unity editor returned no tuner state' }
    this.emitState(s, state)
    return { ok: true, data: state }
  }

  camera(projectPath: string, session: string, camera: TunerCamera): void {
    const s = this.find(projectPath, session)
    if (!s) return
    const args = cameraArgs(camera)
    if (!args) return
    s.camera = args
    if (s.active) s.client.notify('tuner/camera', { session: s.session, ...args })
  }

  async edit(projectPath: string, session: string, edit: TunerEdit): Promise<TunerResult<TunerObject>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The tuner session is not running' }
    if (!edit || typeof edit.id !== 'string' || !ID_RE.test(edit.id)) return { ok: false, error: 'Invalid object id' }
    if (typeof edit.component !== 'string' || !COMPONENT_RE.test(edit.component))
      return { ok: false, error: 'Invalid component key' }
    if (typeof edit.field !== 'string' || !PROP_RE.test(edit.field)) return { ok: false, error: 'Invalid field path' }
    if (edit.op !== 'set' && edit.op !== 'arrayInsert' && edit.op !== 'arrayDelete')
      return { ok: false, error: 'Invalid edit op' }
    if (!s.active) return { ok: false, error: 'The tuner is not running. Enter play mode first.' }
    const r = await s.client.command(
      'tuner/edit',
      {
        session: s.session,
        id: edit.id,
        component: edit.component,
        prop: edit.field,
        op: edit.op,
        value: typeof edit.value === 'string' ? edit.value : '',
        index: typeof edit.index === 'number' ? edit.index : -1
      },
      EDIT_TIMEOUT_MS
    )
    const object = r?.object as TunerObject | undefined
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, 'edit failed'), data: object }
    return object ? { ok: true, data: object } : { ok: false, error: 'The Unity editor returned no object' }
  }

  private async stateCommand(
    projectPath: string,
    session: string,
    cmd: string,
    args: Record<string, unknown>,
    fallback: string
  ): Promise<TunerResult<TunerState>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The tuner session is not running' }
    if (!s.active) return { ok: false, error: 'The tuner is not running. Enter play mode first.' }
    const r = await s.client.command(cmd, { session: s.session, ...args }, START_TIMEOUT_MS)
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, fallback) }
    const state = r.state as TunerState | undefined
    if (!state) return { ok: false, error: 'The Unity editor returned no tuner state' }
    this.emitState(s, state)
    return { ok: true, data: state }
  }

  select(projectPath: string, session: string, state: string): Promise<TunerResult<TunerState>> {
    if (typeof state !== 'string' || !STATE_RE.test(state)) return Promise.resolve({ ok: false, error: 'Invalid state name' })
    debugLog(`[tuner] select session=${session} state=${state}`)
    return this.stateCommand(projectPath, session, 'tuner/select', { state }, 'selecting the state failed')
  }

  reset(projectPath: string, session: string, reset: TunerReset): Promise<TunerResult<TunerState>> {
    const args: Record<string, unknown> = {}
    const r = reset && typeof reset === 'object' ? reset : {}
    if (r.state != null) {
      if (typeof r.state !== 'string' || (r.state !== '*' && !STATE_RE.test(r.state)))
        return Promise.resolve({ ok: false, error: 'Invalid state name' })
      args.state = r.state
    }
    if (r.id != null) {
      if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return Promise.resolve({ ok: false, error: 'Invalid object id' })
      args.id = r.id
    }
    if (r.component != null) {
      if (typeof r.component !== 'string' || !COMPONENT_RE.test(r.component))
        return Promise.resolve({ ok: false, error: 'Invalid component key' })
      args.component = r.component
    }
    if (r.field != null) {
      if (typeof r.field !== 'string' || !PROP_RE.test(r.field)) return Promise.resolve({ ok: false, error: 'Invalid field path' })
      args.field = r.field
    }
    debugLog(`[tuner] reset session=${session} ${JSON.stringify(args)}`)
    return this.stateCommand(projectPath, session, 'tuner/reset', args, 'reset failed')
  }

  async saveOrDiscard(projectPath: string, session: string, save: boolean, stopPlay: boolean): Promise<TunerResult<TunerSaveResult>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The Tuner session is not running' }
    if (!s.active) return { ok: false, error: 'The Tuner is not connected to the Unity editor yet' }
    console.log(`[tuner] ${save ? 'save' : 'discard'} session=${s.session}${stopPlay ? ' (leaving Play Mode first)' : ''}`)
    const r = await s.client.command(
      save ? 'tuner/save' : 'tuner/discard',
      { session: s.session, ...(stopPlay ? { op: 'stopPlay' } : {}) },
      SAVE_TIMEOUT_MS
    )
    const unsaved = parseTunerUnsaved((r as { unsaved?: unknown } | null)?.unsaved)
    if (s.lastState) this.emitState(s, { ...s.lastState, unsaved })
    if (!r || r.status !== 'completed')
      return { ok: false, error: resultError(r, save ? 'Saving failed' : 'Discarding the changes failed'), data: { unsaved } }
    const summary = typeof r.summary === 'string' ? r.summary : undefined
    return { ok: true, data: summary ? { summary, unsaved } : { unsaved } }
  }

  discardScene(projectPath: string): Promise<TunerResult<TunerSaveResult>> {
    return this.sessionlessSave(projectPath, false)
  }

  saveScene(projectPath: string): Promise<TunerResult<TunerSaveResult>> {
    return this.sessionlessSave(projectPath, true)
  }

  async newScene(projectPath: string, path: string): Promise<TunerResult<null>> {
    if (typeof path !== 'string' || !/^Assets\/[^\r\n]*\.unity$/.test(path) || path.includes('..') || path.length > 512)
      return { ok: false, error: 'Invalid scene path' }
    const ctl = unityProvider.primaryControl(projectPath)
    if (!ctl || !ctl.alive) return { ok: false, error: editorNotRunningError(projectPath) }
    const client = new UnityControlClient(ctl.port)
    try {
      if (!(await this.waitConnected(client, CONNECT_WAIT_MS)))
        return { ok: false, error: 'The Unity editor control socket is not reachable yet. It may be reloading.' }
      console.log(`[tuner] new scene ${path} project=${ctl.projectKey}`)
      const r = await client.command('tuner/newScene', { session: DISCARD_SESSION, path }, SAVE_TIMEOUT_MS)
      if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, 'Creating the scene failed') }
      return { ok: true, data: null }
    } finally {
      client.close()
    }
  }

  private async sessionlessSave(projectPath: string, save: boolean): Promise<TunerResult<TunerSaveResult>> {
    const ctl = unityProvider.primaryControl(projectPath)
    if (!ctl || !ctl.alive) return { ok: false, error: editorNotRunningError(projectPath) }
    if (unityProvider.isEditorRevealed(projectPath)) return { ok: false, error: EDITOR_REVEALED_ERROR }
    const client = new UnityControlClient(ctl.port)
    try {
      if (!(await this.waitConnected(client, CONNECT_WAIT_MS)))
        return { ok: false, error: 'The Unity editor control socket is not reachable yet. It may be reloading.' }
      console.log(`[tuner] ${save ? 'save' : 'discard'} scene changes project=${ctl.projectKey}`)
      const r = await client.command(save ? 'tuner/save' : 'tuner/discard', { session: DISCARD_SESSION }, SAVE_TIMEOUT_MS)
      const unsaved = parseTunerUnsaved((r as { unsaved?: unknown } | null)?.unsaved)
      for (const s of this.sessions.values()) if (s.projectKey === ctl.projectKey && s.lastState) this.emitState(s, { ...s.lastState, unsaved })
      if (!r || r.status !== 'completed')
        return { ok: false, error: resultError(r, save ? 'Saving failed' : 'Discarding the changes failed'), data: { unsaved } }
      const summary = typeof r.summary === 'string' ? r.summary : undefined
      return { ok: true, data: summary ? { summary, unsaved } : { unsaved } }
    } finally {
      client.close()
    }
  }

  watch(projectPath: string, session: string, id: string | null, ids?: string[]): void {
    const s = this.find(projectPath, session)
    if (!s) return
    const next = typeof id === 'string' && ID_RE.test(id) ? id : null
    s.watch = next
    s.watchIds = cleanIds(ids)
    if (s.active) s.client.notify('tuner/watch', { session: s.session, id: next ?? '', ids: s.watchIds })
  }

  tree(projectPath: string, session: string, req: TunerTreeRequest, viewer = 'mac'): void {
    const s = this.find(projectPath, session)
    if (!s) return
    const ask: TreeAsk = { ids: cleanIds(req?.open, MAX_TREE_OPEN), at: ++treeSeq }
    if (typeof req?.query === 'string' && req.query.trim() && req.query.length <= 256) ask.query = req.query
    if (typeof req?.path === 'string' && req.path.length > 0 && req.path.length <= 2048) {
      ask.path = req.path
      if (typeof req.scene === 'string' && req.scene.length <= 512) ask.scene = req.scene
    }
    s.trees.set(viewer, ask)
    this.sendTree(s)
  }

  private dropTree(s: Session, viewer: string): void {
    if (s.trees.delete(viewer)) this.sendTree(s)
  }

  private sendTree(s: Session): void {
    const ids: string[] = []
    const seen = new Set<string>()
    let query: TreeAsk | null = null
    let reveal: TreeAsk | null = null
    for (const a of s.trees.values()) {
      for (const id of a.ids) {
        if (ids.length >= MAX_TREE_OPEN || seen.has(id)) continue
        seen.add(id)
        ids.push(id)
      }
      if (a.query && (!query || a.at > query.at)) query = a
      if (a.path && (!reveal || a.at > reveal.at)) reveal = a
    }
    const next: Record<string, unknown> = { ids }
    if (query) next.query = query.query
    if (reveal) {
      next.path = reveal.path
      if (reveal.scene !== undefined) next.scene = reveal.scene
    }
    if (s.trees.size > 1) debugLog(`[tuner] tree for ${s.trees.size} viewers: ${ids.length} open rows session=${s.session}`)
    s.tree = next
    if (s.active) s.client.notify('tuner/tree', { session: s.session, ...next })
  }

  async pickRect(projectPath: string, session: string, req: TunerPickRectRequest): Promise<TunerResult<TunerPickRectResult>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The Tuner session is not running' }
    if (!s.active) return { ok: false, error: 'The Tuner is not running yet' }
    const r0 = req ?? ({} as TunerPickRectRequest)
    const pts = [r0.x0, r0.y0, r0.x1, r0.y1]
    if (!pts.every((v) => isNum(v) && v >= 0 && v <= 1)) return { ok: false, error: 'Invalid pick rect' }
    const args: Record<string, unknown> = { session: s.session, x: r0.x0, y: r0.y0, x1: r0.x1, y1: r0.y1 }
    const cam = r0.camera ? cameraArgs(r0.camera) : null
    if (cam) Object.assign(args, cam)
    const r = await s.client.command('tuner/pickRect', args, PICK_TIMEOUT_MS)
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, 'picking failed') }
    const ids = Array.isArray(r.ids) ? (r.ids as unknown[]).filter((x): x is string => typeof x === 'string' && ID_RE.test(x)) : []
    return { ok: true, data: { ids } }
  }

  async close(projectPath: string, session: string, id: string): Promise<TunerResult<TunerState>> {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'Invalid object id' }
    debugLog(`[tuner] close ${id} session=${session}`)
    return this.stateCommand(projectPath, session, 'tuner/close', { id }, 'closing it failed')
  }

  async clearView(projectPath: string, session: string, req: TunerClearViewRequest): Promise<TunerResult<{ index: number }>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The Tuner session is not running' }
    if (!s.active) return { ok: false, error: 'The Tuner is not running yet' }
    if (!req || typeof req.id !== 'string' || !ID_RE.test(req.id) || !Array.isArray(req.cams)) return { ok: false, error: 'Invalid clear view request' }
    const cams: number[] = []
    for (const c of req.cams.slice(0, 24)) {
      const p = vec(c?.position, 3)
      const q = vec(c?.rotation, 4)
      if (!p || !q) return { ok: false, error: 'Invalid camera' }
      const clip = Array.isArray(c.clip) && c.clip.length === 2 && isNum(c.clip[0]) && isNum(c.clip[1]) ? c.clip : [0, 0]
      cams.push(...p, ...q, clip[0], clip[1])
    }
    const args = { session: s.session, id: req.id, x: isNum(req.x) ? req.x : 0.5, y: isNum(req.y) ? req.y : 0.5, width: Math.round(req.width) || 0, height: Math.round(req.height) || 0, fov: isNum(req.fov) ? req.fov : 0, cams }
    const r = await s.client.command('tuner/clearView', args, PICK_TIMEOUT_MS)
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, 'the view check failed') }
    return { ok: true, data: { index: typeof r.index === 'number' ? r.index : -1 } }
  }

  async pick(projectPath: string, session: string, req: TunerPickRequest): Promise<TunerResult<TunerPickResult>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The Tuner session is not running' }
    if (!s.active) return { ok: false, error: 'The Tuner is not running yet' }
    const x = req?.x
    const y = req?.y
    if (!isNum(x) || !isNum(y) || x < 0 || x > 1 || y < 0 || y > 1) return { ok: false, error: 'Invalid pick point' }
    const args: Record<string, unknown> = { session: s.session, x, y }
    const cam = req.camera ? cameraArgs(req.camera) : null
    if (cam) Object.assign(args, cam)
    const r = await s.client.command('tuner/pick', args, PICK_TIMEOUT_MS)
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, 'picking failed') }
    return { ok: true, data: parsePickResult(r as { hits?: unknown; icons?: unknown }) }
  }

  async canvases(projectPath: string): Promise<TunerResult<TunerCanvas[]>> {
    const ctl = unityProvider.primaryControl(projectPath)
    if (!ctl || !ctl.alive) return { ok: false, error: editorNotRunningError(projectPath) }
    const client = new UnityControlClient(ctl.port)
    try {
      if (!(await this.waitConnected(client, CONNECT_WAIT_MS)))
        return { ok: false, error: 'The Unity editor control socket is not reachable yet. It may be reloading.' }
      const r = await client.command('tuner/canvases', { session: CANVASES_SESSION }, PICK_TIMEOUT_MS)
      if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, 'listing the canvases failed') }
      return { ok: true, data: parseTunerCanvases(r.canvases) }
    } finally {
      client.close()
    }
  }

  async particles(projectPath: string, session: string, op: TunerParticlesOp, speed?: number): Promise<TunerResult<null>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The Tuner session is not running' }
    if (!s.active) return { ok: false, error: 'The Tuner is not running yet' }
    if (!PARTICLE_OPS.includes(op)) return { ok: false, error: 'Invalid particles action' }
    const args: Record<string, unknown> = { session: s.session, op }
    if (op === 'speed') {
      if (!isNum(speed) || speed < 0 || speed > 100) return { ok: false, error: 'Invalid playback speed' }
      args.value = String(speed)
    }
    const r = await s.client.command('tuner/particles', args, PICK_TIMEOUT_MS)
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, 'the particles command failed') }
    return { ok: true, data: null }
  }

  async hierarchy(projectPath: string, session: string, req: TunerHierarchyRequest): Promise<TunerResult<TunerHierarchyResult>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The Tuner session is not running' }
    if (!s.active) return { ok: false, error: 'The Tuner is not running yet' }
    const r0 = req && typeof req === 'object' ? req : ({} as TunerHierarchyRequest)
    if (!HIERARCHY_OPS.includes(r0.op)) return { ok: false, error: 'Invalid hierarchy action' }
    const ids = cleanIds(r0.ids)
    if (r0.op !== 'create' && ids.length === 0) return { ok: false, error: 'Nothing is selected' }
    const args: Record<string, unknown> = { session: s.session, op: r0.op, ids }
    if (r0.parent != null) {
      if (!hierarchyRef(r0.parent)) return { ok: false, error: 'Invalid parent' }
      args.parent = r0.parent
    }
    if (r0.scene != null) {
      if (!hierarchyRef(r0.scene)) return { ok: false, error: 'Invalid scene' }
      args.scene = r0.scene
    }
    if (r0.before != null) {
      if (typeof r0.before !== 'string' || (r0.before !== '' && !ID_RE.test(r0.before))) return { ok: false, error: 'Invalid sibling' }
      args.before = r0.before
    }
    if (r0.after != null) {
      if (typeof r0.after !== 'string' || !ID_RE.test(r0.after)) return { ok: false, error: 'Invalid sibling' }
      args.after = r0.after
    }
    if (r0.op === 'move' && r0.order === true) args.kind = 'order'
    if (r0.op === 'create') {
      if (r0.primitive != null && !TUNER_PRIMITIVES.includes(r0.primitive)) return { ok: false, error: 'Invalid object kind' }
      args.kind = r0.primitive ?? 'empty'
      if (r0.asset != null) {
        if (typeof r0.asset !== 'string' || !/^(Assets|Packages)\//.test(r0.asset) || r0.asset.length > 1024 || /[\r\n]/.test(r0.asset))
          return { ok: false, error: 'Invalid asset' }
        args.asset = r0.asset
      }
    }
    if (r0.op === 'rename') {
      const name = typeof r0.name === 'string' ? r0.name.trim() : ''
      if (!name || name.length > 256 || /[\r\n]/.test(name)) return { ok: false, error: 'Invalid name' }
      args.name = name
    }
    debugLog(`[tuner] hierarchy ${r0.op} session=${s.session} ids=${ids.length}`)
    const r = await s.client.command('tuner/hierarchy', args, EDIT_TIMEOUT_MS)
    const state = (r?.state as TunerState | undefined) ?? null
    if (state) this.emitState(s, state)
    const data: TunerHierarchyResult = {
      ids: cleanIds(r?.ids),
      add: parseHierarchyAdded(r?.add),
      state
    }
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, 'the hierarchy change failed'), data }
    return { ok: true, data }
  }

  async canvasView(projectPath: string, session: string, canvas: string, scene: string): Promise<TunerResult<TunerState | null>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The Tuner session is not running' }
    if (!s.active) return { ok: false, error: 'The Tuner is not running yet' }
    if (typeof canvas !== 'string' || canvas.length > 2048 || /[\r\n]/.test(canvas)) return { ok: false, error: 'Invalid canvas' }
    if (typeof scene !== 'string' || scene.length > 1024 || /[\r\n]/.test(scene)) return { ok: false, error: 'Invalid scene' }
    debugLog(`[tuner] canvas view session=${s.session} ${canvas || 'Scene'}`)
    const r = await s.client.command('tuner/canvasView', { session: s.session, canvas, scene }, EDIT_TIMEOUT_MS)
    const state = (r?.state as TunerState | undefined) ?? null
    if (state) this.emitState(s, state)
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, 'the canvas view did not change') }
    return { ok: true, data: state }
  }

  async animator(projectPath: string, session: string, req: TunerAnimatorRequest): Promise<TunerResult<TunerAnimatorResult | null>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The Tuner session is not running' }
    if (!s.active) return { ok: false, error: 'The Tuner is not running yet' }
    const args = cleanTunerAnimatorRequest(req)
    if (!args) return { ok: false, error: 'Invalid animator request' }
    const r = await s.client.command('tuner/animator', { session: s.session, ...args }, EDIT_TIMEOUT_MS)
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, 'the animator command failed') }
    const o = r as { time?: unknown; rev?: unknown; data?: unknown }
    return { ok: true, data: { time: isNum(o.time) ? o.time : 0, ...(isNum(o.rev) ? { rev: o.rev } : {}), ...(o.data !== undefined ? { data: o.data } : {}) } }
  }

  async staging(projectPath: string, session: string, req: TunerStagingRequest): Promise<TunerResult<unknown>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The Tuner session is not running' }
    if (!s.active) return { ok: false, error: 'The Tuner is not running yet' }
    const args = cleanTunerStagingRequest(req)
    if (!args) return { ok: false, error: 'Invalid staging request' }
    const r = await s.client.command('tuner/staging', { session: s.session, ...args }, EDIT_TIMEOUT_MS)
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, 'the staging command failed') }
    const data = (r as { data?: unknown }).data
    return { ok: true, data: data ?? null }
  }

  async sceneStats(projectPath: string, reset: boolean): Promise<{ session: string; view: string; stats?: TunerSceneStats; error?: string }[]> {
    const ctl = unityProvider.primaryControl(projectPath)
    const key = ctl?.projectKey ?? projectPath
    const out: { session: string; view: string; stats?: TunerSceneStats; error?: string }[] = []
    for (const s of this.sessions.values()) {
      if (s.projectKey !== key || !s.active) continue
      const r = await s.client.command('tuner/sceneStats', { session: s.session, reset }, PICK_TIMEOUT_MS)
      const stats = r?.stats as TunerSceneStats | undefined
      out.push(
        r && r.status === 'completed' && stats
          ? { session: s.session, view: s.view.name, stats }
          : { session: s.session, view: s.view.name, error: resultError(r, 'reading the frame cost failed') }
      )
    }
    return out
  }

  async annotations(projectPath: string, session: string, req: TunerAnnotationsRequest): Promise<TunerResult<TunerAnnotations>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The Tuner session is not running' }
    if (!s.active) return { ok: false, error: 'The Tuner is not running yet' }
    const args = cleanTunerAnnotationsRequest(req)
    if (!args) return { ok: false, error: 'Invalid gizmo settings request' }
    const r = await s.client.command('tuner/annotations', { session: s.session, ...args }, EDIT_TIMEOUT_MS)
    const data = parseTunerAnnotations((r as { annotations?: unknown } | null)?.annotations)
    if (!r || r.status !== 'completed' || !data) return { ok: false, error: resultError(r, 'reading the gizmo settings failed') }
    return { ok: true, data }
  }

  async rect(projectPath: string, session: string, req: TunerRectRequest): Promise<TunerResult<TunerRectInfo | null>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The Tuner session is not running' }
    if (!s.active) return { ok: false, error: 'The Tuner is not running yet' }
    const args = cleanTunerRectRequest(req)
    if (!args) return { ok: false, error: 'Invalid rect edit' }
    const undo = args.op === 'undo' || args.op === 'redo'
    const r = await s.client.command(undo ? 'tuner/undo' : 'tuner/rect', { session: s.session, ...args }, EDIT_TIMEOUT_MS)
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, undo ? 'undo failed' : 'the rect edit failed') }
    return { ok: true, data: undo ? null : parseTunerRectInfo((r as { rect?: unknown }).rect) }
  }

  async rects(projectPath: string, session: string, req: TunerRectsRequest): Promise<TunerResult<TunerRectInfo[]>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The Tuner session is not running' }
    if (!s.active) return { ok: false, error: 'The Tuner is not running yet' }
    const args = cleanTunerRectsRequest(req)
    if (!args) return { ok: false, error: 'Invalid rect edit' }
    const r = await s.client.command('tuner/rect', { session: s.session, ...args }, EDIT_TIMEOUT_MS)
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, args.op === 'getMany' ? 'reading the rects failed' : 'the rect edit failed') }
    return { ok: true, data: parseTunerRectInfos((r as { rects?: unknown }).rects) }
  }

  async handles(projectPath: string, session: string, req: TunerHandlesRequest): Promise<TunerResult<TunerHandlesState>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The Tuner session is not running' }
    if (!s.active) return { ok: false, error: 'The Tuner is not running yet' }
    const args = cleanTunerHandlesRequest(req)
    if (!args) return { ok: false, error: 'Invalid handles request' }
    const r = await s.client.command('tuner/handles', { session: s.session, ...args }, EDIT_TIMEOUT_MS)
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, 'the scene handles request failed') }
    return { ok: true, data: parseTunerHandlesState((r as { handles?: unknown }).handles) }
  }

  sceneSelection(projectPath: string, session: string, sel: TunerSceneSelection | null): void {
    const s = this.find(projectPath, session)
    if (!s) return
    const next: Record<string, unknown> = {}
    if (sel && typeof sel.id === 'string' && ID_RE.test(sel.id)) next.id = sel.id
    else if (sel && typeof sel.path === 'string' && sel.path.length > 0 && sel.path.length <= 2048) {
      next.path = sel.path
      if (typeof sel.scene === 'string' && sel.scene.length <= 512) next.scene = sel.scene
    }
    const ids = cleanIds(sel?.ids)
    const ghosts = cleanIds(sel?.ghosts)
    if (ids.length) next.ids = ids
    if (ghosts.length) next.ghosts = ghosts
    if (sel?.focusOn === true) {
      next.focusOn = true
      next.focus = cleanIds(sel.focus, MAX_FOCUS_IDS)
      if (sel.focusTree === true) next.focusTree = true
    }
    if (sel?.context === true) next.context = true
    s.sceneSelection = next
    if (s.active) s.client.notify('tuner/sceneSelection', { session: s.session, ...next })
  }

  theme(projectPath: string, session: string, theme: TunerTheme): void {
    const s = this.find(projectPath, session)
    if (!s || !isTunerTheme(theme)) return
    const next = { clear: theme.clear, grid: theme.grid, outline: theme.outline, outlineChild: theme.outlineChild }
    if (JSON.stringify(next) === JSON.stringify(s.theme)) return
    s.theme = next
    if (s.active) s.client.notify('tuner/theme', { session: s.session, ...next })
  }

  sceneSettings(projectPath: string, session: string, settings: TunerSceneSettings): void {
    const s = this.find(projectPath, session)
    if (!s || !isTunerSceneSettings(settings)) return
    const next: TunerSceneSettings = settings.effects ? { gizmos: settings.gizmos, effects: { ...settings.effects } } : { gizmos: settings.gizmos }
    if (settings.lighting !== undefined) next.lighting = settings.lighting
    if (settings.grid !== undefined) next.grid = settings.grid
    if (s.settings && JSON.stringify(s.settings) === JSON.stringify(next)) return
    s.settings = next
    if (s.active) s.client.notify('tuner/sceneSettings', { session: s.session, ...tunerSceneSettingsArgs(next) })
  }

  private hiddenNow(s: Session): boolean {
    return s.hidden && !this.remoteViewers.get(s.session)?.size
  }

  visibility(projectPath: string, session: string, visible: boolean, viewer?: string): void {
    const s = this.find(projectPath, session)
    const was = s ? this.hiddenNow(s) : false
    if (viewer) {
      const set = this.remoteViewers.get(session) ?? new Set<string>()
      if (visible === set.has(viewer)) return
      if (visible) set.add(viewer)
      else set.delete(viewer)
      if (set.size) this.remoteViewers.set(session, set)
      else this.remoteViewers.delete(session)
      debugLog(`[tuner] ${viewer} ${visible ? 'views' : 'left'} session=${session} (${set.size} remote viewer${set.size === 1 ? '' : 's'})`)
    } else if (s) s.hidden = !visible
    if (!s) return
    const now = this.hiddenNow(s)
    if (now === was) return
    debugLog(`[tuner] ${now ? 'hidden' : 'shown'} session=${s.session}${!now && s.hidden ? ' (hidden on the Mac, open on the phone)' : ''}`)
    if (s.active) s.client.notify('tuner/visibility', { session: s.session, hidden: now })
  }

  dropViewer(viewer: string): void {
    for (const s of this.sessions.values()) this.dropTree(s, viewer)
    for (const [session, set] of [...this.remoteViewers]) {
      if (!set.has(viewer)) continue
      const s = [...this.sessions.values()].find((x) => x.session === session)
      if (s) this.visibility(s.projectPath, session, false, viewer)
      else {
        set.delete(viewer)
        if (!set.size) this.remoteViewers.delete(session)
      }
    }
  }

  transform(projectPath: string, session: string, t: TunerTransform): void {
    const s = this.find(projectPath, session)
    if (!s || !s.active || !t || typeof t.id !== 'string' || !ID_RE.test(t.id)) return
    if (Array.isArray(t.items)) {
      const items: Record<string, unknown>[] = []
      for (const it of t.items.slice(0, MAX_TRANSFORM_ITEMS)) {
        if (!it || typeof it.id !== 'string' || !ID_RE.test(it.id)) continue
        const one: Record<string, unknown> = { id: it.id }
        const p = vec(it.position, 3)
        const q = vec(it.rotation, 4)
        const k = vec(it.localScale, 3)
        if (p) one.position = p
        if (q) one.rotation = q
        if (k) one.localScale = k
        if (p || q || k) items.push(one)
      }
      if (items.length === 0) return
      const batch: Record<string, unknown> = { session: s.session, id: t.id, items }
      if (t.final === true) batch.final = true
      if (typeof t.seq === 'number' && Number.isInteger(t.seq) && t.seq > 0) batch.seq = t.seq
      s.client.notify('tuner/transform', batch)
      return
    }
    const args: Record<string, unknown> = { session: s.session, id: t.id }
    const position = vec(t.position, 3)
    const rotation = vec(t.rotation, 4)
    const localScale = vec(t.localScale, 3)
    if (position) args.position = position
    if (rotation) args.rotation = rotation
    if (localScale) args.localScale = localScale
    if (!position && !rotation && !localScale) return
    if (typeof t.fov === 'number' && t.fov > 1 && t.fov < 179) args.fov = t.fov
    if (t.final === true) args.final = true
    if (typeof t.seq === 'number' && Number.isInteger(t.seq) && t.seq > 0) args.seq = t.seq
    s.client.notify('tuner/transform', args)
  }

  async open(projectPath: string, session: string, target: TunerEntryTarget, ghost?: boolean): Promise<TunerResult<TunerOpened>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The tuner session is not running' }
    const t = cleanTunerEntryTarget(target)
    if (!t) return { ok: false, error: 'Invalid object or asset' }
    if (!s.active) return { ok: false, error: 'The tuner is not connected to the Unity editor yet' }
    const wantGhost = ghost === true && t.kind === 'object'
    const r = await s.client.command(
      'tuner/open',
      { session: s.session, kind: t.kind, path: t.path, scene: t.kind === 'object' ? (t.scene ?? '') : '', ghost: wantGhost },
      EDIT_TIMEOUT_MS
    )
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, 'opening it failed') }
    const state = r.state as TunerState | undefined
    const id = typeof r.entry === 'string' ? r.entry : ''
    if (!state || !id) return { ok: false, error: 'The Unity editor returned no tuner state' }
    const created = r.created === true
    debugLog(`[tuner] open ${t.kind} ${t.path} as ${id}${wantGhost && created ? ' (ghost)' : ''} session=${s.session}`)
    this.emitState(s, state)
    return { ok: true, data: { id, created, state } }
  }

  async button(projectPath: string, session: string, index: number): Promise<TunerResult<TunerButtonResult>> {
    const s = this.find(projectPath, session)
    if (!s) return { ok: false, error: 'The tuner session is not running' }
    const b = Number.isInteger(index) ? s.view.buttons[index] : undefined
    if (!b) return { ok: false, error: 'This button is not in the view any more' }
    if (!s.active) return { ok: false, error: 'The tuner is not connected to the Unity editor yet' }
    debugLog(`[tuner] button "${b.label}" session=${s.session}`)
    const r = await s.client.command(
      'tuner/button',
      {
        session: s.session,
        label: b.label,
        method: b.method,
        type: b.type ?? '',
        path: b.path ?? '',
        scene: b.scene ?? '',
        component: b.component ?? '',
        asset: b.asset ?? ''
      },
      BUTTON_TIMEOUT_MS
    )
    const output = typeof r?.output === 'string' ? r.output : undefined
    if (!r || r.status !== 'completed') return { ok: false, error: resultError(r, 'the button failed'), data: { output } }
    return { ok: true, data: output != null ? { output } : {} }
  }
}

export const tunerService = new TunerService()
setTunerStateProbe((projectPath, view, since) => tunerService.startedState(projectPath, view, since))
