import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, networkInterfaces, tmpdir } from 'node:os'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { staticIce } from './ice.mjs'
import { createLimiter } from './rate.mjs'
import { bearerOf, createGate, GATE_REASONS, ticketVerifier } from './gate.mjs'
import { hostChallenge, hostIdForKey, verifyHostProof } from './host-auth.mjs'
import { createProxyTrust, ipKey, plainIp } from './proxy.mjs'
import { createOwners } from './owners.mjs'
import { loadPlugin } from './plugin.mjs'
import { createPush } from './push.mjs'
import { createSite, siteRoot } from './site.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const env = process.env
const port = Number(env.PORT ?? 8790)
const devMode = env.SATURA_RELAY_DEV === '1'
const appRoot = pickAppRoot()
const jsonLogs = env.SATURA_RELAY_LOG === 'json'
const trustProxy = env.SATURA_RELAY_TRUST_PROXY === '1'
const devToken = String(env.SATURA_RELAY_DEV_TOKEN ?? '') || (env.SATURA_RELAY_DEV === '1' ? randomBytes(18).toString('base64url') : '')
const icePolicy = env.SATURA_RELAY_ICE_POLICY === 'relay' ? 'relay' : 'all'
const testIps = loadTestIps(env.SATURA_RELAY_TEST_IPS)
const started = Date.now()
const HELLO_TIMEOUT_MS = 10_000
const HEARTBEAT_MS = Number(env.SATURA_RELAY_HEARTBEAT_MS ?? 5000)
const MB = 1024 * 1024
const HOST_MAX_BYTES = Number(env.SATURA_RELAY_HOST_MAX_BYTES ?? 24 * MB)
const PHONE_MAX_BYTES = Number(env.SATURA_RELAY_PHONE_MAX_BYTES ?? 8 * MB)
const IN_BUDGET_BYTES = Number(env.SATURA_RELAY_IN_BUDGET_MB ?? 160) * MB
const OUT_BUDGET_BYTES = Number(env.SATURA_RELAY_OUT_BUDGET_MB ?? 160) * MB
const PHONE_OUT_MAX_BYTES = Number(env.SATURA_RELAY_PHONE_OUT_MAX_MB ?? 40) * MB
const HOST_OUT_MAX_BYTES = Number(env.SATURA_RELAY_HOST_OUT_MAX_MB ?? 48) * MB
const MAX_HOSTS_PER_IP = Number(env.SATURA_RELAY_MAX_HOSTS_PER_IP ?? 8)
const ALLOWANCE_PUSH_MS = Number(env.SATURA_RELAY_ALLOWANCE_PUSH_MS ?? 15_000)
const ALLOWANCE_WIRE = 1
const HELLO_MAX_BYTES = 64 * 1024
const PRE_ADMIT_BYTES = 256 * 1024
const MAX_SOCKETS_PER_IP = Number(env.SATURA_RELAY_MAX_SOCKETS_PER_IP ?? 64)
const SILENT_MS = HEARTBEAT_MS + 2000
const SILENT_MEMORY_MS = 10 * 60_000
const DRAIN_MS = Number(env.SATURA_RELAY_DRAIN_MS ?? 2000)
const HOST_ID = /^[a-z0-9]{6,32}$/
const TURN_REPORT_MAX = 10 * 1024 * 1024 * 1024
const GONE_PHONE_MS = 10 * 60_000
const publicWeb = cleanWebBase(env.SATURA_RELAY_PUBLIC_WEB)
const APP_MANIFEST = '/satura-remote.json'
const PHONE_CONFIG = '/phone-config.json'
const PRESENCE_MAX = 16
const CORS_MAX_AGE_S = 600
const E2E_FRAME = 0x45
const E2E_CID_CHARS = 8
const E2E_MIN_BYTES = 26
const HANDSHAKE_FRAMES = 4
const NET_PROBE_MS = 30_000
const NET_REPROBE_MS = Number(env.SATURA_RELAY_NET_REPROBE_MS ?? 10 * 60_000)
const NET_KEEP_MS = NET_REPROBE_MS * 2.5
const NET_WAIT_MS = 3000
const NET_MAX = 4
const NET_PROBE_USES = 6
const TEST_IP_COOKIE = 'satura-test-ip'
const UPDATE_REASONS = {
  update: 'Update Satura on your desktop to use Satura Remote.',
  relay: 'Satura on your desktop is newer than Satura Remote on this phone. An update is on its way.'
}

const hosts = new Map()
const phones = new Map()
const probeTokens = new Map()
const socketsByIp = new Map()
const limits = {
  connect: createLimiter(Number(env.SATURA_RELAY_CONNECTS_PER_MIN ?? 120), 60_000),
  pairIp: createLimiter(Number(env.SATURA_RELAY_PAIR_PER_IP ?? 10), 10 * 60_000),
  pairHost: createLimiter(Number(env.SATURA_RELAY_PAIR_PER_HOST ?? 60), 10 * 60_000),
  pairClient: createLimiter(Number(env.SATURA_RELAY_PAIR_FAILS_PER_CLIENT ?? 5), 10 * 60_000),
  hostHello: createLimiter(30, 60_000),
  web: createLimiter(Number(env.SATURA_RELAY_WEB_PER_MIN ?? 1200), 60_000),
  authAsk: createLimiter(Number(env.SATURA_RELAY_AUTH_LOOKUPS_PER_MIN ?? 30), 60_000),
  phoneLog: createLimiter(240, 60_000),
  phoneLogSource: createLimiter(Number(env.SATURA_RELAY_PHONE_LOGS_PER_MIN ?? 600), 60_000),
  videoHello: createLimiter(Number(env.SATURA_RELAY_VIDEO_HELLOS_PER_MIN ?? 30), 60_000),
  logLine: createLimiter(20, 60_000)
}
const gonePhones = new Map()
const hostKeys = new Map()
const HOST_KEY_MEMORY_MS = 7 * 24 * 3600_000
const HOST_KEY_MEMORY_MAX = 100_000
const silentHosts = new Map()
const hostsByIp = new Map()
let draining = false
let inHeld = 0
const shed = { in: 0, out: 0, slow: 0 }

