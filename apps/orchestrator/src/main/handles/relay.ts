import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, generateKeyPairSync, createPrivateKey, randomBytes, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer, connect } from 'node:net'
import { join } from 'node:path'
import { repoPackagePath } from '../bundled-resources'
import { defineHandle, sleep } from './registry'
import { addResource, getResource, ownerOf, scratchFor, type Resource } from './scratch'

const MAX_LINES = 4000

interface Relay {
  child: ChildProcess
  port: number
  url: string
  root: string
  lines: string[]
  cut: number
  exit: { code: number | null; signal: string | null; at: number } | null
  exited: Promise<void>
}

interface Sock {
  ws: WebSocket
  relay: string
  path: string
  frames: unknown[]
  read: number
  opened: boolean
  closed: { code: number; reason: string; at: number } | null
  error: string | null
  hostId?: string
  key?: string
  priv?: string
  autoAuth: boolean
}

const relays = new Map<string, Relay>()
const sockets = new Map<string, Sock>()

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a ? a.port : 0
      s.close(() => done(port))
    })
  })
}

function relayOf(id: unknown): { r: Resource; relay: Relay } {
  const r = getResource(id, 'relay')
  const relay = relays.get(r.id)
  if (!relay) throw new Error(`Relay ${r.id} is gone.`)
  return { r, relay }
}

function stopRelay(relay: Relay): Promise<Record<string, unknown>> {
  return (async () => {
    if (!relay.exit) {
      relay.child.kill('SIGTERM')
      await Promise.race([relay.exited, sleep(9000)])
      if (!relay.exit) {
        relay.child.kill('SIGKILL')
        await Promise.race([relay.exited, sleep(2000)])
      }
    }
    return { exit: relay.exit, logTail: relay.lines.slice(-30) }
  })()
}

function hostKey(): { key: string; priv: string; hostId: string } {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as { x: string; d: string }
  const hostId = createHash('sha256').update(Buffer.from(jwk.x, 'base64url')).digest('hex').slice(0, 16)
  return { key: jwk.x, priv: jwk.d, hostId }
}

function proof(s: Sock, nonce: string): string {
  const key = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: s.key ?? '', d: s.priv ?? '' }, format: 'jwk' })
  return sign(null, Buffer.from(`satura-relay-host:${nonce}:${s.hostId}`), key).toString('base64url')
}

function frameOf(raw: unknown): string | Uint8Array {
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    if (typeof o.base64 === 'string') return Buffer.from(o.base64, 'base64')
    if (typeof o.size === 'number') return 'x'.repeat(Math.max(0, Math.min(80 * 1024 * 1024, o.size)))
    if ('json' in o) return JSON.stringify(o.json)
  }
  return JSON.stringify(raw)
}

function parsed(data: unknown): unknown {
  if (typeof data !== 'string') return { binary: (data as ArrayBuffer).byteLength ?? 0 }
  try {
    return JSON.parse(data)
  } catch {
    return { text: data.slice(0, 2000) }
  }
}

function openSocket(relayId: string, relay: Relay, path: string, headers: Record<string, string>, asHost: boolean): Sock {
  const Ctor = WebSocket as unknown as new (url: string, init?: unknown) => WebSocket
  const ws = Object.keys(headers).length ? new Ctor(`ws://127.0.0.1:${relay.port}${path}`, { headers }) : new Ctor(`ws://127.0.0.1:${relay.port}${path}`)
  const s: Sock = { ws, relay: relayId, path, frames: [], read: 0, opened: false, closed: null, error: null, autoAuth: asHost }
  if (asHost) Object.assign(s, hostKey())
  ws.addEventListener('open', () => (s.opened = true))
  ws.addEventListener('message', (e: MessageEvent) => {
    const m = parsed(e.data)
    s.frames.push(m)
    const o = m as { t?: unknown; nonce?: unknown }
    if (s.autoAuth && o?.t === 'challenge' && typeof o.nonce === 'string') ws.send(JSON.stringify({ t: 'auth', sig: proof(s, o.nonce) }))
  })
  ws.addEventListener('close', (e: CloseEvent) => (s.closed = { code: e.code, reason: e.reason, at: Date.now() }))
  ws.addEventListener('error', (e: Event) => (s.error = (e as unknown as { message?: string }).message ?? 'socket error'))
  return s
}

