import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useFloating } from '../../lib/floating'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  Ellipsis,
  FileSymlink,
  GitBranch,
  LoaderCircle,
  Minus,
  PackageOpen,
  Plus,
  RefreshCw,
  TriangleAlert,
  Undo2,
  X
} from 'lucide-react'
import {
  type ScmStashDetails,
  type ScmStashOptions,
  type ScmViewSettings,
  type Stash
} from '@shared/git-scm'
import { FloatingMenu, MenuLabel, menuItemClass } from '../ui/FloatingMenu'
import { ActionMenu } from '../../lib/actions/ActionMenu'
import { isMobileLayout } from '../../lib/mobile/mobile-back'
import { usePanelActions, type ActionNode } from '../../lib/actions/action-tree'
import { Checkbox } from '../ui/Checkbox'
import { Tooltip, useCopyHint } from '../ui/Tooltip'
import { relativeTimeShort } from '../../lib/relative-time'
import { conflictGroupLabel } from '../../lib/git/conflict-sides'
import { useDismiss } from '../ui/useDismiss'
import {
  getEnvDiffSides,
  getHistoryChangeDiffSides,
  getResourceDiffSides,
  getStatusColor,
  getStatusLetter,
  getStatusText,
  getStrikeThrough,
  joinPath,
  resourcePath,
  type DiffSides
} from '../../lib/git/scm-resource'
import {
  ResourceTree,
  countFiles,
  descendantFolderPaths,
  flattenResourceTree,
  type IResourceNode
} from '../../lib/git/resource-tree'
import type { ScmOperation, ScmRepository } from './use-scm-repository'
import { isMac, useListSelection } from './use-list-selection'
import { EnvAddIcon, EnvFileIcon, EnvWarningIcon } from './env-icons'
import { ScmProgressBar, ScmProgressLabel } from './ScmProgress'
import {
  canOpenFile,
  changeMenuNodes,
  collectPaths,
  groupPaths,
  isBothAddedOrModified,
  moreActionNodes,
  neverTargetEntries,
  plural,
  stashCreateNodes,
  stashDescription,
  stashItemNodes,
  stashLabel,
  useScmChanges,
  useScmCommitMessage,
  type ChangeMenuArgs,
  type GroupId,
  type Item,
  type MenuRow,
  type Row,
  type StashPick
} from './use-scm-changes'

const ROW_HEIGHT = isMobileLayout() ? 30 : 22
const INDENT = 8
const FOLDER_PAGE = 50
const ENV_RESIDUAL_TIP = 'Env file with new changes. Staging commits the new lines and leaves your env edits out.'
const STAGED_ENV_TIP = 'This file has staged changes. Unstage it first to add it to Env Changes.'
const ENV_CONFLICT_TIP = "These edits touch the same lines as your env edits, so they can't be staged on their own. Move them apart in the file, or use Keep as Env."
const ENV_STAGED_TIP = 'Env file. The staged version has the new lines and none of your env edits.'
const ENV_UNSAFE_TIP = 'The staged version still has env edits. Unstage it before you commit.'

const STASH_PICK_PLACEHOLDER: Record<StashPick, string> = {
  apply: 'Pick a stash to restore (keeps a copy)',
  pop: 'Pick a stash to restore and remove',
  drop: 'Pick a stash to delete',
  view: 'Pick a stash to show'
}

type StashDetailsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly details: ScmStashDetails }
  | { readonly kind: 'error'; readonly message: string }

interface Badge {
  readonly warn: boolean
  readonly label: string
}

interface MenuState {
  readonly x: number
  readonly y: number
  readonly targets: MenuRow[]
}

function scopeOf(row: { readonly group: GroupId; readonly stash?: Stash }): string {
  return row.stash ? `stashes:${row.stash.hash}` : row.group
}

function rowKey(row: Row): string | null {
  if (row.type === 'folder') return `${scopeOf(row)}:d:${row.path}`
  if (row.type === 'file') return `${scopeOf(row)}:f:${row.path}`
  return null
}

function useAltKey(): boolean {
  const [alt, setAlt] = useState(false)
  useEffect(() => {
    const update = (e: KeyboardEvent): void => setAlt(e.altKey)
    const reset = (): void => setAlt(false)
    window.addEventListener('keydown', update)
    window.addEventListener('keyup', update)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', update)
      window.removeEventListener('keyup', update)
      window.removeEventListener('blur', reset)
    }
  }, [])
  return alt
}

function folderKey(scope: string, path: string): string {
  return `${scope}:${path}`
}

