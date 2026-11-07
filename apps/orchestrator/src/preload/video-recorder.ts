/// <reference lib="dom" />
import { ipcRenderer, sharedTexture } from 'electron'
import { writeFileSync } from 'node:fs'
import { GenerationLog, RetireLedger } from '@shared/unity/stream-state'
import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat
} from 'mediabunny'
import { debugLog } from '@shared/debug-log'
import { releaseTexture, type ReleasableTex } from './texture-release'

interface ImportedTex extends ReleasableTex {
  getVideoFrame(): VideoFrame
}

interface Slots {
  generation: number
  width: number
  height: number
  map: Map<number, ImportedTex>
}

interface FrameMsg {
  id: string
  surfaceId: number
  generation: number
  width: number
  height: number
  t: number
  u?: number | null
  q?: number | null
}

interface FrameHold {
  gen: number
  upTo: number
  pending: number
  inflight: { ts: number; sid: number; gen: number }[]
}

const frameHolds = new Map<string, FrameHold>()

function frameHold(id: string): FrameHold {
  let h = frameHolds.get(id)
  if (!h) {
    h = { gen: -1, upTo: 0, pending: -1, inflight: [] }
    frameHolds.set(id, h)
  }
  return h
}

function sendHold(id: string): void {
  const h = frameHolds.get(id)
  if (!h) return
  const held = [...new Set([h.pending, ...h.inflight.filter((f) => f.gen === h.gen).map((f) => f.sid)].filter((sid) => sid >= 0))]
  try {
    ipcRenderer.send('unity:sharedHold', { id, gen: h.gen, upTo: h.upTo, held })
  } catch {
  }
}

function dropHold(id: string): void {
  frameHolds.delete(id)
  releaseRetiring(id)
}

const gens = new Map<string, GenerationLog>()
let retiredDrops = 0

function genLog(id: string): GenerationLog {
  let g = gens.get(id)
  if (!g) {
    g = new GenerationLog()
    gens.set(id, g)
  }
  return g
}

function noteRetired(id: string, what: string, gen: number): void {
  retiredDrops++
  if (retiredDrops <= 5 || retiredDrops % 100 === 0) debugLog(`${id}: dropped a ${what} of retired gen ${gen} (${retiredDrops} so far)`)
}

const retiring = new Map<string, RetireLedger<ImportedTex>>()

function ledger(id: string): RetireLedger<ImportedTex> {
  let l = retiring.get(id)
  if (!l) {
    l = new RetireLedger<ImportedTex>()
    retiring.set(id, l)
  }
  return l
}

function retireSlots(id: string, s: Slots): void {
  if (!s.map.size) return
  ledger(id).retire(s.generation, [...s.map.values()])
  s.map.clear()
  releaseRetiring(id)
}

function releaseRetiring(id: string): void {
  const l = retiring.get(id)
  if (!l) return
  const h = frameHolds.get(id)
  for (const r of l.drain((gen) => !!h && h.inflight.some((f) => f.gen === gen))) {
    for (const t of r.items) {
      try {
        releaseTexture(t)
      } catch {
      }
    }
    debugLog(`${id}: released ${r.items.length} slot(s) of gen ${r.gen}: no frame of it left in the encoder`)
  }
  if (!l.size) retiring.delete(id)
}

interface VideoCodecChoice {
  config: VideoEncoderConfig
  mux: 'avc' | 'vp9'
}

interface Stored<C> {
  chunk: C
  meta?: EncodedVideoChunkMetadata | EncodedAudioChunkMetadata
}

