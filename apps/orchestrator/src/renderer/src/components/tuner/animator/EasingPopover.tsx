import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useKeepInView } from '../../../lib/floating'
import { LiftedLayer } from '../../ui/LiftedLayer'
import type { TunerAnimChannel, TunerAnimKey, TunerBezier } from '@shared/tuner-animator'
import { cubicBezier, fmt } from '../../../lib/tuner/animator'
import { EASE_LABELS, EASE_PRESETS, isAutoMode, sampleEase, segRep, shapeOf, type EaseSeg, type SegShape } from '../../../lib/tuner/curves'
import { iconBtn } from './TimelineParts'
import { zoomOf } from '../../../lib/css-zoom'
import { useMobileBack } from '../../../lib/mobile/mobile-back'

const EW = 116
const EX0 = 20
const EH = 220
const YLO = -0.62
const YHI = 1.68
const ex = (x: number): number => EX0 + x * EW
const ey = (y: number): number => 10 + ((YHI - y) / (YHI - YLO)) * (EH - 30)

const TILE_TIPS: Record<string, string> = {
  linear: 'A straight line at constant speed',
  ease: 'CSS ease: a quick start that settles gently',
  easeIn: 'Starts slow and speeds up',
  easeOut: 'Starts fast and slows down at the end',
  easeInOut: 'Slow at both ends',
  backIn: 'Pulls back a little before it moves',
  backOut: 'Overshoots the end, then settles back',
  step: 'Holds the value, then jumps at the next key (Constant tangents)',
  auto: "Clamped Auto on both keys, Unity's default smooth curve"
}

function tilePath(name: string): string {
  const X = (x: number): number => 4 + x * 32
  const Y = (y: number): number => 18 - y * 14
  if (name === 'step') return `M ${X(0)} ${Y(0)} L ${X(1)} ${Y(0)} L ${X(1)} ${Y(1)}`
  const b = name === 'auto' ? ([0.33, 0, 0.67, 1] as TunerBezier) : EASE_PRESETS[name]
  return `M ${X(0)} ${Y(0)} C ${X(b[0])} ${Y(b[1])} ${X(b[2])} ${Y(b[3])} ${X(1)} ${Y(1)}`
}

function sideText(k: TunerAnimKey, side: 'in' | 'out'): string {
  const tan = side === 'in' ? k.in : k.out
  const weighted = side === 'in' ? (k.wm & 1) !== 0 : (k.wm & 2) !== 0
  return `tangent ${tan === null ? 'constant' : fmt(tan, 3)}${weighted ? `, weight ${fmt(side === 'in' ? k.inW : k.outW, 2)}` : ', unweighted'}`
}

