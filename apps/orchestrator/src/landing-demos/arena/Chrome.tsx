import { type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Columns2, SlidersHorizontal, SquareTerminal } from 'lucide-react'
import type { Tab } from '@shared/types'
import { useAppStore } from '@renderer/store'
import { TabGroupPanel, type GroupEdges } from '@renderer/components/workbench/TabGroupPanel'
import { tabDisplayLabel } from '@renderer/lib/tab-label'
import { agentRunStatusFor, stripAgentStatusGlyph, type AgentRunStatus } from '@renderer/lib/agent-status'
import { WORKSPACE } from '../mock/store'

const EDGES: GroupEdges = { top: true, left: false, right: false }
const BELOW: GroupEdges = { top: false, left: false, right: false }

export function DesktopPanels({ agentGroup, tunerGroup, agentWidth, vertical = false, agent, tuner }: { agentGroup: string; tunerGroup: string; agentWidth: number; vertical?: boolean; agent: ReactNode; tuner: ReactNode }) {
  const agentPanel = (
    <div className="min-h-0 min-w-0 shrink-0" style={vertical ? { height: 210 } : { width: agentWidth }}>
      <TabGroupPanel workspaceId={WORKSPACE} groupId={agentGroup} edges={vertical ? BELOW : EDGES} renderPane={() => agent} tabActions={false} />
    </div>
  )
  return (
    <div className={`flex h-full w-full bg-window pb-1 ${vertical ? 'flex-col' : 'flex-row'}`} data-demo-workbench>
      {!vertical && agentPanel}
      {!vertical && <div className="w-1 shrink-0" />}
      <div className="min-h-0 min-w-0 flex-1">
        <TabGroupPanel workspaceId={WORKSPACE} groupId={tunerGroup} edges={EDGES} renderPane={() => tuner} tabActions={false} />
      </div>
      {vertical && <div className="h-1 shrink-0" />}
      {vertical && agentPanel}
    </div>
  )
}

const DOT: Record<AgentRunStatus, string> = { working: 'work', 'needs-input': 'wait', idle: 'ok' }
const SF = { fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter Variable", Inter, system-ui, sans-serif' }

function StatusDot({ dot }: { dot: string }) {
  return (
    <span className="remote-dot relative flex h-[7px] w-[7px] shrink-0 items-center justify-center" data-dot={dot}>
      {(dot === 'work' || dot === 'wait') && <span className="remote-dot-halo absolute h-[13px] w-[13px] rounded-full" />}
      <span className="remote-dot-core relative h-[7px] w-[7px] rounded-full" />
    </span>
  )
}

function useRemoteTabs(order: string[]) {
  return useAppStore(
    useShallow((s) => {
      const tabs = s.tabsByWorkspace[WORKSPACE] ?? []
      const groups = s.groupsByWorkspace[WORKSPACE] ?? []
      const out: { tab: Tab; label: string; dot: string | null; group: string; groupActive: boolean }[] = []
      for (const gid of order) {
        const g = groups.find((x) => x.id === gid)
        if (!g) continue
        for (const id of g.tabOrder) {
          const t = tabs.find((x) => x.id === id)
          if (!t) continue
          const label = tabDisplayLabel(t, s.viewerFileByTab)
          const status = t.contentType === 'terminal' && t.agentId ? agentRunStatusFor(t, s.exitedPtyIds.includes(t.ptyId), s.agentHookStatusByPty[t.ptyId]) : null
          out.push({ tab: t, label: t.contentType === 'terminal' ? stripAgentStatusGlyph(label) : label, dot: status ? DOT[status] : null, group: gid, groupActive: g.activeTabId === t.id })
        }
      }
      return JSON.stringify(out.map((o) => ({ id: o.tab.id, kind: o.tab.contentType, label: o.label, dot: o.dot, group: o.group, groupActive: o.groupActive })))
    })
  )
}

interface Chip {
  id: string
  kind: string
  label: string
  dot: string | null
  group: string
  groupActive: boolean
}

export function RemoteChrome({ groups, selected, onSelect, children }: { groups: string[]; selected: string; onSelect: (tabId: string) => void; children: ReactNode }) {
  const chips = JSON.parse(useRemoteTabs(groups)) as Chip[]
  const focusedGroup = useAppStore((s) => s.activeGroupIdByWorkspace[WORKSPACE])
  const sel = chips.find((c) => c.id === selected) ?? chips[0]
  const many = groups.length > 1
  return (
    <div className="remote-chrome absolute inset-0 flex flex-col bg-canvas" style={SF} data-remote-chrome>
      <div className="relative z-10 flex shrink-0 flex-col gap-1 pb-1.5">
        <div className="flex h-[42px] items-center gap-1.5 px-[18px] pt-1.5">
          <span className="flex min-w-0 flex-1 items-center gap-1" data-remote-title>
            <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--remote-ink)]">{sel?.label ?? ''}</span>
          </span>
        </div>
        <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto px-2.5 py-0.5" data-remote-chips>
          {groups.map((gid, gi) => (
            <div key={gid} className="contents">
              {gi > 0 && <span aria-hidden className="mx-1 h-[22px] w-px shrink-0 bg-white/[0.16]" />}
              {many && (
                <span className={`flex shrink-0 items-center gap-[3px] pr-0.5 ${focusedGroup === gid ? 'text-[var(--remote-accent)]' : 'text-[var(--remote-label3)]'}`} aria-label={`Group ${gi + 1}`}>
                  <Columns2 size={11} strokeWidth={2.4} />
                  <span className="text-[11px] font-bold" style={{ fontFamily: 'ui-rounded, -apple-system, system-ui, sans-serif' }}>
                    {gi + 1}
                  </span>
                </span>
              )}
              {chips
                .filter((c) => c.group === gid)
                .map((c) => {
                  const on = c.id === sel?.id
                  return (
                    <button
                      key={c.id}
                      type="button"
                      data-remote-chip={c.id}
                      aria-pressed={on}
                      onClick={() => onSelect(c.id)}
                      className={`relative flex h-[26px] shrink-0 items-center gap-[7px] rounded-full pl-2 pr-2.5 text-[12px] font-semibold ${on ? 'bg-[var(--remote-ink)] text-[#0f0f12]' : 'remote-glass text-[var(--remote-ink)]'}`}
                    >
                      {c.dot ? <StatusDot dot={c.dot} /> : c.kind === 'tuner' ? <SlidersHorizontal size={13} strokeWidth={2.4} /> : <SquareTerminal size={13} strokeWidth={2.4} />}
                      <span className="whitespace-nowrap">{c.label}</span>
                      {many && c.groupActive && !on && <span aria-hidden className="pointer-events-none absolute inset-0 rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255/0.32)]" />}
                    </button>
                  )
                })}
            </div>
          ))}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  )
}
