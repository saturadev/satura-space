import { readTile, type RvLayout, type RvMacMsg, type RvMacStats, type RvPhoneMsg, type RvSettings, type RvSignal, type RvTunerMeta } from '@shared/remote-video'
import { unb64u } from '@shared/remote-e2e'
import { GI_FAST, GI_RELIABLE } from '@shared/game-input'
import { LINK_LABEL } from '@shared/remote-link'
import { applyPatch, type Operation } from 'fast-json-patch'
import type { TunerFrameMeta } from '@shared/tuner'
import { sameNetwork, type PhoneLinkDiag, type RtcPair } from '@shared/remote-link-diag'
import { STEPS, type StreamPath, type StreamStep } from './steps'

export interface ReceiverStats {
  state: string
  video: string
  fps: number
  kbps: number
  latency: number | null
  latencyP95: number | null
  rtt: number | null
  loss: number
  jitter: number | null
  width: number
  height: number
  painted: number
  codec: string | null
  mac: RvMacStats | null
  settings: RvSettings | null
  path: StreamPath | null
  pathRtt: number | null
  step: StreamStep
  stepAt: number
  furthest: StreamStep
  pair: RtcPair | null
  nack: number
  pli: number
  freezes: number
  dropped: number
  failed: number
}

export interface SignalPort {
  signal: (msg: RvSignal) => void
  onSignal: (cb: (msg: RvSignal) => void) => () => void
}

export interface ReceiverOptions {
  port: SignalPort
  secret: () => Uint8Array | null
  canvas?: HTMLCanvasElement | null
  source?: string | null
  onStats?: (s: ReceiverStats) => void
  onTunerFrame?: (m: RvTunerMeta) => void
  onTile?: (id: string, jpeg: Uint8Array) => void
  onLayout?: (l: RvLayout) => void
  onOpen?: () => void
  onTerm?: (text: string) => void
  onTermState?: (open: boolean) => void
  onMedia?: (ch: RTCDataChannel) => void
  onGameChannel?: (ch: RTCDataChannel) => void
  onLink?: (ch: RTCDataChannel, session: string) => void
}

interface VideoLink {
  id: string
  pc: RTCPeerConnection
  worker: Worker
  track: MediaStreamTrack | null
  chain: Promise<unknown>
  caps: Map<number, number>
  downAt: number
  prev: { at: number; received: number; decoded: number; bytes: number; lost: number; got: number; jbDelay: number; jbCount: number } | null
}

const PING_MS = 500
const REPORT_MS = 1000
const OFFSET_SAMPLES = 10
const RETRY_MS = 2000
const STALL_MS = 8000
const CONNECT_MS = 12_000
const VIDEO_DOWN_MS = 4000
const VIDEO_RETRY_MS = 1000
const CAPS_KEEP = 240

export type VideoDiag = PhoneLinkDiag['video'] & { rtc: PhoneLinkDiag['rtc'] }

function now(): number {
  return performance.timeOrigin + performance.now()
}

function newSessionId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function relayOnlyHint(): { policy?: 'relay' } {
  try {
    return localStorage.getItem('satura-remote-ice') === 'relay' ? { policy: 'relay' } : {}
  } catch {
    return {}
  }
}

function pct(list: number[], p: number): number | null {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))])
}

function pathOf(pair: RtcPair | null): StreamPath | null {
  if (!pair) return null
  return pair.local === 'relay' || pair.remote === 'relay' ? 'turn' : pair.lan ? 'lan' : 'direct'
}

