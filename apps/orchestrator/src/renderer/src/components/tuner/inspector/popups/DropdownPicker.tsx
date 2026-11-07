import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Info, Search, X } from 'lucide-react'
import type { TunerDropdownData, TunerDropdownItem } from '@shared/tuner-inspector-popups'
import { isGroup, searchDropdown, stepSelectable, type DropdownHit } from './dropdown-tree'
import { ingestPopupIcons, popupIconUrl } from './popup-icons'
import { useFocusOnMount } from './controls'
import { isPhoneView } from '../../../../lib/tuner/view-mirror'

interface Row {
  item: TunerDropdownItem
  path?: string[]
}

function Icon({ id }: { id?: string }) {
  const url = popupIconUrl(id)
  return url ? <img src={url} alt="" className="h-4 w-4 shrink-0 object-contain" draggable={false} /> : <span className="w-4 shrink-0" />
}

export interface DropdownPickerProps {
  data: TunerDropdownData
  minWidth?: number
  onPick: (id: number) => void
  onCancel: () => void
}

export function DropdownPicker({ data, minWidth, onPick, onCancel }: DropdownPickerProps) {
  useMemo(() => ingestPopupIcons(data.tex), [data.tex])
  const [stack, setStack] = useState<TunerDropdownItem[]>([])
  const [search, setSearch] = useState('')
  const [focus, setFocus] = useState(0)
  const rowRefs = useRef(new Map<number, HTMLElement>())
  const inputRef = useRef<HTMLInputElement>(null)
  const searchable = data.search !== false
  const rootRef = useRef<HTMLDivElement>(null)
  useFocusOnMount(searchable ? inputRef : rootRef)
  const hasIcons = useMemo(() => {
    const any = (items: TunerDropdownItem[]): boolean => items.some((i) => !!i.icon || (i.ch ? any(i.ch) : false))
    return any(data.items)
  }, [data.items])

  const searching = searchable && search.trim().length > 0
  const hits: DropdownHit[] = useMemo(() => (searching ? searchDropdown(data.items, search) : []), [searching, data.items, search])
  const level = stack.length > 0 ? (stack[stack.length - 1].ch ?? []) : data.items
  const rows: Row[] = searching ? hits.map((h) => ({ item: h.item, path: h.path })) : level.map((item) => ({ item }))
  const title = searching ? 'Search' : stack.length > 0 ? stack[stack.length - 1].name : data.title

  useEffect(() => {
    setFocus(stepSelectable(rows.map((r) => r.item), -1, 1))
  }, [searching, search, stack.length])

  useEffect(() => {
    rowRefs.current.get(focus)?.scrollIntoView({ block: 'nearest' })
  }, [focus])

  const enter = (item: TunerDropdownItem): void => {
    setStack((s) => [...s, item])
    setSearch('')
  }

  const back = (): void => {
    if (stack.length > 0) setStack((s) => s.slice(0, -1))
  }

  const activate = (row: Row | undefined): void => {
    if (!row || row.item.sep || row.item.help) return
    if (isGroup(row.item)) {
      enter(row.item)
      return
    }
    if (row.item.off) return
    onPick(row.item.id)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const items = rows.map((r) => r.item)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setFocus((f) => stepSelectable(items, f, e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(rows[focus])
    } else if (e.key === 'ArrowRight') {
      const row = rows[focus]
      if (row && isGroup(row.item) && (!searching || (inputRef.current?.selectionStart ?? 0) >= search.length)) {
        e.preventDefault()
        enter(row.item)
      }
    } else if (e.key === 'ArrowLeft') {
      if (!searching && stack.length > 0) {
        e.preventDefault()
        back()
      }
    } else if (e.key === 'Backspace') {
      if (!search && stack.length > 0) {
        e.preventDefault()
        back()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  const width = Math.max(minWidth ?? 0, data.width ?? 260)
  const height = Math.max(200, Math.min(520, data.height ?? 320))

  return (
    <div ref={rootRef} tabIndex={-1} data-popup-focus className="flex flex-col outline-none" style={{ width, height }} data-dropdown-picker onKeyDown={onKeyDown}>
      {searchable && (
        <div className="px-2 pt-2">
          <div className="flex h-6 items-center gap-1.5 rounded border border-white/10 bg-sunken px-1.5 focus-within:border-accent">
            <Search className="h-3 w-3 shrink-0 text-ink-4" />
            <input
              ref={inputRef}
              autoFocus
              aria-label="Search"
              data-dropdown-search
              spellCheck={false}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-4"
              placeholder="Search"
            />
            {search && (
              <button type="button" tabIndex={-1} onClick={() => setSearch('')} className="text-ink-4 hover:text-ink">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}
      <div className="mt-1.5 flex h-6 shrink-0 items-center border-b border-white/5 px-1">
        {!searching && stack.length > 0 ? (
          <button
            type="button"
            tabIndex={-1}
            data-dropdown-back
            onPointerDown={(e) => e.preventDefault()}
            onClick={back}
            className="flex h-5 w-5 items-center justify-center rounded text-ink-3 hover:bg-white/10 hover:text-ink"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        ) : (
          <span className="w-5" />
        )}
        <span className="min-w-0 flex-1 truncate text-center text-[11px] font-semibold text-ink" data-dropdown-title>
          {title}
        </span>
        <span className="w-5" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1" role="listbox">
        {rows.map((row, i) => {
          const it = row.item
          if (it.sep) return <div key={i} className="mx-1 my-1 h-px bg-white/10" />
          if (it.help)
            return (
              <div key={i} className="mx-1 my-1 flex gap-1.5 rounded bg-elevated px-1.5 py-1 text-[10px] text-ink-3">
                <Info className="mt-px h-3 w-3 shrink-0 text-sky-400" />
                <span>{it.name}</span>
              </div>
            )
          const active = focus === i
          const group = isGroup(it)
          return (
            <div
              key={`${it.id}:${i}`}
              ref={(el) => {
                if (el) rowRefs.current.set(i, el)
                else rowRefs.current.delete(i)
              }}
              role="option"
              aria-selected={active}
              aria-disabled={it.off ? true : undefined}
              data-ti-tip={it.tip || undefined}
              data-dropdown-item={it.name}
              data-dropdown-group={group ? '' : undefined}
              onPointerEnter={() => setFocus(i)}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => activate(row)}
              className={`flex ${isPhoneView() ? 'h-11' : 'h-[22px]'} cursor-default select-none items-center gap-1.5 rounded px-1.5 ${
                it.off ? 'text-ink-4' : active ? 'bg-accent text-accent-fg' : 'text-ink-2'
              }`}
            >
              {hasIcons && <Icon id={it.icon} />}
              <span className="min-w-0 truncate">{it.name}</span>
              {row.path && row.path.length > 0 && (
                <span className={`ml-auto min-w-0 truncate pl-2 text-[10px] ${active ? 'text-accent-fg/75' : 'text-ink-4'}`}>{row.path.join(' › ')}</span>
              )}
              {group && <ChevronRight className={`ml-auto h-3 w-3 shrink-0 ${active ? '' : 'text-ink-4'}`} />}
            </div>
          )
        })}
        {rows.length === 0 && <div className="px-2 py-3 text-center text-[11px] text-ink-4">{searching ? 'No matches' : 'Empty'}</div>}
      </div>
    </div>
  )
}
