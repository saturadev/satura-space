import type { RateLimitWindow, UsageRemaining } from '@shared/api'

export type UsageFetchResult = UsageRemaining & { retryAfterMs?: number }

export interface UsageCache {
  get: (force?: boolean) => Promise<UsageRemaining>
}

export interface UsageCacheOptions {
  seed?: UsageRemaining | null
  onSuccess?: (result: UsageRemaining) => void
}

const TTL_MS = 15 * 60_000
const MIN_BACKOFF_MS = 5 * 60_000
const MAX_BACKOFF_MS = 60 * 60_000

function formatWait(ms: number): string {
  const mins = Math.ceil(ms / 60_000)
  return mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`
}

export function unexpired(
  w: RateLimitWindow | null | undefined,
  now: number
): RateLimitWindow | null {
  if (!w) return null
  return w.resetsAt !== null && w.resetsAt <= now ? null : w
}

function staleView(lastOk: UsageRemaining, note: string, now: number): UsageRemaining {
  const session = unexpired(lastOk.session, now)
  const weekly = unexpired(lastOk.weekly, now)
  const weeklyScoped = (lastOk.weeklyScoped ?? []).filter((w) => unexpired(w, now))
  return {
    ...lastOk,
    session,
    weekly,
    weeklyScoped,
    stale: true,
    error: note,
    status: session || weekly || weeklyScoped.length > 0 ? 'ok' : 'error'
  }
}

export function createUsageCache(
  fetchRemaining: () => Promise<UsageFetchResult>,
  options: UsageCacheOptions = {}
): UsageCache {
  let last: UsageRemaining | null = null
  let lastOk: UsageRemaining | null = options.seed ?? null
  let lastAt = 0
  let inFlight: Promise<void> | null = null
  let retryAt = 0
  let backoffMs = 0

  const apply = (result: UsageFetchResult): void => {
    const { retryAfterMs, ...payload } = result
    last = payload
    lastAt = Date.now()
    if (payload.status === 'error') {
      const grown = Math.min(Math.max(MIN_BACKOFF_MS, backoffMs * 2), MAX_BACKOFF_MS)
      backoffMs = Math.max(grown, retryAfterMs ?? 0)
      retryAt = lastAt + backoffMs
      return
    }
    backoffMs = 0
    retryAt = 0
    if (payload.status === 'ok') {
      lastOk = payload
      options.onSuccess?.(payload)
    }
  }

  const view = (current: UsageRemaining): UsageRemaining => {
    if (current.status !== 'error') return current
    const now = Date.now()
    const reason = current.error?.replace(/\.$/, '') ?? 'The usage check failed'
    const note =
      retryAt > now ? `${reason}. Retrying in ${formatWait(retryAt - now)}.` : `${reason}.`
    if (!lastOk) return { ...current, error: note }
    return staleView(lastOk, note, now)
  }

  return {
    get: async (force) => {
      const now = Date.now()
      const waiting = retryAt > now
      const fresh = last?.status !== 'error' && now - lastAt < TTL_MS
      if (last && (waiting || (fresh && !force))) return view(last)
      if (!inFlight) {
        inFlight = fetchRemaining()
          .then(apply)
          .finally(() => {
            inFlight = null
          })
      }
      await inFlight
      return view(last as UsageRemaining)
    }
  }
}
