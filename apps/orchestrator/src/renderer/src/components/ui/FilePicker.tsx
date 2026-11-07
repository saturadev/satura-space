import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  Eye,
  EyeOff,
  FileText,
  FolderPlus,
  HardDrive,
  House,
  Monitor,
  X,
  type LucideIcon
} from 'lucide-react'
import {
  addPostfix,
  basenameOf,
  bestMatchIndex,
  displayPath,
  endsWithSep,
  equalsIgnoreCase,
  filterEntries,
  formatSize,
  normalizePath,
  parentOf,
  pathSegments,
  planInput,
  resolveInput,
  sortEntries,
  startsWithIgnoreCase,
  tabComplete,
  toNativeSeparators,
  validatePick,
  type PickerEntry,
  type PickerPlace,
  type PickerPlaces,
  type PickerSortKey,
  type TabCycle
} from '@shared/file-picker'
import { pickerMemory, rememberPicker, useFilePickerStore, type PickOptions } from '../../lib/file-picker/file-picker-store'
import { requestConfirm, useConfirmStore } from '../../lib/confirm/confirm-store'
import { formatDateTime } from '../../lib/date-time'
import { IS_MAC } from '../../lib/shortcuts/shortcuts'
import { pathBasename } from '../../lib/path'
import { ExplorerIcon } from '../workbench/explorer-icons'
import { Select } from './Select'
import { Tooltip } from './Tooltip'

const ROW_H = 26
const PREFS_KEY = 'satura.filePicker.prefs'
const MOD = IS_MAC ? '⌘' : 'Ctrl+'

interface Prefs {
  sort: PickerSortKey
  desc: boolean
  hidden: boolean
}

function loadPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<Prefs> | null
    return { sort: v?.sort ?? 'name', desc: !!v?.desc, hidden: !!v?.hidden }
  } catch {
    return { sort: 'name', desc: false, hidden: false }
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    return
  }
}

let placesCache: Promise<PickerPlaces> | null = null

function loadPlaces(): Promise<PickerPlaces> {
  placesCache ??= window.api.picker.places().catch((e) => {
    placesCache = null
    throw e
  })
  return placesCache
}

const PLACE_ICONS: Record<PickerPlace['kind'], LucideIcon> = {
  home: House,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  volume: HardDrive
}

export function FilePickerHost() {
  const request = useFilePickerStore((s) => s.request)
  const mount = useFilePickerStore((s) => s.mount)
  useEffect(() => mount(), [mount])
  if (!request) return null
  return <FilePicker key={request.id} request={request} />
}

function samePath(a: string | null | undefined, b: string | null | undefined, windows: boolean): boolean {
  if (!a || !b) return false
  const x = normalizePath(a)
  const y = normalizePath(b)
  return IS_MAC || windows ? equalsIgnoreCase(x, y) : x === y
}

function iconButton(active = false): string {
  return `flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-3 transition-colors hover:bg-white/[0.06] hover:text-ink disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-ink-3 ${
    active ? 'bg-accent/[0.14] text-ink' : ''
  }`
}

