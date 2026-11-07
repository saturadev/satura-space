import 'media-chrome/dist/media-controller.js'
import 'media-chrome/dist/media-control-bar.js'
import 'media-chrome/dist/media-play-button.js'
import 'media-chrome/dist/media-time-range.js'
import 'media-chrome/dist/media-time-display.js'
import 'media-chrome/dist/media-preview-time-display.js'
import 'media-chrome/dist/media-fullscreen-button.js'
import 'media-chrome/dist/media-mute-button.js'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { RemoteRenditionId, RemoteVideoPlan } from '@shared/remote-protocol'
import { mediaLoader, onHeldChange, type MediaHeld, type MediaSaveAsk, type MediaTag } from '../../lib/media-loader'
import { qualityName, type VideoQuality } from '../../lib/mobile/phone-quality'
import { useRemoteLink } from '../../lib/remote-link'
import { FramePlayer, type FramePlayerHandle } from './FramePlayer'
import { Fullscreen } from './Fullscreen'
import { loaderSource } from './frame-sources'
import type { PlayerEvent, PlayerLogLine } from './frame-player-core'
import { plainError } from './media-gate'
import { canStream, playMp4, type Pipe } from './mse-stream'
import { ProgressBar } from '../../remote/motion'
import { attachMediaZoom } from './media-zoom'
import { attachFrameClock } from './phone-video-clock'
import { bestOf, bestPath, chosenRendition, effectiveQuality, heldQuality, heldState, makingRendition, qualityLabel, qualityOptions, readyRendition, sizeText, tierOf } from './phone-video-quality'
import { SaveMedia } from './save-media'
import { useVideoStill } from './phone-video-still'
import { useDropWhenAway } from './phone-video-away'
import { lockSeekSwipes } from './seek-swipe'
import { fmtTime } from './zoom-pan'
import './phone-video.css'

const POLL_MS = 1000
const PLANS_KEPT = 100
const NEAR_MARGIN = '800px 0px'
const SAVE_EVERY_MS = 1000
const plans = new Map<string, RemoteVideoPlan>()
const originals = new Set<string>()
const choices = new Map<string, VideoQuality>()
const logged = new Set<string>()

const nameOf = (path: string): string => path.split('/').pop() || 'the video'

function note(line: string): void {
  console.info(line)
  mediaLoader()?.note?.(line)
}
const clockOf = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

function keepPlan(path: string, plan: RemoteVideoPlan): void {
  plans.delete(path)
  plans.set(path, plan)
  if (plans.size > PLANS_KEPT) plans.delete(plans.keys().next().value as string)
  const state = plan.version?.state ?? 'direct'
  const key = `${path}\n${state}`
  if (logged.has(key) || state === 'queued') return
  logged.add(key)
  if (!plan.reason) console.info(`[media] ${nameOf(path)} plays as it is (${plan.label})`)
  else if (state === 'ready') console.info(`[media] ${nameOf(path)} plays the phone version (${plan.version?.label}) instead of the original (${plan.label}: ${plan.reason})`)
  else if (state === 'preparing') console.info(`[media] ${nameOf(path)} waits for a phone version (${plan.label}: ${plan.reason})`)
  else console.info(`[media] ${nameOf(path)} has no phone version (${plan.reason}): ${plan.version?.note ?? state}`)
}

function useNear(el: HTMLElement | null): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    if (!el) return
    const root = el.closest('.rk-host')
    let recheck = 0
    let seen = false
    const hidden = (): boolean => !!el.closest('[data-phone-expanding]') && !el.closest('[data-phone-expanded]')
    const consider = (): void => {
      window.clearTimeout(recheck)
      if (!seen) return
      if (hidden()) recheck = window.setTimeout(consider, 800)
      else setNear(true)
    }
    const io = new IntersectionObserver(
      (list) => {
        seen = list[list.length - 1].isIntersecting
        consider()
      },
      { root: root instanceof HTMLElement ? root : null, rootMargin: NEAR_MARGIN }
    )
    io.observe(el)
    return () => {
      window.clearTimeout(recheck)
      io.disconnect()
    }
  }, [el])
  return near
}

function usePlan(path: string, near: boolean, online: boolean, rendition: RemoteRenditionId | undefined, urgent: boolean, prepare: boolean): { plan: RemoteVideoPlan | null; error: string; retry: () => void } {
  const [state, setState] = useState<{ plan: RemoteVideoPlan | null; error: string }>(() => ({ plan: plans.get(path) ?? null, error: '' }))
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const loader = mediaLoader()
    if (!near || !online || !loader?.plan) return
    let alive = true
    let timer = 0
    const ask = (): void => {
      loader.plan!(path, prepare, { rendition, urgent }).then(
        (plan) => {
          if (!alive) return
          keepPlan(path, plan)
          setState({ plan, error: '' })
          const s = plan.version?.state
          const r = rendition ? plan.renditions?.find((x) => x.id === rendition)?.state : undefined
          if (s === 'queued' || s === 'preparing' || r === 'queued' || r === 'preparing') timer = window.setTimeout(ask, POLL_MS)
        },
        (e: unknown) => {
          if (alive) setState((st) => ({ plan: st.plan, error: plainError(e) }))
        }
      )
    }
    ask()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [path, near, online, attempt, rendition, urgent, prepare])
  return { ...state, retry: () => setAttempt((n) => n + 1) }
}

