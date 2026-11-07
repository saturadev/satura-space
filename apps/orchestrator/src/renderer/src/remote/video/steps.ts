import { getMac, macLabel, pathHostId } from '../macs'

export type StreamStep = 'desktop' | 'route' | 'secure' | 'video' | 'frame' | 'live'
export type StreamPath = 'lan' | 'direct' | 'turn'

export const STEPS: StreamStep[] = ['desktop', 'route', 'secure', 'video', 'frame', 'live']

const PLAN: Record<Exclude<StreamStep, 'live'>, { weight: number; ms: number }> = {
  desktop: { weight: 0.15, ms: 400 },
  route: { weight: 0.25, ms: 900 },
  secure: { weight: 0.1, ms: 200 },
  video: { weight: 0.4, ms: 1500 },
  frame: { weight: 0.1, ms: 300 }
}

export const PATH_TEXT: Record<StreamPath, string> = {
  lan: 'Direct, same network',
  direct: 'Direct over the internet',
  turn: 'Through a relay server'
}

export function stepLabel(step: StreamStep, path: StreamPath | null): string {
  if (step === 'desktop') return `Connecting to ${macLabel(getMac(pathHostId()))}…`
  if (step === 'route') return 'Finding a direct route…'
  if (step === 'secure') return path === 'turn' ? 'Using the relay server…' : 'Securing the connection…'
  if (step === 'video') return 'Starting video…'
  if (step === 'frame') return 'Waiting for the first frame…'
  return 'Reconnecting…'
}

export function stepTrouble(step: StreamStep): string {
  if (step === 'desktop') return "your desktop didn't answer"
  if (step === 'route') return 'no route to your desktop was found'
  if (step === 'secure') return "the secure connection didn't finish"
  if (step === 'video') return "your desktop didn't start the video"
  return 'no picture came from your desktop'
}

export function stepProgress(step: StreamStep, elapsedMs: number): number {
  if (step === 'live') return 0.05
  let done = 0
  for (const s of STEPS) {
    if (s === step) break
    if (s !== 'live') done += PLAN[s].weight
  }
  const p = PLAN[step]
  return Math.min(0.95, done + p.weight * 0.9 * (1 - Math.exp(-elapsedMs / p.ms)))
}
