import type { MovedPanel } from '@shared/api'
import { useAppStore } from '../store'
import { captureTerminalSnapshot } from './terminal/serialize'
import { showDropFeedback } from './drop-feedback'
import { dropMovedDraft } from './editor/unsaved-files'

export async function moveTabToWindow(
  tabId: string,
  target: string | 'new',
  point?: { x: number; y: number }
): Promise<boolean> {
  const st = useAppStore.getState()
  let workspaceId: string | null = null
  for (const [wsId, tabs] of Object.entries(st.tabsByWorkspace)) {
    if (tabs.some((t) => t.id === tabId)) {
      workspaceId = wsId
      break
    }
  }
  if (!workspaceId) return false

  const tab = (st.tabsByWorkspace[workspaceId] ?? []).find((t) => t.id === tabId)
  if (!tab) return false
  if (tab.contentType === 'unity-instance-player' || tab.contentType === 'unity-scratchpad') {
    showDropFeedback("The Unity panel can't be moved to another window")
    return false
  }
  const wt = (st.worktreesByWorkspace[workspaceId] ?? []).find((w) => w.id === tab.worktreeId)
  const ws = st.workspaces.find((w) => w.id === workspaceId)

  const viewerFile = st.viewerFileByTab[tab.id] ?? null

  const panel: MovedPanel = {
    activeTabIndex: 0,
    originFolderPath: ws?.folderPath ?? wt?.path ?? '',
    originWorktreePath: ws?.worktreePath ?? wt?.path ?? '',
    tabs: [
      {
        ptyId: tab.ptyId,
        contentType: tab.contentType,
        label: tab.label,
        customLabel: tab.customLabel ?? null,
        generatedLabel: tab.generatedLabel ?? null,
        agentId: tab.agentId ?? null,
        claudeSessionId: tab.claudeSessionId ?? null,
        parentPtyId: tab.parentPtyId ?? null,
        worktreeName: wt?.name ?? 'main',
        worktreePath: wt?.path ?? '',
        scrollback: captureTerminalSnapshot(tab.ptyId),
        viewerFile,
        markdownView: st.markdownViewByTab[tab.id] ?? null,
        draft: viewerFile ? (st.draftsByPath[viewerFile] ?? null) : null,
        blameEnabled: viewerFile ? !!st.blameEnabledByPath[viewerFile] : false,
        tuner: tab.tuner ?? null,
        scratchpadId: tab.scratchpadId ?? null,
        plugin: tab.plugin ?? null
      }
    ]
  }

  const res = await window.api.window.movePanel({ target, panel, point })
  if (res.ok) {
    useAppStore.getState().detachTab(tabId)
    dropMovedDraft(viewerFile)
  } else if (res.reason === 'different-workspace')
    showDropFeedback("Can't move here — that window is a different workspace")
  return res.ok
}
