import { ipcMain } from 'electron'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { loadState, saveState } from '../persistence'
import { refreshAgentHooks } from '../agent-hooks'
import { usageSettingsChanged } from '../usage/usage-hub'

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', (): Settings => ({ ...DEFAULT_SETTINGS, ...loadState().settings }))

  ipcMain.handle('settings:set', (_event, settings: Settings): Settings => {
    saveState({ ...loadState(), settings })
    void refreshAgentHooks()
    usageSettingsChanged()
    return settings
  })
}
