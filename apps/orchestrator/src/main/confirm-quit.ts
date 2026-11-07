import { BrowserWindow, ipcMain } from 'electron'
import type { QuitConfirmRequest } from '@shared/api'
import { inBackground } from './window/background'

const CONFIRM_FAILSAFE_MS = 120_000

const pending = new WeakSet<BrowserWindow>()
let tokenSeq = 0

export interface QuitConfirmResult {
  confirmed: boolean
  closeTerminals: boolean
  scope: 'app' | 'window'
}

export function askWindowToConfirm(
  win: BrowserWindow,
  req: Omit<QuitConfirmRequest, 'token'>
): Promise<QuitConfirmResult> {
  if (win.isDestroyed() || win.webContents.isDestroyed())
    return Promise.resolve({ confirmed: true, closeTerminals: false, scope: 'app' })
  if (pending.has(win))
    return Promise.resolve({ confirmed: false, closeTerminals: false, scope: 'app' })
  pending.add(win)
  const token = ++tokenSeq

  return new Promise<QuitConfirmResult>((resolve) => {
    let settled = false
    const finish = (result: QuitConfirmResult, dismissRenderer: boolean): void => {
      if (settled) return
      settled = true
      pending.delete(win)
      clearTimeout(timer)
      ipcMain.removeListener('app:quit-response', onResponse)
      if (!win.isDestroyed()) {
        win.removeListener('closed', onClosed)
        if (!win.webContents.isDestroyed()) {
          win.webContents.removeListener('render-process-gone', onGone)
          if (dismissRenderer) win.webContents.send('app:quit-dismissed')
        }
      }
      resolve(result)
    }
    const onResponse = (
      e: Electron.IpcMainEvent,
      payload: {
        token?: number
        confirmed?: boolean
        closeTerminals?: boolean
        scope?: 'app' | 'window'
      }
    ): void => {
      if (win.isDestroyed() || e.sender.id !== win.webContents.id) return
      if (payload?.token !== token) return
      finish(
        {
          confirmed: payload.confirmed === true,
          closeTerminals: payload.closeTerminals === true,
          scope: payload.scope === 'window' ? 'window' : 'app'
        },
        false
      )
    }
    const onClosed = (): void =>
      finish({ confirmed: false, closeTerminals: false, scope: 'app' }, false)
    const onGone = (): void => finish({ confirmed: true, closeTerminals: false, scope: 'app' }, false)
    const timer = setTimeout(
      () => finish({ confirmed: false, closeTerminals: false, scope: 'app' }, true),
      CONFIRM_FAILSAFE_MS
    )

    ipcMain.on('app:quit-response', onResponse)
    win.once('closed', onClosed)
    win.webContents.once('render-process-gone', onGone)
    if (!inBackground) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    const message: QuitConfirmRequest = { ...req, token }
    win.webContents.send('app:quit-requested', message)
  })
}
