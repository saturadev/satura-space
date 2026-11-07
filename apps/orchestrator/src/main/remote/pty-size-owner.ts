import { censusTrack } from '@shared/census'

export const DESKTOP = 'desktop'

export interface PtySizeAnnouncement {
  id: string
  owner: 'desktop' | 'phone'
  cols: number | null
  rows: number | null
}

interface Entry {
  owner: string
  sizes: Map<string, { cols: number; rows: number }>
  lastInput: Map<string, number>
}

interface Deps {
  announce: (a: PtySizeAnnouncement) => void
  log: (line: string) => void
}

const OWNER_TYPING_HOLD_MS = 800

const entries = new Map<string, Entry>()
censusTrack('pty-size-owner.entries', entries)
let deps: Deps | null = null
let resizer: ((id: string, cols: number, rows: number) => void) | null = null

export function setPtyResizer(fn: (id: string, cols: number, rows: number) => void): void {
  resizer = fn
}

export function configurePtySizeOwner(d: Deps): void {
  deps = d
}

function entry(id: string): Entry {
  let e = entries.get(id)
  if (!e) entries.set(id, (e = { owner: DESKTOP, sizes: new Map(), lastInput: new Map() }))
  return e
}

export function clientOfSender(sender: unknown): string {
  const s = sender as { remote?: boolean; cid?: string } | null
  return s?.remote && s.cid ? String(s.cid) : DESKTOP
}

export function ptySizeOwner(id: string): string {
  return entries.get(id)?.owner ?? DESKTOP
}

export function allowPtyResize(id: string, client: string, cols: number, rows: number): boolean {
  if (!id || !(cols > 0) || !(rows > 0)) return false
  const e = entry(id)
  const prev = e.sizes.get(client)
  e.sizes.set(client, { cols, rows })
  if (e.owner !== client) return false
  if (!prev || prev.cols !== cols || prev.rows !== rows) deps?.announce({ id, owner: client === DESKTOP ? 'desktop' : 'phone', cols, rows })
  return true
}

const NOISE = [/^\x1b\[[IO]$/, /^\x1b\[\??[\d;]*[cRnt]$/, /^\x1b\][\d;]*[^\x07\x1b]*(\x07|\x1b\\)$/, /^\x1b\[<3[2-9];\d+;\d+[Mm]$/, /^\x1bP[\s\S]*\x1b\\$/]

export function isRealInput(data: string): boolean {
  if (!data) return false
  return !NOISE.some((re) => re.test(data))
}

export function notePtyInput(id: string, client: string, data: string): void {
  if (!id || !isRealInput(data)) return
  const e = entry(id)
  const now = Date.now()
  e.lastInput.set(client, now)
  if (e.owner === client) return
  const ownerTyped = e.lastInput.get(e.owner) ?? 0
  if (now - ownerTyped < OWNER_TYPING_HOLD_MS) {
    deps?.log(`[pty-size] ${id} ${client} typed while ${e.owner} is typing, size stays`)
    return
  }
  setOwner(id, client, 'typed')
}

export function claimPtySize(id: string, client: string, reason: string): void {
  if (!id) return
  if (entry(id).owner === client) return
  setOwner(id, client, reason)
}

export function releasePtySize(id: string, client: string, reason: string): void {
  const e = entries.get(id)
  if (!e || e.owner !== client) return
  setOwner(id, DESKTOP, reason)
}

export function releaseClient(client: string, reason: string): void {
  for (const [id, e] of entries) {
    e.sizes.delete(client)
    e.lastInput.delete(client)
    if (e.owner === client) setOwner(id, DESKTOP, reason)
  }
}

export function forgetPty(id: string): void {
  entries.delete(id)
}

function setOwner(id: string, client: string, reason: string): void {
  const e = entry(id)
  const from = e.owner
  e.owner = client
  const size = e.sizes.get(client) ?? null
  if (size) resizer?.(id, size.cols, size.rows)
  deps?.log(`[pty-size] ${id} owner ${from} -> ${client} (${reason})${size ? ` ${size.cols}x${size.rows}` : ' size pending'}`)
  deps?.announce({ id, owner: client === DESKTOP ? 'desktop' : 'phone', cols: size?.cols ?? null, rows: size?.rows ?? null })
}
