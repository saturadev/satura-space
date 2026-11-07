import { ipcMain } from 'electron'
import type {
  MovedPanel,
  MovedWorkspace,
  MoveWorkspaceResult,
  WindowInfo,
  DropTarget
} from '@shared/api'
import { sameWorkspace } from '@shared/workspace-identity'
import {
  closeSecondaryWindowsForWorkspace,
  createAppWindow,
  focusWindow,
  getManagedWindow,
  getWindowIdentity,
  isPrimaryWindow,
  listWindows,
  setWindowIdentity,
  windowIdForWebContents,
  type WindowSeed
} from '../window/window-manager'
import {
  abortDrag,
  beginDrag,
  completeDropFromRelease,
  currentDropTarget,
  endDrag
} from '../window/drag-session'
import { exitRevealSplitLayout } from '../window/reveal-layout'
import { unityProvider } from '../unity/unity-instance-provider'
import { reassignPtyOwners } from './pty'
import {
  claimWorkspaceIdentity,
  findWorkspaceHolder,
  mergeMovedWorkspaceIntoSession,
  sessionHasWorkspaceIdentity
} from '../session-registry'

function transferWorkspaceSessions(
  moved: MovedWorkspace,
  fromWcId: number,
  toWcId: number
): void {
  const ptyIds = (moved?.tabs ?? [])
    .map((t) => t?.ptyId)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
  if (ptyIds.length === 0) return
  reassignPtyOwners(ptyIds, fromWcId, toWcId)
  unityProvider.reassignSubscribers(ptyIds, fromWcId, toWcId)
}

