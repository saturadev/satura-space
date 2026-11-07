import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { UnityLogLine } from '@shared/api'
import type { ScratchpadInfo } from '@shared/scratchpads'
import { useAppStore } from '../../store'
import { openFileFromExplorer } from '../../lib/editor/open-file-from-explorer'
import { requestGoto } from '../../lib/editor/goto-line'
import {
  useConsoleView,
  setConsoleView,
  consolePrefsOf
} from '../../lib/unity/unity-console-view'
import {
  ensureProject,
  isPendingId,
  useInstance,
  useInstanceIds,
  useEffectiveLifecycle,
  useGroupWorking,
  useGroupTearingDown,
  useGroupPending
} from '../../lib/unity/world-store'
import { TRANSITIONAL_LIFECYCLES, type Lifecycle } from '@shared/unity/world'
import { useSessionStatus, setSessionStatus } from '../../lib/unity/session-status'
import { primaryWorldId } from '../../lib/unity/instance-ids'
import { useAnchoredPosition } from '../../lib/anchored-popover'
import { registerConsoleFind } from '../../lib/shortcuts/pane-actions'
import { compact as compactNodes, section, usePanelActions } from '../../lib/actions/action-tree'
import { GridCellIcon, EditorOpenedOverlay } from './PaneUnitySlot'
import { UnityStateCard, isUnityDown } from './UnityStateCard'
import { useUnityLifecycle } from '../../lib/unity/lifecycle-store'
import { stateTitle } from '@shared/unity/lifecycle'
import { BarXScroll } from './BarXScroll'
import { LogRow, renderWithLinks } from './UnityLogRow'

const MAX_LINES = 5000
const FLUSH_MS = 120
const ROW_EST = 18
const BOTTOM_PAD = 12
const PULSE_MS = 850

const haystacks = new WeakMap<UnityLogLine, string>()

function matches(line: UnityLogLine, needle: string): boolean {
  let hay = haystacks.get(line)
  if (hay === undefined) {
    hay = line.stack
      ? `${line.message.toLowerCase()}\u0000${line.stack.toLowerCase()}`
      : line.message.toLowerCase()
    haystacks.set(line, hay)
  }
  return hay.includes(needle)
}

function isBooting(lifecycle: Lifecycle | undefined): boolean {
  return lifecycle === 'init' || lifecycle === 'launching' || lifecycle === 'restarting'
}

function isLiveLifecycle(lifecycle: Lifecycle | undefined): boolean {
  return (
    lifecycle === 'editmode' ||
    lifecycle === 'entering-play' ||
    lifecycle === 'playing' ||
    lifecycle === 'exiting-play'
  )
}

const CS_ERROR = /: error CS\d+/
const collapseKeys = new WeakMap<UnityLogLine, string>()

function collapseKey(line: UnityLogLine): string {
  let key = collapseKeys.get(line)
  if (key === undefined) {
    key = `${line.severity} ${line.message} ${line.stack ?? ''}`
    collapseKeys.set(line, key)
  }
  return key
}

interface Row {
  key: string
  line: UnityLogLine
  count: number
}

interface LogFeed {
  path: string
  lines: UnityLogLine[]
}

const NO_LINES: UnityLogLine[] = []
const EMPTY_FEED: LogFeed = { path: '', lines: NO_LINES }

