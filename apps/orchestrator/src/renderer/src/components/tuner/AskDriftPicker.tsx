import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentId } from '@shared/types'
import { AGENT_CATALOG, getAgentEntry } from '@shared/agent-catalog'
import { useAppStore } from '../../store'
import { AnchoredLayer } from '../ui/AnchoredLayer'
import { AgentIcon } from '../../lib/agent-icon'
import { AgentModelEffort, agentHasModelEffort } from '../AgentModelEffort'
import { AgentLaunchRow, type AgentLaunchTarget } from '../workbench/AgentLaunchRow'
import { MoreAgentsSubmenu } from '../workbench/MoreAgentsSubmenu'
import { StatusDot, useWorkspaceAgents } from '../workspace/WorkspaceAgentsBadge'

export type AskDriftTo = { kind: 'agent'; ptyId: string } | { kind: 'new'; agentId: AgentId; target: AgentLaunchTarget }

function Heading({ children }: { children: string }) {
  return <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-ink-3">{children}</div>
}

export function AskDriftPicker({
  anchor,
  workspaceId,
  current,
  onPick,
  onClose
}: {
  anchor: HTMLElement | null
  workspaceId: string
  current: string
  onPick: (to: AskDriftTo) => void
  onClose: () => void
}) {
  const layerRef = useRef<HTMLDivElement>(null)
  const settings = useAppStore((s) => s.settings)
  const detected = useAppStore((s) => s.detectedAgents)
  const exited = useAppStore((s) => s.exitedPtyIds)
  const agents = useWorkspaceAgents(workspaceId)
  const running = useMemo(() => agents.filter((a) => !exited.includes(a.ptyId)), [agents, exited])
  const launchable = (id: AgentId): boolean => (detected ?? []).includes(id) && settings?.agents[id]?.enabled !== false
  const favs = (settings?.favoriteAgents ?? []).filter(launchable)
  const more = AGENT_CATALOG.map((e) => e.id).filter((id) => launchable(id) && !favs.includes(id))
  const optionAgents = [...favs, ...more].filter(agentHasModelEffort)
  const items: AskDriftTo[] = [
    ...running.map((a): AskDriftTo => ({ kind: 'agent', ptyId: a.ptyId })),
    ...favs.map((id): AskDriftTo => ({ kind: 'new', agentId: id, target: 'split' }))
  ]
  const [active, setActive] = useState(() => Math.max(0, running.findIndex((a) => a.ptyId === current)))
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const itemsRef = useRef(items)
  itemsRef.current = items
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const n = itemsRef.current.length
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowDown' && n) setActive((i) => (i + 1) % n)
      else if (e.key === 'ArrowUp' && n) setActive((i) => (i - 1 + n) % n)
      else if (e.key === 'Enter' && !e.shiftKey && n) pickRef.current(itemsRef.current[Math.min(activeRef.current, n - 1)])
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null
      if (layerRef.current?.contains(t) || anchor?.contains(t)) return
      if ((t as Element | null)?.closest?.('[data-menu-layer]') && !(t as Element).closest('[data-tuner-ask-window]')) return
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [anchor, onClose])

  const row = (i: number): string =>
    `relative rounded ${i === active ? 'bg-accent/[0.14]' : ''}`
  const launch = (id: AgentId, target: AgentLaunchTarget): void => onPick({ kind: 'new', agentId: id, target })

  return (
    <AnchoredLayer
      ref={layerRef}
      anchor={anchor}
      side="top"
      align="end"
      gap={6}
      className="animate-menu-pop-in surface-overlay w-80 origin-bottom-right rounded-lg p-1"
    >
      <div role="menu" aria-label="Who should Drift ask" data-tuner-ask-picker>
        {running.length > 0 && (
          <>
            <Heading>Agents in this workspace</Heading>
            {running.map((a, i) => (
              <button
                key={a.ptyId}
                type="button"
                role="menuitem"
                data-ask-agent={a.ptyId}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick({ kind: 'agent', ptyId: a.ptyId })}
                className={`${row(i)} flex h-8 w-full items-center gap-2 px-2 text-left text-[13px] text-ink`}
              >
                <AgentIcon id={a.agentId} />
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                {a.ptyId === current && <span className="text-xs text-ink-3">current</span>}
                <StatusDot status={a.status} />
              </button>
            ))}
            <div className="mx-1 my-1 h-px bg-white/[0.06]" />
          </>
        )}
        <Heading>Start a new agent</Heading>
        {favs.length === 0 && more.length === 0 ? (
          <div className="px-2 py-1.5 text-[13px] text-ink-3">No agents found. Set them up in Settings.</div>
        ) : (
          <>
            {favs.map((id, j) => (
              <div key={id} data-ask-new={id} className={row(running.length + j)} onMouseEnter={() => setActive(running.length + j)} onClick={(e) => {
                if (!(e.target as Element).closest('button')) launch(id, 'split')
              }}>
                <AgentLaunchRow id={id} onPick={launch} />
              </div>
            ))}
            {more.length > 0 && <MoreAgentsSubmenu agents={more} onPick={launch} />}
          </>
        )}
        {optionAgents.length > 0 && (
          <>
            <div className="mx-1 my-1 h-px bg-white/[0.06]" />
            {optionAgents.map((id) => (
              <div key={id} className="px-2 py-1.5" data-ask-options={id}>
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-3">
                  <AgentIcon id={id} className="h-3 w-3" />
                  {getAgentEntry(id)?.label ?? id} options
                </div>
                <AgentModelEffort id={id} />
              </div>
            ))}
          </>
        )}
      </div>
    </AnchoredLayer>
  )
}
