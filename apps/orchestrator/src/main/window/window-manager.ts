import { app, BrowserWindow, screen, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { WorkspaceIdentity } from '@shared/workspace-identity'
import { sameWorkspace } from '@shared/workspace-identity'
import type { WindowSession } from '@shared/api'
import { clampAppZoom, DEFAULT_APP_ZOOM } from '@shared/types'
import { killPtysForWebContents } from '../ipc/pty'
import { unityProvider } from '../unity/unity-instance-provider'
import { loadState } from '../persistence'
import { isQuitting, isRestoreQuit, markQuitConfirmed, setCloseTerminalsOnQuit } from '../quit-state'
import {
  notifyDevRelaunchWindowLoaded,
  registerDevRelaunchWindow,
  reportDevRelaunchLoadFailure
} from '../dev-relaunch'
import { askWindowToConfirm } from '../confirm-quit'
import { fileUrlToPath, openFileInApp } from './open-file-in-app'
import { appPageUrl } from './navigation-guard'
import { APP_PAGE_ARG } from '@shared/app-page'
import { acquireShutdownStatus } from './shutdown-window'
import {
  emptyWindowSession,
  hasLiveTerminals,
  registerSessionWindow,
  removeSessionWindow,
  updateSessionBounds,
  updateSessionMeta,
  windowHasDrafts,
  windowHasWorkspaces,
  windowWorkspaceIdentities
} from '../session-registry'
import { censusTrack } from '@shared/census'
import { captureActive } from '../capture-state'
import { holdUntilLaunched } from './splash-window'
import { inBackground } from './background'

export interface WindowSeed {
  folderPath: string
  worktreePath: string
  name: string
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface CreateWindowOpts {
  bounds?: WindowBounds
  maximized?: boolean
  identity?: WorkspaceIdentity | null
  label?: string
  role?: 'primary' | 'secondary'
  restore?: boolean
  initialSession?: WindowSession
}

const FALLBACK_WIDTH = 1440
const FALLBACK_HEIGHT = 900
export const MIN_WIDTH = 900
export const MIN_HEIGHT = 600
const SPAWN_WIDTH = 1280
const SPAWN_HEIGHT = 840
const SPAWN_CASCADE_STEP = 28
const SPAWN_CASCADE_WRAP = 6
const BOUNDS_SAVE_DEBOUNCE_MS = 500

function defaultSize(): { width: number; height: number } {
  try {
    const wa = screen.getPrimaryDisplay().workAreaSize
    return {
      width: Math.max(MIN_WIDTH, wa.width),
      height: Math.max(MIN_HEIGHT, wa.height)
    }
  } catch {
    return { width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT }
  }
}

function validateBounds(b?: WindowBounds): { width: number; height: number; x?: number; y?: number } {
  if (!b || b.width < MIN_WIDTH || b.height < MIN_HEIGHT) return defaultSize()
  const visible = screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    const overlapX = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x)
    const overlapY = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y)
    return overlapX >= MIN_WIDTH / 2 && overlapY >= MIN_HEIGHT / 2
  })
  return visible ? { width: b.width, height: b.height, x: b.x, y: b.y } : defaultSize()
}

interface ManagedWindow {
  id: string
  win: BrowserWindow
  index: number
  label: string
  identity: WorkspaceIdentity | null
  role: 'primary' | 'secondary'
}

const windows = new Map<string, ManagedWindow>()
censusTrack('window-manager.windows', windows)
const focusOrder: string[] = []
const closeConfirmed = new Set<string>()
censusTrack('window-manager.closeConfirmed', closeConfirmed)
let createdCount = 0

function bringToFront(id: string): void {
  const i = focusOrder.indexOf(id)
  if (i !== -1) focusOrder.splice(i, 1)
  focusOrder.unshift(id)
}

function liveWindows(): BrowserWindow[] {
  return [...windows.values()].filter((m) => !m.win.isDestroyed()).map((m) => m.win)
}

function spawnBounds(): WindowBounds | undefined {
  const open = liveWindows()
  if (open.length === 0) return undefined
  try {
    const anchor = BrowserWindow.getFocusedWindow() ?? open[open.length - 1]
    const wa = screen.getDisplayMatching(anchor.getBounds()).workArea
    const width = Math.min(Math.max(MIN_WIDTH, SPAWN_WIDTH), wa.width)
    const height = Math.min(Math.max(MIN_HEIGHT, SPAWN_HEIGHT), wa.height)
    const step = (open.length % SPAWN_CASCADE_WRAP) * SPAWN_CASCADE_STEP
    const x = Math.round(wa.x + (wa.width - width) / 2 + step)
    const y = Math.round(wa.y + (wa.height - height) / 2 + step)
    return {
      x: Math.max(wa.x, Math.min(x, wa.x + wa.width - width)),
      y: Math.max(wa.y, Math.min(y, wa.y + wa.height - height)),
      width,
      height
    }
  } catch {
    return undefined
  }
}

