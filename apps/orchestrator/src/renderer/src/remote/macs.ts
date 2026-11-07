import { cleanHostKind, type HostKind } from '@shared/remote-host-kind'
import { fetchPresenceBody, goSignIn } from './account'

export interface MacSummary {
  at: number
  version: string
  projects: { title: string; unity: string | null; agents: number; asks: number }[]
}

export interface MacRemoved {
  at: number
  why: string
}

export interface MacRecord {
  hostId: string
  name: string
  alias: string
  phoneId: string
  pairedAt: number
  seenAt: number
  hue: number
  removed: MacRemoved | null
  summary: MacSummary | null
  kind: HostKind | null
}

export type MacPlace = string | 'all'

export interface MacPresence {
  state: 'up' | 'silent' | 'gone' | 'unknown'
  fit: 'ok' | 'update' | 'relay' | null
}

export interface MacUnread {
  count: number
  latest: { title: string; body: string; at: number } | null
}

interface Registry {
  v: 1
  last: MacPlace | null
  desktops: Record<string, MacRecord>
}

export const MACS_KEY = 'satura-remote-desktops'
export const HOME_PATH = '/h/all/'
const SESSION_HOST_KEY = 'satura-remote-session-host'
const SESSION_SCOPED = ['satura.terminalSnapshots']
const HOST_ID = /^[a-z0-9]{6,32}$/
const MAX_MACS = 24
const HUES = [214, 28, 152, 276, 346, 190, 48, 2]
const listeners = new Set<() => void>()

export function validHostId(id: unknown): id is string {
  return typeof id === 'string' && HOST_ID.test(id)
}

export function pathHostId(path = location.pathname): string | null {
  return /^\/h\/([a-z0-9]{6,32})\//.exec(path)?.[1] ?? null
}

export function macPath(hostId: string): string {
  return `/h/${hostId}/`
}

function clean(raw: unknown): MacRecord | null {
  const r = raw as Partial<MacRecord> | null
  if (!r || !validHostId(r.hostId)) return null
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
  const removed = r.removed && typeof r.removed === 'object' && Number(r.removed.at) > 0 ? { at: Number(r.removed.at), why: text(r.removed.why, 200) } : null
  const s = r.summary as Partial<MacSummary> | null | undefined
  const summary =
    s && typeof s === 'object' && Array.isArray(s.projects)
      ? {
          at: Number(s.at) || 0,
          version: text(s.version, 40),
          projects: s.projects.slice(0, 40).map((p) => ({ title: text(p?.title, 120), unity: typeof p?.unity === 'string' ? p.unity.slice(0, 40) : null, agents: Number(p?.agents) || 0, asks: Number(p?.asks) || 0 }))
        }
      : null
  const hue = Number(r.hue)
  return { hostId: r.hostId, name: text(r.name, 120), alias: text(r.alias, 60), phoneId: text(r.phoneId, 64), pairedAt: Number(r.pairedAt) || 0, seenAt: Number(r.seenAt) || 0, hue: Number.isFinite(hue) && hue >= 0 ? hue % 360 : -1, removed, summary, kind: cleanHostKind(r.kind) }
}

function load(): Registry {
  const out: Registry = { v: 1, last: null, desktops: {} }
  try {
    const raw = JSON.parse(localStorage.getItem(MACS_KEY) ?? 'null') as Partial<Registry> | null
    if (raw && typeof raw === 'object') {
      for (const v of Object.values(raw.desktops ?? {})) {
        const m = clean(v)
        if (m) out.desktops[m.hostId] = m
      }
      out.last = raw.last === 'all' || validHostId(raw.last) ? raw.last : null
    }
  } catch {
  }
  return out
}

function save(r: Registry): void {
  const ids = Object.keys(r.desktops)
  if (ids.length > MAX_MACS) {
    for (const id of ids.sort((a, b) => r.desktops[a].seenAt - r.desktops[b].seenAt).slice(0, ids.length - MAX_MACS)) delete r.desktops[id]
  }
  try {
    localStorage.setItem(MACS_KEY, JSON.stringify(r))
  } catch {
  }
  for (const l of listeners) l()
}

export function onMacsChange(fn: () => void): () => void {
  listeners.add(fn)
  const onStorage = (e: StorageEvent): void => {
    if (e.key === MACS_KEY) fn()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(fn)
    window.removeEventListener('storage', onStorage)
  }
}

export function listMacs(): MacRecord[] {
  return Object.values(load().desktops).sort((a, b) => (a.pairedAt || a.seenAt) - (b.pairedAt || b.seenAt) || a.hostId.localeCompare(b.hostId))
}

