import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createECDH, createHmac, createPrivateKey, hkdfSync, sign, timingSafeEqual } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/]
const URGENCY = new Set(['very-low', 'low', 'normal', 'high'])
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/
const MAX_ENDPOINT = 1024
const MAX_BODY = 4096
const MIN_BODY = 103
const MAX_TTL_S = 24 * 3600
const JWT_TTL_S = 12 * 3600
const JWT_RENEW_S = 3600
const SEND_TIMEOUT_MS = 10_000
const MAX_INFLIGHT = 64

const b64u = (buf) => Buffer.from(buf).toString('base64url')

function unb64u(text) {
  const s = String(text ?? '')
  return /^[A-Za-z0-9_-]*$/.test(s) ? Buffer.from(s, 'base64url') : Buffer.alloc(0)
}

function publicOf(d) {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(d)
  return ecdh.getPublicKey()
}

function readKeyFile(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    const d = unb64u(j.private)
    return d.length === 32 ? d : null
  } catch {
    return null
  }
}

function loadKeys(env, devMode, log) {
  if (env.SATURA_RELAY_VAPID_PRIVATE) {
    const d = unb64u(env.SATURA_RELAY_VAPID_PRIVATE)
    if (d.length !== 32) return log('push off', { reason: 'SATURA_RELAY_VAPID_PRIVATE is not a base64url P-256 private key (32 bytes)' }), null
    return { d, source: 'env' }
  }
  const file = env.SATURA_RELAY_VAPID_FILE ? resolve(env.SATURA_RELAY_VAPID_FILE) : devMode ? join(tmpdir(), 'satura-relay-vapid.json') : ''
  if (!file) return null
  if (existsSync(file)) {
    const d = readKeyFile(file)
    if (!d) return log('push off', { reason: `${file} holds no VAPID private key` }), null
    return { d, source: file }
  }
  if (!devMode) return log('push off', { reason: `${file} does not exist` }), null
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const d = ecdh.getPrivateKey()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ private: b64u(d), public: b64u(ecdh.getPublicKey()) }, null, 2), { mode: 0o600 })
  chmodSync(file, 0o600)
  log('push made dev VAPID keys', { file })
  return { d, source: file }
}

