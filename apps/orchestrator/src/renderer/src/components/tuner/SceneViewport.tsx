import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MathUtils, Vector2 } from 'three'
import {
  TUNER_FRAME_MS,
  type Quat,
  type TunerBounds,
  type TunerCamera,
  type TunerCameraSpec,
  type TunerObject,
  type TunerPose,
  type TunerSceneIcon,
  type Vec3
} from '@shared/tuner'
import { tunerSurfaceKey } from '@shared/tuner-frame'
import { blockWheel, pinchFactor, wheelPixels, wheelStream, type WheelStream } from '../../lib/tuner/wheel'
import type { TunerPickBase, TunerPickHit, TunerPiercePick, TunerSceneSelection, TunerTheme } from '@shared/tuner-sceneview'
import { gizmoRenderAvailable } from '../../lib/tuner/gizmo-renderer'
import {
  FOCUS_MS,
  defaultOrbit,
  easeInOutCubic,
  easeOutCubic,
  cameraFrameBounds,
  focusObjectOrbit,
  frameBounds,
  frameLevel,
  MAX_DISTANCE,
  MIN_DISTANCE,
  lerpOrbit,
  nextFrameLevel,
  orbitCamera,
  orbitForward,
  orbitFromLookAt,
  orbitLook,
  orbitOrthoSize,
  orbitPan,
  orbitRotate,
  orbitScale,
  orbitZoom,
  orbitZoomAt,
  orbitFly,
  flyStep,
  FLY_REST,
  dollyStart,
  orbitDolly,
  orbitSize,
  sizeDistance,
  shotOrbit,
  WHEEL_UNITS_PER_PX,
  type DollyDrag,
  type FlyMotion,
  outputSize,
  perspectiveOrbit,
  planarOrbit,
  planarPoint,
  planarSnap,
  projectPoint,
  screenRay,
  type FrameMemo,
  type Orbit
} from '../../lib/tuner/orbit'
import { TUNER_SHOT_EVENT, type TunerShot } from '../../lib/tuner/shot'
import {
  MOVE_SNAP,
  beginDrag,
  pickNearest,
  pickPlanar,
  updateDrag,
  type DragStart,
  type HandleId,
  type HandleMode,
  type HandlePivot,
  type HandleSpace
} from '../../lib/tuner/handles'
import { multiMove, multiRotate, selectionCenter, type PoseItem, type PoseStart } from '../../lib/tuner/multi'
import { NO_SELECTION, rectSelection, topLevel, viewportClick, type PickMode, type TunerSelection, type ViewportHit } from '../../lib/tuner/selection'
import { AXIS_COLORS, SceneOverlay } from '../../lib/tuner/overlay'
import { drawGizmo, GIZMO_CAPTION_FONT, GIZMO_VIEW_NAMES, gizmoCaption, gizmoClickDir, gizmoHit, gizmoScene, snapOrbit, type GizmoColors, type GizmoPart, type GizmoScene } from '../../lib/tuner/scene-gizmo'
import { drawMarkers, markerLayout, pickDot, toScreen, type MarkerColors, type MarkerLayout } from '../../lib/tuner/markers'
import { drawStagingTrails, type StagingTrail } from '../../lib/tuner/staging-report'
import { drawSceneIcons, pickSceneIcon, sceneIconSpots, type SceneIconSpot, type SceneIconStyle } from '../../lib/tuner/scene-icons'
import { iconTraceDraw, iconTraceFrame, iconTraceOn, iconTracePaint, iconTraceProbe } from '../../lib/tuner/icon-trace'
import type { TunerRectInfo, TunerRectItem, TunerRectValues, V2 } from '@shared/tuner-rect'
import {
  ROTATE_STEP,
  anchorValues,
  changedValues,
  moveLockAxis,
  moveValues,
  pivotValues,
  planeAngle,
  planeLocal,
  frameVector,
  resizeFactors,
  resizeValues,
  rotateValues,
  toWorld,
  withValues,
  zAngle,
  type RectHandle
} from '../../lib/tuner/rect-tool'
import { drawRectTool, hitRect, rectCursor, rectScreen, sameRectHandle, type RectColors, type RectScreen } from '../../lib/tuner/rect-overlay'
import {
  MULTI_ID,
  basisRotation,
  mergeRectInfos,
  movedFrame,
  multiFrameOf,
  multiMoveValues,
  multiResizeValues,
  multiRotateValues,
  rectItems,
  resizedFrame,
  rotatedFrame,
  scalePoint
} from '../../lib/tuner/rect-multi'
import { applyPoses, type LiveStore } from '../../lib/tuner/live'
import { movedBounds, pointBounds, rotate, unionBounds } from '../../lib/tuner/space'
import { hasMoveTool, hasTransform } from '../../lib/tuner/prompt'
import { createThrottle } from '../../lib/tuner/session-memory'
import { forgetTransformLatency, noteFrameAck, transformsAcked } from '../../lib/tuner/latency'
import { cyclePick, isClick, newPickCycle, toPiercePick } from '../../lib/tuner/pierce'
import { readCssRgb, readTunerTheme, rgbCss, sameTheme, watchTheme } from '../../lib/tuner/theme'
import { handleTraceOn, handleTraceRecord } from '../../lib/tuner/handle-trace'
import { boxOf, outlineBox, probeObject, screenOf, type ProbeObject } from '../../lib/tuner/view-probe'
import { PierceMenu } from './PierceMenu'
import { createUnityHandles, type UnityHandles } from '../../lib/tuner/unity-handles'
import type { TunerHandleEventType } from '@shared/tuner-handles'
import { noteRender } from '../../lib/tuner/perf'
import { DEFAULT_TUNER_CAMERA, type TunerCameraSettings } from '../../lib/tuner/layout'
import { loopCameraSeq, loopFrame, loopInput, loopPaint } from '../../lib/tuner/loop-trace'
import { isPhoneView, onTunerMirror, sendTunerMirror, sendTunerOrbit } from '../../lib/tuner/view-mirror'
import { GIZMO_ASK_ATTR, GIZMO_AT_ATTR, GIZMO_EVENT, GIZMO_OBJECT, pickGizmoPoint, type GizmoAim, type GizmoSpec } from '@shared/gizmo-pick'
import { debugLog } from '@shared/debug-log'

export interface TunerFocus {
  ids: string[]
  tree: boolean
  context?: boolean
}

export interface PoseChange {
  position?: Vec3
  rotation?: Quat
  localScale?: Vec3
  fov?: number
}

interface MultiDrag {
  starts: PoseStart[]
  origin: Vec3
  rot0: Quat
  pose: { position: Vec3; rotation: Quat }
  last: PoseItem[] | null
}

const GIZMO_COLORS: GizmoColors = { axes: AXIS_COLORS, negative: 0xc9c9ce, cube: 0xc4c4c9, hover: 0xf5d547 }

type Gesture =
  | { kind: 'touch2'; mx: number; my: number; d: number; a: number; t: number; vx: number; vy: number }
  | { kind: 'touchHold'; x: number; y: number; timer: ReturnType<typeof setTimeout> }
  | { kind: 'gizmo'; part: GizmoPart; x: number; y: number }
  | { kind: 'pending'; x: number; y: number; alt: boolean; mode: PickMode }
  | { kind: 'pendingRight'; x: number; y: number; alt: boolean }
  | { kind: 'orbit'; x: number; y: number; t?: number; vx?: number; vy?: number }
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'look'; x: number; y: number }
  | { kind: 'dolly'; x: number; y: number; dolly?: DollyDrag }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; mode: PickMode; start: TunerSelection; seq: number }
  | { kind: 'handle'; id: string; drag: DragStart; last: PoseChange | null; multi: MultiDrag | null; start: { position: Vec3; rotation: Quat }; off?: [number, number] }
  | { kind: 'unity' }
  | {
      kind: 'rect'
      id: string
      handle: RectHandle
      start: TunerRectInfo
      m0: V2
      p0: V2
      w0: Vec3
      lock: -1 | 0 | 1
      sent: Set<keyof TunerRectValues>
      last: TunerRectValues | null
      action: boolean
      multi: RectMulti | null
    }

interface RectMulti {
  starts: TunerRectInfo[]
  frame: TunerRectInfo
  center: boolean
  active: TunerRectInfo | null
  items: TunerRectItem[] | null
  params: Record<string, unknown> | null
}

interface MenuState {
  x: number
  y: number
  hits: TunerPickHit[]
  pending: boolean
}
const NO_PINS: ReadonlySet<string> = new Set()
const NO_IDS: string[] = []
const MARQUEE_MS = 70
const DRAG_HOLD_MAX_MS = 1000
const PHONE_GIZMO_SCALE = 0.65
const TOUCH_HOLD_MS = 480
const TOUCH_DOUBLE_MS = 320
const TOUCH_DOUBLE_PX = 28
const TOUCH_FRAME_SETTLE_MS = 160
const TOUCH_FLING_MIN = 0.25
const TOUCH_FLING_STOP = 0.02
const TOUCH_FLING_TAU_MS = 260
const TOUCH_FLING_GAP_MS = 90
const TOUCH_HANDLE_RINGS = [0, 11, 22]
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

function pickMode(e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): PickMode {
  if (e.shiftKey) return 'add'
  return (isMac ? e.metaKey : e.ctrlKey) ? 'sub' : 'normal'
}

function hitIds(hits: TunerPickHit[]): ViewportHit | null {
  const h = hits[0]
  if (!h) return null
  const exact = h.target ?? h.owner
  const base = h.base ? (h.base.target ?? h.base.owner ?? exact) : exact
  const chain = [h.target, h.owner, h.base?.target ?? null, h.base?.owner ?? null].filter((x): x is string => !!x)
  return { exact, base, chain: [...new Set(chain)] }
}

function framable(o: TunerObject): boolean {
  return !o.error && (o.kind !== 'member' || o.bounds != null || o.components.length > 0)
}

function boundsOf(objects: TunerObject[], ids?: string[]) {
  const list = objects.filter((o) => !o.error && (!ids || ids.includes(o.id)))
  const solid = unionBounds(list.map((o) => o.bounds))
  if (!solid) return unionBounds(list.map((o) => pointBounds([o.position], 1)))
  const reach = Math.max(OUTLIER_MIN, Math.hypot(...solid.size)) * OUTLIER_SHARE
  const near = list.filter((o) => !o.bounds && Math.hypot(...o.position.map((v, i) => v - solid.center[i])) <= reach)
  return unionBounds([solid, ...near.map((o) => pointBounds([o.position], 1))])
}

const OUTLIER_MIN = 10
const OUTLIER_SHARE = 1

type CamPose = Pick<TunerCamera, 'position' | 'rotation' | 'fov' | 'ortho' | 'clip'>

const CAMERA_MS = 450

interface CameraCmd {
  op: string
  paths?: string[] | null
  pivot?: boolean
  auto?: boolean
  view?: string
  yaw?: number
  pitch?: number
  distance?: number
  target?: number[]
  ortho?: number
  factor?: number
  pad?: number
  ms?: number
  angle?: string | null
  solid?: boolean
  nice?: boolean
}

interface CameraState {
  target: number[]
  yaw: number
  pitch: number
  distance: number
  ortho: number | null
  view: string
  animating: boolean
}

interface CameraReply {
  ok: boolean
  why?: string
  moved?: boolean
  subject?: string
  ms?: number
  missing?: string[]
  state?: CameraState | null
  box?: { x: number; y: number; width: number; height: number } | null
  aim?: GizmoAim | null
  inView?: boolean
  invisible?: boolean
  note?: string
}

const FOCUS_PAD = 1.35
const FOCUS_ANGLES = ['auto', 'front', 'back', 'left', 'right', 'top', 'three-quarter', 'current']

function flatYaw(d: number[]): number | null {
  return Math.hypot(d[0], d[2]) < 1e-3 ? null : (Math.atan2(d[0], d[2]) * 180) / Math.PI
}

function focusAngle(base: Orbit, obj: TunerObject, cmd: CameraCmd): { yaw: number; pitch: number; free: boolean } | string {
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const pitchOf = (p: number): number => Math.max(-89, Math.min(89, p))
  if (num(cmd.yaw) || num(cmd.pitch)) return { yaw: num(cmd.yaw) ? cmd.yaw : base.yaw, pitch: pitchOf(num(cmd.pitch) ? cmd.pitch : base.pitch), free: false }
  const a = cmd.angle == null ? 'auto' : String(cmd.angle).toLowerCase()
  const f = rotate(obj.rotation, [0, 0, 1])
  const r = rotate(obj.rotation, [1, 0, 0])
  const look = (d: number[], pitch: number): { yaw: number; pitch: number; free: boolean } => ({ yaw: flatYaw(d) ?? base.yaw, pitch, free: false })
  if (a === 'auto') return { yaw: base.yaw, pitch: Math.max(15, Math.min(40, base.pitch)), free: true }
  if (a === 'current') return { yaw: base.yaw, pitch: base.pitch, free: false }
  if (a === 'front') return look([-f[0], 0, -f[2]], 12)
  if (a === 'back') return look([f[0], 0, f[2]], 12)
  if (a === 'left') return look([r[0], 0, r[2]], 12)
  if (a === 'right') return look([-r[0], 0, -r[2]], 12)
  if (a === 'three-quarter') return look([-(f[0] * 0.82 + r[0] * 0.57), 0, -(f[2] * 0.82 + r[2] * 0.57)], 22)
  if (a === 'top') return { yaw: base.yaw, pitch: 85, free: false }
  return `unknown angle "${a}": use ${FOCUS_ANGLES.join(', ')}, or { yaw, pitch } in degrees`
}

function sameCam(a: CamPose | null, b: CamPose): boolean {
  if (!a) return false
  return (
    a.fov === b.fov &&
    a.ortho === b.ortho &&
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.position[2] === b.position[2] &&
    a.rotation[0] === b.rotation[0] &&
    a.rotation[1] === b.rotation[1] &&
    a.rotation[2] === b.rotation[2] &&
    a.rotation[3] === b.rotation[3]
  )
}

function overlayKey(objects: TunerObject[], sel: TunerObject | null): number[] {
  const key: number[] = []
  if (sel && hasTransform(sel)) key.push(...sel.position, ...sel.rotation)
  objects.forEach((o, i) => {
    if (!o.error && !o.bounds && o.active) key.push(i, o.position[0], o.position[1], o.position[2])
  })
  return key
}

function sameKey(a: number[] | null, b: number[]): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

interface Drawn {
  cam: CamPose | null
  key: number[] | null
  selected: string | null
  selection: TunerSelection | null
  pivot: HandlePivot | null
  hovered: string | null
  hoverHandle: HandleId | null
  activeHandle: HandleId | null
  mode: HandleMode | null
  space: HandleSpace | null
  w: number
  h: number
  shadow: unknown
  rect: number
  icons: TunerSceneIcon[]
  poses: number
  trails: readonly StagingTrail[] | null
}

const RECT_FETCH_MS = 90
const FRAME_WAIT_MS = 8000
const FOG_FRAME_SHARE = 0.45
const INITIAL_FRAME_PAD = 1.7
const RECT_CURSORS: Record<string, string> = {
  default: 'cursor-default',
  move: 'cursor-move',
  grabbing: 'cursor-grabbing',
  pointer: 'cursor-pointer',
  alias: 'cursor-alias',
  'ew-resize': 'cursor-ew-resize',
  'ns-resize': 'cursor-ns-resize',
  'nwse-resize': 'cursor-nwse-resize',
  'nesw-resize': 'cursor-nesw-resize'
}
const PIVOT_SNAP_PX = 6

function rectPoseKey(o: TunerObject): string {
  return `${o.position.join(',')}|${o.rotation.join(',')}|${o.bounds ? [...o.bounds.center, ...o.bounds.size].join(',') : ''}`
}

function fmtRect(v: number): string {
  const r = Math.round(v * 1000) / 1000
  return `${Object.is(r, -0) ? 0 : r}`
}

function rectToolDataset(info: TunerRectInfo, sc: RectScreen) {
  const r = (p: V2): V2 => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]
  return {
    id: info.id,
    corners: sc.corners.map(r),
    pivot: r(sc.pivot),
    anchors: sc.anchors
      .filter((a) => a.tri)
      .map((a) => ({ x: a.x, y: a.y, at: r([(a.tri![0][0] + a.tri![1][0] + a.tri![2][0]) / 3, (a.tri![0][1] + a.tri![1][1] + a.tri![2][1]) / 3]) }))
  }
}

function pickRect(v: TunerRectValues, keys: Set<keyof TunerRectValues>): Partial<TunerRectValues> {
  const out: Partial<TunerRectValues> = {}
  for (const k of keys) (out as Record<string, unknown>)[k] = v[k]
  return out
}

function rectLabel(h: RectHandle): string {
  if (h.kind === 'move') return 'Move Rect'
  if (h.kind === 'resize') return 'Resize Rect'
  if (h.kind === 'pivot') return 'Move Rectangle Pivot'
  if (h.kind === 'anchor') return 'Move Rectangle Anchors'
  return 'Rotate Rect'
}

function rectReadout(h: RectHandle, info: TunerRectInfo): string {
  if (h.kind === 'pivot') return `Pivot ${fmtRect(info.pivot[0])}, ${fmtRect(info.pivot[1])}`
  if (h.kind === 'anchor')
    return `Min ${fmtRect(info.anchorMin[0])}, ${fmtRect(info.anchorMin[1])} · Max ${fmtRect(info.anchorMax[0])}, ${fmtRect(info.anchorMax[1])}`
  if (h.kind === 'rotate') return `Z ${fmtRect(Math.round(zAngle(info.localRotation) * 10) / 10)}°`
  return `Pos ${fmtRect(info.anchoredPosition[0])}, ${fmtRect(info.anchoredPosition[1])} · ${fmtRect(info.rect[2])} × ${fmtRect(info.rect[3])}`
}

