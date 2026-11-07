import { useEffect, useState } from 'react'
import { PENDING_DELAY_MS } from '../../components/ui/PendingState'
import { ProgressBar } from '../motion'
import type { ReceiverStats } from './receiver'
import { stepLabel, stepProgress } from './steps'
import { useVideoStats } from './link'

const TICK_MS = 200

export function StreamProgress({ stats: given, tag, className = '' }: { stats?: ReceiverStats | null; tag: string; className?: string }): React.JSX.Element | null {
  const live = useVideoStats()
  const stats = given === undefined ? live : given
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), TICK_MS)
    return () => clearInterval(t)
  }, [])
  const step = stats?.step ?? 'desktop'
  const label = stepLabel(step, stats?.path ?? null)
  if (tick * TICK_MS < PENDING_DELAY_MS) return null
  return (
    <div data-pending={tag} data-rv-step={step} aria-label={label} className={`flex w-[220px] max-w-[80%] flex-col items-center gap-2 ${className}`}>
      <ProgressBar value={stepProgress(step, performance.now() - (stats?.stepAt ?? performance.now()))} className="h-[3px] w-full" />
      <span className="text-center text-[11.5px] leading-snug text-zinc-300">{label}</span>
    </div>
  )
}

export function StreamWait({ label, tag }: { label: string; tag: string }): React.JSX.Element {
  return (
    <div data-pending={tag} aria-label={label} className="flex w-[220px] max-w-[80%] flex-col items-center gap-2">
      <ProgressBar value={null} className="h-[3px] w-full" />
      <span className="text-center text-[11.5px] leading-snug text-zinc-300">{label}</span>
    </div>
  )
}
