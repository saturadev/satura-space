import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { STATUSLINE_HOOK_PATH } from './claude-statusline'
import { tokenMatches } from '../secret-token'
import { parseJsonObject, readString } from './agent-events'
import { SATURA_EXEC_ANSWER_PATH, SATURA_EXEC_PATH, type ExecPeer, type PeerAnswer, type SaturaExecReply, type SaturaExecRequest } from '@shared/satura-exec'

export type AgentHookEventHandler = (ptyId: string, agent: string, event: string, payload: string) => void
export interface AgentSessionInfo {
  sessionId: string
  event: string
  source: string
}
export type AgentSessionHandler = (ptyId: string, info: AgentSessionInfo) => void
export type AgentStatusLineHandler = (payload: string, configDir: string) => void
export type SaturaExecHandler = (req: SaturaExecRequest, signal: AbortSignal, peer?: ExecPeer) => Promise<SaturaExecReply>

const TOKEN_HEADER = 'x-satura-hook-token'
const HOOK_PATH_PREFIX = '/hook/'
const HOOK_AGENTS = new Set(['claude', 'kimi', 'cursor', 'grok'])
const BODY_LIMIT_BYTES = 1024 * 1024
const ANSWER_LIMIT_BYTES = 64 * 1024 * 1024
const SLOWLORIS_MS = 5000
const EXEC_KEEPALIVE_MS = 10_000

export class AgentHookServer {
  private server: Server | null = null
  private port = 0
  private token = ''
  private handler: AgentHookEventHandler | null = null
  private sessionHandler: AgentSessionHandler | null = null
  private statusLineHandler: AgentStatusLineHandler | null = null
  private execHandler: SaturaExecHandler | null = null
  private peers = new Map<string, Map<number, (answer: PeerAnswer) => void>>()
  execKeepaliveMs = EXEC_KEEPALIVE_MS

  isRunning(): boolean {
    return this.server != null && this.port > 0
  }

  setHandler(handler: AgentHookEventHandler | null): void {
    this.handler = handler
  }

  setSessionHandler(handler: AgentSessionHandler | null): void {
    this.sessionHandler = handler
  }

  setStatusLineHandler(handler: AgentStatusLineHandler | null): void {
    this.statusLineHandler = handler
  }

  setExecHandler(handler: SaturaExecHandler | null): void {
    this.execHandler = handler
  }

