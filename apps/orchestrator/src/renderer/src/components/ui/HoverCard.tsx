import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy } from 'lucide-react'
import { arrow as arrowMiddleware, autoUpdate, computePosition, flip, offset, shift, size } from '../../lib/floating-ui/dom/index'
import type { Placement } from '../../lib/floating-ui/utils/index'
import { driftDriving } from '../../lib/drift-driving'
import { writeClipboard } from '../../lib/clipboard'

export type HoverPlacement = Placement

const MARGIN = 8
const ARROW = 10
const WARM_DELAY = 60

export interface HoverCardTarget<K> {
  key: K
  el: HTMLElement
}

export interface HoverBindProps {
  onPointerEnter: (e: PointerEvent<HTMLElement>) => void
  onPointerLeave: (e: PointerEvent<HTMLElement>) => void
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
  onFocus: (e: FocusEvent<HTMLElement>) => void
  onBlur: (e: FocusEvent<HTMLElement>) => void
}

export interface HoverCardState<K> {
  target: HoverCardTarget<K> | null
  close: () => void
  bind: (key: K) => HoverBindProps
  floatingProps: { onPointerEnter: () => void; onPointerLeave: () => void }
}

const stop = (e: { stopPropagation: () => void }): void => e.stopPropagation()

const within = (e: { currentTarget: HTMLElement; target: EventTarget }): boolean =>
  e.target instanceof Node && e.currentTarget.contains(e.target)

export function useHoverCard<K = string>({
  openDelay = 500,
  closeDelay = 160,
  disabled = false
}: { openDelay?: number; closeDelay?: number; disabled?: boolean } = {}): HoverCardState<K> {
  const [target, setTarget] = useState<HoverCardTarget<K> | null>(null)
  const current = useRef(target)
  current.current = target
  const timer = useRef<number | undefined>(undefined)
  const blocked = useRef<{ key: K } | null>(null)
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled

  const clear = useCallback(() => window.clearTimeout(timer.current), [])
  const close = useCallback(() => {
    window.clearTimeout(timer.current)
    setTarget(null)
  }, [])

  const show = useCallback(
    (key: K, el: HTMLElement) => {
      window.clearTimeout(timer.current)
      if (disabledRef.current || driftDriving()) return
      if (blocked.current && Object.is(blocked.current.key, key)) return
      const cur = current.current
      if (cur && Object.is(cur.key, key) && cur.el === el) return
      timer.current = window.setTimeout(
        () => {
          if (!el.isConnected || disabledRef.current || driftDriving()) return
          setTarget({ key, el })
        },
        cur ? WARM_DELAY : openDelay
      )
    },
    [openDelay]
  )

  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    if (!current.current) return
    timer.current = window.setTimeout(() => setTarget(null), closeDelay)
  }, [closeDelay])

  useEffect(() => {
    if (disabled) close()
  }, [disabled, close])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      blocked.current = { key: target.key }
      close()
    }
    const onBlur = (): void => close()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [target, close])

  const bind = useCallback(
    (key: K): HoverBindProps => ({
      onPointerEnter: (e) => {
        if (e.pointerType === 'touch' || e.buttons !== 0) return
        show(key, e.currentTarget)
      },
      onPointerLeave: () => {
        if (blocked.current && Object.is(blocked.current.key, key)) blocked.current = null
        hide()
      },
      onPointerDown: (e) => {
        if (!within(e)) return
        blocked.current = { key }
        close()
      },
      onFocus: (e) => {
        if (!within(e) || !e.currentTarget.matches(':focus-visible')) return
        show(key, e.currentTarget)
      },
      onBlur: (e) => {
        if (within(e)) hide()
      }
    }),
    [show, hide, close]
  )

  return { target, close, bind, floatingProps: { onPointerEnter: clear, onPointerLeave: hide } }
}

const ARROW_EDGES: Record<string, { side: 'top' | 'bottom' | 'left' | 'right'; borders: CSSProperties }> = {
  bottom: { side: 'top', borders: { borderTopWidth: 1, borderLeftWidth: 1 } },
  top: { side: 'bottom', borders: { borderBottomWidth: 1, borderRightWidth: 1 } },
  right: { side: 'left', borders: { borderBottomWidth: 1, borderLeftWidth: 1 } },
  left: { side: 'right', borders: { borderTopWidth: 1, borderRightWidth: 1 } }
}

