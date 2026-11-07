import { useEffect, useState } from 'react'
import type { InstanceObserved } from '@shared/unity/world'
import { stateLabel, stateTitle, type UnityLifecycle } from '@shared/unity/lifecycle'
import { Crossfade, ProgressBar, useStageProgress } from './motion'

export function isUnityLoading(life: UnityLifecycle | null | undefined): life is UnityLifecycle {
  return !!life && (life.state === 'starting' || life.state === 'stopping')
}

const SPANS: [RegExp, number, number][] = [
  [/resolv|package/i, 0.3, 0.4],
  [/compil/i, 0.4, 0.7],
  [/import|refresh|asset/i, 0.45, 0.85],
  [/scene|loading/i, 0.85, 0.95]
]

const STAGE_SPANS: Record<string, [number, number]> = {
  preparing: [0.02, 0.15],
  hub: [0.12, 0.2],
  installing: [0.1, 0.3],
  launching: [0.18, 0.3],
  restarting: [0.08, 0.3],
  compiling: [0.4, 0.7],
  importing: [0.45, 0.85]
}

function stepOf(life: UnityLifecycle, inst: InstanceObserved | undefined): { text: string; pct: number; from: number; to: number } {
  if (life.state === 'stopping') return { text: 'Closing Unity', pct: -1, from: 0.05, to: 0.95 }
  if (life.stage === 'installing' && life.install) return { text: `Unity Hub is installing Unity ${life.version}`, pct: life.install.pct, from: 0.1, to: 0.3 }
  const label = (inst?.progressLabel ?? '').replace(/[\s.…]+$/, '')
  const span = label ? SPANS.find(([re]) => re.test(label)) : undefined
  if (label && span) return { text: label.replace(/^Loading scene$/i, 'Loading the scene'), pct: inst?.progressPct ?? -1, from: span[1], to: span[2] }
  const [from, to] = STAGE_SPANS[life.stage || 'preparing'] ?? [0.02, 0.3]
  return { text: label || stateTitle(life).replace(/…$/, ''), pct: -1, from, to }
}

export function UnityIdleCard({ life, canStart }: { life: UnityLifecycle; canStart: boolean }) {
  const [busy, setBusy] = useState(false)
  useEffect(() => setBusy(false), [life.seq])
  const start = (): void => {
    if (busy) return
    setBusy(true)
    console.log(`[unity] phone Start Unity pressed in ${stateLabel(life)} for ${life.project}`)
    void window.api.unity.retry(life.project).then(
      (r) => {
        console.log(`[unity] start ${r.ok ? 'ok' : 'failed'}${r.error ? `: ${r.error}` : r.note ? `: ${r.note}` : ''}`)
        if (!r.ok) setBusy(false)
      },
      (e: Error) => {
        console.log(`[unity] start failed: ${e.message}`)
        setBusy(false)
      }
    )
  }
  return (
    <div className="ws-swap absolute inset-0 flex flex-col items-center justify-center bg-canvas px-8 text-center" data-unity-state-card={stateLabel(life)} data-unity-state={life.state}>
      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-zinc-500" />
      <p className="mt-2.5 text-[14px] text-zinc-300">{stateTitle(life)}</p>
      {canStart && (
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="ws-press mt-5 h-9 rounded-full bg-white/[0.09] px-5 text-[14px] font-medium text-zinc-100 disabled:opacity-50"
          data-unity-state-action="start"
        >
          {busy ? 'Starting…' : 'Start Unity'}
        </button>
      )}
    </div>
  )
}

export function UnityLoadingCard({ life, inst }: { life: UnityLifecycle; inst: InstanceObserved | undefined }) {
  const [busy, setBusy] = useState(false)
  useEffect(() => setBusy(false), [life.state])
  const step = stepOf(life, inst)
  const value = useStageProgress(step.text, step.from, step.to, step.pct, life.state === 'stopping' ? 2500 : 6000)
  const label = stateLabel(life)
  const cancel = (): void => {
    if (busy) return
    setBusy(true)
    console.log(`[unity] phone Cancel pressed in ${label} for ${life.project}`)
    void window.api.unity.cancel(life.project).then(
      (r) => console.log(`[unity] cancel ${r.ok ? 'ok' : 'failed'}${r.error ? `: ${r.error}` : r.note ? `: ${r.note}` : ''}`),
      (e: Error) => {
        console.log(`[unity] cancel failed: ${e.message}`)
        setBusy(false)
      }
    )
  }
  return (
    <div className="ws-swap absolute inset-0 z-[35] flex flex-col items-center justify-center bg-canvas px-8 text-center" data-unity-state-card={label} data-unity-state={life.state} data-unity-loading>
      <ProgressBar value={value} className="h-[3px] w-full max-w-[240px]" />
      <div className="mt-3 flex min-h-[20px] w-full max-w-[280px] justify-center text-[13px] leading-5 text-zinc-300">
        <Crossfade k={step.text}>
          <span className="truncate" data-unity-step>
            {step.text}…{step.pct >= 0 && <span className="tabular-nums text-zinc-500"> {Math.round(step.pct)}%</span>}
          </span>
        </Crossfade>
      </div>
      {life.stall && life.state === 'starting' && <p className="ws-fade-in mt-1.5 line-clamp-2 max-w-[280px] text-[12px] leading-snug text-amber-200/80" data-unity-stall>{life.stall}</p>}
      {life.state === 'starting' && (
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          className="ws-press mt-5 h-9 rounded-full bg-white/[0.09] px-5 text-[14px] font-medium text-zinc-100 disabled:opacity-50"
          data-unity-state-action="cancel"
        >
          Cancel
        </button>
      )}
    </div>
  )
}
