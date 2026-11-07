import type { PhoneDriftAnswer, PhoneDriftCue } from './drift-spot'
import type {
  TunerPickRectRequest,
  TunerPickRectResult,
  TunerPickRequest,
  TunerPickResult,
  TunerSceneSelection,
  TunerSceneSettings,
  TunerTheme
} from './tuner-sceneview'
import type { TunerRectInfo, TunerRectRequest, TunerRectsRequest } from './tuner-rect'
import type { TunerHandlesRequest, TunerHandlesState } from './tuner-handles'
import type { TunerAnimatorUpdate, TunerAnimatorRequest, TunerAnimatorResult, TunerAnimatorSpec } from './tuner-animator'
import type { TunerStaging, TunerStagingRequest } from './tuner-staging'
import type { TunerAnnotations, TunerAnnotationsRequest } from './tuner-annotations'

export type TunerResult<T> = { ok: true; data: T } | { ok: false; error: string; data?: T }

const VIEW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isTunerViewName(name: unknown): name is string {
  return typeof name === 'string' && VIEW_NAME_RE.test(name)
}

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]

export type TunerMode = '2d' | '3d'

export type TunerViewKind = 'ui' | 'objects' | 'scene' | 'prefabs'

export interface TunerComponentSpec {
  type: string
  index?: number
  fields?: string[]
  exclude?: string[]
}

export interface TunerObjectSpec {
  path: string
  scene?: string
  label?: string
  components?: TunerComponentSpec[]
  exclude?: string[]
  children?: boolean
}

export type TunerUiSpec = Omit<TunerObjectSpec, 'children'>

export interface TunerAssetSpec {
  path: string
  label?: string
  fields?: string[]
  exclude?: string[]
}

export interface TunerButtonSpec {
  label: string
  method: string
  type?: string
  path?: string
  scene?: string
  component?: string
  asset?: string
  tip?: string
  mode?: 'play' | 'edit'
  step?: string
}

export type TunerEntryTarget =
  | {
      kind: 'object'
      path: string
      scene?: string
      components?: TunerComponentSpec[]
      exclude?: string[]
      at?: number[]
      id?: string
      ghost?: boolean
    }
  | { kind: 'asset'; path: string; fields?: string[]; exclude?: string[] }

export interface TunerCameraSpec {
  position: Vec3
  lookAt: Vec3
}

export interface TunerAnimateStep {
  animate: {
    path: string
    scene?: string
    state?: string
    clip?: string
    layer?: number
    time?: number
    seconds?: number
  }
}

export interface TunerCallStep {
  call: {
    method: string
    type?: string
    path?: string
    scene?: string
    component?: string
  }
}

export interface TunerSetStep {
  set: {
    path: string
    scene?: string
    component: string
    field: string
    value: string
  }
}

export type TunerSetupStep = TunerAnimateStep | TunerCallStep | TunerSetStep

export interface TunerStateSpec {
  name: string
  label: string
  note: string
  objects: TunerObjectSpec[]
  camera?: TunerCameraSpec
  setup: TunerSetupStep[]
  pause?: boolean
}

export interface TunerView {
  name: string
  title: string
  note: string
  paneKey: string
  kind: TunerViewKind
  ui?: TunerUiSpec
  scene?: string
  prefabs?: string[]
  objects: TunerObjectSpec[]
  assets: TunerAssetSpec[]
  buttons: TunerButtonSpec[]
  states?: TunerStateSpec[]
  camera?: TunerCameraSpec
  mode?: TunerMode
  animator?: TunerAnimatorSpec
  updatedAt: number
}

export interface TunerComponent {
  key: string
  type: string
  error?: string
}

export interface TunerBounds {
  center: Vec3
  size: Vec3
  fog?: number
  fogClear?: number
  sun?: Vec3
}