export function registerWindowHandlers(): void {
  ipcMain.handle('window:create', (): string => createAppWindow(undefined, { role: 'primary' }))

  ipcMain.handle('window:createForWorkspace', (_event, seed: WindowSeed): string =>
    createAppWindow(
      {
        folderPath: typeof seed?.folderPath === 'string' ? seed.folderPath : '',
        worktreePath: typeof seed?.worktreePath === 'string' ? seed.worktreePath : '',
        name: typeof seed?.name === 'string' ? seed.name : ''
      },
      { role: 'secondary' }
    )
  )

  ipcMain.handle('window:list', (event): WindowInfo[] => {
    const selfId = windowIdForWebContents(event.sender.id)
    return listWindows().filter((w) => w.id !== selfId)
  })

  ipcMain.handle(
    'window:claimWorkspace',
    (event, identity: { folderPath: string; worktreePath: string }): { ok: boolean } => {
      const folderPath = typeof identity?.folderPath === 'string' ? identity.folderPath : ''
      const worktreePath = typeof identity?.worktreePath === 'string' ? identity.worktreePath : ''
      if (!folderPath && !worktreePath) return { ok: true }
      const selfId = windowIdForWebContents(event.sender.id)
      const holder = findWorkspaceHolder({ folderPath, worktreePath }, selfId, isPrimaryWindow)
      if (holder) {
        focusWindow(holder)
        return { ok: false }
      }
      if (selfId) claimWorkspaceIdentity({ folderPath, worktreePath }, selfId)
      return { ok: true }
    }
  )

  ipcMain.on(
    'window:setWorkspaceIdentity',
    (event, identity: { label: string; folderPath: string; worktreePath: string }) => {
      const id = windowIdForWebContents(event.sender.id)
      if (!id) return
      const folderPath = typeof identity?.folderPath === 'string' ? identity.folderPath : ''
      const worktreePath = typeof identity?.worktreePath === 'string' ? identity.worktreePath : ''
      setWindowIdentity(id, {
        label: typeof identity?.label === 'string' ? identity.label : '',
        folderPath,
        worktreePath
      })
      for (const root of new Set([folderPath, worktreePath])) {
        void unityProvider.ensureProjectEnv(root).catch(() => {})
      }
    }
  )

  ipcMain.on('window:focus', (_event, id: string) => {
    if (typeof id === 'string') focusWindow(id)
  })

  const senderWindow = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
    const id = windowIdForWebContents(event.sender.id)
    return id ? getManagedWindow(id) : null
  }

  ipcMain.on('window:minimize', (event) => {
    const win = senderWindow(event)
    if (win && !win.isDestroyed()) win.minimize()
  })

  ipcMain.on('window:maximize', (event) => {
    const win = senderWindow(event)
    if (!win || win.isDestroyed()) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.on('window:close', (event) => {
    const win = senderWindow(event)
    if (win && !win.isDestroyed()) win.close()
  })

  ipcMain.handle('window:isMaximized', (event): boolean => {
    const win = senderWindow(event)
    return !!win && !win.isDestroyed() && win.isMaximized()
  })

  ipcMain.handle('window:exitRevealLayout', (event) => {
    exitRevealSplitLayout(event.sender.id)
  })

  ipcMain.on(
    'window:dragBegin',
    (event, args: { label: string; origin: { folderPath: string; worktreePath: string } | null }) =>
      beginDrag(
        event.sender.id,
        typeof args?.label === 'string' ? args.label : '',
        args?.origin
          ? { folderPath: args.origin.folderPath, worktreePath: args.origin.worktreePath }
          : null
      )
  )
  ipcMain.handle('window:dragEnd', (): DropTarget => {
    const target = currentDropTarget()
    endDrag()
    return target
  })
  ipcMain.on('window:dragAbort', () => abortDrag())
  ipcMain.on('window:dropReleased', () => completeDropFromRelease())

  ipcMain.handle(
    'window:movePanel',
    (
      _event,
      args: { target: string | 'new'; panel: MovedPanel; point?: { x: number; y: number } }
    ): { ok: boolean; reason?: string } => {
      const panel = args?.panel
      if (!panel) return { ok: false, reason: 'no-panel' }

      if (args.target === 'new') {
        const id = createAppWindow(undefined, {
          role: 'secondary',
          identity: {
            folderPath: panel.originFolderPath,
            worktreePath: panel.originWorktreePath
          },
          label: panel.tabs[0]?.worktreeName ?? ''
        })
        const win = getManagedWindow(id)
        if (!win) return { ok: false, reason: 'no-window' }
        win.webContents.once('did-finish-load', () => {
          win.webContents.send('window:panelDropped', { panel })
        })
        return { ok: true }
      }

      const win = getManagedWindow(args.target)
      if (!win) return { ok: false, reason: 'no-window' }

      const targetIdentity = getWindowIdentity(args.target)
      const origin = { folderPath: panel.originFolderPath, worktreePath: panel.originWorktreePath }
      if (targetIdentity && !sameWorkspace(origin, targetIdentity)) {
        return { ok: false, reason: 'different-workspace' }
      }

      win.webContents.send('window:panelDropped', { panel, point: args.point })
      return { ok: true }
    }
  )

  ipcMain.handle('window:moveWorkspace', (event, workspace: MovedWorkspace): string => {
    const id = createAppWindow(undefined, { role: 'primary' })
    const win = getManagedWindow(id)
    if (!win) return id
    const ws = workspace?.workspace
    if (ws) {
      setWindowIdentity(id, {
        label: typeof ws.name === 'string' ? ws.name : '',
        folderPath: typeof ws.folderPath === 'string' ? ws.folderPath : '',
        worktreePath:
          typeof ws.worktreePath === 'string'
            ? ws.worktreePath
            : typeof ws.folderPath === 'string'
              ? ws.folderPath
              : ''
      })
    }
    transferWorkspaceSessions(workspace, event.sender.id, win.webContents.id)
    mergeMovedWorkspaceIntoSession(id, workspace)
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send('window:workspaceDropped', workspace)
    })
    return id
  })

  ipcMain.handle(
    'window:moveWorkspaceToWindow',
    (event, args: { targetId: string; workspace: MovedWorkspace }): MoveWorkspaceResult => {
      const targetId = typeof args?.targetId === 'string' ? args.targetId : ''
      if (!targetId || !args?.workspace || !isPrimaryWindow(targetId))
        return { ok: false, reason: 'no-window' }
      if (windowIdForWebContents(event.sender.id) === targetId)
        return { ok: false, reason: 'no-window' }
      const win = getManagedWindow(targetId)
      if (!win || win.isDestroyed()) return { ok: false, reason: 'no-window' }
      const ws = args.workspace.workspace
      const identity = ws
        ? {
            folderPath: typeof ws.folderPath === 'string' ? ws.folderPath : '',
            worktreePath:
              typeof ws.worktreePath === 'string'
                ? ws.worktreePath
                : typeof ws.folderPath === 'string'
                  ? ws.folderPath
                  : ''
          }
        : null
      if (identity && (identity.folderPath || identity.worktreePath)) {
        if (sessionHasWorkspaceIdentity(targetId, identity))
          return { ok: false, reason: 'duplicate' }
      }
      transferWorkspaceSessions(args.workspace, event.sender.id, win.webContents.id)
      mergeMovedWorkspaceIntoSession(targetId, args.workspace)
      win.webContents.send('window:workspaceDropped', args.workspace)
      focusWindow(targetId)
      return { ok: true }
    }
  )

  ipcMain.on(
    'window:closeWorkspaceWindows',
    (event, identity: { folderPath: string; worktreePath: string }) => {
      const folderPath = typeof identity?.folderPath === 'string' ? identity.folderPath : ''
      const worktreePath = typeof identity?.worktreePath === 'string' ? identity.worktreePath : ''
      if (!folderPath && !worktreePath) return
      const selfId = windowIdForWebContents(event.sender.id)
      closeSecondaryWindowsForWorkspace({ folderPath, worktreePath }, selfId)
    }
  )
}
