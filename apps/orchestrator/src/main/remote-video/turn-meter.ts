export interface CandidateEnd {
  type: string
}

export interface TurnSample {
  pair: { local: CandidateEnd; remote: CandidateEnd } | null
  sent: number
  received: number
}

export interface TurnBytes {
  tx: number
  rx: number
  egress: number
}

export type TurnPath = 'local' | 'remote' | 'both' | null

function isRelay(end: CandidateEnd | undefined): boolean {
  return String(end?.type ?? '').toLowerCase() === 'relay'
}

function turnPath(pair: TurnSample['pair']): TurnPath {
  if (!pair) return null
  const local = isRelay(pair.local)
  const remote = isRelay(pair.remote)
  return local && remote ? 'both' : local ? 'local' : remote ? 'remote' : null
}

function grew(now: number, before: number): number {
  if (!Number.isFinite(now) || now < 0) return 0
  return now >= before ? now - before : now
}

export class TurnMeter {
  readonly total: TurnBytes = { tx: 0, rx: 0, egress: 0 }
  path: TurnPath = null
  private sent = 0
  private received = 0

  sample(s: TurnSample): TurnBytes | null {
    const tx = grew(s.sent, this.sent)
    const rx = grew(s.received, this.received)
    if (Number.isFinite(s.sent) && s.sent >= 0) this.sent = s.sent
    if (Number.isFinite(s.received) && s.received >= 0) this.received = s.received
    this.path = turnPath(s.pair)
    if (!this.path || (!tx && !rx)) return null
    const egress = (this.path === 'remote' ? 0 : rx) + (this.path === 'local' ? 0 : tx)
    this.total.tx += tx
    this.total.rx += rx
    this.total.egress += egress
    return { tx, rx, egress }
  }
}

export class TurnTally {
  readonly sinceStart: TurnBytes = { tx: 0, rx: 0, egress: 0 }
  readonly since = Date.now()
  private pending = new Map<string, TurnBytes>()

  add(cid: string, d: TurnBytes): void {
    const p = this.pending.get(cid) ?? { tx: 0, rx: 0, egress: 0 }
    p.tx += d.tx
    p.rx += d.rx
    p.egress += d.egress
    this.pending.set(cid, p)
    this.sinceStart.tx += d.tx
    this.sinceStart.rx += d.rx
    this.sinceStart.egress += d.egress
    while (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value as string)
  }

  pendingBytes(): number {
    let n = 0
    for (const p of this.pending.values()) n += p.tx + p.rx
    return n
  }

  drain(send: (cid: string, d: TurnBytes) => boolean): number {
    let sent = 0
    for (const [cid, d] of [...this.pending]) {
      if (!send(cid, d)) break
      this.pending.delete(cid)
      sent++
    }
    return sent
  }
}
