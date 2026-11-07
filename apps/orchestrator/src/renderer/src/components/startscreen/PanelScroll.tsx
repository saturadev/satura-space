import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'

const MIN_THUMB = 36
const FADE_MS = 900

export function PanelScroll({
  className,
  wrapperClassName = 'relative min-h-0 flex-1',
  children
}: {
  className: string
  wrapperClassName?: string
  children: ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const [scrollable, setScrollable] = useState(false)
  const [active, setActive] = useState(false)
  const [atTop, setAtTop] = useState(true)
  const [atBottom, setAtBottom] = useState(true)
  const dragRef = useRef<{ startY: number; startScroll: number } | null>(null)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const wake = useCallback(() => {
    setActive(true)
    if (fadeTimer.current) clearTimeout(fadeTimer.current)
    fadeTimer.current = setTimeout(() => {
      if (!dragRef.current) setActive(false)
    }, FADE_MS)
  }, [])

  const sync = useCallback(() => {
    const el = scrollRef.current
    const thumb = thumbRef.current
    const track = trackRef.current
    if (!el || !thumb || !track) return
    const { scrollTop, scrollHeight, clientHeight } = el
    const overflow = scrollHeight - clientHeight
    if (overflow <= 1) {
      setScrollable(false)
      setAtTop(true)
      setAtBottom(true)
      return
    }
    setScrollable(true)
    setAtTop(scrollTop <= 1)
    setAtBottom(scrollTop >= overflow - 1)
    const trackH = track.clientHeight
    const height = Math.max(MIN_THUMB, (clientHeight / scrollHeight) * trackH)
    const top = trackH > height ? (scrollTop / overflow) * (trackH - height) : 0
    thumb.style.height = `${height}px`
    thumb.style.transform = `translateY(${top}px)`
  }, [])

  useLayoutEffect(() => {
    sync()
  })

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    const mo = new MutationObserver(sync)
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [sync])

  useEffect(() => {
    return () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current)
    }
  }, [])

  const onThumbDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = scrollRef.current
      if (!el) return
      e.preventDefault()
      e.stopPropagation()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      dragRef.current = { startY: e.clientY, startScroll: el.scrollTop }
      setActive(true)
    },
    []
  )

  const onThumbMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const el = scrollRef.current
    const track = trackRef.current
    const thumb = thumbRef.current
    if (!drag || !el || !track || !thumb) return
    const trackH = track.clientHeight
    const thumbH = thumb.clientHeight
    const overflow = el.scrollHeight - el.clientHeight
    const travel = trackH - thumbH
    if (travel <= 0 || overflow <= 0) return
    const dy = e.clientY - drag.startY
    el.scrollTop = drag.startScroll + (dy / travel) * overflow
  }, [])

  const onThumbUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      dragRef.current = null
      wake()
    },
    [wake]
  )

  const onTrackDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== trackRef.current) return
    const el = scrollRef.current
    const track = trackRef.current
    const thumb = thumbRef.current
    if (!el || !track || !thumb) return
    const rect = track.getBoundingClientRect()
    const thumbH = thumb.clientHeight
    const target = e.clientY - rect.top - thumbH / 2
    const travel = track.clientHeight - thumbH
    const overflow = el.scrollHeight - el.clientHeight
    el.scrollTop = travel > 0 ? Math.max(0, Math.min(1, target / travel)) * overflow : 0
  }, [])

  return (
    <div className={wrapperClassName}>
      <div
        ref={scrollRef}
        className={`no-scrollbar ${className}`}
        onScroll={() => {
          sync()
          wake()
        }}
      >
        {children}
      </div>
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-panel to-transparent transition-opacity duration-200 ${
          atTop ? 'opacity-0' : 'opacity-100'
        }`}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-panel to-transparent transition-opacity duration-200 ${
          atBottom ? 'opacity-0' : 'opacity-100'
        }`}
      />
      <div
        ref={trackRef}
        onPointerDown={onTrackDown}
        onPointerEnter={wake}
        aria-hidden
        className={`absolute right-0.5 top-2 bottom-2 z-20 w-2 transition-opacity duration-300 ${
          scrollable ? '' : 'pointer-events-none'
        } ${scrollable && active ? 'opacity-100' : 'opacity-0'}`}
      >
        <div
          ref={thumbRef}
          onPointerDown={onThumbDown}
          onPointerMove={onThumbMove}
          onPointerUp={onThumbUp}
          onPointerCancel={onThumbUp}
          className="absolute inset-x-0 top-0 mx-auto w-[2px] rounded-full bg-white/30 transition-colors hover:bg-white/50 active:bg-white/70"
          style={{ willChange: 'transform, height', touchAction: 'none' }}
        />
      </div>
    </div>
  )
}
