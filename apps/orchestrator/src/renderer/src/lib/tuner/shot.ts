import type { TunerBounds } from '@shared/tuner'
import type { Orbit } from './orbit'

export const TUNER_SHOT_EVENT = 'satura:tuner-shot'

export interface TunerShot {
  session: string
  bounds?: TunerBounds
  orbit?: Orbit
  yaw?: number
  pitch?: number
  pad?: number
  ms?: number
}

export function tunerShot(shot: TunerShot): void {
  window.dispatchEvent(new CustomEvent<TunerShot>(TUNER_SHOT_EVENT, { detail: shot }))
}
