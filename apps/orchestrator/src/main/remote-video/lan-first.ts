const HOLD_MS = 1000

function parse(candidate: string): { kind: string; address: string } {
  const f = candidate.replace(/^a=/, '').trim().split(/\s+/)
  return { kind: f[7] ?? 'unknown', address: f[4] ?? '' }
}

const v4 = (a: string): boolean => /^\d+\.\d+\.\d+\.\d+$/.test(a)

export class LanFirst {
  private held: (() => void)[] = []
  private timer: NodeJS.Timeout | null = null
  private open = false
  private since = 0
  private own = new Set<string>()
  private phone = new Set<string>()

  constructor(
    private readonly name: string,
    private readonly log: (line: string) => void
  ) {}

  ownCandidate(candidate: string): void {
    const c = parse(candidate)
    if (c.kind !== 'srflx' || !v4(c.address)) return
    this.own.add(c.address)
    this.elsewhere()
  }

  phoneCandidate(candidate: string, apply: () => void): void {
    const c = parse(candidate)
    if (this.open || c.kind === 'host') return apply()
    if (c.kind === 'srflx' && v4(c.address)) this.phone.add(c.address)
    this.held.push(apply)
    if (!this.timer) {
      this.since = Date.now()
      this.timer = setTimeout(() => this.release(`no route on the same network within ${HOLD_MS} ms`), HOLD_MS)
    }
    this.elsewhere()
  }

  release(why: string): void {
    if (this.open) return
    this.open = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const list = this.held
    this.held = []
    if (list.length) this.log(`${this.name}: ${why}, ${list.length} internet candidate(s) from the phone go in after ${Date.now() - this.since} ms`)
    for (const apply of list) apply()
  }

  stop(): void {
    this.open = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.held = []
  }

  private elsewhere(): void {
    if (this.open || !this.own.size || !this.phone.size) return
    for (const ip of this.phone) if (this.own.has(ip)) return
    this.release('the phone is behind another router')
  }
}
