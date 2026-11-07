import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { TANGENT, WEIGHTED, WRAP, type TunerCurve, type TunerMenuData } from '@shared/tuner-inspector-popups'
import type { TiPsCurves, TiPsCurvesCommand, TunerInspectorInput } from '@shared/tuner-inspector'
import { addKey, applyTangentAction, dragTangent, encodeCurve, evaluate, isStep, KEY_MENU, leftMode, rightMode, segmentControls, tangentState } from './popups/curve-math'
import { PopupMenu } from './popups/PopupMenu'
import { fieldCls, fmtNum } from './popups/controls'
import { cssColor, parseHex, type Rgba } from '../../../lib/tuner/inspector/model'
import {
  axisScalarFor,
  boundsOf,
  clamp,
  curveOf,
  decimalsFor,
  deleteKeys,
  enforceView,
  flatSel,
  fmtAxis,
  frameBox,
  labelPeriod,
  moveKeys,
  orderedItems,
  pairSel,
  panView,
  PSC_MARGIN,
  regionContains,
  samplesBetween,
  sameSel,
  scaleAbout,
  scaled,
  shiftCurve,
  shiftRange,
  tickLevels,
  towardWhite,
  transformKeys,
  zoomView,
  type PsItem,
  type PsSel,
  type View
} from './particle-curves-math'

const PICK = 7
const CURVE_PICK = 6
const TOUCH_PICK = 20
const TOUCH_CURVE_PICK = 14
const TOUCH_DOUBLE_PX = 30
const HOLD_MS = 500
const HOLD_SLOP_PX = 8
const HANDLE_PX = 42
const HIT_TOP = 22
const WRAP_ICON = 14
const DOUBLE_MS = 500
const TOUCH_DOUBLE_MS = 800
const RECT_HANDLE = 17
const RECT_MIN_W = 14
const RECT_MIN_H = 15
const RECT_BAR = 15

const KEY_MENU_PS = [{ label: 'Delete Key', action: 'delete' as const }, { label: 'Edit Key...', action: 'edit' as const }, ...KEY_MENU.slice(1)]

const WRAP_MENU = [
  { label: 'Clamp', value: WRAP.clampForever },
  { label: 'Loop', value: WRAP.loop },
  { label: 'Ping Pong', value: WRAP.pingPong }
]

type Pt = { x: number; y: number }

type Rect = { x: number; y: number; w: number; h: number }

type Side = 'left' | 'right' | 'top' | 'bottom'

type Gesture =
  | { kind: 'keys'; start: Pt; base: Map<number, TunerCurve>; sel: PsSel; moved: boolean; box?: boolean }
  | { kind: 'scale'; side: Side; pivot: number; picked: number; offset: number; base: Map<number, TunerCurve>; sel: PsSel; moved: boolean }
  | { kind: 'pan'; last: Pt }
  | { kind: 'zoom'; last: Pt; ft: number; fv: number }
  | { kind: 'tangent'; id: number; key: number; side: 'in' | 'out'; base: TunerCurve; moved: boolean }
  | { kind: 'curve'; start: Pt; base: Map<number, TunerCurve>; moved: boolean }
  | { kind: 'marquee'; start: Pt; cur: Pt; add: boolean; base: PsSel }
  | { kind: 'scrub'; last: Pt; value: number; ids: number[]; moved: boolean }

type Menu = { x: number; y: number; kind: 'key' | 'curve' | 'wrap'; id: number; key: number; time: number; side?: 'pre' | 'post' }

type KeyEdit = { id: number; key: number; x: number; y: number; time: string; value: string }

interface Props {
  section: string
  psc: TiPsCurves
  send: (input: TunerInspectorInput) => Promise<void>
}

function rgba(hex: string): Rgba {
  return parseHex(hex) ?? { r: 1, g: 1, b: 1, a: 1 }
}

function defaultView(vmin: number): View {
  return { t0: 0, t1: 1, v0: vmin, v1: 1 }
}

