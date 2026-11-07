
export function relativeTimeShort(ms: number): string {
  const diff = Date.now() - ms
  if (!Number.isFinite(diff) || diff < 0) return 'now'
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  if (d < 30) return `${Math.floor(d / 7)}w`
  if (d < 365) return `${Math.floor(d / 30)}mo`
  return `${Math.floor(d / 365)}y`
}

export function relativeTimeLong(ms: number): string {
  const diff = Date.now() - ms
  if (!Number.isFinite(diff) || diff < 0) return 'just now'
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return plural(m, 'minute')
  const h = Math.floor(m / 60)
  if (h < 24) return plural(h, 'hour')
  const d = Math.floor(h / 24)
  if (d < 7) return plural(d, 'day')
  if (d < 30) return plural(Math.floor(d / 7), 'week')
  if (d < 365) return plural(Math.floor(d / 30), 'month')
  return plural(Math.floor(d / 365), 'year')
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`
}
