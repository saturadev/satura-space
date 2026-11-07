import { useState } from 'react'
import { AnchoredLayer } from '../ui/AnchoredLayer'
import type { AgentId } from '@shared/types'
import { menuItemClass } from '../ui/FloatingMenu'
import { AgentLaunchRow, type AgentLaunchTarget } from './AgentLaunchRow'

export function MoreAgentsSubmenu({
  agents,
  onPick
}: {
  agents: AgentId[]
  onPick: (id: AgentId, target: AgentLaunchTarget) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button className={menuItemClass} onClick={() => setOpen((o) => !o)}>
        <svg
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="1" />
          <circle cx="6" cy="12" r="1" />
          <circle cx="18" cy="12" r="1" />
        </svg>
        More agents
        <svg
          viewBox="0 0 24 24"
          className="ml-auto h-3.5 w-3.5 shrink-0 text-zinc-500"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>

      {open && (
        <AnchoredLayer
          side="left"
          align="start"
          gap={2}
          className="animate-submenu-pop-in surface-overlay w-64 origin-top-right rounded-lg p-1"
        >
          {agents.map((id) => (
            <AgentLaunchRow key={id} id={id} onPick={onPick} />
          ))}
        </AnchoredLayer>
      )}
    </div>
  )
}