export interface TunerObject {
  id: string
  path: string
  scene: string
  label: string
  ancestors: string[]
  active: boolean
  position: Vec3
  rotation: Quat
  localPosition: Vec3
  localRotation: Quat
  localScale: Vec3
  bounds: TunerBounds | null
  components: TunerComponent[]
  error?: string
  kind?: TunerEntryKind
  type?: string
  opened?: boolean
  ghost?: boolean
  inspect?: TunerEntryTarget
  at?: number[]
  prefab?: TunerPrefabMark
  pf?: number
}

export type TunerPrefabMark = 'root' | 'variant' | 'missing'

export const TUNER_PF_PART = 1
export const TUNER_PF_ADDED = 2
export const TUNER_PF_OVERRIDES = 4

export type TunerEntryKind = 'target' | 'opened' | 'asset' | 'member'

export interface TunerMember {
  id: string
  parent: string
  name: string
  index: number
  active: boolean
  dup?: boolean
  nth?: number
  env?: boolean
  runtime?: boolean
  icon?: string
  types?: string
  prefab?: TunerPrefabMark
  asset?: string
  pf?: number
  staging?: boolean
  kids?: number
  uid?: string
}

export interface TunerTreeRequest {
  open: string[]
  query?: string
  path?: string
  scene?: string
}

export interface TunerStateInfo {
  name: string
  label: string
  note: string
  changes: number
  pause?: boolean
  error?: string
}

export interface TunerOverride {
  state: string
  id: string
  path: string
  component: string
  field: string
  before: string
  after: string
  beforeRaw: string
  afterRaw: string
  runtime?: TunerRuntimeOrigin
}

export interface TunerRuntimeOrigin {
  prefab?: string
  child?: string
  copyOf?: string
}

export interface TunerState {
  session: string
  offline?: boolean
  playing: boolean
  graphics: boolean
  paused?: boolean
  planar?: boolean
  sceneBounds?: TunerBounds | null
  sceneNoRenderers?: boolean
  activeState?: string
  states?: TunerStateInfo[]
  objects: TunerObject[]
  entries?: TunerObject[]
  members?: TunerMember[]
  membersCapped?: number
  filterCount?: [number, number]
  membersLazy?: boolean
  revealMissing?: string
  canvasView?: string
  canvasViewScene?: string
  overlays?: TunerOverlayCanvas[]
  watchGone?: string[]
  overrides?: TunerOverride[]
  edits?: TunerEdit[]
  unsaved?: TunerUnsaved
  prefabs?: string[]
  prefabError?: string
}

export const TUNER_EDIT_STATE = '@edit'

export type TunerEditKind = 'field' | 'added' | 'duplicated' | 'deleted' | 'moved' | 'componentAdded' | 'componentRemoved'

export interface TunerEdit {
  kind?: TunerEditKind
  path: string
  component: string
  field: string
  before: string
  after: string
  saved?: boolean
  label?: string
  type?: string
  asset?: string
}

export interface TunerUnsavedAsset {
  path: string
  created?: boolean
}

export interface TunerUnsaved {
  scenes: string[]
  prefabs: string[]
  assets: TunerUnsavedAsset[]
  playing?: boolean
}

export const NO_UNSAVED: TunerUnsaved = { scenes: [], prefabs: [], assets: [] }

export interface TunerSaveResult {
  summary?: string
  unsaved: TunerUnsaved
}

function stringList(v: unknown, max = 256): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) if (typeof x === 'string' && x && out.length < max && !out.includes(x)) out.push(x)
  return out
}

export function parseTunerUnsaved(v: unknown): TunerUnsaved {
  if (!v || typeof v !== 'object') return NO_UNSAVED
  const o = v as Record<string, unknown>
  const assets: TunerUnsavedAsset[] = []
  for (const a of Array.isArray(o.assets) ? o.assets : []) {
    if (!a || typeof a !== 'object' || assets.length >= 256) continue
    const r = a as Record<string, unknown>
    if (typeof r.path !== 'string' || !r.path || assets.some((x) => x.path === r.path)) continue
    assets.push(r.created === true ? { path: r.path, created: true } : { path: r.path })
  }
  const out: TunerUnsaved = { scenes: stringList(o.scenes), prefabs: stringList(o.prefabs), assets }
  if (o.playing === true) out.playing = true
  return out
}

