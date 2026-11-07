import { findTabRef, TAB_KIND, type ExecTab } from '@shared/tab-ref'
import type { ExecTabsReply } from '@shared/agent-exec'
import { useAppStore, type AppState } from '../../store'
import { collectGroupIds, shownTab } from '../tab-tree'
import { tabDisplayLabel } from '../tab-label'
import { stripAgentStatusGlyph } from '../agent-status'

export function execTabsOf(s: AppState, workspaceId: string): ExecTab[] {
  const tabs = s.tabsByWorkspace[workspaceId] ?? []
  const groups = s.groupsByWorkspace[workspaceId] ?? []
  const order = collectGroupIds(s.layoutByWorkspace[workspaceId])
  const full = s.fullscreenGroupIdByWorkspace[workspaceId]
  const active = s.activeGroupIdByWorkspace[workspaceId]
  const front = s.activeWorkspaceId === workspaceId
  const rows: ExecTab[] = []
  for (const gid of [...order, ...groups.map((g) => g.id).filter((id) => !order.includes(id))]) {
    const g = groups.find((x) => x.id === gid)
    if (!g) continue
    const own = g.tabOrder.map((id) => tabs.find((t) => t.id === id)).filter((t): t is NonNullable<typeof t> => !!t)
    const top = shownTab(g, own)
    const at = order.indexOf(g.id)
    for (const t of own) {
      const label = tabDisplayLabel(t, s.viewerFileByTab)
      const shown = !!top && top.id === t.id && !g.hidden && (!full || full === g.id) && at >= 0
      rows.push({
        id: t.id,
        ptyId: t.ptyId,
        label: t.contentType === 'terminal' ? stripAgentStatusGlyph(label).trim() : label,
        kind: TAB_KIND[t.contentType] ?? t.contentType,
        agent: t.agentId ?? null,
        pane: at >= 0 ? at + 1 : null,
        shown,
        focused: shown && front && g.id === active
      })
    }
  }
  return rows
}

function settled(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 150)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer)
        resolve()
      })
    )
  })
}

export async function execTabs(payload: { workspaceId: string; show?: string }): Promise<ExecTabsReply> {
  const s = useAppStore.getState()
  const ws = payload.workspaceId && s.tabsByWorkspace[payload.workspaceId] ? payload.workspaceId : s.activeWorkspaceId ?? ''
  if (!ws) return { error: 'This window has no workspace open.' }
  const tabs = execTabsOf(s, ws)
  if (payload.show === undefined) return { workspaceId: ws, tabs }
  const hit = findTabRef(tabs, payload.show)
  if (!hit.ok) return { error: hit.error }
  if (s.activeWorkspaceId !== ws) s.setActiveWorkspace(ws)
  const st = useAppStore.getState()
  const tab = (st.tabsByWorkspace[ws] ?? []).find((t) => t.id === hit.tab.id)
  const full = st.fullscreenGroupIdByWorkspace[ws]
  if (tab && full && full !== tab.groupId) st.exitFullscreen(ws)
  useAppStore.getState().activateTab(hit.tab.id)
  await settled()
  const now = execTabsOf(useAppStore.getState(), ws)
  return { workspaceId: ws, tabs: now, shown: now.find((t) => t.id === hit.tab.id) ?? hit.tab }
}
