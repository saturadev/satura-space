import type { UsageRemaining } from '@shared/api'

function hasWindows(usage: UsageRemaining): boolean {
  return !!usage.session || !!usage.weekly || (usage.weeklyScoped?.length ?? 0) > 0
}

export function mergeUsage(probe: UsageRemaining, live: UsageRemaining): UsageRemaining {
  if (!hasWindows(live)) return probe
  if (!hasWindows(probe)) return live
  if (live.updatedAt <= probe.updatedAt) return probe
  return {
    ...probe,
    session: live.session ?? probe.session,
    weekly: live.weekly ?? probe.weekly,
    updatedAt: live.updatedAt
  }
}