export function unsavedCount(u: TunerUnsaved | null | undefined): number {
  return u ? u.scenes.length + u.prefabs.length + u.assets.length : 0
}

export function unsavedKey(u: TunerUnsaved | null | undefined): string {
  if (!u) return ''
  return [...u.scenes, '|', ...u.prefabs, '|', ...u.assets.map((a) => `${a.path}${a.created ? '+' : ''}`), u.playing ? 'p' : ''].join('\n')
}

export interface TunerReset {
  state?: string
  id?: string
  component?: string
  field?: string
}

export interface TunerRestore {
  activeState?: string
  overrides: TunerOverride[]
  opened?: TunerEntryTarget[]
}

export interface TunerOpened {
  id: string
  created?: boolean
  state: TunerState
}

export interface TunerButtonResult {
  output?: string
}

export interface TunerCamera {
  position: Vec3
  rotation: Quat
  fov: number
  ortho?: number
  clip?: [number, number]
  width: number
  height: number
  points?: number
  cseq?: number
}

export interface TunerFrameMeta {
  session: string
  seq: number
  ack?: number
  xr?: number
  width: number
  height: number
  camera: TunerCamera
  poses?: TunerPose[]
  icons?: TunerSceneIcon[]
  lt?: number[]
}

export interface TunerClearViewRequest {
  id: string
  x: number
  y: number
  width: number
  height: number
  fov: number
  cams: TunerCamera[]
}

export interface TunerSceneIcon {
  id: string
  kind: string
  position: Vec3
}

export interface TunerFrameSurface {
  key: string
  surfaceId: number
  generation: number
  flipY: boolean
}

export interface TunerFrameEvent {
  projectPath: string
  meta: TunerFrameMeta
  surface: TunerFrameSurface
}

export interface TunerStateEvent {
  projectPath: string
  state: TunerState
}

export interface TunerEndedEvent {
  projectPath: string
  session: string
  reason: string
}

export interface TunerEdit {
  id: string
  component: string
  field: string
  op: 'set' | 'arrayInsert' | 'arrayDelete'
  value?: string
  index?: number
}

export interface TunerTransformItem {
  id: string
  position?: Vec3
  rotation?: Quat
  localScale?: Vec3
}

export interface TunerTransform {
  id: string
  position?: Vec3
  rotation?: Quat
  localScale?: Vec3
  fov?: number
  final?: boolean
  seq?: number
  items?: TunerTransformItem[]
}

export interface TunerViewObject {
  path: string
  scene?: string
}

export type TunerHierarchyOp = 'create' | 'delete' | 'duplicate' | 'rename' | 'move'

export const TUNER_PRIMITIVES = ['empty', 'cube', 'sphere', 'capsule', 'cylinder', 'plane', 'quad', 'camera', 'light', 'pointlight', 'spotlight'] as const

export type TunerPrimitive = (typeof TUNER_PRIMITIVES)[number]

export interface TunerHierarchyRequest {
  op: TunerHierarchyOp
  ids?: string[]
  parent?: string
  scene?: string
  before?: string
  after?: string
  order?: boolean
  primitive?: TunerPrimitive
  asset?: string
  name?: string
}

export interface TunerOverlayCanvas {
  name: string
  path: string
  scene: string
  center: [number, number, number]
  size: [number, number, number]
}

export interface TunerHierarchyAdded {
  id: string
  path: string
  scene: string
}

export interface TunerHierarchyResult {
  ids: string[]
  add: TunerHierarchyAdded[]
  state: TunerState | null
}

export interface TunerOpenRequest {
  projectPath: string
  view: string
  paneKey: string
  quiet?: boolean
  unfilter?: boolean
}

export interface TunerViewsChanged {
  projectPath: string
}

