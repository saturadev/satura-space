import { applyPatch, compare, type Operation } from 'fast-json-patch'
import { encodeRemote } from './remote-protocol'

export const LINK_LABEL = 'rpc'
export const LINK_PACK_MIN = 1024
export const LINK_FRAGMENT_BYTES = 16 * 1024
export const LINK_DELTA_MIN = 1024
export const LINK_DELTA_KEYS = 48
export const LINK_STALL_MS = 2500
export const LINK_BUSY_MS = 3200
export const LINK_SWITCH_WINDOW_MS = 60_000
export const LINK_ACK_MS = 40
export const LINK_MAX_UNACKED_BYTES = 32 * 1024 * 1024
export const LINK_MAX_HELD = 20_000
export const LINK_INTERN_MIN = 200
export const LINK_INTERN_MAX_CHARS = 8_000_000

const F_DEFLATE = 1
const F_MORE = 2

export interface LinkCodec {
  deflate: (raw: Uint8Array) => Uint8Array
  inflate: (packed: Uint8Array) => Uint8Array
}

export type LinkFrame = Record<string, any>
export type LinkField = 'args' | 'value'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function packLink(text: string, codec: LinkCodec): (string | Uint8Array)[] {
  if (text.length < LINK_PACK_MIN) return [text]
  const raw = textEncoder.encode(text)
  const packed = codec.deflate(raw)
  const deflated = packed.byteLength < raw.byteLength
  const body = deflated ? packed : raw
  const out: Uint8Array[] = []
  let at = 0
  do {
    const end = Math.min(body.byteLength, at + LINK_FRAGMENT_BYTES)
    const msg = new Uint8Array(end - at + 1)
    msg[0] = (deflated ? F_DEFLATE : 0) | (end < body.byteLength ? F_MORE : 0)
    msg.set(body.subarray(at, end), 1)
    out.push(msg)
    at = end
  } while (at < body.byteLength)
  return out
}

export class LinkUnpacker {
  private parts: Uint8Array[] = []

  constructor(private readonly codec: LinkCodec) {}

  push(msg: string | ArrayBuffer | Uint8Array): string | null {
    if (typeof msg === 'string') return msg
    const u8 = msg instanceof Uint8Array ? msg : new Uint8Array(msg)
    if (!u8.byteLength) return null
    this.parts.push(u8.subarray(1))
    if (u8[0] & F_MORE) return null
    const parts = this.parts
    this.parts = []
    let body = parts[0]
    if (parts.length > 1) {
      body = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
      let o = 0
      for (const p of parts) {
        body.set(p, o)
        o += p.byteLength
      }
    }
    return textDecoder.decode(u8[0] & F_DEFLATE ? this.codec.inflate(body) : body)
  }

  reset(): void {
    this.parts = []
  }
}

export function frameText(head: LinkFrame, field?: LinkField, body?: string): string {
  const h = JSON.stringify(head)
  if (!field || body === undefined) return h
  return `${h.slice(0, -1)}${h.length > 2 ? ',' : ''}"${field}":${body}}`
}

export function deltaKeyOf(ch: string, args: unknown[]): string {
  const a = args[0] as { projectPath?: unknown; session?: unknown; state?: { session?: unknown } } | null | undefined
  if (!a || typeof a !== 'object') return `e:${ch}`
  const session = typeof a.session === 'string' ? a.session : typeof a.state?.session === 'string' ? a.state.session : ''
  return `e:${ch}:${typeof a.projectPath === 'string' ? a.projectPath : ''}:${session}`
}

export class LinkBroken extends Error {}

function isRef(v: unknown): v is { $r: number } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const keys = Object.keys(v)
  return keys.length === 1 && keys[0] === '$r' && typeof (v as { $r: unknown }).$r === 'number'
}

class StringBook {
  private ids = new Map<string, number>()
  private byId = new Map<number, string>()
  private next = 1
  private chars = 0

  clear(): void {
    this.ids.clear()
    this.byId.clear()
    this.next = 1
    this.chars = 0
  }

  full(v: unknown): boolean {
    let add = 0
    const walk = (x: unknown): void => {
      if (typeof x === 'string') {
        if (x.length >= LINK_INTERN_MIN && !this.ids.has(x)) add += x.length
      } else if (Array.isArray(x)) for (const y of x) walk(y)
      else if (x && typeof x === 'object') for (const k in x as Record<string, unknown>) walk((x as Record<string, unknown>)[k])
    }
    walk(v)
    return this.chars + add > LINK_INTERN_MAX_CHARS
  }