function useHeld(path: string, on: boolean): MediaHeld[] | null {
  const [held, setHeld] = useState<MediaHeld[] | null>(null)
  useEffect(() => {
    const loader = mediaLoader()
    if (!on) return
    if (!loader?.held) {
      setHeld([])
      return
    }
    let alive = true
    const read = (): void => {
      loader.held!(path).then(
        (h) => alive && setHeld(h),
        () => alive && setHeld((cur) => cur ?? [])
      )
    }
    read()
    const off = onHeldChange(read)
    return () => {
      alive = false
      off()
    }
  }, [path, on])
  return held
}

interface PlayerProps {
  path: string
  tag: MediaTag
  save: MediaSaveAsk | null
  name: string
  label: string
  bytes?: number
  audio: boolean
  fps: number
  initialFrame?: number
  onFrame?: (frame: number) => void
  onHandle?: (h: FramePlayerHandle | null) => void
  resume: { t: number; play: boolean } | null
  onFailed: () => void
  poster: string | null
  duration?: number
  quality: ReactElement | null
  armed: boolean
  onArm: (want: { t: number; play: boolean }) => void
  onCancel: () => void
  statusEl: HTMLElement | null
}

interface Got {
  have: number
  size: number
  done: boolean
}

const got = new Map<string, Got>()
const STUCK_MS = 5000
const mb = (n: number): string => (n / 1e6).toFixed(1)
const isAbort = (e: unknown): boolean => /AbortError|cancelled/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e))
const phoneName = (): string => navigator.userAgent.match(/(iPhone|iPad|Android|Mac OS X|Windows)[^;)]*/)?.[0] ?? 'this phone'

function errorText(v: HTMLVideoElement, everLoaded: boolean): string {
  const code = v.error?.code
  if (code === 4 && !everLoaded) return "This video can't play on the phone."
  if (code === 3) return "The phone couldn't decode this video."
  return `The phone's player stopped (error ${code ?? '?'}${v.error?.message ? `: ${v.error.message}` : ''}).`
}

