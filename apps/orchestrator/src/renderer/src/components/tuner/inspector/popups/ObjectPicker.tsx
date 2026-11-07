import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, CircleSlash, Search, X } from 'lucide-react'
import {
  OBJECT_PAGE,
  sameObjectRef,
  type TunerObjectCandidate,
  type TunerObjectData,
  type TunerObjectQuery,
  type TunerObjectQueryResult,
  type TunerObjectRef
} from '@shared/tuner-inspector-popups'
import { ingestPopupIcons, knownPopupIcons, popupIconUrl } from './popup-icons'
import { Segmented } from './controls'
import { isPhoneView } from '../../../../lib/tuner/view-mirror'
import { PendingState } from '../../../ui/PendingState'

const SEARCH_DEBOUNCE_MS = 120

export type ObjectQueryFn = (q: TunerObjectQuery) => Promise<TunerObjectQueryResult>

function refOf(c: TunerObjectCandidate): TunerObjectRef {
  const r: TunerObjectRef = {}
  if (c.guid) r.guid = c.guid
  if (c.localId !== undefined && c.localId !== '0' && c.localId !== 0) r.localId = c.localId
  if (c.path) r.path = c.path
  if (c.scenePath) r.scenePath = c.scenePath
  if (c.scene) r.scene = c.scene
  if (c.component) r.component = c.component
  return r
}

function Icon({ id }: { id?: string }) {
  const url = popupIconUrl(id)
  if (url) return <img src={url} alt="" className="h-4 w-4 shrink-0 object-contain" draggable={false} />
  return <Box className="h-3.5 w-3.5 shrink-0 text-ink-4" />
}

export interface ObjectPickerProps {
  data: TunerObjectData
  query: ObjectQueryFn
  onChange: (ref: TunerObjectRef | null) => void
  onCommit: (ref: TunerObjectRef | null) => void
  onCancel: () => void
  onSelectionChanged?: (changed: boolean) => void
  noNone?: boolean
}