function log(msg, fields) {
  if (jsonLogs) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...fields }))
    return
  }
  const tail = fields ? Object.entries(fields).map(([k, v]) => ` ${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('') : ''
  console.log(`${new Date().toISOString()} ${msg}${tail}`)
}

function logLimited(key, msg, fields) {
  if (limits.logLine.take(`${msg}|${key}`)) log(msg, fields)
}

function redact(text) {
  return String(text)
    .replace(/([?&#](?:pair|ticket)=)[^&\s"']+/gi, '$1<redacted>')
    .replace(/\bv1\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, 'v1.<redacted>')
    .replace(/\b([a-z0-9]{6,32}):[0-9a-f]{8,64}\b/g, '$1:<redacted>')
    .replace(/("?phoneKey"?\s*[:=]\s*"?)[\w-]+/g, '$1<redacted>')
}

function logTime(at) {
  const d = new Date(num(at) || Date.now())
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

function parseFrame(text) {
  try {
    const m = JSON.parse(text)
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null
  } catch {
    return null
  }
}

function str(v) {
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
}

function num(v) {
  return typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN
}

function safe(ws, fn) {
  return (data, isBinary) => {
    try {
      fn(data, isBinary)
    } catch (e) {
      log('frame error', { role: ws.role ?? '-', error: str(e?.message) || 'unknown' })
      ws.close(1011, 'internal error')
    }
  }
}

function capFrames(ws, bytes) {
  if (ws._receiver && typeof ws._receiver._maxPayload === 'number') ws._receiver._maxPayload = bytes
}

function closeReason(text, fallback) {
  return str(text).replace(/[^\x20-\x7e]/g, '').slice(0, 100) || fallback
}

function pickAppRoot() {
  if (env.SATURA_RELAY_APP) return env.SATURA_RELAY_APP === 'off' ? null : siteRoot(resolve(env.SATURA_RELAY_APP))
  return siteRoot(resolve(join(here, '../m/app'))) ?? (devMode ? siteRoot(resolve(join(here, '../../../../apps/orchestrator/out/remote'))) : null)
}

function appInfo() {
  const f = site?.file(APP_MANIFEST)
  if (!f) return null
  try {
    const j = JSON.parse(readFileSync(f.file, 'utf8'))
    return { protocol: Number(j.protocol) || 0, minHost: Number(j.minHost) || 0, version: String(j.version ?? '') }
  } catch {
    return null
  }
}

function fitFor(phone, host) {
  if (host.protocol < phone.minHost) return 'update'
  if (phone.protocol < host.minPhone) return 'relay'
  return 'ok'
}

function cleanWebBase(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  try {
    const u = new URL(text)
    return /^https?:$/.test(u.protocol) ? u.origin : null
  } catch {
    return null
  }
}

const gate = createGate({ authUrl: env.SATURA_RELAY_AUTH_URL, allowEmails: env.SATURA_RELAY_ALLOW_EMAILS, ticketKey: env.SATURA_RELAY_TICKET_KEY, ttlMs: Number(env.SATURA_RELAY_AUTH_TTL_MS ?? 30_000), log })
const proxy = createProxyTrust({ enabled: trustProxy, file: env.SATURA_RELAY_CF_IPS_FILE ?? '', peers: env.SATURA_RELAY_PROXY_PEERS ?? '', log })
const allowedOrigins = new Set([publicWeb, ...String(env.SATURA_RELAY_ORIGINS ?? '').split(',').map((o) => cleanWebBase(o))].filter(Boolean))
const site = appRoot ? createSite(appRoot, { headersFor: siteHeaders }) : null

const ice = staticIce(env.SATURA_RELAY_ICE_SERVERS, log)
const owners = createOwners({ file: env.SATURA_RELAY_OWNERS_FILE ? resolve(env.SATURA_RELAY_OWNERS_FILE) : null, log })
const plugin = await loadPlugin(env.SATURA_RELAY_PLUGIN ?? '', {
  env,
  log,
  logLimited,
  devMode,
  isLoopback,
  status: () => relayStatus(),
  core: { createGate, GATE_REASONS, ticketVerifier, bearerOf, createLimiter, ipKey, staticIce: () => ({ iceServers: ice.servers, source: ice.source }) }
})
const accountsOn = plugin.has('authorize') || gate.enabled
const push = createPush({ env, devMode, publicWeb, log, logLimited, createLimiter })

function count(account, kind, bytes) {
  if (account === undefined || !(bytes > 0)) return
  plugin.callSync('onUsage', [account, kind, bytes], null)
}

function relayStatus() {
  const mem = process.memoryUsage()
  return { uptime: Math.round((Date.now() - started) / 1000), hosts: hosts.size, phones: phones.size, sockets: wss?.clients.size ?? 0, heapMB: Math.round(mem.heapUsed / MB), rssMB: Math.round(mem.rss / MB), externalMB: Math.round(mem.external / MB), inHeldMB: Math.round(inHeld / MB), shed: { ...shed }, gate: gate.stats(), proxy: proxy.status(), owners: owners.size(), plugin: plugin.status(), push: push.status(), draining }
}

function sendBinary(ws, bytes, account) {
  if (ws.readyState !== ws.OPEN) return false
  const cap = ws.role === 'host' ? HOST_OUT_MAX_BYTES : PHONE_OUT_MAX_BYTES
  if (ws.bufferedAmount + bytes.length > cap) {
    shed.slow++
    logLimited(ws.ipKey ?? '-', 'socket backed up, closing it', { role: ws.role ?? '-', bufferedKB: Math.round(ws.bufferedAmount / 1024), ...(ws.hostId ? { hostId: ws.hostId } : {}) })
    ws.close(1013, 'backed up')
    setTimeout(() => ws.terminate(), 2000).unref()
    return false
  }
  ws.send(bytes, { binary: true })
  const who = account ?? ws.account
  if (who !== undefined) count(who, 'wsOut', bytes.length)
  return true
}

function send(ws, msg, account) {
  if (ws.readyState !== ws.OPEN) return false
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg)
  const bytes = Buffer.byteLength(text)
  const cap = ws.role === 'host' ? HOST_OUT_MAX_BYTES : PHONE_OUT_MAX_BYTES
  if (ws.bufferedAmount + bytes > cap) {
    shed.slow++
    logLimited(ws.ipKey ?? '-', 'socket backed up, closing it', { role: ws.role ?? '-', bufferedKB: Math.round(ws.bufferedAmount / 1024), ...(ws.hostId ? { hostId: ws.hostId } : {}) })
    ws.close(1013, 'backed up')
    setTimeout(() => ws.terminate(), 2000).unref()
    return false
  }
  ws.send(text)
  const who = account ?? ws.account
  if (who !== undefined) count(who, 'wsOut', bytes)
  return true
}

function meterIn(ws) {
  const raw = ws._socket
  const rx = ws._receiver
  if (!raw || !rx) return
  ws.inHeld = 0
  const update = () => {
    const held = Math.max(Number(rx._bufferedBytes) || 0, Number(rx._totalPayloadLength) || 0)
    inHeld += held - ws.inHeld
    ws.inHeld = held
  }
  raw.on('data', () => {
    update()
    if (inHeld > IN_BUDGET_BYTES) shedIn()
  })
  ws.on('message', update)
  ws.once('close', () => {
    inHeld -= ws.inHeld
    ws.inHeld = 0
  })
}

function shedIn() {
  let worst = null
  for (const ws of wss.clients) if (!worst || (ws.inHeld ?? 0) > (worst.inHeld ?? 0)) worst = ws
  if (!worst || !worst.inHeld) return
  shed.in++
  logLimited('budget', 'inbound budget full, dropping the biggest sender', { role: worst.role ?? '-', heldMB: Math.round(worst.inHeld / MB), totalMB: Math.round(inHeld / MB) })
  inHeld -= worst.inHeld
  worst.inHeld = 0
  worst.terminate()
}

function shedOut() {
  let total = 0
  let worst = null
  for (const ws of wss.clients) {
    const b = ws.bufferedAmount
    total += b
    if (!worst || b > worst.bufferedAmount) worst = ws
  }
  if (total <= OUT_BUDGET_BYTES || !worst) return total
  shed.out++
  logLimited('budget', 'outbound budget full, dropping the slowest reader', { role: worst.role ?? '-', bufferedMB: Math.round(worst.bufferedAmount / MB), totalMB: Math.round(total / MB) })
  worst.terminate()
  return total
}

function phoneAccount(hostId, cid) {
  const p = phones.get(cid)
  if (p) return p.hostId === hostId ? p.account : undefined
  const gone = gonePhones.get(cid)
  return gone && gone.hostId === hostId && Date.now() - gone.at < GONE_PHONE_MS ? gone.account : undefined
}

function rememberGone(p) {
  const now = Date.now()
  for (const [cid, g] of gonePhones) if (now - g.at >= GONE_PHONE_MS) gonePhones.delete(cid)
  gonePhones.set(p.cid, { hostId: p.hostId, account: p.account, at: now })
}

function hostIn(account, bytes) {
  count(account, 'wsIn', bytes)
}

function onTurnUsage(host, m) {
  const account = phoneAccount(host.hostId, str(m.cid))
  if (account === undefined) return
  const out = {}
  for (const key of ['tx', 'rx', 'egress']) {
    const n = num(m[key])
    out[key] = Number.isFinite(n) && n > 0 && n <= TURN_REPORT_MAX ? Math.round(n) : 0
  }
  if (out.tx || out.rx || out.egress) plugin.callSync('onTurnUsage', [account, out], null)
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function loadTestIps(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const why = env.NODE_ENV === 'production' ? 'NODE_ENV is production' : !devMode ? 'SATURA_RELAY_DEV is not 1' : trustProxy ? 'SATURA_RELAY_TRUST_PROXY is on' : ''
  if (why) {
    console.error(`refusing to start: SATURA_RELAY_TEST_IPS only works on a local test relay, and ${why}`)
    process.exit(1)
  }
  const map = new Map()
  for (const part of text.split(',')) {
    const at = part.indexOf('=')
    const from = plainIp(part.slice(0, at).trim())
    const to = plainIp(part.slice(at + 1).trim())
    if (at > 0 && isLoopback(from) && isIP(to)) map.set(from, to)
  }
  return map
}

function testIp(req) {
  if (!testIps) return null
  const peer = plainIp(req.socket?.remoteAddress)
  if (!isLoopback(peer)) return null
  const cookie = new RegExp(`(?:^|;\\s*)${TEST_IP_COOKIE}=([^;]+)`).exec(String(req.headers.cookie ?? ''))
  const given = cookie ? plainIp(decodeURIComponent(cookie[1]).trim()) : ''
  if (isIP(given)) return given
  return testIps.get(peer) ?? null
}

function clientIp(req) {
  return testIp(req) ?? proxy.clientIp(req)
}

function familyOf(ip) {
  return isIP(plainIp(ip)) === 6 ? 6 : 4
}

function headerText(v, max) {
  return str(Array.isArray(v) ? v[0] : v).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max)
}

function placeOf(req) {
  const via = proxy.viaCloudflare(req)
  const place = { ip: clientIp(req) }
  if (!via.trusted) return place
  const country = headerText(req.headers['cf-ipcountry'], 2).toUpperCase()
  if (/^[A-Z]{2}$/.test(country) && country !== 'XX') place.country = country
  const region = headerText(req.headers['cf-region'], 80) || headerText(req.headers['cf-region-code'], 10)
  if (region) place.region = region
  const city = headerText(req.headers['cf-ipcity'], 80)
  if (city) place.city = city
  return place
}

function devAllowed(req) {
  if (!devMode || !devToken) return false
  const given = String(req.headers['x-satura-dev-token'] ?? '')
  if (!given) return false
  if (req.headers.origin !== undefined && !originAllowed(req)) return false
  if (str(req.headers['sec-fetch-site']) === 'cross-site') return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(devToken).digest()
  return timingSafeEqual(a, b)
}

function devBodyType(req, want) {
  return str(req.headers['content-type']).split(';')[0].trim().toLowerCase() === want
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 1e6) req.destroy()
    })
    req.on('end', () => ok(body))
    req.on('error', fail)
  })
}

function saveShot(url, req, res) {
  const name = (url.searchParams.get('name') || 'shot').replace(/[^\w.-]/g, '_').slice(0, 60)
  const dir = env.SATURA_RELAY_SHOTS || join(tmpdir(), 'satura-relay-shots')
  const chunks = []
  let size = 0
  req.on('data', (c) => {
    size += c.length
    if (size > 12e6) req.destroy()
    else chunks.push(c)
  })
  req.on('end', () => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${name}.jpg`)
    writeFileSync(file, Buffer.concat(chunks))
    log(`[dev] shot ${file} ${Math.round(size / 1024)} KB`)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ file }))
  })
  return true
}

