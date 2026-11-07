import { useAppStore, type AppState } from '../store'

const SESSION_RELEVANT_FIELDS = [
  'workspaces',
  'activeWorkspaceId',
  'worktreesByWorkspace',
  'tabsByWorkspace',
  'groupsByWorkspace',
  'layoutByWorkspace',
  'activeGroupIdByWorkspace',
  'viewerFileByTab',
  'markdownViewByTab',
  'selectedFileByWorktree',
  'expandedDirsByWorktree',
  'blameEnabledByPath',
  'draftsByPath',
  'draftMetaByPath',
  'liveByTab'
] as const satisfies readonly (keyof AppState)[]

const DEBOUNCE_MS = 150
const MAX_WAIT_MS = 1000
const SNAPSHOT_INTERVAL_MS = 30_000

export function startSessionWriteSubscriber(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstPendingAt = 0
  const flush = (terminalSnapshots: boolean): void => {
    if (!useAppStore.getState().hydrationSucceeded) return
    window.api.session.updateWindow(useAppStore.getState().buildWindowSession({ terminalSnapshots }))
  }
  const unsubscribe = useAppStore.subscribe((state, prev) => {
    if (!state.hydrationSucceeded) return
    if (!SESSION_RELEVANT_FIELDS.some((key) => state[key] !== prev[key])) return
    if (state.viewerFileByTab !== prev.viewerFileByTab) {
      if (timer) clearTimeout(timer)
      timer = null
      flush(false)
      return
    }
    const now = Date.now()
    if (timer) clearTimeout(timer)
    else firstPendingAt = now
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, firstPendingAt + MAX_WAIT_MS - now))
    timer = setTimeout(() => {
      timer = null
      flush(false)
    }, delay)
  })
  const snapshotTimer = setInterval(() => flush(true), SNAPSHOT_INTERVAL_MS)
  flush(true)
  return () => {
    unsubscribe()
    if (timer) clearTimeout(timer)
    clearInterval(snapshotTimer)
  }
}
