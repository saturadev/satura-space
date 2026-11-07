import { open, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import type { UnityLogLine } from '@shared/api'

const RAW_REL = join('.sspace', '.mcp_logs', 'console.log')
const POLL_MS = 150
const RING_CAP = 5000
const RING_SLACK = 1000
const READ_CAP = 1024 * 1024
const SNAPSHOT_CAP = 2000
const EMIT_CAP = 5000
const SEED_TAIL_BYTES = 256 * 1024
const MAX_STACK_CHARS = 8000

const HEADER = /^\[F:(-?\d+) T:([\d.]+)\] ([LWEP]) ?(.*)$/s

interface Header {
  frame: number
  time: number
  sev: string
  message: string
}

function parseHeader(line: string): Header | null {
  const m = HEADER.exec(line)
  if (!m) return null
  return { frame: Number(m[1]), time: Number(m[2]), sev: m[3], message: m[4] }
}

function severityFor(sev: string): UnityLogLine['severity'] {
  return sev === 'E' ? 'error' : sev === 'W' ? 'warn' : 'log'
}

type Emit = (projectKey: string, lines: UnityLogLine[]) => void

interface Tailer {
  refs: number
  ring: UnityLogLine[]
  offset: number
  pending: string
  current: UnityLogLine | null
  timer: ReturnType<typeof setInterval> | null
  seeding: Promise<void> | null
  reading: boolean
}

function newTailer(): Tailer {
  return {
    refs: 0,
    ring: [],
    offset: 0,
    pending: '',
    current: null,
    timer: null,
    seeding: null,
    reading: false
  }
}

class LogTailerCore {
  private tailers = new Map<string, Tailer>()
  private seq: number

  constructor(
    private emit: Emit,
    seqBase = 0
  ) {
    this.seq = seqBase
  }

  parseForTest(text: string): UnityLogLine[] {
    const t = newTailer()
    const batch: UnityLogLine[] = []
    this.ingest('test', t, text, true, batch)
    if (t.pending !== '') this.ingest('test', t, '\n', true, batch)
    this.flushCurrent(t, true, batch)
    return batch
  }

  private key(projectPath: string): string {
    return resolve(projectPath)
  }

  private filePath(key: string): string {
    return join(key, RAW_REL)
  }

  private nextSeq(): number {
    return ++this.seq
  }

  async subscribe(projectPath: string): Promise<UnityLogLine[]> {
    const key = this.key(projectPath)
    let t = this.tailers.get(key)
    if (!t) {
      t = newTailer()
      this.tailers.set(key, t)
      const created = t
      created.seeding = this.seed(key, created).then(() => {
        created.seeding = null
        if (this.tailers.get(key) !== created || created.refs <= 0) return
        created.timer = setInterval(() => void this.poll(key, created), POLL_MS)
      })
    }
    t.refs++
    if (t.seeding) await t.seeding
    return t.ring.slice(-SNAPSHOT_CAP)
  }

  unsubscribe(projectPath: string): void {
    const key = this.key(projectPath)
    const t = this.tailers.get(key)
    if (!t) return
    t.refs--
    if (t.refs <= 0) {
      if (t.timer) clearInterval(t.timer)
      this.tailers.delete(key)
    }
  }

  snapshot(projectPath: string): UnityLogLine[] {
    return this.tailers.get(this.key(projectPath))?.ring.slice(-SNAPSHOT_CAP) ?? []
  }

  reset(projectPath: string): void {
    const key = this.key(projectPath)
    const t = this.tailers.get(key)
    if (!t) return
    t.offset = 0
    t.pending = ''
    t.current = null
    t.ring = []
    this.emit(key, [
      { seq: this.nextSeq(), severity: 'log', kind: 'restart', frame: -1, time: 0, message: '' }
    ])
  }

  private async seed(key: string, t: Tailer): Promise<void> {
    try {
      const file = this.filePath(key)
      const s = await stat(file)
      const start = Math.max(0, s.size - SEED_TAIL_BYTES)
      const len = s.size - start
      const fh = await open(file, 'r')
      try {
        const buf = Buffer.alloc(len)
        if (len > 0) await fh.read(buf, 0, len, start)
        let text = buf.toString('utf8')
        if (start > 0) {
          const nl = text.indexOf('\n')
          text = nl >= 0 ? text.slice(nl + 1) : ''
        }
        t.offset = s.size
        this.ingest(key, t, text, false)
      } finally {
        await fh.close()
      }
    } catch {
      t.offset = 0
    }
  }

  private async poll(key: string, t: Tailer): Promise<void> {
    if (t.reading) return
    t.reading = true
    try {
      const file = this.filePath(key)
      let size: number
      try {
        size = (await stat(file)).size
      } catch {
        return
      }
      if (size < t.offset) {
        t.offset = 0
        t.pending = ''
        t.current = null
        t.ring = []
        this.emit(key, [
          {
            seq: this.nextSeq(),
            severity: 'log',
            kind: 'restart',
            frame: -1,
            time: 0,
            message: ''
          }
        ])
      }
      if (size === t.offset) return
      const remaining = size - t.offset
      const want = Math.min(remaining, READ_CAP)
      let fh: Awaited<ReturnType<typeof open>>
      try {
        fh = await open(file, 'r')
      } catch {
        return
      }
      try {
        const buf = Buffer.alloc(want)
        const { bytesRead } = await fh.read(buf, 0, want, t.offset)
        const capped = bytesRead < remaining
        let take = bytesRead
        if (capped) {
          const nl = buf.lastIndexOf(0x0a, bytesRead - 1)
          if (nl >= 0) take = nl + 1
          else while (take > 0 && (buf[take] & 0xc0) === 0x80) take--
        }
        t.offset += take
        const batch: UnityLogLine[] = []
        this.ingest(key, t, buf.toString('utf8', 0, take), true, batch, !capped)
        if (batch.length > 0) {
          this.emit(key, batch.length > EMIT_CAP ? batch.slice(-EMIT_CAP) : batch)
        }
      } catch {
        return
      } finally {
        await fh.close().catch(() => {})
      }
    } finally {
      t.reading = false
    }
  }

  private ingest(
    key: string,
    t: Tailer,
    text: string,
    emit: boolean,
    batch?: UnityLogLine[],
    flushAtEnd = true
  ): void {
    const lines = (t.pending + text).split('\n')
    t.pending = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      const header = parseHeader(line)
      if (header) {
        this.flushCurrent(t, emit, batch)
        this.startEntry(t, header)
        continue
      }
      if (line.trim() === '') continue
      if (t.current) this.appendStack(t.current, line.replace(/^ {4}/, ''))
    }
    if (t.pending === '' && flushAtEnd) this.flushCurrent(t, emit, batch)
  }

  private startEntry(t: Tailer, h: Header): void {
    t.current = {
      seq: this.nextSeq(),
      severity: severityFor(h.sev),
      ...(h.sev === 'P' ? { kind: 'play' as const } : {}),
      frame: h.frame,
      time: h.time,
      message: h.message
    }
  }

  private appendStack(entry: UnityLogLine, line: string): void {
    const next = (entry.stack ? entry.stack + '\n' : '') + line
    entry.stack = next.length > MAX_STACK_CHARS ? next.slice(0, MAX_STACK_CHARS) : next
  }

  private flushCurrent(t: Tailer, emit: boolean, batch?: UnityLogLine[]): void {
    if (!t.current) return
    const line = t.current
    t.current = null
    t.ring.push(line)
    if (t.ring.length > RING_CAP + RING_SLACK) t.ring.splice(0, t.ring.length - RING_CAP)
    if (emit && batch) batch.push(line)
  }
}

if (parentPort) {
  const port = parentPort
  const seqBase = typeof workerData?.seqBase === 'number' ? workerData.seqBase : 0
  const core = new LogTailerCore(
    (projectKey, lines) => port.postMessage({ t: 'lines', projectPath: projectKey, lines }),
    seqBase
  )
  port.on('message', async (m: { t: string; projectPath: string; reqId?: number }) => {
    if (m.t === 'sub') {
      const lines = await core.subscribe(m.projectPath)
      port.postMessage({ t: 'res', reqId: m.reqId, lines })
    } else if (m.t === 'unsub') {
      core.unsubscribe(m.projectPath)
    } else if (m.t === 'reset') {
      core.reset(m.projectPath)
    } else if (m.t === 'snap') {
      port.postMessage({ t: 'res', reqId: m.reqId, lines: core.snapshot(m.projectPath) })
    }
  })
}
