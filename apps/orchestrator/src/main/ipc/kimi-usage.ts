import { ipcMain } from 'electron'
import type { KimiUsageRemaining } from '@shared/api'
import { fetchKimiUsageRemaining } from '../kimi-usage/fetch-remaining'
import { createUsageCache, type UsageCache } from '../usage/usage-cache'
import { readUsageSnapshot, writeUsageSnapshot } from '../usage/usage-store'
import { hiddenUsage, isUsageHidden } from '../usage/usage-visibility'
import { readUsage, registerUsageReader } from '../usage/usage-hub'

let cache: UsageCache | null = null

function kimiUsageCache(): UsageCache {
  cache ??= createUsageCache(fetchKimiUsageRemaining, {
    seed: readUsageSnapshot('kimi'),
    onSuccess: (usage) => writeUsageSnapshot('kimi', usage)
  })
  return cache
}

export function registerKimiUsageHandlers(): void {
  registerUsageReader('kimi', (force) =>
    isUsageHidden('kimi') ? Promise.resolve(hiddenUsage('kimi')) : kimiUsageCache().get(force)
  )
  ipcMain.handle(
    'kimiUsage:getRemaining',
    (_event, args?: { force?: boolean }): Promise<KimiUsageRemaining> => readUsage('kimi', args?.force)
  )
}
