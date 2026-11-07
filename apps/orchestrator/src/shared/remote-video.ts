import type { TunerFrameMeta } from './tuner'
import type { MacLinkDiag, PhoneLinkDiag } from './remote-link-diag'

export const RV_PRESETS = {
  auto: { label: 'Auto', note: 'Best for your connection', mbps: 20, fps: 60, side: 1920 },
  sharp: { label: 'Sharp', note: 'More detail, needs a good connection', mbps: 20, fps: 60, side: 0 },
  smooth: { label: 'Smooth', note: 'Fewer stutters on weak Wi-Fi or mobile data', mbps: 2, fps: 30, side: 960 },
  saver: { label: 'Data saver', note: 'Low quality, uses little data', mbps: 0.6, fps: 30, side: 640 }
} as const
export type RvPreset = keyof typeof RV_PRESETS

export type RvFilter = 'smooth' | 'pixel'

export interface RvSettings {
  preset: RvPreset
  filter: RvFilter
}

export const RV_DEFAULTS: RvSettings = { preset: 'auto', filter: 'smooth' }

export type RvRtc =
  | { t: 'vstart' }
  | { t: 'voffer'; id: string; sdp: string; salt: string }
  | { t: 'vanswer'; id: string; sdp: string }
  | { t: 'vcand'; id: string; candidate: string; mid: string }

export type RvPhoneMsg =
  | { t: 'key' }
  | { t: 'set'; settings: Partial<RvSettings> }
  | { t: 'ping'; id: number; at: number }
  | { t: 'caps'; tdelta?: boolean }
  | { t: 'source'; source: string | null }
  | { t: 'layout'; on: boolean; tile?: { w: number; h: number } }
  | { t: 'diag'; diag: PhoneLinkDiag }
  | Exclude<RvRtc, { t: 'voffer' }>

export interface RvSenderStats {
  id: string
  state: string
  pair: { local: string; remote: string; protocol: string; lan: boolean } | null
  sent: number
  received: number
  rttMs: number | null
  lossPct: number | null
  availableKbps: number | null
  fedFps: number
  encodedFps: number
  fps: number
  kbps: number
  resentKbps: number
  targetKbps: number | null
  width: number
  height: number
  codec: string | null
  hardware: boolean | null
  limit: string | null
  keys: number
  nack: number
  pli: number
  unsealed: number
}

export interface RvEncoderConfig {
  fps: number
  kbps: number
  maxSide: number
  filter: RvFilter
  degrade: 'balanced' | 'maintain-framerate' | 'maintain-resolution'
}

export type RvViewRtc =
  | { t: 'start'; id: string; secret: Uint8Array; salt: Uint8Array; iceServers: RvIceServer[]; iceTransportPolicy: 'all' | 'relay' }
  | { t: 'answer'; id: string; sdp: string }
  | { t: 'cand'; id: string; candidate: string; mid: string }
  | { t: 'stop' }

export type RvViewOut = { t: 'offer'; id: string; sdp: string } | { t: 'cand'; id: string; candidate: string; mid: string } | { t: 'state'; id: string; state: string }

export interface RvMacStats {
  link: MacLinkDiag
}

export type RvMacMsg =
  | { t: 'pong'; id: number; at: number; mac: number }
  | { t: 'settings'; settings: RvSettings }
  | { t: 'stats'; stats: RvMacStats }
  | { t: 'error'; message: string }
  | { t: 'tframe'; frame: Omit<RvTunerMeta, 'meta'> & { meta?: TunerFrameMeta }; mp?: unknown[] }
  | { t: 'layout'; layout: RvLayout }
  | Exclude<RvRtc, { t: 'vstart' } | { t: 'vanswer' }>

export interface RvTunerMeta {
  at: number
  projectPath: string
  key: string
  flipY: boolean
  meta: TunerFrameMeta
}

export interface RvLayoutGroup {
  id: string
  tab?: string | null
  x: number
  y: number
  w: number
  h: number
}

export interface RvLayout {
  workspaceId: string | null
  width: number
  height: number
  groups: RvLayoutGroup[]
  focused: string | null
}

export const RV_TILE_MAGIC = 0x54

export function readTile(buf: ArrayBuffer | Uint8Array): { id: string; jpeg: Uint8Array } | null {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (u8.byteLength < 2 || u8[0] !== RV_TILE_MAGIC) return null
  const n = u8[1]
  if (u8.byteLength < 2 + n) return null
  return { id: new TextDecoder().decode(u8.subarray(2, 2 + n)), jpeg: u8.subarray(2 + n) }
}

export type RvIceServer = { urls: string | string[]; username?: string; credential?: string }

export type RvIce = { iceServers?: RvIceServer[]; iceTransportPolicy?: 'all' | 'relay' }

export type RvSignal =
  | ({ type: 'hello'; session: string; source?: string; policy?: 'relay' } & RvIce)
  | ({ type: 'offer'; session: string; sdp: string } & RvIce)
  | { type: 'answer'; session: string; sdp: string }
  | { type: 'candidate'; session: string; candidate: string; mid: string }
  | { type: 'bye'; session: string }