export interface WindowInfo {
  id: string
  label: string
  focused: boolean
  role: 'primary' | 'secondary'
}

export function windowIdForWebContents(webContentsId: number): string | null {
  for (const m of windows.values()) {
    if (!m.win.isDestroyed() && m.win.webContents.id === webContentsId) return m.id
  }
  return null
}

export function getManagedWindow(id: string): BrowserWindow | null {
  const m = windows.get(id)
  return m && !m.win.isDestroyed() ? m.win : null
}

export function windowMetaForWebContents(
  webContentsId: number
): { bounds: WindowBounds; identity: WorkspaceIdentity | null; label: string } | null {
  for (const m of windows.values()) {
    if (!m.win.isDestroyed() && m.win.webContents.id === webContentsId) {
      const b = m.win.getBounds()
      return {
        bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
        identity: m.identity,
        label: m.identity ? m.label : ''
      }
    }
  }
  return null
}

function boundsContain(win: BrowserWindow, x: number, y: number): boolean {
  const b = win.getBounds()
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height
}

function syncFocusedToFront(): void {
  const focused = BrowserWindow.getFocusedWindow()
  if (!focused || focused.isDestroyed()) return
  const id = windowIdForWebContents(focused.webContents.id)
  if (id) bringToFront(id)
}

export function topWindowAt(x: number, y: number): string | null {
  syncFocusedToFront()
  for (const id of focusOrder) {
    const m = windows.get(id)
    if (m && !m.win.isDestroyed() && boundsContain(m.win, x, y)) return id
  }
  return null
}

export function windowContentOrigin(id: string): { x: number; y: number } | null {
  const win = getManagedWindow(id)
  if (!win) return null
  const b = win.getContentBounds()
  return { x: b.x, y: b.y }
}

export function listWindows(): WindowInfo[] {
  return [...windows.values()]
    .filter((m) => !m.win.isDestroyed())
    .map((m) => ({ id: m.id, label: m.label, focused: m.win.isFocused(), role: m.role }))
}

export function isPrimaryWindow(id: string): boolean {
  const m = windows.get(id)
  return !!m && !m.win.isDestroyed() && m.role === 'primary'
}

function primaryWindowCount(): number {
  let n = 0
  for (const m of windows.values()) if (!m.win.isDestroyed() && m.role === 'primary') n += 1
  return n
}

export function setWindowLabel(id: string, label: string): void {
  const m = windows.get(id)
  if (!m || m.win.isDestroyed()) return
  m.label = label || `Window ${m.index}`
  m.win.setTitle(label ? `Satura Space — ${label}` : 'Satura Space')
}

export function setWindowIdentity(
  id: string,
  identity: { label: string; folderPath: string; worktreePath: string }
): void {
  const m = windows.get(id)
  if (!m || m.win.isDestroyed()) return
  setWindowLabel(id, identity.label)
  m.identity =
    identity.folderPath || identity.worktreePath
      ? { folderPath: identity.folderPath, worktreePath: identity.worktreePath }
      : null
  updateSessionMeta(id, m.identity, m.label)
}

export function getWindowIdentity(id: string): WorkspaceIdentity | null {
  return windows.get(id)?.identity ?? null
}

export function closeSecondaryWindowsForWorkspace(
  identity: WorkspaceIdentity,
  exceptId?: string | null
): void {
  for (const m of [...windows.values()]) {
    if (m.win.isDestroyed() || m.id === exceptId || m.role !== 'secondary') continue
    if (m.identity && sameWorkspace(m.identity, identity)) closeOnceSaved(m.win, m.id)
  }
}

function closeOnceSaved(win: BrowserWindow, id: string): void {
  const close = (): void => {
    if (win.isDestroyed()) return
    closeConfirmed.add(id)
    win.close()
  }
  if (!windowHasDrafts(id)) return close()
  void askWindowToConfirm(win, {
    variant: 'close-unsaved',
    title: '',
    message: '',
    confirmLabel: ''
  }).then((result) => {
    if (result.confirmed) close()
  })
}

