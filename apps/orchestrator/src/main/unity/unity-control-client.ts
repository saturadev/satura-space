import { createConnection, type Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import {
  type ControlEvent,
  type ControlResult,
  NdjsonParser,
  PendingRequests,
  encodeHello,
  encodeMessage
} from '@shared/control-protocol'

export type ControlEventHandler = (e: ControlEvent) => void

const controlTokens = new Map<number, string>()

export function setEditorControlToken(port: number, token: string): void {
  controlTokens.set(port, token)
}

export class UnityControlClient {
  private socket: Socket | null = null
  private readonly parser = new NdjsonParser()
  private readonly pending = new PendingRequests()
  private readonly decoder = new StringDecoder('utf8')
  private readonly events = new Set<ControlEventHandler>()
  private readonly connects = new Set<() => void>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private connected = false

  constructor(
    private readonly port: number,
    private readonly host = '127.0.0.1',
    private readonly reconnectMs = 500
  ) {
    this.connect()
  }

  get isConnected(): boolean {
    return this.connected
  }

  onEvent(cb: ControlEventHandler): () => void {
    this.events.add(cb)
    return () => this.events.delete(cb)
  }

  onConnect(cb: () => void): () => void {
    this.connects.add(cb)
    return () => this.connects.delete(cb)
  }

  async command(
    cmd: string,
    args?: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<ControlResult | null> {
    const id = this.pending.nextId()
    const wait = this.pending.waitFor(id, timeoutMs)
    if (!this.send({ type: 'command', id, cmd, args })) {
      this.pending.settle({ type: 'result', id, status: 'error', error: 'control socket not connected' })
    }
    return wait
  }

  notify(cmd: string, args?: Record<string, unknown>): boolean {
    return this.send({ type: 'command', id: this.pending.nextId(), cmd, args })
  }

  private send(msg: Parameters<typeof encodeMessage>[0]): boolean {
    if (!this.socket || !this.connected) return false
    try {
      this.socket.write(encodeMessage(msg))
      return true
    } catch {
      return false
    }
  }

  private connect(): void {
    if (this.closed) return
    const s = createConnection({ host: this.host, port: this.port })
    this.socket = s
    s.on('connect', () => {
      s.setNoDelay(true)
      try {
        s.write(encodeHello(controlTokens.get(this.port) ?? ''))
      } catch {
      }
      this.connected = true
      for (const cb of this.connects) {
        try {
          cb()
        } catch {
        }
      }
    })
    s.on('data', (chunk) => {
      for (const msg of this.parser.push(this.decoder.write(chunk))) {
        if (msg.type === 'result') this.pending.settle(msg)
        else if (msg.type === 'event')
          for (const cb of this.events) {
            try {
              cb(msg)
            } catch {
            }
          }
      }
    })
    s.on('error', () => {
    })
    s.on('close', () => {
      this.connected = false
      this.socket = null
      this.parser.reset()
      this.pending.rejectAll()
      if (!this.closed) this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs)
    })
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.pending.rejectAll()
    try {
      this.socket?.destroy()
    } catch {
    }
    this.socket = null
    this.connected = false
  }
}