async function settle(s: Sock, waitMs: number, until: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline && !signal.aborted) {
    if (s.closed) return
    if (until && s.frames.slice(s.read).some((f) => (f as { t?: unknown })?.t === until)) return
    await sleep(25, signal)
  }
}

function sockView(id: string, s: Sock, fresh: unknown[]): Record<string, unknown> {
  return { socket: id, path: s.path, opened: s.opened, received: fresh, closed: s.closed, ...(s.error ? { error: s.error } : {}), ...(s.hostId ? { hostId: s.hostId, key: s.key } : {}), state: ['connecting', 'open', 'closing', 'closed'][s.ws.readyState] }
}

defineHandle({
  name: 'relay.start',
  side: 'main',
  agentOnly: true,
  description:
    "Starts a local Satura Remote relay (packages/companion-app/relay/src/server.mjs) as a child process on 127.0.0.1 and a free port, with the environment you give it on top of a clean one: SATURA_RELAY_DEV=1, the usage file and dev screenshots in a scratch dir, and the phone site from the app's out/remote when it is built (SATURA_RELAY_APP names another folder, or off). env sets more, like SATURA_RELAY_AUTH_URL pointed at a fake.start url that answers the plan JSON for a Bearer ticket, SATURA_RELAY_TICKET_KEY (the base64url Ed25519 public key that signs tickets), SATURA_RELAY_ALLOW_EMAILS, SATURA_RELAY_ICE_SERVERS (a JSON list of ICE servers), SATURA_RELAY_ORIGINS, SATURA_RELAY_TRUST_PROXY with SATURA_RELAY_PROXY_PEERS, SATURA_RELAY_OWNERS_FILE, SATURA_RELAY_HOST_MAX_BYTES, SATURA_RELAY_IN_BUDGET_MB, SATURA_RELAY_MAX_SOCKETS_PER_IP, SATURA_RELAY_CONNECTS_PER_MIN, SATURA_RELAY_PAIR_PER_IP, SATURA_RELAY_AUTH_LOOKUPS_PER_MIN, SATURA_RELAY_HEARTBEAT_MS. SATURA_RELAY_PLUGIN loads a relay plugin by absolute path (it may point outside the scratch dir, at a service plugin checkout); the plugin reads the rest of the env itself, like SATURA_RELAY_TURN_API / SATURA_RELAY_CF_GRAPHQL at fake urls, TURN_KEY_ID, SATURA_RELAY_ADMIN_TOKEN and SATURA_RELAY_USAGE_FLUSH_MS. A value of null removes a default. Its /dev/* routes need the x-satura-dev-token header set to env.SATURA_RELAY_DEV_TOKEN (and a JSON body for POSTs), from loopback too. Waits up to waitMs for 'relay listening'. Drive it with relay.http and relay.ws, read it with relay.state, stop it with scratch.close (it also stops when the exec script ends unless keep: true). Returns id, port, url, pid, scratch root, the env it got and the startup log lines.",
  params: { env: {}, waitMs: 10_000, keep: false },
  async run(p, ctx) {
    const RELAY_DIR = join(repoPackagePath('companion-app'), 'relay')
    const entry = join(RELAY_DIR, 'src', 'server.mjs')
    if (!existsSync(entry)) throw new Error(`No relay at ${entry}.`)
    if (!existsSync(join(RELAY_DIR, 'node_modules', 'ws'))) throw new Error(`The relay has no node_modules: run corepack pnpm@10.34.9 install in ${RELAY_DIR}.`)
    const owner = ownerOf(p, ctx)
    const s = scratchFor({ root: '', keep: p.keep }, ctx, 'relay data')
    const port = await freePort()
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: s.root,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      SATURA_RELAY_HOST: '127.0.0.1',
      SATURA_RELAY_DEV: '1',
      SATURA_RELAY_DEV_TOKEN: randomBytes(18).toString('base64url'),
      SATURA_RELAY_USAGE_FILE: join(s.root, 'usage.json'),
      SATURA_RELAY_SHOTS: join(s.root, 'shots'),
      SATURA_RELAY_DRAIN_MS: '300'
    }
    for (const [k, v] of Object.entries((p.env ?? {}) as Record<string, unknown>)) {
      if (k === 'SATURA_RELAY_HOST' || k === 'PORT' || k === 'ELECTRON_RUN_AS_NODE') throw new Error(`${k} is set by relay.start: the relay always listens on 127.0.0.1 and a free port.`)
      if (v === null) delete env[k]
      else env[k] = String(v)
    }
    mkdirSync(join(s.root, 'shots'), { recursive: true })
    const child = spawn(process.execPath, [entry], { cwd: RELAY_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const relay: Relay = { child, port, url: `http://127.0.0.1:${port}`, root: s.root, lines: [], cut: 0, exit: null, exited: Promise.resolve() }
    relay.exited = new Promise((done) => child.once('exit', (code, signal) => {
      relay.exit = { code, signal, at: Date.now() }
      ctx.log(`relay on ${port} exited with ${code ?? signal}`)
      done()
    }))
    const push = (tag: string) => (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue
        relay.lines.push(tag ? `${tag} ${line}` : line)
        if (relay.lines.length > MAX_LINES) {
          relay.lines.shift()
          relay.cut++
        }
      }
    }
    child.stdout?.on('data', push(''))
    child.stderr?.on('data', push('[stderr]'))
    const r = addResource('relay', owner, `relay on ${port}`, () => ({ port, url: relay.url, pid: child.pid, root: s.root, running: !relay.exit }), async () => {
      for (const [id, sock] of sockets) if (sock.relay === r.id) {
        try {
          sock.ws.close()
        } catch {
        }
        sockets.delete(id)
      }
      relays.delete(r.id)
      return stopRelay(relay)
    })
    relays.set(r.id, relay)
    const deadline = Date.now() + Math.max(500, Number(p.waitMs) || 10_000)
    while (Date.now() < deadline && !relay.exit && !relay.lines.some((l) => l.includes('relay listening'))) await sleep(50, ctx.signal)
    const ready = relay.lines.some((l) => l.includes('relay listening'))
    ctx.log(`${r.id}: pid ${child.pid} on ${relay.url} ${ready ? 'listening' : relay.exit ? 'exited' : 'not ready yet'}`)
    return { id: r.id, ready, port, url: relay.url, pid: child.pid, root: s.root, env, exit: relay.exit, logs: relay.lines.slice(0, 40) }
  }
})

