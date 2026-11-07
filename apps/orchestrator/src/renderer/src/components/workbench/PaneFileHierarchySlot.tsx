import { useFloatingInParent } from '../../lib/floating'
import { captureText, useCapture } from '../../lib/capture'
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type Ref as ReactRef
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DirEntry, DirWatchHandle } from '@shared/api'
import { useAppStore } from '../../store'
import { DEFAULT_FILE_SEARCH } from '../../store/slices/ui'
import type { DirState } from '../../store/slices/files'
import { pathBasename, toPosixPath } from '../../lib/path'
import { openFileFromExplorer } from '../../lib/editor/open-file-from-explorer'
import { closeViewersForDeletedPath } from '../../lib/editor/close-deleted-file'
import { moveExplorerPath, renameExplorerPath } from '../../lib/editor/move-file'
import { QUICK_OPEN_LIMIT, rankQuickOpenFiles } from '../../lib/quick-open/quick-open-search'
import {
  copyAbsolutePath,
  copyRelativePath,
  joinPath,
  parentDir,
  relativePath
} from '../../lib/file-explorer/copy-paths'
import { buildNameFilterTree, type NameFilterNode } from '../../lib/file-explorer/name-filter-tree'
import { PaneFileExplorerContextMenu } from './PaneFileExplorerContextMenu'
import { showDropFeedback } from '../../lib/drop-feedback'
import { ExplorerContentsResults } from './file-search/ExplorerContentsResults'
import { allTargets, runReplaceInFiles } from './file-search/run-replace'
import { useDismiss } from '../ui/useDismiss'
import { openGitHistory } from '../../lib/git/open-git-history'
import { checkUnityProject, knownUnityProject } from '../../lib/unity/unity-project-cache'
import { ExplorerIcon } from './explorer-icons'
import {
  HIDDEN_DIRS,
  fileExt,
  isAlwaysDim,
  isMetaFile,
  isTreeIgnored,
  opensAsUnityAsset,
  opensInSaturaWithMeta,
  projectRel,
  sortByDim
} from '../../lib/file-explorer/explorer-rules'

const IS_MAC_EXPLORER = /Mac/i.test(navigator.platform || navigator.userAgent)

const PRESET_EXTS = ['cs', 'json', 'asset']
const FILE_DRAG_MIME = 'text/x-satura-file-path'
const DRAG_EXPAND_DELAY_MS = 500
const NAMES_REFRESH_DELAY_MS = 1200
const FOCUS_REVALIDATE_MIN_MS = 5000
const RECURSIVE_EXPAND_LIMIT = 2000

const EMPTY_DIR_CACHE: Record<string, DirState> = {}

type ExplorerMode = 'files' | 'search'

type InlineAction =
  | { kind: 'new-file' | 'new-folder'; dir: string; initial: string }
  | { kind: 'rename'; dir: string; path: string; initial: string }

interface TreeCtx {
  worktreeId: string
  rootPath: string
  unity: boolean
  expanded: Set<string>
  childrenByDir: Record<string, DirState>
  dirty: Set<string>
  selectedFile: string | undefined
  picked: Set<string>
  onRowClick: (e: ReactMouseEvent, entry: DirEntry, activate: (recursive: boolean) => void) => void
  contextMenuPath: string | null
  action: InlineAction | null
  loadDir: (dir: string) => void
  toggleDir: (worktreeId: string, dir: string) => void
  toggleDirTree: (dir: string, expanded: boolean) => void
  openFile: (worktreeId: string, file: string, preview?: boolean) => void
  onContextMenu: (e: ReactMouseEvent, node: DirEntry) => void
  startRename: (node: DirEntry) => void
  submitAction: (name: string) => void
  cancelAction: () => void
  isDimmed: (entry: DirEntry) => boolean
  isHidden: (entry: DirEntry) => boolean
  scrollTarget: string | null
  onScrolled: () => void
  drag: DragCtx
}

interface DragCtx {
  sourcePath: string | null
  targetDir: string | null
  onDragStart: (path: string) => void
  onDragEnd: () => void
  onDragEnterDir: (dir: string, expanded: boolean) => void
  onDragOverDir: (e: ReactDragEvent) => void
  onDragLeaveDir: () => void
  onDropDir: (dir: string) => void
}