interface Rec {
  id: string
  width: number
  height: number
  audio: boolean
  codec: VideoCodecChoice | null
  encoder: VideoEncoder | null
  aencoder: AudioEncoder | null
  amux: 'aac' | 'opus' | null
  aChannels: number
  aRate: number
  video: Stored<EncodedVideoChunk>[]
  sound: Stored<EncodedAudioChunk>[]
  error: string | null
  recording: boolean
  armedAt: number
  segStartT: number | null
  segStartU: number | null
  clockOffsetUs: number | null
  fps: number
  slotUs: number
  lastTs: number
  offsetUs: number
  lastKeyUs: number
  keyUs: number
  needKey: boolean
  frames: number
  dropped: number
  copied: number
  late: number
  lastQ: number
  chunkRegress: number
  tsRegress: number
  lastGen: number
  firstQ: number
  qRegress: number
  qGens: number
  audioAnchorUs: number | null
  audioSamples: number
  audioPeak: number | null
  startReq: number | null
  startTimer: ReturnType<typeof setTimeout> | null
  scaled: boolean
  canvas: OffscreenCanvas | null
  pendingFrame: FrameMsg | null
}

const SCALE_AFTER_MS = 2000
const START_WAIT_MS = 3000
const KEY_INTERVAL_US = 2_000_000
const SCRUB_KEY_INTERVAL_US = 250_000
const ZERO_COPY_QUEUE = 2
const MAX_QUEUE = 16
const CLOCK_RESET_US = 1_000_000
const FLUSH_WAIT_MS = 8000
const PAUSE_DRAIN_MS = 3000

const recs = new Map<string, Rec>()
const slots = new Map<string, Slots>()

function reply(req: number, payload: Record<string, unknown>): void {
  ipcRenderer.send('video:reply', { req, ...payload })
}

function dropSlots(id: string): void {
  const s = slots.get(id)
  if (!s) return
  slots.delete(id)
  retireSlots(id, s)
}

function bitrateFor(w: number, h: number): number {
  return Math.min(16_000_000, Math.max(2_000_000, Math.round(w * h * 60 * 0.08)))
}

async function pickVideoCodec(w: number, h: number, fps: number): Promise<VideoCodecChoice | string> {
  if (typeof VideoEncoder !== 'function')
    return `WebCodecs is unavailable in the recorder page (secure context: ${window.isSecureContext})`
  const reasons: string[] = []
  const bitrate = bitrateFor(w, h)
  const candidates: VideoCodecChoice[] = []
  for (const codec of ['avc1.640033', 'avc1.4d0033', 'avc1.42e033'])
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const)
      candidates.push({
        mux: 'avc',
        config: { codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality', hardwareAcceleration, avc: { format: 'avc' } }
      })
  candidates.push({ mux: 'vp9', config: { codec: 'vp09.00.40.08', width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality' } })
  for (const c of candidates) {
    try {
      const r = await VideoEncoder.isConfigSupported(c.config)
      if (r.supported) return c
      reasons.push(`${c.config.codec} ${c.config.hardwareAcceleration ?? 'no-preference'}: unsupported`)
    } catch (e) {
      reasons.push(`${c.config.codec}: ${(e as Error).message}`)
    }
  }
  return `no video encoder supports ${w}x${h} on this machine (${reasons.join('; ')})`
}

function fail(rec: Rec, message: string): void {
  if (!rec.error) console.warn(`${rec.id}: ${message}`)
  rec.error = rec.error ?? message
}

function makeEncoder(rec: Rec): void {
  if (!rec.codec || rec.encoder) return
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const h = frameHolds.get(rec.id)
      if (h) {
        h.inflight = h.inflight.filter((f) => f.ts > chunk.timestamp)
        sendHold(rec.id)
        if (retiring.has(rec.id)) releaseRetiring(rec.id)
      }
      if (recs.get(rec.id) !== rec) return
      const prevChunk = rec.video[rec.video.length - 1]?.chunk.timestamp
      if (prevChunk != null && chunk.timestamp <= prevChunk) {
        rec.chunkRegress++
        if (rec.chunkRegress <= 5) console.warn(`${rec.id}: encoder output ${chunk.timestamp} after ${prevChunk}`)
      }
      rec.video.push(rec.video.length === 0 ? { chunk, meta } : { chunk })
    },
    error: (e) => fail(rec, `video encoder: ${e.message}`)
  })
  encoder.configure(rec.codec.config)
  rec.encoder = encoder
}

