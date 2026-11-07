import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { REPORT_FRAME_SANDBOX, REPORT_FRAME_URL, type FrameEvent, type FrameInsets, type FrameLoad, type FrameSettings } from '@shared/report-frame'
import { isMobileLayout, useMobileBack } from '../../lib/mobile/mobile-back'
import { FrameChannel, inlineFrameHtml, inlineFrameUrl, inlineReportFrames, type FrameScope } from './frame-host'
import { onHeldChange } from '../../lib/media-loader'

const FULL: CSSProperties = { position: 'fixed', inset: 0, width: '100vw', height: '100vh', zIndex: 2147483000 }

function dispatchKey(el: HTMLElement, ev: Extract<FrameEvent, { e: 'key' }>): void {
  el.dispatchEvent(
    new KeyboardEvent(ev.type, { key: ev.key, code: ev.code, metaKey: ev.meta, ctrlKey: ev.ctrl, altKey: ev.alt, shiftKey: ev.shift, repeat: ev.repeat, bubbles: true, cancelable: true, composed: true })
  )
}

function dispatchPointer(el: HTMLElement): void {
  const init = { bubbles: true, cancelable: true, composed: true, view: window }
  if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }))
  el.dispatchEvent(new MouseEvent('mousedown', init))
}

function screenInsets(): FrameInsets {
  const cs = getComputedStyle(document.documentElement)
  const safe = (side: string): number => Math.max(0, Math.round(parseFloat(cs.getPropertyValue(`--safe-${side}`)) || 0))
  return { t: safe('top'), r: safe('right'), b: safe('bottom'), l: safe('left') }
}

function frameInsets(el: HTMLIFrameElement, screen: FrameInsets): FrameInsets {
  const r = el.getBoundingClientRect()
  const over = (inset: number, room: number): number => Math.max(0, Math.round(inset - Math.max(0, room)))
  return { t: over(screen.t, r.top), r: over(screen.r, window.innerWidth - r.right), b: over(screen.b, window.innerHeight - r.bottom), l: over(screen.l, r.left) }
}

const sides = (i: FrameInsets): string => `${i.t},${i.r},${i.b},${i.l}`

function useFrameInsets(el: HTMLIFrameElement | null, channel: FrameChannel, full: boolean, label: string): void {
  const sent = useRef('')
  useLayoutEffect(() => {
    if (!el || !isMobileLayout()) return
    let raf = 0
    const send = (): void => {
      raf = 0
      const screen = screenInsets()
      const insets = full ? null : frameInsets(el, screen)
      const key = `${sides(screen)}|${insets ? sides(insets) : 'full'}`
      if (key === sent.current) return
      sent.current = key
      channel.set(insets ? { insets, screen } : { screen })
      console.info(`[report] ${label} safe area: screen ${sides(screen)}, ${insets ? `panel frame ${sides(insets)}` : 'frame is full screen'} (top,right,bottom,left)`)
    }
    const later = (): void => {
      if (!raf) raf = requestAnimationFrame(send)
    }
    send()
    const ro = new ResizeObserver(later)
    ro.observe(el)
    window.addEventListener('resize', later)
    window.addEventListener('satura-insets', later)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', later)
      window.removeEventListener('satura-insets', later)
    }
  }, [el, channel, full, label])
}

export function ReportFrame({
  scope,
  load,
  settings,
  onEvent,
  title,
  className,
  style,
  onChannel
}: {
  scope: FrameScope
  load: FrameLoad | null
  settings: FrameSettings
  onEvent: (ev: FrameEvent) => void
  title: string
  className?: string
  style?: CSSProperties
  onChannel?: (channel: FrameChannel | null) => void
}) {
  const handler = useRef(onEvent)
  handler.current = onEvent
  const [full, setFull] = useState(false)
  const [back, setBack] = useState({ depth: 0, title: '' })
  const ref = useRef<HTMLIFrameElement | null>(null)
  const [frameEl, setFrameEl] = useState<HTMLIFrameElement | null>(null)
  const [channel] = useState(
    () =>
      new FrameChannel(scope, (ev) => {
        const el = ref.current
        if (ev.e === 'fullscreen') setFull(ev.on)
        else if (ev.e === 'back') setBack({ depth: ev.depth, title: ev.title })
        else if (ev.e === 'key') {
          if (el) dispatchKey(el, ev)
        } else if (ev.e === 'pointer') {
          if (el) dispatchPointer(el)
        } else handler.current(ev)
      })
  )
  channel.scope = scope
  const inline = inlineReportFrames()
  const [html, setHtml] = useState<string | null>(null)
  const [htmlError, setHtmlError] = useState('')
  useEffect(() => {
    if (!inline) return
    let alive = true
    inlineFrameHtml().then(
      (h) => alive && setHtml(h),
      (e: unknown) => alive && setHtmlError(e instanceof Error ? e.message : String(e))
    )
    return () => {
      alive = false
    }
  }, [inline])
  useLayoutEffect(() => {
    onChannel?.(channel)
    return () => onChannel?.(null)
  }, [channel, onChannel])
  useEffect(() => () => channel.detach(), [channel])
  useEffect(() => {
    if (load) channel.load(load)
  }, [channel, load])
  useEffect(() => {
    channel.set(settings)
  }, [channel, settings.zoom, settings.online, settings.theme])
  useEffect(() => {
    let n = 0
    return onHeldChange(() => channel.set({ held: ++n }))
  }, [channel])
  useMobileBack(back.depth > 0 ? () => channel.back() : null, back.title)
  useFrameInsets(frameEl, channel, full, scope.file.split('/').slice(-2).join('/'))
  const attachFrame = useCallback(
    (el: HTMLIFrameElement | null) => {
      ref.current = el
      if (el) channel.attach(el)
      setFrameEl(el)
    },
    [channel]
  )
  if (inline && !html)
    return htmlError ? (
      <div className="rk-error" data-report-frame-error>
        <div className="rk-error-box">
          <pre className="rk-error-pre">{`Couldn't load the report viewer: ${htmlError}`}</pre>
        </div>
      </div>
    ) : null
  return (
    <iframe
      ref={attachFrame}
      src={inline ? inlineFrameUrl() : REPORT_FRAME_URL}
      sandbox={REPORT_FRAME_SANDBOX}
      title={title}
      data-report-frame={scope.mode}
      data-report-frame-full={full ? '' : undefined}
      className={className}
      style={full ? { ...style, ...FULL } : style}
    />
  )
}
