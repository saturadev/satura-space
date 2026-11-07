export type LinkPath = 'relay' | 'dc'
export type LinkDir = 'in' | 'out'
export type Lag = (bytes: number, fn: () => void) => void

interface Row {
  n: number
  bytes: number
}

const rows = new Map<string, Row>()
let since = Date.now()
let current = new Map<string, number>()
let previous = new Map<string, number>()
let rotatedAt = Date.now()
let spanMs = 1000

export function countTraffic(path: LinkPath, dir: LinkDir, ch: string, bytes: number): void {
  const key = `${path}\t${dir}\t${ch}`
  const r = rows.get(key)
  if (r) {
    r.n++
    r.bytes += bytes
  } else rows.set(key, { n: 1, bytes })
  const group = `${path}\t${dir}\t${ch.split(' ')[0]}`
  current.set(group, (current.get(group) ?? 0) + bytes)
}

setInterval(() => {
  const now = Date.now()
  spanMs = Math.max(1, now - rotatedAt)
  rotatedAt = now
  previous = current
  current = new Map()
}, 1000).unref()

export function recentKbps(path: LinkPath, dir: LinkDir, group: string): number {
  return Math.round((((previous.get(`${path}\t${dir}\t${group}`) ?? 0) * 8) / spanMs) * 10) / 10
}

export function recentGroups(path: LinkPath): string[] {
  const out = new Set<string>()
  for (const key of previous.keys()) {
    const [p, , g] = key.split('\t')
    if (p === path) out.add(g)
  }
  return [...out]
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}

export function trafficReport(reset: boolean): {
  secs: number
  totals: Record<string, { n: number; kb: number; kbps: number }>
  rows: { path: string; dir: string; ch: string; n: number; kb: number; kbps: number }[]
} {
  const secs = Math.max(0.001, (Date.now() - since) / 1000)
  const totals: Record<string, { n: number; kb: number; kbps: number }> = {}
  const list = [...rows].map(([key, r]) => {
    const [path, dir, ch] = key.split('\t')
    const t = (totals[`${path} ${dir}`] ??= { n: 0, kb: 0, kbps: 0 })
    t.n += r.n
    t.kb += r.bytes / 1024
    t.kbps += (r.bytes * 8) / 1000 / secs
    return { path, dir, ch, n: r.n, kb: round(r.bytes / 1024), kbps: round((r.bytes * 8) / 1000 / secs) }
  })
  for (const t of Object.values(totals)) {
    t.kb = round(t.kb)
    t.kbps = round(t.kbps)
  }
  if (reset) {
    rows.clear()
    since = Date.now()
  }
  return { secs: round(secs), totals, rows: list.sort((a, b) => b.kb - a.kb || b.n - a.n) }
}

export function makeLag(delayMs: number, kbps: number): Lag {
  let freeAt = 0
  if (!(delayMs > 0) && !(kbps > 0)) return (_bytes, fn) => fn()
  return (bytes, fn) => {
    const now = performance.now()
    freeAt = Math.max(now, freeAt) + (kbps > 0 ? (bytes * 8) / kbps : 0)
    setTimeout(fn, Math.max(0, freeAt + Math.max(0, delayMs) - now))
  }
}

function envNumber(name: string): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : 0
}

export const relayLagMs = envNumber('SATURA_REMOTE_RELAY_DELAY_MS')
export const relayLagKbps = envNumber('SATURA_REMOTE_RELAY_KBPS')
export const dcLagMs = envNumber('SATURA_REMOTE_DC_DELAY_MS')
export const dcLagKbps = envNumber('SATURA_REMOTE_DC_KBPS')

export function recentTotalKbps(path: LinkPath, dir: LinkDir): number {
  let bytes = 0
  for (const [key, b] of previous) if (key.startsWith(`${path}\t${dir}\t`)) bytes += b
  return Math.round(((bytes * 8) / spanMs) * 10) / 10
}