async function makeAudioEncoder(rec: Rec, rate: number, channels: number): Promise<void> {
  const ch = Math.min(2, channels)
  rec.aRate = rate
  rec.aChannels = ch
  const options: { mux: 'aac' | 'opus'; config: AudioEncoderConfig }[] = []
  if (rec.codec?.mux === 'avc') options.push({ mux: 'aac', config: { codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: ch, bitrate: 160_000 } })
  options.push({ mux: 'opus', config: { codec: 'opus', sampleRate: rate, numberOfChannels: ch, bitrate: 128_000 } })
  for (const o of options) {
    try {
      if (!(await AudioEncoder.isConfigSupported(o.config)).supported) continue
    } catch {
      continue
    }
    const aenc = new AudioEncoder({
      output: (chunk, meta) => {
        if (recs.get(rec.id) !== rec) return
        rec.sound.push(rec.sound.length === 0 ? { chunk, meta } : { chunk })
      },
      error: (e) => fail(rec, `audio encoder: ${e.message}`)
    })
    aenc.configure(o.config)
    rec.aencoder = aenc
    rec.amux = o.mux
    return
  }
  console.warn(`${rec.id}: no audio encoder for ${rate} Hz x${ch}`)
}

function settleStart(rec: Rec, extra: Record<string, unknown>): void {
  if (rec.startTimer) clearTimeout(rec.startTimer)
  rec.startTimer = null
  const req = rec.startReq
  rec.startReq = null
  if (req != null) reply(req, { ok: true, ...extra })
}

function segmentUs(rec: Rec, tMs: number): number {
  if (rec.segStartU != null && rec.clockOffsetUs != null) return rec.offsetUs + tMs * 1000 - rec.clockOffsetUs - rec.segStartU * 1e6
  return rec.offsetUs + (tMs - (rec.segStartT ?? tMs)) * 1000
}

function frameTime(rec: Rec, msg: FrameMsg): number | null {
  let at: number
  if (msg.u != null && rec.segStartU != null) {
    at = rec.offsetUs + (msg.u - rec.segStartU) * 1e6
    if (rec.lastTs >= 0 && at < rec.lastTs - CLOCK_RESET_US) {
      rec.segStartU = msg.u - (rec.lastTs + rec.slotUs - rec.offsetUs) / 1e6
      at = rec.lastTs + rec.slotUs
    }
  } else at = segmentUs(rec, msg.t)
  let ts = Math.round(Math.max(0, Math.round(at / rec.slotUs)) * rec.slotUs)
  if (ts <= rec.lastTs) {
    ts = Math.round(rec.lastTs + rec.slotUs)
    if (ts - at > rec.slotUs) return null
  }
  return ts
}

