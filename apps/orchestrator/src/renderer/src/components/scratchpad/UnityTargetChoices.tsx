import { Box, FlaskConical, Play } from 'lucide-react'
import type { ScratchpadInfo } from '@shared/scratchpads'
import { useAppStore } from '../../store'
import { useWorldStore } from '../../lib/unity/world-store'
import { isPhoneView } from '../../lib/tuner/view-mirror'
import { useEditorView, useScratchpadView } from './scratchpad-status'
import { debugLog } from '@shared/debug-log'

const ORDER: Record<string, number> = { running: 0, starting: 1, stopping: 2, stopped: 3, error: 4 }

function rowClass(phone: boolean): string {
  return `flex w-full items-center gap-2 rounded border border-white/10 bg-white/5 text-left text-zinc-200 transition-colors hover:bg-white/10 hover:text-white ${
    phone ? 'min-h-11 px-3 py-2 text-sm' : 'px-2.5 py-1.5 text-[11px]'
  }`
}

export function startProjectUnity(tabId: string, worktreePath: string): void {
  const s = useAppStore.getState()
  const ws = Object.keys(s.tabsByWorkspace).find((w) => s.tabsByWorkspace[w]?.some((t) => t.id === tabId))
  const me = ws ? s.tabsByWorkspace[ws]?.find((t) => t.id === tabId) : undefined
  if (!ws || !me) return
  const world = useWorldStore.getState()
  if (world.worlds[worktreePath]?.desired.stopped) world.setStopped(worktreePath, false)
  const player = (s.tabsByWorkspace[ws] ?? []).find((t) => t.contentType === 'unity-instance-player' && t.worktreeId === me.worktreeId)
  debugLog(`[tuner] start Unity for ${worktreePath}: ${player ? `showing the Unity Player tab ${player.id}` : 'opening a Unity Player beside the Tuner'}`)
  if (player) s.activateTab(player.id)
  else s.openTabBeside(ws, me.groupId, me.worktreeId, { contentType: 'unity-instance-player', label: 'Unity Player' })
}

function ScratchpadChoice({ projectPath, info, phone, onPick }: { projectPath: string; info: ScratchpadInfo; phone: boolean; onPick: () => void }) {
  const view = useScratchpadView(projectPath, info)
  return (
    <button
      type="button"
      onClick={onPick}
      data-tuner-target-choice={info.id}
      data-ti-tip={`Show scratchpad “${info.name}” in this Tuner`}
      className={rowClass(phone)}
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0 text-violet-400" />
      <span className="min-w-0 flex-1 truncate">{info.name}</span>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${view.dot}`} />
      <span className={`shrink-0 text-[10px] ${view.tone}`}>{view.label}</span>
    </button>
  )
}

export function UnityTargetChoices({
  tabId,
  projectPath,
  list,
  scratchpad
}: {
  tabId: string
  projectPath: string
  list: ScratchpadInfo[]
  scratchpad: ScratchpadInfo | null
}) {
  const setTabScratchpad = useAppStore((s) => s.setTabScratchpad)
  const phone = isPhoneView()
  const project = useEditorView(projectPath)
  const others = list.filter((s) => s.id !== scratchpad?.id).sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9))
  const canStart = project.status === 'stopped' || project.status === 'error'
  const pick = (id: string | null): void => {
    debugLog(`[tuner] target picked from the state card: ${id ?? 'project'} tab=${tabId}`)
    setTabScratchpad(tabId, id)
  }
  if (!scratchpad && !canStart && others.length === 0) return null
  return (
    <div data-tuner-target-choices className={`flex w-full flex-col gap-1.5 ${phone ? 'max-w-[320px]' : 'max-w-[260px]'}`}>
      {scratchpad ? (
        <button type="button" onClick={() => pick(null)} data-tuner-target-choice="project" data-ti-tip="Show the project's own Unity editor in this Tuner" className={rowClass(phone)}>
          <Box className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          <span className="min-w-0 flex-1 truncate">Use the project</span>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${project.dot}`} />
          <span className={`shrink-0 text-[10px] ${project.tone}`}>{project.label}</span>
        </button>
      ) : canStart ? (
        <button
          type="button"
          onClick={() => startProjectUnity(tabId, projectPath)}
          data-tuner-target-choice="start-unity"
          data-ti-tip="Open the Unity Player panel, which starts the project's editor"
          className={rowClass(phone)}
        >
          <Play className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
          <span className="min-w-0 flex-1 truncate">Start Unity</span>
        </button>
      ) : null}
      {others.length > 0 && (
        <>
          <div className={`pt-1 text-left text-zinc-500 ${phone ? 'text-xs' : 'text-[10px]'}`}>{scratchpad ? 'Or another scratchpad' : canStart ? 'Or a scratchpad' : 'Or show a scratchpad'}</div>
          {others.map((info) => (
            <ScratchpadChoice key={info.id} projectPath={projectPath} info={info} phone={phone} onPick={() => pick(info.id)} />
          ))}
        </>
      )}
    </div>
  )
}
