import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { TERM_EMPTY, captureLines, packTerm, encodeModes, frameOf, linkLookup, serializeLine, type CellLike, type LinkLookup, type TermMacMsg, type TermPhoneMsg, type TermState } from '@shared/remote-term'
import { censusGauge, censusLive, censusTrack } from '@shared/census'
import { getLocalPtyProvider, ptyOwnerWebContentsId, tapPtyExit, tapPtyOutput, tapPtyResize } from '../ipc/pty'

export interface TermLink {
  open: () => boolean
  send: (fast: boolean, text: string) => boolean
  buffered: () => number
}

interface Deps {
  sendWs: (cid: string, msg: TermMacMsg) => void
  writeInput: (cid: string, id: string, data: string) => void
  alive: (cid: string) => boolean
  log: (line: string) => void
}

interface CoreBits {
  coreService: { isCursorHidden: boolean; decPrivateModes: { cursorStyle?: string; cursorBlink?: boolean } }
  coreMouseService: { activeEncoding: string }
  buffers: { normal: { lines: { onTrim: (fn: (n: number) => void) => { dispose: () => void } } } }
  writeSync: (data: string) => void
}

const SCROLLBACK = 5000
const SB_CHUNK_BYTES = 48 * 1024
const FRAME_MS = 16
const FRAME_SLOW_MS = 50
const WS_FRAME_MS = 33
const SYNC_HOLD_MS = 150
const BUSY_BUFFERED = 128 * 1024
const MAX_SENT = 256
const STATS_MS = 5000
const RTO_MIN_MS = 25
const RESEND_CHECK_MS = 10
const RTO_MAX_MS = 2000
const MAX_COLS = 1000
const MAX_ROWS = 500

let deps: Deps | null = null
let link: TermLink | null = null
const mirrors = new Map<string, Mirror>()
let taps: (() => void)[] = []
censusTrack('term-mirror.mirrors', mirrors)
censusGauge('term-mirror.taps', () => taps.length)
const dropRate = Math.max(0, Math.min(0.9, Number(process.env.SATURA_REMOTE_TERM_DROP) || 0))

function now(): number {
  return performance.timeOrigin + performance.now()
}

class Mirror {
  term!: Terminal
  private core!: CoreBits
  private cell: CellLike | undefined
  private links: LinkLookup | undefined
  private seq = 0
  private acked: TermState = TERM_EMPTY
  private latest: TermState = TERM_EMPTY
  private sent = new Map<number, { state: TermState; at: number }>()
  private lastFrameAt = 0
  private timer: NodeJS.Timeout | null = null
  private resendTimer: NodeJS.Timeout | null = null
  private statsTimer: NodeJS.Timeout
  private dirty = true
  private syncSince = 0
  private trimmed = 0
  private sbNext = -1
  private epoch = 0
  private rtt = 80
  private backoff = 0
  private ready = false
  private started = false
  private pre: string[] = []
  private closed = false
  private stats = { frames: 0, resends: 0, keys: 0, bytes: 0, rows: 0, dropped: 0, sbLines: 0, acks: 0 }

  constructor(readonly id: string, public cid: string) {
    censusLive('term-mirror.Mirror', this)
    this.build()
    this.statsTimer = setInterval(() => this.logStats(), STATS_MS)
  }

  private build(): void {
    this.term = censusLive('term-mirror.Terminal', new Terminal({ cols: 80, rows: 24, scrollback: SCROLLBACK, allowProposedApi: true, logLevel: 'off' }))
    this.term.loadAddon(new Unicode11Addon())
    this.term.unicode.activeVersion = '11'
    this.core = (this.term as unknown as { _core: CoreBits })._core
    this.links = linkLookup(this.term)
    this.core.buffers.normal.lines.onTrim((n) => (this.trimmed += n))
    this.term.onTitleChange((title) => this.send(false, { t: 'title', id: this.id, title }))
  }

