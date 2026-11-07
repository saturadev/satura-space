
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { DeepPartial, UnityWorldEvent } from '@shared/api'
import {
  MAX_PLAYERS,
  TRANSITIONAL_LIFECYCLES,
  emptyWorldDesired,
  emptyWorldObserved,
  type InstanceDesired,
  type InstanceObserved,
  type Lifecycle,
  type WorldDesired,
  type WorldObserved
} from '@shared/unity/world'
import { WORLD_EVENT } from '@shared/unity/protocol'
import { applyDesiredPatch, applyWorldPatch } from '@shared/unity/patch'
import { useAppQuitting } from '../app-quitting'
import { useUnityLifecycle } from './lifecycle-store'
import { stateTitle } from '@shared/unity/lifecycle'
import { primaryWorldId } from '@shared/unity/ids'

export interface WorldEntry {
  observed: WorldObserved
  desired: WorldDesired
}

export interface FramesLiveLoc {
  projectPath: string
  worldId: string
}

export type StatusTone = 'amber-pulse' | 'rose' | 'zinc' | 'emerald'

export interface StatusDot {
  tone: StatusTone
  label: string
}

export interface InstanceLocks {
  playStop: boolean
  scene: boolean
  relaunch: boolean
  hotReload: boolean
  addPlayer: boolean
  removePlayer: boolean
}

export interface WorldStoreState {
  worlds: Record<string, WorldEntry>
  framesLive: Record<string, FramesLiveLoc>

  ensureProject: (projectPath: string) => void
  reloadWorlds: () => Promise<void>

  setPlaying: (pp: string, iid: string, playing: boolean) => void
  setPaused: (pp: string, iid: string, paused: boolean) => void
  setScene: (pp: string, iid: string, scene: string) => void
  setHotReload: (pp: string, iid: string, enabled: boolean) => void
  bumpRefresh: (pp: string, primaryId: string) => void
  setPlayerCount: (pp: string, count: number) => void
  setStopped: (pp: string, stopped: boolean) => void
  removeInstance: (pp: string, iid: string) => void
  setStreamRes: (pp: string, iid: string, res: string) => void
  setFpsCap: (pp: string, iid: string, cap: number) => void
  setVolume: (pp: string, iid: string, volume: number) => void
  setMuted: (pp: string, iid: string, muted: boolean) => void

  markFramesLive: (sessionId: string, projectPath: string, worldId: string) => void
  clearFramesLive: (sessionId: string, projectPath: string, worldId: string) => void
  forgetProject: (projectPath: string) => void
}

const PENDING_PREFIX = '__pending__'

export function pendingId(index: number): string {
  return `${PENDING_PREFIX}${index}`
}

export function isPendingId(id: string): boolean {
  return id.startsWith(PENDING_PREFIX)
}

const FRAME_DEAD_LIFECYCLES: ReadonlySet<Lifecycle> = new Set<Lifecycle>([
  'init',
  'launching',
  'editmode',
  'exiting-play',
  'restarting',
  'error',
  'exited'
])

function isBusy(inst: InstanceObserved): boolean {
  return inst.compile === 'compiling' || TRANSITIONAL_LIFECYCLES.has(inst.lifecycle)
}

function groupWorkingOf(observed: WorldObserved): boolean {
  return Object.values(observed.instances).some(isBusy)
}

function groupArmableOf(observed: WorldObserved): boolean {
  const insts = Object.values(observed.instances)
  if (insts.length === 0) return false
  return insts.every((i) => i.lifecycle === 'playing' && i.compile === 'idle')
}

function groupTearingDownOf(entry: WorldEntry): boolean {
  return entry.desired.playerCount < Object.keys(entry.observed.instances).length
}

function groupPendingOf(entry: WorldEntry): boolean {
  return entry.desired.playerCount > Object.keys(entry.observed.instances).length
}

function optimisticLifecycle(inst: InstanceObserved, desired?: InstanceDesired): Lifecycle {
  const lc = inst.lifecycle
  if (inst.compile === 'compiling' || inst.compile === 'error') return lc
  if (!desired || desired.playGen <= inst.playGen) return lc
  if (desired.playing && lc === 'editmode') return 'entering-play'
  if (!desired.playing && lc === 'playing') return 'exiting-play'
  return lc
}

