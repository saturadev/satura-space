/// <reference lib="dom" />
import { ipcRenderer, sharedTexture } from 'electron'
import type { RvEncoderConfig, RvSenderStats, RvViewOut, RvViewRtc } from '@shared/remote-video'
import { sealFrame, videoFrameKey } from '@shared/remote-video-e2e'
import { debugLog } from '@shared/debug-log'
import { sameNetwork } from '@shared/remote-link-diag'
import { releaseTexture, type ReleasableTex } from '../../preload/texture-release'

interface ImportedTex extends ReleasableTex {
  getVideoFrame(): VideoFrame
}

interface FrameMsg {
  id: string
  surfaceId: number
  generation: number
  width: number
  height: number
  t: number
  q: number | null
}

interface Slots {
  generation: number
  width: number
  height: number
  map: Map<number, ImportedTex>
}

declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'video' })
  readonly writable: WritableStream<VideoFrame>
}

interface Video {
  id: string
  pc: RTCPeerConnection
  gen: MediaStreamTrackGenerator
  writer: WritableStreamDefaultWriter<VideoFrame>
  sender: RTCRtpSender
  key: Promise<CryptoKey>
  n: number
  unsealed: number
  fed: number
  written: number[]
  offs: number[]
  rtpBase: number
  rtpLast: number
  applying: Promise<void> | null
  again: boolean
  prev: { at: number; fed: number; encoded: number; sent: number; bytes: number; resent: number } | null
}

const REFEED_MS = 25
const STEADY_GAP_MS = 100
const MISSING_MS = 1500
const WRITTEN_KEEP = 48
const OFFS_KEEP = 120
const STATS_MS = 1000
const START_KBPS = 2500

const slots = new Map<string, Slots>()
const holds = new Map<string, { gen: number; upTo: number; pending: number; written: number }>()
let cfg: RvEncoderConfig | null = null
let active: string | null = null
let canvas: OffscreenCanvas | null = null
let scaler: string | null = null
let lastEncodeAt = 0
let pendingFrame: FrameMsg | null = null
let lastFed: { msg: FrameMsg; tex: ImportedTex; at: number } | null = null
let refeedTimer: ReturnType<typeof setTimeout> | null = null
let realAt = 0
let busy = 0
let video: Video | null = null
const missing = new Map<string, number>()
let askedAt = 0

function log(msg: string): void {
  console.log(msg)
}

function out(m: RvViewOut): void {
  ipcRenderer.send('rv:rtc', m)
}

function ack(id: string): void {
  const h = holds.get(id)
  if (!h) return
  try {
    ipcRenderer.send('unity:sharedHold', { id, gen: h.gen, upTo: h.upTo, held: [h.pending, h.written].filter((n) => n >= 0) })
  } catch {
  }
}

function release(t: ImportedTex): void {
  try {
    releaseTexture(t)
  } catch {
  }
}

function dropSlots(id: string): void {
  const s = slots.get(id)
  if (!s) return
  for (const t of s.map.values()) release(t)
  slots.delete(id)
}

function missKey(id: string, generation: number, surfaceId: number): string {
  return `${id}|${generation}|${surfaceId}`
}

function askMissing(now: number): void {
  if (!active || now - askedAt < MISSING_MS) return
  let oldest: { key: string; at: number } | null = null
  for (const [key, at] of missing) {
    if (now - at > 10_000) missing.delete(key)
    else if (key.startsWith(`${active}|`) && now - at >= MISSING_MS && (!oldest || at < oldest.at)) oldest = { key, at }
  }
  if (!oldest) return
  askedAt = now
  const surfaceId = Number(oldest.key.slice(oldest.key.lastIndexOf('|') + 1))
  const waited = Math.round(now - oldest.at)
  log(`no picture for surface ${surfaceId} after ${waited} ms, asking the Mac for it again`)
  ipcRenderer.send('rv:missing', { id: active, surfaceId, waited })
}

function even(n: number): number {
  return Math.max(16, Math.round(n / 2) * 2)
}

function targetSize(w: number, h: number, maxSide: number, pixel: boolean): { w: number; h: number } {
  const long = Math.max(w, h)
  const fit = maxSide > 0 && long > maxSide ? maxSide / long : 1
  const scale = pixel ? 1 / Math.ceil(1 / fit - 1e-6) : fit
  return { w: even(w * scale), h: even(h * scale) }
}