defineHandle({
  name: 'relay.state',
  side: 'main',
  agentOnly: true,
  description:
    "Reads a relay.start relay (id defaults to the newest): running or its exit code and signal, its log lines (since: n skips the first n, grep filters by a regex), the usage file it flushed (usage.json in its scratch dir, parsed), the dev screenshots it saved and its relay.ws sockets with their state and close codes. Use it after relay.http and relay.ws calls to see what the relay logged and whether it is still up.",
  params: { id: '', since: 0, grep: '' },
  async run(p) {
    const { r, relay } = relayOf(p.id)
    const since = Math.max(0, Number(p.since) || 0)
    let lines = relay.lines.slice(Math.max(0, since - relay.cut))
    if (p.grep) {
      const re = new RegExp(String(p.grep), 'i')
      lines = lines.filter((l) => re.test(l))
    }
    let usage: unknown = null
    const file = join(relay.root, 'usage.json')
    if (existsSync(file)) {
      try {
        usage = JSON.parse(readFileSync(file, 'utf8'))
      } catch (e) {
        usage = { unreadable: (e as Error).message }
      }
    }
    const socks = [...sockets.entries()].filter(([, s]) => s.relay === r.id).map(([id, s]) => ({ socket: id, path: s.path, state: ['connecting', 'open', 'closing', 'closed'][s.ws.readyState], closed: s.closed, frames: s.frames.length, ...(s.hostId ? { hostId: s.hostId } : {}) }))
    return { id: r.id, running: !relay.exit, exit: relay.exit, pid: relay.child.pid, url: relay.url, lineCount: relay.cut + relay.lines.length, logs: lines.slice(-400), usage, sockets: socks }
  }
})

