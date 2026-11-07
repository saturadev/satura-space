
export interface ControlCommand {
  type: 'command'
  id: number
  cmd: string
  args?: Record<string, unknown>
}

export interface ControlResult {
  type: 'result'
  id: number
  status: 'completed' | 'error'
  error?: string | null
  [key: string]: unknown
}

export interface ControlEvent {
  type: 'event'
  event: string
  [key: string]: unknown
}

export type ControlMessage = ControlCommand | ControlResult | ControlEvent

export function encodeMessage(msg: ControlMessage): string {
  return JSON.stringify(msg) + '\n'
}

export function encodeHello(token: string): string {
  return JSON.stringify({ type: 'hello', token }) + '\n'
}

export function helloToken(line: string): string | null {
  try {
    const parsed: unknown = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object') return null
    const { type, token } = parsed as { type?: unknown; token?: unknown }
    return type === 'hello' && typeof token === 'string' ? token : null
  } catch {
    return null
  }
}

function isControlMessage(v: unknown): v is ControlMessage {
  return !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string'
}

export class NdjsonParser {
  private buf = ''

  push(chunk: string): ControlMessage[] {
    this.buf += chunk
    const out: ControlMessage[] = []
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isControlMessage(parsed)) out.push(parsed)
      } catch {
      }
    }
    return out
  }

  reset(): void {
    this.buf = ''
  }
}

export class PendingRequests {
  private seq = 0
  private readonly map = new Map<
    number,
    { resolve: (r: ControlResult | null) => void; timer: ReturnType<typeof setTimeout> }
  >()

  nextId(): number {
    return ++this.seq
  }

  waitFor(id: number, timeoutMs: number): Promise<ControlResult | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.map.delete(id)
        resolve(null)
      }, timeoutMs)
      this.map.set(id, { resolve, timer })
    })
  }

  settle(result: ControlResult): boolean {
    const p = this.map.get(result.id)
    if (!p) return false
    clearTimeout(p.timer)
    this.map.delete(result.id)
    p.resolve(result)
    return true
  }

  rejectAll(): void {
    for (const p of this.map.values()) {
      clearTimeout(p.timer)
      p.resolve(null)
    }
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