async function devRoute(url, req, res) {
  if (!devAllowed(req)) return false
  if (req.method === 'POST' && !devBodyType(req, url.pathname === '/dev/shot' ? 'image/jpeg' : 'application/json')) return res.writeHead(415, { 'cache-control': 'no-store' }).end(), true
  if (url.pathname === '/dev/shot' && req.method === 'POST') return saveShot(url, req, res)
  if (url.pathname === '/dev/phones') {
    const list = [...phones.values()].map((p) => ({ cid: p.cid, hostId: p.hostId, accepted: p.accepted, phoneId: p.phoneId, ua: p.ua, place: p.place, account: p.account, scope: p.scope, net: p.ipKey, hostNets: hosts.get(p.hostId) ? [...hosts.get(p.hostId).nets.keys()] : [] }))
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list))
    return true
  }
  if (url.pathname === '/dev/drop' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}')
    const list = body.hosts ? [...hosts.values()] : [...phones.values()].filter((p) => !body.cid || body.cid === p.cid)
    for (const c of list) c.ws.terminate()
    log(`[dev] dropped ${list.length} ${body.hosts ? 'desktop' : 'phone'} socket(s) the way a network change does`)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ dropped: list.length }))
    return true
  }
  if (url.pathname === '/dev/test-ips' && req.method === 'POST' && testIps) {
    const body = JSON.parse((await readBody(req)) || '{}')
    for (const [from, to] of Object.entries(body.map ?? {})) if (isLoopback(plainIp(from)) && isIP(plainIp(String(to)))) testIps.set(plainIp(from), plainIp(String(to)))
    log(`[dev] test addresses now ${[...testIps].map(([a, b]) => `${a}=${b}`).join(',')}`)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Object.fromEntries(testIps)))
    return true
  }
  if (url.pathname === '/dev/drive' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}')
    let n = 0
    for (const p of phones.values()) {
      if (!p.accepted || (body.cid && body.cid !== p.cid)) continue
      send(p.ws, { ...body, t: 'drive' })
      n++
    }
    log(`[dev] drive ${JSON.stringify(body)} -> ${n} phone(s)`)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sent: n }))
    return true
  }
  return false
}

function phonePageHeaders(req) {
  const host = requestHost(req)
  const sockets = host ? ` wss://${host} ws://${host}` : ''
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src 'self'${sockets}`,
    "worker-src 'self'",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ].join('; ')
  return {
    'content-security-policy': csp,
    'x-frame-options': 'SAMEORIGIN',
    'cross-origin-opener-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'permissions-policy': 'camera=(self), microphone=(), geolocation=()'
  }
}

function siteHeaders(req, rel) {
  if (!rel.endsWith('.html')) return {}
  if (rel.split('/').includes('report-frame')) return { 'content-security-policy': "frame-ancestors 'self'; object-src 'none'; base-uri 'none'" }
  return phonePageHeaders(req)
}

function requestHost(req) {
  const host = String(req.headers.host ?? '').toLowerCase()
  return /^[a-z0-9.\-:\[\]]{1,255}$/.test(host) ? host : ''
}

function servePhoneConfig(req, res) {
  const host = requestHost(req)
  if (!host) return res.writeHead(400, { 'cache-control': 'no-store' }).end()
  const tls = req.socket.encrypted || headerText(req.headers['x-forwarded-proto'], 10).toLowerCase() === 'https'
  const body = JSON.stringify({ relay: `${tls ? 'wss' : 'ws'}://${host}/ws`, account: null })
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(body)
}