export function closeAllWorkspacesEverywhere(): void {
  syncFocusedToFront()
  let keep: ManagedWindow | null = null
  for (const id of focusOrder) {
    const m = windows.get(id)
    if (m && !m.win.isDestroyed() && m.role === 'primary') {
      keep = m
      break
    }
  }
  for (const m of [...windows.values()]) {
    if (m.win.isDestroyed() || m === keep) continue
    closeConfirmed.add(m.id)
    m.win.close()
  }
  if (!keep) return
  try {
    keep.win.webContents.send('app:close-all-workspaces')
  } catch {
  }
}

export function raiseWindow(win: BrowserWindow): void {
  if (captureActive()?.hidden || inBackground) return
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  const appWasActive = BrowserWindow.getFocusedWindow() !== null
  if (!win.isVisible()) win.show()
  if (process.platform === 'darwin') {
    app.focus({ steal: true })
    win.moveTop()
    win.focus()
    return
  }
  if (process.platform === 'win32' && !appWasActive) {
    win.setAlwaysOnTop(true)
    win.show()
    win.focus()
    win.setAlwaysOnTop(false)
    return
  }
  win.moveTop()
  win.focus()
}

export function focusWindow(id: string): void {
  const win = getManagedWindow(id)
  if (win) raiseWindow(win)
}

export function frontmostWindow(): BrowserWindow | null {
  syncFocusedToFront()
  for (const id of focusOrder) {
    const win = getManagedWindow(id)
    if (win) return win
  }
  return liveWindows()[0] ?? null
}

