import type { TunerBounds, TunerCamera, TunerFrameMeta, TunerPose, TunerSceneIcon } from './tuner'

export interface TunerSurfaceRef {
  id: number
  handleHigh: number
  format: number
  generation: number
  flipY: boolean
}

export interface ParsedTunerFrame {
  meta: TunerFrameMeta
  surface: TunerSurfaceRef
}

const SURFACE_RESYNC_MS = 400
const SURFACE_GIVE_UP_MS = 4000

export function tunerSurfaceKey(projectPath: string, session: string): string {
  return `tuner|${projectPath}|${session}`
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function u32(v: unknown): number | null {
  const n = num(v)
  return n != null && Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : null
}

function tuple(v: unknown, n: number): number[] | null {
  return Array.isArray(v) && v.length === n && v.every((x) => num(x) != null) ? [...(v as number[])] : null
}

function camera(v: unknown, width: number, height: number): TunerCamera | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  const position = tuple(c.position, 3)
  const rotation = tuple(c.rotation, 4)
  const fov = num(c.fov)
  if (!position || !rotation || fov == null) return null
  const ortho = num(c.ortho)
  return {
    position: position as TunerCamera['position'],
    rotation: rotation as TunerCamera['rotation'],
    fov,
    ...(ortho != null && ortho > 0 ? { ortho } : {}),
    width: num(c.width) ?? width,
    height: num(c.height) ?? height
  }
}

function bounds(v: unknown): TunerBounds | null {
  if (!v || typeof v !== 'object') return null
  const b = v as Record<string, unknown>
  const center = tuple(b.center, 3)
  const size = tuple(b.size, 3)
  return center && size ? { center: center as TunerBounds['center'], size: size as TunerBounds['size'] } : null
}

function icons(v: unknown): TunerSceneIcon[] | null {
  if (!Array.isArray(v)) return null
  const out: TunerSceneIcon[] = []
  for (const x of v) {
    if (!Array.isArray(x) || x.length !== 5) continue
    const [id, kind, px, py, pz] = x
    if (typeof id !== 'string' || typeof kind !== 'string' || id.length > 64 || kind.length > 32) continue
    if (![px, py, pz].every((n) => typeof n === 'number' && Number.isFinite(n))) continue
    out.push({ id, kind, position: [px, py, pz] })
    if (out.length >= 1024) break
  }
  return out
}

function poses(v: unknown): TunerPose[] | null {
  if (!Array.isArray(v)) return null
  const out: TunerPose[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object') continue
    const p = x as Record<string, unknown>
    const position = tuple(p.position, 3)
    const rotation = tuple(p.rotation, 4)
    const localPosition = tuple(p.localPosition, 3)
    const localRotation = tuple(p.localRotation, 4)
    const localScale = tuple(p.localScale, 3)
    if (typeof p.id !== 'string' || !position || !rotation || !localPosition || !localRotation || !localScale) continue
    out.push({
      id: p.id,
      active: p.active !== false,
      position: position as TunerPose['position'],
      rotation: rotation as TunerPose['rotation'],
      localPosition: localPosition as TunerPose['localPosition'],
      localRotation: localRotation as TunerPose['localRotation'],
      localScale: localScale as TunerPose['localScale'],
      bounds: bounds(p.bounds)
    })
  }
  return out.length ? out : null
}

function surfaceRef(v: unknown): TunerSurfaceRef | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  const id = u32(s.id)
  const generation = u32(s.generation)
  if (!id || generation == null) return null
  return {
    id,
    handleHigh: u32(s.handleHigh) ?? 0,
    format: u32(s.format) ?? 1,
    generation,
    flipY: s.flipY === true
  }
}

export function parseTunerFrame(e: Record<string, unknown>): ParsedTunerFrame | null {
  if (typeof e.session !== 'string') return null
  const width = u32(e.width) ?? 0
  const height = u32(e.height) ?? 0
  if (width < 1 || height < 1 || width > 0xffff || height > 0xffff) return null
  const cam = camera(e.camera, width, height)
  if (!cam) return null
  const surface = surfaceRef(e.surface)
  if (!surface) return null
  const ack = u32(e.ack)
  const xr = typeof e.xr === 'number' && Number.isFinite(e.xr) ? e.xr : 0
  const ps = poses(e.poses)
  const ic = icons(e.icons)
  const lt = Array.isArray(e.lt) && e.lt.length <= 16 && e.lt.every((x) => num(x) != null) ? (e.lt as number[]) : null
  return {
    meta: { session: e.session, seq: u32(e.seq) ?? 0, ...(ack ? { ack } : {}), ...(xr ? { xr } : {}), width, height, camera: cam, ...(ps ? { poses: ps } : {}), ...(ic ? { icons: ic } : {}), ...(lt ? { lt } : {}) },
    surface
  }
}

export function surfaceWaitAction(waitedMs: number, resynced: boolean): 'resync' | 'give-up' | null {
  if (waitedMs >= SURFACE_GIVE_UP_MS) return 'give-up'
  if (waitedMs >= SURFACE_RESYNC_MS && !resynced) return 'resync'
  return null
}
