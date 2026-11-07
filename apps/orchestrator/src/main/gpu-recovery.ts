import { app, ipcMain } from 'electron'
import { clearSentTo, releaseAllSurfaces } from './unity/shared-surface'
import { broadcastToAllWindows, invalidateAllWindows } from './window/window-manager'
import { isQuitting } from './quit-state'

const RESET_DEBOUNCE_MS = 400
const RESET_MIN_INTERVAL_MS = 10_000
const LOSS_QUIET_MS = 1500

let resetTimer: ReturnType<typeof setTimeout> | null = null
let lastResetAt = 0
let lastLossAt = 0
let quietTimer: ReturnType<typeof setTimeout> | null = null

function scheduleGpuReset(source: string): void {
  console.log(`[gpu-recovery] GPU context lost (${source}) — recovering`)
  lastResetAt = Date.now()
  releaseAllSurfaces()
  if (resetTimer) return
  resetTimer = setTimeout(() => {
    resetTimer = null
    broadcastToAllWindows('gpu:reset')
    invalidateAllWindows()
  }, RESET_DEBOUNCE_MS)
}

export function registerGpuRecovery(): void {
  app.on('child-process-gone', (_event, details) => {
    if (details.type === 'GPU') {
      scheduleGpuReset(`child-process-gone reason=${details.reason}`)
    }
  })

  app.on('render-process-gone', (_event, contents, details) => {
    if (details.reason === 'clean-exit' || details.reason === 'killed') return
    console.log(`[gpu-recovery] renderer gone reason=${details.reason} — reloading`)
    releaseAllSurfaces()
    try {
      if (!contents.isDestroyed()) contents.reload()
    } catch {
    }
  })

  ipcMain.on('gpu:reportStuck', (event, payload: { id?: string } | null) => {
    if (isQuitting()) return
    const id = payload && typeof payload.id === 'string' ? payload.id : '?'
    const now = Date.now()
    const wait = lastResetAt + RESET_MIN_INTERVAL_MS - now
    if (wait <= 0) {
      scheduleGpuReset(`renderer-stuck id=${id} wc=${event.sender.id}`)
      return
    }
    const reportedAt = now
    setTimeout(() => {
      if (isQuitting()) return
      if (lastResetAt > reportedAt) return
      scheduleGpuReset(`renderer-stuck deferred id=${id}`)
    }, wait)
  })

  ipcMain.on('gpu:resetAck', (event) => {
    clearSentTo(event.sender.id)
  })

  ipcMain.on('gpu:reportContextLoss', (event) => {
    if (isQuitting()) return
    const now = Date.now()
    lastLossAt = now
    if (now - lastResetAt >= RESET_MIN_INTERVAL_MS) {
      scheduleGpuReset(`webgl-context-lost wc=${event.sender.id}`)
    }
    if (quietTimer) clearTimeout(quietTimer)
    quietTimer = setTimeout(() => {
      quietTimer = null
      if (isQuitting()) return
      if (lastResetAt >= lastLossAt) return
      scheduleGpuReset('webgl-context-lost settled')
    }, LOSS_QUIET_MS)
  })
}
