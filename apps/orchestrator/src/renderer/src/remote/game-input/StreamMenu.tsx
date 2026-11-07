import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { MonitorPlay } from 'lucide-react'
import { RV_PRESETS, type RvPreset, type RvSettings } from '@shared/remote-video'
import type { ReceiverStats } from '../video/receiver'
import { rttOf, signal } from '../video/StreamBadge'
import { PATH_TEXT, stepLabel } from '../video/steps'
import { contentBox } from './geometry'

export interface StreamQuality {
  stats: ReceiverStats | null
  showStats: boolean
  pick: (patch: Partial<RvSettings>) => void
  pending: <K extends keyof RvSettings>(k: K, v: RvSettings[K]) => boolean
}

const TRIGGER = 30
const MIN_BAR = 28
const GAP = 6

interface Spot {
  left: number
  top: number
  size: number
  w: number
  h: number
}

function placeTrigger(canvas: HTMLCanvasElement | null, root: HTMLElement): Spot {
  const r = root.getBoundingClientRect()
  const box = contentBox(canvas)
  const base = { w: r.width, h: r.height }
  if (box) {
    const right = r.right - (box.x + box.w)
    const top = box.y - r.top
    if (right >= MIN_BAR) {
      const size = Math.min(TRIGGER, right - 4)
      return { ...base, size, left: r.width - right / 2 - size / 2, top: GAP }
    }
    if (top >= MIN_BAR) {
      const size = Math.min(TRIGGER, top - 4)
      return { ...base, size, left: r.width - size - GAP, top: top >= size + 2 * GAP ? top - size - GAP : top / 2 - size / 2 }
    }
  }
  return { ...base, size: TRIGGER, left: r.width - TRIGGER - GAP, top: GAP }
}

export function QualityControls({ quality }: { quality: StreamQuality }): React.JSX.Element {
  const cur = quality.stats?.settings
  const pixel = cur?.filter === 'pixel'
  return (
    <div className="flex flex-col gap-1.5" data-gi-quality>
      <span className="px-0.5 text-[11px] text-ink-3">Picture</span>
      <div className="flex flex-col gap-0.5 rounded-md bg-sunken p-0.5" role="radiogroup" aria-label="Picture">
        {(Object.keys(RV_PRESETS) as RvPreset[]).map((p) => {
          const on = cur?.preset === p
          return (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={on}
              className={`flex flex-col items-start rounded px-2 py-1.5 text-left ${on ? 'bg-elevated' : ''} ${quality.pending('preset', p) ? 'remote-pending' : ''}`}
              data-gi-menu-pick={`preset:${p}`}
              onClick={() => quality.pick({ preset: p })}
            >
              <span className={`text-[12.5px] ${on ? 'text-ink' : 'text-ink-2'}`}>{RV_PRESETS[p].label}</span>
              <span className="text-[11px] leading-snug text-ink-3">{RV_PRESETS[p].note}</span>
            </button>
          )
        })}
      </div>
      <button
        type="button"
        className={`flex items-center gap-2 rounded-md px-0.5 py-1 text-left ${quality.pending('filter', pixel ? 'smooth' : 'pixel') ? 'remote-pending' : ''}`}
        aria-pressed={pixel}
        data-gi-menu-pick={`filter:${pixel ? 'smooth' : 'pixel'}`}
        onClick={() => quality.pick({ filter: pixel ? 'smooth' : 'pixel' })}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[12.5px] text-ink-2">Pixel art</span>
          <span className="text-[11px] leading-snug text-ink-3">Crisp pixels, no blur</span>
        </span>
        <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${pixel ? 'bg-accent' : 'bg-sunken'}`}>
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${pixel ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
        </span>
      </button>
    </div>
  )
}

export function statsLine(s: ReceiverStats | null): string {
  if (!s?.painted || s.state !== 'connected') return stepLabel(s?.step ?? 'desktop', s?.path ?? null)
  const rtt = rttOf(s)
  return [signal(s).word, s.path ? PATH_TEXT[s.path] : null, rtt == null ? null : `${rtt} ms`].filter(Boolean).join(' · ')
}

export function StreamMenu({ canvas, quality, icon, children, hidden }: { canvas: HTMLCanvasElement | null; quality: StreamQuality; icon?: ReactNode; children?: ReactNode; hidden?: boolean }): React.JSX.Element | null {
  const anchor = useRef<HTMLDivElement>(null)
  const [spot, setSpot] = useState<Spot | null>(null)
  const [open, setOpen] = useState(false)
  const s = quality.stats

  useLayoutEffect(() => {
    const root = anchor.current?.parentElement
    if (!root) return
    const place = (): void => setSpot(placeTrigger(canvas, root))
    place()
    const ro = new ResizeObserver(place)
    ro.observe(root)
    return () => ro.disconnect()
  }, [canvas, s?.width, s?.height])

  useEffect(() => {
    if (hidden) setOpen(false)
  }, [hidden])

  const menuW = spot ? Math.min(268, spot.w - 2 * GAP) : 268
  const menuLeft = spot ? Math.max(GAP, Math.min(spot.left + spot.size - menuW, spot.w - menuW - GAP)) : GAP
  const menuTop = spot ? spot.top + spot.size + GAP : 0
  return (
    <div ref={anchor} className="gi-chrome contents" onPointerDown={(e) => e.stopPropagation()}>
      {spot && !hidden && (
        <button
          type="button"
          className={`absolute z-[6] flex items-center justify-center rounded-full border border-white/10 text-ink-2 ${open ? 'bg-elevated text-ink' : 'bg-panel/70'}`}
          style={{ left: spot.left, top: spot.top, width: spot.size, height: spot.size }}
          aria-label="Stream and input"
          aria-expanded={open}
          data-gi-menu-trigger
          onClick={() => setOpen(!open)}
        >
          {icon ?? <MonitorPlay size={15} />}
        </button>
      )}
      {open && spot && !hidden && (
        <>
          <div className="absolute inset-0 z-[6]" onPointerDown={() => setOpen(false)} />
          <div
            className="absolute z-[7] flex flex-col gap-3 overflow-y-auto rounded-lg border border-white/10 bg-panel p-2.5 text-ink-2 shadow-2xl"
            style={{ left: menuLeft, top: menuTop, width: menuW, maxHeight: Math.max(120, spot.h - menuTop - GAP) }}
            data-gi-menu
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('[data-gi-menu-close]')) setOpen(false)
            }}
          >
            {quality.showStats && (
              <div className="truncate px-0.5 text-[11px] text-ink-3" data-rv-stats>
                {statsLine(s)}
              </div>
            )}
            {children}
            <QualityControls quality={quality} />
          </div>
        </>
      )}
    </div>
  )
}
