import { createContext, useEffect, useRef, type CSSProperties, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { isMobileLayout, useMobileBack } from '../../lib/mobile/mobile-back'
import { TITLE_BAR_HEIGHT, WINDOW_CONTROLS_INSET, windowChromeOverride } from '../../lib/window-insets'

export const FullscreenContext = createContext(false)

const stack: symbol[] = []

let fullscreenListener: ((open: boolean) => void) | null = null

export function onFullscreenChange(cb: ((open: boolean) => void) | null): void {
  fullscreenListener = cb
}

const OVERLAY_PAD = 14

const windowChrome = (): 'mac' | 'win' | null => {
  const forced = windowChromeOverride()
  if (forced !== undefined) return forced
  if (typeof window === 'undefined' || !('api' in window) || isMobileLayout()) return null
  return /Mac/i.test(navigator.platform || navigator.userAgent) ? 'mac' : 'win'
}

const overlayInset = (chrome: 'mac' | 'win' | null): CSSProperties | undefined =>
  chrome === 'mac' ? { paddingTop: TITLE_BAR_HEIGHT } : undefined

const barInset = (chrome: 'mac' | 'win' | null): CSSProperties | undefined =>
  chrome === 'win' ? { paddingRight: WINDOW_CONTROLS_INSET - OVERLAY_PAD } : undefined

const isTyping = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

export function Fullscreen({
  kind,
  title,
  tools,
  onClose,
  bodyRef,
  children
}: {
  kind: string
  title: ReactNode
  tools?: ReactNode
  onClose: () => void
  bodyRef?: Ref<HTMLDivElement>
  children?: ReactNode
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useMobileBack(() => closeRef.current(), 'Full screen')
  useEffect(() => {
    const id = Symbol(kind)
    stack.push(id)
    if (stack.length === 1) fullscreenListener?.(true)
    const before = document.activeElement as HTMLElement | null
    if (!boxRef.current?.contains(document.activeElement)) boxRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || stack[stack.length - 1] !== id || isTyping(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      stack.splice(stack.indexOf(id), 1)
      if (!stack.length) fullscreenListener?.(false)
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [kind])
  const chrome = windowChrome()
  return createPortal(
    <div className="sr-scope rk-overlay rk-fs" data-report-overlay={kind} style={overlayInset(chrome)} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rk-ov-box" ref={boxRef} tabIndex={-1}>
        <div className="rk-ov-bar" data-chrome={chrome ?? undefined} style={barInset(chrome)}>
          <span className="rk-ov-title">{title}</span>
          {tools}
          <button type="button" className="rk-ov-close" onClick={onClose} title="Close (Esc)" aria-label="Close" data-fs-close>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="rk-ov-body" ref={bodyRef}>
          <FullscreenContext.Provider value={true}>{children}</FullscreenContext.Provider>
        </div>
      </div>
    </div>,
    document.body
  )
}

export function ExpandButton({ onClick, label = 'Full screen' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="sr-btn rk-expand" onClick={onClick} title={label} aria-label={label} data-expand>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      </svg>
    </button>
  )
}
