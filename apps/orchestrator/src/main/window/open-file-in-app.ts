import { BrowserWindow, webContents } from 'electron'
import { fileURLToPath } from 'node:url'
import type { OpenFileRequest } from '@shared/api'
import { frontmostWindow, raiseWindow } from './window-manager'
import { debugLog } from '@shared/debug-log'

export function fileUrlToPath(url: string): string | null {
  if (!/^file:\/\//i.test(url)) return null
  try {
    return fileURLToPath(url)
  } catch {
    return null
  }
}

function windowFor(webContentsId?: number): BrowserWindow | null {
  if (typeof webContentsId === 'number') {
    const wc = webContents.fromId(webContentsId)
    const win = wc && !wc.isDestroyed() ? BrowserWindow.fromWebContents(wc) : null
    if (win && !win.isDestroyed()) return win
  }
  return frontmostWindow()
}

export function openFileInApp(req: OpenFileRequest, webContentsId?: number): boolean {
  if (!req || typeof req.file !== 'string') return false
  if (!req.file && !req.projectPath) return false
  const win = windowFor(webContentsId)
  if (!win) return false
  try {
    raiseWindow(win)
  } catch {
  }
  win.webContents.send('app:openFile', req)
  debugLog(`[open-file] ${req.source ?? 'app'} ${req.file}`)
  return true
}
