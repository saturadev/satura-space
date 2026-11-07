import { WebContentsView, app, ipcMain, type IpcMainEvent } from 'electron'
import { join, isAbsolute, resolve, dirname, extname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { censusTrack } from '@shared/census'
import { clearSentTo, resendSurface } from './shared-surface'
import { guardSspace } from './sspace-state'
import type { PixelSize } from '@shared/unity/stream-size'

export interface VideoArgs {
  op?: string
  audio?: boolean
  size?: string | number
  path?: string
}

export interface VideoState {
  active: boolean
  recording: boolean
  width: number
  height: number
  seconds: number
  audio: boolean
}

export interface VideoResult {
  ok: boolean
  error?: string
  note?: string
  video?: Record<string, unknown>
}

export interface VideoHooks {
  setOverride(worldId: string, res: string | null): void
  audioTap(worldId: string, on: boolean): void
  clockLock(worldId: string, fps: number): void
  consumers(worldId: string): void
  emitState(worldId: string, state: VideoState): void
}

interface Session {
  worldId: string
  projectPath: string
  width: number
  height: number
  audio: boolean
  recording: boolean
  draining: boolean
  doneMs: number
  segFrameAt: number
  frames: number
  segments: number
  limitHit: boolean
  ticker: NodeJS.Timeout | null
  touched: number
}

interface Reply {
  ok: boolean
  error?: string
  [k: string]: unknown
}

const DEFAULT_WIDTH = 1920
const DEFAULT_HEIGHT = 1080
const MIN_SIDE = 64
const MAX_SIDE = 3840
const MAX_SECONDS = 15 * 60
const START_TIMEOUT_MS = 8000
const FINISH_TIMEOUT_MS = 120000
const IDLE_CLOSE_MS = 30000
const PAUSED_KEEP_MS = 15 * 60 * 1000
const SUB_PREFIX = 'video:'
const VIDEO_FPS = 60

function even(n: number): number {
  return Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(n / 2) * 2))
}

