import type { UsageRemaining } from '@shared/api'
import { unexpired } from './usage-cache'

export interface UsageFeed {
  publish: (live: UsageRemaining) => void
  get: () => UsageRemaining
}

export interface UsageFeedOptions {
  seed?: UsageRemaining | null
  onPublish?: (usage: UsageRemaining) => void
}

export function createUsageFeed(empty: UsageRemaining, options: UsageFeedOptions = {}): UsageFeed {
  let last = options.seed ?? null

  return {
    publish: (live) => {
      last = live
      options.onPublish?.(live)
    },

    get: () => {
      if (!last) return empty
      const now = Date.now()
      const session = unexpired(last.session, now)
      const weekly = unexpired(last.weekly, now)
      const weeklyScoped = (last.weeklyScoped ?? []).filter((w) => unexpired(w, now) !== null)
      if (!session && !weekly && weeklyScoped.length === 0) return empty
      return { ...last, session, weekly, weeklyScoped }
    }
  }
}