export function getMac(hostId: string | null): MacRecord | null {
  return hostId ? load().desktops[hostId] ?? null : null
}

export function pairedMacs(): MacRecord[] {
  return listMacs().filter((m) => !m.removed)
}

export function updateMac(hostId: string, patch: Partial<Omit<MacRecord, 'hostId'>>): MacRecord | null {
  if (!validHostId(hostId)) return null
  const r = load()
  const was = r.desktops[hostId] ?? { hostId, name: '', alias: '', phoneId: '', pairedAt: 0, seenAt: 0, hue: -1, removed: null, summary: null, kind: null }
  const next = clean({ ...was, ...patch, hostId })
  if (!next) return null
  if (next.hue < 0) next.hue = freeHue(hostId, Object.values(r.desktops).filter((m) => m.hostId !== hostId))
  r.desktops[hostId] = next
  save(r)
  return next
}

export function dropMac(hostId: string): void {
  const r = load()
  if (!r.desktops[hostId]) return
  delete r.desktops[hostId]
  if (r.last === hostId) r.last = null
  save(r)
}

export function setLastPlace(place: MacPlace): void {
  const r = load()
  if (r.last === place) return
  r.last = place
  save(r)
}

export function lastPlace(): MacPlace | null {
  return load().last
}

export function macLabel(m: Pick<MacRecord, 'alias' | 'name'> | null | undefined): string {
  return (m?.alias || m?.name || 'Desktop').slice(0, 80)
}

function hashOf(hostId: string): number {
  let h = 2166136261
  for (let i = 0; i < hostId.length; i++) h = Math.imul(h ^ hostId.charCodeAt(i), 16777619) >>> 0
  return h
}

function freeHue(hostId: string, others: MacRecord[]): number {
  const used = new Set(others.map((m) => m.hue))
  const start = hashOf(hostId) % HUES.length
  for (let i = 0; i < HUES.length; i++) {
    const hue = HUES[(start + i) % HUES.length]
    if (!used.has(hue)) return hue
  }
  return HUES[start]
}

export function macHue(hostId: string): number {
  const m = load().desktops[hostId]
  return m && m.hue >= 0 ? m.hue : HUES[hashOf(hostId) % HUES.length]
}

export function claimSessionFor(hostId: string): void {
  try {
    const was = sessionStorage.getItem(SESSION_HOST_KEY)
    if (was === hostId) return
    for (const k of SESSION_SCOPED) sessionStorage.removeItem(k)
    sessionStorage.setItem(SESSION_HOST_KEY, hostId)
    if (was) console.info(`[macs] this tab switched from ${was} to ${hostId}, cleared the other desktop's session keys`)
  } catch {
  }
}

export function hostKey(base: string, hostId: string | null = pathHostId()): string {
  return hostId ? `${base}:${hostId}` : base
}

export async function fetchPresence(ids: string[], ms = 3000): Promise<Record<string, MacPresence> | null> {
  const list = ids.filter(validHostId).slice(0, 16)
  if (!list.length) return {}
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    const { status, body: raw } = await fetchPresenceBody(list, ctl.signal)
    if (status === 401) goSignIn('the relay wants a signed-in phone to say which desktops are online')
    if (!raw) return null
    const body = raw as { hosts?: Record<string, Partial<MacPresence>> }
    const out: Record<string, MacPresence> = {}
    for (const id of list) {
      const p = body.hosts?.[id]
      const state = p?.state === 'up' || p?.state === 'silent' || p?.state === 'gone' ? p.state : 'unknown'
      const fit = p?.fit === 'ok' || p?.fit === 'update' || p?.fit === 'relay' ? p.fit : null
      out[id] = { state, fit }
    }
    return out
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function unreadFor(hostId: string): Promise<MacUnread> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration(macPath(hostId))
    if (!reg || !reg.scope.endsWith(macPath(hostId))) return { count: 0, latest: null }
    const list = await reg.getNotifications()
    let latest: MacUnread['latest'] = null
    for (const n of list) {
      const at = Number((n.data as { at?: unknown } | null)?.at) || Number((n as Notification & { timestamp?: number }).timestamp) || 0
      if (!latest || at > latest.at) latest = { title: n.title, body: n.body, at }
    }
    return { count: list.length, latest }
  } catch {
    return { count: 0, latest: null }
  }
}

export function agoText(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  return d === 1 ? 'yesterday' : `${d} days ago`
}
