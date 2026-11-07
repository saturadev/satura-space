import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type WheelEvent,
} from 'react'

export function BarXScroll({
  className,
  wrapperClassName = 'relative shrink-0',
  fade = 'var(--canvas)',
  children
}: {
  className: string
  wrapperClassName?: string
  fade?: string
  children: ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLSpanElement>(null)
  const leftRef = useRef<HTMLSpanElement>(null)
  const rightRef = useRef<HTMLSpanElement>(null)

  const sync = useCallback(() => {
    const el = scrollRef.current
    const thumb = thumbRef.current
    if (!el || !thumb) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    const overflow = scrollWidth - clientWidth
    if (leftRef.current) leftRef.current.style.opacity = overflow > 1 && scrollLeft > 1 ? '1' : '0'
    if (rightRef.current) rightRef.current.style.opacity = overflow > 1 && scrollLeft < overflow - 1 ? '1' : '0'
    if (overflow <= 1) {
      thumb.style.opacity = '0'
      return
    }
    const width = Math.min(clientWidth, Math.max(24, (clientWidth / scrollWidth) * clientWidth))
    const left = clientWidth > width ? (scrollLeft / overflow) * (clientWidth - width) : 0
    thumb.style.width = `${width}px`
    thumb.style.transform = `translateX(${left}px)`
    thumb.style.opacity = '1'
  }, [])

  useLayoutEffect(() => {
    sync()
  }, [sync])
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(sync)
    const observeChildren = (): void => {
      for (const child of Array.from(el.children)) ro.observe(child)
    }
    ro.observe(el)
    observeChildren()
    const mo = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.removedNodes)) {
          if (node instanceof Element) ro.unobserve(node)
        }
      }
      observeChildren()
      sync()
    })
    mo.observe(el, { childList: true })
    return () => {
      mo.disconnect()
      ro.disconnect()
    }
  }, [sync])

  const onWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    el.scrollLeft += e.deltaY
  }, [])

  return (
    <div className={wrapperClassName}>
      <div ref={scrollRef} className={className} onScroll={sync} onWheel={onWheel}>
        {children}
      </div>
      <span
        ref={leftRef}
        aria-hidden
        data-bar-fade="left"
        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 transition-opacity duration-150"
        style={{ opacity: 0, background: `linear-gradient(to right, ${fade}, transparent)`, boxShadow: 'inset 6px 0 6px -6px rgb(0 0 0 / 0.55)' }}
      />
      <span
        ref={rightRef}
        aria-hidden
        data-bar-fade="right"
        className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 transition-opacity duration-150"
        style={{ opacity: 0, background: `linear-gradient(to left, ${fade}, transparent)`, boxShadow: 'inset -6px 0 6px -6px rgb(0 0 0 / 0.55)' }}
      />
      <span
        ref={thumbRef}
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 z-10 h-[2px] rounded-full bg-white/35"
        style={{ opacity: 0, willChange: 'transform' }}
      />
    </div>
  )
}