export function SceneViewport({
  projectPath,
  session,
  live,
  onEditKey,
  startSeq = 0,
  planar = false,
  orthographic = false,
  onOrthographicChange,
  camera = DEFAULT_TUNER_CAMERA,
  onCameraChange,
  iconStyle,
  objects,
  wholeScene = false,
  focus = null,
  viewTo = null,
  frameBox = null,
  sceneBounds,
  liveStore,
  pinned = NO_PINS,
  selected,
  selection = NO_SELECTION,
  ghosts = NO_IDS,
  pivot = 'pivot',
  mode,
  space,
  cameraSpec,
  cameraKey,
  orbitMemory,
  frameSignal,
  frameSelectionFirst = false,
  onSelect,
  onSelectionChange,
  onPiercePick,
  selectedPath,
  onTransform,
  onTransformMany,
  onFps,
  trails = null,
  children
}: {
  projectPath: string
  session: string
  live: boolean
  onEditKey?: (op: 'duplicate' | 'delete') => void
  startSeq?: number
  planar?: boolean
  orthographic?: boolean
  onOrthographicChange?: (on: boolean) => void
  camera?: TunerCameraSettings
  onCameraChange?: (patch: Partial<TunerCameraSettings>) => void
  iconStyle?: SceneIconStyle
  objects: TunerObject[]
  wholeScene?: boolean
  focus?: TunerFocus | null
  viewTo?: { orbit: Orbit; seq: number } | null
  frameBox?: { bounds: TunerBounds; seq: number } | null
  sceneBounds?: TunerBounds | null
  liveStore?: LiveStore
  pinned?: ReadonlySet<string>
  selected: string | null
  selection?: TunerSelection
  ghosts?: string[]
  pivot?: HandlePivot
  mode: HandleMode
  space: HandleSpace
  cameraSpec?: TunerCameraSpec
  cameraKey?: string
  orbitMemory: { orbit: Orbit | null }
  frameSignal: number
  frameSelectionFirst?: boolean
  onSelect: (id: string | null) => void
  onSelectionChange?: (sel: TunerSelection) => void
  onPiercePick?: (pick: TunerPiercePick) => void
  selectedPath?: { path: string; scene: string } | null
  onTransform: (id: string, pose: PoseChange, final: boolean) => void
  onTransformMany?: (items: PoseItem[], final: boolean) => void
  onFps?: (fps: number) => void
  trails?: readonly StagingTrail[] | null
  children?: ReactNode
}) {
  noteRender('SceneViewport')
  const wrapRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLCanvasElement>(null)
  const ovRef = useRef<HTMLCanvasElement>(null)
  const readoutRef = useRef<HTMLSpanElement>(null)
  const flyRef = useRef<{ keys: Set<string>; raf: number; last: number; motion: FlyMotion; flew: boolean; shift: boolean; dt: number }>({ keys: new Set(), raf: 0, last: 0, motion: FLY_REST, flew: false, shift: false, dt: 0 })
  const iconsRef = useRef<TunerSceneIcon[]>([])
  const iconSpotsRef = useRef<SceneIconSpot[]>([])
  const iconHoverRef = useRef<string | null>(null)
  const overlayRef = useRef<SceneOverlay | null>(null)
  const frameCamRef = useRef<TunerCamera | null>(null)
  const sceneBoundsRef = useRef<TunerBounds | null>(null)
  sceneBoundsRef.current = wholeScene ? (sceneBounds ?? null) : null
  const pendingFrameRef = useRef<{ id: string; until: number; instant?: boolean } | null>(null)
  const surfaceViewRef = useRef({ shown: false, flipY: false })
  const [surfaceView, setSurfaceView] = useState<{ shown: boolean; flipY: boolean }>({ shown: false, flipY: false })
  const sizeRef = useRef({ w: 0, h: 0 })
  const orbitRef = useRef<Orbit | null>(orbitMemory.orbit)
  const planarRef = useRef(planar)
  planarRef.current = planar
  const orthoRef = useRef(orthographic)
  orthoRef.current = orthographic
  const onOrthoRef = useRef(onOrthographicChange)
  onOrthoRef.current = onOrthographicChange
  const camSetRef = useRef(camera)
  camSetRef.current = camera
  const onCameraRef = useRef(onCameraChange)
  onCameraRef.current = onCameraChange
  const iconStyleRef = useRef(iconStyle)
  iconStyleRef.current = iconStyle
  const gizmoRef = useRef<GizmoScene | null>(null)
  const gizmoHoverRef = useRef<GizmoPart | null>(null)
  const gizmoDataRef = useRef('')
  const objectsRef = useRef(objects)
  const trailsRef = useRef(trails)
  trailsRef.current = trails
  const pinnedRef = useRef(pinned)
  const liveStoreRef = useRef(liveStore)
  const effectiveRef = useRef<{ objects: TunerObject[] | null; pinned: ReadonlySet<string> | null; version: number; drag: number; frame: number; value: TunerObject[] }>({
    objects: null,
    pinned: null,
    version: -1,
    drag: -1,
    frame: -1,
    value: objects
  })
  const dragPoseRef = useRef<Map<string, PoseChange> | null>(null)
  const dragVerRef = useRef(0)
  const dragHeldRef = useRef(false)
  const dragHoldRef = useRef(0)
  const framePosesRef = useRef(new Map<string, TunerPose>())
  const framePoseVerRef = useRef(0)
  const frameSeqRef = useRef(0)
  const selectedRef = useRef(selected)
  const selectionRef = useRef(selection)
  const pivotRef = useRef(pivot)
  const marqueeRef = useRef<HTMLDivElement>(null)
  const modeRef = useRef(mode)
  const spaceRef = useRef(space)
  const hoverRef = useRef<string | null>(null)
  const hoverHandleRef = useRef<HandleId | null>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const touchesRef = useRef(new Map<number, { x: number; y: number }>())
  const inertiaRef = useRef(0)
  const lastTapRef = useRef<{ x: number; y: number; at: number } | null>(null)
  const rafRef = useRef(0)
  const imageDirtyRef = useRef(true)
  const drawnRef = useRef<Drawn | null>(null)
  const layoutRef = useRef<MarkerLayout>({ dots: [], shadows: [] })
  const animRef = useRef(0)
  const [cursor, setCursor] = useState('cursor-default')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const pickIconsRef = useRef<Record<string, string>>({})
  const themeRef = useRef<TunerTheme | null>(null)
  const chromeRef = useRef<{ markers?: MarkerColors }>({})
  const cycleRef = useRef(newPickCycle())
  const activePathRef = useRef<string | null>(null)
  const expectSelRef = useRef<string | null | undefined>(undefined)
  const pickSeqRef = useRef(0)
  const rectRef = useRef<TunerRectInfo | null>(null)
  const rectVersionRef = useRef(0)
  const rectPoseRef = useRef<string | null>(null)
  const rectObjectsRef = useRef<TunerObject[] | null>(null)
  const rectSeqRef = useRef(0)
  const rectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rectHoverRef = useRef<RectHandle | null>(null)
  const multiInfoRef = useRef<{ key: string; infos: TunerRectInfo[] } | null>(null)
  const multiSeqRef = useRef(0)
  const multiPoseRef = useRef<string | null>(null)
  const multiObjectsRef = useRef<TunerObject[] | null>(null)
  const multiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const multiHeldRef = useRef<{ key: string; frame: TunerRectInfo } | null>(null)
  const rectColorsRef = useRef<RectColors>({
    accent: '#8196ff',
    outline: 'rgba(255,255,255,0.75)',
    parent: 'rgba(255,255,255,0.45)',
    label: '#fafafa',
    labelBg: 'rgba(41,43,48,0.92)',
    shadow: 'rgba(0,0,0,0.55)'
  })
  const [glOk] = useState(() => gizmoRenderAvailable())
  const wheelRef = useRef<WheelStream | null>(null)
  const frameMemoRef = useRef<FrameMemo | null>(null)
  const orbitMemoryRef = useRef(orbitMemory)
  const viewStartRef = useRef(startSeq)
  if (orbitMemoryRef.current !== orbitMemory) {
    orbitMemoryRef.current = orbitMemory
    viewStartRef.current = startSeq
    orbitRef.current = orbitMemory.orbit
    frameCamRef.current = null
    pendingFrameRef.current = null
    frameMemoRef.current = null
  }
  objectsRef.current = objects
  pinnedRef.current = pinned
  liveStoreRef.current = liveStore
  selectedRef.current = selected
  selectionRef.current = selection
  pivotRef.current = pivot
  modeRef.current = mode
  spaceRef.current = space
  const apiRef = useRef({ projectPath, session })
  apiRef.current = { projectPath, session }
  const unityToolRef = useRef(false)
  const unityRef = useRef<UnityHandles | null>(null)
  if (!unityRef.current)
    unityRef.current = createUnityHandles(
      (req) => window.api.tuner.handles(apiRef.current.projectPath, apiRef.current.session, req),
      (st) => {
        if (st.tool === unityToolRef.current) return
        unityToolRef.current = st.tool
        if (st.tool) hoverHandleRef.current = null
        requestDraw()
      }
    )
  const lastPtrRef = useRef<{ clientX: number; clientY: number } | null>(null)
  const unityEvent = (
    e: { clientX: number; clientY: number; button?: number; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
    type: TunerHandleEventType
  ): void => {
    const wrap = wrapRef.current
    if (!wrap || !liveRef.current) return
    const r = wrap.getBoundingClientRect()
    unityRef.current!.push({
      type,
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      w: r.width,
      h: r.height,
      button: e.button ?? 0,
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      cmd: e.metaKey
    })
  }

  const rectSend = useRef(
    createThrottle((pp: string, s: string, id: string, values: Partial<TunerRectValues>, final: boolean, label: string) => {
      void window.api.tuner
        .rect(pp, s, { op: 'set', id, ...values, ...(final ? { final: true } : {}), label })
        .then((res) => {
          if (!final || !res.ok || !res.data || gestureRef.current?.kind === 'rect') return
          if (selectedRef.current !== id) return
          setRectInfo(res.data)
        })
        .catch(() => undefined)
    }, TUNER_FRAME_MS)
  ).current

  const setRectInfo = (info: TunerRectInfo | null): void => {
    rectRef.current = info
    rectVersionRef.current++
    requestDraw()
  }

  const fetchRect = (id: string): void => {
    if (!liveRef.current) return
    const seq = ++rectSeqRef.current
    void window.api.tuner
      .rect(projectPath, session, { op: 'get', id })
      .then((res) => {
        if (seq !== rectSeqRef.current || gestureRef.current?.kind === 'rect' || selectedRef.current !== id) return
        setRectInfo(res.ok ? res.data : null)
        if (!res.ok && !/RectTransform|no object/.test(res.error))
          setTimeout(() => {
            if (seq !== rectSeqRef.current) return
            rectPoseRef.current = null
            requestDraw()
          }, 500)
      })
      .catch(() => undefined)
  }

  const scheduleRect = (id: string): void => {
    if (rectTimerRef.current) clearTimeout(rectTimerRef.current)
    rectTimerRef.current = setTimeout(() => {
      rectTimerRef.current = null
      fetchRect(id)
    }, RECT_FETCH_MS)
  }

  const rectsSend = useRef(
    createThrottle((pp: string, s: string, items: TunerRectItem[], final: boolean, label: string) => {
      void window.api.tuner
        .rects(pp, s, { op: 'set', items, ...(final ? { final: true } : {}), label })
        .then((res) => {
          if (!final) return
          multiHeldRef.current = null
          const m = multiInfoRef.current
          if (res.ok && m) multiInfoRef.current = { key: m.key, infos: mergeRectInfos(m.infos, res.data) }
          rectVersionRef.current++
          requestDraw()
        })
        .catch(() => {
          multiHeldRef.current = null
        })
    }, TUNER_FRAME_MS)
  ).current

  const rectMultiIds = (): string[] | null => (modeRef.current === 'rect' && selectionRef.current.ids.length > 1 ? selectionRef.current.ids : null)

  const fetchMulti = (ids: string[]): void => {
    if (!liveRef.current) return
    const seq = ++multiSeqRef.current
    const key = ids.join('\n')
    void window.api.tuner
      .rects(projectPath, session, { op: 'get', ids })
      .then((res) => {
        if (seq !== multiSeqRef.current || gestureRef.current?.kind === 'rect' || multiHeldRef.current) return
        multiInfoRef.current = res.ok && res.data.length > 0 ? { key, infos: res.data } : null
        rectVersionRef.current++
        requestDraw()
      })
      .catch(() => undefined)
  }

  const scheduleMulti = (ids: string[]): void => {
    if (multiTimerRef.current) clearTimeout(multiTimerRef.current)
    multiTimerRef.current = setTimeout(() => {
      multiTimerRef.current = null
      fetchMulti(ids)
    }, RECT_FETCH_MS)
  }

  const multiFrameFrom = (infos: TunerRectInfo[]): TunerRectInfo | null => {
    const active = infos.find((i) => i.id === selectedRef.current) ?? null
    const rotation: Quat = spaceRef.current === 'local' && active ? basisRotation(active.frame.ux, active.frame.uy) : [0, 0, 0, 1]
    return multiFrameOf(infos, pivotRef.current === 'pivot' && active ? active.frame.origin : null, rotation)
  }

  const multiFrame = (): TunerRectInfo | null => {
    const g = gestureRef.current
    if (g?.kind === 'rect' && g.multi) return g.multi.frame
    const ids = rectMultiIds()
    const m = multiInfoRef.current
    if (!ids || !m || m.key !== ids.join('\n')) return null
    const held = multiHeldRef.current
    if (held && held.key === m.key) return held.frame
    return multiFrameFrom(m.infos)
  }

  const rectFor = (id: string | null): TunerRectInfo | null => {
    if (modeRef.current !== 'rect') return null
    if (rectMultiIds()) return multiFrame()
    const r = rectRef.current
    return r && id && r.id === id ? r : null
  }

  useEffect(() => {
    unityRef.current?.release()
  }, [mode])

  useEffect(() => {
    const t = setTimeout(() => unityRef.current?.refresh(), 300)
    return () => clearTimeout(t)
  }, [selected])

  useEffect(() => () => unityRef.current?.dispose(), [])

  const handleMode = (): HandleMode => {
    const id = selectedRef.current
    return modeRef.current === 'rect' && !rectFor(id) ? (isRectObject(id) ? 'rect' : 'move') : modeRef.current
  }

  const isRectObject = (id: string | null): boolean => {
    const o = id ? effectiveObjects().find((x) => x.id === id && !x.error) : null
    return !!o?.components?.some((c) => /(^|\.)RectTransform$/.test(c.type))
  }

  const cameraSend = useRef(
    createThrottle((pp: string, s: string, o: Orbit, w: number, h: number) => {
      const c = camSetRef.current
      window.api.tuner.camera(pp, s, { ...orbitCamera(o, w, h, c.dynamicClip ? null : [c.near, c.far]), points: sizeRef.current.w, cseq: loopCameraSeq() })
    }, TUNER_FRAME_MS)
  ).current

  const liveRef = useRef(live)
  liveRef.current = live

  const effectiveObjects = (): TunerObject[] => {
    const store = liveStoreRef.current
    const c = effectiveRef.current
    const version = store?.version ?? 0
    if (c.objects === objectsRef.current && c.pinned === pinnedRef.current && c.version === version && c.drag === dragVerRef.current && c.frame === framePoseVerRef.current) return c.value
    c.objects = objectsRef.current
    c.pinned = pinnedRef.current
    c.version = version
    c.drag = dragVerRef.current
    c.frame = framePoseVerRef.current
    const live = store ? applyPoses(objectsRef.current, store.poses, pinnedRef.current) : objectsRef.current
    const base = framePosesRef.current.size > 0 ? applyPoses(live, framePosesRef.current, pinnedRef.current) : live
    const drag = dragPoseRef.current
    c.value =
      drag && drag.size > 0
        ? base.map((o) => {
            const p = drag.get(o.id)
            if (!p) return o
            const position = p.position ?? o.position
            const rotation = p.rotation ?? o.rotation
            const localScale = p.localScale ?? o.localScale
            return { ...o, position, rotation, localScale, bounds: o.bounds ? movedBounds(o.bounds, o.position, o.rotation, position, rotation) : null }
          })
        : base
    return c.value
  }

  const sendCamera = (flush = false): void => {
    const o = orbitRef.current
    const { w, h } = sizeRef.current
    if (!o || w < 2 || h < 2 || !liveRef.current) return
    const [pw, ph] = outputSize(w, h, window.devicePixelRatio || 1)
    if (flush) cameraSend.flush(projectPath, session, o, pw, ph)
    else cameraSend.call(projectPath, session, o, pw, ph)
    sendTunerOrbit(projectPath, session, o, flush)
  }

  useEffect(
    () =>
      onTunerMirror(projectPath, session, (m) => {
        if (m.ask && orbitRef.current) sendTunerOrbit(projectPath, session, orbitRef.current, true)
        const o = m.orbit as Orbit | undefined
        if (!o || !Array.isArray(o.target) || gestureRef.current) return
        stopAnim()
        orbitRef.current = o
        orbitMemory.orbit = o
        requestDraw()
      }),
    [projectPath, session, orbitMemory]
  )

  const setOrbit = (input: Orbit): void => {
    const fov = camSetRef.current.fov
    const next = input.fov === fov || input.ortho ? input : { ...input, fov, distance: Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, sizeDistance(orbitSize(input), fov))) }
    const want = !planarRef.current && orthoRef.current
    const o = !!next.orthographic === want ? next : { ...next, orthographic: want || undefined }
    orbitRef.current = o
    orbitMemory.orbit = o
    const wrap = wrapRef.current
    if (wrap) {
      wrap.dataset.orbitTarget = o.target.map((v) => v.toFixed(4)).join(',')
      wrap.dataset.orbit = JSON.stringify({ t: o.target.map((v) => Number(v.toFixed(6))), d: Number(o.distance.toFixed(6)), yaw: Number(o.yaw.toFixed(4)), pitch: Number(o.pitch.toFixed(4)), ...(o.ortho ? { o: Number(o.ortho.toFixed(6)) } : {}) })
    }
    sendCamera()
    requestDraw()
  }

  useEffect(() => {
    const o = orbitRef.current
    if (o) setOrbit(o)
  }, [camera.fov, camera.dynamicClip, camera.near, camera.far])

  const viewSeqRef = useRef(viewTo?.seq ?? 0)
  useEffect(() => {
    if (!viewTo || viewTo.seq === viewSeqRef.current) return
    viewSeqRef.current = viewTo.seq
    setOrbit(viewTo.orbit)
  })

  const fitMode = (o: Orbit): Orbit => (planarRef.current ? planarOrbit(o) : perspectiveOrbit(o))

  const baseOrbit = (): Orbit => orbitRef.current ?? fitMode(defaultOrbit())

  const stopAnim = (): void => {
    if (!animRef.current) return
    cancelAnimationFrame(animRef.current)
    animRef.current = 0
  }

  const animateTo = (to: Orbit, ms = FOCUS_MS, ease: (t: number) => number = easeOutCubic): void => {
    stopAnim()
    const from = baseOrbit()
    const start = performance.now()
    const step = (now: number): void => {
      const k = ease((now - start) / ms)
      setOrbit(k >= 1 ? to : lerpOrbit(from, to, k))
      if (k < 1) animRef.current = requestAnimationFrame(step)
      else {
        animRef.current = 0
        sendCamera(true)
      }
    }
    animRef.current = requestAnimationFrame(step)
  }

  const currentCamera = () => {
    const o = baseOrbit()
    const { w, h } = sizeRef.current
    return { cam: orbitCamera(o, w, h), aspect: w / Math.max(1, h), orbit: o }
  }

  const focusObject = (id: string): void => {
    const objs = effectiveObjects()
    const obj = objs.find((o) => o.id === id && !o.error)
    if (!obj) return
    const { w, h } = sizeRef.current
    const others = objs.filter((o) => o.id !== id && !o.error).map((o) => o.bounds)
    const to = focusObjectOrbit(baseOrbit(), obj, others, w / Math.max(1, h))
    if (!liveRef.current || planarRef.current || to.ortho) {
      animateTo(to)
      return
    }
    void clearView(to, obj.id, 0).then((best) => best && animateTo(best))
  }

  const drawImageLayer = (): void => {
    const c = imgRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    imageDirtyRef.current = false
    const theme = themeRef.current
    if (theme) {
      ctx.fillStyle = rgbCss(theme.clear)
      ctx.fillRect(0, 0, c.width, c.height)
    } else ctx.clearRect(0, 0, c.width, c.height)
  }

  const drawSceneGizmo = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, rotation: Quat): void => {
    const wrap = wrapRef.current
    if (planarRef.current) {
      gizmoRef.current = null
      if (gizmoDataRef.current && wrap) {
        gizmoDataRef.current = ''
        delete wrap.dataset.sceneGizmo
        delete wrap.dataset.sceneView
        wrap.dataset.sceneProjection = 'perspective'
      }
      return
    }
    const dpr = canvas.width / Math.max(1, canvas.clientWidth)
    const ortho = orthoRef.current
    const caption = gizmoCaption(baseOrbit(), ortho)
    ctx.save()
    ctx.font = GIZMO_CAPTION_FONT
    const scene = gizmoScene(rotation, canvas.clientWidth, caption, ortho, gizmoHoverRef.current, GIZMO_COLORS, (t) => ctx.measureText(t).width, isPhoneView() ? PHONE_GIZMO_SCALE : 1)
    ctx.restore()
    gizmoRef.current = scene
    drawGizmo(ctx, scene, dpr)
    if (!wrap) return
    const r1 = (v: number): number => Math.round(v * 10) / 10
    const c = scene.caption
    const cones = [0, 1, 2, 3, 4, 5].map((i) => {
      const it = scene.items.find((x) => x.part === i)!
      return [r1(it.center[0]), r1(it.center[1]), r1(it.alpha)]
    })
    const data = JSON.stringify({ cube: [r1(scene.cx), r1(scene.cy)], label: [r1(c.x + c.w / 2), r1(c.y + c.h / 2)], cones })
    const key = `${data}|${caption}|${ortho}`
    if (key === gizmoDataRef.current) return
    gizmoDataRef.current = key
    wrap.dataset.sceneGizmo = data
    wrap.dataset.sceneView = caption
    wrap.dataset.sceneProjection = ortho ? 'orthographic' : 'perspective'
  }

  const setProjection = (on: boolean): void => {
    if (planarRef.current) return
    orthoRef.current = on
    onOrthoRef.current?.(on)
    const o = orbitRef.current
    if (!o) return
    setOrbit(o)
    sendCamera(true)
  }

  const gizmoClick = (part: GizmoPart, shift: boolean): void => {
    if (planarRef.current) return
    if (isPhoneView()) debugLog(`[tuner] view gizmo tap ${typeof part === 'number' ? GIZMO_VIEW_NAMES[part] : part}`)
    if (part === 'cube' || part === 'label') {
      setProjection(!orthoRef.current)
      return
    }
    const o = baseOrbit()
    const dir = gizmoClickDir(o, part)
    if (shift && !orthoRef.current) setProjection(true)
    animateTo(snapOrbit(o, dir))
  }

  const selectionObjects = (objs: TunerObject[]): TunerObject[] => {
    const ids = selectionRef.current.ids
    if (ids.length < 2) return []
    const set = new Set(ids)
    return objs.filter((o) => set.has(o.id) && !o.error && hasTransform(o))
  }

  const multiHandle = (sel: TunerObject | null): boolean =>
    !!sel && !!onTransformMany && (selectionRef.current.ids.length > 1 || pivotRef.current === 'center')

  const handlePose = (objs: TunerObject[], sel: TunerObject | null, g: Gesture | null): { position: Vec3; rotation: Quat } | null => {
    if (!sel || !hasMoveTool(sel)) return null
    if (g?.kind === 'handle' && g.multi) return g.multi.pose
    if (pivotRef.current !== 'center') return { position: sel.position, rotation: sel.rotation }
    const list = selectionRef.current.ids.length > 1 ? selectionObjects(objs) : [sel]
    return { position: selectionCenter(list.length ? list : [sel]) ?? sel.position, rotation: sel.rotation }
  }

  const drawOverlay = (): void => {
    const canvas = ovRef.current
    if (!canvas) return
    const { w, h } = sizeRef.current
    if (w < 2 || h < 2) return
    const current = currentCamera()
    const cam = liveRef.current && frameCamRef.current ? { ...frameCamRef.current, clip: current.cam.clip } : current.cam
    const objs = effectiveObjects()
    const g = gestureRef.current
    const activeHandle = g?.kind === 'handle' ? g.drag.handle : null
    const shadow = liveStoreRef.current?.shadow ?? null
    const sel = objs.find((o) => o.id === selectedRef.current && !o.error) ?? null
    if (modeRef.current === 'rect' && sel && g?.kind !== 'rect') {
      const pk = `${sel.id}|${rectPoseKey(sel)}`
      if (pk !== rectPoseRef.current || rectObjectsRef.current !== objectsRef.current) {
        rectPoseRef.current = pk
        rectObjectsRef.current = objectsRef.current
        if (rectRef.current?.id !== sel.id) {
          if (rectTimerRef.current) clearTimeout(rectTimerRef.current)
          rectTimerRef.current = null
          fetchRect(sel.id)
        } else scheduleRect(sel.id)
      }
    }
    const mids = rectMultiIds()
    if (mids && g?.kind !== 'rect') {
      const want = new Set(mids)
      const key = mids.join('\n')
      const pk = `${key}|${objs.filter((o) => want.has(o.id)).map(rectPoseKey).join(';')}`
      if (pk !== multiPoseRef.current || multiObjectsRef.current !== objectsRef.current) {
        multiPoseRef.current = pk
        multiObjectsRef.current = objectsRef.current
        if (multiInfoRef.current?.key !== key) {
          if (multiTimerRef.current) clearTimeout(multiTimerRef.current)
          multiTimerRef.current = null
          fetchMulti(mids)
        } else scheduleMulti(mids)
      }
    }
    const hp = unityToolRef.current ? null : handlePose(objs, sel, g)
    const key = overlayKey(objs, sel)
    if (hp) key.push(...hp.position, ...hp.rotation)
    const wrapEl = wrapRef.current
    if (wrapEl) {
      const at = hp ? toScreen(cam, hp.position, w, h) : null
      const v = at ? `${at[0].toFixed(1)},${at[1].toFixed(1)}` : ''
      const seq = String(frameSeqRef.current)
      if (wrapEl.dataset.handleSeq !== seq) wrapEl.dataset.handleSeq = seq
      if (wrapEl.dataset.handleAt !== v) wrapEl.dataset.handleAt = v
    }
    const d = drawnRef.current
    if (
      d &&
      sameCam(d.cam, cam) &&
      sameKey(d.key, key) &&
      d.selected === selectedRef.current &&
      d.selection === selectionRef.current &&
      d.pivot === pivotRef.current &&
      d.hovered === hoverRef.current &&
      d.hoverHandle === hoverHandleRef.current &&
      d.activeHandle === activeHandle &&
      d.mode === modeRef.current &&
      d.space === spaceRef.current &&
      d.w === w &&
      d.h === h &&
      d.shadow === shadow &&
      d.rect === rectVersionRef.current &&
      d.icons === iconsRef.current &&
      d.poses === framePoseVerRef.current &&
      d.trails === trailsRef.current
    )
      return
    drawnRef.current = {
      cam: { position: cam.position, rotation: cam.rotation, fov: cam.fov, ortho: cam.ortho },
      key,
      selected: selectedRef.current,
      selection: selectionRef.current,
      pivot: pivotRef.current,
      hovered: hoverRef.current,
      hoverHandle: hoverHandleRef.current,
      activeHandle,
      mode: modeRef.current,
      space: spaceRef.current,
      w,
      h,
      shadow,
      rect: rectVersionRef.current,
      icons: iconsRef.current,
      poses: framePoseVerRef.current,
      trails: trailsRef.current
    }
    const ov = overlayRef.current
    let drewGl = false
    if (ov) {
      ov.update(
        {
          camera: cam,
          planar: planarRef.current,
          handle: hp,
          mode: handleMode(),
          space: spaceRef.current,
          hoverHandle: hoverHandleRef.current,
          activeHandle
        },
        current.aspect,
        h
      )
    }
    if (ov && ov.hasContent) {
      ov.render(canvas)
      drewGl = true
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const pw = Math.round(canvas.clientWidth * dpr)
    const ph = Math.round(canvas.clientHeight * dpr)
    if (!drewGl && (canvas.width !== pw || canvas.height !== ph)) {
      canvas.width = pw
      canvas.height = ph
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    if (!drewGl) ctx.clearRect(0, 0, canvas.width, canvas.height)
    const multiIds = selectionRef.current.ids.length > 1 ? new Set(selectionRef.current.ids) : undefined
    const layout = markerLayout(cam, w, h, objs, selectedRef.current, hoverRef.current, shadow, multiIds)
    const markerDpr = canvas.width / Math.max(1, canvas.clientWidth)
    const spots = sceneIconSpots(cam, w, h, iconsRef.current, iconStyleRef.current)
    iconSpotsRef.current = spots
    if (iconTraceOn()) {
      const at = hp ? toScreen(cam, hp.position, w, h) : null
      const pr = iconTraceProbe()
      const po = pr ? objs.find((o) => o.path === pr || o.path.endsWith(`/${pr}`)) : null
      const ps = po ? toScreen(cam, po.position, w, h) : null
      iconTraceDraw(frameSeqRef.current, spots, at ? [at[0], at[1]] : null, ps ? [ps[0], ps[1]] : null)
    }
    const iconData = spots.map((s) => `${s.kind}:${Math.round(s.x)},${Math.round(s.y)},${s.members.length}:${s.id}:${s.scale.toFixed(2)}`).join(';')
    if (wrapRef.current && wrapRef.current.dataset.sceneIcons !== iconData) wrapRef.current.dataset.sceneIcons = iconData
    const accent = chromeRef.current.markers?.accent ?? [56, 189, 248]
    drawSceneIcons(ctx, spots, markerDpr, { hover: iconHoverRef.current, selected: new Set([...selectionRef.current.ids, ...(selectedRef.current ? [selectedRef.current] : [])]), accent: `rgb(${accent.join(',')})` })
    const trailList = trailsRef.current
    if (trailList?.length || wrapRef.current?.dataset.stagingTrails) {
      const drew = drawStagingTrails(ctx, trailList ?? [], (p) => {
        const s = toScreen(cam, p, w, h)
        return s ? [s[0], s[1]] : null
      }, markerDpr)
      const td = trailList?.length ? `${drew.drawn}:${trailList.reduce((a, t) => a + t.points.length, 0)}:${drew.last ? `${Math.round(drew.last[0])},${Math.round(drew.last[1])}` : ''}` : ''
      if (wrapRef.current && wrapRef.current.dataset.stagingTrails !== td) {
        if (td) wrapRef.current.dataset.stagingTrails = td
        else delete wrapRef.current.dataset.stagingTrails
      }
    }
    drawMarkers(ctx, layout, markerDpr, chromeRef.current.markers)
    layoutRef.current = layout
    const rect = rectFor(sel?.id ?? null)
    const wrap = wrapRef.current
    if (wrap && !rect) delete wrap.dataset.rectTool
    if (rect) {
      const project = (p: Vec3): V2 | null => {
        const s = toScreen(cam, p, w, h)
        return s ? [s[0], s[1]] : null
      }
      const sc = rectScreen(rect, project)
      if (wrap) wrap.dataset.rectTool = sc ? JSON.stringify(rectToolDataset(rect, sc)) : ''
      if (sc) {
        const active = g?.kind === 'rect' ? g.handle : null
        drawRectTool(ctx, rect, sc, project, {
          hover: rectHoverRef.current,
          active,
          labels: !active || active.kind === 'rotate' || rect.renderer ? 'none' : active.kind === 'anchor' ? 'anchors' : 'distances',
          colors: rectColorsRef.current,
          dpr: canvas.width / Math.max(1, canvas.clientWidth)
        })
      }
    }
    if (handleTraceOn() && sel) {
      const m = handleMode()
      handleTraceRecord(sel.path, isRectObject(sel.id), rect ? 'rect' : m !== 'rect' && hp && hasMoveTool(sel) ? m : 'none')
    }
    drawSceneGizmo(ctx, canvas, cam.rotation)
  }

  const releaseDragHold = (): void => {
    if (!dragHeldRef.current || gestureRef.current?.kind === 'handle') return
    dragHeldRef.current = false
    dragPoseRef.current = null
    dragVerRef.current++
  }

  const takeFramePoses = (list: TunerPose[] | undefined): void => {
    const m = framePosesRef.current
    let changed = false
    for (const id of [...m.keys()])
      if (id[0] !== 'o' && !list?.some((p) => p.id === id)) {
        m.delete(id)
        changed = true
      }
    if (list)
      for (const p of list) {
        m.set(p.id, p)
        changed = true
      }
    if (changed) framePoseVerRef.current++
    if (transformsAcked(session)) releaseDragHold()
  }

  const requestDraw = (): void => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      if (imageDirtyRef.current) drawImageLayer()
      drawOverlay()
    })
  }

  useEffect(() => {
    requestDraw()
  }, [iconStyle?.use3d, iconStyle?.texelWorldSize])

  useEffect(() => {
    requestDraw()
  }, [trails])


  useEffect(() => {
    if (!glOk) return
    overlayRef.current = new SceneOverlay()
    drawnRef.current = null
    requestDraw()
    return () => {
      overlayRef.current?.dispose()
      overlayRef.current = null
    }
  }, [glOk])

  useEffect(() => {
    if (!liveStore) return
    return liveStore.subscribe(requestDraw)
  }, [liveStore])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      sizeRef.current = { w: r.width, h: r.height }
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const c = imgRef.current
      if (c) {
        c.width = Math.max(1, Math.round(r.width * dpr))
        c.height = Math.max(1, Math.round(r.height * dpr))
      }
      imageDirtyRef.current = true
      drawnRef.current = null
      frameInitialRef.current()
      if (orbitRef.current) sendCamera()
      requestDraw()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onInput = (e: Event): void => loopInput(e.timeStamp)
    const onPaint = (e: Event): void => {
      const c = e.target as HTMLCanvasElement
      loopPaint(Number(c.dataset.paintSid), Number(c.dataset.paintAt))
    }
    const kinds = ['pointermove', 'pointerdown', 'wheel', 'keydown']
    for (const k of kinds) el.addEventListener(k, onInput, { capture: true, passive: true })
    el.addEventListener('unitypaint', onPaint, true)
    return () => {
      for (const k of kinds) el.removeEventListener(k, onInput, { capture: true })
      el.removeEventListener('unitypaint', onPaint, true)
    }
  }, [])

  useEffect(() => {
    let count = 0
    let lastFps = -1
    let windowStart = performance.now()
    const showSurface = (shown: boolean, flipY: boolean): void => {
      const v = surfaceViewRef.current
      if (v.shown === shown && v.flipY === flipY) return
      surfaceViewRef.current = { shown, flipY }
      setSurfaceView({ shown, flipY })
    }
    const off = window.api.tuner.onFrame((e) => {
      if (e.projectPath !== projectPath || e.meta.session !== session) return
      noteFrameAck(session, e.meta.ack, performance.now())
      loopFrame(e.meta.lt, e.surface.surfaceId, e.meta.ack, e.meta.xr)
      if (e.meta.icons) iconsRef.current = e.meta.icons
      showSurface(true, e.surface.flipY)
      frameCamRef.current = e.meta.camera
      frameSeqRef.current = e.meta.seq
      const fw = wrapRef.current
      if (fw) {
        fw.dataset.unityFrame = String(e.meta.seq)
        fw.dataset.unityFrameCam = e.meta.camera ? e.meta.camera.position.map((v) => v.toFixed(3)).join(',') : ''
      }
      takeFramePoses(e.meta.poses)
      count++
      iconTraceFrame(e.meta.seq, e.meta.icons, e.meta.poses?.length ?? 0)
      drawOverlay()
      if (iconTraceOn()) iconTracePaint(e.meta.seq, fw?.querySelector<HTMLCanvasElement>('canvas[data-unity-session]') ?? null, sizeRef.current.w, sizeRef.current.h, e.surface.flipY)
    })
    const tick = setInterval(() => {
      const now = performance.now()
      const fps = Math.round((count * 1000) / Math.max(1, now - windowStart))
      count = 0
      windowStart = now
      if (fps === lastFps) return
      lastFps = fps
      onFps?.(fps)
    }, 1000)
    return () => {
      off()
      clearInterval(tick)
      frameCamRef.current = null
      surfaceViewRef.current = { shown: false, flipY: false }
      setSurfaceView({ shown: false, flipY: false })
      window.api.tuner.dropSurface(projectPath, session)
      forgetTransformLatency(session)
    }
  }, [projectPath, session])

  const frameInitialRef = useRef<(bounds?: boolean) => void>(() => {})
  const frameWhyRef = useRef('')
  frameInitialRef.current = (bounds = false) => {
    if (isPhoneView()) return
    const why = orbitMemory.orbit ? '' : startSeq === viewStartRef.current ? 'view not started yet' : wholeScene && sceneBounds === undefined ? 'no scene bounds yet' : !wholeScene && objects.length === 0 ? 'no objects yet' : sizeRef.current.w < 2 || sizeRef.current.h < 2 ? 'no viewport size yet' : ''
    if (why && why !== frameWhyRef.current) debugLog(`[tuner] initial frame waits: ${why}`)
    frameWhyRef.current = why
    if (orbitMemory.orbit || startSeq === viewStartRef.current || (wholeScene ? sceneBounds === undefined : objects.length === 0)) return
    if (orbitRef.current) {
      stopAnim()
      orbitRef.current = null
    }
    const { w, h } = sizeRef.current
    if (w < 2 || h < 2) return
    if (frameSelectionFirst && !bounds && !cameraSpec) {
      if (!selectedRef.current) return
      if (pendingFrameRef.current?.instant) return
      if (runFrame(true) || pendingFrameRef.current) return
    }
    if (cameraSpec) orbitRef.current = fitMode(orbitFromLookAt(cameraSpec.position, cameraSpec.lookAt))
    else {
      const b = (wholeScene ? sceneBoundsRef.current : null) ?? boundsOf(objects)
      const base = fitMode(defaultOrbit())
      const framed = b ? frameBounds(base, b, w / h, wholeScene && sceneBoundsRef.current ? 1 : INITIAL_FRAME_PAD) : base
      const fogCap = b?.fog ? b.fog * FOG_FRAME_SHARE : 0
      orbitRef.current = fogCap > 0 && !framed.ortho && framed.distance > fogCap ? { ...framed, distance: fogCap } : framed
      debugLog(`[tuner] initial frame bounds ${b ? `${b.center.map((v) => v.toFixed(2)).join(',')} size ${b.size.map((v) => v.toFixed(2)).join(',')}` : 'none'} ortho=${orbitRef.current.ortho?.toFixed(2) ?? '-'} view=${w}x${h}`)
    }
    orbitMemory.orbit = orbitRef.current
    sendCamera(true)
  }

  useEffect(() => {
    if (!live) return
    const mem = orbitMemory
    if (startSeq === viewStartRef.current) return
    if (isPhoneView()) {
      sendTunerMirror({ projectPath, session, ask: true })
      const ask = setInterval(() => {
        if (mem.orbit) clearInterval(ask)
        else sendTunerMirror({ projectPath, session, ask: true })
      }, 1000)
      return () => clearInterval(ask)
    }
    const t = setTimeout(() => {
      if (mem.orbit || orbitMemoryRef.current !== mem) return
      const { w, h } = sizeRef.current
      const b = sceneBoundsRef.current ?? boundsOf(objectsRef.current)
      debugLog(`[tuner] initial frame forced after 1s: bounds=${b ? 'ok' : 'none'} sceneBounds=${sceneBoundsRef.current ? 'ok' : 'none'} objects=${objectsRef.current.length} view=${w}x${h}`)
      if (w < 2 || h < 2) return
      stopAnim()
      const base = fitMode(defaultOrbit())
      orbitRef.current = b ? frameBounds(base, b, w / h, sceneBoundsRef.current ? 1 : INITIAL_FRAME_PAD) : base
      mem.orbit = orbitRef.current
      sendCamera(true)
      requestDraw()
    }, 1000)
    return () => clearTimeout(t)
  }, [orbitMemory, live, startSeq])

  useEffect(() => {
    frameInitialRef.current()
  }, [objects, cameraSpec, wholeScene, sceneBounds, orbitMemory, selected, startSeq])

  useEffect(() => {
    if (live) {
      sendCamera(true)
      window.api.tuner.surface(projectPath, session)
    } else frameCamRef.current = null
    requestDraw()
  }, [live, startSeq])

  useEffect(() => {
    const apply = (): void => {
      const next = readTunerTheme()
      const changed = !sameTheme(next, themeRef.current)
      themeRef.current = next
      if (changed) {
        const elevated = readCssRgb('--elevated')
        const accent = readCssRgb('--accent')
        const sunken = readCssRgb('--sunken')
        chromeRef.current = {
          markers: accent && sunken ? { accent, ring: sunken } : undefined
        }
        const ink = readCssRgb('--ink')
        const ink2 = readCssRgb('--ink-2')
        const ink3 = readCssRgb('--ink-3')
        const rgba = (c: [number, number, number] | null, a: number, fallback: string): string => (c ? `rgba(${c[0]},${c[1]},${c[2]},${a})` : fallback)
        const prev = rectColorsRef.current
        rectColorsRef.current = {
          accent: rgba(accent, 1, prev.accent),
          outline: rgba(ink2, 0.9, prev.outline),
          parent: rgba(ink3, 0.75, prev.parent),
          label: rgba(ink, 1, prev.label),
          labelBg: rgba(elevated, 0.92, prev.labelBg),
          shadow: prev.shadow
        }
        rectVersionRef.current++
        imageDirtyRef.current = true
        drawnRef.current = null
        requestDraw()
      }
      if (next && liveRef.current) window.api.tuner.theme(projectPath, session, next)
    }
    apply()
    return watchTheme(apply)
  }, [projectPath, session, live])

  const selPath = selectedPath?.path ?? null
  const selScene = selectedPath?.scene ?? null
  useEffect(() => {
    const path = selPath ?? effectiveObjects().find((o) => o.id === selected)?.path ?? null
    const picked = expectSelRef.current !== undefined && (expectSelRef.current === selected || (path !== null && path === activePathRef.current))
    if (!picked) {
      activePathRef.current = path
      cycleRef.current = newPickCycle()
    }
    expectSelRef.current = undefined
  }, [projectPath, session, live, selected, selPath, selScene])

  const selIdsKey = selection.ids.length > 1 ? selection.ids.join('\n') : ''
  const ghostsKey = ghosts.join('\n')
  useEffect(() => {
    if (!live) return
    const base: TunerSceneSelection | null = selPath ? { path: selPath, scene: selScene ?? undefined } : selected ? { id: selected } : null
    const ids = selIdsKey ? selIdsKey.split('\n') : []
    const extra = ghostsKey ? ghostsKey.split('\n') : []
    const lens = focus ? { focusOn: true, focus: focus.ids, ...(focus.tree ? { focusTree: true } : {}), ...(focus.context ? { context: true } : {}) } : {}
    window.api.tuner.sceneSelection(
      projectPath,
      session,
      base || ids.length || extra.length || focus ? { ...(base ?? {}), ...(ids.length ? { ids } : {}), ...(extra.length ? { ghosts: extra } : {}), ...lens } : null
    )
  }, [projectPath, session, live, selected, selPath, selScene, selIdsKey, ghostsKey, focus])

  const cameraKeyRef = useRef(cameraKey)
  useEffect(() => {
    if (cameraKeyRef.current === cameraKey) return
    cameraKeyRef.current = cameraKey
    if (cameraSpec && orbitRef.current) setOrbit(fitMode(orbitFromLookAt(cameraSpec.position, cameraSpec.lookAt)))
  }, [cameraKey, cameraSpec])

  useEffect(() => {
    const o = orbitRef.current
    if (!o) return
    const next = fitMode(o)
    if (next === o) return
    stopAnim()
    const { w, h } = sizeRef.current
    const b = boundsOf(effectiveObjects())
    setOrbit(b ? frameBounds(next, b, w / Math.max(1, h)) : next)
    sendCamera(true)
  }, [planar])

  useEffect(() => setMenu(null), [live, planar, frameSignal, frameBox?.seq, viewTo?.seq])

  const frameBoxSeqRef = useRef(0)
  useEffect(() => {
    if (!frameBox || frameBox.seq === frameBoxSeqRef.current) return
    frameBoxSeqRef.current = frameBox.seq
    stopAnim()
    const { w, h } = sizeRef.current
    setOrbit(frameBounds(fitMode(baseOrbit()), frameBox.bounds, w / Math.max(1, h), 1.04))
    sendCamera(true)
  }, [frameBox?.seq, planar])

  useEffect(() => {
    const o = orbitRef.current
    if (!o || !!o.orthographic === (orthographic && !planarRef.current)) return
    stopAnim()
    setOrbit(o)
    sendCamera(true)
  }, [orthographic])

  const frameCover = (): number => {
    const wrap = wrapRef.current
    if (!wrap) return 0
    let n = wrap.parentElement
    while (n && !n.querySelector(':scope > [data-tuner-timeline-overlay]')) n = n.parentElement
    const tl = n?.querySelector(':scope > [data-tuner-timeline-overlay]')?.firstElementChild
    if (!tl) return 0
    const a = wrap.getBoundingClientRect()
    const b = tl.getBoundingClientRect()
    if (a.height <= 0 || b.right <= a.left || b.left >= a.right) return 0
    return Math.min(0.8, Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) / a.height)
  }

  const coverBase = (cover: number): Orbit => {
    const o = baseOrbit()
    if (cover <= 0 || o.ortho) return o
    return { ...o, fov: MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(o.fov) / 2) * (1 - cover))) }
  }

  const uncover = (o: Orbit, cover: number): Orbit => {
    if (cover <= 0) return o
    const h = sizeRef.current.h
    const out = o.ortho ? { ...o, ortho: o.ortho / (1 - cover) } : { ...o, fov: baseOrbit().fov }
    return orbitPan(out, 0, (-h * cover) / 2, h)
  }

  const frameSubject = (cover = 0): { key: string; orbit: Orbit; at: Vec3; close?: number; bounds?: TunerBounds } | 'pending' | null => {
    const { w, h } = sizeRef.current
    const aspect = w / Math.max(1, h * (1 - cover))
    const base = coverBase(cover)
    const sel = selectedRef.current
    const objs = effectiveObjects()
    const many = selectionObjects(objs)
    if (many.length > 1) {
      const mb = unionBounds(many.map((o) => o.bounds ?? pointBounds([o.position], 0.5)))
      if (mb) {
        const orbit = frameBounds(base, mb, aspect)
        return { key: `many:${selectionRef.current.ids.join(',')}`, orbit, at: orbit.target }
      }
    }
    const obj = sel ? objs.find((o) => o.id === sel && framable(o)) : undefined
    if (obj) {
      const others = objs.filter((o) => o.id !== obj.id && !o.error).map((o) => o.bounds)
      const orbit = focusObjectOrbit(base, obj, others, aspect)
      return { key: `obj:${obj.id}`, orbit, at: orbit.target, bounds: cameraFrameBounds(obj) ?? undefined }
    }
    if (sel && wholeScene) return 'pending'
    const b = (wholeScene ? null : boundsOf(objs)) ?? sceneBoundsRef.current
    if (!b) return null
    const orbit = frameBounds(base, b, aspect)
    return { key: 'all', orbit, at: orbit.target }
  }

  const clearSeqRef = useRef(0)
  const focusSeqRef = useRef(0)
  const focusBusyRef = useRef(false)
  const clearView = async (to: Orbit, id: string, cover: number, above = false): Promise<Orbit | null> => {
    const seq = ++clearSeqRef.current
    const start = orbitRef.current
    const { w, h } = sizeRef.current
    const [pw, ph] = outputSize(w, h, window.devicePixelRatio || 1)
    const tries = ([[0, 0, 1], [0, 0, 0.6], [0, 0, 0.35], [35, 0, 1], [-35, 0, 1], [0, 30, 1], [35, 0, 0.6], [-35, 0, 0.6], [0, 30, 0.6], [70, 0, 1], [-70, 0, 1], [35, 30, 1], [-35, 30, 1], [0, 55, 1], [180, 0, 1], [180, 0, 0.6], [0, -40, 0.6], [90, -40, 0.6], [-90, -40, 0.6], [180, -40, 0.6], [0, 0, 0.2], [0, -40, 0.3]] as [number, number, number][]).filter(([dy, dp]) => !above || (dp >= 0 && Math.abs(dy) < 180))
    const cands = tries.map(([dy, dp, k]): Orbit => (dy === 0 && dp === 0 && k === 1 ? to : { ...to, yaw: ((((to.yaw + dy + 180) % 360) + 360) % 360) - 180, pitch: Math.max(-80, Math.min(85, to.pitch + dp)), distance: Math.max(MIN_DISTANCE, to.distance * k) }))
    const res = await window.api.tuner
      .clearView(projectPath, session, { id, x: 0.5, y: 0.5 * (1 - cover), width: pw, height: ph, fov: to.fov, cams: cands.map((c) => orbitCamera(c, pw, ph)) })
      .catch(() => null)
    if (seq !== clearSeqRef.current || orbitRef.current !== start) return null
    if (!res || !res.ok || res.data.index <= 0) {
      debugLog(`[tuner] frame ${id}: ${!res ? 'view check failed' : !res.ok ? `view check failed: ${res.error}` : res.data.index < 0 ? 'blocked from every angle tried' : 'clear'}`)
      return to
    }
    const [dy, dp, k] = tries[res.data.index]
    debugLog(`[tuner] frame ${id}: view blocked, turned ${dy}° yaw, ${dp}° pitch, distance x${k}`)
    return cands[res.data.index]
  }

  const runFrame = (instant = false): boolean => {
    const cover = frameCover()
    const sub = frameSubject(cover)
    if (sub === 'pending') {
      const pending = { id: selectedRef.current ?? '', until: Date.now() + FRAME_WAIT_MS, instant }
      pendingFrameRef.current = pending
      if (instant)
        setTimeout(() => {
          if (pendingFrameRef.current !== pending || orbitRef.current) return
          pendingFrameRef.current = null
          debugLog(`[tuner] initial frame fell back to bounds (selected ${selectedRef.current ?? '-'} never arrived)`)
          frameInitialRef.current(true)
        }, 800)
      return false
    }
    pendingFrameRef.current = null
    if (!sub) return false
    const level = nextFrameLevel(frameMemoRef.current, sub.key, orbitRef.current, animRef.current !== 0)
    const { w: fw, h: fh } = sizeRef.current
    const to = uncover(instant && sub.bounds ? frameBounds(coverBase(cover), sub.bounds, fw / Math.max(1, fh * (1 - cover)), INITIAL_FRAME_PAD) : frameLevel(sub.orbit, level, sub.close), cover)
    frameMemoRef.current = { key: sub.key, level, orbit: to }
    const wrap = wrapRef.current
    if (wrap) {
      wrap.dataset.frameKey = sub.key
      wrap.dataset.frameLevel = String(level)
      wrap.dataset.frameAt = JSON.stringify(sub.at.map((v) => Math.round(v * 1e6) / 1e6))
      wrap.dataset.frameSeq = String(Number(wrap.dataset.frameSeq ?? 0) + 1)
    }
    if (!instant && sub.key.startsWith('obj:') && liveRef.current && !planarRef.current && !to.ortho) {
      void clearView(to, sub.key.slice(4), cover).then((best) => {
        if (!best) return
        if (frameMemoRef.current?.orbit === to) frameMemoRef.current = { key: sub.key, level, orbit: best }
        animateTo(best)
      })
      return true
    }
    if (instant) {
      debugLog(`[tuner] initial frame ${sub.key} at ${sub.at.map((v) => v.toFixed(2)).join(',')} ortho=${to.ortho?.toFixed(2) ?? '-'} dist=${to.distance.toFixed(2)} size=${sizeRef.current.w}x${sizeRef.current.h}`)
      stopAnim()
      setOrbit(to)
      sendCamera(true)
    } else animateTo(to)
    return true
  }

  useEffect(() => {
    if (frameSignal === 0) return
    wheelRef.current = blockWheel(wheelRef.current)
    runFrame()
  }, [frameSignal])

  const camState = (): CameraState | null => {
    const o = orbitRef.current
    if (!o) return null
    const r6 = (v: number): number => Math.round(v * 1e6) / 1e6
    return {
      target: o.target.map(r6),
      yaw: r6(o.yaw),
      pitch: r6(o.pitch),
      distance: r6(o.distance),
      ortho: o.ortho ? r6(o.ortho) : orthoRef.current ? r6(orbitOrthoSize(o)) : null,
      view: planarRef.current ? '2D' : gizmoCaption(o, !!o.ortho || orthoRef.current),
      animating: animRef.current !== 0 || focusBusyRef.current
    }
  }

  const camSubject = (cmd: CameraCmd): { bounds: TunerBounds; label: string; point: Vec3 | null } | { missing: string[] } | null => {
    const objs = effectiveObjects().filter((o) => !o.error)
    const under = (roots: TunerObject[]): TunerObject[] => objs.filter((o) => roots.some((r) => o === r || (o.scene === r.scene && o.path.startsWith(`${r.path}/`))))
    const boundsFor = (list: TunerObject[]): TunerBounds | null => (list.some((o) => o.bounds) ? unionBounds(list.map((o) => o.bounds)) : unionBounds(list.map((o) => pointBounds([o.position], 0.5))))
    const scene = (): { bounds: TunerBounds; label: string; point: null } | null => {
      const b = sceneBoundsRef.current ?? boundsOf(objs)
      return b ? { bounds: b, label: 'the whole scene', point: null } : null
    }
    if (cmd.paths === null) return scene()
    if (!cmd.paths) {
      const sel = selectionRef.current.ids.length ? selectionRef.current.ids : selectedRef.current ? [selectedRef.current] : []
      const roots = objs.filter((o) => sel.includes(o.id))
      const b = roots.length ? boundsFor(under(roots)) : null
      if (!b) return scene()
      return { bounds: b, label: roots.length === 1 ? roots[0].path || roots[0].label : `${roots.length} selected objects`, point: roots.length === 1 ? roots[0].position : null }
    }
    const roots: TunerObject[] = []
    const missing: string[] = []
    for (const raw of cmd.paths) {
      const p = String(raw).replace(/^\/+|\/+$/g, '')
      let hit = objs.filter((o) => o.path === p || `${o.scene}/${o.path}` === p)
      if (!hit.length) hit = objs.filter((o) => o.path.endsWith(`/${p}`))
      if (!hit.length) hit = objs.filter((o) => o.path.startsWith(`${p}/`) || `${o.scene}/${o.path}`.startsWith(`${p}/`))
      if (!hit.length) missing.push(p)
      for (const o of hit) if (!roots.includes(o)) roots.push(o)
    }
    if (missing.length) return { missing }
    const b = boundsFor(under(roots))
    if (!b) return null
    return { bounds: b, label: roots.length === 1 ? roots[0].path || roots[0].label : roots.map((o) => o.label || o.path).join(', '), point: roots.length === 1 ? roots[0].position : null }
  }

  const camFramed = (b: TunerBounds, pivot: Vec3 | null): boolean => {
    const o = orbitRef.current
    const { w, h } = sizeRef.current
    if (!o || w < 2 || h < 2) return false
    const cover = frameCover()
    const cam = orbitCamera(o, w, h)
    const aspect = w / h
    const bottom = -1 + 2 * cover
    const pts: Vec3[] = []
    for (let i = 0; i < 8; i++) pts.push([0, 1, 2].map((k) => b.center[k] + (((i >> k) & 1) ? 0.5 : -0.5) * b.size[k]) as Vec3)
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const p of pts) {
      const n = projectPoint(cam, p, aspect)
      if (!n) return false
      x0 = Math.min(x0, n[0])
      x1 = Math.max(x1, n[0])
      y0 = Math.min(y0, n[1])
      y1 = Math.max(y1, n[1])
    }
    const m = 0.06
    if (x0 < -1 + m || x1 > 1 - m || y0 < bottom + m || y1 > 1 - m) return false
    if (pivot) {
      const n = projectPoint(cam, pivot, aspect)
      if (!n || Math.abs(n[0]) > 0.55 || Math.abs(n[1] - (1 + bottom) / 2) > (0.55 * (1 - bottom)) / 2) return false
    }
    return Math.max((x1 - x0) / 2, (y1 - y0) / (1 - bottom)) >= 0.3
  }

  const camMove = (to: Orbit, ms: number): number => {
    const t = Math.max(0, Math.min(5000, Math.round(ms)))
    wheelRef.current = blockWheel(wheelRef.current)
    if (t === 0) {
      stopAnim()
      setOrbit(fitMode(to))
      sendCamera(true)
    } else animateTo(fitMode(to), t, easeInOutCubic)
    return t
  }

  const cameraOp = (cmd: CameraCmd): CameraReply => {
    const { w, h } = sizeRef.current
    if (cmd.op === 'get') return { ok: true, state: camState() }
    if (!orbitRef.current || w < 40 || h < 40) return { ok: false, why: 'the Tuner viewport is not showing yet' }
    if (cmd.auto && gestureRef.current) return { ok: false, why: 'busy' }
    const ms = typeof cmd.ms === 'number' && Number.isFinite(cmd.ms) ? cmd.ms : CAMERA_MS
    const o = orbitRef.current
    const planar = planarRef.current
    if (cmd.op === 'frame') {
      if (!cmd.paths && cmd.paths !== null && !cmd.pivot && wholeScene && selectedRef.current && !effectiveObjects().some((o) => o.id === selectedRef.current)) {
        runFrame()
        return { ok: true, moved: true, subject: 'the selection', ms: ms + 400 }
      }
      const sub = camSubject(cmd)
      if (!sub) return { ok: false, why: 'nothing in the viewport to frame' }
      if ('missing' in sub) return { ok: false, missing: sub.missing, why: `the viewport shows no ${sub.missing.join(', ')}` }
      let b = sub.bounds
      if (cmd.pivot && sub.point) {
        const p = sub.point
        const half = [0, 1, 2].map((k) => Math.max(Math.abs(b.center[k] - b.size[k] / 2 - p[k]), Math.abs(b.center[k] + b.size[k] / 2 - p[k]), 0.25)) as Vec3
        b = { center: [...p] as Vec3, size: half.map((v) => v * 2) as Vec3 }
      }
      if (cmd.auto && camFramed(b, cmd.pivot ? sub.point : null)) return { ok: true, moved: false, subject: sub.label, state: camState() }
      const cover = frameCover()
      const pad = typeof cmd.pad === 'number' && cmd.pad > 0 ? cmd.pad : cmd.pivot ? 1.25 : 1.1
      const to = uncover(frameBounds(coverBase(cover), b, w / Math.max(1, h * (1 - cover)), pad), cover)
      return { ok: true, moved: true, subject: sub.label, ms: camMove(to, ms) }
    }
    if (cmd.op === 'focus') {
      const sel = selectedRef.current
      const objs = effectiveObjects()
      const obj = sel ? objs.find((x) => x.id === sel && framable(x)) : undefined
      if (!obj) return { ok: false, why: sel ? 'pending' : 'nothing is selected' }
      if (cmd.solid && !obj.bounds) return { ok: true, moved: false, invisible: true, subject: obj.path || obj.label }
      const cover = frameCover()
      const base = coverBase(cover)
      if (cmd.nice && obj.bounds && !planar && !base.ortho) {
        const aspect = w / Math.max(1, h * (1 - cover))
        const to = uncover(shotOrbit(base, { bounds: obj.bounds, rotation: obj.rotation }, aspect, sceneBoundsRef.current ?? null), cover)
        const t = Math.max(0, Math.min(5000, Math.round(ms)))
        const label = obj.path || obj.label
        if (t > 0 && liveRef.current) {
          const seq = ++focusSeqRef.current
          focusBusyRef.current = true
          const done = (best: Orbit | null): void => {
            if (focusSeqRef.current !== seq) return
            focusBusyRef.current = false
            debugLog(`[tuner] shot ${label}: dist=${(best ?? to).distance.toFixed(2)} yaw=${(best ?? to).yaw.toFixed(0)} pitch=${(best ?? to).pitch.toFixed(0)} fogClear=${sceneBoundsRef.current?.fogClear ?? '-'}`)
            camMove(best ?? to, t)
          }
          void clearView(to, obj.id, cover, true).then(done, () => done(null))
          return { ok: true, moved: true, subject: label, ms: t }
        }
        return { ok: true, moved: true, subject: label, ms: camMove(to, t) }
      }
      const angle = focusAngle(base, obj, cmd)
      if (typeof angle === 'string') return { ok: false, why: angle }
      const aspect = w / Math.max(1, h * (1 - cover))
      const others = objs.filter((x) => x.id !== obj.id && !x.error).map((x) => x.bounds)
      const fit = focusObjectOrbit(planar ? base : { ...base, yaw: angle.yaw, pitch: angle.pitch }, obj, others, aspect)
      const pad = typeof cmd.pad === 'number' && cmd.pad > 0 ? cmd.pad : FOCUS_PAD
      const want = typeof cmd.distance === 'number' && cmd.distance > 0 ? cmd.distance : fit.distance * pad
      const to = uncover(fit.ortho ? { ...fit, ortho: fit.ortho * pad } : { ...fit, distance: Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, want)) }, cover)
      const t = Math.max(0, Math.min(5000, Math.round(ms)))
      const label = obj.path || obj.label
      if (angle.free && t > 0 && liveRef.current && !planar && !to.ortho) {
        const seq = ++focusSeqRef.current
        focusBusyRef.current = true
        const done = (best: Orbit | null): void => {
          if (focusSeqRef.current !== seq) return
          focusBusyRef.current = false
          camMove(best ?? to, t)
        }
        void clearView(to, obj.id, cover).then(done, () => done(null))
        return { ok: true, moved: true, subject: label, ms: t }
      }
      return { ok: true, moved: true, subject: label, ms: camMove(to, t) }
    }
    if (cmd.op === 'box') {
      const sub = camSubject(cmd)
      if (!sub) return { ok: false, why: 'nothing in the viewport to point at' }
      if ('missing' in sub) return { ok: false, missing: sub.missing, why: `the viewport shows no ${sub.missing.join(', ')}` }
      const cam = orbitCamera(o, w, h)
      const aspect = w / Math.max(1, h)
      let x0 = Infinity
      let x1 = -Infinity
      let y0 = Infinity
      let y1 = -Infinity
      const b = sub.bounds
      let behind = false
      for (let i = 0; i < 8; i++) {
        const n = projectPoint(cam, [0, 1, 2].map((k) => b.center[k] + (((i >> k) & 1) ? 0.5 : -0.5) * b.size[k]) as Vec3, aspect)
        if (!n) {
          behind = true
          continue
        }
        x0 = Math.min(x0, n[0])
        x1 = Math.max(x1, n[0])
        y0 = Math.min(y0, n[1])
        y1 = Math.max(y1, n[1])
      }
      if (behind && !o.ortho) {
        const t = projectPoint(cam, o.target, aspect)
        if (t && Math.abs(t[0]) <= 1 && Math.abs(t[1]) <= 1 && b.center.every((c, k) => Math.abs(o.target[k] - c) <= Math.abs(b.size[k]) / 2 + 1e-3)) {
          x0 = t[0] - 0.3
          x1 = t[0] + 0.3
          y0 = t[1] - 0.3
          y1 = t[1] + 0.3
        }
      }
      if (!(x1 >= x0) || x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1) return { ok: true, box: null, inView: false, subject: sub.label }
      const inView = x0 >= -1 && x1 <= 1 && y0 >= -1 && y1 <= 1
      const c = (v: number): number => Math.max(-1, Math.min(1, v))
      const r = (wrapRef.current as HTMLElement).getBoundingClientRect()
      const sx = (v: number): number => r.left + ((c(v) + 1) / 2) * r.width
      const sy = (v: number): number => r.top + ((1 - c(v)) / 2) * r.height
      return { ok: true, box: { x: sx(x0), y: sy(y1), width: Math.max(1, sx(x1) - sx(x0)), height: Math.max(1, sy(y0) - sy(y1)) }, inView, subject: sub.label }
    }
    if (cmd.op === 'aim') {
      const want = String(cmd.paths?.[0] ?? '').replace(/^\/+|\/+$/g, '')
      const objs = effectiveObjects().filter((x) => !x.error)
      const obj = (want ? objs.find((x) => x.path === want || `${x.scene}/${x.path}` === want) ?? objs.find((x) => x.path.endsWith(`/${want}`)) : objs.find((x) => x.id === selectedRef.current)) ?? null
      if (!obj) return { ok: false, why: `the viewport shows no ${want || 'selection'}` }
      const current = currentCamera()
      const cam = liveRef.current && frameCamRef.current ? { ...frameCamRef.current, clip: current.cam.clip } : current.cam
      const under = objs.filter((x) => x === obj || (x.scene === obj.scene && x.path.startsWith(`${obj.path}/`)))
      const b = under.some((x) => x.bounds) ? unionBounds(under.map((x) => x.bounds)) : null
      let keep: GizmoAim['keep'] = null
      if (b) {
        let x0 = Infinity
        let x1 = -Infinity
        let y0 = Infinity
        let y1 = -Infinity
        for (let i = 0; i < 8; i++) {
          const n = toScreen(cam, [0, 1, 2].map((k) => b.center[k] + (((i >> k) & 1) ? 0.5 : -0.5) * b.size[k]) as Vec3, w, h)
          if (!n) continue
          x0 = Math.min(x0, n[0])
          x1 = Math.max(x1, n[0])
          y0 = Math.min(y0, n[1])
          y1 = Math.max(y1, n[1])
        }
        const cx0 = Math.max(0, x0)
        const cy0 = Math.max(0, y0)
        const cx1 = Math.min(w, x1)
        const cy1 = Math.min(h, y1)
        if (cx1 > cx0 && cy1 > cy0) keep = { x: cx0, y: cy0, width: cx1 - cx0, height: cy1 - cy0 }
      }
      const ov = overlayRef.current
      if (ov && ov.hasContent && !unityToolRef.current && selectedRef.current === obj.id) {
        const c = ov.centerPoint(w, h)
        if (c) return { ok: true, subject: obj.path, aim: { x: c.x, y: c.y, kind: 'gizmo', keep } }
      }
      const s = toScreen(cam, b ? b.center : obj.position, w, h)
      const c = s ? { x: s[0], y: s[1] } : keep ? { x: keep.x + keep.width / 2, y: keep.y + keep.height / 2 } : null
      if (!c) return { ok: true, subject: obj.path, aim: null, inView: false }
      return { ok: true, subject: obj.path, aim: { x: c.x, y: c.y, kind: 'center', keep } }
    }
    if (cmd.op === 'view') {
      if (planar) return { ok: true, moved: false, note: `the 2D view always faces the XY plane, so the camera stayed put instead of turning to the ${String(cmd.view ?? '').toLowerCase()} view` }
      const i = GIZMO_VIEW_NAMES.findIndex((n) => n.toLowerCase() === String(cmd.view ?? '').toLowerCase())
      if (i < 0) return { ok: false, why: `unknown view "${String(cmd.view)}": use ${GIZMO_VIEW_NAMES.map((n) => n.toLowerCase()).join(', ')}` }
      return { ok: true, moved: true, subject: `the ${GIZMO_VIEW_NAMES[i].toLowerCase()} view`, ms: camMove(snapOrbit(o, i), ms) }
    }
    if (cmd.op === 'orbit') {
      if (planar) return { ok: true, moved: false, note: 'the 2D view only pans and zooms, so the camera stayed put instead of orbiting' }
      const yaw = o.yaw + (Number(cmd.yaw) || 0)
      const pitch = Math.max(-89, Math.min(89, o.pitch + (Number(cmd.pitch) || 0)))
      return { ok: true, moved: true, ms: camMove({ ...o, yaw: ((((yaw + 180) % 360) + 360) % 360) - 180, pitch }, ms) }
    }
    if (cmd.op === 'zoom') {
      const f = Number(cmd.factor)
      if (!(f > 0) || !Number.isFinite(f)) return { ok: false, why: 'zoom needs a factor above 0, like 2 to get twice as close' }
      return { ok: true, moved: true, ms: camMove(orbitScale(o, 1 / f), ms) }
    }
    if (cmd.op === 'set') {
      const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
      const t = Array.isArray(cmd.target) && cmd.target.length === 3 && cmd.target.every((v) => typeof v === 'number' && Number.isFinite(v)) ? (cmd.target as Vec3) : o.target
      const to: Orbit = {
        ...o,
        target: [...t] as Vec3,
        yaw: planar ? o.yaw : num(cmd.yaw, o.yaw),
        pitch: planar ? o.pitch : Math.max(-89, Math.min(89, num(cmd.pitch, o.pitch))),
        distance: Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, num(cmd.distance, o.distance)))
      }
      if (o.ortho && typeof cmd.ortho === 'number' && cmd.ortho > 0) to.ortho = cmd.ortho
      const turned = planar && (typeof cmd.yaw === 'number' || typeof cmd.pitch === 'number')
      return { ok: true, moved: true, ms: camMove(to, ms), ...(turned ? { note: 'the 2D view always faces the XY plane, so yaw and pitch were left as they are' } : {}) }
    }
    return { ok: false, why: `unknown camera call ${String(cmd.op)}` }
  }
  const cameraOpRef = useRef(cameraOp)
  cameraOpRef.current = cameraOp

  useEffect(() => {
    const shot = (e: Event): void => {
      const d = (e as CustomEvent<TunerShot>).detail
      if (!d || d.session !== session) return
      const cover = frameCover()
      const { w, h } = sizeRef.current
      const base = coverBase(cover)
      const aimed = { ...base, yaw: d.yaw ?? base.yaw, pitch: d.pitch ?? base.pitch }
      const to = d.orbit ? d.orbit : d.bounds ? uncover(frameBounds(aimed, d.bounds, w / Math.max(1, h * (1 - cover)), d.pad ?? 1), cover) : null
      if (!to) return
      wheelRef.current = blockWheel(wheelRef.current)
      animateTo(fitMode(to), d.ms ?? FOCUS_MS, easeInOutCubic)
    }
    window.addEventListener(TUNER_SHOT_EVENT, shot)
    return () => window.removeEventListener(TUNER_SHOT_EVENT, shot)
  }, [session])

  useEffect(() => {
    const pending = pendingFrameRef.current
    if (!pending) return
    if (Date.now() > pending.until || selectedRef.current !== pending.id) {
      pendingFrameRef.current = null
      if (pending.instant && !orbitRef.current) {
        debugLog(`[tuner] initial frame fell back to bounds (selected ${selectedRef.current ?? '-'})`)
        frameInitialRef.current(true)
      }
      return
    }
    if (!effectiveObjects().some((o) => o.id === pending.id && framable(o))) return
    runFrame(pending.instant)
  }, [objects])

  useEffect(() => {
    if (framePosesRef.current.size === 0 || transformsAcked(session)) releaseDragHold()
    requestDraw()
  }, [objects, pinned, selected, mode, space])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if ((e.target as Element | null)?.closest?.('[data-viewport-ui]')) return
      e.preventDefault()
      const o = orbitRef.current
      if (!o) return
      const st = wheelStream(wheelRef.current, e, performance.now(), planarRef.current || !!o.ortho)
      wheelRef.current = st
      const tag = `${st.device}:${st.mode}${st.blocked ? ':blocked' : ''}`
      if (el.dataset.wheel !== tag) el.dataset.wheel = tag
      el.dataset.wheelSeq = String(Number(el.dataset.wheelSeq ?? 0) + 1)
      const gk = gestureRef.current?.kind
      if ((gk === 'pendingRight' || gk === 'look') && !planarRef.current) {
        const [wx, wy] = wheelPixels(e)
        const c = camSetRef.current
        const span = Math.max(1e-6, c.speedMax - c.speedMin)
        const norm = Math.max(0, Math.min(1, (c.speed - c.speedMin) / span - (e.shiftKey && wy === 0 ? wx : wy) * WHEEL_UNITS_PER_PX * 0.01))
        const speed = c.speedMin + span * norm
        camSetRef.current = { ...c, speed }
        onCameraRef.current?.({ speed })
        const digits = speed < 0.0001 ? 6 : speed < 0.001 ? 5 : speed < 0.01 ? 4 : speed < 0.1 ? 3 : speed < 10 ? 2 : 0
        let text = speed.toFixed(digits)
        if (speed < 0.1) text = text.replace(/0+$/, '')
        setReadout(`${text}${c.acceleration ? 'x' : ''}`)
        return
      }
      if (st.blocked || (st.mode !== 'zoom' && gestureRef.current)) return
      stopAnim()
      const [dx, dy] = wheelPixels(e)
      if (st.mode === 'orbit') {
        setOrbit(orbitRotate(o, -dx, -dy))
        return
      }
      if (st.mode === 'pan') {
        setOrbit(orbitPan(o, -dx, -dy, sizeRef.current.h, sizeRef.current.w))
        return
      }
      const r = el.getBoundingClientRect()
      const nx = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1
      const ny = -((e.clientY - r.top) / Math.max(1, r.height)) * 2 + 1
      const anchor = o.ortho ? planarPoint(o, nx, ny, r.width / Math.max(1, r.height)) : undefined
      if (st.mode === 'pinch') {
        setOrbit(orbitScale(o, pinchFactor(dy), anchor))
        return
      }
      const zd = dy !== 0 || !e.shiftKey ? dy : dx
      setOrbit(anchor ? orbitZoom(o, zd, anchor) : orbitZoomAt(o, zd, nx, ny, r.width / Math.max(1, r.height)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    rectPoseRef.current = null
    multiPoseRef.current = null
    rectHoverRef.current = null
    rectVersionRef.current++
    requestDraw()
  }, [mode, live])

  useEffect(() => {
    const el = wrapRef.current as (HTMLDivElement & { __motion?: unknown }) | null
    if (!el) return
    el.__motion = {
      parts: () => {
        const { w, h } = sizeRef.current
        return overlayRef.current?.partPoints(w, h) ?? []
      },
      ring: (axis: number) => {
        const { w, h } = sizeRef.current
        return overlayRef.current?.ringPoints(axis, w, h) ?? []
      },
      gesture: () => gestureRef.current?.kind ?? 'none',
      probe: (opts: { spot?: string; seq?: boolean }) => probeRef.current(opts),
      camera: (cmd: CameraCmd) => cameraOpRef.current(cmd),
      orbit: () => {
        const o = orbitRef.current
        return o ? { target: [...o.target], distance: o.distance, yaw: o.yaw, pitch: o.pitch, ortho: o.ortho ?? null, animating: animRef.current !== 0, level: frameMemoRef.current?.level ?? 0, key: frameMemoRef.current?.key ?? '' } : null
      },
      wheel: () => wheelRef.current
    }
    const onGizmo = (): void => {
      let spec: GizmoSpec | null = null
      try {
        spec = JSON.parse(el.getAttribute(GIZMO_ASK_ATTR) ?? 'null') as GizmoSpec | null
      } catch {
        spec = null
      }
      if (spec?.kind === GIZMO_OBJECT) {
        const r = cameraOpRef.current({ op: 'aim', paths: spec.path ? [spec.path] : undefined })
        if (r.ok && r.aim) el.setAttribute(GIZMO_AT_ATTR, JSON.stringify(r.aim))
        else el.removeAttribute(GIZMO_AT_ATTR)
        return
      }
      const { w, h } = sizeRef.current
      const o = overlayRef.current
      const p = spec && o ? pickGizmoPoint(o.partPoints(w, h), (axis) => o.ringPoints(axis, w, h), spec) : null
      if (p) el.setAttribute(GIZMO_AT_ATTR, JSON.stringify(p))
      else el.removeAttribute(GIZMO_AT_ATTR)
    }
    el.addEventListener(GIZMO_EVENT, onGizmo)
    return () => {
      el.removeEventListener(GIZMO_EVENT, onGizmo)
      delete el.__motion
    }
  }, [])

  useEffect(() => () => {
    cameraSend.cancel()
    rectSend.cancel()
    rectsSend.cancel()
    if (marqueeTimerRef.current) clearTimeout(marqueeTimerRef.current)
    if (rectTimerRef.current) clearTimeout(rectTimerRef.current)
    if (multiTimerRef.current) clearTimeout(multiTimerRef.current)
    stopAnim()
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
  }, [])

  const localOf = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = wrapRef.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  const ndcOf = (e: { clientX: number; clientY: number }): Vector2 => {
    const r = wrapRef.current!.getBoundingClientRect()
    return new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  }

  const rayAt = (e: { clientX: number; clientY: number }) => {
    const { cam, aspect } = currentCamera()
    const p = ndcOf(e)
    return screenRay(cam, p.x, p.y, aspect)
  }

  const selectedObject = (): TunerObject | null =>
    effectiveObjects().find((o) => o.id === selectedRef.current && !o.error) ?? null

  const pickObject = (e: { clientX: number; clientY: number }): string | null => {
    const [x, y] = localOf(e)
    const dot = pickDot(layoutRef.current, x, y)
    if (dot) return dot
    const o = orbitRef.current
    if (o?.ortho) {
      const { w, h } = sizeRef.current
      const p = ndcOf(e)
      const at = planarPoint(o, p.x, p.y, w / Math.max(1, h))
      return pickPlanar(
        at[0],
        at[1],
        effectiveObjects().filter((ob) => !ob.error),
        (6 * o.ortho) / Math.max(1, h)
      )
    }
    return pickNearest(
      rayAt(e),
      effectiveObjects().filter((o) => !o.error)
    )
  }

  const applyPick = (hit: TunerPickBase | null): void => {
    if (!hit) {
      activePathRef.current = null
      expectSelRef.current = null
      onSelect(null)
      return
    }
    activePathRef.current = hit.path
    const id = hit.target ?? hit.owner
    expectSelRef.current = id
    if (onPiercePick) onPiercePick(toPiercePick(hit))
    else onSelect(id)
  }

  const requestPick = (e: { clientX: number; clientY: number }) => {
    const cam = frameCamRef.current
    const el = wrapRef.current
    if (!cam || !el || !liveRef.current) return null
    const r = el.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)))
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height)))
    const seq = ++pickSeqRef.current
    return window.api.tuner
      .pick(projectPath, session, { x, y, camera: cam })
      .then((res) => {
        if (seq !== pickSeqRef.current || !res.ok) return res.ok ? null : undefined
        Object.assign(pickIconsRef.current, res.data.icons)
        return res.data.hits
      })
      .catch(() => undefined)
  }

  const clickSelect = (e: { clientX: number; clientY: number }, mode: PickMode = 'normal'): void => {
    const [x, y] = localOf(e)
    const markerDot = pickDot(layoutRef.current, x, y)
    const iconDot = pickSceneIcon(iconSpotsRef.current, x, y, selectedRef.current)
    const dot = markerDot && markerDot !== selectedRef.current ? markerDot : (iconDot ?? markerDot)
    if (mode !== 'normal' && onSelectionChange) {
      const apply = (hit: ViewportHit | null): void => {
        const next = viewportClick(selectionRef.current, hit, mode)
        if (next !== selectionRef.current) onSelectionChange(next)
      }
      if (dot) {
        apply({ exact: dot, base: dot, chain: [dot] })
        return
      }
      const pending = requestPick(e)
      if (!pending) {
        const id = pickObject(e)
        apply(id ? { exact: id, base: id, chain: [id] } : null)
        return
      }
      void pending.then((hits) => {
        if (hits === null) return
        if (hits === undefined) {
          const id = pickObject(e)
          apply(id ? { exact: id, base: id, chain: [id] } : null)
          return
        }
        apply(hitIds(hits))
      })
      return
    }
    const fallback = (): void => onSelect(pickObject(e))
    if (dot) {
      activePathRef.current = effectiveObjects().find((o) => o.id === dot)?.path ?? null
      expectSelRef.current = dot
      onSelect(dot)
      return
    }
    const pending = requestPick(e)
    if (!pending) {
      fallback()
      return
    }
    void pending.then((hits) => {
      if (hits === null) return
      if (hits === undefined) {
        fallback()
        return
      }
      applyPick(cyclePick(hits, activePathRef.current, cycleRef.current))
    })
  }

  const marqueeSeqRef = useRef(0)
  const marqueeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const marqueeBusyRef = useRef(false)
  const marqueeDirtyRef = useRef(false)

  const showMarquee = (g: Extract<Gesture, { kind: 'marquee' }> | null): void => {
    const el = marqueeRef.current
    const wrap = wrapRef.current
    if (!el || !wrap) return
    if (!g) {
      el.style.display = 'none'
      delete wrap.dataset.marquee
      return
    }
    const r = wrap.getBoundingClientRect()
    const left = Math.min(g.x0, g.x1) - r.left
    const top = Math.min(g.y0, g.y1) - r.top
    el.style.display = 'block'
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.width = `${Math.abs(g.x1 - g.x0)}px`
    el.style.height = `${Math.abs(g.y1 - g.y0)}px`
    wrap.dataset.marquee = g.mode
  }

  const runMarquee = (g: Extract<Gesture, { kind: 'marquee' }>, final: boolean): void => {
    const cam = frameCamRef.current
    const el = wrapRef.current
    if (!cam || !el || !liveRef.current || !onSelectionChange) return
    if (marqueeBusyRef.current && !final) return
    const r = el.getBoundingClientRect()
    const nx = (v: number): number => Math.max(0, Math.min(1, (v - r.left) / Math.max(1, r.width)))
    const ny = (v: number): number => Math.max(0, Math.min(1, (v - r.top) / Math.max(1, r.height)))
    const req = { x0: nx(g.x0), y0: ny(g.y0), x1: nx(g.x1), y1: ny(g.y1), camera: cam }
    const seq = ++marqueeSeqRef.current
    g.seq = seq
    marqueeBusyRef.current = true
    void window.api.tuner
      .pickRect(projectPath, session, req)
      .then((res) => {
        marqueeBusyRef.current = false
        if (seq !== marqueeSeqRef.current || !res.ok) return
        onSelectionChange(rectSelection(g.start, res.data.ids, g.mode))
        if (!final && marqueeDirtyRef.current && gestureRef.current === g) {
          marqueeDirtyRef.current = false
          scheduleMarquee(g)
        }
      })
      .catch(() => {
        marqueeBusyRef.current = false
      })
  }

  const scheduleMarquee = (g: Extract<Gesture, { kind: 'marquee' }>): void => {
    if (marqueeTimerRef.current) return
    marqueeTimerRef.current = setTimeout(() => {
      marqueeTimerRef.current = null
      if (gestureRef.current === g) runMarquee(g, false)
    }, MARQUEE_MS)
  }

  const cancelMarquee = (restore: boolean): boolean => {
    const g = gestureRef.current
    if (g?.kind !== 'marquee') return false
    gestureRef.current = null
    marqueeSeqRef.current++
    if (marqueeTimerRef.current) clearTimeout(marqueeTimerRef.current)
    marqueeTimerRef.current = null
    showMarquee(null)
    setCursor('cursor-default')
    if (restore) onSelectionChange?.(g.start)
    return true
  }

  const openPierceMenu = (e: { clientX: number; clientY: number }): void => {
    const at = { x: e.clientX, y: e.clientY }
    const pending = requestPick(e)
    setMenu({ ...at, hits: [], pending: !!pending })
    if (!pending) return
    void pending.then((hits) => {
      if (hits === null) return
      setMenu((m) => (m && m.x === at.x && m.y === at.y ? { ...m, hits: hits ?? [], pending: false } : m))
    })
  }

  const setReadout = (text: string | null): void => {
    const el = readoutRef.current
    if (!el) return
    el.textContent = text ?? ''
    el.style.display = text ? '' : 'none'
  }

  const flyKeys: Record<string, Vec3> = { KeyW: [0, 0, 1], KeyS: [0, 0, -1], KeyA: [-1, 0, 0], KeyD: [1, 0, 0], KeyE: [0, 1, 0], KeyQ: [0, -1, 0] }

  const flyTick = (now: number): void => {
    const f = flyRef.current
    f.raf = 0
    const o = orbitRef.current
    const g = gestureRef.current
    if (!o || f.keys.size === 0 || (g?.kind !== 'look' && g?.kind !== 'pendingRight')) {
      f.keys.clear()
      return
    }
    const raw = Math.min(0.1, Math.max(0, (now - f.last) / 1000))
    f.last = now
    f.dt = f.dt > 0 ? f.dt * 0.8 + raw * 0.2 : raw
    const dt = f.dt
    const move: Vec3 = [0, 0, 0]
    for (const k of f.keys) for (let i = 0; i < 3; i++) move[i] += flyKeys[k][i]
    const c = camSetRef.current
    f.motion = flyStep(f.motion, move, dt, { speed: c.speed, shift: f.shift, acceleration: c.acceleration, accelerationSpeed: c.accelerationSpeed, easing: c.easing, easingDuration: c.easingDuration, speedModifier: c.speedModifier })
    setOrbit(orbitFly(o, f.motion.vel, dt))
    f.raf = requestAnimationFrame(flyTick)
  }

  const flyKey = (e: React.KeyboardEvent, down: boolean): boolean => {
    flyRef.current.shift = e.shiftKey
    const g = gestureRef.current
    if (!flyKeys[e.code] || (g?.kind !== 'look' && g?.kind !== 'pendingRight') || planarRef.current) return false
    e.preventDefault()
    e.stopPropagation()
    const f = flyRef.current
    if (!down) {
      f.keys.delete(e.code)
      return true
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return true
    if (g.kind === 'pendingRight') {
      gestureRef.current = { kind: 'look', x: g.x, y: g.y }
      setCursor('cursor-grabbing')
    }
    if (f.keys.size === 0) {
      f.motion = FLY_REST
      f.dt = 0
    }
    f.keys.add(e.code)
    f.flew = true
    stopAnim()
    if (!f.raf) {
      f.last = performance.now()
      f.raf = requestAnimationFrame(flyTick)
    }
    return true
  }

  const endFly = (): void => {
    const f = flyRef.current
    f.keys.clear()
    if (f.raf) cancelAnimationFrame(f.raf)
    f.raf = 0
    f.flew = false
  }

  const viewCamera = () => {
    const current = currentCamera()
    const cam = liveRef.current && frameCamRef.current ? { ...frameCamRef.current, clip: current.cam.clip } : current.cam
    return { cam, aspect: current.aspect }
  }

  const viewRay = (e: { clientX: number; clientY: number }) => {
    const { cam, aspect } = viewCamera()
    const p = ndcOf(e)
    return screenRay(cam, p.x, p.y, aspect)
  }

  const rectScreenNow = (info: TunerRectInfo): RectScreen | null => {
    const { cam } = viewCamera()
    const { w, h } = sizeRef.current
    return rectScreen(info, (p) => {
      const s = toScreen(cam, p, w, h)
      return s ? [s[0], s[1]] : null
    })
  }

  const rectHit = (e: { clientX: number; clientY: number }): { info: TunerRectInfo; hit: RectHandle | null; sc: RectScreen | null } | null => {
    const info = rectFor(selectedRef.current)
    if (!info) return null
    const sc = rectScreenNow(info)
    if (!sc) return { info, hit: null, sc }
    const [x, y] = localOf(e)
    return { info, hit: hitRect(sc, x, y, true, !info.renderer), sc }
  }

  const beginRect = (e: React.PointerEvent, info: TunerRectInfo, handle: RectHandle): boolean => {
    const ray = viewRay(e)
    const m0 = planeLocal(info.frame, ray)
    if (!m0) return false
    const p0 = info.parent ? planeLocal(info.parent, ray) : null
    const w0 = frameVector(info.frame, [m0[0], m0[1], 0])
    let multi: RectMulti | null = null
    if (info.id === MULTI_ID) {
      const m = multiInfoRef.current
      if (!m) return false
      const want = new Set(selectionRef.current.ids)
      const known = effectiveObjects().filter((o) => want.has(o.id) && !o.error)
      const top = new Set(topLevel(known).map((o) => o.id))
      const nested = new Set(known.filter((o) => !top.has(o.id)).map((o) => o.id))
      const starts = m.infos.filter((i) => !nested.has(i.id))
      if (starts.length === 0) return false
      multi = { starts, frame: info, center: pivotRef.current === 'center', active: m.infos.find((i) => i.id === selectedRef.current) ?? null, items: null, params: null }
    }
    gestureRef.current = {
      kind: 'rect',
      id: info.id,
      handle,
      start: info,
      m0,
      p0: p0 ?? [0, 0],
      w0,
      lock: -1,
      sent: new Set(),
      last: null,
      action: e.metaKey || e.ctrlKey,
      multi
    }
    rectHoverRef.current = handle
    setCursor(RECT_CURSORS[rectCursor(handle, rectScreenNow(info), true)] ?? 'cursor-grabbing')
    rectVersionRef.current++
    requestDraw()
    return true
  }

  const moveMulti = (e: React.PointerEvent, g: Extract<Gesture, { kind: 'rect' }>, mm: RectMulti, m1: V2): void => {
    const start = g.start
    const h = g.handle
    const n = mm.starts.length
    let next: TunerRectValues[]
    let readout: string
    if (h.kind === 'move') {
      if (e.shiftKey && g.lock < 0 && Math.hypot(m1[0] - g.m0[0], m1[1] - g.m0[1]) > 0) g.lock = moveLockAxis(g.m0, m1)
      if (!e.shiftKey) g.lock = -1
      const d: V2 = [m1[0] - g.m0[0], m1[1] - g.m0[1]]
      if (g.lock >= 0) d[1 - g.lock] = 0
      const w = frameVector(start.frame, [d[0], d[1], 0])
      next = multiMoveValues(mm.starts, w)
      mm.frame = movedFrame(start, w)
      mm.params = { kind: 'move', delta: w }
      readout = `Move ${fmtRect(d[0])}, ${fmtRect(d[1])}`
    } else if (h.kind === 'resize') {
      const f = resizeFactors(start.rect, h, g.m0, m1, { shift: e.shiftKey, alt: e.altKey })
      next = multiResizeValues(mm.starts, start, f)
      mm.params = { kind: 'resize', scale: [f.sx, f.sy, 1], pivot: toWorld(start.frame, f.sp[0], f.sp[1]), rotation: start.localRotation }
      mm.frame = resizedFrame(start, f, mm.center ? 'center' : mm.active ? scalePoint(start, f, mm.active.frame.origin) : null)
      readout = `${fmtRect(mm.frame.rect[2])} × ${fmtRect(mm.frame.rect[3])}`
    } else if (h.kind === 'rotate') {
      const raw = planeAngle(start.frame, g.w0, frameVector(start.frame, [m1[0], m1[1], 0]))
      const deg = e.shiftKey ? Math.round(raw / ROTATE_STEP) * ROTATE_STEP : raw
      next = multiRotateValues(mm.starts, start, deg)
      mm.frame = rotatedFrame(start, deg)
      mm.params = { kind: 'rotate', degrees: deg, pivot: start.frame.origin, axis: start.frame.uz }
      readout = `Z ${fmtRect(Math.round(deg * 10) / 10)}°`
    } else return
    const items = rectItems(mm.starts, next, g.sent)
    if (g.sent.size === 0) return
    mm.items = items
    rectVersionRef.current++
    setReadout(`${readout} · ${n} objects${e.shiftKey ? ' · snap' : ''}`)
    rectsSend.call(projectPath, session, items, false, rectLabel(h))
    requestDraw()
  }

  const moveRect = (e: React.PointerEvent, g: Extract<Gesture, { kind: 'rect' }>): void => {
    const start = g.start
    const ray = viewRay(e)
    const m1 = planeLocal(start.frame, ray)
    if (!m1) return
    if (g.multi) {
      moveMulti(e, g, g.multi, m1)
      return
    }
    const h = g.handle
    let next: TunerRectValues
    if (h.kind === 'move') {
      if (e.shiftKey && g.lock < 0 && Math.hypot(m1[0] - g.m0[0], m1[1] - g.m0[1]) > 0) g.lock = moveLockAxis(g.m0, m1)
      if (!e.shiftKey) g.lock = -1
      next = moveValues(start, g.m0, m1, g.lock)
    } else if (h.kind === 'resize') next = resizeValues(start, h, g.m0, m1, { shift: e.shiftKey, alt: e.altKey })
    else if (h.kind === 'pivot') {
      const sc = rectScreenNow(start)
      const px = sc ? Math.max(1, Math.hypot(sc.corners[1][0] - sc.corners[0][0], sc.corners[1][1] - sc.corners[0][1])) : 0
      const py = sc ? Math.max(1, Math.hypot(sc.corners[3][0] - sc.corners[0][0], sc.corners[3][1] - sc.corners[0][1])) : 0
      next = pivotValues(start, g.m0, m1, sc ? [PIVOT_SNAP_PX / px, PIVOT_SNAP_PX / py] : [0, 0])
    } else if (h.kind === 'anchor') {
      const p1 = start.parent ? planeLocal(start.parent, ray) : null
      if (!p1) return
      next = anchorValues(start, h, g.p0, p1, { shift: e.shiftKey, action: g.action })
    } else {
      next = rotateValues(start, planeAngle(start.frame, g.w0, frameVector(start.frame, [m1[0], m1[1], 0])), e.shiftKey)
    }
    g.last = next
    for (const k of Object.keys(changedValues(start, next)) as (keyof TunerRectValues)[]) g.sent.add(k)
    if (g.sent.size === 0) return
    const info = withValues(start, next)
    rectRef.current = info
    rectVersionRef.current++
    setReadout(rectReadout(h, info))
    rectSend.call(projectPath, session, g.id, pickRect(next, g.sent), false, rectLabel(h))
    requestDraw()
  }

  const endRect = (g: Extract<Gesture, { kind: 'rect' }>): void => {
    if (g.multi) {
      if (g.multi.items && g.sent.size > 0) {
        multiHeldRef.current = multiInfoRef.current ? { key: multiInfoRef.current.key, frame: g.multi.frame } : null
        rectsSend.flush(projectPath, session, g.multi.items, true, rectLabel(g.handle))
      } else rectsSend.cancel()
      multiPoseRef.current = null
      rectVersionRef.current++
      return
    }
    if (g.last && g.sent.size > 0) rectSend.flush(projectPath, session, g.id, pickRect(g.last, g.sent), true, rectLabel(g.handle))
    else rectSend.cancel()
    rectPoseRef.current = null
    rectVersionRef.current++
  }

  const spotAt = (spot: string): V2 | null => {
    const { w, h } = sizeRef.current
    const g = /^gizmo:(\w+):(\d)$/.exec(spot)
    if (g) {
      if (g[1] === 'ring') {
        const q = overlayRef.current?.ringPoints(Number(g[2]), w, h).find((x) => x.front)
        return q ? [q.x, q.y] : null
      }
      const p = overlayRef.current?.partPoints(w, h).find((q) => q.kind === g[1] && q.axis === Number(g[2]))
      return p ? [p.x, p.y] : null
    }
    const xy = /^(-?[\d.]+),(-?[\d.]+)$/.exec(spot)
    if (xy) return [Number(xy[1]), Number(xy[2])]
    const info = rectFor(selectedRef.current)
    const sc = info ? rectScreenNow(info) : null
    if (!sc) return null
    const c = sc.corners
    const mid: V2 = [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2]
    if (spot === 'rect:move') return [mid[0] + (c[0][0] - mid[0]) * 0.35, mid[1] + (c[0][1] - mid[1]) * 0.35]
    if (spot === 'rect:pivot') return sc.pivot
    const r = /^rect:(resize|rotate):([012]),([012])$/.exec(spot)
    if (!r) return null
    const x = Number(r[2])
    const y = Number(r[3])
    const corner = [[0, 0], [2, 0], [2, 2], [0, 2]].findIndex((s) => s[0] === x && s[1] === y)
    if (r[1] === 'rotate') {
      if (corner < 0) return null
      const d: V2 = [c[corner][0] - mid[0], c[corner][1] - mid[1]]
      const l = Math.max(1e-6, Math.hypot(d[0], d[1]))
      return [c[corner][0] + (d[0] / l) * 12, c[corner][1] + (d[1] / l) * 12]
    }
    if (corner >= 0) return c[corner]
    const edge = [[1, 0], [2, 1], [1, 2], [0, 1]].findIndex((s) => s[0] === x && s[1] === y)
    if (edge < 0) return null
    const a = c[edge]
    const b = c[(edge + 1) % 4]
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  }

  const probeView = async (opts: { spot?: string; seq?: boolean }): Promise<Record<string, unknown>> => {
    const wrap = wrapRef.current
    const seq = frameSeqRef.current
    if (!wrap) return { seq, missing: true }
    const r = wrap.getBoundingClientRect()
    const at = opts.spot ? spotAt(opts.spot) : null
    if (opts.seq) return { seq, origin: [r.left, r.top], at }
    const { w, h } = sizeRef.current
    const { cam } = viewCamera()
    const project = (p: Vec3): V2 | null => {
      const s = toScreen(cam, p, w, h)
      return s ? [s[0], s[1]] : null
    }
    const sel = selectionRef.current
    const ids = sel.ids.length > 1 ? sel.ids : selectedRef.current ? [selectedRef.current] : []
    const objs = effectiveObjects()
    const stream = wrap.querySelector<HTMLCanvasElement>('canvas[data-unity-session]')
    const { projectPath: pp, session: ss } = apiRef.current
    const objects: ProbeObject[] = []
    for (const id of ids) {
      const res = await window.api.tuner.rect(pp, ss, { op: 'get', id }).catch(() => null)
      if (!res || !res.ok || !res.data) continue
      const sc = rectScreen(res.data, project)
      const screen = sc ? boxOf(sc.corners) : null
      const outline = screen ? outlineBox(stream, surfaceViewRef.current.flipY, w, h, screen) : { box: null, n: 0 }
      objects.push(probeObject(res.data, objs.find((o) => o.id === id)?.path ?? id, sc, outline))
    }
    const frame = rectFor(selectedRef.current)
    const ha = wrap.dataset.handleAt ? (wrap.dataset.handleAt.split(',').map(Number) as V2) : null
    const g = gestureRef.current
    const mm = g?.kind === 'rect' ? g.multi : null
    return {
      seq,
      origin: [r.left, r.top],
      at,
      gesture: gestureRef.current?.kind ?? 'none',
      selected: selectedRef.current,
      ids,
      handleAt: ha,
      rect: frame ? screenOf(rectScreenNow(frame)) : null,
      multi: mm ? { moved: mm.starts.map((i) => objs.find((o) => o.id === i.id)?.path ?? i.id), params: mm.params } : null,
      objects,
      framesBox: boxOf(objects.flatMap((o) => (o.screen ? [[o.screen[0], o.screen[1]] as V2, [o.screen[2], o.screen[3]] as V2] : [])))
    }
  }
  const probeRef = useRef(probeView)
  probeRef.current = probeView

  const gizmoAt = (e: { clientX: number; clientY: number }): GizmoPart | null => {
    const scene = gizmoRef.current
    if (!scene || planarRef.current || !wrapRef.current) return null
    const [x, y] = localOf(e)
    const hit = gizmoHit(scene, x, y)
    if (hit != null || !isPhoneView()) return hit
    for (const r of [7, 13])
      for (let k = 0; k < 8; k++) {
        const h = gizmoHit(scene, x + r * Math.cos((k * Math.PI) / 4), y + r * Math.sin((k * Math.PI) / 4))
        if (h != null) return h
      }
    return null
  }

  const gizmoHover = (e: { clientX: number; clientY: number }): boolean => {
    const gp = gizmoAt(e)
    if (gp !== gizmoHoverRef.current) {
      gizmoHoverRef.current = gp
      requestDraw()
    }
    if (gp == null) return false
    if (hoverRef.current || hoverHandleRef.current) {
      hoverRef.current = null
      hoverHandleRef.current = null
    }
    setCursor('cursor-pointer')
    return true
  }

  const updateHover = (e: React.PointerEvent): void => {
    const rh = rectHit(e)
    if (rh) {
      const prev = rectHoverRef.current
      rectHoverRef.current = rh.hit
      const changed = !sameRectHandle(prev, rh.hit) || hoverRef.current !== null
      hoverRef.current = null
      hoverHandleRef.current = null
      setCursor(RECT_CURSORS[rectCursor(rh.hit, rh.sc, false)] ?? 'cursor-default')
      if (changed) {
        rectVersionRef.current++
        requestDraw()
      }
      if (rh.hit) return
    } else if (rectHoverRef.current) {
      rectHoverRef.current = null
      rectVersionRef.current++
      requestDraw()
    }
    const sel = selectedObject()
    let hh: HandleId | null = null
    if (sel && hasMoveTool(sel) && overlayRef.current && !unityToolRef.current) hh = overlayRef.current.pickHandle(ndcOf(e), handleMode())
    const ho = hh ? null : pickObject(e)
    const changed =
      ho !== hoverRef.current ||
      hh?.kind !== hoverHandleRef.current?.kind ||
      hh?.axis !== hoverHandleRef.current?.axis
    if (!changed) return
    hoverRef.current = ho
    hoverHandleRef.current = hh
    setCursor(hh || ho ? 'cursor-pointer' : 'cursor-default')
    requestDraw()
  }

  const touchPair = (): { mx: number; my: number; d: number; a: number } => {
    const [a, b] = [...touchesRef.current.values()]
    return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y), a: Math.atan2(b.y - a.y, b.x - a.x) }
  }

  const stopInertia = (): void => {
    if (inertiaRef.current) cancelAnimationFrame(inertiaRef.current)
    inertiaRef.current = 0
  }

  const startInertia = (kind: 'orbit' | 'pan', vx: number, vy: number): void => {
    stopInertia()
    if (Math.hypot(vx, vy) < TOUCH_FLING_MIN) return
    let last = performance.now()
    let v: [number, number] = [vx, vy]
    const step = (): void => {
      const now = performance.now()
      const dt = Math.min(50, now - last)
      last = now
      const k = Math.exp(-dt / TOUCH_FLING_TAU_MS)
      v = [v[0] * k, v[1] * k]
      const o = orbitRef.current
      if (!o || Math.hypot(v[0], v[1]) < TOUCH_FLING_STOP) {
        inertiaRef.current = 0
        sendCamera(true)
        return
      }
      const dx = v[0] * dt
      const dy = v[1] * dt
      setOrbit(kind === 'orbit' && !planarRef.current ? orbitRotate(o, dx, dy) : orbitPan(o, dx, dy, sizeRef.current.h, sizeRef.current.w))
      inertiaRef.current = requestAnimationFrame(step)
    }
    inertiaRef.current = requestAnimationFrame(step)
  }

  const touchVelocity = (g: { t?: number; vx?: number; vy?: number }, dx: number, dy: number): void => {
    const now = performance.now()
    const dt = Math.max(1, now - (g.t ?? now - 16))
    const a = Math.min(1, dt / 50)
    g.vx = (g.vx ?? 0) * (1 - a) + (dx / dt) * a
    g.vy = (g.vy ?? 0) * (1 - a) + (dy / dt) * a
    g.t = now
  }

  const touchHandle = (e: { clientX: number; clientY: number }, sel: TunerObject | null): { hh: ReturnType<SceneOverlay['pickHandle']>; at: { clientX: number; clientY: number } } | null => {
    const ov = overlayRef.current
    if (!sel || !hasMoveTool(sel) || !ov || unityToolRef.current) return null
    for (const r of TOUCH_HANDLE_RINGS)
      for (let k = 0; k < (r ? 8 : 1); k++) {
        const at = { clientX: e.clientX + r * Math.cos((k * Math.PI) / 4), clientY: e.clientY + r * Math.sin((k * Math.PI) / 4) }
        const hh = ov.pickHandle(ndcOf(at), handleMode())
        if (hh) return { hh, at }
      }
    return null
  }

  const touchDoubleTap = (e: { clientX: number; clientY: number }): boolean => {
    const prev = lastTapRef.current
    const now = performance.now()
    lastTapRef.current = { x: e.clientX, y: e.clientY, at: now }
    if (!prev || now - prev.at > TOUCH_DOUBLE_MS || Math.hypot(prev.x - e.clientX, prev.y - e.clientY) > TOUCH_DOUBLE_PX) return false
    lastTapRef.current = null
    setTimeout(() => {
      debugLog(`[tuner] touch double-tap: frame ${selectedRef.current ? 'selection' : 'scene'}`)
      runFrame()
    }, TOUCH_FRAME_SETTLE_MS)
    return true
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('[data-viewport-ui]')) return
    if (e.pointerType === 'touch') {
      stopInertia()
      const tp = touchesRef.current
      tp.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (tp.size >= 2) {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        stopAnim()
        const g = gestureRef.current
        if (g?.kind === 'touchHold') clearTimeout(g.timer)
        if (g?.kind === 'handle') {
          if (g.multi?.last) onTransformMany?.(g.multi.last, true)
          else if (g.last) onTransform(g.id, g.last, true)
        }
        if (g?.kind === 'marquee' && marqueeRef.current) marqueeRef.current.style.display = 'none'
        gestureRef.current = { kind: 'touch2', ...touchPair(), t: performance.now(), vx: 0, vy: 0 }
        debugLog('[tuner] touch two-finger pan/pinch/twist start')
        return
      }
    }
    wheelRef.current = blockWheel(wheelRef.current)
    wrapRef.current?.focus({ preventScroll: true })
    e.preventDefault()
    stopAnim()
    e.currentTarget.setPointerCapture(e.pointerId)
    if (e.button === 2) {
      gestureRef.current = { kind: 'pendingRight', x: e.clientX, y: e.clientY, alt: e.altKey }
      return
    }
    if (e.button === 1) {
      gestureRef.current = { kind: 'pan', x: e.clientX, y: e.clientY }
      setCursor('cursor-grabbing')
      return
    }
    if (e.button !== 0) return
    const gp = e.altKey ? null : gizmoAt(e)
    if (gp != null) {
      gestureRef.current = { kind: 'gizmo', part: gp, x: e.clientX, y: e.clientY }
      return
    }
    if (e.altKey) {
      gestureRef.current = { kind: planarRef.current ? 'pan' : 'orbit', x: e.clientX, y: e.clientY }
      setCursor('cursor-grabbing')
      return
    }
    const uh = unityRef.current!.state
    if ((uh.tool || uh.editors) && uh.near) {
      gestureRef.current = { kind: 'unity' }
      unityEvent(e, 'down')
      return
    }
    const rh = rectHit(e)
    if (rh?.hit && beginRect(e, rh.info, rh.hit)) return
    const sel = selectedObject()
    const touchHit = e.pointerType === 'touch' ? touchHandle(e, sel ?? null) : null
    const at = touchHit?.at ?? e
    const hh = touchHit ? touchHit.hh : sel && hasMoveTool(sel) && overlayRef.current && !unityToolRef.current ? overlayRef.current.pickHandle(ndcOf(e), handleMode()) : null
    if (sel && hh) {
      const objs = effectiveObjects()
      const hp = handlePose(objs, sel, null) ?? { position: sel.position, rotation: sel.rotation }
      const drag = beginDrag(hh, hp.position, hp.rotation, spaceRef.current, rayAt(at), at.clientX, at.clientY, sel.localScale, overlayRef.current?.handleSize ?? 1)
      let multi: MultiDrag | null = null
      if (hh.kind !== 'scale' && multiHandle(sel)) {
        const list = selectionRef.current.ids.length > 1 ? selectionObjects(objs) : [sel]
        const starts = topLevel(list.length ? list : [sel]).map((o) => ({ id: o.id, position: o.position, rotation: o.rotation }))
        multi = { starts, origin: hp.position, rot0: hp.rotation, pose: hp, last: null }
      }
      gestureRef.current = { kind: 'handle', id: sel.id, drag, last: null, multi, start: { position: hp.position, rotation: hp.rotation }, off: at === e ? undefined : [at.clientX - e.clientX, at.clientY - e.clientY] }
      if (e.pointerType === 'touch') debugLog(`[tuner] touch handle ${hh.kind} on ${sel.id}${at === e ? '' : ' (finger ring)'}`)
      hoverHandleRef.current = hh
      requestDraw()
      return
    }
    if (e.pointerType === 'touch') {
      const x = e.clientX
      const y = e.clientY
      const timer = setTimeout(() => {
        const g = gestureRef.current
        if (g?.kind !== 'touchHold' || g.x !== x || g.y !== y) return
        gestureRef.current = null
        debugLog('[tuner] touch long-press: pierce menu')
        openPierceMenu({ clientX: x, clientY: y })
      }, TOUCH_HOLD_MS)
      gestureRef.current = { kind: 'touchHold', x, y, timer }
      return
    }
    gestureRef.current = { kind: 'pending', x: e.clientX, y: e.clientY, alt: false, mode: pickMode(e) }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const g = gestureRef.current
    if (e.pointerType === 'touch' && touchesRef.current.has(e.pointerId)) touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (g?.kind === 'touch2') {
      const o = orbitRef.current
      if (touchesRef.current.size < 2 || !o) return
      const n = touchPair()
      const dx = n.mx - g.mx
      const dy = n.my - g.my
      touchVelocity(g, dx, dy)
      let next = orbitPan(o, dx, dy, sizeRef.current.h, sizeRef.current.w)
      if (n.d > 4 && g.d > 4) {
        const f = Math.max(0.5, Math.min(2, g.d / n.d))
        const r = wrapRef.current?.getBoundingClientRect()
        const nx = r ? ((n.mx - r.left) / Math.max(1, r.width)) * 2 - 1 : 0
        const ny = r ? -((n.my - r.top) / Math.max(1, r.height)) * 2 + 1 : 0
        const aspect = r ? r.width / Math.max(1, r.height) : 1
        const zd = (f - 1) / (WHEEL_UNITS_PER_PX * 0.015)
        next = next.ortho ? orbitZoom(next, zd, planarPoint(next, nx, ny, aspect)) : orbitZoomAt(next, zd, nx, ny, aspect)
      }
      let turn = n.a - g.a
      if (turn > Math.PI) turn -= 2 * Math.PI
      if (turn < -Math.PI) turn += 2 * Math.PI
      if (!planarRef.current && !next.ortho && Math.abs(turn) > 0.002) next = { ...next, yaw: ((((next.yaw - (turn * 180) / Math.PI + 180) % 360) + 360) % 360) - 180 }
      g.mx = n.mx
      g.my = n.my
      g.d = n.d
      g.a = n.a
      setOrbit(next)
      return
    }
    if (g?.kind === 'touchHold') {
      if (isClick(g.x, g.y, e.clientX, e.clientY)) return
      clearTimeout(g.timer)
      stopAnim()
      debugLog(`[tuner] touch one-finger ${planarRef.current ? 'pan' : 'orbit'} start`)
      gestureRef.current = { kind: planarRef.current ? 'pan' : 'orbit', x: g.x, y: g.y }
    }
    lastPtrRef.current = { clientX: e.clientX, clientY: e.clientY }
    if (!g) {
      if (gizmoHover(e)) return
      unityEvent(e, 'move')
      updateHover(e)
      const [ix, iy] = localOf(e)
      const ih = pickSceneIcon(iconSpotsRef.current, ix, iy)
      if (ih !== iconHoverRef.current) {
        iconHoverRef.current = ih
        requestDraw()
      }
      return
    }
    if (g.kind === 'unity') {
      unityEvent(e, 'drag')
      return
    }
    if (g.kind === 'gizmo') {
      if (isClick(g.x, g.y, e.clientX, e.clientY)) return
      gestureRef.current = { kind: planarRef.current ? 'pan' : 'orbit', x: g.x, y: g.y }
      gizmoHoverRef.current = null
      setCursor('cursor-grabbing')
      return
    }
    if (g.kind === 'pending') {
      if (isClick(g.x, g.y, e.clientX, e.clientY)) return
      if (!onSelectionChange || e.pointerType === 'touch') {
        gestureRef.current = { kind: planarRef.current ? 'pan' : 'orbit', x: g.x, y: g.y }
        setCursor('cursor-grabbing')
      } else {
        const mq: Extract<Gesture, { kind: 'marquee' }> = {
          kind: 'marquee',
          x0: g.x,
          y0: g.y,
          x1: e.clientX,
          y1: e.clientY,
          mode: g.mode,
          start: selectionRef.current,
          seq: 0
        }
        gestureRef.current = mq
        hoverRef.current = null
        hoverHandleRef.current = null
        marqueeDirtyRef.current = false
        showMarquee(mq)
        scheduleMarquee(mq)
        requestDraw()
        return
      }
    }
    if (g.kind === 'pendingRight') {
      if (isClick(g.x, g.y, e.clientX, e.clientY)) return
      gestureRef.current = { kind: g.alt && !planarRef.current ? 'dolly' : planarRef.current ? 'pan' : 'look', x: g.x, y: g.y }
      setCursor('cursor-grabbing')
    }
    const cur = gestureRef.current!
    if (cur.kind === 'marquee') {
      cur.x1 = e.clientX
      cur.y1 = e.clientY
      showMarquee(cur)
      if (marqueeBusyRef.current) marqueeDirtyRef.current = true
      else scheduleMarquee(cur)
      return
    }
    if (cur.kind === 'rect') {
      moveRect(e, cur)
      return
    }
    if (cur.kind === 'orbit' || cur.kind === 'pan' || cur.kind === 'look' || cur.kind === 'dolly') {
      const o = orbitRef.current
      if (!o) return
      const dx = e.clientX - cur.x
      const dy = e.clientY - cur.y
      cur.x = e.clientX
      cur.y = e.clientY
      if (cur.kind === 'orbit') {
        if (e.pointerType === 'touch') touchVelocity(cur, dx, dy)
        setOrbit(orbitRotate(o, dx, dy))
      }
      else if (cur.kind === 'look') setOrbit(orbitLook(o, dx, dy))
      else if (cur.kind === 'dolly') {
        cur.dolly ??= dollyStart(o)
        setOrbit(orbitDolly(o, cur.dolly, dx, dy, e.shiftKey))
      } else setOrbit(orbitPan(o, dx, dy, sizeRef.current.h, sizeRef.current.w))
      return
    }
    if (cur.kind === 'handle') {
      const o = baseOrbit()
      const pe = cur.off ? { clientX: e.clientX + cur.off[0], clientY: e.clientY + cur.off[1] } : e
      const res = o.ortho
        ? updateDrag(cur.drag, rayAt(pe), pe.clientX, pe.clientY, e.shiftKey, orbitForward(o), planarSnap(o.ortho), '')
        : updateDrag(cur.drag, rayAt(pe), pe.clientX, pe.clientY, e.shiftKey, orbitForward(o), MOVE_SNAP)
      if (!res) return
      if (cur.multi && onTransformMany) {
        const m = cur.multi
        const items = res.position
          ? multiMove(m.starts, m.origin, res.position)
          : multiRotate(m.starts, pivotRef.current, spaceRef.current, m.origin, m.rot0, res.rotation ?? m.rot0)
        m.pose = { position: res.position ?? m.origin, rotation: res.rotation ?? m.rot0 }
        m.last = items
        dragPoseRef.current = new Map(items.map((it) => [it.id, it.pose]))
        dragVerRef.current++
        requestDraw()
        setReadout(res.readout + (m.starts.length > 1 ? ` · ${m.starts.length} objects` : '') + (e.shiftKey ? ' · snap' : ''))
        onTransformMany(items, false)
        return
      }
      const pose: PoseChange = res.position ? { position: res.position } : res.localScale ? { localScale: res.localScale } : { rotation: res.rotation }
      cur.last = pose
      dragPoseRef.current = new Map([[cur.id, pose]])
      dragVerRef.current++
      requestDraw()
      setReadout(res.readout + (e.shiftKey ? ' · snap' : ''))
      onTransform(cur.id, pose, false)
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'touch') touchesRef.current.delete(e.pointerId)
    const tg = gestureRef.current
    if (tg?.kind === 'touch2') {
      if (touchesRef.current.size === 0) {
        gestureRef.current = null
        const o = orbitRef.current
        debugLog(`[tuner] touch two-finger end: distance ${o?.distance.toFixed(2) ?? '-'} yaw ${o?.yaw.toFixed(1) ?? '-'}`)
        if (performance.now() - tg.t < TOUCH_FLING_GAP_MS) startInertia('pan', tg.vx, tg.vy)
        else sendCamera(true)
      }
      return
    }
    if (tg?.kind === 'touchHold') {
      clearTimeout(tg.timer)
      gestureRef.current = e.type === 'pointerup' ? { kind: 'pending', x: tg.x, y: tg.y, alt: false, mode: 'normal' } : null
      if (e.type === 'pointerup' && touchDoubleTap(e)) {
        gestureRef.current = null
        return
      }
    }
    if (tg?.kind === 'orbit' && e.pointerType === 'touch' && tg.t && performance.now() - tg.t < TOUCH_FLING_GAP_MS) {
      gestureRef.current = null
      debugLog(`[tuner] touch orbit fling ${(tg.vx ?? 0).toFixed(2)},${(tg.vy ?? 0).toFixed(2)} px/ms`)
      startInertia('orbit', tg.vx ?? 0, tg.vy ?? 0)
      setCursor('cursor-default')
      return
    }
    const g = gestureRef.current
    gestureRef.current = null
    endFly()
    if (g?.kind === 'handle' && dragPoseRef.current) {
      dragHeldRef.current = true
      const hold = ++dragHoldRef.current
      setTimeout(() => {
        if (hold !== dragHoldRef.current) return
        releaseDragHold()
        requestDraw()
      }, DRAG_HOLD_MAX_MS)
    }
    setReadout(null)
    setCursor('cursor-default')
    if (!g) return
    if (g.kind === 'unity') {
      unityEvent(e, 'up')
      requestDraw()
      return
    }
    if (g.kind === 'gizmo') {
      if (e.type === 'pointerup' && gizmoAt(e) === g.part) gizmoClick(g.part, e.shiftKey)
      gizmoHover(e)
    } else if (g.kind === 'pending') {
      clickSelect(e, g.mode)
    } else if (g.kind === 'marquee') {
      if (marqueeTimerRef.current) clearTimeout(marqueeTimerRef.current)
      marqueeTimerRef.current = null
      g.x1 = e.clientX
      g.y1 = e.clientY
      showMarquee(null)
      if (e.type === 'pointerup') runMarquee(g, true)
      else {
        marqueeSeqRef.current++
        onSelectionChange?.(g.start)
      }
    } else if (g.kind === 'pendingRight') {
      if (e.type === 'pointerup') openPierceMenu(e)
    } else if (g.kind === 'handle' && g.multi) {
      if (g.multi.last) onTransformMany?.(g.multi.last, true)
    } else if (g.kind === 'handle' && g.last) {
      onTransform(g.id, g.last, true)
    } else if (g.kind === 'rect') {
      endRect(g)
      if (g.handle.kind === 'move' && g.sent.size === 0) clickSelect(e)
      updateHover(e)
    }
    requestDraw()
  }

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('[data-viewport-ui]')) return
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
    const id = pickObject(e)
    if (!id) return
    onSelect(id)
    focusObject(id)
  }

  return (
    <div
      ref={wrapRef}
      data-scene-viewport
      data-selected-id={selected ?? ''}
      tabIndex={-1}
      className={`relative h-full w-full touch-none select-none overflow-hidden outline-none ${cursor}`}
      style={{ background: 'var(--sunken)' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        lastPtrRef.current = null
        unityRef.current?.push({ type: 'leave', x: 0, y: 0, w: 0, h: 0 })
        if (gizmoHoverRef.current != null) {
          gizmoHoverRef.current = null
          requestDraw()
        }
        if (!gestureRef.current && (hoverRef.current || hoverHandleRef.current)) {
          hoverRef.current = null
          hoverHandleRef.current = null
          requestDraw()
        }
      }}
      onDoubleClick={onDoubleClick}
      onKeyUp={(e) => {
        if (flyKey(e, false)) return
        const p = lastPtrRef.current
        if (p && (unityRef.current?.state.tool || unityRef.current?.state.editors) && (e.key === 'Control' || e.key === 'Meta' || e.key === 'Shift' || e.key === 'Alt'))
          unityEvent({ ...p, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey }, gestureRef.current?.kind === 'unity' ? 'drag' : 'move')
      }}
      onKeyDown={(e) => {
        if (flyKey(e, true)) return
        const p = lastPtrRef.current
        if (p && (unityRef.current?.state.tool || unityRef.current?.state.editors) && (e.key === 'Control' || e.key === 'Meta' || e.key === 'Shift' || e.key === 'Alt'))
          unityEvent({ ...p, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey }, gestureRef.current?.kind === 'unity' ? 'drag' : 'move')
        if (e.key === 'Escape' && cancelMarquee(true)) {
          e.preventDefault()
          e.stopPropagation()
          return
        }
        if (onEditKey && !e.altKey && !e.shiftKey && gestureRef.current == null) {
          const dup = (e.metaKey || e.ctrlKey) && e.code === 'KeyD'
          if (dup || e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault()
            e.stopPropagation()
            onEditKey(dup ? 'duplicate' : 'delete')
            return
          }
        }
        if (!(e.metaKey || e.ctrlKey) || e.altKey || !liveRef.current) return
        const k = e.key.toLowerCase()
        if (k !== 'z' && k !== 'y') return
        e.preventDefault()
        e.stopPropagation()
        void window.api.tuner.rect(projectPath, session, { op: k === 'y' || e.shiftKey ? 'redo' : 'undo' })
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={imgRef} className="absolute inset-0 h-full w-full" />
      <canvas
        data-unity-session={tunerSurfaceKey(projectPath, session)}
        className="pointer-events-none absolute left-1/2 top-0 h-full max-w-none"
        style={{
          width: 'auto',
          transform: `translateX(-50%)${surfaceView.flipY ? ' scaleY(-1)' : ''}`,
          visibility: surfaceView.shown ? undefined : 'hidden'
        }}
      />
      <canvas ref={ovRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      <div
        ref={marqueeRef}
        data-tuner-marquee
        style={{ display: 'none' }}
        className="pointer-events-none absolute border border-accent/80 bg-accent/15"
      />
      <span
        ref={readoutRef}
        style={{ display: 'none' }}
        className="pointer-events-none absolute left-2 top-2 rounded bg-elevated/90 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-ink shadow"
      />
      {children}
      {menu && (
        <PierceMenu
          x={menu.x}
          y={menu.y}
          hits={menu.hits}
          icons={pickIconsRef.current}
          pending={menu.pending}
          onPick={(hit) => applyPick(hit)}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  )
}