export function ScmChangesPane({
  repo,
  settings,
  onSettings,
  onOpenDiff,
  onOpenMerge,
  onOpenFile,
  onShowHistory,
  actionScope,
  detailOpen = false
}: {
  repo: ScmRepository
  settings: ScmViewSettings
  onSettings: (patch: Partial<ScmViewSettings>) => void
  onOpenDiff: (key: string, sides: DiffSides) => void
  onOpenMerge: (key: string, path: string) => void
  onOpenFile?: (path: string) => void
  onShowHistory: (paths: string[]) => void
  actionScope?: string
  detailOpen?: boolean
}) {
  const { api, root, state, busy, run, refresh, operationError, dismissError, loadError } = repo
  const m = useScmChanges(repo, settings, onSettings)
  const {
    neverCommit,
    envUnsafe,
    stashes,
    mergeInProgress,
    groups,
    pendingPaths,
    discardable,
    stage,
    unstage,
    discard,
    pull,
    pullDefault,
    forcePush,
    createStash,
    applyStash,
    popStash,
    dropStash,
    dropAllStashes,
    acceptAll,
    ignore,
    abortRebase,
    abortMerge,
    addNever,
    keepEnv,
    removeNever,
    isStaged,
    isEnvUnsafe,
    unstaged,
    changedUnder,
    addTyped,
    stagedCount,
    rebasing,
    continuing,
    conflictWarning,
    HEAD,
    branchLabel,
    headLabel,
    ahead,
    behind
  } = m
  const cancelRemote = repo.remote && !repo.remote.cancelling ? repo.cancelRemote : undefined
  const [message, setMessage] = useScmCommitMessage(state)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [adding, setAdding] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [pullOpen, setPullOpen] = useState(false)
  const [more, setMore] = useState<{ x: number; y: number } | null>(null)
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number } | null>(null)
  const [stashMenu, setStashMenu] = useState<{ x: number; y: number } | null>(null)
  const [stashItemMenu, setStashItemMenu] = useState<{ x: number; y: number; stash: Stash } | null>(null)
  const [picker, setPicker] = useState<{ x: number; y: number; kind: StashPick } | null>(null)
  const [stashPrompt, setStashPrompt] = useState<Omit<ScmStashOptions, 'message'> | null>(null)
  const [expandedStashes, setExpandedStashes] = useState<ReadonlySet<string>>(() => new Set())
  const [stashDetails, setStashDetails] = useState<ReadonlyMap<string, StashDetailsState>>(() => new Map())
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const { hint: copyHint, copy } = useCopyHint()
  const sel = useListSelection()
  const alt = useAltKey()

  useEffect(() => {
    const wanted = stashes.filter((s) => expandedStashes.has(s.hash) && !stashDetails.has(s.hash))
    if (wanted.length === 0) return
    setStashDetails((prev) => {
      const next = new Map(prev)
      for (const s of wanted) next.set(s.hash, { kind: 'loading' })
      return next
    })
    for (const stash of wanted) {
      void api.stashShow(root, stash.index).then((result) => {
        setStashDetails((prev) =>
          new Map(prev).set(
            stash.hash,
            result.ok ? { kind: 'loaded', details: result.value } : { kind: 'error', message: result.error.message }
          )
        )
      })
    }
  }, [api, root, stashes, expandedStashes, stashDetails])

  const stashTrees = useMemo(() => {
    const out = new Map<string, { tree: ResourceTree<Item>; counts: Map<string, number>; untracked: Set<string> }>()
    for (const stash of stashes) {
      const entry = stashDetails.get(stash.hash)
      if (entry?.kind !== 'loaded') continue
      const tree = new ResourceTree<Item>()
      for (const change of entry.details.changes) tree.add(resourcePath(change), { change })
      out.set(stash.hash, { tree, counts: countFiles(tree.root), untracked: new Set(entry.details.untracked) })
    }
    return out
  }, [stashes, stashDetails])

  const rows = useMemo(() => {
    const out: Row[] = []
    const pushNodes = (
      group: GroupId,
      root: IResourceNode<Item>,
      counts: Map<string, number>,
      depth: number,
      stash?: Stash
    ): void => {
      const scope = stash ? `stashes:${stash.hash}` : group
      const flat = flattenResourceTree(root, (p) => collapsed.has(folderKey(scope, p)), {
        depth,
        pageSize: FOLDER_PAGE,
        shown: (p) => shown.get(folderKey(scope, p)) ?? 0
      })
      for (const r of flat) {
        if (r.kind === 'more') {
          out.push({ type: 'more', group, path: r.path, depth: r.depth, remaining: r.remaining ?? 0, stash })
        } else if (r.kind === 'folder') {
          out.push({
            type: 'folder',
            group,
            path: r.path,
            label: r.label,
            depth: r.depth,
            collapsed: r.collapsed,
            node: r.node,
            count: counts.get(r.path),
            stash
          })
        } else if (r.node.element) {
          out.push({ type: 'file', group, path: r.path, depth: r.depth, item: r.node.element, stash })
        }
      }
    }
    const pushTree = (group: Exclude<GroupId, 'stashes'>): void => {
      pushNodes(group, groups.trees[group].root, groups.counts[group], 1)
    }
    const section = (id: Exclude<GroupId, 'stashes'>, label: string, count: number, show: boolean): void => {
      if (!show) return
      out.push({ type: 'group', id, label, count })
      if (collapsed.has(id)) return
      if (id === 'never') {
        if (adding) out.push({ type: 'neverAdd' })
        if (neverCommit.length === 0 && !adding) {
          out.push({ type: 'empty', text: 'Right-click a change and add it to Env Changes' })
        }
      }
      if (id === 'index' && groups.index.length === 0) out.push({ type: 'empty', text: 'Nothing staged' })
      if (id === 'workingTree' && groups.workingTree.length === 0) out.push({ type: 'empty', text: 'No changes' })
      pushTree(id)
    }
    section('merge', conflictGroupLabel(state?.conflictSides), groups.merge.length, groups.merge.length > 0)
    section('index', 'Staged', groups.index.length, true)
    section('workingTree', 'Unstaged', groups.workingTree.length, true)
    section('never', 'Env Changes', groups.neverCount, true)
    out.push({ type: 'group', id: 'stashes', label: 'Stashes', count: stashes.length })
    if (!collapsed.has('stashes')) {
      if (stashes.length === 0) out.push({ type: 'empty', text: 'No stashes' })
      for (const stash of stashes) {
        const expanded = expandedStashes.has(stash.hash)
        out.push({ type: 'stash', stash, expanded })
        if (!expanded) continue
        const entry = stashDetails.get(stash.hash)
        const tree = stashTrees.get(stash.hash)
        if (tree) pushNodes('stashes', tree.tree.root, tree.counts, 2, stash)
        else if (entry?.kind === 'error') out.push({ type: 'empty', text: entry.message, depth: 2 })
        else out.push({ type: 'empty', text: 'Loading…', depth: 2 })
      }
    }
    return out
  }, [groups, collapsed, neverCommit, adding, shown, stashes, expandedStashes, stashDetails, stashTrees])

  const showMore = (row: Extract<Row, { type: 'more' }>, all: boolean): void => {
    const key = folderKey(scopeOf(row), row.path)
    setShown((prev) => {
      const current = Math.max(FOLDER_PAGE, prev.get(key) ?? 0)
      return new Map(prev).set(key, all ? Number.MAX_SAFE_INTEGER : current + FOLDER_PAGE)
    })
  }

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20
  })

  const groupIndices = useMemo(() => rows.flatMap((r, i) => (r.type === 'group' ? [i] : [])), [rows])
  const scrollOffset = virtualizer.scrollOffset ?? 0
  let stickyPos = -1
  while (stickyPos + 1 < groupIndices.length && groupIndices[stickyPos + 1] * ROW_HEIGHT <= scrollOffset) stickyPos++
  const stickyIndex = stickyPos >= 0 ? groupIndices[stickyPos] : -1
  const stickyNext = stickyPos >= 0 ? groupIndices[stickyPos + 1] : undefined
  const stickyShift = stickyNext === undefined ? 0 : Math.min(0, stickyNext * ROW_HEIGHT - scrollOffset - ROW_HEIGHT)
  const stickyRow = stickyIndex > 0 || (stickyIndex === 0 && scrollOffset > 0) ? rows[stickyIndex] : undefined

  const orderedKeys = useMemo(() => rows.map(rowKey).filter((k): k is string => k !== null), [rows])
  const rowByKey = useMemo(() => {
    const map = new Map<string, MenuRow>()
    for (const r of rows) {
      const k = rowKey(r)
      if (k && (r.type === 'folder' || r.type === 'file')) map.set(k, r)
    }
    return map
  }, [rows])
  const targetsFor = (row: MenuRow): MenuRow[] => {
    const key = rowKey(row)!
    if (!sel.has(key)) return [row]
    return [...sel.selected].map((k) => rowByKey.get(k)).filter((r): r is MenuRow => !!r)
  }

  const setKeys = useCallback((keys: string[], collapse: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      for (const k of keys) {
        if (collapse) next.add(k)
        else next.delete(k)
      }
      return next
    })
  }, [])

  const toggleGroup = (id: GroupId, recursive: boolean): void => {
    const collapse = !collapsed.has(id)
    if (id === 'stashes') {
      setKeys([id], collapse)
      if (recursive) {
        setExpandedStashes(collapse ? new Set() : new Set(stashes.map((s) => s.hash)))
      }
      return
    }
    const keys = recursive
      ? [id, ...descendantFolderPaths(groups.trees[id].root).map((p) => folderKey(id, p))]
      : [id]
    setKeys(keys, collapse)
  }

  const toggleFolder = (row: Extract<Row, { type: 'folder' }>, recursive: boolean): void => {
    const scope = scopeOf(row)
    const key = folderKey(scope, row.path)
    const collapse = !collapsed.has(key)
    const keys = recursive
      ? [key, ...descendantFolderPaths(row.node).map((p) => folderKey(scope, p))]
      : [key]
    setKeys(keys, collapse)
  }

  const toggleStash = (stash: Stash, recursive: boolean): void => {
    const expand = !expandedStashes.has(stash.hash)
    setExpandedStashes((prev) => {
      const next = new Set(prev)
      if (expand) next.add(stash.hash)
      else next.delete(stash.hash)
      return next
    })
    if (!recursive) return
    const tree = stashTrees.get(stash.hash)
    if (!tree) return
    const scope = `stashes:${stash.hash}`
    setKeys(descendantFolderPaths(tree.tree.root).map((p) => folderKey(scope, p)), !expand)
  }

  const viewStash = (stash: Stash): void => {
    setKeys(['stashes'], false)
    setExpandedStashes((prev) => new Set(prev).add(stash.hash))
  }

  const pickStash = (kind: StashPick, stash: Stash): void => {
    if (kind === 'apply') void applyStash(stash)
    else if (kind === 'pop') void popStash(stash)
    else if (kind === 'drop') void dropStash(stash)
    else viewStash(stash)
  }
  const openFile = onOpenFile ? (path: string): void => onOpenFile(joinPath(root, path)) : undefined

  const openChange = (group: GroupId, item: Item, stash?: Stash): void => {
    if (!item.change) return
    const path = resourcePath(item.change)
    if (stash) {
      const untracked = stashTrees.get(stash.hash)?.untracked.has(path)
      const parent = stash.parents.length > 0 ? stash.parents[0] : `${stash.hash}^`
      const ref = untracked ? (stash.parents.length === 3 ? stash.parents[2] : stash.hash) : stash.hash
      onOpenDiff(`stash:${stash.hash}:${path}`, getHistoryChangeDiffSides(item.change, parent, ref))
      return
    }
    if (group === 'merge' && isBothAddedOrModified(item.change)) {
      onOpenMerge(`${group}:${path}`, path)
      return
    }
    onOpenDiff(
      `${group}:${path}`,
      group === 'workingTree' && item.residual ? getEnvDiffSides(path) : getResourceDiffSides(item.change, state?.indexChanges ?? [])
    )
  }

  const badgeFor = (row: Extract<Row, { type: 'file' }>): Badge | undefined => {
    const { entry, residual } = row.item
    if (row.group === 'workingTree' && residual) {
      return { warn: residual.conflict, label: residual.conflict ? ENV_CONFLICT_TIP : ENV_RESIDUAL_TIP }
    }
    if (row.group === 'index' && entry) {
      return envUnsafe.has(row.path) ? { warn: true, label: ENV_UNSAFE_TIP } : { warn: false, label: ENV_STAGED_TIP }
    }
    return undefined
  }

  const canCommit = m.canCommit(message)
  const commitHint = !state
    ? ''
    : rebasing
      ? busy === 'Commit' ? 'Continuing Rebase...' : 'Continue Rebase'
      : mergeInProgress
        ? busy === 'Commit' ? 'Continuing Merge...' : 'Continue Merge'
        : stagedCount === 0
          ? 'Stage changes to commit'
          : !message.trim()
            ? 'Write a commit message'
            : `Commit ${plural(stagedCount, 'staged file')}`

  const commit = async (override?: string): Promise<boolean> => {
    const text = override ?? message
    const done = await m.commitText(text, () => {
      if (override !== undefined) setMessage(override)
    })
    if (done) setMessage('')
    return done
  }

  const placeholder = branchLabel
    ? `Message (${isMac ? '⌘Enter' : 'Ctrl+Enter'} to commit on "${branchLabel}")`
    : `Message (${isMac ? '⌘Enter' : 'Ctrl+Enter'} to commit)`

  const onStash = (options: Omit<ScmStashOptions, 'message'>, text?: string): void => {
    if (text === undefined) setStashPrompt(options)
    else void createStash({ ...options, message: text || undefined })
  }
  const moreNodes = (openPicker: (kind: StashPick) => void): ActionNode[] =>
    moreActionNodes({
      rebasing,
      mergeInProgress,
      onPull: () => void pull({ rebase: false, autoStash: settings.pullAutoStash }),
      onPullRebase: () => void pull({ rebase: true, autoStash: settings.pullAutoStash }),
      onPush: () => void run('Push', () => api.push(root)),
      onForcePush: () => void forcePush(),
      onFetch: () => void run('Fetch', () => api.fetch(root)),
      onAbortRebase: () => void abortRebase(),
      onAbortMerge: () => void abortMerge(),
      onStash,
      onApplyLatest: () => void applyStash(),
      onPopLatest: () => void popStash(),
      onDropAll: () => void dropAllStashes(),
      onPick: (kind, st) => (st ? pickStash(kind, st) : openPicker(kind)),
      stashes
    })
  const branchNodes = (): ActionNode[] => m.branchNodes(copy)
  usePanelActions(
    actionScope,
    m.panelNodes({
      detailOpen,
      message,
      commit,
      onAddEnvInline: () => setAdding(true),
      more: moreNodes((kind) => setPicker({ x: 0, y: 0, kind }))
    })
  )

  const onContextMenu = (e: ReactMouseEvent, row: MenuRow): void => {
    e.preventDefault()
    const targets = sel
      .contextTarget(rowKey(row)!)
      .map((k) => rowByKey.get(k))
      .filter((r): r is MenuRow => !!r)
    setMenu({ x: e.clientX, y: e.clientY, targets: targets.length > 0 ? targets : [row] })
  }

  const onFileClick = (e: ReactMouseEvent, row: Extract<Row, { type: 'file' }>): void => {
    const mode = sel.click(e, rowKey(row)!, orderedKeys)
    if (mode === 'single') openChange(row.group, row.item, row.stash)
  }

  const onFolderClick = (e: ReactMouseEvent, row: Extract<Row, { type: 'folder' }>): void => {
    if (e.altKey) {
      toggleFolder(row, true)
      return
    }
    if (sel.click(e, rowKey(row)!, orderedKeys) === 'single') toggleFolder(row, false)
  }

  const groupActions = (id: GroupId): React.ReactNode => {
    if (id !== 'stashes' && id !== 'never' && repo.progress.length > 0) return null
    if (id === 'index') {
      return groups.index.length > 0 ? (
        <RowAction title="Unstage All Changes" onClick={() => void unstage(groups.index.map(resourcePath))}>
          <Minus size={14} />
        </RowAction>
      ) : null
    }
    if (id === 'workingTree') {
      return groups.workingTree.length > 0 ? (
        <>
          <RowAction title="Discard All Changes" onClick={() => void discard(groups.workingTree.map(resourcePath))}>
            <Undo2 size={14} />
          </RowAction>
          <RowAction title="Stage All Changes" onClick={() => void stage(groups.workingTree.map(resourcePath))}>
            <Plus size={14} />
          </RowAction>
        </>
      ) : null
    }
    if (id === 'merge') {
      return (
        <RowAction title="Stage All Merge Changes" onClick={() => void stage(groups.merge.map(resourcePath), true)}>
          <Plus size={14} />
        </RowAction>
      )
    }
    if (id === 'stashes') {
      return (
        <RowAction
          title="Stash Changes"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setStashMenu({ x: r.left, y: r.bottom + 2 })
          }}
        >
          <Plus size={14} />
        </RowAction>
      )
    }
    return (
      <RowAction title="Add a file" onClick={() => setAdding(true)}>
        <Plus size={14} />
      </RowAction>
    )
  }

  const folderActions = (row: Extract<Row, { type: 'folder' }>): React.ReactNode => {
    if (row.group === 'stashes') return null
    if (row.group === 'never') {
      const paths = groupPaths(targetsFor(row), ['never']).filter((p) => discardable.has(p))
      return (
        <>
          {paths.length > 0 && (
            <RowAction title="Discard Changes" onClick={() => void discard([], paths)}>
              <Undo2 size={14} />
            </RowAction>
          )}
          <RowAction title="Remove these files from Env Changes" onClick={() => void removeNever(neverTargetEntries(targetsFor(row)))}>
            <X size={14} />
          </RowAction>
        </>
      )
    }
    if (row.group === 'index') {
      return (
        <RowAction title="Unstage Changes" onClick={() => void unstage(groupPaths(targetsFor(row), ['index']))}>
          <Minus size={14} />
        </RowAction>
      )
    }
    return (
      <>
        {row.group === 'workingTree' && (() => {
          const all = groupPaths(targetsFor(row), ['workingTree'])
          const ok = unstaged(all)
          return (
            <RowAction
              title={
                ok.length === 0
                  ? STAGED_ENV_TIP
                  : ok.length < all.length
                    ? `Add ${plural(ok.length, 'changed file')} in this folder to Env Changes. ${plural(all.length - ok.length, 'staged file')} will be skipped.`
                    : 'Add the changed files in this folder to Env Changes (Satura Space only)'
              }
              disabled={ok.length === 0}
              onClick={() => void addNever(ok)}
            >
              <EnvAddIcon size={13} />
            </RowAction>
          )
        })()}
        {row.group === 'workingTree' && (
          <RowAction title="Discard Changes" onClick={() => void discard(groupPaths(targetsFor(row), ['workingTree']))}>
            <Undo2 size={14} />
          </RowAction>
        )}
        <RowAction title="Stage Changes" onClick={() => void stage(groupPaths(targetsFor(row), ['workingTree', 'merge']))}>
          <Plus size={14} />
        </RowAction>
      </>
    )
  }

  const fileActions = (row: Extract<Row, { type: 'file' }>): React.ReactNode => {
    const { change, entry } = row.item
    const open = openFile && canOpenFile(change) ? (
      <RowAction title="Open File" onClick={() => openFile(row.path)}>
        <FileSymlink size={14} />
      </RowAction>
    ) : null
    if (row.group === 'stashes') return open
    if (row.group === 'never') {
      return entry === row.path ? (
        <>
          {open}
          {change && discardable.has(row.path) && (
            <RowAction title="Discard Changes" onClick={() => void discard([], groupPaths(targetsFor(row), ['never']))}>
              <Undo2 size={14} />
            </RowAction>
          )}
          <RowAction title="Remove from Env Changes" onClick={() => void removeNever(neverTargetEntries(targetsFor(row)))}>
            <X size={14} />
          </RowAction>
        </>
      ) : null
    }
    if (!change) return null
    if (row.group === 'index') {
      return (
        <>
          {open}
          <RowAction title="Unstage Changes" onClick={() => void unstage(groupPaths(targetsFor(row), ['index']))}>
            <Minus size={14} />
          </RowAction>
        </>
      )
    }
    return (
      <>
        {open}
        {row.group === 'workingTree' && !row.item.residual && (
          <RowAction
            title={isStaged(row.path) ? STAGED_ENV_TIP : 'Add to Env Changes (Satura Space only)'}
            disabled={isStaged(row.path)}
            onClick={() => void addNever(unstaged(groupPaths(targetsFor(row), ['workingTree'])))}
          >
            <EnvAddIcon size={13} />
          </RowAction>
        )}
        {row.group === 'workingTree' && discardable.has(row.path) && (
          <RowAction title={row.type === 'file' && row.item.residual ? 'Discard Only Non-Env Changes' : 'Discard Changes'} onClick={() => void discard(groupPaths(targetsFor(row), ['workingTree']))}>
            <Undo2 size={14} />
          </RowAction>
        )}
        <RowAction title="Stage Changes" onClick={() => void stage(groupPaths(targetsFor(row), ['workingTree', 'merge']))}>
          <Plus size={14} />
        </RowAction>
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-scm-changes>
      <div className="relative flex h-[26px] shrink-0 items-center gap-0.5 border-b border-hairline px-2">
        {HEAD ? (
          <div
            role="button"
            data-scm-branch
            className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded text-xs text-ink-3 hover:text-ink-2"
            title={HEAD.upstream ? `${HEAD.upstream.remote}/${HEAD.upstream.name}` : 'No upstream branch'}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setBranchMenu({ x: r.left, y: r.bottom + 2 })
            }}
          >
            <GitBranch size={13} className="shrink-0" />
            <span className="shrink-0 truncate text-ink-2">{headLabel}</span>
            {HEAD.upstream ? (
              <span className="truncate">
                {behind}↓ {ahead}↑ {HEAD.upstream.remote}/{HEAD.upstream.name}
              </span>
            ) : (
              <span className="truncate">not published</span>
            )}
          </div>
        ) : (
          <span className="shrink-0 truncate text-xs font-medium text-ink-2">Git</span>
        )}
        <span className="flex min-w-0 flex-1 items-center pl-2">
          <ScmProgressLabel progress={repo.progress} remote={repo.remote} />
        </span>
        <ScmProgressBar progress={repo.progress} remote={repo.remote} className="-bottom-px" />
        <ToolbarButton title="Fetch" operation="Fetch" busy={busy} onCancel={cancelRemote} onClick={() => void run('Fetch', () => api.fetch(root))}>
          <CloudDownload size={14} />
        </ToolbarButton>
        <PullButton
          behind={behind}
          busy={busy}
          onCancel={cancelRemote}
          open={pullOpen}
          onOpenChange={setPullOpen}
          settings={settings}
          onPull={() => void pullDefault()}
          onPullWith={(rebase, autoStash) => {
            onSettings({ pullRebase: rebase, pullAutoStash: autoStash })
            void pull({ rebase, autoStash })
          }}
        />
        <PushButton
          title={HEAD?.upstream ? (ahead ? `Push (${ahead} outgoing)` : 'Push') : 'Publish Branch'}
          ahead={ahead}
          busy={busy}
          onCancel={cancelRemote}
          onPush={() => void run('Push', () => api.push(root))}
          onForcePush={() => void forcePush()}
        />
        <Tooltip label="Refresh">
          <button type="button" aria-label="Refresh" onClick={() => void refresh()} className="rounded p-1 text-ink-3 hover:bg-white/10 hover:text-ink">
            <RefreshCw size={13} />
          </button>
        </Tooltip>
        <Tooltip label="More Actions...">
          <button
            ref={moreRef}
            type="button"
            aria-label="More Actions..."
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setMore({ x: r.right - 200, y: r.bottom + 2 })
            }}
            className="rounded p-1 text-ink-3 hover:bg-white/10 hover:text-ink"
          >
            <Ellipsis size={14} />
          </button>
        </Tooltip>
      </div>

      <div className="shrink-0 space-y-2 px-2 pb-2 pt-2">
        {loadError && <div className="rounded border border-rose-400/30 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-200">{loadError.message}</div>}
        {state?.isRepositoryHuge && (
          <div className="rounded border border-amber-400/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
            This repository has too many active changes, only the first {state.isRepositoryHuge.limit} are shown.
          </div>
        )}
        {conflictWarning ? (
          <div className="rounded border border-amber-400/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200" data-scm-conflict-warning>
            <div className="flex items-start gap-1.5">
              <TriangleAlert size={13} className="mt-px shrink-0 text-amber-300" />
              <span className="min-w-0 flex-1 break-words">{conflictWarning}</span>
              <button type="button" onClick={dismissError} className="shrink-0 text-amber-300 hover:text-amber-100">
                <X size={13} />
              </button>
            </div>
          </div>
        ) : operationError && (
          <div className="rounded border border-rose-400/30 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-100">
            <div className="flex items-start gap-1.5">
              <TriangleAlert size={13} className="mt-px shrink-0 text-rose-300" />
              <span className="min-w-0 flex-1 break-words">
                {operationError.operation} failed: {operationError.error.message}
              </span>
              <button type="button" onClick={dismissError} className="shrink-0 text-rose-300 hover:text-rose-100">
                <X size={13} />
              </button>
            </div>
            {operationError.error.stderr && operationError.error.stderr.trim() !== operationError.error.message.trim() && (
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-rose-200/80">
                {operationError.error.stderr.trim()}
              </pre>
            )}
          </div>
        )}
        <textarea
          ref={inputRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void commit()
            }
          }}
          placeholder={placeholder}
          rows={Math.min(10, Math.max(1, message.split('\n').length))}
          className="block w-full resize-none rounded border border-hairline bg-sunken px-2 py-1 text-[13px] text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
        />
        <Tooltip label={commitHint} className="flex w-full">
          <button
            type="button"
            disabled={!canCommit}
            onClick={() => void commit()}
            className="flex h-[26px] w-full items-center justify-center gap-1.5 rounded bg-accent text-[13px] text-accent-fg enabled:hover:brightness-110 disabled:pointer-events-none disabled:opacity-40"
          >
            {busy === 'Commit' ? <LoaderCircle size={14} className="animate-spin" /> : <Check size={14} />}
            {continuing ? 'Continue' : stagedCount > 0 ? `Commit ${plural(stagedCount, 'file')}` : 'Commit'}
          </button>
        </Tooltip>
      </div>

      <div
        ref={scrollRef}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-auto outline-none"
        onKeyDown={(e) => {
          if (e.key === 'Escape') sel.clear()
          if (e.key.toLowerCase() === 'a' && (isMac ? e.metaKey : e.ctrlKey)) {
            e.preventDefault()
            sel.select(orderedKeys)
          }
        }}
      >
        {stickyRow?.type === 'group' && (
          <div className="sticky top-0 z-10 h-0">
            <div className="bg-canvas" style={{ height: ROW_HEIGHT, transform: `translateY(${stickyShift}px)` }}>
              <GroupRow
                row={stickyRow}
                collapsed={collapsed.has(stickyRow.id)}
                onToggle={(recursive) => {
                  scrollRef.current?.scrollTo({ top: stickyIndex * ROW_HEIGHT })
                  toggleGroup(stickyRow.id, recursive)
                }}
                actions={groupActions(stickyRow.id)}
              />
            </div>
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index]
            return (
              <div key={v.key} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${v.start}px)` }}>
                {row.type === 'stash' ? (
                  <StashRow
                    row={row}
                    alt={alt}
                    onClick={(e) => toggleStash(row.stash, e.altKey)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setStashItemMenu({ x: e.clientX, y: e.clientY, stash: row.stash })
                    }}
                    onApply={(pop) => void (pop ? popStash(row.stash) : applyStash(row.stash))}
                  />
                ) : row.type === 'group' ? (
                  <GroupRow
                    row={row}
                    collapsed={collapsed.has(row.id)}
                    onToggle={(recursive) => toggleGroup(row.id, recursive)}
                    actions={groupActions(row.id)}
                  />
                ) : row.type === 'folder' ? (
                  <FolderRow
                    row={row}
                    pending={!row.stash && pendingPaths.size > 0 && collectPaths(row.node).some((p) => pendingPaths.has(p))}
                    selected={sel.has(rowKey(row)!)}
                    count={row.count}
                    onClick={(e) => onFolderClick(e, row)}
                    onContextMenu={(e) => onContextMenu(e, row)}
                    actions={folderActions(row)}
                  />
                ) : row.type === 'file' ? (
                  <FileRow
                    row={row}
                    pending={!row.stash && pendingPaths.has(row.path)}
                    selected={sel.has(rowKey(row)!)}
                    badge={badgeFor(row)}
                    onClick={(e) => onFileClick(e, row)}
                    onContextMenu={(e) => onContextMenu(e, row)}
                    actions={fileActions(row)}
                  />
                ) : row.type === 'more' ? (
                  <div className="flex h-full select-none items-center pr-2 text-xs" style={{ paddingLeft: 2 + row.depth * INDENT + 16 }}>
                    <button type="button" className="pl-0.5 text-ink-3 hover:text-ink" onClick={() => showMore(row, false)}>
                      Show {Math.min(FOLDER_PAGE, row.remaining)} more
                    </button>
                    <span className="mx-1.5 text-ink-4">·</span>
                    <button type="button" className="text-ink-3 hover:text-ink" onClick={() => showMore(row, true)}>
                      Show all {row.remaining}
                    </button>
                  </div>
                ) : row.type === 'neverAdd' ? (
                  <NeverAddRow
                    onSubmit={(value) => {
                      setAdding(false)
                      if (value.trim()) addTyped(value)
                    }}
                    onCancel={() => setAdding(false)}
                  />
                ) : (
                  <div className="flex h-full items-center truncate text-xs italic text-ink-4" style={{ paddingLeft: (row.depth ?? 1) * INDENT + 16 }}>
                    {row.text}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {branchMenu && <ActionMenu x={branchMenu.x} y={branchMenu.y} onDismiss={() => setBranchMenu(null)} className="min-w-[260px]" nodes={branchNodes()} />}
      {more && (
        <ActionMenu
          x={more.x}
          y={more.y}
          onDismiss={() => setMore(null)}
          className="min-w-[300px]"
          nodes={moreNodes((kind) => setPicker({ x: more.x, y: more.y, kind }))}
        />
      )}
      {stashMenu && (
        <ActionMenu
          x={stashMenu.x}
          y={stashMenu.y}
          onDismiss={() => setStashMenu(null)}
          className="min-w-[300px]"
          nodes={stashCreateNodes(onStash, 'repositories')}
        />
      )}
      {picker && (
        <FloatingMenu x={picker.x} y={picker.y} onDismiss={() => setPicker(null)} className="max-w-[420px]">
          <MenuLabel>{STASH_PICK_PLACEHOLDER[picker.kind]}</MenuLabel>
          {stashes.length === 0 ? (
            <div className="px-3 py-1.5 text-sm text-ink-3">This repository has no stashes.</div>
          ) : (
            stashes.map((stash) => (
              <button
                key={stash.hash}
                className={menuItemClass}
                onClick={() => {
                  setPicker(null)
                  pickStash(picker.kind, stash)
                }}
              >
                <span className="min-w-0 truncate">{stashLabel(stash)}</span>
                <span className="ml-auto shrink-0 pl-3 text-xs text-ink-3">{stashDescription(stash)}</span>
              </button>
            ))
          )}
        </FloatingMenu>
      )}
      {stashItemMenu && (
        <ActionMenu
          x={stashItemMenu.x}
          y={stashItemMenu.y}
          onDismiss={() => setStashItemMenu(null)}
          nodes={stashItemNodes({
            stash: stashItemMenu.stash,
            onView: () => viewStash(stashItemMenu.stash),
            onApply: () => void applyStash(stashItemMenu.stash),
            onPop: () => void popStash(stashItemMenu.stash),
            onDrop: () => void dropStash(stashItemMenu.stash),
            onCopy: copy
          })}
        />
      )}
      {stashPrompt && moreRef.current && (
        <StashMessagePrompt
          anchor={moreRef.current.getBoundingClientRect()}
          initial=""
          onCancel={() => setStashPrompt(null)}
          onSubmit={(value) => {
            const options = stashPrompt
            setStashPrompt(null)
            void createStash({ ...options, message: value || undefined })
          }}
        />
      )}
      {menu && (
        <ChangeContextMenu
          menu={menu}
          root={root}
          onDismiss={() => setMenu(null)}
          onOpenFile={openFile}
          conflictSides={state?.conflictSides}
          onAcceptAll={(paths, type) => void acceptAll(paths, type)}
          onIgnore={(entries) => void ignore(entries)}
          onStage={(paths) => void stage(paths)}
          onUnstage={(paths) => void unstage(paths)}
          onDiscard={(paths, wholeEnv) => void discard(paths, wholeEnv)}
          isDiscardable={(path) => discardable.has(path)}
          onNever={(paths) => void addNever(paths)}
          onKeepEnv={(paths) => void keepEnv(paths)}
          onRemoveNever={(paths) => void removeNever(paths)}
          changedUnder={changedUnder}
          isStaged={isStaged}
          isEnvUnsafe={isEnvUnsafe}
          onReveal={(path) => void api.revealInFolder(root, path)}
          onCopy={copy}
          onShowHistory={onShowHistory}
        />
      )}
      {copyHint}
    </div>
  )
}

function ToolbarButton({
  title,
  operation,
  busy,
  onCancel,
  onClick,
  children
}: {
  title: string
  operation: ScmOperation
  busy: ScmOperation | null
  onCancel?: () => void
  onClick: () => void
  children: React.ReactNode
}) {
  const running = busy === operation
  const cancel = running ? onCancel : undefined
  return (
    <Tooltip label={cancel ? `Cancel ${operation}` : running ? `${title}…` : title}>
      <button
        type="button"
        aria-label={cancel ? `Cancel ${operation}` : title}
        disabled={busy !== null && !cancel}
        onClick={cancel ?? onClick}
        className="group/cancel flex items-center gap-0.5 rounded p-1 text-ink-3 hover:bg-white/10 hover:text-ink disabled:hover:bg-transparent"
      >
        {running ? (
          <>
            <LoaderCircle size={14} className={`animate-spin ${cancel ? 'group-hover/cancel:hidden' : ''}`} />
            {cancel && <X size={14} className="hidden group-hover/cancel:block" />}
          </>
        ) : (
          children
        )}
      </button>
    </Tooltip>
  )
}

function RowAction({
  title,
  onClick,
  disabled,
  children
}: {
  title: string
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip label={title}>
      <button
        type="button"
        aria-label={title}
        aria-disabled={disabled}
        onClick={(e) => {
          e.stopPropagation()
          if (!disabled) onClick(e)
        }}
        className={`rounded p-0.5 ${disabled ? 'cursor-default text-ink-4' : 'text-ink-2 hover:bg-white/10 hover:text-ink'}`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function Twistie({ collapsed }: { collapsed: boolean }) {
  const Chevron = collapsed ? ChevronRight : ChevronDown
  return (
    <div className="flex w-4 shrink-0 items-center justify-center">
      <Chevron size={14} className="text-ink-3" />
    </div>
  )
}

function GroupRow({
  row,
  collapsed,
  onToggle,
  actions
}: {
  row: Extract<Row, { type: 'group' }>
  collapsed: boolean
  onToggle: (recursive: boolean) => void
  actions: React.ReactNode
}) {
  return (
    <div
      className="scm-row group flex h-full cursor-pointer select-none items-center pr-2"
      style={{ paddingLeft: 2 }}
      onClick={(e) => onToggle(e.altKey)}
    >
      <Twistie collapsed={collapsed} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate pl-0.5 text-xs font-medium text-ink-2">
        {row.label}
        {row.id === 'never' && (
          <span className="rounded bg-white/10 px-1 py-px text-[10px] font-medium normal-case tracking-normal text-ink-3">
            Satura Space only
          </span>
        )}
      </span>
      <div className="hidden items-center group-hover:flex">{actions}</div>
      <span className="ml-1 min-w-[18px] rounded-full bg-white/10 px-1.5 text-center text-[11px] leading-[18px] text-ink-2">{row.count}</span>
    </div>
  )
}

function FolderRow({
  row,
  pending,
  selected,
  count,
  onClick,
  onContextMenu,
  actions
}: {
  row: Extract<Row, { type: 'folder' }>
  pending: boolean
  selected: boolean
  count?: number
  onClick: (e: ReactMouseEvent) => void
  onContextMenu: (e: ReactMouseEvent) => void
  actions: React.ReactNode
}) {
  return (
    <div
      className={`scm-row group flex h-full cursor-pointer select-none items-center pr-2 ${selected ? 'selected' : ''} ${pending ? 'opacity-60' : ''}`}
      style={{ paddingLeft: 2 + row.depth * INDENT }}
      data-scm-group={row.group}
      aria-busy={pending}
      title={row.path}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <Twistie collapsed={row.collapsed} />
      <span className="min-w-0 flex-1 truncate pl-0.5 text-[13px] text-ink-2">{row.label}</span>
      {!pending && <div className="ml-1 hidden shrink-0 items-center group-hover:flex">{actions}</div>}
      {pending && <LoaderCircle size={12} className="ml-1 shrink-0 animate-spin text-ink-3" />}
      {count !== undefined && count > 0 && <span className="ml-1 shrink-0 text-[11px] text-ink-4">{count}</span>}
    </div>
  )
}

function FileRow({
  row,
  pending,
  selected,
  badge,
  onClick,
  onContextMenu,
  actions
}: {
  row: Extract<Row, { type: 'file' }>
  pending: boolean
  selected: boolean
  badge?: Badge
  onClick: (e: ReactMouseEvent) => void
  onContextMenu: (e: ReactMouseEvent) => void
  actions: React.ReactNode
}) {
  const { change, entry } = row.item
  const name = row.path.substring(row.path.lastIndexOf('/') + 1)
  const isEntry = row.group === 'never' && entry === row.path
  const color = change ? getStatusColor(change.status) : undefined
  return (
    <div
      className={`scm-row group flex h-full cursor-pointer select-none items-center pr-2 ${selected ? 'selected' : ''} ${row.group === 'never' || pending ? 'opacity-60' : ''}`}
      style={{ paddingLeft: 2 + row.depth * INDENT }}
      aria-busy={pending}
      data-scm-group={row.group}
      title={change ? `${row.path} • ${getStatusText(change.status)}` : `${row.path} is marked as an env change (no changes)`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className="w-4 shrink-0" />
      {isEntry && <EnvFileIcon size={12} className="mr-1 shrink-0 text-sky-400/70" />}
      {badge && (
        <Tooltip label={badge.label}>
          <span className={`mr-1 flex shrink-0 items-center ${badge.warn ? 'text-amber-400' : 'text-sky-400/70'}`}>
            {badge.warn ? <EnvWarningIcon size={12} /> : <EnvFileIcon size={12} />}
          </span>
        </Tooltip>
      )}
      <span
        className={`min-w-0 flex-1 truncate pl-0.5 text-[13px] ${change && getStrikeThrough(change.status) ? 'line-through' : ''} ${change ? '' : 'text-ink-4'}`}
        style={{ color }}
      >
        {name}
      </span>
      {!pending && <div className="ml-1 hidden shrink-0 items-center group-hover:flex">{actions}</div>}
      {pending && <LoaderCircle size={12} className="ml-1 shrink-0 animate-spin text-ink-3" />}
      {change && (
        <span className="ml-1 w-3 shrink-0 text-center text-xs font-semibold" style={{ color }}>
          {getStatusLetter(change.status)}
        </span>
      )}
    </div>
  )
}

function NeverAddRow({ onSubmit, onCancel }: { onSubmit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="flex h-full items-center pr-2" style={{ paddingLeft: 2 + INDENT + 16 }}>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit(value)
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={() => onSubmit(value)}
        placeholder="path/to/file"
        className="h-[20px] w-full rounded border border-accent bg-sunken px-1.5 text-[12px] text-ink placeholder:text-ink-4 focus:outline-none"
      />
    </div>
  )
}

const PULL_OPTIONS_WIDTH = 300

function PullButton({
  behind,
  busy,
  onCancel,
  open,
  onOpenChange,
  settings,
  onPull,
  onPullWith
}: {
  behind: number
  busy: ScmOperation | null
  onCancel?: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: ScmViewSettings
  onPull: () => void
  onPullWith: (rebase: boolean, autoStash: boolean) => void
}) {
  const [rebase, setRebase] = useState(settings.pullRebase)
  const [autoStash, setAutoStash] = useState(settings.pullAutoStash)
  const wrapRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useFloating(anchorRef.current, menuRef, { placement: 'bottom-end', gap: 6 }, open)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  useDismiss(wrapRef, close, open)
  useEffect(() => {
    if (!open) return
    setRebase(settings.pullRebase)
    setAutoStash(settings.pullAutoStash)
  }, [open, settings.pullRebase, settings.pullAutoStash])
  const title = settings.pullRebase ? 'Pull (Rebase)' : 'Pull'
  return (
    <div ref={wrapRef} className="[-webkit-app-region:no-drag]">
      <div ref={anchorRef} className="flex items-center">
        <ToolbarButton title={behind ? `${title} (${behind} incoming)` : title} operation="Pull" busy={busy} onCancel={onCancel} onClick={onPull}>
          <ArrowDown size={14} />
          {behind > 0 && <span className="text-[11px]">{behind}</span>}
        </ToolbarButton>
        <Tooltip label="Pull options">
          <button
            type="button"
            aria-label="Pull options"
            aria-expanded={open}
            disabled={busy !== null}
            onClick={() => onOpenChange(!open)}
            className={`-ml-0.5 rounded px-px py-1 text-ink-3 hover:bg-white/10 hover:text-ink disabled:hover:bg-transparent ${open ? 'bg-white/10 text-ink' : ''}`}
          >
            <ChevronDown size={12} />
          </button>
        </Tooltip>
      </div>
      {open && (
        <div
          ref={menuRef}
          style={{ left: 0, top: 0, width: PULL_OPTIONS_WIDTH }}
          className="animate-menu-pop-in surface-overlay fixed z-50 overflow-hidden rounded-lg text-sm text-zinc-200"
        >
          <div className="space-y-2.5 px-3.5 pb-2 pt-3.5" data-scm-pull-options>
            <label className="flex cursor-pointer select-none items-center gap-2.5 text-[13px] text-ink">
              <Checkbox checked={rebase} onChange={setRebase} />
              Rebase instead of merge
            </label>
            <label className="flex cursor-pointer select-none items-center gap-2.5 text-[13px] text-ink">
              <Checkbox checked={autoStash} onChange={setAutoStash} />
              Stash and reapply local changes
            </label>
          </div>
          <div className="flex justify-end gap-2 px-3.5 pb-3.5 pt-2">
            <button
              type="button"
              onClick={close}
              className="rounded bg-white/10 px-3.5 py-1 text-[13px] text-ink hover:bg-white/15"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                close()
                onPullWith(rebase, autoStash)
              }}
              className="rounded bg-accent px-3.5 py-1 text-[13px] text-accent-fg hover:brightness-110"
            >
              Pull
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function PushButton({
  title,
  ahead,
  busy,
  onCancel,
  onPush,
  onForcePush
}: {
  title: string
  ahead: number
  busy: ScmOperation | null
  onCancel?: () => void
  onPush: () => void
  onForcePush: () => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useFloating(anchorRef.current, menuRef, { placement: 'bottom-end', gap: 6 }, open)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(wrapRef, close, open)
  return (
    <div ref={wrapRef} className="[-webkit-app-region:no-drag]">
      <div ref={anchorRef} className="flex items-center">
        <ToolbarButton title={title} operation="Push" busy={busy} onCancel={onCancel} onClick={onPush}>
          <ArrowUp size={14} />
          {ahead > 0 && <span className="text-[11px]">{ahead}</span>}
        </ToolbarButton>
        <Tooltip label="Push options">
          <button
            type="button"
            aria-label="Push options"
            aria-expanded={open}
            disabled={busy !== null}
            onClick={() => setOpen(!open)}
            className={`-ml-0.5 rounded px-px py-1 text-ink-3 hover:bg-white/10 hover:text-ink disabled:hover:bg-transparent ${open ? 'bg-white/10 text-ink' : ''}`}
          >
            <ChevronDown size={12} />
          </button>
        </Tooltip>
      </div>
      {open && (
        <div
          ref={menuRef}
          style={{ left: 0, top: 0 }}
          role="menu"
          className="animate-menu-pop-in surface-overlay fixed z-50 min-w-[240px] overflow-hidden rounded-lg p-1 text-sm text-zinc-200"
        >
          <button
            className={menuItemClass}
            onClick={() => {
              close()
              onForcePush()
            }}
          >
            Force Push
            <GitHint>--force-with-lease</GitHint>
          </button>
        </div>
      )}
    </div>
  )
}

function GitHint({ children }: { children: React.ReactNode }) {
  return <span aria-hidden className="ml-auto shrink-0 pl-4 font-mono text-[11px] text-ink-4">{children}</span>
}

function StashRow({
  row,
  alt,
  onClick,
  onContextMenu,
  onApply
}: {
  row: Extract<Row, { type: 'stash' }>
  alt: boolean
  onClick: (e: ReactMouseEvent) => void
  onContextMenu: (e: ReactMouseEvent) => void
  onApply: (pop: boolean) => void
}) {
  const { stash } = row
  const description = stashDescription(stash)
  return (
    <div
      className="scm-row group flex h-full cursor-pointer select-none items-center pr-2"
      style={{ paddingLeft: 2 + INDENT }}
      data-scm-stash={stash.index}
      title={description ? `${stashLabel(stash)}\n${description}` : stashLabel(stash)}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <Twistie collapsed={!row.expanded} />
      <Archive size={13} className="mr-1.5 shrink-0 text-ink-3" />
      <span className="min-w-0 shrink truncate text-[13px] text-ink-2">{stash.description}</span>
      <span className="ml-2 min-w-0 flex-1 truncate text-xs text-ink-4">{stash.branchName}</span>
      <div className="ml-1 hidden shrink-0 items-center group-hover:flex">
        <RowAction title={alt ? 'Restore and Remove Stash' : 'Restore Stash, Keep a Copy (Alt: Restore and Remove)'} onClick={(e) => onApply(e.altKey)}>
          {alt ? <PackageOpen size={14} /> : <ArchiveRestore size={14} />}
        </RowAction>
      </div>
      {stash.commitDate !== undefined && (
        <span className="ml-1 shrink-0 text-[11px] text-ink-4">{relativeTimeShort(stash.commitDate)}</span>
      )}
    </div>
  )
}

function StashMessagePrompt({
  anchor,
  initial,
  onSubmit,
  onCancel
}: {
  anchor: DOMRect
  initial: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onCancel)
  const reference = useMemo(() => ({ getBoundingClientRect: () => anchor }), [anchor])
  useFloating(reference, ref, { placement: 'bottom-end', gap: 4 })
  return (
    <div
      ref={ref}
      style={{ left: 0, top: 0, width: 320 }}
      className="animate-menu-pop-in surface-overlay fixed z-50 rounded-lg p-2 [-webkit-app-region:no-drag]"
      data-scm-stash-prompt
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit(value)
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Stash message"
        className="h-[24px] w-full rounded border border-accent bg-sunken px-1.5 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none"
      />
      <div className="mt-1 px-0.5 text-[11px] text-ink-3">Optionally provide a stash message (Press 'Enter' to confirm or 'Escape' to cancel)</div>
    </div>
  )
}

function ChangeContextMenu(props: Omit<ChangeMenuArgs, 'targets' | 'at'> & { menu: MenuState; onDismiss: () => void }) {
  const { menu, onDismiss, ...rest } = props
  const nodes = changeMenuNodes({ ...rest, targets: menu.targets, at: { x: menu.x, y: menu.y } })
  return <ActionMenu x={menu.x} y={menu.y} nodes={nodes} onDismiss={onDismiss} />
}
