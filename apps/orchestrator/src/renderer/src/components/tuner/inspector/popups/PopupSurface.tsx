import { createContext, useContext, useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Box } from './placement'
import { attachFloating } from '../../../../lib/floating'
import { tunerTip } from '../../../../lib/tuner/inspector/tooltip'
import { useMobileBack } from '../../../../lib/mobile/mobile-back'

export type AnchorGetter = () => Box | null

const DepthContext = createContext(0)

export function rectBox(el: Element | null | undefined): Box | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

function stop(e: React.SyntheticEvent): void {
  e.stopPropagation()
}

function isInsideDeeper(target: EventTarget | null, depth: number, self: HTMLElement | null): boolean {
  const el = target instanceof Element ? target : null
  if (!el) return false
  if (self && self.contains(el)) return true
  const root = el.closest('[data-tuner-popup-depth]') as HTMLElement | null
  if (!root) return false
  return Number(root.dataset.tunerPopupDepth) > depth
}

export function PopupSurface({
  getAnchor,
  placement = 'anchor',
  onOutside,
  children,
  className,
  style,
  minWidth,
  kind,
  role,
  onKeyDown,
  autoFocus = true,
  surfaceRef,
  attrs,
  title
}: {
  getAnchor: AnchorGetter
  placement?: 'anchor' | 'beside'
  onOutside?: () => void
  children: ReactNode
  className?: string
  style?: CSSProperties
  minWidth?: number
  kind?: string
  role?: string
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void
  autoFocus?: boolean
  surfaceRef?: React.MutableRefObject<HTMLDivElement | null>
  attrs?: Record<string, string>
  title?: string
}) {
  const parentDepth = useContext(DepthContext)
  const depth = parentDepth + 1
  const ref = useRef<HTMLDivElement | null>(null)
  const outsideRef = useRef(onOutside)
  outsideRef.current = onOutside
  useMobileBack(onOutside ? () => outsideRef.current?.() : null, title ?? kind ?? 'Popup')
  const anchorRef = useRef(getAnchor)
  anchorRef.current = getAnchor

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let last: Box = { left: -10000, top: -10000, width: 0, height: 0 }
    const reference = {
      getBoundingClientRect: () => {
        last = anchorRef.current() ?? last
        const { left, top, width, height } = last
        return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height }
      }
    }
    return attachFloating(
      reference,
      el,
      placement === 'beside' ? { placement: 'right-start', gap: -2, crossGap: -4, padding: 6 } : { placement: 'bottom-start', gap: 2, padding: 6 }
    )
  }, [placement])

  useEffect(() => {
    if (!onOutside) return
    const onDown = (e: PointerEvent): void => {
      if (isInsideDeeper(e.target, depth, ref.current)) return
      outsideRef.current?.()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [depth, !!onOutside])

  useEffect(() => tunerTip.hide(), [])

  useEffect(() => {
    const el = ref.current
    if (autoFocus && el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
  }, [autoFocus])

  return createPortal(
    <DepthContext.Provider value={depth}>
      <div
        ref={(el) => {
          ref.current = el
          if (surfaceRef) surfaceRef.current = el
        }}
        tabIndex={-1}
        role={role}
        data-tuner-popup-depth={depth}
        data-tuner-popup={kind}
        {...attrs}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          e.stopPropagation()
        }}
        onKeyUp={stop}
        onPointerDown={stop}
        onPointerUp={stop}
        onPointerMove={stop}
        onMouseDown={stop}
        onClick={stop}
        onDoubleClick={stop}
        onWheel={stop}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
        className={`fixed z-[70] flex flex-col overflow-hidden rounded-lg border border-white/10 bg-panel text-xs text-ink-2 shadow-2xl outline-none [-webkit-app-region:no-drag] ${placement === 'beside' ? 'animate-submenu-pop-in' : 'animate-menu-pop-in'} ${className ?? ''}`}
        style={{
          left: 0,
          top: 0,
          visibility: 'hidden',
          minWidth,
          ...style
        }}
      >
        {children}
      </div>
    </DepthContext.Provider>,
    document.body
  )
}
