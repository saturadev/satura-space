import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Check, ChevronDown, PanelsTopLeft, Search } from 'lucide-react'
import type { TunerOverlayCanvas } from '@shared/tuner'
import { useFloating } from '../../lib/floating'

const FILTER_FROM = 6

export function CanvasViewPicker({
  overlays,
  current,
  onPick
}: {
  overlays: TunerOverlayCanvas[]
  current: TunerOverlayCanvas | null
  onPick: (o: TunerOverlayCanvas | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useFloating(rootRef.current, menuRef, { placement: 'bottom-start', gap: 4 }, open)

  const filtering = overlays.length >= FILTER_FROM
  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list: (TunerOverlayCanvas | null)[] = [null, ...overlays]
    return q ? list.filter((o) => (o ? `${o.name} ${o.path}` : 'scene').toLowerCase().includes(q)) : list
  }, [overlays, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    const at = current ? overlays.indexOf(current) + 1 : 0
    setCursor(Math.max(0, at))
    if (filtering) setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0)
  }, [open])

  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, items.length - 1))), [items.length])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onBlur = (): void => setOpen(false)
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector(`[data-canvas-view-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open])

  const pick = (o: TunerOverlayCanvas | null): void => {
    setOpen(false)
    onPick(o)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (items.length ? (c + 1) % items.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (items.length ? (c - 1 + items.length) % items.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = items[cursor]
      if (it !== undefined) pick(it)
    } else if (!filtering && e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase()
      const at = items.findIndex((o, i) => i > cursor && (o ? o.name : 'Scene').toLowerCase().startsWith(k))
      const first = at >= 0 ? at : items.findIndex((o) => (o ? o.name : 'Scene').toLowerCase().startsWith(k))
      if (first >= 0) setCursor(first)
    }
  }

  const label = current ? current.name : 'Scene'
  const Icon = current ? PanelsTopLeft : Box

  return (
    <div ref={rootRef} className="relative ml-1 flex shrink-0 items-center" onKeyDown={onKey} data-tuner-canvas-selector={current ? current.path : 'scene'} data-canvas-view-options={JSON.stringify(['Scene', ...overlays.map((o) => o.path)])}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`The scene view shows ${current ? `the canvas ${current.name}` : 'the scene'}`}
        data-canvas-view-button
        className={`flex h-6 w-40 items-center gap-1.5 rounded border px-2 text-[11px] transition-colors ${
          current ? 'border-sky-400/40 bg-sky-500/20 text-sky-100 hover:bg-sky-500/30' : 'border-white/10 bg-black/20 text-zinc-200 hover:bg-white/10'
        }`}
        onClick={() => setOpen((o) => !o)}
        data-ti-tip={
          current
            ? `Showing only the UI overlay canvas ${current.path}. Click to pick the scene or another canvas.`
            : 'Showing the scene. UI overlay canvases are left out, since the game draws them over the camera image. Click to view one on its own.'
        }
      >
        <Icon className={`h-3.5 w-3.5 shrink-0 ${current ? 'text-sky-300' : 'text-zinc-400'}`} />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="listbox"
          data-canvas-view-menu
          style={{ left: 0, top: 0 }}
          className="surface-overlay fixed z-40 flex max-h-80 w-64 flex-col rounded-lg py-1"
        >
          {filtering && (
            <div className="mx-1 mb-1 flex items-center gap-1.5 rounded border border-white/10 bg-black/20 px-2 py-1">
              <Search className="h-3 w-3 shrink-0 text-zinc-500" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter canvases"
                data-canvas-view-filter
                className="min-w-0 flex-1 bg-transparent text-[12px] text-zinc-100 outline-none placeholder:text-zinc-500"
              />
            </div>
          )}
          <div className="min-h-0 overflow-y-auto">
            {items.length === 0 && <div className="px-3 py-1.5 text-[12px] text-zinc-500">No canvas matches</div>}
            {items.map((o, i) => {
              const on = o === current || (!o && !current)
              const ItemIcon = o ? PanelsTopLeft : Box
              return (
                <div key={o ? `${o.scene}\n${o.path}` : 'scene'}>
                  {o && i > 0 && !items[i - 1] && <div role="separator" className="mx-1 my-1 h-px bg-white/[0.06]" />}
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    data-canvas-view-option={o ? o.path : ''}
                    data-canvas-view-index={i}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => pick(o)}
                    title={o ? o.path : 'The scene, without overlay canvases'}
                    className={`flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] ${i === cursor ? 'bg-white/10 text-white' : 'text-zinc-200'}`}
                  >
                    <ItemIcon className={`h-3.5 w-3.5 shrink-0 ${o ? 'text-sky-300/80' : 'text-zinc-400'}`} />
                    <span className="min-w-0 flex-1 truncate">{o ? o.name : 'Scene'}</span>
                    {on && <Check className="h-3.5 w-3.5 shrink-0 text-sky-300" />}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