export type TunerCanvasMode = 'overlay' | 'camera' | 'world'

export interface TunerCanvas {
  name: string
  path: string
  scene: string
  mode: TunerCanvasMode
  view: string
}

export type TunerQuickView = { kind: 'scene' } | { kind: 'canvas'; canvas: TunerCanvas }

export const TUNER_SCENE_VIEW = 'scene'

export const TUNER_SCENE_PARENT = 'scene:'

export const TUNER_VIEWS_DIR = 'tuners'

export const LEGACY_TUNER_VIEWS_DIR = 'scene-tuners'

export const LEGACY_TUNER_TAB_TYPE = 'scene-tuner'

export const TUNER_INPUT_HZ = 120

export const TUNER_FRAME_MS = 1000 / TUNER_INPUT_HZ

export const TUNER_SHADOW_LIGHT: Vec3 = (() => {
  const v: Vec3 = [-0.35, -1, -0.25]
  const m = Math.hypot(v[0], v[1], v[2])
  return [v[0] / m, v[1] / m, v[2] / m]
})()

export interface TunerPose {
  id: string
  active: boolean
  position: Vec3
  rotation: Quat
  localPosition: Vec3
  localRotation: Quat
  localScale: Vec3
  bounds: TunerBounds | null
}

export type TunerShadowSurface = 'mesh' | 'bounds' | 'ground'

export interface TunerShadow {
  id: string
  point: Vec3
  normal: Vec3
  surface: TunerShadowSurface
}

export type TunerParticlesOp = 'play' | 'pause' | 'restart' | 'stop' | 'speed'

export interface TunerParticles {
  name: string
  path: string
  mode: 'edit' | 'play'
  playing: boolean
  time: number
  duration: number
  count: number
  speed: number
}

export interface TunerLiveEvent {
  projectPath: string
  session: string
  poses?: TunerPose[]
  object?: TunerObject
  objects?: TunerObject[]
  shadow?: TunerShadow | null
  particles?: TunerParticles | null
  animator?: TunerAnimatorUpdate | null
  staging?: TunerStaging | null
  frameTrouble?: string | null
}

export interface TunerMirror {
  projectPath: string
  session: string
  from: string
  selection?: { ids: string[]; active: string | null }
  orbit?: unknown
  ask?: boolean
}

export interface TunerApi {
  listViews: (projectPath: string) => Promise<TunerView[]>
  watchViews: (projectPath: string) => Promise<void>
  unwatchViews: (projectPath: string) => Promise<void>
  onViewsChanged: (cb: (e: TunerViewsChanged) => void) => () => void
  onOpen: (cb: (req: TunerOpenRequest) => void) => () => void
  canvases: (projectPath: string) => Promise<TunerResult<TunerCanvas[]>>
  writeQuickView: (projectPath: string, quick: TunerQuickView) => Promise<TunerResult<string>>
  addObject: (projectPath: string, view: string, object: TunerViewObject) => Promise<TunerResult<number>>

