import { ipcMain } from 'electron'
import { isIP } from 'node:net'
import { readAllowance, type RemoteAccountUsage, type RemoteUsageRow, type RemoteUsageState } from '@shared/remote-protocol'
import { AUTH_BASE_URL, authConfigured, getAuthToken } from '../auth'
import { relayHttpOrigin, turnUsageHere } from './host'

const FETCH_TIMEOUT_MS = 8000
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function siteOf(hostname: string): string {
  const h = hostname.toLowerCase()
  if (LOOPBACK.has(h)) return 'loopback'
  if (isIP(h.replace(/^\[|\]$/g, ''))) return h
  return h.split('.').slice(-2).join('.')
}

export function sameAccountSite(relay: string, auth: string): boolean {
  try {
    return siteOf(new URL(relay).hostname) === siteOf(new URL(auth).hostname)
  } catch {
    return false
  }
}

function row(raw: unknown): RemoteUsageRow | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const n = (k: string): number => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : 0)
  return { cfEgress: n('cfEgress'), cfIngress: n('cfIngress'), turnTx: n('turnTx'), turnRx: n('turnRx'), turnEgress: n('turnEgress'), wsIn: n('wsIn'), wsOut: n('wsOut'), web: n('web'), mints: n('mints') }
}

function base(state: RemoteUsageState, detail: string, relay: string | null): RemoteAccountUsage {
  const here = turnUsageHere()
  return {
    state,
    detail,
    at: Date.now(),
    relay,
    account: null,
    day: null,
    month: null,
    today: null,
    thisMonth: null,
    total: null,
    days: [],
    cloudflare: null,
    allowance: null,
    access: null,
    thisMac: { sinceStart: here.sinceStart, since: here.since, pendingBytes: here.pendingBytes, live: { session: here.live.session, path: here.live.path, total: here.live.total } }
  }
}

export async function fetchAccountUsage(): Promise<RemoteAccountUsage> {
  const relay = relayHttpOrigin()
  if (!authConfigured()) return base('no-auth', 'Accounts are not set up in this build.', relay)
  const token = getAuthToken()
  if (!token) return base('signed-out', 'Sign in to see what Satura Remote used this month.', relay)
  if (!relay) return base('off', 'Satura Remote is off.', relay)
  if (!sameAccountSite(relay, AUTH_BASE_URL)) return base('other-relay', `${new URL(relay).host} isn't run by Satura, so this desktop won't send it your sign-in.`, relay)
  let res: Response
  try {
    res = await fetch(`${relay}/usage/me`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (e) {
    console.log(`[remote] usage: ${relay}/usage/me didn't answer: ${(e as Error).message}`)
    return base('error', "Satura Remote didn't answer. Try again in a moment.", relay)
  }
  let body: Record<string, unknown> | null = null
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
  }
  const error = typeof body?.error === 'string' ? body.error : 'Satura Remote is unavailable right now.'
  if (res.status === 404) return base('no-accounts', '', relay)
  if (res.status === 401 || res.status === 403) return base('refused', error, relay)
  if (!res.ok || !body) return base('error', error, relay)
  const out = base('ok', '', relay)
  const cf = (body.cloudflare ?? null) as { enabled?: unknown; at?: unknown; error?: unknown } | null
  return {
    ...out,
    account: typeof body.account === 'string' ? body.account : null,
    day: typeof body.day === 'string' ? body.day : null,
    month: typeof body.month === 'string' ? body.month : null,
    today: row(body.today),
    thisMonth: row(body.thisMonth),
    total: row(body.total),
    days: (Array.isArray(body.days) ? body.days : []).flatMap((d) => {
      const r = row(d)
      const day = (d as { day?: unknown })?.day
      return r && typeof day === 'string' ? [{ ...r, day }] : []
    }),
    cloudflare: cf ? { enabled: cf.enabled === true, at: typeof cf.at === 'number' ? cf.at : 0, error: typeof cf.error === 'string' ? cf.error : null } : null,
    allowance: readAllowance(body.allowance),
    access: (body.remote as { access?: unknown } | undefined)?.access === 'local' ? 'local' : 'any'
  }
}

export function registerAccountUsage(): void {
  ipcMain.handle('remote:usage', (event) => {
    if ((event.sender as unknown as { remote?: boolean }).remote) throw new Error("The phone can't read this desktop's account traffic")
    return fetchAccountUsage()
  })
}
