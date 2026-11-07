import type { HostKind } from './remote-host-kind'
import type { WindowSession } from './api'
import type { ClaudeRestorePromptState } from './claude-sessions'

export type RpcKind = 'invoke' | 'send' | 'sendSync'

export interface RemoteRpc {
  t: 'rpc'
  id: number
  kind: RpcKind
  ch: string
  args: unknown[]
}

export interface RemoteRpcResult {
  t: 'res'
  id: number
  ok: boolean
  value?: unknown
  error?: string
}

export interface RemoteEvent {
  t: 'evt'
  ch: string
  args: unknown[]
}

export interface RemoteHello {
  hostName: string
  version: string
  session: WindowSession | null
  phoneLogs?: RemotePhoneLogs
  kind: HostKind
  restorePrompts?: ClaudeRestorePromptState[]
}

export type RemotePhoneLogs = 'errors' | 'all'

export interface RemoteMediaReport {
  file: string
  root: string
}

export interface RemoteMediaRead {
  path: string
  offset: number
  length: number
  info?: boolean
  report?: RemoteMediaReport
}

export interface RemoteMediaInfo {
  width: number
  height: number
  fps?: number
  duration?: number
  audio?: boolean
  codec?: string
  exifTurned?: boolean
}

export interface RemoteMediaChunk {
  size: number
  mtime: number
  type: string
  offset: number
  data: Uint8Array
  info?: RemoteMediaInfo | null
}

export type RemoteRenditionId = '1080' | '720' | '480'

export interface RemoteVideoPlanAsk {
  path: string
  hevc?: boolean
  webm?: boolean
  prepare?: boolean
  rendition?: RemoteRenditionId
  urgent?: boolean
  drop?: boolean
  report?: RemoteMediaReport
}

export interface RemoteVideoRendition {
  id: RemoteRenditionId
  width: number
  height: number
  bitrate: number
  bytes: number
  state: 'ready' | 'queued' | 'preparing' | 'none' | 'skipped' | 'failed'
  progress?: number
  path?: string
  note?: string
}

export interface RemoteVideoStill {
  path: string
  width: number
  height: number
  bytes: number
}

export interface RemoteVideoVersion {
  state: 'ready' | 'queued' | 'preparing' | 'skipped' | 'failed'
  lossless?: boolean
  path?: string
  bytes?: number
  progress?: number
  label?: string
  note?: string
}

export interface RemoteVideoPlan {
  path: string
  reason: string
  plays: boolean
  label: string
  audio: boolean
  bytes?: number
  bitrate?: number
  width?: number
  height?: number
  version?: RemoteVideoVersion
  renditions?: RemoteVideoRendition[]
  slow?: boolean
}

export type RemoteDesktopCall = 'panelActions' | 'runPanelAction' | 'answerConfirm' | 'openFile' | 'pickerData' | 'pickerPick' | 'pickerDismiss' | 'fileVersions' | 'restoreToggle' | 'restoreAnswer'

export type RemoteStoreAction = 'setActiveWorkspace' | 'activateTab' | 'setActiveGroup' | 'setTabScratchpad' | 'openTabBeside' | 'exitFullscreen' | 'setViewerLive' | 'toggleBlame' | 'moveTab' | RemoteDesktopCall | RemoteHostCall

export type RemoteHostCall = 'openProject'

export const REMOTE_HOST_CALLS: readonly RemoteStoreAction[] = ['openProject']

export const REMOTE_STORE_ACTIONS: readonly RemoteStoreAction[] = ['setActiveWorkspace', 'activateTab', 'setActiveGroup', 'setTabScratchpad', 'openTabBeside', 'exitFullscreen', 'setViewerLive', 'toggleBlame', 'moveTab']

export const REMOTE_DESKTOP_CALLS: readonly RemoteStoreAction[] = ['panelActions', 'runPanelAction', 'answerConfirm', 'openFile', 'pickerData', 'pickerPick', 'pickerDismiss', 'fileVersions', 'restoreToggle', 'restoreAnswer']

export interface RemoteStoreActionRequest {
  reqId: number
  action: RemoteStoreAction
  args: unknown[]
  at?: number
  ttl?: number
}

export interface RemoteStatus {
  enabled: boolean
  url: string | null
  connected: boolean
  hostId: string
  phones: number
  paired: number
  pairCode: string | null
  phoneRelay: string | null
  phoneApp: PhoneAppCheck | null
}

export interface PhoneAppCheck {
  status: 'ok' | 'mismatch' | 'unknown'
  at: number
  web: string
  commit: string | null
  checked: number
  detail: string
  problems: string[]
}