export function PaneFileHierarchySlot({
  workspaceId,
  groupId,
  worktreeId,
  rootPath
}: {
  workspaceId: string
  groupId: string
  worktreeId: string
  rootPath: string
}) {
  useCapture((s) => s.replace)
  const expandedList = useAppStore(useShallow((s) => s.expandedDirsByWorktree[worktreeId] ?? []))
  const expandedListRef = useRef(expandedList)
  expandedListRef.current = expandedList
  const selectedFile = useAppStore((s) => s.selectedFileByWorktree[worktreeId])
  const dirtyKeys = useAppStore(useShallow((s) => Object.keys(s.draftsByPath)))
  const toggleDir = useAppStore((s) => s.toggleDir)
  const expandDirs = useAppStore((s) => s.expandDirs)
  const collapseDirTree = useAppStore((s) => s.collapseDirTree)
  const search = useAppStore((s) => s.searchStateByWorktree[worktreeId]) ?? DEFAULT_FILE_SEARCH
  const updateSearchState = useAppStore((s) => s.updateSearchState)
  const bumpSearchRun = useAppStore((s) => s.bumpSearchRun)
  const explorerSearchRequest = useAppStore((s) => s.explorerSearchRequest)
  const explorerRevealRequest = useAppStore((s) => s.explorerRevealRequest)
  const revealPath = useAppStore((s) => s.revealPath)
  const lastViewerFile = useAppStore((s) => s.lastViewerFile)
  const workspaceVisible = useAppStore((s) => s.activeWorkspaceId === workspaceId)
  const workspaceVisibleRef = useRef(workspaceVisible)
  workspaceVisibleRef.current = workspaceVisible
  const openFile = useCallback(
    (wtId: string, file: string, preview = true) =>
      openFileFromExplorer(workspaceId, wtId, groupId, file, { preview }),
    [workspaceId, groupId]
  )
  const [unity, setUnity] = useState(() => knownUnityProject(rootPath) === true)
  useEffect(() => {
    let alive = true
    void checkUnityProject(rootPath).then((ok) => {
      if (alive) setUnity(ok)
    })
    return () => {
      alive = false
    }
  }, [rootPath])

  const [mode, setMode] = useState<ExplorerMode>('files')
  const [nameQuery, setNameQuery] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const wantSearchFocus = useRef(false)

  const focusSearchInput = useCallback((el: HTMLInputElement) => {
    wantSearchFocus.current = false
    el.focus()
    el.select()
  }, [])

  const attachSearchInput = useCallback(
    (el: HTMLInputElement | null) => {
      searchInputRef.current = el
      if (el && wantSearchFocus.current) focusSearchInput(el)
    },
    [focusSearchInput]
  )

  const openSearch = useCallback(() => {
    wantSearchFocus.current = true
    setMode('search')
    if (searchInputRef.current) focusSearchInput(searchInputRef.current)
  }, [focusSearchInput])

  const [scrollTarget, setScrollTarget] = useState<string | null>(null)
  const reveal = useCallback(
    (filePath: string): void => {
      const root = toPosixPath(rootPath)
      const file = toPosixPath(filePath)
      if (!file || (file !== root && !file.startsWith(root + '/'))) return
      setMode('files')
      revealPath(worktreeId, rootPath, filePath)
      setScrollTarget(file)
    },
    [rootPath, worktreeId, revealPath]
  )

  const [names, setNames] = useState<string[] | null>(null)
  const namesRequested = useRef(false)
  const namesGen = useRef(0)
  useEffect(() => {
    namesGen.current++
    setNames(null)
    namesRequested.current = false
  }, [rootPath])
  const loadNames = useCallback((): void => {
    const gen = namesGen.current
    void window.api.fs
      .listFiles(rootPath)
      .then((list) => {
        if (namesGen.current === gen) setNames(list)
      })
      .catch(() => {
        if (namesGen.current === gen) setNames([])
      })
  }, [rootPath])
  const ensureNames = useCallback(() => {
    if (namesRequested.current) return
    namesRequested.current = true
    loadNames()
  }, [loadNames])

  const [selectedExts, setSelectedExts] = useState<string[]>([])
  const [extPopoverOpen, setExtPopoverOpen] = useState(false)
  const extWrapRef = useRef<HTMLDivElement>(null)
  useDismiss(extWrapRef, () => setExtPopoverOpen(false), extPopoverOpen)
  const toggleExt = (ext: string): void => {
    ensureNames()
    setSelectedExts((cur) => (cur.includes(ext) ? cur.filter((e) => e !== ext) : [...cur, ext]))
  }

  const deferredNameQuery = useDeferredValue(nameQuery)
  const extFiltered = useMemo(() => {
    const all = (names ?? []).filter((p) => !isMetaFile(p))
    if (selectedExts.length === 0) return all
    const set = new Set(selectedExts)
    return all.filter((p) => set.has(fileExt(p)))
  }, [names, selectedExts])
  const nameResults = useMemo(
    () =>
      deferredNameQuery.trim() || selectedExts.length > 0
        ? rankQuickOpenFiles(deferredNameQuery, extFiltered)
        : [],
    [deferredNameQuery, extFiltered, selectedExts]
  )
  const nameTree = useMemo(
    () => buildNameFilterTree(rootPath, nameResults),
    [rootPath, nameResults]
  )
  const [filterCollapsed, setFilterCollapsed] = useState<Set<string>>(new Set())
  const toggleFilterDir = useCallback((dir: string, tree?: string[]) => {
    setFilterCollapsed((cur) => {
      const next = new Set(cur)
      const collapse = !next.has(dir)
      for (const d of tree ?? [dir]) {
        if (collapse) next.add(d)
        else next.delete(d)
      }
      return next
    })
  }, [])
  const namesActive = nameQuery.trim().length > 0 || selectedExts.length > 0
  const namesPending = nameQuery !== deferredNameQuery
  const namesActiveRef = useRef(namesActive)
  namesActiveRef.current = namesActive

  useEffect(() => {
    if (namesActive && names === null) ensureNames()
  }, [namesActive, names, ensureNames])

  useEffect(() => {
    if (explorerSearchRequest && explorerSearchRequest.worktreeId === worktreeId) {
      openSearch()
    }
  }, [explorerSearchRequest, worktreeId, openSearch])

  useEffect(() => {
    if (explorerRevealRequest && explorerRevealRequest.worktreeId === worktreeId) {
      reveal(explorerRevealRequest.filePath)
    }
  }, [explorerRevealRequest, worktreeId, reveal])

  const childrenByDir = useAppStore((s) => s.dirCacheByWorktree[worktreeId]) ?? EMPTY_DIR_CACHE
  const setDirLoading = useAppStore((s) => s.setDirLoading)
  const setDirEntries = useAppStore((s) => s.setDirEntries)
  const setDirError = useAppStore((s) => s.setDirError)
  const resetDirCache = useAppStore((s) => s.resetDirCache)
  const cacheRef = useRef(childrenByDir)
  cacheRef.current = childrenByDir

  const [menu, setMenu] = useState<{
    x: number
    y: number
    node: DirEntry
    isRoot: boolean
    targets: string[]
  } | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const pickedRef = useRef(picked)
  pickedRef.current = picked
  const anchorRef = useRef<string | null>(null)
  const selectedFileRef = useRef(selectedFile)
  selectedFileRef.current = selectedFile
  useEffect(() => {
    setPicked([])
    anchorRef.current = null
  }, [rootPath])
  useEffect(() => {
    setPicked((cur) => (cur.length === 0 ? cur : []))
  }, [selectedFile])
  const [isRepo, setIsRepo] = useState(false)
  useEffect(() => {
    let alive = true
    setIsRepo(false)
    void window.api.git.isRepo(rootPath).then(
      (ok) => alive && setIsRepo(ok),
      () => {}
    )
    return () => {
      alive = false
    }
  }, [rootPath])
  const [action, setAction] = useState<InlineAction | null>(null)
  const [ignored, setIgnored] = useState<Set<string>>(new Set())

  const readSeq = useRef(new Map<string, number>())

  const reloadDir = useCallback(
    (dir: string) => {
      const n = (readSeq.current.get(dir) ?? 0) + 1
      readSeq.current.set(dir, n)
      void window.api.fs
        .readDir(dir)
        .then((entries) => {
          if (readSeq.current.get(dir) === n) setDirEntries(worktreeId, dir, entries)
        })
        .catch(() => {
          if (readSeq.current.get(dir) === n) setDirError(worktreeId, dir)
        })
    },
    [worktreeId, setDirEntries, setDirError]
  )

  const loadDir = useCallback(
    (dir: string) => {
      if (cacheRef.current[dir] === undefined) setDirLoading(worktreeId, dir)
      reloadDir(dir)
    },
    [worktreeId, setDirLoading, reloadDir]
  )

  const refreshNames = useCallback((): void => {
    if (!namesRequested.current || !namesActiveRef.current) return
    loadNames()
  }, [loadNames])

  const namesTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshNamesSoon = useCallback((): void => {
    if (!namesRequested.current || !namesActiveRef.current) return
    if (namesTimer.current) clearTimeout(namesTimer.current)
    namesTimer.current = setTimeout(() => {
      namesTimer.current = null
      refreshNames()
    }, NAMES_REFRESH_DELAY_MS)
  }, [refreshNames])

  useEffect(
    () => () => {
      if (namesTimer.current) clearTimeout(namesTimer.current)
    },
    []
  )

  const prevNamesActive = useRef(namesActive)
  useEffect(() => {
    const was = prevNamesActive.current
    prevNamesActive.current = namesActive
    if (was === namesActive) return
    if (namesActive) {
      ensureNames()
      return
    }
    if (selectedFileRef.current) reveal(selectedFileRef.current)
    if (namesTimer.current) {
      clearTimeout(namesTimer.current)
      namesTimer.current = null
    }
    namesGen.current++
    namesRequested.current = false
    setNames(null)
  }, [namesActive, ensureNames, reveal])

  const applyIgnored = useCallback((paths: string[]): void => {
    setIgnored((cur) =>
      cur.size === paths.length && paths.every((p) => cur.has(p)) ? cur : new Set(paths)
    )
  }, [])

  const [dragSource, setDragSource] = useState<string | null>(null)
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null)
  const dragSourceRef = useRef<string | null>(null)
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearExpandTimer = (): void => {
    if (expandTimer.current) {
      clearTimeout(expandTimer.current)
      expandTimer.current = null
    }
  }

  const onDragStart = useCallback((path: string) => {
    dragSourceRef.current = path
    setDragSource(path)
  }, [])

  const onDragEnd = useCallback(() => {
    dragSourceRef.current = null
    setDragSource(null)
    setDropTargetDir(null)
    clearExpandTimer()
  }, [])

  const onDragEnterDir = useCallback(
    (dir: string, isExpanded: boolean) => {
      const src = dragSourceRef.current
      if (!src) return
      if (dir === src || dir.startsWith(src + '/')) return
      setDropTargetDir(dir)
      clearExpandTimer()
      if (dir !== rootPath && !isExpanded) {
        expandTimer.current = setTimeout(() => {
          expandTimer.current = null
          if (!expandedListRef.current.includes(dir)) toggleDir(worktreeId, dir)
        }, DRAG_EXPAND_DELAY_MS)
      }
    },
    [rootPath, toggleDir, worktreeId]
  )

  const onDragOverDir = useCallback((e: ReactDragEvent) => {
    if (!dragSourceRef.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDragLeaveDir = useCallback(() => {
    clearExpandTimer()
  }, [])

  const onDropDir = useCallback(
    (dir: string) => {
      const src = dragSourceRef.current
      onDragEnd()
      if (!src) return
      const sourceDir = parentDir(src)
      if (sourceDir === dir) return
      if (dir === src || dir.startsWith(src + '/')) return
      const dest = joinPath(dir, pathBasename(src))
      void moveExplorerPath(src, dest, () => {
        reloadDir(sourceDir)
        reloadDir(dir)
        if (dir !== rootPath && !expandedListRef.current.includes(dir)) toggleDir(worktreeId, dir)
        refreshNames()
      })
    },
    [onDragEnd, reloadDir, refreshNames, rootPath, toggleDir, worktreeId]
  )

  const prevRoot = useRef<string | null>(null)
  useEffect(() => {
    if (prevRoot.current !== null && prevRoot.current !== rootPath) resetDirCache(worktreeId)
    prevRoot.current = rootPath
    readSeq.current.clear()
    loadDir(rootPath)
  }, [rootPath, worktreeId, loadDir, resetDirCache])

  useEffect(() => {
    let alive = true
    void window.api.git.listIgnored(rootPath).then((paths) => {
      if (alive) applyIgnored(paths)
    })
    return () => {
      alive = false
    }
  }, [rootPath, applyIgnored])

  const watchedDirs = useMemo(() => {
    const prefix = toPosixPath(rootPath).replace(/\/+$/, '') + '/'
    const dirs = [rootPath]
    for (const dir of expandedList) if (toPosixPath(dir).startsWith(prefix)) dirs.push(dir)
    return dirs
  }, [rootPath, expandedList])

  const revalidate = useCallback((): void => {
    for (const dir of watchedDirs) reloadDir(dir)
    refreshNames()
    void window.api.git.listIgnored(rootPath).then(applyIgnored)
  }, [watchedDirs, reloadDir, refreshNames, rootPath, applyIgnored])

  const revalidateRef = useRef(revalidate)
  revalidateRef.current = revalidate

  const onWatchedDirsChanged = useCallback(
    (dirs: string[]): void => {
      for (const dir of dirs) reloadDir(dir)
      refreshNamesSoon()
    },
    [reloadDir, refreshNamesSoon]
  )
  const onWatchedDirsChangedRef = useRef(onWatchedDirsChanged)
  onWatchedDirsChangedRef.current = onWatchedDirsChanged

  const watchHandle = useRef<DirWatchHandle | null>(null)
  useEffect(() => {
    const handle = window.api.fs.watchDirs((dirs) => onWatchedDirsChangedRef.current(dirs))
    watchHandle.current = handle
    return () => {
      watchHandle.current = null
      handle.stop()
    }
  }, [])

  useEffect(() => {
    watchHandle.current?.setDirs(watchedDirs)
  }, [watchedDirs])

  const lastFocusRevalidate = useRef(0)
  const revalidateOnFocus = useCallback((): void => {
    if (!workspaceVisibleRef.current) return
    const now = Date.now()
    if (now - lastFocusRevalidate.current < FOCUS_REVALIDATE_MIN_MS) return
    lastFocusRevalidate.current = now
    revalidateRef.current()
  }, [])

  useEffect(() => {
    window.addEventListener('focus', revalidateOnFocus)
    return () => window.removeEventListener('focus', revalidateOnFocus)
  }, [revalidateOnFocus])

  const prevWorkspaceVisible = useRef(workspaceVisible)
  useEffect(() => {
    const was = prevWorkspaceVisible.current
    prevWorkspaceVisible.current = workspaceVisible
    if (workspaceVisible && !was) revalidateOnFocus()
  }, [workspaceVisible, revalidateOnFocus])

  const refresh = (): void => revalidate()

  const toggleDirTree = useCallback(
    (dir: string, isExpanded: boolean): void => {
      if (isExpanded) {
        collapseDirTree(worktreeId, dir)
        return
      }
      const skipIgnored = !isTreeIgnored(ignored, relativePath(rootPath, dir), true)
      const walk = async (): Promise<void> => {
        const found = [dir]
        let level = [dir]
        while (level.length > 0 && found.length < RECURSIVE_EXPAND_LIMIT) {
          const lists = await Promise.all(
            level.map(async (cur): Promise<DirEntry[]> => {
              const cached = cacheRef.current[cur]
              if (Array.isArray(cached)) return cached
              try {
                const entries = await window.api.fs.readDir(cur)
                setDirEntries(worktreeId, cur, entries)
                return entries
              } catch {
                return []
              }
            })
          )
          const next: string[] = []
          for (const entries of lists) {
            for (const e of entries) {
              if (!e.isDirectory || isAlwaysDim(e.name)) continue
              const rel = relativePath(rootPath, e.path)
              if (HIDDEN_DIRS.has(rel) || (skipIgnored && isTreeIgnored(ignored, rel, true))) continue
              if (found.length >= RECURSIVE_EXPAND_LIMIT) break
              found.push(e.path)
              next.push(e.path)
            }
          }
          level = next
        }
        expandDirs(worktreeId, found)
      }
      void walk()
    },
    [collapseDirTree, expandDirs, ignored, rootPath, setDirEntries, worktreeId]
  )

  const ensureExpanded = (dir: string): void => {
    if (dir !== rootPath && !expandedList.includes(dir)) toggleDir(worktreeId, dir)
  }

  const startCreate = (dir: string, kind: 'new-file' | 'new-folder'): void => {
    setMode('files')
    setNameQuery('')
    ensureExpanded(dir)
    loadDir(dir)
    setAction({ kind, dir, initial: '' })
  }

  const startRename = useCallback((node: DirEntry): void => {
    setAction({ kind: 'rename', dir: parentDir(node.path), path: node.path, initial: node.name })
  }, [])

  const cancelAction = useCallback((): void => setAction(null), [])

  const submitAction = useCallback((name: string): void => {
    if (!action) return
    const dest = joinPath(action.dir, name)
    const after = (): void => {
      reloadDir(action.dir)
      if (
        action.kind !== 'rename' &&
        action.dir !== rootPath &&
        !expandedListRef.current.includes(action.dir)
      )
        toggleDir(worktreeId, action.dir)
      refreshNames()
    }
    const fail = (err: unknown): void => console.error('[fs] explorer action failed:', err)
    if (action.kind === 'new-file') void window.api.fs.createFile(dest).then(after).catch(fail)
    else if (action.kind === 'new-folder') void window.api.fs.createDir(dest).then(after).catch(fail)
    else if (action.kind === 'rename')
      void renameExplorerPath(action.path, dest)
        .then((res) => res.ok && after())
        .catch(fail)
    setAction(null)
  }, [action, reloadDir, rootPath, toggleDir, worktreeId, refreshNames])

  const onContextMenu = useCallback((e: ReactMouseEvent, node: DirEntry): void => {
    e.preventDefault()
    const cur = pickedRef.current
    const multi = cur.length > 1 && cur.includes(node.path)
    if (!multi && cur.length > 0 && !cur.includes(node.path)) setPicked([])
    setMenu({ x: e.clientX, y: e.clientY, node, isRoot: false, targets: multi ? cur : [node.path] })
  }, [])

  const onScrolled = useCallback(() => setScrollTarget(null), [])

  const findInFolder = (dirPath: string): void => {
    const rel = relativePath(rootPath, dirPath).replace(/\/+$/, '')
    updateSearchState(worktreeId, { includeGlobs: rel ? `${rel}/**` : '' })
    openSearch()
  }

  const replaceAll = (): void => {
    const files = search.result?.files ?? []
    const total = files.reduce((n, f) => n + f.matches.length, 0)
    if (total === 0) return
    const ok = window.confirm(
      `Replace ${total} ${total === 1 ? 'occurrence' : 'occurrences'} across ${files.length} ${
        files.length === 1 ? 'file' : 'files'
      }?`
    )
    if (!ok) return
    void runReplaceInFiles(rootPath, search, allTargets(files))
      .then(() => bumpSearchRun(worktreeId))
      .catch((err) => console.error('[search] replace all failed:', err))
  }

  const contextMenuPath = menu && !menu.isRoot ? menu.node.path : null
  const expandedSet = useMemo(() => new Set(expandedList), [expandedList])
  const dirtySet = useMemo(() => new Set(dirtyKeys), [dirtyKeys])

  const isDimmed = useCallback(
    (entry: DirEntry): boolean =>
      isAlwaysDim(entry.name) || isTreeIgnored(ignored, relativePath(rootPath, entry.path), entry.isDirectory),
    [ignored, rootPath]
  )

  const isHidden = useCallback(
    (entry: DirEntry): boolean =>
      (!entry.isDirectory && isMetaFile(entry.name)) || HIDDEN_DIRS.has(relativePath(rootPath, entry.path)),
    [rootPath]
  )

  const visiblePaths = useCallback((): string[] => {
    const out: string[] = []
    const walk = (dir: string): void => {
      const kids = childrenByDir[dir]
      if (!Array.isArray(kids)) return
      for (const e of sortByDim(kids.filter((k) => !isHidden(k)), isDimmed)) {
        out.push(e.path)
        if (e.isDirectory && expandedSet.has(e.path)) walk(e.path)
      }
    }
    walk(rootPath)
    return out
  }, [childrenByDir, expandedSet, isDimmed, isHidden, rootPath])

  const onRowClick = useCallback(
    (e: ReactMouseEvent, entry: DirEntry, activate: (recursive: boolean) => void): void => {
      const toggle = IS_MAC_EXPLORER ? e.metaKey : e.ctrlKey
      if (e.shiftKey) {
        const order = visiblePaths()
        const to = order.indexOf(entry.path)
        const from = order.indexOf(anchorRef.current ?? selectedFileRef.current ?? entry.path)
        const start = from < 0 ? to : from
        if (to >= 0) {
          setPicked(order.slice(Math.min(start, to), Math.max(start, to) + 1))
          return
        }
      }
      if (toggle || e.shiftKey) {
        const cur = pickedRef.current
        const seed = selectedFileRef.current
        const base =
          cur.length > 0 ? cur : seed && seed !== entry.path && visiblePaths().includes(seed) ? [seed] : []
        setPicked(base.includes(entry.path) ? base.filter((p) => p !== entry.path) : [...base, entry.path])
        anchorRef.current = entry.path
        return
      }
      anchorRef.current = entry.path
      setPicked(entry.isDirectory ? [entry.path] : [])
      activate(e.altKey)
    },
    [visiblePaths]
  )

  const pickedSet = useMemo(() => new Set(picked), [picked])

  const drag = useMemo<DragCtx>(
    () => ({
      sourcePath: dragSource,
      targetDir: dropTargetDir,
      onDragStart,
      onDragEnd,
      onDragEnterDir,
      onDragOverDir,
      onDragLeaveDir,
      onDropDir
    }),
    [
      dragSource,
      dropTargetDir,
      onDragStart,
      onDragEnd,
      onDragEnterDir,
      onDragOverDir,
      onDragLeaveDir,
      onDropDir
    ]
  )

  const ctx = useMemo<TreeCtx>(
    () => ({
      worktreeId,
      rootPath,
      unity,
      expanded: expandedSet,
      childrenByDir,
      dirty: dirtySet,
      selectedFile,
      picked: pickedSet,
      onRowClick,
      contextMenuPath,
      action,
      loadDir,
      toggleDir,
      toggleDirTree,
      openFile,
      onContextMenu,
      startRename,
      submitAction,
      cancelAction,
      isDimmed,
      isHidden,
      scrollTarget,
      onScrolled,
      drag
    }),
    [
      worktreeId,
      rootPath,
      unity,
      expandedSet,
      childrenByDir,
      dirtySet,
      selectedFile,
      pickedSet,
      onRowClick,
      contextMenuPath,
      action,
      loadDir,
      toggleDir,
      toggleDirTree,
      openFile,
      onContextMenu,
      startRename,
      submitAction,
      cancelAction,
      isDimmed,
      isHidden,
      scrollTarget,
      onScrolled,
      drag
    ]
  )

  const root = childrenByDir[rootPath]
  const rootNode: DirEntry = {
    name: pathBasename(rootPath) || rootPath,
    path: rootPath,
    isDirectory: true
  }
  const creatingAtRoot = action && action.kind !== 'rename' && action.dir === rootPath
  const sortedRoot = useMemo(
    () => (Array.isArray(root) ? sortByDim(root.filter((e) => !isHidden(e)), isDimmed) : root),
    [root, isDimmed, isHidden]
  )

  const tabBtn = (active: boolean): string =>
    `flex-1 rounded px-2 py-0.5 text-center transition-colors ${
      active ? 'bg-white/[0.08] text-ink' : 'text-ink-3 hover:text-ink'
    }`
  const toggleBtn = (active: boolean): string =>
    `flex h-5 w-5 items-center justify-center rounded text-[11px] font-semibold ${
      active ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-500 hover:bg-white/10 hover:text-zinc-200'
    }`

  return (
    <div className="absolute inset-0 flex select-none flex-col">
      {}
      <div
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, node: rootNode, isRoot: true, targets: [rootNode.path] })
        }}
        className="flex h-8 shrink-0 items-center px-3"
      >
        <span
          className="min-w-0 flex-1 truncate pr-2 text-xs font-medium text-ink-2"
          title={rootPath}
        >
          {captureText(pathBasename(rootPath)) || rootPath}
        </span>
        <button
          onClick={() => {
            if (lastViewerFile) reveal(lastViewerFile)
          }}
          disabled={!lastViewerFile}
          title="Focus active file"
          className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="7" />
            <path d="M12 2v6M12 16v6M2 12h6M16 12h6" />
          </svg>
        </button>
        <button
          onClick={() => startCreate(rootPath, 'new-file')}
          title="New file"
          className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-white/10 hover:text-white"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <path d="M14 2v6h6M12 12v6M9 15h6" />
          </svg>
        </button>
        <button
          onClick={() => startCreate(rootPath, 'new-folder')}
          title="New folder"
          className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-white/10 hover:text-white"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
            <path d="M12 11v4M10 13h4" />
          </svg>
        </button>
        <button
          onClick={refresh}
          title="Refresh"
          className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-white/10 hover:text-white"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 4v6h-6" />
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>

      {}
      <div className="shrink-0 space-y-2 border-b border-white/[0.06] px-3 pb-2">
        <div className="flex items-center gap-0.5 rounded-md bg-white/5 p-px text-[11px] font-medium">
          <button onClick={() => setMode('files')} className={tabBtn(mode === 'files')}>
            Names
          </button>
          <button onClick={openSearch} className={tabBtn(mode === 'search')}>
            Contents
          </button>
        </div>

        {mode === 'files' ? (
          <div className="flex h-7 items-center gap-1.5 rounded bg-white/[0.05] px-2">
            <SearchGlyph />
            <input
              ref={nameInputRef}
              value={nameQuery}
              onChange={(e) => {
                setNameQuery(e.target.value)
                if (e.target.value) ensureNames()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && nameQuery) {
                  e.preventDefault()
                  e.stopPropagation()
                  setNameQuery('')
                }
              }}
              onFocus={ensureNames}
              spellCheck={false}
              placeholder="Filter files by name…"
              className="min-w-0 flex-1 bg-transparent text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
            />
            {nameQuery && (
              <button onClick={() => setNameQuery('')} title="Clear" className="shrink-0 text-zinc-500 hover:text-white">
                ×
              </button>
            )}
            <div ref={extWrapRef} className="relative flex shrink-0 items-center">
              <button
                onClick={() => {
                  ensureNames()
                  setExtPopoverOpen((v) => !v)
                }}
                title="Filter by extension"
                className={`flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-medium ${
                  selectedExts.length > 0 || extPopoverOpen
                    ? 'bg-sky-500/20 text-sky-300'
                    : 'text-zinc-500 hover:bg-white/10 hover:text-zinc-200'
                }`}
              >
                <FilterGlyph />
                {selectedExts.length > 0 && <span>{selectedExts.length}</span>}
              </button>
              {extPopoverOpen && (
                <ExtFilterPopover
                  presets={PRESET_EXTS}
                  selected={selectedExts}
                  onToggle={toggleExt}
                  onClear={() => setSelectedExts([])}
                />
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-1">
              <button
                onClick={() => updateSearchState(worktreeId, { replaceOpen: !search.replaceOpen })}
                title="Toggle Replace"
                className="flex h-7 w-4 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
              >
                <svg
                  viewBox="0 0 24 24"
                  className={`h-3 w-3 transition-transform ${search.replaceOpen ? 'rotate-90' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>

              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex h-7 items-center gap-1.5 rounded bg-white/[0.05] px-2">
                  <SearchGlyph />
                  <input
                    ref={attachSearchInput}
                    value={search.query}
                    onChange={(e) => updateSearchState(worktreeId, { query: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' && search.query) {
                        e.preventDefault()
                        e.stopPropagation()
                        updateSearchState(worktreeId, { query: '' })
                      }
                    }}
                    spellCheck={false}
                    placeholder="Search in files…"
                    className="min-w-0 flex-1 bg-transparent text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
                  />
                  <button
                    onClick={() => updateSearchState(worktreeId, { caseSensitive: !search.caseSensitive })}
                    title="Match case"
                    className={toggleBtn(search.caseSensitive)}
                  >
                    Aa
                  </button>
                  <button
                    onClick={() => updateSearchState(worktreeId, { wholeWord: !search.wholeWord })}
                    title="Match whole word"
                    className={toggleBtn(search.wholeWord)}
                  >
                    W
                  </button>
                  <button
                    onClick={() => updateSearchState(worktreeId, { regex: !search.regex })}
                    title="Use regular expression"
                    className={toggleBtn(search.regex)}
                  >
                    .*
                  </button>
                  <button
                    onClick={() => updateSearchState(worktreeId, { useGitignore: !search.useGitignore })}
                    title={
                      search.useGitignore
                        ? 'Respecting .gitignore — click to also search ignored & hidden files'
                        : 'Searching ignored & hidden files — click to respect .gitignore'
                    }
                    className={toggleBtn(!search.useGitignore)}
                  >
                    <EyeGlyph off={search.useGitignore} />
                  </button>
                </div>

                {search.replaceOpen && (
                  <div className="flex h-7 items-center gap-1.5 rounded bg-white/[0.05] px-2">
                    <ReplaceGlyph />
                    <input
                      value={search.replaceQuery}
                      onChange={(e) => updateSearchState(worktreeId, { replaceQuery: e.target.value })}
                      spellCheck={false}
                      placeholder="Replace…"
                      className="min-w-0 flex-1 bg-transparent text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
                    />
                    <button
                      onClick={() => updateSearchState(worktreeId, { preserveCase: !search.preserveCase })}
                      title="Preserve case"
                      className={toggleBtn(search.preserveCase)}
                    >
                      AB
                    </button>
                    <button
                      onClick={replaceAll}
                      title="Replace all"
                      className="shrink-0 rounded bg-white/10 px-1.5 text-[11px] font-medium text-zinc-200 hover:bg-white/20"
                    >
                      All
                    </button>
                  </div>
                )}
              </div>
            </div>

            <FilterField
              label="Files to include"
              placeholder="e.g. *.ts, src/**"
              value={search.includeGlobs}
              onChange={(v) => updateSearchState(worktreeId, { includeGlobs: v })}
            />
            <FilterField
              label="Files to exclude"
              placeholder="e.g. *.min.js, dist/**"
              value={search.excludeGlobs}
              onChange={(v) => updateSearchState(worktreeId, { excludeGlobs: v })}
            />

            <div className="flex items-center justify-between px-0.5 text-[10px] text-zinc-500">
              <span className="font-medium uppercase tracking-wide">Context lines</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() =>
                    updateSearchState(worktreeId, { contextLines: Math.max(0, search.contextLines - 1) })
                  }
                  className="flex h-4 w-4 items-center justify-center rounded bg-white/5 text-zinc-300 hover:bg-white/10"
                >
                  −
                </button>
                <span className="w-3 text-center tabular-nums text-zinc-300">{search.contextLines}</span>
                <button
                  onClick={() =>
                    updateSearchState(worktreeId, { contextLines: Math.min(10, search.contextLines + 1) })
                  }
                  className="flex h-4 w-4 items-center justify-center rounded bg-white/5 text-zinc-300 hover:bg-white/10"
                >
                  +
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {}
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === 'search' ? (
          <ExplorerContentsResults
            workspaceId={workspaceId}
            groupId={groupId}
            worktreeId={worktreeId}
            rootPath={rootPath}
          />
        ) : namesActive ? (
          <div
            onDragEnter={() => drag.onDragEnterDir(rootPath, true)}
            onDragOver={drag.onDragOverDir}
            onDrop={(e) => {
              e.preventDefault()
              drag.onDropDir(rootPath)
            }}
            className="h-full overflow-auto py-1 text-[13px] leading-6"
          >
            {names === null ? (
              <p className="px-3 py-1 text-xs text-zinc-600">Listing files…</p>
            ) : nameResults.length === 0 ? (
              <p className="px-3 py-1 text-xs text-zinc-600">
                {namesPending ? 'Filtering…' : 'No matching files'}
              </p>
            ) : (
              <>
                {nameTree.roots.map((node) => (
                  <FilterTreeNode
                    key={node.entry.path}
                    node={node}
                    depth={0}
                    ctx={ctx}
                    collapsed={filterCollapsed}
                    onToggle={toggleFilterDir}
                  />
                ))}
                {nameResults.length >= QUICK_OPEN_LIMIT && extFiltered.length > QUICK_OPEN_LIMIT && (
                  <p className="px-3 py-1 text-[11px] text-zinc-600">
                    Showing first {QUICK_OPEN_LIMIT} — type to narrow.
                  </p>
                )}
              </>
            )}
          </div>
        ) : (
          <div
            onKeyDown={(e) => {
              if (e.key === 'Escape' && picked.length > 0) {
                e.stopPropagation()
                setPicked([])
              }
            }}
            onDragEnter={() => drag.onDragEnterDir(rootPath, true)}
            onDragOver={drag.onDragOverDir}
            onDrop={(e) => {
              e.preventDefault()
              drag.onDropDir(rootPath)
            }}
            className={`h-full overflow-auto py-1 text-[13px] leading-6 ${
              dragSource && dropTargetDir === rootPath ? 'bg-sky-500/5 ring-1 ring-inset ring-sky-400/30' : ''
            }`}
          >
            {root === 'loading' || root === undefined ? (
              <p className="px-3 py-1 text-xs text-zinc-600">Loading…</p>
            ) : root === 'error' ? (
              <p className="px-3 py-1 text-xs text-rose-400">Failed to read folder</p>
            ) : root.length === 0 && !creatingAtRoot ? (
              <p className="px-3 py-1 text-xs text-zinc-600">Empty folder</p>
            ) : (
              <>
                {creatingAtRoot && (
                  <InlineTreeInput
                    depth={0}
                    kind={action!.kind}
                    isDir={action!.kind === 'new-folder'}
                    initial=""
                    onSubmit={submitAction}
                    onCancel={cancelAction}
                  />
                )}
                {Array.isArray(sortedRoot) &&
                  sortedRoot.map((entry) => (
                    <TreeNode key={entry.path} entry={entry} depth={0} ctx={ctx} />
                  ))}
              </>
            )}
          </div>
        )}
      </div>

      {menu && (
        <PaneFileExplorerContextMenu
          x={menu.x}
          y={menu.y}
          isDir={menu.node.isDirectory}
          isRoot={menu.isRoot}
          count={menu.targets.length}
          onDismiss={() => setMenu(null)}
          onNewFile={() =>
            startCreate(menu.node.isDirectory ? menu.node.path : parentDir(menu.node.path), 'new-file')
          }
          onNewFolder={() =>
            startCreate(menu.node.isDirectory ? menu.node.path : parentDir(menu.node.path), 'new-folder')
          }
          onCopyPath={() =>
            menu.targets.length > 1
              ? void window.api.ui.writeClipboardText(menu.targets.join('\n'))
              : copyAbsolutePath(menu.node.path)
          }
          onCopyRelativePath={() =>
            menu.targets.length > 1
              ? void window.api.ui.writeClipboardText(menu.targets.map((p) => relativePath(rootPath, p)).join('\n'))
              : copyRelativePath(rootPath, menu.node.path)
          }
          onShowHistory={
            isRepo && !menu.isRoot ? () => openGitHistory(workspaceId, worktreeId, menu.targets) : undefined
          }
          onOpenInTuner={
            unity && !menu.isRoot && !menu.node.isDirectory && opensInSaturaWithMeta(menu.node, rootPath, childrenByDir)
              ? () => openFileFromExplorer(workspaceId, worktreeId, groupId, menu.node.path, { preview: false, asset: true })
              : undefined
          }
          onOpenAsText={
            unity && !menu.isRoot && !menu.node.isDirectory && opensAsUnityAsset(menu.node, rootPath, childrenByDir)
              ? () => openFileFromExplorer(workspaceId, worktreeId, groupId, menu.node.path, { preview: false, text: true })
              : undefined
          }
          onDuplicate={() =>
            void window.api.fs
              .duplicate(menu.node.path)
              .then(() => {
                reloadDir(parentDir(menu.node.path))
                refreshNames()
              })
              .catch((err) => console.error('[fs] duplicate failed:', err))
          }
          onReveal={() => void window.api.shell.showItemInFolder(menu.node.path)}
          onFindInFolder={() => findInFolder(menu.node.path)}
          onRename={() => startRename(menu.node)}
          onDelete={() => {
            const path = menu.node.path
            void window.api.fs
              .trash(path)
              .then((result) => {
                if (result?.ok === false) {
                  if (result.code === 'locked') {
                    showDropFeedback(`Can't delete “${pathBasename(path)}” — file is in use by another process.`)
                  } else {
                    showDropFeedback(`Couldn't delete “${pathBasename(path)}”.`)
                  }
                  return
                }
                closeViewersForDeletedPath(workspaceId, path)
                reloadDir(parentDir(path))
                refreshNames()
              })
              .catch((err) => {
                console.error('[fs] delete failed:', err)
                showDropFeedback(`Couldn't delete “${pathBasename(path)}”.`)
              })
          }}
        />
      )}
    </div>
  )
}

