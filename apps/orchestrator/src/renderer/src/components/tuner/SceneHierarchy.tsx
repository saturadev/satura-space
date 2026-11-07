import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { FloatingMenu, MenuLabel, MenuSeparator, menuItemClass } from '../ui/FloatingMenu'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertTriangle, Box, ChevronRight, FileCog, Filter, Folder, Package, Plus, ScanSearch, Search, X } from 'lucide-react'
import { componentIcon } from '../../lib/tuner/component-icons'
import { UnityPrefabAddedBadge, UnityPrefabIcon, UnityPrefabVariantIcon, UnitySceneIcon, UnityStagingPrefabIcon } from './unity-icons'
import { TUNER_PF_ADDED, TUNER_PF_OVERRIDES, TUNER_PF_PART, TUNER_SCENE_PARENT, type TunerHierarchyRequest, type TunerMember, type TunerObject, type TunerPrimitive, type TunerTreeRequest } from '@shared/tuner'
import { closestTunerRows, findTunerRow, type TunerRowInfo } from '@shared/tuner-find'
import {
  buildHierarchyRows,
  bulkyRows,
  hiddenChanges,
  hierarchyKey,
  isGroupKey,
  revealRow,
  collapsedFromExpanded,
  expandedFromCollapsed,
  rowForObject,
  rowForPath,
  selectableRows,
  moveExpanded,
  pruneExpanded,
  setExpanded,
  toggleCollapsed,
  visibleRows,
  type HierarchyRow
} from '../../lib/tuner/hierarchy'
import { loadHierarchyCollapsed, loadHierarchyExpanded, saveHierarchyCollapsed, saveHierarchyExpanded } from '../../lib/tuner/layout'
import { NO_MEMBERS, isMemberId } from '../../lib/tuner/members'
import { handleMultiSelection, hierarchySelection, NO_SELECTION, type TunerSelection } from '../../lib/tuner/selection'
import { noteRender } from '../../lib/tuner/perf'
import { scrollTopTo } from '../../lib/drift-driving'
import { sameSticky, stickyDepth, stickyRows, stickyTree, type StickyRow, type StickyTree } from '../../lib/tuner/sticky'

const ROW_HEIGHT = 24
const LIST_PAD = 4
const SEARCH_HEIGHT = 30

