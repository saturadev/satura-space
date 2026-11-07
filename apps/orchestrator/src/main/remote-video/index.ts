import { WebContentsView, app, ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { LINK_LABEL, LinkUnpacker, packLink, type LinkCodec } from '@shared/remote-link'
import { compare } from 'fast-json-patch'
import { writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { PeerConnection, cleanup as releaseDataChannels, type DataChannel, type DataChannelInitConfig } from 'node-datachannel'
import { clearSentTo, resendSurface } from '../unity/shared-surface'
import { censusGauge, censusLive } from '@shared/census'
import { libIceServers } from './ice'
import { setTermLink, termFromPhone, termLinkOpened } from '../remote/term-mirror'
import { answerMediaRequest } from '../remote/media-read'
import { gameInput } from './game-input'
import { GI_FAST, GI_RELIABLE } from '@shared/game-input'
import { RV_DEFAULTS, RV_PRESETS, type RvEncoderConfig, type RvIce, type RvMacMsg, type RvPhoneMsg, type RvSenderStats, type RvSettings, type RvSignal, type RvTunerMeta, type RvViewOut, type RvViewRtc } from '@shared/remote-video'
import { b64u } from '@shared/remote-e2e'
import { debugLog } from '@shared/debug-log'
import { countTraffic, dcLagKbps, dcLagMs, makeLag, recentKbps, recentTotalKbps } from '../remote/link-meter'
import type { LinkPeerDiag } from '@shared/remote-link'
import { linkVerdict, sameNetwork, type LinkVerdict, type MacLinkDiag, type MacVideoDiag, type PhoneLinkDiag } from '@shared/remote-link-diag'
import { TurnMeter, type TurnBytes, type TurnPath, type TurnSample } from './turn-meter'
import { LanFirst } from './lan-first'

const SUB_PREFIX = 'rv:'
const STATS_MS = 1000
const LOG_MS = 5000
const SOURCE_STALE_MS = 3000
const VIEW_IDLE_MS = 15_000
const VIEW_LOAD_MS = 20_000

export interface LinkInfo {
  calls: (cid: string | null) => LinkPeerDiag | null
  relay: () => { open: boolean; rttMs: number | null }
  videoSecret: (cid: string | null) => Buffer | null
}

interface Session {
  id: string
  gen: number
  peer: WebContents
  pc: PeerConnection
  ice: RvIce
  control: DataChannel | null
  tiles: DataChannel | null
  term: DataChannel | null
  termFast: DataChannel | null
  rpc: DataChannel | null
  owner: string | null
  secret: Buffer | null
  tdelta: boolean
  lastMeta: object | null
  channels: DataChannel[]
  source: string | null
  wantSource: string | null
  settings: RvSettings
  src: { frames: number; at: number; fps: number }
  rtt: number | null
  timers: NodeJS.Timeout[]
  heardAt: number
  pcState: string
  phoneDiag: PhoneLinkDiag | null
  phoneDiagAt: number
  turn: TurnMeter
  turnPair: string
  lan: LanFirst
  vlan: LanFirst | null
  vn: number
  vid: string | null
  vsalt: Buffer | null
  vstate: string
  vstats: RvSenderStats | null
  vturn: TurnMeter
  vpair: string
}

function now(): number {
  return performance.timeOrigin + performance.now()
}

const linkCodec: LinkCodec = { deflate: (raw) => deflateRawSync(raw), inflate: (packed) => inflateRawSync(packed) }

const closingChannels = new Set<DataChannel>()
const closingPeers = new Set<PeerConnection>()

function openChannel(pc: PeerConnection, label: string, init: DataChannelInitConfig, closed?: () => void): DataChannel {
  const ch = censusLive('remote-video.DataChannel', pc.createDataChannel(label, init))
  closingChannels.add(ch)
  ch.onClosed(() => {
    closingChannels.delete(ch)
    closed?.()
  })
  return ch
}

export interface LinkHandlers {
  message: (session: string, text: string) => void
  closed: (session: string) => void
}

const dcOut = makeLag(dcLagMs, dcLagKbps)
const dcIn = makeLag(dcLagMs, 0)

function lagSend(ch: DataChannel, label: string, data: Buffer | string): boolean {
  countTraffic('dc', 'out', label, data.length)
  if (!dcLagMs && !dcLagKbps) return typeof data === 'string' ? ch.sendMessage(data) : ch.sendMessageBinary(data)
  dcOut(data.length, () => {
    try {
      if (ch.isOpen()) typeof data === 'string' ? ch.sendMessage(data) : ch.sendMessageBinary(data)
    } catch {
    }
  })
  return true
}

class RemoteVideo {
  private started = false
  private session: Session | null = null
  private view: WebContentsView | null = null
  private ready: Promise<void> | null = null
  private viewReady = false
  private viewAt = 0
  private lastFrameAt = new Map<string, number>()
  private consumersChanged: ((worldId: string) => void) | null = null
  private sourceWanted: ((source: string) => void) | null = null
  private layoutHandler: ((on: boolean, tile: { w: number; h: number } | null, ended?: boolean) => void) | null = null
  private viewIdle: NodeJS.Timeout | null = null
  private gen = 0
  private listening = false
  private termCid: (() => string | null) | null = null
  private linkHandlers: LinkHandlers | null = null
  private linkInfo: LinkInfo | null = null
  private turnSink: ((cid: string, d: TurnBytes) => void) | null = null

  setTurnSink(fn: (cid: string, d: TurnBytes) => void): void {
    this.turnSink = fn
  }

  turnState(): { session: string | null; owner: string | null; path: TurnPath; total: TurnBytes } {
    const s = this.session
    const total = { tx: (s?.turn.total.tx ?? 0) + (s?.vturn.total.tx ?? 0), rx: (s?.turn.total.rx ?? 0) + (s?.vturn.total.rx ?? 0), egress: (s?.turn.total.egress ?? 0) + (s?.vturn.total.egress ?? 0) }
    return { session: s?.id ?? null, owner: s?.owner ?? null, path: s?.vturn.path ?? s?.turn.path ?? null, total }
  }

  setLinkInfo(info: LinkInfo): void {
    this.linkInfo = info
  }

  heardFrom(session: string | null): number {
    const s = this.session
    return s && session && s.id === session ? s.heardAt : 0
  }

  setLinkHandlers(h: LinkHandlers): void {
    this.linkHandlers = h
  }

  endOwnedBy(cids: Set<string>, why: string): boolean {
    const s = this.session
    if (!s || !s.owner || !cids.has(s.owner)) return false
    console.log(`[remote-video] ${s.id} ended: ${why}`)
    this.endSession()
    return true
  }

  linkOwner(session: string): string | null {
    const s = this.session
    return s && s.id === session && s.rpc?.isOpen() ? (s.owner ?? '') : null
  }

  linkSend(session: string | null, text: string, label: string): boolean {
    const s = this.session
    const ch = s && session && s.id === session ? s.rpc : null
    if (!ch || !ch.isOpen()) return false
    try {
      for (const part of packLink(text, linkCodec)) lagSend(ch, `rpc ${label}`, typeof part === 'string' ? part : Buffer.from(part.buffer, part.byteOffset, part.byteLength))
      return true
    } catch {
      return false
    }
  }

  censusSession(): number {
    return this.session ? 1 : 0
  }

  censusView(): number {
    return this.view && !this.view.webContents.isDestroyed() ? 1 : 0
  }

  censusSources(): number {
    return this.lastFrameAt.size
  }

  setTermCid(fn: () => string | null): void {
    this.termCid = fn
    setTermLink({
      open: () => !!this.session?.term?.isOpen() && !!this.session.termFast?.isOpen(),
      send: (fast, text) => {
        const ch = fast ? this.session?.termFast : this.session?.term
        if (!ch || !ch.isOpen()) return false
        countTraffic('dc', 'out', fast ? 'termu' : 'term', text.length)
        try {
          return ch.sendMessage(text)
        } catch {
          return false
        }
      },
      buffered: () => this.session?.termFast?.bufferedAmount() ?? 0
    })
  }

  setSourceWanted(fn: (source: string) => void): void {
    this.sourceWanted = fn
  }

  devSource(source: string): string | null {
    const s = this.session
    if (!s) return null
    s.wantSource = source || null
    this.pickSource(s)
    return s.source
  }

  setLayoutHandler(fn: (on: boolean, tile: { w: number; h: number } | null, ended?: boolean) => void): void {
    this.layoutHandler = fn
  }

  hasTiles(): boolean {
    return !!this.session?.tiles?.isOpen()
  }

  sendLayoutMsg(m: RvMacMsg): void {
    this.sendControl(m)
  }

  sendTile(id: string, jpeg: Buffer): boolean {
    const ch = this.session?.tiles
    if (!ch || !ch.isOpen()) return false
    const name = Buffer.from(id, 'utf8')
    const out = Buffer.alloc(2 + name.byteLength + jpeg.byteLength)
    out.writeUInt8(0x54, 0)
    out.writeUInt8(name.byteLength, 1)
    name.copy(out, 2)
    jpeg.copy(out, 2 + name.byteLength)
    try {
      lagSend(ch, 'tiles', out)
      return true
    } catch (e) {
      console.log(`[remote-video] tile send failed: ${(e as Error).message}`)
      return false
    }
  }

  setConsumersChanged(fn: (worldId: string) => void): void {
    this.consumersChanged = fn
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.listen()
    ipcMain.on('rvideo:signal', (e: IpcMainEvent, m: RvSignal) => {
      if (m && typeof m === 'object' && typeof m.session === 'string') this.onSignal(m, e.sender)
    })
  }

  stop(): void {
    this.endSession()
    this.closeView()
  }

  subscribersFor(worldId: string, base: Iterable<[string, number]>): Iterable<[string, number]> {
    const s = this.session
    const wc = this.view?.webContents
    if (!s || s.source !== worldId || !s.control || !wc || wc.isDestroyed() || !this.viewReady) return base
    return [...base, [SUB_PREFIX + worldId, wc.id]]
  }

  onFrame(worldId: string, surfaceId: number, generation: number, width: number, height: number, seq: number | null, tuner?: Omit<RvTunerMeta, 'at'>): void {
    const t = now()
    this.lastFrameAt.set(worldId, t)
    const s = this.session
    if (!s || !s.control) return
    if (s.source !== worldId) return
    s.src.frames++
    const wc = this.view?.webContents
    if (!wc || wc.isDestroyed() || !this.viewReady) return
    if (tuner) this.sendTframe(s, { ...tuner, at: t })
    wc.send('rv:frame', { id: SUB_PREFIX + worldId, surfaceId, generation, width, height, t, q: seq })
  }

  private sendTframe(s: Session, frame: RvTunerMeta): void {
    if (!s.tdelta) return this.sendControl({ t: 'tframe', frame })
    const text = JSON.stringify(frame.meta)
    const meta = JSON.parse(text) as object
    const base = s.lastMeta
    s.lastMeta = meta
    if (base) {
      const patch = compare(base, meta)
      if (JSON.stringify(patch).length < text.length / 2) {
        const { meta: _meta, ...rest } = frame
        return this.sendControl({ t: 'tframe', frame: rest, mp: patch })
      }
    }
    this.sendControl({ t: 'tframe', frame })
  }

  private liveSources(): string[] {
    const t = now()
    return [...this.lastFrameAt].filter(([, at]) => t - at < SOURCE_STALE_MS).map(([w]) => w)
  }

  private pickSource(s: Session): void {
    const best = s.wantSource
    if (best === s.source) return
    const prev = s.source
    s.source = best
    gameInput.setSource(best)
    debugLog(`[remote-video] ${s.id} source ${prev ?? 'none'} -> ${best ?? 'none'}${best && !this.liveSources().includes(best) ? ' (no frames from it yet)' : ''}`)
    if (best) {
      this.cancelViewIdle()
      void this.ensureView().then(() => {
        if (!this.viewReady || this.session !== s || s.source !== best) return
        this.sendConfig()
        this.sourceWanted?.(best)
      })
    } else this.closeViewWhenIdle()
    this.pushConfig()
    if (prev) this.consumersChanged?.(prev)
    if (best) this.consumersChanged?.(best)
  }

  private listen(): void {
    if (this.listening) return
    this.listening = true
    ipcMain.on('rv:rtc', (e: IpcMainEvent, m: RvViewOut) => {
      if (!this.view || e.sender !== this.view.webContents) return
      this.fromView(m)
    })
    ipcMain.on('rv:stats', (e: IpcMainEvent, m: RvSenderStats) => {
      const s = this.session
      if (!this.view || e.sender !== this.view.webContents || !s || m.id !== s.vid) return
      s.vstats = m
      this.sampleVideoTurn(s, m)
    })
    ipcMain.on('rv:error', (e: IpcMainEvent, m: { message: string }) => {
      if (!this.view || e.sender !== this.view.webContents) return
      this.sendControl({ t: 'error', message: m.message })
    })
    ipcMain.on('rv:missing', (e: IpcMainEvent, m: { id: string; surfaceId: number; waited: number }) => {
      if (!this.view || e.sender !== this.view.webContents) return
      this.onMissing(e.sender, m)
    })
  }

  private onMissing(wc: WebContents, m: { id: string; surfaceId: number; waited: number }): void {
    const s = this.session
    const source = s?.source
    if (!source || m.id !== SUB_PREFIX + source) return
    console.log(`[remote-video] the encoder has no picture for surface ${m.surfaceId} after ${m.waited} ms, sending ${source} again`)
    resendSurface(source, wc.id, m.id)
    this.sourceWanted?.(source)
  }

  private ensureView(): Promise<void> {
    if (this.ready && this.view && !this.view.webContents.isDestroyed()) {
      if (this.viewReady || performance.now() - this.viewAt < VIEW_LOAD_MS) return this.ready
      console.log(`[remote-video] the encoder page didn't load in ${VIEW_LOAD_MS / 1000} s, starting a new one`)
      this.closeView()
    }
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/remote-video.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    this.view = view
    this.viewReady = false
    this.viewAt = performance.now()
    const wc = view.webContents
    wc.on('console-message', (d) => console.log(`[remote-video] encoder: ${d.message}`))
    wc.on('render-process-gone', (_e, d) => {
      console.log(`[remote-video] encoder process gone: ${d.reason}`)
      if (this.view === view) {
        this.view = null
        this.ready = null
        this.viewReady = false
        const s = this.session
        if (s?.vid) this.startVideo(s)
      }
    })
    wc.on('destroyed', () => clearSentTo(wc.id))
    const page = join(app.getPath('userData'), 'remote-video.html')
    writeFileSync(page, '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>remote-video</title>')
    this.ready = wc.loadFile(page).then(
      () => {
        if (this.view !== view || wc.isDestroyed()) return
        this.viewReady = true
        clearSentTo(wc.id)
        debugLog(`[remote-video] encoder page loaded in ${Math.round(performance.now() - this.viewAt)} ms`)
        this.sendConfig()
      },
      (e: Error) => {
        if (this.view !== view) return
        console.log(`[remote-video] the encoder page failed to load: ${e.message}`)
        this.closeView()
      }
    )
    return this.ready
  }

  private cancelViewIdle(): void {
    if (this.viewIdle) clearTimeout(this.viewIdle)
    this.viewIdle = null
  }

  private closeViewWhenIdle(): void {
    if (this.viewIdle || !this.view) return
    this.viewIdle = setTimeout(() => {
      this.viewIdle = null
      if (this.session) return
      console.log('[remote-video] no phone video link, closing the encoder')
      this.closeView()
    }, VIEW_IDLE_MS)
  }

  private idleView(): void {
    this.toView({ t: 'stop' })
    const wc = this.view?.webContents
    if (wc && !wc.isDestroyed() && this.viewReady) wc.send('rv:config', { id: null, config: null })
    this.closeViewWhenIdle()
  }

  private closeView(): void {
    this.cancelViewIdle()
    const view = this.view
    this.view = null
    this.ready = null
    this.viewReady = false
    if (!view || view.webContents.isDestroyed()) return
    clearSentTo(view.webContents.id)
    view.webContents.close()
  }

  private signal(s: Session, m: RvSignal): void {
    if (s.peer.isDestroyed()) return
    s.peer.send('rvideo:signal', m)
  }

  private onSignal(m: RvSignal, peer: WebContents): void {
    if (m.type === 'hello') {
      this.endSession()
      this.newSession(m.session, m.source ?? null, peer, { iceServers: m.iceServers, iceTransportPolicy: m.iceTransportPolicy === 'relay' || process.env.SATURA_REMOTE_ICE_POLICY === 'relay' ? 'relay' : 'all' })
      return
    }
    const s = this.session
    if (!s || m.session !== s.id) return
    if (m.type === 'answer') s.pc.setRemoteDescription(m.sdp, 'answer')
    else if (m.type === 'candidate')
      s.lan.phoneCandidate(m.candidate, () => {
        if (this.session !== s) return
        try {
          s.pc.addRemoteCandidate(m.candidate, m.mid)
        } catch (e) {
          console.log(`[remote-video] candidate rejected: ${(e as Error).message}`)
        }
      })
    else if (m.type === 'bye') this.endSession()
  }

  private newSession(id: string, wantSource: string | null, peer: WebContents, ice: RvIce): void {
    const gen = ++this.gen
    const relayOnly = ice.iceTransportPolicy === 'relay'
    const pc = censusLive('remote-video.PeerConnection', new PeerConnection(`rv-${id}`, { iceServers: libIceServers(ice.iceServers), maxMessageSize: 262144, ...(relayOnly ? { iceTransportPolicy: 'relay' as const } : {}) }))
    closingPeers.add(pc)
    debugLog(`[remote-video] ${id} ice servers=${ice.iceServers?.length ?? 0} policy=${relayOnly ? 'relay' : 'all'}`)
    const owner = (peer as unknown as { cid?: string }).cid ?? null
    const s: Session = {
      id,
      gen,
      peer,
      pc,
      ice,
      control: null,
      tiles: null,
      term: null,
      termFast: null,
      rpc: null,
      owner,
      secret: this.linkInfo?.videoSecret(owner) ?? null,
      tdelta: false,
      lastMeta: null,
      channels: [],
      source: null,
      wantSource,
      settings: { ...RV_DEFAULTS },
      src: { frames: 0, at: performance.now(), fps: 0 },
      rtt: null,
      timers: [],
      heardAt: 0,
      pcState: 'new',
      phoneDiag: null,
      phoneDiagAt: 0,
      turn: new TurnMeter(),
      turnPair: '',
      lan: new LanFirst(id, (line) => console.log(`[remote-video] ${line}`)),
      vlan: null,
      vn: 0,
      vid: null,
      vsalt: null,
      vstate: 'new',
      vstats: null,
      vturn: new TurnMeter(),
      vpair: ''
    }
    censusLive('remote-video.Session', s)
    this.session = s
    if (relayOnly) s.lan.release('relay only')
    pc.onLocalDescription((sdp, type) => {
      if (type === 'offer') this.signal(s, { type: 'offer', session: id, sdp, iceServers: ice.iceServers, ...(relayOnly ? { iceTransportPolicy: 'relay' as const } : {}) })
    })
    pc.onLocalCandidate((candidate, mid) => {
      s.lan.ownCandidate(candidate)
      this.signal(s, { type: 'candidate', session: id, candidate, mid })
    })
    pc.onStateChange((state) => {
      console.log(`[remote-video] ${id} ${state}`)
      s.pcState = state
      if (state === 'connected') s.lan.release('connected')
      if (state === 'closed') closingPeers.delete(pc)
      if ((state === 'failed' || state === 'closed') && this.session?.gen === gen) this.endSession()
    })
    const control = openChannel(pc, 'control', { unordered: false }, () => {
      if (this.session?.gen === gen) this.endSession()
    })
    const tiles = openChannel(pc, 'tiles', { unordered: false })
    tiles.onOpen(() => {
      s.tiles = tiles
    })
    const term = openChannel(pc, 'term', { unordered: false })
    const termFast = openChannel(pc, 'termu', { unordered: true, maxRetransmits: 0 })
    s.channels = [control, tiles, term, termFast]
    const termReady = (): void => {
      if (s.term && s.termFast && this.session === s) {
        debugLog(`[remote-video] ${id} terminal channels open`)
        termLinkOpened()
      }
    }
    term.onOpen(() => {
      s.term = term
      termReady()
    })
    termFast.onOpen(() => {
      s.termFast = termFast
      termReady()
    })
    const media = openChannel(pc, 'media', { unordered: false })
    s.channels.push(media)
    const rpc = openChannel(pc, LINK_LABEL, { unordered: false }, () => {
      if (s.rpc !== rpc) return
      s.rpc = null
      this.linkHandlers?.closed(id)
    })
    s.channels.push(rpc)
    const unpack = new LinkUnpacker(linkCodec)
    rpc.onOpen(() => {
      if (this.session !== s) return
      s.rpc = rpc
      debugLog(`[remote-video] ${id} call channel open`)
    })
    rpc.onMessage((msg) => {
      if (this.session !== s) return
      s.heardAt = Date.now()
      const data = typeof msg === 'string' ? msg : Buffer.isBuffer(msg) ? msg : Buffer.from(msg as ArrayBuffer)
      countTraffic('dc', 'in', 'rpc', data.length)
      dcIn(data.length, () => {
        if (this.session !== s) return
        let text: string | null = null
        try {
          text = unpack.push(data)
        } catch (e) {
          console.log(`[remote-video] ${id} call frame could not be read: ${(e as Error).message}`)
          return
        }
        if (text !== null) this.linkHandlers?.message(id, text)
      })
    })
    const gin = openChannel(pc, GI_RELIABLE, { unordered: false }, () => {
      if (this.session === s) gameInput.detach('input channel closed')
    })
    const ginu = openChannel(pc, GI_FAST, { unordered: true, maxRetransmits: 0 })
    s.channels.push(gin, ginu)
    gin.onOpen(() => {
      if (this.session !== s) return
      gameInput.setSource(s.source)
      gameInput.attachReliable(gin)
    })
    ginu.onOpen(() => {
      if (this.session === s) gameInput.attachFast(ginu)
    })
    gin.onMessage((msg) => {
      if (this.session !== s) return
      s.heardAt = Date.now()
      gameInput.onReliable(msg)
    })
    ginu.onMessage((msg) => {
      if (this.session !== s) return
      s.heardAt = Date.now()
      gameInput.onFast(msg)
    })
    media.onMessage((msg) => {
      if (typeof msg !== 'string') return
      s.heardAt = Date.now()
      void answerMediaRequest(msg).then((out) => {
        if (media.isOpen()) lagSend(media, 'media', out)
      })
    })
    term.onMessage((msg) => {
      if (typeof msg !== 'string') return
      s.heardAt = Date.now()
      const cid = this.termCid?.()
      if (!cid) return
      try {
        termFromPhone(cid, JSON.parse(msg))
      } catch {
      }
    })
    control.onOpen(() => {
      s.control = control
      debugLog(`[remote-video] ${id} control open`)
      this.cancelViewIdle()
      void this.ensureView()
      this.pickSource(s)
      this.pushConfig()
      this.sendSettings()
    })
    control.onMessage((msg) => {
      if (typeof msg !== 'string') return
      s.heardAt = Date.now()
      countTraffic('dc', 'in', 'control', msg.length)
      dcIn(msg.length, () => {
        try {
          this.onControl(s, JSON.parse(msg) as RvPhoneMsg)
        } catch {
        }
      })
    })
    s.timers.push(setInterval(() => this.tickStats(s), STATS_MS))
    s.timers.push(setInterval(() => this.logStats(s), LOG_MS))
    if (!s.secret) console.log(`[remote-video] ${id} has no end-to-end key for phone ${owner ?? '-'}, the game picture can't start`)
  }

  private endSession(): void {
    const s = this.session
    if (!s) return
    this.session = null
    gameInput.detach('video session ended')
    for (const t of s.timers) clearInterval(t)
    s.timers = []
    s.lan.stop()
    s.vlan?.stop()
    for (const ch of s.channels) {
      try {
        ch.close()
      } catch {
      }
    }
    s.channels = []
    this.sampleTurn(s)
    const turn = this.turnState().total
    if (turn.tx || turn.rx) console.log(`[remote-video] ${s.id} TURN carried ${turn.tx} B out and ${turn.rx} B in, ${turn.egress} B of it Cloudflare egress`)
    s.secret?.fill(0)
    const hadRpc = !!s.rpc
    s.control = s.tiles = s.term = s.termFast = s.rpc = null
    if (hadRpc) this.linkHandlers?.closed(s.id)
    try {
      s.pc.close()
    } catch {
    }
    this.idleView()
    if (s.source) this.consumersChanged?.(s.source)
    this.layoutHandler?.(false, null, true)
    console.log(`[remote-video] ${s.id} ended`)
  }

  private onControl(s: Session, m: RvPhoneMsg): void {
    if (m.t === 'ping') {
      this.sendControl({ t: 'pong', id: m.id, at: m.at, mac: now() })
      return
    }
    if (m.t === 'key') {
      const source = s.source
      if (source)
        void this.ensureView().then(() => {
          if (!this.viewReady || this.session !== s || s.source !== source) return
          this.sendConfig()
          this.sourceWanted?.(source)
        })
      return
    }
    if (m.t === 'vstart') return this.startVideo(s)
    if (m.t === 'vanswer') {
      if (m.id === s.vid) this.toView({ t: 'answer', id: m.id, sdp: m.sdp })
      return
    }
    if (m.t === 'vcand') {
      if (m.id === s.vid) s.vlan?.phoneCandidate(m.candidate, () => s.vid === m.id && this.toView({ t: 'cand', id: m.id, candidate: m.candidate, mid: m.mid }))
      return
    }
    if (m.t === 'caps') {
      s.tdelta = m.tdelta === true
      s.lastMeta = null
      return
    }
    if (m.t === 'set') {
      this.applySettings(s, m.settings)
      return
    }
    if (m.t === 'source') {
      s.wantSource = typeof m.source === 'string' && m.source ? m.source : null
      this.pickSource(s)
      return
    }
    if (m.t === 'layout') {
      this.layoutHandler?.(!!m.on, m.tile && m.tile.w > 0 && m.tile.h > 0 ? m.tile : null)
      return
    }
    if (m.t === 'diag') {
      s.phoneDiag = m.diag
      s.phoneDiagAt = Date.now()
    }
  }

  private startVideo(s: Session): void {
    const secret = s.secret
    if (!secret) {
      this.sendControl({ t: 'error', message: 'The desktop has no end-to-end key for the game picture. Reconnect the phone.' })
      return
    }
    const id = `${s.id}.${++s.vn}`
    const salt = randomBytes(16)
    s.vid = id
    s.vsalt = salt
    s.vstate = 'new'
    s.vstats = null
    s.vpair = ''
    s.vlan?.stop()
    const vlan = new LanFirst(`${id} video`, (line) => console.log(`[remote-video] ${line}`))
    s.vlan = vlan
    const lan = this.onLan(s)
    if (!lan) vlan.release('the data channel is not on the same network')
    console.log(`[remote-video] ${id} the phone asked for the video track, ${lan ? 'the data channel is on the same network, so the video tries that route first' : 'the data channel goes over the internet'}`)
    void this.ensureView().then(() => {
      if (!this.viewReady || this.session !== s || s.vid !== id) return
      this.sendConfig()
      this.toView({ t: 'start', id, secret: new Uint8Array(secret), salt: new Uint8Array(salt), iceServers: s.ice.iceServers ?? [], iceTransportPolicy: s.ice.iceTransportPolicy === 'relay' ? 'relay' : 'all' })
    })
  }

  private fromView(m: RvViewOut): void {
    const s = this.session
    if (!s || m.id !== s.vid) return
    if (m.t === 'offer') return this.sendControl({ t: 'voffer', id: m.id, sdp: m.sdp, salt: b64u(s.vsalt ?? new Uint8Array(0)) })
    if (m.t === 'cand') {
      s.vlan?.ownCandidate(m.candidate)
      return this.sendControl({ t: 'vcand', id: m.id, candidate: m.candidate, mid: m.mid })
    }
    s.vstate = m.state
    if (m.state === 'connected') s.vlan?.release('video track connected')
    console.log(`[remote-video] ${m.id} video track ${m.state}`)
  }

  private toView(m: RvViewRtc): void {
    const wc = this.view?.webContents
    if (wc && !wc.isDestroyed() && this.viewReady) wc.send('rv:rtc', m)
  }

  degradeNow(): string | null {
    return this.session ? this.encoderConfig(this.session).degrade : null
  }

  setSettings(p: Partial<RvSettings>): RvSettings | null {
    if (this.session) this.applySettings(this.session, p)
    return this.session?.settings ?? null
  }

  private applySettings(s: Session, p: Partial<RvSettings>): void {
    const next = { ...s.settings }
    if (p.preset != null && p.preset in RV_PRESETS) next.preset = p.preset
    if (p.filter === 'smooth' || p.filter === 'pixel') next.filter = p.filter
    s.settings = next
    const c = this.encoderConfig(s)
    console.log(`[remote-video] settings ${next.preset}/${next.filter}: ${c.maxSide || 'full'} px, ${c.fps} fps, up to ${c.kbps} kbps, ${c.degrade}, ${c.filter === 'pixel' ? 'nearest-neighbor' : 'smooth'} scaling`)
    this.pushConfig()
    this.sendSettings()
  }

  private encoderConfig(s: Session): RvEncoderConfig {
    const p = RV_PRESETS[s.settings.preset]
    const pixel = s.settings.filter === 'pixel'
    const degrade = s.settings.preset === 'sharp' || (pixel && s.settings.preset === 'auto') ? 'maintain-resolution' : s.settings.preset === 'auto' ? 'balanced' : 'maintain-framerate'
    return { fps: p.fps, kbps: Math.round(p.mbps * 1000), maxSide: p.side, filter: s.settings.filter, degrade }
  }

  private pushConfig(): void {
    if (this.ready) void this.ready.then(() => this.sendConfig())
  }

  private sendConfig(): void {
    const s = this.session
    const wc = this.view?.webContents
    if (!s || !wc || wc.isDestroyed() || !this.viewReady) return
    wc.send('rv:config', { id: s.source ? SUB_PREFIX + s.source : null, config: this.encoderConfig(s) })
  }

  private sendControl(m: RvMacMsg): void {
    const c = this.session?.control
    if (!c || !c.isOpen()) return
    try {
      lagSend(c, `control ${m.t}`, JSON.stringify(m))
    } catch {
    }
  }

  private sendSettings(): void {
    const s = this.session
    if (!s) return
    this.sendControl({ t: 'settings', settings: s.settings })
  }

  private path(s: Session): string {
    try {
      const pair = s.pc.getSelectedCandidatePair()
      if (!pair) return 'connecting'
      return `${pair.local.type}/${pair.remote.type} ${pair.remote.transportType}${sameNetwork(pair.local, pair.remote) ? ' same network' : ''}`.toLowerCase()
    } catch {
      return 'unknown'
    }
  }

  private onLan(s: Session): boolean {
    try {
      const pair = s.pc.getSelectedCandidatePair()
      return !!pair && sameNetwork(pair.local, pair.remote)
    } catch {
      return false
    }
  }

  private sampleTurn(s: Session): void {
    let sample: TurnSample
    try {
      sample = { pair: s.pc.getSelectedCandidatePair(), sent: s.pc.bytesSent(), received: s.pc.bytesReceived() }
    } catch {
      return
    }
    const d = s.turn.sample(sample)
    const pair = sample.pair ? `${sample.pair.local.type}/${sample.pair.remote.type}` : ''
    if (pair && pair !== s.turnPair) {
      s.turnPair = pair
      console.log(`[remote-video] ${s.id} pair ${pair}${this.onLan(s) ? ' on the same network' : ''}: ${s.turn.path ? `through TURN (${s.turn.path === 'both' ? 'both ends' : `${s.turn.path} end`} relayed), counting its bytes for the account` : 'direct, no TURN bytes'}`)
    }
    if (d && s.owner) this.turnSink?.(s.owner, d)
  }

  private sampleVideoTurn(s: Session, v: RvSenderStats): void {
    const d = s.vturn.sample({ pair: v.pair ? { local: { type: v.pair.local }, remote: { type: v.pair.remote } } : null, sent: v.sent, received: v.received })
    const pair = v.pair ? `${v.pair.local}/${v.pair.remote}${v.pair.lan ? ' on the same network' : ''}` : ''
    if (pair && pair !== s.vpair) {
      s.vpair = pair
      console.log(`[remote-video] ${v.id} video pair ${pair} ${v.pair?.protocol ?? ''}: ${s.vturn.path ? 'through TURN, counting its bytes for the account' : 'direct, no TURN bytes'}`)
    }
    if (d && s.owner) this.turnSink?.(s.owner, d)
  }

  private tickStats(s: Session): void {
    if (s.peer.isDestroyed() && !s.control?.isOpen()) {
      this.endSession()
      return
    }
    this.sampleTurn(s)
    const t = performance.now()
    s.src.fps = Math.round((s.src.frames / Math.max(0.001, (t - s.src.at) / 1000)) * 10) / 10
    s.src = { frames: 0, at: t, fps: s.src.fps }
    try {
      const r = s.pc.rtt()
      s.rtt = r >= 0 ? r : null
    } catch {
    }
    this.sendControl({ t: 'stats', stats: { link: this.macDiag(s) } })
  }

  private encoderState(s: Session): string {
    if (!s.source) return 'idle, no stream picked'
    if (!this.view || this.view.webContents.isDestroyed()) return 'not started'
    if (!this.viewReady) return 'starting'
    if (!s.vid) return 'waiting for the phone to ask for video'
    if (s.vstate !== 'connected') return `video track ${s.vstate}`
    if (!s.src.fps) return 'waiting for Unity frames'
    if (!s.vstats?.encodedFps) return 'not encoding'
    return 'running'
  }

  private videoDiag(s: Session): MacVideoDiag {
    const v = s.vstats
    const c = this.encoderConfig(s)
    return {
      source: s.source,
      encoder: this.encoderState(s),
      state: s.vid ? s.vstate : 'none',
      pair: v?.pair ? `${v.pair.local}/${v.pair.remote} ${v.pair.protocol}${v.pair.lan ? ' same network' : ''}` : 'connecting',
      rttMs: v?.rttMs ?? null,
      lossPct: v?.lossPct ?? null,
      sourceFps: s.src.fps,
      fedFps: v?.fedFps ?? 0,
      encodedFps: v?.encodedFps ?? 0,
      fps: v?.fps ?? 0,
      kbps: v?.kbps ?? 0,
      targetKbps: v?.targetKbps ?? null,
      availableKbps: v?.availableKbps ?? null,
      maxKbps: c.kbps,
      maxSide: c.maxSide,
      fpsCap: c.fps,
      preset: s.settings.preset,
      filter: s.settings.filter,
      codec: v?.codec ?? null,
      hardware: v?.hardware ?? null,
      width: v?.width ?? 0,
      height: v?.height ?? 0,
      limit: v?.limit ?? null,
      keys: v?.keys ?? 0,
      nack: v?.nack ?? 0,
      pli: v?.pli ?? 0,
      resentKbps: v?.resentKbps ?? 0,
      unsealed: v?.unsealed ?? 0
    }
  }

  private macDiag(s: Session): MacLinkDiag {
    const channels = s.channels
      .filter((ch) => {
        try {
          return ch.isOpen()
        } catch {
          return false
        }
      })
      .map((ch) => {
        const label = ch.getLabel()
        return { ch: label, outKbps: recentKbps('dc', 'out', label), inKbps: recentKbps('dc', 'in', label), bufferedKb: Math.round(ch.bufferedAmount() / 102.4) / 10 }
      })
    channels.push({ ch: 'video (RTP)', outKbps: s.vstats?.kbps ?? 0, inKbps: 0, bufferedKb: 0 })
    channels.push({ ch: 'relay', outKbps: recentTotalKbps('relay', 'out'), inKbps: recentTotalKbps('relay', 'in'), bufferedKb: 0 })
    return {
      at: Date.now(),
      calls: this.linkInfo?.calls(s.owner) ?? null,
      relay: this.linkInfo?.relay() ?? { open: false, rttMs: null },
      rtc: { state: s.pcState, pair: this.path(s), rttMs: s.rtt },
      video: this.videoDiag(s),
      channels
    }
  }

  linkReport(): { verdict: LinkVerdict; session: string | null; mac: MacLinkDiag | null; phone: (PhoneLinkDiag & { ageMs: number }) | null } {
    const s = this.session
    if (!s) return { verdict: { kind: 'waiting', text: 'No video link to a phone' }, session: null, mac: null, phone: null }
    const mac = this.macDiag(s)
    const phone = s.phoneDiag ? { ...s.phoneDiag, ageMs: Date.now() - s.phoneDiagAt } : null
    return { verdict: linkVerdict(s.phoneDiag, mac), session: s.id, mac, phone }
  }

  private logStats(s: Session): void {
    const v = this.videoDiag(s)
    debugLog(
      `[remote-video] ${v.source ?? '-'} ${v.width}x${v.height} ${v.codec ?? '-'}${v.hardware === null ? '' : v.hardware ? ' hw' : ' sw'} src=${v.sourceFps}fps fed=${v.fedFps} enc=${v.encodedFps} sent=${v.fps}fps ${v.kbps}kbps target=${v.targetKbps ?? '-'} avail=${v.availableKbps ?? '-'} max=${v.maxKbps} limit=${v.limit ?? '-'} rtt=${v.rttMs ?? '-'} loss=${v.lossPct ?? '-'}% nack=${v.nack} pli=${v.pli} keys=${v.keys} resent=${v.resentKbps}kbps video=${v.state} ${v.pair} data=${this.path(s)} sctp=${s.rtt ?? '-'}`
    )
  }
}

export const remoteVideo = new RemoteVideo()
censusGauge('remote-video.session', () => remoteVideo.censusSession())
censusGauge('remote-video.encoderView', () => remoteVideo.censusView())
censusGauge('remote-video.sources', () => remoteVideo.censusSources())

export function startRemoteVideo(): void {
  remoteVideo.start()
  app.on('before-quit', () => remoteVideo.stop())
  app.on('will-quit', releaseRemoteVideo)
}

let released = false
export function releaseRemoteVideo(): void {
  if (released) return
  released = true
  remoteVideo.stop()
  const closing = `${closingChannels.size} channel(s) and ${closingPeers.size} peer connection(s) still closing`
  const t0 = performance.now()
  try {
    releaseDataChannels()
    console.log(`[remote-video] WebRTC released in ${Math.round(performance.now() - t0)} ms, ${closing}`)
  } catch (e) {
    console.log(`[remote-video] WebRTC cleanup failed: ${(e as Error).message}, ${closing}`)
  }
  closingChannels.clear()
  closingPeers.clear()
}
