import { toPosixPath } from '../path'
import { censusTrack } from '@shared/census'
import { BoundedMap } from '@shared/bounded-map'

const known = new BoundedMap<string, boolean>(64)
censusTrack('unity-project-cache.known', known)
const pending = new Map<string, Promise<boolean>>()
censusTrack('unity-project-cache.pending', pending)

export function knownUnityProject(path: string): boolean | undefined {
  return known.get(toPosixPath(path))
}

export function checkUnityProject(path: string): Promise<boolean> {
  const key = toPosixPath(path)
  const hit = known.get(key)
  if (hit !== undefined) return Promise.resolve(hit)
  const inflight = pending.get(key)
  if (inflight) return inflight
  const p = window.api.unity
    .isProject(path)
    .then((ok) => {
      known.set(key, ok === true)
      return ok === true
    })
    .catch(() => false)
    .finally(() => pending.delete(key))
  pending.set(key, p)
  return p
}
