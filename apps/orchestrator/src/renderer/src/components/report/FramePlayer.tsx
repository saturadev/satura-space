import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { FramePlayerCore, type AngleSource, type PlayerEvent, type PlayerLogLine } from './frame-player-core'
import type { FrameSource } from './frame-decoder'
import { CompareCore, compareMode, compareRatios, type CompareMode } from './compare-core'
import './report-kit.css'
import './video-player.css'

export interface FramePlayerHandle {
  goto: (loc: { frame?: number; t?: number }, pause?: boolean) => string
  element: () => HTMLElement | null
  fps: () => number
  frame: () => number
  pulse?: () => void
  target?: () => HTMLElement | null
}

const sourceIds = new WeakMap<FrameSource, number>()
let nextSourceId = 1

function sourceId(s: FrameSource | null | undefined): number {
  if (!s) return 0
  let id = sourceIds.get(s)
  if (!id) sourceIds.set(s, (id = nextSourceId++))
  return id
}

export function FramePlayer({
  src,
  source,
  duration,
  poster,
  list,
  onLog,
  fps,
  events,
  log,
  initialFrame,
  onFrame,
  onError,
  onHandle,
  onExpand,
  fullscreen,
  label,
  angles,
  aspect,
  className = '',
  style
}: {
  src: string
  source?: FrameSource | null
  duration?: number
  poster?: string | null
  list?: boolean
  onLog?: (line: string) => void
  fps?: number
  aspect?: number
  events?: PlayerEvent[]
  log?: PlayerLogLine[]
  initialFrame?: number
  onFrame?: (frame: number) => void
  onError?: (message: string) => void
  onHandle?: (handle: FramePlayerHandle | null) => void
  onExpand?: () => void
  fullscreen?: HTMLElement | null
  label?: string
  angles?: AngleSource[]
  className?: string
  style?: CSSProperties
}) {
  const slotRef = useRef<HTMLDivElement>(null)
  const host = useMemo(() => {
    const el = document.createElement('div')
    el.tabIndex = 0
    el.dataset.framePlayer = ''
    el.addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement).closest('input')) el.focus({ preventScroll: true })
    })
    return el
  }, [])
  const callbacks = useRef({ onFrame, onError, onHandle, onExpand, onLog })
  callbacks.current = { onFrame, onError, onHandle, onExpand, onLog }
  const posterRef = useRef(poster)
  posterRef.current = poster
  const coreRef = useRef<FramePlayerCore | null>(null)
  const initialRef = useRef(initialFrame)
  const dataKey = useMemo(() => JSON.stringify([events ?? [], log ?? [], label ?? '', (angles ?? []).map((a) => ({ src: a.src, label: a.label, offset: a.offset, source: sourceId(a.source) }))]), [events, log, label, angles])
  const anglesRef = useRef(angles)
  anglesRef.current = angles
  const expandable = !!onExpand

  const fitRef = useRef('')
  const aspectRef = useRef(aspect)
  aspectRef.current = aspect

  useLayoutEffect(() => {
    host.className = `sr-scope sr-player ${className}`
    host.removeAttribute('style')
    if (style) Object.assign(host.style, style)
    if (fitRef.current && !fullscreen) host.style.maxHeight = fitRef.current
  })

  useLayoutEffect(() => {
    if (fullscreen) {
      fitRef.current = ''
      host.style.removeProperty('max-height')
      return
    }
    const fit = (): void => {
      const v = host.querySelector<HTMLVideoElement | HTMLCanvasElement>('.srv-main .sr-content > video, .srv-main .sr-content > canvas')
      const main = host.querySelector<HTMLElement>('.srv-main')
      const box = main?.querySelector<HTMLElement>(':scope > .sr-viewport, :scope > .srv-stage')
      const side = host.querySelector<HTMLElement>('.srv-side')
      const known = aspectRef.current && aspectRef.current > 0 ? 1 / aspectRef.current : 0
      const w = v instanceof HTMLVideoElement ? v.videoWidth : (v?.width ?? 0)
      const h = v instanceof HTMLVideoElement ? v.videoHeight : (v?.height ?? 0)
      const ratio = w && h ? h / w : known
      if (!ratio || !main || !box || !box.clientWidth) return
      let need = box.clientWidth * ratio
      if (box.classList.contains('srv-stage')) {
        if (box.classList.contains('focus')) return
        const cs = getComputedStyle(box)
        const gap = parseFloat(cs.rowGap) || 0
        const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
        const cols = Math.max(1, cs.gridTemplateColumns.split(' ').filter(Boolean).length)
        const rows = Math.ceil(box.children.length / cols)
        const tileW = (box.clientWidth - pad - gap * (cols - 1)) / cols
        need = rows * tileW * ratio + gap * (rows - 1) + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
      }
      const chrome = main.clientHeight - box.clientHeight
      const body = need + chrome
      const stacked = !!side && side.offsetParent !== null && side.offsetTop >= main.offsetTop + main.offsetHeight - 1
      const total = stacked ? Math.max(body / 0.66, body + 120) : body
      const next = `${Math.ceil(Math.max(160, total))}px`
      if (next === fitRef.current) return
      fitRef.current = next
      host.style.maxHeight = next
    }
    let frame = 0
    const later = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fit)
    }
    const ro = new ResizeObserver(later)
    ro.observe(host)
    host.addEventListener('loadedmetadata', fit, true)
    host.addEventListener('frame-player:built', fit)
    fit()
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      host.removeEventListener('loadedmetadata', fit, true)
      host.removeEventListener('frame-player:built', fit)
    }
  }, [host, fullscreen])

  useLayoutEffect(() => {
    const target = fullscreen ?? slotRef.current
    if (!target) return
    const hadFocus = host.contains(document.activeElement)
    target.appendChild(host)
    if (fullscreen) host.dataset.fullscreen = ''
    else delete host.dataset.fullscreen
    if (fullscreen || hadFocus) host.focus({ preventScroll: true })
  }, [host, fullscreen])

  useEffect(() => () => host.remove(), [host])

  useLayoutEffect(() => {
    const [ev, ln, lb] = JSON.parse(dataKey) as [PlayerEvent[], PlayerLogLine[], string]
    const an = anglesRef.current ?? []
    const core = new FramePlayerCore(host, {
      src,
      source,
      duration,
      aspect: aspectRef.current,
      poster: posterRef.current,
      list,
      onLog: (line) => callbacks.current.onLog?.(line),
      fps,
      events: ev,
      log: ln,
      label: lb || undefined,
      angles: an.length ? an : undefined,
      initialFrame: initialRef.current,
      onFrame: (f) => {
        initialRef.current = f
        callbacks.current.onFrame?.(f)
      },
      onError: (m) => callbacks.current.onError?.(m),
      onExpand: expandable ? () => callbacks.current.onExpand?.() : undefined
    })
    coreRef.current = core
    const handle: FramePlayerHandle = {
      goto: (loc, pause) => core.goto(loc, pause),
      element: () => host,
      fps: () => core.fps,
      frame: () => core.frame,
      pulse: () => core.pulse()
    }
    callbacks.current.onHandle?.(handle)
    return () => {
      callbacks.current.onHandle?.(null)
      if (coreRef.current === core) coreRef.current = null
      core.dispose()
    }
  }, [host, src, source, duration, list, fps, dataKey, expandable])

  useEffect(() => {
    coreRef.current?.setPoster(poster)
  }, [poster])

  return <div ref={slotRef} className="sr-player-slot" />
}