function searchRows(rows: readonly HierarchyRow[], query: string): HierarchyRow[] {
  const q = query.trim().toLowerCase()
  const out: HierarchyRow[] = []
  for (const r of rows) {
    if (r.kind !== 'object' || !r.objectId || !r.name.toLowerCase().includes(q)) continue
    const cut = r.path.lastIndexOf('/')
    out.push({ ...r, depth: 0, hasChildren: false, label: cut > 0 ? r.path.slice(0, cut) : r.scene.replace(/^.*\//, '').replace(/\.(unity|prefab)$/i, '') })
  }
  return out
}
const NO_STICKY: StickyRow[] = []
const NO_PLACE: CSSProperties = {}
const RENAME_DELAY_MS = 500
const EXPAND_DELAY_MS = 700
const DRAG_TYPE = 'application/x-satura-tuner-objects'
const PRIMITIVES: [TunerPrimitive, string][] = [
  ['cube', 'Cube'],
  ['sphere', 'Sphere'],
  ['capsule', 'Capsule'],
  ['cylinder', 'Cylinder'],
  ['plane', 'Plane'],
  ['quad', 'Quad']
]

const LIGHTS: [TunerPrimitive, string][] = [
  ['light', 'Directional Light'],
  ['pointlight', 'Point Light'],
  ['spotlight', 'Spot Light']
]

type DropZone = 'above' | 'below' | 'into' | 'root'

interface DropPlan {
  parent: string
  scene: string
  before?: string
  order: boolean
  parentKey: string | null
}

interface HierarchyMenu {
  x: number
  y: number
  row: HierarchyRow | null
  scene: string
}
const PING_MS = 2400
const OPEN_MARK = '+'
const TREE_QUERY_MS = 150
const REVEAL_WAIT_MS = 3000
const SETTLE_MS = 1500
const TREE_RESEND_MS = 3000

function lazyRow(r: HierarchyRow): boolean {
  return r.kind === 'object' && r.hasChildren && isMemberId(r.objectId)
}
const NO_GHOSTS: TunerObject[] = []

function rowInfo(r: HierarchyRow): TunerRowInfo {
  const path = r.kind === 'object' || r.kind === 'ancestor' ? r.path : ''
  return { key: r.key, path, scene: r.scene, name: r.name, ...(r.error ? { error: r.error } : {}) }
}

export interface HierarchyPing {
  path: string
  scene: string
  seq: number
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

function actionKey(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

function groupedRow(r: HierarchyRow): boolean {
  return !!r.parent && isGroupKey(r.parent)
}

function RuntimeTag() {
  return (
    <span
      data-runtime-tag
      className="ml-auto shrink-0 rounded-sm px-1 text-[9px] font-medium uppercase leading-[14px] tracking-wide text-zinc-500 ring-1 ring-inset ring-white/10"
    >
      runtime
    </span>
  )
}

function editableRow(r: HierarchyRow): boolean {
  return r.kind === 'object' && !!r.objectId && !r.error && !r.env
}

function ownName(r: HierarchyRow): string {
  return r.path ? r.path.slice(r.path.lastIndexOf('/') + 1) : r.name
}

function sceneParent(scene: string): string {
  return scene ? `${TUNER_SCENE_PARENT}${scene}` : ''
}

function Hint({ children }: { children: string }) {
  return <span className="ml-auto pl-6 text-xs text-zinc-500">{children}</span>
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (name: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  return (
    <input
      ref={ref}
      data-hierarchy-rename
      defaultValue={initial}
      spellCheck={false}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(e.currentTarget.value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(null)
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      className="h-5 min-w-0 flex-1 rounded-sm border border-sky-500/60 bg-sunken px-1 text-xs text-zinc-100 outline-none"
    />
  )
}

const StickyLayer = memo(function StickyLayer({ tree, render }: { tree: StickyTree; render: (row: StickyRow, z: number) => ReactNode }) {
  const [pinned, setPinned] = useState<StickyRow[]>(NO_STICKY)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current?.parentElement
    if (!el) return
    let height = el.clientHeight
    const update = (): void => {
      const next = stickyRows(tree, { scrollTop: el.scrollTop, height, rowHeight: ROW_HEIGHT, padTop: LIST_PAD })
      setPinned((prev) => (sameSticky(prev, next) ? prev : next.length ? next : NO_STICKY))
    }
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            height = el.clientHeight
            update()
          })
    ro?.observe(el)
    el.addEventListener('scroll', update, { passive: true })
    update()
    return () => {
      ro?.disconnect()
      el.removeEventListener('scroll', update)
    }
  }, [tree])
  const last = pinned[pinned.length - 1]
  return (
    <div ref={ref} data-hierarchy-sticky={pinned.length} className="sticky top-0 z-10 h-0">
      {pinned.map((p, i) => render(p, pinned.length - i))}
      {last && (
        <div
          className="pointer-events-none absolute left-0 right-0 h-[3px] shadow-[inset_0_6px_6px_-6px_rgb(0_0_0/0.7)]"
          style={{ top: last.position + ROW_HEIGHT }}
        />
      )}
    </div>
  )
})

export const SceneHierarchy = memo(function SceneHierarchy({
  objects,
  assets,
  members,
  ghosts = NO_GHOSTS,
  selection,
  onSelectionChange,
  onFocusObject,
  onOpenPath,
  onOpenPrefab,
  contextOnly,
  storageKey,
  waiting,
  wholeScene,
  changed,
  ping,
  onPingMissing,
  onGhostAdd,
  onGhostDismiss,
  ghostAddBlocked,
  collapseBulky,
  capped = 0,
  lazy = false,
  revealMissing,
  onRestoreFilter,
  restoreFilterTip,
  onTree,
  onSearch,
  onFitHeight,
  headerExtra,
  onHierarchyOp,
  onAddFromProject,
  onUndo,
  dimRow
}: {
  objects: TunerObject[]
  assets?: TunerObject[]
  members?: readonly TunerMember[]
  ghosts?: TunerObject[]
  selection: TunerSelection
  onSelectionChange: (sel: TunerSelection) => void
  onFocusObject?: (id: string) => void
  onOpenPath?: (path: string, scene: string) => void
  onOpenPrefab?: (asset: string) => void
  contextOnly?: boolean
  storageKey: string
  waiting?: boolean
  wholeScene?: boolean
  changed?: Set<string>
  ping?: HierarchyPing | null
  onPingMissing?: (path: string, scene: string) => void
  onGhostAdd?: (id: string) => void
  onGhostDismiss?: (id: string) => void
  ghostAddBlocked?: string | null
  collapseBulky?: boolean
  capped?: number
  lazy?: boolean
  revealMissing?: string
  onRestoreFilter?: () => void
  restoreFilterTip?: string
  onTree?: (req: TunerTreeRequest) => void
  onSearch?: (ids: string[] | null) => void
  onFitHeight?: (px: number) => void
  headerExtra?: ReactNode
  onHierarchyOp?: (req: TunerHierarchyRequest) => void
  onAddFromProject?: (at: { parent: string; scene: string; x: number; y: number }) => void
  onUndo?: (redo: boolean) => void
  dimRow?: (path: string, scene: string) => string | null
}) {
  noteRender('SceneHierarchy')
  const rows = useMemo(
    () => buildHierarchyRows(objects, false, assets ?? [], members ?? NO_MEMBERS, ghosts),
    [objects, assets, members, ghosts]
  )
  const sceneScope = useMemo(() => (wholeScene ? [...new Set(rows.filter((r) => r.depth === 0 && r.scene !== 'DontDestroyOnLoad').map((r) => r.scene))].sort().join('|') : ''), [rows, wholeScene])
  const scopeKey = sceneScope ? `${storageKey}@${sceneScope}` : storageKey
  const [collapsedSaved, setCollapsedState] = useState<Set<string>>(() => (wholeScene ? new Set() : loadHierarchyCollapsed(scopeKey)))
  const [expanded, setExpandedState] = useState<Set<string>>(() => (wholeScene ? loadHierarchyExpanded(scopeKey) : new Set()))
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const collapsedRaw = useMemo(
    () => (wholeScene ? collapsedFromExpanded(rows, expanded) : collapsedSaved),
    [wholeScene, rows, expanded, collapsedSaved]
  )
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set())
  const collapsed = useMemo(() => {
    let out: Set<string> | null = null
    for (const r of rows) {
      if (lazy && !wholeScene && lazyRow(r)) {
        if (collapsedRaw.has(OPEN_MARK + r.key) || collapsedRaw.has(r.key)) continue
        out ??= new Set(collapsedRaw)
        out.add(r.key)
        continue
      }
      if (r.kind !== 'group' || openGroups.has(r.key) || collapsedRaw.has(r.key)) continue
      out ??= new Set(collapsedRaw)
      out.add(r.key)
    }
    return out ?? collapsedRaw
  }, [rows, collapsedRaw, openGroups, lazy, wholeScene])
  const autoRef = useRef<{ on: boolean; seen: Set<string> }>({ on: collapsedRaw.size === 0, seen: new Set() })
  const [cursor, setCursor] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ key: string; seq: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const revealedFor = useRef<string | null>(null)
  const mountSelected = useRef<string | null>(selection.active)
  const selected = selection.active
  const selectionActiveRef = useRef(selected)
  selectionActiveRef.current = selected
  const selectedSet = useMemo(() => new Set(selection.ids), [selection.ids])
  const editable = !!onHierarchyOp
  const [menu, setMenu] = useState<HierarchyMenu | null>(null)
  const [menuAlt, setMenuAlt] = useState(false)
  useEffect(() => {
    if (!menu) return
    const track = (e: KeyboardEvent): void => setMenuAlt(e.altKey)
    window.addEventListener('keydown', track, true)
    window.addEventListener('keyup', track, true)
    return () => {
      window.removeEventListener('keydown', track, true)
      window.removeEventListener('keyup', track, true)
    }
  }, [menu])
  const [renaming, setRenaming] = useState<string | null>(null)
  const renameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const soleRef = useRef(false)
  const dragIds = useRef<string[] | null>(null)
  const dragKeys = useRef<string[]>([])
  const [drop, setDrop] = useState<{ key: string; zone: DropZone } | null>(null)
  const expandTimer = useRef<{ key: string; t: ReturnType<typeof setTimeout> } | null>(null)
  useEffect(
    () => () => {
      if (renameTimer.current) clearTimeout(renameTimer.current)
      if (expandTimer.current) clearTimeout(expandTimer.current.t)
    },
    []
  )
  useEffect(() => {
    if (!editable) {
      setMenu(null)
      setRenaming(null)
    }
  }, [editable])

  const setCollapsed = (base: ReadonlySet<string>, next: Set<string>, prune?: readonly string[]): void => {
    const raw = new Set<string>()
    if (lazy && !wholeScene) {
      const present = new Set<string>()
      for (const r of live.current.rows) if (lazyRow(r)) present.add(r.key)
      for (const k of next) if (!isGroupKey(k) && !k.startsWith(OPEN_MARK) && !present.has(k)) raw.add(k)
      for (const k of live.current.raw) if (k.startsWith(OPEN_MARK) && !present.has(k.slice(OPEN_MARK.length))) raw.add(k)
      for (const k of present) if (!next.has(k)) raw.add(OPEN_MARK + k)
    } else for (const k of next) if (!isGroupKey(k)) raw.add(k)
    const groups = live.current.rows.filter((r) => r.kind === 'group')
    if (groups.length > 0)
      setOpenGroups((prev) => {
        let out: Set<string> | null = null
        for (const g of groups) {
          const open = !next.has(g.key)
          if (open === prev.has(g.key)) continue
          out ??= new Set(prev)
          if (open) out.add(g.key)
          else out.delete(g.key)
        }
        return out ?? prev
      })
    if (wholeScene) {
      const opened = expandedFromCollapsed(live.current.rows, expandedRef.current, raw, base)
      const nextExpanded = prune?.length ? pruneExpanded(opened, prune) : opened
      expandedRef.current = nextExpanded
      setExpandedState(nextExpanded)
      saveHierarchyExpanded(scopeKey, nextExpanded)
      return
    }
    setCollapsedState(raw)
    saveHierarchyCollapsed(scopeKey, raw)
  }

  useEffect(() => {
    const saved = wholeScene ? new Set<string>() : loadHierarchyCollapsed(scopeKey)
    setCollapsedState(saved)
    const savedExpanded = wholeScene ? loadHierarchyExpanded(scopeKey) : new Set<string>()
    expandedRef.current = savedExpanded
    setExpandedState(savedExpanded)
    uidKeys.current = new Map()
    deepRef.current = new Set()
    deepDone.current = new Set()
    autoRef.current = { on: saved.size === 0, seen: new Set() }
    revealedFor.current = null
    mountSelected.current = selectionActiveRef.current
  }, [scopeKey, wholeScene])

  useEffect(() => {
    if (wholeScene || lazy || !autoRef.current.on) return
    const add = bulkyRows(rows, autoRef.current.seen, collapseBulky ? 8 : 0)
    if (add.length === 0) return
    setCollapsedState((prev) => {
      const next = new Set(prev)
      for (const k of add) next.add(k)
      return next
    })
  }, [rows, collapseBulky, wholeScene, lazy])

  useEffect(() => {
    const row = rowForObject(rows, selected)
    if (!row) return
    setCursor((c) => {
      const cur = c ? rows.find((r) => r.key === c) : null
      return cur?.objectId && selectedSet.has(cur.objectId) ? c : row.key
    })
    if (revealedFor.current === selected) return
    const first = revealedFor.current === null && selected === mountSelected.current
    revealedFor.current = selected
    const next = revealRow(rows, collapsed, row.key)
    if (next) setCollapsed(collapsed, next)
    if (first) {
      revealScroll.current = row.key
      setReveal((n) => n + 1)
    }
  }, [selected, rows])

  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const searching = query.trim() !== ''
  const shown = useMemo(() => (searching ? searchRows(rows, query) : visibleRows(rows, collapsed)), [rows, collapsed, searching, query])
  const searchIds = useMemo(() => (searching ? shown.map((r) => r.objectId!).join('\n') : null), [searching, shown])
  useEffect(() => {
    onSearch?.(searchIds === null ? null : searchIds ? searchIds.split('\n') : [])
  }, [searchIds, onSearch])
  useEffect(() => () => onSearch?.(null), [onSearch])
  const endSearch = (): void => {
    setQuery('')
    const row = rowForObject(rows, selected)
    if (!row) return
    const next = revealRow(rows, collapsed, row.key)
    if (next) setCollapsed(collapsed, next)
    revealScroll.current = row.key
    setReveal((n) => n + 1)
  }
  const [reveal, setReveal] = useState(0)
  const revealScroll = useRef<string | null>(null)
  const live = useRef({ rows, collapsed, raw: collapsedRaw, lazy, shown, revealMissing, waiting })
  live.current = { rows, collapsed, raw: collapsedRaw, lazy, shown, revealMissing, waiting }
  const deepRef = useRef<Set<string>>(new Set())
  const deepDone = useRef<Set<string>>(new Set())
  const uidKeys = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    if (!wholeScene) return
    const seen = uidKeys.current
    let next: ReadonlySet<string> = expandedRef.current
    let moved = false
    for (const r of rows) {
      if (!r.uid) continue
      const was = seen.get(r.uid)
      seen.set(r.uid, r.key)
      if (was === undefined || was === r.key) continue
      const out = moveExpanded(next, was, r.key)
      if (!out) continue
      next = out
      moved = true
    }
    if (!moved) return
    const out = new Set(next)
    expandedRef.current = out
    setExpandedState(out)
    saveHierarchyExpanded(scopeKey, out)
  }, [rows, wholeScene, scopeKey])
  useEffect(() => {
    if (!lazy || deepRef.current.size === 0) return
    const byKey = new Map(rows.map((r) => [r.key, r]))
    const open: string[] = []
    for (const r of rows) {
      if (!lazyRow(r) || !collapsed.has(r.key) || deepDone.current.has(r.key)) continue
      for (let k: string | null = r.key; k; k = byKey.get(k)?.parent ?? null)
        if (deepRef.current.has(k)) {
          open.push(r.key)
          break
        }
    }
    if (open.length === 0) return
    const next = new Set(collapsed)
    for (const k of open) {
      next.delete(k)
      deepDone.current.add(k)
    }
    setCollapsed(collapsed, next)
  }, [rows, collapsed, lazy])
  const [treeQuery, setTreeQuery] = useState('')
  const [lookup, setLookup] = useState('')
  useEffect(() => {
    if (!lazy) return
    const t = setTimeout(() => setTreeQuery(query.trim()), query.trim() ? TREE_QUERY_MS : 0)
    return () => clearTimeout(t)
  }, [query, lazy])
  const [treeReveal, setTreeReveal] = useState<{ path: string; scene: string } | null>(null)
  const treeOpen = useMemo(() => {
    if (!lazy) return ''
    const out: string[] = []
    for (const r of visibleRows(rows, collapsed)) if (lazyRow(r) && !collapsed.has(r.key)) out.push(r.objectId!)
    return out.join('\n')
  }, [rows, collapsed, lazy])
  const loadingRows = useMemo(() => {
    if (!lazy || searching) return null
    let out: Set<string> | null = null
    for (let i = 0; i < shown.length; i++) {
      const r = shown[i]
      if (!lazyRow(r) || collapsed.has(r.key)) continue
      const next = shown[i + 1]
      if (next && next.depth > r.depth) continue
      ;(out ??= new Set()).add(r.key)
    }
    return out
  }, [shown, collapsed, lazy, searching])
  const waitingKids = loadingRows ? [...loadingRows].join('\n') : ''
  const loadingSince = useRef(new Map<string, number>())
  useEffect(() => {
    const since = loadingSince.current
    const now = performance.now()
    const names = (keys: string[]): string => keys.map((k) => k.split('/').pop()).join(', ')
    const done = [...since.keys()].filter((k) => !loadingRows?.has(k))
    for (const k of done) {
      const ms = Math.round(now - since.get(k)!)
      since.delete(k)
      if (ms > 300) console.info(`[hierarchy] children of ${names([k])} arrived after ${ms} ms`)
    }
    const started = [...(loadingRows ?? [])].filter((k) => !since.has(k))
    for (const k of started) since.set(k, now)
  }, [loadingRows])
  useEffect(() => {
    if (!lazy || !onTree) return
    const send = (): void =>
      onTree({
        open: treeOpen ? treeOpen.split('\n') : [],
        ...(treeQuery || lookup ? { query: treeQuery || lookup } : {}),
        ...(treeReveal ? { path: treeReveal.path, scene: treeReveal.scene } : {})
      })
    send()
    if (!waitingKids) return
    const t = setInterval(() => {
      console.info(`[hierarchy] still waiting for the children of ${waitingKids.split('\n').map((k) => k.split('/').pop()).join(', ')}, asking again`)
      send()
    }, TREE_RESEND_MS)
    return () => clearInterval(t)
  }, [lazy, onTree, treeOpen, treeQuery, treeReveal, lookup, waitingKids])
  const empty = rows.length === 0
  useEffect(() => {
    const el = listRef.current as (HTMLDivElement & { __tunerRows?: unknown }) | null
    if (!el) return
    el.__tunerRows = {
      rows: () => live.current.rows.map(rowInfo),
      shown: () => live.current.shown.map((r) => ({ ...rowInfo(r), ...(r.hasChildren ? { open: !live.current.collapsed.has(r.key) } : {}) })),
      list: () =>
        live.current.rows
          .filter((r) => r.kind === 'object' && r.path)
          .map((r) => ({ path: r.path, name: r.name, icon: r.icon ?? '', types: r.types ?? '', active: r.active, kids: r.hasChildren, depth: r.depth, key: r.key, scene: r.scene })),
      lookup: (text: string) => {
        if (!live.current.lazy) return false
        setLookup(String(text ?? '').trim())
        return true
      },
      find: (want: string) => {
        const hit = findTunerRow(live.current.rows.map(rowInfo), String(want))
        const uid = hit ? live.current.rows.find((r) => r.key === hit.key)?.uid : undefined
        return hit && uid ? { ...hit, uid } : hit
      },
      near: (want: string) => closestTunerRows(live.current.rows.map(rowInfo), String(want), 6, false),
      missing: (want: string) => {
        const { rows: all, lazy: lz, revealMissing: gone, waiting: busy } = live.current
        if (busy || all.length === 0) return false
        if (findTunerRow(all.map(rowInfo), String(want))) return false
        return lz ? gone === String(want).replace(/^\/+/, '') : true
      },
      sure: (want: string) => {
        const { lazy: lz, revealMissing: gone, waiting: busy } = live.current
        return !busy && !!lz && gone === String(want).replace(/^\/+/, '')
      },
      load: (want: string) => {
        if (!live.current.lazy) return false
        setTreeReveal({ path: String(want).replace(/^\/+/, ''), scene: '' })
        return true
      },
      open: (key: string) => {
        const { rows: all, collapsed: closed } = live.current
        const next = revealRow(all, closed, String(key))
        if (next) setCollapsed(closed, next)
        return true
      },
      where: (want: string) => {
        const list = listRef.current
        const { rows: all, shown: vis, collapsed: closed, lazy: lz } = live.current
        const w = String(want)
        const row = all.find((r) => r.uid === w) ?? all.find((r) => r.key === w) ?? null
        if (!row || !list) return null
        const at = vis.findIndex((r) => r.key === row.key)
        let pending = false
        if (lz) for (let i = 0; i < at && !pending; i++) if (lazyRow(vis[i]) && !closed.has(vis[i].key) && !(vis[i + 1] && vis[i + 1].depth > vis[i].depth)) pending = true
        const max = Math.max(0, list.scrollHeight - list.clientHeight)
        const top = at < 0 ? null : Math.min(max, onGrid(LIST_PAD + at * ROW_HEIGHT + (ROW_HEIGHT - list.clientHeight) / 2, false))
        return { key: row.key, uid: row.uid ?? null, at, pending, top, scrollTop: list.scrollTop, max }
      },
      top: (key: string) => {
        const list = listRef.current
        const at = live.current.shown.findIndex((r) => r.key === String(key))
        if (!list || at < 0) return null
        return onGrid(LIST_PAD + at * ROW_HEIGHT + (ROW_HEIGHT - list.clientHeight) / 2, false)
      },
      reveal: (key: string) => {
        const { rows: all, collapsed: closed } = live.current
        const next = revealRow(all, closed, String(key))
        if (next) setCollapsed(closed, next)
        revealScroll.current = String(key)
        setReveal((n) => n + 1)
        return true
      }
    }
    return () => {
      delete el.__tunerRows
    }
  }, [empty, storageKey])
  const marks = useMemo(() => hiddenChanges(rows, changed), [rows, changed])
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    paddingStart: LIST_PAD,
    paddingEnd: LIST_PAD,
    overscan: 12,
    useFlushSync: false
  })
  const fitHeight = (shown.length ? virtualizer.getTotalSize() : searching ? ROW_HEIGHT + 2 * LIST_PAD : 0) + (rows.length ? SEARCH_HEIGHT : 0)
  useEffect(() => {
    onFitHeight?.(fitHeight)
  }, [fitHeight, onFitHeight])
  const tree = useMemo(() => stickyTree(shown), [shown])

  const revealUnder = (index: number): void => {
    const el = listRef.current
    if (el) el.scrollTop = LIST_PAD + (index - stickyDepth(tree, index)) * ROW_HEIGHT
  }

  const onGrid = (y: number, up: boolean): number => Math.max(0, LIST_PAD + Math[up ? 'ceil' : 'round']((y - LIST_PAD) / ROW_HEIGHT) * ROW_HEIGHT)

  const scrollIntoView = (index: number): void => {
    const el = listRef.current
    if (!el) return
    const top = LIST_PAD + index * ROW_HEIGHT
    const under = top - stickyDepth(tree, index) * ROW_HEIGHT
    if (under < el.scrollTop) el.scrollTop = under
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = onGrid(top + ROW_HEIGHT - el.clientHeight, true)
  }

  const scrollToCenter = (index: number): void => {
    const el = listRef.current
    if (el) scrollTopTo(el, onGrid(LIST_PAD + index * ROW_HEIGHT + (ROW_HEIGHT - el.clientHeight) / 2, false))
  }

  const settling = useRef<{ key: string; at: number; center: boolean; until: number } | null>(null)
  const settle = (key: string, at: number, center: boolean): void => {
    settling.current = lazy ? { key, at, center, until: Date.now() + SETTLE_MS } : null
  }
  const pendingScroll = useRef<string | null>(null)
  useEffect(() => {
    pendingScroll.current = cursor
  }, [cursor])
  useEffect(() => {
    const key = pendingScroll.current
    if (!key) return
    const at = shown.findIndex((r) => r.key === key)
    if (at < 0) return
    pendingScroll.current = null
    scrollIntoView(at)
    settle(key, at, false)
  }, [cursor, shown, tree])

  const pingSeq = useRef(0)
  const pingScroll = useRef<string | null>(null)
  const pingWait = useRef<{ seq: number; at: number } | null>(null)
  const [pingTick, setPingTick] = useState(0)
  useEffect(() => {
    if (!ping || ping.seq === pingSeq.current) return
    const row = rowForPath(rows, ping.path, ping.scene)
    if (!row && lazy) {
      if (pingWait.current?.seq !== ping.seq) {
        pingWait.current = { seq: ping.seq, at: Date.now() }
        setTreeReveal({ path: ping.path, scene: ping.scene })
        setTimeout(() => setPingTick((n) => n + 1), REVEAL_WAIT_MS + 50)
        return
      }
      if (Date.now() - pingWait.current.at < REVEAL_WAIT_MS) return
    }
    pingSeq.current = ping.seq
    pingWait.current = null
    if (lazy) setTreeReveal(null)
    if (!row) {
      onPingMissing?.(ping.path, ping.scene)
      return
    }
    const next = revealRow(rows, collapsed, row.key)
    if (next) setCollapsed(collapsed, next)
    pingScroll.current = row.key
    setFlash({ key: row.key, seq: ping.seq })
  }, [ping, rows, pingTick])

  useEffect(() => {
    const key = pingScroll.current
    if (!key) return
    const at = shown.findIndex((r) => r.key === key)
    if (at < 0) return
    pingScroll.current = null
    scrollToCenter(at)
    settle(key, at, true)
  }, [flash, shown])

  useEffect(() => {
    const key = revealScroll.current
    if (!key) return
    const at = shown.findIndex((r) => r.key === key)
    if (at < 0) return
    revealScroll.current = null
    scrollToCenter(at)
    settle(key, at, true)
  }, [reveal, shown])

  useEffect(() => {
    const s = settling.current
    if (!s) return
    if (Date.now() > s.until) {
      settling.current = null
      return
    }
    const at = shown.findIndex((r) => r.key === s.key)
    if (at < 0 || at === s.at) return
    s.at = at
    if (s.center) scrollToCenter(at)
    else scrollIntoView(at)
  }, [shown])

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash((f) => (f === flash ? null : f)), PING_MS)
    return () => clearTimeout(t)
  }, [flash])

  const selectedRow = rowForObject(rows, selected)
  const selectedPaths = useMemo(() => JSON.stringify(selection.ids.map((id) => rowForObject(rows, id)?.path).filter(Boolean)), [rows, selection.ids])

  const forgetDeep = (key: string): void => {
    for (const set of [deepRef.current, deepDone.current]) for (const k of [...set]) if (k === key || k.startsWith(`${key}/`)) set.delete(k)
  }

  const toggle = (r: HierarchyRow, recursive: boolean): void => {
    const expand = collapsed.has(r.key)
    if (recursive) {
      forgetDeep(r.key)
      if (lazy && expand) deepRef.current.add(r.key)
    }
    setCollapsed(collapsed, toggleCollapsed(rows, collapsed, r.key, recursive), recursive && !expand ? [r.key] : undefined)
  }

  const lastClickedId = (): string | null => {
    const row = cursor ? rows.find((r) => r.key === cursor) : null
    return row?.objectId ?? selected
  }

  const selectableIds = (): string[] => selectableRows(shown).map((r) => r.objectId!)

  const apply = (ids: string[], clickedKey: string): void => {
    setCursor(clickedKey)
    onSelectionChange(hierarchySelection(ids))
  }

  const rowClick = (r: HierarchyRow, e: React.MouseEvent | React.KeyboardEvent, arrowKeys = false, fromKey = false): void => {
    if (!r.objectId) return
    const multi = (r.kind === 'object' || r.kind === 'ghost') && !r.error
    const range = e.shiftKey || (fromKey && actionKey(e))
    const toggleSel = !fromKey && actionKey(e)
    const next = handleMultiSelection({
      clicked: r.objectId,
      all: selectableIds(),
      selected: selection.ids,
      lastClicked: lastClickedId(),
      allowMulti: multi,
      range,
      toggle: toggleSel,
      arrowKeys
    })
    apply(next, r.key)
  }

  const contextClick = (r: HierarchyRow): void => {
    if (!r.objectId) return
    setCursor(r.key)
    if (selectedSet.has(r.objectId)) return
    onSelectionChange(hierarchySelection([r.objectId]))
  }

  const focusRow = (key: string, e: React.KeyboardEvent, arrowKeys: boolean): void => {
    const row = rows.find((r) => r.key === key)
    if (!row) return
    if (row.objectId && !row.error) rowClick(row, e, arrowKeys, true)
    else setCursor(key)
  }

  const offsetCursor = (e: React.KeyboardEvent, offset: number, arrowKeys: boolean): void => {
    const key = cursor ?? rowForObject(rows, selected)?.key ?? null
    const at = key ? shown.findIndex((r) => r.key === key) : -1
    const next = shown[Math.max(0, Math.min(shown.length - 1, at + offset))]
    if (next) focusRow(next.key, e, arrowKeys)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('input')) return
    if (hierarchyKeys(e)) return
    const k = e.key.toLowerCase()
    if (e.code === 'KeyC' && e.altKey && (isMac ? e.metaKey && !e.shiftKey && !e.ctrlKey : e.shiftKey && !e.ctrlKey && !e.metaKey)) {
      const r = (cursor ? rows.find((x) => x.key === cursor) : null) ?? rowForObject(rows, selected)
      if (!r?.path) return
      e.preventDefault()
      e.stopPropagation()
      copyPaths(r)
      return
    }
    if (actionKey(e) && !e.altKey && (k === 'a' || k === 'i')) {
      e.preventDefault()
      e.stopPropagation()
      const visible = selectableIds()
      const ids = k === 'a' ? visible : visible.filter((id) => !selectedSet.has(id))
      onSelectionChange(hierarchySelection(ids))
      return
    }
    if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && k === 'd') {
      e.preventDefault()
      e.stopPropagation()
      onSelectionChange(NO_SELECTION)
      return
    }
    if ((e.metaKey || e.ctrlKey) && !(e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End')) return
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && searching) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      e.stopPropagation()
      const expand = e.key === 'ArrowRight'
      if (selection.ids.length > 1) {
        let next = new Set(collapsed)
        const pruned: string[] = []
        for (const id of selection.ids) {
          const row = rowForObject(rows, id)
          if (!row?.hasChildren) continue
          next = setExpanded(rows, next, row.key, expand, e.altKey)
          if (e.altKey) forgetDeep(row.key)
          if (e.altKey && !expand) pruned.push(row.key)
        }
        setCollapsed(collapsed, next, pruned)
        return
      }
      const key = cursor ?? rowForObject(rows, selected)?.key ?? null
      if (!key) return
      const a = hierarchyKey(rows, collapsed, key, expand ? 'right' : 'left', e.altKey)
      if (!a) return
      if (e.altKey && a.kind === 'collapse') {
        forgetDeep(key)
        if (lazy && expand) deepRef.current.add(key)
      }
      if (a.kind === 'collapse') setCollapsed(collapsed, a.collapsed, e.altKey && !expand ? [key] : undefined)
      else focusRow(a.key, e, false)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      offsetCursor(e, e.key === 'ArrowDown' ? 1 : -1, true)
      return
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      e.stopPropagation()
      offsetCursor(e, e.key === 'End' ? 1_000_000 : -1_000_000, false)
      return
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault()
      e.stopPropagation()
      const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? ROW_HEIGHT * 10) / ROW_HEIGHT) - 1)
      offsetCursor(e, e.key === 'PageDown' ? page : -page, false)
    }
  }

  const clearRenameTimer = (): void => {
    if (renameTimer.current) clearTimeout(renameTimer.current)
    renameTimer.current = null
  }

  const refocus = (): void => listRef.current?.focus({ preventScroll: true })

  const op = (req: TunerHierarchyRequest): void => {
    if (!onHierarchyOp) return
    onHierarchyOp(req)
    refocus()
  }

  const editIds = (): string[] => rows.filter((r) => editableRow(r) && selectedSet.has(r.objectId!)).map((r) => r.objectId!)

  const activeEditRow = (): HierarchyRow | null => {
    const r = rowForObject(rows, selected)
    return r && editableRow(r) ? r : null
  }

  const lastScene = (): string => (rows.length ? rows[rows.length - 1].scene : '')

  const createAt = (parent: HierarchyRow | null, scene: string, primitive: TunerPrimitive = 'empty'): void => {
    if (parent?.objectId) op({ op: 'create', parent: parent.objectId, scene: parent.scene, primitive })
    else op({ op: 'create', parent: sceneParent(scene), scene, primitive })
  }

  const createBelow = (row: HierarchyRow, primitive: TunerPrimitive = 'empty'): void => {
    if (row.objectId) op({ op: 'create', after: row.objectId, scene: row.scene, primitive })
  }

  const removeSelected = (): void => {
    const ids = editIds()
    if (ids.length) op({ op: 'delete', ids })
  }

  const duplicateSelected = (): void => {
    const ids = editIds()
    if (ids.length) op({ op: 'duplicate', ids })
  }

  const startRename = (r: HierarchyRow | null): void => {
    clearRenameTimer()
    if (!r || !editableRow(r)) return
    const next = revealRow(rows, collapsed, r.key)
    if (next) setCollapsed(collapsed, next)
    setCursor(r.key)
    setRenaming(r.key)
  }

  const finishRename = (r: HierarchyRow, name: string | null): void => {
    setRenaming(null)
    const v = name?.trim()
    if (v && v !== ownName(r) && r.objectId) op({ op: 'rename', ids: [r.objectId], name: v })
    else refocus()
  }

  const copyPaths = (r: HierarchyRow): void => {
    const picked = r.objectId && selectedSet.has(r.objectId) ? rows.filter((x) => x.objectId && selectedSet.has(x.objectId)) : [r]
    const paths = [...new Set(picked.map((x) => x.path).filter(Boolean))]
    if (paths.length) void navigator.clipboard.writeText(paths.join('\n')).catch(() => {})
    refocus()
  }

  const openMenu = (e: React.MouseEvent, row: HierarchyRow | null, scene: string): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!editable && !row?.path) return
    clearRenameTimer()
    setMenuAlt(e.altKey)
    setMenu({ x: e.clientX, y: e.clientY, row, scene })
  }

  const finishDrag = (): void => {
    dragIds.current = null
    dragKeys.current = []
    setDrop(null)
    if (expandTimer.current) clearTimeout(expandTimer.current.t)
    expandTimer.current = null
  }

  const dragStart = (r: HierarchyRow, e: React.DragEvent): void => {
    if (!editable || !editableRow(r) || renaming) {
      e.preventDefault()
      return
    }
    clearRenameTimer()
    const id = r.objectId!
    const ids = selectedSet.has(id) ? editIds() : [id]
    if (!selectedSet.has(id)) apply([id], r.key)
    dragIds.current = ids
    dragKeys.current = rows.filter((x) => x.objectId && ids.includes(x.objectId)).map((x) => x.key)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(DRAG_TYPE, ids.join('\n'))
  }

  const zoneOf = (r: HierarchyRow, e: React.DragEvent): DropZone | null => {
    if (r.kind === 'scene') return 'into'
    if (!editableRow(r)) return null
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = (e.clientY - box.top) / Math.max(1, box.height)
    return y < 0.25 ? 'above' : y > 0.75 ? 'below' : 'into'
  }

  const planDrop = (r: HierarchyRow, zone: DropZone): DropPlan | null => {
    if (r.kind === 'scene') return { parent: r.key, scene: r.scene, before: '', order: true, parentKey: r.key }
    if (!editableRow(r)) return null
    if (zone === 'into') return { parent: r.objectId!, scene: r.scene, order: false, parentKey: r.key }
    if (zone === 'below' && r.hasChildren && !collapsed.has(r.key)) {
      const first = shown.find((x) => x.parent === r.key)
      if (first && !first.objectId) return null
      return { parent: r.objectId!, scene: r.scene, before: first?.objectId ?? '', order: true, parentKey: r.key }
    }
    const p = r.parent ? rows.find((x) => x.key === r.parent) : null
    let parent: string
    if (!p) parent = sceneParent(r.scene)
    else if (p.kind === 'scene') parent = p.key
    else if (editableRow(p)) parent = p.objectId!
    else return null
    if (zone === 'above') return { parent, scene: r.scene, before: r.objectId!, order: true, parentKey: r.parent }
    const at = rows.indexOf(r)
    let next: HierarchyRow | null = null
    for (let i = at + 1; i < rows.length; i++) {
      const x = rows[i]
      if (x.depth < r.depth) break
      if (x.depth === r.depth && x.parent === r.parent) {
        next = x
        break
      }
    }
    if (next && !editableRow(next)) return null
    return { parent, scene: r.scene, before: next?.objectId ?? '', order: true, parentKey: r.parent }
  }

  const planOk = (p: DropPlan): boolean =>
    !p.parentKey || !dragKeys.current.some((k) => p.parentKey === k || p.parentKey!.startsWith(`${k}/`))

  const markDrop = (key: string, zone: DropZone): void => {
    setDrop((d) => (d && d.key === key && d.zone === zone ? d : { key, zone }))
  }

  const dragOver = (r: HierarchyRow, e: React.DragEvent): void => {
    if (!dragIds.current) return
    e.stopPropagation()
    const zone = zoneOf(r, e)
    const plan = zone ? planDrop(r, zone) : null
    if (!zone || !plan || !planOk(plan)) {
      e.dataTransfer.dropEffect = 'none'
      setDrop(null)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    markDrop(r.key, zone)
    const wantsOpen = zone === 'into' && r.hasChildren && collapsed.has(r.key)
    if (expandTimer.current && (!wantsOpen || expandTimer.current.key !== r.key)) {
      clearTimeout(expandTimer.current.t)
      expandTimer.current = null
    }
    if (wantsOpen && !expandTimer.current) {
      const key = r.key
      expandTimer.current = {
        key,
        t: setTimeout(() => {
          expandTimer.current = null
          const { rows: all, collapsed: closed } = live.current
          if (closed.has(key)) setCollapsed(closed, toggleCollapsed(all, closed, key, false))
        }, EXPAND_DELAY_MS)
      }
    }
  }

  const dropOn = (r: HierarchyRow, e: React.DragEvent): void => {
    if (!dragIds.current) return
    e.preventDefault()
    e.stopPropagation()
    const ids = dragIds.current
    const zone = zoneOf(r, e)
    const plan = zone ? planDrop(r, zone) : null
    const ok = !!plan && planOk(plan)
    finishDrag()
    if (!ok || !plan) return
    op({ op: 'move', ids, parent: plan.parent, scene: plan.scene, ...(plan.order ? { before: plan.before ?? '', order: true } : {}) })
  }

  const noDrop = (e: React.DragEvent): void => {
    if (!dragIds.current) return
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'none'
    setDrop(null)
  }

  const dragOverEmpty = (e: React.DragEvent): void => {
    if (!dragIds.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    markDrop('', 'root')
  }

  const dropEmpty = (e: React.DragEvent): void => {
    if (!dragIds.current) return
    e.preventDefault()
    const ids = dragIds.current
    finishDrag()
    const scene = lastScene()
    op({ op: 'move', ids, parent: sceneParent(scene), scene, before: '', order: true })
  }

  const hierarchyKeys = (e: React.KeyboardEvent<HTMLDivElement>): boolean => {
    if (!editable) return false
    const k = e.key.toLowerCase()
    const meta = actionKey(e)
    const stop = (): true => {
      e.preventDefault()
      e.stopPropagation()
      return true
    }
    if (meta && !e.altKey && (k === 'z' || k === 'y')) {
      if (!onUndo) return false
      stop()
      onUndo(k === 'y' || e.shiftKey)
      return true
    }
    if (meta && !e.altKey && !e.shiftKey && k === 'd') {
      stop()
      duplicateSelected()
      return true
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.altKey && !e.shiftKey) {
      stop()
      removeSelected()
      return true
    }
    if (e.key === 'F2' || (isMac && e.key === 'Enter' && !meta && !e.shiftKey && !e.altKey)) {
      const r = activeEditRow()
      if (!r) return false
      stop()
      startRename(r)
      return true
    }
    if (e.code === 'KeyN' && e.shiftKey && meta && !e.altKey) {
      stop()
      createAt(null, activeEditRow()?.scene ?? lastScene())
      return true
    }
    if (e.code === 'KeyN' && e.shiftKey && e.altKey && !meta) {
      stop()
      const r = activeEditRow()
      createAt(r, r?.scene ?? lastScene())
      return true
    }
    return false
  }

  const menuRow = menu?.row ?? null
  const runMenu = (fn: () => void) => (): void => {
    setMenu(null)
    fn()
  }
  const menuEdit = editable && !!menuRow && editableRow(menuRow)
  const menuCreate = editable && (!menuRow || editableRow(menuRow))
  const menuView = menu && (
    <FloatingMenu x={menu.x} y={menu.y} onDismiss={() => setMenu(null)}>
      {menuEdit && menuRow && (
        <>
          <button className={menuItemClass} onClick={runMenu(() => startRename(menuRow))}>
            Rename
            <Hint>{isMac ? '↩' : 'F2'}</Hint>
          </button>
          <button className={menuItemClass} onClick={runMenu(duplicateSelected)}>
            Duplicate
            <Hint>{isMac ? '⌘D' : 'Ctrl+D'}</Hint>
          </button>
          <button className={menuItemClass} onClick={runMenu(removeSelected)}>
            Delete
            <Hint>{isMac ? '⌘⌫' : 'Del'}</Hint>
          </button>
          <MenuSeparator />
        </>
      )}
      {menuRow?.path && (
        <>
          <button className={menuItemClass} data-hierarchy-copy-path onClick={runMenu(() => copyPaths(menuRow))}>
            Copy Path
            <Hint>{isMac ? '⌥⌘C' : 'Shift+Alt+C'}</Hint>
          </button>
          {menuRow.prefabAsset && onOpenPrefab && (
            <button className={menuItemClass} data-hierarchy-open-prefab onClick={runMenu(() => menuRow.prefabAsset && onOpenPrefab(menuRow.prefabAsset))}>
              Open Prefab Asset
            </button>
          )}
          {menuCreate && <MenuSeparator />}
        </>
      )}
      {menuCreate && !(menuAlt && menuRow?.objectId) && (
        <button className={menuItemClass} data-hierarchy-create="empty" onClick={runMenu(() => createAt(menuRow, menu.scene))}>
          Create Empty
          {!menuRow && <Hint>{isMac ? '⇧⌘N' : 'Ctrl+Shift+N'}</Hint>}
        </button>
      )}
      {menuCreate && menuRow?.objectId && (
        <button
          className={menuItemClass}
          data-hierarchy-create-below="empty"
          title={`Create a new object right below this one, at the same level. Hold ${isMac ? 'Option' : 'Alt'} to create any object below.`}
          onClick={runMenu(() => createBelow(menuRow))}
        >
          Create Empty Below
        </button>
      )}
      {menuCreate && <MenuLabel>3D Object</MenuLabel>}
      {menuCreate && PRIMITIVES.map(([kind, label]) => {
        const below = menuAlt && !!menuRow?.objectId
        return (
          <button
            key={kind}
            className={`${menuItemClass} pl-5`}
            data-hierarchy-create={kind}
            onClick={runMenu(() => (below && menuRow ? createBelow(menuRow, kind) : createAt(menuRow, menu.scene, kind)))}
          >
            {below ? `${label} Below` : label}
          </button>
        )
      })}
      {menuCreate && <MenuLabel>Camera and Light</MenuLabel>}
      {menuCreate && ([['camera', 'Camera'], ...LIGHTS] as [TunerPrimitive, string][]).map(([kind, label]) => {
        const below = menuAlt && !!menuRow?.objectId
        return (
          <button
            key={kind}
            className={`${menuItemClass} pl-5`}
            data-hierarchy-create={kind}
            onClick={runMenu(() => (below && menuRow ? createBelow(menuRow, kind) : createAt(menuRow, menu.scene, kind)))}
          >
            {below ? `${label} Below` : label}
          </button>
        )
      })}
      {menuCreate && onAddFromProject && (
        <>
          <MenuSeparator />
          <button
            className={menuItemClass}
            data-hierarchy-add-asset
            title="Add a prefab or model from the project to the scene, like dragging it from Unity's Project window"
            onClick={runMenu(() =>
              onAddFromProject({
                parent: menuRow?.objectId ?? sceneParent(menu.scene),
                scene: menuRow?.objectId ? menuRow.scene : menu.scene,
                x: menu.x,
                y: menu.y
              })
            )}
          >
            Add from Project…
          </button>
        </>
      )}
    </FloatingMenu>
  )

  const renderRow = (r: HierarchyRow, index: number, place: CSSProperties, stuck: boolean): ReactNode => {
    const pad = { paddingLeft: 2 + r.depth * 12, ...place }
    const ids = stuck
      ? { 'data-sticky-key': r.key, 'data-sticky-depth': r.depth, 'data-sticky-name': r.name }
      : { 'data-row-key': r.key, 'data-row-depth': r.depth, 'data-row-name': r.name }
    const unstick = (): void => {
      if (stuck) revealUnder(index)
    }
    const isCollapsed = r.hasChildren && collapsed.has(r.key)
    const rowLoading = !isCollapsed && !!loadingRows?.has(r.key)
    const isCursor = r.key === cursor
    const flashed = flash?.key === r.key
    const pingMark = flashed && <span key={flash.seq} data-ping-flash className="tuner-ping pointer-events-none absolute inset-0 rounded-sm" />
    const chevron = r.hasChildren ? (
      <button
        type="button"
        tabIndex={-1}
        data-chevron
        aria-label={isCollapsed ? 'Expand' : 'Collapse'}
        title={isCollapsed ? 'Expand (Alt-click: expand all below)' : 'Collapse (Alt-click: collapse all below)'}
        onClick={(e) => {
          e.stopPropagation()
          unstick()
          listRef.current?.focus({ preventScroll: true })
          toggle(r, e.altKey)
          if (e.shiftKey || actionKey(e) || !r.objectId || r.error) setCursor(r.key)
          else apply([r.objectId], r.key)
        }}
        data-row-loading={rowLoading ? 'true' : undefined}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
      >
        {rowLoading ? (
          <span role="status" aria-label="Loading its children" className="tuner-row-loading h-2.5 w-2.5 rounded-full border-[1.5px] border-white/15 border-t-white/70" />
        ) : (
          <ChevronRight className={`h-3 w-3 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
        )}
      </button>
    ) : (
      <span className="h-4 w-4 shrink-0" />
    )
    const hiddenDot = isCollapsed && marks.has(r.key) && (
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400/35" title="Changed objects inside" />
    )
    const dropHere = drop && drop.key === r.key ? drop.zone : null
    const cursorRing = dropHere === 'into' ? ' ring-1 ring-inset ring-sky-400 bg-sky-500/10' : isCursor ? ' ring-1 ring-inset ring-white/15' : ''
    const lineIndent = 2 + (r.depth + (dropHere === 'below' && r.hasChildren && !isCollapsed ? 1 : 0)) * 12 + 16
    const dropLine = (dropHere === 'above' || dropHere === 'below') && (
      <span
        data-hierarchy-drop={dropHere}
        className={`pointer-events-none absolute right-1 h-0.5 rounded bg-sky-400 ${dropHere === 'above' ? 'top-0' : 'bottom-0'}`}
        style={{ left: lineIndent }}
      />
    )
    if (r.kind === 'scene' || r.kind === 'assets' || r.kind === 'ghosts') {
      const isScene = r.kind === 'scene'
      const HeadIcon = r.kind === 'assets' ? Package : r.kind === 'ghosts' ? ScanSearch : r.prefab === 'variant' ? UnityPrefabVariantIcon : /\.prefab$/i.test(r.scene) ? UnityPrefabIcon : UnitySceneIcon
      return (
        <div
          key={r.key}
          {...ids}
          style={pad}
          onClick={() => {
            unstick()
            setCursor(r.key)
          }}
          onContextMenu={(e) => (r.kind === 'scene' ? openMenu(e, null, r.scene) : e.preventDefault())}
          onDragOver={(e) => (r.kind === 'scene' ? dragOver(r, e) : noDrop(e))}
          onDrop={(e) => (r.kind === 'scene' ? dropOn(r, e) : noDrop(e))}
          title={r.kind === 'ghosts' ? 'Objects you pinged in the inspector that are not in this Tuner' : undefined}
          data-scene-row={isScene ? r.scene : undefined}
          className={`absolute left-0 right-0 top-0 flex h-6 items-center gap-1 pr-2 ${
            isScene ? 'text-xs font-medium text-zinc-300' : 'text-[10px] font-semibold uppercase tracking-wide text-zinc-500'
          }${cursorRing}`}
        >
          {chevron}
          <HeadIcon className={`shrink-0 ${isScene ? `h-3.5 w-3.5 ${/\.prefab$/i.test(r.scene) ? 'text-[#7cb4ff]' : 'text-zinc-400'}` : 'h-3 w-3'}`} />
          <span className="truncate">{r.name}</span>
          {hiddenDot}
        </div>
      )
    }
    if (r.kind === 'group') {
      const GroupIcon = r.icon ? componentIcon(r.icon) : Box
      return (
        <div
          key={r.key}
          {...ids}
          {...(stuck ? {} : { 'data-row-group': r.count })}
          style={pad}
          onClick={() => {
            unstick()
            setCursor(r.key)
          }}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest('[data-chevron]')) return
            toggle(r, false)
          }}
          onContextMenu={(e) => e.preventDefault()}
          onDragOver={noDrop}
          onDrop={noDrop}
          className={`absolute left-0 right-0 top-0 flex h-6 cursor-default items-center gap-1 pr-2 text-xs text-zinc-300 hover:bg-white/5${cursorRing}`}
          title={`${r.count} copies of ${r.name} created at runtime. Expand to see them.`}
        >
          {chevron}
          <GroupIcon className="h-3 w-3 shrink-0 text-sky-400/60" />
          <span className="truncate italic">{r.name}</span>
          <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">×{r.count}</span>
          {hiddenDot}
          <RuntimeTag />
        </div>
      )
    }
    if (r.kind === 'ancestor') {
      return (
        <div
          key={r.key}
          {...ids}
          style={pad}
          onClick={() => {
            unstick()
            setCursor(r.key)
            if (onOpenPath && r.path) onOpenPath(r.path, r.scene)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setCursor(r.key)
            if (r.path) openMenu(e, r, r.scene)
          }}
          onDragOver={noDrop}
          onDrop={noDrop}
          className={`absolute left-0 right-0 top-0 flex h-6 items-center gap-1 pr-2 text-xs text-zinc-600 hover:bg-white/5 hover:text-zinc-400${cursorRing}`}
          title={contextOnly ? 'Outside the filter, shown for context only. Clear the filter to edit it.' : 'Parent object the agent did not pick. Click to inspect it.'}
        >
          {pingMark}
          {chevron}
          <Folder className="h-3 w-3 shrink-0" />
          <span className="truncate">{r.name}</span>
          {hiddenDot}
        </div>
      )
    }
    const isSel = !!r.objectId && selectedSet.has(r.objectId)
    const isActive = !!r.objectId && r.objectId === selected
    const ghost = r.kind === 'ghost'
    const dimTip = dimRow && r.kind === 'object' && r.path ? dimRow(r.path, r.scene) : null
    const untargeted = !ghost && !r.targeted && !r.error
    const prefab = r.kind === 'object' ? r.prefab : undefined
    const pf = r.kind === 'object' ? r.pf ?? 0 : 0
    const added = (pf & TUNER_PF_ADDED) !== 0
    const staging = r.kind === 'object' && !!r.staging
    const prefabTint = staging ? 'text-violet-300' : prefab === 'missing' ? 'text-red-400' : prefab || (pf & TUNER_PF_PART) !== 0 ? 'text-[#7cb4ff]' : ''
    const Icon = r.kind === 'asset' ? FileCog : staging ? UnityStagingPrefabIcon : prefab === 'variant' ? UnityPrefabVariantIcon : prefab ? UnityPrefabIcon : r.icon ? componentIcon(r.icon) : Box
    return (
      <div
        key={r.key}
        {...ids}
        {...(stuck
          ? {}
          : {
              'data-row-path': r.path || undefined,
              'data-row-error': r.error || undefined,
              'data-targeted': r.targeted ? 'true' : 'false',
              'data-selected': isSel ? 'true' : undefined,
              'data-active': isActive ? 'true' : undefined,
              'data-ghost': ghost ? (r.objectId ?? '') : undefined,
              'data-runtime': r.runtime ? 'true' : undefined,
              'data-prefab': prefab,
              'data-staging': staging ? 'true' : undefined,
              'data-prefab-added': added ? 'true' : undefined,
              'data-prefab-overrides': pf & TUNER_PF_OVERRIDES ? 'true' : undefined,
              'data-canvas-filtered': dimTip ? 'true' : undefined,
              'data-ti-tip': dimTip ?? undefined
            })}
        style={pad}
        role="button"
        aria-label={r.name || undefined}
        draggable={editable && editableRow(r) && renaming !== r.key}
        onDragStart={(e) => dragStart(r, e)}
        onDragEnd={finishDrag}
        onDragOver={(e) => dragOver(r, e)}
        onDrop={(e) => dropOn(r, e)}
        onMouseDown={(e) => {
          soleRef.current =
            e.button === 0 &&
            !e.shiftKey &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.altKey &&
            editable &&
            editableRow(r) &&
            selection.ids.length === 1 &&
            selected === r.objectId
        }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('[data-ghost-action], [data-prefab-open]')) return
          unstick()
          if (!r.objectId) {
            setCursor(r.key)
            return
          }
          rowClick(r, e)
          clearRenameTimer()
          if (soleRef.current && (e.target as HTMLElement).closest('[data-row-label]'))
            renameTimer.current = setTimeout(() => startRename(r), RENAME_DELAY_MS)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          contextClick(r)
          if (r.path) openMenu(e, r, r.scene)
        }}
        onDoubleClick={(e) => {
          clearRenameTimer()
          if ((e.target as HTMLElement).closest('[data-chevron], [data-ghost-action], [data-prefab-open]')) return
          if (r.kind === 'asset' && r.prefabAsset && onOpenPrefab) onOpenPrefab(r.prefabAsset)
          else if (r.objectId && !r.error) onFocusObject?.(r.objectId)
        }}
        title={
          r.error ??
          (prefab === 'missing'
            ? 'Missing prefab. Its asset was deleted or moved.'
            : added
            ? 'Added to this prefab instance. It is not in the prefab asset.'
            : ghost
            ? `${r.path}\nNot in this Tuner. You pinged it in the inspector.`
            : untargeted
              ? 'You opened this. The agent did not pick it.'
              : r.kind === 'asset'
                ? r.path
                : r.env
                  ? 'Prefab Mode environment. It is not part of the prefab and is never saved.'
                  : r.runtime
                  ? `Created at runtime in Play Mode. It is not in the scene file.${r.active ? '' : ' Inactive in hierarchy.'}`
                  : r.active
                  ? undefined
                  : 'Inactive in hierarchy')
        }
        className={`group absolute left-0 right-0 top-0 flex h-6 cursor-default items-center gap-1 pr-2 text-left text-xs transition-colors ${
          isSel ? 'bg-sky-500/20 text-sky-200' : 'text-zinc-200 hover:bg-white/5'
        } ${ghost || ((r.active || r.error) && !r.env) ? '' : 'opacity-50'}${cursorRing}`}
      >
        {pingMark}
        {dropLine}
        {pf & TUNER_PF_OVERRIDES ? (
          <span
            data-prefab-bar
            className={`pointer-events-none absolute bottom-px left-0 top-px w-0.5 ${isSel ? 'bg-zinc-300/80' : 'bg-[#0199eb]/75'}`}
            title="This prefab instance has overrides"
          />
        ) : null}
        {chevron}
        <span className={`flex min-w-0 flex-1 items-center gap-1${ghost || dimTip ? ' opacity-50' : ''}`}>
          {r.error ? (
            <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />
          ) : (
            <span className="relative flex shrink-0 items-center">
              <Icon
                className={`${prefab ? 'h-4 w-4' : 'h-3 w-3'} shrink-0 ${prefabTint || (untargeted || ghost ? 'text-zinc-500' : isSel ? 'text-sky-300' : 'text-sky-400/80')}`}
              />
              {added && <UnityPrefabAddedBadge className="absolute -bottom-1 -left-1" />}
            </span>
          )}
          {renaming === r.key && !stuck ? (
            <RenameInput initial={ownName(r)} onDone={(name) => finishRename(r, name)} />
          ) : (
            <span
              data-row-label
              className={`truncate${searching ? ' max-w-[80%] shrink-0' : ''} ${r.error ? 'text-amber-200/80 line-through decoration-amber-400/40' : untargeted || ghost ? `italic ${prefabTint || 'text-zinc-400'}` : r.runtime ? `italic ${prefabTint}` : prefabTint}`}
              style={ghost ? { direction: 'rtl', textAlign: 'left' } : undefined}
            >
              {ghost ? <bdi>{r.name}</bdi> : r.name}
            </span>
          )}
          {r.label &&
            (searching ? (
              <span className="min-w-0 truncate text-[10px] text-zinc-500" style={{ direction: 'rtl', textAlign: 'left' }}>
                <bdi>{r.label}</bdi>
              </span>
            ) : (
              <span className="truncate text-[10px] text-zinc-500">{r.label}</span>
            ))}
        </span>
        {r.objectId && changed?.has(r.objectId) && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400/70" title="Changed in this state" />
        )}
        {!(r.objectId && changed?.has(r.objectId)) && hiddenDot}
        {r.error && <span className="ml-auto shrink-0 text-[10px] text-amber-300/80">missing</span>}
        {r.prefabAsset && onOpenPrefab && !ghost && (
          <button
            type="button"
            tabIndex={-1}
            data-prefab-open={r.prefabAsset}
            onClick={(e) => {
              e.stopPropagation()
              if (r.prefabAsset) onOpenPrefab(r.prefabAsset)
            }}
            data-ti-tip={`Open ${r.prefabAsset.split('/').pop()}`}
            aria-label="Open Prefab Asset"
            className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
        )}
        {r.runtime && !groupedRow(r) && <RuntimeTag />}
        {ghost && r.objectId && (
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              tabIndex={-1}
              data-ghost-action="add"
              disabled={!!ghostAddBlocked}
              onClick={() => r.objectId && onGhostAdd?.(r.objectId)}
              data-ti-tip={ghostAddBlocked ?? 'Add it to this Tuner. The view keeps it and agents can see it.'}
              aria-label="Add to Tuner"
              className="flex h-4 w-4 items-center justify-center rounded text-zinc-400 hover:bg-white/10 hover:text-zinc-100 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <Plus className="h-3 w-3" />
            </button>
            <button
              type="button"
              tabIndex={-1}
              data-ghost-action="dismiss"
              onClick={() => r.objectId && onGhostDismiss?.(r.objectId)}
              data-ti-tip="Dismiss"
              aria-label="Dismiss"
              className="flex h-4 w-4 items-center justify-center rounded text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
      </div>
    )
  }

  const renderSticky = (p: StickyRow, z: number): ReactNode => {
    const r = shown[p.index]
    if (!r) return null
    return (
      <div key={r.key} className="absolute left-0 right-0 h-6 bg-canvas" style={{ top: p.position, zIndex: z }}>
        <div className="absolute inset-0 bg-sunken/60" />
        {renderRow(r, p.index, NO_PLACE, true)}
      </div>
    )
  }

  if (rows.length === 0) {
    const what = wholeScene ? 'The scene shows' : 'The picked objects show'
    const empty = (
      <div
        className="h-full px-3 py-2 text-[11px] text-zinc-500"
        onContextMenu={(e) => (wholeScene ? openMenu(e, null, '') : e.preventDefault())}
      >
        {waiting ? `${what} up once Unity is connected` : wholeScene ? 'The scene is empty' : 'The view picks no objects'}
        {menuView}
      </div>
    )
    if (!headerExtra) return empty
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center justify-end px-1.5" style={{ height: SEARCH_HEIGHT }}>
          {headerExtra}
        </div>
        <div className="min-h-0 flex-1">{empty}</div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div data-hierarchy-search-bar className="flex shrink-0 items-center px-1.5" style={{ height: SEARCH_HEIGHT }}>
        <label className="flex h-[22px] min-w-0 flex-1 items-center gap-1.5 rounded-md bg-sunken px-2 text-ink-3 focus-within:text-ink-2">
          <Search className="h-3 w-3 shrink-0" />
          <input
            ref={searchRef}
            data-hierarchy-search
            value={query}
            spellCheck={false}
            placeholder="Search"
            aria-label="Search the hierarchy"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault()
                e.stopPropagation()
                endSearch()
              } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                e.preventDefault()
                listRef.current?.focus()
                const first = shown.find((r) => r.objectId)
                if (first && (e.key === 'Enter' || !cursor)) {
                  setCursor(first.key)
                  if (e.key === 'Enter') rowClick(first, e)
                }
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3"
          />
          {query && (
            <button
              type="button"
              tabIndex={-1}
              aria-label="Clear search"
              onClick={endSearch}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-white/10 hover:text-ink"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </label>
        {onRestoreFilter && (
          <button
            type="button"
            data-tuner-restore-filter
            aria-label="Restore the filter"
            data-ti-tip={restoreFilterTip}
            onClick={onRestoreFilter}
            className="ml-1 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-white/10 hover:text-ink"
          >
            <Filter className="h-3 w-3" />
          </button>
        )}
        {headerExtra}
      </div>
      {capped > 0 && <div className="px-3 py-1 text-[11px] text-ink-3" data-hierarchy-capped={capped}>This scene is too big to list in full, so some objects below level {capped} aren't listed</div>}
      {searching && shown.length === 0 && <div className="px-3 py-1.5 text-[11px] text-ink-3">No objects match "{query.trim()}"</div>}
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto outline-none"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') {
            e.preventDefault()
            e.stopPropagation()
            searchRef.current?.focus()
            searchRef.current?.select()
            return
          }
          if (e.key === 'Escape' && searching) {
            e.preventDefault()
            e.stopPropagation()
            endSearch()
            return
          }
          onKeyDown(e)
        }}
        onContextMenu={(e) => openMenu(e, null, lastScene())}
        onDragOver={dragOverEmpty}
        onDrop={dropEmpty}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDrop(null)
        }}
        data-scene-hierarchy
        data-row-count={shown.length}
        data-total-rows={rows.length}
        data-selected-count={selection.ids.length}
        data-selected-path={selectedRow?.path || undefined}
        data-selected-paths={selectedPaths}
        data-selected-scene={selectedRow ? selectedRow.scene : undefined}
      >
        <StickyLayer tree={tree} render={renderSticky} />
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {drop?.zone === 'root' && (
            <span
              data-hierarchy-drop="root"
              className="pointer-events-none absolute left-1 right-1 h-0.5 rounded bg-sky-400"
              style={{ top: virtualizer.getTotalSize() - LIST_PAD - 1 }}
            />
          )}
          {virtualizer.getVirtualItems().map((v) =>
            renderRow(shown[v.index], v.index, { transform: `translateY(${v.start}px)` }, false)
          )}
        </div>
      </div>
      {menuView}
    </div>
  )
})
