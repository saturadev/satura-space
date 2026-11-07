import { fromUtf8, unb64u } from '@shared/remote-e2e'
import { REMOTE_PROTOCOL } from '@shared/remote-version'
import { topWindow } from './wide-frame'
import { leavePage } from './motion'

export interface PhoneConfig {
  relay: string
  account: string | null
}

export interface Ticket {
  raw: string
  sub: string
  email: string
  iat: number
  exp: number
}

const CONFIG_PATH = '/phone-config.json'
const CONFIG_MS = 8000
const DB_NAME = 'satura-account'
const DB_STORE = 'ticket'
const TICKET_KEY = 'ticket'
const AUDIENCE = 'satura-remote'
const TICKET_MAX = 4096
const TICKET = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const RENEW_LEFT_S = 15 * 86400
const RENEW_MS = 10_000
const SIGNIN_KEY = 'satura-remote-signin-at'
const SIGNIN_AGAIN_MS = 60_000
const PAIR_STASH_KEY = 'satura-remote-pair-stash'

let configJob: Promise<PhoneConfig | null> | null = null
let config: PhoneConfig | null = null
let ticket: Ticket | null = null
let ticketLoad: Promise<Ticket | null> | null = null
let renewing: Promise<void> | null = null
let opening: Promise<IDBDatabase> | null = null
const listeners = new Set<() => void>()

function parseUrl(raw: unknown, schemes: RegExp): URL | null {
  if (typeof raw !== 'string' || raw.length > 512) return null
  try {
    const u = new URL(raw)
    return schemes.test(u.protocol) && !u.username && !u.password ? u : null
  } catch {
    return null
  }
}

function readConfig(raw: unknown): PhoneConfig | null {
  const r = raw as Partial<PhoneConfig> | null
  if (!r || typeof r !== 'object') return null
  const relay = parseUrl(r.relay, /^wss?:$/)
  if (!relay || relay.search || relay.hash) return null
  const account = r.account === null ? null : parseUrl(r.account, /^https?:$/)
  if (r.account !== null && !account) return null
  return { relay: relay.href, account: account ? account.origin : null }
}

export function loadConfig(): Promise<PhoneConfig | null> {
  configJob ??= (async () => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), CONFIG_MS)
    try {
      const r = await fetch(CONFIG_PATH, { cache: 'no-store', credentials: 'omit', signal: ctl.signal, headers: { accept: 'application/json' } })
      if (!r.ok) throw new Error(`it answered ${r.status}`)
      const c = readConfig(await r.json())
      if (!c) throw new Error('it has no valid relay and account')
      config = c
      console.info(`[account] relay ${c.relay}, ${c.account ? `account site ${c.account}` : 'no accounts on this relay'}`)
      return c
    } catch (e) {
      configJob = null
      console.warn(`[account] couldn't read ${CONFIG_PATH}: ${e instanceof Error ? e.message : String(e)}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  })()
  return configJob
}

export function configNow(): PhoneConfig | null {
  return config
}

export function relayHost(): string {
  return config ? new URL(config.relay).host : ''
}

export function accountUrl(path: string): string | null {
  return config?.account ? `${config.account}${path}` : null
}

function relayHttp(c: PhoneConfig, path: string): string {
  const u = new URL(c.relay)
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
  return new URL(path, u).href
}

export function parseTicket(raw: unknown, now = Date.now()): Ticket | null {
  if (typeof raw !== 'string' || raw.length > TICKET_MAX || !TICKET.test(raw)) return null
  try {
    const claims = JSON.parse(fromUtf8(unb64u(raw.split('.')[1]))) as Record<string, unknown> | null
    if (!claims || claims.aud !== AUDIENCE || typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null
    return { raw, sub: String(claims.sub ?? '').slice(0, 200), email: typeof claims.email === 'string' ? claims.email.slice(0, 200) : '', iat: Number(claims.iat) || 0, exp: claims.exp }
  } catch {
    return null
  }
}

function db(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE)
    }
    req.onsuccess = () => {
      const d = req.result
      d.onversionchange = () => {
        d.close()
        opening = null
      }
      resolve(d)
    }
    req.onerror = () => {
      opening = null
      reject(req.error ?? new Error("IndexedDB didn't open"))
    }
    req.onblocked = () => {
      opening = null
      reject(new Error('IndexedDB is blocked'))
    }
  })
  return opening
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  const d = await db()
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = d.transaction(DB_STORE, mode)
    const req = fn(tx.objectStore(DB_STORE))
    tx.oncomplete = () => resolve(req ? (req.result as T) : undefined)
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB aborted'))
  })
}

function setTicket(next: Ticket | null): void {
  const changed = next?.raw !== ticket?.raw
  ticket = next
  if (changed) for (const l of listeners) l()
}

export function onAccountChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function ticketNow(): Ticket | null {
  if (ticket && ticket.exp * 1000 <= Date.now()) setTicket(null)
  return ticket
}

export function loadTicket(): Promise<Ticket | null> {
  ticketLoad ??= (async () => {
    try {
      const raw = await run<unknown>('readonly', (s) => s.get(TICKET_KEY))
      const t = parseTicket(raw)
      if (raw && !t) {
        console.info('[account] the stored ticket expired, forgetting it')
        await run('readwrite', (s) => s.delete(TICKET_KEY)).catch(() => {})
      }
      setTicket(t)
      return t
    } catch (e) {
      console.warn(`[account] couldn't read the ticket: ${e instanceof Error ? e.message : String(e)}`)
      return null
    } finally {
      ticketLoad = null
    }
  })()
  return ticketLoad
}

