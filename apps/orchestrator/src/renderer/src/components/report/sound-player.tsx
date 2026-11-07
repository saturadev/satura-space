import 'media-chrome/dist/media-controller.js'
import 'media-chrome/dist/media-control-bar.js'
import 'media-chrome/dist/media-play-button.js'
import 'media-chrome/dist/media-time-range.js'
import 'media-chrome/dist/media-time-display.js'
import 'media-chrome/dist/media-preview-time-display.js'
import 'media-chrome/dist/media-mute-button.js'
import 'media-chrome/dist/media-volume-range.js'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { FramePlayerHandle } from './FramePlayer'
import './video-player.css'

const SAVE_EVERY_MS = 1000
const WAIT_MS = 350
const EXPAND = '<svg class="sr-i-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg><svg class="sr-i-collapse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>'

function errorText(v: HTMLVideoElement, name: string): string {
  const code = v.error?.code
  const why = code === 2 ? 'The connection dropped while it loaded.' : code === 3 ? 'The file looks damaged.' : "The file is damaged or in a format this browser can't play."
  return `Can't play ${name}. ${why}`
}

export function SoundPlayer({
  src,
  name,
  fps,
  aspect,
  initialFrame,
  onFrame,
  onHandle,
  onExpand,
  onLog,
  fullscreen,
  style
}: {
  src: string
  name: string
  fps: number
  aspect?: number
  initialFrame?: number
  onFrame?: (frame: number) => void
  onHandle?: (h: FramePlayerHandle | null) => void
  onExpand?: () => void
  onLog?: (line: string) => void
  fullscreen?: HTMLElement | null
  style?: CSSProperties
}): ReactElement {
  const slotRef = useRef<HTMLDivElement>(null)
  const calls = useRef({ onFrame, onHandle, onExpand, onLog })
  calls.current = { onFrame, onHandle, onExpand, onLog }
  const startRef = useRef(initialFrame ?? 0)
  const [state, setState] = useState<{ kind: 'idle' | 'wait' | 'error'; text: string }>({ kind: 'idle', text: '' })
  const [attempt, setAttempt] = useState(0)
  const host = useMemo(() => {
    const el = document.createElement('div')
    el.className = 'sv'
    el.dataset.soundPlayer = ''
    el.innerHTML = `
      <div class="sv-box">
        <media-controller class="sv-mc" autohide="2" novolumepref nomutedpref>
          <video slot="media" playsinline preload="metadata"></video>
          <media-play-button slot="centered-chrome" class="sv-big"></media-play-button>
          <div class="sv-bottom">
            <media-time-range class="sv-range"><media-preview-time-display slot="preview"></media-preview-time-display></media-time-range>
            <media-control-bar class="sv-bar">
              <media-play-button></media-play-button>
              <media-mute-button></media-mute-button>
              <media-volume-range></media-volume-range>
              <media-time-display showduration notoggle></media-time-display>
              <span class="sv-spacer"></span>
              <button type="button" class="sv-btn" data-expand title="Full screen" aria-label="Full screen">${EXPAND}</button>
            </media-control-bar>
          </div>
        </media-controller>
      </div>`
    return el
  }, [])

  useLayoutEffect(() => {
    const box = host.querySelector<HTMLElement>('.sv-box')
    if (!box) return
    box.removeAttribute('style')
    if (fullscreen) return
    if (style) Object.assign(box.style, style)
    box.style.aspectRatio = String(aspect && aspect > 0 ? aspect : 16 / 9)
  })

  useLayoutEffect(() => {
    const target = fullscreen ?? slotRef.current
    if (!target) return
    target.appendChild(host)
    host.toggleAttribute('data-full', !!fullscreen)
    host.classList.toggle('sv-full', !!fullscreen)
  }, [host, fullscreen])

  useEffect(() => () => host.remove(), [host])

  useEffect(() => {
    const video = host.querySelector('video') as HTMLVideoElement
    const expand = host.querySelector<HTMLElement>('[data-expand]')
    host.dataset.videoName = name
    const log = (line: string): void => calls.current.onLog?.(`[video] ${name} ${line}`)
    let lastSave = 0
    let waitT = 0
    let loggedPlay = false
    const save = (): void => {
      lastSave = Date.now()
      startRef.current = Math.round(video.currentTime * fps)
      calls.current.onFrame?.(startRef.current)
    }
    const onMeta = (): void => {
      const t = startRef.current / fps
      if (t > 0) video.currentTime = Math.min(t, Math.max(0, video.duration - 0.05))
      log(`ready: ${video.videoWidth}x${video.videoHeight}, ${video.duration.toFixed(2)} s, plays with sound`)
    }
    const onTime = (): void => {
      if (Date.now() - lastSave > SAVE_EVERY_MS) save()
    }
    const onWaiting = (): void => {
      window.clearTimeout(waitT)
      waitT = window.setTimeout(() => {
        if (!video.paused && video.readyState < 3) setState({ kind: 'wait', text: 'Loading' })
      }, WAIT_MS)
    }
    const onFlow = (): void => {
      window.clearTimeout(waitT)
      setState((s) => (s.kind === 'wait' ? { kind: 'idle', text: '' } : s))
    }
    const onPlaying = (): void => {
      onFlow()
      if (loggedPlay) return
      loggedPlay = true
      log(`plays from ${video.currentTime.toFixed(2)} s, ${video.muted ? 'muted' : `volume ${Math.round(video.volume * 100)}%`}`)
    }
    const onError = (): void => {
      if (!video.error) return
      const text = errorText(video, name)
      log(`error ${video.error.code}: ${text}`)
      setState({ kind: 'error', text })
    }
    const onExpandClick = (e: Event): void => {
      e.stopPropagation()
      calls.current.onExpand?.()
    }
    video.addEventListener('loadedmetadata', onMeta)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('pause', save)
    video.addEventListener('seeked', save)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('seeking', onWaiting)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('canplay', onFlow)
    video.addEventListener('seeked', onFlow)
    video.addEventListener('error', onError)
    expand?.addEventListener('click', onExpandClick)
    if (!calls.current.onExpand && expand) expand.hidden = true
    setState({ kind: 'idle', text: '' })
    video.src = src
    const handle: FramePlayerHandle = {
      goto: (loc, pause = true) => {
        const t = loc.t ?? (loc.frame != null ? loc.frame / fps : null)
        if (t == null) return 'seek failed: no frame or t'
        if (video.readyState < 1) {
          startRef.current = Math.round(t * fps)
          return 'waiting for the video to load'
        }
        video.currentTime = Math.min(t, Math.max(0, video.duration - 0.01))
        if (pause) video.pause()
        else video.play().catch(() => {})
        return `seeked to ${t.toFixed(2)} s`
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
    return () => {
      calls.current.onHandle?.(null)
      window.clearTimeout(waitT)
      video.removeEventListener('loadedmetadata', onMeta)
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('pause', save)
      video.removeEventListener('seeked', save)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('seeking', onWaiting)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('canplay', onFlow)
      video.removeEventListener('seeked', onFlow)
      video.removeEventListener('error', onError)
      expand?.removeEventListener('click', onExpandClick)
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [host, src, fps, name, attempt])

  return (
    <>
      <div ref={slotRef} className="sv-slot" />
      {state.kind !== 'idle' && (
        <div className="sv-status" data-state={state.kind}>
          <span>{state.text}</span>
          {state.kind === 'error' && (
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          )}
        </div>
      )}
    </>
  )
}
