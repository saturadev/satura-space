import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { History, X } from 'lucide-react'
import { Tooltip } from '../ui/Tooltip'
import { joinPath, type DiffSides } from '../../lib/git/scm-resource'
import { noteViewMounted, noteViewUnmounted } from '../../lib/view-host-registry'
import { useGitCommitRequests, useGitHistoryRequests } from '../../lib/git/history-request'
import { useScmRepository, type ScmRepository } from './use-scm-repository'
import { useScmSettings } from './use-scm-settings'
import { ScmChangesPane } from './ScmChangesPane'
import { ScmGraphPane } from './ScmGraphPane'
import { ScmDiffEditor, type DiffRequest } from './ScmDiffEditor'
import { ScmMergeEditor } from './merge/ScmMergeEditor'
import { useMobileBack } from '../../lib/mobile/mobile-back'
import './git-scm.css'

interface MergeRequest {
  readonly key: string
  readonly path: string
}

function useDrag(onMove: (dx: number, dy: number) => void): (e: React.PointerEvent<HTMLDivElement>) => void {
  const moveRef = useRef(onMove)
  moveRef.current = onMove
  return useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const handle = e.currentTarget
    const startX = e.clientX
    const startY = e.clientY
    handle.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => moveRef.current(ev.clientX - startX, ev.clientY - startY)
    const up = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }, [])
}

export function GitScmView({
  rootPath,
  projectPath,
  visible = true,
  viewId,
  onOpenFile,
  actionScope
}: {
  rootPath: string
  projectPath?: string
  visible?: boolean
  viewId?: string
  onOpenFile?: (file: string) => void
  actionScope?: string
}) {
  useEffect(() => {
    if (!viewId) return
    noteViewMounted(viewId)
    return () => noteViewUnmounted(viewId)
  }, [viewId])
  const repo = useScmRepository(rootPath, visible)
  return <GitScmBody rootPath={rootPath} projectPath={projectPath} repo={repo} onOpenFile={onOpenFile} actionScope={actionScope} />
}