export function ParticleCurves({ section, psc, send }: Props) {
  const [local, setLocal] = useState<Map<number, TunerCurve>>(() => new Map())
  const [sel, setSel] = useState<PsSel>(() => pairSel(psc.sel))
  const [front, setFront] = useState<number | null>(null)
  const [marquee, setMarquee] = useState<{ a: Pt; b: Pt } | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [edit, setEdit] = useState<KeyEdit | null>(null)
  const [axisDraft, setAxisDraft] = useState<string | null>(null)
  const [view, setView] = useState<View>(() => defaultView(psc.vmin < 0 ? -1 : 0))
  const [moveLabel, setMoveLabel] = useState<Pt | null>(null)
  const [cursor, setCursor] = useState<CSSProperties['cursor']>('default')
  const rootRef = useRef<HTMLDivElement>(null)
  const hitRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const net = useRef<{ inflight: number; queue: TiPsCurvesCommand[] }>({ inflight: 0, queue: [] })
  const lastDown = useRef<{ t: number; x: number; y: number } | null>(null)
  const touchInput = useRef(false)
  const touchPts = useRef(new Map<number, Pt>())
  const pinch = useRef<{ d: number; mid: Pt } | null>(null)
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; at: Pt } | null>(null)
  const state = useRef({ local, sel, front, view })
  state.current = { local, sel, front, view }

  const w = psc.w
  const h = psc.h
  const vmin = psc.vmin < 0 ? -1 : 0
  const pw = Math.max(1, w - PSC_MARGIN.left - PSC_MARGIN.right)
  const ph = Math.max(1, h - PSC_MARGIN.top - PSC_MARGIN.bottom)
  const vw = view.t1 - view.t0
  const vh = view.v1 - view.v0
  const X = (t: number): number => PSC_MARGIN.left + ((t - view.t0) / vw) * pw
  const Y = (v: number): number => PSC_MARGIN.top + ((view.v1 - v) / vh) * ph
  const T = (x: number): number => view.t0 + ((x - PSC_MARGIN.left) / pw) * vw
  const V = (y: number): number => view.v1 - ((y - PSC_MARGIN.top) / ph) * vh

  useEffect(() => {
    setView((v) => enforceView({ ...v, v0: vmin, v1: 1 }, vmin))
  }, [vmin])

  const items = useMemo(() => orderedItems(psc, front), [psc, front])
  const top = items[items.length - 1]

  useEffect(() => {
    if (gesture.current || net.current.inflight > 0 || net.current.queue.length > 0) return
    setLocal(new Map())
    setFront(null)
    setSel((s) => {
      const next = pairSel(psc.sel)
      return sameSel(s, next) ? s : next
    })
  }, [psc])

  const flush = (): void => {
    const n = net.current
    if (n.inflight > 0 || n.queue.length === 0) return
    const cmd = n.queue.shift()!
    n.inflight++
    void send({ op: 'psCurves', section, data: cmd }).finally(() => {
      n.inflight--
      flush()
    })
  }

  const queue = (cmd: TiPsCurvesCommand): void => {
    const q = net.current.queue
    const last = q[q.length - 1]
    if (last && last.cmd === 'set' && cmd.cmd === 'set') {
      const merged = new Map(last.curves.map((c) => [c.id, c]))
      for (const c of cmd.curves) merged.set(c.id, c)
      q[q.length - 1] = { ...cmd, begin: last.begin || cmd.begin, front: cmd.front ?? last.front, curves: [...merged.values()] }
    } else if (last && last.cmd === 'select' && cmd.cmd === 'select') q[q.length - 1] = cmd
    else if (last && last.cmd === 'set' && cmd.cmd === 'select') q[q.length - 1] = { ...last, front: cmd.front ?? last.front, hasSel: cmd.hasSel ?? last.hasSel, sel: cmd.sel ?? last.sel }
    else if (last && last.cmd === 'scalar' && cmd.cmd === 'scalar' && !cmd.begin) q[q.length - 1] = { ...cmd, begin: last.begin }
    else q.push(cmd)
    flush()
  }

  const curveFor = (id: number): TunerCurve | null => {
    for (const it of items) if (it.ids.includes(id)) return curveOf(it, id, state.current.local)
    return null
  }

  const pushCurves = (changed: Map<number, TunerCurve>, nextSel: PsSel, begin: boolean, frontId?: number): void => {
    const nextLocal = new Map(state.current.local)
    for (const [id, c] of changed) nextLocal.set(id, c)
    state.current.local = nextLocal
    setLocal(nextLocal)
    setSel(nextSel)
    state.current.sel = nextSel
    if (frontId !== undefined) setFront(frontId)
    queue({
      cmd: 'set',
      begin,
      curves: [...changed].map(([id, c]) => ({ id, curve: encodeCurve(c) })),
      front: frontId,
      hasSel: true,
      sel: flatSel(nextSel)
    })
  }

  const select = (nextSel: PsSel, frontId?: number): void => {
    setSel(nextSel)
    state.current.sel = nextSel
    if (frontId !== undefined) setFront(frontId)
    queue({ cmd: 'select', front: frontId, hasSel: true, sel: flatSel(nextSel) })
  }

  const isSelected = (id: number, key: number): boolean => sel.some(([a, b]) => a === id && b === key)

  const local2 = (e: { clientX: number; clientY: number }): Pt => {
    const el = rootRef.current!
    const r = el.getBoundingClientRect()
    const k = el.offsetWidth > 0 && Math.abs(r.width / el.offsetWidth - 1) > 0.02 ? r.width / el.offsetWidth : 1
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
  }

  const pick = (): number => (touchInput.current ? TOUCH_PICK : PICK)

  const handlePoint = (id: number, key: number, side: 'in' | 'out'): Pt | null => {
    const c = curveFor(id)
    const k = c?.keys[key]
    if (!c || !k) return null
    const m = side === 'in' ? k.inTangent : k.outTangent
    if (!Number.isFinite(m)) return null
    if (side === 'in' && (key === 0 || leftMode(k) === TANGENT.constant || leftMode(k) === TANGENT.linear)) return null
    if (side === 'out' && (key === c.keys.length - 1 || rightMode(k) === TANGENT.constant || rightMode(k) === TANGENT.linear)) return null
    const weighted = side === 'in' ? (k.weightedMode & WEIGHTED.in) !== 0 : (k.weightedMode & WEIGHTED.out) !== 0
    if (weighted) {
      const nb = c.keys[side === 'in' ? key - 1 : key + 1]
      const span = Math.abs(nb.time - k.time)
      const wt = side === 'in' ? k.inWeight : k.outWeight
      const dt = (side === 'in' ? -1 : 1) * wt * span
      return { x: X(k.time + dt), y: Y(k.value + dt * m) }
    }
    const dx = pw / vw
    const dy = (-m * ph) / vh
    const len = Math.hypot(dx, dy) || 1
    const dir = side === 'in' ? -1 : 1
    return { x: X(k.time) + (dir * dx * HANDLE_PX) / len, y: Y(k.value) + (dir * dy * HANDLE_PX) / len }
  }

  const hitHandle = (p: Pt): { id: number; key: number; side: 'in' | 'out' } | null => {
    for (const [id, key] of sel)
      for (const side of ['in', 'out'] as const) {
        const hp = handlePoint(id, key, side)
        if (hp && Math.hypot(hp.x - p.x, hp.y - p.y) <= pick()) return { id, key, side }
      }
    return null
  }

  const hitKey = (p: Pt): [number, number] | null => {
    for (let i = items.length - 1; i >= 0; i--) {
      let best: [number, number] | null = null
      let bestD = pick()
      for (const id of items[i].ids) {
        const keys = curveOf(items[i], id, local)?.keys ?? []
        for (let ki = 0; ki < keys.length; ki++) {
          const d = Math.hypot(X(keys[ki].time) - p.x, Y(keys[ki].value) - p.y)
          if (d < bestD) {
            bestD = d
            best = [id, ki]
          }
        }
      }
      if (best) return best
    }
    return null
  }

  const hitCurve = (p: Pt): { item: PsItem; id: number | null } | null => {
    const t = T(p.x)
    if (t < 0 || t > 1) return null
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      for (const id of it.ids) {
        const c = curveOf(it, id, local)
        if (c && c.keys.length > 0 && Math.abs(Y(evaluate(c, t)) - p.y) <= (touchInput.current ? TOUCH_CURVE_PICK : CURVE_PICK)) return { item: it, id }
      }
      if (it.ids.length === 2) {
        const a = curveOf(it, it.ids[0], local)
        const b = curveOf(it, it.ids[1], local)
        if (a && b && regionContains(a, b, t, V(p.y))) return { item: it, id: null }
      }
    }
    return null
  }

  const finishGesture = (): void => {
    gesture.current = null
    setMarquee(null)
    setMoveLabel(null)
  }

  const keysInRect = (a: Pt, b: Pt): PsSel => {
    const x0 = Math.min(a.x, b.x)
    const x1 = Math.max(a.x, b.x)
    const y0 = Math.min(a.y, b.y)
    const y1 = Math.max(a.y, b.y)
    const out: PsSel = []
    for (const it of items)
      for (const id of it.ids)
        curveOf(it, id, local)?.keys.forEach((k, ki) => {
          const x = X(k.time)
          const y = Y(k.value)
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push([id, ki])
        })
    return out
  }

  const createKeyAt = (p: Pt): void => {
    const editable = items.flatMap((it) => it.ids)
    const t = clamp(T(p.x), 0, 1)
    if (editable.length === 1) {
      const id = editable[0]
      const c = curveFor(id)
      if (c && (c.keys.length === 0 || t < c.keys[0].time || t > c.keys[c.keys.length - 1].time)) {
        const r = addKey(c, t, clamp(V(p.y), vmin, 1))
        pushCurves(new Map([[id, r.curve]]), [[id, r.index]], true, id)
        return
      }
    }
    const hit = hitCurve(p)
    if (!hit || hit.id === null) return
    const c = curveFor(hit.id)
    if (!c) return
    const r = addKey(c, t, clamp(evaluate(c, t), vmin, 1))
    pushCurves(new Map([[hit.id, r.curve]]), [[hit.id, r.index]], true, hit.id)
  }

  const selectedKeys = (): [number, number][] => {
    const out: [number, number][] = []
    for (const [id, key] of sel) {
      const k = curveFor(id)?.keys[key]
      if (k) out.push([k.time, k.value])
    }
    return out
  }

  const rectTool = (): { box: Rect; handles: { side: Side; r: Rect }[]; bounds: { t0: number; t1: number; v0: number; v1: number } } | null => {
    const g = gesture.current
    if (g?.kind === 'curve' && g.moved) return null
    const b = boundsOf(selectedKeys())
    if (!b) return null
    const canX = b.t1 - b.t0 > 1e-6
    const canY = b.v1 - b.v0 > 1e-6
    const box = { x: X(b.t0), y: Y(b.v1), w: X(b.t1) - X(b.t0), h: Y(b.v0) - Y(b.v1) }
    if (box.w - RECT_BAR * 2 < RECT_MIN_W && box.w < RECT_MIN_W) {
      box.x = box.x + box.w / 2 - RECT_MIN_W / 2
      box.w = RECT_MIN_W
    }
    if (box.h - RECT_BAR * 2 < RECT_MIN_H && box.h < RECT_MIN_H) {
      box.y = box.y + box.h / 2 - RECT_MIN_H / 2
      box.h = RECT_MIN_H
    }
    const handles: { side: Side; r: Rect }[] = []
    if (canX) {
      handles.push({ side: 'left', r: { x: box.x - RECT_HANDLE, y: box.y + box.h * 0.1, w: RECT_HANDLE, h: box.h * 0.8 } })
      handles.push({ side: 'right', r: { x: box.x + box.w, y: box.y + box.h * 0.1, w: RECT_HANDLE, h: box.h * 0.8 } })
    }
    if (canY) {
      handles.push({ side: 'top', r: { x: box.x + box.w * 0.1, y: box.y - RECT_HANDLE, w: box.w * 0.8, h: RECT_HANDLE } })
      handles.push({ side: 'bottom', r: { x: box.x + box.w * 0.1, y: box.y + box.h, w: box.w * 0.8, h: RECT_HANDLE } })
    }
    return { box, handles, bounds: b }
  }

  const inRect = (r: Rect, p: Pt): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

  const selBase = (): Map<number, TunerCurve> => {
    const base = new Map<number, TunerCurve>()
    for (const [id] of sel) {
      const c = curveFor(id)
      if (c) base.set(id, c)
    }
    return base
  }

  const frame = (): void => {
    const pts: [number, number][] = []
    if (sel.length === 0) {
      for (const it of items)
        for (const id of it.ids) {
          const c = curveOf(it, id, local)
          if (!c || !c.keys.length) continue
          for (const k of c.keys) pts.push([k.time, k.value])
          pts.push(...samplesBetween(c, c.keys[0].time, c.keys[c.keys.length - 1].time))
        }
    } else if (sel.length === 1) {
      const [id, key] = sel[0]
      const c = curveFor(id)
      if (c?.keys[key]) {
        const lo = c.keys[Math.max(0, key - 1)]
        const hi = c.keys[Math.min(c.keys.length - 1, key + 1)]
        pts.push([c.keys[key].time, c.keys[key].value], [lo.time, lo.value], [hi.time, hi.value], ...samplesBetween(c, lo.time, hi.time))
      }
    } else {
      for (const id of new Set(sel.map(([a]) => a))) {
        const c = curveFor(id)
        if (!c) continue
        const ks = sel.filter(([a]) => a === id).map(([, b]) => c.keys[b]).filter(Boolean)
        for (const k of ks) pts.push([k.time, k.value])
        if (ks.length > 1) pts.push(...samplesBetween(c, Math.min(...ks.map((k) => k.time)), Math.max(...ks.map((k) => k.time))))
      }
    }
    const v = frameBox(boundsOf(pts))
    if (v) setView(enforceView(v, vmin))
  }

  const menuAt = (clientX: number, clientY: number, p: Pt): void => {
    const k = hitKey(p)
    if (k) {
      if (!isSelected(k[0], k[1])) select([k], k[0])
      setMenu({ x: clientX, y: clientY, kind: 'key', id: k[0], key: k[1], time: 0 })
      return
    }
    const c = hitCurve(p)
    if (c && c.id !== null) setMenu({ x: clientX, y: clientY, kind: 'curve', id: c.id, key: -1, time: clamp(T(p.x), 0, 1) })
  }

  const stopHold = (): void => {
    if (hold.current) clearTimeout(hold.current.timer)
    hold.current = null
  }

  const spread = (): { d: number; mid: Pt } | null => {
    const [a, b] = [...touchPts.current.values()]
    if (!a || !b) return null
    return { d: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
  }

  const doubleAt = (p: Pt, shift: boolean): void => {
    const k = hitKey(p)
    if (k) {
      const c = curveFor(k[0])
      const all: PsSel = (c?.keys ?? []).map((_, i) => [k[0], i])
      const merged = shift ? [...sel.filter(([id]) => id !== k[0]), ...all] : all
      select(merged, k[0])
    } else createKeyAt(p)
  }

  const onDoubleTap = (e: React.MouseEvent<HTMLDivElement>): void => {
    const prev = lastDown.current
    if (!touchInput.current || !prev) return
    const p = local2(e)
    if (e.timeStamp - prev.t > TOUCH_DOUBLE_MS || Math.hypot(prev.x - p.x, prev.y - p.y) > TOUCH_DOUBLE_PX) return
    lastDown.current = null
    doubleAt(p, e.shiftKey)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.stopPropagation()
    if (edit) setEdit(null)
    const p = local2(e)
    hitRef.current?.focus({ preventScroll: true })
    touchInput.current = e.pointerType === 'touch'
    if (e.pointerType === 'touch') {
      touchPts.current.set(e.pointerId, p)
      if (touchPts.current.size >= 2) {
        stopHold()
        gesture.current = null
        setMarquee(null)
        lastDown.current = null
        pinch.current = spread()
        return
      }
      const clientX = e.clientX
      const clientY = e.clientY
      hold.current = {
        at: p,
        timer: setTimeout(() => {
          hold.current = null
          finishGesture()
          lastDown.current = null
          menuAt(clientX, clientY, p)
        }, HOLD_MS)
      }
    }
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      gesture.current = { kind: 'pan', last: p }
      return
    }
    if (e.button === 2 && e.altKey) {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      gesture.current = { kind: 'zoom', last: p, ft: T(p.x), fv: V(p.y) }
      return
    }
    if (e.button === 2) {
      e.preventDefault()
      menuAt(e.clientX, e.clientY, p)
      return
    }
    if (e.button !== 0) return
    const prev = lastDown.current
    const dbl = !!prev && e.timeStamp - prev.t < DOUBLE_MS && Math.hypot(prev.x - p.x, prev.y - p.y) <= (touchInput.current ? TOUCH_DOUBLE_PX : 4)
    lastDown.current = dbl ? null : { t: e.timeStamp, x: p.x, y: p.y }
    const hh0 = hitHandle(p)
    if (hh0) {
      const base = curveFor(hh0.id)
      e.currentTarget.setPointerCapture(e.pointerId)
      if (base) gesture.current = { kind: 'tangent', id: hh0.id, key: hh0.key, side: hh0.side, base, moved: false }
      return
    }
    const rt = rectTool()
    if (rt) {
      const hit = rt.handles.find((hd) => inRect(hd.r, p))
      if (hit) {
        e.currentTarget.setPointerCapture(e.pointerId)
        const b = rt.bounds
        const horiz = hit.side === 'left' || hit.side === 'right'
        const pivot = hit.side === 'left' ? b.t1 : hit.side === 'right' ? b.t0 : hit.side === 'top' ? b.v0 : b.v1
        const picked = hit.side === 'left' ? b.t0 : hit.side === 'right' ? b.t1 : hit.side === 'top' ? b.v1 : b.v0
        const offset = (horiz ? T(p.x) : V(p.y)) - picked
        gesture.current = { kind: 'scale', side: hit.side, pivot, picked, offset, base: selBase(), sel, moved: false }
        return
      }
      if (!e.shiftKey && !(e.metaKey || e.ctrlKey) && inRect(rt.box, p)) {
        e.currentTarget.setPointerCapture(e.pointerId)
        gesture.current = { kind: 'keys', start: p, base: selBase(), sel, moved: false, box: true }
        return
      }
    }
    if (dbl) {
      doubleAt(p, e.shiftKey)
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    const k = hitKey(p)
    if (k) {
      let nextSel: PsSel
      if (e.shiftKey) nextSel = isSelected(k[0], k[1]) ? sel : [...sel, k]
      else if (e.metaKey || e.ctrlKey) nextSel = isSelected(k[0], k[1]) ? sel.filter(([a, b]) => a !== k[0] || b !== k[1]) : [...sel, k]
      else nextSel = isSelected(k[0], k[1]) ? sel : [k]
      select(nextSel, k[0])
      const base = new Map<number, TunerCurve>()
      for (const [id] of nextSel) {
        const c = curveFor(id)
        if (c) base.set(id, c)
      }
      gesture.current = { kind: 'keys', start: p, base, sel: nextSel, moved: false }
      return
    }
    const c = hitCurve(p)
    if (c) {
      const frontId = c.item.data.id
      if (!e.shiftKey && sel.length) select([], frontId)
      else select(sel, frontId)
      const base = new Map<number, TunerCurve>()
      for (const id of c.id !== null ? [c.id] : c.item.ids) {
        const cc = curveOf(c.item, id, local)
        if (cc) base.set(id, cc)
      }
      gesture.current = { kind: 'curve', start: p, base, moved: false }
      return
    }
    if (!e.shiftKey && sel.length) select([])
    gesture.current = { kind: 'marquee', start: p, cur: p, add: e.shiftKey, base: e.shiftKey ? sel : [] }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.stopPropagation()
    if (e.pointerType === 'touch' && touchPts.current.has(e.pointerId)) {
      touchPts.current.set(e.pointerId, local2(e))
      const pn = pinch.current
      const now = spread()
      if (pn && now) {
        pinch.current = now
        const g = geo.current
        setView((v) => {
          const ft = v.t0 + ((now.mid.x - PSC_MARGIN.left) / g.pw) * (v.t1 - v.t0)
          const fv = v.v1 - ((now.mid.y - PSC_MARGIN.top) / g.ph) * (v.v1 - v.v0)
          const z = zoomView(v, ft, fv, now.d / pn.d, false, false, g.vmin)
          return panView(z, (-(now.mid.x - pn.mid.x) / g.pw) * (z.t1 - z.t0), ((now.mid.y - pn.mid.y) / g.ph) * (z.v1 - z.v0), g.vmin)
        })
        return
      }
      if (pn) return
      const h = hold.current
      if (h) {
        const p0 = local2(e)
        if (Math.hypot(p0.x - h.at.x, p0.y - h.at.y) <= HOLD_SLOP_PX) return
        stopHold()
      }
    }
    const g = gesture.current
    const p = local2(e)
    if (!g) {
      const rt = rectTool()
      const hd = rt?.handles.find((x) => inRect(x.r, p))
      const next = hd ? (hd.side === 'left' || hd.side === 'right' ? 'ew-resize' : 'ns-resize') : rt && inRect(rt.box, p) ? 'move' : 'default'
      if (next !== cursor) setCursor(next)
      return
    }
    if (g.kind === 'marquee') {
      g.cur = p
      setMarquee({ a: g.start, b: p })
      return
    }
    if (g.kind === 'scrub') return
    if (g.kind === 'tangent') {
      const k = g.base.keys[g.key]
      if (!k) return
      const next = dragTangent(g.base, g.key, g.side, T(p.x) - k.time, V(p.y) - k.value)
      pushCurves(new Map([[g.id, next]]), state.current.sel, !g.moved)
      g.moved = true
      return
    }
    if (g.kind === 'pan') {
      const d = { x: p.x - g.last.x, y: p.y - g.last.y }
      g.last = p
      setView((v) => panView(v, (-d.x / pw) * (v.t1 - v.t0), (d.y / ph) * (v.v1 - v.v0), vmin))
      return
    }
    if (g.kind === 'zoom') {
      const d = p.x - g.last.x + (p.y - g.last.y)
      g.last = p
      const k = Math.max(0.01, 1 + d * 0.01)
      setView((v) => zoomView(v, g.ft, g.fv, k, e.shiftKey, e.metaKey || e.ctrlKey, vmin))
      return
    }
    if (g.kind === 'scale') {
      const horiz = g.side === 'left' || g.side === 'right'
      const to = horiz ? T(p.x) : V(p.y)
      const k = scaleAbout(g.pivot, g.picked, to, g.offset)
      if (k === null) return
      const changed = new Map<number, TunerCurve>()
      const nextSel: PsSel = []
      for (const [id, base] of g.base) {
        const idx = g.sel.filter(([a]) => a === id).map(([, b]) => b)
        const r = transformKeys(
          base,
          idx,
          horiz
            ? { time: (t) => g.pivot + (t - g.pivot) * k, value: (v) => v, flipX: k < 0 }
            : { time: (t) => t, value: (v) => g.pivot + (v - g.pivot) * k, flipY: k < 0 },
          vmin
        )
        changed.set(id, r.curve)
        for (const i of r.idx) nextSel.push([id, i])
      }
      pushCurves(changed, nextSel, !g.moved)
      g.moved = true
      return
    }
    const dt = ((p.x - g.start.x) / pw) * vw
    const dv = (-(p.y - g.start.y) / ph) * vh
    if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) < 2) return
    if (g.kind === 'keys') {
      if (g.box) setMoveLabel(p)
      const changed = new Map<number, TunerCurve>()
      const nextSel: PsSel = []
      for (const [id, base] of g.base) {
        const idx = g.sel.filter(([a]) => a === id).map(([, b]) => b)
        const r = moveKeys(base, idx, dt, dv, vmin)
        changed.set(id, r.curve)
        for (const i of r.idx) nextSel.push([id, i])
      }
      pushCurves(changed, nextSel, !g.moved)
      g.moved = true
      return
    }
    const d = shiftRange([...g.base.values()], dv, vmin)
    const changed = new Map<number, TunerCurve>()
    for (const [id, base] of g.base) changed.set(id, shiftCurve(base, d))
    pushCurves(changed, state.current.sel, !g.moved)
    g.moved = true
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.stopPropagation()
    if (e.pointerType === 'touch' && touchPts.current.has(e.pointerId)) {
      touchPts.current.delete(e.pointerId)
      stopHold()
      if (pinch.current) {
        if (touchPts.current.size === 0) pinch.current = null
        return
      }
    }
    const g = gesture.current
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
    }
    if (g?.kind === 'marquee') {
      const inside = keysInRect(g.start, g.cur)
      const merged = g.add ? [...g.base, ...inside.filter(([a, b]) => !g.base.some(([c, d]) => c === a && d === b))] : inside
      if (Math.hypot(g.cur.x - g.start.x, g.cur.y - g.start.y) > 2 || g.add) select(merged)
    }
    finishGesture()
  }

  const deleteSelected = (): void => {
    const changed = new Map<number, TunerCurve>()
    for (const id of new Set(sel.map(([a]) => a))) {
      const c = curveFor(id)
      if (!c) continue
      const next = deleteKeys(
        c,
        sel.filter(([a]) => a === id).map(([, b]) => b)
      )
      if (next !== c) changed.set(id, next)
    }
    if (changed.size) pushCurves(changed, [], true)
    else select([])
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target instanceof HTMLInputElement) return
    const mod = e.metaKey || e.ctrlKey
    e.stopPropagation()
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      void send({ op: e.shiftKey ? 'redo' : 'undo' })
      return
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      void send({ op: 'redo' })
      return
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) {
      e.preventDefault()
      deleteSelected()
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      const all: PsSel = []
      for (const it of items) for (const id of it.ids) curveOf(it, id, local)?.keys.forEach((_, i) => all.push([id, i]))
      select(all)
    } else if (!mod && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault()
      frame()
    } else if (e.key === 'Escape' && sel.length) {
      e.preventDefault()
      select([])
    }
  }

  const geo = useRef({ pw, ph, vmin })
  geo.current = { pw, ph, vmin }
  useEffect(() => {
    const el = hitRef.current
    const root = rootRef.current
    if (!el || !root) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const r = root.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      const unit = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 20 : 1 / 33
      const delta = -(e.deltaX + e.deltaY) * unit
      const k = Math.max(0.01, 1 + delta * 0.01)
      const g = geo.current
      setView((v) => {
        const ft = v.t0 + ((px - PSC_MARGIN.left) / g.pw) * (v.t1 - v.t0)
        const fv = v.v1 - ((py - PSC_MARGIN.top) / g.ph) * (v.v1 - v.v0)
        return zoomView(v, ft, fv, k, e.shiftKey, e.metaKey || e.ctrlKey, g.vmin)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.setAttribute('data-drift-wheel', '')
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const menuData: TunerMenuData | null = !menu
    ? null
    : menu.kind === 'curve'
      ? { options: ['Add Key'], enabled: [true], separator: [false], selected: [] }
      : menu.kind === 'wrap'
        ? (() => {
            const c = curveFor(menu.id)
            const cur = c ? (menu.side === 'pre' ? c.preWrapMode : c.postWrapMode) : WRAP.clampForever
            const now = cur === WRAP.loop || cur === WRAP.pingPong ? cur : WRAP.clampForever
            return {
              options: WRAP_MENU.map((m) => m.label),
              enabled: WRAP_MENU.map(() => true),
              separator: WRAP_MENU.map(() => false),
              selected: WRAP_MENU.flatMap((m, i) => (m.value === now ? [i] : []))
            }
          })()
        : (() => {
            const many = sel.length > 1
            const c = curveFor(menu.id)
            const k = c?.keys[menu.key]
            const on = k ? tangentState(k) : null
            return {
              options: KEY_MENU_PS.map((m) => (m.action === 'delete' && many ? 'Delete Keys' : m.action === 'edit' && many ? 'Edit Keys...' : m.label)),
              enabled: KEY_MENU_PS.map((m) => m.action !== null),
              separator: KEY_MENU_PS.map((m) => m.action === null),
              selected: KEY_MENU_PS.flatMap((m, i) => (on && m.action && m.action !== 'delete' && m.action !== 'edit' && on[m.action] ? [i] : []))
            }
          })()

  const pickMenu = (i: number): void => {
    const m = menu
    setMenu(null)
    if (!m) return
    if (m.kind === 'curve') {
      const c = curveFor(m.id)
      if (!c) return
      const r = addKey(c, m.time, clamp(evaluate(c, m.time), vmin, 1))
      pushCurves(new Map([[m.id, r.curve]]), [[m.id, r.index]], true, m.id)
      return
    }
    if (m.kind === 'wrap') {
      const c = curveFor(m.id)
      const v = WRAP_MENU[i]?.value
      if (!c || v === undefined) return
      pushCurves(new Map([[m.id, m.side === 'pre' ? { ...c, preWrapMode: v } : { ...c, postWrapMode: v }]]), state.current.sel, true)
      return
    }
    const action = KEY_MENU_PS[i]?.action
    if (!action) return
    if (action === 'delete') {
      deleteSelected()
      return
    }
    if (action === 'edit') {
      const c = curveFor(m.id)
      const k = c?.keys[m.key]
      if (!k) return
      setEdit({ id: m.id, key: m.key, x: X(k.time), y: Y(k.value), time: fmtNum(k.time, 4), value: fmtNum(k.value, 4) })
      return
    }
    const changed = new Map<number, TunerCurve>()
    for (const id of new Set(sel.map(([a]) => a))) {
      let c = curveFor(id)
      if (!c) continue
      for (const [, key] of sel.filter(([a]) => a === id)) c = applyTangentAction(c, key, action)
      changed.set(id, c)
    }
    if (changed.size) pushCurves(changed, state.current.sel, true)
  }

  const commitEdit = (ed: KeyEdit): void => {
    setEdit(null)
    const t = Number(ed.time.trim().replace(',', '.'))
    const v = Number(ed.value.trim().replace(',', '.'))
    if (!Number.isFinite(t) || !Number.isFinite(v)) return
    const c = curveFor(ed.id)
    const k = c?.keys[ed.key]
    if (!c || !k) return
    const r = moveKeys(c, [ed.key], clamp(t, 0, 1) - k.time, clamp(v, vmin, 1) - k.value, vmin)
    pushCurves(new Map([[ed.id, r.curve]]), r.idx.map((i) => [ed.id, i] as [number, number]), true)
  }

  const axis = axisScalarFor(items, sel)
  const ax = axis && axis.y > 0 ? axis.y : 1
  const sx = axis && axis.x > 0 ? axis.x : 1
  const hLabels = !axis || axis.x > 0
  const vLabels = !axis || axis.y > 0
  const shownT0 = T(0)
  const shownT1 = T(w)
  const shownV0 = V(h)
  const shownV1 = V(0)
  const hLevels = tickLevels(shownT0 * sx, shownT1 * sx, w)
  const vLevels = tickLevels(shownV0 * ax, shownV1 * ax, h)
  const hStep = labelPeriod(shownT0 * sx, shownT1 * sx, w, 30)
  const vStep = labelPeriod(shownV0 * ax, shownV1 * ax, h, 20)
  const labelTicks = (a: number, b: number, step: number): number[] => {
    const out: number[] = []
    for (let i = Math.floor(a / step); i <= Math.ceil(b / step); i++) out.push(Math.abs(i * step) < step * 1e-9 ? 0 : i * step)
    return out
  }
  const hTicks = labelTicks(shownT0 * sx, shownT1 * sx, hStep).filter((t) => t / sx >= -1e-6 && t / sx <= 1 + 1e-6)
  const vTicks = labelTicks(shownV0 * ax, shownV1 * ax, vStep).filter((v) => v / ax >= vmin - 1e-6 && v / ax <= 1 + 1e-6)
  const hDec = decimalsFor(hStep)
  const vDec = decimalsFor(vStep)
  const showField = !!axis && axis.editable
  const lineX0 = X(Math.max(shownT0, 0))
  const lineX1 = X(Math.min(shownT1, 1))
  const lineY0 = Y(Math.min(shownV1, 1))
  const lineY1 = Y(Math.max(shownV0, vmin))
  const gridLines: ReactNode[] = []
  for (const lv of hLevels) {
    if (lv.strength <= 0) continue
    for (const t of lv.ticks) {
      const pos = t / sx
      if (pos <= 0 || pos >= 1) continue
      gridLines.push(<line key={`h${lv.period}:${t}`} x1={X(pos)} x2={X(pos)} y1={lineY0} y2={lineY1} stroke="var(--strong)" strokeOpacity={lv.strength} />)
    }
  }
  for (const lv of vLevels) {
    if (lv.strength <= 0) continue
    for (const v of lv.ticks) {
      const pos = v / ax
      if (pos <= vmin || pos >= 1) continue
      gridLines.push(<line key={`v${lv.period}:${v}`} x1={lineX0} x2={lineX1} y1={Y(pos)} y2={Y(pos)} stroke="var(--strong)" strokeOpacity={lv.strength} />)
    }
  }
  for (const t of [0, 1]) if (t >= shownT0 && t <= shownT1) gridLines.push(<line key={`hr${t}`} x1={X(t)} x2={X(t)} y1={lineY0} y2={lineY1} stroke="var(--strong)" />)
  for (const v of [vmin, 1]) if (v >= shownV0 && v <= shownV1) gridLines.push(<line key={`vr${v}`} x1={lineX0} x2={lineX1} y1={Y(v)} y2={Y(v)} stroke="var(--strong)" />)

  const commitAxis = (text: string): void => {
    setAxisDraft(null)
    const n = Number(text.trim().replace(',', '.'))
    if (!axis || !Number.isFinite(n) || Math.abs(n - axis.y) < 1e-9) return
    queue({ cmd: 'scalar', begin: true, ids: axis.ids, value: n })
  }

  const hasSelection = sel.length > 0
  const nodes: ReactNode[] = []
  const tangents: ReactNode[] = []
  const keyNodes: ReactNode[] = []
  items.forEach((it, idx) => {
    const isTop = idx === items.length - 1
    const curveSelected = (id: number): boolean => sel.some(([a]) => a === id)
    const focus = isTop || (hasSelection && it.ids.some(curveSelected))
    const base = rgba(it.data.col)
    const curves = it.ids.map((id) => ({ id, c: curveOf(it, id, local) })).filter((x): x is { id: number; c: TunerCurve } => !!x.c && x.c.keys.length > 0)
    if (curves.length === 2) {
      const steps = Math.max(8, Math.ceil(pw / 3))
      const top2: string[] = []
      const bot: string[] = []
      for (let s = 0; s <= steps; s++) {
        const t = s / steps
        top2.push(`${X(t).toFixed(1)},${Y(evaluate(curves[0].c, t)).toFixed(1)}`)
        bot.push(`${X(t).toFixed(1)},${Y(evaluate(curves[1].c, t)).toFixed(1)}`)
      }
      const fill = focus ? { ...base, a: 0.4 } : scaled(base, 0.4, 0.1)
      nodes.push(<polygon key={`r${it.data.id}`} data-psc-region={it.data.id} points={`${top2.join(' ')} ${bot.reverse().join(' ')}`} fill={cssColor(fill)} />)
    }
    for (const { id, c } of curves) {
      const g = gesture.current
      const dragging = g?.kind === 'curve' && g.base.has(id) && g.moved
      const col = dragging ? towardWhite(base, 0.3) : focus ? base : scaled(base, 0.5, 0.8)
      const keys = c.keys
      let main = ''
      let pre = ''
      let post = ''
      if (keys.length === 1) main = `M ${X(0)} ${Y(keys[0].value)} H ${X(1)}`
      else {
        main = `M ${X(keys[0].time)} ${Y(keys[0].value)}`
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
          const n = Math.max(2, Math.ceil(((to - from) * pw) / 3))
          for (let s = 0; s <= n; s++) {
            const t = from + ((to - from) * s) / n
            pts.push(`${X(t).toFixed(1)} ${Y(evaluate(c, t)).toFixed(1)}`)
          }
          return `M ${pts.join(' L ')}`
        }
        pre = sample(shownT0, keys[0].time)
        post = sample(keys[keys.length - 1].time, shownT1)
      }
      const wrapCol = { ...base, a: base.a * 0.5 }
      if (pre) nodes.push(<path key={`pre${id}`} d={pre} fill="none" stroke={cssColor(wrapCol)} strokeWidth={1} />)
      if (post) nodes.push(<path key={`post${id}`} d={post} fill="none" stroke={cssColor(wrapCol)} strokeWidth={1} />)
      nodes.push(<path key={`c${id}`} data-psc-curve={id} data-psc-name={it.data.name} data-psc-role={id === it.data.id ? 'max' : 'min'} data-psc-focus={focus ? 'true' : undefined} d={main} fill="none" stroke={cssColor(col)} strokeWidth={1.25} />)
      const onCurve = curveSelected(id)
      const keyCol = onCurve ? towardWhite(base, 0.2) : focus ? base : scaled(base, 0.5)
      keys.forEach((k, ki) => {
        const chosen = onCurve && isSelected(id, ki)
        keyNodes.push(
          <circle
            key={`k${id}:${ki}`}
            data-psc-key={`${id}:${ki}`}
            data-psc-time={k.time}
            data-psc-value={k.value}
            data-psc-selected={chosen ? 'true' : undefined}
            cx={X(k.time)}
            cy={Y(k.value)}
            r={chosen ? 4 : 3.5}
            fill={chosen ? 'var(--ink)' : cssColor(keyCol)}
            stroke={chosen ? cssColor(keyCol) : 'var(--canvas)'}
            strokeWidth={chosen ? 1.5 : 1}
          />
        )
        if (!chosen) return
        for (const side of ['in', 'out'] as const) {
          const hp = handlePoint(id, ki, side)
          if (!hp) continue
          tangents.push(
            <g key={`t${id}:${ki}:${side}`} data-psc-handle={`${id}:${ki}:${side}`}>
              <line x1={X(k.time)} y1={Y(k.value)} x2={hp.x} y2={hp.y} stroke="var(--ink-3)" strokeWidth={1} />
              <circle cx={hp.x} cy={hp.y} r={3} fill="var(--panel)" stroke="var(--ink-2)" strokeWidth={1.25} />
            </g>
          )
        }
      })
    }
  })

  const wrapButtons: ReactNode[] = []
  if (top) {
    const c = curveOf(top, top.data.id, local)
    if (c && c.keys.length >= 2) {
      const col = cssColor(rgba(top.data.col))
      for (const side of ['pre', 'post'] as const) {
        const k = side === 'pre' ? c.keys[0] : c.keys[c.keys.length - 1]
        const left = X(k.time) + WRAP_ICON * (side === 'pre' ? -1.5 : 0.5)
        wrapButtons.push(
          <button
            key={side}
            type="button"
            tabIndex={-1}
            data-psc-wrap={side}
            aria-label={side === 'pre' ? 'Pre wrap mode' : 'Post wrap mode'}
            onPointerDown={(e) => {
              e.stopPropagation()
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, kind: 'wrap', id: top.data.id, key: -1, time: 0, side })
            }}
            className="pointer-events-auto absolute flex items-center justify-center rounded-[3px] hover:bg-white/10"
            style={{ left, top: Y(k.value), width: WRAP_ICON, height: WRAP_ICON, color: col }}
          >
            <ChevronDown className="h-3 w-3" strokeWidth={2.5} />
          </button>
        )
      }
    }
  }

  const fieldValue = axis ? fmtAxis(axis.y, vDec) : ''
  const rt = rectTool()
  const rectNodes = rt ? (
    <g data-psc-rect={`${rt.box.x.toFixed(1)},${rt.box.y.toFixed(1)},${rt.box.w.toFixed(1)},${rt.box.h.toFixed(1)}`}>
      <rect x={rt.box.x} y={rt.box.y} width={rt.box.w} height={rt.box.h} fill="var(--accent)" fillOpacity={0.08} stroke="var(--accent)" strokeOpacity={0.55} />
      {rt.handles.map((hd) => {
        const vert = hd.side === 'left' || hd.side === 'right'
        const bar = vert ? { x: hd.r.x + hd.r.w / 2 - 1.5, y: hd.r.y, w: 3, h: hd.r.h } : { x: hd.r.x, y: hd.r.y + hd.r.h / 2 - 1.5, w: hd.r.w, h: 3 }
        return (
          <g key={hd.side}>
            <rect data-psc-scale={hd.side} x={hd.r.x} y={hd.r.y} width={hd.r.w} height={hd.r.h} fill="transparent" />
            <rect x={bar.x} y={bar.y} width={bar.w} height={bar.h} rx={1.5} fill="var(--accent)" fillOpacity={0.6} />
          </g>
        )
      })}
    </g>
  ) : null

  return (
    <div
      ref={rootRef}
      data-ps-curves={section}
      data-psc-count={psc.curves.length}
      data-psc-top={top?.data.id ?? 0}
      data-psc-sel={flatSel(sel).join(',')}
      data-psc-view={[view.t0, view.t1, view.v0, view.v1].map((n) => n.toFixed(4)).join(',')}
      className="absolute"
      style={{ left: psc.x, top: psc.y, width: w, height: h, pointerEvents: 'none' }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg width={w} height={h} className="absolute left-0 top-0 overflow-hidden" style={{ pointerEvents: 'none' }}>
        <g shapeRendering="crispEdges" data-psc-grid={`${hLevels.filter((l) => l.strength > 0).length},${vLevels.filter((l) => l.strength > 0).length}`}>
          {gridLines}
        </g>
        {psc.curves.length > 0 && (
          <g className="fill-ink-3 text-[9px] tabular-nums" data-psc-labels>
            {hLabels && hTicks.map((t) => (
              <text key={`ht${t}`} x={Math.floor(X(t / sx))} y={h - 21 + 11} textAnchor="middle">
                {fmtAxis(t, hDec)}
              </text>
            ))}
            {vLabels && vTicks
              .filter((v) => !(showField && Math.abs(Y(v / ax) - PSC_MARGIN.top) < 8))
              .map((v) => (
                <text key={`vt${v}`} x={PSC_MARGIN.left - 4} y={Math.floor(Y(v / ax)) + 3} textAnchor="end">
                  {fmtAxis(v, vDec)}
                </text>
              ))}
          </g>
        )}
        <svg x={0} y={0} width={w} height={h} overflow="hidden">
          {nodes}
          {keyNodes}
          {rectNodes}
          {tangents}
        </svg>
        {marquee && (
          <rect
            data-psc-marquee
            x={Math.min(marquee.a.x, marquee.b.x)}
            y={Math.min(marquee.a.y, marquee.b.y)}
            width={Math.abs(marquee.b.x - marquee.a.x)}
            height={Math.abs(marquee.b.y - marquee.a.y)}
            fill="var(--accent)"
            fillOpacity={0.12}
            stroke="var(--accent)"
            strokeOpacity={0.6}
          />
        )}
      </svg>
      <div
        ref={hitRef}
        tabIndex={-1}
        data-psc-plot
        className="absolute left-0 outline-none"
        style={{ top: HIT_TOP, width: w, height: Math.max(0, h - HIT_TOP), pointerEvents: 'auto', cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleTap}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      />
      {showField && (
        <>
          <div
            data-psc-axis-drag
            className="absolute cursor-ew-resize"
            style={{ left: 0, top: PSC_MARGIN.top - 8 - 16, width: PSC_MARGIN.left - 4, height: 16, pointerEvents: 'auto' }}
            onPointerDown={(e) => {
              e.stopPropagation()
              if (e.button !== 0 || !axis) return
              e.currentTarget.setPointerCapture(e.pointerId)
              gesture.current = { kind: 'scrub', last: { x: e.clientX, y: e.clientY }, value: axis.y, ids: axis.ids, moved: false }
            }}
            onPointerMove={(e) => {
              e.stopPropagation()
              const g = gesture.current
              if (!g || g.kind !== 'scrub') return
              const d = e.clientX - g.last.x - (e.clientY - g.last.y)
              g.last = { x: e.clientX, y: e.clientY }
              if (!d) return
              const sens = clamp(Math.max(g.value, Math.sqrt(Math.abs(g.value))) * 0.01, 0, 1)
              g.value = Math.max(0.001, g.value + d * sens)
              queue({ cmd: 'scalar', begin: !g.moved, ids: g.ids, value: g.value })
              g.moved = true
            }}
            onPointerUp={(e) => {
              e.stopPropagation()
              try {
                e.currentTarget.releasePointerCapture(e.pointerId)
              } catch {
              }
              finishGesture()
            }}
          />
          <input
            data-psc-axis
            aria-label="Curve scale"
            className="absolute min-w-0 rounded border border-white/10 bg-sunken px-0.5 text-right text-[11px] tabular-nums text-ink outline-none hover:border-white/20 focus:border-accent"
            style={{ left: 0, top: PSC_MARGIN.top - 8, width: PSC_MARGIN.left - 4, height: 16, pointerEvents: 'auto' }}
            value={axisDraft ?? fieldValue}
            spellCheck={false}
            onPointerDown={(e) => e.stopPropagation()}
            onFocus={(e) => {
              setAxisDraft(axis ? String(Math.round(axis.y * 1e6) / 1e6) : '')
              e.currentTarget.select()
            }}
            onChange={(e) => setAxisDraft(e.target.value)}
            onBlur={() => axisDraft !== null && commitAxis(axisDraft)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                if (axisDraft !== null) commitAxis(axisDraft)
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setAxisDraft(null)
                e.currentTarget.blur()
              }
            }}
          />
        </>
      )}
      {wrapButtons}
      {moveLabel && (
        <div
          data-psc-move-label
          className="pointer-events-none absolute whitespace-nowrap text-[11px] tabular-nums text-ink [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]"
          style={{ left: clamp(moveLabel.x, 0, Math.max(0, w - 80)), top: clamp(moveLabel.y - 16, 0, Math.max(0, h - 16)) }}
        >
          {`${fmtAxis(T(moveLabel.x), 2)}, ${fmtAxis(V(moveLabel.y), 2)}`}
        </div>
      )}
      {edit && (
        <div
          data-psc-key-edit
          className="pointer-events-auto absolute z-10 flex items-center gap-1 rounded border border-white/10 bg-panel p-1 text-[10px] text-ink-3 shadow-lg"
          style={{ left: clamp(edit.x + 8, 0, Math.max(0, w - 170)), top: clamp(edit.y + 8, 0, Math.max(0, h - 28)) }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              commitEdit(edit)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setEdit(null)
            }
          }}
        >
          <span>Time</span>
          <input autoFocus data-psc-edit="time" className={`${fieldCls} w-14`} value={edit.time} onChange={(e) => setEdit({ ...edit, time: e.target.value })} />
          <span>Value</span>
          <input data-psc-edit="value" className={`${fieldCls} w-14`} value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} />
        </div>
      )}
      {menu && menuData && (
        <PopupMenu
          data={menuData}
          attrs={{ 'data-psc-menu': menu.kind }}
          getAnchor={() => ({ left: menu.x, top: menu.y, width: 0, height: 0 })}
          onPick={pickMenu}
          onCancel={() => setMenu(null)}
        />
      )}
    </div>
  )
}
