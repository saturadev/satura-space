import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { driftDriving, useDriftDriving } from '../../lib/drift-driving'
import { useFloating } from '../../lib/floating'

export function FloatingHint({
  x = 0,
  y = 0,
  anchor,
  text,
  above,
  tip
}: {
  x?: number
  y?: number
  anchor?: Element | null
  text: string
  above?: boolean
  tip?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useFloating(anchor ?? { x, y }, ref, { placement: above ? 'top' : 'bottom', gap: anchor ? 4 : 0, fitHeight: false, origin: false })

  return createPortal(
    <div
      ref={ref}
      data-hover-tip={tip ? '' : undefined}
      style={{ left: 0, top: 0, maxWidth: 'calc(100vw - 16px)' }}
      className="surface-overlay-sm pointer-events-none fixed z-[200] overflow-hidden text-ellipsis whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-ink"
    >
      {text}
    </div>,
    document.body
  )
}

export function Tooltip({
  label,
  children,
  delay = 350,
  className
}: {
  label: string
  children: ReactNode
  delay?: number
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const driving = useDriftDriving()

  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    setOpen(false)
  }, [])

  const show = useCallback(() => {
    window.clearTimeout(timer.current)
    if (driftDriving()) return
    timer.current = window.setTimeout(() => {
      if (driftDriving() || !ref.current) return
      setOpen(true)
    }, delay)
  }, [delay])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <span ref={ref} className={className ?? 'inline-flex'} onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide}>
      {children}
      {open && label && !driving && <FloatingHint anchor={ref.current} text={label} tip />}
    </span>
  )
}

export function useFlashHint(duration = 1200): {
  hint: ReactNode
  flash: (text: string, x: number, y: number) => void
} {
  const [state, setState] = useState<{ text: string; x: number; y: number; id: number } | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const flash = useCallback(
    (text: string, x: number, y: number) => {
      window.clearTimeout(timer.current)
      setState({ text, x, y, id: Date.now() })
      timer.current = window.setTimeout(() => setState(null), duration)
    },
    [duration]
  )

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return {
    hint: state ? <FloatingHint key={state.id} x={state.x} y={state.y - 6} text={state.text} above /> : null,
    flash
  }
}

function shorten(text: string): string {
  return text.length > 64 ? `${text.slice(0, 28)}…${text.slice(-32)}` : text
}

export function useCopyHint(): {
  hint: ReactNode
  copy: (text: string, x: number, y: number) => void
} {
  const { hint, flash } = useFlashHint()
  const copy = useCallback(
    (text: string, x: number, y: number) => {
      void navigator.clipboard.writeText(text).then(
        () => flash(`Copied ${shorten(text)}`, x, y),
        () => flash('Copy failed', x, y)
      )
    },
    [flash]
  )
  return { hint, copy }
}
