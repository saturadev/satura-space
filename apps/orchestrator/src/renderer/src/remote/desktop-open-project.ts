import type { AgentId } from '@shared/types'
import { buildAgentLaunchCommand, getAgentEntry } from '@shared/agent-catalog'
import { debugLog } from '@shared/debug-log'
import { useAppStore } from '../store'
import type { TerminalAgentLaunch } from '../store/slices/workspaces'

function cleanPath(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

async function firstAgent(): Promise<(TerminalAgentLaunch | null)[] | undefined> {
  if (useAppStore.getState().detectedAgents === null) await useAppStore.getState().detectAgents().catch(() => {})
  const s = useAppStore.getState()
  const settings = s.settings
  const enabled = (s.detectedAgents ?? []).filter((id) => settings?.agents?.[id]?.enabled !== false)
  const prefs = [settings?.defaultAgent, ...(settings?.favoriteAgents ?? [])].filter((x): x is AgentId => Boolean(x))
  const top = prefs.find((id) => enabled.includes(id)) ?? enabled[0]
  const entry = top ? getAgentEntry(top) : undefined
  if (!top || !entry) return undefined
  return [{ command: buildAgentLaunchCommand(entry, settings?.agents?.[top]), label: entry.label, agentId: top }]
}

export async function openProjectOnMac(raw: string, rawRoot?: string): Promise<{ workspaceId: string; created: boolean; unity: boolean }> {
  const path = cleanPath(String(raw ?? ''))
  const root = rawRoot ? cleanPath(rawRoot) : path
  if (!path.startsWith('/') || !root.startsWith('/')) throw new Error('That is not a folder on the desktop')
  const worktree = root !== path
  const what = worktree ? `worktree ${path} of ${root}` : path
  const s = useAppStore.getState()
  const open = s.workspaces.find((w) => cleanPath(w.worktreePath || w.folderPath || '') === path)
  if (open) {
    s.setActiveWorkspace(open.id)
    debugLog(`[remote] the phone opened ${what}, it was open already`)
    return { workspaceId: open.id, created: false, unity: await window.api.unity.isProject(path).catch(() => false) }
  }
  const claim = await window.api.window.claimWorkspace({ folderPath: root, worktreePath: path })
  if (!claim.ok) throw new Error('This project is open in another Satura window')
  const unity = await window.api.unity.isProject(path).catch(() => false)
  const agents = await firstAgent()
  const st = useAppStore.getState()
  const tree = worktree ? path : undefined
  const id = unity ? st.createWorkspaceWithDefaultView(root, tree, 1, 1, agents) : st.createWorkspaceWithGrid(root, tree, 1, 1, agents)
  const after = useAppStore.getState()
  if (after.hydrationSucceeded) window.api.session.updateWindow(after.buildWindowSession({ terminalSnapshots: false }))
  console.log(`[remote] the phone opened ${what} as workspace ${id}${unity ? ' (Unity layout)' : ''}${agents?.[0] ? ` with ${agents[0].label}` : ''}`)
  return { workspaceId: id, created: true, unity }
}