async function gateCheck(req, what, quiet, ip, ticket) {
  if (!accountsOn) return { state: 'ok' }
  const key = ipKey(ip)
  const mayAsk = () => limits.authAsk.take(key)
  const r = plugin.has('authorize') ? await plugin.call('authorize', [{ req, ip, ipKey: key, what, mayAsk, ticket }], { state: 'error', gated: true }) : await gate.check(ticket, mayAsk)
  if (!r || typeof r.state !== 'string') return { state: 'error', gated: true }
  if (r.throttled) {
    logLimited(key, 'gate throttled', { what, ip })
    return r
  }
  if (r.gated && !(quiet && r.state === 'ok')) logLimited(`${key}|${r.state}|${r.why ?? ''}`, 'gate', { what, state: r.state, ...(r.why ? { ticket: r.why } : {}), ...(r.email ? { email: r.email } : {}) })
  return r
}

function knowsHost(hostId, account) {
  return !accountsOn || owners.has(hostId, account)
}

function hostState(hostId) {
  const host = hosts.get(hostId)
  if (host) return Date.now() - (host.ws.seenAt ?? 0) > SILENT_MS ? 'silent' : 'up'
  const at = silentHosts.get(hostId)
  return at && Date.now() - at < SILENT_MEMORY_MS ? 'silent' : 'gone'
}

function rememberSilent(hostId) {
  const now = Date.now()
  for (const [id, at] of silentHosts) if (now - at >= SILENT_MEMORY_MS) silentHosts.delete(id)
  silentHosts.set(hostId, now)
}

function presenceOf(ids, account, phone) {
  const info = phone ?? appInfo()
  const out = {}
  for (const id of ids) {
    if (!knowsHost(id, account)) {
      out[id] = { state: 'unknown', fit: null }
      continue
    }
    const host = hosts.get(id)
    out[id] = { state: hostState(id), fit: host && info ? fitFor(info, host) : null }
  }
  return out
}

function corsHeaders(req) {
  const origin = cleanWebBase(req.headers.origin)
  return { vary: 'Origin', ...(origin && origin === str(req.headers.origin) && allowedOrigins.has(origin) ? { 'access-control-allow-origin': origin } : {}) }
}

function phoneFit(url) {
  const protocol = Number(url.searchParams.get('protocol'))
  if (!Number.isInteger(protocol) || protocol <= 0) return null
  const minHost = Number(url.searchParams.get('minHost'))
  return { protocol, minHost: Number.isInteger(minHost) && minHost > 0 ? minHost : protocol }
}

async function servePresence(url, req, res, ip) {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') {
    const allowed = 'access-control-allow-origin' in cors
    return res.writeHead(204, { ...cors, 'cache-control': 'no-store', ...(allowed ? { 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'authorization', 'access-control-max-age': String(CORS_MAX_AGE_S) } : {}) }).end()
  }
  const json = (status, body, extra) => res.writeHead(status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra }).end(JSON.stringify(body))
  if (req.method !== 'GET') return json(405, { hosts: {} }, { allow: 'GET, OPTIONS' })
  const access = await gateCheck(req, 'presence', true, ip, bearerOf(req))
  if (access.throttled) return json(429, { hosts: {} }, { 'retry-after': '20' })
  if (access.state === 'signin') return json(401, { hosts: {} }, { 'www-authenticate': 'Bearer' })
  if (access.state === 'denied') return json(403, { hosts: {} })
  if (access.state !== 'ok') return json(503, { hosts: {} })
  const ids = [...new Set(str(url.searchParams.get('h')).split(','))].filter((id) => HOST_ID.test(id)).slice(0, PRESENCE_MAX)
  json(200, { hosts: presenceOf(ids, access.email ?? '', phoneFit(url)) })
}

const server = createServer(async (req, res) => {
  let path = null
  try {
    const url = new URL(req.url ?? '/', 'http://relay')
    path = url.pathname
    const ip = clientIp(req)
    if (url.pathname === '/net/probe') {
      if (!limits.web.take(ipKey(ip))) return void res.writeHead(429, { 'retry-after': '30', 'cache-control': 'no-store' }).end()
      return serveProbe(url, req, res, ip)
    }
    if (url.pathname === '/health') {
      res.writeHead(draining ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: !draining, uptime: Math.round((Date.now() - started) / 1000), hosts: hosts.size, phones: phones.size, turn: ice.source === 'static-turn' || plugin.status()?.turn === true, plugin: plugin.enabled, push: push.enabled }))
      return
    }
    if (!limits.web.take(ipKey(ip))) return void res.writeHead(429, { 'retry-after': '30', 'cache-control': 'no-store' }).end()
    if (plugin.has('route') && (await plugin.call('route', [url, req, res, { ip, ipKey: ipKey(ip) }], false))) return
    if (res.headersSent || res.writableEnded) return
    if (url.pathname.startsWith('/dev/') && (await devRoute(url, req, res))) return
    if (url.pathname === '/presence') return void (await servePresence(url, req, res, ip))
    if (site && url.pathname === PHONE_CONFIG && (req.method === 'GET' || req.method === 'HEAD')) return servePhoneConfig(req, res)
    if (site && site.serve(url, req, res)) return
    if (!site && publicWeb && url.pathname === '/' && req.method === 'GET') return void res.writeHead(302, { location: `${publicWeb}/m/`, 'cache-control': 'no-store' }).end()
    res.writeHead(404, { 'cache-control': 'no-store' }).end()
  } catch (e) {
    log('http error', { path: path ?? '-', error: str(e?.message) || 'unknown' })
    if (!res.headersSent) res.writeHead(path === null || e instanceof URIError ? 400 : 500)
    res.end()
  }
})

