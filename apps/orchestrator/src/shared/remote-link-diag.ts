import type { LinkPeerDiag } from './remote-link'
import type { RvFilter, RvPreset } from './remote-video'

export interface RtcPair {
  local: string
  remote: string
  protocol: string
  relay: string | null
  server: string | null
  lan: boolean
}

function lanAddress(address: string | null | undefined): boolean {
  const a = String(address ?? '').toLowerCase().replace(/^::ffff:/, '')
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a)
  if (v4) {
    const x = Number(v4[1])
    const y = Number(v4[2])
    return x === 10 || (x === 172 && y >= 16 && y < 32) || (x === 192 && y === 168) || (x === 169 && y === 254)
  }
  return /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a)
}

export function sameNetwork(local: { type: string; address?: string | null }, remote: { type: string; address?: string | null }): boolean {
  if (local.type === 'relay' || remote.type === 'relay') return false
  return lanAddress(remote.address) || (local.type === 'host' && remote.type === 'host')
}

export interface PhoneLinkDiag {
  at: number
  calls: LinkPeerDiag & { channel: string; callMs: number | null; callP95: number | null }
  relay: { open: boolean; rttMs: number | null }
  rtc: { state: string; ice: string; pair: RtcPair | null; rttMs: number | null; outKbps: number | null; inKbps: number | null }
  video: {
    source: string | null
    state: string
    pair: RtcPair | null
    recvFps: number
    decodedFps: number
    shownFps: number
    kbps: number
    lossPct: number | null
    jitterMs: number | null
    frameAgeMs: number | null
    dropped: number
    freezes: number
    nack: number
    pli: number
    failed: number
    latencyMs: number | null
    waitMs: number | null
    firstFrameMs: number | null
  }
}

export interface MacChannel {
  ch: string
  outKbps: number
  inKbps: number
  bufferedKb: number
}

export interface MacVideoDiag {
  source: string | null
  encoder: string
  state: string
  pair: string
  rttMs: number | null
  lossPct: number | null
  sourceFps: number
  fedFps: number
  encodedFps: number
  fps: number
  kbps: number
  targetKbps: number | null
  availableKbps: number | null
  maxKbps: number
  maxSide: number
  fpsCap: number
  preset: RvPreset
  filter: RvFilter
  codec: string | null
  hardware: boolean | null
  width: number
  height: number
  limit: string | null
  keys: number
  nack: number
  pli: number
  resentKbps: number
  unsealed: number
}

export interface MacLinkDiag {
  at: number
  calls: LinkPeerDiag | null
  relay: { open: boolean; rttMs: number | null }
  rtc: { state: string; pair: string; rttMs: number | null }
  video: MacVideoDiag
  channels: MacChannel[]
}

export type VerdictKind = 'ok' | 'network' | 'app' | 'waiting'

export interface LinkVerdict {
  kind: VerdictKind
  text: string
}

export function fmtMs(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '–'
  return n >= 10_000 ? `${Math.round(n / 1000)} s` : `${Math.round(n)} ms`
}

export function fmtRate(kbps: number | null | undefined): string {
  if (kbps == null || !Number.isFinite(kbps)) return '–'
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`
}

const DOWN = new Set(['failed', 'disconnected', 'closed'])

export function linkVerdict(phone: PhoneLinkDiag | null, mac: MacLinkDiag | null): LinkVerdict {
  if (phone && !phone.relay.open) return { kind: 'network', text: 'Network: no connection to the relay' }
  if (phone && DOWN.has(phone.rtc.state)) return { kind: 'network', text: `Network: the WebRTC link is ${phone.rtc.state}, calls use the relay` }
  if (phone && phone.rtc.state !== 'connected') return { kind: 'waiting', text: 'Connecting the WebRTC link' }
  const v = mac?.video
  const pv = phone?.video
  const rtt = v?.rttMs ?? phone?.rtc.rttMs ?? null
  const loss = pv?.lossPct ?? v?.lossPct ?? null
  const slow: string[] = []
  if (rtt != null && rtt > 250) slow.push(`RTT ${fmtMs(rtt)}`)
  if (loss != null && loss >= 2) slow.push(`${loss}% loss`)
  if (v?.limit === 'bandwidth' && v.availableKbps != null && v.availableKbps < Math.min(3000, v.maxKbps / 2)) slow.push(`${fmtRate(v.availableKbps)} gets through`)
  if (pv?.source && pv.waitMs != null) {
    if (v && !v.source) return { kind: 'app', text: 'App: the desktop has no stream for this view yet' }
    if (v && v.sourceFps === 0) return { kind: 'app', text: 'App: Unity sends no frames to the desktop encoder' }
    if (pv.state !== 'connected') return { kind: pv.state === 'failed' ? 'network' : 'waiting', text: `Network: the video link is ${pv.state}` }
    if (v && v.encodedFps === 0) return { kind: 'app', text: `App: the desktop encoder is ${v.encoder}` }
    if (v && v.fps > 0 && pv.recvFps === 0) return { kind: 'network', text: `Network: frames leave the desktop but don't arrive${slow.length ? ` (${slow.join(', ')})` : ''}` }
    if (pv.failed > 0) return { kind: 'app', text: `App: ${pv.failed} frames failed to decrypt on the phone` }
    if (pv.recvFps > 0 && pv.decodedFps === 0) return { kind: 'app', text: 'App: the phone decodes nothing' }
    return { kind: 'waiting', text: `Waiting for the first frame, ${fmtMs(pv.waitMs)}` }
  }
  if (phone && !phone.calls.direct && phone.calls.last) return { kind: 'network', text: `Network: calls on the relay (${phone.calls.last.why})` }
  if (slow.length) return { kind: 'network', text: `Network: slow (${slow.join(', ')})` }
  const player = !!pv?.source && !pv.source.startsWith('tuner|')
  if (player && v && v.sourceFps === 0 && (pv?.frameAgeMs ?? 0) > 2000) return { kind: 'app', text: 'App: Unity sends no new frames' }
  if (player && v && v.sourceFps > 0 && v.sourceFps < 10 && v.sourceFps < v.fpsCap / 3) return { kind: 'app', text: `App: Unity sends ${v.sourceFps} fps` }
  if (player && v && v.limit === 'cpu') return { kind: 'app', text: `App: the desktop encoder is short of CPU, ${v.encodedFps} fps` }
  if (pv?.source && v && v.fps >= 6 && pv.recvFps < v.fps / 2) return { kind: 'network', text: `Network: ${pv.recvFps} of ${v.fps} fps arrive` }
  if (pv?.source && pv.recvFps >= 5 && pv.decodedFps < pv.recvFps * 0.7) return { kind: 'app', text: 'App: the phone decoder falls behind' }
  const bits = [`RTT ${fmtMs(rtt)}`]
  if (pv?.source) bits.push(`${pv.shownFps} fps`, fmtRate(pv.kbps))
  return { kind: 'ok', text: `OK · ${bits.join(' · ')}` }
}
