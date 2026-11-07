import type { TunerBounds } from '@shared/tuner'
import type { Orbit } from '@renderer/lib/tuner/orbit'
import { tunerShot } from '@renderer/lib/tuner/shot'
import { tunerMemory } from '@renderer/lib/tuner/session-memory'

export interface Shot {
  center: [number, number, number]
  size: [number, number, number]
  yaw: number
  pitch: number
  pad?: number
}

export const SHOTS = {
  monolith: { center: [0, 1.9, 1.2], size: [2.2, 4.2, 1.2], yaw: -28, pitch: 6, pad: 1.1 },
  slab: { center: [0, 2.1, 1.2], size: [1.9, 4, 0.6], yaw: 22, pitch: 4, pad: 1.1 },
  motes: { center: [0, 1.8, 0.2], size: [3, 3.6, 3], yaw: -22, pitch: 10, pad: 1.15 },
  nicheL: { center: [-2.7, 1.6, 4.4], size: [1.8, 3, 1.4], yaw: -18, pitch: 8, pad: 1.1 },
  lights: { center: [0, 1.6, 1.6], size: [7.4, 3.4, 6.4], yaw: 14, pitch: 14, pad: 0.92 },
  rise: { center: [0, 1.9, 1.2], size: [2.2, 4.2, 1.2], yaw: 30, pitch: 3, pad: 1 }
} satisfies Record<string, Shot>

export class Camera {
  private home: Orbit | null = null

  constructor(
    private readonly session: string,
    private readonly tab: string,
    private readonly root: string,
    private readonly view: () => string
  ) {}

  private orbit(): Orbit | null {
    return (tunerMemory(this.tab, this.view(), this.root).orbit as Orbit | null) ?? null
  }

  mark(): void {
    const o = this.orbit()
    this.home = o ? structuredClone(o) : null
  }

  shot(s: Shot, ms = 1600): number {
    if (!this.home) this.mark()
    const bounds: TunerBounds = { center: s.center, size: s.size }
    tunerShot({ session: this.session, bounds, yaw: s.yaw, pitch: s.pitch, pad: s.pad, ms })
    return ms
  }

  back(ms = 1500): number {
    if (!this.home) return 0
    tunerShot({ session: this.session, orbit: this.home, ms })
    this.home = null
    return ms
  }
}
