import { ipcMain } from 'electron'
import type { CodexUsageRemaining } from '@shared/api'
import { fetchCodexUsageRemaining } from '../codex-usage/fetch-remaining'
import { createUsageCache, type UsageCache } from '../usage/usage-cache'
import { readUsageSnapshot, writeUsageSnapshot } from '../usage/usage-store'
import { hiddenUsage, isUsageHidden } from '../usage/usage-visibility'
import { readUsage, registerUsageReader } from '../usage/usage-hub'

let cache: UsageCache | null = null

function codexUsageCache(): UsageCache {
  cache ??= createUsageCache(fetchCodexUsageRemaining, {
    seed: readUsageSnapshot('codex'),
    onSuccess: (usage) => writeUsageSnapshot('codex', usage)
  })
  return cache
}

export function registerCodexUsageHandlers(): void {
  registerUsageReader('codex', (force) =>
    isUsageHidden('codex') ? Promise.resolve(hiddenUsage('codex')) : codexUsageCache().get(force)
  )
  ipcMain.handle(
    'codexUsage:getRemaining',
    (_event, args?: { force?: boolean }): Promise<CodexUsageRemaining> => readUsage('codex', args?.force)
  )
}
