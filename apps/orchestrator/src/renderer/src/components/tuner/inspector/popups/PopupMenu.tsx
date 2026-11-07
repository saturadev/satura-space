import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import type { TunerMenuData, TunerMenuExtra } from '@shared/tuner-inspector-popups'
import { PopupSurface, rectBox, type AnchorGetter } from './PopupSurface'
import { buildMenuTree, edgeFocus, firstChecked, isFocusable, stepFocus, typeahead, type MenuNode } from './menu-tree'
import { isPhoneView } from '../../../../lib/tuner/view-mirror'

const TYPEAHEAD_MS = 700
const HOVER_OPEN_MS = 140

export interface PopupMenuProps {
  data: TunerMenuData
  getAnchor: AnchorGetter
  minWidth?: number
  onPick: (index: number) => void
  onCancel: () => void
  extras?: TunerMenuExtra[]
  attrs?: Record<string, string>
}

function withExtras(data: TunerMenuData, extras: TunerMenuExtra[] | undefined): TunerMenuData {
  if (!extras || extras.length === 0) return data
  const sep = data.options.length > 0 ? [''] : []
  return {
    ...data,
    options: [...data.options, ...sep, ...extras.map((e) => e.label)],
    enabled: [...data.options.map((_, i) => data.enabled[i] !== false), ...sep.map(() => false), ...extras.map(() => true)],
    separator: [...data.options.map((_, i) => data.separator[i] === true), ...sep.map(() => true), ...extras.map(() => false)]
  }
}

export function PopupMenu({ data, getAnchor, minWidth, onPick, onCancel, extras, attrs }: PopupMenuProps) {
  const merged = useMemo(() => withExtras(data, extras), [data, extras])
  const nodes = useMemo(() => buildMenuTree(merged), [merged])
  const base = data.options.length
  const extraStart = merged.options.length - (extras?.length ?? 0)
  const pick = (i: number): void => {
    if (extras && i >= extraStart && i >= base) extras[i - extraStart]?.onPick()
    else onPick(i)
  }
  return (
    <MenuPanel
      nodes={nodes}
      getAnchor={getAnchor}
      level={0}
      minWidth={minWidth}
      onPick={pick}
      onClose={onCancel}
      onCancelAll={onCancel}
      attrs={attrs}
    />
  )
}

