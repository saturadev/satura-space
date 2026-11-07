import { ipcMain } from 'electron'
import type { UsageProvider, UsageSnapshot } from '@shared/api'
import { requestUsage } from '../usage/usage-hub'

export function registerUsageHandlers(): void {
  ipcMain.handle(
    'usage:snapshot',
    (_event, args?: { force?: boolean; provider?: UsageProvider }): UsageSnapshot => requestUsage(!!args?.force, args?.provider)
  )
}