async function selectedPair(pc: RTCPeerConnection): Promise<{ all: Map<string, Record<string, any>>; pair: RtcPair | null; stat: Record<string, any> | undefined }> {
  const stats = await pc.getStats()
  const all = new Map<string, Record<string, any>>()
  stats.forEach((r) => all.set(r.id, r as Record<string, any>))
  let stat: Record<string, any> | undefined
  for (const r of all.values()) if (r.type === 'transport' && r.selectedCandidatePairId) stat = all.get(String(r.selectedCandidatePairId))
  if (!stat) for (const r of all.values()) if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') stat = r
  if (!stat) return { all, pair: null, stat }
  const local = all.get(String(stat.localCandidateId))
  const remote = all.get(String(stat.remoteCandidateId))
  const server = typeof local?.url === 'string' ? local.url : null
  const lan = sameNetwork({ type: String(local?.candidateType), address: local?.address }, { type: String(remote?.candidateType), address: remote?.address })
  return { all, stat, pair: { local: String(local?.candidateType ?? '?'), remote: String(remote?.candidateType ?? '?'), protocol: String(local?.protocol ?? remote?.protocol ?? '?'), relay: local?.relayProtocol ? String(local.relayProtocol) : null, server, lan } }
}

function videoCodecs(): RTCRtpCodec[] {
  const all = RTCRtpReceiver.getCapabilities?.('video')?.codecs ?? []
  const rank = (c: RTCRtpCodec): number => {
    const f = c.sdpFmtpLine ?? ''
    if (c.mimeType !== 'video/H264') return ['video/rtx', 'video/red', 'video/ulpfec', 'video/flexfec-03'].includes(c.mimeType) ? 9 : -1
    if (!f.includes('packetization-mode=1')) return -1
    return /profile-level-id=64/.test(f) ? 0 : 1
  }
  return all.filter((c) => rank(c) >= 0).sort((a, b) => rank(a) - rank(b))
}

export class VideoReceiver {
  private session = newSessionId()
  private helloAt = 0
  private unsub: (() => void) | null = null
  private pc: RTCPeerConnection | null = null
  private ice: { iceServers: RTCIceServer[]; policy: RTCIceTransportPolicy } = { iceServers: [], policy: 'all' }
  private secret: Uint8Array | null = null
  private control: RTCDataChannel | null = null
  private term: RTCDataChannel | null = null
  private termFast: RTCDataChannel | null = null
  private video: VideoLink | null = null
  private retryVideo: ReturnType<typeof setTimeout> | null = null
  private el: HTMLVideoElement | null = null
  private elTrack: MediaStreamTrack | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private frameToken = 0
  private tapWait = false
  private timers: ReturnType<typeof setInterval>[] = []
  private offsets: { rtt: number; offset: number }[] = []
  private pingId = 0
  private pings = new Map<number, number>()
  private closed = false
  private metas: RvTunerMeta[] = []
  private lastMeta: TunerFrameMeta | null = null
  private lastControlAt = 0
  private heardAt = 0
  private paintAt = 0
  private sourceAt = 0
  private firstFrameMs: number | null = null
  private shownWin = 0
  private lat: number[] = []
  private rtc: PhoneLinkDiag['rtc'] = { state: 'new', ice: 'new', pair: null, rttMs: null, outKbps: null, inKbps: null }
  private rtcBytes = { at: 0, bytes: 0 }
  private vdiag: Pick<PhoneLinkDiag['video'], 'recvFps' | 'decodedFps' | 'shownFps' | 'kbps' | 'lossPct' | 'jitterMs' | 'pair'> = { recvFps: 0, decodedFps: 0, shownFps: 0, kbps: 0, lossPct: null, jitterMs: null, pair: null }
  private stats: ReceiverStats = {
    state: 'new',
    video: 'none',
    fps: 0,
    kbps: 0,
    latency: null,
    latencyP95: null,
    rtt: null,
    loss: 0,
    jitter: null,
    width: 0,
    height: 0,
    painted: 0,
    codec: null,
    mac: null,
    settings: null,
    path: null,
    pathRtt: null,
    step: 'desktop',
    stepAt: performance.now(),
    furthest: 'desktop',
    pair: null,
    nack: 0,
    pli: 0,
    freezes: 0,
    dropped: 0,
    failed: 0
  }
  private attemptAt = performance.now()

  constructor(private opts: ReceiverOptions) {
    this.setCanvas(opts.canvas ?? null)
  }

