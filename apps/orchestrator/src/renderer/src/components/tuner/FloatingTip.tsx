import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { FLOAT_TIP_OPTIONS, floatTipReference, tipMaxWidth } from '../../lib/tuner/inspector/tooltip'
import { placeFloating } from '../../lib/floating'
import { useDriftDriving } from '../../lib/drift-driving'

export function FloatingTip({
  origin,
  x,
  y,
  className,
  attrs,
  html,
  children
}: {
  origin: RefObject<Element | null>
  x: number
  y: number
  className: string
  attrs?: Record<string, string>
  html?: string
  children?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const driving = useDriftDriving()
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const o = origin.current?.getBoundingClientRect()
    el.style.maxWidth = `${tipMaxWidth(window.innerWidth)}px`
    let alive = true
    void placeFloating(floatTipReference({ x: (o?.left ?? 0) + x, y: (o?.top ?? 0) + y }), el, FLOAT_TIP_OPTIONS, () => alive)
    return () => {
      alive = false
    }
  })
  useEffect(() => {
    const hide = (): void => {
      if (ref.current) ref.current.style.visibility = 'hidden'
    }
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [])
  if (driving) return null
  return createPortal(
    <div
      ref={ref}
      data-floating-tip=""
      {...attrs}
      className={`pointer-events-none fixed z-[120] ${className}`}
      style={{ visibility: 'hidden' }}
      dangerouslySetInnerHTML={html != null ? { __html: html } : undefined}
    >
      {html != null ? undefined : children}
    </div>,
    document.body
  )
}