export interface RemotePlace {
  ip?: string
  country?: string
  region?: string
  city?: string
}

export interface RemotePairedPhone {
  phoneId: string
  device: string
  ua: string
  uaShort: string
  email: string | null
  pairedEmail: string | null
  pairedAt: number
  pairedFrom: RemotePlace | null
  lastSeenAt: number | null
  lastFrom: RemotePlace | null
  online: number
  newCountry: boolean
  otherAccount: boolean
  accountChanged: boolean
}

export interface RemotePairAsk {
  id: string
  device: string
  ua: string
  uaShort: string
  email: string | null
  place: RemotePlace | null
  expiresAt: number
}

export interface RemotePairAnswer {
  ok: boolean
  state: 'allowed' | 'denied' | 'gone' | 'busy'
  phoneId?: string
}

export interface RemoteForgetResult {
  removed: string[]
  kicked: number
  phones: RemotePairedPhone[]
}

export interface RemoteUsageRow {
  cfEgress: number
  cfIngress: number
  turnTx: number
  turnRx: number
  turnEgress: number
  wsIn: number
  wsOut: number
  web: number
  mints: number
}

export interface RemoteTurnBytes {
  tx: number
  rx: number
  egress: number
}

export type RemoteUsageState = 'ok' | 'no-auth' | 'signed-out' | 'off' | 'other-relay' | 'no-accounts' | 'refused' | 'error'

export const REMOTE_ALLOWANCE_VERSION = 1

export interface RemoteAllowance {
  v: number
  tier: string
  period: string
  periodStart: number
  resetAt: number
  anchor: 'subscription' | 'utc-month'
  allowanceBytes: number
  usedBytes: number
  remainingBytes: number
  usedPercent: number
  turnBytes: number
  relayBytes: number
  overQuota: boolean
  enforce: boolean
  blocked: boolean
}

export interface RemoteVideoRefusal {
  code: string
  reason: string
  resetAt: number | null
  at: number
}

export function readAllowance(raw: unknown): RemoteAllowance | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (Number(r.v) !== REMOTE_ALLOWANCE_VERSION) return null
  const n = (k: string): number => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : 0)
  if (!(n('allowanceBytes') >= 0) || !n('resetAt')) return null
  return {
    v: REMOTE_ALLOWANCE_VERSION,
    tier: typeof r.tier === 'string' ? r.tier.slice(0, 20) : 'unknown',
    period: typeof r.period === 'string' ? r.period.slice(0, 20) : '',
    periodStart: n('periodStart'),
    resetAt: n('resetAt'),
    anchor: r.anchor === 'subscription' ? 'subscription' : 'utc-month',
    allowanceBytes: n('allowanceBytes'),
    usedBytes: n('usedBytes'),
    remainingBytes: n('remainingBytes'),
    usedPercent: n('usedPercent'),
    turnBytes: n('turnBytes'),
    relayBytes: n('relayBytes'),
    overQuota: r.overQuota === true,
    enforce: r.enforce === true,
    blocked: r.blocked === true
  }
}

export interface RemoteAccountUsage {
  state: RemoteUsageState
  detail: string
  at: number
  relay: string | null
  account: string | null
  day: string | null
  month: string | null
  today: RemoteUsageRow | null
  thisMonth: RemoteUsageRow | null
  total: RemoteUsageRow | null
  days: (RemoteUsageRow & { day: string })[]
  cloudflare: { enabled: boolean; at: number; error: string | null } | null
  allowance: RemoteAllowance | null
  access: 'any' | 'local' | null
  thisMac: { sinceStart: RemoteTurnBytes; since: number; pendingBytes: number; live: { session: string | null; path: 'local' | 'remote' | 'both' | null; total: RemoteTurnBytes } }
}

export interface RemotePresence {
  tabId: string
  device: string
}

export interface RemotePairInfo {
  code: string
  relay: string
  link: string
  expiresAt: number
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export function encodeRemote(msg: unknown): string {
  return JSON.stringify(msg, function (this: Record<string, unknown>, key, value) {
    const raw = this[key]
    if (raw instanceof Uint8Array) return { $u8: toBase64(raw) }
    if (raw instanceof ArrayBuffer) return { $u8: toBase64(new Uint8Array(raw)) }
    if (raw instanceof Map) return Object.fromEntries(raw)
    if (raw instanceof Set) return [...raw]
    return value
  })
}

export function decodeRemote<T = unknown>(text: string): T {
  return JSON.parse(text, (_key, value) =>
    value && typeof value === 'object' && typeof value.$u8 === 'string' && Object.keys(value).length === 1
      ? fromBase64(value.$u8)
      : value
  ) as T
}
