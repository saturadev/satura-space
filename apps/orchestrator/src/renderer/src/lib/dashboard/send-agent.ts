import { buildAgentLaunchCommand, getAgentEntry } from '@shared/agent-catalog'
import type { AskDriftTo } from '../../components/tuner/AskDriftPicker'
import { useAppStore } from '../../store'
import { setPendingCommand } from '../terminal/pending-commands'

export type AgentTarget = AskDriftTo

export async function sendToAgent(
  place: { workspaceId: string; worktreeId: string; groupId: string },
  to: AgentTarget,
  text: string
): Promise<{ sent: true; ptyId: string; label: string } | { sent: false; error: string }> {
  const st = useAppStore.getState()
  if (to.kind === 'agent') {
    const t = Object.values(st.tabsByWorkspace).flat().find((x) => x.ptyId === to.ptyId)
    const label = t ? (t.customLabel ?? t.label) : 'That terminal'
    const r = await window.api.agentExec.tell(to.ptyId, text).catch(() => 'gone' as const)
    if (r !== 'sent') return { sent: false, error: r === 'shell' ? `${label} has no agent running now. Pick another one.` : `${label} is closed. Pick another agent.` }
    if (t) useAppStore.getState().activateTab(t.id)
    return { sent: true, ptyId: to.ptyId, label }
  }
  const entry = getAgentEntry(to.agentId)
  if (!entry) return { sent: false, error: 'Satura Space could not start that agent here.' }
  const opts = { label: entry.label, agentId: to.agentId }
  const fresh =
    to.target === 'panel'
      ? st.createTab(place.workspaceId, place.worktreeId, { ...opts, groupId: place.groupId })
      : st.openTabBeside(place.workspaceId, place.groupId, place.worktreeId, opts)
  setPendingCommand(fresh.ptyId, buildAgentLaunchCommand(entry, st.settings?.agents[to.agentId]))
  const r = await window.api.agentExec.tell(fresh.ptyId, text, true).catch(() => 'gone' as const)
  if (r !== 'sent') return { sent: false, error: `${entry.label} did not start in time. Pick it from the list once it is ready.` }
  return { sent: true, ptyId: fresh.ptyId, label: entry.label }
}
