import { useEffect, useMemo, useRef, useState } from 'react'
import { Pipette } from 'lucide-react'
import type { TunerColor } from '@shared/tuner-inspector-popups'
import {
  colorState,
  cssColor,
  gammaToLinear,
  hexOf,
  hsvToRgb,
  linearToGamma,
  maxComponent,
  resetState,
  setByte,
  setExposure,
  setHdrChannel,
  setHex,
  setHsv,
  setHsv2,
  setRgbHdr,
  stateColor,
  type ColorState
} from './color-math'
import { CHECKER, DragTrack, NumField, Segmented, fieldCls, fmtNum, returnFocus, useFocusOnMount } from './controls'

type SliderMode = 'rgb' | 'float' | 'hsv'

const MODE_KEY = 'satura.tuner.colorPicker.mode'
const MODE_KEY_HDR = 'satura.tuner.colorPicker.modeHdr'
const EXPOSURE_MAX = 10
const BOX = 96

function readMode(hdr: boolean): SliderMode {
  try {
    const v = localStorage.getItem(hdr ? MODE_KEY_HDR : MODE_KEY)
    if (v === 'rgb' || v === 'float' || v === 'hsv') return v
  } catch {
  }
  return 'rgb'
}

function saveMode(hdr: boolean, m: SliderMode): void {
  try {
    localStorage.setItem(hdr ? MODE_KEY_HDR : MODE_KEY, m)
  } catch {
  }
}

interface EyeDropperCtor {
  new (): { open: () => Promise<{ sRGBHex: string }> }
}

export interface ColorPickerProps {
  value: TunerColor
  hdr: boolean
  showAlpha: boolean
  onChange: (c: TunerColor) => void
  onCommit?: () => void
  onCancel?: () => void
}

