import type { Quat, TunerBounds, Vec3 } from '@shared/tuner'
import type { HandlePivot, HandleSpace } from './handles'
import { pointBounds, qarr, quat, rotate, unionBounds } from './space'

export interface PoseStart {
  id: string
  position: Vec3
  rotation: Quat
}

export interface PoseItem {
  id: string
  pose: { position?: Vec3; rotation?: Quat }
}

export function selectionCenter(objects: { position: Vec3; bounds: TunerBounds | null }[]): Vec3 | null {
  const b = unionBounds(objects.map((o) => o.bounds ?? pointBounds([o.position], 0)))
  return b ? b.center : null
}

export function multiMove(starts: PoseStart[], origin: Vec3, next: Vec3): PoseItem[] {
  const d: Vec3 = [next[0] - origin[0], next[1] - origin[1], next[2] - origin[2]]
  return starts.map((s) => ({ id: s.id, pose: { position: [s.position[0] + d[0], s.position[1] + d[1], s.position[2] + d[2]] } }))
}

export function multiRotate(
  starts: PoseStart[],
  pivot: HandlePivot,
  space: HandleSpace,
  center: Vec3,
  rot0: Quat,
  next: Quat
): PoseItem[] {
  const q0 = quat(rot0)
  const r = quat(next).multiply(q0.clone().invert())
  const rq = qarr(r)
  const local = q0.clone().invert().multiply(r).multiply(q0)
  return starts.map((s) => {
    if (pivot === 'center') {
      const off = rotate(rq, [s.position[0] - center[0], s.position[1] - center[1], s.position[2] - center[2]])
      return {
        id: s.id,
        pose: { position: [center[0] + off[0], center[1] + off[1], center[2] + off[2]], rotation: qarr(r.clone().multiply(quat(s.rotation))) }
      }
    }
    if (space === 'local') return { id: s.id, pose: { rotation: qarr(quat(s.rotation).multiply(local)) } }
    return { id: s.id, pose: { rotation: qarr(r.clone().multiply(quat(s.rotation))) } }
  })
}
