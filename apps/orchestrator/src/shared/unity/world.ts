import { DEFAULT_STREAM_RES, normalizeStreamRes } from './stream-size'

export type Lifecycle =
  | 'init'
  | 'launching'
  | 'editmode'
  | 'entering-play'
  | 'playing'
  | 'exiting-play'
  | 'restarting'
  | 'error'
  | 'exited'

export const TRANSITIONAL_LIFECYCLES: ReadonlySet<Lifecycle> = new Set<Lifecycle>([
  'launching',
  'entering-play',
  'exiting-play',
  'restarting'
])

export type CompileState = 'idle' | 'compiling' | 'error'

export type UnityMode = 'normal' | 'headless-graphics' | 'headless-nographics'

export function isUnityMode(v: unknown): v is UnityMode {
  return v === 'normal' || v === 'headless-graphics' || v === 'headless-nographics'
}

export type InstanceRole = 'primary' | 'clone'

export type EditorFaultKind = 'crashed' | 'hung'

export interface InstanceObserved {
  id: string
  role: InstanceRole
  playerIndex: number

  lifecycle: Lifecycle
  compile: CompileState
  compileError: string | null
  error: string | null
  warning: string | null

  progressLabel: string
  progressPct: number
  noCamera: boolean

  scene: string

  refreshGen: number
  sceneGen: number
  playGen: number
  pauseGen: number
  assetSeq: number

  paused: boolean
  hotReloadActive: boolean
  sceneDirty: boolean
  dirtyScenes: string
  saving: boolean

  connected: boolean
  alive: boolean

  reachable: boolean

  fault: EditorFaultKind | ''
  faultReason: string
  faultLine: number
  stall: string
  logPath: string

  unityMode: UnityMode

  fps: number
  ping: number
}

export interface WorldObserved {
  version: number
  project: {
    path: string
    isUnityProject: boolean
    editorVersion?: string
  }
  scenes: string[]
  instances: Record<string, InstanceObserved>
}

export interface InstanceDesired {
  role: InstanceRole
  present: boolean
  playing: boolean
  paused: boolean
  scene: string
  hotReload: boolean

  refreshGen: number
  sceneGen: number
  sceneForceGen: number
  playGen: number
  pauseGen: number
  streamRes: string
  muted: boolean
  volume: number
  fpsCap: number
}

export interface WorldDesired {
  version: number
  playerCount: number
  stopped: boolean
  instances: Record<string, InstanceDesired>
}

export const MAX_RECENT_SCENES = 5
export { DEFAULT_STREAM_RES, normalizeStreamRes }
export const MAX_PLAYERS = 4
export const MAX_FPS_CAP = 1000

export function migrateStoredStreamRes(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_STREAM_RES
  return normalizeStreamRes(raw) ?? DEFAULT_STREAM_RES
}

export function emptyWorldObserved(projectPath: string): WorldObserved {
  return {
    version: 0,
    project: { path: projectPath, isUnityProject: false },
    scenes: [],
    instances: {}
  }
}

export function emptyWorldDesired(): WorldDesired {
  return { version: 0, playerCount: 1, stopped: false, instances: {} }
}

export function defaultInstanceDesired(role: InstanceRole): InstanceDesired {
  return {
    role,
    present: true,
    playing: false,
    paused: false,
    scene: '',
    hotReload: false,
    refreshGen: 0,
    sceneGen: 0,
    sceneForceGen: 0,
    playGen: 0,
    pauseGen: 0,
    streamRes: DEFAULT_STREAM_RES,
    muted: role === 'clone',
    volume: 1,
    fpsCap: 0
  }
}