export function EasingPopover({
  seg,
  idx,
  names,
  fps,
  left,
  top,
  readOnly,
  onPreset,
  onDrag,
  onClose
}: {
  seg: EaseSeg
  idx: ReadonlyMap<string, TunerAnimChannel>
  names: ReadonlyMap<string, string>
  fps: number
  left: number
  top: number
  readOnly: boolean
  onPreset: (kind: string, b?: TunerBezier) => void
  onDrag: (b: TunerBezier, final: boolean) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useMobileBack(onClose, 'Easing')
  useKeepInView(ref)
  const svgRef = useRef<SVGSVGElement>(null)
  const dotRef = useRef<SVGCircleElement>(null)
  const barRef = useRef<SVGCircleElement>(null)
  const [drag, setDrag] = useState<{ which: 0 | 1; b: TunerBezier } | null>(null)
  const [hot, setHot] = useState(-1)
  const [text, setText] = useState<string | null>(null)
  const base = shapeOf(seg, idx, fps)
  const shape: SegShape = drag ? { b: drag.b } : base
  const shapeRef = useRef(shape)
  shapeRef.current = shape

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Element
      if (ref.current && !ref.current.contains(t) && !t.closest?.('[data-anim-seg]') && !t.closest?.('[data-anim-menu]')) onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [onClose])

  useEffect(() => {
    const t0 = performance.now()
    let raf = 0
    const tick = (): void => {
      const u = Math.min(1, ((performance.now() - t0) / 1600) % 1.25)
      const y = sampleEase(shapeRef.current, u)
      const flat = 'flat' in shapeRef.current
      dotRef.current?.setAttribute('cx', String(ex(u)))
      dotRef.current?.setAttribute('cy', String(ey(flat ? 0 : y)))
      barRef.current?.setAttribute('cy', String(ey(flat ? 0 : y)))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const sk = segRep(seg, idx, fps)
  const flat = 'flat' in shape
  const step = 'step' in shape
  const bez = 'b' in shape ? shape.b : null
  const auto = !!sk && isAutoMode(sk[0].rm) && isAutoMode(sk[1].lm)
  const linear = !!sk && sk[0].rm === 2 && sk[1].lm === 2

  const pt = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const el = svgRef.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    const k = zoomOf(el)
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
  }

  const handleAt = (p: { x: number; y: number }, b: TunerBezier): number => {
    const d1 = Math.hypot(p.x - ex(b[0]), p.y - ey(b[1]))
    const d2 = Math.hypot(p.x - ex(b[2]), p.y - ey(b[3]))
    if (Math.min(d1, d2) > 14) return -1
    return d1 <= d2 ? 0 : 1
  }

  const onDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (readOnly || flat || e.button !== 0) return
    const b: TunerBezier = bez ? [...bez] : [0.33, 0, 0.67, 1]
    const which = handleAt(pt(e), b)
    if (which < 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ which: which as 0 | 1, b })
  }

  const onMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const p = pt(e)
    if (!drag) {
      setHot(bez ? handleAt(p, bez) : -1)
      return
    }
    const x = Math.max(0, Math.min(1, (p.x - EX0) / EW))
    const y = Math.max(-1, Math.min(2, YHI - ((p.y - 10) / (EH - 30)) * (YHI - YLO)))
    const b: TunerBezier = [...drag.b]
    b[drag.which * 2] = Math.round(x * 100) / 100
    b[drag.which * 2 + 1] = Math.round(y * 100) / 100
    setDrag({ which: drag.which, b })
    onDrag(b, false)
  }

  const onUp = (): void => {
    if (!drag) return
    onDrag(drag.b, true)
    setDrag(null)
  }

  const applyText = (): void => {
    const nums = ((text ?? '').match(/-?\d*\.?\d+(e-?\d+)?/g) ?? []).map(Number)
    setText(null)
    if (nums.length !== 4 || nums.some((v) => !Number.isFinite(v))) return
    onPreset('bezier', [Math.max(0, Math.min(1, nums[0])), nums[1], Math.max(0, Math.min(1, nums[2])), nums[3]])
  }

  const tileOn = (name: string): boolean => {
    if (name === 'step') return step
    if (name === 'auto') return auto
    if (name === 'linear') return linear || (!!bez && EASE_PRESETS.linear.every((v, i) => Math.abs(v - bez[i]) < 0.02))
    const p = EASE_PRESETS[name]
    return !!bez && !!p && !auto && p.every((v, i) => Math.abs(v - bez[i]) < 0.02)
  }

  const inputValue = text ?? (step ? 'step' : flat ? 'no change' : bez ? bez.map((v) => fmt(v, 2)).join(', ') : '')
  const n = seg.targets.length

  return (
    <LiftedLayer>
      <div
        ref={ref}
        data-viewport-ui
        data-anim-ease-pop={`${seg.row}@${seg.fa}`}
        data-anim-ease-shape={step ? 'step' : flat ? 'flat' : bez ? bez.map((v) => v.toFixed(3)).join(',') : ''}
        className="surface-overlay absolute z-40 w-[404px] rounded-lg text-[11px] text-ink-2"
        style={{ left, top }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-[30px] items-center gap-1.5 border-b border-hairline pl-2.5 pr-1.5">
          <span className="font-medium text-ink">{seg.label}</span>
          <span className="text-ink-3">
            frames {seg.fa} → {seg.fb}
          </span>
          <span className="flex-1" />
          <button type="button" className={iconBtn} aria-label="Close" data-anim-ease-close onClick={onClose} data-ti-tip="Close (Esc)">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex gap-2.5 p-2.5">
          <svg
            ref={svgRef}
            data-anim-ease-canvas
            width={156}
            height={EH}
            className={`shrink-0 touch-none rounded bg-sunken ${flat || readOnly ? '' : hot >= 0 || drag ? 'cursor-grab' : 'cursor-crosshair'}`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onPointerLeave={() => setHot(-1)}
          >
            <rect x={ex(0) + 0.5} y={ey(1) + 0.5} width={EW} height={ey(0) - ey(1)} fill="none" stroke="currentColor" strokeOpacity={0.12} />
            <text x={6} y={ey(1) + 3} fontSize={9} fill="currentColor" fillOpacity={0.45}>
              1
            </text>
            <text x={6} y={ey(0) + 3} fontSize={9} fill="currentColor" fillOpacity={0.45}>
              0
            </text>
            <text x={ex(0)} y={EH - 2} fontSize={9} fill="currentColor" fillOpacity={0.45}>
              time →
            </text>
            <line x1={ex(0)} y1={ey(0)} x2={ex(1)} y2={ey(1)} stroke="currentColor" strokeOpacity={0.15} strokeDasharray="2 3" />
            {flat ? (
              <>
                <text x={ex(0) + 8} y={ey(0.55)} fontSize={10} fill="currentColor" fillOpacity={0.6}>
                  No change in value
                </text>
                <text x={ex(0) + 8} y={ey(0.45)} fontSize={10} fill="currentColor" fillOpacity={0.6}>
                  between these keys
                </text>
              </>
            ) : (
              <path
                d={step ? `M ${ex(0)} ${ey(0)} L ${ex(1)} ${ey(0)} L ${ex(1)} ${ey(1)}` : bez ? `M ${ex(0)} ${ey(0)} C ${ex(bez[0])} ${ey(bez[1])} ${ex(bez[2])} ${ey(bez[3])} ${ex(1)} ${ey(1)}` : ''}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={2}
              />
            )}
            <line x1={ex(1) + 12.5} y1={ey(0)} x2={ex(1) + 12.5} y2={ey(1)} stroke="currentColor" strokeOpacity={0.15} />
            <circle ref={barRef} cx={ex(1) + 12.5} cy={ey(0)} r={4} fill="var(--accent)" />
            <circle ref={dotRef} cx={ex(0)} cy={ey(0)} r={3} fill="var(--ink)" />
            {bez &&
              [
                [0, 0, bez[0], bez[1]],
                [1, 1, bez[2], bez[3]]
              ].map(([ax, ay, bx, by], j) => (
                <g key={j} data-anim-ease-handle={j}>
                  <line x1={ex(ax)} y1={ey(ay)} x2={ex(bx)} y2={ey(by)} stroke="var(--ink-3)" />
                  <circle cx={ex(bx)} cy={ey(by)} r={5} fill={(drag && drag.which === j) || hot === j ? 'var(--accent)' : 'var(--panel)'} stroke="var(--accent)" strokeWidth={1.5} />
                </g>
              ))}
          </svg>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="grid grid-cols-3 gap-1">
              {EASE_LABELS.map(([name, label]) => {
                const on = tileOn(name)
                const disabled = readOnly || (flat && name !== 'step' && name !== 'auto')
                return (
                  <button
                    key={name}
                    type="button"
                    data-anim-ease={name}
                    aria-pressed={on}
                    disabled={disabled}
                    onClick={() => onPreset(name, EASE_PRESETS[name])}
                    data-ti-tip={TILE_TIPS[name]}
                    className={`flex flex-col items-center gap-px rounded border px-0.5 pb-[3px] pt-1 text-[10px] transition-colors disabled:cursor-default disabled:opacity-35 ${on ? 'border-accent text-accent' : 'border-hairline text-ink-3 hover:border-strong hover:text-ink'}`}
                  >
                    <svg width={40} height={22} className="block">
                      <path d={tilePath(name)} fill="none" stroke="currentColor" strokeWidth={1.3} />
                    </svg>
                    {label}
                  </button>
                )
              })}
            </div>
            <label className="flex items-center gap-1.5" data-ti-tip="Type four numbers, as in CSS cubic-bezier, and press Enter">
              <span className="shrink-0 text-[10px] text-ink-3">cubic-bezier</span>
              <input
                data-anim-ease-input
                spellCheck={false}
                disabled={readOnly || flat}
                value={inputValue}
                onFocus={(e) => {
                  setText(bez ? bez.map((v) => fmt(v, 3)).join(', ') : '')
                  requestAnimationFrame(() => e.target.select())
                }}
                onChange={(e) => setText(e.target.value)}
                onBlur={() => setText(null)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    applyText()
                    ;(e.target as HTMLInputElement).blur()
                  } else if (e.key === 'Escape') {
                    setText(null)
                    ;(e.target as HTMLInputElement).blur()
                  }
                }}
                className="h-[22px] min-w-0 flex-1 rounded border border-hairline bg-sunken px-1 font-mono text-[10px] text-ink outline-none focus:border-accent disabled:opacity-50"
              />
            </label>
            <div className="text-[10px] leading-[1.45] tabular-nums text-ink-3" data-anim-ease-info>
              {flat ? (
                'Both keys have the same value, so there is nothing to ease. Step and Auto still apply, or open Curves to shape the segment by hand.'
              ) : sk ? (
                <>
                  Key {seg.fa} out: {sideText(sk[0], 'out')}
                  <br />
                  Key {seg.fb} in: {sideText(sk[1], 'in')}
                  {n > 1 && (
                    <>
                      <br />
                      Same easing on {n} curves: {seg.targets.map((t) => names.get(t.id) ?? t.id).join(', ')}
                    </>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>
        <div className="px-2.5 pb-2 text-[10px] text-ink-4">Drag the two handles or pick a preset. Your choice becomes Unity weighted tangents on both keys, so the clip stays a plain .anim. Ctrl+Z undoes it.</div>
      </div>
    </LiftedLayer>
  )
}

export function easeGlyphPath(shape: SegShape, x: number, y: number, w: number, h: number): string {
  if ('flat' in shape) return `M ${x} ${y + h / 2} L ${x + w} ${y + h / 2}`
  if ('step' in shape) return `M ${x} ${y + h} L ${x + w} ${y + h} L ${x + w} ${y}`
  const n = Math.max(6, Math.min(40, Math.round(w / 3)))
  let d = ''
  for (let j = 0; j <= n; j++) {
    const u = j / n
    const p = j === n ? 1 : cubicBezier(shape.b, u)
    const Y = y + h - Math.max(-0.35, Math.min(1.35, p)) * h
    d += `${j ? ' L' : 'M'} ${(x + u * w).toFixed(1)} ${Y.toFixed(1)}`
  }
  return d
}
