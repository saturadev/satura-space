import type { WindowInfo } from '@shared/api'
import type { Tab } from '@shared/types'
import { useAppStore, type AppState } from '../../store'
import { requestCloseTab } from '../editor/close-file-tab'
import { viewerFileForTab } from '../editor/viewer-file'
import { canRestartAgentTab, restartAgentTab } from '../claude-sessions/launch-restore'
import { moveWorkspaceToNewWindow, moveWorkspaceToWindow } from '../workspace-move'
import { tabDisplayLabel } from '../tab-label'
import type { ConfirmAnchor } from '../confirm/confirm-store'
import { compact, section, type ActionNode } from './action-tree'

export function findTabIn(s: AppState, tabId: string): { workspaceId: string; tab: Tab } | null {
  for (const [workspaceId, tabs] of Object.entries(s.tabsByWorkspace)) {
    const tab = tabs.find((t) => t.id === tabId)
    if (tab) return { workspaceId, tab }
  }
  return null
}

export function tabMenuNodes(tabId: string, opts: { onRename?: () => void; anchor?: ConfirmAnchor | null } = {}): ActionNode[] {
  const s = useAppStore.getState()
  const found = findTabIn(s, tabId)
  if (!found) return []
  const { workspaceId, tab } = found
  const groupId = tab.groupId
  const isFullscreen = s.fullscreenGroupIdByWorkspace[workspaceId] === groupId
  const isHidden = !!s.groupsByWorkspace[workspaceId]?.find((g) => g.id === groupId)?.hidden
  const file = viewerFileForTab(tab, s.viewerFileByTab)
  const viewerFile = tab.contentType === 'file-viewer' && file ? file : null
  return compact([
    section('tab', [
      tab.contentType === 'terminal' && {
        id: 'tab.rename',
        label: 'Rename',
        icon: 'pencil',
        input: { title: 'Rename', initial: tabDisplayLabel(tab, s.viewerFileByTab), submit: 'Rename' },
        run: (value) => (value === undefined ? opts.onRename?.() : s.setTabLabel(tabId, value))
      },
      canRestartAgentTab(tab) && { id: 'tab.restart', label: 'Restart session', icon: 'arrow.clockwise', run: () => restartAgentTab(tabId) },
      {
        id: 'tab.fullscreen',
        label: isFullscreen ? 'Exit fullscreen' : 'Fullscreen panel',
        icon: isFullscreen ? 'arrow.down.right.and.arrow.up.left' : 'arrow.up.left.and.arrow.down.right',
        checked: isFullscreen,
        run: () => s.toggleGroupFullscreen(workspaceId, groupId)
      },
      {
        id: 'tab.hide',
        label: isHidden ? 'Show panels' : 'Hide panels',
        icon: isHidden ? 'eye' : 'eye.slash',
        checked: isHidden,
        run: () => s.toggleGroupHidden(workspaceId, groupId)
      }
    ]),
    viewerFile &&
      section('file', [
        { id: 'tab.explorer', label: 'Focus in Explorer', icon: 'sidebar.left', run: () => s.requestExplorerReveal(tab.worktreeId, viewerFile) },
        { id: 'tab.copyPath', label: 'Copy full path', icon: 'doc.on.doc', run: () => void window.api.ui.writeClipboardText(viewerFile) },
        { id: 'tab.finder', label: 'Reveal in Finder', icon: 'folder', run: () => void window.api.shell.showItemInFolder(viewerFile) }
      ]),
    section('close', [{ id: 'tab.close', label: 'Close tab', icon: 'xmark', destructive: true, run: () => requestCloseTab(tabId, opts.anchor ?? null) }])
  ])
}

export function workspaceMenuNodes(
  workspaceId: string,
  targets: WindowInfo[],
  requestDelete: (id: string, anchor?: ConfirmAnchor | null) => void,
  anchor?: ConfirmAnchor | null
): ActionNode[] {
  return compact([
    section('move', [
      { id: 'workspace.newWindow', label: 'Move to New Window', icon: 'macwindow.badge.plus', run: () => void moveWorkspaceToNewWindow(workspaceId) },
    ]),
    section(
      'moveTo',
      targets.map((t) => ({ id: `workspace.moveTo:${t.id}`, label: t.label || 'Untitled window', icon: 'macwindow', run: () => void moveWorkspaceToWindow(workspaceId, t.id) })),
      'Move to window'
    ),
    section('close', [
      {
        id: 'workspace.close',
        label: 'Close Workspace',
        icon: 'xmark.rectangle',
        destructive: true,
        desktopClass: 'text-rose-300 hover:text-rose-200',
        run: () => requestDelete(workspaceId, anchor)
      }
    ])
  ])
}

export function workbenchNodes(): ActionNode[] {
  const s = useAppStore.getState()
  return [
    section('workbench', [
      { id: 'workbench.quickOpen', label: 'Quick Open', icon: 'magnifyingglass', shortcut: 'shift shift', run: () => s.openQuickOpen() },
      {
        id: 'workbench.findInFiles',
        label: 'Find in files',
        icon: 'doc.text.magnifyingglass',
        shortcut: 'mod+shift+f',
        run: () => {
          const wsId = s.activeWorkspaceId
          const worktree = wsId ? (s.worktreesByWorkspace[wsId] ?? [])[0] : undefined
          if (!worktree) return
          s.setSidebarOpen(true)
          s.requestExplorerSearch(worktree.id)
        }
      },
      { id: 'workbench.sidebar', label: 'Toggle Sidebar', icon: 'sidebar.left', shortcut: 'mod+b', checked: s.sidebarOpen, run: () => s.toggleSidebar() }
    ])
  ]
}

export function terminalNodes(): ActionNode[] {
  const s = useAppStore.getState()
  return [
    section('terminal', [
      {
        id: 'terminal.font',
        label: 'Font size',
        icon: 'textformat.size',
        children: [
          { id: 'terminal.font.up', label: 'Increase font size', icon: 'plus.magnifyingglass', shortcut: 'mod+plus', run: () => s.adjustFontSize('terminal', 1) },
          { id: 'terminal.font.down', label: 'Decrease font size', icon: 'minus.magnifyingglass', shortcut: 'mod+minus', run: () => s.adjustFontSize('terminal', -1) },
          { id: 'terminal.font.reset', label: 'Reset font size', icon: 'arrow.counterclockwise', shortcut: 'mod+0', run: () => s.adjustFontSize('terminal', 'reset') }
        ]
      }
    ])
  ]
}