export function useEffectiveLifecycle(pp: string, iid: string): Lifecycle | undefined {
  return useWorldStore((s) => {
    const entry = s.worlds[pp]
    const inst = entry?.observed.instances[iid]
    if (!inst) return undefined
    return optimisticLifecycle(inst, entry.desired.instances[iid])
  })
}

function effectivePaused(inst: InstanceObserved, desired?: InstanceDesired): boolean {
  if (desired && desired.pauseGen > inst.pauseGen) return desired.paused
  return inst.paused
}

export function useEffectivePaused(pp: string, iid: string): boolean {
  return useWorldStore((s) => {
    const entry = s.worlds[pp]
    const inst = entry?.observed.instances[iid]
    if (!inst) return false
    return effectivePaused(inst, entry.desired.instances[iid])
  })
}

function reconcileFramesLive(
  framesLive: Record<string, FramesLiveLoc>,
  projectPath: string,
  observed: WorldObserved,
  desired: WorldDesired | undefined
): Record<string, FramesLiveLoc> {
  let mutated = false
  const next = { ...framesLive }
  for (const [sessionId, loc] of Object.entries(next)) {
    if (loc.projectPath !== projectPath) continue
    const inst = observed.instances[loc.worldId]
    if (!inst || FRAME_DEAD_LIFECYCLES.has(optimisticLifecycle(inst, desired?.instances[loc.worldId]))) {
      delete next[sessionId]
      mutated = true
    }
  }
  return mutated ? next : framesLive
}

