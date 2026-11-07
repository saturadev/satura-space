import { DASHBOARD_TAB_LABEL } from '@shared/dashboard'
import type { Tab } from '@shared/types'
import { useAppStore, type AppState } from '../../store'
import { toPosixPath } from '../path'

const pages = new Map<string, string>()
const listeners = new Set<() => void>()

const key = (project: string): string => toPosixPath(project).replace(/\/+$/, '')

export function dashboardPage(project: string): string | undefined {
  return pages.get(key(project))
}

export function setDashboardPage(project: string, page: string): void {
  if (pages.get(key(project)) === page) return
  pages.set(key(project), page)
  for (const l of [...listeners]) l()
}

export function subscribeDashboardPage(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function dashboardTabOf(s: AppState, project: string): { tab: Tab; workspaceId: string } | null {
  const want = key(project)
  for (const [workspaceId, tabs] of Object.entries(s.tabsByWorkspace)) {
    const wts = s.worktreesByWorkspace[workspaceId] ?? []
    const tab = tabs.find((t) => t.contentType === 'dashboard' && key(wts.find((w) => w.id === t.worktreeId)?.path ?? '') === want)
    if (tab) return { tab, workspaceId }
  }
  return null
}

function target(s: AppState, project: string, ptyId?: string): { workspaceId: string; worktreeId: string; groupId: string | null } | null {
  const want = key(project)
  if (ptyId) {
    for (const [workspaceId, tabs] of Object.entries(s.tabsByWorkspace)) {
      const t = tabs.find((x) => x.ptyId === ptyId)
      if (t) return { workspaceId, worktreeId: t.worktreeId, groupId: t.groupId }
    }
  }
  const order = [s.activeWorkspaceId, ...Object.keys(s.worktreesByWorkspace)].filter((w): w is string => !!w)
  for (const workspaceId of order) {
    const wt = (s.worktreesByWorkspace[workspaceId] ?? []).find((w) => key(w.path) === want)
    if (wt) return { workspaceId, worktreeId: wt.id, groupId: s.activeGroupIdByWorkspace[workspaceId] ?? null }
  }
  return null
}

export function openDashboard(req: { projectPath: string; page?: string; ptyId?: string; workspaceId?: string; groupId?: string }): boolean {
  if (req.page) setDashboardPage(req.projectPath, req.page)
  const s = useAppStore.getState()
  const open = dashboardTabOf(s, req.projectPath)
  if (open) {
    if (s.activeWorkspaceId !== open.workspaceId) s.setActiveWorkspace(open.workspaceId)
    const full = s.fullscreenGroupIdByWorkspace[open.workspaceId]
    if (full && full !== open.tab.groupId) s.exitFullscreen(open.workspaceId)
    useAppStore.getState().activateTab(open.tab.id)
    return true
  }
  const t = target(s, req.projectPath, req.ptyId)
  if (!t) return false
  const workspaceId = req.workspaceId ?? t.workspaceId
  if (s.activeWorkspaceId !== workspaceId) s.setActiveWorkspace(workspaceId)
  const st = useAppStore.getState()
  const groupId = req.groupId ?? t.groupId ?? st.activeGroupIdByWorkspace[workspaceId] ?? st.ensureWorkbench(workspaceId)
  const full = st.fullscreenGroupIdByWorkspace[workspaceId]
  if (full) st.exitFullscreen(workspaceId)
  const tab = st.openTabBeside(workspaceId, groupId, t.worktreeId, { label: DASHBOARD_TAB_LABEL, contentType: 'dashboard' })
  useAppStore.getState().activateTab(tab.id)
  return true
}
