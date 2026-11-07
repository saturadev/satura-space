import { useSyncExternalStore } from 'react'
import { useWorldStore } from '../unity/world-store'
import { TRANSITIONAL_LIFECYCLES, type InstanceDesired, type InstanceObserved } from '@shared/unity/world'

export type TunerShow = 'neutral' | 'loading' | 'scene'

export type UnityPresence = 'none' | 'busy' | 'ready'

interface ReloadEntry {
  pending: number
  gen: number
  saving: number
}

const reloads = new Map<string, ReloadEntry>()
const subs = new Set<() => void>()
const NONE: ReloadEntry = { pending: 0, gen: 0, saving: 0 }

function bump(projectPath: string, fn: (e: ReloadEntry) => ReloadEntry): void {
  reloads.set(projectPath, fn(reloads.get(projectPath) ?? NONE))
  for (const cb of subs) cb()
}

export function markTunerReload<T>(projectPath: string, work: Promise<T>): Promise<T> {
  bump(projectPath, (e) => ({ ...e, pending: e.pending + 1 }))
  return work.finally(() => bump(projectPath, (e) => ({ ...e, pending: Math.max(0, e.pending - 1), gen: e.gen + 1 })))
}

export function markTunerSaving<T>(projectPath: string, work: Promise<T>): Promise<T> {
  bump(projectPath, (e) => ({ ...e, saving: e.saving + 1 }))
  return work.finally(() => bump(projectPath, (e) => ({ ...e, saving: Math.max(0, e.saving - 1) })))
}

function subscribe(cb: () => void): () => void {
  subs.add(cb)
  return () => subs.delete(cb)
}

export function useTunerReload(projectPath: string): ReloadEntry {
  return useSyncExternalStore(subscribe, () => reloads.get(projectPath) ?? NONE)
}

export function unityPresence(inst: InstanceObserved | undefined, desired: InstanceDesired | undefined, stopped: boolean): UnityPresence {
  if (stopped || !inst) return 'none'
  const lc = inst.lifecycle
  if (lc === 'exited' || lc === 'error') return 'none'
  if (lc === 'init' || TRANSITIONAL_LIFECYCLES.has(lc) || inst.compile === 'compiling') return 'busy'
  if (desired && (desired.playGen > inst.playGen || desired.sceneGen > inst.sceneGen || desired.refreshGen > inst.refreshGen)) return 'busy'
  return 'ready'
}

export function useUnityPresence(projectPath: string): UnityPresence {
  return useWorldStore((s) => {
    const entry = s.worlds[projectPath]
    if (!entry || entry.observed.version === 0) return 'busy'
    const insts = Object.values(entry.observed.instances)
    const inst = insts.find((i) => i.role === 'primary') ?? insts[0]
    return unityPresence(inst, inst ? entry.desired.instances[inst.id] : undefined, entry.desired.stopped)
  })
}

export function unityBusyLabel(inst: InstanceObserved | undefined, desired: InstanceDesired | undefined): string {
  if (!inst || inst.lifecycle === 'init' || inst.lifecycle === 'launching') return 'Unity is starting…'
  if (inst.compile === 'compiling') return 'Unity is compiling…'
  if (inst.lifecycle === 'restarting') return 'Unity is restarting…'
  if (inst.lifecycle === 'entering-play') return 'Unity is entering Play Mode…'
  if (inst.lifecycle === 'exiting-play') return 'Unity is leaving Play Mode…'
  if (desired && desired.refreshGen > inst.refreshGen) return 'Unity is importing changes…'
  if (desired && desired.sceneGen > inst.sceneGen) return 'Unity is opening the scene…'
  if (desired && desired.playGen > inst.playGen) return 'Unity is switching Play Mode…'
  return 'Unity is busy…'
}

export function useUnityBusyLabel(projectPath: string): string {
  return useWorldStore((s) => {
    const entry = s.worlds[projectPath]
    if (!entry || entry.observed.version === 0) return 'Connecting to Unity…'
    const insts = Object.values(entry.observed.instances)
    const inst = insts.find((i) => i.role === 'primary') ?? insts[0]
    return unityBusyLabel(inst, inst ? entry.desired.instances[inst.id] : undefined)
  })
}

export function useUnitySaving(projectPath: string): boolean {
  return useWorldStore((s) => {
    const entry = s.worlds[projectPath]
    if (!entry) return false
    return Object.values(entry.observed.instances).some((i) => i.role === 'primary' && i.saving === true)
  })
}