export function videoSize(size: unknown, pane: PixelSize): PixelSize | string {
  const aspect = pane.width > 0 && pane.height > 0 ? pane.width / pane.height : 16 / 9
  const raw = typeof size === 'number' ? String(size) : typeof size === 'string' ? size.trim().toLowerCase() : ''
  if (!raw) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  const pair = /^(\d+)\s*x\s*(\d+)$/.exec(raw)
  if (pair) return { width: even(Number(pair[1])), height: even(Number(pair[2])) }
  if (/^\d+$/.test(raw)) {
    const long = Number(raw)
    return aspect >= 1
      ? { width: even(long), height: even(long / aspect) }
      : { width: even(long * aspect), height: even(long) }
  }
  return `size must be "WIDTHxHEIGHT" like "1920x1080", or one number for the long side; got "${String(size)}"`
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

class VideoRecorder {
  private hooks: VideoHooks | null = null
  private sessions = censusTrack('video-recorder.sessions', new Map<string, Session>())
  private pending = censusTrack('video-recorder.pending', new Map<number, (r: Reply) => void>())
  private view: WebContentsView | null = null
  private ready: Promise<void> | null = null
  private nextReq = 1
  private idleTimer: NodeJS.Timeout | null = null
  private listening = false

  setHooks(hooks: VideoHooks): void {
    this.hooks = hooks
  }

  subscribersFor(worldId: string, base: Map<string, number>): Iterable<[string, number]> {
    const s = this.sessions.get(worldId)
    const wc = this.view?.webContents
    if (!s || !(s.recording || s.draining) || !wc || wc.isDestroyed()) return base
    return [...base, [SUB_PREFIX + worldId, wc.id]]
  }

  onFrame(worldId: string, surfaceId: number, generation: number, width: number, height: number, stamp: number | null, useq: number | null = null): void {
    const s = this.sessions.get(worldId)
    if (!s || !(s.recording || s.draining)) return
    const t = performance.now()
    if (s.recording) {
      s.frames += 1
      if (!s.segFrameAt) s.segFrameAt = t
    }
    this.post('video:frame', { id: SUB_PREFIX + worldId, surfaceId, generation, width, height, t, u: stamp, q: useq })
  }

  onAudio(worldId: string, msg: Buffer): void {
    const s = this.sessions.get(worldId)
    if (!s || !s.recording || !s.audio || msg.length < 10) return
    const channels = msg[1]
    const rate = msg.readUInt32LE(2)
    if (!channels || !rate) return
    const data = new Uint8Array(msg.buffer.slice(msg.byteOffset + 6, msg.byteOffset + msg.length))
    this.post('video:audio', { id: SUB_PREFIX + worldId, channels, rate, data, t: performance.now() })
  }

  drop(worldId: string): void {
    const s = this.sessions.get(worldId)
    if (!s) return
    this.endSession(s)
    void this.call('video:clear', { id: SUB_PREFIX + worldId }, 5000).catch(() => undefined)
  }

  async command(worldId: string, projectPath: string, pane: PixelSize, args: VideoArgs): Promise<VideoResult> {
    const op = String(args.op ?? '')
    const touched = this.sessions.get(worldId)
    if (touched) touched.touched = performance.now()
    if (op === 'start') return this.start(worldId, projectPath, pane, args)
    if (op === 'stop') return this.stop(worldId)
    if (op === 'finish') return this.finish(worldId, projectPath, args)
    if (op === 'clear_buffer') return this.clear(worldId)
    if (op === 'status') return { ok: true, video: this.describe(this.sessions.get(worldId)) }
    return { ok: false, error: `Unknown op "${op}". Use start, stop, finish, clear_buffer or status.` }
  }

  private describe(s: Session | undefined): Record<string, unknown> {
    if (!s) return { state: 'empty', seconds: 0 }
    return {
      state: s.recording ? 'recording' : 'paused',
      seconds: round1(this.seconds(s)),
      frames: s.frames,
      ...(s.recording && !s.segFrameAt ? { waiting: true } : {}),
      segments: s.segments,
      width: s.width,
      height: s.height,
      audio: s.audio,
      ...(s.limitHit ? { limit: `stopped at the ${MAX_SECONDS / 60} min limit` } : {})
    }
  }

  private seconds(s: Session): number {
    return (s.doneMs + (s.recording && s.segFrameAt ? performance.now() - s.segFrameAt : 0)) / 1000
  }

  private async start(worldId: string, projectPath: string, pane: PixelSize, args: VideoArgs): Promise<VideoResult> {
    let s = this.sessions.get(worldId)
    const notes: string[] = []
    if (s?.recording) return { ok: true, note: 'Already recording.', video: this.describe(s) }
    if (s?.limitHit) return { ok: false, error: `The buffer is full (${MAX_SECONDS / 60} min). finish or clear_buffer first.` }
    if (!s) {
      const size = videoSize(args.size, pane)
      if (typeof size === 'string') return { ok: false, error: size }
      s = {
        worldId,
        projectPath,
        width: size.width,
        height: size.height,
        audio: args.audio === true,
        recording: false,
        draining: false,
        doneMs: 0,
        segFrameAt: 0,
        frames: 0,
        segments: 0,
        limitHit: false,
        ticker: null,
        touched: performance.now()
      }
      this.sessions.set(worldId, s)
    } else {
      if (args.audio !== undefined && (args.audio === true) !== s.audio)
        notes.push(`audio stays ${s.audio ? 'on' : 'off'} for this buffer; clear_buffer to change it`)
      if (args.size !== undefined && args.size !== '') {
        const want = videoSize(args.size, pane)
        if (typeof want !== 'string' && (want.width !== s.width || want.height !== s.height))
          notes.push(`size stays ${s.width}x${s.height} for this buffer; clear_buffer to change it`)
      }
    }
    try {
      await this.ensureView()
    } catch (e) {
      this.endSession(s)
      return { ok: false, error: `The video recorder didn't start: ${(e as Error).message}` }
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    s.recording = true
    s.segFrameAt = 0
    s.segments += 1
    this.hooks?.setOverride(worldId, `${s.width}x${s.height}`)
    this.hold(s, true)
    this.hooks?.consumers(worldId)
    this.startTicker(s)
    let r: Reply
    try {
      r = await this.call(
        'video:begin',
        { id: SUB_PREFIX + worldId, width: s.width, height: s.height, audio: s.audio, fps: VIDEO_FPS, t: performance.now() },
        START_TIMEOUT_MS
      )
    } catch (e) {
      s.recording = false
      this.hold(s, false)
      this.hooks?.consumers(worldId)
      this.hooks?.setOverride(worldId, null)
      if (s.segments === 1) this.endSession(s)
      else s.segments -= 1
      return { ok: false, error: `Recording didn't start: ${(e as Error).message}` }
    }
    if (!r.ok) {
      s.recording = false
      this.hold(s, false)
      this.hooks?.consumers(worldId)
      this.hooks?.setOverride(worldId, null)
      if (s.segments === 1) this.endSession(s)
      return { ok: false, error: r.error ?? 'Recording did not start' }
    }
    if (r.scaled && !r.waiting) notes.push(`Unity did not switch the stream to ${s.width}x${s.height}; frames are scaled to fit`)
    this.emit(s)
    return { ok: true, note: notes.length ? notes.join('; ') : undefined, video: this.describe(s) }
  }

  private async stop(worldId: string): Promise<VideoResult> {
    const s = this.sessions.get(worldId)
    if (!s) return { ok: false, error: 'Nothing is recording. Call start first.' }
    if (!s.recording) return { ok: true, note: 'Already stopped.', video: this.describe(s) }
    await this.pause(s)
    return { ok: true, video: this.describe(s) }
  }

  private async pause(s: Session): Promise<void> {
    if (!s.recording) return
    if (s.segFrameAt) s.doneMs += performance.now() - s.segFrameAt
    s.segFrameAt = 0
    s.recording = false
    s.draining = true
    s.touched = performance.now()
    this.hold(s, false)
    this.emit(s)
    await this.call('video:pause', { id: SUB_PREFIX + s.worldId, t: performance.now() }, 5000).catch(() => undefined)
    s.draining = false
    if (this.sessions.get(s.worldId) === s && !s.recording) {
      this.hooks?.consumers(s.worldId)
      this.hooks?.setOverride(s.worldId, null)
    }
  }

  private async finish(worldId: string, projectPath: string, args: VideoArgs): Promise<VideoResult> {
    const s = this.sessions.get(worldId)
    if (!s) return { ok: false, error: 'The buffer is empty. Record something with start and stop first.' }
    await this.pause(s)
    const now = new Date()
    const two = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
    let out = args.path ? String(args.path) : join(projectPath, '.sspace', 'videos', `video-${stamp}.mp4`)
    if (!isAbsolute(out)) out = resolve(projectPath, out)
    try {
      if (out.startsWith(join(projectPath, '.sspace'))) guardSspace(projectPath)
      mkdirSync(dirname(out), { recursive: true })
    } catch (e) {
      return { ok: false, error: `Cannot create ${dirname(out)}: ${(e as Error).message}` }
    }
    let r: Reply
    try {
      r = await this.call('video:finish', { id: SUB_PREFIX + worldId, path: out }, FINISH_TIMEOUT_MS)
    } catch (e) {
      return { ok: false, error: `Writing the video failed: ${(e as Error).message}. The buffer is kept; retry finish.` }
    }
    if (!r.ok) return { ok: false, error: r.error ?? 'Writing the video failed. The buffer is kept; retry finish.' }
    this.endSession(s)
    const notes: string[] = []
    if (typeof r.path === 'string' && extname(r.path) !== extname(out)) notes.push(`saved as ${extname(r.path)}: this machine has no H.264 encoder`)
    if (s.audio && r.audioPeak === 0) notes.push('the audio track is silent: nothing played, or the scene has no active AudioListener (audio is captured in Play Mode only)')
    if (s.audio && r.audioPeak == null) notes.push('no audio reached the recorder: audio is captured in Play Mode only')
    return {
      ok: true,
      note: notes.length ? notes.join('; ') : undefined,
      video: {
        path: r.path,
        seconds: r.seconds,
        frames: r.frames,
        dropped: r.dropped,
        width: s.width,
        height: s.height,
        audio: s.audio && r.audioPeak != null,
        bytes: r.bytes,
        codec: r.codec,
        segments: s.segments
      }
    }
  }

  private async clear(worldId: string): Promise<VideoResult> {
    const s = this.sessions.get(worldId)
    if (!s) return { ok: true, note: 'The buffer was already empty.', video: { state: 'empty', seconds: 0 } }
    const seconds = round1(this.seconds(s))
    this.endSession(s)
    await this.call('video:clear', { id: SUB_PREFIX + worldId }, 5000).catch(() => undefined)
    return { ok: true, note: `Discarded ${seconds}s.`, video: { state: 'empty', seconds: 0 } }
  }

  private endSession(s: Session): void {
    if (s.ticker) clearInterval(s.ticker)
    s.ticker = null
    if (s.recording) this.hold(s, false)
    s.recording = false
    s.draining = false
    this.sessions.delete(s.worldId)
    this.hooks?.consumers(s.worldId)
    const wc = this.view?.webContents
    if (wc && !wc.isDestroyed()) resendSurface(s.worldId, wc.id, SUB_PREFIX + s.worldId)
    this.hooks?.setOverride(s.worldId, null)
    this.hooks?.emitState(s.worldId, { active: false, recording: false, width: 0, height: 0, seconds: 0, audio: false })
    if (this.sessions.size === 0) this.scheduleIdleClose()
  }

  private hold(s: Session, on: boolean): void {
    if (s.audio) this.hooks?.audioTap(s.worldId, on)
    else this.hooks?.clockLock(s.worldId, on ? VIDEO_FPS : 0)
  }

  private startTicker(s: Session): void {
    if (s.ticker) return
    s.ticker = setInterval(() => {
      if (this.sessions.get(s.worldId) !== s) return
      if (s.recording) this.hold(s, true)
      if (s.recording && this.seconds(s) >= MAX_SECONDS) {
        s.limitHit = true
        void this.pause(s)
      }
      if (!s.recording && performance.now() - s.touched >= PAUSED_KEEP_MS) {
        console.log(`[video] discarded ${round1(this.seconds(s))}s of video for ${s.worldId}: nobody saved or cleared it for ${PAUSED_KEEP_MS / 60000} min`)
        this.drop(s.worldId)
        return
      }
      this.emit(s)
    }, 1000)
  }

  private emit(s: Session): void {
    this.hooks?.emitState(s.worldId, {
      active: true,
      recording: s.recording,
      width: s.width,
      height: s.height,
      seconds: round1(this.seconds(s)),
      audio: s.audio
    })
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.sessions.size === 0) this.closeView()
    }, IDLE_CLOSE_MS)
  }

  private closeView(): void {
    const view = this.view
    this.view = null
    this.ready = null
    if (!view) return
    const wc = view.webContents
    if (wc.isDestroyed()) return
    clearSentTo(wc.id)
    wc.close()
  }

  private listen(): void {
    if (this.listening) return
    this.listening = true
    ipcMain.on('video:reply', (e: IpcMainEvent, r: Reply & { req: number }) => {
      if (!this.view || e.sender !== this.view.webContents) return
      const done = this.pending.get(r.req)
      if (!done) return
      this.pending.delete(r.req)
      done(r)
    })
  }

  private ensureView(): Promise<void> {
    if (this.ready && this.view && !this.view.webContents.isDestroyed()) return this.ready
    this.listen()
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/video-recorder.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    this.view = view
    const wc = view.webContents
    wc.on('console-message', (details) => console.log(`[video-rec] ${details.message}`))
    wc.on('render-process-gone', (_e, d) => {
      console.log(`[video-rec] recorder process gone: ${d.reason}`)
      if (this.view === view) {
        this.view = null
        this.ready = null
      }
      for (const done of this.pending.values()) done({ ok: false, error: 'the recorder process crashed' })
      this.pending.clear()
      for (const s of [...this.sessions.values()]) this.endSession(s)
    })
    wc.on('destroyed', () => clearSentTo(wc.id))
    const page = join(app.getPath('userData'), 'video-recorder.html')
    writeFileSync(page, '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>video-recorder</title>')
    this.ready = wc.loadFile(page).then(() => undefined)
    return this.ready
  }

  private post(channel: string, payload: Record<string, unknown>): void {
    const wc = this.view?.webContents
    if (!wc || wc.isDestroyed()) return
    wc.send(channel, payload)
  }

  private call(channel: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    const wc = this.view?.webContents
    if (!wc || wc.isDestroyed()) return Promise.reject(new Error('the recorder is not running'))
    const req = this.nextReq++
    return new Promise<Reply>((resolveReply, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req)
        reject(new Error(`no answer from the recorder in ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(req, (r) => {
        clearTimeout(timer)
        resolveReply(r)
      })
      wc.send(channel, { ...payload, req })
    })
  }
}

export const videoRecorder = new VideoRecorder()