function encodeFrame(rec: Rec, msg: FrameMsg, tex: ImportedTex): void {
  if (!rec.encoder || rec.error) return
  const matches = msg.width === rec.width && msg.height === rec.height
  if (rec.segStartT == null) {
    if (!matches && msg.t - rec.armedAt < SCALE_AFTER_MS) return
    rec.segStartT = msg.t
    rec.segStartU = msg.u ?? null
    if (rec.lastTs >= 0) rec.offsetUs = rec.lastTs + rec.slotUs
    if (!matches) rec.scaled = true
    settleStart(rec, matches ? {} : { scaled: true })
  }
  if (msg.u != null) {
    const off = msg.t * 1000 - msg.u * 1e6
    if (rec.clockOffsetUs == null || off < rec.clockOffsetUs) rec.clockOffsetUs = off
  }
  const queued = rec.encoder.encodeQueueSize
  if (queued > MAX_QUEUE) {
    rec.dropped++
    return
  }
  const ts = frameTime(rec, msg)
  if (ts == null) {
    rec.late++
    return
  }
  let src: VideoFrame | null = null
  let frame: VideoFrame | null = null
  try {
    src = tex.getVideoFrame()
    if (matches && queued < ZERO_COPY_QUEUE) frame = new VideoFrame(src, { timestamp: ts })
    else {
      if (!rec.canvas) rec.canvas = new OffscreenCanvas(rec.width, rec.height)
      const ctx = rec.canvas.getContext('2d', { alpha: false })
      if (!ctx) return
      if (matches) ctx.drawImage(src, 0, 0)
      else {
        const scale = Math.min(rec.width / msg.width, rec.height / msg.height)
        const w = msg.width * scale
        const h = msg.height * scale
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, rec.width, rec.height)
        ctx.drawImage(src, (rec.width - w) / 2, (rec.height - h) / 2, w, h)
      }
      frame = new VideoFrame(rec.canvas, { timestamp: ts })
      if (matches) rec.copied++
    }
    const keyFrame = rec.needKey || ts - rec.lastKeyUs >= rec.keyUs - rec.slotUs / 2
    if (keyFrame) {
      rec.lastKeyUs = ts
      rec.needKey = false
    }
    if (ts <= rec.lastTs) rec.tsRegress++
    rec.encoder.encode(frame, { keyFrame })
    frameHold(rec.id).inflight.push({ ts, sid: msg.surfaceId, gen: msg.generation })
    rec.lastTs = ts
    rec.frames++
    if (typeof msg.q === 'number') {
      if (rec.firstQ < 0) rec.firstQ = msg.q
      if (rec.lastQ >= 0 && msg.q <= rec.lastQ && msg.generation === rec.lastGen) {
        rec.qRegress++
        console.warn(`${rec.id}: encoded seq ${msg.q} after ${rec.lastQ} in gen ${msg.generation}`)
      }
      if (msg.generation !== rec.lastGen) rec.qGens++
      rec.lastQ = msg.q
    }
    rec.lastGen = msg.generation
  } catch (e) {
    fail(rec, `frame: ${(e as Error).message}`)
  } finally {
    frame?.close()
    src?.close()
  }
}

function onFrame(msg: FrameMsg): void {
  if (genLog(msg.id).admit(msg.generation) === 'retired') {
    noteRetired(msg.id, 'frame notice', msg.generation)
    return
  }
  const h = frameHold(msg.id)
  if (h.gen !== msg.generation) {
    h.gen = msg.generation
    h.pending = -1
  }
  if (typeof msg.q === 'number') h.upTo = msg.q
  h.pending = -1
  const rec = recs.get(msg.id)
  if (!rec || !rec.recording) {
    sendHold(msg.id)
    return
  }
  const s = slots.get(msg.id)
  const tex = s && s.generation === msg.generation ? s.map.get(msg.surfaceId) : undefined
  if (!tex) {
    rec.pendingFrame = msg
    h.pending = msg.surfaceId
    sendHold(msg.id)
    return
  }
  rec.pendingFrame = null
  encodeFrame(rec, msg, tex)
  sendHold(msg.id)
}

async function onAudio(msg: { id: string; channels: number; rate: number; data: Uint8Array; t: number }): Promise<void> {
  const rec = recs.get(msg.id)
  if (!rec || !rec.recording || !rec.audio || rec.segStartT == null || msg.t < rec.segStartT) return
  if (!rec.aencoder) {
    if (rec.aRate) return
    rec.aRate = msg.rate
    await makeAudioEncoder(rec, msg.rate, msg.channels)
    if (!rec.aencoder) return
  }
  if (msg.rate !== rec.aRate) return
  const floats = new Float32Array(msg.data.buffer, msg.data.byteOffset, Math.floor(msg.data.byteLength / 4))
  const inCh = msg.channels
  const frames = Math.floor(floats.length / inCh)
  if (!frames) return
  const ch = rec.aChannels
  let data = floats
  if (inCh !== ch) {
    data = new Float32Array(frames * ch)
    for (let i = 0; i < frames; i++) for (let c = 0; c < ch; c++) data[i * ch + c] = floats[i * inCh + c]
  }
  let peak = rec.audioPeak ?? 0
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(data[i])
    if (v > peak) peak = v
  }
  rec.audioPeak = peak
  if (rec.audioAnchorUs == null) {
    const lead = (frames / rec.aRate) * 1e6
    rec.audioAnchorUs = Math.max(rec.offsetUs, segmentUs(rec, msg.t) - lead)
    rec.audioSamples = 0
  }
  const timestamp = Math.round(rec.audioAnchorUs + (rec.audioSamples / rec.aRate) * 1e6)
  rec.audioSamples += frames
  let ad: AudioData | null = null
  try {
    ad = new AudioData({ format: 'f32', sampleRate: rec.aRate, numberOfFrames: frames, numberOfChannels: ch, timestamp, data: data as Float32Array<ArrayBuffer> })
    rec.aencoder.encode(ad)
  } catch (e) {
    fail(rec, `audio: ${(e as Error).message}`)
  } finally {
    ad?.close()
  }
}

