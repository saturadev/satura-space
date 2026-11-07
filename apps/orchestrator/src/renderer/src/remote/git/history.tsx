import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, CircleX, Cloud, GitCommitHorizontal, Search, Tag } from 'lucide-react'
import type { Commit, ScmGitError, ScmGraphFilter, ScmLogSearchMode } from '@shared/git-scm'
import type { ScmRepository } from '../../components/git/use-scm-repository'
import { GitGraphSvg } from '../../components/git/GitGraphSvg'
import { getGraphColorMap, provideHistoryItemRefs, resolveCurrentHistoryItemRefs, toHistoryItem, type CurrentHistoryItemRefs } from '../../lib/git/history-provider'
import {
  SCMIncomingHistoryItemId,
  SCMOutgoingHistoryItemId,
  SWIMLANE_HEIGHT,
  renderSCMHistoryGraphPlaceholder,
  renderSCMHistoryItemGraph,
  toISCMHistoryItemViewModelArray,
  type ISCMHistoryItem,
  type ISCMHistoryItemRef,
  type ISCMHistoryItemViewModel
} from '../../lib/git/scm-history'
import { relativeTimeShort } from '../../lib/relative-time'
import type { ActionNode } from '../../lib/actions/action-tree'
import { Banner, Spinner, StateView, baseName, useGit } from './ui'

const PAGE_SIZE = 50
const SEARCH_LIMIT = 200
const ROW = 64

export interface HistoryModel {
  readonly viewModels: ISCMHistoryItemViewModel[]
  readonly loading: boolean
  readonly error: ScmGitError | null
  readonly hasMore: boolean
  readonly loadMore: () => void
  readonly reload: () => void
  readonly current: CurrentHistoryItemRefs
  readonly refs: ISCMHistoryItemRef[]
  readonly branchRef: ISCMHistoryItemRef | undefined
  readonly setBranchRef: (id: string | null) => void
  readonly searchText: string
  readonly setSearchText: (text: string) => void
  readonly searchBy: ScmLogSearchMode
  readonly setSearchBy: (by: ScmLogSearchMode) => void
  readonly searching: boolean
  readonly searchActive: boolean
  readonly paths: string[] | null
  readonly resolveRange: (vm: ISCMHistoryItemViewModel) => { ref: string; parentRef?: string } | undefined
}

