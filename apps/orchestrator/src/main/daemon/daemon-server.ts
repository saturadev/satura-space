
import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { encodeNdjson, createNdjsonParser } from './ndjson'
import { tokenMatches } from './daemon-token'
import { TerminalHost } from './terminal-host'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { SubprocessHandle } from './session'
import { checkPtySpawnHealth } from './pty-subprocess'
import { fitSnapshotToLine } from './daemon-snapshot-fit'
import {
  PROTOCOL_VERSION,
  NOTIFY_PREFIX,
  SessionNotFoundError,
  type HelloMessage,
  type DaemonRequest,
  type TerminalSnapshot
} from './types'

export type DaemonServerOptions = {
  socketPath: string
  tokenPath: string
  buildId?: string
  maxLineBytes?: number
  ptySpawnHealthCheck?: () => Promise<void>
  onShutdownRequested?: (done: Promise<void>) => void
  spawnSubprocess: (opts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    command?: string
    shellOverride?: string
  }) => SubprocessHandle
}

type ConnectedClient = {
  clientId: string
  controlSocket: Socket
  streamSocket: Socket | null
}

export class DaemonServer {
  private server: Server | null = null
  private token: string
  private host: TerminalHost
  private socketPath: string
  private tokenPath: string
  private buildId: string | undefined
  private maxLineBytes: number | undefined
  private ptySpawnHealthCheck: () => Promise<void>
  private onShutdownRequested: DaemonServerOptions['onShutdownRequested']

  private clients = new Map<string, ConnectedClient>()
  private streamDataBatcher = new DaemonStreamDataBatcher((clientId) => this.clients.get(clientId))
  private lastInputAtBySessionId = new Map<string, number>()

  private static readonly INTERACTIVE_OUTPUT_WINDOW_MS = 100
  private static readonly INTERACTIVE_OUTPUT_MAX_CHARS = 1024

