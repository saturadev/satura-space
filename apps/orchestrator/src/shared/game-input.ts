import type { RcEffective, RcPatch } from './remote-controls'

export const GI_RELIABLE = 'gin'
export const GI_FAST = 'ginu'

export interface GiBinding {
  id?: string
  path: string
  display: string
  dev: string
  ctl: string
  key: string
  groups: string
  interactions: string
  processors: string
  composite: string
  part: string
}

export interface GiAction {
  id: string
  name: string
  type: string
  control: string
  enabled: boolean
  interactions: string
  processors: string
  bindings: GiBinding[]
}

export interface GiMap {
  id: string
  name: string
  enabled: boolean
  actions: GiAction[]
}

export interface GiControlScheme {
  name: string
  group: string
  devices: string[]
}

export interface GiAsset {
  key: string
  name: string
  path: string
  sources: string[]
  schemes: GiControlScheme[]
  maps: GiMap[]
}

export interface GiPlayer {
  obj: string
  asset: string
  map: string
  scheme: string
  defaultScheme: string
  autoSwitch: boolean
  behavior: string
  active: boolean
  index: number
}

export interface GiScheme {
  v: number
  inputSystem: boolean
  gamepadModule?: boolean
  sdk?: boolean
  playing: boolean
  paused: boolean
  sig: string
  enabledCount: number
  assets: GiAsset[]
  players: GiPlayer[]
  loose: GiAction[]
}

export type GiEvent =
  | { k: 'kd'; t: number; c: string; r: number; m: number }
  | { k: 'ku'; t: number; c: string; m: number }
  | { k: 'md' | 'mu'; t: number; b: number; x: number; y: number; n: number; m: number }

export interface GiPayload {
  v: 3
  sid: string
  now: number
  focus: number
  ev?: GiEvent[]
  keys?: string[]
  btn?: number
  pb?: string[]
  nr?: number
  useq?: number
  hp?: number
  px?: number
  py?: number
  ha?: number
  ax?: number
  ay?: number
  aw?: number
  hpad?: number
  lx?: number
  ly?: number
  rx?: number
  ry?: number
  bye?: number
}

export interface GiLive {
  playing: boolean
  paused: boolean
  maps: string[]
  gamepadModule: boolean
}

export type GiPhoneMsg =
  | { t: 'hello'; sid: string }
  | { t: 'in'; p: GiPayload }
  | { t: 'override'; patch: RcPatch }
  | { t: 'bye' }

export type GiMacMsg =
  | { t: 'target'; source: string | null; project: string | null; clone: boolean }
  | { t: 'cursor'; source: string; locked: boolean; visible: boolean }
  | { t: 'controls'; project: string; controls: RcEffective | null; error?: string; saved?: string }
  | { t: 'live'; source: string; live: GiLive }