export function createAppWindow(seed?: WindowSeed, opts?: CreateWindowOpts): string {
  const dev = !app.isPackaged
  const id = randomUUID()
  const index = ++createdCount
  const vb = validateBounds(opts?.bounds ?? spawnBounds())

  const win = new BrowserWindow({
    width: vb.width,
    height: vb.height,
    ...(vb.x != null && vb.y != null ? { x: vb.x, y: vb.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'Satura Space',
    backgroundColor: '#0c0d0f',
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 12 },
          acceptFirstMouse: true
        }
      : process.platform === 'win32'
        ? { titleBarStyle: 'hidden' as const }
        : { frame: false }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      additionalArguments: [`${APP_PAGE_ARG}${appPageUrl()}`]
    }
  })

  const named = seed?.name || opts?.label || ''
  const role = opts?.role ?? 'secondary'
  const identity = seed
    ? { folderPath: seed.folderPath, worktreePath: seed.worktreePath }
    : (opts?.identity ?? null)
  windows.set(id, {
    id,
    win,
    index,
    label: named || `Window ${index}`,
    identity,
    role
  })
  if (named) win.setTitle(`Satura Space — ${named}`)
  bringToFront(id)

  const b = win.getBounds()
  registerSessionWindow(id, {
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
    maximized: opts?.maximized ?? false,
    identity,
    label: identity ? named || `Window ${index}` : '',
    role,
    session: opts?.initialSession ?? emptyWindowSession()
  })

  const wcId = win.webContents.id

  let boundsTimer: ReturnType<typeof setTimeout> | null = null
  const persistBounds = (): void => {
    if (win.isDestroyed() || isQuitting() || captureActive()) return
    const maximized = win.isMaximized()
    if (maximized || win.isFullScreen() || win.isMinimized()) {
      updateSessionBounds(id, null, maximized)
      return
    }
    const cur = win.getBounds()
    if (cur.width <= MIN_WIDTH && cur.height <= MIN_HEIGHT) return
    updateSessionBounds(id, { x: cur.x, y: cur.y, width: cur.width, height: cur.height }, false)
  }
  const scheduleBoundsSave = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(persistBounds, BOUNDS_SAVE_DEBOUNCE_MS)
  }

  win.on('ready-to-show', () => {
    const zoom = clampAppZoom(loadState().settings.appZoomFactor ?? DEFAULT_APP_ZOOM)
    win.webContents.setZoomFactor(zoom)
    if (opts?.maximized) win.maximize()
    if (inBackground) return
    if (!app.isPackaged && process.env.SATURA_DEV_CAPTURE === '1') {
      win.setOpacity(0)
      win.setIgnoreMouseEvents(true)
      win.showInactive()
      return
    }
    if (holdUntilLaunched(() => {
      if (!win.isDestroyed()) win.show()
    })) return
    win.show()
  })
  win.on('focus', () => bringToFront(id))
  win.on('resize', scheduleBoundsSave)
  win.on('move', scheduleBoundsSave)
  win.on('maximize', () => {
    if (win.isDestroyed()) return
    win.webContents.send('window:maximize-changed', true)
    persistBounds()
  })
  win.on('unmaximize', () => {
    if (win.isDestroyed()) return
    win.webContents.send('window:maximize-changed', false)
    persistBounds()
  })
  win.on('close', (event) => {
    if (isQuitting() || isRestoreQuit() || closeConfirmed.has(id)) return
    if (role === 'primary') {
      if (primaryWindowCount() <= 1) {
        event.preventDefault()
        app.quit()
        return
      }
      if (!windowHasWorkspaces(id)) {
        if (!windowHasDrafts(id)) return
        event.preventDefault()
        closeOnceSaved(win, id)
        return
      }
      event.preventDefault()
      void askWindowToConfirm(win, {
        variant: 'close-primary',
        title: 'Close this window?',
        message:
          'This closes this window and all its workspaces, terminals, and Unity instances. Other windows stay open — or quit Satura Space entirely.',
        confirmLabel: 'Close Window',
        showCloseTerminals: hasLiveTerminals()
      }).then((result) => {
        if (!result.confirmed || win.isDestroyed()) return
        if (result.scope === 'window' && primaryWindowCount() > 1) {
          for (const identity of windowWorkspaceIdentities(id)) {
            closeSecondaryWindowsForWorkspace(identity, id)
          }
          closeConfirmed.add(id)
          win.close()
          return
        }
        setCloseTerminalsOnQuit(result.scope === 'window' ? true : result.closeTerminals)
        markQuitConfirmed()
        app.quit()
      })
      return
    }
    if (!windowHasWorkspaces(id)) {
      if (!windowHasDrafts(id)) return
      event.preventDefault()
      closeOnceSaved(win, id)
      return
    }
    event.preventDefault()
    void askWindowToConfirm(win, {
      variant: 'close-window',
      title: 'Close this window?',
      message:
        'Its terminals and panels will close, ending any work in progress. Other windows stay open.',
      confirmLabel: 'Close Window',
      showCloseTerminals: false
    }).then((result) => {
      if (!result.confirmed || win.isDestroyed()) return
      closeConfirmed.add(id)
      win.close()
    })
  })

  win.on('closed', () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    closeConfirmed.delete(id)
    windows.delete(id)
    const i = focusOrder.indexOf(id)
    if (i !== -1) focusOrder.splice(i, 1)
    if (!isQuitting() && hasWindows()) {
      removeSessionWindow(id)
      killPtysForWebContents(wcId)
      const releaseStatus = acquireShutdownStatus(
        'Closing window…',
        'Stopping its Unity instances and agents'
      )
      void unityProvider.stopForWebContents(wcId).finally(releaseStatus)
    }
  })

  if (dev) {
    const levels = ['verbose', 'info', 'warning', 'error'] as const
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const tag = levels[level] ?? 'info'
      const where = sourceId ? ` (${sourceId}:${line})` : ''
      console.log(`[w${index}:${tag}] ${message}${where}`)
    })
    if (process.platform !== 'darwin') {
      win.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.code === 'F12') {
          event.preventDefault()
          if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools()
          else win.webContents.openDevTools({ mode: 'undocked' })
        }
      })
    }
  }

  win.webContents.setWindowOpenHandler(({ url, referrer }) => {
    const file = /^satura-report:/i.test(referrer?.url ?? '') ? null : fileUrlToPath(url)
    if (file) openFileInApp({ file }, win.webContents.id)
    else if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const query: Record<string, string> = { wid: id }
  if (role === 'primary') query.primary = '1'
  if (!app.isPackaged) query.devBuild = '1'
  if (seed) {
    query.seedFolder = seed.folderPath
    query.seedWorktree = seed.worktreePath
    query.seedName = seed.name
  }
  if (opts?.restore) query.restore = '1'
  registerDevRelaunchWindow(win.webContents.id)
  win.webContents.once('did-finish-load', () => notifyDevRelaunchWindowLoaded())
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    reportDevRelaunchLoadFailure(errorCode, errorDescription)
  })
  if (dev && process.env.ELECTRON_RENDERER_URL) {
    const qs = new URLSearchParams(query).toString()
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${qs}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }

  return id
}

export function hasWindows(): boolean {
  return [...windows.values()].some((m) => !m.win.isDestroyed())
}

export function applyZoomToAllWindows(factor: number): void {
  const zoom = clampAppZoom(factor)
  for (const { win } of windows.values()) {
    if (!win.isDestroyed()) win.webContents.setZoomFactor(zoom)
  }
}

export function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
  for (const { win } of windows.values()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, ...args)
    } catch {
    }
  }
}

export function invalidateAllWindows(): void {
  for (const { win } of windows.values()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.invalidate()
    } catch {
    }
  }
}
