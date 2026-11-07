import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useFloating } from '../../lib/floating'

export type LayerSide = 'bottom' | 'top' | 'left' | 'right'
export type LayerAlign = 'start' | 'end'

export const AnchoredLayer = forwardRef<
  HTMLDivElement,
  {
    side?: LayerSide
    align?: LayerAlign
    gap?: number
    anchor?: HTMLElement | null
    className?: string
    style?: CSSProperties
    children: ReactNode
  }
>(function AnchoredLayer({ side = 'bottom', align = 'end', gap = 4, anchor, className, style, children }, ref) {
  const markerRef = useRef<HTMLSpanElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => layerRef.current as HTMLDivElement)
  const [parent, setParent] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!anchor) setParent(markerRef.current?.parentElement ?? null)
  }, [anchor])
  useFloating(anchor ?? parent, layerRef, { placement: `${side}-${align}`, gap, origin: !style?.transformOrigin })

  return (
    <>
      {!anchor && <span ref={markerRef} hidden />}
      {createPortal(
        <div
          ref={layerRef}
          data-menu-layer
          className={className}
          style={{ ...style, position: 'fixed', zIndex: 70, top: 0, left: 0, visibility: 'hidden' }}
        >
          {children}
        </div>,
        document.body
      )}
    </>
  )
})
