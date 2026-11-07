import type { Tab } from '@shared/types'
import { useAppStore } from '../../store'
import { confirmCloseTab } from '../confirm/close-confirmations'
import type { ConfirmAnchor } from '../confirm/confirm-store'
import { resolveUnsavedFiles, unsavedFilesOf } from './unsaved-files'

export function requestCloseTab(tabId: string, anchor?: ConfirmAnchor | null): void {
  const s = useAppStore.getState()

  let tab: Tab | undefined
  let root = ''
  for (const [wsId, tabs] of Object.entries(s.tabsByWorkspace)) {
    tab = tabs.find((t) => t.id === tabId)
    if (!tab) continue
    root = (s.worktreesByWorkspace[wsId] ?? []).find((w) => w.id === tab?.worktreeId)?.path ?? ''
    break
  }
  if (!tab) return
  const closing = tab

  void confirmCloseTab(closing, anchor).then(async (ok) => {
    if (!ok) return
    const files = unsavedFilesOf((t) => t.id === closing.id || t.attachedTo === closing.id)
    if (!(await resolveUnsavedFiles(files, 'close', { anchor, root }))) return
    useAppStore.getState().closeTab(closing.id, { keepGroup: true })
  })
}
