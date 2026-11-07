import { app, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { censusTrack } from '@shared/census'

const RENDERER_URL_SWITCH = 'satura-renderer-url'
const READY_FILE_SWITCH = 'satura-dev-relaunch-ready'
const READY_FILE_NAME = 'dev-relaunch-ready'
const RELAUNCH_WAIT_MS = 30_000
const WARM_FALLBACK_MS = 15_000

let pendingUrl: string | null = null
let spawned = false

export function applyDevRelaunchRendererUrl(): void {
  const url = app.commandLine.getSwitchValue(RENDERER_URL_SWITCH)
  if (url && !process.env.ELECTRON_RENDERER_URL) process.env.ELECTRON_RENDERER_URL = url
}

export function requestDevRelaunch(url: string): void {
  pendingUrl = url
}

export function wasDevRelaunchSpawned(): boolean {
  return spawned
}

const registeredWindows = new Set<number>()
censusTrack('dev-relaunch.registeredWindows', registeredWindows)
const warmedWindows = new Set<number>()
censusTrack('dev-relaunch.warmedWindows', warmedWindows)
let readyWritten = false
let warmFallbackTimer: ReturnType<typeof setTimeout> | null = null

function readyFilePath(): string {
  return app.commandLine.getSwitchValue(READY_FILE_SWITCH)
}

function writeReadyFile(): void {
  const readyFile = readyFilePath()
  if (!readyFile || readyWritten) return
  readyWritten = true
  if (warmFallbackTimer) {
    clearTimeout(warmFallbackTimer)
    warmFallbackTimer = null
  }
  try {
    writeFileSync(readyFile, '1')
  } catch {
  }
}

export function registerDevRelaunchWindow(webContentsId: number): void {
  if (!readyFilePath()) return
  registeredWindows.add(webContentsId)
}

export function notifyDevRelaunchWindowLoaded(): void {
  if (!readyFilePath() || readyWritten) return
  if (!warmFallbackTimer) {
    warmFallbackTimer = setTimeout(() => {
      console.error(
        `[dev-relaunch] renderer never reported lazy chunks warm within ${WARM_FALLBACK_MS / 1000}s — releasing old instance anyway`
      )
      writeReadyFile()
    }, WARM_FALLBACK_MS)
  }
}

export function notifyDevRelaunchRendererWarm(webContentsId: number): void {
  if (!readyFilePath() || readyWritten) return
  warmedWindows.add(webContentsId)
  for (const id of registeredWindows) {
    if (!warmedWindows.has(id)) return
  }
  console.log('[dev-relaunch] renderer warm — releasing old instance')
  writeReadyFile()
}

let failureReported = false

export function reportDevRelaunchLoadFailure(code: number, description: string): void {
  const readyFile = readyFilePath()
  if (!readyFile || failureReported) return
  failureReported = true
  console.error(`[dev-relaunch] renderer failed to load (${code} ${description})`)
  writeReadyFile()
  dialog.showErrorBox(
    'Update relaunch failed',
    `The relaunched dev instance could not load the renderer (${description || code}). ` +
      'The electron-vite dev server exits with the old instance — restart pnpm dev. ' +
      'Unity editors and terminals are still running.'
  )
}

export async function performPendingDevRelaunch(): Promise<void> {
  if (!pendingUrl) return
  const url = pendingUrl
  pendingUrl = null
  const readyFile = join(app.getPath('userData'), READY_FILE_NAME)
  try {
    rmSync(readyFile, { force: true })
  } catch {
  }
  app.releaseSingleInstanceLock()
  const args = process.argv
    .slice(1)
    .filter(
      (a) => !a.startsWith(`--${RENDERER_URL_SWITCH}=`) && !a.startsWith(`--${READY_FILE_SWITCH}=`)
    )
  args.push(`--${RENDERER_URL_SWITCH}=${url}`, `--${READY_FILE_SWITCH}=${readyFile}`)
  const childLog = join(app.getPath('userData'), 'dev-relaunch-child.log')
  let stdio: ('ignore' | number)[] = ['ignore', 'ignore', 'ignore']
  try {
    const fd = openSync(childLog, 'w')
    stdio = ['ignore', fd, fd]
  } catch {
  }
  console.log(`[dev-relaunch] spawning update-relaunch instance (child log: ${childLog})`)
  const child = spawn(process.execPath, args, { detached: true, stdio })
  child.on('error', (e) => console.error(`[dev-relaunch] spawn failed: ${e.message}`))
  child.unref()
  spawned = true
  const deadline = Date.now() + RELAUNCH_WAIT_MS
  while (Date.now() < deadline && !existsSync(readyFile)) {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (existsSync(readyFile)) {
    try {
      rmSync(readyFile, { force: true })
    } catch {
    }
    console.log('[dev-relaunch] new instance is up — exiting old instance')
  } else {
    console.error(
      `[dev-relaunch] new instance did not load within ${RELAUNCH_WAIT_MS / 1000}s — check the new window for errors`
    )
  }
}
