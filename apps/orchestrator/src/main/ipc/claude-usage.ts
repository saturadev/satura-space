import { ipcMain } from 'electron'
import type { ClaudeUsageRemaining } from '@shared/api'
import { fetchClaudeUsageRemaining } from '../claude-usage/fetch-remaining'
import { isDefaultClaudeAccount, parseStatusLineUsage } from '../claude-usage/statusline-usage'
import { createUsageCache, type UsageCache } from '../usage/usage-cache'
import { createUsageFeed, type UsageFeed } from '../usage/usage-feed'
import { mergeUsage } from '../usage/usage-merge'
import { readUsageSnapshot, writeUsageSnapshot } from '../usage/usage-store'
import { isUsageHidden } from '../usage/usage-visibility'
import { readUsage, registerUsageReader } from '../usage/usage-hub'

const EMPTY: ClaudeUsageRemaining = {
  provider: 'claude',
  session: null,
  weekly: null,
  updatedAt: 0,
  error: null,
  status: 'unavailable'
}

let feed: UsageFeed | null = null
let cache: UsageCache | null = null

function claudeUsageFeed(): UsageFeed {
  feed ??= createUsageFeed(EMPTY, { seed: readUsageSnapshot('claude') })
  return feed
}

function claudeUsageCache(): UsageCache {
  cache ??= createUsageCache(fetchClaudeUsageRemaining, {
    seed: readUsageSnapshot('claude'),
    onSuccess: (usage) => writeUsageSnapshot('claude', usage)
  })
  return cache
}

export function publishClaudeStatusLineUsage(payload: string, configDir: string): void {
  if (!isDefaultClaudeAccount(configDir)) return
  const live = parseStatusLineUsage(payload)
  if (!live) return
  claudeUsageFeed().publish(live)
  if (!isUsageHidden('claude')) void readUsage('claude').catch(() => {})
}

export function registerClaudeUsageHandlers(): void {
  registerUsageReader('claude', async (force) =>
    isUsageHidden('claude')
      ? EMPTY
      : mergeUsage(await claudeUsageCache().get(force), claudeUsageFeed().get())
  )
  ipcMain.handle(
    'claudeUsage:getRemaining',
    (_event, args?: { force?: boolean }): Promise<ClaudeUsageRemaining> => readUsage('claude', args?.force)
  )
}
