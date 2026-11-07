export type StreamPhase = 'idle' | 'streaming' | 'disposed'

export type RejectReason = 'disposed' | 'bad-size' | 'retired-gen' | 'size-mismatch' | 'stale-seq'

export interface FramePacket {
  generation: number
  width: number
  height: number
  format: number
  seq: number | null
}

export interface StreamIdentity {
  generation: number
  width: number
  height: number
  format: number
}

export type FrameVerdict =
  | { ok: true; newGeneration: boolean; retired: StreamIdentity | null }
  | { ok: false; reason: RejectReason; count: number }

const RETIRED_KEEP = 64

export class GenerationLog {
  private retired: number[] = []
  current: number | null = null

  isRetired(gen: number): boolean {
    return this.retired.includes(gen)
  }

  admit(gen: number): 'current' | 'new' | 'retired' {
    if (gen === this.current) return 'current'
    if (this.isRetired(gen)) return 'retired'
    if (this.current != null) {
      this.retired.push(this.current)
      if (this.retired.length > RETIRED_KEEP) this.retired.shift()
    }
    this.current = gen
    return 'new'
  }

  retireCurrent(): void {
    if (this.current == null) return
    this.retired.push(this.current)
    if (this.retired.length > RETIRED_KEEP) this.retired.shift()
    this.current = null
  }
}

export class StreamGate {
  phase: StreamPhase = 'idle'
  identity: StreamIdentity | null = null
  lastSeq = 0
  accepted = 0
  readonly rejected: Record<RejectReason, number> = {
    disposed: 0,
    'bad-size': 0,
    'retired-gen': 0,
    'size-mismatch': 0,
    'stale-seq': 0
  }
  private gens = new GenerationLog()

  accept(p: FramePacket): FrameVerdict {
    if (this.phase === 'disposed') return this.reject('disposed')
    if (!(p.width > 0) || !(p.height > 0)) return this.reject('bad-size')
    const cur = this.identity
    if (cur && p.generation === cur.generation) {
      if (p.width !== cur.width || p.height !== cur.height || p.format !== cur.format) return this.reject('size-mismatch')
      if (p.seq != null && p.seq <= this.lastSeq) return this.reject('stale-seq')
      if (p.seq != null) this.lastSeq = p.seq
      this.accepted++
      return { ok: true, newGeneration: false, retired: null }
    }
    if (this.gens.admit(p.generation) === 'retired') return this.reject('retired-gen')
    this.identity = { generation: p.generation, width: p.width, height: p.height, format: p.format }
    this.lastSeq = p.seq ?? 0
    this.phase = 'streaming'
    this.accepted++
    return { ok: true, newGeneration: true, retired: cur }
  }

  stop(): StreamIdentity | null {
    const cur = this.identity
    if (this.phase === 'disposed') return null
    this.gens.retireCurrent()
    this.identity = null
    this.lastSeq = 0
    this.phase = 'idle'
    return cur
  }

  dispose(): StreamIdentity | null {
    const cur = this.stop()
    this.phase = 'disposed'
    return cur
  }

  private reject(reason: RejectReason): FrameVerdict {
    this.rejected[reason]++
    return { ok: false, reason, count: this.rejected[reason] }
  }
}

export interface HoldAck {
  upTo: number
  held: number[]
}

export interface HoldMessage {
  held: number[]
  upTo: number
  gen: number
  on?: 0
}

export class HoldBook {
  private acks = new Map<string, HoldAck>()
  private joined = new Map<string, number>()
  private sent = ''
  private gen = -1
  private seq = 0

  get generation(): number {
    return this.gen
  }

  get lastSent(): string {
    return this.sent
  }

  consumersWithAcks(): string[] {
    return [...this.acks.keys()]
  }

  onFrame(gen: number, seq: number | null, consumers: string[]): void {
    if (gen !== this.gen) this.resetFor(gen)
    if (seq == null) return
    for (const key of consumers) if (!this.joined.has(key)) this.joined.set(key, seq - 1)
    this.seq = seq
  }

  ack(consumer: string, gen: number, upTo: number, held: number[]): boolean {
    if (gen !== this.gen || this.gen < 0) return false
    this.acks.set(consumer, { upTo, held })
    return true
  }

  message(consumers: string[]): HoldMessage | null {
    if (this.gen < 0) return null
    const live = new Set(consumers)
    for (const key of [...this.acks.keys()]) if (!live.has(key)) this.acks.delete(key)
    for (const key of [...this.joined.keys()]) if (!live.has(key)) this.joined.delete(key)
    for (const key of consumers) if (!this.joined.has(key)) this.joined.set(key, this.seq)
    let msg: HoldMessage
    if (consumers.length === 0) msg = { held: [], upTo: 0, gen: this.gen, on: 0 }
    else {
      let upTo = Number.MAX_SAFE_INTEGER
      const held = new Set<number>()
      for (const key of consumers) {
        const a = this.acks.get(key)
        upTo = Math.min(upTo, Math.max(a?.upTo ?? 0, this.joined.get(key) ?? 0))
        for (const sid of a?.held ?? []) held.add(sid)
      }
      msg = { held: [...held].sort((a, b) => a - b), upTo, gen: this.gen }
    }
    const text = JSON.stringify(msg)
    if (text === this.sent) return null
    this.sent = text
    return msg
  }

  reset(): void {
    this.resetFor(-1)
  }

  private resetFor(gen: number): void {
    this.gen = gen
    this.seq = 0
    this.acks.clear()
    this.joined.clear()
    this.sent = ''
  }
}

export class RetireLedger<T> {
  private list: { gen: number; items: T[] }[] = []

  get size(): number {
    return this.list.length
  }

  retire(gen: number, items: T[]): void {
    if (items.length) this.list.push({ gen, items })
  }

  drain(busy: (gen: number) => boolean): { gen: number; items: T[] }[] {
    const out = this.list.filter((r) => !busy(r.gen))
    this.list = this.list.filter((r) => busy(r.gen))
    return out
  }
}
