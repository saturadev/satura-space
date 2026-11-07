import { ipcMain } from 'electron'
import { loadState, saveState } from '../persistence'

const MAX_RECENTS = 10

export function registerRecentsHandlers(): void {
  ipcMain.handle('recents:list', (): string[] => loadState().recentFolders ?? [])

  ipcMain.on('recents:add', (_event, path: string) => {
    const folder = typeof path === 'string' ? path.trim() : ''
    if (!folder) return
    const state = loadState()
    const next = [folder, ...(state.recentFolders ?? []).filter((p) => p !== folder)].slice(
      0,
      MAX_RECENTS
    )
    saveState({ ...state, recentFolders: next })
  })

  ipcMain.on('recents:remove', (_event, path: string) => {
    const folder = typeof path === 'string' ? path.trim() : ''
    if (!folder) return
    const state = loadState()
    saveState({ ...state, recentFolders: (state.recentFolders ?? []).filter((p) => p !== folder) })
  })
}