function onHostMessage(host, text, bytes = Buffer.byteLength(text)) {
  const m = parseFrame(text)
  if (!m) return
  if (m.t === 'turn-usage') return onTurnUsage(host, m)
  if (m.t === 'phone-accept' || m.t === 'phone-reject') {
    const p = phones.get(m.cid)
    if (!p || p.hostId !== host.hostId) return
    hostIn(p.account, bytes)
    if (m.t === 'phone-reject') {
      if (p.pairing && m.code !== 'busy') {
        limits.pairClient.take(p.pairKey)
        limits.pairHost.take(host.hostId)
      }
      log('phone rejected', { cid: p.cid, hostId: host.hostId, reason: str(m.reason).slice(0, 200) })
      if (!p.pairing && m.code !== 'busy' && !knowsHost(host.hostId, p.account)) {
        send(p.ws, { t: 'host-left', reason: 'closed' })
        setTimeout(() => p.ws.close(4004, 'host offline'), 200)
        return
      }
      const known = knowsHost(host.hostId, p.account)
      send(p.ws, { t: 'reject', reason: str(m.reason).slice(0, 200), ...(m.code ? { code: str(m.code).slice(0, 20), ...(known && m.device ? { device: str(m.device).slice(0, 60) } : {}) } : {}) })
      setTimeout(() => p.ws.close(4003, 'rejected'), 200)
      return
    }
    if (p.accepted) return
    p.accepted = true
    p.phoneId = m.phoneId
    p.pairing = false
    capFrames(p.ws, PHONE_MAX_BYTES)
    host.phones.add(p.cid)
    if (accountsOn) owners.note(host.hostId, p.account)
    log('phone accepted', { cid: p.cid, hostId: host.hostId, phoneId: m.phoneId, scope: p.scope, ...(p.scope === 'local' ? { net: p.ipKey } : {}) })
    send(p.ws, { t: 'welcome', hostId: host.hostId, phoneId: str(m.phoneId).slice(0, 64), ping: 1, access: p.scope, ...(push.enabled ? { push: { key: push.publicKey } } : {}) })
    pushAllowance(p, true)
    return
  }
  if (m.t === 'ping') return send(host.ws, { t: 'pong' })
  if (m.t === 'push') return pushFromHost(host, m)
  if (m.t === 'phone-hs') {
    const p = phones.get(m.cid)
    if (!p || p.hostId !== host.hostId || p.accepted || ++p.hsFrames > HANDSHAKE_FRAMES) return
    hostIn(p.account, bytes)
    send(p.ws, { t: 'hs', ...(m.e2e && typeof m.e2e === 'object' ? { e2e: m.e2e } : {}), ...(m.wait === 'allow' ? { wait: 'allow' } : {}) })
    return
  }
  if (m.t === 'phone-kick') {
    const p = phones.get(m.cid)
    if (!p || p.hostId !== host.hostId) return
    hostIn(p.account, bytes)
    log('phone dropped', { cid: p.cid, hostId: host.hostId, reason: m.reason })
    host.phones.delete(p.cid)
    p.accepted = false
    if (m.reason === 'removed') {
      send(p.ws, { t: 'reject', code: 'removed', reason: 'This desktop removed this phone. Pair it again with a new code.' })
      p.ws.close(4003, 'removed')
      return
    }
    if (m.reason === 'integrity') return p.ws.close(4009, 'integrity')
    p.ws.close(4006, closeReason(m.reason, 'replaced'))
  }
}

function pushFromHost(host, m) {
  const id = str(m.id).slice(0, 40)
  void push.send(host.hostId, m).then((r) => send(host.ws, { t: 'push-result', id, status: r.status, ...(r.gone ? { gone: true } : {}), ...(r.error ? { error: r.error } : {}) }))
}

function bindPush(p, m) {
  const endpoint = str(m.endpoint)
  if (!push.enabled) return send(p.ws, { t: 'push-bound', endpoint, error: "This relay can't send notifications." })
  const r = push.bind(p.hostId, p.account || p.ipKey, endpoint)
  logLimited(p.cid, 'push bind', { cid: p.cid, hostId: p.hostId, ok: !r.error, ...(r.error ? { error: r.error } : { service: new URL(endpoint).hostname }) })
  send(p.ws, { t: 'push-bound', endpoint, ...(r.error ? { error: r.error } : { token: r.token, key: push.publicKey }) })
}

function onHostBinary(host, data) {
  if (data.length < E2E_MIN_BYTES + E2E_CID_CHARS || data[0] !== E2E_FRAME) return
  const cid = data.subarray(1, 1 + E2E_CID_CHARS).toString('latin1')
  const p = phones.get(cid)
  if (!p || !p.accepted || p.hostId !== host.hostId) return
  hostIn(p.account, data.length)
  const out = Buffer.allocUnsafe(data.length - E2E_CID_CHARS)
  out[0] = E2E_FRAME
  data.copy(out, 1, 1 + E2E_CID_CHARS)
  sendBinary(p.ws, out)
}

function onPhoneBinary(p, data) {
  if (!p.accepted || data.length < E2E_MIN_BYTES || data[0] !== E2E_FRAME) return
  const host = hosts.get(p.hostId)
  if (!host) return
  if (host.ws.bufferedAmount + data.length > HOST_OUT_MAX_BYTES / 2) {
    shed.slow++
    logLimited(p.cid, 'mac socket backed up, closing the phone', { cid: p.cid, hostId: host.hostId, bufferedKB: Math.round(host.ws.bufferedAmount / 1024) })
    return p.ws.close(1013, 'mac backed up')
  }
  const out = Buffer.allocUnsafe(data.length + E2E_CID_CHARS)
  out[0] = E2E_FRAME
  out.write(p.cid, 1, E2E_CID_CHARS, 'latin1')
  data.copy(out, 1 + E2E_CID_CHARS, 1)
  sendBinary(host.ws, out, p.account)
}

function pushAllowance(p, force = false) {
  if (!p.accepted || p.scope === 'local' || p.ws.readyState !== p.ws.OPEN || !plugin.has('allowance')) return
  const a = plugin.callSync('allowance', [p.account], null)
  if (!a || typeof a !== 'object') return
  const text = JSON.stringify({ ...a, t: 'allowance', v: ALLOWANCE_WIRE })
  const shape = `${Math.floor(a.usedBytes / 5e6)}|${a.allowanceBytes}|${a.overQuota}|${a.blocked}|${a.period}`
  if (!force && shape === p.allowanceShape) return
  p.allowanceShape = shape
  send(p.ws, text)
}

function videoRefused(p, host, session, why, code, resetAt) {
  logLimited(p.account || p.cid, 'video refused', { cid: p.cid, account: p.account || '-', code, why })
  send(host.ws, { t: 'video-deny', cid: p.cid, session: p.videoSession || session }, p.account)
  p.videoSession = ''
  send(p.ws, { t: 'video-refused', code, reason: why, session, ...(Number(resetAt) > 0 ? { resetAt: Number(resetAt) } : {}) })
  pushAllowance(p, true)
}

function withoutTurn(list) {
  const out = []
  for (const s of list) {
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === 'string' && /^stuns?:/.test(u))
    if (urls.length) out.push({ urls })
  }
  return out
}

function grantVideo(p, host, m) {
  const session = str(m.session).slice(0, 64)
  if (!session) return
  const local = p.scope === 'local'
  const policy = !local && (m.policy === 'relay' || icePolicy === 'relay') ? 'relay' : 'all'
  const may = plugin.callSync('canUse', [p.account, 'video', { scope: p.scope }], { ok: true })
  if (may && may.ok === false) return videoRefused(p, host, session, str(may.reason).slice(0, 300) || "Video isn't available on this account right now.", str(may.code).slice(0, 20) || 'refused', may.resetAt)
  if (!limits.videoHello.take(p.account || p.cid)) return videoRefused(p, host, session, 'Video restarted too often. Wait a minute and try again.', 'rate')
  const grant = (list, source) => {
    const iceServers = local ? withoutTurn(list) : list
    logLimited(p.cid, 'video ice', { cid: p.cid, hostId: host.hostId, source, policy, scope: p.scope, turn: iceServers.some((s) => s.username), account: p.account || '-' })
    if (!p.accepted || hosts.get(p.hostId) !== host) return
    p.videoSession = session
    send(host.ws, { t: 'video-grant', cid: p.cid, session, iceServers, ...(policy === 'relay' ? { iceTransportPolicy: 'relay' } : {}) }, p.account)
  }
  plugin
    .call('iceFor', [p.account, { cid: p.cid, hostId: host.hostId, policy, scope: p.scope }], null)
    .then((got) => {
      const mine = Array.isArray(got?.iceServers) && got.iceServers.length
      grant(mine ? got.iceServers : ice.servers, mine ? str(got.source) || 'plugin' : ice.source)
    })
    .catch((e) => {
      log('video ice error', { cid: p.cid, error: str(e?.message) || 'unknown' })
      grant(ice.servers, ice.source)
    })
}

