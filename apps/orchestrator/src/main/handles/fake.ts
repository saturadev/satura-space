import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createTcp, type Server, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { defineHandle } from './registry'
import { addResource, getResource, ownerOf } from './scratch'

interface Reply {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  delayMs?: number
  close?: boolean
  silent?: boolean
  [key: string]: unknown
}

interface Route {
  method: string
  path: string
  replies: Reply[]
  hits: number
}

interface Hit {
  at: number
  method?: string
  path?: string
  query?: string
  headers?: Record<string, string>
  body?: string
  message?: unknown
  route?: string
  replied?: unknown
}

export interface Fake {
  kind: 'http' | 'ndjson'
  port: number
  token: string
  url: string
  hits: Hit[]
}

const fakes = new Map<string, Fake>()
const MAX_HITS = 500

function routeOf(raw: unknown): Route {
  const o = (raw ?? {}) as Record<string, unknown>
  const replies = Array.isArray(o.replies) && o.replies.length ? (o.replies as Reply[]) : [o as Reply]
  return { method: String(o.method ?? '*').toUpperCase(), path: String(o.path ?? '*'), replies, hits: 0 }
}

function matches(route: Route, method: string, path: string): boolean {
  if (route.method !== '*' && route.method !== method) return false
  if (route.path === '*') return true
  return route.path.endsWith('*') ? path.startsWith(route.path.slice(0, -1)) : route.path === path
}

function next(route: Route): Reply {
  const r = route.replies[Math.min(route.hits, route.replies.length - 1)]
  route.hits++
  return r
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => {
      if (text.length < 64 * 1024) text += c
    })
    req.on('end', () => resolve(text))
    req.on('error', () => resolve(text))
  })
}

function listen(server: Server | ReturnType<typeof createHttp>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const a = server.address()
      resolve(typeof a === 'object' && a ? a.port : 0)
    })
  })
}

async function httpFake(routes: Route[], fake: Fake): Promise<ReturnType<typeof createHttp>> {
  const server = createHttp(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const hit: Hit = { at: Date.now(), method: req.method, path: url.pathname, query: url.search, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), body: await body(req) }
    if (fake.hits.length < MAX_HITS) fake.hits.push(hit)
    const route = routes.find((r) => matches(r, String(req.method), url.pathname))
    if (!route) {
      hit.replied = 404
      return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no fake route"}')
    }
    hit.route = `${route.method} ${route.path}`
    const r = next(route)
    if (r.delayMs) await new Promise((d) => setTimeout(d, Math.min(60_000, Number(r.delayMs))))
    if (r.close) {
      hit.replied = 'closed'
      return void req.socket.destroy()
    }
    const status = Number(r.status ?? 200)
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})
    hit.replied = status
    res.writeHead(status, { 'content-type': typeof r.body === 'string' ? 'text/plain' : 'application/json', ...(r.headers ?? {}) }).end(text)
  })
  fake.port = await listen(server)
  fake.url = `http://127.0.0.1:${fake.port}`
  return server
}

async function ndjsonFake(replies: Reply[], fake: Fake): Promise<{ server: Server; sockets: Set<Socket> }> {
  let n = 0
  const sockets = new Set<Socket>()
  const server = createTcp((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buf = ''
    let authed = false
    socket.setEncoding('utf8')
    socket.on('error', () => undefined)
    socket.on('data', async (chunk: string) => {
      buf += chunk
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let msg: Record<string, unknown> | null = null
        try {
          msg = JSON.parse(line) as Record<string, unknown>
        } catch {
          msg = null
        }
        const hit: Hit = { at: Date.now(), message: msg ?? line.slice(0, 2000) }
        if (fake.hits.length < MAX_HITS) fake.hits.push(hit)
        if (!msg) continue
        if (msg.type === 'hello') {
          authed = msg.token === fake.token
          hit.replied = authed ? 'hello ok' : 'bad token, closing'
          if (!authed) socket.destroy()
          continue
        }
        if (!authed) {
          hit.replied = 'not authed, closing'
          socket.destroy()
          return
        }
        const r = replies.length ? replies[Math.min(n, replies.length - 1)] : { ok: true }
        n++
        if (r.delayMs) await new Promise((d) => setTimeout(d, Math.min(60_000, Number(r.delayMs))))
        if (r.close) {
          hit.replied = 'closed'
          socket.destroy()
          return
        }
        if (r.silent) {
          hit.replied = 'silent'
          continue
        }
        const { delayMs: _d, close: _c, silent: _s, ...fields } = r
        const out = { type: 'result', id: msg.id, ...fields }
        hit.replied = out
        socket.write(`${JSON.stringify(out)}\n`)
      }
    })
  })
  fake.port = await listen(server)
  fake.url = `tcp://127.0.0.1:${fake.port}`
  return { server, sockets }
}