export function PaneUnityConsoleSlot({
  id,
  projectPath,
  scratchpad = null,
  targetChip = null,
  worldId = null,
  compact = false,
  maxLines = MAX_LINES
}: {
  id: string
  projectPath: string
  scratchpad?: ScratchpadInfo | null
  targetChip?: ReactNode
  worldId?: string | null
  compact?: boolean
  maxLines?: number
}) {
  const view = useConsoleView(id)
  const scratchpadId = scratchpad?.id ?? null
  const [feed, setFeed] = useState<LogFeed>(EMPTY_FEED)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const userGestureUntilRef = useRef(0)
  const [autoFollow, setAutoFollow] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [pulseKeys, setPulseKeys] = useState<Set<string>>(() => new Set())
  const rowCountRef = useRef<Map<string, number>>(new Map())
  const seededRef = useRef(false)
  const prevViewRef = useRef(view)
  const pulseTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const primaryId = useAppStore((s) => {
    for (const tabs of Object.values(s.tabsByWorkspace)) {
      const mine = tabs.find((t) => t.ptyId === id)
      if (!mine) continue
      const player = tabs.find((t) =>
        scratchpadId
          ? t.contentType === 'unity-scratchpad' && t.worktreeId === mine.worktreeId && t.scratchpadId === scratchpadId
          : t.contentType === 'unity-instance-player' && t.worktreeId === mine.worktreeId
      )
      return player?.ptyId ?? null
    }
    return null
  })
  useEffect(() => {
    ensureProject(projectPath)
  }, [projectPath])
  useEffect(
    () =>
      registerConsoleFind(id, () => {
        const el = searchInputRef.current
        if (!el) return
        el.focus()
        el.select()
      }),
    [id]
  )
  const instanceIds = useInstanceIds(projectPath)
  const playerCount = instanceIds.filter((g) => !isPendingId(g)).length
  const count = Math.max(1, playerCount)
  const primaryStatus = useSessionStatus(primaryId ?? '')
  const playerStandalone = primaryStatus.standalone
  const editorRevealed = primaryStatus.revealed
  const groupWorking = useGroupWorking(projectPath)
  const groupTearingDown = useGroupTearingDown(projectPath)
  const groupPending = useGroupPending(projectPath)
  const primaryLifecycle = useEffectiveLifecycle(projectPath, primaryWorldId(projectPath))
  const revealLocked =
    groupWorking ||
    groupTearingDown ||
    groupPending ||
    (!!primaryLifecycle && TRANSITIONAL_LIFECYCLES.has(primaryLifecycle))
  const hideEditor = useCallback(() => {
    if (revealLocked) return
    void window.api.unity.hideEditor(projectPath).then((r) => {
      if (r.ok && primaryId) setSessionStatus(primaryId, { revealed: false })
    })
  }, [projectPath, primaryId, revealLocked])
  const [instanceIdx, setInstanceIdx] = useState(0)
  useEffect(() => setInstanceIdx(0), [projectPath])
  const pinnedIdx = worldId ? instanceIds.indexOf(worldId) : -1
  const idx = pinnedIdx >= 0 ? pinnedIdx : Math.min(instanceIdx, count - 1)
  const activeWorldId = instanceIds[idx] ?? ''
  const activeWorldIdReal = isPendingId(activeWorldId) ? '' : activeWorldId
  const lifecycle = useEffectiveLifecycle(projectPath, activeWorldIdReal)
  const unityLife = useUnityLifecycle(projectPath)
  const activeInstance = useInstance(projectPath, activeWorldIdReal)
  const compileError =
    activeInstance?.compile === 'error' ? (activeInstance.compileError ?? null) : null
  const compileErrorLines = useMemo(
    () => (compileError ? compileError.split('\n').map((l) => l.trim()).filter(Boolean) : []),
    [compileError]
  )
  const [compileErrorOpen, setCompileErrorOpen] = useState(true)
  const [activePath, setActivePath] = useState(projectPath)
  const lines = feed.path === activePath ? feed.lines : NO_LINES
  const cleared = view.clearedPath === activePath ? view.clearedThrough : 0
  useEffect(() => {
    let alive = true
    if (idx <= 0) {
      setActivePath(projectPath)
      return
    }
    if (!activeWorldIdReal) {
      setActivePath('')
      return
    }
    void window.api.unity.instanceDir(projectPath, activeWorldIdReal).then((dir) => {
      if (alive && dir) setActivePath(dir)
    })
    return () => {
      alive = false
    }
  }, [idx, activeWorldIdReal, projectPath])

  const prevWorldRef = useRef(activeWorldId)
  const boundWorldRef = useRef(activeWorldId)
  useLayoutEffect(() => {
    if (prevWorldRef.current !== activeWorldId) {
      prevWorldRef.current = activeWorldId
      boundWorldRef.current = activeWorldId
      setFeed(EMPTY_FEED)
    }
  }, [activeWorldId])

  const prevPathRef = useRef<string | null>(null)
  useEffect(() => {
    if (prevPathRef.current !== null && prevPathRef.current !== activePath) {
      setConsoleView(id, { clearedThrough: 0, clearedPath: activePath })
      setExpanded(new Set<string>())
      seededRef.current = false
      rowCountRef.current = new Map()
      for (const t of pulseTimers.current.values()) clearTimeout(t)
      pulseTimers.current.clear()
      setPulseKeys(new Set<string>())
    }
    prevPathRef.current = activePath
  }, [activePath, id])

  useEffect(
    () => () => {
      for (const t of pulseTimers.current.values()) clearTimeout(t)
      pulseTimers.current.clear()
    },
    []
  )

  const prefsHydratedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!activePath) return
    prefsHydratedFor.current = null
    let alive = true
    void window.api.unity.getConsolePrefs(activePath).then((prefs) => {
      if (!alive) return
      if (prefs) setConsoleView(id, prefs)
      prefsHydratedFor.current = activePath
    })
    return () => {
      alive = false
    }
  }, [activePath, id])

  useEffect(() => {
    if (!activePath || prefsHydratedFor.current !== activePath) return
    window.api.unity.setConsolePrefs(activePath, consolePrefsOf(view))
  }, [activePath, view.showLog, view.showWarn, view.showError, view.collapse])

  useEffect(() => {
    if (!activePath) return
    let alive = true
    const boundWorld = activeWorldId
    const seen = new Set<number>()
    let queue: UnityLogLine[] = []
    const add = (incoming: UnityLogLine[]): void => {
      for (const l of incoming) {
        if (seen.has(l.seq)) continue
        seen.add(l.seq)
        queue.push(l)
      }
    }
    const off = window.api.unity.onLog((e) => {
      if (e.projectPath === activePath) add(e.lines)
    })
    void window.api.unity.subscribeLog(activePath).then((snapshot) => {
      if (alive) add(snapshot)
    })
    const timer = setInterval(() => {
      if (!alive || queue.length === 0 || boundWorldRef.current !== boundWorld) return
      let batch = queue
      queue = []
      if (batch.length > maxLines) {
        for (let i = 0; i < batch.length - maxLines; i++) seen.delete(batch[i].seq)
        batch = batch.slice(-maxLines)
      }
      setFeed((f) => {
        const prev = f.path === activePath ? f.lines : NO_LINES
        const lastPrev = prev.length ? prev[prev.length - 1].seq : -1
        let ordered = batch[0].seq > lastPrev
        for (let i = 1; ordered && i < batch.length; i++) {
          if (batch[i].seq <= batch[i - 1].seq) ordered = false
        }
        const all = prev.concat(batch)
        if (!ordered) all.sort((a, b) => a.seq - b.seq)
        if (all.length > maxLines) {
          const dropped = all.splice(0, all.length - maxLines)
          for (const d of dropped) seen.delete(d.seq)
        }
        return { path: activePath, lines: all }
      })
    }, FLUSH_MS)
    return () => {
      alive = false
      clearInterval(timer)
      off()
      window.api.unity.unsubscribeLog(activePath)
      setFeed(EMPTY_FEED)
    }
  }, [activePath, activeWorldId, maxLines])

  const counts = useMemo(() => {
    let log = 0
    let warn = 0
    let error = 0
    for (const l of lines) {
      if (l.seq <= cleared || l.kind) continue
      if (l.severity === 'error' && CS_ERROR.test(l.message)) continue
      if (l.severity === 'warn') warn++
      else if (l.severity === 'error') error++
      else log++
    }
    return { log, warn, error }
  }, [lines, cleared])

  const search = useDeferredValue(view.search)
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return lines.filter((l) => {
      if (l.seq <= cleared) return false
      if (l.kind) return false
      if (l.severity === 'error' && CS_ERROR.test(l.message)) return false
      return (
        (l.severity === 'warn'
          ? view.showWarn
          : l.severity === 'error'
            ? view.showError
            : view.showLog) &&
        (needle === '' || matches(l, needle))
      )
    })
  }, [lines, search, cleared, view.showWarn, view.showError, view.showLog])

  const rows = useMemo(() => {
    if (!view.collapse) {
      return visible.map((l) => ({ key: `seq:${l.seq}`, line: l, count: 1 }))
    }
    const byKey = new Map<string, Row>()
    const out: Row[] = []
    for (const l of visible) {
      const key = collapseKey(l)
      const hit = byKey.get(key)
      if (hit) {
        hit.count++
        hit.line = l
      } else {
        const row: Row = { key, line: l, count: 1 }
        byKey.set(key, row)
        out.push(row)
      }
    }
    return out
  }, [visible, view.collapse])

  useEffect(() => {
    const prevCounts = rowCountRef.current
    const nextCounts = new Map<string, number>()
    const fresh: string[] = []
    for (const r of rows) {
      nextCounts.set(r.key, r.count)
      if (r.line.kind) continue
      const before = prevCounts.get(r.key)
      if (before !== undefined && r.count > before) fresh.push(r.key)
    }
    rowCountRef.current = nextCounts
    const viewChanged = prevViewRef.current !== view
    prevViewRef.current = view
    if (!seededRef.current) {
      if (rows.length > 0) seededRef.current = true
      return
    }
    if (viewChanged || fresh.length === 0) return
    setPulseKeys((prev) => {
      const next = new Set(prev)
      for (const k of fresh) next.add(k)
      return next
    })
    for (const k of fresh) {
      const existing = pulseTimers.current.get(k)
      if (existing) clearTimeout(existing)
      pulseTimers.current.set(
        k,
        setTimeout(() => {
          pulseTimers.current.delete(k)
          setPulseKeys((prev) => {
            if (!prev.has(k)) return prev
            const next = new Set(prev)
            next.delete(k)
            return next
          })
        }, PULSE_MS)
      )
    }
  }, [rows, view])

  useEffect(() => {
    let maxMarker = -1
    for (const l of lines) if (l.kind === 'restart' && l.seq > maxMarker) maxMarker = l.seq
    if (maxMarker > cleared) setConsoleView(id, { clearedThrough: maxMarker, clearedPath: activePath })
  }, [lines, cleared, activePath, id])

  const prevLifecycleRef = useRef(lifecycle)
  useEffect(() => {
    const prev = prevLifecycleRef.current
    prevLifecycleRef.current = lifecycle
    if (lifecycle === 'entering-play' && prev !== 'entering-play') {
      const latest = lines.length > 0 ? lines[lines.length - 1].seq : cleared
      if (latest > cleared) {
        setConsoleView(id, { clearedThrough: latest, clearedPath: activePath })
        setExpanded(new Set<string>())
      }
    }
  }, [lifecycle, lines, cleared, activePath, id])

  const prevCollapseRef = useRef(view.collapse)
  useEffect(() => {
    if (prevCollapseRef.current === view.collapse) return
    prevCollapseRef.current = view.collapse
    setExpanded(new Set<string>())
    setAutoFollow(true)
  }, [view.collapse])

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_EST,
    overscan: 16,
    getItemKey: (index) => rows[index]?.key ?? index
  })

  const virtualItems = rowVirtualizer.getVirtualItems()
  const totalSize = rowVirtualizer.getTotalSize()

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (autoFollow && el) el.scrollTop = el.scrollHeight
  }, [rows.length, totalSize, autoFollow])

  const isConsoleAtBottom = useCallback((el: HTMLDivElement): boolean => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }, [])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (isConsoleAtBottom(el)) {
      setAutoFollow(true)
      return
    }
    if (Date.now() < userGestureUntilRef.current) setAutoFollow(false)
  }, [isConsoleAtBottom])

  const noteUserGesture = useCallback((): void => {
    userGestureUntilRef.current = Date.now() + 400
  }, [])

  const onWheelConsole = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>): void => {
      if (e.deltaY < 0) noteUserGesture()
    },
    [noteUserGesture]
  )

  const onKeyDownConsole = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      const k = e.key
      if (
        k === 'ArrowUp' ||
        k === 'ArrowDown' ||
        k === 'PageUp' ||
        k === 'PageDown' ||
        k === 'Home' ||
        k === 'End'
      )
        noteUserGesture()
    },
    [noteUserGesture]
  )

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setAutoFollow(true)
  }, [])

  const openProjectFile = useCallback(
    (...segments: string[]) => {
      const logPath = [activePath, ...segments].join('/')
      const tabsByWorkspace = useAppStore.getState().tabsByWorkspace
      for (const [workspaceId, tabs] of Object.entries(tabsByWorkspace)) {
        const consoleTab = tabs.find((t) => t.ptyId === id)
        if (consoleTab) {
          openFileFromExplorer(workspaceId, consoleTab.worktreeId, consoleTab.groupId, logPath, {
            live: true,
            preview: false
          })
          return
        }
      }
    },
    [activePath, id]
  )
  const openConsoleLog = useCallback(
    () => openProjectFile('.sspace', '.mcp_logs', 'console.log'),
    [openProjectFile]
  )
  const openRawLog = useCallback(
    () => openProjectFile('.sspace', '.mcp_rawstream_editor.log'),
    [openProjectFile]
  )
  const openPrevLog = useCallback(
    (n: number) => openProjectFile('.sspace', '.mcp_logs', `console.prev${n}.log`),
    [openProjectFile]
  )

  const [consoleLogHasContent, setConsoleLogHasContent] = useState(false)
  const [rawLogHasContent, setRawLogHasContent] = useState(false)
  const [prevLogs, setPrevLogs] = useState<number[]>([])
  useEffect(() => {
    if (!activePath) return
    let alive = true
    const logsDir = `${activePath}/.sspace/.mcp_logs`
    const consolePath = `${logsDir}/console.log`
    const rawPath = `${activePath}/.sspace/.mcp_rawstream_editor.log`
    const hasContent = async (p: string): Promise<boolean> => {
      const info = await window.api.fs.statPath(p)
      return info.exists && (info.size ?? 0) > 0
    }
    const check = (): void => {
      void hasContent(consolePath).then((v) => alive && setConsoleLogHasContent(v))
      void hasContent(rawPath).then((v) => alive && setRawLogHasContent(v))
      void window.api.fs.readDir(logsDir).then((entries) => {
        if (!alive) return
        const nums = entries
          .map((e) => /^console\.prev(\d+)\.log$/.exec(e.name)?.[1])
          .filter((m): m is string => !!m)
          .map(Number)
          .sort((a, b) => a - b)
        setPrevLogs((prev) =>
          prev.length === nums.length && prev.every((n, i) => n === nums[i]) ? prev : nums
        )
      }, () => alive && setPrevLogs((prev) => (prev.length === 0 ? prev : [])))
    }
    setConsoleLogHasContent(false)
    setRawLogHasContent(false)
    setPrevLogs([])
    check()
    const timer = setInterval(check, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [activePath])

  const openFileAt = useCallback(
    (rel: string, line: number, col: number) => {
      const abs = rel.startsWith('/') ? rel : `${projectPath}/${rel}`
      const tabsByWorkspace = useAppStore.getState().tabsByWorkspace
      for (const [workspaceId, tabs] of Object.entries(tabsByWorkspace)) {
        const consoleTab = tabs.find((t) => t.ptyId === id)
        if (consoleTab) {
          requestGoto(abs, line, col)
          openFileFromExplorer(workspaceId, consoleTab.worktreeId, consoleTab.groupId, abs, { preview: false })
          return
        }
      }
    },
    [projectPath, id]
  )

  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    setAutoFollow(false)
  }, [])

  const clear = useCallback(() => {
    const lastSeq = lines.length > 0 ? lines[lines.length - 1].seq : cleared
    setConsoleView(id, { clearedThrough: lastSeq, clearedPath: activePath })
    setExpanded(new Set<string>())
  }, [id, lines, cleared, activePath])

  usePanelActions(
    compact || editorRevealed ? null : id,
    compactNodes([
      section('console', [
        { id: 'console.clear', label: 'Clear', icon: 'trash', primary: true, run: clear },
        { id: 'console.collapse', label: 'Collapse identical entries', icon: 'square.stack', checked: view.collapse, run: () => setConsoleView(id, { collapse: !view.collapse }) },
        !autoFollow && { id: 'console.latest', label: 'Latest', icon: 'arrow.down.to.line', primary: true, run: jumpToBottom }
      ]),
      count > 1 &&
        section(
          'players',
          Array.from({ length: count }, (_, i) => ({ id: `console.player:${i}`, label: `Player ${i + 1}`, checked: idx === i, enabled: pinnedIdx < 0, run: () => setInstanceIdx(i) })),
          "Choose which player's console to show"
        ),
      section(
        'filters',
        [
          { id: 'console.log', label: `Log ${counts.log}`, icon: 'info.circle', checked: view.showLog, run: () => setConsoleView(id, { showLog: !view.showLog }) },
          { id: 'console.warn', label: `Warn ${counts.warn}`, icon: 'exclamationmark.triangle', checked: view.showWarn, run: () => setConsoleView(id, { showWarn: !view.showWarn }) },
          { id: 'console.error', label: `Error ${counts.error}`, icon: 'xmark.octagon', checked: view.showError, run: () => setConsoleView(id, { showError: !view.showError }) },
          {
            id: 'console.filter',
            label: view.search ? `Filter: ${view.search}` : 'Filter',
            icon: 'line.3.horizontal.decrease.circle',
            shortcut: 'mod+f',
            input: { title: 'Filter', placeholder: 'Filter', initial: view.search, submit: 'Filter' },
            run: (value) => setConsoleView(id, { search: String(value ?? '') })
          },
          !!view.search && { id: 'console.clearFilter', label: 'Clear filter', icon: 'xmark.circle', run: () => setConsoleView(id, { search: '' }) }
        ],
        '',
        { bar: true }
      ),
      section('logs', [
        { id: 'console.openLogs', label: 'Open Logs', icon: 'doc.text', enabled: consoleLogHasContent, run: openConsoleLog },
        rawLogHasContent && { id: 'console.openRaw', label: 'Open Raw Editor Log', icon: 'doc.plaintext', run: openRawLog },
        prevLogs.length > 0 && {
          id: 'console.prev',
          label: 'Previous runs',
          icon: 'clock.arrow.circlepath',
          children: prevLogs.map((n) => ({ id: `console.prev:${n}`, label: n === 1 ? 'Previous run' : `${n} runs ago`, run: () => openPrevLog(n) }))
        }
      ]),
      compileErrorLines.length > 0 &&
        section('compile', [
          { id: 'console.compileErrors', label: compileErrorOpen ? 'Collapse compile errors' : 'Expand compile errors', icon: 'chevron.up.chevron.down', checked: compileErrorOpen, run: () => setCompileErrorOpen((o) => !o) }
        ])
    ])
  )

  const idleScratchpad =
    scratchpad && scratchpad.status !== 'running' && !isBooting(lifecycle) && !isLiveLifecycle(lifecycle)
      ? scratchpad
      : null

  if (editorRevealed) {
    return (
      <div className="absolute inset-0 bg-canvas">
        <EditorOpenedOverlay onHide={hideEditor} locked={revealLocked} />
      </div>
    )
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-canvas" data-unity-console={compact ? 'compact' : ''}>
      {!compact && (
        <BarXScroll className="bar-x-scroll flex h-9 items-center gap-1 border-b border-white/[0.06] bg-canvas px-1.5">
          {targetChip && (
            <>
              {targetChip}
              <Divider />
            </>
          )}
          <TbButton onClick={clear} title="Clear the console">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
            </svg>
          </TbButton>

          <Divider />

          <CollapseToggle
            active={view.collapse}
            onClick={() => setConsoleView(id, { collapse: !view.collapse })}
          />

          <Divider />

          {
  }
          {count > 1 && (
            <>
              <InstancePicker count={count} idx={idx} onPick={setInstanceIdx} />
              <Divider />
            </>
          )}

          <FilterChip
            label="Log"
            count={counts.log}
            active={view.showLog}
            activeClass="text-ink"
            dotClass="bg-zinc-400"
            onClick={() => setConsoleView(id, { showLog: !view.showLog })}
          />
          <FilterChip
            label="Warn"
            count={counts.warn}
            active={view.showWarn}
            activeClass="text-amber-300"
            dotClass="bg-amber-400"
            onClick={() => setConsoleView(id, { showWarn: !view.showWarn })}
          />
          <FilterChip
            label="Error"
            count={counts.error}
            active={view.showError}
            activeClass="text-rose-300"
            dotClass="bg-rose-400"
            onClick={() => setConsoleView(id, { showError: !view.showError })}
          />

          <div className="flex-1" />

          {}
          {!autoFollow && (
            <button
              onClick={jumpToBottom}
              title="Scroll to the latest log"
              className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded bg-sky-500/20 px-2 py-1 text-xs text-sky-200 transition-colors hover:bg-sky-500/30"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
              Latest
            </button>
          )}

          {}
          <OpenLogsButton
            onOpenConsole={openConsoleLog}
            onOpenRaw={openRawLog}
            onOpenPrev={openPrevLog}
            prevLogs={prevLogs}
            consoleDisabled={!consoleLogHasContent}
            rawDisabled={!rawLogHasContent}
          />

          {}
          <div className="relative shrink-0">
            <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-500" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              value={view.search}
              onChange={(e) => setConsoleView(id, { search: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && view.search) {
                  e.preventDefault()
                  e.stopPropagation()
                  setConsoleView(id, { search: '' })
                }
              }}
              placeholder="Filter"
              spellCheck={false}
              className="h-6 w-40 rounded border border-white/10 bg-sunken pl-7 pr-2 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-sky-500/50"
            />
            {view.search && (
              <button
                onClick={() => setConsoleView(id, { search: '' })}
                title="Clear filter"
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-xs text-zinc-500 hover:text-zinc-200"
              >
                ×
              </button>
            )}
          </div>
        </BarXScroll>
      )}

      {compileErrorLines.length > 0 && (
        <CompileErrorPanel
          errors={compileErrorLines}
          open={compileErrorOpen}
          onToggle={() => setCompileErrorOpen((o) => !o)}
          onOpen={openFileAt}
        />
      )}

      {lines.length > 0 && !idleScratchpad && !isLiveLifecycle(lifecycle) && isUnityDown(unityLife) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] bg-rose-500/[0.06] px-3 py-1.5 text-xs" data-console-unity-down-bar={unityLife.code}>
          <span className="h-2 w-2 shrink-0 rounded-full bg-rose-400" />
          <span className="min-w-0 flex-1 truncate text-rose-200" title={unityLife.error}>
            {stateTitle(unityLife)}
            {unityLife.error ? <span className="text-zinc-400"> · {unityLife.error.split('\n')[0]}</span> : null}
          </span>
          {unityLife.actions.includes('retry') && (
            <button
              type="button"
              onClick={() => void window.api.unity.retry(unityLife.project).then((r) => console.log(`[unity] retry from the console ${r.ok ? 'ok' : `failed: ${r.error}`}`))}
              className="shrink-0 rounded border border-white/10 px-2 py-0.5 text-zinc-300 hover:bg-white/10 hover:text-white"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={onWheelConsole}
          onKeyDown={onKeyDownConsole}
          onMouseDown={noteUserGesture}
          className="absolute inset-0 overflow-y-auto overflow-x-hidden"
        >
          {playerStandalone ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
              <p className="text-sm text-zinc-300">Another Unity is open</p>
              <p className="max-w-xs px-6 text-xs text-zinc-600">
                This project is open in another Unity. Its log isn&apos;t mirrored here — close it
                and press Retry in the player to resume the in-app console.
              </p>
            </div>
          ) : rows.length === 0 && lines.length === 0 && !idleScratchpad && !isLiveLifecycle(lifecycle) && isUnityDown(unityLife) ? (
            <div className="flex h-full flex-col items-center justify-center text-center" data-console-unity-down>
              <UnityStateCard life={unityLife} compact />
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
              <p className="text-sm text-zinc-500">
                {lines.length > 0
                  ? 'No matching log lines'
                  : isBooting(lifecycle) || unityLife?.state === 'starting'
                    ? unityLife?.state === 'starting'
                      ? stateTitle(unityLife)
                      : 'Starting Unity…'
                    : isLiveLifecycle(lifecycle)
                      ? 'Editor is live — console is clear'
                      : idleScratchpad
                        ? idleScratchpad.status === 'starting'
                          ? 'Starting Unity…'
                          : `“${idleScratchpad.name}” isn’t running`
                        : 'No editor running'}
              </p>
              {lines.length === 0 && !isBooting(lifecycle) && unityLife?.state !== 'starting' && (
                <p className="max-w-xs px-6 text-xs text-zinc-600">
                  {isLiveLifecycle(lifecycle) ? (
                    <>
                      Every <span className="text-zinc-500">Debug.Log</span>, warning and error from
                      the running project shows up here.
                    </>
                  ) : idleScratchpad ? (
                    <>Start it in the Scratchpads panel to stream its console here.</>
                  ) : (
                    <>Start the project to stream its console here.</>
                  )}
                </p>
              )}
            </div>
          ) : (
            <div style={{ height: totalSize + BOTTOM_PAD, position: 'relative', width: '100%' }}>
              {virtualItems.map((vi) => {
                const row = rows[vi.index]
                if (!row) return null
                return (
                  <div
                    key={vi.key}
                    data-index={vi.index}
                    ref={rowVirtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                  >
                    <LogRow
                      line={row.line}
                      count={row.count}
                      pulse={pulseKeys.has(row.key)}
                      expanded={expanded.has(row.key)}
                      onToggle={() => toggleExpand(row.key)}
                      onOpen={openFileAt}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}

function CompileErrorPanel({
  errors,
  open,
  onToggle,
  onOpen
}: {
  errors: string[]
  open: boolean
  onToggle: () => void
  onOpen: (rel: string, line: number, col: number) => void
}) {
  const n = errors.length
  return (
    <div className="shrink-0 border-b border-rose-500/30 bg-rose-500/[0.07]">
      <button
        onClick={onToggle}
        title={open ? 'Collapse compile errors' : 'Expand compile errors'}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-rose-200 outline-none transition-colors hover:bg-rose-500/10"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <path d="M12 9v4M12 17h.01" />
        </svg>
        <span className="flex-1">
          Compilation failed — {n} error{n === 1 ? '' : 's'}
        </span>
        <span className="shrink-0 select-none font-mono text-[10px] text-rose-300/70">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div className="max-h-40 select-text overflow-y-auto px-3 pb-2">
          {errors.map((e, i) => (
            <div
              key={i}
              className="whitespace-pre-wrap break-words py-0.5 font-mono text-[11px] leading-snug text-rose-300"
            >
              {renderWithLinks(e, onOpen)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function InstancePicker({
  count,
  idx,
  onPick
}: {
  count: number
  idx: number
  onPick: (i: number) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const pop = useAnchoredPosition(open, btnRef, 'bottom-left')

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative flex shrink-0">
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        title="Choose which player's console to show"
        className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 text-xs outline-none transition-colors ${
          open ? 'bg-white/10 text-white' : 'text-zinc-300 hover:bg-white/10 hover:text-white'
        }`}
      >
        <GridCellIcon count={count} index={idx} />
        Player {idx + 1}
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          ref={pop.ref}
          style={pop.style}
          className="animate-menu-pop-in surface-overlay z-30 flex flex-col gap-1 rounded-lg px-2 py-2"
        >
          <span className="px-1 pb-1 text-[10px] uppercase tracking-wide text-zinc-500">Show console</span>
          {Array.from({ length: count }, (_, i) => (
            <button
              key={i}
              onClick={() => {
                setOpen(false)
                onPick(i)
              }}
              className={`flex items-center gap-2 whitespace-nowrap rounded px-2 py-1 text-xs outline-none transition-colors ${
                i === idx ? 'bg-white/10 text-white' : 'text-zinc-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              <GridCellIcon count={count} index={i} />
              Player {i + 1}
              {i === 0 && <span className="text-[10px] text-zinc-500">primary</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function FilterChip({
  label,
  count,
  active,
  activeClass,
  dotClass,
  onClick
}: {
  label: string
  count: number
  active: boolean
  activeClass: string
  dotClass: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={`${active ? 'Hide' : 'Show'} ${label.toLowerCase()} messages`}
      className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 text-xs transition-colors ${
        active ? `${activeClass} hover:bg-white/[0.07]` : 'text-ink-3 hover:bg-white/[0.07] hover:text-ink-2'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${active ? dotClass : 'bg-zinc-700'}`} />
      {label}
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  )
}

function TbButton({
  onClick,
  title,
  children
}: {
  onClick: () => void
  title: string
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 text-xs text-ink-2 outline-none transition-colors hover:bg-white/[0.07] hover:text-ink"
    >
      {children}
    </button>
  )
}

function OpenLogsButton({
  onOpenConsole,
  onOpenRaw,
  onOpenPrev,
  prevLogs,
  consoleDisabled,
  rawDisabled
}: {
  onOpenConsole: () => void
  onOpenRaw: () => void
  onOpenPrev: (n: number) => void
  prevLogs: number[]
  consoleDisabled: boolean
  rawDisabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const arrowRef = useRef<HTMLButtonElement>(null)
  const pop = useAnchoredPosition(open, arrowRef, 'bottom-right')

  const menuEmpty = rawDisabled && prevLogs.length === 0

  useEffect(() => {
    if (menuEmpty) setOpen(false)
  }, [menuEmpty])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative flex shrink-0 items-center">
      <button
        onClick={onOpenConsole}
        disabled={consoleDisabled}
        title={
          consoleDisabled
            ? 'No console log yet'
            : 'Open the console log (.sspace/.mcp_logs/console.log)'
        }
        className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-l px-2 py-1 text-xs text-zinc-300 outline-none transition-colors hover:bg-white/10 hover:text-white disabled:cursor-default disabled:text-zinc-600 disabled:hover:bg-transparent disabled:hover:text-zinc-600"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
          <path d="M15 3h6v6M10 14L21 3" />
        </svg>
        Open Logs
      </button>
      <button
        ref={arrowRef}
        onClick={() => setOpen((o) => !o)}
        disabled={menuEmpty}
        title={menuEmpty ? 'No other logs yet' : 'Choose which log to open'}
        aria-label="Choose log to open"
        className={`flex shrink-0 items-center rounded-r px-1 py-1 outline-none transition-colors disabled:cursor-default disabled:text-zinc-600 disabled:hover:bg-transparent ${
          open ? 'text-ink hover:bg-white/[0.07]' : 'text-ink-3 hover:bg-white/[0.07] hover:text-ink-2'
        }`}
      >
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && !menuEmpty && (
        <div
          ref={pop.ref}
          style={pop.style}
          className="animate-menu-pop-in surface-overlay z-30 flex flex-col gap-1 rounded-lg px-2 py-2"
        >
          {!rawDisabled && (
            <button
              onClick={() => {
                setOpen(false)
                onOpenRaw()
              }}
              className="flex items-center gap-2 whitespace-nowrap rounded px-2 py-1 text-xs text-zinc-300 outline-none transition-colors hover:bg-white/10 hover:text-white"
            >
              Open Raw Editor Log
              <span className="text-[10px] text-zinc-500">full Unity -logFile</span>
            </button>
          )}
          {prevLogs.length > 0 && (
            <>
              <p className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                Previous runs
              </p>
              {prevLogs.map((n) => (
                <button
                  key={n}
                  onClick={() => {
                    setOpen(false)
                    onOpenPrev(n)
                  }}
                  className="flex items-center gap-2 whitespace-nowrap rounded px-2 py-1 text-xs text-zinc-300 outline-none transition-colors hover:bg-white/10 hover:text-white"
                >
                  {n === 1 ? 'Previous run' : `${n} runs ago`}
                  <span className="text-[10px] text-zinc-500">console.prev{n}.log</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function CollapseToggle({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Collapse identical entries"
      aria-pressed={active}
      className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 text-xs transition-colors ${
        active ? 'text-ink hover:bg-white/[0.07]' : 'text-ink-3 hover:bg-white/[0.07] hover:text-ink-2'
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 7h16M7 12h10M10 17h4" />
      </svg>
      Collapse
    </button>
  )
}

function Divider() {
  return <div className="mx-1.5 h-4 w-px shrink-0 bg-white/[0.08]" />
}
