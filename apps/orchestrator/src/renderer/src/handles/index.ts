import { censusSizes } from '@shared/census'
import { tunerPerfSnapshot } from '../lib/tuner/perf'
import './layout'
import './workspace'
import './git'
import './tuner'
import './staging'
import './capture'
import './terminal'
import './editor'
import './file-versions'
import './scratchpad'
import './actions'
import './usage'
import './unity'
import './report'
import './ui'
import './claude'
import './fn'

export { rendererHandleList, runRendererHandle } from './registry'

let lag: { max: number; sum: number; n: number; timer: ReturnType<typeof setInterval> } | null = null

function loopLag(): { avg: number; max: number } | null {
  if (!lag) {
    let last = performance.now()
    const state = { max: 0, sum: 0, n: 0, timer: setInterval(() => {
      const now = performance.now()
      const late = Math.max(0, now - last - 100)
      last = now
      state.max = Math.max(state.max, late)
      state.sum += late
      state.n++
    }, 100) }
    lag = state
    return null
  }
  const out = { avg: Math.round((lag.sum / Math.max(1, lag.n)) * 10) / 10, max: Math.round(lag.max) }
  lag.max = 0
  lag.sum = 0
  lag.n = 0
  return out
}

export function windowCensus(reset: boolean): Record<string, unknown> {
  const lagMs = loopLag()
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  return {
    maps: censusSizes(),
    heapMB: memory ? Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10 : null,
    domNodes: document.getElementsByTagName('*').length,
    tuner: tunerPerfSnapshot(reset),
    lagMs
  }
}
