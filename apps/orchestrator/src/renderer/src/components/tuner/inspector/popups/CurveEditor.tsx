import { useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, Trash2 } from 'lucide-react'
import { WEIGHTED, WRAP, type TunerCurve, type TunerMenuData, type TunerPopupRect } from '@shared/tuner-inspector-popups'
import {
  addKey,
  applyPreset,
  applyTangentAction,
  clampToRanges,
  curveBounds,
  curvePresets,
  decodeCurve,
  dragTangent,
  evaluate,
  isStep,
  KEY_MENU,
  leftMode,
  moveKey,
  niceStep,
  removeKey,
  rightMode,
  segmentControls,
  tangentState,
  type Bounds
} from './curve-math'
import { TANGENT } from '@shared/tuner-inspector-popups'
import { MenuButton, NumField, fmtNum, useFocusOnMount } from './controls'
import { PopupMenu } from './PopupMenu'
import { isPhoneView } from '../../../../lib/tuner/view-mirror'
import { viewRect } from '../../../../lib/floating'

const W = 470
const H = 250
const ML = 38
const MR = 10
const MT = 10
const MB = 18
const HANDLE_PX = 42
const HIT_PX = 7
const TOUCH_HIT_PX = 22
const PHONE_MIN_W = 260
const PHONE_GUTTER = 16
const HOLD_MS = 500
const HOLD_SLOP_PX = 8
const TAP_GAP_MS = 380
const DBL_TAP_MS = 700
const TAP_NEAR_PX = 30

const WRAP_OPTIONS = [
  { value: WRAP.clampForever, label: 'Clamp' },
  { value: WRAP.loop, label: 'Loop' },
  { value: WRAP.pingPong, label: 'Ping Pong' }
]

function wrapValue(v: number): number {
  return v === WRAP.loop || v === WRAP.pingPong ? v : WRAP.clampForever
}

type Drag =
  | { kind: 'key'; index: number; dx: number; dy: number; moved: boolean }
  | { kind: 'in' | 'out'; index: number }
  | { kind: 'pan'; x: number; y: number; view: Bounds }
  | { kind: 'pinch'; a: { x: number; y: number }; b: { x: number; y: number }; view: Bounds }

type Touches = Map<number, { x: number; y: number }>

type Menu = { x: number; y: number; key: number | null; time: number; value: number }

function padded(b: Bounds): Bounds {
  const pt = (b.tMax - b.tMin) * 0.06
  const pv = (b.vMax - b.vMin) * 0.1
  return { tMin: b.tMin - pt, tMax: b.tMax + pt, vMin: b.vMin - pv, vMax: b.vMax + pv }
}

export interface CurveEditorProps {
  value: TunerCurve
  ranges?: TunerPopupRect
  color?: string
  onChange: (c: TunerCurve) => void
  onCommit?: () => void
  onCancel?: () => void
}

