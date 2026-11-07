import { noteLive } from './perf'
import { censusTrack } from '@shared/census'
import { loopTransformSeq } from './loop-trace'

const MAX = 512

interface SessionLatency {
  sent: { seq: number; at: number }[]
  ack: number
  samples: number[]
}

const bySession = new Map<string, SessionLatency>()
censusTrack('latency.bySession', bySession)
let counter = 0

function of(session: string): SessionLatency {
  let s = bySession.get(session)
  if (!s) {
    s = { sent: [], ack: 0, samples: [] }
    bySession.set(session, s)
    noteLive('latency', 1)
  }
  return s
}

export function nextTransformSeq(session: string, at: number): number {
  const seq = ++counter
  const s = of(session)
  s.sent.push({ seq, at })
  if (s.sent.length > MAX) s.sent.splice(0, s.sent.length - MAX)
  loopTransformSeq(seq)
  return seq
}

export function noteFrameAck(session: string, ack: number | undefined, at: number): void {
  if (!ack) return
  const s = bySession.get(session)
  if (!s || ack <= s.ack) return
  s.ack = ack
  const hit = s.sent.find((x) => x.seq === ack)
  if (!hit) return
  s.samples.push(at - hit.at)
  if (s.samples.length > MAX) s.samples.splice(0, s.samples.length - MAX)
}

export function transformsAcked(session: string): boolean {
  const s = bySession.get(session)
  if (!s || s.sent.length === 0) return true
  return s.ack >= s.sent[s.sent.length - 1].seq
}

export function forgetTransformLatency(session: string): void {
  if (bySession.delete(session)) noteLive('latency', -1)
}
