import { createHash, createPublicKey, verify } from 'node:crypto'

export const GATE_REASONS = {
  signin: 'Sign in to use Satura Remote.',
  denied: "This account doesn't have Satura Remote yet.",
  away: "This phone isn't on the same network as your desktop."
}

export const TICKET_AUDIENCE = 'satura-remote'
const TICKET_MAX = 4096
const B64U = /^[A-Za-z0-9_-]+$/

export function ticketVerifier(rawKey) {
  const text = String(rawKey ?? '').trim()
  if (!text) return null
  const raw = B64U.test(text) ? Buffer.from(text, 'base64url') : Buffer.alloc(0)
  if (raw.length !== 32) throw new Error('SATURA_RELAY_TICKET_KEY is not a base64url Ed25519 public key (32 bytes)')
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
  return (ticket, now = Date.now()) => {
    const parts = String(ticket ?? '').split('.')
    if (parts.length !== 3 || parts[0] !== 'v1' || !B64U.test(parts[1]) || !B64U.test(parts[2])) return { ok: false, why: 'malformed' }
    const sig = Buffer.from(parts[2], 'base64url')
    if (sig.length !== 64) return { ok: false, why: 'malformed' }
    let good = false
    try {
      good = verify(null, Buffer.from(`v1.${parts[1]}`, 'ascii'), key, sig)
    } catch {
    }
    if (!good) return { ok: false, why: 'signature' }
    let claims = null
    try {
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    } catch {
    }
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return { ok: false, why: 'malformed' }
    if (claims.aud !== TICKET_AUDIENCE) return { ok: false, why: 'audience' }
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now) return { ok: false, why: 'expired' }
    return { ok: true, claims }
  }
}

export function bearerOf(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req?.headers?.authorization ?? ''))
  return m ? m[1] : ''
}

export function createGate({ authUrl, allowEmails, ticketKey, ttlMs = 30_000, timeoutMs = 5000, maxEntries = 2000, maxInflight = 64, interpret = null, fetchImpl = fetch, log = () => {} } = {}) {
  const url = String(authUrl ?? '').trim()
  const allow = new Set(String(allowEmails ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))
  const verifyTicket = ticketVerifier(ticketKey)
  const enabled = Boolean(url)
  const cache = new Map()
  const inflight = new Map()
  const stats = { asked: 0, refused: 0, throttled: 0 }

  function remember(key, result) {
    cache.set(key, { at: Date.now(), result })
    if (cache.size <= maxEntries) return
    const now = Date.now()
    for (const [k, v] of cache) if (now - v.at > ttlMs || cache.size > maxEntries) cache.delete(k)
  }

  async function ask(ticket) {
    stats.asked++
    let res
    try {
      res = await fetchImpl(url, { headers: { authorization: `Bearer ${ticket}`, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      log('gate error', { error: String(e?.message ?? e) })
      return { state: 'error' }
    }
    if (res.status === 401 || res.status === 403) return { state: 'signin' }
    if (!res.ok) {
      log('gate error', { status: res.status })
      return { state: 'error' }
    }
    let body = null
    try {
      body = await res.json()
    } catch {
    }
    const raw = typeof body?.user?.email === 'string' ? body.user.email : typeof body?.email === 'string' ? body.email : ''
    const email = raw.trim().toLowerCase()
    if (!email) return { state: 'signin' }
    const allowlisted = allow.has(email)
    const fallback = allow.size && !allowlisted ? 'denied' : 'ok'
    if (interpret) {
      const more = interpret(body, { email, allowlisted, state: fallback }) ?? {}
      return { state: more.state === 'ok' || more.state === 'denied' ? more.state : fallback, email, ...(more.plan ? { plan: more.plan } : {}) }
    }
    return { state: fallback, email }
  }

  async function lookup(ticket, mayAsk) {
    const key = createHash('sha256').update(ticket).digest('base64url')
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at <= ttlMs) return { ...hit.result, gated: true }
    let pending = inflight.get(key)
    if (!pending && (inflight.size >= maxInflight || (mayAsk && !mayAsk()))) {
      stats.throttled++
      return { state: 'error', throttled: true, gated: true }
    }
    if (!pending) {
      pending = ask(ticket).then((r) => {
        inflight.delete(key)
        if (r.state !== 'error') remember(key, r)
        return r
      })
      inflight.set(key, pending)
    }
    return { ...(await pending), gated: true }
  }

  async function check(ticket, mayAsk) {
    if (!enabled) return { state: 'ok', gated: false }
    const t = String(ticket ?? '').trim()
    if (!t) return { state: 'signin', gated: true, why: 'missing' }
    if (t.length > TICKET_MAX) return { state: 'signin', gated: true, why: 'malformed' }
    if (verifyTicket) {
      const v = verifyTicket(t)
      if (!v.ok) {
        stats.refused++
        return { state: 'signin', gated: true, why: v.why }
      }
    }
    return lookup(t, mayAsk)
  }

  async function checkToken(token, mayAsk) {
    if (!enabled) return { state: 'ok', gated: false }
    const t = String(token ?? '').trim()
    if (!t || t.length > TICKET_MAX) return { state: 'signin', gated: true, why: t ? 'malformed' : 'missing' }
    return lookup(t, mayAsk)
  }

  return { enabled, verifies: !!verifyTicket, allowCount: allow.size, check, checkToken, verifyTicket: verifyTicket ?? (() => ({ ok: false, why: 'unchecked' })), stats: () => ({ cached: cache.size, inflight: inflight.size, ...stats }) }
}