function captureOf(v: Video, rtp: number): number {
  if (v.rtpLast && rtp < v.rtpLast - 0x80000000) v.rtpBase += 0x100000000
  v.rtpLast = rtp
  const rtpMs = (v.rtpBase + rtp) / 90
  const last = v.written[v.written.length - 1]
  if (last !== undefined) v.offs.push(last - rtpMs)
  if (v.offs.length > OFFS_KEEP) v.offs.shift()
  const guess = rtpMs + Math.min(...v.offs)
  let exact = guess
  let gap = 2.5
  for (const t of v.written)
    if (Math.abs(t - guess) < gap) {
      gap = Math.abs(t - guess)
      exact = t
    }
  return exact
}

function codecs(): RTCRtpCodec[] {
  const all = RTCRtpSender.getCapabilities('video')?.codecs ?? []
  const rank = (c: RTCRtpCodec): number => {
    const f = c.sdpFmtpLine ?? ''
    if (c.mimeType !== 'video/H264') return c.mimeType === 'video/rtx' ? 10 : c.mimeType === 'video/red' || c.mimeType === 'video/ulpfec' || c.mimeType === 'video/flexfec-03' ? 11 : -1
    if (!f.includes('packetization-mode=1')) return -1
    return f.includes('profile-level-id=640034') ? 0 : f.includes('profile-level-id=42e01f') ? 1 : f.includes('profile-level-id=42001f') ? 2 : 3
  }
  return all.filter((c) => rank(c) >= 0).sort((a, b) => rank(a) - rank(b))
}

async function setParams(v: Video): Promise<void> {
  const c = cfg
  if (!c || video !== v) return
  const p = v.sender.getParameters()
  if (!p.encodings?.length) return
  p.encodings[0].maxBitrate = c.kbps * 1000
  p.encodings[0].maxFramerate = c.fps
  p.degradationPreference = c.degrade
  try {
    await v.sender.setParameters(p)
  } catch (e) {
    log(`video parameters refused: ${(e as Error).message}`)
  }
}

function applyParams(v: Video): Promise<void> {
  if (v.applying) {
    v.again = true
    return v.applying
  }
  v.applying = (async () => {
    do {
      v.again = false
      await setParams(v)
    } while (v.again && video === v)
  })().finally(() => {
    v.applying = null
  })
  return v.applying
}

function stopVideo(why: string): void {
  const v = video
  if (!v) return
  video = null
  log(`${v.id} video track closed: ${why}`)
  try {
    v.writer.releaseLock()
  } catch {
  }
  try {
    v.gen.stop()
  } catch {
  }
  v.pc.close()
}

async function seal(v: Video, f: RTCEncodedVideoFrame, ctl: TransformStreamDefaultController<RTCEncodedVideoFrame>): Promise<void> {
  const cap = captureOf(v, f.getMetadata().rtpTimestamp ?? 0)
  const sealed = await sealFrame(await v.key, ++v.n, new Uint8Array(f.data), cap)
  if (!sealed) {
    v.unsealed++
    return
  }
  f.data = sealed.buffer as ArrayBuffer
  ctl.enqueue(f)
}

