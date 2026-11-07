import type { ReactNode } from 'react'
import type { AgentId } from '@shared/types'
import { getAgentEntry } from '@shared/agent-catalog'
import { AgentIcon } from '../../lib/agent-icon'

export type AgentLaunchTarget = 'split' | 'panel'

function TargetButton({
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
      className="flex items-center gap-1.5 whitespace-nowrap px-3 text-[11px] font-medium text-zinc-400 hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  )
}

function SplitIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3 w-3 shrink-0 opacity-70"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </svg>
  )
}

function PanelIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3 w-3 shrink-0 opacity-70"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
    </svg>
  )
}

export function AgentLaunchRow({
  id,
  onPick
}: {
  id: AgentId
  onPick: (id: AgentId, target: AgentLaunchTarget) => void
}) {
  return (
    <div className="group/agent relative flex w-full items-stretch rounded hover:bg-accent/[0.14]">
      <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 pr-24 text-[13px] text-ink">
        <AgentIcon id={id} />
        <span className="truncate">{getAgentEntry(id)?.label ?? id}</span>
      </div>

      <div className="absolute inset-y-0 right-0 hidden items-stretch group-hover/agent:flex">
        <div className="from-panel/0 to-panel w-8 bg-gradient-to-r" />
        <div className="bg-panel flex items-stretch divide-x divide-white/[0.06] rounded-r">
          <TargetButton onClick={() => onPick(id, 'split')} title="Open in a new split">
            <SplitIcon />
            Split
          </TargetButton>
          <TargetButton onClick={() => onPick(id, 'panel')} title="Open as a tab in this panel">
            <PanelIcon />
            This panel
          </TargetButton>
        </div>
      </div>
    </div>
  )
}
