import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { zoomOf } from '../../lib/css-zoom'

export function LiftedLayer({ children }: { children: ReactNode }) {
  const markerRef = useRef<HTMLSpanElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const host = markerRef.current?.offsetParent
    const box = boxRef.current
    if (!(host instanceof HTMLElement) || !box) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      if (!host.isConnected) return
      const r = host.getBoundingClientRect()
      const z = zoomOf(host)
      box.style.zoom = z === 1 ? '' : String(z)
      box.style.left = `${r.left / z + host.clientLeft}px`
      box.style.top = `${r.top / z + host.clientTop}px`
      box.style.width = `${host.clientWidth}px`
      box.style.height = `${host.clientHeight}px`
      box.style.visibility = ''
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    const ro = new ResizeObserver(schedule)
    ro.observe(host)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [])

  return (
    <>
      <span ref={markerRef} aria-hidden style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' }} />
      {createPortal(
        <div
          ref={boxRef}
          data-viewport-ui
          data-lifted-layer
          className="pointer-events-none fixed left-0 top-0 z-50 [&>*]:pointer-events-auto"
          style={{ visibility: 'hidden' }}
        >
          {children}
        </div>,
        document.body
      )}
    </>
  )
}