const GitScmBody = memo(function GitScmBody({
  rootPath,
  projectPath,
  repo,
  onOpenFile,
  actionScope
}: {
  rootPath: string
  projectPath?: string
  repo: ScmRepository
  onOpenFile?: (file: string) => void
  actionScope?: string
}) {
  const [settings, updateSettings] = useScmSettings(rootPath)
  const [diff, setDiff] = useState<DiffRequest | null>(null)
  const [merge, setMerge] = useState<MergeRequest | null>(null)
  const [version, setVersion] = useState(0)
  const [sidebarWidth, setSidebarWidth] = useState(440)
  const [splitRatio, setSplitRatio] = useState(0.5)
  const [history, setHistory] = useState<string[] | null>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef({ width: 440, ratio: 0.5 })

  useEffect(() => {
    setVersion((v) => v + 1)
  }, [repo.state])

  const openDiff = useCallback((key: string, sides: DiffSides) => {
    setMerge(null)
    setDiff({ key, sides })
  }, [])
  const openMerge = useCallback((key: string, path: string) => {
    setDiff(null)
    setMerge({ key, path })
  }, [])
  const openRelative = useMemo(
    () => (onOpenFile ? (path: string) => onOpenFile(joinPath(rootPath, path)) : undefined),
    [onOpenFile, rootPath]
  )
  const showHistory = useCallback((paths: string[]) => {
    if (paths.length === 0) return
    setDiff(null)
    setMerge(null)
    setHistory(paths)
  }, [])
  useGitHistoryRequests(projectPath, rootPath, showHistory)
  useMobileBack(diff || merge ? () => (setDiff(null), setMerge(null)) : history ? () => setHistory(null) : null, merge ? 'Merge' : diff ? diff.sides.title : history ? 'History' : '')
  const [focusCommit, setFocusCommit] = useState<{ hash: string; nonce: number } | null>(null)
  useGitCommitRequests(projectPath, (hash) => {
    setDiff(null)
    setMerge(null)
    setHistory(null)
    setFocusCommit((prev) => ({ hash, nonce: (prev?.nonce ?? 0) + 1 }))
  })

  const onWidthDown = useDrag((dx) => {
    const room = viewRef.current?.clientWidth ?? window.innerWidth
    setSidebarWidth(Math.max(280, Math.min(room - 240, dragStart.current.width + dx)))
  })
  const startDrag = (): void => {
    dragStart.current = { width: sidebarRef.current?.offsetWidth ?? sidebarWidth, ratio: splitRatio }
  }
  const onRatioDown = useDrag((_dx, dy) => {
    const h = sidebarRef.current?.clientHeight ?? 1
    setSplitRatio(Math.max(0.15, Math.min(0.85, dragStart.current.ratio + dy / h)))
  })

  const graph = (
    <ScmGraphPane
      key={history ? history.join('\n') : 'graph'}
      repo={repo}
      onOpenDiff={openDiff}
      onShowHistory={showHistory}
      pathFilter={history ?? undefined}
      filter={settings.graphFilter}
      onFilterChange={(graphFilter) => updateSettings({ graphFilter })}
      focusCommit={history ? undefined : focusCommit ?? undefined}
    />
  )

  return (
    <div
      ref={viewRef}
      className="scm-view flex h-full w-full min-w-0 flex-col overflow-hidden bg-canvas text-ink"
      data-scm-detail={diff || merge ? 'open' : 'closed'}
      data-scm-history={history ? 'on' : 'off'}
    >
      {history && <HistoryBanner paths={history} onExit={() => setHistory(null)} />}
      <div className="flex min-h-0 flex-1">
        <div
          ref={sidebarRef}
          data-scm-sidebar
          className="flex h-full shrink-0 flex-col bg-canvas"
          style={{ width: sidebarWidth, maxWidth: 'calc(100% - 240px)', minWidth: 'min(280px, 100%)' }}
        >
          {history ? (
            <div className="min-h-0 flex-1">{graph}</div>
          ) : (
            <>
              <div className="min-h-0" style={{ flex: `${splitRatio} 1 0` }}>
                <ScmChangesPane
                  repo={repo}
                  settings={settings}
                  onSettings={updateSettings}
                  onOpenDiff={openDiff}
                  onOpenMerge={openMerge}
                  onOpenFile={onOpenFile}
                  onShowHistory={showHistory}
                  actionScope={actionScope}
                  detailOpen={!!diff || !!merge}
                />
              </div>
              <div
                data-scm-graph
                className="group relative h-px shrink-0 cursor-row-resize bg-hairline"
                onPointerDown={(e) => {
                  startDrag()
                  onRatioDown(e)
                }}
              >
                <div className="absolute inset-x-0 -inset-y-1 group-hover:bg-sky-500/30" />
              </div>
              <div className="min-h-0" data-scm-graph style={{ flex: `${1 - splitRatio} 1 0` }}>
                {graph}
              </div>
            </>
          )}
        </div>
        <div
          data-scm-resizer
          className="group relative w-px shrink-0 cursor-col-resize bg-hairline"
          onPointerDown={(e) => {
            startDrag()
            onWidthDown(e)
          }}
        >
          <div className="absolute inset-y-0 -inset-x-1 group-hover:bg-sky-500/30" />
        </div>
        <div className="min-w-0 flex-1" data-scm-detail-pane>
          {merge ? (
            <ScmMergeEditor
              key={merge.key}
              root={rootPath}
              path={merge.path}
              rebasing={!!repo.state?.rebaseCommit}
              sides={repo.state?.conflictSides}
              version={version}
              onOpenFile={openRelative}
              onCompleted={() => setMerge(null)}
            />
          ) : (
            <ScmDiffEditor
              root={rootPath}
              repo={repo}
              request={diff}
              version={version}
              settings={settings}
              onSettings={updateSettings}
              onOpenFile={openRelative}
              actionScope={actionScope}
            />
          )}
        </div>
      </div>
    </div>
  )
})

function HistoryBanner({ paths, onExit }: { paths: string[]; onExit: () => void }) {
  const shown = paths.slice(0, 4)
  const rest = paths.length - shown.length
  return (
    <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-accent/40 bg-accent/10 px-3 text-[13px]">
      <History size={14} className="shrink-0 text-accent" />
      <span className="shrink-0 font-medium text-ink">History</span>
      <span className="shrink-0 text-xs text-ink-3">
        {paths.length === 1 ? 'commits that changed' : `commits that changed any of ${paths.length} items`}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {shown.map((p) => (
          <span key={p} className="max-w-[260px] shrink-0 truncate rounded bg-white/10 px-1.5 py-px font-mono text-[11px] text-ink-2" title={p}>
            {p}
          </span>
        ))}
        {rest > 0 && (
          <Tooltip label={paths.slice(4).join(', ')}>
            <span className="shrink-0 rounded bg-white/10 px-1.5 py-px text-[11px] text-ink-3">+{rest} more</span>
          </Tooltip>
        )}
      </div>
      <button
        type="button"
        onClick={onExit}
        className="flex shrink-0 items-center gap-1 rounded border border-hairline px-2 py-0.5 text-xs text-ink-2 hover:bg-white/10 hover:text-ink"
      >
        <X size={12} /> Exit History
      </button>
    </div>
  )
}
