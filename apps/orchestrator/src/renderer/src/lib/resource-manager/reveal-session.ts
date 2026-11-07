import type { ResourceSession } from '@shared/api'
import { useAppStore } from '../../store'

export function revealSession(session: ResourceSession): void {
  const currentWindowId = new URLSearchParams(window.location.search).get('wid')
  if (session.windowId && currentWindowId && session.windowId !== currentWindowId) {
    window.api.window.focus(session.windowId)
    return
  }
  const st = useAppStore.getState()
  for (const ws of st.workspaces) {
    const tabs = st.tabsByWorkspace[ws.id] ?? []
    let tabId: string | null = null
    if (session.kind === 'terminal') {
      tabId = tabs.find((t) => t.ptyId === session.id)?.id ?? null
    } else {
      const wt = (st.worktreesByWorkspace[ws.id] ?? []).find((w) => w.path === session.projectPath)
      if (wt) {
        tabId =
          tabs.find((t) => t.contentType === 'unity-instance-player' && t.worktreeId === wt.id)?.id ??
          null
      }
    }
    if (tabId) {
      st.setActiveWorkspace(ws.id)
      st.activateTab(tabId)
      return
    }
  }
}
