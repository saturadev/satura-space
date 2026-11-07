import { ipcMain } from 'electron'
import type { AuthUser } from '@shared/api'
import { authConfigured, signOut, startBrowserSignIn, fetchSession } from '../auth'

export function registerAuthHandlers(): void {
  ipcMain.handle('auth:configured', (): boolean => authConfigured())
  ipcMain.handle('auth:get-session', (): Promise<AuthUser | null> => fetchSession())
  ipcMain.handle('auth:start-sign-in', (_e, open?: boolean): Promise<{ url: string }> =>
    startBrowserSignIn(open !== false)
  )
  ipcMain.handle('auth:sign-out', (): Promise<void> => signOut())
}