function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-zinc-500" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  )
}

function FilterGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5h18l-7 8v6l-4-2v-4z" />
    </svg>
  )
}

function ExtFilterPopover({
  presets,
  selected,
  onToggle,
  onClear
}: {
  presets: string[]
  selected: string[]
  onToggle: (ext: string) => void
  onClear: () => void
}) {
  const [custom, setCustom] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useFloatingInParent(ref, { placement: 'bottom-end', gap: 4 })
  const selectedSet = new Set(selected)
  const customSelected = selected.filter((e) => !presets.includes(e))

  const addCustom = (): void => {
    const e = custom.trim().replace(/^[.*\s]+/, '').toLowerCase()
    if (e && !selectedSet.has(e)) onToggle(e)
    setCustom('')
  }

  const chip = (active: boolean): string =>
    `rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
      active
        ? 'bg-sky-500/20 text-sky-200 ring-1 ring-inset ring-sky-400/40'
        : 'bg-white/5 text-zinc-300 hover:bg-white/10'
    }`

  return (
    <div ref={ref} style={{ visibility: 'hidden' }} className="animate-menu-pop-in surface-overlay fixed left-0 top-0 z-50 w-56 rounded-lg p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
          Extensions
        </span>
        {selected.length > 0 && (
          <button onClick={onClear} className="text-[11px] text-zinc-500 hover:text-zinc-200">
            Clear
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {presets.map((ext) => (
          <button key={ext} onClick={() => onToggle(ext)} className={chip(selectedSet.has(ext))}>
            .{ext}
          </button>
        ))}
        {customSelected.map((ext) => (
          <button key={ext} onClick={() => onToggle(ext)} className={chip(true)} title="Remove">
            .{ext} ×
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1">
        <span className="text-xs text-zinc-600">.</span>
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addCustom()
            }
          }}
          spellCheck={false}
          placeholder="custom ext"
          className="min-w-0 flex-1 rounded border border-white/10 bg-sunken px-1.5 py-0.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
        />
        <button
          onClick={addCustom}
          className="shrink-0 rounded bg-white/10 px-2 py-0.5 text-xs text-zinc-200 hover:bg-white/20"
        >
          Add
        </button>
      </div>
    </div>
  )
}

function FilterField({
  label,
  placeholder,
  value,
  onChange,
  list,
  onCommit
}: {
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  list?: string
  onCommit?: (value: string) => void
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="px-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit?.(e.target.value)}
        list={list}
        spellCheck={false}
        placeholder={placeholder}
        className="h-6 rounded bg-white/[0.05] px-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-sky-500/40"
      />
    </label>
  )
}

function EyeGlyph({ off }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="2.5" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  )
}

function ReplaceGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-zinc-500" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h11a4 4 0 014 4v1" />
      <path d="M7 4L4 7l3 3" />
      <path d="M20 17H9a4 4 0 01-4-4v-1" />
      <path d="M17 20l3-3-3-3" />
    </svg>
  )
}

