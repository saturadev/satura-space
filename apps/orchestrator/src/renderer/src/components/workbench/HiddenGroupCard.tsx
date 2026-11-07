import type { Tab } from '@shared/types'
import { useAppStore } from '../../store'
import { PanelIcon } from './PanelIcon'
import { viewerFileForTab } from '../../lib/editor/viewer-file'
import { agentRunStatusFor } from '../../lib/agent-status'
import { tabDisplayLabel } from '../../lib/tab-label'
import { useTunerTabTitles } from '../../lib/tuner/tab-titles'
import { useTerminalRecaps } from '../../lib/terminal/recap'
import { StatusDot } from '../workspace/WorkspaceAgentsBadge'

function HiddenTabRow({ tab }: { tab: Tab }) {
  const recaps = useTerminalRecaps(tab.ptyId, tab.contentType === 'terminal')
  const tunerTitles = useTunerTabTitles()
  const label = useAppStore((s) => tabDisplayLabel(tab, s.viewerFileByTab, s.reportTitles, tunerTitles))
  const pulse = useAppStore((s) => s.pulseByPty[tab.ptyId])
  const file = useAppStore((s) => viewerFileForTab(tab, s.viewerFileByTab))
  const status = useAppStore((s) =>
    tab.agentId
      ? agentRunStatusFor(tab, s.exitedPtyIds.includes(tab.ptyId), s.agentHookStatusByPty[tab.ptyId])
      : null
  )
  const recap = recaps[recaps.length - 1]

  return (
    <div className="relative px-4 py-3" data-hidden-tab={tab.id}>
      {pulse && (
        <span
          key={pulse.seq}
          aria-hidden
          className={`satura-alert-flash pointer-events-none absolute inset-0 ${
            pulse.kind === 'finished'
              ? 'bg-emerald-400/12'
              : pulse.kind === 'opened'
                ? 'bg-sky-400/15'
                : 'bg-amber-400/15'
          }`}
        />
      )}
      <div className="relative flex items-center gap-2.5">
        <span className="flex w-4 shrink-0 justify-center">
          <PanelIcon tab={tab} file={file} />
        </span>
        <span className="min-w-0 truncate text-[13px] text-zinc-200">{label}</span>
        {status && (
          <span className="ml-auto flex shrink-0 pl-2">
            <StatusDot status={status} />
          </span>
        )}
      </div>
      {recap && (
        <p className="relative mt-1.5 line-clamp-3 pl-[26px] text-xs leading-relaxed text-zinc-400">{recap}</p>
      )}
    </div>
  )
}

export function HiddenGroupCard({
  workspaceId,
  groupId,
  tabs
}: {
  workspaceId: string
  groupId: string
  tabs: Tab[]
}) {
  const toggleGroupHidden = useAppStore((s) => s.toggleGroupHidden)

  return (
    <div className="flex h-full w-full overflow-auto bg-canvas">
      <div className="m-auto w-full max-w-md p-4">
        <div className="overflow-hidden rounded-md bg-sunken">
          {tabs.length > 0 && (
            <div className="divide-y divide-white/5">
              {tabs.map((t) => (
                <HiddenTabRow key={t.id} tab={t} />
              ))}
            </div>
          )}
          <button
            onClick={() => toggleGroupHidden(workspaceId, groupId)}
            className={`w-full py-2 text-center text-xs text-zinc-400 transition-colors hover:bg-white/5 hover:text-white ${
              tabs.length > 0 ? 'border-t border-white/10' : ''
            }`}
          >
            Show
          </button>
        </div>
      </div>
    </div>
  )
}