export const useWorldStore = create<WorldStoreState>()((set, get) => {
  let subscribed = false

  function adoptSnapshot(projectPath: string, observed: WorldObserved, desired: WorldDesired): void {
    set((s) => {
      const entry = s.worlds[projectPath]
      if (!entry) return s
      const nextObserved = observed.version >= entry.observed.version ? observed : entry.observed
      const nextDesired = desired.version >= entry.desired.version ? desired : entry.desired
      if (nextObserved === entry.observed && nextDesired === entry.desired) return s
      return {
        worlds: { ...s.worlds, [projectPath]: { observed: nextObserved, desired: nextDesired } },
        framesLive: reconcileFramesLive(s.framesLive, projectPath, nextObserved, nextDesired)
      }
    })
  }

  function resync(projectPath: string): void {
    void window.api.unity.getWorld(projectPath).then(({ observed, desired }) => {
      adoptSnapshot(projectPath, observed, desired)
    })
  }

  function replaceWorld(projectPath: string, observed: WorldObserved, desired: WorldDesired): void {
    set((s) => {
      if (!s.worlds[projectPath]) return s
      return {
        worlds: { ...s.worlds, [projectPath]: { observed, desired } },
        framesLive: reconcileFramesLive(s.framesLive, projectPath, observed, desired)
      }
    })
  }

  function applyObserved(projectPath: string, observed: WorldObserved): void {
    set((s) => {
      const entry = s.worlds[projectPath]
      if (!entry) return s
      return {
        worlds: { ...s.worlds, [projectPath]: { ...entry, observed } },
        framesLive: reconcileFramesLive(s.framesLive, projectPath, observed, entry.desired)
      }
    })
  }

  function applyDesired(projectPath: string, desired: WorldDesired): void {
    set((s) => {
      const entry = s.worlds[projectPath]
      if (!entry) return s
      return { worlds: { ...s.worlds, [projectPath]: { ...entry, desired } } }
    })
  }

  function handleWorldEvent(ev: UnityWorldEvent): void {
    const pp = ev.projectPath
    const entry = get().worlds[pp]
    if (!entry) return

    if (ev.event === WORLD_EVENT.snapshot) {
      adoptSnapshot(pp, ev.world, ev.desired)
      return
    }
    if (ev.event === WORLD_EVENT.patch) {
      if (ev.baseVersion === entry.observed.version) {
        const next = applyWorldPatch(entry.observed, ev.patch)
        next.version = ev.version
        applyObserved(pp, next)
      } else {
        resync(pp)
      }
      return
    }
    if (ev.event === WORLD_EVENT.desired) {
      if (ev.baseVersion === entry.desired.version) {
        const next = applyDesiredPatch(entry.desired, ev.patch)
        next.version = ev.version
        applyDesired(pp, next)
      } else {
        resync(pp)
      }
      return
    }
  }

  function dispatchDesired(pp: string, patch: DeepPartial<WorldDesired>): void {
    window.api.unity.setDesired(pp, patch)
  }

  return {
    worlds: {},
    framesLive: {},

    ensureProject: (projectPath) => {
      if (!subscribed) {
        subscribed = true
        window.api.unity.onWorld(handleWorldEvent)
      }
      if (get().worlds[projectPath]) return
      set((s) =>
        s.worlds[projectPath]
          ? s
          : {
              worlds: {
                ...s.worlds,
                [projectPath]: {
                  observed: emptyWorldObserved(projectPath),
                  desired: emptyWorldDesired()
                }
              }
            }
      )
      void window.api.unity.getWorld(projectPath).then(({ observed, desired }) => {
        adoptSnapshot(projectPath, observed, desired)
      })
    },

    reloadWorlds: async () => {
      await Promise.all(
        Object.keys(get().worlds).map((pp) =>
          window.api.unity.getWorld(pp).then(({ observed, desired }) => replaceWorld(pp, observed, desired))
        )
      )
    },

    setPlaying: (pp, iid, playing) => dispatchDesired(pp, { instances: { [iid]: { playing } } }),
    setPaused: (pp, iid, paused) => dispatchDesired(pp, { instances: { [iid]: { paused } } }),
    setScene: (pp, iid, scene) => dispatchDesired(pp, { instances: { [iid]: { scene } } }),
    setHotReload: (pp, iid, enabled) => dispatchDesired(pp, { instances: { [iid]: { hotReload: enabled } } }),
    bumpRefresh: (pp, primaryId) => {
      const entry = get().worlds[pp]
      const cur = Math.max(
        entry?.desired.instances[primaryId]?.refreshGen ?? 0,
        entry?.observed.instances[primaryId]?.refreshGen ?? 0
      )
      dispatchDesired(pp, { instances: { [primaryId]: { refreshGen: cur + 1 } } })
    },
    setPlayerCount: (pp, count) => {
      const clamped = Math.max(1, Math.min(MAX_PLAYERS, Math.round(count)))
      dispatchDesired(pp, { playerCount: clamped })
    },
    setStopped: (pp, stopped) => dispatchDesired(pp, { stopped }),
    removeInstance: (pp, _iid) => {
      const entry = get().worlds[pp]
      const cur = entry?.desired.playerCount ?? 1
      dispatchDesired(pp, { playerCount: Math.max(1, cur - 1) })
    },
    setStreamRes: (pp, iid, res) => dispatchDesired(pp, { instances: { [iid]: { streamRes: res } } }),
    setFpsCap: (pp, iid, cap) => dispatchDesired(pp, { instances: { [iid]: { fpsCap: cap } } }),
    setVolume: (pp, iid, volume) => dispatchDesired(pp, { instances: { [iid]: { volume } } }),
    setMuted: (pp, iid, muted) => dispatchDesired(pp, { instances: { [iid]: { muted } } }),

    markFramesLive: (sessionId, pp, worldId) => {
      if (framesLiveAt(get().framesLive[sessionId], pp, worldId)) return
      const entry = get().worlds[pp]
      const inst = entry?.observed.instances[worldId]
      if (inst && FRAME_DEAD_LIFECYCLES.has(optimisticLifecycle(inst, entry.desired.instances[worldId]))) return
      set((s) => ({ framesLive: { ...s.framesLive, [sessionId]: { projectPath: pp, worldId } } }))
    },

    clearFramesLive: (sessionId, pp, worldId) => {
      if (!framesLiveAt(get().framesLive[sessionId], pp, worldId)) return
      set((s) => {
        const next = { ...s.framesLive }
        delete next[sessionId]
        return { framesLive: next }
      })
    },

    forgetProject: (pp) => {
      const s = get()
      const stale = Object.keys(s.framesLive).filter((id) => s.framesLive[id].projectPath === pp)
      if (!s.worlds[pp] && stale.length === 0) return
      const worlds = { ...s.worlds }
      delete worlds[pp]
      const framesLive = { ...s.framesLive }
      for (const id of stale) delete framesLive[id]
      set({ worlds, framesLive })
    }
  }
})