function FilePicker({ request }: { request: PickOptions & { id: number } }) {
  const respond = useFilePickerStore((s) => s.respond)
  const mode = request.mode
  const [places, setPlaces] = useState<PickerPlaces | null>(null)
  const [recents, setRecents] = useState<string[]>([])
  const [dir, setDir] = useState<string | null>(null)
  const [entries, setEntries] = useState<PickerEntry[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [value, setValue] = useState('')
  const [query, setQuery] = useState('')
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [active, setActive] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [history, setHistory] = useState<{ back: string[]; fwd: string[] }>({ back: [], fwd: [] })
  const [name, setName] = useState(request.defaultName ?? '')
  const [filterIdx, setFilterIdx] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [creating, setCreating] = useState<{ name: string; error: string | null } | null>(null)
  const [busy, setBusy] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const crumbsRef = useRef<HTMLDivElement>(null)
  const listSeq = useRef(0)
  const valueSeq = useRef(0)
  const valueRef = useRef('')
  const dirRef = useRef<string | null>(null)
  const badPath = useRef<string | null>(null)
  const cycle = useRef<TabCycle | null>(null)
  const anchor = useRef<string | null>(null)
  const closed = useRef(false)

  const windows = places?.windows ?? false
  const home = places?.home ?? '/'
  const filters = request.filters ?? []
  const filter = filters[filterIdx] ?? null

  const visible = useMemo(
    () => sortEntries(filterEntries(entries, { mode, query, showHidden: prefs.hidden, filter }), prefs.sort, prefs.desc),
    [entries, mode, query, prefs, filter]
  )
  const activeIndex = active ? visible.findIndex((e) => e.path === active) : -1
  const activeEntry = activeIndex >= 0 ? visible[activeIndex] : null

  const setBoxValue = useCallback((v: string) => {
    valueRef.current = v
    setValue(v)
  }, [])

  const finish = useCallback(
    (paths: string[] | null) => {
      if (closed.current) return
      closed.current = true
      listSeq.current++
      valueSeq.current++
      respond(paths)
    },
    [respond]
  )

  const go = useCallback(
    async (target: string, opts: { keepValue?: boolean; select?: string; push?: boolean; from?: 'back' | 'fwd' } = {}): Promise<boolean> => {
      const seq = ++listSeq.current
      setLoading(true)
      const listing = await window.api.picker.list(target, { unity: request.unity }).catch(() => null)
      if (seq !== listSeq.current || !listing) return false
      const prev = dirRef.current
      dirRef.current = listing.dir
      setDir(listing.dir)
      setEntries(listing.entries)
      setListError(listing.error ?? null)
      setLoading(false)
      setCreating(null)
      setMessage(null)
      cycle.current = null
      if (prev && !samePath(prev, listing.dir, windows)) {
        setHistory((h) =>
          opts.from === 'back'
            ? { back: h.back.slice(0, -1), fwd: [...h.fwd, prev] }
            : opts.from === 'fwd'
              ? { back: [...h.back, prev], fwd: h.fwd.slice(0, -1) }
              : opts.push === false
                ? h
                : { back: [...h.back, prev], fwd: [] }
        )
      }
      if (opts.keepValue) {
        const plan = planInput(valueRef.current, listing.dir, home, windows)
        setQuery(samePath(plan.folder, listing.dir, windows) ? plan.query : '')
        const match = listing.entries.find((e) => plan.query && startsWithIgnoreCase(e.name, plan.query))
        setActive(match?.path ?? null)
        setSelected(match ? [match.path] : [])
      } else {
        setBoxValue(displayPath(listing.dir))
        setQuery('')
        const pick = opts.select ? listing.entries.find((e) => e.name === opts.select) : undefined
        setActive(pick?.path ?? null)
        setSelected(pick ? [pick.path] : [])
      }
      return !listing.error
    },
    [request.unity, home, windows, setBoxValue]
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      const [p, r] = await Promise.all([loadPlaces().catch(() => null), window.api.recents.list().catch(() => [] as string[])])
      if (!alive) return
      if (p) setPlaces(p)
      setRecents(r.slice(0, 8))
      const memory = pickerMemory(request.purpose)
      const start = memory?.dir ?? request.defaultPath ?? p?.home ?? '/'
      const ok = await go(start, { push: false, select: memory?.name })
      if (!ok && alive && !closed.current) await go(request.defaultPath && start !== request.defaultPath ? request.defaultPath : (p?.home ?? '/'), { push: false })
    })()
    return () => {
      alive = false
      listSeq.current++
      valueSeq.current++
    }
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useLayoutEffect(() => {
    const el = crumbsRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [dir])

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_H,
    overscan: 16
  })

  useEffect(() => {
    if (activeIndex >= 0) virtualizer.scrollToIndex(activeIndex, { align: 'auto' })
  }, [activeIndex, virtualizer])

  const updatePrefs = (patch: Partial<Prefs>): void => {
    setPrefs((p) => {
      const next = { ...p, ...patch }
      savePrefs(next)
      return next
    })
  }

  const onValueChange = async (v: string): Promise<void> => {
    setBoxValue(v)
    setMessage(null)
    cycle.current = null
    const current = dirRef.current
    if (!current) return
    const seq = ++valueSeq.current
    const plan = planInput(v, current, home, windows)
    if (plan.rewrite && plan.rewrite !== v) setBoxValue(plan.rewrite)
    if (samePath(plan.folder, current, windows)) {
      badPath.current = null
      setQuery(plan.query)
      const list = sortEntries(filterEntries(entries, { mode, query: plan.query, showHidden: prefs.hidden, filter }), prefs.sort, prefs.desc)
      const idx = bestMatchIndex(list, plan.query)
      setActive(idx >= 0 ? list[idx].path : null)
      return
    }
    if (badPath.current && v.length > badPath.current.length && startsWithIgnoreCase(v, badPath.current)) {
      setMessage('That path does not exist.')
      return
    }
    const st = await window.api.picker.stat(plan.folder)
    if (seq !== valueSeq.current) return
    if (st.exists && st.isDir) {
      badPath.current = null
      await go(plan.folder, { keepValue: true })
    } else if (endsWithSep(plan.rewrite ?? v)) {
      badPath.current = plan.rewrite ?? v
      setMessage('That path does not exist.')
    } else {
      setQuery(plan.query)
      setActive(null)
    }
  }

  const complete = (back: boolean): void => {
    const current = dirRef.current
    if (!current) return
    const plan = planInput(valueRef.current, current, home, windows)
    if (!samePath(plan.folder, current, windows)) return
    const pool = sortEntries(filterEntries(entries, { mode, showHidden: prefs.hidden || plan.query.startsWith('.'), filter }), prefs.sort, prefs.desc)
    const res = tabComplete(cycle.current ? cycle.current.base : plan.query, pool, cycle.current, back)
    if (!res) {
      setMessage(plan.query ? `Nothing here starts with “${plan.query}”.` : null)
      return
    }
    if (res.done && res.isDir) {
      void onValueChange(displayPath(current, `${res.text}/`))
      return
    }
    const base = cycle.current?.base ?? plan.query
    const next = displayPath(current, res.text)
    setBoxValue(next)
    setMessage(null)
    const visibleQuery = res.cycle ? base : res.text
    setQuery(visibleQuery)
    const hit = pool.find((e) => e.name === res.text) ?? pool.find((e) => startsWithIgnoreCase(e.name, res.text))
    setActive(hit?.path ?? null)
    if (hit && (mode === 'save' ? !hit.isDir : true)) setSelected([hit.path])
    if (mode === 'save' && hit && !hit.isDir) setName(hit.name)
    cycle.current = res.cycle
  }

  const pickedFolder = (): string | null => {
    const sel = selected.length === 1 ? entries.find((e) => e.path === selected[0]) : undefined
    if (sel?.isDir) return sel.path
    return dirRef.current
  }

  const confirmPaths = async (paths: string[]): Promise<void> => {
    if (paths.length === 0 || closed.current) return
    const first = normalizePath(paths[0])
    const parent = parentOf(first) ?? first
    rememberPicker(request.purpose, { dir: parent, name: basenameOf(first) || undefined })
    finish(paths.map((p) => toNativeSeparators(normalizePath(p), windows)))
  }

  const confirmOpen = async (target: string): Promise<void> => {
    setBusy(true)
    try {
      const st = await window.api.picker.stat(target)
      const verdict = validatePick(mode, target, st, null, windows)
      if (verdict.kind === 'error') {
        setMessage(verdict.message)
        return
      }
      if (mode === 'openFile' && request.multiple && selected.length > 1) await confirmPaths(selected)
      else await confirmPaths([target])
    } finally {
      setBusy(false)
    }
  }

  const confirmSave = async (): Promise<void> => {
    const current = dirRef.current
    if (!current) return
    const raw = name.trim()
    if (!raw) {
      setMessage('Enter a file name.')
      nameRef.current?.focus()
      return
    }
    setBusy(true)
    try {
      const target = addPostfix(resolveInput(raw, current, home, windows), filters, filter)
      const parent = parentOf(target) ?? target
      const [st, pst] = await Promise.all([window.api.picker.stat(target), window.api.picker.stat(parent)])
      const verdict = validatePick('save', target, st, pst, windows)
      if (verdict.kind === 'error') {
        setMessage(verdict.message)
        return
      }
      if (verdict.kind === 'confirm') {
        const ok = await requestConfirm({ title: verdict.title, message: verdict.message, confirmLabel: verdict.confirmLabel, danger: !verdict.createParent })
        if (!ok) {
          nameRef.current?.focus()
          return
        }
        if (verdict.createParent) await window.api.fs.createDir(toNativeSeparators(parent, windows))
      }
      await confirmPaths([target])
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const confirm = (): void => {
    if (busy) return
    if (mode === 'save') {
      void confirmSave()
      return
    }
    if (mode === 'openFolder') {
      const target = pickedFolder()
      if (target) void confirmOpen(target)
      return
    }
    const files = selected.filter((p) => entries.find((e) => e.path === p && !e.isDir))
    if (files.length === 0) {
      setMessage('Select a file.')
      return
    }
    void confirmOpen(files[0])
  }

  const openEntry = (e: PickerEntry): void => {
    if (e.isDir) {
      void go(e.path)
      return
    }
    if (mode === 'save') {
      setName(e.name)
      setSelected([e.path])
      requestAnimationFrame(focusName)
      return
    }
    if (mode === 'openFile') void confirmOpen(e.path)
  }

  const acceptBox = async (): Promise<void> => {
    const current = dirRef.current
    if (!current || busy) return
    if (activeEntry) {
      openEntry(activeEntry)
      return
    }
    const target = resolveInput(valueRef.current, current, home, windows)
    if (!samePath(target, current, windows)) {
      const st = await window.api.picker.stat(target)
      if (st.exists && st.isDir) {
        await go(target)
        return
      }
      if (mode === 'save') {
        const plan = planInput(valueRef.current, current, home, windows)
        if (plan.query) setName(plan.query)
        requestAnimationFrame(focusName)
        return
      }
      await confirmOpen(target)
      return
    }
    if (mode === 'save') {
      focusName()
      return
    }
    confirm()
  }

  const goUp = (): void => {
    const current = dirRef.current
    const parent = current ? parentOf(current) : null
    if (parent && current) void go(parent, { select: basenameOf(current) })
  }

  const goBack = (): void => {
    const target = history.back.at(-1)
    if (target) void go(target, { from: 'back' })
  }

  const goForward = (): void => {
    const target = history.fwd.at(-1)
    if (target) void go(target, { from: 'fwd' })
  }

  const moveActive = (delta: number, extend = false): void => {
    if (visible.length === 0) return
    const from = activeIndex < 0 ? (delta > 0 ? -1 : visible.length) : activeIndex
    const idx = Math.max(0, Math.min(visible.length - 1, from + delta))
    const e = visible[idx]
    setActive(e.path)
    if (extend && request.multiple && anchor.current) {
      const a = visible.findIndex((x) => x.path === anchor.current)
      const [lo, hi] = a <= idx ? [a, idx] : [idx, a]
      setSelected(visible.slice(lo, hi + 1).filter((x) => !x.isDir).map((x) => x.path))
    } else {
      anchor.current = e.path
      setSelected([e.path])
      if (mode === 'save' && !e.isDir) setName(e.name)
    }
  }

  const startCreate = (): void => {
    if (!dirRef.current || listError) return
    setCreating({ name: 'New Folder', error: null })
  }

  const finishCreate = async (): Promise<void> => {
    const current = dirRef.current
    if (!creating || !current) return
    const res = await window.api.picker.mkdir(current, creating.name)
    if (!res.ok) {
      setCreating({ ...creating, error: res.error })
      return
    }
    const made = basenameOf(res.path)
    await go(current, { push: false, select: made })
    inputRef.current?.focus()
  }

  const focusName = (): void => {
    const el = nameRef.current
    if (!el) return
    el.focus()
    const dot = el.value.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length)
  }

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (useConfirmStore.getState().request) return
    const mod = IS_MAC ? e.metaKey : e.ctrlKey
    const target = e.target as HTMLElement
    const inBox = target === inputRef.current
    const inName = target === nameRef.current
    const inCreate = target.dataset.pickerCreate !== undefined
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (inCreate) {
        setCreating(null)
        inputRef.current?.focus()
      } else finish(null)
      return
    }
    if (inCreate) return
    if (mod && e.shiftKey && (e.key === '.' || e.code === 'Period')) {
      e.preventDefault()
      updatePrefs({ hidden: !prefs.hidden })
      return
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      startCreate()
      return
    }
    if (mod && e.key === 'ArrowUp') {
      e.preventDefault()
      goUp()
      return
    }
    if (mod && e.key === 'ArrowDown') {
      e.preventDefault()
      if (activeEntry) openEntry(activeEntry)
      return
    }
    if (mod && (e.key === '[' || (e.altKey && e.key === 'ArrowLeft'))) {
      e.preventDefault()
      goBack()
      return
    }
    if (mod && (e.key === ']' || (e.altKey && e.key === 'ArrowRight'))) {
      e.preventDefault()
      goForward()
      return
    }
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      confirm()
      return
    }
    if (inName) {
      if (e.key === 'Enter') {
        e.preventDefault()
        confirm()
      }
      return
    }
    if (inBox) {
      if (e.key === 'Tab') {
        e.preventDefault()
        complete(e.shiftKey)
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        moveActive(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)
        return
      }
      if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault()
        moveActive((e.key === 'PageDown' ? 1 : -1) * Math.max(1, Math.floor((listRef.current?.clientHeight ?? 260) / ROW_H) - 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        void acceptBox()
      }
      return
    }
    if (target === listRef.current) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        moveActive(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        moveActive(e.key === 'Home' ? -visible.length : visible.length)
      } else if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault()
        moveActive((e.key === 'PageDown' ? 1 : -1) * Math.max(1, Math.floor(listRef.current.clientHeight / ROW_H) - 1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (activeEntry) openEntry(activeEntry)
        else confirm()
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        goUp()
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        inputRef.current?.focus()
        const current = dirRef.current
        if (current) {
          const plan = planInput(valueRef.current, current, home, windows)
          const base = samePath(plan.folder, current, windows) ? valueRef.current : displayPath(current)
          void onValueChange(base + e.key)
        }
      }
    }
  }

  const clickRow = (e: ReactMouseEvent, entry: PickerEntry): void => {
    listRef.current?.focus()
    setActive(entry.path)
    setMessage(null)
    const multi = request.multiple && mode === 'openFile' && !entry.isDir
    if (multi && (IS_MAC ? e.metaKey : e.ctrlKey)) {
      setSelected((s) => (s.includes(entry.path) ? s.filter((p) => p !== entry.path) : [...s.filter((p) => !entries.find((x) => x.path === p)?.isDir), entry.path]))
      anchor.current = entry.path
      return
    }
    if (multi && e.shiftKey && anchor.current) {
      const a = visible.findIndex((x) => x.path === anchor.current)
      const b = visible.findIndex((x) => x.path === entry.path)
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      setSelected(visible.slice(lo, hi + 1).filter((x) => !x.isDir).map((x) => x.path))
      return
    }
    anchor.current = entry.path
    setSelected([entry.path])
    if (mode === 'save' && !entry.isDir) setName(entry.name)
  }

  const sortBy = (key: PickerSortKey): void => {
    updatePrefs(prefs.sort === key ? { desc: !prefs.desc } : { sort: key, desc: key === 'modified' })
  }

  const title = request.title ?? (mode === 'openFolder' ? 'Choose a folder' : mode === 'save' ? 'Save as' : 'Open file')
  const confirmLabel = request.confirmLabel ?? (mode === 'openFolder' ? 'Choose' : mode === 'save' ? 'Save' : 'Open')
  const folderTarget = mode === 'openFolder' ? pickedFolder() : null
  const folderTargetEntry = folderTarget ? entries.find((e) => e.path === folderTarget) : undefined
  const selectedFiles = mode === 'openFile' ? selected.filter((p) => entries.find((e) => e.path === p && !e.isDir)) : []
  const confirmDisabled = busy || loading || !dir || (mode === 'openFile' && selectedFiles.length === 0) || (mode === 'save' && !name.trim()) || (mode === 'openFolder' && !!listError && !folderTargetEntry)

  const place = (p: PickerPlace | { label: string; path: string; icon: LucideIcon; unity?: boolean }, key: string): ReactNode => {
    const Icon = 'kind' in p ? PLACE_ICONS[p.kind] : p.icon
    const on = samePath(dir, p.path, windows)
    return (
      <button
        key={key}
        type="button"
        title={p.path}
        data-picker-place={p.label}
        onClick={() => {
          void go(p.path)
          inputRef.current?.focus()
        }}
        className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] transition-colors ${
          on ? 'bg-accent/[0.14] text-ink' : 'text-ink-2 hover:bg-white/[0.05] hover:text-ink'
        }`}
      >
        <Icon className={`h-3.5 w-3.5 shrink-0 ${on ? 'text-accent' : 'text-ink-3'}`} strokeWidth={1.75} />
        <span className="min-w-0 truncate">{p.label}</span>
      </button>
    )
  }

  const segments = dir ? pathSegments(dir) : []
  const sortIcon = (key: PickerSortKey): ReactNode =>
    prefs.sort === key ? prefs.desc ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" /> : null

  const status = (() => {
    if (mode === 'openFolder' && folderTarget) {
      const e = folderTargetEntry
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-ink-4">Folder</span>
          <span className="min-w-0 truncate font-mono text-ink-2" data-picker-target>{pathBasename(folderTarget) || folderTarget}</span>
          {e?.unity && <UnityBadge version={e.unity} />}
        </span>
      )
    }
    if (mode === 'openFile') {
      if (selectedFiles.length > 1) return <span className="text-ink-3">{selectedFiles.length} files selected</span>
      if (selectedFiles.length === 1) return <span className="min-w-0 truncate font-mono text-ink-2" data-picker-target>{pathBasename(selectedFiles[0])}</span>
      return <span className="text-ink-4">No file selected</span>
    }
    return null
  })()

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 [-webkit-app-region:no-drag]" data-file-picker-scrim>
      <div
        role="dialog"
        aria-label={title}
        aria-modal
        data-file-picker={mode}
        onKeyDown={onKeyDown}
        className="animate-menu-pop-in surface-overlay flex h-[min(640px,88vh)] w-[min(980px,94vw)] flex-col overflow-hidden rounded-xl"
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{title}</h2>
          <Tooltip label="Close (Esc)">
            <button type="button" aria-label="Close" onClick={() => finish(null)} className={iconButton()}>
              <X className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </Tooltip>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="flex w-48 shrink-0 flex-col gap-3 overflow-y-auto border-r border-white/[0.06] bg-black/10 p-2" data-picker-sidebar>
            {places && (
              <div className="flex flex-col gap-px">
                <SideLabel>Places</SideLabel>
                {places.places.map((p) => place(p, p.path))}
              </div>
            )}
            {recents.length > 0 && (
              <div className="flex flex-col gap-px">
                <SideLabel>Recent</SideLabel>
                {recents.map((r) => place({ label: pathBasename(r) || r, path: r, icon: Clock }, `recent:${r}`))}
              </div>
            )}
            {places && places.volumes.length > 0 && (
              <div className="flex flex-col gap-px">
                <SideLabel>Locations</SideLabel>
                {places.volumes.map((p) => place(p, `vol:${p.path}`))}
              </div>
            )}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-1 border-b border-white/[0.06] px-2">
              <Tooltip label={`Back (${MOD}[)`}>
                <button type="button" aria-label="Back" disabled={history.back.length === 0} onClick={goBack} className={iconButton()}>
                  <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </Tooltip>
              <Tooltip label={`Forward (${MOD}])`}>
                <button type="button" aria-label="Forward" disabled={history.fwd.length === 0} onClick={goForward} className={iconButton()}>
                  <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </Tooltip>
              <Tooltip label={`Enclosing folder (${MOD}↑)`}>
                <button type="button" aria-label="Enclosing folder" data-picker-up disabled={!dir || !parentOf(dir)} onClick={goUp} className={iconButton()}>
                  <ArrowUp className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </Tooltip>
              <div ref={crumbsRef} className="no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto px-1" data-picker-crumbs>
                {segments.map((s, i) => (
                  <span key={s.path} className="flex shrink-0 items-center">
                    {i > 0 && !(i === 1 && segments[0].label === '/') && <span className="px-0.5 text-ink-4">/</span>}
                    <button
                      type="button"
                      title={s.path}
                      onClick={() => {
                        void go(s.path)
                        inputRef.current?.focus()
                      }}
                      className={`rounded px-1.5 py-0.5 text-[13px] transition-colors hover:bg-white/[0.06] hover:text-ink ${
                        i === segments.length - 1 ? 'font-medium text-ink' : 'text-ink-3'
                      }`}
                    >
                      {s.label}
                    </button>
                  </span>
                ))}
              </div>
              <Tooltip label={`${prefs.hidden ? 'Hide' : 'Show'} hidden files (${MOD}${IS_MAC ? '⇧' : 'Shift+'}.)`}>
                <button
                  type="button"
                  aria-label={prefs.hidden ? 'Hide hidden files' : 'Show hidden files'}
                  aria-pressed={prefs.hidden}
                  data-picker-hidden-toggle
                  onClick={() => {
                    updatePrefs({ hidden: !prefs.hidden })
                    inputRef.current?.focus()
                  }}
                  className={iconButton(prefs.hidden)}
                >
                  {prefs.hidden ? <Eye className="h-4 w-4" strokeWidth={1.75} /> : <EyeOff className="h-4 w-4" strokeWidth={1.75} />}
                </button>
              </Tooltip>
              <Tooltip label={`New folder (${MOD}${IS_MAC ? '⇧' : 'Shift+'}N)`}>
                <button type="button" aria-label="New folder" data-picker-new-folder disabled={!dir || !!listError} onClick={startCreate} className={iconButton()}>
                  <FolderPlus className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </Tooltip>
            </div>

            <div className="shrink-0 px-3 pt-2.5 pb-2">
              <div className={`flex items-center rounded-lg border bg-sunken px-2.5 ${message ? 'border-err/60' : 'border-white/10 focus-within:border-white/20'}`}>
                <input
                  ref={inputRef}
                  value={value}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Path"
                  data-picker-path
                  onChange={(e) => void onValueChange(e.target.value)}
                  placeholder="Type a path"
                  className="h-8 min-w-0 flex-1 bg-transparent font-mono text-xs text-ink placeholder:text-ink-4/60 focus:outline-none"
                />
                <span className="shrink-0 pl-2 text-[11px] text-ink-4">Tab completes</span>
              </div>
              {message && (
                <div className="pt-1.5 text-xs text-err" data-picker-message>
                  {message}
                </div>
              )}
            </div>

            <div className="flex h-7 shrink-0 items-center border-y border-white/[0.06] bg-black/10 pr-3 pl-3 text-[11px] font-medium text-ink-3 select-none">
              <SortHeader className="min-w-0 flex-1 justify-start" onClick={() => sortBy('name')} on={prefs.sort === 'name'} sortKey="name">
                Name {sortIcon('name')}
              </SortHeader>
              <SortHeader className="w-24 justify-end" onClick={() => sortBy('size')} on={prefs.sort === 'size'} sortKey="size">
                {sortIcon('size')} Size
              </SortHeader>
              <SortHeader className="w-44 justify-end" onClick={() => sortBy('modified')} on={prefs.sort === 'modified'} sortKey="modified">
                {sortIcon('modified')} Modified
              </SortHeader>
            </div>

            {creating && (
              <div className="flex shrink-0 flex-col gap-1 border-b border-white/[0.06] bg-accent/[0.06] px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <ExplorerIcon name={creating.name} rel={creating.name} isDir open={false} dim={false} unity={false} />
                  <input
                    autoFocus
                    data-picker-create
                    value={creating.name}
                    spellCheck={false}
                    aria-label="New folder name"
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setCreating({ name: e.target.value, error: null })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void finishCreate()
                      }
                    }}
                    className="h-6 min-w-0 flex-1 rounded border border-white/20 bg-sunken px-1.5 text-[13px] text-ink focus:outline-none"
                  />
                  <button type="button" onClick={() => void finishCreate()} className="rounded px-2 py-0.5 text-xs font-medium text-ink-2 hover:bg-white/10 hover:text-ink">
                    Create
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(null)
                      inputRef.current?.focus()
                    }}
                    className="rounded px-2 py-0.5 text-xs font-medium text-ink-3 hover:bg-white/10 hover:text-ink"
                  >
                    Cancel
                  </button>
                </div>
                {creating.error && <div className="pl-6 text-xs text-err">{creating.error}</div>}
              </div>
            )}

            <div
              ref={listRef}
              tabIndex={0}
              role="listbox"
              aria-multiselectable={!!request.multiple}
              data-picker-list
              className="relative min-h-0 flex-1 overflow-y-auto focus:outline-none"
            >
              {visible.length === 0 ? (
                <div className="flex h-full items-center justify-center px-6 text-center text-xs text-ink-4" data-picker-empty>
                  {loading ? 'Loading…' : listError ?? (query ? `Nothing matches “${query}”.` : mode === 'openFolder' ? 'No folders here.' : 'This folder is empty.')}
                </div>
              ) : (
                <div style={{ height: virtualizer.getTotalSize() }} className="relative w-full">
                  {virtualizer.getVirtualItems().map((v) => {
                    const e = visible[v.index]
                    const isActive = e.path === active
                    const isSel = selected.includes(e.path)
                    return (
                      <div
                        key={e.path}
                        role="option"
                        aria-selected={isSel}
                        data-picker-row={e.name}
                        data-picker-dir={e.isDir ? '' : undefined}
                        data-picker-active={isActive ? '' : undefined}
                        onMouseDown={(ev) => {
                          if (ev.button === 0) ev.preventDefault()
                        }}
                        onClick={(ev) => clickRow(ev, e)}
                        onDoubleClick={() => openEntry(e)}
                        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW_H, transform: `translateY(${v.start}px)` }}
                        className={`flex cursor-default items-center px-3 text-[13px] ${
                          isSel ? 'bg-accent/[0.18] text-ink' : isActive ? 'bg-white/[0.05] text-ink' : 'text-ink-2 hover:bg-white/[0.03]'
                        } ${isActive ? 'shadow-[inset_2px_0_0_var(--accent)]' : ''}`}
                      >
                        <span className={`flex min-w-0 flex-1 items-center gap-2 ${e.hidden ? 'opacity-60' : ''}`}>
                          <ExplorerIcon name={e.name} rel={e.name} isDir={e.isDir} open={false} dim={false} unity={false} />
                          <span className="min-w-0 truncate">{e.name}</span>
                          {e.unity && <UnityBadge version={e.unity} />}
                        </span>
                        <span className="w-24 shrink-0 text-right text-xs text-ink-3 tabular-nums">{e.isDir ? '—' : formatSize(e.size)}</span>
                        <span className="w-44 shrink-0 truncate text-right text-xs text-ink-3 tabular-nums">{formatDateTime(e.mtime)}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t border-white/[0.06] px-3 py-2.5">
          {mode === 'save' ? (
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-xs text-ink-3">Name</span>
              <input
                ref={nameRef}
                value={name}
                spellCheck={false}
                autoComplete="off"
                aria-label="File name"
                data-picker-name
                onChange={(e) => {
                  setName(e.target.value)
                  setMessage(null)
                }}
                className="h-8 min-w-0 max-w-sm flex-1 rounded-lg border border-white/10 bg-sunken px-2.5 font-mono text-xs text-ink focus:border-white/20 focus:outline-none"
              />
            </label>
          ) : (
            <div className="flex min-w-0 flex-1 items-center text-xs">{status}</div>
          )}
          {filters.length > 1 ? (
            <Select
              value={String(filterIdx)}
              options={filters.map((f, i) => ({ value: String(i), label: `${f.name} (${f.extensions.map((x) => (x === '*' ? '*' : `.${x}`)).join(', ')})` }))}
              onChange={(v) => setFilterIdx(Number(v))}
              className="w-56 shrink-0"
            />
          ) : filters.length === 1 ? (
            <span className="shrink-0 text-xs text-ink-4" data-picker-filter>
              {filters[0].name} ({filters[0].extensions.map((x) => (x === '*' ? '*' : `.${x}`)).join(', ')})
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => finish(null)}
            className="rounded px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-white/10 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            data-picker-confirm
            disabled={confirmDisabled}
            onClick={confirm}
            className="rounded bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-fg transition hover:opacity-90 disabled:cursor-default disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function SideLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-ink-4">{children}</div>
}

function SortHeader({
  children,
  onClick,
  on,
  className,
  sortKey
}: {
  children: ReactNode
  onClick: () => void
  on: boolean
  className: string
  sortKey: PickerSortKey
}) {
  return (
    <button
      type="button"
      data-picker-sort={sortKey}
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1 transition-colors hover:text-ink ${on ? 'text-ink-2' : ''} ${className}`}
    >
      {children}
    </button>
  )
}

function UnityBadge({ version }: { version: string }) {
  return (
    <span
      title={`Unity project, editor ${version}`}
      data-picker-unity={version}
      className="shrink-0 rounded border border-accent/30 bg-accent/10 px-1.5 text-[10px] leading-4 font-medium text-accent"
    >
      {version === 'Unity' ? 'Unity' : `Unity ${version}`}
    </span>
  )
}
