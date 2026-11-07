import type { Terminal } from '@xterm/xterm'
import { dumpCells, type CellDump } from '@shared/remote-term'

const MARK = /⏱(\d{13})/g
const REPORT_MS = 2000
const LONG_FRAME_MS = 20

let scrollingNow = false

export function setTermScrolling(on: boolean): void {
  scrollingNow = on
}

export interface TermPerf {
  bytes: (n: number) => void
  scrolling: (on: boolean) => void
  dispose: () => void
}

function enabled(): boolean {
  try {
    return localStorage.getItem('satura-term-perf') === '1' || new URLSearchParams(location.search).has('termperf')
  } catch {
    return false
  }
}

function pct(list: number[], p: number): number {
  if (!list.length) return 0
  const s = [...list].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10
}

export function attachTermPerf(term: Terminal, label: string): TermPerf {
  if (!enabled()) return { bytes: () => {}, scrolling: () => {}, dispose: () => {} }
  const w = window as unknown as { __saturaTerms?: Record<string, Terminal>; __saturaTermCells?: (label: string, from?: number, count?: number) => CellDump | null }
  w.__saturaTerms = { ...w.__saturaTerms, [label]: term }
  w.__saturaTermCells = (id, from, count) => (w.__saturaTerms?.[id] ? dumpCells(w.__saturaTerms[id] as never, from, count) : null)
  const seen = new Set<string>()
  let lat: number[] = []
  let frames: number[] = []
  let scrollFrames: number[] = []
  let msgs = 0
  let bytes = 0
  let scrolling = false
  let last = performance.now()
  let raf = 0
  let at = performance.now()
  const tick = (t: number): void => {
    const d = t - last
    last = t
    frames.push(d)
    if (scrolling || scrollingNow) scrollFrames.push(d)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  const sub = term.onRender(({ start, end }) => {
    const buf = term.buffer.active
    const now = Date.now()
    for (let y = start; y <= end; y++) {
      const text = buf.getLine(buf.viewportY + y)?.translateToString(true)
      if (!text || !text.includes('⏱')) continue
      for (const m of text.matchAll(MARK)) {
        if (seen.has(m[1])) continue
        seen.add(m[1])
        lat.push(now - Number(m[1]))
      }
    }
    if (seen.size > 5000) seen.clear()
  })
  const timer = setInterval(() => {
    const secs = (performance.now() - at) / 1000
    at = performance.now()
    const long = frames.filter((f) => f > LONG_FRAME_MS).length
    console.info(
      `[term-perf] ${label} ${Math.round(msgs / secs)} msg/s ${Math.round(bytes / 1024 / secs)} KB/s` +
        (lat.length ? ` latency p50 ${pct(lat, 0.5)} p95 ${pct(lat, 0.95)} ms (n=${lat.length})` : '') +
        ` frame p50 ${pct(frames, 0.5)} p95 ${pct(frames, 0.95)} max ${Math.round(Math.max(0, ...frames))} long ${long}/${frames.length}` +
        (scrollFrames.length ? ` scroll-frame p50 ${pct(scrollFrames, 0.5)} p95 ${pct(scrollFrames, 0.95)} max ${Math.round(Math.max(...scrollFrames))} (n=${scrollFrames.length})` : '')
    )
    lat = []
    frames = []
    scrollFrames = []
    msgs = 0
    bytes = 0
  }, REPORT_MS)
  return {
    bytes: (n) => {
      msgs++
      bytes += n
    },
    scrolling: (on) => {
      scrolling = on
    },
    dispose: () => {
      cancelAnimationFrame(raf)
      clearInterval(timer)
      sub.dispose()
    }
  }
}