function framesLiveAt(loc: FramesLiveLoc | undefined, pp: string, worldId: string): boolean {
  return !!loc && loc.projectPath === pp && loc.worldId === worldId
}

export function ensureProject(projectPath: string): void {
  useWorldStore.getState().ensureProject(projectPath)
}

export function reloadWorlds(): Promise<void> {
  return useWorldStore.getState().reloadWorlds()
}

export function markFramesLive(sessionId: string, projectPath: string, worldId: string): void {
  useWorldStore.getState().markFramesLive(sessionId, projectPath, worldId)
}

export function clearFramesLive(sessionId: string, projectPath: string, worldId: string): void {
  useWorldStore.getState().clearFramesLive(sessionId, projectPath, worldId)
}

export function forgetWorld(projectPath: string): void {
  useWorldStore.getState().forgetProject(projectPath)
}

export function useInstanceIds(pp: string): string[] {
  return useWorldStore(
    useShallow((s) => {
      const entry = s.worlds[pp]
      if (!entry) return []
      const ids = Object.values(entry.observed.instances)
        .sort((a, b) => a.playerIndex - b.playerIndex)
        .map((i) => i.id)
      const target = Math.max(ids.length, entry.desired.playerCount)
      for (let i = ids.length; i < target; i++) ids.push(pendingId(i))
      return ids
    })
  )
}

export function useProjectStopped(pp: string): boolean {
  return useWorldStore((s) => s.worlds[pp]?.desired.stopped === true)
}

export function useEditorsRunning(pp: string): boolean {
  return useWorldStore((s) =>
    Object.values(s.worlds[pp]?.observed.instances ?? {}).some((i) => i.lifecycle !== 'exited')
  )
}

export function useInstance(pp: string, iid: string): InstanceObserved | undefined {
  return useWorldStore((s) => s.worlds[pp]?.observed.instances[iid])
}

export function useDesired(pp: string, iid: string): InstanceDesired | undefined {
  return useWorldStore((s) => s.worlds[pp]?.desired.instances[iid])
}

export function useScenes(pp: string): string[] {
  return useWorldStore(useShallow((s) => s.worlds[pp]?.observed.scenes ?? []))
}

export function useProjectHotReloadArmed(pp: string): boolean {
  return useWorldStore((s) => {
    const entry = s.worlds[pp]
    if (!entry) return false
    for (const inst of Object.values(entry.observed.instances)) {
      if (inst.hotReloadActive) return true
    }
    for (const des of Object.values(entry.desired.instances)) {
      if (des.hotReload) return true
    }
    return false
  })
}

export function useStreaming(pp: string, worldId: string, sessionId: string): boolean {
  return useWorldStore(
    (s) =>
      framesLiveAt(s.framesLive[sessionId], pp, worldId) ||
      s.worlds[pp]?.observed.instances[worldId]?.lifecycle === 'playing'
  )
}

export function useGroupWorking(pp: string): boolean {
  return useWorldStore((s) => {
    const entry = s.worlds[pp]
    return entry ? groupWorkingOf(entry.observed) : false
  })
}

export function useGroupArmable(pp: string): boolean {
  return useWorldStore((s) => {
    const entry = s.worlds[pp]
    return entry ? groupArmableOf(entry.observed) : false
  })
}

export function useGroupTearingDown(pp: string): boolean {
  return useWorldStore((s) => {
    const entry = s.worlds[pp]
    return entry ? groupTearingDownOf(entry) : false
  })
}

export function useGroupPending(pp: string): boolean {
  return useWorldStore((s) => {
    const entry = s.worlds[pp]
    return entry ? groupPendingOf(entry) : false
  })
}