function closeRec(rec: Rec): void {
  if (rec.startTimer) clearTimeout(rec.startTimer)
  for (const enc of [rec.encoder, rec.aencoder]) {
    try {
      if (enc && enc.state !== 'closed') enc.close()
    } catch {
    }
  }
  rec.encoder = null
  rec.aencoder = null
  dropHold(rec.id)
}

async function begin(msg: { req: number; id: string; width: number; height: number; audio: boolean; fps?: number; t: number }): Promise<void> {
  let rec = recs.get(msg.id)
  if (!rec) {
    const fps = Math.max(1, Math.min(240, Math.round(msg.fps ?? 30)))
    const codec = await pickVideoCodec(msg.width, msg.height, fps)
    if (typeof codec === 'string') {
      console.warn(`${msg.id}: ${codec}`)
      reply(msg.req, { ok: false, error: codec })
      return
    }
    rec = {
      id: msg.id,
      width: msg.width,
      height: msg.height,
      audio: msg.audio,
      codec,
      encoder: null,
      aencoder: null,
      amux: null,
      aChannels: 0,
      aRate: 0,
      video: [],
      sound: [],
      error: null,
      recording: false,
      armedAt: 0,
      segStartT: null,
      segStartU: null,
      clockOffsetUs: null,
      fps,
      slotUs: 1e6 / fps,
      lastTs: -1,
      offsetUs: 0,
      lastKeyUs: 0,
      keyUs: msg.audio ? KEY_INTERVAL_US : SCRUB_KEY_INTERVAL_US,
      needKey: true,
      frames: 0,
      dropped: 0,
      copied: 0,
      late: 0,
      lastQ: -1,
      chunkRegress: 0,
      tsRegress: 0,
      lastGen: -1,
      firstQ: -1,
      qRegress: 0,
      qGens: 0,
      audioAnchorUs: null,
      audioSamples: 0,
      audioPeak: null,
      startReq: null,
      startTimer: null,
      scaled: false,
      canvas: null,
      pendingFrame: null
    }
    recs.set(msg.id, rec)
    try {
      makeEncoder(rec)
    } catch (e) {
      recs.delete(msg.id)
      reply(msg.req, { ok: false, error: `video encoder: ${(e as Error).message}` })
      return
    }
  }
  if (rec.error) {
    reply(msg.req, { ok: false, error: rec.error })
    return
  }
  rec.recording = true
  rec.armedAt = msg.t
  rec.segStartT = null
  rec.needKey = true
  rec.audioAnchorUs = null
  rec.startReq = msg.req
  const armed = rec
  rec.startTimer = setTimeout(() => {
    if (armed.startReq == null) return
    settleStart(armed, { waiting: true })
  }, START_WAIT_MS)
}

async function pause(msg: { req: number; id: string; t: number }): Promise<void> {
  const rec = recs.get(msg.id)
  if (rec && rec.recording) {
    if (rec.lastTs >= 0) rec.offsetUs = rec.lastTs + rec.slotUs
    rec.recording = false
    rec.segStartT = null
    rec.segStartU = null
    rec.pendingFrame = null
    rec.audioAnchorUs = null
    rec.needKey = true
    settleStart(rec, { waiting: true })
    const enc = rec.encoder
    if (enc && enc.state === 'configured' && enc.encodeQueueSize + (frameHolds.get(rec.id)?.inflight.length ?? 0) > 0) {
      let timer: ReturnType<typeof setTimeout> | null = null
      const drained = await Promise.race([
        enc.flush().then(() => true, () => true),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(false), PAUSE_DRAIN_MS)))
      ])
      if (timer) clearTimeout(timer)
      if (!drained) console.warn(`${rec.id}: the encoder still holds frames ${PAUSE_DRAIN_MS} ms after the stop`)
    }
    sendHold(rec.id)
  }
  reply(msg.req, { ok: true })
}