function MenuPanel({
  nodes,
  getAnchor,
  level,
  minWidth,
  onPick,
  onClose,
  onCancelAll,
  initialFocus,
  autoFocus = true,
  attrs
}: {
  nodes: MenuNode[]
  getAnchor: AnchorGetter
  level: number
  minWidth?: number
  onPick: (index: number) => void
  onClose: () => void
  onCancelAll: () => void
  initialFocus?: 'first' | 'none'
  autoFocus?: boolean
  attrs?: Record<string, string>
}) {
  const [focus, setFocus] = useState(() => {
    if (initialFocus === 'first') return stepFocus(nodes, -1, 1)
    return level === 0 ? firstChecked(nodes) : -1
  })
  const [open, setOpen] = useState<{ index: number; keyboard: boolean } | null>(null)
  const surface = useRef<HTMLDivElement | null>(null)
  const rows = useRef(new Map<number, HTMLElement>())
  const typed = useRef({ text: '', at: 0 })
  const hoverTimer = useRef(0)

  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  useEffect(() => {
    if (focus >= 0) rows.current.get(focus)?.scrollIntoView({ block: 'nearest' })
  }, [focus])

  const activate = (i: number, keyboard: boolean): void => {
    const n = nodes[i]
    if (!n || !isFocusable(n)) return
    if (n.kind === 'submenu') {
      setFocus(i)
      setOpen({ index: i, keyboard })
      return
    }
    if (n.kind === 'item') onPick(n.index)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== surface.current) return
    const key = e.key
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault()
      setOpen(null)
      setFocus((f) => stepFocus(nodes, f, key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown') {
      e.preventDefault()
      setOpen(null)
      setFocus(edgeFocus(nodes, key === 'End' || key === 'PageDown'))
      return
    }
    if (key === 'ArrowRight') {
      e.preventDefault()
      if (focus >= 0 && nodes[focus]?.kind === 'submenu') activate(focus, true)
      return
    }
    if (key === 'Enter' || key === ' ') {
      e.preventDefault()
      if (focus >= 0) activate(focus, true)
      return
    }
    if (key === 'ArrowLeft') {
      e.preventDefault()
      if (level > 0) onClose()
      return
    }
    if (key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (level > 0) onClose()
      else onCancelAll()
      return
    }
    if (key === 'Tab') {
      e.preventDefault()
      return
    }
    if (key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      const now = performance.now()
      const t = typed.current
      t.text = now - t.at > TYPEAHEAD_MS ? key : t.text + key
      t.at = now
      const hit = typeahead(nodes, focus, t.text)
      if (hit >= 0) {
        setOpen(null)
        setFocus(hit)
      }
    }
  }

  const hover = (i: number): void => {
    setFocus(i)
    window.clearTimeout(hoverTimer.current)
    const n = nodes[i]
    if (n?.kind === 'submenu') {
      if (open?.index === i) return
      hoverTimer.current = window.setTimeout(() => setOpen({ index: i, keyboard: false }), HOVER_OPEN_MS)
    } else if (open) {
      hoverTimer.current = window.setTimeout(() => {
        setOpen(null)
        surface.current?.focus({ preventScroll: true })
      }, HOVER_OPEN_MS)
    }
  }

  const sub = open ? nodes[open.index] : undefined

  return (
    <PopupSurface
      getAnchor={getAnchor}
      placement={level === 0 ? 'anchor' : 'beside'}
      onOutside={level === 0 ? onCancelAll : undefined}
      minWidth={Math.max(140, minWidth ?? 0)}
      kind={level === 0 ? 'menu' : 'submenu'}
      role="menu"
      className="py-1"
      onKeyDown={onKeyDown}
      autoFocus={autoFocus}
      surfaceRef={surface}
      attrs={level === 0 ? attrs : undefined}
    >
      <div className="min-h-0 overflow-y-auto overscroll-contain" data-tuner-menu-level={level}>
        {nodes.map((n, i) => {
          if (n.kind === 'separator') return <div key={i} role="separator" className="mx-2 my-1 h-px bg-white/10" />
          const focused = focus === i
          const disabled = n.kind === 'item' && n.disabled
          const expanded = n.kind === 'submenu' && open?.index === i
          return (
            <div
              key={i}
              ref={(el) => {
                if (el) rows.current.set(i, el)
                else rows.current.delete(i)
              }}
              role="menuitem"
              aria-disabled={disabled || undefined}
              aria-haspopup={n.kind === 'submenu' ? 'menu' : undefined}
              aria-expanded={n.kind === 'submenu' ? expanded : undefined}
              aria-checked={n.kind === 'item' ? n.checked : undefined}
              data-menu-label={n.label}
              data-menu-index={n.kind === 'item' ? n.index : undefined}
              data-focused={focused ? '' : undefined}
              onPointerEnter={() => !disabled && hover(i)}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => !disabled && activate(i, false)}
              className={`mx-1 flex ${isPhoneView() ? 'h-11' : 'h-[22px]'} cursor-default select-none items-center gap-1.5 rounded px-1.5 ${
                disabled
                  ? 'text-ink-4'
                  : focused || expanded
                    ? 'bg-accent text-accent-fg'
                    : 'text-ink-2'
              }`}
            >
              <span className="flex w-3.5 shrink-0 justify-center">
                {n.kind === 'item' && n.checked && <Check className="h-3 w-3" strokeWidth={2.5} />}
              </span>
              <span className="min-w-0 flex-1 truncate">{n.label}</span>
              {n.kind === 'item' && n.shortcut && (
                <span className={`shrink-0 pl-3 text-[10px] tabular-nums ${focused ? 'text-accent-fg/80' : 'text-ink-4'}`}>{n.shortcut}</span>
              )}
              {n.kind === 'submenu' && <ChevronRight className={`h-3 w-3 shrink-0 ${focused || expanded ? '' : 'text-ink-4'}`} />}
            </div>
          )
        })}
        {nodes.length === 0 && <div className="px-3 py-1 text-ink-4">No items</div>}
      </div>
      {sub && sub.kind === 'submenu' && open && (
        <MenuPanel
          key={open.index}
          nodes={sub.children}
          getAnchor={() => rectBox(rows.current.get(open.index))}
          level={level + 1}
          onPick={onPick}
          onClose={() => {
            setOpen(null)
            surface.current?.focus({ preventScroll: true })
          }}
          onCancelAll={onCancelAll}
          initialFocus={open.keyboard ? 'first' : 'none'}
          autoFocus={open.keyboard}
        />
      )}
    </PopupSurface>
  )
}