  async load(): Promise<string | null> {
    const provider = getLocalPtyProvider()
    const snap = await provider?.getScreenSnapshot?.(this.id).catch(() => null)
    const size = snap ?? (await provider?.getAppliedSize?.(this.id).catch(() => null))
    if (mirrors.get(this.id) !== this) return null
    if (!deps?.alive(this.cid)) {
      close(this.id)
      return null
    }
    if (size) this.resize(size.cols, size.rows)
    this.start(snap?.data ?? '')
    const cur = await provider?.getAppliedSize?.(this.id).catch(() => null)
    if (cur) this.resize(cur.cols, cur.rows)
    return this.closed ? null : snap ? `${snap.data.length} chars` : 'none'
  }

  private start(snapshot: string): void {
    this.started = true
    this.guard(() => {
      for (const d of [snapshot, ...this.pre.splice(0)]) if (d) this.core.writeSync(d)
      this.ready = true
      this.restart()
    })
  }

  feed(data: string): void {
    if (!this.started) this.pre.push(data)
    else
      this.guard(() => {
        this.core.writeSync(data)
        this.touch()
      })
  }

  resize(cols: number, rows: number): void {
    const c = Math.min(MAX_COLS, Math.floor(cols))
    const r = Math.min(MAX_ROWS, Math.floor(rows))
    if (!(c > 0 && r > 0)) return
    this.guard(() => {
      if (c === this.term.cols && r === this.term.rows) return
      this.term.resize(c, r)
      if (this.ready) this.sendScrollback(true)
      this.touch()
    })
  }

  restart(): void {
    this.guard(() => {
      this.acked = TERM_EMPTY
      this.sent.clear()
      this.stats.keys++
      this.sendScrollback(true)
      this.dirty = true
      this.schedule(0)
    })
  }

  private guard(fn: () => void): void {
    if (this.closed) return
    try {
      fn()
    } catch (e) {
      this.fail(e)
    }
  }

  private fail(e: unknown): void {
    const why = e instanceof Error ? e.message : String(e)
    if (!this.ready) {
      deps?.log(`[term] ${this.id} mirror failed while loading (${why}), closing it`)
      close(this.id)
      return
    }
    deps?.log(`[term] ${this.id} mirror failed (${why}), rebuilding it from the terminal snapshot`)
    try {
      this.term.dispose()
    } catch {}
    this.ready = this.started = false
    this.trimmed = 0
    this.sbNext = -1
    this.build()
    void this.load()
  }

