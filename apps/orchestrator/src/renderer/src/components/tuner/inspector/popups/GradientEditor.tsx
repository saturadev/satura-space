import { useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { GRADIENT_MODE, type TunerColor, type TunerGradient } from '@shared/tuner-inspector-popups'
import {
  GRADIENT_PRESETS,
  MAX_GRADIENT_KEYS,
  addAlphaKey,
  addColorKey,
  applyGradientPreset,
  displayOf,
  gradientCss,
  keysAreLinear,
  maxColorComponent,
  moveKey,
  removeKey
} from './gradient-math'
import { CHECKER, DragTrack, MenuButton, NumField, useFocusOnMount } from './controls'
import { ColorPicker } from './ColorPicker'
import { PopupSurface, rectBox } from './PopupSurface'
import { isPhoneView } from '../../../../lib/tuner/view-mirror'

const W = 340
const LANE = 16
const PHONE_LANE = 26
const REMOVE_PX = 26
const PHONE_REMOVE_PX = 44
const TOUCH_GRAB_PX = 16

const MODES = [
  { value: GRADIENT_MODE.blend, label: 'Blend' },
  { value: GRADIENT_MODE.perceptual, label: 'Perceptual' },
  { value: GRADIENT_MODE.fixed, label: 'Fixed' }
]

type Sel = { alpha: boolean; index: number }

export interface GradientEditorProps {
  value: TunerGradient
  hdr: boolean
  onChange: (g: TunerGradient) => void
  onCommit?: () => void
  onCancel?: () => void
}

export function GradientEditor({ value, hdr, onChange, onCommit, onCancel }: GradientEditorProps) {
  const [g, setG] = useState<TunerGradient>(() => ({
    ...value,
    colorKeys: [...value.colorKeys].sort((a, b) => a.time - b.time),
    alphaKeys: [...value.alphaKeys].sort((a, b) => a.time - b.time)
  }))
  const [sel, setSel] = useState<Sel | null>(() => (value.colorKeys.length > 0 ? { alpha: false, index: 0 } : null))
  const [picking, setPicking] = useState<TunerColor | null>(null)
  const [doomed, setDoomed] = useState<Sel | null>(null)
  const gRef = useRef(g)
  gRef.current = g
  const barRef = useRef<HTMLDivElement>(null)
  const swatchRef = useRef<HTMLButtonElement>(null)
  const drag = useRef<{ sel: Sel; startY: number; moved: boolean } | null>(null)
  const linear = keysAreLinear(g)
  const rootRef = useRef<HTMLDivElement>(null)
  useFocusOnMount(rootRef)
  const [phone] = useState(isPhoneView)
  const lane = phone ? PHONE_LANE : LANE

  const update = (next: TunerGradient, nextSel?: Sel | null): void => {
    gRef.current = next
    setG(next)
    if (nextSel !== undefined) setSel(nextSel)
    onChange(next)
  }

  const timeAt = (clientX: number): number => {
    const r = barRef.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }

  const laneDown = (alpha: boolean) => (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const t = timeAt(e.clientX)
    if (e.pointerType === 'touch') {
      const keys = alpha ? gRef.current.alphaKeys : gRef.current.colorKeys
      const span = barRef.current?.getBoundingClientRect().width ?? W
      let near = -1
      keys.forEach((k, i) => {
        if (Math.abs(k.time - t) * span <= TOUCH_GRAB_PX && (near < 0 || Math.abs(k.time - t) < Math.abs(keys[near].time - t))) near = i
      })
      if (near >= 0) {
        const s = { alpha, index: near }
        setSel(s)
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { sel: s, startY: e.clientY, moved: false }
        return
      }
    }
    const r = alpha ? addAlphaKey(gRef.current, t) : addColorKey(gRef.current, t)
    if (!r) return
    const s = { alpha, index: r.index }
    update(r.gradient, s)
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { sel: s, startY: e.clientY, moved: false }
  }

  const markerDown = (s: Sel) => (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setSel(s)
    e.currentTarget.parentElement?.setPointerCapture(e.pointerId)
    drag.current = { sel: s, startY: e.clientY, moved: false }
  }

  const laneMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const count = d.sel.alpha ? gRef.current.alphaKeys.length : gRef.current.colorKeys.length
    const away = Math.abs(e.clientY - d.startY) > (phone ? PHONE_REMOVE_PX : REMOVE_PX) && count > 1
    setDoomed(away ? d.sel : null)
    if (away) return
    const r = moveKey(gRef.current, d.sel.alpha, d.sel.index, timeAt(e.clientX))
    d.sel = { alpha: d.sel.alpha, index: r.index }
    d.moved = true
    update(r.gradient, d.sel)
  }

  const laneUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    drag.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
    }
    if (d && doomed) {
      update(removeKey(gRef.current, d.sel.alpha, d.sel.index), null)
    }
    setDoomed(null)
  }

  const deleteSel = (): void => {
    if (!sel) return
    update(removeKey(gRef.current, sel.alpha, sel.index), null)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      e.preventDefault()
      deleteSel()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel?.()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onCommit?.()
    }
  }

  const selColor = sel && !sel.alpha ? g.colorKeys[sel.index] : undefined
  const selAlpha = sel && sel.alpha ? g.alphaKeys[sel.index] : undefined
  const selTime = selColor?.time ?? selAlpha?.time

  const setSelColor = (c: TunerColor): void => {
    if (!sel || sel.alpha) return
    const cur = gRef.current
    update({ ...cur, colorKeys: cur.colorKeys.map((k, i) => (i === sel.index ? { ...k, color: { r: c.r, g: c.g, b: c.b, a: 1 } } : k)) })
  }

  const marker = (s: Sel, time: number, fill: string, active: boolean) => (
    <div
      key={`${s.alpha ? 'a' : 'c'}${s.index}`}
      data-gradient-key={`${s.alpha ? 'alpha' : 'color'}:${s.index}`}
      onPointerDown={markerDown(s)}
      className={`absolute flex w-3 cursor-pointer flex-col items-center ${doomed && doomed.alpha === s.alpha && doomed.index === s.index ? 'opacity-25' : ''}`}
      style={{ left: `calc(${time * 100}% - 6px)`, top: s.alpha ? undefined : 0, bottom: s.alpha ? 0 : undefined, height: LANE }}
    >
      <div
        className={`h-0 w-0 border-x-[5px] border-x-transparent ${s.alpha ? 'order-2 border-t-[5px]' : 'border-b-[5px]'}`}
        style={s.alpha ? { borderTopColor: active ? 'var(--accent)' : 'var(--ink-3)' } : { borderBottomColor: active ? 'var(--accent)' : 'var(--ink-3)' }}
      />
      <div className={`h-[10px] w-3 rounded-[2px] border ${active ? 'border-accent' : 'border-white/30'}`} style={{ background: fill }} />
    </div>
  )

  return (
    <div ref={rootRef} tabIndex={-1} data-popup-focus className="flex w-[340px] flex-col gap-2 p-2.5 outline-none" data-gradient-editor onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-ink-3">Mode</span>
        <MenuButton label="Mode" options={MODES} value={g.mode} onChange={(m) => update({ ...gRef.current, mode: m })} className="w-[100px]" />
        <span className="ml-auto text-[10px] text-ink-4">{maxColorComponent(g) > 1 ? 'HDR' : ''}</span>
      </div>
      <div className="select-none" style={{ width: W - 20 }}>
        <div
          className="relative cursor-copy touch-none"
          style={{ height: lane }}
          data-gradient-lane="alpha"
          data-ti-tip={g.alphaKeys.length >= MAX_GRADIENT_KEYS ? `Up to ${MAX_GRADIENT_KEYS} alpha keys` : 'Click to add an alpha key'}
          onPointerDown={laneDown(true)}
          onPointerMove={laneMove}
          onPointerUp={laneUp}
          onPointerCancel={laneUp}
        >
          {g.alphaKeys.map((k, i) =>
            marker({ alpha: true, index: i }, k.time, displayOf({ r: k.alpha, g: k.alpha, b: k.alpha, a: 1 }, false), !!sel && sel.alpha && sel.index === i)
          )}
        </div>
        <div ref={barRef} className="relative h-6 overflow-hidden rounded-[3px] ring-1 ring-inset ring-white/10" style={CHECKER} data-gradient-preview>
          <div className="absolute inset-0" style={{ backgroundImage: gradientCss(g) }} />
        </div>
        <div
          className="relative cursor-copy touch-none"
          style={{ height: lane }}
          data-gradient-lane="color"
          data-ti-tip={g.colorKeys.length >= MAX_GRADIENT_KEYS ? `Up to ${MAX_GRADIENT_KEYS} color keys` : 'Click to add a color key'}
          onPointerDown={laneDown(false)}
          onPointerMove={laneMove}
          onPointerUp={laneUp}
          onPointerCancel={laneUp}
        >
          {g.colorKeys.map((k, i) => marker({ alpha: false, index: i }, k.time, displayOf({ ...k.color, a: 1 }, linear), !!sel && !sel.alpha && sel.index === i))}
        </div>
      </div>
      <div className="flex h-6 items-center gap-1.5 border-t border-white/5 pt-2">
        {selColor && (
          <>
            <span className="text-[10px] text-ink-3">Color</span>
            <button
              ref={swatchRef}
              type="button"
              data-gradient-color
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setPicking((p) => (p ? null : { ...selColor.color, a: 1 }))}
              className="h-5 w-14 rounded-[3px] ring-1 ring-inset ring-white/15"
              style={{ background: displayOf({ ...selColor.color, a: 1 }, linear) }}
            />
          </>
        )}
        {selAlpha && (
          <>
            <span className="text-[10px] text-ink-3">Alpha</span>
            <DragTrack
              label="Alpha"
              value={selAlpha.alpha * 255}
              min={0}
              max={255}
              background="linear-gradient(to right, var(--canvas), var(--ink))"
              className="h-3.5 w-20"
              onChange={(x) => {
                const cur = gRef.current
                update({ ...cur, alphaKeys: cur.alphaKeys.map((k, i) => (i === sel!.index ? { ...k, alpha: Math.round(x) / 255 } : k)) })
              }}
            />
            <NumField
              name="alpha"
              label="Alpha"
              value={Math.round(selAlpha.alpha * 255)}
              digits={0}
              min={0}
              max={255}
              className="w-10"
              onChange={(x) => {
                const cur = gRef.current
                update({ ...cur, alphaKeys: cur.alphaKeys.map((k, i) => (i === sel!.index ? { ...k, alpha: x / 255 } : k)) })
              }}
            />
          </>
        )}
        {selTime !== undefined && (
          <>
            <span className="ml-auto text-[10px] text-ink-3">Location</span>
            <NumField
              name="location"
              label="Location"
              value={selTime * 100}
              digits={1}
              min={0}
              max={100}
              className="w-12"
              onChange={(x) => {
                const r = moveKey(gRef.current, sel!.alpha, sel!.index, x / 100)
                update(r.gradient, { alpha: sel!.alpha, index: r.index })
              }}
            />
            <span className="text-[10px] text-ink-4">%</span>
            <button
              type="button"
              tabIndex={-1}
              aria-label="Delete key"
              data-ti-tip="Delete key"
              disabled={(sel!.alpha ? g.alphaKeys.length : g.colorKeys.length) <= 1}
              onPointerDown={(e) => e.preventDefault()}
              onClick={deleteSel}
              className="flex h-5 w-5 items-center justify-center rounded text-ink-3 hover:bg-white/10 hover:text-ink disabled:opacity-30"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </>
        )}
        {!sel && (
          <span className="text-[10px] text-ink-4">
            {phone ? 'Tap above or below the bar to add a key. Drag a key off the bar to remove it.' : 'Click above or below the bar to add a key. Drag a key off the bar to remove it.'}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1 border-t border-white/5 pt-2" data-gradient-presets>
        {GRADIENT_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            tabIndex={-1}
            aria-label={p.name}
            data-ti-tip={p.name}
            data-gradient-preset={p.name}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => update(applyGradientPreset(gRef.current, p), { alpha: false, index: 0 })}
            className="h-4 w-[50px] overflow-hidden rounded-[3px] ring-1 ring-inset ring-white/10 hover:ring-accent"
            style={CHECKER}
          >
            <div className="h-full w-full" style={{ backgroundImage: gradientCss(p.gradient) }} />
          </button>
        ))}
      </div>
      {picking && selColor && sel && (
        <PopupSurface getAnchor={() => rectBox(swatchRef.current)} onOutside={() => setPicking(null)} kind="gradient-color">
          <ColorPicker
            key={`${sel.index}`}
            value={picking}
            hdr={hdr}
            showAlpha={false}
            onChange={setSelColor}
            onCommit={() => setPicking(null)}
            onCancel={() => {
              setSelColor(picking)
              setPicking(null)
            }}
          />
        </PopupSurface>
      )}
    </div>
  )
}