export function fakeOf(id: unknown): Fake {
  const r = getResource(id, 'fake')
  const f = fakes.get(r.id)
  if (!f) throw new Error(`Fake ${r.id} is gone.`)
  return f
}

defineHandle({
  name: 'fake.start',
  side: 'main',
  agentOnly: true,
  description:
    'Starts a fake server on 127.0.0.1 that other handles point at, and records every request it gets. kind http: routes is a list of {method (default any), path (exact, or a prefix ending in *), status, headers, body (an object is sent as JSON), delayMs, close: true to drop the connection}, or {method, path, replies: [...]} to answer successive requests in order (the last one repeats); anything else gets 404. Use it as the relay\'s account check (SATURA_RELAY_AUTH_URL), TURN credential API (SATURA_RELAY_TURN_API) or Cloudflare analytics (SATURA_RELAY_CF_GRAPHQL) in relay.start. kind ndjson: an app control socket like the one the MCP talks to (hello with token, then {type:command, id, cmd, args} lines); replies are the result fields for each command in order ({ok:true,cmdId:3}, {ok:false,error:"...",retryable:true}), or {close:true} to drop the connection or {silent:true} to never answer; mcp.call with app: <id> points a scratch project at it. Closed when the exec script ends unless keep: true. Returns id, kind, port, url and token.',
  params: { kind: 'http', routes: [] as unknown[], replies: [] as unknown[], keep: false },
  async run(p, ctx) {
    const kind = p.kind === 'ndjson' ? 'ndjson' : 'http'
    const fake: Fake = { kind, port: 0, token: randomBytes(12).toString('hex'), url: '', hits: [] }
    let close: () => Promise<unknown>
    if (kind === 'http') {
      const routes = (Array.isArray(p.routes) ? p.routes : []).map(routeOf)
      const server = await httpFake(routes, fake)
      close = () => new Promise((d) => { server.closeAllConnections(); server.close(() => d({ hits: fake.hits.length })) })
    } else {
      const { server, sockets } = await ndjsonFake(Array.isArray(p.replies) ? (p.replies as Reply[]) : [], fake)
      close = () => new Promise((d) => { for (const s of sockets) s.destroy(); server.close(() => d({ hits: fake.hits.length })) })
    }
    const r = addResource('fake', ownerOf(p, ctx), `${kind} fake on ${fake.port}`, () => ({ port: fake.port, url: fake.url, hits: fake.hits.length }), async () => {
      fakes.delete(r.id)
      return close()
    })
    fakes.set(r.id, fake)
    ctx.log(`${r.id}: ${kind} fake on ${fake.url}`)
    return { id: r.id, kind, port: fake.port, url: fake.url, token: fake.token }
  }
})

defineHandle({
  name: 'fake.hits',
  side: 'main',
  agentOnly: true,
  description:
    'Reads what a fake.start server received, oldest first: for http the method, path, query, headers, body and which route answered with what; for ndjson every line (parsed when it is JSON) and the reply sent. id defaults to the newest fake. since: n skips the first n hits; clear: true forgets them after reading.',
  params: { id: '', since: 0, clear: false },
  async run(p) {
    const f = fakeOf(p.id)
    const hits = f.hits.slice(Math.max(0, Number(p.since) || 0))
    const total = f.hits.length
    if (p.clear) f.hits.length = 0
    return { url: f.url, total, hits }
  }
})