function InlineTreeInput({
  depth,
  kind,
  isDir,
  initial,
  onSubmit,
  onCancel
}: {
  depth: number
  kind: 'new-file' | 'new-folder' | 'rename'
  isDir: boolean
  initial: string
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const resolved = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    if (kind === 'rename') {
      const dot = initial.lastIndexOf('.')
      if (dot > 0) el.setSelectionRange(0, dot)
      else el.select()
    } else {
      el.select()
    }
  }, [])

  const submit = (): void => {
    if (resolved.current) return
    resolved.current = true
    const v = value.trim()
    if (!v || (kind === 'rename' && v === initial)) onCancel()
    else onSubmit(v)
  }
  const cancel = (): void => {
    if (resolved.current) return
    resolved.current = true
    onCancel()
  }

  return (
    <div
      style={{ paddingLeft: depth * 12 + 12 }}
      className="flex items-center gap-1 py-px pr-2"
    >
      <span className="h-3 w-3 shrink-0" />
      <ExplorerIcon name={value} rel={value} isDir={isDir} open={false} dim={false} unity={false} />
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          else if (e.key === 'Escape') cancel()
        }}
        onBlur={submit}
        spellCheck={false}
        className="min-w-0 flex-1 bg-sunken px-1 text-[13px] text-zinc-100 outline-none ring-1 ring-white/20"
      />
    </div>
  )
}