  async start(): Promise<void> {
    if (this.server) return
    this.token = randomUUID()
    const server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server = null
        reject(err)
      }
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', onError)
        this.port = (server.address() as AddressInfo).port
        resolve()
      })
    })
  }

  stop(): void {
    const server = this.server
    this.server = null
    this.port = 0
    this.token = ''
    if (server) {
      try {
        server.close()
      } catch {
      }
    }
  }

  endpoint(): { port: number; token: string } | null {
    return this.isRunning() ? { port: this.port, token: this.token } : null
  }

  buildPtyEnv(ptyId: string): Record<string, string> {
    if (!this.isRunning()) return {}
    return {
      SATURA_PANE_KEY: ptyId
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== 'POST') {
        res.writeHead(404)
        res.end()
        return
      }
      if (!tokenMatches(this.token, req.headers[TOKEN_HEADER])) {
        res.writeHead(403)
        res.end()
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      if (pathname === STATUSLINE_HOOK_PATH) {
        req.setTimeout(SLOWLORIS_MS, () => req.destroy())
        const form = new URLSearchParams(await readBody(req))
        const payload = form.get('payload') ?? ''
        if (payload) this.statusLineHandler?.(payload, form.get('configDir') ?? '')
        res.writeHead(204)
        res.end()
        return
      }
      if (pathname === SATURA_EXEC_PATH) {
        await this.handleExec(req, res)
        return
      }
      if (pathname === SATURA_EXEC_ANSWER_PATH) {
        this.handleAnswer(parseJsonObject(await readBody(req, ANSWER_LIMIT_BYTES)))
        res.writeHead(204)
        res.end()
        return
      }
      if (!pathname.startsWith(HOOK_PATH_PREFIX)) {
        res.writeHead(404)
        res.end()
        return
      }
      const agent = pathname.slice(HOOK_PATH_PREFIX.length)
      if (!HOOK_AGENTS.has(agent)) {
        res.writeHead(404)
        res.end()
        return
      }
      req.setTimeout(SLOWLORIS_MS, () => req.destroy())
      const body = await readBody(req)
      const form = new URLSearchParams(body)
      const paneKey = (form.get('paneKey') ?? '').trim()
      const event = (form.get('event') ?? '').trim()
      const payload = form.get('payload') ?? ''
      if (paneKey) this.handler?.(paneKey, agent, event, payload)
      if (paneKey && agent === 'claude') {
        const session = claudeSessionInfo(event, payload)
        if (session) this.sessionHandler?.(paneKey, session)
      }
      res.writeHead(204)
      res.end()
    } catch {
      try {
        res.writeHead(204)
        res.end()
      } catch {
      }
    }
  }

  private handleAnswer(body: Record<string, unknown> | null): void {
    if (!body) return
    const waiting = this.peers.get(String(body.run ?? ''))
    const resolve = waiting?.get(Number(body.id))
    if (!waiting || !resolve) return
    waiting.delete(Number(body.id))
    resolve(body as unknown as PeerAnswer)
  }

  private async handleExec(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.setTimeout(SLOWLORIS_MS, () => req.destroy())
    const body = parseJsonObject(await readBody(req))
    req.setTimeout(0)
    const abort = new AbortController()
    const run = randomUUID()
    const lines = body?.peer === true
    const waiting = new Map<number, (answer: PeerAnswer) => void>()
    const closed = (): void => {
      for (const resolve of waiting.values()) resolve({ ok: false, name: 'UnityError', error: 'The MCP server went away before it answered.' })
      waiting.clear()
    }
    res.once('close', () => {
      if (!res.writableEnded) abort.abort()
      closed()
    })
    const head = (): void => {
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': lines ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8' })
    }
    let nextId = 1
    const peer: ExecPeer | undefined = lines
      ? {
          call: (fn, args) =>
            new Promise<PeerAnswer>((resolve) => {
              if (res.destroyed || res.writableEnded) return resolve({ ok: false, name: 'UnityError', error: 'The MCP server went away.' })
              const id = nextId++
              waiting.set(id, resolve)
              head()
              res.write(JSON.stringify({ t: 'call', run, id, fn, args }) + '\n')
            })
        }
      : undefined
    if (lines) this.peers.set(run, waiting)
    const fail = (error: string): SaturaExecReply => ({ ok: false, error, logs: [], shots: [], ms: 0 })
    let reply: SaturaExecReply
    const beat = setInterval(() => {
      if (res.destroyed || res.writableEnded) return
      head()
      res.write(lines ? '\n' : ' ')
    }, this.execKeepaliveMs)
    if (!body) reply = fail('The request body must be a JSON object.')
    else if (!this.execHandler) reply = fail('Satura Space is still starting up.')
    else {
      try {
        reply = await this.execHandler(body, abort.signal, peer)
      } catch (e) {
        reply = fail((e as Error)?.message ?? String(e))
      }
    }
    clearInterval(beat)
    this.peers.delete(run)
    closed()
    if (res.destroyed) return
    head()
    res.end(lines ? JSON.stringify({ t: 'done', reply }) + '\n' : JSON.stringify(reply))
  }
}

export function claudeSessionInfo(event: string, payload: string): AgentSessionInfo | null {
  const parsed = parseJsonObject(payload)
  const sessionId = readString(parsed, 'session_id').trim()
  if (!sessionId || readString(parsed, 'agent_id') !== '') return null
  const name = event || readString(parsed, 'hook_event_name')
  if (!name) return null
  return { sessionId, event: name, source: readString(parsed, 'source') }
}

function readBody(req: IncomingMessage, limit = BODY_LIMIT_BYTES): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolve('')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', () => resolve(''))
  })
}