  setCanvas(canvas: HTMLCanvasElement | null): void {
    this.opts.canvas = canvas
    this.ctx = canvas ? (canvas.getContext('2d', { alpha: false, desynchronized: true }) as CanvasRenderingContext2D | null) : null
    this.applyFilter()
  }

  private applyFilter(): void {
    const c = this.opts.canvas
    if (c) c.style.imageRendering = this.stats.settings?.filter === 'pixel' ? 'pixelated' : ''
  }

  private step(next: StreamStep): void {
    const was = this.stats.step
    if (was === next) return
    const t = performance.now()
    console.log(`video: step ${was} took ${Math.round(t - this.stats.stepAt)} ms, now ${next} at ${Math.round(t - this.attemptAt)} ms`)
    this.stats.step = next
    this.stats.stepAt = t
    if (STEPS.indexOf(next) > STEPS.indexOf(this.stats.furthest)) this.stats.furthest = next
    if (next === 'live') this.stats.furthest = 'desktop'
    this.emit()
  }

  setSource(source: string | null): void {
    if ((this.opts.source ?? null) === source) return
    this.opts.source = source
    this.sourceAt = source ? performance.now() : 0
    this.firstFrameMs = null
    this.metas = []
    this.stats.width = 0
    this.stats.height = 0
    this.stats.painted = 0
    this.stats.furthest = 'desktop'
    if (source && this.open) {
      this.attemptAt = performance.now()
      this.stats.stepAt = this.attemptAt
      this.step(this.video?.pc.connectionState === 'connected' ? 'frame' : 'video')
    }
    this.send({ t: 'source', source })
    if (source) this.requestKey('a new source')
  }

  get source(): string | null {
    return this.opts.source ?? null
  }

  get open(): boolean {
    return this.control?.readyState === 'open'
  }

  async start(): Promise<void> {
    console.log(`video: RTCRtpScriptTransform=${typeof RTCRtpScriptTransform} rVFC=${typeof HTMLVideoElement.prototype.requestVideoFrameCallback} secure=${window.isSecureContext} ua=${navigator.userAgent}`)
    this.setState('signaling')
    if (this.closed) return
    this.unsub = this.opts.port.onSignal((m) => void this.onSignal(m))
    this.hello()
    this.timers.push(setInterval(() => this.ping(), PING_MS))
    this.timers.push(setInterval(() => void this.report(), REPORT_MS))
  }

  get lastHeard(): number {
    return this.heardAt
  }

  private hear(): void {
    this.heardAt = Date.now()
  }

  diag(): VideoDiag {
    const t = performance.now()
    const source = this.opts.source ?? null
    return {
      source,
      ...this.vdiag,
      state: this.video?.pc.connectionState ?? 'none',
      frameAgeMs: this.paintAt ? Math.round(t - this.paintAt) : null,
      dropped: this.stats.dropped,
      freezes: this.stats.freezes,
      nack: this.stats.nack,
      pli: this.stats.pli,
      failed: this.stats.failed,
      latencyMs: this.stats.latency,
      waitMs: source && this.firstFrameMs === null && this.sourceAt ? Math.round(t - this.sourceAt) : null,
      firstFrameMs: this.firstFrameMs,
      rtc: { ...this.rtc, state: this.pc?.connectionState ?? 'closed', ice: this.pc?.iceConnectionState ?? 'closed' }
    }
  }

  restart(why: string): void {
    if (this.closed || !this.helloAt) return
    const pc = this.pc
    this.pc = null
    this.control = null
    this.lastControlAt = 0
    this.closeVideo()
    pc?.close()
    this.session = newSessionId()
    console.log(`video: ${why}, starting over as ${this.session}`)
    this.setState('reconnecting')
    this.hello()
  }