export function ColorPicker({ value, hdr, showAlpha, onChange, onCommit, onCancel }: ColorPickerProps) {
  const [st, setSt] = useState<ColorState>(() => colorState(value, hdr))
  const [mode, setModeState] = useState<SliderMode>(() => readMode(hdr))
  const [hex, setHexDraft] = useState<string | null>(null)
  const stRef = useRef(st)
  stRef.current = st
  const linear = hdr
  const rootRef = useRef<HTMLDivElement>(null)
  useFocusOnMount(rootRef)

  const update = (next: ColorState | null): void => {
    if (!next || next === stRef.current) return
    stRef.current = next
    setSt(next)
    onChange(stateColor(next))
  }

  const setMode = (m: SliderMode): void => {
    setModeState(m)
    saveMode(hdr, m)
  }

  const current = stateColor(st)
  const [h, s, v] = st.hsv
  const hueCss = useMemo(() => {
    const [r, g, b] = hsvToRgb(h, 1, 1)
    return cssColor({ r, g, b, a: 1 }, false, false)
  }, [h])

  const boxRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = boxRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const img = ctx.createImageData(BOX, BOX)
    for (let y = 0; y < BOX; y++) {
      const vv = 1 - y / (BOX - 1)
      for (let x = 0; x < BOX; x++) {
        const ss = x / (BOX - 1)
        const [r, g, b] = hsvToRgb(h, ss, vv)
        const o = (y * BOX + x) * 4
        img.data[o] = Math.round((linear ? linearToGamma(r) : r) * 255)
        img.data[o + 1] = Math.round((linear ? linearToGamma(g) : g) * 255)
        img.data[o + 2] = Math.round((linear ? linearToGamma(b) : b) * 255)
        img.data[o + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
  }, [h, linear])

  const boxDrag = useRef(false)
  const pickBox = (e: React.PointerEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const ss = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    const vv = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height))
    update(setHsv2(stRef.current, ss, vv))
  }

  const track = (stops: TunerColor[]): string => `linear-gradient(to right, ${stops.map((c) => cssColor(c, linear)).join(', ')})`
  const rgbBase = { r: st.bytes[0] / 255, g: st.bytes[1] / 255, b: st.bytes[2] / 255 }
  const channelTrack = (i: number): string => {
    const lo = { ...rgbBase, a: 1 }
    const hi = { ...rgbBase, a: 1 }
    const key = (['r', 'g', 'b'] as const)[i]
    lo[key] = 0
    hi[key] = 1
    return track([lo, hi])
  }
  const hueTrackV = `linear-gradient(to bottom, ${[0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1].map((k) => {
    const [r, g, b] = hsvToRgb(k, 1, 1)
    return cssColor({ r, g, b, a: 1 }, false, false)
  }).join(', ')})`
  const hueTrackH = hueTrackV.replace('to bottom', 'to right')
  const satTrack = (): string => {
    const steps = [0, 0.5, 1].map((k) => {
      const [r, g, b] = hsvToRgb(h, k, Math.max(v, 0.2))
      return { r, g, b, a: 1 }
    })
    return track(steps)
  }
  const valTrack = (): string => {
    const steps = [0, 0.5, 1].map((k) => {
      const [r, g, b] = hsvToRgb(h, s, k)
      return { r, g, b, a: 1 }
    })
    return track(steps)
  }
  const alphaTrack = `${track([{ ...rgbBase, a: 0 }, { ...rgbBase, a: 1 }])}, ${CHECKER.backgroundImage}`

  const floatMax = hdr && maxComponent(current) > 1 ? maxComponent(current) / Math.max(1e-6, Math.max(rgbBase.r, rgbBase.g, rgbBase.b)) : 1
  const labels = ['R', 'G', 'B']

  const rows =
    mode === 'hsv'
      ? [
          { label: 'H', value: h * 360, max: 360, digits: 0, bg: hueTrackH, set: (x: number) => update(setHsv(stRef.current, 0, x / 360)) },
          { label: 'S', value: s * 100, max: 100, digits: 0, bg: satTrack(), set: (x: number) => update(setHsv(stRef.current, 1, x / 100)) },
          { label: 'V', value: v * 100, max: 100, digits: 0, bg: valTrack(), set: (x: number) => update(setHsv(stRef.current, 2, x / 100)) }
        ]
      : [0, 1, 2].map((i) =>
          mode === 'rgb'
            ? { label: labels[i], value: st.bytes[i], max: 255, digits: 0, bg: channelTrack(i), set: (x: number) => update(setByte(stRef.current, i, x)) }
            : {
                label: labels[i],
                value: st.hdr[i],
                max: floatMax,
                digits: 3,
                bg: channelTrack(i),
                fieldMax: hdr ? Infinity : 1,
                set: (x: number) => update(setHdrChannel(stRef.current, i, x))
              }
        )

  const alphaScale = mode === 'hsv' ? 100 : mode === 'rgb' ? 255 : 1
  const eyeDropper = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper
  const hexText = hexOf(st.bytes, showAlpha)
  const exposureSwatches = [-2, -1, 0, 1, 2]

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target instanceof HTMLInputElement) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel?.()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onCommit?.()
    }
  }

  return (
    <div ref={rootRef} tabIndex={-1} data-popup-focus className="flex w-[244px] flex-col gap-2 p-2.5 outline-none" data-color-picker onKeyDown={onKeyDown}>
      <div className="flex items-stretch gap-1.5">
        <div className="flex h-6 flex-1 overflow-hidden rounded ring-1 ring-inset ring-white/10" style={CHECKER}>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Original color"
            data-ti-tip="Original color. Click to restore it."
            data-color-original
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => update(resetState(stRef.current, hdr))}
            className="h-full flex-1"
            style={{ background: cssColor(st.original, linear) }}
          />
          <div className="h-full flex-1" data-color-current style={{ background: cssColor(current, linear) }} />
        </div>
        {eyeDropper && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Pick a color from the screen"
            data-ti-tip="Pick a color from the screen"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              void new eyeDropper()
                .open()
                .then((r) => {
                  const n = parseInt(r.sRGBHex.replace('#', ''), 16)
                  const g = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255)
                  const c = hdr ? g.map(gammaToLinear) : g
                  update(setRgbHdr(stRef.current, { r: c[0], g: c[1], b: c[2] }))
                })
                .catch(() => {})
            }}
            className="flex w-7 items-center justify-center rounded text-ink-3 ring-1 ring-inset ring-white/10 hover:bg-white/10 hover:text-ink"
          >
            <Pipette className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <div
          className="relative h-[150px] flex-1 cursor-crosshair touch-none overflow-hidden rounded ring-1 ring-inset ring-white/10"
          data-color-box
          style={{ background: hueCss }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            boxDrag.current = true
            pickBox(e)
          }}
          onPointerMove={(e) => boxDrag.current && pickBox(e)}
          onPointerUp={(e) => {
            boxDrag.current = false
            e.currentTarget.releasePointerCapture(e.pointerId)
          }}
          onPointerCancel={() => {
            boxDrag.current = false
          }}
        >
          <canvas ref={boxRef} width={BOX} height={BOX} className="pointer-events-none absolute inset-0 h-full w-full" />
          <div
            className="pointer-events-none absolute h-3 w-3 rounded-full border-2 border-ink shadow-[0_0_0_1px_var(--canvas)]"
            style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, transform: 'translate(-50%, -50%)' }}
          />
        </div>
        <DragTrack
          vertical
          label="Hue"
          value={h * 360}
          min={0}
          max={360}
          background={hueTrackV}
          className="h-[150px] w-3.5"
          onChange={(x) => update(setHsv(stRef.current, 0, x / 360))}
        />
      </div>

      <Segmented
        name="color-mode"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'rgb', label: 'RGB 0–255' },
          { value: 'float', label: hdr ? 'RGB 0–Inf' : 'RGB 0–1.0' },
          { value: 'hsv', label: 'HSV' }
        ]}
      />

      <div className="flex flex-col gap-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-1.5">
            <span className="w-3 text-[10px] font-medium text-ink-3">{r.label}</span>
            <DragTrack
              label={r.label}
              value={r.value}
              min={0}
              max={r.max}
              background={r.bg}
              className="h-3.5 flex-1"
              onChange={(x) => r.set(r.digits === 0 ? Math.round(x) : x)}
            />
            <NumField
              name={r.label}
              label={r.label}
              value={r.value}
              digits={r.digits}
              min={0}
              max={'fieldMax' in r ? r.fieldMax : r.max}
              onChange={r.set}
            />
          </div>
        ))}
        {showAlpha && (
          <div className="flex items-center gap-1.5">
            <span className="w-3 text-[10px] font-medium text-ink-3">A</span>
            <DragTrack
              label="A"
              value={(st.bytes[3] / 255) * alphaScale}
              min={0}
              max={alphaScale}
              background={alphaTrack}
              style={{ backgroundSize: '100% 100%, 8px 8px', backgroundColor: 'var(--panel)' }}
              className="h-3.5 flex-1"
              onChange={(x) => update(setByte(stRef.current, 3, Math.round((x / alphaScale) * 255)))}
            />
            <NumField
              name="A"
              label="A"
              value={alphaScale === 1 ? st.hdr[3] : Math.round((st.bytes[3] / 255) * alphaScale)}
              digits={alphaScale === 1 ? 3 : 0}
              min={0}
              max={alphaScale}
              onChange={(x) => update(setByte(stRef.current, 3, Math.round((x / alphaScale) * 255)))}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <span className="flex-1 text-[10px] text-ink-3">Hexadecimal</span>
        <input
          aria-label="Hexadecimal"
          data-color-hex
          spellCheck={false}
          className={`${fieldCls} w-[84px] font-mono uppercase`}
          value={hex ?? hexText}
          onFocus={(e) => {
            setHexDraft(hexText)
            e.currentTarget.select()
          }}
          onChange={(e) => setHexDraft(e.target.value)}
          onBlur={() => {
            if (hex !== null) update(setHex(stRef.current, hex, showAlpha))
            setHexDraft(null)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              if (hex !== null) update(setHex(stRef.current, hex, showAlpha))
              setHexDraft(null)
              returnFocus(e.currentTarget)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setHexDraft(null)
              returnFocus(e.currentTarget)
            }
          }}
        />
      </div>

      {hdr && (
        <div className="flex flex-col gap-1.5 border-t border-white/5 pt-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-ink-3">Intensity</span>
            <DragTrack
              label="Intensity"
              value={st.exposure}
              min={-EXPOSURE_MAX}
              max={EXPOSURE_MAX}
              background="linear-gradient(to right, var(--sunken), var(--elevated))"
              className="h-3.5 flex-1"
              thumb="circle"
              onChange={(x) => update(setExposure(stRef.current, Math.round(x * 100) / 100))}
            />
            <NumField name="Intensity" label="Intensity" value={st.exposure} digits={2} onChange={(x) => update(setExposure(stRef.current, x))} />
          </div>
          <div className="flex justify-center gap-1">
            {exposureSwatches.map((stop) => {
              const k = Math.pow(2, stop)
              const c = { r: current.r * k, g: current.g * k, b: current.b * k, a: 1 }
              return (
                <button
                  key={stop}
                  type="button"
                  tabIndex={-1}
                  aria-label={`${stop > 0 ? '+' : ''}${stop} stops`}
                  data-ti-tip={`${stop > 0 ? '+' : ''}${stop} stops`}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => update(setExposure(stRef.current, Math.max(-EXPOSURE_MAX, Math.min(EXPOSURE_MAX, stRef.current.exposure + stop))))}
                  className={`h-4 w-9 rounded-[3px] ring-1 ring-inset ${stop === 0 ? 'ring-accent' : 'ring-white/10'}`}
                  style={{ background: cssColor(c, true, false) }}
                />
              )
            })}
          </div>
        </div>
      )}
      <div className="flex justify-between text-[10px] tabular-nums text-ink-4">
        <span>{hdr ? 'HDR' : ''}</span>
        <span data-color-value>
          {fmtNum(current.r, 3)}, {fmtNum(current.g, 3)}, {fmtNum(current.b, 3)}
          {showAlpha ? `, ${fmtNum(current.a, 3)}` : ''}
        </span>
      </div>
    </div>
  )
}