  pack(v: unknown): { value: unknown; changed: boolean } {
    let changed = false
    const walk = (x: unknown): unknown => {
      if (typeof x === 'string') {
        if (x.length < LINK_INTERN_MIN) return x
        const id = this.ids.get(x)
        if (id !== undefined) {
          changed = true
          return { $r: id }
        }
        this.ids.set(x, this.next++)
        this.chars += x.length
        return x
      }
      if (Array.isArray(x)) {
        let out: unknown[] | null = null
        for (let i = 0; i < x.length; i++) {
          const y = walk(x[i])
          if (y !== x[i]) (out ??= x.slice())[i] = y
        }
        return out ?? x
      }
      if (x && typeof x === 'object') {
        let out: Record<string, unknown> | null = null
        const o = x as Record<string, unknown>
        for (const k in o) {
          const y = walk(o[k])
          if (y !== o[k]) (out ??= { ...o })[k] = y
        }
        return out ?? x
      }
      return x
    }
    const value = walk(v)
    return { value, changed }
  }

  unpack(v: unknown): unknown {
    if (typeof v === 'string') {
      if (v.length >= LINK_INTERN_MIN) {
        this.byId.set(this.next++, v)
        this.chars += v.length
      }
      return v
    }
    if (isRef(v)) {
      const s = this.byId.get(v.$r)
      if (s === undefined) throw new LinkBroken(`no string ${v.$r}`)
      return s
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = this.unpack(v[i])
      return v
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      for (const k in o) o[k] = this.unpack(o[k])
    }
    return v
  }
}

export interface LinkPeerOptions {
  name: string
  relay: (text: string, label: string) => boolean
  direct: (text: string, label: string) => boolean
  deliver: (frame: LinkFrame, path: 'relay' | 'direct') => void
  loose: (a: number) => LinkFrame
  log: (line: string) => void
  deltas: boolean
  stampAlways: boolean
  overflow: (why: string) => void
  broken: (why: string) => void
  heard?: () => number
  now?: () => number
  maxBody?: number
  tooBig?: (head: LinkFrame, bytes: number) => LinkFrame | null
}

export interface LinkSwitch {
  at: number
  direct: boolean
  why: string
}

export interface LinkPeerDiag {
  direct: boolean
  unacked: number
  oldestMs: number
  resent: number
  switches: number
  last: LinkSwitch | null
  ackMs: number | null
}

interface Sent {
  s: number
  text: string
  label: string
  at: number
}

function newEpoch(): string {
  return Math.random().toString(36).slice(2, 10)
}

export class LinkPeer {
  seq = false
  private epoch = newEpoch()
  private peerEpoch = ''
  private early: { m: LinkFrame; path: 'relay' | 'direct' }[] = []
  private nextSeq = 1
  private sent: Sent[] = []
  private sentBytes = 0
  private delivered = 0
  private held = new Map<number, LinkFrame>()
  private ackedOut = 0
  private ackTimer: ReturnType<typeof setTimeout> | null = null
  private directOn = false
  private gen = 0
  private bases = new Map<number, unknown>()
  private keyIds = new Map<string, number>()
  private nextKey = 1
  private strings = new StringBook()
  private switches: LinkSwitch[] = []
  private ackMs: number | null = null
  readonly stats = { direct: 0, relay: 0, resent: 0, dups: 0, held: 0, stale: 0, deltas: 0, deltaBytes: 0, fullBytes: 0 }

  constructor(private readonly opts: LinkPeerOptions) {}

  get direct(): boolean {
    return this.directOn
  }