  onAck(seq: number): void {
    this.stats.acks++
    if (seq <= this.acked.seq) return
    const s = this.sent.get(seq)
    if (!s) return
    this.rtt = this.rtt * 0.8 + Math.max(1, now() - s.at) * 0.2
    this.backoff = 0
    this.acked = s.state
    for (const k of this.sent.keys()) if (k < seq) this.sent.delete(k)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.resendTimer) clearInterval(this.resendTimer)
    clearInterval(this.statsTimer)
    try {
      this.term.dispose()
    } catch {}
  }

  private touch(): void {
    this.dirty = true
    this.schedule()
  }

  private viaDc(): boolean {
    return !!link?.open()
  }

  private schedule(delay?: number): void {
    if (this.timer || this.closed || !this.ready) return
    const busy = this.viaDc() && (link?.buffered() ?? 0) > BUSY_BUFFERED
    const gap = this.viaDc() ? (busy ? FRAME_SLOW_MS : FRAME_MS) : WS_FRAME_MS
    const wait = delay ?? Math.max(0, this.lastFrameAt + gap - performance.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.guard(() => this.tick())
    }, wait)
  }

  private tick(): void {
    if (!this.ready || !this.dirty) return
    if (this.term.modes.synchronizedOutputMode) {
      const t = performance.now()
      if (!this.syncSince) this.syncSince = t
      if (t - this.syncSince < SYNC_HOLD_MS) {
        this.timer = setTimeout(() => {
          this.timer = null
          this.guard(() => this.tick())
        }, FRAME_MS)
        return
      }
    }
    this.syncSince = 0
    this.dirty = false
    this.trackScrollback()
    const state = this.capture()
    if (state.seq === 0) return
    this.latest = state
    this.sendFrame(state)
  }

  private capture(): TermState {
    const t = this.term
    const b = t.buffer.active
    const cols = t.cols
    const rows = t.rows
    this.cell ??= b.getLine(0)?.getCell(0) as CellLike | undefined
    const lines = captureLines(t as never, this.cell, this.links)
    const prev = this.latest
    const priv = this.core.coreService.decPrivateModes
    const head = {
      cols,
      rows,
      alt: b.type === 'alternate',
      cx: Math.min(cols - 1, b.cursorX),
      cy: Math.min(rows - 1, b.cursorY),
      cursor: !this.core.coreService.isCursorHidden,
      modes: encodeModes(t.modes, this.core.coreMouseService.activeEncoding, priv.cursorStyle ?? 'block', priv.cursorBlink ?? true)
    }
    const same =
      prev.seq > 0 &&
      prev.cols === head.cols &&
      prev.rows === head.rows &&
      prev.alt === head.alt &&
      prev.cx === head.cx &&
      prev.cy === head.cy &&
      prev.cursor === head.cursor &&
      prev.modes === head.modes &&
      prev.lines.every((l, i) => l === lines[i])
    if (same) return { ...prev, seq: 0 }
    return { seq: ++this.seq, ...head, lines }
  }

  private sendFrame(state: TermState, resend = false): void {
    const f = frameOf(this.id, this.acked, state)
    const text = JSON.stringify(f)
    this.lastFrameAt = performance.now()
    this.resendTimer ??= setInterval(() => this.guard(() => this.resend()), RESEND_CHECK_MS)
    if (!resend) {
      this.sent.set(state.seq, { state, at: now() })
      if (this.sent.size > MAX_SENT) this.sent.delete(this.sent.keys().next().value as number)
      this.stats.frames++
    } else this.stats.resends++
    if (f.base === 0) this.stats.keys++
    this.stats.rows += f.set.length
    if (this.viaDc() && dropRate > 0 && Math.random() < dropRate) {
      this.stats.dropped++
      return
    }
    this.sendText(true, text, f)
  }

  private resend(): void {
    if (this.closed || this.latest.seq <= this.acked.seq || !this.viaDc()) {
      if (this.resendTimer) clearInterval(this.resendTimer)
      this.resendTimer = null
      return
    }
    const rto = Math.min(RTO_MAX_MS, Math.max(RTO_MIN_MS, Math.min(1000, this.rtt * 2 + 10)) * 2 ** this.backoff)
    if (performance.now() - this.lastFrameAt < rto) return
    this.backoff = Math.min(6, this.backoff + 1)
    this.sendFrame(this.latest, true)
  }

  private trackScrollback(): void {
    const normal = this.term.buffer.normal
    const top = this.trimmed + normal.baseY
    if (this.sbNext < 0) return
    if (top < this.sbNext) {
      this.sendScrollback(true)
      return
    }
    if (top === this.sbNext) return
    let from = Math.max(this.sbNext, this.trimmed, top - SCROLLBACK)
    const lines: string[] = []
    for (; from < top; from++) lines.push(serializeLine(normal.getLine(from - this.trimmed) as never, this.term.cols, this.cell, this.links))
    this.pushLines(top - lines.length, lines, false)
    this.sbNext = top
  }

  private sendScrollback(reset: boolean): void {
    const normal = this.term.buffer.normal
    const top = this.trimmed + normal.baseY
    const lines: string[] = []
    for (let y = 0; y < normal.baseY; y++) lines.push(serializeLine(normal.getLine(y) as never, this.term.cols, this.cell, this.links))
    if (reset) this.epoch++
    this.pushLines(this.trimmed, lines, reset)
    this.sbNext = top
  }

  private pushLines(from: number, lines: string[], reset: boolean): void {
    let start = 0
    let bytes = 0
    let first = true
    const flush = (end: number): void => {
      if (end <= start && !(reset && first)) return
      this.send(false, { t: 'sb', id: this.id, epoch: this.epoch, from: from + start, cols: this.term.cols, rows: this.term.rows, lines: lines.slice(start, end), ...(reset && first ? { reset: true } : {}) })
      first = false
      start = end
      bytes = 0
    }
    for (let i = 0; i < lines.length; i++) {
      bytes += lines[i].length + 4
      if (bytes > SB_CHUNK_BYTES) flush(i + 1)
    }
    flush(lines.length)
    this.stats.sbLines += lines.length
  }

  send(fast: boolean, msg: TermMacMsg): void {
    this.sendText(fast, JSON.stringify(msg), msg)
  }

  private sendText(fast: boolean, text: string, msg: TermMacMsg): void {
    if (this.closed) return
    const out = link?.open() ? packTerm(text) : text
    if (fast) this.stats.bytes += out.length
    if (link?.open() && link.send(fast, out)) return
    deps?.sendWs(this.cid, msg)
  }

  private logStats(): void {
    const s = this.stats
    if (!s.frames && !s.resends && !s.sbLines) return
    deps?.log(
      `[term] ${this.id} ${this.viaDc() ? 'datachannel' : 'websocket'} ${s.frames} frames ${s.resends} resends ${s.keys} keyframes ${s.rows} rows ${Math.round(s.bytes / 1024 / (STATS_MS / 1000))} KB/s ${s.sbLines} scrollback lines ${s.acks} acks rtt ${Math.round(this.rtt)} ms${dropRate ? ` dropped ${s.dropped} (${Math.round(dropRate * 100)}% test loss)` : ''}`
    )
    this.stats = { frames: 0, resends: 0, keys: 0, bytes: 0, rows: 0, dropped: 0, sbLines: 0, acks: 0 }
  }
}