async function startVideo(m: Extract<RvViewRtc, { t: 'start' }>): Promise<void> {
  stopVideo('replaced by a new one')
  const gen = new MediaStreamTrackGenerator({ kind: 'video' })
  gen.contentHint = 'motion'
  const pc = new RTCPeerConnection({ iceServers: m.iceServers, iceTransportPolicy: m.iceTransportPolicy, bundlePolicy: 'max-bundle', encodedInsertableStreams: true } as RTCConfiguration)
  const tr = pc.addTransceiver(gen, { direction: 'sendonly' })
  tr.setCodecPreferences(codecs())
  const v: Video = { id: m.id, pc, gen, writer: gen.writable.getWriter(), sender: tr.sender, key: videoFrameKey(m.secret, m.salt), n: 0, unsealed: 0, fed: 0, written: [], offs: [], rtpBase: 0, rtpLast: 0, applying: null, again: false, prev: null }
  video = v
  const streams = (tr.sender as unknown as { createEncodedStreams(): { readable: ReadableStream<RTCEncodedVideoFrame>; writable: WritableStream<RTCEncodedVideoFrame> } }).createEncodedStreams()
  void streams.readable
    .pipeThrough(new TransformStream<RTCEncodedVideoFrame, RTCEncodedVideoFrame>({ transform: (f, ctl) => seal(v, f, ctl) }))
    .pipeTo(streams.writable)
    .catch((e: Error) => {
      if (video === v) log(`${v.id} encrypt stream ended: ${e.message}`)
    })
  const gathered: string[] = []
  pc.onicecandidate = (e) => {
    if (video !== v) return
    if (!e.candidate) return log(`${v.id} video candidates: ${gathered.join(', ') || 'none'}`)
    const c = e.candidate
    gathered.push(c.type === 'host' ? `host ${c.address?.endsWith('.local') ? 'mDNS name' : c.address}` : String(c.type))
    out({ t: 'cand', id: v.id, candidate: c.candidate, mid: c.sdpMid ?? '0' })
  }
  pc.onicecandidateerror = (e) => {
    if (video === v) log(`${v.id} ICE server ${e.url} failed: ${e.errorCode} ${e.errorText}`)
  }
  pc.onconnectionstatechange = () => {
    if (video === v) out({ t: 'state', id: v.id, state: pc.connectionState })
  }
  await applyParams(v)
  await pc.setLocalDescription()
  if (video !== v || !pc.localDescription) return
  log(`${v.id} video offer: ${codecs().filter((c) => c.mimeType === 'video/H264').length} H.264 profiles, ${m.iceServers.length} ICE servers, policy ${m.iceTransportPolicy}`)
  out({ t: 'offer', id: v.id, sdp: pc.localDescription.sdp })
}

function startBitrate(sdp: string): string {
  const kbps = Math.min(START_KBPS, cfg?.kbps ?? START_KBPS)
  const h264 = new Set([...sdp.matchAll(/^a=rtpmap:(\d+) H264\/90000/gm)].map((m) => m[1]))
  return sdp.replace(/^(a=fmtp:(\d+) [^\r\n]*)/gm, (line, _all, pt: string) => (h264.has(pt) && !line.includes('x-google-start-bitrate') ? `${line};x-google-start-bitrate=${kbps}` : line))
}

function onRtc(m: RvViewRtc): void {
  if (m.t === 'start') {
    void startVideo(m).catch((e: Error) => log(`${m.id} video start failed: ${e.message}`))
    return
  }
  if (m.t === 'stop') return stopVideo('the phone left')
  const v = video
  if (!v || v.id !== m.id) return
  if (m.t === 'answer') {
    void v.pc.setRemoteDescription({ type: 'answer', sdp: startBitrate(m.sdp) }).catch((e: Error) => log(`${v.id} answer refused: ${e.message}`))
    return
  }
  void v.pc.addIceCandidate({ candidate: m.candidate, sdpMid: m.mid }).catch((e: Error) => log(`${v.id} candidate refused: ${e.message}`))
}

function encode(msg: FrameMsg, tex: ImportedTex): void {
  const c = cfg
  if (!c) return
  lastFed = { msg, tex, at: performance.now() }
  const v = video
  if (!v || v.pc.connectionState !== 'connected') return
  if (msg.t - lastEncodeAt < (1000 / c.fps) * 0.85) return
  if ((v.writer.desiredSize ?? 1) <= 0) {
    busy++
    return
  }
  const size = targetSize(msg.width, msg.height, c.maxSide, c.filter === 'pixel')
  let src: VideoFrame | null = null
  try {
    src = tex.getVideoFrame()
    if (!canvas || canvas.width !== size.w || canvas.height !== size.h) canvas = new OffscreenCanvas(size.w, size.h)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    const mode = `${c.filter} ${msg.width}x${msg.height} -> ${size.w}x${size.h}`
    if (scaler !== mode) {
      scaler = mode
      log(`scaler ${c.filter === 'pixel' ? 'nearest-neighbor' : 'smooth'}: ${msg.width}x${msg.height} -> ${size.w}x${size.h}`)
    }
    ctx.imageSmoothingEnabled = c.filter !== 'pixel'
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(src, 0, 0, size.w, size.h)
    v.written.push(msg.t)
    if (v.written.length > WRITTEN_KEEP) v.written.shift()
    const h = holds.get(msg.id)
    if (h && h.gen === msg.generation) h.written = msg.surfaceId
    v.fed++
    lastEncodeAt = msg.t
    void v.writer.write(new VideoFrame(canvas, { timestamp: Math.round(msg.t * 1000) })).catch((e: Error) => {
      if (video === v) log(`${v.id} frame write failed: ${e.message}`)
    })
  } catch (e) {
    log(`frame: ${(e as Error).message}`)
  } finally {
    src?.close()
  }
}