function onPhoneMessage(p, text) {
  const m = parseFrame(text)
  if (!m) return
  if (m.t === 'log') {
    if (!limits.phoneLog.take(p.cid) || !limits.phoneLogSource.take(p.account || p.ipKey)) return
    const line = redact(str(m.text).slice(0, 4000))
    if (jsonLogs) console.log(JSON.stringify({ ts: logTime(m.at), msg: 'phone log', cid: p.cid, level: str(m.level).slice(0, 20), text: line }))
    else console.log(`${logTime(m.at)} [phone ${p.cid}] ${str(m.level).slice(0, 20)}: ${line}`)
    return
  }
  if (m.t === 'ping') return send(p.ws, { t: 'pong', id: num(m.id) || 0, ...(p.accepted ? { host: hostState(p.hostId) } : {}) })
  const host = hosts.get(p.hostId)
  if (m.t === 'hs' && !p.accepted && host && ++p.hsFrames <= HANDSHAKE_FRAMES) return send(host.ws, { t: 'phone-hs', cid: p.cid, e2e: m.e2e }, p.account)
  if (!p.accepted) return
  if (m.t === 'allowance') return pushAllowance(p, true)
  if (m.t === 'push-bind') return bindPush(p, m)
  if (m.t === 'video-ask' && host) return grantVideo(p, host, m)
}

function noteNet(host, ip, via) {
  const key = ipKey(ip)
  const known = host.nets.get(key)
  if (known) {
    known.at = Date.now()
    return false
  }
  if (host.nets.size >= NET_MAX) {
    let oldest = null
    for (const [k, n] of host.nets) if (n.via === 'probe' && (!oldest || n.at < host.nets.get(oldest).at)) oldest = k
    if (!oldest) return false
    host.nets.delete(oldest)
  }
  host.nets.set(key, { at: Date.now(), via, family: familyOf(ip) })
  return true
}

function sameNetwork(host, ip) {
  return !!host && host.nets.has(ipKey(ip))
}

function netsText(host) {
  return [...host.nets.keys()].join(' ')
}

function issueProbe(host) {
  if (host.probe) probeTokens.delete(host.probe.token)
  const token = randomBytes(18).toString('base64url')
  host.probe = { token, at: Date.now(), uses: 0 }
  probeTokens.set(token, host)
  send(host.ws, { t: 'net-probe', token, path: '/net/probe' })
}

function serveProbe(url, req, res, ip) {
  const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
  if (req.method !== 'GET') return json(405, { error: 'GET only' })
  const host = probeTokens.get(str(url.searchParams.get('t')))
  if (!host || hosts.get(host.hostId) !== host) return json(404, { error: 'unknown check' })
  const probe = host.probe
  if (Date.now() - probe.at > NET_PROBE_MS || ++probe.uses > NET_PROBE_USES) return json(410, { error: 'this check expired' })
  const country = placeOf(req).country
  if (country && host.country && country !== host.country) {
    logLimited(host.hostId, 'network check refused', { hostId: host.hostId, ip, country, hostCountry: host.country })
    return json(403, { error: 'this check came from another country' })
  }
  const added = noteNet(host, ip, 'probe')
  log('network check', { hostId: host.hostId, family: familyOf(ip), net: ipKey(ip), added, nets: netsText(host) })
  for (const wake of [...host.netWaiters]) wake()
  json(200, { ok: true, family: familyOf(ip) })
}

function waitForNet(host, ip) {
  if (!host?.probe || sameNetwork(host, ip)) return Promise.resolve()
  const left = NET_WAIT_MS - (Date.now() - host.probe.at)
  if (left <= 0) return Promise.resolve()
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer)
      host.netWaiters.delete(check)
      done()
    }
    const check = () => {
      if (sameNetwork(host, ip)) finish()
    }
    const timer = setTimeout(finish, left)
    host.netWaiters.add(check)
  })
}

function accessOf(p, host) {
  if (!plugin.has('phoneAccess')) return { scope: 'any', same: false }
  const same = sameNetwork(host, p.ip)
  const a = plugin.callSync('phoneAccess', [p.account, { hostId: host.hostId, sameNetwork: same, plan: p.plan ?? null }], null)
  if (a?.scope === 'any' || (a?.scope === 'local' && same)) return { scope: a.scope, same }
  return { refuse: { code: str(a?.code).slice(0, 20) || 'away', reason: str(a?.reason).slice(0, 300) || GATE_REASONS.away }, same }
}

function refuseAccess(p, a, why) {
  logLimited(`${p.account || p.ipKey}|${a.refuse.code}`, 'phone refused', { cid: p.cid, hostId: p.hostId, code: a.refuse.code, why, net: ipKey(p.ip), ...(p.account ? { account: p.account } : {}) })
  send(p.ws, { t: 'reject', code: a.refuse.code, reason: a.refuse.reason })
  setTimeout(() => p.ws.close(4003, a.refuse.code), 200)
}

function recheckLocal(host, why) {
  for (const p of phones.values()) {
    if (p.hostId !== host.hostId || p.scope !== 'local' || p.ws.readyState !== p.ws.OPEN) continue
    const a = accessOf(p, host)
    if (a.refuse) refuseAccess(p, a, why)
  }
}

function netTick(now) {
  for (const host of hosts.values()) {
    let dropped = false
    for (const [key, n] of host.nets) {
      if (n.via !== 'probe' || now - n.at <= NET_KEEP_MS) continue
      host.nets.delete(key)
      dropped = true
    }
    if (dropped) recheckLocal(host, 'a network check of the desktop expired')
    if (!host.probe || now - host.probe.at > NET_REPROBE_MS) issueProbe(host)
  }
  for (const [token, host] of probeTokens) if (hosts.get(host.hostId) !== host || host.probe?.token !== token) probeTokens.delete(token)
}

function admitHost(ws, hello, ip, place) {
  const hostId = str(hello.hostId)
  if (!HOST_ID.test(hostId)) return ws.close(4002, 'bad host id')
  if (!limits.hostHello.take(ipKey(ip))) return ws.close(4008, 'too many connections')
  const refuse = (reason) => {
    log('host refused', { hostId, ip, reason })
    send(ws, { t: 'refused', reason })
    setTimeout(() => ws.close(4002, 'host refused'), 200)
  }
  const key = str(hello.key)
  if (!key) return refuse('This relay needs a newer Satura. Update Satura on this computer.')
  if (hostIdForKey(key) !== hostId) return refuse("The host id doesn't match its key.")
  const nonce = hostChallenge()
  const timer = setTimeout(() => refuse("The host didn't prove its key in time."), HELLO_TIMEOUT_MS)
  const onProof = safe(ws, (data) => {
    if (data.length > HELLO_MAX_BYTES) return ws.close(1009, 'frame too large')
    const m = parseFrame(data.toString())
    if (!m) return ws.close(4000, 'bad frame')
    if (m.t !== 'auth') return ws.close(4000, 'expected auth')
    clearTimeout(timer)
    ws.off('message', onProof)
    if (!verifyHostProof({ key, hostId, nonce, sig: m.sig })) return refuse("The host key proof didn't check out.")
    attachHost(ws, hello, ip, place)
  })
  ws.on('message', onProof)
  ws.once('close', () => clearTimeout(timer))
  send(ws, { t: 'challenge', nonce })
}

function pinHostKey(hostId, key) {
  const now = Date.now()
  const known = hostKeys.get(hostId)
  if (known && known.key !== key && now - known.at < HOST_KEY_MEMORY_MS) return false
  hostKeys.delete(hostId)
  hostKeys.set(hostId, { key, at: now })
  while (hostKeys.size > HOST_KEY_MEMORY_MAX) hostKeys.delete(hostKeys.keys().next().value)
  return true
}