function scrollRoot(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll' || o === 'overlay') return p
  }
  return null
}

function useNear(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver !== 'function') {
      setNear(true)
      return
    }
    const io = new IntersectionObserver((entries) => setNear(entries[entries.length - 1].isIntersecting), {
      root: scrollRoot(el),
      rootMargin: '100% 0px'
    })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
  return near
}

const PLACEHOLDER = '<div class="src"><div class="src-bar" style="visibility:hidden"><div class="sr-seg"><button class="sr-btn" tabindex="-1">Wipe</button></div><span class="sr-spacer"></span><span class="sr-chip">Fit</span></div><div class="src-stage"></div></div>'

export function CompareView({
  before,
  after,
  beforeLabel,
  afterLabel,
  mode,
  aspect,
  onError,
  className = '',
  style
}: {
  before: string
  after: string
  beforeLabel?: string
  afterLabel?: string
  mode?: CompareMode
  aspect?: number
  onError?: (message: string) => void
  className?: string
  style?: CSSProperties
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const modeRef = useRef<CompareMode | undefined>(mode)
  useEffect(() => {
    modeRef.current = mode
  }, [mode])
  const near = useNear(hostRef)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const m = compareMode(modeRef.current)
    if (!host.dataset.mode) host.dataset.mode = m
    if (!aspect || host.style.getPropertyValue('--src-ar')) return
    for (const [k, v] of Object.entries(compareRatios(aspect, m))) host.style.setProperty(k, v)
  }, [aspect])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (!near) {
      host.innerHTML = PLACEHOLDER
      return
    }
    host.replaceChildren()
    const core = new CompareCore(host, {
      before,
      after,
      beforeLabel,
      afterLabel,
      mode: modeRef.current,
      onError: (m) => onErrorRef.current?.(m),
      onMode: (m) => {
        modeRef.current = m
      }
    })
    return () => core.dispose()
  }, [near, before, after, beforeLabel, afterLabel, mode])

  return (
    <div
      ref={hostRef}
      className={`sr-scope sr-compare ${className}`}
      style={style}
      tabIndex={0}
      data-compare-view
      data-mounted={near ? '' : undefined}
      onPointerDown={() => hostRef.current?.focus({ preventScroll: true })}
    />
  )
}