  start: (
    projectPath: string,
    session: string,
    view: string,
    restore?: TunerRestore
  ) => Promise<TunerResult<TunerState>>
  stop: (projectPath: string, session: string) => Promise<void>
  refresh: (projectPath: string, session: string) => Promise<TunerResult<TunerState>>
  camera: (projectPath: string, session: string, camera: TunerCamera) => void
  edit: (projectPath: string, session: string, edit: TunerEdit) => Promise<TunerResult<TunerObject>>
  transform: (projectPath: string, session: string, t: TunerTransform) => void
  open: (projectPath: string, session: string, target: TunerEntryTarget, ghost?: boolean) => Promise<TunerResult<TunerOpened>>
  close: (projectPath: string, session: string, id: string) => Promise<TunerResult<TunerState>>
  button: (projectPath: string, session: string, index: number) => Promise<TunerResult<TunerButtonResult>>
  select: (projectPath: string, session: string, state: string) => Promise<TunerResult<TunerState>>
  reset: (projectPath: string, session: string, reset: TunerReset) => Promise<TunerResult<TunerState>>
  save: (projectPath: string, session: string, stopPlay?: boolean) => Promise<TunerResult<TunerSaveResult>>
  discard: (projectPath: string, session: string, stopPlay?: boolean) => Promise<TunerResult<TunerSaveResult>>
  discardScene: (projectPath: string) => Promise<TunerResult<TunerSaveResult>>
  saveScene: (projectPath: string) => Promise<TunerResult<TunerSaveResult>>
  newScene: (projectPath: string, path: string) => Promise<TunerResult<null>>
  watch: (projectPath: string, session: string, id: string | null, ids?: string[]) => void
  visibility: (projectPath: string, session: string, visible: boolean) => void
  tree: (projectPath: string, session: string, req: TunerTreeRequest) => void
  pick: (projectPath: string, session: string, req: TunerPickRequest) => Promise<TunerResult<TunerPickResult>>
  clearView: (projectPath: string, session: string, req: TunerClearViewRequest) => Promise<TunerResult<{ index: number }>>
  pickRect: (projectPath: string, session: string, req: TunerPickRectRequest) => Promise<TunerResult<TunerPickRectResult>>
  rect: (projectPath: string, session: string, req: TunerRectRequest) => Promise<TunerResult<TunerRectInfo | null>>
  rects: (projectPath: string, session: string, req: TunerRectsRequest) => Promise<TunerResult<TunerRectInfo[]>>
  handles: (projectPath: string, session: string, req: TunerHandlesRequest) => Promise<TunerResult<TunerHandlesState>>
  sceneSelection: (projectPath: string, session: string, sel: TunerSceneSelection | null) => void
  theme: (projectPath: string, session: string, theme: TunerTheme) => void
  sceneSettings: (projectPath: string, session: string, settings: TunerSceneSettings) => void
  annotations: (projectPath: string, session: string, req: TunerAnnotationsRequest) => Promise<TunerResult<TunerAnnotations>>
  particles: (projectPath: string, session: string, op: TunerParticlesOp, speed?: number) => Promise<TunerResult<null>>
  animator: (projectPath: string, session: string, req: TunerAnimatorRequest) => Promise<TunerResult<TunerAnimatorResult | null>>
  staging: (projectPath: string, session: string, req: TunerStagingRequest) => Promise<TunerResult<unknown>>
  hierarchy: (projectPath: string, session: string, req: TunerHierarchyRequest) => Promise<TunerResult<TunerHierarchyResult>>
  canvasView: (projectPath: string, session: string, canvas: string, scene: string) => Promise<TunerResult<TunerState | null>>

  onFrame: (cb: (e: TunerFrameEvent) => void) => () => void
  surface: (projectPath: string, session: string) => void
  dropSurface: (projectPath: string, session: string) => void
  onState: (cb: (e: TunerStateEvent) => void) => () => void
  onEnded: (cb: (e: TunerEndedEvent) => void) => () => void
  onLive: (cb: (e: TunerLiveEvent) => void) => () => void
  attach: (projectPath: string, session: string) => Promise<TunerResult<TunerState>>
  mirror: (payload: TunerMirror) => void
  onMirror: (cb: (e: TunerMirror) => void) => () => void
  onDrift: (cb: (cue: PhoneDriftCue) => void) => () => void
  driftAnswer: (payload: PhoneDriftAnswer) => void
}

export function openedTargets(state: TunerState): TunerEntryTarget[] {
  const out: TunerEntryTarget[] = []
  for (const e of state.entries ?? []) {
    if (!e.opened) continue
    if (e.kind === 'asset') {
      out.push({ kind: 'asset', path: e.path })
      continue
    }
    const t: TunerEntryTarget = e.scene ? { kind: 'object', path: e.path, scene: e.scene, id: e.id } : { kind: 'object', path: e.path, id: e.id }
    if (e.ghost) t.ghost = true
    out.push(t)
  }
  return out
}
