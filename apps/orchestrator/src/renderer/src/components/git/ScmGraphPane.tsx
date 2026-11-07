import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useFloating } from '../../lib/floating'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  GitBranch,
  GitCompare,
  FileText,
  History,
  LoaderCircle,
  RefreshCw,
  Search,
  Tag,
  Target,
  X,
  type LucideIcon
} from 'lucide-react'
import type { Change, Commit, ScmDiffStat, ScmGitError, ScmGraphFilter, ScmLogSearchMode } from '@shared/git-scm'
import {
  SCMIncomingHistoryItemId,
  SCMOutgoingHistoryItemId,
  getHistoryItemIndex,
  historyItemHoverAdditionsForeground,
  historyItemHoverDefaultLabelBackground,
  historyItemHoverDefaultLabelForeground,
  historyItemHoverDeletionsForeground,
  historyItemHoverLabelForeground,
  renderSCMHistoryGraphPlaceholder,
  renderSCMHistoryItemGraph,
  toISCMHistoryItemViewModelArray,
  type HistoryItemRefIcon,
  type ISCMHistoryItem,
  type ISCMHistoryItemGraphNode,
  type ISCMHistoryItemRef,
  type ISCMHistoryItemViewModel
} from '../../lib/git/scm-history'
import {
  getGraphColorMap,
  provideHistoryItemRefs,
  resolveCurrentHistoryItemRefs,
  toHistoryItem
} from '../../lib/git/history-provider'
import {
  getHistoryChangeDiffSides,
  getStatusColor,
  getStatusLetter,
  getStatusText,
  getStrikeThrough,
  joinPath,
  revealLabel,
  type DiffSides
} from '../../lib/git/scm-resource'
import { openFileInWorkbench } from '../../lib/editor/open-file'
import { FloatingMenu, MenuSeparator, menuItemClass } from '../ui/FloatingMenu'
import {
  ResourceTree,
  countFiles,
  descendantFolderPaths,
  flattenResourceTree,
  type IResourceNode
} from '../../lib/git/resource-tree'
import { GitGraphSvg } from './GitGraphSvg'
import { Tooltip, useCopyHint } from '../ui/Tooltip'
import type { ScmRepository } from './use-scm-repository'
import { useListSelection } from './use-list-selection'

const PAGE_SIZE = 50
const FOLDER_PAGE = 50
const SMALL_COMMIT = 100
const ROW_HEIGHT = 22
const SEARCH_LIMIT = 200
const GUTTER = 18
const INDENT = 8

type HistoryFilter = ScmGraphFilter

interface ChangesEntry {
  readonly loading: boolean
  readonly changes: Change[]
  readonly error?: ScmGitError
  readonly parentRef?: string
  readonly ref?: string
  readonly tree?: ResourceTree<Change>
  readonly counts?: Map<string, number>
  readonly stats: ReadonlyMap<string, ScmDiffStat>
  readonly compare?: boolean
}

interface Comparison {
  readonly base: ISCMHistoryItem
  readonly target: ISCMHistoryItem
}

const COMPARE_PREFIX = 'compare:'

const NO_STATS: ReadonlyMap<string, ScmDiffStat> = new Map()

type Row =
  | { readonly type: 'item'; readonly vm: ISCMHistoryItemViewModel }
  | { readonly type: 'compare'; readonly vm: ISCMHistoryItemViewModel; readonly comparison: Comparison; readonly entry?: ChangesEntry; readonly collapsed: boolean }
  | { readonly type: 'message'; readonly vm: ISCMHistoryItemViewModel; readonly entry?: ChangesEntry }
  | {
      readonly type: 'folder'
      readonly vm: ISCMHistoryItemViewModel
      readonly path: string
      readonly label: string
      readonly depth: number
      readonly collapsed: boolean
      readonly node: IResourceNode<Change>
      readonly count?: number
    }
  | {
      readonly type: 'change'
      readonly vm: ISCMHistoryItemViewModel
      readonly change: Change
      readonly depth: number
      readonly parentRef?: string
      readonly ref: string
    }
  | { readonly type: 'status'; readonly vm: ISCMHistoryItemViewModel; readonly text: string }
  | { readonly type: 'hidden'; readonly vm: ISCMHistoryItemViewModel; readonly count: number }
  | {
      readonly type: 'more'
      readonly vm: ISCMHistoryItemViewModel
      readonly path: string
      readonly remaining: number
      readonly depth: number
    }
  | { readonly type: 'loadMore'; readonly columns: ISCMHistoryItemGraphNode[] }

type SelRow = Extract<Row, { type: 'item' } | { type: 'folder' } | { type: 'change' }>

function rowKey(row: Row): string | null {
  if (row.type === 'item') return `c:${row.vm.historyItem.id}`
  if (row.type === 'folder') return `d:${row.vm.historyItem.id}:${row.path}`
  if (row.type === 'change') return `f:${row.vm.historyItem.id}:${row.change.path}`
  return null
}

function isSynthetic(item: ISCMHistoryItem): boolean {
  return item.id === SCMIncomingHistoryItemId || item.id === SCMOutgoingHistoryItemId || item.id.startsWith(COMPARE_PREFIX)
}

function messageEntry(item: ISCMHistoryItem): string {
  const lines = (item.message || item.subject).trim().split(/\r?\n/)
  return [`- ${lines[0]}`, ...lines.slice(1).map((l) => (l.trim() ? `  ${l}` : ''))].join('\n')
}

function shortId(item: ISCMHistoryItem): string {
  return item.displayId ?? item.id.substring(0, 7)
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

const REF_ICONS: Record<HistoryItemRefIcon, LucideIcon> = {
  head: Target,
  branch: GitBranch,
  remoteBranch: Cloud,
  tag: Tag
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list) list.push(item)
    else out.set(k, [item])
  }
  return out
}

function Badge({ refs, showDescription }: { refs: ISCMHistoryItemRef[]; showDescription: boolean }) {
  const first = refs[0]
  if (!first?.icon) return null
  const Icon = REF_ICONS[first.icon]
  return (
    <div
      className="label"
      title={refs.map((r) => r.name).join(', ')}
      style={{
        color: first.color ? historyItemHoverLabelForeground : historyItemHoverDefaultLabelForeground,
        backgroundColor: first.color ?? historyItemHoverDefaultLabelBackground
      }}
    >
      {refs.length > 1 && <div className="count">{refs.length}</div>}
      <Icon className="icon" size={18} strokeWidth={2.25} />
      {showDescription && <div className="description">{first.name}</div>}
    </div>
  )
}

function Badges({ item }: { item: ISCMHistoryItem }) {
  const references = item.references ? item.references.slice(0) : []
  const badges: { key: string; refs: ISCMHistoryItemRef[]; showDescription: boolean }[] = []

  if (references.length > 0 && references[0].color) {
    badges.push({ key: `first:${references[0].id}`, refs: [references[0]], showDescription: true })
    references.splice(0, 1)
  }

  for (const [color, byColor] of groupBy(references, (ref) => ref.color ?? '')) {
    if (color === '') continue
    for (const [icon, byIcon] of groupBy(byColor, (ref) => ref.icon ?? '')) {
      if (icon === '') continue
      badges.push({ key: `${color}:${icon}`, refs: byIcon, showDescription: false })
    }
  }

  if (badges.length === 0) return null
  return (
    <div className="label-container">
      {badges.map((b) => (
        <Badge key={b.key} refs={b.refs} showDescription={b.showDescription} />
      ))}
    </div>
  )
}

