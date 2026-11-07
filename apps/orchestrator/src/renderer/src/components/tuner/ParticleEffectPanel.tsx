import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Pause, Play, RotateCcw, Square } from 'lucide-react'
import type { TunerParticles, TunerParticlesOp } from '@shared/tuner'

const btn =
  'flex h-6 flex-1 items-center justify-center gap-1 rounded text-[11px] text-zinc-300 transition-colors hover:bg-white/10 hover:text-zinc-100 disabled:opacity-40'

function seconds(v: number): string {
  return v.toFixed(2)
}

export function ParticleEffectPanel({
  projectPath,
  session,
  particles,
  bottom
}: {
  projectPath: string
  session: string
  particles: TunerParticles
  bottom?: number
}) {
  const [busy, setBusy] = useState(false)
  const [speed, setSpeed] = useState(String(particles.speed))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setSpeed(String(particles.speed)), [particles.speed])

  const ref = useRef<HTMLDivElement>(null)
  const [lift, setLift] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const host = el?.offsetParent as HTMLElement | null
    const area = el?.closest('[data-tuner-viewport-area]')
    if (!el || !host || !area || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      const tl = area.querySelector(':scope > [data-tuner-timeline-overlay]')?.firstElementChild
      const a = host.getBoundingClientRect()
      if (!tl || a.height <= 0) return setLift(null)
      const b = tl.getBoundingClientRect()
      const over = b.right > a.left && b.left < a.right ? a.bottom - b.top : 0
      setLift(over > 0 ? Math.max(0, Math.min(Math.round((over * host.offsetHeight) / a.height) + 8, host.offsetHeight - el.offsetHeight - 8)) : null)
    }
    const ro = new ResizeObserver(measure)
    const watch = (): void => {
      ro.disconnect()
      ro.observe(host)
      const overlay = area.querySelector(':scope > [data-tuner-timeline-overlay]')
      if (overlay) {
        mo.observe(overlay, { childList: true })
        if (overlay.firstElementChild) ro.observe(overlay.firstElementChild)
      }
      measure()
    }
    const mo = new MutationObserver(watch)
    mo.observe(area, { childList: true })
    watch()
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [])
  const at = lift ?? bottom

  const send = (op: TunerParticlesOp, value?: number): void => {
    setBusy(true)
    void window.api.tuner.particles(projectPath, session, op, value).then((r) => {
      setBusy(false)
      setError(r.ok ? null : r.error)
    })
  }

  const commitSpeed = (): void => {
    const v = Number(speed)
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      setSpeed(String(particles.speed))
      return
    }
    if (v !== particles.speed) send('speed', v)
  }

  const edit = particles.mode === 'edit'

  return (
    <div
      data-viewport-ui
      ref={ref}
      data-tuner-particles
      style={at != null ? { bottom: at } : undefined}
      className={`surface-overlay absolute ${at != null ? '' : 'bottom-6'} right-2 w-56 rounded-lg p-2 text-[11px] text-zinc-300`}
    >
      <div className="mb-1.5 flex items-baseline gap-1.5">
        <span className="shrink-0 font-medium text-zinc-100">Particle Effect</span>
        <span className="truncate text-zinc-500" title={particles.path}>
          {particles.name}
        </span>
      </div>
      <div className="mb-1.5 flex gap-1">
        <button
          type="button"
          className={btn}
          disabled={busy}
          data-ti-tip={particles.playing ? 'Pause' : 'Play'}
          aria-label={particles.playing ? 'Pause' : 'Play'}
          onClick={() => send(particles.playing ? 'pause' : 'play')}
        >
          {particles.playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button type="button" className={btn} disabled={busy} data-ti-tip="Restart" aria-label="Restart" onClick={() => send('restart')}>
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={btn} disabled={busy} data-ti-tip="Stop" aria-label="Stop" onClick={() => send('stop')}>
          <Square className="h-3 w-3" />
        </button>
      </div>
      <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1">
        {edit && (
          <>
            <label htmlFor={`${session}-ps-speed`} className="text-zinc-400">
              Playback Speed
            </label>
            <input
              id={`${session}-ps-speed`}
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={speed}
              onChange={(e) => setSpeed(e.target.value)}
              onBlur={commitSpeed}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              className="w-16 rounded border border-white/10 bg-sunken px-1 py-0.5 text-right tabular-nums text-zinc-100 outline-none focus:border-sky-500/60"
            />
          </>
        )}
        <span className="text-zinc-400">Playback Time</span>
        <span className="text-right tabular-nums" data-tuner-particles-time>
          {seconds(particles.time)}
        </span>
        <span className="text-zinc-400">Particles</span>
        <span className="text-right tabular-nums" data-tuner-particles-count>
          {particles.count}
        </span>
      </div>
      {error && <div className="mt-1.5 text-[10px] text-rose-300">{error}</div>}
    </div>
  )
}