function rawHttp(port: number, text: string, timeoutMs: number): Promise<{ text: string; ms: number; ended: string }> {
  return new Promise((done) => {
    const t0 = Date.now()
    let out = ''
    const sock = connect(port, '127.0.0.1')
    const finish = (ended: string): void => {
      sock.destroy()
      done({ text: out.slice(0, 64 * 1024), ms: Date.now() - t0, ended })
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    sock.on('connect', () => sock.write(text.replace(/\r?\n/g, '\r\n')))
    sock.on('data', (c) => (out += c.toString('utf8')))
    sock.on('end', () => {
      clearTimeout(timer)
      finish('closed by the relay')
    })
    sock.on('error', (e) => {
      clearTimeout(timer)
      finish(`error ${e.message}`)
    })
  })
}

function oneRequest(port: number, method: string, path: string, headers: Record<string, string>, body: string | null, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((done) => {
    const t0 = Date.now()
    const req = request({ host: '127.0.0.1', port, method, path, headers: { ...(body !== null ? { 'content-length': String(Buffer.byteLength(body)) } : {}), ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        if (text.length < 256 * 1024) text += c
      })
      res.on('end', () => {
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          json = undefined
        }
        done({ status: res.statusCode, headers: res.headers, ...(json !== undefined ? { json } : { body: text.slice(0, 16 * 1024) }), ms: Date.now() - t0 })
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer in ${timeoutMs} ms`)))
    req.on('error', (e) => done({ error: e.message, ms: Date.now() - t0 }))
    req.end(body ?? undefined)
  })
}

defineHandle({
  name: 'relay.http',
  side: 'main',
  agentOnly: true,
  description:
    "Sends HTTP to a relay.start relay (relay: id, default the newest) or a fake.start http fake (fake: id). method, path (sent as is, so malformed paths like /%E0%A4%A or /h/x/../../etc reach the server), headers (Authorization: Bearer <ticket> for /presence or <admin token> for /admin/usage.json, origin for CORS, x-forwarded-for, cf-connecting-ip), body (a string, or an object sent as JSON). repeat: n sends it n times in a row and also returns every status, for rate limits. raw: '<request text>' writes those bytes on a plain TCP socket instead (\\n becomes \\r\\n) and returns whatever comes back, for requests a normal client refuses to send. Returns status, headers, json or body and ms (statuses with repeat; text and how it ended with raw).",
  params: { relay: '', fake: '', method: 'GET', path: '/health', headers: {}, body: null as unknown, repeat: 1, raw: '', timeoutMs: 5000 },
  async run(p, ctx) {
    let port: number
    if (p.fake) {
      const f = getResource(p.fake, 'fake').info() as { port?: number }
      port = Number(f.port)
    } else port = relayOf(p.relay).relay.port
    const timeoutMs = Math.max(100, Math.min(60_000, Number(p.timeoutMs) || 5000))
    if (p.raw) {
      const out = await rawHttp(port, String(p.raw), timeoutMs)
      ctx.log(`raw ${String(p.raw).split('\n')[0].slice(0, 120)} -> ${out.text.split('\r\n')[0] || out.ended}`)
      return out
    }
    const body = p.body === null || p.body === undefined ? null : typeof p.body === 'string' ? p.body : JSON.stringify(p.body)
    const headers = { ...(body !== null && typeof p.body !== 'string' ? { 'content-type': 'application/json' } : {}), ...((p.headers ?? {}) as Record<string, string>) }
    const n = Math.max(1, Math.min(500, Number(p.repeat) || 1))
    const statuses: unknown[] = []
    let last: Record<string, unknown> = {}
    for (let i = 0; i < n; i++) {
      last = await oneRequest(port, String(p.method || 'GET').toUpperCase(), String(p.path || '/'), headers, body, timeoutMs)
      statuses.push(last.status ?? last.error)
    }
    ctx.log(`${String(p.method).toUpperCase()} ${String(p.path)} x${n} -> ${[...new Set(statuses)].join(', ')}`)
    return n > 1 ? { ...last, statuses } : last
  }
})

defineHandle({
  name: 'relay.ws',
  side: 'main',
  agentOnly: true,
  description:
    "Opens and drives raw WebSockets on a relay.start relay, the way a Mac host or a phone would, or with frames neither would send. socket: '' opens a new one at path (default /) with headers; socket: <id> keeps using an open one across calls. host: true makes it a host: it gets a fresh Ed25519 key, its hello is filled in with role host, hostId and key, and the relay's challenge is answered with a signed auth frame (host: false and your own frames test a bad proof). hello is sent first (an object, sent as JSON). send is a list of frames: a string is sent as text, an object as JSON, {text}, {json}, {base64} for binary, {size: n} for n bytes of junk (frame caps). Then it waits waitMs, or until a frame with t equal to until arrives, or the socket closes. count: n opens n sockets at once with the same hello and returns each one's outcome (per-IP socket caps, connect rate limits). close: true or a code closes it at the end. Returns socket id, received frames (parsed JSON; only those new since the last read), closed {code, reason}, state, and hostId and key for a host, so a phone hello can name that hostId. Sockets close when the exec script ends unless the relay was kept.",
  params: { relay: '', socket: '', path: '/', headers: {}, host: false, hello: null as unknown, send: [] as unknown[], waitMs: 1000, until: '', count: 1, close: false as unknown },
  async run(p, ctx) {
    const sendAll = (s: Sock): void => {
      for (const f of Array.isArray(p.send) ? p.send : []) s.ws.send(frameOf(f))
    }
    const helloFor = (s: Sock): unknown => {
      const h = p.hello && typeof p.hello === 'object' ? (p.hello as Record<string, unknown>) : null
      if (!h && !s.hostId) return null
      return s.hostId ? { t: 'hello', role: 'host', hostId: s.hostId, key: s.key, name: 'handles', version: '0.0.0', protocol: 99, ...(h ?? {}) } : h
    }
    const waitOpen = async (s: Sock): Promise<void> => {
      const until = Date.now() + 5000
      while (!s.opened && !s.closed && Date.now() < until) await sleep(20, ctx.signal)
    }
    const waitMs = Math.max(0, Math.min(60_000, Number(p.waitMs) || 0))
    const closeAt = (s: Sock): void => {
      if (p.close === true) s.ws.close()
      else if (typeof p.close === 'number') s.ws.close(p.close)
    }
    if (p.socket) {
      const id = String(p.socket)
      const s = sockets.get(id)
      if (!s) throw new Error(`There is no open relay socket ${id}.`)
      getResource(s.relay, 'relay')
      sendAll(s)
      await settle(s, waitMs, String(p.until ?? ''), ctx.signal)
      closeAt(s)
      if (p.close) await settle(s, 1000, '', ctx.signal)
      const fresh = s.frames.slice(s.read)
      s.read = s.frames.length
      return sockView(id, s, fresh)
    }
    const { r, relay } = relayOf(p.relay)
    const count = Math.max(1, Math.min(200, Number(p.count) || 1))
    const made: [string, Sock][] = []
    for (let i = 0; i < count; i++) {
      const s = openSocket(r.id, relay, String(p.path || '/'), (p.headers ?? {}) as Record<string, string>, p.host === true)
      const res = addResource('socket', r.owner, `socket ${p.path || '/'} on ${relay.port}`, () => ({ relay: r.id, path: s.path, state: ['connecting', 'open', 'closing', 'closed'][s.ws.readyState] }), async () => {
        sockets.delete(res.id)
        try {
          s.ws.close()
        } catch {
        }
        return { closed: s.closed }
      })
      sockets.set(res.id, s)
      made.push([res.id, s])
    }
    await Promise.all(made.map(([, s]) => waitOpen(s)))
    for (const [, s] of made) {
      const hello = helloFor(s)
      if (s.opened && !s.closed) {
        if (hello) s.ws.send(JSON.stringify(hello))
        sendAll(s)
      }
    }
    await Promise.all(made.map(([, s]) => settle(s, waitMs, String(p.until ?? ''), ctx.signal)))
    for (const [, s] of made) closeAt(s)
    if (p.close) await Promise.all(made.map(([, s]) => settle(s, 1000, '', ctx.signal)))
    const views = made.map(([id, s]) => {
      const fresh = s.frames.slice(s.read)
      s.read = s.frames.length
      return sockView(id, s, fresh)
    })
    ctx.log(`${count} socket(s) on ${p.path || '/'}: ${views.map((v) => (v.closed ? `closed ${(v.closed as { code: number }).code}` : String(v.state))).join(', ')}`)
    return count === 1 ? views[0] : { sockets: views }
  }
})
