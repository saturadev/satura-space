import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { lineScale } from './zoom-pan'

type Props = {
  kind: 'scroll' | 'control'
  children: ReactNode
  className?: string
  style?: CSSProperties
}

export function Activatable({ kind, children, className = '', style }: Props) {
  if (kind === 'scroll') {
    return (
      <div className={`rk-act ${className}`} style={style} data-act="scroll">
        {children}
      </div>
    )
  }
  return <Control className={className} style={style}>{children}</Control>
}

function Control({ children, className, style }: Omit<Props, 'kind'>) {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)
  const activeRef = useRef(false)
  activeRef.current = active

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let pointerAt = 0
    const set = (on: boolean): void => {
      activeRef.current = on
      setActive(on)
    }
    const deactivate = (): void => {
      if (!activeRef.current) return
      set(false)
      const focused = document.activeElement as HTMLElement | null
      if (focused && el.contains(focused)) focused.blur()
    }
    const onWheel = (e: WheelEvent): void => {
      if (activeRef.current) return
      if (!e.ctrlKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) return
      e.stopPropagation()
      e.preventDefault()
      if (e.ctrlKey) return
      const host = el.closest('.rk-host, .rk-ov-scroll') as HTMLElement | null
      host?.scrollBy({ top: e.deltaY * lineScale(e), left: 0 })
    }
    const onGesture = (e: Event): void => {
      if (activeRef.current) return
      e.stopPropagation()
      e.preventDefault()
    }
    const onDown = (e: PointerEvent): void => {
      pointerAt = performance.now()
      if (e.button === 0 && !activeRef.current) set(true)
    }
    const onFocusIn = (): void => {
      if (performance.now() - pointerAt > 400) set(true)
    }
    const onFocusOut = (e: FocusEvent): void => {
      const next = e.relatedTarget as Node | null
      if (!next || !el.contains(next)) {
        if (!el.matches(':hover')) deactivate()
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && activeRef.current) {
        e.stopPropagation()
        deactivate()
      }
    }
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    el.addEventListener('gesturestart', onGesture, true)
    el.addEventListener('gesturechange', onGesture, true)
    el.addEventListener('pointerdown', onDown, true)
    el.addEventListener('pointerleave', deactivate)
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)
    el.addEventListener('keydown', onKey, true)
    return () => {
      el.removeEventListener('wheel', onWheel, { capture: true })
      el.removeEventListener('gesturestart', onGesture, true)
      el.removeEventListener('gesturechange', onGesture, true)
      el.removeEventListener('pointerdown', onDown, true)
      el.removeEventListener('pointerleave', deactivate)
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
      el.removeEventListener('keydown', onKey, true)
    }
  }, [])

  return (
    <div ref={ref} className={`rk-act ${className}`} style={style} data-act="control" data-active={active ? '' : undefined}>
      {children}
    </div>
  )
}
