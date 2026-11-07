import { ProgressBar } from '../motion'
import { isPendingId, useInstance } from '../../lib/unity/world-store'
import { pickPlayer } from './player-pick'

function PlayerChip({ projectPath, tabId, id, index, current }: { projectPath: string; tabId: string; id: string; index: number; current: boolean }) {
  const inst = useInstance(projectPath, id)
  const pending = isPendingId(id) || !inst || inst.lifecycle === 'init' || inst.lifecycle === 'launching' || inst.lifecycle === 'restarting'
  return (
    <button
      type="button"
      disabled={isPendingId(id)}
      onClick={() => pickPlayer(tabId, projectPath, id, index)}
      aria-pressed={current}
      data-phone-player={index + 1}
      className={`flex h-10 shrink-0 items-center gap-2 rounded-full border px-4 text-[15px] disabled:opacity-60 ${
        current ? 'border-sky-400/60 bg-sky-500/20 text-white' : 'border-white/10 bg-white/[0.04] text-zinc-300'
      }`}
    >
      {pending && <ProgressBar value={null} className="h-[2px] w-4" />}
      Player {index + 1}
    </button>
  )
}

export function PlayerPicker({ tabId, projectPath, ids, worldId }: { tabId: string; projectPath: string; ids: string[]; worldId: string }) {
  if (ids.length < 2) return null
  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-white/[0.06] bg-canvas px-3 py-2 [scrollbar-width:none]" data-phone-players={ids.length}>
      {ids.map((id, i) => (
        <PlayerChip key={id} projectPath={projectPath} tabId={tabId} id={id} index={i} current={id === worldId} />
      ))}
    </div>
  )
}