  private hello(): void {
    this.helloAt = performance.now()
    this.attemptAt = this.helloAt
    this.stats.path = null
    this.secret = this.opts.secret()
    this.step('desktop')
    this.opts.port.signal({ type: 'hello', session: this.session, source: this.opts.source ?? undefined, ...relayOnlyHint() })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const t of this.timers) clearInterval(t)
    this.opts.port.signal({ type: 'bye', session: this.session })
    this.unsub?.()
    this.closeVideo()
    this.pc?.close()
    this.el?.remove()
    this.el = null
  }

  get termOpen(): boolean {
    return this.term?.readyState === 'open' && this.termFast?.readyState === 'open'
  }

  sendTerm(text: string): boolean {
    if (!this.termOpen || !this.term) return false
    try {
      this.term.send(text)
      return true
    } catch {
      return false
    }
  }

  send(msg: RvPhoneMsg): void {
    if (this.control?.readyState === 'open') this.control.send(JSON.stringify(msg))
  }

  set(settings: Partial<RvSettings>): void {
    this.send({ t: 'set', settings })
  }

  requestKey(why: string): void {
    this.send({ t: 'key' })
    const v = this.video
    if (!v) return
    v.worker.postMessage({ t: 'key', id: v.id, why })
  }

  private setState(s: string): void {
    this.stats.state = s
    this.emit()
  }

  private emit(): void {
    this.stats.video = this.video?.pc.connectionState ?? 'none'
    this.opts.onStats?.({ ...this.stats })
  }

  private async onSignal(m: RvSignal): Promise<void> {
    if (m.session !== this.session) return
    if (m.type === 'offer') {
      this.pc?.close()
      this.closeVideo()
      this.ice = { iceServers: (m.iceServers ?? []) as RTCIceServer[], policy: m.iceTransportPolicy ?? 'all' }
      const pc = new RTCPeerConnection({ iceServers: this.ice.iceServers, iceTransportPolicy: this.ice.policy })
      console.log(`video: ice servers=${m.iceServers?.length ?? 0} policy=${m.iceTransportPolicy ?? 'all'}`)
      this.pc = pc
      this.step('route')
      this.rtcBytes = { at: 0, bytes: 0 }
      pc.onicecandidate = (e) => {
        if (e.candidate) this.opts.port.signal({ type: 'candidate', session: this.session, candidate: e.candidate.candidate, mid: e.candidate.sdpMid ?? '0' })
      }
      pc.onconnectionstatechange = () => {
        if (this.pc !== pc) return
        console.log(`video: pc ${pc.connectionState}`)
        this.setState(pc.connectionState)
        if (pc.connectionState === 'connected') this.step('video')
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.retry(pc)
      }
      pc.oniceconnectionstatechange = () => {
        if (this.pc !== pc || (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') || this.stats.step !== 'route') return
        void this.readRtc().then(() => {
          if (this.pc === pc && this.stats.step === 'route') this.step('secure')
        })
      }
      pc.ondatachannel = (e) => this.onChannel(e.channel)
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp })
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      this.opts.port.signal({ type: 'answer', session: this.session, sdp: pc.localDescription?.sdp ?? answer.sdp ?? '' })
      return
    }
    if (m.type === 'candidate' && this.pc) {
      try {
        await this.pc.addIceCandidate({ candidate: m.candidate, sdpMid: m.mid })
      } catch (e) {
        console.log(`video: candidate rejected ${(e as Error).message}`)
      }
      return
    }
    if (m.type === 'bye') this.setState('closed')
  }

  private retry(pc: RTCPeerConnection): void {
    setTimeout(() => {
      if (this.closed || this.pc !== pc) return
      this.pc = null
      this.control = null
      this.closeVideo()
      pc.close()
      this.session = newSessionId()
      console.log(`video: reconnecting as ${this.session}`)
      this.hello()
    }, RETRY_MS)
  }

  askVideo(why: string): void {
    if (this.retryVideo) clearTimeout(this.retryVideo)
    this.retryVideo = null
    if (!this.open) return
    console.log(`video: asking the desktop for the video track (${why})`)
    this.send({ t: 'vstart' })
  }

  private askVideoSoon(why: string): void {
    if (this.retryVideo || this.closed) return
    this.retryVideo = setTimeout(() => {
      this.retryVideo = null
      this.askVideo(why)
    }, VIDEO_RETRY_MS)
  }

  private closeVideo(): void {
    const v = this.video
    if (!v) return
    this.video = null
    if (this.el && this.elTrack === v.track) {
      this.el.srcObject = null
      this.elTrack = null
      this.frameToken++
    }
    v.pc.close()
    v.worker.terminate()
    v.track?.stop()
  }

  private async onVideoOffer(m: Extract<RvMacMsg, { t: 'voffer' }>): Promise<void> {
    this.closeVideo()
    const secret = this.secret
    if (!secret || typeof RTCRtpScriptTransform !== 'function') {
      console.warn(`video: can't decrypt the game picture (${secret ? 'no RTCRtpScriptTransform in this browser' : 'no end-to-end key'})`)
      return
    }
    const pc = new RTCPeerConnection({ iceServers: this.ice.iceServers, iceTransportPolicy: this.ice.policy, bundlePolicy: 'max-bundle' })
    const worker = new Worker(new URL('./e2e-worker.ts', import.meta.url), { type: 'module', name: 'video-e2e' })
    const v: VideoLink = { id: m.id, pc, worker, track: null, chain: Promise.resolve(), caps: new Map(), downAt: 0, prev: null }
    this.video = v
    worker.onmessage = (e) => this.onWorker(v, e.data)
    pc.onicecandidate = (e) => {
      if (e.candidate && this.video === v) this.send({ t: 'vcand', id: v.id, candidate: e.candidate.candidate, mid: e.candidate.sdpMid ?? '0' })
    }
    pc.onconnectionstatechange = () => {
      if (this.video !== v) return
      const st = pc.connectionState
      console.log(`video: track link ${v.id} ${st}`)
      v.downAt = st === 'disconnected' ? performance.now() : 0
      if (st === 'connected' && this.source && this.stats.step === 'video') this.step('frame')
      if (st === 'failed') this.askVideoSoon('the video link failed')
      this.emit()
    }
    pc.ontrack = (e) => {
      if (this.video !== v) return
      e.receiver.transform = new RTCRtpScriptTransform(worker, { id: v.id, secret, salt: unb64u(m.salt, 16) })
      try {
        e.receiver.jitterBufferTarget = 0
      } catch {
      }
      v.track = e.track
      this.attachTrack()
    }
    v.chain = (async () => {
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp })
      const codecs = videoCodecs()
      for (const t of pc.getTransceivers()) if (codecs.length) t.setCodecPreferences(codecs)
      await pc.setLocalDescription()
      if (this.video === v && pc.localDescription) this.send({ t: 'vanswer', id: v.id, sdp: pc.localDescription.sdp })
    })().catch((e: Error) => {
      console.warn(`video: the video offer failed: ${e.message}`)
      if (this.video === v) this.askVideoSoon('the video offer failed')
    })
  }

  private onWorker(v: VideoLink, d: { t: string; rtp?: number; cap?: number; key?: boolean; stuck?: boolean; why?: string }): void {
    if (this.video !== v) return
    if (d.t === 'frame' && typeof d.rtp === 'number' && typeof d.cap === 'number') {
      v.caps.set(d.rtp, d.cap)
      if (v.caps.size > CAPS_KEEP) v.caps.delete(v.caps.keys().next().value as number)
      return
    }
    if (d.t === 'failed') {
      this.stats.failed++
      if (d.stuck) {
        console.warn(`video: ${this.stats.failed} frames failed to decrypt, asking for a new video track`)
        this.askVideo('frames keep failing to decrypt')
      }
      return
    }
    if (d.t === 'asked') console.log(`video: keyframe asked (${d.why})`)
  }

  private videoElement(): HTMLVideoElement {
    if (this.el) return this.el
    const el = document.createElement('video')
    el.muted = true
    el.playsInline = true
    el.autoplay = true
    el.setAttribute('playsinline', '')
    el.setAttribute('aria-hidden', 'true')
    el.dataset.rvVideo = ''
    el.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1'
    document.body.appendChild(el)
    this.el = el
    return el
  }

  private attachTrack(): void {
    const track = this.video?.track ?? null
    if (!track || this.elTrack === track) return
    const el = this.videoElement()
    this.elTrack = track
    el.srcObject = new MediaStream([track])
    const token = ++this.frameToken
    const play = (): void => {
      void el.play().then(
        () => console.log('video: the picture plays'),
        (e: Error) => {
          console.log(`video: play waits for a tap (${e.message})`)
          this.waitTap()
        }
      )
    }
    play()
    const onFrame = (_t: number, md: VideoFrameCallbackMetadata): void => {
      if (this.frameToken !== token) return
      this.paint(el, md)
      el.requestVideoFrameCallback(onFrame)
    }
    el.requestVideoFrameCallback(onFrame)
  }

  private waitTap(): void {
    if (this.tapWait) return
    this.tapWait = true
    const again = (): void => {
      document.removeEventListener('pointerdown', again, true)
      this.tapWait = false
      void this.el?.play().then(
        () => console.log('video: the picture plays after a tap'),
        () => this.waitTap()
      )
    }
    document.addEventListener('pointerdown', again, true)
  }

  private paint(el: HTMLVideoElement, md: VideoFrameCallbackMetadata): void {
    const c = this.opts.canvas
    const w = md.width
    const h = md.height
    if (!w || !h) return
    if (c && (c.width !== w || c.height !== h)) {
      c.width = w
      c.height = h
    }
    this.stats.width = w
    this.stats.height = h
    if (this.ctx) this.ctx.drawImage(el, 0, 0, w, h)
    this.shownWin++
    this.paintAt = performance.now()
    if (this.firstFrameMs === null && this.sourceAt) {
      this.firstFrameMs = Math.round(this.paintAt - this.sourceAt)
      console.info(`video: first frame of ${this.opts.source} after ${this.firstFrameMs} ms`)
    }
    this.stats.painted++
    if (this.stats.step !== 'live') this.step('live')
    const cap = typeof md.rtpTimestamp === 'number' ? this.video?.caps.get(md.rtpTimestamp) : undefined
    if (cap == null) return
    if (this.metas.length) {
      let i = -1
      for (let k = 0; k < this.metas.length; k++) if (this.metas[k].at <= cap + 2) i = k
      if (i >= 0) {
        const m = this.metas[i]
        this.metas.splice(0, i + 1)
        this.opts.onTunerFrame?.(m)
      }
    }
    const off = this.offset()
    if (off != null) this.lat.push(performance.timeOrigin + md.expectedDisplayTime - (cap - off))
  }

  private onChannel(ch: RTCDataChannel): void {
    ch.binaryType = 'arraybuffer'
    ch.addEventListener('message', () => this.hear())
    if (ch.label === 'control') {
      this.control = ch
      ch.onopen = () => {
        this.lastMeta = null
        this.send({ t: 'caps', tdelta: true })
        this.askVideo('the stream channel opened')
        this.ping()
        this.opts.onOpen?.()
      }
      ch.onmessage = (e) => this.onControl(JSON.parse(String(e.data)) as RvMacMsg)
      ch.onclose = () => {
        const pc = this.pc
        if (this.control !== ch || !pc) return
        console.log('video: the Mac closed the stream channel')
        this.retry(pc)
      }
      return
    }
    if (ch.label === 'media') {
      this.opts.onMedia?.(ch)
      return
    }
    if (ch.label === LINK_LABEL) {
      this.opts.onLink?.(ch, this.session)
      return
    }
    if (ch.label === GI_RELIABLE || ch.label === GI_FAST) {
      this.opts.onGameChannel?.(ch)
      return
    }
    if (ch.label === 'term' || ch.label === 'termu') {
      if (ch.label === 'term') this.term = ch
      else this.termFast = ch
      const changed = (): void => this.opts.onTermState?.(this.termOpen)
      ch.onopen = changed
      ch.onclose = changed
      ch.onmessage = (e) => {
        if (typeof e.data === 'string') this.opts.onTerm?.(e.data)
      }
      if (ch.readyState === 'open') changed()
      return
    }
    if (ch.label === 'tiles')
      ch.onmessage = (e) => {
        const t = readTile(e.data as ArrayBuffer)
        if (t) this.opts.onTile?.(t.id, t.jpeg)
      }
  }

  private onControl(m: RvMacMsg): void {
    this.lastControlAt = performance.now()
    if (m.t === 'pong') {
      const sent = this.pings.get(m.id)
      this.pings.delete(m.id)
      if (sent == null) return
      const t = now()
      const rtt = t - sent
      this.offsets.push({ rtt, offset: m.mac - (sent + t) / 2 })
      if (this.offsets.length > OFFSET_SAMPLES) this.offsets.shift()
      this.stats.rtt = rtt
      return
    }
    if (m.t === 'voffer') {
      console.log(`video: the desktop offers video track ${m.id}`)
      void this.onVideoOffer(m)
      return
    }
    if (m.t === 'vcand') {
      const v = this.video
      if (!v || v.id !== m.id) return
      v.chain = v.chain.then(() => v.pc.addIceCandidate({ candidate: m.candidate, sdpMid: m.mid })).catch((e: Error) => console.log(`video: video candidate rejected ${e.message}`))
      return
    }
    if (m.t === 'settings') {
      this.stats.settings = m.settings
      this.applyFilter()
      this.emit()
      return
    }
    if (m.t === 'stats') {
      this.stats.mac = m.stats
      return
    }
    if (m.t === 'tframe') {
      let meta = m.frame.meta
      if (m.mp) {
        if (!this.lastMeta) return
        meta = applyPatch(this.lastMeta, m.mp as Operation[], false, false).newDocument
      }
      if (!meta) return
      this.lastMeta = m.mp ? meta : structuredClone(meta)
      if (m.frame.key !== this.opts.source) return
      this.metas.push({ ...m.frame, meta: m.mp ? structuredClone(meta) : meta })
      if (this.metas.length > 30) this.metas.splice(0, this.metas.length - 30)
      return
    }
    if (m.t === 'layout') {
      this.opts.onLayout?.(m.layout)
      return
    }
    if (m.t === 'error') console.log(`video: mac error ${m.message}`)
  }

  private offset(): number | null {
    if (!this.offsets.length) return null
    let best = this.offsets[0]
    for (const o of this.offsets) if (o.rtt < best.rtt) best = o
    return best.offset
  }

  private ping(): void {
    if (!this.open && this.helloAt && performance.now() - this.helloAt > CONNECT_MS) {
      this.restart(`no stream link after ${Math.round((performance.now() - this.helloAt) / 1000)} s (${this.stats.state})`)
      return
    }
    const pc = this.pc
    const quietMs = Math.min(performance.now() - this.lastControlAt, Date.now() - this.heardAt)
    if (pc && this.control?.readyState === 'open' && this.lastControlAt && quietMs > STALL_MS) {
      console.log(`video: no word from the Mac for ${Math.round(quietMs / 1000)} s, reconnecting`)
      this.lastControlAt = 0
      pc.close()
      this.setState('reconnecting')
      this.retry(pc)
      return
    }
    const v = this.video
    if (v?.downAt && performance.now() - v.downAt > VIDEO_DOWN_MS) {
      v.downAt = 0
      this.askVideo(`the video link was down for ${VIDEO_DOWN_MS / 1000} s`)
    }
    const id = ++this.pingId
    const at = now()
    this.pings.set(id, at)
    if (this.pings.size > 20) this.pings.delete(this.pings.keys().next().value as number)
    this.send({ t: 'ping', id, at })
  }

  private async readRtc(): Promise<void> {
    const pc = this.pc
    if (!pc) return
    try {
      const { pair, stat } = await selectedPair(pc)
      let rttMs: number | null = null
      let outKbps: number | null = null
      let inKbps: number | null = null
      if (stat) {
        if (typeof stat.currentRoundTripTime === 'number') rttMs = Math.round(stat.currentRoundTripTime * 1000)
        if (typeof stat.availableOutgoingBitrate === 'number') outKbps = Math.round(stat.availableOutgoingBitrate / 1000)
        const bytes = Number(stat.bytesReceived) || 0
        const t = performance.now()
        if (this.rtcBytes.at && bytes >= this.rtcBytes.bytes) inKbps = Math.round(((bytes - this.rtcBytes.bytes) * 8) / (t - this.rtcBytes.at))
        this.rtcBytes = { at: t, bytes }
      }
      if (this.pc !== pc) return
      this.rtc = { state: pc.connectionState, ice: pc.iceConnectionState, pair, rttMs, outKbps, inKbps }
      if (!this.video) {
        this.stats.path = pathOf(pair)
        this.stats.pair = pair
        this.stats.pathRtt = rttMs
      }
    } catch {
    }
  }

  private async readVideo(): Promise<void> {
    const v = this.video
    if (!v) return
    const { all, pair, stat } = await selectedPair(v.pc)
    if (this.video !== v) return
    let inb: Record<string, any> | undefined
    for (const r of all.values()) if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r
    const codec = inb?.codecId ? all.get(String(inb.codecId)) : undefined
    const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
    const at = performance.now()
    const cur = { at, received: n(inb?.framesReceived), decoded: n(inb?.framesDecoded), bytes: n(inb?.bytesReceived), lost: n(inb?.packetsLost), got: n(inb?.packetsReceived), jbDelay: n(inb?.jitterBufferDelay), jbCount: n(inb?.jitterBufferEmittedCount) }
    const p = v.prev ?? cur
    v.prev = cur
    const secs = Math.max(0.001, (at - p.at) / 1000)
    const per = (a: number, b: number): number => Math.round(((a - b) / secs) * 10) / 10
    const lost = Math.max(0, cur.lost - p.lost)
    const seen = lost + Math.max(0, cur.got - p.got)
    const jb = cur.jbCount > p.jbCount ? Math.round(((cur.jbDelay - p.jbDelay) / (cur.jbCount - p.jbCount)) * 1000) : null
    const kbps = Math.round(per(cur.bytes, p.bytes) * 0.008)
    this.vdiag = { recvFps: per(cur.received, p.received), decodedFps: per(cur.decoded, p.decoded), shownFps: this.vdiag.shownFps, kbps, lossPct: seen ? Math.round((lost / seen) * 1000) / 10 : 0, jitterMs: jb, pair }
    this.stats.kbps = kbps
    this.stats.loss = this.vdiag.lossPct ?? 0
    this.stats.jitter = jb
    this.stats.nack = n(inb?.nackCount)
    this.stats.pli = n(inb?.pliCount) + n(inb?.firCount)
    this.stats.freezes = n(inb?.freezeCount)
    this.stats.dropped = n(inb?.framesDropped)
    this.stats.codec = typeof codec?.mimeType === 'string' ? codec.mimeType.replace('video/', '') : this.stats.codec
    this.stats.path = pathOf(pair)
    this.stats.pair = pair
    this.stats.pathRtt = typeof stat?.currentRoundTripTime === 'number' ? Math.round(stat.currentRoundTripTime * 1000) : null
  }

  private async report(): Promise<void> {
    const shown = this.shownWin
    this.shownWin = 0
    const lat = this.lat
    this.lat = []
    this.stats.fps = shown
    this.vdiag.shownFps = shown
    this.stats.latency = pct(lat, 0.5)
    this.stats.latencyP95 = pct(lat, 0.95)
    await this.readRtc()
    try {
      await this.readVideo()
    } catch {
    }
    this.emit()
  }
}
