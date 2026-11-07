const DAY_MS = 86_400_000

function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function daysAgo(ms: number, now: number): number {
  return Math.round((dayStart(new Date(now)) - dayStart(new Date(ms))) / DAY_MS)
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
}

export function formatDay(ms: number, now: number = Date.now()): string {
  const d = new Date(ms)
  const days = daysAgo(ms, now)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, {
    weekday: days < 7 ? 'long' : undefined,
    day: 'numeric',
    month: 'long',
    year: d.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric'
  })
}

export function formatWhen(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const days = daysAgo(ms, now)
  const clock = formatClock(ms)
  if (days <= 0) return `Today ${clock}`
  if (days === 1) return `Yesterday ${clock}`
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' })} ${clock}`
}

export function formatWhenFull(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  })
}
