import { BrowserWindow, screen, webContents } from 'electron'
import { MIN_HEIGHT, MIN_WIDTH } from './window-manager'
import { censusTrack } from '@shared/census'

export interface RevealBounds {
  x: number
  y: number
  w: number
  h: number
}

interface SavedWindowState {
  bounds: Electron.Rectangle
  maximized: boolean
  fullscreen: boolean
  onClosed: () => void
  onLeaveFullScreen: (() => void) | null
}

const saved = new Map<number, SavedWindowState>()
censusTrack('reveal-layout.saved', saved)

function windowForWebContents(wcId: number): BrowserWindow | null {
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) return null
  const win = BrowserWindow.fromWebContents(wc)
  return win && !win.isDestroyed() ? win : null
}

function revealArea(win: BrowserWindow): Electron.Rectangle {
  const prev = saved.get(win.id)
  const bounds = prev ? prev.bounds : win.getBounds()
  const fullscreen = prev ? prev.fullscreen : win.isFullScreen()
  const maximized = prev ? prev.maximized : win.isMaximized()
  if (fullscreen || (process.platform === 'win32' && maximized))
    return screen.getDisplayMatching(bounds).workArea
  return bounds
}

function splitArea(win: BrowserWindow): { area: Electron.Rectangle; editorWidth: number } {
  const area = revealArea(win)
  const appWidth = Math.max(Math.round(area.width / 2), MIN_WIDTH)
  return { area, editorWidth: Math.max(area.width - appWidth, 0) }
}

export function unityRevealBounds(wcId: number): RevealBounds | null {
  const win = windowForWebContents(wcId)
  if (!win) return null
  const { area, editorWidth } = splitArea(win)
  const dip = { x: area.x, y: area.y, width: editorWidth, height: area.height }
  const rect = process.platform === 'win32' ? screen.dipToScreenRect(win, dip) : dip
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
}

export function enterRevealSplitLayout(wcId: number): void {
  const win = windowForWebContents(wcId)
  if (!win) return
  const { area, editorWidth } = splitArea(win)
  let state = saved.get(win.id)
  if (!state) {
    const winId = win.id
    state = {
      bounds: win.getBounds(),
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
      onClosed: () => saved.delete(winId),
      onLeaveFullScreen: null
    }
    saved.set(winId, state)
    win.once('closed', state.onClosed)
  }
  if (process.platform === 'darwin') win.setWindowButtonVisibility(false)
  const apply = (): void => {
    if (win.isDestroyed() || !saved.has(win.id)) return
    win.setBounds({
      x: area.x + editorWidth,
      y: area.y,
      width: area.width - editorWidth,
      height: area.height
    })
  }
  if (win.isFullScreen()) {
    if (state.onLeaveFullScreen) win.removeListener('leave-full-screen', state.onLeaveFullScreen)
    state.onLeaveFullScreen = apply
    win.once('leave-full-screen', apply)
    win.setFullScreen(false)
    return
  }
  if (win.isMaximized() && process.platform !== 'darwin') win.unmaximize()
  apply()
}

export function exitRevealSplitLayout(wcId: number): void {
  const win = windowForWebContents(wcId)
  if (!win) return
  const prev = saved.get(win.id)
  if (!prev) return
  saved.delete(win.id)
  win.removeListener('closed', prev.onClosed)
  if (prev.onLeaveFullScreen) win.removeListener('leave-full-screen', prev.onLeaveFullScreen)
  win.setResizable(true)
  win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT)
  if (process.platform === 'darwin') win.setWindowButtonVisibility(true)
  if (prev.fullscreen) {
    win.setFullScreen(true)
    return
  }
  if (prev.maximized) {
    if (process.platform === 'darwin')
      win.setBounds(screen.getDisplayMatching(prev.bounds).workArea)
    else win.maximize()
    return
  }
  win.setBounds(prev.bounds)
}
