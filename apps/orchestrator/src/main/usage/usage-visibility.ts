import type { UsageProvider, UsageRemaining } from '@shared/api'
import { loadState } from '../persistence'

export function isUsageHidden(provider: UsageProvider): boolean {
  return loadState().settings.hiddenUsageProviders?.includes(provider) ?? false
}

export function hiddenUsage(provider: UsageProvider): UsageRemaining {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'unavailable'
  }
}
