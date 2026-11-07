import type { TunerPickBase, TunerPickHit, TunerPiercePick } from '@shared/tuner-sceneview'

export interface PickCycle {
  topmost: string | null
  prefix: string | null
}

export const CLICK_SLOP_PX = 4

export function newPickCycle(): PickCycle {
  return { topmost: null, prefix: null }
}

function extend(prefix: string, path: string): string {
  return `${prefix}\n${path}`
}

export function cyclePick(hits: TunerPickHit[], active: string | null, st: PickCycle): TunerPickBase | null {
  if (hits.length === 0) return null
  const topmost = hits[0]
  const baseHit = topmost.base && topmost.base.path !== topmost.path ? topmost.base : null
  const base = baseHit ? baseHit.path : null
  const first: TunerPickBase = baseHit ?? topmost
  const topHash = topmost.path
  let prefix = topHash
  if (!active) {
    st.topmost = topHash
    st.prefix = prefix
    return first
  }
  if (topHash !== st.topmost) {
    st.topmost = topHash
    st.prefix = prefix
    return active === base ? topmost : first
  }
  st.topmost = topHash
  if (base && active === base) {
    if (prefix === st.prefix) return topmost
    st.prefix = prefix
    return baseHit
  }
  let i = 0
  const at = hits.findIndex((h) => h.path === active)
  if (at > 0) {
    while (i < at) {
      i++
      prefix = extend(prefix, hits[i].path)
    }
  }
  if (prefix !== st.prefix) {
    st.prefix = topHash
    return first
  }
  i++
  if (i >= hits.length) {
    st.prefix = topHash
    return first
  }
  prefix = extend(prefix, hits[i].path)
  if (hits[i].path === base) {
    i++
    if (i >= hits.length) {
      st.prefix = topHash
      return first
    }
    prefix = extend(prefix, hits[i].path)
  }
  st.prefix = prefix
  return hits[i]
}

export function toPiercePick(hit: TunerPickBase): TunerPiercePick {
  return { path: hit.path, scene: hit.scene, targetId: hit.target, ownerId: hit.owner }
}

export function pathHint(hit: TunerPickHit): string {
  const cut = hit.path.lastIndexOf('/')
  const parent = cut > 0 ? hit.path.slice(0, cut) : ''
  if (parent) return parent
  return hit.scene
}

export function isClick(x0: number, y0: number, x1: number, y1: number): boolean {
  return Math.hypot(x1 - x0, y1 - y0) < CLICK_SLOP_PX
}
