import type { TunerMode, TunerRestore } from '@shared/tuner'
import type { Orbit } from './orbit'
import type { HandleMode, HandlePivot, HandleSpace } from './handles'
import { censusTrack } from '@shared/census'

export interface TunerMemory {
  view: string
  project: string
  restore: TunerRestore | null
  orbit: Orbit | null
  selected: string | null
  selection: string[]
  selectedPath?: TunerObjectPath | null
  specShown?: boolean
  collapsed: Set<string>
  mode: TunerMode | null
  animOpen?: boolean
  stagingOpen?: boolean
}

export interface TunerObjectPath {
  scene: string
  path: string
}

const byTab = new Map<string, TunerMemory>()
censusTrack('session-memory.byTab', byTab)

export const handlePrefs: { mode: HandleMode; space: HandleSpace; pivot: HandlePivot } = { mode: 'move', space: 'global', pivot: 'pivot' }

export function tunerMemory(tabId: string, view: string, project: string, carry = false): TunerMemory {
  const cur = byTab.get(tabId)
  if (cur && cur.view === view && cur.project === project) return cur
  const same = cur && cur.project === project ? cur : null
  const keep = carry ? same : null
  const next: TunerMemory = { view, project, restore: null, orbit: keep?.orbit ?? null, selected: same?.selected ?? null, selection: same ? [...same.selection] : [], selectedPath: same?.selectedPath ?? null, collapsed: new Set(), mode: null }
  byTab.set(tabId, next)
  return next
}

export function forgetTuner(tabId: string): void {
  byTab.delete(tabId)
}

export function createThrottle<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: A | null = null
  const fire = (): void => {
    timer = null
    if (!pending) return
    const args = pending
    pending = null
    last = Date.now()
    fn(...args)
  }
  return {
    call(...args: A): void {
      pending = args
      if (timer) return
      const wait = ms - (Date.now() - last)
      if (wait <= 0) fire()
      else timer = setTimeout(fire, wait)
    },
    flush(...args: A): void {
      if (timer) clearTimeout(timer)
      timer = null
      pending = args
      fire()
    },
    cancel(): void {
      if (timer) clearTimeout(timer)
      timer = null
      pending = null
    }
  }
}
