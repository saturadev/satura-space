const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function formatDateTime(ms: number | null): string | null {
  if (ms == null) return null
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function unit(value: number, name: string): string {
  return `${value} ${name}${value === 1 ? '' : 's'}`
}

export function formatDuration(ms: number): string {
  if (ms < MINUTE) return 'less than a minute'
  if (ms < HOUR) return unit(Math.floor(ms / MINUTE), 'minute')
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    return minutes > 0 ? `${unit(hours, 'hour')} ${unit(minutes, 'minute')}` : unit(hours, 'hour')
  }
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  return hours > 0 ? `${unit(days, 'day')} ${unit(hours, 'hour')}` : unit(days, 'day')
}

export function formatDurationShort(ms: number): string {
  if (ms < MINUTE) return '<1m'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

export function timeLeft(target: number | null, now: number = Date.now()): number {
  if (target == null) return 0
  return Math.max(0, target - now)
}
