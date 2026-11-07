import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { loadState, saveState } from '../persistence'
import type { AuthUser } from '@shared/api'

export const AUTH_BASE_URL = process.env.SATURA_AUTH_URL || ''

export function authConfigured(): boolean {
  return AUTH_BASE_URL !== ''
}

const FETCH_TIMEOUT_MS = 15_000

function isJsonResponse(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('json')
}

function storeToken(token: string, email: string): void {
  let stored: { token: string; email: string; enc: boolean }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      stored = { token: safeStorage.encryptString(token).toString('base64'), email, enc: true }
    } else {
      console.warn('[auth] safeStorage unavailable — storing token unencrypted')
      stored = { token, email, enc: false }
    }
  } catch {
    stored = { token, email, enc: false }
  }
  saveState({ ...loadState(), auth: stored })
  setSessionCache({ email })
}

function readToken(): { token: string; email: string } | null {
  const a = loadState().auth
  if (!a) return null
  try {
    if (a.enc) return { token: safeStorage.decryptString(Buffer.from(a.token, 'base64')), email: a.email }
    return { token: a.token, email: a.email }
  } catch (e) {
    if (!app.isReady()) return null
    console.error(
      `[auth] the saved sign-in can't be decrypted (${(e as Error).message}); signing out so the user can sign in again`
    )
    clearToken()
    broadcast('auth:signed-out')
    return null
  }
}

function clearToken(): void {
  saveState({ ...loadState(), auth: null })
  setSessionCache(null)
}

export function getAuthToken(): string | null {
  return readToken()?.token ?? null
}

export function hasStoredAuth(): boolean {
  return loadState().auth != null
}

function broadcast(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

let sessionPromise: Promise<AuthUser | null> | null = null

export function fetchSession(): Promise<AuthUser | null> {
  return (sessionPromise ??= revalidateSession())
}

function setSessionCache(user: AuthUser | null): void {
  sessionPromise = Promise.resolve(user)
}

async function revalidateSession(): Promise<AuthUser | null> {
  if (!authConfigured()) return null
  const t = readToken()
  if (!t) {
    const email = loadState().auth?.email
    return email ? { email } : null
  }
  try {
    const res = await fetch(`${AUTH_BASE_URL}/api/auth/get-session`, {
      headers: { authorization: `Bearer ${t.token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if ((res.status === 401 || res.status === 403) && isJsonResponse(res)) {
      clearToken()
      return null
    }
    if (!res.ok) return { email: t.email }
    const data = (await res.json()) as { user?: { email?: string } } | null
    const email = data?.user?.email
    if (!email) {
      clearToken()
      return null
    }
    return { email }
  } catch {
    return { email: t.email }
  }
}

function pageHtml(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Satura Space</title>
<style>body{font-family:-apple-system,Inter,Segoe UI,sans-serif;background:#f7f7f4;color:#15140f;
display:grid;place-items:center;height:100vh;margin:0}.c{text-align:center;max-width:24rem;padding:2rem}
h1{font-size:1.25rem;font-weight:600;letter-spacing:-.02em}p{color:#57554d;margin-top:.5rem;font-size:.95rem}</style>
</head><body><div class="c"><h1>${title}</h1><p>${body}</p></div></body></html>`
}

export async function startBrowserSignIn(open = true): Promise<{ url: string }> {
  if (!authConfigured()) throw new Error('Account sign-in is not available yet.')
  const state = randomBytes(16).toString('hex')
  return new Promise<{ url: string }>((resolve, reject) => {
    let done = false
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        if (url.pathname !== '/callback') {
          res.writeHead(404)
          res.end()
          return
        }
        const code = url.searchParams.get('code')
        const gotState = url.searchParams.get('state')
        if (!code || gotState !== state) {
          res.writeHead(400, { 'content-type': 'text/html' })
          res.end(pageHtml('Sign-in failed', 'Please try again from the Satura Space app.'))
          return
        }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(pageHtml("You're signed in", 'You can close this tab and return to Satura Space.'))
        void exchangeAndStore(code)
        cleanup()
      } catch {
        res.writeHead(500)
        res.end()
      }
    })
    const cleanup = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        server.close()
      } catch {
      }
    }
    const timer = setTimeout(cleanup, 5 * 60_000)
    server.on('error', (e) => {
      cleanup()
      reject(e)
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      const url = `${AUTH_BASE_URL}/desktop?port=${port}&state=${state}`
      if (open) void shell.openExternal(url)
      resolve({ url })
    })
  })
}

async function exchangeAndStore(code: string): Promise<void> {
  try {
    const res = await fetch(`${AUTH_BASE_URL}/api/auth/one-time-token/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: code }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.log(`[auth] one-time-token verify failed: ${res.status}`)
      return
    }
    const data = (await res.json()) as { session?: { token?: string }; user?: { email?: string } }
    const token = data?.session?.token || res.headers.get('set-auth-token') || undefined
    const email = data?.user?.email
    if (!token || !email) {
      console.log('[auth] one-time-token verify: missing token or email in response')
      return
    }
    storeToken(token, email)
    broadcast('auth:signed-in', { email } satisfies AuthUser)
    ;(app as unknown as EventEmitter).emit('satura:signed-in')
  } catch (e) {
    console.log(`[auth] token exchange error: ${(e as Error).message}`)
  }
}

export async function signOut(): Promise<void> {
  const t = readToken()
  if (t) {
    try {
      await fetch(`${AUTH_BASE_URL}/api/auth/sign-out`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t.token}` },
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
    }
  }
  clearToken()
  broadcast('auth:signed-out')
}