function attachHost(ws, hello, ip, place = {}) {
  const hostId = str(hello.hostId)
  const key = ipKey(ip)
  const prev = hosts.get(hostId)
  if (!pinHostKey(hostId, str(hello.key))) {
    log('host refused', { hostId, ip, reason: 'another key already holds this host id' })
    send(ws, { t: 'refused', reason: 'Another computer already uses this host id with a different key.' })
    setTimeout(() => ws.close(4002, 'host id taken'), 200)
    return
  }
  const here = (hostsByIp.get(key) ?? 0) + (prev && prev.ws.ipKey === key ? 0 : 1)
  if (here > MAX_HOSTS_PER_IP) {
    logLimited(key, 'host refused', { hostId, ip, reason: 'too many hosts from this address' })
    send(ws, { t: 'refused', reason: 'Too many desktops connect from this network. Try again later.' })
    setTimeout(() => ws.close(4008, 'too many hosts'), 200)
    return
  }
  hostsByIp.set(key, (hostsByIp.get(key) ?? 0) + 1)
  ws.once('close', () => {
    const n = (hostsByIp.get(key) ?? 1) - 1
    if (n > 0) hostsByIp.set(key, n)
    else hostsByIp.delete(key)
  })
  ws.hostId = hostId
  if (prev) prev.ws.close(4005, 'replaced')
  const host = { ws, hostId, name: str(hello.name).slice(0, 120), version: str(hello.version).slice(0, 40), protocol: num(hello.protocol) || 0, minPhone: num(hello.minPhone) || 0, phones: new Set(), nets: new Map(), netWaiters: new Set(), probe: null, country: place.country ?? '' }
  noteNet(host, ip, 'socket')
  const moved = !!prev && !sameNetwork(prev, ip)
  if (prev && !moved) for (const [k, n] of prev.nets) if (!host.nets.has(k)) host.nets.set(k, n)
  ws.role = 'host'
  capFrames(ws, HOST_MAX_BYTES)
  hosts.set(hostId, host)
  silentHosts.delete(hostId)
  log('host connected', { hostId, name: host.name, version: host.version, protocol: host.protocol, ip, net: ipKey(ip), ...(prev ? { replaced: true, moved } : {}) })
  send(ws, { t: 'welcome', ping: 1, ...(publicWeb ? { web: publicWeb } : {}) })
  issueProbe(host)
  if (moved)
    setTimeout(() => {
      if (hosts.get(hostId) === host) recheckLocal(host, 'the desktop connected again from another network')
    }, NET_WAIT_MS).unref()
  ws.on('message', safe(ws, (data, isBinary) => (isBinary ? onHostBinary(host, data) : onHostMessage(host, data.toString(), data.length))))
  ws.on('close', (code) => {
    if (host.probe) probeTokens.delete(host.probe.token)
    if (hosts.get(hostId) !== host) return
    hosts.delete(hostId)
    if (ws.silent) rememberSilent(hostId)
    log('host disconnected', { hostId, code, ...(ws.silent ? { silent: true } : {}) })
    for (const cid of host.phones) {
      const p = phones.get(cid)
      if (!p) continue
      send(p.ws, { t: 'host-left', reason: ws.silent ? 'silent' : 'closed' })
      p.ws.close(4004, 'host left')
    }
  })
}

async function admitPhone(ws, hello, ip, req, early) {
  const held = []
  let heldBytes = 0
  const hold = safe(ws, (data, isBinary) => {
    if (isBinary) return
    if (held.length < 100 && heldBytes + data.length <= PRE_ADMIT_BYTES) {
      heldBytes += data.length
      held.push(data.toString())
      return
    }
    if (parseFrame(data.toString())?.t !== 'log') ws.close(1008, 'too much sent before admission')
  })
  ws.on('message', hold)
  const r = await gateCheck(req, 'phone', false, ip, str(hello.ticket))
  const host = r.state === 'ok' && plugin.has('phoneAccess') ? hosts.get(str(hello.hostId)) : null
  if (host && ws.readyState === ws.OPEN) await waitForNet(host, ip)
  ws.off('message', hold)
  if (ws.readyState !== ws.OPEN) return
  if (r.throttled) return ws.close(1013, 'try again later')
  if (r.state === 'signin' || r.state === 'denied') {
    send(ws, { t: 'reject', code: r.state, reason: GATE_REASONS[r.state] })
    setTimeout(() => ws.close(4003, r.state), 200)
    return
  }
  if (r.state !== 'ok') return ws.close(1013, 'account check failed')
  const p = attachPhone(ws, hello, ip, r.email ?? '', placeOf(req), r.plan)
  for (const e of early) onPhoneMessage(p, JSON.stringify(e))
  for (const text of held) {
    if (text.length > PHONE_MAX_BYTES) return ws.close(1009, 'frame too large')
    onPhoneMessage(p, text)
  }
}

function attachPhone(ws, hello, ip, account, place = { ip }, plan = null) {
  const cid = randomBytes(4).toString('hex')
  const hostId = str(hello.hostId)
  const pairing = hello.pairing === true || Boolean(hello.code) || hello.e2e?.mode === 'pair'
  const p = { ws, cid, hostId, accepted: false, phoneId: null, ua: str(hello.ua).slice(0, 200), account, place, ip, ipKey: ipKey(ip), plan, scope: 'any', pairing, pairKey: `${account || ipKey(ip)}|${hostId}`, allowanceShape: '', hsFrames: 0 }
  ws.role = 'phone'
  ws.account = account
  phones.set(cid, p)
  logLimited(account || p.ipKey, 'phone connected', { cid, ip, hostId: p.hostId || '?', pairing, ...(account ? { account } : {}) })
  ws.on(
    'message',
    safe(ws, (data, isBinary) => {
      count(account, 'wsIn', data.length)
      if (data.length > PHONE_MAX_BYTES) return ws.close(1009, 'frame too large')
      if (isBinary) return onPhoneBinary(p, data)
      onPhoneMessage(p, data.toString())
    })
  )
  ws.on('close', (code) => {
    phones.delete(cid)
    rememberGone(p)
    logLimited(account || p.ipKey, 'phone disconnected', { cid, code })
    const host = hosts.get(p.hostId)
    if (host && (host.phones.delete(cid) || p.forwarded)) send(host.ws, { t: 'phone-left', cid }, account)
  })
  const known = knowsHost(p.hostId, account)
  const host = hosts.get(p.hostId)
  if (host) {
    const a = accessOf(p, host)
    if (a.refuse && (known || pairing)) {
      refuseAccess(p, a, pairing ? 'pairing from another network' : 'the phone is on another network')
      return p
    }
    if (a.refuse) {
      send(ws, { t: 'host-left', reason: 'closed' })
      setTimeout(() => ws.close(4004, 'host offline'), 200)
      return p
    }
    p.scope = a.scope
  }
  const hostBusy = pairing && limits.pairHost.full(hostId)
  if (pairing && (hostBusy || !(limits.pairIp.take(p.ipKey) && !limits.pairClient.full(p.pairKey)))) {
    logLimited(p.ipKey, 'pairing throttled', { cid, ip, hostId: p.hostId, ...(hostBusy ? { hostBusy: true } : {}) })
    send(ws, { t: 'reject', code: 'rate', reason: hostBusy ? 'This desktop had too many pairing attempts. Wait a few minutes and try again.' : 'Too many pairing attempts. Wait a few minutes and try again.' })
    setTimeout(() => ws.close(4008, 'too many pairing attempts'), 200)
    return p
  }
  if (!host) {
    if (!known && pairing) {
      limits.pairClient.take(p.pairKey)
      send(ws, { t: 'reject', reason: 'That pairing code is wrong or expired' })
      setTimeout(() => ws.close(4003, 'rejected'), 200)
      return p
    }
    send(ws, { t: 'host-left', reason: known && hostState(p.hostId) === 'silent' ? 'silent' : 'closed' })
    setTimeout(() => ws.close(4004, 'host offline'), 200)
    return p
  }
  const fit = fitFor({ protocol: num(hello.protocol) || 0, minHost: num(hello.minHost) || 0 }, host)
  if (fit !== 'ok') {
    log('phone refused', { cid, hostId, fit, phone: num(hello.protocol) || 0, host: host.protocol })
    send(ws, { t: 'reject', code: 'update', reason: UPDATE_REASONS[fit] })
    setTimeout(() => ws.close(4007, 'protocol mismatch'), 200)
    return p
  }
  const e2e = hello.e2e && typeof hello.e2e === 'object' && !Array.isArray(hello.e2e) ? hello.e2e : undefined
  p.forwarded = true
  send(host.ws, { t: 'phone-hello', cid, ...(pairing ? { pairing: true } : {}), ...(e2e ? { e2e } : {}), ua: p.ua, device: str(hello.device).slice(0, 60), installId: str(hello.installId).slice(0, 64), ...place, ...(account ? { email: account } : {}) }, account)
  return p
}