export function ObjectPicker({ data, query, onChange, onCommit, onCancel, onSelectionChanged, noNone }: ObjectPickerProps) {
  const first = noNone ? 1 : 0
  const sceneCurrent = !!data.current && !data.current.guid && !data.current.path && !!data.current.scenePath
  const [scene, setScene] = useState(data.allowSceneObjects && (sceneCurrent || (!data.current && !!data.preferScene)))
  const [sceneTab, setSceneTab] = useState(data.allowSceneObjects)
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<TunerObjectCandidate[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<number | null>(data.current || noNone ? null : 0)
  const [picked, setPicked] = useState<TunerObjectRef | null>(data.current)
  const reqRef = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef(new Map<number, HTMLElement>())
  const touchPick = useRef(false)

  const load = useCallback(
    async (offset: number, s: string, sc: boolean): Promise<void> => {
      const req = ++reqRef.current
      setLoading(true)
      const r = await query({
        type: data.type,
        allowSceneObjects: data.allowSceneObjects,
        scene: sc,
        search: s,
        offset,
        limit: OBJECT_PAGE,
        known: knownPopupIcons(),
        ...(data.context ? { context: data.context } : {})
      }).catch((e: unknown) => ({ ok: false, error: String(e) }) as TunerObjectQueryResult)
      if (req !== reqRef.current) return
      setLoading(false)
      if (!r.ok) {
        setError(r.error ?? "Couldn't list objects")
        return
      }
      setError(null)
      if (r.noScene) {
        setSceneTab(false)
        setScene(false)
      }
      ingestPopupIcons(r.tex)
      setTotal(r.total ?? 0)
      setItems((prev) => (offset === 0 ? (r.items ?? []) : [...prev, ...(r.items ?? [])]))
    },
    [query, data.type, data.allowSceneObjects, data.context]
  )

  useEffect(() => {
    const t = window.setTimeout(() => void load(0, search, scene), search ? SEARCH_DEBOUNCE_MS : 0)
    return () => window.clearTimeout(t)
  }, [load, search, scene])

  useEffect(() => {
    if (sel !== null || items.length === 0) return
    const i = items.findIndex((c) => sameObjectRef(refOf(c), picked))
    if (i >= 0) setSel(i + 1)
  }, [items, sel, picked])

  useEffect(() => {
    if (sel !== null) rowRefs.current.get(sel)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const refAt = (i: number): TunerObjectRef | null => (i <= 0 ? null : refOf(items[i - 1]))

  const choose = (i: number): void => {
    if (i < first || i > items.length) return
    setSel(i)
    const r = refAt(i)
    setPicked(r)
    onChange(r)
    onSelectionChanged?.(!sameObjectRef(r, data.current))
  }

  const onScroll = (): void => {
    const el = listRef.current
    if (!el || loading || items.length >= total) return
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 80) void load(items.length, search, scene)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const count = items.length + 1
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const cur = sel ?? first - 1
      choose(Math.max(first, Math.min(count - 1, cur + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault()
      const cur = sel ?? first - 1
      choose(Math.max(first, Math.min(count - 1, cur + (e.key === 'PageDown' ? 10 : -10))))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const at = (sel === 0 || sel === null) && (search.trim() || noNone) && items.length > 0 ? 1 : sel
      onCommit(at === null ? picked : refAt(at))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Tab' && sceneTab) {
      e.preventDefault()
      setScene((v) => !v)
      setSel(null)
    }
  }

  const selected = sel !== null && sel > 0 ? items[sel - 1] : null
  const tabs = useMemo(
    () => [
      { value: 'assets', label: 'Assets' },
      { value: 'scene', label: 'Scene' }
    ],
    []
  )

  return (
    <div tabIndex={-1} data-popup-focus className="flex h-[400px] w-[340px] flex-col outline-none" data-object-picker onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 border-b border-white/5 px-2.5 pt-2.5 pb-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-ink">Select {data.typeName}</span>
        {sceneTab && (
          <div className="w-[120px]">
            <Segmented
              name="object-tab"
              value={scene ? 'scene' : 'assets'}
              onChange={(v) => {
                setScene(v === 'scene')
                setSel(null)
                inputRef.current?.focus()
              }}
              options={tabs}
            />
          </div>
        )}
      </div>
      <div className="px-2.5 py-2">
        <div className="flex h-6 items-center gap-1.5 rounded border border-white/10 bg-sunken px-1.5 focus-within:border-accent">
          <Search className="h-3 w-3 shrink-0 text-ink-4" />
          <input
            ref={inputRef}
            autoFocus
            aria-label="Search"
            data-object-search
            spellCheck={false}
            value={search}
            placeholder={`Search ${scene ? 'the scene' : 'assets'}`}
            onChange={(e) => {
              setSearch(e.target.value)
              setSel(null)
            }}
            className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-4"
          />
          {search && (
            <button type="button" tabIndex={-1} onClick={() => setSearch('')} className="text-ink-4 hover:text-ink">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1" role="listbox" data-object-list>
        {[null, ...items].map((c, i) => {
          if (i < first) return null
          const active = sel === i
          return (
            <div
              key={c ? `${c.guid ?? ''}:${c.localId ?? ''}:${c.scenePath ?? ''}:${c.component ?? ''}:${i}` : 'none'}
              ref={(el) => {
                if (el) rowRefs.current.set(i, el)
                else rowRefs.current.delete(i)
              }}
              role="option"
              aria-selected={active}
              data-object-name={c ? c.name : 'None'}
              data-object-path={c ? (c.path ?? c.scenePath) : undefined}
              onPointerDown={(e) => {
                e.preventDefault()
                touchPick.current = e.pointerType === 'touch'
              }}
              onClick={() => {
                choose(i)
                if (touchPick.current) onCommit(refAt(i))
              }}
              onDoubleClick={() => onCommit(refAt(i))}
              className={`flex ${isPhoneView() ? 'h-11' : 'h-[22px]'} cursor-default select-none items-center gap-1.5 rounded px-1.5 ${
                active ? 'bg-accent text-accent-fg' : 'text-ink-2 hover:bg-white/5'
              }`}
            >
              {c ? <Icon id={c.icon} /> : <CircleSlash className={`h-3.5 w-3.5 shrink-0 ${active ? '' : 'text-ink-4'}`} />}
              <span className="min-w-0 max-w-[65%] shrink-0 truncate">{c ? c.name : 'None'}</span>
              {c && (
                <span className={`ml-auto min-w-0 truncate pl-2 text-[10px] ${active ? 'text-accent-fg/75' : 'text-ink-4'}`}>
                  {c.path ?? c.scenePath ?? ''}
                </span>
              )}
            </div>
          )
        })}
        {!loading && items.length === 0 && !error && (
          <div className="px-2 py-3 text-center text-[11px] text-ink-4">{search ? 'No matches' : scene ? `No ${data.typeName} objects in the open scenes` : `No ${data.typeName} assets`}</div>
        )}
        {loading && <PendingState tag="object picker" label={items.length ? 'Loading more…' : 'Loading the list…'} className="py-2" />}
        {error && <div className="px-2 py-2 text-[11px] text-amber-400">{error}</div>}
      </div>
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-t border-white/5 px-2.5 text-[10px] text-ink-3">
        {selected ? (
          <>
            <Icon id={selected.icon} />
            <span className="min-w-0 truncate text-ink-2">{selected.name}</span>
            <span className="ml-auto shrink-0 text-ink-4">{selected.typeName}</span>
          </>
        ) : (
          <span className="text-ink-4">{sel === 0 ? 'None' : `${total} ${total === 1 ? 'item' : 'items'}`}</span>
        )}
      </div>
    </div>
  )
}
