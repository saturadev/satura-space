import { FlaskConical } from 'lucide-react'
import type { ScratchpadInfo } from '@shared/scratchpads'
import { gridDims, gridSessionId, primaryWorldId } from '../../lib/unity/instance-ids'
import { isScratchpadLive } from '../../lib/unity/scratchpads'
import { UNITY_MODE_MENU, UnityViewportCell } from '../workbench/PaneUnitySlot'
import { useScratchpadView } from './scratchpad-status'

export function modeLabel(info: Pick<ScratchpadInfo, 'unityMode'>): string | null {
  if (!info.unityMode || info.unityMode === 'normal') return null
  return UNITY_MODE_MENU.find((m) => m.id === info.unityMode)?.label ?? null
}

function GridCell({
  projectPath,
  ptyId,
  info,
  current,
  onOpen
}: {
  projectPath: string
  ptyId: string
  info: ScratchpadInfo
  current: boolean
  onOpen: (info: ScratchpadInfo) => void
}) {
  const view = useScratchpadView(projectPath, info, true)
  const mode = modeLabel(info)
  return (
    <div
      className={`relative flex min-h-0 min-w-0 flex-col bg-canvas ${current ? 'ring-1 ring-inset ring-sky-500/60' : ''}`}
      data-scratchpad-cell={info.id}
      data-scratchpad-path={info.path}
    >
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-white/[0.06] px-2 text-[11px]">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${view.dot}`} />
        <span className="min-w-0 truncate text-zinc-200">{info.name}</span>
        <span className={`shrink-0 ${view.tone}`} data-scratchpad-state={view.play ?? view.status}>
          {view.label}
        </span>
        {mode && <span className="ml-auto shrink-0 text-zinc-500" data-scratchpad-mode={info.unityMode}>{mode}</span>}
      </div>
      <div className="grid min-h-0 flex-1">
        <UnityViewportCell
          projectPath={info.path}
          worldId={primaryWorldId(info.path)}
          primaryPtyId={gridSessionId(ptyId, info.id)}
          pending={false}
          revealLocked
          revealLockedReason=""
          refreshBlocked
          compactConsole
        />
      </div>
      <button
        type="button"
        onClick={() => onOpen(info)}
        title={`Open “${info.name}”`}
        className="absolute inset-0 z-20 cursor-pointer outline-none hover:bg-white/[0.03] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-400"
      />
    </div>
  )
}

export function ScratchpadGrid({
  projectPath,
  ptyId,
  list,
  selectedId,
  onOpen
}: {
  projectPath: string
  ptyId: string
  list: ScratchpadInfo[]
  selectedId: string | null
  onOpen: (info: ScratchpadInfo) => void
}) {
  const live = list.filter(isScratchpadLive)
  if (live.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" data-scratchpad-grid="empty">
        <FlaskConical className="h-6 w-6 text-violet-400" />
        <p className="max-w-sm text-sm text-zinc-400">No scratchpad is running. Start one to see it here.</p>
      </div>
    )
  }
  const { cols, rows } = gridDims(live.length)
  return (
    <div
      className="absolute inset-0 grid gap-px bg-white/10"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`
      }}
      data-scratchpad-grid={live.length}
    >
      {live.map((info) => (
        <GridCell
          key={info.id}
          projectPath={projectPath}
          ptyId={ptyId}
          info={info}
          current={info.id === selectedId}
          onOpen={onOpen}
        />
      ))}
    </div>
  )
}