  constructor(opts: DaemonServerOptions) {
    this.socketPath = opts.socketPath
    this.tokenPath = opts.tokenPath
    this.buildId = opts.buildId
    this.maxLineBytes = opts.maxLineBytes
    this.token = randomUUID()
    this.host = new TerminalHost({ spawnSubprocess: opts.spawnSubprocess })
    this.ptySpawnHealthCheck = opts.ptySpawnHealthCheck ?? checkPtySpawnHealth
    this.onShutdownRequested = opts.onShutdownRequested
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket))
      const onListenError = (err: Error): void => {
        reject(err)
      }

      this.server.once('error', onListenError)

      this.server.listen(this.socketPath, () => {
        this.server?.off('error', onListenError)
        writeFileSync(this.tokenPath, this.token, { mode: 0o600 })
        try {
          chmodSync(this.socketPath, 0o600)
        } catch {
        }
        resolve()
      })
    })
  }

  async shutdown(): Promise<void> {
    this.host.dispose()
    this.streamDataBatcher.clear()

    for (const [, client] of this.clients) {
      client.controlSocket.destroy()
      client.streamSocket?.destroy()
    }
    this.clients.clear()

    return new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => {
          try {
            unlinkSync(this.socketPath)
          } catch {}
          resolve()
        })
        this.server = null
      } else {
        resolve()
      }
    })
  }

  private handleConnection(socket: Socket): void {
    const decoder = new StringDecoder('utf8')
    const parser = createNdjsonParser(
      (msg) => this.handleFirstMessage(socket, msg, parser),
      () => {
        socket.destroy()
      }
    )

    socket.on('data', (chunk) => parser.feed(decoder.write(chunk)))
    socket.on('error', () => socket.destroy())
  }

  private handleFirstMessage(
    socket: Socket,
    msg: unknown,
    _parser: ReturnType<typeof createNdjsonParser>
  ): void {
    const hello = msg as HelloMessage
    if (hello.type !== 'hello') {
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Expected hello' }))
      socket.destroy()
      return
    }

    if (hello.version !== PROTOCOL_VERSION) {
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Protocol version mismatch' }))
      socket.destroy()
      return
    }

    if (!tokenMatches(hello.token, this.token)) {
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Invalid token' }))
      socket.destroy()
      return
    }

    socket.write(
      encodeNdjson({ type: 'hello', ok: true, ...(this.buildId ? { buildId: this.buildId } : {}) })
    )

    if (hello.role === 'control') {
      const previous = this.clients.get(hello.clientId)
      const client: ConnectedClient = {
        clientId: hello.clientId,
        controlSocket: socket,
        streamSocket: null
      }
      this.clients.set(hello.clientId, client)
      if (hello.clientId !== 'health-check' && hello.clientId !== 'resolver-health-check') {
        console.log(`[daemon] client ${hello.clientId} connected`)
      }
      this.setupControlSocket(socket, hello.clientId)
      if (previous) {
        previous.streamSocket?.destroy()
        previous.controlSocket.destroy()
      }
    } else if (hello.role === 'stream') {
      const client = this.clients.get(hello.clientId)
      if (!client) {
        socket.destroy()
        return
      }
      this.setupStreamSocket(socket, client)
    }
  }

  private setupControlSocket(socket: Socket, clientId: string): void {
    const decoder = new StringDecoder('utf8')
    const parser = createNdjsonParser(
      (msg) => this.handleRequest(socket, clientId, msg as DaemonRequest),
      () => {}
    )

    socket.removeAllListeners('data')
    socket.on('data', (chunk) => parser.feed(decoder.write(chunk)))

    socket.on('close', () => {
      const client = this.clients.get(clientId)
      if (client?.controlSocket !== socket) {
        return
      }
      this.streamDataBatcher.clear(clientId)
      client.streamSocket?.destroy()
      this.clients.delete(clientId)
      if (clientId !== 'health-check' && clientId !== 'resolver-health-check') {
        console.log(`[daemon] client ${clientId} disconnected`)
      }
    })
  }

  private setupStreamSocket(socket: Socket, client: ConnectedClient): void {
    const previous = client.streamSocket
    socket.removeAllListeners('data')
    client.streamSocket = socket

    const cleanup = (): void => {
      socket.removeListener('close', cleanup)
      socket.removeListener('error', cleanup)
      if (this.clients.get(client.clientId) !== client || client.streamSocket !== socket) {
        return
      }
      this.streamDataBatcher.clear(client.clientId)
      client.streamSocket = null
    }

    socket.on('close', cleanup)
    socket.on('error', cleanup)

    if (previous && previous !== socket) {
      previous.destroy()
    }
  }

  private async handleRequest(
    socket: Socket,
    clientId: string,
    request: DaemonRequest
  ): Promise<void> {
    const isNotify = request.id.startsWith(NOTIFY_PREFIX)

    try {
      const result = await this.routeRequest(clientId, request)
      if (!isNotify) {
        socket.write(encodeNdjson({ id: request.id, ok: true, payload: result }))
      }
    } catch (err) {
      if (!isNotify) {
        socket.write(
          encodeNdjson({
            id: request.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          })
        )
      }
    }
  }

  private async routeRequest(clientId: string, request: DaemonRequest): Promise<unknown> {
    switch (request.type) {
      case 'createOrAttach': {
        const p = request.payload
        const result = await this.host.createOrAttach({
          sessionId: p.sessionId,
          cols: p.cols,
          rows: p.rows,
          cwd: p.cwd,
          env: p.env,
          shellOverride: p.shellOverride,
          streamClient: {
            onData: (data) => {
              const lastInputAt = this.lastInputAtBySessionId.get(p.sessionId)
              const isInteractiveOutput =
                data.length <= DaemonServer.INTERACTIVE_OUTPUT_MAX_CHARS &&
                lastInputAt !== undefined &&
                performance.now() - lastInputAt <= DaemonServer.INTERACTIVE_OUTPUT_WINDOW_MS
              this.streamDataBatcher.enqueue(clientId, p.sessionId, data, {
                flushImmediately: isInteractiveOutput,
                flushMaxChars: DaemonServer.INTERACTIVE_OUTPUT_MAX_CHARS
              })
            },
            onExit: (code) => {
              this.lastInputAtBySessionId.delete(p.sessionId)
              console.log(`[daemon] session ${p.sessionId} exited code=${code}`)
              this.streamDataBatcher.enqueueExit(clientId, p.sessionId, code)
            }
          }
        })
        console.log(
          `[daemon] session ${p.sessionId} ${result.isNew ? `created pid=${result.pid}` : 'attached'} client=${clientId}`
        )
        return {
          isNew: result.isNew,
          snapshot: this.fitSnapshot(p.sessionId, result.snapshot),
          pid: result.pid
        }
      }

      case 'cancelCreateOrAttach':
        return {}

      case 'write':
        try {
          this.lastInputAtBySessionId.set(request.payload.sessionId, performance.now())
          this.host.write(request.payload.sessionId, request.payload.data)
        } catch (err) {
          this.lastInputAtBySessionId.delete(request.payload.sessionId)
          if (err instanceof SessionNotFoundError) {
            return {}
          }
          throw err
        }
        return {}

      case 'resize':
        try {
          this.host.resize(request.payload.sessionId, request.payload.cols, request.payload.rows)
        } catch (err) {
          if (err instanceof SessionNotFoundError) {
            return {}
          }
          throw err
        }
        return {}

      case 'kill':
        this.lastInputAtBySessionId.delete(request.payload.sessionId)
        this.streamDataBatcher.dropSession(request.payload.sessionId)
        this.host.kill(request.payload.sessionId, { immediate: request.payload.immediate })
        console.log(`[daemon] session ${request.payload.sessionId} killed${request.payload.immediate ? ' (immediate)' : ''}`)
        return {}

      case 'signal':
        this.host.signal(request.payload.sessionId, request.payload.signal)
        return {}

      case 'detach':
        return {}

      case 'getCwd':
        return { cwd: await this.host.getCwd(request.payload.sessionId) }

      case 'getForegroundProcess':
        return { foregroundProcess: this.host.getForegroundProcess(request.payload.sessionId) }

      case 'clearScrollback':
        this.host.clearScrollback(request.payload.sessionId)
        return {}

      case 'listSessions':
        return { sessions: this.host.listSessions() }

      case 'getSnapshot':
        return {
          snapshot: this.fitSnapshot(request.payload.sessionId, this.host.getSnapshot(request.payload.sessionId))
        }

      case 'getSize':
        return { size: this.host.getAppliedSize(request.payload.sessionId) }

      case 'ping':
        return { pong: true }

      case 'systemResolverHealth':
        return { health: 'healthy' }

      case 'ptySpawnHealth':
        await this.ptySpawnHealthCheck()
        return { healthy: true }

      case 'shutdown':
        if (request.payload.killSessions) {
          this.host.dispose()
        }
        process.nextTick(() => {
          const done = this.shutdown()
          this.onShutdownRequested?.(done)
        })
        return {}
    }
    throw new Error(`Unknown request type: ${(request as { type: string }).type}`)
  }

  private fitSnapshot(sessionId: string, snapshot: TerminalSnapshot | null): TerminalSnapshot | null {
    if (!snapshot) {
      return snapshot
    }
    const fitted = fitSnapshotToLine(snapshot, this.maxLineBytes)
    if (fitted.trimmed) {
      console.warn(
        `[daemon] session ${sessionId} snapshot trimmed from ${fitted.originalBytes} to ${fitted.bytes} bytes to fit the line limit (oldest scrollback dropped)`
      )
    }
    return fitted.snapshot
  }
}
