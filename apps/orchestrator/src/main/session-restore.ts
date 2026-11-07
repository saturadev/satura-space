import { app, BrowserWindow } from 'electron'
import type { PersistedSession, WindowSession } from '@shared/api'
import type { LaunchRestoreKind } from '@shared/claude-sessions'
import { flushStateSync, loadState } from './persistence'
import { getLiveWindowSession, putWindowSession, takeAllSessionWindows } from './session-registry'
import { createAppWindow, windowIdForWebContents, windowMetaForWebContents } from './window/window-manager'
import { markRestoreQuit } from './quit-state'
import { requestDevRelaunch } from './dev-relaunch'
import { isUpdateRelaunch } from './update-handoff'
import { censusTrack } from '@shared/census'
import { debugLog } from '@shared/debug-log'

let capture: { remaining: Set<string>; done: () => void } | null = null

export function captureSessionForRestart(timeoutMs = 1500): Promise<void> {
  markRestoreQuit()
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (wins.length === 0) {
    flushStateSync()
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      capture = null
      flushStateSync()
      console.log('[restore] captured window sessions for update restart')
      resolve()
    }
    const remaining = new Set<string>()
    for (const w of wins) {
      const id = windowIdForWebContents(w.webContents.id)
      if (id) remaining.add(id)
    }
    if (remaining.size === 0) {
      finish()
      return
    }
    capture = { remaining, done: finish }
    for (const w of wins) w.webContents.send('updater:prepare-restore')
    setTimeout(finish, timeoutMs)
  })
}

export function recordWindowSnapshot(webContentsId: number, session: WindowSession): void {
  const windowId = windowIdForWebContents(webContentsId)
  if (!windowId) return
  const meta = windowMetaForWebContents(webContentsId)
  putWindowSession(windowId, session, meta ? { identity: meta.identity, label: meta.label } : null)
  if (capture && session.terminalSnapshots !== undefined) {
    capture.remaining.delete(windowId)
    if (capture.remaining.size === 0) capture.done()
  }
}

const pendingWindowSession = new Map<string, WindowSession>()
censusTrack('session-restore.pendingWindowSession', pendingWindowSession)
const launchRestoreIds = new Set<string>()
censusTrack('session-restore.launchRestoreIds', launchRestoreIds)
let launchRestoreKind: LaunchRestoreKind = 'normal'

export function restorePersistedWindows(session: PersistedSession): string[] {
  console.log(`[restore] restoring ${session.windows.length} window(s) from disk`)
  const anyPrimary = session.windows.some((s) => s.role === 'primary')
  const restoreIds: string[] = []
  session.windows.forEach((snap, idx) => {
    const role: 'primary' | 'secondary' =
      snap.role === 'primary' || (!anyPrimary && idx === 0) ? 'primary' : 'secondary'
    const restoreId = createAppWindow(undefined, {
      bounds: snap.bounds,
      maximized: snap.maximized,
      identity: snap.identity,
      label: snap.label,
      role,
      restore: true,
      initialSession: snap.session
    })
    pendingWindowSession.set(restoreId, snap.session)
    restoreIds.push(restoreId)
  })
  return restoreIds
}

export function restoreOnLaunch(): boolean {
  const session = loadState().session
  if (!session || session.windows.length === 0) return false
  launchRestoreKind = isUpdateRelaunch() ? 'update' : 'normal'
  console.log(`[restore] launch restore kind: ${launchRestoreKind}`)
  for (const id of restorePersistedWindows(session)) launchRestoreIds.add(id)
  return true
}

export function takeLaunchRestoreKind(restoreId: string): LaunchRestoreKind | null {
  if (!launchRestoreIds.delete(restoreId)) return null
  return launchRestoreKind
}

export function restoreClosedWindowsOrCreate(): void {
  const snaps = takeAllSessionWindows()
  if (snaps.length === 0) {
    createAppWindow(undefined, { role: 'primary' })
    return
  }
  restorePersistedWindows({ windows: snaps })
}

export function takeWindowSession(restoreId: string): WindowSession | null {
  const pending = pendingWindowSession.get(restoreId) ?? null
  if (pending) {
    pendingWindowSession.delete(restoreId)
    debugLog(`[restore] window ${restoreId} hydrated from pending session`)
    return pending
  }
  const liveSession = getLiveWindowSession(restoreId)
  if (liveSession) {
    debugLog(`[restore] window ${restoreId} hydrated from live registry fallback`)
    return liveSession
  }
  debugLog(`[restore] window ${restoreId} has no session to hydrate`)
  return null
}

export async function simulateUpdateRestart(): Promise<void> {
  if (!app.isPackaged) {
    const url = process.env.ELECTRON_RENDERER_URL
    if (!url) {
      throw new Error(
        'Simulated update cannot do a real relaunch: ELECTRON_RENDERER_URL is not set for this dev runner.'
      )
    }
    requestDevRelaunch(url)
  }
  await captureSessionForRestart()
  if (app.isPackaged) app.relaunch()
  app.quit()
}
