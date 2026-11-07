import { BrowserWindow, webContents } from 'electron'
import type { TunerOpenRequest, TunerState } from '@shared/tuner'
import { ptyOwnerWebContentsId } from '../ipc/pty'
import { frontmostWindow, raiseWindow } from '../window/window-manager'
import { debugLog } from '@shared/debug-log'

function sendToOwnerWindow(channel: string, req: TunerOpenRequest, fallbackWcId?: number): boolean {
  const ownerId = req.paneKey ? ptyOwnerWebContentsId(req.paneKey) : undefined
  let win: BrowserWindow | null = null
  for (const id of [ownerId, fallbackWcId]) {
    if (typeof id !== 'number') continue
    const wc = webContents.fromId(id)
    const w = wc && !wc.isDestroyed() ? BrowserWindow.fromWebContents(wc) : null
    if (w && !w.isDestroyed()) {
      win = w
      break
    }
  }
  win ??= frontmostWindow()
  if (!win) return false
  try {
    raiseWindow(win)
  } catch {
  }
  win.webContents.send(channel, req)
  return true
}

export function openTunerInApp(req: TunerOpenRequest, fallbackWcId?: number): boolean {
  if (!sendToOwnerWindow('tuner:open', req, fallbackWcId)) return false
  debugLog(`[tuner] open view=${req.view} project=${req.projectPath}`)
  return true
}

export interface TunerMissingTarget {
  path: string
  scene?: string
  error: string
}

type TunerStateProbe = (projectPath: string, view: string, since: number) => TunerState | null

let stateProbe: TunerStateProbe | null = null

export function setTunerStateProbe(probe: TunerStateProbe): void {
  stateProbe = probe
}

export async function awaitTunerMissing(projectPath: string, view: string, since: number, timeoutMs: number): Promise<TunerMissingTarget[] | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const state = stateProbe?.(projectPath, view, since)
    if (state)
      return state.objects
        .filter((o) => typeof o.error === 'string' && o.error)
        .map((o) => ({ path: o.path, ...(o.scene ? { scene: o.scene } : {}), error: o.error as string }))
    await new Promise((r) => setTimeout(r, 150))
  }
  return null
}