function arm(ms: number): void {
  if (refeedTimer) clearTimeout(refeedTimer)
  refeedTimer = setTimeout(refeed, ms)
}

function fresh(msg: FrameMsg, tex: ImportedTex): void {
  const at = performance.now()
  const gap = at - realAt
  realAt = at
  encode(msg, tex)
  arm(gap < STEADY_GAP_MS ? Math.max(REFEED_MS, gap * 1.5) : REFEED_MS)
}

function refeed(): void {
  refeedTimer = null
  const f = lastFed
  if (!f || !cfg || f.msg.id !== active) return
  const s = slots.get(f.msg.id)
  if (!s || s.generation !== f.msg.generation || s.map.get(f.msg.surfaceId) !== f.tex) {
    lastFed = null
    return
  }
  encode({ ...f.msg, t: f.msg.t + performance.now() - f.at }, f.tex)
  arm(REFEED_MS)
}

function onFrame(msg: FrameMsg): void {
  let h = holds.get(msg.id)
  if (!h || h.gen !== msg.generation) {
    h = { gen: msg.generation, upTo: 0, pending: -1, written: -1 }
    holds.set(msg.id, h)
    for (const key of [...missing.keys()]) if (key.startsWith(`${msg.id}|`)) missing.delete(key)
  }
  if (typeof msg.q === 'number') h.upTo = msg.q
  h.pending = -1
  if (msg.id !== active) {
    ack(msg.id)
    return
  }
  const s = slots.get(msg.id)
  const tex = s && s.generation === msg.generation ? s.map.get(msg.surfaceId) : undefined
  if (!tex) {
    pendingFrame = msg
    h.pending = msg.surfaceId
    const key = missKey(msg.id, msg.generation, msg.surfaceId)
    if (!missing.has(key)) missing.set(key, performance.now())
    ack(msg.id)
    return
  }
  pendingFrame = null
  fresh(msg, tex)
  ack(msg.id)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

async function readStats(v: Video): Promise<void> {
  const report = await v.pc.getStats()
  if (video !== v) return
  const all = new Map<string, Record<string, unknown>>()
  report.forEach((r) => all.set(r.id, r as Record<string, unknown>))
  let outbound: Record<string, unknown> | undefined
  let remote: Record<string, unknown> | undefined
  let transport: Record<string, unknown> | undefined
  for (const r of all.values()) {
    if (r.type === 'outbound-rtp' && r.kind === 'video') outbound = r
    if (r.type === 'remote-inbound-rtp' && r.kind === 'video') remote = r
    if (r.type === 'transport') transport = r
  }
  const pairStat = transport?.selectedCandidatePairId ? all.get(String(transport.selectedCandidatePairId)) : undefined
  const local = pairStat ? all.get(String(pairStat.localCandidateId)) : undefined
  const peer = pairStat ? all.get(String(pairStat.remoteCandidateId)) : undefined
  const codec = outbound?.codecId ? all.get(String(outbound.codecId)) : undefined
  const at = performance.now()
  const cur = { at, fed: v.fed, encoded: num(outbound?.framesEncoded), sent: num(outbound?.framesSent), bytes: num(outbound?.bytesSent), resent: num(outbound?.retransmittedBytesSent) }
  const p = v.prev
  v.prev = cur
  const secs = p ? Math.max(0.001, (at - p.at) / 1000) : 1
  const rate = (a: number, b: number): number => (p ? Math.round(((a - b) / secs) * 10) / 10 : 0)
  const impl = typeof outbound?.encoderImplementation === 'string' ? outbound.encoderImplementation : ''
  const rtt = typeof remote?.roundTripTime === 'number' ? remote.roundTripTime : typeof pairStat?.currentRoundTripTime === 'number' ? pairStat.currentRoundTripTime : null
  const stats: RvSenderStats = {
    id: v.id,
    state: v.pc.connectionState,
    pair: local && peer ? { local: String(local.candidateType ?? '?'), remote: String(peer.candidateType ?? '?'), protocol: String(local.relayProtocol ?? local.protocol ?? '?'), lan: sameNetwork({ type: String(local.candidateType), address: local.address as string }, { type: String(peer.candidateType), address: peer.address as string }) } : null,
    sent: num(transport?.bytesSent),
    received: num(transport?.bytesReceived),
    rttMs: rtt === null ? null : Math.round(rtt * 1000),
    lossPct: typeof remote?.fractionLost === 'number' ? Math.round(remote.fractionLost * 1000) / 10 : null,
    availableKbps: typeof pairStat?.availableOutgoingBitrate === 'number' ? Math.round(pairStat.availableOutgoingBitrate / 1000) : null,
    fedFps: rate(cur.fed, p?.fed ?? 0),
    encodedFps: rate(cur.encoded, p?.encoded ?? 0),
    fps: rate(cur.sent, p?.sent ?? 0),
    kbps: Math.round(rate(cur.bytes, p?.bytes ?? 0) * 0.008),
    resentKbps: Math.round(rate(cur.resent, p?.resent ?? 0) * 0.008),
    targetKbps: typeof outbound?.targetBitrate === 'number' ? Math.round(outbound.targetBitrate / 1000) : null,
    width: num(outbound?.frameWidth),
    height: num(outbound?.frameHeight),
    codec: typeof codec?.mimeType === 'string' ? `${codec.mimeType.replace('video/', '')}${typeof codec.sdpFmtpLine === 'string' ? ` ${/profile-level-id=(\w+)/.exec(codec.sdpFmtpLine)?.[1] ?? ''}` : ''}`.trim() : null,
    hardware: typeof outbound?.powerEfficientEncoder === 'boolean' ? outbound.powerEfficientEncoder : impl ? !/openh264|libvpx|libaom|fallback/i.test(impl) : null,
    limit: typeof outbound?.qualityLimitationReason === 'string' ? outbound.qualityLimitationReason : null,
    keys: num(outbound?.keyFramesEncoded),
    nack: num(outbound?.nackCount),
    pli: num(outbound?.pliCount) + num(outbound?.firCount),
    unsealed: v.unsealed
  }
  ipcRenderer.send('rv:stats', stats)
}

sharedTexture.setSharedTextureReceiver(async (data, meta?: { id: string; surfaceId: number; width: number; height: number; generation: number }) => {
  if (!meta) return
  const tex = data.importedSharedTexture as unknown as ImportedTex
  let s = slots.get(meta.id)
  if (s && (s.generation !== meta.generation || s.width !== meta.width || s.height !== meta.height)) {
    dropSlots(meta.id)
    s = undefined
  }
  if (!s) {
    s = { generation: meta.generation, width: meta.width, height: meta.height, map: new Map() }
    slots.set(meta.id, s)
  }
  const prev = s.map.get(meta.surfaceId)
  if (prev && prev !== tex) release(prev)
  s.map.set(meta.surfaceId, tex)
  missing.delete(missKey(meta.id, meta.generation, meta.surfaceId))
  const p = pendingFrame
  if (p && p.id === meta.id && p.generation === meta.generation && p.surfaceId === meta.surfaceId) {
    pendingFrame = null
    const h = holds.get(meta.id)
    if (h) h.pending = -1
    fresh(p, tex)
    ack(meta.id)
  }
})

window.addEventListener('unhandledrejection', (e) => {
  const msg = String((e.reason as Error | undefined)?.message ?? e.reason ?? '')
  if (msg.includes('IMPORT_SHARED_TEXTURE_RELEASE_RENDERER_TO_MAIN')) e.preventDefault()
})

ipcRenderer.on('rv:frame', (_e, msg: FrameMsg) => onFrame(msg))
ipcRenderer.on('rv:rtc', (_e, msg: RvViewRtc) => onRtc(msg))
ipcRenderer.on('rv:config', (_e, msg: { id: string | null; config: RvEncoderConfig | null }) => {
  if (active && msg.id !== active) holds.delete(active)
  active = msg.id
  cfg = msg.config
  if (video) void applyParams(video)
  if (!active) {
    pendingFrame = null
    lastFed = null
    missing.clear()
  }
})
setInterval(() => askMissing(performance.now()), 50)
setInterval(() => {
  const v = video
  if (v) void readStats(v).catch(() => {})
}, STATS_MS)
setInterval(() => {
  if (busy) debugLog(`skipped ${busy} frame(s): the video track was busy`)
  busy = 0
}, 5000)
