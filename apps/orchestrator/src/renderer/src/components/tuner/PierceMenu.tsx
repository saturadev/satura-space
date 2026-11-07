import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Box } from 'lucide-react'
import type { TunerPickHit } from '@shared/tuner-sceneview'
import { FloatingMenu, menuItemClass } from '../ui/FloatingMenu'
import { pathHint } from '../../lib/tuner/pierce'
import { PIERCE_RING, placePiercePopover, swallowNextClick } from '../../lib/tuner/pierce-popover'
import { installTunerTips } from '../../lib/tuner/inspector/tooltip'
import { isMobileLayout, useMobileBack } from '../../lib/mobile/mobile-back'

const PENDING_SHOW_MS = 250

function stop(e: React.SyntheticEvent): void {
  e.stopPropagation()
}

export function PierceMenu({
  x,
  y,
  hits,
  icons,
  pending,
  onPick,
  onDismiss
}: {
  x: number
  y: number
  hits: TunerPickHit[]
  icons: Record<string, string>
  pending: boolean
  onPick: (hit: TunerPickHit) => void
  onDismiss: () => void
}) {
  const [cursor, setCursor] = useState(0)
  const [keyed, setKeyed] = useState(false)
  const [touch] = useState(isMobileLayout)
  const [late, setLate] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const placedRef = useRef('')
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useMobileBack(onDismiss, 'Objects here')
  useEffect(() => {
    if (!touch || !pending) return
    const t = window.setTimeout(() => setLate(true), PENDING_SHOW_MS)
    return () => window.clearTimeout(t)
  }, [touch, pending])
  useEffect(() => setCursor(0), [hits])
  useEffect(() => installTunerTips(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onDismiss()
        return
      }
      if (hits.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setKeyed(true)
        setCursor((c) => (c + 1) % hits.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setKeyed(true)
        setCursor((c) => (c - 1 + hits.length) % hits.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const hit = hits[cursor]
        if (hit) {
          onPick(hit)
          onDismiss()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hits, cursor, onPick, onDismiss])

  useEffect(() => {
    const outside = (e: Event): void => {
      const t = e.target as Node | null
      if (t && rootRef.current?.contains(t)) return
      if (touch && e instanceof PointerEvent && e.pointerType === 'touch') {
        e.stopPropagation()
        swallowNextClick()
        console.info('[tuner] pierce popover closed by a tap outside it, the tap went no further')
      }
      onDismiss()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape') return
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return
      onDismiss()
    }
    const onBlur = (): void => onDismiss()
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('wheel', outside, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('wheel', outside, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [onDismiss, touch])

  useLayoutEffect(() => {
    if (!touch) return
    let alive = true
    let width = window.innerWidth
    const place = (): void => {
      const el = popRef.current
      const list = listRef.current
      const tip = tipRef.current
      if (!el || !list || !tip) return
      void placePiercePopover(x, y, el, list, tip).then((p) => {
        if (!alive) return
        const r = p.rect
        const b = p.bounds
        const text = `${p.side} at ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} for the touch at ${Math.round(x)},${Math.round(y)}, ${hits.length} row(s)${p.scrolls ? ' that scroll' : ''}, ${p.inside ? 'inside' : 'OUTSIDE'} ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}, ${p.clear ? 'clear of' : 'OVER'} the finger`
        if (text === placedRef.current) return
        placedRef.current = text
        console.info(`[tuner] pierce popover ${text}`)
      })
    }
    place()
    const onResize = (): void => {
      if (window.innerWidth !== width) {
        width = window.innerWidth
        console.info('[tuner] pierce popover closed: the phone turned')
        dismissRef.current()
        return
      }
      place()
    }
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      alive = false
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [touch, x, y, hits, pending, late])

  if (touch) {
    const title = pending && hits.length === 0 ? 'Finding objects…' : hits.length === 0 ? 'Nothing here' : `${hits.length} ${hits.length === 1 ? 'object' : 'objects'} here`
    return createPortal(
      <div
        ref={rootRef}
        data-viewport-ui
        data-pierce-menu
        data-pierce-touch
        onPointerDown={stop}
        onPointerMove={stop}
        onPointerUp={stop}
        onClick={stop}
        onDoubleClick={stop}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <span data-pierce-marker aria-hidden style={{ left: x - PIERCE_RING / 2, top: y - PIERCE_RING / 2, width: PIERCE_RING, height: PIERCE_RING }} />
        {(!pending || late || hits.length > 0) && (
          <div ref={popRef} role="menu" aria-label={title} data-pierce-popover data-menu-layer style={{ left: 0, top: 0, visibility: 'hidden' }}>
            <div data-pierce-head>{title}</div>
            {hits.length > 0 && (
              <div ref={listRef} data-pierce-list>
                {hits.map((hit, i) => {
                  const icon = icons[hit.icon]
                  const hint = pathHint(hit)
                  return (
                    <button
                      key={`${hit.scene}|${hit.path}`}
                      type="button"
                      role="menuitem"
                      data-pierce-item={hit.path}
                      data-cursor={keyed && i === cursor ? '' : undefined}
                      tabIndex={-1}
                      onClick={() => {
                        console.info(`[tuner] pierce popover picked ${hit.path}`)
                        onPick(hit)
                        onDismiss()
                      }}
                    >
                      {icon ? <img src={icon} alt="" draggable={false} /> : <Box />}
                      <span data-pierce-text>
                        <span data-pierce-name>{hit.name}</span>
                        {hint && <span data-pierce-hint>{hint}</span>}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            {hits.length === 0 && <div ref={listRef} data-pierce-list data-pierce-empty />}
            <div ref={tipRef} data-pierce-arrow aria-hidden />
          </div>
        )}
      </div>,
      document.body
    )
  }

  return createPortal(
    <div ref={rootRef} data-viewport-ui data-pierce-menu onPointerDown={stop} onPointerMove={stop} onPointerUp={stop} onDoubleClick={stop}>
      <FloatingMenu x={x} y={y} onDismiss={onDismiss} className="max-w-80">
        {pending && hits.length === 0 && <div className="px-3 py-1.5 text-sm text-zinc-500">Finding objects…</div>}
        {!pending && hits.length === 0 && <div className="px-3 py-1.5 text-sm text-zinc-500">Nothing under the pointer</div>}
        {hits.map((hit, i) => {
          const icon = icons[hit.icon]
          const hint = pathHint(hit)
          return (
            <button
              key={`${hit.scene}|${hit.path}`}
              data-pierce-item={hit.path}
              data-ti-tip={hit.scene ? `${hit.scene}: ${hit.path}` : hit.path}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setCursor(i)}
              onClick={() => {
                onPick(hit)
                onDismiss()
              }}
              className={`${menuItemClass} ${i === cursor ? 'bg-white/10 text-white' : ''}`}
            >
              {icon ? (
                <img src={icon} alt="" draggable={false} className="h-4 w-4 shrink-0 object-contain" />
              ) : (
                <Box className="h-4 w-4 shrink-0 text-zinc-500" />
              )}
              <span className="shrink-0 truncate">{hit.name}</span>
              {hint && <span className="min-w-0 truncate text-xs text-zinc-500">{hint}</span>}
            </button>
          )
        })}
      </FloatingMenu>
    </div>,
    document.body
  )
}
