import type { Tab } from '@shared/types'
import { useAppStore } from '../../store'
import { detectAgentStatusFromTitle } from '../agent-status'
import { requestConfirm, type ConfirmAnchor } from './confirm-store'
import { isScratchpadLive } from '../unity/scratchpads'
import { confirmCloseTunerTab } from '../tuner/unsaved'

function tabTitle(tab: Tab): string {
  return tab.customLabel ?? tab.generatedLabel ?? tab.label
}

function isTerminalWorking(tab: Tab): boolean {
  if (tab.contentType !== 'terminal') return false
  const exited = useAppStore.getState().exitedPtyIds.includes(tab.ptyId)
  if (exited) return false
  if (detectAgentStatusFromTitle(tab.generatedLabel) === 'working') return true
  return true
}

function worktreePathOf(tab: Tab): string {
  const s = useAppStore.getState()
  for (const [wsId, tabs] of Object.entries(s.tabsByWorkspace)) {
    if (!tabs.some((t) => t.id === tab.id)) continue
    return (s.worktreesByWorkspace[wsId] ?? []).find((w) => w.id === tab.worktreeId)?.path ?? ''
  }
  return ''
}

async function confirmCloseScratchpads(tab: Tab, anchor?: ConfirmAnchor | null): Promise<boolean> {
  const path = worktreePathOf(tab)
  if (!path) return true
  const s = useAppStore.getState()
  const otherPanel = Object.entries(s.tabsByWorkspace).some(([wsId, tabs]) =>
    tabs.some(
      (t) =>
        t.id !== tab.id &&
        t.contentType === 'unity-scratchpad' &&
        (s.worktreesByWorkspace[wsId] ?? []).find((w) => w.id === t.worktreeId)?.path === path
    )
  )
  if (otherPanel) return true
  const r = await window.api.scratchpads.list(path)
  const live = r.ok ? r.data.filter(isScratchpadLive) : []
  if (live.length === 0) return true
  const names = live.map((sp) => `“${sp.name}”`).join(', ')
  const ok = await requestConfirm({
    title: 'Stop scratchpads?',
    message:
      live.length === 1
        ? `Scratchpads run only while this panel is open. Closing it stops ${names}.`
        : `Scratchpads run only while this panel is open. Closing it stops ${live.length} of them: ${names}.`,
    confirmLabel: 'Stop and Close',
    anchor
  })
  if (ok) void window.api.scratchpads.stopAll(path)
  return ok
}

export async function confirmCloseTab(
  tab: Tab,
  anchor?: ConfirmAnchor | null
): Promise<boolean> {
  if (tab.contentType === 'unity-instance-player') {
    return requestConfirm({
      title: 'Close Unity Player?',
      message: 'This stops the running Unity instance for this pane. Unsaved play-mode changes will be lost.',
      confirmLabel: 'Close Player',
      anchor
    })
  }

  if (tab.contentType === 'unity-scratchpad') return confirmCloseScratchpads(tab, anchor)

  if (tab.contentType === 'tuner') return confirmCloseTunerTab(tab.id, anchor)

  if (isTerminalWorking(tab)) {
    return requestConfirm({
      title: 'Close terminal?',
      message: `“${tabTitle(tab)}” is still running. Closing it will terminate the process and any work in progress.`,
      confirmLabel: 'Close Terminal',
      anchor
    })
  }

  return true
}

export function confirmDeleteWorkspace(
  name: string,
  hasWork: boolean,
  anchor?: ConfirmAnchor | null
): Promise<boolean> {
  return requestConfirm({
    title: 'Close workspace?',
    message: hasWork
      ? `“${name}” has running terminals and Unity instances. Closing it will terminate them and any work in progress, and close any separate windows for this workspace.`
      : `Close “${name}”? Its layout and open panes will be discarded, and any separate windows for this workspace will close.`,
    confirmLabel: 'Close Workspace',
    anchor
  })
}