export function HoverCardLayer({
  anchor,
  placement = 'bottom',
  arrow = true,
  gap = 8,
  onDismiss,
  floatingProps,
  className = '',
  style,
  label,
  children
}: {
  anchor: HTMLElement
  placement?: HoverPlacement
  arrow?: boolean
  gap?: number
  onDismiss?: () => void
  floatingProps?: { onPointerEnter: () => void; onPointerLeave: () => void }
  className?: string
  style?: CSSProperties
  label?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const arrowRef = useRef<HTMLDivElement>(null)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let alive = true
    const update = (): void => {
      if (!anchor.isConnected) {
        dismiss.current?.()
        return
      }
      const middleware = [
        offset(gap + (arrow ? ARROW / 2 - 1 : 0)),
        flip({ padding: MARGIN }),
        shift({ padding: MARGIN }),
        size({
          padding: MARGIN,
          apply({ availableHeight, elements }) {
            const body = elements.floating.firstElementChild as HTMLElement | null
            if (body) body.style.maxHeight = `${Math.max(0, Math.floor(availableHeight))}px`
          }
        })
      ]
      if (arrow && arrowRef.current) middleware.push(arrowMiddleware({ element: arrowRef.current, padding: 10 }))
      void computePosition(anchor, el, { strategy: 'fixed', placement, middleware }).then((res) => {
        if (!alive) return
        el.style.left = `${res.x}px`
        el.style.top = `${res.y}px`
        el.style.visibility = 'visible'
        const side = res.placement.split('-')[0]
        el.dataset.side = side
        const a = arrowRef.current
        const data = res.middlewareData.arrow
        if (!a || !data) return
        const edge = ARROW_EDGES[side] ?? ARROW_EDGES.bottom
        Object.assign(a.style, {
          left: data.x != null ? `${data.x}px` : '',
          top: data.y != null ? `${data.y}px` : '',
          right: '',
          bottom: '',
          borderWidth: '0',
          [edge.side]: `${-ARROW / 2 - 1}px`,
          ...Object.fromEntries(Object.entries(edge.borders).map(([k, v]) => [k, `${v}px`]))
        })
      })
    }
    const stop = autoUpdate(anchor, el, update)
    return () => {
      alive = false
      stop()
    }
  }, [anchor, placement, gap, arrow])

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      aria-label={label}
      data-hover-card
      onPointerEnter={floatingProps?.onPointerEnter}
      onPointerLeave={floatingProps?.onPointerLeave}
      onClick={stop}
      onDoubleClick={stop}
      onPointerDown={stop}
      onMouseDown={stop}
      onContextMenu={stop}
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        zIndex: 200,
        visibility: 'hidden',
        maxWidth: `min(380px, calc(100vw - ${MARGIN * 2}px))`,
        ...style
      }}
      className={`hover-card surface-overlay rounded-[var(--radius-menu)] text-[12px] leading-[1.45] text-ink ${className}`}
    >
      <div className="hover-card-body max-h-[calc(100vh-16px)] overflow-y-auto overscroll-contain">{children}</div>
      {arrow && (
        <div
          ref={arrowRef}
          aria-hidden
          className="hover-card-arrow pointer-events-none absolute"
          style={{ width: ARROW, height: ARROW }}
        />
      )}
    </div>,
    document.body
  )
}

export function HoverCard({
  content,
  children,
  placement = 'bottom',
  arrow = true,
  openDelay,
  disabled,
  className = 'inline-flex',
  label,
  attrs,
  layerClassName
}: {
  attrs?: Record<string, string | undefined>
  layerClassName?: string
  content: ReactNode | (() => ReactNode)
  children: ReactNode
  placement?: HoverPlacement
  arrow?: boolean
  openDelay?: number
  disabled?: boolean
  className?: string
  label?: string
}) {
  const hc = useHoverCard<true>({ openDelay, disabled })
  return (
    <>
      <span {...attrs} className={className} {...hc.bind(true)}>
        {children}
      </span>
      {hc.target && (
        <HoverCardLayer anchor={hc.target.el} placement={placement} arrow={arrow} onDismiss={hc.close} floatingProps={hc.floatingProps} label={label} className={layerClassName}>
          {typeof content === 'function' ? content() : content}
        </HoverCardLayer>
      )}
    </>
  )
}

export function CardHeader({ icon, title, aside, sub }: { icon?: ReactNode; title: ReactNode; aside?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="px-3 pb-2 pt-2.5">
      <div className="flex min-w-0 items-center gap-2">
        {icon && <span className="flex shrink-0 items-center text-ink-2">{icon}</span>}
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink" data-hover-title>
          {title}
        </span>
        {aside && <span className="flex shrink-0 items-center gap-1">{aside}</span>}
      </div>
      {sub && <div className="mt-0.5 text-[11.5px] text-ink-2">{sub}</div>}
    </div>
  )
}

export function CardRows({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-t border-white/[0.07] px-3 py-2">
      {children}
    </div>
  )
}

export function CardRow({
  label,
  children,
  mono,
  full,
  tone,
  nowrap
}: {
  label: string
  children: ReactNode
  mono?: boolean
  nowrap?: boolean
  full?: string
  tone?: 'ink' | 'ink-2'
}) {
  return (
    <>
      <span className="whitespace-nowrap text-[11px] text-ink-3" data-hover-label>
        {label}
      </span>
      <span
        className={`min-w-0 ${nowrap ? 'truncate' : 'break-words'} ${mono ? 'font-mono text-[11px] [overflow-wrap:anywhere]' : ''} ${tone === 'ink-2' ? 'text-ink-2' : 'text-ink'}`}
        data-hover-value={label}
        data-hover-full={full}
      >
        {children}
      </span>
    </>
  )
}

export function CardFooter({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-1 border-t border-white/[0.07] px-1.5 py-1">{children}</div>
}

export function CardAction({ onClick, children, icon }: { onClick: () => void; children: ReactNode; icon?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-6 items-center gap-1.5 rounded px-1.5 text-[11.5px] text-ink-2 hover:bg-white/[0.07] hover:text-ink"
    >
      {icon}
      {children}
    </button>
  )
}

export function CopyAction({ text, children = 'Copy path' }: { text: string; children?: ReactNode }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => setDone(false), 1200)
    return () => window.clearTimeout(t)
  }, [done])
  return (
    <CardAction
      icon={done ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.75} />}
      onClick={() => {
        void writeClipboard(text).then(() => setDone(true), () => undefined)
      }}
    >
      <span data-hover-copy={text}>{done ? 'Copied' : children}</span>
    </CardAction>
  )
}