export function useLocks(pp: string, iid: string): InstanceLocks {
  return useWorldStore(
    useShallow((s): InstanceLocks => {
      const entry = s.worlds[pp]
      const inst = entry?.observed.instances[iid]
      if (!entry || !inst) {
        return {
          playStop: true,
          scene: true,
          relaunch: true,
          hotReload: true,
          addPlayer: true,
          removePlayer: true
        }
      }
      const lifecycle = optimisticLifecycle(inst, entry.desired.instances[iid])
      const busy = inst.compile === 'compiling' || TRANSITIONAL_LIFECYCLES.has(lifecycle)
      const compileError = inst.compile === 'error'
      const errored = inst.lifecycle === 'error'
      const inEdit = lifecycle === 'editmode'
      const stoppable = lifecycle === 'playing'
      const working = groupWorkingOf(entry.observed)
      const tearingDown = groupTearingDownOf(entry)
      const pending = groupPendingOf(entry)
      const armable = groupArmableOf(entry.observed)
      const count = Object.keys(entry.observed.instances).length
      const scenesEmpty = entry.observed.scenes.length === 0
      const sceneLocked =
        busy || !inEdit || scenesEmpty || compileError || errored || working || tearingDown || pending
      return {
        playStop: errored || compileError || working || pending || (stoppable ? false : busy || (inEdit && (working || pending))),
        scene: sceneLocked,
        relaunch: inst.lifecycle === 'restarting',
        hotReload: !inst.hotReloadActive && !armable,
        addPlayer: !inEdit || tearingDown || count >= MAX_PLAYERS,
        removePlayer: count <= 1 || working
      }
    })
  )
}

export function useStatusDot(pp: string, worldId: string, sessionId: string): StatusDot {
  const quitting = useAppQuitting()
  const life = useUnityLifecycle(pp || null)
  const noInstance = useWorldStore((s) => !s.worlds[pp]?.observed.instances[worldId] && !s.worlds[pp]?.desired.stopped)
  const dot = useWorldStore(
    useShallow((s): StatusDot => {
      const entry = s.worlds[pp]
      const inst = entry?.observed.instances[worldId]
      if (entry?.desired.stopped)
        return Object.keys(entry.observed.instances).length > 0
          ? { tone: 'amber-pulse', label: 'Closing Unity…' }
          : { tone: 'zinc', label: 'Unity stopped' }
      if (!inst) return { tone: 'amber-pulse', label: 'Starting…' }
      if (inst.reachable === false) return { tone: 'rose', label: 'Unreachable' }
      if (inst.compile === 'error' || inst.lifecycle === 'error') {
        return { tone: 'rose', label: inst.compile === 'error' ? 'Compile error' : 'Error' }
      }
      const lifecycle = optimisticLifecycle(inst, entry?.desired.instances[worldId])
      if (lifecycle === 'exiting-play') return { tone: 'amber-pulse', label: 'Stopping…' }
      if (lifecycle === 'playing' && effectivePaused(inst, entry?.desired.instances[worldId])) {
        return { tone: 'zinc', label: 'Paused' }
      }
      if (lifecycle === 'playing' || framesLiveAt(s.framesLive[sessionId], pp, worldId)) {
        return { tone: 'emerald', label: `${inst.fps} fps · ${inst.ping} ms` }
      }
      if (lifecycle === 'editmode') {
        return { tone: 'zinc', label: 'Edit Mode' }
      }
      if (inst.compile === 'compiling') return { tone: 'amber-pulse', label: 'Compiling…' }
      if (lifecycle === 'entering-play') return { tone: 'amber-pulse', label: 'Entering Play Mode…' }
      if (lifecycle === 'restarting') return { tone: 'amber-pulse', label: 'Restarting…' }
      if (lifecycle === 'exited') return { tone: 'zinc', label: 'Unity stopped' }
      return { tone: 'amber-pulse', label: 'Starting Unity…' }
    })
  )
  if (quitting) return { tone: 'amber-pulse', label: 'Closing Unity…' }
  if (life && worldId === primaryWorldId(pp) && (noInstance || dot.label === 'Starting Unity…')) {
    if (life.state === 'failed') return { tone: 'rose', label: stateTitle(life) }
    if (life.state === 'exited') return { tone: 'zinc', label: 'Unity exited' }
    if (life.state === 'starting') return { tone: 'amber-pulse', label: stateTitle(life) }
    if (life.state === 'stopping') return { tone: 'amber-pulse', label: 'Closing Unity…' }
    if (life.state === 'stopped') return { tone: 'zinc', label: 'Unity stopped' }
    if (life.state === 'idle') return { tone: 'zinc', label: 'Unity not running' }
  }
  return dot
}

