import type { TunerObject, TunerPose, TunerShadow } from '@shared/tuner'

export interface LiveStore {
  poses: Map<string, TunerPose>
  shadow: TunerShadow | null
  version: number
  subscribe: (fn: () => void) => () => void
  setPoses: (poses: TunerPose[]) => void
  setShadow: (shadow: TunerShadow | null) => void
  clear: () => void
}

export function createLiveStore(): LiveStore {
  const listeners = new Set<() => void>()
  const notify = (): void => {
    store.version++
    for (const fn of listeners) fn()
  }
  const store: LiveStore = {
    poses: new Map(),
    shadow: null,
    version: 0,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    setPoses(poses) {
      for (const p of poses) store.poses.set(p.id, p)
      notify()
    },
    setShadow(shadow) {
      store.shadow = shadow
      notify()
    },
    clear() {
      if (store.poses.size === 0 && !store.shadow) return
      store.poses.clear()
      store.shadow = null
      notify()
    }
  }
  return store
}

export function applyPoses(
  objects: TunerObject[],
  poses: ReadonlyMap<string, TunerPose>,
  pinned: ReadonlySet<string>
): TunerObject[] {
  if (poses.size === 0) return objects
  let changed = false
  const out = objects.map((o) => {
    const p = poses.get(o.id)
    if (!p || o.error || pinned.has(o.id)) return o
    changed = true
    return {
      ...o,
      active: p.active,
      position: p.position,
      rotation: p.rotation,
      localPosition: p.localPosition,
      localRotation: p.localRotation,
      localScale: p.localScale,
      bounds: p.bounds
    }
  })
  return changed ? out : objects
}

export function posesChangeStructure(objects: TunerObject[], poses: TunerPose[]): boolean {
  const byId = new Map(objects.map((o) => [o.id, o]))
  for (const p of poses) {
    const o = byId.get(p.id)
    if (!o || o.error) continue
    if (o.active !== p.active || !o.bounds !== !p.bounds) return true
  }
  return false
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  return true
}

function shareList<T>(prev: T[] | undefined, next: T[], match: (a: T, b: T) => boolean, share: (a: T, b: T) => T): T[] {
  if (!prev) return next
  let changed = prev.length !== next.length
  const out = next.map((n, i) => {
    const p = prev[i]
    if (p === undefined || !match(p, n)) {
      changed = true
      return n
    }
    const s = share(p, n)
    if (s !== p) changed = true
    return s
  })
  return changed ? out : prev
}

export function shareObject(prev: TunerObject | undefined, next: TunerObject): TunerObject {
  if (!prev || prev.id !== next.id) return next
  if (same(prev, next)) return prev
  const components = shareList(
    prev.components,
    next.components,
    (a, b) => a.key === b.key,
    (a, b) => (same(a, b) ? a : b)
  )
  return components === next.components ? next : { ...next, components }
}

export function mergeLiveObject(objects: TunerObject[], object: TunerObject): TunerObject[] {
  let hit = false
  let changed = false
  const out = objects.map((o) => {
    if (o.id !== object.id) return o
    hit = true
    const shared = shareObject(o, object)
    if (shared !== o) changed = true
    return shared
  })
  return hit && changed ? out : objects
}
