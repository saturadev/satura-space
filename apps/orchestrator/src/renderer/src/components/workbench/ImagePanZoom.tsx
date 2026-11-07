import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { isMobileLayout } from '../../lib/mobile/mobile-back'
import { blockWheel, pinchFactor, wheelPixels, wheelStream, type WheelStream } from '../../lib/tuner/wheel'
import { attachTouchZoom, clampScale, fitView, settleView, zoomAt, FIT_PAD, TOUCH_MAX_ZOOM, type View } from './image-view'

export function ImagePanZoom({
  src,
  alt,
  onSwipe,
  size,
  onShown
}: {
  src: string
  alt: string
  onSwipe?: (dir: 1 | -1) => void
  size?: { w: number; h: number }
  onShown?: (ok: boolean) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(() => (size && size.w > 0 && size.h > 0 ? { w: size.w, h: size.h } : null))
  const naturalRef = useRef(natural)
  naturalRef.current = natural
  const swipeRef = useRef(onSwipe)
  swipeRef.current = onSwipe
  const pad = isMobileLayout() ? 0 : FIT_PAD
  const [view, setView] = useState<View | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const fittedRef = useRef(true)
  const touchedRef = useRef(false)
  const wheelRef = useRef<WheelStream | null>(null)
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const fit = useCallback((): void => {
    const el = wrapRef.current
    if (!el || !natural) return
    fittedRef.current = true
    setView(fitView(el.clientWidth, el.clientHeight, natural.w, natural.h, pad))
  }, [natural, pad])

  const prevNaturalRef = useRef<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const prev = prevNaturalRef.current
    prevNaturalRef.current = natural
    if (!natural) return
    if (fittedRef.current || !viewRef.current) {
      fit()
      return
    }
    const v = viewRef.current
    const el = wrapRef.current
    if (!prev || !el || (prev.w === natural.w && prev.h === natural.h)) return
    const cx = el.clientWidth / 2
    const cy = el.clientHeight / 2
    const u = (cx - v.x) / (v.scale * prev.w)
    const w = (cy - v.y) / (v.scale * prev.h)
    const scale = clampScale((v.scale * prev.w) / natural.w)
    setView({ scale, x: cx - u * natural.w * scale, y: cy - w * natural.h * scale })
  }, [natural, fit])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (fittedRef.current) return fit()
      const v = viewRef.current
      const n = naturalRef.current
      if (!touchedRef.current || !v || !n || el.clientWidth < 2 || el.clientHeight < 2) return
      const min = fitView(el.clientWidth, el.clientHeight, n.w, n.h, pad).scale
      setView(settleView(v, el.clientWidth, el.clientHeight, n.w, n.h, min, Math.max(min * TOUCH_MAX_ZOOM, 4, v.scale), el.clientWidth / 2, el.clientHeight / 2))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit, pad])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    return attachTouchZoom(el, {
      view: () => viewRef.current,
      natural: () => naturalRef.current,
      show: (v, fitted) => {
        touchedRef.current = true
        fittedRef.current = fitted
        viewRef.current = v
        setView(v)
      },
      pad,
      onSwipe: (dir) => {
        const go = swipeRef.current
        go?.(dir)
        return !!go
      }
    })
  }, [pad])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const v = viewRef.current
      if (!v) return
      const st = wheelStream(wheelRef.current, e, performance.now(), true)
      wheelRef.current = st
      if (st.blocked || (st.mode !== 'zoom' && dragRef.current)) return
      fittedRef.current = false
      const [dx, dy] = wheelPixels(e)
      if (st.mode === 'pan' || st.mode === 'orbit') {
        setView({ ...v, x: v.x - dx, y: v.y - dy })
        return
      }
      const r = el.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      if (st.mode === 'pinch') {
        setView(zoomAt(v, 1 / pinchFactor(dy), px, py))
        return
      }
      setView(zoomAt(v, Math.exp(-(dy !== 0 || !e.shiftKey ? dy : dx) * 0.0015), px, py))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'touch' || (e.button !== 0 && e.button !== 1 && e.button !== 2)) return
    wheelRef.current = blockWheel(wheelRef.current)
    wrapRef.current?.focus({ preventScroll: true })
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
    setDragging(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    const v = viewRef.current
    if (!d || d.id !== e.pointerId || !v) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (dx === 0 && dy === 0) return
    dragRef.current = { ...d, x: e.clientX, y: e.clientY }
    fittedRef.current = false
    setView({ ...v, x: v.x + dx, y: v.y + dy })
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.id !== e.pointerId) return
    dragRef.current = null
    setDragging(false)
  }

  return (
    <div
      ref={wrapRef}
      tabIndex={-1}
      data-image-viewer
      data-image-scale={view ? view.scale.toFixed(4) : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onContextMenu={(e) => e.preventDefault()}
      onDoubleClick={fit}
      onKeyDown={(e) => {
        if (e.key !== 'f' && e.key !== 'F') return
        if (e.metaKey || e.ctrlKey || e.altKey) return
        e.preventDefault()
        fit()
      }}
      className={`absolute inset-0 overflow-hidden bg-canvas outline-none ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      style={{ touchAction: 'none' }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(e) => {
          const img = e.currentTarget
          if (natural?.w !== img.naturalWidth || natural?.h !== img.naturalHeight) setNatural({ w: img.naturalWidth, h: img.naturalHeight })
          onShown?.(true)
        }}
        onError={() => onShown?.(false)}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          maxWidth: 'none',
          transformOrigin: '0 0',
          transform: view ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : undefined,
          visibility: view ? 'visible' : 'hidden',
          imageRendering: view && view.scale >= 2 ? 'pixelated' : 'auto'
        }}
      />
    </div>
  )
}