async function saveTicket(t: Ticket): Promise<void> {
  await run('readwrite', (s) => s.put(t.raw, TICKET_KEY))
  setTicket(t)
}

export async function dropTicket(why: string): Promise<void> {
  console.info(`[account] forgetting this phone's ticket: ${why}`)
  setTicket(null)
  await run('readwrite', (s) => s.delete(TICKET_KEY)).catch((e: Error) => console.warn(`[account] couldn't delete the ticket: ${e.message}`))
}

export async function signOutHere(): Promise<void> {
  await dropTicket('signed out on this phone')
  leavePage('/m/?out=1', 'signed out')
}

export function renewTicket(why: string): Promise<void> {
  const c = config
  const t = ticketNow()
  if (!c?.account || !t || t.exp - Date.now() / 1000 >= RENEW_LEFT_S || renewing) return renewing ?? Promise.resolve()
  renewing = (async () => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), RENEW_MS)
    try {
      const r = await fetch(`${c.account}/api/remote/ticket`, { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', signal: ctl.signal, headers: { authorization: `Bearer ${t.raw}`, accept: 'application/json' } })
      if (r.status === 401) {
        await dropTicket('the account site no longer accepts it')
        return
      }
      if (!r.ok) throw new Error(`the account site answered ${r.status}`)
      const body = (await r.json()) as { ticket?: unknown }
      const next = parseTicket(body.ticket)
      if (!next) throw new Error('the account site sent no valid ticket')
      await saveTicket(next)
      console.info(`[account] renewed the ticket (${why}), valid for ${Math.round((next.exp - Date.now() / 1000) / 86400)} days`)
    } catch (e) {
      console.warn(`[account] couldn't renew the ticket (${why}): ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      clearTimeout(timer)
      renewing = null
    }
  })()
  return renewing
}

function stashPairCode(): void {
  const code = new URLSearchParams(location.hash.replace(/^#/, '')).get('pair')
  if (!code) return
  try {
    sessionStorage.setItem(PAIR_STASH_KEY, JSON.stringify({ code, at: Date.now() }))
  } catch {
  }
}

export function signInUrl(): string | null {
  return accountUrl(`/remote/connect?next=${encodeURIComponent(location.pathname + location.search)}`)
}

function standalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

export function goSignIn(why: string, asked = false): boolean {
  const url = signInUrl()
  if (!url) return false
  if (standalone()) {
    stashPairCode()
    console.info(`[account] sign-in needed (${why}); the Home Screen app signs in from /m/ with a claim`)
    topWindow().location.replace(`/m/?next=${encodeURIComponent(location.pathname + location.search)}`)
    return true
  }
  if (!asked) {
    try {
      const last = Number(sessionStorage.getItem(SIGNIN_KEY) ?? 0)
      if (Date.now() - last < SIGNIN_AGAIN_MS) {
        console.warn(`[account] sign-in needed (${why}), but this tab came back from it ${Math.round((Date.now() - last) / 1000)} s ago, so it waits for a tap`)
        return false
      }
      sessionStorage.setItem(SIGNIN_KEY, String(Date.now()))
    } catch {
    }
  }
  stashPairCode()
  console.info(`[account] sign-in needed (${why}), opening ${new URL(url).origin}/remote/connect`)
  topWindow().location.replace(url)
  return true
}

export async function fetchPresenceBody(ids: string[], signal: AbortSignal): Promise<{ status: number; body: unknown }> {
  const c = config ?? (await loadConfig())
  if (!c) return { status: 0, body: null }
  const t = c.account ? (ticketNow() ?? (await loadTicket())) : null
  if (c.account && !t) return { status: 401, body: null }
  const r = await fetch(relayHttp(c, `presence?h=${ids.join(',')}&protocol=${REMOTE_PROTOCOL}&minHost=${REMOTE_PROTOCOL}`), { mode: 'cors', credentials: 'omit', cache: 'no-store', signal, headers: { accept: 'application/json', ...(t ? { authorization: `Bearer ${t.raw}` } : {}) } })
  return { status: r.status, body: r.ok ? await r.json() : null }
}

export async function accountReady(why: string): Promise<{ config: PhoneConfig | null; ticket: Ticket | null }> {
  const c = await loadConfig()
  if (!c?.account) return { config: c, ticket: null }
  const t = await loadTicket()
  if (t) void renewTicket(why)
  return { config: c, ticket: t }
}