function extraHosts(raw) {
  return String(raw ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

export function createPush({ env, devMode, publicWeb, log, logLimited, createLimiter }) {
  const keys = loadKeys(env, devMode, log)
  const stats = { sent: 0, failed: 0, refused: 0, gone: 0, inflight: 0 }
  if (!keys) return { enabled: false, publicKey: null, bind: () => ({ error: 'This relay has no push keys.' }), send: async () => ({ status: 0, error: 'push is off' }), status: () => ({ enabled: false }) }
  const pub = publicOf(keys.d)
  const given = env.SATURA_RELAY_VAPID_PUBLIC ? unb64u(env.SATURA_RELAY_VAPID_PUBLIC) : null
  if (given && !given.equals(pub)) {
    log('push off', { reason: "SATURA_RELAY_VAPID_PUBLIC doesn't match SATURA_RELAY_VAPID_PRIVATE" })
    return { enabled: false, publicKey: null, bind: () => ({ error: 'This relay has no push keys.' }), send: async () => ({ status: 0, error: 'push is off' }), status: () => ({ enabled: false }) }
  }
  const publicKey = b64u(pub)
  const subject = String(env.SATURA_RELAY_VAPID_SUBJECT || publicWeb || 'mailto:relay@localhost')
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64u(keys.d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' })
  const secret = Buffer.from(hkdfSync('sha256', keys.d, Buffer.from('satura-relay-push'), Buffer.from('bind'), 32))
  const extra = extraHosts(env.SATURA_RELAY_PUSH_HOSTS)
  const perHost = createLimiter(Number(env.SATURA_RELAY_PUSH_PER_MIN ?? 120), 60_000)
  const perEndpoint = createLimiter(Number(env.SATURA_RELAY_PUSH_PER_ENDPOINT_PER_MIN ?? 40), 60_000)
  const binds = createLimiter(Number(env.SATURA_RELAY_PUSH_BINDS_PER_MIN ?? 20), 60_000)
  const jwts = new Map()

  function endpointProblem(raw) {
    const text = String(raw ?? '')
    if (!text || text.length > MAX_ENDPOINT) return 'bad endpoint'
    let u
    try {
      u = new URL(text)
    } catch {
      return 'bad endpoint'
    }
    if (u.username || u.password || u.hash) return 'bad endpoint'
    const host = u.hostname.toLowerCase()
    if (extra.includes(u.host.toLowerCase()) || extra.includes(host)) return u.protocol === 'https:' || (devMode && u.protocol === 'http:') ? null : 'push endpoints are https'
    if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return 'push endpoints are https'
    return PUSH_HOSTS.some((re) => re.test(host)) ? null : `${host} is not a known push service`
  }

  function tokenFor(hostId, endpoint) {
    return createHmac('sha256', secret).update(`${hostId}\n${endpoint}`).digest('base64url')
  }

  function tokenOk(hostId, endpoint, token) {
    const want = Buffer.from(tokenFor(hostId, endpoint))
    const got = Buffer.from(String(token ?? ''))
    return got.length === want.length && timingSafeEqual(got, want)
  }

  function jwtFor(aud) {
    const now = Math.floor(Date.now() / 1000)
    const hit = jwts.get(aud)
    if (hit && hit.exp - now > JWT_RENEW_S) return hit.token
    const exp = now + JWT_TTL_S
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
    const body = b64u(JSON.stringify({ aud, exp, sub: subject }))
    const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' })
    const token = `${head}.${body}.${b64u(sig)}`
    jwts.set(aud, { token, exp })
    if (jwts.size > 64) jwts.delete(jwts.keys().next().value)
    return token
  }

  function bind(hostId, who, endpoint) {
    if (!binds.take(who)) return { error: 'Too many notification sign-ups. Wait a minute and try again.' }
    const problem = endpointProblem(endpoint)
    if (problem) return { error: problem }
    return { token: tokenFor(hostId, endpoint) }
  }

  async function send(hostId, m) {
    const endpoint = String(m.endpoint ?? '')
    const problem = endpointProblem(endpoint)
    const refuse = (error) => {
      stats.refused++
      logLimited(hostId, 'push refused', { hostId, error })
      return { status: 0, error }
    }
    if (problem) return refuse(problem)
    if (!tokenOk(hostId, endpoint, m.token)) return refuse('that endpoint was not signed up through this relay for this Mac')
    const body = unb64u(m.body)
    if (body.length < MIN_BODY || body.length > MAX_BODY) return refuse(`a push body is ${MIN_BODY} to ${MAX_BODY} bytes, got ${body.length}`)
    if (!perHost.take(hostId) || !perEndpoint.take(endpoint)) return refuse('too many pushes')
    if (stats.inflight >= MAX_INFLIGHT) return refuse('too many pushes in flight')
    const ttl = Math.max(0, Math.min(MAX_TTL_S, Math.round(Number(m.ttl) || 0)))
    const urgency = URGENCY.has(m.urgency) ? m.urgency : 'normal'
    const topic = typeof m.topic === 'string' && TOPIC.test(m.topic) ? m.topic : ''
    const u = new URL(endpoint)
    const service = u.hostname
    const headers = {
      ttl: String(ttl),
      urgency,
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      authorization: `vapid t=${jwtFor(u.origin)}, k=${publicKey}`,
      ...(topic ? { topic } : {})
    }
    const started = Date.now()
    stats.inflight++
    try {
      const res = await fetch(endpoint, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })
      const ms = Date.now() - started
      const reason = res.ok ? '' : (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)
      if (res.ok) stats.sent++
      else stats.failed++
      const gone = res.status === 404 || res.status === 410
      if (gone) stats.gone++
      log('push sent', { hostId, id: String(m.id ?? '').slice(0, 40), service, status: res.status, bytes: body.length, ttl, urgency, ms, ...(topic ? { topic: true } : {}), ...(reason ? { reason } : {}) })
      return { status: res.status, ms, ...(gone ? { gone: true } : {}), ...(reason ? { error: reason } : {}) }
    } catch (e) {
      stats.failed++
      const error = String(e?.name === 'TimeoutError' ? `no answer in ${SEND_TIMEOUT_MS / 1000} s` : (e?.message ?? e)).slice(0, 160)
      log('push failed', { hostId, id: String(m.id ?? '').slice(0, 40), service, error })
      return { status: 0, error }
    } finally {
      stats.inflight--
    }
  }

  log('push on', { keys: keys.source, subject, publicKey: `${publicKey.slice(0, 12)}…`, ...(extra.length ? { extraHosts: extra } : {}) })
  return { enabled: true, publicKey, bind, send, status: () => ({ enabled: true, ...stats }) }
}
