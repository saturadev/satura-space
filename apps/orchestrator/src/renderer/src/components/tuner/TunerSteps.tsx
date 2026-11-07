import { Check, ChevronRight, Loader2 } from 'lucide-react'
import type { TunerButtonSpec } from '@shared/tuner'

export function buttonModeOk(b: TunerButtonSpec, playing: boolean): boolean {
  return !b.mode || (b.mode === 'play') === playing
}

export function TunerSteps({
  buttons,
  playing,
  live,
  running,
  done,
  onRun
}: {
  buttons: readonly TunerButtonSpec[]
  playing: boolean
  live: boolean
  running: number | null
  done: number
  onRun: (index: number) => void
}) {
  const steps = buttons.map((b, i) => ({ b, i })).filter((x) => !!x.b.step)
  if (steps.length === 0) return null
  const title = steps[0].b.step
  const needsPlay = steps.some((x) => x.b.mode === 'play')
  const next = steps[done]
  const hint = !live
    ? 'Waiting for the Unity editor.'
    : needsPlay && !playing
      ? 'Press Play in the Unity panel, then run the steps in order.'
      : !next
        ? 'All steps done. To run them again, stop and press Play.'
        : `Next: ${done + 1}. ${next.b.label}${next.b.tip ? `. ${next.b.tip}` : ''}`
  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-hairline px-3 py-1" data-tuner-steps={title}>
      <span className="mr-1 shrink-0 text-[11px] font-medium text-ink-2">{title}</span>
      <div className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto">
        {steps.map(({ b, i }, k) => {
          const state = k < done ? 'done' : k === done ? 'next' : 'later'
          const modeOk = buttonModeOk(b, playing)
          const enabled = live && running == null && modeOk && k === done
          const why = !modeOk
            ? b.mode === 'play'
              ? 'Works in Play Mode.'
              : 'Works in Edit Mode.'
            : k > done
              ? `Run step ${done + 1} first.`
              : k < done
                ? 'Done.'
                : ''
          const tip = [b.tip, why].filter(Boolean).join(' ')
          return (
            <div key={b.label} className="flex shrink-0 items-center gap-0.5">
              {k > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-ink-3/60" />}
              <button
                type="button"
                data-tuner-step={k + 1}
                data-step-state={state}
                aria-disabled={!enabled}
                data-ti-tip={tip || undefined}
                onClick={() => {
                  if (enabled) onRun(i)
                }}
                className={`flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-xs transition-colors ${
                  enabled
                    ? 'bg-accent/15 text-ink hover:bg-accent/25'
                    : state === 'done'
                      ? 'cursor-default text-ink-2'
                      : 'cursor-not-allowed text-ink-3'
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] tabular-nums ${
                    state === 'done' ? 'bg-accent/25 text-ink' : enabled ? 'bg-accent text-accent-fg' : 'border border-hairline'
                  }`}
                >
                  {running === i ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : state === 'done' ? <Check className="h-2.5 w-2.5" /> : k + 1}
                </span>
                {b.label}
              </button>
            </div>
          )
        })}
      </div>
      <span className="ml-2 min-w-0 flex-1 truncate text-right text-[11px] text-ink-3" title={hint} data-tuner-steps-hint>
        {hint}
      </span>
    </div>
  )
}
