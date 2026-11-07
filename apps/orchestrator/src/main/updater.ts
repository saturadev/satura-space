import { app, ipcMain, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdaterStatus } from '@shared/api'
import { captureSessionForRestart, simulateUpdateRestart } from './session-restore'
import { clearRestoreQuit } from './quit-state'
import { worldStore } from './unity/world-store'

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

const CHECK_INTERVAL_MS = 30 * 60_000
const SIMULATED_DOWNLOAD_DELAY_MS = 500
const SIMULATED_DOWNLOAD_STEP_MS = 100

let downloadVersion = ''
let simulatedDownloadDelay: ReturnType<typeof setTimeout> | null = null
let simulatedDownloadProgress: ReturnType<typeof setInterval> | null = null

function broadcast(status: UpdaterStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updater:status', status)
  }
}

function friendlyUpdateError(raw: string): string {
  const line = (raw.split('\n')[0] || '').trim()
  if (!line) return 'Update check failed. It will be retried automatically.'
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

function checkForUpdates(): void {
  autoUpdater.checkForUpdates().catch(() => {})
}

function nextFakeVersion(): string {
  const [maj, min, patch] = app.getVersion().split('.').map((n) => parseInt(n, 10) || 0)
  return `${maj}.${min}.${patch + 1}`
}

function clearSimulatedDownload(): void {
  if (simulatedDownloadDelay) clearTimeout(simulatedDownloadDelay)
  if (simulatedDownloadProgress) clearInterval(simulatedDownloadProgress)
  simulatedDownloadDelay = null
  simulatedDownloadProgress = null
}

function simulateDownload(): void {
  clearSimulatedDownload()
  const version = nextFakeVersion()
  downloadVersion = version
  broadcast({ state: 'available', version })
  simulatedDownloadDelay = setTimeout(() => {
    simulatedDownloadDelay = null
    let percent = 0
    broadcast({ state: 'downloading', version, percent })
    simulatedDownloadProgress = setInterval(() => {
      percent = Math.min(100, percent + 2)
      broadcast({ state: 'downloading', version, percent })
      if (percent < 100) return
      clearSimulatedDownload()
      broadcast({ state: 'ready', version })
    }, SIMULATED_DOWNLOAD_STEP_MS)
  }, SIMULATED_DOWNLOAD_DELAY_MS)
}

function performInstall(): void {
  // Backstop guard: never restart while a Unity editor is in Play mode. The renderer
  // already disables the button, but a race must not restart mid-play. Agent-busy is
  // advisory (agents cold-restore on relaunch) and stays a renderer-only guard.
  if (worldStore.anyPlaying()) {
    broadcast({ state: 'error', message: 'Stop Unity Play mode before updating.' })
    return
  }
  if (app.isPackaged) {
    void captureSessionForRestart().then(() => {
      try {
        autoUpdater.quitAndInstall()
      } catch (err) {
        clearRestoreQuit()
        broadcast({ state: 'error', message: err instanceof Error ? err.message : String(err) })
        return
      }
      setTimeout(() => clearRestoreQuit(), 15_000)
    })
  } else {
    void simulateUpdateRestart().catch((err) => {
      broadcast({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    })
  }
}

// Registered in both dev and packaged builds so the update popover + guarded
// restart-with-state can be exercised in `pnpm dev` (electron-updater itself is
// packaged-only). `updater:simulate` fakes an available update for testing.
export function registerUpdaterIpc(): void {
  ipcMain.on('updater:install', () => performInstall())
  ipcMain.on('updater:check', () => {
    if (app.isPackaged) checkForUpdates()
    else broadcast({ state: 'not-available' })
  })
  ipcMain.on('updater:simulate', () => {
    simulateDownload()
  })
}

export function initUpdater(): void {
  if (!app.isPackaged) return

  autoUpdater.on('checking-for-update', () => {
    broadcast({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    downloadVersion = info.version
    broadcast({ state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    downloadVersion = ''
    broadcast({ state: 'not-available' })
  })

  autoUpdater.on('download-progress', (p) => {
    broadcast({
      state: 'downloading',
      version: downloadVersion,
      percent: Math.round(p.percent)
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    downloadVersion = info.version
    broadcast({ state: 'ready', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    downloadVersion = ''
    console.error(`[updater] ${err.message}`)
    broadcast({ state: 'error', message: friendlyUpdateError(err.message) })
  })

  setTimeout(checkForUpdates, 10_000)
  setInterval(checkForUpdates, CHECK_INTERVAL_MS)
}