function dropTapsWhenIdle(): void {
  if (mirrors.size || !taps.length) return
  for (const off of taps) off()
  taps = []
}

function ensureTaps(): void {
  if (taps.length) return
  taps = [
    tapPtyOutput((id, data) => mirrors.get(id)?.feed(data)),
    tapPtyExit((id, code) => {
      const m = mirrors.get(id)
      if (!m) return
      m.send(false, { t: 'exit', id, code })
      m.close()
      mirrors.delete(id)
      dropTapsWhenIdle()
    }),
    tapPtyResize((id, cols, rows) => mirrors.get(id)?.resize(cols, rows))
  ]
}

async function open(cid: string, id: string): Promise<void> {
  const known = mirrors.get(id)
  if (known) {
    known.cid = cid
    known.restart()
    return
  }
  const provider = getLocalPtyProvider()
  if (!provider || ptyOwnerWebContentsId(id) === undefined) {
    deps?.sendWs(cid, { t: 'error', id, message: 'That terminal is not running on the desktop' })
    return
  }
  if (!deps?.alive(cid)) return
  ensureTaps()
  const m = new Mirror(id, cid)
  mirrors.set(id, m)
  const snap = await m.load()
  if (snap) deps?.log(`[term] ${id} mirrored for ${m.cid} at ${m.term.cols}x${m.term.rows}, snapshot ${snap}`)
}

function close(id: string): void {
  const m = mirrors.get(id)
  if (!m) return
  m.close()
  mirrors.delete(id)
  dropTapsWhenIdle()
  deps?.log(`[term] ${id} mirror closed`)
}

export function configureTermMirror(d: Deps): void {
  deps = d
}

export function setTermLink(l: TermLink | null): void {
  link = l
  if (l?.open()) for (const m of mirrors.values()) m.restart()
}

export function termLinkOpened(): void {
  for (const m of mirrors.values()) m.restart()
}

export function termFromPhone(cid: string, raw: unknown): void {
  const m = raw as TermPhoneMsg | null
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) return
  if (m.t === 'in') {
    if (typeof m.data === 'string' && m.data) deps?.writeInput(cid, m.id, m.data)
    return
  }
  if (m.t === 'ack') {
    mirrors.get(m.id)?.onAck(Number(m.seq) || 0)
    return
  }
  if (m.t === 'open') {
    void open(cid, m.id)
    return
  }
  if (m.t === 'key') {
    mirrors.get(m.id)?.restart()
    return
  }
  if (m.t === 'close') close(m.id)
}

export function termPhoneLeft(cid: string): void {
  for (const [id, m] of [...mirrors]) if (m.cid === cid) close(id)
}

export function termMirrors(): { id: string; cid: string; cols: number; rows: number }[] {
  return [...mirrors.values()].map((m) => ({ id: m.id, cid: m.cid, cols: m.term.cols, rows: m.term.rows }))
}

export function termMirrorTerminal(id: string): Terminal | undefined {
  return mirrors.get(id)?.term
}

export function resizeTermMirror(id: string, cols: number, rows: number): boolean {
  mirrors.get(id)?.resize(cols, rows)
  return mirrors.has(id)
}