function Player({ path, tag, save, name, label, bytes, audio, fps, initialFrame, onFrame, onHandle, resume, onFailed, poster, duration, quality, armed, onArm, onCancel, statusEl }: PlayerProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const link = useRemoteLink()
  const offline = link?.online === false
  const [failure, setFailure] = useState('')
  const [attempt, setAttempt] = useState(0)
  const calls = useRef({ onFrame, onHandle, onFailed, onArm })
  calls.current = { onFrame, onHandle, onFailed, onArm }
  const posterRef = useRef(poster)
  posterRef.current = poster
  const refs = useRef<{ mc: HTMLElement; video: HTMLVideoElement; host: HTMLElement; range: HTMLElement | null } | null>(null)
  const pending = useRef<{ t: number; play: boolean } | null>(resume ?? (initialFrame ? { t: initialFrame / fps, play: false } : null))
  const armedRef = useRef(armed)
  armedRef.current = armed
  const pathRef = useRef(path)
  pathRef.current = path
  const tagRef = useRef(tag)
  tagRef.current = tag
  const nameRef = useRef(name)
  nameRef.current = name
  const everLoaded = useRef(false)
  const wasOffline = useRef(false)
  const pipe = useRef<Pipe | null>(null)
  const stopWhy = useRef('the video left the screen')
  const [built, setBuilt] = useState(0)
  const [stalled, setStalled] = useState(false)
  const [started, setStarted] = useState(false)
  const [dl, setDl] = useState<Got | null>(() => got.get(path) ?? null)
  const [pos, setPos] = useState(0)
  const [mediaDur, setMediaDur] = useState(0)
  const [late, setLate] = useState(false)
  const [, setTick] = useState(0)
  const movedAt = useRef(0)
  const playedOnce = useRef(false)
  const armedAt = useRef(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.innerHTML = `
      <media-controller class="pv-mc" autohide="2" novolumepref nomutedpref>
        <video slot="media" playsinline webkit-playsinline preload="none"${audio ? '' : ' muted'}></video>
        <media-play-button slot="centered-chrome" class="pv-big"></media-play-button>
        <div class="pv-bottom">
          <media-control-bar class="pv-bar">
            <media-time-display showduration notoggle></media-time-display>
            <span class="pv-spacer"></span>
            ${audio ? '<media-mute-button></media-mute-button>' : ''}
            <media-fullscreen-button></media-fullscreen-button>
          </media-control-bar>
          <media-time-range class="pv-range"><media-preview-time-display slot="preview"></media-preview-time-display></media-time-range>
        </div>
      </media-controller>`
    const mc = host.querySelector('media-controller') as HTMLElement
    const video = host.querySelector('video') as HTMLVideoElement
    if (posterRef.current) video.poster = posterRef.current
    const range = host.querySelector<HTMLElement>('media-time-range')
    const unlockSeek = range ? lockSeekSwipes(range) : null
    refs.current = { mc, video, host, range }
    const name = (): string => nameRef.current
    const arm = (why: string, want: { t: number; play: boolean }): void => {
      if (armedRef.current) return
      armedAt.current = performance.now()
      pending.current = want
      note(`[media] ${name()} play tapped (${why}), starting at ${want.t.toFixed(2)} s`)
      calls.current.onArm(want)
    }
    const onPlayAsk = (): void => arm('play', { t: pending.current?.t ?? 0, play: true })
    let lastSave = 0
    const clock = attachFrameClock(video, {
      scrubbing: () => !!range?.hasAttribute('dragging'),
      onStall: (on, why, at) => {
        host.toggleAttribute('data-stalled', on)
        setStalled(on)
        if (on) console.info(`[media] ${name()} waits for data at ${at.toFixed(2)} s (${why === 'clock' ? 'the clock stopped' : why === 'picture' ? 'the picture stopped' : 'held'})`)
        else console.info(`[media] ${name()} ${video.paused ? 'stops waiting, paused' : 'plays again'} at ${at.toFixed(2)} s`)
      },
      onNote: (msg) => console.info(`[media] ${name()} ${msg}`)
    })
    const unzoom = attachMediaZoom(host, video, { ignore: 'media-time-range, .pv-q', clicks: 'media-mute-button, media-fullscreen-button, .pv-q, .pv-big', name: 'video' })
    const save = (): void => {
      lastSave = Date.now()
      calls.current.onFrame?.(Math.round(video.currentTime * fps))
    }
    const onMeta = (): void => {
      everLoaded.current = true
      setMediaDur(Number.isFinite(video.duration) ? video.duration : 0)
      const p = pending.current
      pending.current = null
      if (p && p.t > 0) video.currentTime = Math.min(p.t, Math.max(0, (video.duration || p.t) - 0.05))
      if (p?.play) video.play().catch((e: unknown) => note(`[media] ${name()} is ready and waits for a tap on Play (${e instanceof Error ? e.name : String(e)})`))
    }
    const onTime = (): void => {
      setPos(Math.floor(video.currentTime * 4) / 4)
      if (Date.now() - lastSave > SAVE_EVERY_MS) save()
    }
    const onSeeking = (): void => {
      setPos(Math.floor(video.currentTime * 4) / 4)
      save()
    }
    const onError = (): void => {
      if (!video.error || !pipe.current) return
      note(`[media] ${name()} media error ${video.error.code} at ${video.currentTime.toFixed(1)} s${video.error.message ? `: ${video.error.message}` : ''}`)
      setFailure(errorText(video, everLoaded.current))
    }
    const onPlaying = (): void => {
      if (!playedOnce.current) note(`[media] ${name()} plays, first frame ${Math.round(performance.now() - armedAt.current)} ms after the tap`)
      playedOnce.current = true
      setStarted(true)
    }
    const onCanPlay = (): void => setStarted(true)
    video.addEventListener('loadedmetadata', onMeta)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('pause', save)
    video.addEventListener('seeking', onSeeking)
    video.addEventListener('error', onError)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('canplay', onCanPlay)
    host.addEventListener('mediaplayrequest', onPlayAsk, true)
    const handle: FramePlayerHandle = {
      goto: (loc, pause = true) => {
        const t = loc.t ?? (loc.frame != null ? loc.frame / fps : null)
        if (t == null) return 'seek failed: no frame or t'
        if (video.readyState < 1) {
          pending.current = { t, play: !pause }
          if (!armedRef.current) {
            arm('a seek to a frame', { t, play: !pause })
            return 'loading the video to seek'
          }
          return 'waiting for the video to load'
        }
        video.currentTime = t
        if (pause) video.pause()
        else video.play().catch(() => {})
        return `seeked to frame ${Math.round(t * fps)}`
      },
      element: () => host,
      fps: () => fps,
      frame: () => Math.round(video.currentTime * fps),
      pulse: () => {
        host.classList.remove('pv-pulse')
        void host.offsetWidth
        host.classList.add('pv-pulse')
      }
    }
    calls.current.onHandle?.(handle)
    setBuilt((n) => n + 1)
    return () => {
      calls.current.onHandle?.(null)
      clock.dispose()
      unzoom()
      unlockSeek?.()
      video.removeEventListener('loadedmetadata', onMeta)
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('pause', save)
      video.removeEventListener('seeking', onSeeking)
      video.removeEventListener('error', onError)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('canplay', onCanPlay)
      host.removeEventListener('mediaplayrequest', onPlayAsk, true)
      video.pause()
      refs.current = null
      host.replaceChildren()
    }
  }, [audio, fps])

  useEffect(() => {
    if (resume) pending.current = resume
  }, [resume])

  useEffect(() => {
    refs.current?.host.toggleAttribute('data-armed', armed)
  }, [armed, built])

  useEffect(() => {
    const r = refs.current
    if (!r || !built || !armed) return
    const v = r.video
    const loader = mediaLoader()
    const p = path
    const who = nameRef.current
    setFailure('')
    setStarted(false)
    setMediaDur(0)
    setLate(false)
    everLoaded.current = false
    if (!armedAt.current || playedOnce.current) armedAt.current = performance.now()
    playedOnce.current = false
    if (!loader?.download || !loader.read) {
      setFailure('This page has no way to read videos from the desktop.')
      return
    }
    if (!canStream()) {
      setFailure("This phone can't stream video. It needs iOS 17.1 or later.")
      return
    }
    stopWhy.current = 'the video left the screen'
    const known = got.get(p)
    const s = { stopped: false, have: known?.have ?? 0 }
    setDl(known ?? { have: 0, size: 0, done: false })
    note(`[media] ${who} plays ${label} (${nameOf(p)}) on ${phoneName()}: one download from the start to the end, playing as it arrives`)
    movedAt.current = performance.now()
    const keep = (g: Got): void => {
      if (g.have !== got.get(p)?.have) movedAt.current = performance.now()
      got.set(p, g)
      setDl(g)
    }
    loader.download(p, (pr) => {
      if (s.stopped) return
      s.have = pr.got
      keep({ have: pr.got, size: pr.total, done: pr.total > 0 && pr.got >= pr.total })
    }, { tag: tagRef.current }).then(
      (r) => {
        if (s.stopped) return
        s.have = r.size
        keep({ have: r.size, size: r.size, done: true })
      },
      (e: unknown) => {
        if (s.stopped || isAbort(e)) return
        note(`[media] ${who} download failed: ${plainError(e)}`)
        setFailure((f) => f || plainError(e) || 'The download stopped.')
      }
    )
    pipe.current = playMp4(v, {
      read: (o, l) => loader.read!(p, o, l),
      have: () => s.have,
      log: (line) => note(`[media] ${who} ${line}`),
      fail: (why) => {
        if (!s.stopped) setFailure((f) => f || plainError(new Error(why)))
      },
      late: () => {
        if (!s.stopped) setLate(true)
      }
    })
    return () => {
      s.stopped = true
      movedAt.current = 0
      if (everLoaded.current && !v.error && !pending.current) pending.current = { t: v.currentTime, play: !v.paused }
      pipe.current?.stop()
      pipe.current = null
      loader.stop?.(p, pathRef.current !== p ? 'switched to another quality' : stopWhy.current)
    }
  }, [armed, path, attempt, built])

  useEffect(() => {
    if (armed) return
    const known = got.get(path)
    setDl(known ?? null)
    if (known?.done) return
    let alive = true
    void mediaLoader()
      ?.saved?.(path)
      .then((s) => {
        if (!alive || !s?.total) return
        const g = { have: s.got, size: s.total, done: s.got >= s.total }
        got.set(path, g)
        setDl(g)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [path, armed])

  useEffect(() => {
    const v = refs.current?.video
    if (!v) return
    if (poster) v.poster = poster
    else v.removeAttribute('poster')
  }, [poster, built])

  useEffect(() => {
    if (failure) calls.current.onFailed()
  }, [!!failure])

  useEffect(() => {
    if (offline) {
      wasOffline.current = true
      return
    }
    if (!wasOffline.current) return
    wasOffline.current = false
    if (failure && armed) {
      console.info('[media] the desktop is back, the download goes on from where it stopped')
      setAttempt((n) => n + 1)
    }
  }, [offline, failure])

  const busy = armed && !failure && !dl?.done
  useEffect(() => {
    if (!busy) return
    const t = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [busy])

  const size = dl?.size ?? 0
  const have = dl?.have ?? 0
  const total = mediaDur || duration || 0
  const ready = !!pipe.current?.ready()
  const gotTime = dl?.done ? total : ready ? (pipe.current?.timeAt(have) ?? 0) : 0

  useEffect(() => {
    const range = refs.current?.range
    if (!range) return
    const pct = total > 0 ? Math.min(100, Math.max(0, (gotTime / total) * 100)) : 0
    range.style.setProperty('--media-range-track-background', `linear-gradient(to right, var(--pv-got) 0 ${pct}%, var(--pv-missing) ${pct}% 100%)`)
    range.dataset.pvGot = pct.toFixed(1)
  }, [gotTime, total, built])

  const cancel = (): void => {
    const r = refs.current
    if (!r) return
    note(`[media] ${name} download cancelled on the phone at ${mb(have)} of ${mb(size)} MB`)
    stopWhy.current = 'cancelled on the phone'
    r.video.pause()
    onCancel()
  }

  const waiting = armed && !dl?.done && size > 0 && everLoaded.current && pos > gotTime + 0.3
  let state: string
  let text: string
  let bar: number | null = null
  let button: ReactElement | null = null
  if (!armed) {
    state = 'idle'
    text = dl?.done ? `${label} · ${mb(size)} MB on this phone` : dl?.have && size ? `${label} · ${mb(have)} of ${mb(size)} MB on this phone` : `${label}${bytes ? ` · ${sizeText(bytes)}` : ''}`
  } else if (failure) {
    state = 'error'
    text = `Couldn't play ${name}. ${failure}`
    button = (
      <button type="button" onClick={() => setAttempt((n) => n + 1)}>
        Try again
      </button>
    )
  } else if (!dl?.done && ((movedAt.current > 0 && performance.now() - movedAt.current > STUCK_MS) || (offline && !size))) {
    state = offline ? 'offline' : 'stuck'
    text = `${offline ? 'Waiting for your desktop to reconnect' : 'Waiting for data from your desktop'}${size ? ` · ${mb(have)} of ${mb(size)} MB` : ''}`
    bar = size ? have / size : 0
  } else if (!size) {
    state = 'starting'
    text = `${label} · asking your desktop for the file`
    bar = 0
  } else if (!dl?.done) {
    state = waiting ? 'waiting' : 'downloading'
    text = waiting ? `Waiting for the download to reach ${clockOf(pos)} · ${mb(have)} of ${mb(size)} MB` : `${label} · downloading ${mb(have)} of ${mb(size)} MB${late ? ', plays when all of it is here (index at the end)' : ''}`
    bar = have / size
  } else {
    state = 'done'
    text = `${label} · ${mb(size)} MB on this phone`
  }
  if (armed && !failure && !dl?.done)
    button = (
      <button type="button" onClick={cancel}>
        Cancel
      </button>
    )

  const loading = armed && !started && !failure
  const mc = built ? refs.current?.mc : null
  const row = (
    <div className="pv-status" data-pv-status={state} data-pv-have={have} data-pv-size={size} data-pv-tier={tag.q} data-pv-got={total ? (gotTime / total).toFixed(3) : undefined}>
      <span className="pv-status-text">{text}</span>
      {bar !== null && <ProgressBar key={path} value={bar} className="pv-status-bar" />}
      {button}
      {state !== 'error' && <SaveMedia ask={save} />}
    </div>
  )
  return (
    <div className="pv-wrap">
      <div ref={hostRef} className="pv-host" data-phone-video="" data-loading={loading ? '' : undefined} data-waiting={waiting || (stalled && armed) ? '' : undefined} />
      {mc && quality ? createPortal(quality, mc) : null}
      {!armed && duration ? <span className="pv-dur">{clockOf(duration)}</span> : null}
      {statusEl ? createPortal(row, statusEl) : null}
    </div>
  )
}

interface FramesProps {
  path: string
  tag: MediaTag
  save: MediaSaveAsk | null
  name: string
  label: string
  bytes?: number
  fps: number
  duration?: number
  aspect?: number
  events?: PlayerEvent[]
  initialFrame?: number
  onFrame?: (frame: number) => void
  onHandle?: (h: FramePlayerHandle | null) => void
  poster: string | null
  quality: ReactElement | null
  armed: boolean
  onArm: (want: { t: number; play: boolean }) => void
  onCancel: () => void
  statusEl: HTMLElement | null
  height: string
}

function PhoneFrames({ path, tag, save, name, label, bytes, fps, duration, aspect, events, initialFrame, onFrame, onHandle, poster, quality, armed, onArm, onCancel, statusEl, height }: FramesProps): ReactElement {
  const link = useRemoteLink()
  const offline = link?.online === false
  const [epoch, setEpoch] = useState(0)
  const [failure, setFailure] = useState('')
  const [dl, setDl] = useState<Got | null>(() => got.get(path) ?? null)
  const [full, setFull] = useState(false)
  const [fullBody, setFullBody] = useState<HTMLDivElement | null>(null)
  const [, setTick] = useState(0)
  const calls = useRef({ onArm, onFrame, onHandle })
  calls.current = { onArm, onFrame, onHandle }
  const stopWhy = useRef('the video left the screen')
  const movedAt = useRef(0)
  const wasOffline = useRef(false)
  const source = useMemo(
    () =>
      loaderSource(path, false, {
        tag,
        arm: () => {
          movedAt.current = performance.now()
          note(`[media] ${name} plays ${label} (${nameOf(path)}) frame by frame on ${phoneName()}: one download from the start to the end, frames show as they arrive`)
          calls.current.onArm({ t: 0, play: false })
        },
        progress: (have, size) => {
          const g = { have, size, done: size > 0 && have >= size }
          if (g.have !== got.get(path)?.have) movedAt.current = performance.now()
          got.set(path, g)
          setDl(g)
        },
        failed: (why) => {
          note(`[media] ${name} download failed: ${why}`)
          setFailure((f) => f || plainError(new Error(why)) || 'The download stopped.')
        }
      }),
    [path, epoch]
  )
  useEffect(() => () => source.stop(stopWhy.current), [source])
  useEffect(() => {
    if (armed) void source.open().catch(() => {})
  }, [armed, source])
  useEffect(() => {
    if (armed) return
    const known = got.get(path)
    setDl(known ?? null)
    if (known?.done) return
    let alive = true
    void mediaLoader()
      ?.saved?.(path)
      .then((sv) => {
        if (!alive || !sv?.total) return
        const g = { have: sv.got, size: sv.total, done: sv.got >= sv.total }
        got.set(path, g)
        setDl(g)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [path, armed])
  useEffect(() => {
    if (offline) {
      wasOffline.current = true
      return
    }
    if (!wasOffline.current) return
    wasOffline.current = false
    if (failure && armed) {
      console.info('[media] the desktop is back, the download goes on from where it stopped')
      setFailure('')
      setEpoch((n) => n + 1)
    }
  }, [offline, failure])
  const busy = armed && !failure && !dl?.done
  useEffect(() => {
    if (!busy) return
    const t = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [busy])
  const size = dl?.size ?? 0
  const have = dl?.have ?? 0
  const cancel = (): void => {
    note(`[media] ${name} download cancelled on the phone at ${mb(have)} of ${mb(size)} MB`)
    stopWhy.current = 'cancelled on the phone'
    onCancel()
    setEpoch((n) => n + 1)
  }
  let state: string
  let text: string
  let bar: number | null = null
  let button: ReactElement | null = null
  if (!armed) {
    state = 'idle'
    text = dl?.done ? `${label} · ${mb(size)} MB on this phone` : dl?.have && size ? `${label} · ${mb(have)} of ${mb(size)} MB on this phone` : `${label}${bytes ? ` · ${sizeText(bytes)}` : ''}`
  } else if (failure) {
    state = 'error'
    text = `Couldn't load ${name}. ${failure}`
    button = (
      <button
        type="button"
        onClick={() => {
          setFailure('')
          setEpoch((n) => n + 1)
        }}
      >
        Try again
      </button>
    )
  } else if (!dl?.done && ((movedAt.current > 0 && performance.now() - movedAt.current > STUCK_MS) || (offline && !size))) {
    state = offline ? 'offline' : 'stuck'
    text = `${offline ? 'Waiting for your desktop to reconnect' : 'Waiting for data from your desktop'}${size ? ` · ${mb(have)} of ${mb(size)} MB` : ''}`
    bar = size ? have / size : 0
  } else if (!size) {
    state = 'starting'
    text = `${label} · asking your desktop for the file`
    bar = 0
  } else if (!dl?.done) {
    state = 'downloading'
    text = `${label} · downloading ${mb(have)} of ${mb(size)} MB`
    bar = have / size
  } else {
    state = 'done'
    text = `${label} · ${mb(size)} MB on this phone`
  }
  if (armed && !failure && !dl?.done)
    button = (
      <button type="button" onClick={cancel}>
        Cancel
      </button>
    )
  const row = (
    <div className="pv-status" data-pv-frames="" data-pv-status={state} data-pv-have={have} data-pv-size={size} data-pv-tier={tag.q}>
      <span className="pv-status-text">{text}</span>
      {bar !== null && <ProgressBar key={path} value={bar} className="pv-status-bar" />}
      {quality}
      {button}
      {state !== 'error' && <SaveMedia ask={save} />}
    </div>
  )
  return (
    <div className="pv-frames" data-phone-video="" data-phone-frames="">
      {full && (
        <div className="rk-fs-away" style={{ height }}>
          <span>Playing in full screen</span>
          <button type="button" className="sr-btn on" onClick={() => setFull(false)}>
            Show it here
          </button>
        </div>
      )}
      <FramePlayer
        key={epoch}
        src=""
        source={source}
        fps={fps}
        duration={duration}
        aspect={aspect}
        poster={poster}
        list={false}
        events={events}
        initialFrame={initialFrame}
        onFrame={(f) => calls.current.onFrame?.(f)}
        onHandle={(h) => calls.current.onHandle?.(h)}
        onLog={note}
        onExpand={() => setFull((f) => !f)}
        fullscreen={full ? fullBody : null}
        style={{ height }}
      />
      {full && <Fullscreen kind="video" title={name} bodyRef={setFullBody} onClose={() => setFull(false)} />}
      {statusEl ? createPortal(row, statusEl) : null}
    </div>
  )
}

function EventList({ events, log, onSeek, fps }: { events: PlayerEvent[]; log: PlayerLogLine[]; fps: number; onSeek: (t: number) => void }): ReactElement | null {
  const rows = useMemo(() => {
    const at = (r: { frame?: number; t?: number }): number | null => r.t ?? (r.frame != null ? r.frame / fps : null)
    return [
      ...events.map((e) => ({ t: at(e), text: e.label, kind: e.kind ?? 'info' })),
      ...log.map((l) => ({ t: at(l), text: l.msg, kind: l.level ?? 'info' }))
    ].sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity))
  }, [events, log, fps])
  if (!rows.length) return null
  return (
    <div className="pv-events">
      {rows.map((r, i) =>
        r.t != null ? (
          <button key={i} type="button" className="pv-ev" data-kind={r.kind} onClick={() => onSeek(r.t!)}>
            <span className="pv-ev-t">{fmtTime(r.t)}</span>
            <span className="pv-ev-l">{r.text}</span>
          </button>
        ) : (
          <div key={i} className="pv-ev" data-kind={r.kind}>
            <span className="pv-ev-t" />
            <span className="pv-ev-l">{r.text}</span>
          </div>
        )
      )}
    </div>
  )
}

const TIER_NAMES: Record<MediaTag['q'], string> = { best: 'Best', '1080': '1080p', '720': '720p', '480': '480p', phone: 'phone version' }
const extOf = (p: string): string => /\.[A-Za-z0-9]{1,8}$/.exec(p)?.[0] ?? ''

export function PhoneVideo({
  path,
  ready = true,
  mode = 'sound',
  framesHeight,
  aspect,
  fps,
  events,
  log,
  initialFrame,
  onFrame,
  onHandle,
  style,
  duration
}: {
  path: string
  ready?: boolean
  mode?: 'frames' | 'sound'
  framesHeight?: string
  aspect?: number
  duration?: number
  fps?: number
  events?: PlayerEvent[]
  log?: PlayerLogLine[]
  initialFrame?: number
  onFrame?: (frame: number) => void
  onHandle?: (h: FramePlayerHandle | null) => void
  style: CSSProperties
}): ReactElement {
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [statusEl, setStatusEl] = useState<HTMLDivElement | null>(null)
  const near = useNear(box) && ready
  const link = useRemoteLink()
  const online = link?.online !== false
  const held = useHeld(path, near)
  const hs = heldState(held ?? [])
  const [choice, setChoiceState] = useState<VideoQuality | null>(() => choices.get(path) ?? null)
  const setChoice = (q: VideoQuality | null): void => {
    if (q) choices.set(path, q)
    else choices.delete(path)
    setChoiceState(q)
  }
  const [armed, setArmed] = useState(false)
  const [locked, setLocked] = useState<VideoQuality | null>(null)
  const [lockedAuto, setLockedAuto] = useState(false)
  const [asked, setAsked] = useState<VideoQuality | null>(null)
  const [original, setOriginal] = useState(() => originals.has(path))
  const [epoch, setEpoch] = useState(0)
  const known = plans.get(path) ?? null
  const bestHere = hs.bestDone && !!hs.best && (!known || bestOf(known, hs.best.path))
  const standing = choice ?? heldQuality(hs) ?? 'auto'
  const quality = locked ?? (bestHere ? 'original' : effectiveQuality(known, standing))
  const auto = locked ? lockedAuto : !bestHere && standing === 'auto'
  const lower = quality === 'auto' || quality === 'original' ? null : quality
  const want = !!lower && asked === quality
  const urgent = want && !!makingRendition(known, quality)
  const { plan, error, retry } = usePlan(path, near && held !== null, online, want ? lower! : undefined, urgent, !bestHere)
  const still = useVideoStill(path, near)
  const [resume, setResume] = useState<{ t: number; play: boolean } | null>(null)
  const handle = useRef<FramePlayerHandle | null>(null)
  const frameRate = fps && fps > 0 ? fps : 30
  const v = plan?.version
  const made = readyRendition(plan, quality)
  const [rendition, setRendition] = useState(made)
  const chosen = makingRendition(plan, quality)
  const chosenMaking = chosen?.state === 'queued' || chosen?.state === 'preparing' ? chosen : null
  const best = (bestHere && hs.best && bestOf(plan, hs.best.path) ? hs.best.path : null) ?? bestPath(plan)
  const wantBest = quality === 'original' && !!best
  const wantOriginal = original && !!plan?.plays
  const noVersion = !!plan?.reason && (v?.state === 'skipped' || v?.state === 'failed')
  const versionMaking = v?.state === 'queued' || v?.state === 'preparing'
  const pendingRendition = !!chosen && (chosen.state === 'none' || chosen.state === 'queued' || chosen.state === 'preparing')
  const preparing = !rendition && !wantBest && ((!!plan?.reason && !wantOriginal && (versionMaking || (!!chosenMaking && noVersion && !plan?.plays))) || ((armed || asked === quality) && pendingRendition))
  let playPath: string | null = null
  if (plan && !preparing) playPath = rendition ?? (wantBest ? best : !plan.reason || wantOriginal || !(v?.state === 'ready' && v.path) ? plan.path : v.path)
  const tag: MediaTag | null = plan && playPath ? { of: path, q: tierOf(plan, playPath) } : null
  const blocked = !rendition && !preparing && noVersion && !plan?.plays
  const ratio = aspect && aspect > 0 ? aspect : 16 / 9
  const boxStyle: CSSProperties = { ...style, aspectRatio: String(ratio) }
  const saveFrom = best ?? plan?.path ?? null
  const save: MediaSaveAsk | null = saveFrom ? { path: saveFrom, name: `${nameOf(path).replace(/\.[^.]+$/, '')}${extOf(saveFrom) || extOf(path)}`, kind: 'video', ...(best ? { tag: { of: path, q: 'best' as const } } : {}) } : null
  useDropWhenAway(box, path, !armed && want && chosen?.state === 'queued' ? chosen.id : null, () => setAsked(null))

  const holdPlace = (): void => {
    const h = handle.current
    if (mode === 'frames') {
      if (h) setResume({ t: h.frame() / h.fps(), play: false })
      return
    }
    const el = h?.element()?.querySelector('video')
    if (el && el.readyState > 0) setResume({ t: el.currentTime, play: !el.paused })
  }

  useLayoutEffect(() => {
    if (made === rendition) return
    holdPlace()
    setRendition(made)
  }, [made, rendition])

  const lastHeld = useRef<MediaHeld[] | null>(null)
  useEffect(() => {
    const before = lastHeld.current
    lastHeld.current = held
    if (!held || !before) return
    const lost = before.filter((h) => h.bytes > 0 && !held.some((x) => x.path === h.path && x.bytes > 0))
    if (!lost.length) return
    for (const h of lost) got.delete(h.path)
    if (hs.bestDone) {
      if (armed && playPath && hs.best && playPath !== hs.best.path && bestOf(plan, hs.best.path)) {
        console.info(`[media] ${nameOf(path)} switches to Best now that all of it is on this phone`)
        holdPlace()
        setLocked('original')
        setLockedAuto(false)
      }
      return
    }
    console.info(`[media] ${nameOf(path)} lost ${lost.map((h) => `${TIER_NAMES[h.q]} (${mb(h.bytes)} MB)`).join(', ')} from this phone's cache, back to Auto${armed ? ', the player downloads it again' : ''}`)
    holdPlace()
    setChoice(null)
    setAsked(null)
    if (armed) {
      setLocked(effectiveQuality(plan, 'auto'))
      setLockedAuto(true)
    }
    setEpoch((n) => n + 1)
  }, [held])

  const arm = (): void => {
    setArmed(true)
    setLocked(quality)
    setLockedAuto(auto)
    setAsked(quality)
  }

  const pick = (q: VideoQuality): void => {
    const next = effectiveQuality(plan, q)
    console.info(`[media] ${nameOf(path)} quality picked: ${qualityName(q)}${next !== q ? ` (${qualityName(next)} here)` : ''}${armed ? ', switching now' : ''}`)
    holdPlace()
    setChoice(q)
    setAsked(next)
    if (armed) {
      setLocked(next)
      setLockedAuto(q === 'auto')
    } else if (q === 'original' && best && !bestHere) {
      const size = best === plan?.path ? plan?.bytes : v?.bytes
      console.info(`[media] ${nameOf(path)} downloads Best from start to end: ${best === plan?.path ? 'the original' : 'the phone version'}${size ? `, ${mb(size)} MB` : ''}`)
      setArmed(true)
      setLocked('original')
      setLockedAuto(false)
    }
  }

  const picker = (inline = false): ReactElement | null =>
    plan ? (
      <label slot={inline ? undefined : 'centered-chrome'} className="pv-q" data-inline={inline ? '' : undefined} data-quality={quality} data-picked={auto ? 'auto' : quality} data-best-here={bestHere ? '' : undefined}>
        <span className="pv-q-text">{bestHere && !locked ? 'Best' : qualityLabel(plan, quality, auto)}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 10l5 5 5-5" />
        </svg>
        <select value={auto ? 'auto' : quality} aria-label="Video quality" onChange={(e) => pick(e.currentTarget.value as VideoQuality)}>
          {qualityOptions(plan, held ?? [], best).map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.text}
            </option>
          ))}
        </select>
      </label>
    ) : null

  let body: ReactElement
  if (blocked) {
    body = (
      <div className="rk-media-wait" data-media-wait="error" style={boxStyle}>
        <span>{`This ${plan?.reason.split(', ')[0] ?? ''} video can't play on the phone. ${v?.note ?? ''}`.replace(/\s+/g, ' ').trim()}</span>
        {!!plan?.renditions?.length && picker(true)}
      </div>
    )
  } else if (error && !plan) {
    body = (
      <div className="rk-media-wait" data-media-wait={online ? 'error' : 'offline'} style={boxStyle}>
        <span>{online ? `Couldn't check ${nameOf(path)} on your desktop. ${error}` : 'Waiting for your desktop to reconnect'}</span>
        {online && (
          <button type="button" onClick={retry}>
            Try again
          </button>
        )}
      </div>
    )
  } else if (preparing) {
    const own = pendingRendition && chosen && (armed || asked === quality || chosen.state === 'preparing' || !versionMaking || v?.state === 'queued') ? chosen : null
    const making = own ?? v
    const pct = Math.round((making?.progress ?? 0) * 100)
    const what = own ? `the ${own.id}p version` : 'a phone version'
    const queuedUp = making?.state === 'queued' || making?.state === 'none'
    body = (
      <div className="rk-media-wait" data-media-wait="prepare" data-making={own ? own.id : 'phone'} data-still={still ? '' : undefined} style={still ? { ...boxStyle, backgroundImage: `url("${still}")` } : boxStyle}>
        <span>{queuedUp ? `Waiting to make ${what}, then it downloads` : `Making ${what} · ${pct}%, then it downloads`}</span>
        <ProgressBar value={queuedUp ? 0 : pct / 100} className="rk-media-bar" />
        <span className="pv-why">{`Original: ${plan?.label}`}</span>
        <span className="pv-prep-row">
          {picker(true)}
          {plan?.plays && (
            <button
              type="button"
              onClick={() => {
                console.info(`[media] ${nameOf(path)} plays the original instead of waiting`)
                originals.add(path)
                setOriginal(true)
                setLocked('original')
                setLockedAuto(false)
              }}
            >
              Play the original
            </button>
          )}
        </span>
      </div>
    )
  } else if (plan && playPath && tag) {
    const picked = lower ? chosenRendition(plan, quality) : null
    const r = picked && (picked.state === 'ready' || pendingRendition) ? picked : null
    const label = r ? `${r.id}p` : tag.q === 'best' ? 'Best' : 'Phone version'
    const bytes = r ? r.bytes : playPath === plan.path ? plan.bytes : playPath === v?.path ? v.bytes : undefined
    const onPlayerHandle = (h: FramePlayerHandle | null): void => {
      handle.current = h
      onHandle?.(h)
    }
    body =
      mode === 'frames' ? (
        <PhoneFrames
          key={`${playPath}#${epoch}`}
          path={playPath}
          tag={tag}
          save={save}
          name={nameOf(path)}
          label={label}
          bytes={bytes}
          fps={frameRate}
          duration={duration}
          aspect={ratio}
          events={events}
          initialFrame={resume ? Math.round(resume.t * frameRate) : initialFrame}
          onFrame={onFrame}
          onHandle={onPlayerHandle}
          poster={still}
          quality={picker(true)}
          armed={armed}
          statusEl={statusEl}
          height={framesHeight ?? `min(${Math.round(560)}px, 70vh)`}
          onArm={arm}
          onCancel={() => setArmed(false)}
        />
      ) : (
        <div className="pv-frame" style={still ? { ...boxStyle, backgroundImage: `url("${still}")` } : boxStyle} data-still={still ? '' : undefined}>
          <Player
            key={epoch}
            path={playPath}
            tag={tag}
            save={save}
            name={nameOf(path)}
            label={label}
            bytes={bytes}
            audio={plan.audio}
            fps={frameRate}
            initialFrame={initialFrame}
            onFrame={onFrame}
            onHandle={onPlayerHandle}
            resume={resume}
            onFailed={() => {
              if (playPath !== plan.path) retry()
            }}
            poster={still}
            duration={duration}
            quality={picker()}
            armed={armed}
            statusEl={statusEl}
            onArm={(at) => {
              setResume(at)
              arm()
            }}
            onCancel={() => setArmed(false)}
          />
          {noVersion && plan.plays && <div className="pv-note">{`Playing the original. ${v?.note ?? ''}`.trim()}</div>}
        </div>
      )
  } else {
    body = (
      <div className="rk-media-wait" data-media-wait="load" data-still={still ? '' : undefined} style={still ? { ...boxStyle, backgroundImage: `url("${still}")` } : boxStyle}>
        <span>{`Checking ${nameOf(path)} on your desktop`}</span>
        <ProgressBar value={null} className="rk-media-bar" />
      </div>
    )
  }
  return (
    <div ref={setBox} className="pv" data-pv-quality={quality} data-pv-auto={auto ? '' : undefined} data-pv-best-here={bestHere ? '' : undefined} data-pv-path={playPath ?? undefined} data-pv-tier={tag?.q} data-pv-held={held ? held.map((h) => `${h.q}:${h.bytes}/${h.size}`).join(' ') : undefined}>
      <div className="pv-main">
        {body}
        <div ref={setStatusEl} className="pv-status-slot" />
      </div>
      {!!(events?.length || log?.length) && <EventList events={events ?? []} log={log ?? []} fps={frameRate} onSeek={(t) => handle.current?.goto({ t }, true)} />}
    </div>
  )
}