export function CurveEditor({ value, ranges, color, onChange, onCommit, onCancel }: CurveEditorProps) {
  const [phone] = useState(isPhoneView)
  const [width] = useState(() => (phone ? Math.round(Math.max(PHONE_MIN_W, Math.min(W, viewRect().width - PHONE_GUTTER))) : W))
  const PW = width - ML - MR
  const PH = H - MT - MB
  const touches = useRef<Touches>(new Map())
  const lastType = useRef('mouse')
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null)
  const hasRanges = !!ranges && ranges.w > 0 && ranges.h > 0
  const [curve, setCurve] = useState<TunerCurve>(() => decodeCurve(value))
  const [view, setView] = useState<Bounds>(() => padded(curveBounds(decodeCurve(value), ranges)))
  const [sel, setSel] = useState<number | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const drag = useRef<Drag | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const curveRef = useRef(curve)
  curveRef.current = curve
  const stroke = color ?? 'var(--accent)'
  const rootRef = useRef<HTMLDivElement>(null)
  useFocusOnMount(rootRef)

  const update = (next: TunerCurve, nextSel?: number | null): void => {
    curveRef.current = next
    setCurve(next)
    if (nextSel !== undefined) setSel(nextSel)
    onChange(next)
  }

  const sx = PW / (view.tMax - view.tMin)
  const sy = PH / (view.vMax - view.vMin)
  const X = (t: number): number => ML + (t - view.tMin) * sx
  const Y = (v: number): number => MT + (view.vMax - v) * sy
  const T = (x: number): number => view.tMin + (x - ML) / sx
  const V = (y: number): number => view.vMax - (y - MT) / sy

  const frame = (): void => setView(padded(curveBounds(curveRef.current, ranges)))

  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const handlePoint = (i: number, side: 'in' | 'out'): { x: number; y: number } | null => {
    const keys = curve.keys
    const k = keys[i]
    if (!k) return null
    const m = side === 'in' ? k.inTangent : k.outTangent
    if (!Number.isFinite(m)) return null
    if (side === 'in' && (i === 0 || leftMode(k) === TANGENT.constant)) return null
    if (side === 'out' && (i === keys.length - 1 || rightMode(k) === TANGENT.constant)) return null
    const weighted = side === 'in' ? (k.weightedMode & WEIGHTED.in) !== 0 : (k.weightedMode & WEIGHTED.out) !== 0
    const kx = X(k.time)
    const ky = Y(k.value)
    if (weighted) {
      const nb = keys[side === 'in' ? i - 1 : i + 1]
      const span = Math.abs(nb.time - k.time)
      const w = side === 'in' ? k.inWeight : k.outWeight
      const dt = (side === 'in' ? -1 : 1) * w * span
      return { x: X(k.time + dt), y: Y(k.value + dt * m) }
    }
    const dx = sx
    const dy = -m * sy
    const len = Math.hypot(dx, dy) || 1
    const dir = side === 'in' ? -1 : 1
    return { x: kx + (dir * dx * HANDLE_PX) / len, y: ky + (dir * dy * HANDLE_PX) / len }
  }

  const hit = (p: { x: number; y: number }, radius = HIT_PX): { kind: 'key' | 'in' | 'out'; index: number } | null => {
    if (sel !== null) {
      for (const side of ['in', 'out'] as const) {
        const h = handlePoint(sel, side)
        if (h && Math.hypot(h.x - p.x, h.y - p.y) <= radius) return { kind: side, index: sel }
      }
    }
    let best: { kind: 'key'; index: number } | null = null
    let bestD = radius
    curve.keys.forEach((k, i) => {
      const d = Math.hypot(X(k.time) - p.x, Y(k.value) - p.y)
      if (d <= bestD) {
        bestD = d
        best = { kind: 'key', index: i }
      }
    })
    return best
  }

  const openMenu = (clientX: number, clientY: number, p: { x: number; y: number }, radius: number): void => {
    const h = hit(p, radius)
    if (h?.kind === 'key') setSel(h.index)
    setMenu({ x: clientX, y: clientY, key: h?.kind === 'key' ? h.index : null, time: T(p.x), value: V(p.y) })
  }

  const stopHold = (): void => {
    if (hold.current) clearTimeout(hold.current.timer)
    hold.current = null
  }

  const addKeyAt = (p: { x: number; y: number }, radius: number): void => {
    const cur = curveRef.current
    const [t, v0] = clampToRanges(T(p.x), V(p.y), ranges)
    const onCurve = cur.keys.length > 0 ? evaluate(cur, t) : v0
    const v = Math.abs(Y(onCurve) - p.y) <= radius ? onCurve : v0
    const r = addKey(cur, t, v)
    update(r.curve, r.index)
  }

  const onTouchDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    const p = local(e)
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
    }
    touches.current.set(e.pointerId, p)
    if (touches.current.size >= 2) {
      stopHold()
      lastTap.current = null
      const [a, b] = [...touches.current.values()]
      drag.current = { kind: 'pinch', a, b, view }
      return
    }
    const clientX = e.clientX
    const clientY = e.clientY
    hold.current = {
      x: p.x,
      y: p.y,
      timer: setTimeout(() => {
        hold.current = null
        drag.current = null
        lastTap.current = null
        openMenu(clientX, clientY, p, TOUCH_HIT_PX)
      }, HOLD_MS)
    }
    const h = hit(p, TOUCH_HIT_PX)
    if (!h) {
      drag.current = null
      return
    }
    lastTap.current = null
    if (h.kind === 'key') {
      setSel(h.index)
      const k = curve.keys[h.index]
      drag.current = { kind: 'key', index: h.index, dx: X(k.time) - p.x, dy: Y(k.value) - p.y, moved: false }
    } else drag.current = { kind: h.kind, index: h.index }
  }

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    const p = local(e)
    rootRef.current?.focus({ preventScroll: true })
    lastType.current = e.pointerType
    if (e.pointerType === 'touch') {
      onTouchDown(e)
      return
    }
    if (e.button === 2) {
      e.preventDefault()
      const h = hit(p)
      if (h?.kind === 'key') setSel(h.index)
      setMenu({ x: e.clientX, y: e.clientY, key: h?.kind === 'key' ? h.index : null, time: T(p.x), value: V(p.y) })
      return
    }
    const pan = e.button === 1 || (e.button === 0 && e.altKey)
    if (pan) {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { kind: 'pan', x: p.x, y: p.y, view }
      return
    }
    if (e.button !== 0) return
    const h = hit(p)
    if (!h) {
      setSel(null)
      return
    }
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    if (h.kind === 'key') {
      setSel(h.index)
      const k = curve.keys[h.index]
      drag.current = { kind: 'key', index: h.index, dx: X(k.time) - p.x, dy: Y(k.value) - p.y, moved: false }
    } else drag.current = { kind: h.kind, index: h.index }
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
      const p = local(e)
      touches.current.set(e.pointerId, p)
      if (hold.current && Math.hypot(p.x - hold.current.x, p.y - hold.current.y) > HOLD_SLOP_PX) stopHold()
      const d = drag.current
      if (d?.kind === 'pinch' && touches.current.size >= 2) {
        const [a, b] = [...touches.current.values()]
        const v0 = d.view
        const span = (u: number, w: number): number => Math.max(Math.abs(u), 24) / Math.max(Math.abs(w), 24)
        const kx = span(d.b.x - d.a.x, b.x - a.x)
        const ky = span(d.b.y - d.a.y, b.y - a.y)
        const csx = PW / (v0.tMax - v0.tMin)
        const csy = PH / (v0.vMax - v0.vMin)
        const t0 = v0.tMin + ((d.a.x + d.b.x) / 2 - ML) / csx
        const val0 = v0.vMax - ((d.a.y + d.b.y) / 2 - MT) / csy
        const tw = (v0.tMax - v0.tMin) * kx
        const vh = (v0.vMax - v0.vMin) * ky
        const mx = ((a.x + b.x) / 2 - ML) / PW
        const my = ((a.y + b.y) / 2 - MT) / PH
        setView({ tMin: t0 - mx * tw, tMax: t0 + (1 - mx) * tw, vMin: val0 - (1 - my) * vh, vMax: val0 + my * vh })
        return
      }
      if (!d || d.kind === 'pinch' || hold.current) return
    }
    const d = drag.current
    if (!d || d.kind === 'pinch') return
    const p = local(e)
    if (d.kind === 'pan') {
      const dt = (p.x - d.x) / (PW / (d.view.tMax - d.view.tMin))
      const dv = (p.y - d.y) / (PH / (d.view.vMax - d.view.vMin))
      setView({ tMin: d.view.tMin - dt, tMax: d.view.tMax - dt, vMin: d.view.vMin + dv, vMax: d.view.vMax + dv })
      return
    }
    const cur = curveRef.current
    if (d.kind === 'key') {
      const [t, v] = clampToRanges(T(p.x + d.dx), V(p.y + d.dy), ranges)
      const r = moveKey(cur, d.index, t, v)
      d.index = r.index
      d.moved = true
      update(r.curve, r.index)
      return
    }
    const k = cur.keys[d.index]
    if (!k) return
    update(dragTangent(cur, d.index, d.kind, T(p.x) - k.time, V(p.y) - k.value))
  }

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (lastType.current === 'touch') {
      const prev = lastTap.current
      const p = local(e)
      lastTap.current = null
      if (prev && performance.now() - prev.t <= DBL_TAP_MS && Math.hypot(p.x - prev.x, p.y - prev.y) <= TAP_NEAR_PX) addKeyAt(p, TOUCH_HIT_PX)
      return
    }
    if (e.button !== 0 || e.altKey) return
    const p = local(e)
    if (hit(p)) return
    addKeyAt(p, HIT_PX)
  }

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
      const p = local(e)
      const tapped = hold.current !== null && touches.current.size === 1 && e.type === 'pointerup'
      stopHold()
      touches.current.delete(e.pointerId)
      if (drag.current?.kind === 'pinch') {
        if (touches.current.size === 0) drag.current = null
        return
      }
      if (tapped && !drag.current) {
        const now = performance.now()
        const prev = lastTap.current
        if (prev && now - prev.t <= TAP_GAP_MS && Math.hypot(p.x - prev.x, p.y - prev.y) <= TAP_NEAR_PX) {
          lastTap.current = null
          addKeyAt(p, TOUCH_HIT_PX)
        } else {
          lastTap.current = { t: now, x: p.x, y: p.y }
          setSel(null)
        }
      }
    }
    if (!drag.current) return
    drag.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
    }
  }

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      const k = Math.exp(e.deltaY * 0.0015)
      setView((vw) => {
        const csx = (width - ML - MR) / (vw.tMax - vw.tMin)
        const csy = (H - MT - MB) / (vw.vMax - vw.vMin)
        const t = vw.tMin + (x - ML) / csx
        const v = vw.vMax - (y - MT) / csy
        const kx = e.altKey ? 1 : k
        const ky = e.shiftKey ? 1 : k
        return { tMin: t - (t - vw.tMin) * kx, tMax: t + (vw.tMax - t) * kx, vMin: v - (v - vw.vMin) * ky, vMax: v + (vw.vMax - v) * ky }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.setAttribute('data-drift-wheel', '')
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel !== null) {
      e.preventDefault()
      update(removeKey(curveRef.current, sel), null)
    } else if (e.key === 'f' || e.key === 'F' || e.key === 'a' || e.key === 'A') {
      e.preventDefault()
      frame()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel?.()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onCommit?.()
    }
  }

  const gridX = niceStep(view.tMax - view.tMin, PW, 56)
  const gridY = niceStep(view.vMax - view.vMin, PH, 32)
  const xs: number[] = []
  for (let t = Math.ceil(view.tMin / gridX) * gridX; t <= view.tMax; t += gridX) xs.push(t)
  const ys: number[] = []
  for (let v = Math.ceil(view.vMin / gridY) * gridY; v <= view.vMax; v += gridY) ys.push(v)
  const digitsX = Math.max(0, -Math.floor(Math.log10(gridX)))
  const digitsY = Math.max(0, -Math.floor(Math.log10(gridY)))

  const paths = useMemo(() => {
    const keys = curve.keys
    if (keys.length === 0) return { main: '', pre: '', post: '' }
    if (keys.length === 1) {
      const y = Y(keys[0].value)
      return { main: '', pre: `M ${ML} ${y} H ${X(keys[0].time)}`, post: `M ${X(keys[0].time)} ${y} H ${ML + PW}` }
    }
    let main = `M ${X(keys[0].time)} ${Y(keys[0].value)}`
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i]
      const b = keys[i + 1]
      if (isStep(a, b)) main += ` H ${X(b.time)} V ${Y(b.value)}`
      else {
        const [, , x1, y1, x2, y2, x3, y3] = segmentControls(a, b)
        main += ` C ${X(x1)} ${Y(y1)} ${X(x2)} ${Y(y2)} ${X(x3)} ${Y(y3)}`
      }
    }
    const sample = (from: number, to: number): string => {
      if (to <= from) return ''
      const pts: string[] = []
      const steps = Math.max(2, Math.ceil(((to - from) * sx) / 3))
      for (let s = 0; s <= steps; s++) {
        const t = from + ((to - from) * s) / steps
        pts.push(`${X(t).toFixed(1)} ${Y(evaluate(curve, t)).toFixed(1)}`)
      }
      return `M ${pts.join(' L ')}`
    }
    return { main, pre: sample(view.tMin, keys[0].time), post: sample(keys[keys.length - 1].time, view.tMax) }
  }, [curve, view])

  const selKey = sel !== null ? curve.keys[sel] : undefined
  const presets = useMemo(() => curvePresets(hasRanges ? ranges!.y < 0 : false), [hasRanges, ranges])

  const menuData: TunerMenuData | null = menu
    ? menu.key === null
      ? { options: ['Add Key'], enabled: [true], separator: [false], selected: [] }
      : (() => {
          const k = curve.keys[menu.key!]
          const on = k ? tangentState(k) : null
          return {
            options: KEY_MENU.map((m) => m.label),
            enabled: KEY_MENU.map((m) => m.action !== null),
            separator: KEY_MENU.map((m) => m.action === null),
            selected: KEY_MENU.flatMap((m, i) => (on && m.action && m.action !== 'delete' && on[m.action] ? [i] : []))
          }
        })()
    : null

  const pickMenu = (i: number): void => {
    const m = menu
    setMenu(null)
    if (!m) return
    if (m.key === null) {
      const [t] = clampToRanges(m.time, m.value, ranges)
      const r = addKey(curveRef.current, t, curveRef.current.keys.length > 0 ? evaluate(curveRef.current, t) : m.value)
      update(r.curve, r.index)
      return
    }
    const action = KEY_MENU[i]?.action
    if (!action) return
    if (action === 'delete') update(removeKey(curveRef.current, m.key), null)
    else update(applyTangentAction(curveRef.current, m.key, action))
  }

  const rangeRect = hasRanges ? { x: X(ranges!.x), y: Y(ranges!.y + ranges!.h), w: ranges!.w * sx, h: ranges!.h * sy } : null

  return (
    <div ref={rootRef} tabIndex={-1} data-popup-focus className="flex flex-col outline-none" style={{ width }} data-curve-editor onKeyDown={onKeyDown}>
      <div className="flex items-center gap-1.5 border-b border-white/5 px-2 py-1.5">
        <MenuButton label="Pre wrap" options={WRAP_OPTIONS} value={wrapValue(curve.preWrapMode)} onChange={(v) => update({ ...curveRef.current, preWrapMode: v })} className="w-[86px]" />
        <span className="flex-1 truncate text-center text-[11px] text-ink-3">
          {curve.keys.length} {curve.keys.length === 1 ? 'key' : 'keys'}
        </span>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Frame all"
          data-ti-tip="Frame all (F)"
          data-curve-frame
          onPointerDown={(e) => e.preventDefault()}
          onClick={frame}
          className="flex h-5 w-5 items-center justify-center rounded text-ink-3 hover:bg-white/10 hover:text-ink"
        >
          <Maximize2 className="h-3 w-3" />
        </button>
        <MenuButton label="Post wrap" options={WRAP_OPTIONS} value={wrapValue(curve.postWrapMode)} onChange={(v) => update({ ...curveRef.current, postWrapMode: v })} className="w-[86px]" />
      </div>
      <svg
        ref={svgRef}
        width={width}
        height={H}
        data-curve-canvas
        className="block cursor-default touch-none select-none outline-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        <rect x={ML} y={MT} width={PW} height={PH} style={{ fill: 'var(--sunken)' }} />
        {rangeRect && (
          <>
            <rect x={ML} y={MT} width={PW} height={PH} style={{ fill: 'var(--canvas)', opacity: 0.55 }} />
            <rect x={rangeRect.x} y={rangeRect.y} width={rangeRect.w} height={rangeRect.h} style={{ fill: 'var(--sunken)', stroke: 'var(--strong)' }} />
          </>
        )}
        <g style={{ stroke: 'var(--hairline)' }} shapeRendering="crispEdges">
          {xs.map((t) => (
            <line key={`x${t}`} x1={X(t)} x2={X(t)} y1={MT} y2={MT + PH} style={Math.abs(t) < gridX / 1000 ? { stroke: 'var(--strong)' } : undefined} />
          ))}
          {ys.map((v) => (
            <line key={`y${v}`} x1={ML} x2={ML + PW} y1={Y(v)} y2={Y(v)} style={Math.abs(v) < gridY / 1000 ? { stroke: 'var(--strong)' } : undefined} />
          ))}
        </g>
        <g className="fill-ink-4 text-[9px] tabular-nums">
          {xs.map((t) => (
            <text key={`tx${t}`} x={X(t)} y={H - 5} textAnchor="middle">
              {fmtNum(t, digitsX)}
            </text>
          ))}
          {ys.map((v) => (
            <text key={`ty${v}`} x={ML - 4} y={Y(v) + 3} textAnchor="end">
              {fmtNum(v, digitsY)}
            </text>
          ))}
        </g>
        <svg x={ML} y={MT} width={PW} height={PH} viewBox={`${ML} ${MT} ${PW} ${PH}`} overflow="hidden">
          <path d={paths.pre} fill="none" style={{ stroke }} strokeWidth={1.5} strokeDasharray="4 3" opacity={0.45} />
          <path d={paths.post} fill="none" style={{ stroke }} strokeWidth={1.5} strokeDasharray="4 3" opacity={0.45} />
          <path d={paths.main} fill="none" style={{ stroke }} strokeWidth={1.75} data-curve-path />
          {sel !== null &&
            (['in', 'out'] as const).map((side) => {
              const h = handlePoint(sel, side)
              const k = curve.keys[sel]
              if (!h || !k) return null
              return (
                <g key={side} data-curve-handle={side}>
                  <line x1={X(k.time)} y1={Y(k.value)} x2={h.x} y2={h.y} style={{ stroke: 'var(--ink-3)' }} strokeWidth={1} />
                  <circle cx={h.x} cy={h.y} r={3.5} style={{ fill: 'var(--panel)', stroke: 'var(--ink-2)' }} strokeWidth={1.25} />
                </g>
              )
            })}
          {curve.keys.map((k, i) => (
            <rect
              key={i}
              data-curve-key={i}
              data-curve-time={k.time}
              data-curve-value={k.value}
              x={X(k.time) - (sel === i ? 4.5 : 3.5)}
              y={Y(k.value) - (sel === i ? 4.5 : 3.5)}
              width={sel === i ? 9 : 7}
              height={sel === i ? 9 : 7}
              transform={`rotate(45 ${X(k.time)} ${Y(k.value)})`}
              style={{ fill: sel === i ? 'var(--accent)' : 'var(--ink)', stroke: 'var(--canvas)' }}
              strokeWidth={1}
            />
          ))}
        </svg>
      </svg>
      <div className="flex h-7 items-center gap-1.5 border-t border-white/5 px-2 text-[10px] text-ink-3">
        {selKey ? (
          <>
            <span>Time</span>
            <NumField
              name="time"
              label="Time"
              value={selKey.time}
              digits={4}
              className="w-16"
              onChange={(t) => {
                const [ct, cv] = clampToRanges(t, selKey.value, ranges)
                const r = moveKey(curveRef.current, sel!, ct, cv)
                update(r.curve, r.index)
              }}
            />
            <span>Value</span>
            <NumField
              name="value"
              label="Value"
              value={selKey.value}
              digits={4}
              className="w-16"
              onChange={(v) => {
                const [ct, cv] = clampToRanges(selKey.time, v, ranges)
                const r = moveKey(curveRef.current, sel!, ct, cv)
                update(r.curve, r.index)
              }}
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label="Delete key"
              data-ti-tip="Delete key"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => update(removeKey(curveRef.current, sel!), null)}
              className="ml-auto flex h-5 w-5 items-center justify-center rounded text-ink-3 hover:bg-white/10 hover:text-ink"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </>
        ) : (
          <span className="text-ink-4">
            {phone
              ? 'Double-tap to add a key. Hold a key to change its tangents. Pinch to zoom, drag with two fingers to pan.'
              : 'Double-click to add a key. Right-click a key to change its tangents. Alt-drag or middle-drag to pan.'}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 border-t border-white/5 px-2 py-1.5" data-curve-presets>
        {presets.map((p) => (
          <PresetSwatch key={p.name} name={p.name} keys={p.keys} stroke={stroke} onPick={() => update(applyPreset(curveRef.current, p, hasRanges ? ranges : undefined), null)} />
        ))}
      </div>
      {menu && menuData && (
        <PopupMenu
          data={menuData}
          getAnchor={() => ({ left: menu.x, top: menu.y, width: 0, height: 0 })}
          onPick={pickMenu}
          onCancel={() => setMenu(null)}
        />
      )}
    </div>
  )
}

function PresetSwatch({ name, keys, stroke, onPick }: { name: string; keys: TunerCurve['keys']; stroke: string; onPick: () => void }) {
  const d = useMemo(() => {
    const c: TunerCurve = { keys, preWrapMode: WRAP.clampForever, postWrapMode: WRAP.clampForever }
    const pts: string[] = []
    for (let i = 0; i <= 20; i++) {
      const t = i / 20
      pts.push(`${(2 + t * 36).toFixed(1)} ${(20 - evaluate(c, t) * 16).toFixed(1)}`)
    }
    return `M ${pts.join(' L ')}`
  }, [keys])
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={name}
      data-ti-tip={name}
      data-curve-preset={name}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onPick}
      className="rounded bg-sunken ring-1 ring-inset ring-white/10 hover:ring-accent"
    >
      <svg width={40} height={24}>
        <path d={d} fill="none" style={{ stroke }} strokeWidth={1.25} />
      </svg>
    </button>
  )
}