export function useHistory(repo: ScmRepository, enabled: boolean, filter: ScmGraphFilter, paths: string[] | null): HistoryModel {
  const { api, root, state } = repo
  const [branchId, setBranchId] = useState<string | null>(null)
  const [commits, setCommits] = useState<Commit[]>([])
  const [historyItemRefs, setHistoryItemRefs] = useState<ISCMHistoryItemRef[]>([])
  const [mergeBase, setMergeBase] = useState<string | undefined>()
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<ScmGitError | null>(null)
  const [tick, setTick] = useState(0)
  const [searchText, setSearchText] = useState('')
  const [searchBy, setSearchBy] = useState<ScmLogSearchMode>('message')
  const [searchResults, setSearchResults] = useState<Commit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const generation = useRef(0)
  const refNamesRef = useRef<string[]>([])
  const loadingRef = useRef(false)
  const logPaths = paths && paths.length > 0 ? paths : undefined
  const pathsKey = logPaths?.join('\n') ?? ''
  const searchQuery = searchText.trim()
  const searchActive = searchQuery.length > 0

  const headKey = JSON.stringify(state?.HEAD ?? null)
  const current = useMemo(() => resolveCurrentHistoryItemRefs(state?.HEAD), [headKey])
  const refsKey = useMemo(() => (state?.refs ?? []).map((r) => `${r.type}:${r.name}:${r.commit}`).join(','), [state?.refs])
  const allRefs = useMemo(() => provideHistoryItemRefs(state?.refs ?? []).filter((ref) => !ref.name.endsWith('/HEAD')), [refsKey])
  const branchRef = useMemo(() => (branchId ? allRefs.find((ref) => ref.id === branchId) : undefined), [branchId, allRefs])
  useEffect(() => {
    if (branchId && state && !branchRef) setBranchId(null)
  }, [branchId, branchRef, state])

  const reloadKey = [
    enabled ? 'on' : 'off',
    root,
    filter,
    branchRef ? `${branchRef.id}@${branchRef.revision ?? ''}` : '',
    state?.HEAD?.commit ?? '',
    state?.HEAD?.name ?? '',
    state?.HEAD?.upstream?.commit ?? '',
    filter === 'all' ? refsKey : '',
    pathsKey,
    tick
  ].join('|')

  useEffect(() => {
    if (!state || !enabled) return
    const gen = ++generation.current
    const refs = branchRef
      ? [branchRef]
      : filter === 'all'
        ? provideHistoryItemRefs(state.refs)
        : [current.historyItemRef, current.historyItemRemoteRef, current.historyItemBaseRef].filter((ref): ref is ISCMHistoryItemRef => !!ref)
    const refNames = Array.from(new Set(refs.map((ref) => ref.revision ?? ref.id)))
    refNamesRef.current = refNames
    if ((!branchRef && !current.historyItemRef) || refNames.length === 0) {
      setCommits([])
      setHistoryItemRefs(refs)
      setHasMore(false)
      return
    }
    loadingRef.current = true
    setLoading(true)
    const started = performance.now()
    void (async () => {
      const page = await api.log(root, { refNames, maxEntries: PAGE_SIZE, skip: 0, paths: logPaths })
      const base =
        current.historyItemRef && current.historyItemRemoteRef ? await api.getMergeBase(root, current.historyItemRef.name, current.historyItemRemoteRef.name) : undefined
      if (gen !== generation.current) return
      loadingRef.current = false
      setLoading(false)
      setHistoryItemRefs(refs)
      setMergeBase(base?.ok ? base.value : undefined)
      if (!page.ok) {
        console.info(`[git] history failed: ${page.error.message}`)
        setError(page.error)
        setCommits([])
        setHasMore(false)
        return
      }
      console.info(`[git] history ${page.value.length} commits of ${refNames.join(', ')}${logPaths ? ` touching ${logPaths.join(', ')}` : ''} in ${Math.round(performance.now() - started)} ms`)
      setError(null)
      setCommits(page.value)
      setHasMore(page.value.length === PAGE_SIZE)
    })()
  }, [reloadKey])

  const loadMore = useCallback(() => {
    if (loadingRef.current || !hasMore || searchActive) return
    const gen = generation.current
    loadingRef.current = true
    setLoading(true)
    void api.log(root, { refNames: refNamesRef.current, maxEntries: PAGE_SIZE, skip: commits.length, paths: logPaths }).then((page) => {
      if (gen !== generation.current) return
      loadingRef.current = false
      setLoading(false)
      if (!page.ok) {
        setError(page.error)
        setHasMore(false)
        return
      }
      console.info(`[git] history page of ${page.value.length} more after ${commits.length}`)
      setCommits((prev) => [...prev, ...page.value])
      setHasMore(page.value.length === PAGE_SIZE)
    })
  }, [api, root, commits.length, hasMore, pathsKey, searchActive])

  useEffect(() => {
    if (!searchActive || !enabled) {
      setSearchResults(null)
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = window.setTimeout(() => {
      void api.log(root, { refNames: refNamesRef.current, maxEntries: SEARCH_LIMIT, paths: logPaths, search: { text: searchQuery, by: searchBy } }).then((result) => {
        if (cancelled) return
        setSearching(false)
        setSearchResults(result.ok ? result.value : [])
        setError(result.ok ? null : result.error)
        console.info(`[git] history search ${searchBy} "${searchQuery}": ${result.ok ? result.value.length : result.error.message}`)
      })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [searchActive, searchQuery, searchBy, reloadKey])

  const listed = searchActive ? searchResults ?? [] : commits

  const viewModels = useMemo(() => {
    const items = listed.map(toHistoryItem)
    const colorMap = getGraphColorMap(historyItemRefs, current)
    const addIncoming = !logPaths && !searchActive && historyItemRefs.some((ref) => ref.id === current.historyItemRemoteRef?.id)
    const addOutgoing = !logPaths && !searchActive && historyItemRefs.some((ref) => ref.id === current.historyItemRef?.id)
    return toISCMHistoryItemViewModelArray(items, colorMap, current.historyItemRef, current.historyItemRemoteRef, current.historyItemBaseRef, addIncoming, addOutgoing, mergeBase)
  }, [listed, historyItemRefs, current, mergeBase, pathsKey, searchActive])

  const resolveRange = useCallback(
    (vm: ISCMHistoryItemViewModel): { ref: string; parentRef?: string } | undefined => {
      const historyItem = vm.historyItem
      const { historyItemRef, historyItemRemoteRef } = current
      if (historyItemRemoteRef && (historyItem.id === SCMIncomingHistoryItemId || historyItem.id === SCMOutgoingHistoryItemId)) {
        if (!mergeBase || !historyItemRef) return undefined
        if (historyItem.id === SCMIncomingHistoryItemId) return { ref: historyItemRemoteRef.id, parentRef: mergeBase }
        return { ref: historyItemRef.id, parentRef: mergeBase }
      }
      let parentRef: string | undefined
      if (historyItem.parentIds.length > 0) {
        parentRef = historyItem.parentIds[0] === SCMIncomingHistoryItemId && historyItemRemoteRef ? mergeBase : historyItem.parentIds[0]
      }
      return { ref: historyItem.id, parentRef }
    },
    [current, mergeBase]
  )

  return {
    viewModels,
    loading: loading || searching,
    error,
    hasMore: hasMore && !searchActive,
    loadMore,
    reload: () => setTick((t) => t + 1),
    current,
    refs: allRefs,
    branchRef,
    setBranchRef: setBranchId,
    searchText,
    setSearchText,
    searchBy,
    setSearchBy,
    searching,
    searchActive,
    paths: logPaths ?? null,
    resolveRange
  }
}

export function isSynthetic(item: ISCMHistoryItem): boolean {
  return item.id === SCMIncomingHistoryItemId || item.id === SCMOutgoingHistoryItemId
}

export function messageEntry(item: ISCMHistoryItem): string {
  return (item.message || item.subject).trim()
}

function GraphColumn({ vm, height }: { vm: ISCMHistoryItemViewModel; height: number }) {
  const node = renderSCMHistoryItemGraph(vm)
  const top = renderSCMHistoryGraphPlaceholder(vm.inputSwimlanes)
  const bottom = renderSCMHistoryGraphPlaceholder(vm.outputSwimlanes)
  const width = Math.min(88, Math.max(node.width, top.width, bottom.width))
  const pad = (height - SWIMLANE_HEIGHT) / 2
  const kind = vm.kind === 'HEAD' ? 'current' : vm.kind === 'incoming-changes' || vm.kind === 'outgoing-changes' ? 'synthetic' : ''
  return (
    <div className={`pg-graph flex shrink-0 flex-col overflow-hidden ${kind}`} style={{ width, height }}>
      <div style={{ height: pad }}>
        <GitGraphSvg graph={top} stretch />
      </div>
      <GitGraphSvg graph={node} />
      <div style={{ height: pad }}>
        <GitGraphSvg graph={bottom} stretch />
      </div>
    </div>
  )
}

export function RefChip({ r }: { r: ISCMHistoryItemRef }) {
  const Icon = r.icon === 'tag' ? Tag : r.icon === 'remoteBranch' ? Cloud : GitCommitHorizontal
  return (
    <span className="flex h-[20px] max-w-[150px] shrink-0 items-center gap-1 rounded-full px-1.5 text-[11.5px] font-semibold" style={{ color: r.color ?? 'var(--ink-2)', background: `color-mix(in srgb, ${r.color ?? 'var(--ink-3)'} 18%, transparent)` }} data-pg-ref={r.name}>
      <Icon size={11} className="shrink-0" strokeWidth={2.4} />
      <span className="truncate">{r.name}</span>
    </span>
  )
}

function HistoryRow({ vm, onOpen, onMenu, picking }: { vm: ISCMHistoryItemViewModel; onOpen: () => void; onMenu: (x: number, y: number) => void; picking: boolean }) {
  const item = vm.historyItem
  const synthetic = isSynthetic(item)
  const refs = (item.references ?? []).slice(0, 2)
  const more = (item.references?.length ?? 0) - refs.length
  return (
    <div
      role="button"
      className={`pg-press flex select-none items-center pr-3 ${picking && synthetic ? 'opacity-40' : ''}`}
      style={{ height: ROW }}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault()
        if (!synthetic) onMenu(e.clientX, e.clientY)
      }}
      data-ctx-menu
      data-pg-row="commit"
      data-pg-commit={item.displayId ?? item.id}
    >
      <div className="w-2 shrink-0" />
      <GraphColumn vm={vm} height={ROW} />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-[3px] pl-2">
        <span className={`truncate text-[15px] leading-tight ${vm.kind === 'HEAD' ? 'font-semibold text-ink' : synthetic ? 'italic text-ink-2' : 'text-ink'}`}>{item.subject}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-tight text-ink-3">
          {refs.map((r) => (
            <RefChip key={r.id} r={r} />
          ))}
          {more > 0 && <span className="shrink-0">+{more}</span>}
          {!synthetic && (
            <span className="min-w-0 truncate">
              {item.author}
              {item.timestamp ? ` · ${relativeTimeShort(item.timestamp)}` : ''}
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

function filterNodes(h: HistoryModel, filter: ScmGraphFilter, setFilter: (f: ScmGraphFilter) => void): ActionNode[] {
  const groups: { category: string; label: string }[] = [
    { category: 'branches', label: 'Branches' },
    { category: 'remote branches', label: 'Remote branches' },
    { category: 'tags', label: 'Tags' }
  ]
  return [
    {
      id: 'git.history.scope',
      label: 'Show',
      inline: true,
      children: [
        { id: 'git.history.auto', label: 'Current branch and its remote', checked: !h.branchRef && filter === 'auto', run: () => setFilter('auto') },
        { id: 'git.history.all', label: 'All branches, remotes and tags', checked: !h.branchRef && filter === 'all', run: () => setFilter('all') }
      ]
    },
    ...groups
      .map((g) => ({
        id: `git.history.${g.category}`,
        label: g.label,
        inline: true,
        children: h.refs
          .filter((r) => r.category === g.category && !!r.name)
          .map((r) => ({ id: `git.history.ref:${r.id}`, label: r.name, hint: r.revision?.substring(0, 8), checked: h.branchRef?.id === r.id, run: () => h.setBranchRef(r.id) }))
      }))
      .filter((g) => g.children.length > 0)
  ]
}

export function HistoryTab({ comparing, onPick, onCompare, onCancelCompare }: { comparing: ISCMHistoryItem | null; onPick: (vm: ISCMHistoryItemViewModel) => void; onCompare: (item: ISCMHistoryItem) => void; onCancelCompare: () => void }) {
  const { history: h, settings, onSettings, openMenu, copy, showHistory } = useGit()
  const filter = settings.graphFilter
  const setFilter = (f: ScmGraphFilter): void => {
    h.setBranchRef(null)
    onSettings({ graphFilter: f })
  }
  const scrollRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  const vms = h.viewModels
  const count = vms.length + (h.hasMore || (h.loading && !h.searchActive && vms.length > 0) ? 1 : 0)
  const virtualizer = useVirtualizer({ count, getScrollElement: () => scrollRef.current, estimateSize: () => ROW, overscan: 12 })
  const items = virtualizer.getVirtualItems()
  const last = items.at(-1)?.index ?? -1
  useEffect(() => {
    if (last >= vms.length && h.hasMore) h.loadMore()
  }, [last, vms.length, h.hasMore, h.loadMore])
  const scopeLabel = h.branchRef ? h.branchRef.name : filter === 'all' ? 'All branches' : 'Current branch'
  const rowMenu = (vm: ISCMHistoryItemViewModel, x: number, y: number): void => {
    const item = vm.historyItem
    openMenu(
      [
        { id: 'git.commit.copyHash', label: 'Copy Hash', icon: 'doc.on.doc', run: (_v, at) => copy(item.id, at?.x ?? x, at?.y ?? y) },
        { id: 'git.commit.copyMessage', label: 'Copy Message', icon: 'doc.on.clipboard', run: (_v, at) => copy(messageEntry(item), at?.x ?? x, at?.y ?? y) },
        { id: 'git.commit.compare', label: 'Compare with…', icon: 'arrow.left.arrow.right', run: () => onCompare(item) }
      ],
      x,
      y
    )
  }

  let body: React.ReactNode
  if (h.error && vms.length === 0)
    body = (
      <StateView title="Couldn't load the history" body={h.error.message} data="history-error">
        <button type="button" onClick={h.reload} className="h-11 rounded-[12px] bg-elevated px-5 text-[15px] font-semibold text-ink" data-pg-button="Try again">
          Try again
        </button>
      </StateView>
    )
  else if (vms.length === 0 && h.loading) body = <StateView icon={<Spinner size={22} />} title={h.searchActive ? 'Searching' : 'Loading history'} data="history-loading" />
  else if (vms.length === 0)
    body = (
      <StateView
        title={h.searchActive ? 'No commits match' : h.paths ? 'No commits changed this' : 'No commits yet'}
        body={h.searchActive ? (h.searchBy === 'hash' && !/^[0-9a-f]+$/i.test(h.searchText.trim()) ? 'Hashes use only 0-9 and a-f.' : `No commit in ${scopeLabel.toLowerCase()} matches "${h.searchText.trim()}".`) : h.paths ? `No commit in ${scopeLabel.toLowerCase()} changed ${h.paths.map(baseName).join(', ')}.` : undefined}
        data="history-empty"
      />
    )
  else
    body = (
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {items.map((v) => {
          const vm = vms[v.index]
          return (
            <div key={v.key} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW, transform: `translateY(${v.start}px)` }}>
              {vm ? (
                <HistoryRow vm={vm} picking={!!comparing} onOpen={() => onPick(vm)} onMenu={(x, y) => rowMenu(vm, x, y)} />
              ) : (
                <div className="flex h-full items-center justify-center gap-2 text-[14px] text-ink-3" data-pg-row="more">
                  <Spinner /> Loading more
                </div>
              )}
            </div>
          )
        })}
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-col" data-pg-tab="history">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
        <label className={`flex h-11 min-w-0 flex-1 items-center gap-2 rounded-[10px] bg-sunken px-3 ${focused ? 'ring-1 ring-accent/60' : ''}`}>
          {h.searching ? <Spinner size={15} /> : <Search size={16} className="shrink-0 text-ink-3" />}
          <input
            value={h.searchText}
            onChange={(e) => h.setSearchText(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={h.searchBy === 'hash' ? 'Search by hash' : 'Search commit messages'}
            enterKeyHint="search"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-4"
            style={{ fontSize: 16 }}
            data-pg-history-search
          />
          {h.searchText && (
            <button type="button" aria-label="Clear search" onClick={() => h.setSearchText('')} className="-mr-3 flex h-11 w-11 items-center justify-center text-ink-3">
              <CircleX size={17} />
            </button>
          )}
        </label>
        <button
          type="button"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            openMenu(filterNodes(h, filter, setFilter), r.left, r.bottom)
          }}
          className="flex h-11 max-w-[44%] shrink-0 items-center gap-1 rounded-[10px] bg-sunken px-3 text-[14px] font-medium text-ink"
          data-pg-history-scope={scopeLabel}
        >
          <span className="truncate">{scopeLabel}</span>
          <ChevronDown size={15} className="shrink-0 text-ink-3" />
        </button>
      </div>
      {h.searchText.trim() && (
        <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
          {(['message', 'hash'] as const).map((by) => (
            <button
              key={by}
              type="button"
              aria-pressed={h.searchBy === by}
              onClick={() => h.setSearchBy(by)}
              className={`h-11 rounded-full px-4 text-[14px] font-medium ${h.searchBy === by ? 'bg-ink text-canvas' : 'bg-sunken text-ink-2'}`}
              data-pg-search-by={by}
            >
              {by === 'message' ? 'Message' : 'Hash'}
            </button>
          ))}
          {!h.searching && <span className="ml-auto text-[13px] text-ink-3">{vms.length >= SEARCH_LIMIT ? `First ${SEARCH_LIMIT}` : `${vms.length} ${vms.length === 1 ? 'commit' : 'commits'}`}</span>}
        </div>
      )}
      {h.paths && (
        <div className="mx-3 mb-2 flex shrink-0 items-center gap-2 rounded-[12px] bg-accent/12 py-1 pl-3 pr-1" data-pg-history-paths>
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
            History of <span className="font-semibold">{h.paths.length === 1 ? h.paths[0] : `${h.paths.length} items`}</span>
          </span>
          <button type="button" onClick={() => showHistory([])} className="h-11 shrink-0 rounded-[9px] px-3 text-[14px] font-semibold text-accent" data-pg-button="All commits">
            All Commits
          </button>
        </div>
      )}
      {comparing && (
        <div className="mx-3 mb-2 flex shrink-0 items-center gap-2 rounded-[12px] bg-accent/12 py-1 pl-3 pr-1" data-pg-compare-pick>
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
            Tap a commit to compare with <span className="font-mono">{comparing.displayId}</span>
          </span>
          <button type="button" onClick={onCancelCompare} className="h-11 shrink-0 rounded-[9px] px-3 text-[14px] font-semibold text-accent">
            Cancel
          </button>
        </div>
      )}
      {h.error && vms.length > 0 && (
        <Banner tone="err" action={{ label: 'Try again', run: h.reload }} data="history-error">
          {h.error.message}
        </Banner>
      )}
      <div ref={scrollRef} className="pg-scroll min-h-0 flex-1 overflow-auto" data-pg-history-list>
        {body}
      </div>
    </div>
  )
}