function ownHostName(name) {
  const h = name.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true
  const own = hostname().toLowerCase().replace(/\.local$/, '')
  if (own && (h === own || h === `${own}.local`)) return true
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.address.toLowerCase() === h) return true
  return false
}

function originAllowed(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const o = cleanWebBase(origin)
  if (!o) return false
  if (allowedOrigins.has(o)) return true
  const host = String(req.headers.host ?? '').toLowerCase()
  if (!host || (o !== `https://${host}` && o !== `http://${host}`)) return false
  try {
    return ownHostName(new URL(o).hostname)
  } catch {
    return false
  }
}

const wss = new WebSocketServer({
  server,
  maxPayload: HOST_MAX_BYTES,
  verifyClient: ({ req }) => {
    if (originAllowed(req)) return true
    const ip = clientIp(req)
    logLimited(ipKey(ip), 'websocket origin refused', { ip, origin: str(req.headers.origin).slice(0, 120) })
    return false
  }
})

wss.on('connection', (ws, req) => {
  const ip = clientIp(req)
  const key = ipKey(ip)
  ws.ipKey = key
  if (draining) return ws.close(1012, 'restarting')
  const open = (socketsByIp.get(key) ?? 0) + 1
  if (!limits.connect.take(key) || open > MAX_SOCKETS_PER_IP) {
    logLimited(key, 'connection refused', { ip, open })
    return ws.close(4008, 'too many connections')
  }
  socketsByIp.set(key, open)
  ws.on('close', () => {
    const n = (socketsByIp.get(key) ?? 1) - 1
    if (n > 0) socketsByIp.set(key, n)
    else socketsByIp.delete(key)
  })
  capFrames(ws, HELLO_MAX_BYTES)
  meterIn(ws)
  ws.alive = true
  ws.seenAt = Date.now()
  ws.on('pong', () => {
    ws.alive = true
    ws.seenAt = Date.now()
  })
  ws.on('message', () => {
    ws.seenAt = Date.now()
  })
  ws.on('error', (e) => log('socket error', { ip, error: e.message }))
  const timer = setTimeout(() => ws.close(4001, 'no hello'), HELLO_TIMEOUT_MS)
  const early = []
  let earlyBytes = 0
  const onFirst = safe(ws, (data) => {
    if (data.length > HELLO_MAX_BYTES) return ws.close(1009, 'frame too large')
    const m = parseFrame(data.toString())
    if (!m) return ws.close(4000, 'bad frame')
    if (m.t === 'log') {
      earlyBytes += data.length
      if (early.length < 50 && earlyBytes <= PRE_ADMIT_BYTES) early.push(m)
      return
    }
    if (m.t !== 'hello') return ws.close(4000, 'expected hello')
    clearTimeout(timer)
    ws.off('message', onFirst)
    if (m.role === 'host') admitHost(ws, m, ip, placeOf(req))
    else if (m.role === 'phone')
      admitPhone(ws, m, ip, req, early).catch((e) => {
        log('phone admit error', { ip, error: str(e?.message) || 'unknown' })
        ws.close(1011, 'internal error')
      })
    else ws.close(4000, 'unknown role')
  })
  ws.on('message', onFirst)
})

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      if (ws.role === 'host') ws.silent = true
      ws.terminate()
      continue
    }
    ws.alive = false
    ws.ping()
  }
  shedOut()
  netTick(Date.now())
}, HEARTBEAT_MS)

const allowanceTimer = setInterval(() => {
  for (const p of phones.values()) pushAllowance(p)
}, ALLOWANCE_PUSH_MS)
allowanceTimer.unref()

wss.on('close', () => {
  clearInterval(heartbeat)
  clearInterval(allowanceTimer)
})

function shutdown(signal) {
  if (draining) return
  draining = true
  log('draining', { signal, hosts: hosts.size, phones: phones.size })
  setTimeout(() => {
    for (const ws of wss.clients) ws.close(1012, 'relay restarting')
    owners.flush()
    const done = plugin.call('close', [], null, 3000)
    server.close(() => {
      void done.then(() => {
        log('stopped')
        process.exit(0)
      })
    })
    server.closeIdleConnections?.()
    setTimeout(() => process.exit(0), 5000).unref()
  }, DRAIN_MS)
}

process.on('exit', () => {
  owners.close()
  plugin.closeNow()
})
process.on('uncaughtException', (e) => {
  log('crashed', { error: str(e?.stack ?? e?.message).slice(0, 2000) })
  process.exit(1)
})
process.on('unhandledRejection', (e) => log('unhandled rejection', { error: str(e?.stack ?? e?.message ?? e).slice(0, 2000) }))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

server.listen(port, env.SATURA_RELAY_HOST || '0.0.0.0', () => {
  log(`relay listening on :${port}`, { app: appRoot ?? '-', appProtocol: appInfo()?.protocol ?? '-', dev: devMode, ...(devMode ? { devToken: env.SATURA_RELAY_DEV_TOKEN ? 'from SATURA_RELAY_DEV_TOKEN' : devToken } : {}), ice: ice.source, icePolicy, trustProxy, proxy: proxy.status(), origins: [...allowedOrigins], hostMaxMB: Math.round(HOST_MAX_BYTES / MB), publicWeb: publicWeb ?? '-', gate: plugin.has('authorize') ? 'plugin' : gate.enabled ? 'ticket' : 'off', ticketKey: gate.verifies ? 'set' : 'none', allow: gate.allowCount, owners: env.SATURA_RELAY_OWNERS_FILE ?? 'memory', plugin: plugin.enabled ? plugin.name : 'none', push: push.enabled ? 'on' : 'off', networkRule: plugin.has('phoneAccess') ? 'plugin' : 'off', ...(testIps ? { testIps: [...testIps].map(([a, b]) => `${a}=${b}`).join(','), testIpCookie: TEST_IP_COOKIE } : {}) })
})