  get unacked(): number {
    return this.sent.length
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  private keyId(key: string): number {
    let id = this.keyIds.get(key)
    if (id === undefined) {
      id = this.nextKey++
      this.keyIds.set(key, id)
    }
    return id
  }

  private touch(id: number, value: unknown): void {
    this.bases.delete(id)
    this.bases.set(id, value)
    while (this.bases.size > LINK_DELTA_KEYS) this.bases.delete(this.bases.keys().next().value as number)
  }

  send(head: LinkFrame, field?: LinkField, payload?: unknown, deltaKey?: string, label = String(head.ch ?? head.t)): void {
    let body = field ? (encodeRemote(payload) as string | undefined) : undefined
    const max = this.opts.maxBody ?? 0
    if (max > 0 && body !== undefined && body.length * 3 > max) {
      const bytes = body.length > max ? body.length : textEncoder.encode(body).byteLength
      if (bytes > max) {
        this.opts.log(`${this.opts.name}: ${label} is ${Math.round(bytes / 1048576)} MB, over the ${Math.round(max / 1048576)} MB a frame may carry, not sent`)
        const instead = this.opts.tooBig?.(head, bytes) ?? null
        if (instead) this.send(instead, undefined, undefined, undefined, label)
        return
      }
    }
    let out: LinkFrame = head
    let outField: LinkField | undefined = body === undefined ? undefined : field
    if (this.seq && this.opts.deltas && outField && body !== undefined && deltaKey && body.length >= LINK_DELTA_MIN && (body[0] === '{' || body[0] === '[') && !body.includes('"$u8"')) {
      const id = this.keyId(deltaKey)
      const next = JSON.parse(body) as object
      const base = this.bases.get(id)
      out = { ...head, k: id }
      let sent: unknown = next
      if (base !== undefined && typeof base === 'object' && base !== null && Array.isArray(base) === Array.isArray(next)) {
        const patch = compare(base, next)
        const ptext = JSON.stringify(patch)
        if (ptext.length < body.length / 2) {
          this.stats.deltas++
          this.stats.deltaBytes += ptext.length
          this.stats.fullBytes += body.length
          out = { ...out, p: 1, d: field }
          body = ptext
          outField = 'value'
          sent = patch
        }
      }
      this.touch(id, next)
      if (this.strings.full(sent)) {
        this.strings.clear()
        out = { ...out, x: 1 }
      }
      const packed = this.strings.pack(sent)
      if (packed.changed) body = JSON.stringify(packed.value)
    }
    if (!this.seq && !this.opts.stampAlways) {
      this.wire(frameText(out, outField, body), label)
      return
    }
    const s = this.nextSeq++
    out = { ...out, s, e: this.epoch, a: this.delivered }
    this.ackedOut = this.delivered
    const text = frameText(out, outField, body)
    if (this.seq) {
      this.sent.push({ s, text, label, at: this.now() })
      this.sentBytes += text.length
      if (this.sentBytes > LINK_MAX_UNACKED_BYTES) {
        this.opts.overflow(`${this.sent.length} frames (${Math.round(this.sentBytes / 1048576)} MB) wait for an answer`)
        return
      }
    }
    this.wire(text, label)
  }

  private wire(text: string, label: string): void {
    if (this.directOn) {
      if (this.opts.direct(text, label)) {
        this.stats.direct++
        return
      }
      this.setDirect(false, 'the data channel is closed')
      return
    }
    this.stats.relay++
    this.opts.relay(text, label)
  }

  receive(m: LinkFrame, path: 'relay' | 'direct'): void {
    if (typeof m.e === 'string') {
      if (!this.peerEpoch) {
        if (path !== 'relay') {
          if (this.early.length < LINK_MAX_HELD) this.early.push({ m, path })
          return
        }
        this.peerEpoch = m.e
        const early = this.early
        this.early = []
        this.receive(m, path)
        for (const x of early) this.receive(x.m, x.path)
        return
      }
      if (m.e !== this.peerEpoch) {
        this.stats.stale++
        return
      }
    }
    if (typeof m.a === 'number') this.acked(m.a)
    if (m.t === 'ack' || m.ch === 'remote:ack') return
    if (typeof m.s !== 'number') {
      this.take(m, path)
      return
    }
    this.seq = true
    if (m.s <= this.delivered) {
      this.stats.dups++
      this.scheduleAck()
      return
    }
    if (m.s > this.delivered + 1) {
      this.stats.held++
      this.held.set(m.s, m)
      if (this.held.size > LINK_MAX_HELD) this.opts.broken(`${this.held.size} frames wait for frame ${this.delivered + 1}`)
      return
    }
    this.delivered = m.s
    this.take(m, path)
    for (let next = this.held.get(this.delivered + 1); next; next = this.held.get(this.delivered + 1)) {
      this.held.delete(next.s)
      this.delivered = next.s
      this.take(next, path)
    }
    this.scheduleAck()
  }

  private take(m: LinkFrame, path: 'relay' | 'direct'): void {
    let frame = m
    try {
      frame = this.expand(m)
    } catch (e) {
      this.opts.broken(`frame ${m.s ?? '-'} (${m.ch ?? m.t}) did not apply: ${(e as Error).message}`)
      return
    }
    this.opts.deliver(frame, path)
  }

  private expand(m: LinkFrame): LinkFrame {
    if (typeof m.k !== 'number') return m
    if (m.x) this.strings.clear()
    const carried: LinkField = m.p || m.t !== 'evt' ? 'value' : 'args'
    if (carried in m) m[carried] = this.strings.unpack(m[carried])
    if (m.p) {
      const base = this.bases.get(m.k)
      if (base === undefined) throw new LinkBroken(`no base for delta key ${m.k}`)
      const doc = applyPatch(base, m.value as Operation[], false, true).newDocument
      this.touch(m.k, doc)
      const field: LinkField = m.d === 'args' ? 'args' : 'value'
      const out: LinkFrame = { ...m, [field]: structuredClone(doc) }
      if (field !== 'value') delete out.value
      delete out.p
      delete out.d
      return out
    }
    const field: LinkField = m.t === 'evt' ? 'args' : 'value'
    if (field in m) this.touch(m.k, structuredClone(m[field]))
    return m
  }

  private acked(a: number): void {
    let i = 0
    while (i < this.sent.length && this.sent[i].s <= a) {
      this.sentBytes -= this.sent[i].text.length
      i++
    }
    if (!i) return
    const ms = this.now() - this.sent[i - 1].at
    this.ackMs = this.ackMs === null ? ms : Math.round(this.ackMs * 0.8 + ms * 0.2)
    this.sent.splice(0, i)
  }

  private scheduleAck(): void {
    if (this.ackTimer) return
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null
      if (this.delivered <= this.ackedOut) return
      this.ackedOut = this.delivered
      const text = JSON.stringify({ ...this.opts.loose(this.delivered), e: this.epoch })
      if (this.directOn && this.opts.direct(text, 'ack')) return
      this.opts.relay(text, 'ack')
    }, LINK_ACK_MS)
  }

  setDirect(on: boolean, why: string): void {
    if (on === this.directOn) return
    this.directOn = on
    const gen = ++this.gen
    this.switches.push({ at: this.now(), direct: on, why })
    if (this.switches.length > 40) this.switches.splice(0, this.switches.length - 40)
    this.opts.log(`${this.opts.name} now on the ${on ? 'data channel' : 'relay'} (${why})${this.sent.length ? `, sending ${this.sent.length} unanswered frames again` : ''}`)
    const now = this.now()
    for (const f of [...this.sent]) {
      if (gen !== this.gen) return
      f.at = now
      this.stats.resent++
      this.wire(f.text, 'resend')
    }
  }

  tick(): void {
    const first = this.sent[0]
    if (!this.directOn || !first) return
    const now = this.now()
    const waited = now - first.at
    if (waited <= LINK_STALL_MS) return
    const quiet = this.opts.heard ? now - this.opts.heard() : waited
    if (quiet > LINK_STALL_MS) this.setDirect(false, `no answer on the data channel for ${Math.round(Math.min(waited, quiet) / 1000)} s`)
    else if (waited > LINK_BUSY_MS) this.setDirect(false, `calls waited ${Math.round(waited / 1000)} s on a busy data channel`)
  }

  diag(): LinkPeerDiag {
    const now = this.now()
    const first = this.sent[0]
    return {
      direct: this.directOn,
      unacked: this.sent.length,
      oldestMs: first ? Math.max(0, now - first.at) : 0,
      resent: this.stats.resent,
      switches: this.switches.filter((x) => now - x.at < LINK_SWITCH_WINDOW_MS).length,
      last: this.switches[this.switches.length - 1] ?? null,
      ackMs: this.ackMs
    }
  }

  reset(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = null
    this.seq = false
    this.epoch = newEpoch()
    this.peerEpoch = ''
    this.early = []
    this.nextSeq = 1
    this.sent = []
    this.sentBytes = 0
    this.delivered = 0
    this.held.clear()
    this.ackedOut = 0
    this.directOn = false
    this.gen++
    this.ackMs = null
    this.bases.clear()
    this.keyIds.clear()
    this.nextKey = 1
    this.strings.clear()
  }
}
