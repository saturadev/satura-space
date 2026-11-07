import { wallClock } from '@shared/wall-clock'

const MAX = 4096

export interface LoopRecord {
  kind?: 'x'
  cseq: number
  input: number
  send: number
  lt: number[]
  frame: number
  sid: number
  paint: number
}

interface LoopTrace {
  on: boolean
  records: LoopRecord[]
  raf: number[]
  frames: number[]
}

const trace: LoopTrace = { on: false, records: [], raf: [], frames: [] }
const sent = new Map<number, { input: number; send: number }>()
const sentX = new Map<number, { input: number; send: number }>()
let lastAck = 0
const bySid = new Map<number, LoopRecord[]>()
const paints = new Map<number, number>()
let seq = 0
let lastInput = 0
let rafId = 0
let rafLast = 0

const epoch = (t = performance.now()): number => wallClock(t)

function rafTick(ts: number): void {
  if (rafLast) trace.raf.push(ts - rafLast)
  rafLast = ts
  if (trace.raf.length > MAX) trace.raf.splice(0, trace.raf.length - MAX)
  rafId = trace.on ? requestAnimationFrame(rafTick) : 0
}

export function loopInput(timeStamp: number): void {
  if (trace.on) lastInput = epoch(timeStamp)
}

export function loopCameraSeq(): number {
  seq++
  if (trace.on) {
    sent.set(seq, { input: lastInput || epoch(), send: epoch() })
    if (sent.size > MAX) sent.delete(sent.keys().next().value as number)
  }
  return seq
}

export function loopTransformSeq(seq: number): void {
  if (!trace.on) return
  sentX.set(seq, { input: lastInput || epoch(), send: epoch() })
  if (sentX.size > MAX) sentX.delete(sentX.keys().next().value as number)
}

function loopRecords(rs: LoopRecord[], now: number, sid: number): void {
  if (rs.length === 0) return
  trace.records.push(...rs)
  if (trace.records.length > MAX) trace.records.splice(0, trace.records.length - MAX)
  const p = paints.get(sid)
  paints.delete(sid)
  if (p != null && now - p < 40) for (const r of rs) r.paint = p
  else bySid.set(sid, rs)
}

export function loopFrame(lt: number[] | undefined, sid: number, ack?: number, xr?: number): void {
  if (!trace.on) return
  const now = epoch()
  trace.frames.push(now)
  if (trace.frames.length > MAX) trace.frames.splice(0, trace.frames.length - MAX)
  if (!lt || lt.length < 8) return
  const rs: LoopRecord[] = []
  if (ack && xr && ack > lastAck) {
    lastAck = ack
    const x = sentX.get(ack)
    if (x) {
      sentX.delete(ack)
      const rest = lt.slice(1)
      rest[0] = xr
      rs.push({ kind: 'x', cseq: ack, input: x.input, send: x.send, lt: rest, frame: now, sid, paint: 0 })
    }
  }
  const s = sent.get(lt[0])
  if (s) {
    sent.delete(lt[0])
    rs.push({ cseq: lt[0], input: s.input, send: s.send, lt: lt.slice(1), frame: now, sid, paint: 0 })
  }
  loopRecords(rs, now, sid)
}

export function loopPaint(sid: number, at: number): void {
  if (!trace.on) return
  const rs = bySid.get(sid)
  bySid.delete(sid)
  const wall = epoch(at)
  if (rs && wall >= rs[0].frame) for (const r of rs) r.paint = wall
  else paints.set(sid, wall)
}

const api = {
  start(): void {
    trace.on = true
    trace.records = []
    trace.raf = []
    trace.frames = []
    sent.clear()
    sentX.clear()
    lastAck = 0
    bySid.clear()
    paints.clear()
    rafLast = 0
    if (!rafId) rafId = requestAnimationFrame(rafTick)
  },
  stop(): LoopTrace {
    trace.on = false
    return { ...trace }
  }
}

;(window as unknown as { __tunerLoop?: typeof api }).__tunerLoop = api