async function mux(rec: Rec, path: string): Promise<{ path: string; bytes: number; codec: string }> {
  const webm = rec.codec?.mux === 'vp9'
  const out = webm ? path.replace(/\.[^./\\]+$/, '') + '.webm' : path
  const target = new BufferTarget()
  const output = new Output({ format: webm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
  const vsrc = new EncodedVideoPacketSource(webm ? 'vp9' : 'avc')
  output.addVideoTrack(vsrc)
  const withAudio = rec.sound.length > 0 && rec.amux != null && !(webm && rec.amux === 'aac')
  const asrc = withAudio ? new EncodedAudioPacketSource(rec.amux!) : null
  if (asrc) output.addAudioTrack(asrc)
  await output.start()
  const endUs = rec.offsetUs
  const items: { ts: number; add: () => Promise<void> }[] = []
  rec.video.forEach((v, i) => {
    const next = rec.video[i + 1]?.chunk.timestamp ?? Math.max(endUs, v.chunk.timestamp + 16_667)
    const duration = Math.max(1, next - v.chunk.timestamp) / 1e6
    const packet = EncodedPacket.fromEncodedChunk(v.chunk).clone({ duration })
    items.push({ ts: v.chunk.timestamp, add: () => vsrc.add(packet, v.meta as EncodedVideoChunkMetadata | undefined) })
  })
  if (asrc)
    for (const a of rec.sound) {
      if (a.chunk.timestamp > endUs && a !== rec.sound[0]) continue
      const packet = EncodedPacket.fromEncodedChunk(a.chunk)
      items.push({ ts: a.chunk.timestamp, add: () => asrc.add(packet, a.meta as EncodedAudioChunkMetadata | undefined) })
    }
  items.sort((a, b) => a.ts - b.ts)
  for (const it of items) await it.add()
  await output.finalize()
  const buf = target.buffer
  if (!buf) throw new Error('the muxer produced no data')
  writeFileSync(out, Buffer.from(buf))
  return { path: out, bytes: buf.byteLength, codec: `${webm ? 'vp9' : 'h264'}${asrc ? `+${rec.amux}` : ''}` }
}

async function finish(msg: { req: number; id: string; path: string }): Promise<void> {
  const rec = recs.get(msg.id)
  if (!rec) {
    reply(msg.req, { ok: false, error: 'the buffer is empty' })
    return
  }
  const flushStart = performance.now()
  let late: ReturnType<typeof setTimeout> | null = null
  const flushed = Promise.all([
    rec.encoder && rec.encoder.state === 'configured' ? rec.encoder.flush() : undefined,
    rec.aencoder && rec.aencoder.state === 'configured' ? rec.aencoder.flush() : undefined
  ]).then(
    () => true,
    (e) => {
      if (recs.get(rec.id) === rec) fail(rec, `flush: ${(e as Error).message}`)
      return true
    }
  )
  const waited = new Promise<boolean>((r) => (late = setTimeout(() => r(false), FLUSH_WAIT_MS)))
  if (!(await Promise.race([flushed, waited])))
    console.warn(`${msg.id}: encoder flush still running after ${FLUSH_WAIT_MS} ms; writing the ${rec.video.length} frames encoded so far`)
  if (late) clearTimeout(late)
  const flushMs = Math.round(performance.now() - flushStart)
  if (!rec.video.length) {
    reply(msg.req, { ok: false, error: rec.error ?? 'no frames were recorded. The Unity Player panel streams only in Play Mode, so nothing arrived while the editor was in Edit Mode. Enter Play (unity.play()) before or during the recording, and check that the Unity Player panel is open' })
    return
  }
  try {
    const r = await mux(rec, msg.path)
    const frames = rec.frames
    const dropped = rec.dropped
    const seconds = Math.round(rec.offsetUs / 1e5) / 10
    const audioPeak = rec.sound.length ? Math.round((rec.audioPeak ?? 0) * 1000) / 1000 : null
    closeRec(rec)
    recs.delete(msg.id)
    dropSlots(msg.id)
    console.log(
      `${msg.id}: wrote ${r.path} (${r.bytes} bytes, ${frames} frames at ${rec.fps} fps, ${seconds}s, ${r.codec}, a key frame every ${Math.round(rec.keyUs / rec.slotUs)} frames, flush ${flushMs} ms, copied ${rec.copied}, dropped ${dropped}, late ${rec.late}, clock ${rec.clockOffsetUs == null ? 'arrival' : 'unity'}, seq ${rec.firstQ}..${rec.lastQ} over ${rec.qGens} gen(s), ${rec.qRegress} out of order, ${retiredDrops} retired-gen drops, ts regress ${rec.tsRegress}, chunk regress ${rec.chunkRegress})`
    )
    reply(msg.req, { ok: true, ...r, frames, dropped, seconds, audioPeak })
  } catch (e) {
    reply(msg.req, { ok: false, error: `mux: ${(e as Error).message}` })
  }
}

function clear(msg: { req: number; id: string }): void {
  const rec = recs.get(msg.id)
  if (rec) {
    settleStart(rec, { waiting: true })
    closeRec(rec)
    recs.delete(msg.id)
  }
  dropSlots(msg.id)
  reply(msg.req, { ok: true })
}

sharedTexture.setSharedTextureReceiver(async (data, meta?: { id: string; surfaceId: number; width: number; height: number; generation: number }) => {
  if (!meta) return
  const tex = data.importedSharedTexture as unknown as ImportedTex
  if (genLog(meta.id).admit(meta.generation) === 'retired') {
    noteRetired(meta.id, 'texture', meta.generation)
    try {
      releaseTexture(tex)
    } catch {
    }
    return
  }
  let s = slots.get(meta.id)
  if (s && (s.generation !== meta.generation || s.width !== meta.width || s.height !== meta.height)) {
    retireSlots(meta.id, s)
    s = undefined
  }
  if (!s) {
    s = { generation: meta.generation, width: meta.width, height: meta.height, map: new Map() }
    slots.set(meta.id, s)
  }
  const prev = s.map.get(meta.surfaceId)
  if (prev && prev !== tex) {
    const h = frameHolds.get(meta.id)
    if (h && h.inflight.some((f) => f.gen === meta.generation && f.sid === meta.surfaceId)) ledger(meta.id).retire(meta.generation, [prev])
    else
      try {
        releaseTexture(prev)
      } catch {
      }
  }
  s.map.set(meta.surfaceId, tex)
  const rec = recs.get(meta.id)
  const p = rec?.pendingFrame
  if (rec && p && p.generation === meta.generation && p.surfaceId === meta.surfaceId) {
    rec.pendingFrame = null
    encodeFrame(rec, p, tex)
  }
})

window.addEventListener('unhandledrejection', (e) => {
  const msg = String((e.reason as Error | undefined)?.message ?? e.reason ?? '')
  if (msg.includes('IMPORT_SHARED_TEXTURE_RELEASE_RENDERER_TO_MAIN')) e.preventDefault()
})

ipcRenderer.on('video:frame', (_e, msg: FrameMsg) => onFrame(msg))
ipcRenderer.on('video:audio', (_e, msg) => void onAudio(msg))
ipcRenderer.on('video:begin', (_e, msg) => void begin(msg))
ipcRenderer.on('video:pause', (_e, msg) => void pause(msg))
ipcRenderer.on('video:finish', (_e, msg) => void finish(msg))
ipcRenderer.on('video:clear', (_e, msg) => clear(msg))