function buildTree(changes: Change[]): ResourceTree<Change> {
  const tree = new ResourceTree<Change>()
  for (const change of changes) tree.add(change.path, change)
  return tree
}

function folderKey(id: string, path: string): string {
  return `${id}:${path}`
}

export function ScmGraphPane({
  repo,
  onOpenDiff,
  onShowHistory,
  pathFilter,
  filter,
  onFilterChange,
  focusCommit
}: {
  repo: ScmRepository
  onOpenDiff: (key: string, sides: DiffSides) => void
  onShowHistory: (paths: string[]) => void
  pathFilter?: string[]
  filter: HistoryFilter
  onFilterChange: (filter: HistoryFilter) => void
  focusCommit?: { hash: string; nonce: number }
}) {
  const { api, root, state } = repo
  const [branchRef, setBranchRef] = useState<string | null>(null)
  const [branchPicker, setBranchPicker] = useState<{ x: number; y: number } | null>(null)
  const setFilter = (next: HistoryFilter): void => {
    setBranchRef(null)
    onFilterChange(next)
  }
  const [commits, setCommits] = useState<Commit[]>([])
  const [historyItemRefs, setHistoryItemRefs] = useState<ISCMHistoryItemRef[]>([])
  const [mergeBase, setMergeBase] = useState<string | undefined>()
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<ScmGitError | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set())
  const [changes, setChanges] = useState<ReadonlyMap<string, ChangesEntry>>(() => new Map())
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(() => new Set())
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(() => new Map())
  const pendingStats = useRef(new Set<string>())
  const changesRef = useRef(changes)
  changesRef.current = changes
  const [reloadTick, setReloadTick] = useState(0)
  const generation = useRef(0)
  const refNamesRef = useRef<string[]>([])
  const loadingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { hint, copy: copyHash } = useCopyHint()
  const sel = useListSelection()
  const [menu, setMenu] = useState<{ x: number; y: number; targets: SelRow[] } | null>(null)
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [compareCollapsed, setCompareCollapsed] = useState(false)
  const pathsKey = pathFilter?.join('\n') ?? ''
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [searchBy, setSearchBy] = useState<ScmLogSearchMode>('hash')
  const [searchResults, setSearchResults] = useState<Commit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchQuery = searchOpen ? searchText.trim() : ''
  const searchActive = searchQuery.length > 0
  const pendingFocusRef = useRef<string | null>(null)

  useEffect(() => {
    if (!focusCommit) return
    pendingFocusRef.current = focusCommit.hash
    setSearchBy('hash')
    setSearchText(focusCommit.hash)
    setSearchOpen(true)
  }, [focusCommit?.nonce])
  const logPaths = pathFilter && pathFilter.length > 0 ? pathFilter : undefined

  const headKey = JSON.stringify(state?.HEAD ?? null)
  const current = useMemo(() => resolveCurrentHistoryItemRefs(state?.HEAD), [headKey])
  const refsKey = useMemo(
    () => (state?.refs ?? []).map((r) => `${r.type}:${r.name}:${r.commit}`).join(','),
    [state?.refs]
  )
  const branchFilterRef = useMemo(
    () => (branchRef ? provideHistoryItemRefs(state?.refs ?? []).find((ref) => ref.id === branchRef) : undefined),
    [branchRef, refsKey]
  )
  useEffect(() => {
    if (branchRef && state && !branchFilterRef) setBranchRef(null)
  }, [branchRef, branchFilterRef, state])
  const reloadKey = [
    root,
    filter,
    branchFilterRef ? `${branchFilterRef.id}@${branchFilterRef.revision ?? ''}` : '',
    state?.HEAD?.commit ?? '',
    state?.HEAD?.name ?? '',
    state?.HEAD?.upstream?.commit ?? '',
    filter === 'all' ? refsKey : '',
    pathsKey,
    reloadTick
  ].join('|')

  useEffect(() => {
    if (!state) return
    const gen = ++generation.current
    const refs =
      branchFilterRef
        ? [branchFilterRef]
        : filter === 'all'
          ? provideHistoryItemRefs(state.refs)
          : [current.historyItemRef, current.historyItemRemoteRef, current.historyItemBaseRef].filter(
              (ref): ref is ISCMHistoryItemRef => !!ref
            )
    const refNames = Array.from(new Set(refs.map((ref) => ref.revision ?? ref.id)))
    refNamesRef.current = refNames
    setExpanded(new Set())
    setCollapsedFolders(new Set())
    setChanges(new Map())
    setShown(new Map())
    pendingStats.current.clear()
    if ((!branchFilterRef && !current.historyItemRef) || refNames.length === 0) {
      setCommits([])
      setHistoryItemRefs(refs)
      setHasMore(false)
      return
    }
    loadingRef.current = true
    setLoading(true)
    void (async () => {
      const page = await api.log(root, { refNames, maxEntries: PAGE_SIZE, skip: 0, paths: logPaths })
      const base =
        current.historyItemRef && current.historyItemRemoteRef
          ? await api.getMergeBase(root, current.historyItemRef.name, current.historyItemRemoteRef.name)
          : undefined
      if (gen !== generation.current) return
      loadingRef.current = false
      setLoading(false)
      setHistoryItemRefs(refs)
      setMergeBase(base?.ok ? base.value : undefined)
      if (!page.ok) {
        setError(page.error)
        setCommits([])
        setHasMore(false)
        return
      }
      setError(null)
      setCommits(page.value)
      setHasMore(page.value.length === PAGE_SIZE)
    })()
  }, [reloadKey])

  const loadMore = useCallback(async () => {
    if (loadingRef.current || !hasMore) return
    const gen = generation.current
    loadingRef.current = true
    setLoading(true)
    const page = await api.log(root, {
      refNames: refNamesRef.current,
      maxEntries: PAGE_SIZE,
      skip: commits.length,
      paths: logPaths
    })
    if (gen !== generation.current) return
    loadingRef.current = false
    setLoading(false)
    if (!page.ok) {
      setError(page.error)
      setHasMore(false)
      return
    }
    setCommits((prev) => [...prev, ...page.value])
    setHasMore(page.value.length === PAGE_SIZE)
  }, [api, root, commits.length, hasMore, pathsKey])

  useEffect(() => {
    if (!searchActive) {
      setSearchResults(null)
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = window.setTimeout(() => {
      void api
        .log(root, {
          refNames: refNamesRef.current,
          maxEntries: SEARCH_LIMIT,
          paths: logPaths,
          search: { text: searchQuery, by: searchBy }
        })
        .then((result) => {
          if (cancelled) return
          setSearching(false)
          setSearchResults(result.ok ? result.value : [])
          setError(result.ok ? null : result.error)
        })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [searchActive, searchQuery, searchBy, reloadKey])

  const listed = searchActive ? searchResults ?? [] : commits

  const viewModels = useMemo(() => {
    const items = listed.map(toHistoryItem)
    const colorMap = getGraphColorMap(historyItemRefs, current)
    const addIncomingChangesNode = !logPaths && historyItemRefs.some((ref) => ref.id === current.historyItemRemoteRef?.id)
    const addOutgoingChangesNode = !logPaths && historyItemRefs.some((ref) => ref.id === current.historyItemRef?.id)
    return toISCMHistoryItemViewModelArray(
      items,
      colorMap,
      current.historyItemRef,
      current.historyItemRemoteRef,
      current.historyItemBaseRef,
      addIncomingChangesNode,
      addOutgoingChangesNode,
      mergeBase
    )
  }, [listed, historyItemRefs, current, mergeBase, pathsKey])

  const resolveRange = useCallback(
    (vm: ISCMHistoryItemViewModel): { ref: string; parentRef?: string } | undefined => {
      const historyItem = vm.historyItem
      const { historyItemRef, historyItemRemoteRef } = current
      if (
        historyItemRemoteRef &&
        (historyItem.id === SCMIncomingHistoryItemId || historyItem.id === SCMOutgoingHistoryItemId)
      ) {
        if (!mergeBase || !historyItemRef) return undefined
        if (historyItem.id === SCMIncomingHistoryItemId) {
          return { ref: historyItemRemoteRef.id, parentRef: mergeBase }
        }
        return { ref: historyItemRef.id, parentRef: mergeBase }
      }
      let parentRef: string | undefined
      if (historyItem.parentIds.length > 0) {
        parentRef =
          historyItem.parentIds[0] === SCMIncomingHistoryItemId && historyItemRemoteRef
            ? mergeBase
            : historyItem.parentIds[0]
      }
      return { ref: historyItem.id, parentRef }
    },
    [current, mergeBase]
  )

  const setFolderKeys = useCallback((keys: string[], collapse: boolean) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      for (const k of keys) {
        if (collapse) next.add(k)
        else next.delete(k)
      }
      return next
    })
  }, [])

  const requestStats = useCallback(
    (id: string, entry: Pick<ChangesEntry, 'parentRef' | 'ref' | 'stats' | 'compare'>, paths: string[]) => {
      if (!entry.ref) return
      const todo = paths.filter((p) => !entry.stats.has(p) && !pendingStats.current.has(`${id}\n${p}`))
      if (todo.length === 0) return
      for (const p of todo) pendingStats.current.add(`${id}\n${p}`)
      const gen = generation.current
      const request = entry.compare && entry.parentRef
        ? api.compareCommitsStats(root, entry.parentRef, entry.ref, todo)
        : api.diffStats(root, entry.parentRef, entry.ref, todo)
      void request.then((result) => {
        for (const p of todo) pendingStats.current.delete(`${id}\n${p}`)
        if (gen !== generation.current || !result.ok) return
        setChanges((prev) => {
          const cur = prev.get(id)
          if (!cur) return prev
          const stats = new Map(cur.stats)
          for (const stat of result.value) stats.set(stat.path, stat)
          for (const p of todo) if (!stats.has(p)) stats.set(p, { path: p, insertions: 0, deletions: 0, binary: false })
          return new Map(prev).set(id, { ...cur, stats })
        })
      })
    },
    [api, root]
  )

  const toggle = useCallback(
    (vm: ISCMHistoryItemViewModel, recursive: boolean) => {
      const id = vm.historyItem.id
      const expanding = !expanded.has(id)
      setExpanded((prev) => {
        const next = new Set(prev)
        if (expanding) next.add(id)
        else next.delete(id)
        return next
      })
      const loaded = changes.get(id)
      if (recursive) {
        if (expanding) {
          setCollapsedFolders((prev) => new Set([...prev].filter((k) => !k.startsWith(`${id}:`))))
        } else if (loaded?.tree) {
          setFolderKeys(descendantFolderPaths(loaded.tree.root).map((p) => folderKey(id, p)), true)
        }
      }
      if (loaded || !expanding) return
      const range = resolveRange(vm)
      if (!range) {
        setChanges((prev) => new Map(prev).set(id, { loading: false, changes: [], stats: NO_STATS }))
        return
      }
      setChanges((prev) => new Map(prev).set(id, { loading: true, changes: [], stats: NO_STATS }))
      const gen = generation.current
      void api.diffBetween(root, range.parentRef, range.ref).then((result) => {
        if (gen !== generation.current) return
        if (!result.ok) {
          setChanges((prev) => new Map(prev).set(id, { loading: false, changes: [], error: result.error, stats: NO_STATS }))
          return
        }
        const tree = buildTree(result.value)
        const entry: ChangesEntry = {
          loading: false,
          changes: result.value,
          parentRef: range.parentRef,
          ref: range.ref,
          tree,
          counts: countFiles(tree.root),
          stats: NO_STATS
        }
        setChanges((prev) => new Map(prev).set(id, entry))
        if (result.value.length <= SMALL_COMMIT) requestStats(id, entry, result.value.map((c) => c.path))
      })
    },
    [api, root, changes, expanded, resolveRange, setFolderKeys, requestStats]
  )

  const toggleFolder = useCallback(
    (row: Extract<Row, { type: 'folder' }>, recursive: boolean) => {
      const id = row.vm.historyItem.id
      const key = folderKey(id, row.path)
      const collapse = !collapsedFolders.has(key)
      const keys = recursive ? [key, ...descendantFolderPaths(row.node).map((p) => folderKey(id, p))] : [key]
      setFolderKeys(keys, collapse)
    },
    [collapsedFolders, setFolderKeys]
  )

  const compareVm = useMemo((): ISCMHistoryItemViewModel | undefined => {
    if (!comparison) return undefined
    const { base, target } = comparison
    return {
      historyItem: {
        id: `${COMPARE_PREFIX}${base.id}..${target.id}`,
        parentIds: [],
        subject: `${shortId(base)} ↔ ${shortId(target)}`,
        message: ''
      },
      inputSwimlanes: [],
      outputSwimlanes: [],
      kind: 'node'
    }
  }, [comparison])

  useEffect(() => {
    if (!comparison || !compareVm) return
    const id = compareVm.historyItem.id
    const { base, target } = comparison
    const gen = generation.current
    setChanges((prev) => new Map(prev).set(id, { loading: true, changes: [], stats: NO_STATS, compare: true }))
    void api.compareCommits(root, base.id, target.id).then((result) => {
      if (gen !== generation.current) return
      if (!result.ok) {
        setChanges((prev) => new Map(prev).set(id, { loading: false, changes: [], error: result.error, stats: NO_STATS, compare: true }))
        return
      }
      const tree = buildTree(result.value)
      const entry: ChangesEntry = {
        loading: false,
        changes: result.value,
        parentRef: base.id,
        ref: target.id,
        tree,
        counts: countFiles(tree.root),
        stats: NO_STATS,
        compare: true
      }
      setChanges((prev) => new Map(prev).set(id, entry))
      if (result.value.length <= SMALL_COMMIT) requestStats(id, entry, result.value.map((c) => c.path))
    })
  }, [compareVm, reloadKey])

  const compareCommits = (items: ISCMHistoryItem[]): void => {
    const index = (item: ISCMHistoryItem): number => viewModels.findIndex((vm) => vm.historyItem.id === item.id)
    const [newer, older] = [...items].sort((a, b) => index(a) - index(b))
    if (!newer || !older) return
    sel.clear()
    setCompareCollapsed(false)
    setComparison({ base: older, target: newer })
    scrollRef.current?.scrollTo({ top: 0 })
  }

  const rows = useMemo(() => {
    const out: Row[] = []
    const pushChanges = (vm: ISCMHistoryItemViewModel, entry: ChangesEntry | undefined): void => {
      const id = vm.historyItem.id
      if (!entry || entry.loading) out.push({ type: 'status', vm, text: 'Loading…' })
      else if (entry.error) out.push({ type: 'status', vm, text: entry.error.message })
      else if (!entry.tree || !entry.ref || entry.changes.length === 0) out.push({ type: 'status', vm, text: 'No changes' })
      else {
        const ref = entry.ref
        const matching = logPaths && !showAll.has(id)
          ? entry.changes.filter((c) =>
              logPaths.some(
                (p) => c.path === p || c.path.startsWith(`${p}/`) || c.originalPath === p || c.originalPath.startsWith(`${p}/`)
              )
            )
          : entry.changes
        const tree = matching === entry.changes ? entry.tree : buildTree(matching)
        const counts = matching === entry.changes ? entry.counts : countFiles(tree.root)
        const flat = flattenResourceTree(tree.root, (p) => collapsedFolders.has(folderKey(id, p)), {
          pageSize: FOLDER_PAGE,
          shown: (p) => shown.get(folderKey(id, p)) ?? 0
        })
        for (const r of flat) {
          if (r.kind === 'more') {
            out.push({ type: 'more', vm, path: r.path, remaining: r.remaining ?? 0, depth: r.depth })
          } else if (r.kind === 'folder') {
            out.push({
              type: 'folder',
              vm,
              path: r.path,
              label: r.label,
              depth: r.depth,
              collapsed: r.collapsed,
              node: r.node,
              count: counts?.get(r.path)
            })
          } else if (r.node.element) {
            out.push({ type: 'change', vm, change: r.node.element, depth: r.depth, parentRef: entry.parentRef, ref })
          }
        }
        if (matching.length < entry.changes.length) {
          out.push({ type: 'hidden', vm, count: entry.changes.length - matching.length })
        }
      }
    }
    if (comparison && compareVm) {
      const entry = changes.get(compareVm.historyItem.id)
      out.push({ type: 'compare', vm: compareVm, comparison, entry, collapsed: compareCollapsed })
      if (!compareCollapsed) pushChanges(compareVm, entry)
    }
    for (const vm of viewModels) {
      out.push({ type: 'item', vm })
      const id = vm.historyItem.id
      if (!expanded.has(id)) continue
      const entry = changes.get(id)
      out.push({ type: 'message', vm, entry })
      pushChanges(vm, entry)
    }
    if (hasMore && !searchActive) out.push({ type: 'loadMore', columns: viewModels.at(-1)?.outputSwimlanes ?? [] })
    return out
  }, [viewModels, expanded, changes, collapsedFolders, hasMore, searchActive, showAll, pathsKey, shown, comparison, compareVm, compareCollapsed])

  const showMore = (row: Extract<Row, { type: 'more' }>, all: boolean): void => {
    const key = folderKey(row.vm.historyItem.id, row.path)
    setShown((prev) => {
      const current = Math.max(FOLDER_PAGE, prev.get(key) ?? 0)
      return new Map(prev).set(key, all ? Number.MAX_SAFE_INTEGER : current + FOLDER_PAGE)
    })
  }

  const orderedKeys = useMemo(() => rows.map(rowKey).filter((k): k is string => k !== null), [rows])
  const rowByKey = useMemo(() => {
    const map = new Map<string, SelRow>()
    for (const r of rows) {
      const k = rowKey(r)
      if (k && (r.type === 'item' || r.type === 'folder' || r.type === 'change')) map.set(k, r)
    }
    return map
  }, [rows])

  const onRowContextMenu = (e: React.MouseEvent, row: SelRow): void => {
    e.preventDefault()
    if (row.type === 'item' && isSynthetic(row.vm.historyItem)) return
    const targets = sel
      .contextTarget(rowKey(row)!)
      .map((k) => rowByKey.get(k))
      .filter((r): r is SelRow => !!r && !(r.type === 'item' && isSynthetic(r.vm.historyItem)))
    setMenu({ x: e.clientX, y: e.clientY, targets: targets.length > 0 ? targets : [row] })
  }

  useEffect(() => {
    const hash = pendingFocusRef.current
    if (!hash || searching || !searchResults) return
    pendingFocusRef.current = null
    const vm = viewModels.find((v) => v.historyItem.id === hash)
    if (!vm) return
    sel.select([`c:${hash}`])
    if (!expanded.has(hash)) toggle(vm, false)
  }, [searchResults, searching, viewModels])

  const onItemClick = (e: React.MouseEvent, vm: ISCMHistoryItemViewModel): void => {
    if (e.altKey) {
      toggle(vm, true)
      return
    }
    const onGraph = (e.target as Element | null)?.closest?.('.graph-container') != null
    if (sel.click(e, `c:${vm.historyItem.id}`, orderedKeys) === 'single' && !onGraph) toggle(vm, false)
  }

  const onCompareClick = (e: React.MouseEvent, row: Extract<Row, { type: 'compare' }>): void => {
    const id = row.vm.historyItem.id
    const expanding = row.collapsed
    setCompareCollapsed(!expanding)
    if (!e.altKey) return
    if (expanding) {
      setCollapsedFolders((prev) => new Set([...prev].filter((k) => !k.startsWith(`${id}:`))))
    } else if (row.entry?.tree) {
      setFolderKeys(descendantFolderPaths(row.entry.tree.root).map((p) => folderKey(id, p)), true)
    }
  }

  const onFolderClick = (e: React.MouseEvent, row: Extract<Row, { type: 'folder' }>): void => {
    if (e.altKey) {
      toggleFolder(row, true)
      return
    }
    if (sel.click(e, rowKey(row)!, orderedKeys) === 'single') toggleFolder(row, false)
  }

  const onChangeClick = (e: React.MouseEvent, row: Extract<Row, { type: 'change' }>): void => {
    if (sel.click(e, rowKey(row)!, orderedKeys) === 'single') {
      onOpenDiff(changeKey(row), getHistoryChangeDiffSides(row.change, row.parentRef, row.ref))
    }
  }

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === 'message' ? 26 : ROW_HEIGHT),
    overscan: 20
  })
  const virtualItems = virtualizer.getVirtualItems()
  const lastIndex = virtualItems.at(-1)?.index ?? -1

  const goToCommit = (hash: string): void => {
    const index = rows.findIndex((r) => r.type === 'item' && r.vm.historyItem.id === hash)
    const row = rows[index]
    if (row?.type === 'item') {
      sel.select([`c:${hash}`])
      if (!expanded.has(hash)) toggle(row.vm, false)
      virtualizer.scrollToIndex(index, { align: 'center' })
      return
    }
    pendingFocusRef.current = hash
    setSearchBy('hash')
    setSearchText(hash)
    setSearchOpen(true)
  }

  useEffect(() => {
    if (lastIndex >= 0 && rows[lastIndex]?.type === 'loadMore') void loadMore()
  }, [lastIndex, rows, loadMore])

  const firstIndex = virtualItems[0]?.index ?? -1
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const byCommit = new Map<string, string[]>()
      for (let i = Math.max(0, firstIndex); i <= lastIndex && i < rows.length; i++) {
        const row = rows[i]
        if (row?.type !== 'change') continue
        const id = row.vm.historyItem.id
        const list = byCommit.get(id) ?? []
        list.push(row.change.path)
        byCommit.set(id, list)
      }
      for (const [id, paths] of byCommit) {
        const entry = changesRef.current.get(id)
        if (entry?.ref) requestStats(id, entry, paths)
      }
    }, 120)
    return () => window.clearTimeout(timer)
  }, [firstIndex, lastIndex, rows, requestStats])

  const placeholder = (vm: ISCMHistoryItemViewModel, stretch?: boolean): React.ReactNode => (
    <GitGraphSvg graph={renderSCMHistoryGraphPlaceholder(vm.outputSwimlanes, getHistoryItemIndex(vm))} stretch={stretch} />
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-scm-graph>
      <div className="flex h-[26px] shrink-0 items-center gap-1 border-b border-hairline px-2">
        <span className="flex-1 truncate text-xs font-medium text-ink-2">
          {logPaths ? 'History' : 'Graph'}
        </span>
        {loading && <LoaderCircle size={13} className="animate-spin text-ink-3" />}
        <Tooltip label="Search Commits">
          <button
            type="button"
            aria-label="Search Commits"
            aria-pressed={searchOpen}
            onClick={() => {
              if (searchOpen) {
                setSearchOpen(false)
                return
              }
              setSearchOpen(true)
              requestAnimationFrame(() => searchInputRef.current?.select())
            }}
            className={`rounded p-1 hover:bg-white/10 hover:text-ink ${searchOpen ? 'bg-white/10 text-ink' : 'text-ink-3'}`}
          >
            <Search size={13} />
          </button>
        </Tooltip>
        {!logPaths && (
          <Tooltip label="Show one branch">
            <button
              type="button"
              aria-label="Show one branch"
              aria-pressed={!!branchFilterRef}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setBranchPicker({ x: r.left, y: r.bottom + 2 })
              }}
              className={`flex max-w-[140px] items-center gap-1 rounded border border-hairline px-1.5 py-px text-[11px] ${branchFilterRef ? 'bg-white/15 text-ink' : 'text-ink-3 hover:text-ink-2'}`}
            >
              <GitBranch size={11} className="shrink-0" />
              <span className="truncate">{branchFilterRef ? branchFilterRef.name : 'Branch'}</span>
              <ChevronDown size={11} className="shrink-0" />
            </button>
          </Tooltip>
        )}
        <div className="flex overflow-hidden rounded border border-hairline text-[11px]">
          {(['auto', 'all'] as const).map((f) => (
            <Tooltip key={f} label={f === 'auto' ? 'Current branch and its remote' : 'All branches, remotes and tags'}>
              <button
                type="button"
                aria-pressed={!branchFilterRef && filter === f}
                onClick={() => setFilter(f)}
                className={`px-1.5 py-px ${!branchFilterRef && filter === f ? 'bg-white/15 text-ink' : 'text-ink-3 hover:text-ink-2'}`}
              >
                {f === 'auto' ? 'Auto' : 'All'}
              </button>
            </Tooltip>
          ))}
        </div>
        <Tooltip label="Refresh">
          <button
            type="button"
            aria-label="Refresh"
            onClick={() => setReloadTick((t) => t + 1)}
            className="rounded p-1 text-ink-3 hover:bg-white/10 hover:text-ink"
          >
            <RefreshCw size={13} />
          </button>
        </Tooltip>
      </div>
      {searchOpen && (
        <div className="shrink-0 border-b border-hairline px-2 py-1.5">
          <div className="animate-menu-pop-in surface-overlay rounded-lg p-2" data-scm-commit-search>
            <div className="flex items-center gap-1.5">
              <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-hairline bg-sunken px-1.5 focus-within:border-accent">
                {searching ? <LoaderCircle size={12} className="shrink-0 animate-spin text-ink-3" /> : <Search size={12} className="shrink-0 text-ink-3" />}
                <input
                  ref={searchInputRef}
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setSearchOpen(false)
                    }
                  }}
                  placeholder={searchBy === 'hash' ? 'Commit hash' : 'Commit message'}
                  spellCheck={false}
                  className="h-6 min-w-0 flex-1 bg-transparent text-[12px] text-ink placeholder:text-ink-4 focus:outline-none"
                />
              </div>
              <button
                type="button"
                aria-label="Close Search"
                onClick={() => setSearchOpen(false)}
                className="shrink-0 rounded p-1 text-ink-3 hover:bg-white/10 hover:text-ink"
              >
                <X size={13} />
              </button>
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <div className="flex overflow-hidden rounded border border-hairline text-[11px]">
                {(['hash', 'message'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={searchBy === m}
                    onClick={() => {
                      setSearchBy(m)
                      searchInputRef.current?.focus()
                    }}
                    className={`px-1.5 py-px ${searchBy === m ? 'bg-white/15 text-ink' : 'text-ink-3 hover:text-ink-2'}`}
                  >
                    {m === 'hash' ? 'Hash' : 'Message'}
                  </button>
                ))}
              </div>
              <span className="min-w-0 flex-1 truncate text-right text-[11px] text-ink-3">
                {!searchActive
                  ? ''
                  : searching
                    ? 'Searching…'
                    : searchBy === 'hash' && !/^[0-9a-f]+$/i.test(searchQuery)
                      ? 'Hashes are hex only'
                      : searchResults && searchResults.length >= SEARCH_LIMIT
                        ? `First ${SEARCH_LIMIT} matches`
                        : `${searchResults?.length ?? 0} ${searchResults?.length === 1 ? 'match' : 'matches'}`}
              </span>
            </div>
          </div>
        </div>
      )}
      {error && <div className="shrink-0 px-3 py-1.5 text-xs text-rose-300">{error.message}</div>}
      <div
        ref={scrollRef}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-auto outline-none"
        onKeyDown={(e) => {
          if (e.key === 'Escape') sel.clear()
        }}
      >
        {searchActive && !searching && searchResults?.length === 0 && (
          <div className="px-3 py-2 text-xs italic text-ink-3">No commits match.</div>
        )}
        {!searchActive && !loading && commits.length === 0 && logPaths && (
          <div className="px-3 py-2 text-xs italic text-ink-3">No commits touch the selected files on these branches.</div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualItems.map((v) => {
            const row = rows[v.index]
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virtualizer.measureElement}
                style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)` }}
              >
                {row.type === 'item' ? (
                  <HistoryItemRow
                    vm={row.vm}
                    expanded={expanded.has(row.vm.historyItem.id)}
                    selected={sel.has(rowKey(row)!)}
                    current={current.historyItemRef?.revision === row.vm.historyItem.id}
                    onClick={(e) => onItemClick(e, row.vm)}
                    onContextMenu={(e) => onRowContextMenu(e, row)}
                  />
                ) : row.type === 'compare' ? (
                  <CompareRow
                    comparison={row.comparison}
                    entry={row.entry}
                    collapsed={row.collapsed}
                    onClick={(e) => onCompareClick(e, row)}
                    onClose={() => setComparison(null)}
                    onCountAll={() => {
                      const entry = changesRef.current.get(row.vm.historyItem.id)
                      if (entry?.ref) requestStats(row.vm.historyItem.id, entry, entry.changes.map((c) => c.path))
                    }}
                  />
                ) : row.type === 'message' ? (
                  <MessageRow
                    vm={row.vm}
                    entry={row.entry}
                    placeholder={placeholder(row.vm, true)}
                    onCopy={copyHash}
                    onGoToCommit={goToCommit}
                    onCountAll={() => {
                      const entry = row.entry && changesRef.current.get(row.vm.historyItem.id)
                      if (entry) requestStats(row.vm.historyItem.id, entry, entry.changes.map((c) => c.path))
                    }}
                  />
                ) : row.type === 'folder' ? (
                  <div
                    className={`scm-row flex h-[22px] cursor-pointer select-none items-center pr-2 ${sel.has(rowKey(row)!) ? 'selected' : ''}`}
                    title={row.path}
                    onClick={(e) => onFolderClick(e, row)}
                    onContextMenu={(e) => onRowContextMenu(e, row)}
                  >
                    <div className="shrink-0" style={{ width: GUTTER }} />
                    {placeholder(row.vm)}
                    <div className="shrink-0" style={{ width: 4 + row.depth * INDENT }} />
                    <div className="flex w-4 shrink-0 items-center justify-center">
                      {row.collapsed ? <ChevronRight size={14} className="text-ink-3" /> : <ChevronDown size={14} className="text-ink-3" />}
                    </div>
                    <span className="min-w-0 flex-1 truncate pl-0.5 text-[13px] text-ink-2">{row.label}</span>
                    {row.count !== undefined && <span className="ml-2 shrink-0 text-[11px] text-ink-4">{row.count}</span>}
                  </div>
                ) : row.type === 'change' ? (
                  <HistoryChangeRow
                    row={row}
                    selected={sel.has(rowKey(row)!)}
                    placeholder={placeholder(row.vm)}
                    stat={changes.get(row.vm.historyItem.id)?.stats.get(row.change.path)}
                    onContextMenu={(e) => onRowContextMenu(e, row)}
                    onClick={(e) => onChangeClick(e, row)}
                  />
                ) : row.type === 'more' ? (
                  <div className="scm-row flex h-[22px] select-none items-center pr-2 text-xs">
                    <div className="shrink-0" style={{ width: GUTTER }} />
                    {placeholder(row.vm)}
                    <div className="shrink-0" style={{ width: 4 + row.depth * INDENT + 16 }} />
                    <button type="button" className="text-ink-3 hover:text-ink" onClick={() => showMore(row, false)}>
                      Show {Math.min(FOLDER_PAGE, row.remaining)} more
                    </button>
                    <span className="mx-1.5 text-ink-4">·</span>
                    <button type="button" className="text-ink-3 hover:text-ink" onClick={() => showMore(row, true)}>
                      Show all {row.remaining}
                    </button>
                  </div>
                ) : row.type === 'hidden' ? (
                  <div
                    className="scm-row flex h-[22px] cursor-pointer select-none items-center"
                    onClick={() => setShowAll((prev) => new Set(prev).add(row.vm.historyItem.id))}
                  >
                    <div className="shrink-0" style={{ width: GUTTER }} />
                    {placeholder(row.vm)}
                    <span className="ml-2 truncate text-xs text-ink-3 hover:text-ink-2">
                      {plural(row.count, 'other file')} in this commit, click to show
                    </span>
                  </div>
                ) : row.type === 'status' ? (
                  <div className="scm-row flex h-[22px] items-center">
                    <div className="shrink-0" style={{ width: GUTTER }} />
                    {placeholder(row.vm)}
                    <span className="ml-2 truncate text-xs italic text-ink-3">{row.text}</span>
                  </div>
                ) : (
                  <div className="scm-row flex h-[22px] items-center">
                    <div className="shrink-0" style={{ width: GUTTER }} />
                    <GitGraphSvg graph={renderSCMHistoryGraphPlaceholder(row.columns)} />
                    <span className="ml-1 truncate text-xs text-ink-3">Load More…</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      {hint}
      {menu && (
        <GraphContextMenu
          menu={menu}
          root={root}
          onDismiss={() => setMenu(null)}
          onCopy={copyHash}
          onReveal={(path) => void api.revealInFolder(root, path)}
          onShowHistory={onShowHistory}
          onCompare={compareCommits}
        />
      )}
      {branchPicker && (
        <BranchFilterPicker
          x={branchPicker.x}
          y={branchPicker.y}
          refs={provideHistoryItemRefs(state?.refs ?? []).filter((ref) => !ref.name.endsWith('/HEAD'))}
          selected={branchFilterRef?.id}
          onPick={(ref) => setBranchRef(ref.id)}
          onDismiss={() => setBranchPicker(null)}
        />
      )}
    </div>
  )
}

const BRANCH_GROUPS: { category: string; label: string; icon: LucideIcon }[] = [
  { category: 'branches', label: 'Branches', icon: GitBranch },
  { category: 'remote branches', label: 'Remote branches', icon: Cloud },
  { category: 'tags', label: 'Tags', icon: Tag }
]

function BranchFilterPicker({
  x,
  y,
  refs,
  selected,
  onPick,
  onDismiss
}: {
  x: number
  y: number
  refs: ISCMHistoryItemRef[]
  selected?: string
  onPick: (ref: ISCMHistoryItemRef) => void
  onDismiss: () => void
}) {
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return BRANCH_GROUPS.map((g) => ({
      ...g,
      refs: refs.filter((r) => r.category === g.category && !!r.name && (!q || r.name.toLowerCase().includes(q)))
    })).filter((g) => g.refs.length > 0)
  }, [refs, query])
  const first = groups[0]?.refs[0]
  const pick = (ref: ISCMHistoryItemRef): void => {
    onDismiss()
    onPick(ref)
  }

  return (
    <FloatingMenu x={x} y={y} onDismiss={onDismiss} className="w-[320px]">
      <div className="px-2 pb-1">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onDismiss()
            else if (e.key === 'Enter' && first) pick(first)
          }}
          placeholder="Show history of a branch or tag"
          spellCheck={false}
          className="w-full rounded border border-hairline bg-sunken px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink-4 focus:border-accent"
        />
      </div>
      <div className="max-h-[50vh] overflow-y-auto">
        {groups.length === 0 && <div className="px-3 py-1.5 text-xs text-ink-3">No branches or tags found.</div>}
        {groups.map((g) => (
          <div key={g.category}>
            <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium text-ink-3">{g.label}</div>
            {g.refs.map((ref) => (
              <button key={ref.id} className={menuItemClass} onClick={() => pick(ref)}>
                <g.icon size={14} className="shrink-0" />
                <span className={`min-w-0 truncate ${ref.id === selected ? 'text-ink' : ''}`}>{ref.name}</span>
                {ref.revision && <span className="ml-auto shrink-0 pl-3 font-mono text-[11px] text-ink-3">{ref.revision.substring(0, 8)}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </FloatingMenu>
  )
}

function changeStats(entry: ChangesEntry | undefined): { files: number; counted: number; insertions: number; deletions: number } | undefined {
  if (!entry || entry.loading || entry.error) return undefined
  const stats = { files: entry.changes.length, counted: 0, insertions: 0, deletions: 0 }
  for (const c of entry.changes) {
    const s = entry.stats.get(c.path)
    if (!s) continue
    stats.counted++
    stats.insertions += s.insertions
    stats.deletions += s.deletions
  }
  return stats
}

function CompareRow({
  comparison,
  entry,
  collapsed,
  onClick,
  onClose,
  onCountAll
}: {
  comparison: Comparison
  entry?: ChangesEntry
  collapsed: boolean
  onClick: (e: React.MouseEvent) => void
  onClose: () => void
  onCountAll: () => void
}) {
  const { base, target } = comparison
  const stats = changeStats(entry)
  const partial = !!stats && stats.counted < stats.files
  return (
    <div
      className="scm-row flex h-[22px] cursor-pointer select-none items-center pr-1"
      title={`${base.subject}\n↔\n${target.subject}`}
      data-compare-row
      aria-expanded={!collapsed}
      onClick={onClick}
    >
      <div className="flex shrink-0 items-center justify-center" style={{ width: GUTTER }}>
        {collapsed ? <ChevronRight size={14} className="text-ink-3" /> : <ChevronDown size={14} className="text-ink-3" />}
      </div>
      <GitCompare size={13} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate pl-1 text-[13px] text-ink">
        Changes from <span className="font-mono">{shortId(base)}</span> to <span className="font-mono">{shortId(target)}</span>
      </span>
      {stats && stats.files > 0 && (
        <span className="ml-2 shrink-0 text-[11px] text-ink-3">
          {plural(stats.files, 'file')}
          {stats.counted > 0 && (partial || stats.insertions + stats.deletions > 0) && (
            <button
              type="button"
              className="ml-1 hover:underline"
              onClick={(e) => {
                e.stopPropagation()
                onCountAll()
              }}
              disabled={!partial}
            >
              <span style={{ color: historyItemHoverAdditionsForeground }}>+{stats.insertions}{partial ? '+' : ''}</span>{' '}
              <span style={{ color: historyItemHoverDeletionsForeground }}>−{stats.deletions}{partial ? '+' : ''}</span>
            </button>
          )}
        </span>
      )}
      <Tooltip label="Close comparison">
        <button type="button" aria-label="Close comparison" onClick={(e) => {
          e.stopPropagation()
          onClose()
        }} className="ml-1 rounded p-0.5 text-ink-3 hover:bg-white/10 hover:text-ink">
          <X size={13} />
        </button>
      </Tooltip>
    </div>
  )
}

function changeKey(row: { vm: ISCMHistoryItemViewModel; change: Change }): string {
  return `history:${row.vm.historyItem.id}:${row.change.path}`
}

function HistoryItemRow({
  vm,
  expanded,
  selected,
  current,
  onClick,
  onContextMenu
}: {
  vm: ISCMHistoryItemViewModel
  expanded: boolean
  selected: boolean
  current: boolean
  onClick: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const item = vm.historyItem
  const Chevron = expanded ? ChevronDown : ChevronRight
  const hover = useCommitHover()
  const graphClass =
    vm.kind === 'HEAD'
      ? 'current'
      : vm.kind === 'incoming-changes'
        ? 'incoming-changes'
        : vm.kind === 'outgoing-changes'
          ? 'outgoing-changes'
          : ''
  return (
    <div
      className={`scm-row flex h-[22px] cursor-pointer select-none items-center pr-2 ${selected ? 'selected' : ''}`}
      onMouseEnter={hover.show}
      onMouseLeave={hover.hide}
      onMouseDown={hover.hide}
      onClick={onClick}
      onContextMenu={(e) => {
        hover.hide()
        onContextMenu(e)
      }}
    >
      {hover.rect && <CommitHoverCard item={item} rect={hover.rect} />}
      <div className="flex shrink-0 items-center justify-center" style={{ width: GUTTER }}>
        <Chevron size={14} className="text-ink-3" />
      </div>
      <div
        className={`history-item flex min-w-0 flex-1 items-center ${expanded ? 'expanded' : ''} ${current ? 'history-item-current' : ''}`}
      >
        <div className={`graph-container ${graphClass}`}>
          <GitGraphSvg graph={renderSCMHistoryItemGraph(vm)} />
        </div>
        <span className="label-name min-w-0 flex-1 truncate pl-1 text-[13px] text-ink">{item.subject}</span>
        <Badges item={item} />
        {item.author && (
          <span className="ml-2 max-w-[35%] shrink-0 truncate text-right text-xs text-ink-3">{item.author}</span>
        )}
      </div>
    </div>
  )
}

function useCommitHover(): { rect: DOMRect | null; show: (e: React.MouseEvent) => void; hide: () => void } {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    setRect(null)
  }, [])
  const show = useCallback((e: React.MouseEvent) => {
    const el = e.currentTarget as HTMLElement
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setRect(el.getBoundingClientRect()), 450)
  }, [])
  useEffect(() => {
    if (!rect) return
    window.addEventListener('wheel', hide, { passive: true })
    return () => window.removeEventListener('wheel', hide)
  }, [rect, hide])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return { rect, show, hide }
}

function CommitHoverCard({ item, rect }: { item: ISCMHistoryItem; rect: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null)
  const reference = useMemo(
    () => ({ getBoundingClientRect: () => ({ x: rect.left, y: rect.top, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }) }),
    [rect]
  )
  useFloating(reference, ref, { placement: 'bottom-start', gap: 4, crossGap: 24 })
  const date = item.timestamp ? new Date(item.timestamp).toLocaleString() : ''
  const hash = item.displayId && !/^0+$/.test(item.displayId) ? item.displayId : ''
  return createPortal(
    <div
      ref={ref}
      data-commit-hover={item.id}
      style={{ left: 0, top: 0 }}
      className="surface-overlay pointer-events-none fixed z-[60] max-w-[32rem] rounded-lg px-3 py-2 text-ink"
    >
      <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-ink-3">
        {item.author && <span className="text-ink-2">{item.author}</span>}
        {date && <span>{date}</span>}
        {hash && <span className="font-mono">{hash}</span>}
      </div>
      <div className="mt-1.5 whitespace-pre-wrap break-words text-[12.5px] leading-[18px]">{(item.message || item.subject).trim()}</div>
      {!!item.references?.length && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.references.map((r) => (
            <span key={r.id} className="rounded bg-white/5 px-1.5 py-px text-[11px] text-ink-2">
              {r.name}
            </span>
          ))}
        </div>
      )}
    </div>,
    document.body
  )
}

function MessageRow({
  vm,
  entry,
  placeholder,
  onCopy,
  onGoToCommit,
  onCountAll
}: {
  vm: ISCMHistoryItemViewModel
  entry?: ChangesEntry
  placeholder: React.ReactNode
  onCopy: (text: string, x: number, y: number) => void
  onGoToCommit: (hash: string) => void
  onCountAll: () => void
}) {
  const item = vm.historyItem
  const parents = item.parentIds.filter((id) => /^[0-9a-f]{7,}$/i.test(id))
  let stats: { files: number; counted: number; insertions: number; deletions: number } | undefined
  if (entry && !entry.loading && !entry.error) {
    stats = { files: entry.changes.length, counted: 0, insertions: 0, deletions: 0 }
    for (const c of entry.changes) {
      const s = entry.stats.get(c.path)
      if (!s) continue
      stats.counted++
      stats.insertions += s.insertions
      stats.deletions += s.deletions
    }
  }
  const partial = !!stats && stats.counted < stats.files
  const date = item.timestamp ? new Date(item.timestamp) : undefined
  return (
    <div className="scm-row flex items-stretch">
      <div className="shrink-0" style={{ width: GUTTER }} />
      <div className="flex shrink-0">{placeholder}</div>
      <div className="min-w-0 flex-1 select-text py-0.5 pl-2 pr-2">
        <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-ink-3">
          {item.displayId && !/^0+$/.test(item.displayId) && (
            <Tooltip label="Right-click to copy the full hash">
              <span
                className="rounded px-0.5 font-mono hover:bg-white/10 hover:text-ink-2"
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onCopy(item.id, e.clientX, e.clientY)
                }}
              >
                {item.displayId}
              </span>
            </Tooltip>
          )}
          {item.author && (
            <span>
              {item.author}
              {item.authorEmail ? ` <${item.authorEmail}>` : ''}
            </span>
          )}
          {date && <span title={date.toString()}>{date.toLocaleString()}</span>}
          {parents.length > 0 && (
            <span className="flex items-center gap-1">
              {parents.length === 1 ? 'Parent' : 'Parents'}
              {parents.map((id) => (
                <Tooltip key={id} label="Go to this commit. Right-click to copy the full hash">
                  <button
                    type="button"
                    className="rounded px-0.5 font-mono text-accent hover:bg-white/10 hover:underline"
                    onClick={() => onGoToCommit(id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      onCopy(id, e.clientX, e.clientY)
                    }}
                  >
                    {id.substring(0, 7)}
                  </button>
                </Tooltip>
              ))}
            </span>
          )}
          {stats && stats.files > 0 && (
            <span>
              {stats.files} file{stats.files === 1 ? '' : 's'}
              {stats.counted > 0 && (partial || stats.insertions + stats.deletions > 0) && (
                <>
                  {' '}
                  {partial ? (
                    <Tooltip label={`At least this many. Lines counted in ${stats.counted} of ${stats.files} files, click to count all`}>
                      <button type="button" className="hover:underline" onClick={onCountAll}>
                        <span style={{ color: historyItemHoverAdditionsForeground }}>+{stats.insertions}+</span>{' '}
                        <span style={{ color: historyItemHoverDeletionsForeground }}>−{stats.deletions}+</span>
                      </button>
                    </Tooltip>
                  ) : (
                    <>
                      <span style={{ color: historyItemHoverAdditionsForeground }}>+{stats.insertions}</span>{' '}
                      <span style={{ color: historyItemHoverDeletionsForeground }}>−{stats.deletions}</span>
                    </>
                  )}
                </>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function HistoryChangeRow({
  row,
  selected,
  placeholder,
  stat,
  onClick,
  onContextMenu
}: {
  row: Extract<Row, { type: 'change' }>
  selected: boolean
  placeholder: React.ReactNode
  stat?: ScmDiffStat
  onClick: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const { change } = row
  const name = change.path.substring(change.path.lastIndexOf('/') + 1)
  const color = getStatusColor(change.status)
  return (
    <div
      className={`scm-row flex h-[22px] cursor-pointer select-none items-center pr-2 ${selected ? 'selected' : ''}`}
      title={`${change.path} • ${getStatusText(change.status)}${stat ? (stat.binary ? ' (binary)' : ` (+${stat.insertions} −${stat.deletions})`) : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className="shrink-0" style={{ width: GUTTER }} />
      {placeholder}
      <div className="shrink-0" style={{ width: 4 + row.depth * INDENT + 16 }} />
      <span
        className={`min-w-0 flex-1 truncate pl-0.5 text-[13px] ${getStrikeThrough(change.status) ? 'line-through' : ''}`}
        style={{ color }}
      >
        {name}
      </span>
      <span className="ml-2 w-3 shrink-0 text-center text-xs font-semibold" style={{ color }}>
        {getStatusLetter(change.status)}
      </span>
    </div>
  )
}

function GraphContextMenu({
  menu,
  root,
  onDismiss,
  onCopy,
  onReveal,
  onShowHistory,
  onCompare
}: {
  menu: { x: number; y: number; targets: SelRow[] }
  root: string
  onDismiss: () => void
  onCopy: (text: string, x: number, y: number) => void
  onReveal: (path: string) => void
  onShowHistory: (paths: string[]) => void
  onCompare: (items: ISCMHistoryItem[]) => void
}) {
  const items = menu.targets.filter((t): t is Extract<SelRow, { type: 'item' }> => t.type === 'item').map((t) => t.vm.historyItem)
  const files = menu.targets.filter((t) => t.type !== 'item')
  const paths = Array.from(new Set(files.map((t) => (t.type === 'change' ? t.change.path : t.type === 'folder' ? t.path : ''))))
  const copy = (text: string) => (e: React.MouseEvent): void => {
    onCopy(text, e.clientX, e.clientY)
    onDismiss()
  }
  const act = (fn: () => void) => (): void => {
    fn()
    onDismiss()
  }
  const single = files.length === 1 ? files[0] : undefined

  return (
    <FloatingMenu x={menu.x} y={menu.y} onDismiss={onDismiss}>
      {items.length === 2 && files.length === 0 && (
        <>
          <button className={menuItemClass} onClick={act(() => onCompare(items))}>
            <GitCompare size={14} /> Compare Commits
          </button>
          <MenuSeparator />
        </>
      )}
      {items.length > 0 && (
        <>
          <button className={menuItemClass} onClick={copy(items.map((i) => i.id).join('\n'))}>
            {items.length === 1 ? 'Copy Hash' : `Copy ${items.length} Hashes`}
          </button>
          <button className={menuItemClass} onClick={copy(items.map(messageEntry).join('\n'))}>
            {items.length === 1 ? 'Copy Message' : `Copy ${items.length} Messages`}
          </button>
        </>
      )}
      {items.length > 0 && files.length > 0 && <MenuSeparator />}
      {files.length > 0 && (
        <>
          {single && single.type !== 'folder' && (
            <button className={menuItemClass} onClick={act(() => openFileInWorkbench({ file: joinPath(root, paths[0]), preview: false }))}>
              <FileText size={14} /> Open File
            </button>
          )}
          <button className={menuItemClass} onClick={act(() => onShowHistory(paths))}>
            <History size={14} />
            {single ? (single.type === 'folder' ? 'Show Folder History' : 'Show File History') : `Show History of ${plural(paths.length, 'Item')}`}
          </button>
          <MenuSeparator />
          {single && (
            <>
              <button className={menuItemClass} onClick={act(() => onReveal(paths[0]))}>
                {revealLabel()}
              </button>
              <MenuSeparator />
            </>
          )}
          <button className={menuItemClass} onClick={copy(paths.map((p) => joinPath(root, p)).join('\n'))}>
            {paths.length > 1 ? `Copy ${plural(paths.length, 'Path')}` : 'Copy Path'}
          </button>
          <button className={menuItemClass} onClick={copy(paths.join('\n'))}>
            {paths.length > 1 ? `Copy ${plural(paths.length, 'Relative Path')}` : 'Copy Relative Path'}
          </button>
        </>
      )}
    </FloatingMenu>
  )
}
