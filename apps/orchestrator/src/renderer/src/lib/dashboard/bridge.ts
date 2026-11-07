import type { AgentId } from '@shared/types'
import { useAppStore } from '../../store'
import { toPosixPath } from '../path'
import { setDashboardAlerts } from './alerts-store'
import { openDashboard } from './open-dashboard'
import { sendToAgent } from './send-agent'

function projectsOf(): string[] {
  const s = useAppStore.getState()
  const out = new Set<string>()
  for (const wts of Object.values(s.worktreesByWorkspace)) for (const w of wts) if (w.path) out.add(toPosixPath(w.path).replace(/\/+$/, ''))
  return [...out].sort()
}

function placeFor(project: string): { workspaceId: string; worktreeId: string; groupId: string } | null {
  const s = useAppStore.getState()
  const want = toPosixPath(project).replace(/\/+$/, '')
  for (const workspaceId of [s.activeWorkspaceId, ...Object.keys(s.worktreesByWorkspace)]) {
    if (!workspaceId) continue
    const wt = (s.worktreesByWorkspace[workspaceId] ?? []).find((w) => toPosixPath(w.path).replace(/\/+$/, '') === want)
    if (!wt) continue
    const groupId = s.activeGroupIdByWorkspace[workspaceId] ?? s.ensureWorkbench(workspaceId)
    return { workspaceId, worktreeId: wt.id, groupId }
  }
  return null
}

function defaultAgent(): AgentId | null {
  const s = useAppStore.getState()
  const detected = s.detectedAgents ?? []
  const ok = (id: AgentId | null | undefined): id is AgentId => !!id && detected.includes(id) && s.settings?.agents[id]?.enabled !== false
  const def = s.settings?.defaultAgent
  if (ok(def)) return def
  return (s.settings?.favoriteAgents ?? []).find(ok) ?? null
}

export function installDashboardBridge(): () => void {
  let last = ''
  const push = (): void => {
    const list = projectsOf()
    const key = list.join('\n')
    if (key === last) return
    last = key
    window.api.dashboard.setProjects(list)
  }
  push()
  const unsub = useAppStore.subscribe(push)
  const offAlerts = window.api.dashboard.onAlerts((ev) => setDashboardAlerts(ev.project, ev.alerts))
  const offOpen = window.api.dashboard.onOpen((req) => {
    openDashboard(req)
  })
  const offSpawn = window.api.dashboard.onSpawnAgent((req) => {
    const place = placeFor(req.projectPath)
    const agent = defaultAgent()
    if (!place || !agent) {
      console.warn(`[dashboard] alert ${req.alert}: no ${place ? 'agent to start' : 'workspace for the project'}`)
      return
    }
    void sendToAgent(place, { kind: 'new', agentId: agent, target: 'split' }, req.text).then((r) => {
      if (r.sent) window.api.dashboard.alertSent(req.projectPath, req.alert, r.ptyId)
    })
  })
  return () => {
    unsub()
    offAlerts()
    offOpen()
    offSpawn()
  }
}
