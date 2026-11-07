import { ipcMain } from 'electron'
import type { WorkspaceState, WindowSession, FilesState } from '@shared/api'
import type { LaunchRestoreInfo } from '@shared/claude-sessions'
import { recordWindowSnapshot, takeLaunchRestoreKind, takeWindowSession } from '../session-restore'
import { getDaemonProvider, whenDaemonReady } from '../daemon/daemon-init'

const LIVE_PTY_QUERY_MS = 4000

async function livePtyIds(): Promise<string[]> {
  const query = (async (): Promise<string[]> => {
    await whenDaemonReady()
    const sessions = (await getDaemonProvider()?.listSessions()) ?? []
    return sessions.map((s) => s.sessionId)
  })().catch(() => [] as string[])
  const timeout = new Promise<string[]>((resolve) => setTimeout(() => resolve([]), LIVE_PTY_QUERY_MS))
  return Promise.race([query, timeout])
}

function record<T>(v: unknown): Record<string, T> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {}
}

function sanitize(s: Partial<WorkspaceState> | null | undefined): WorkspaceState {
  return {
    workspaces: Array.isArray(s?.workspaces) ? s.workspaces : [],
    activeWorkspaceId: typeof s?.activeWorkspaceId === 'string' ? s.activeWorkspaceId : null,
    worktreesByWorkspace: record(s?.worktreesByWorkspace),
    tabsByWorkspace: record(s?.tabsByWorkspace),
    groupsByWorkspace: record(s?.groupsByWorkspace),
    layoutByWorkspace: record(s?.layoutByWorkspace),
    activeGroupIdByWorkspace: record(s?.activeGroupIdByWorkspace),
    exitedPtyIds: Array.isArray(s?.exitedPtyIds)
      ? s.exitedPtyIds.filter((v): v is string => typeof v === 'string')
      : []
  }
}

function sanitizeFiles(f: Partial<FilesState> | null | undefined): FilesState {
  return {
    viewerFileByTab: record(f?.viewerFileByTab),
    markdownViewByTab: record(f?.markdownViewByTab),
    selectedFileByWorktree: record(f?.selectedFileByWorktree),
    expandedDirsByWorktree: record(f?.expandedDirsByWorktree),
    blameEnabledByPath: record(f?.blameEnabledByPath),
    draftsByPath: record(f?.draftsByPath)
  }
}

const MAX_TERMINAL_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_TERMINAL_SNAPSHOTS_BYTES = 8 * 1024 * 1024

function sanitizeTerminalSnapshots(value: unknown): Record<string, string> {
  const input = record<unknown>(value)
  const out: Record<string, string> = {}
  let total = 0
  for (const [id, snapshot] of Object.entries(input)) {
    if (!id || typeof snapshot !== 'string') continue
    const bytes = Buffer.byteLength(snapshot, 'utf8')
    if (bytes > MAX_TERMINAL_SNAPSHOT_BYTES || total + bytes > MAX_TERMINAL_SNAPSHOTS_BYTES) continue
    out[id] = snapshot
    total += bytes
  }
  return out
}

function sanitizeSession(s: Partial<WindowSession> | null | undefined): WindowSession {
  return {
    workspace: sanitize(s?.workspace),
    files: sanitizeFiles(s?.files),
    terminalSnapshots:
      s?.terminalSnapshots === undefined ? undefined : sanitizeTerminalSnapshots(s.terminalSnapshots)
  }
}

export function registerStateHandlers(): void {
  ipcMain.on('session:put-window', (event, payload: WindowSession) => {
    recordWindowSnapshot(event.sender.id, sanitizeSession(payload))
    event.returnValue = true
  })

  ipcMain.on('session:update-window', (event, payload: WindowSession) => {
    recordWindowSnapshot(event.sender.id, sanitizeSession(payload))
  })

  ipcMain.handle('session:consume-window', (_event, restoreId: string): WindowSession | null =>
    takeWindowSession(restoreId)
  )

  ipcMain.handle(
    'session:launch-restore',
    async (_event, restoreId: string): Promise<LaunchRestoreInfo | null> => {
      const kind = typeof restoreId === 'string' ? takeLaunchRestoreKind(restoreId) : null
      if (!kind) return null
      return { kind, livePtyIds: await livePtyIds() }
    }
  )
}
