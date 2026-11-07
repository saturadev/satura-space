const proto = HTMLMediaElement.prototype
const TIME = Object.getOwnPropertyDescriptor(proto, 'currentTime') as PropertyDescriptor
const READY = Object.getOwnPropertyDescriptor(proto, 'readyState') as PropertyDescriptor
const PAUSED = Object.getOwnPropertyDescriptor(proto, 'paused') as PropertyDescriptor
const TICK_MS = 250
const AHEAD_S = 0.5
const STILL_MS = 300
const STUCK_MS = 600
const QUIET_MS = 800
const LOW_S = 2
const RESUME_S = 3
const TRUST_S = 3
const HOLD_MAX_MS = 15_000
const STALE_S = 1

export type StallReason = 'clock' | 'picture' | 'hold' | ''

export interface FrameClock {
  waiting: () => boolean
  dispose: () => void
}

export function attachFrameClock(
  video: HTMLVideoElement,
  opts: { scrubbing: () => boolean; onStall: (on: boolean, why: StallReason, at: number) => void; onNote?: (msg: string) => void }
): FrameClock {
  const time = (): number => TIME.get!.call(video) as number
  const ready = (): number => READY.get!.call(video) as number
  const paused = (): boolean => PAUSED.get!.call(video) as boolean
  const frames = typeof video.requestVideoFrameCallback === 'function'
  let shown: number | null = null
  let shownAt = 0
  let distrust = false
  let anchor = 0
  let since = performance.now()
  let lastT = -1
  let moved = false
  let movedAt = since
  let waiting = false
  let stalled = false
  let hold: number | null = null
  let heldAt = 0
  let lastHold = -1
  let inView = true
  let frame = 0
  let fresh: number | null = null

  const visible = (): boolean =>
    inView && document.visibilityState === 'visible' && !(video as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }).webkitDisplayingFullscreen
  const checking = (): boolean => frames && !distrust && visible()
  const onScreen = (): number => shown ?? anchor
  const restart = (t: number): void => {
    shown = null
    fresh = t
    anchor = t
    since = performance.now()
    movedAt = since
    moved = false
    lastT = t
  }
  const onFrame = (_now: number, meta: VideoFrameCallbackMetadata): void => {
    if (fresh == null || Math.abs(meta.mediaTime - fresh) < STALE_S) {
      fresh = null
      shown = meta.mediaTime
      shownAt = performance.now()
    }
    frame = video.requestVideoFrameCallback(onFrame)
  }
  if (frames) frame = video.requestVideoFrameCallback(onFrame)

  const setWaiting = (on: boolean): void => {
    if (on === waiting) return
    waiting = on
    if (on) video.dispatchEvent(new Event('waiting'))
    else if (!paused()) video.dispatchEvent(new Event('playing'))
  }
  const setStalled = (on: boolean, why: StallReason): void => {
    if (on === stalled) return
    stalled = on
    opts.onStall(on, why, onScreen())
  }
  const ahead = (t: number): number => {
    const b = video.buffered
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.05 && b.end(i) > t) return b.end(i) - t
    return 0
  }
  const toEnd = (t: number): boolean => Number.isFinite(video.duration) && ahead(t) >= video.duration - t - 0.1
  const resume = (): void => {
    hold = null
    void proto.play.call(video).catch(() => {})
  }

  Object.defineProperties(video, {
    currentTime: {
      configurable: true,
      get: (): number => {
        if (hold != null) return hold
        const t = time()
        if (!checking() || paused() || video.seeking) return t
        return waiting || t - onScreen() > AHEAD_S ? Math.min(t, onScreen() + AHEAD_S) : t
      },
      set: (t: number): void => {
        const held = hold != null
        TIME.set!.call(video, t)
        if (held) resume()
      }
    },
    readyState: { configurable: true, get: (): number => (waiting ? Math.min(2, ready()) : ready()) },
    paused: { configurable: true, get: (): boolean => hold == null && paused() }
  })
  video.pause = (): void => {
    const held = hold != null
    hold = null
    proto.pause.call(video)
    if (held) video.dispatchEvent(new Event('pause'))
  }
  video.play = (): Promise<void> => {
    hold = null
    return proto.play.call(video)
  }

  const onSeeking = (): void => {
    restart(time())
    setWaiting(true)
  }
  const onStart = (): void => {
    restart(time())
    setWaiting(true)
  }
  const onLoad = (): void => {
    hold = null
    lastHold = -1
    distrust = false
    restart(0)
    setStalled(false, '')
  }
  const onVisibility = (): void => {
    since = performance.now()
  }
  video.addEventListener('seeking', onSeeking)
  video.addEventListener('play', onStart)
  video.addEventListener('loadstart', onLoad)
  document.addEventListener('visibilitychange', onVisibility)
  const io = new IntersectionObserver((list) => {
    inView = list[list.length - 1].isIntersecting
    since = performance.now()
  })
  io.observe(video)

  const tick = (): void => {
    const now = performance.now()
    const t = time()
    if (t !== lastT) {
      lastT = t
      moved = true
      movedAt = now
    }
    if (hold != null) {
      if (ahead(hold) >= RESUME_S || toEnd(hold) || now - heldAt > HOLD_MAX_MS) {
        const at = hold
        opts.onNote?.(`plays on from ${at.toFixed(2)} s with ${ahead(at).toFixed(1)} s loaded ahead`)
        restart(at)
        TIME.set!.call(video, at)
        resume()
      }
      setWaiting(true)
      setStalled(true, 'hold')
      return
    }
    if (paused() || video.ended || video.error || opts.scrubbing()) {
      movedAt = now
      setWaiting(false)
      setStalled(false, '')
      return
    }
    const short = ahead(t) < LOW_S && !toEnd(t)
    if (checking() && !short && t - onScreen() > TRUST_S) {
      distrust = true
      opts.onNote?.(`shows no frames at ${t.toFixed(2)} s with ${ahead(t).toFixed(1)} s loaded, following the clock`)
    }
    const quiet = now - Math.max(shownAt, since)
    const frozen = checking() && quiet >= QUIET_MS && t - onScreen() >= QUIET_MS / 1000
    if (frozen && short && t - onScreen() >= 1 && onScreen() !== lastHold) {
      hold = onScreen()
      lastHold = hold
      heldAt = now
      opts.onNote?.(`picture stopped at ${hold.toFixed(2)} s while the clock ran to ${t.toFixed(2)} s, holding until more loads`)
      proto.pause.call(video)
      setWaiting(true)
      setStalled(true, 'hold')
      return
    }
    const still = now - movedAt
    const flowing = moved && still < STILL_MS && (!checking() || (shown != null && now - shownAt < QUIET_MS))
    setWaiting(!flowing)
    if (still >= STUCK_MS) setStalled(true, 'clock')
    else if (frozen && short) setStalled(true, 'picture')
    else if (flowing) setStalled(false, '')
  }
  const timer = window.setInterval(tick, TICK_MS)

  return {
    waiting: () => waiting,
    dispose: () => {
      window.clearInterval(timer)
      if (frames && frame) video.cancelVideoFrameCallback(frame)
      io.disconnect()
      video.removeEventListener('seeking', onSeeking)
      video.removeEventListener('play', onStart)
      video.removeEventListener('loadstart', onLoad)
      document.removeEventListener('visibilitychange', onVisibility)
      for (const k of ['currentTime', 'readyState', 'paused', 'pause', 'play']) delete (video as unknown as Record<string, unknown>)[k]
    }
  }
}