function TreeRow({
  entry,
  depth,
  ctx,
  isDir,
  isExpanded,
  rowRef,
  onActivate,
  onDblOpen
}: {
  entry: DirEntry
  depth: number
  ctx: TreeCtx
  isDir: boolean
  isExpanded: boolean
  rowRef?: ReactRef<HTMLButtonElement>
  onActivate: (recursive: boolean) => void
  onDblOpen?: () => void
}) {
  const isSelected = ctx.picked.size > 0 ? ctx.picked.has(entry.path) : !isDir && ctx.selectedFile === entry.path
  const isDirty = !isDir && ctx.dirty.has(entry.path)
  const isContextTarget = ctx.contextMenuPath === entry.path
  const isDim = ctx.isDimmed(entry)
  const dropDir = isDir ? entry.path : parentDir(entry.path)
  const isDropTarget =
    ctx.drag.sourcePath != null &&
    ctx.drag.targetDir === dropDir &&
    parentDir(ctx.drag.sourcePath) !== dropDir

  return (
    <button
      ref={rowRef}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(FILE_DRAG_MIME, entry.path)
        e.dataTransfer.effectAllowed = 'move'
        ctx.drag.onDragStart(entry.path)
      }}
      onDragEnd={ctx.drag.onDragEnd}
      onDragEnter={(e) => {
        e.stopPropagation()
        ctx.drag.onDragEnterDir(dropDir, isDir ? isExpanded : true)
      }}
      onDragOver={ctx.drag.onDragOverDir}
      onDragLeave={ctx.drag.onDragLeaveDir}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(FILE_DRAG_MIME)) return
        e.preventDefault()
        e.stopPropagation()
        ctx.drag.onDropDir(dropDir)
      }}
      onClick={(e) => {
        if (e.detail > 1) return
        ctx.onRowClick(e, entry, onActivate)
      }}
      onDoubleClick={onDblOpen}
      onContextMenu={(e) => ctx.onContextMenu(e, entry)}
      style={{ paddingLeft: depth * 12 + 12 }}
      title={entry.name}
      data-explorer-path={entry.path}
      className={`flex w-full items-center gap-1 whitespace-nowrap py-px pr-2 text-left ${
        isDropTarget
          ? 'bg-sky-500/20 ring-1 ring-inset ring-sky-400/50'
          : isContextTarget
            ? 'bg-white/10 text-white ring-1 ring-inset ring-sky-400/40'
            : isSelected
              ? 'bg-white/10 text-white'
              : 'text-zinc-300 hover:bg-white/5 hover:text-zinc-100'
      }`}
    >
      {isDir ? (
        <svg
          viewBox="0 0 24 24"
          className={`h-3 w-3 shrink-0 text-zinc-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      ) : (
        <span className="h-3 w-3 shrink-0" />
      )}
      <ExplorerIcon
        name={entry.name}
        rel={projectRel(ctx.rootPath, entry.path)}
        isDir={isDir}
        open={isExpanded}
        dim={isDim}
        unity={ctx.unity}
      />
      <span className={`min-w-0 truncate ${isDim ? 'italic text-ink-4' : ''}`}>
        {entry.name}
      </span>
      {isDirty && <span className="ml-1 shrink-0 text-amber-400" aria-hidden>•</span>}
    </button>
  )
}

function TreeNodeView({ entry, depth, ctx }: { entry: DirEntry; depth: number; ctx: TreeCtx }) {
  const isDir = entry.isDirectory
  const isExpanded = isDir && ctx.expanded.has(entry.path)
  const children = ctx.childrenByDir[entry.path]
  const isRenaming = ctx.action?.kind === 'rename' && ctx.action.path === entry.path
  const creatingHere =
    isDir &&
    isExpanded &&
    !!ctx.action &&
    ctx.action.kind !== 'rename' &&
    ctx.action.dir === entry.path
  const { loadDir } = ctx
  const rowRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (isExpanded) loadDir(entry.path)
  }, [isExpanded, entry.path, loadDir])

  useEffect(() => {
    if (ctx.scrollTarget === entry.path && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'center' })
      ctx.onScrolled()
    }
  }, [ctx.scrollTarget, entry.path])

  const sortedChildren = useMemo(
    () =>
      Array.isArray(children)
        ? sortByDim(children.filter((e) => !ctx.isHidden(e)), ctx.isDimmed)
        : children,
    [children, ctx.isDimmed, ctx.isHidden]
  )

  return (
    <>
      {isRenaming ? (
        <InlineTreeInput
          depth={depth}
          kind="rename"
          isDir={isDir}
          initial={entry.name}
          onSubmit={ctx.submitAction}
          onCancel={ctx.cancelAction}
        />
      ) : (
        <TreeRow
          entry={entry}
          depth={depth}
          ctx={ctx}
          isDir={isDir}
          isExpanded={isExpanded}
          rowRef={rowRef}
          onActivate={(recursive) =>
            !isDir
              ? ctx.openFile(ctx.worktreeId, entry.path)
              : recursive
                ? ctx.toggleDirTree(entry.path, isExpanded)
                : ctx.toggleDir(ctx.worktreeId, entry.path)
          }
          onDblOpen={isDir ? undefined : () => ctx.openFile(ctx.worktreeId, entry.path, false)}
        />
      )}

      {creatingHere && (
        <InlineTreeInput
          depth={depth + 1}
          kind={ctx.action!.kind}
          isDir={ctx.action!.kind === 'new-folder'}
          initial=""
          onSubmit={ctx.submitAction}
          onCancel={ctx.cancelAction}
        />
      )}

      {isDir && isExpanded && (
        <>
          {children === 'loading' && (
            <p style={{ paddingLeft: (depth + 1) * 12 + 26 }} className="py-px text-xs text-zinc-600">
              Loading…
            </p>
          )}
          {children === 'error' && (
            <p style={{ paddingLeft: (depth + 1) * 12 + 26 }} className="py-px text-xs text-rose-400">
              Failed to read
            </p>
          )}
          {Array.isArray(sortedChildren) &&
            sortedChildren.map((child) => (
              <TreeNode key={child.path} entry={child} depth={depth + 1} ctx={ctx} />
            ))}
        </>
      )}
    </>
  )
}

const TreeNode = memo(TreeNodeView)

function filterDirs(node: NameFilterNode): string[] {
  const out: string[] = []
  const walk = (n: NameFilterNode): void => {
    if (!n.entry.isDirectory) return
    out.push(n.entry.path)
    for (const c of n.children) walk(c)
  }
  walk(node)
  return out
}

function FilterTreeNode({
  node,
  depth,
  ctx,
  collapsed,
  onToggle
}: {
  node: NameFilterNode
  depth: number
  ctx: TreeCtx
  collapsed: Set<string>
  onToggle: (dir: string, tree?: string[]) => void
}) {
  const { entry } = node
  const isDir = entry.isDirectory
  const isExpanded = isDir && !collapsed.has(entry.path)
  const isRenaming = ctx.action?.kind === 'rename' && ctx.action.path === entry.path

  return (
    <>
      {isRenaming ? (
        <InlineTreeInput
          depth={depth}
          kind="rename"
          isDir={isDir}
          initial={entry.name}
          onSubmit={ctx.submitAction}
          onCancel={ctx.cancelAction}
        />
      ) : (
        <TreeRow
          entry={entry}
          depth={depth}
          ctx={ctx}
          isDir={isDir}
          isExpanded={isExpanded}
          onActivate={(recursive) =>
            !isDir
              ? ctx.openFile(ctx.worktreeId, entry.path)
              : onToggle(entry.path, recursive ? filterDirs(node) : undefined)
          }
          onDblOpen={isDir ? undefined : () => ctx.openFile(ctx.worktreeId, entry.path, false)}
        />
      )}

      {isDir && isExpanded &&
        node.children.map((child) => (
          <FilterTreeNode
            key={child.entry.path}
            node={child}
            depth={depth + 1}
            ctx={ctx}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        ))}
    </>
  )
}
