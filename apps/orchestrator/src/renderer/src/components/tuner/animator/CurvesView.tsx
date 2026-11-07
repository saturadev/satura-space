import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { frameOf, type TunerAnimatorRequest, type TunerAnimClip, type TunerAnimKey, type TunerAnimKeyArg } from '@shared/tuner-animator'
import { fmt, frameView, panView, parseSelId, selId, tOf, timeTicks, xOf, zoomView, type TimeScale, type TimeView } from '../../../lib/tuner/animator'
import {
  applyTangentDrag,
  channelName,
  cloneKey,
  curveColor,
  curveKeysInRect,
  easeName,
  evalKeys,
  fitRange,
  fitSelected,
  handlePt,
  hitCurves,
  IDENTITY_MAP,
  moveKeysLocal,
  niceStep,
  normMap,
  pAt,
  py,
  sideEditable,
  tangentFromPointer,
  updateTangents,
  vAt,
  vy,
  type CurveChan,
  type CurveHit,
  type CurveMap,
  type CurveRegion,
  type ValueView
} from '../../../lib/tuner/curves'
import { FloatingTip } from '../FloatingTip'
import { zoomOf } from '../../../lib/css-zoom'

const TOP_PAD = 14
const BOTTOM_PAD = 12
const VBAR_W = 10
const VBAR_EDGE = 5
const CLICK_PX = 3
const TM_NAMES = ['Free', 'Auto', 'Linear', 'Constant', 'Clamped Auto']

export interface CurvesHandle {
  showAll: () => void
  frameSelection: () => void
}

export type CurvesContext =
  | { kind: 'key'; ids: Set<string>; clicked: string }
  | { kind: 'seg'; id: string; name: string; fa: number; fb: number; t: number; v: number }
  | { kind: 'empty' }

interface Palette {
  key: string
  panel: string
  ink: string
  ink2: string
  ink3: string
  ink4: string
  accent: string
}

let palette: Palette | null = null

function readPalette(): Palette {
  const root = document.documentElement
  const key = `${root.getAttribute('data-theme') ?? ''}|${root.className}`
  if (palette && palette.key === key) return palette
  const cs = getComputedStyle(root)
  const v = (n: string): string => cs.getPropertyValue(n).trim() || '#888'
  palette = { key, panel: v('--panel'), ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'), ink4: v('--ink-4'), accent: v('--accent') }
  return palette
}

type Gesture =
  | {
      kind: 'keys'
      x0: number
      y0: number
      moved: boolean
      lock: 'x' | 'y' | null
      per: Map<string, { base: TunerAnimKey[]; frames: Set<number> }>
      minF: number
      grab: { id: string; frame: number; offX: number; offY: number }
      click: string | null
      df: number
      dp: number
      sent: boolean
    }
  | { kind: 'tan'; id: string; i: number; side: 'in' | 'out'; base: Map<string, TunerAnimKey[]>; targets: Map<string, number[]>; moved: boolean; sent: boolean }
  | { kind: 'marquee'; x0: number; y0: number; base: Set<string>; add: boolean; moved: boolean }
  | { kind: 'pan'; x0: number; y0: number; s0: TimeScale; vv0: ValueView }
  | { kind: 'zoom'; x0: number; y0: number; s0: TimeScale; vv0: ValueView }
  | { kind: 'vbar'; mode: 'top' | 'bottom' | 'pan'; y0: number; vv0: ValueView; total: ValueView; barH: number }

interface DragState {
  chans: Map<string, TunerAnimKey[]>
  sel: Set<string> | null
  maps: Map<string, CurveMap>
  vv: ValueView
  info: string
}

interface Sample {
  t: number
  err: number
  ex: number
}

export const CurvesView = forwardRef<
  CurvesHandle,
  {
    clip: TunerAnimClip
    fps: number
    s: TimeScale
    width: number
    height: number
    time: number
    frames: boolean
    shown: string[]
    why: 'all' | 'rows'
    sel: ReadonlySet<string>
    readOnly: boolean
    normalize: boolean
    onNormalize: (v: boolean) => void
    onSelect: (next: Set<string>) => void
    onView: (v: TimeView | null) => void
    onContext: (e: { clientX: number; clientY: number }, ctx: CurvesContext) => void
    onAddKey: (id: string, t: number, v: number) => void
    onDragStart: () => void
    live: (req: TunerAnimatorRequest) => void
    commit: (req: TunerAnimatorRequest, over: Map<string, TunerAnimKey[]>) => void
    onFocus: () => void
  }
>(function CurvesView(props, ref) {
  const { clip, fps, s, width, height, shown, sel, readOnly, normalize } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [vv, setVv] = useState<ValueView | null>(null)
  const [hover, setHover] = useState<{ hit: CurveHit | null; x: number; y: number } | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [dragInfo, setDragInfo] = useState<{ text: string; x: number; y: number } | null>(null)
  const [barDrag, setBarDrag] = useState(false)
  const gestureRef = useRef<Gesture | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const pointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const rafRef = useRef(0)
  const statsRef = useRef<{ draws: number; moves: number; samples: Sample[] }>({ draws: 0, moves: 0, samples: [] })
  const lastRef = useRef<Record<string, TunerAnimKey[]>>({})

  const props0 = clip.props
  const chans = useMemo(() => {
    const want = new Set(shown)
    const out: CurveChan[] = []
    for (const p of props0) {
      if (p.pptr) continue
      for (const c of p.channels) {
        if (!want.has(c.id)) continue
        const name = channelName(p, c)
        out.push({ id: c.id, keys: c.keys, color: curveColor(c, p), label: p.object && p.path ? `${p.object} · ${name}` : name, name, discrete: c.discrete, m: normalize ? normMap(c.keys) : IDENTITY_MAP })
      }
    }
    return out
  }, [props0, shown, normalize])

  const sig = `${chans.map((c) => c.id).join('|')}#${normalize ? 'n' : ''}`
  useEffect(() => {
    setVv(null)
  }, [sig])

  const fitAll = useMemo(() => fitRange(chans, 0, clip.length), [chans, clip.length])
  const view = vv ?? fitAll
  const plotH = Math.max(10, height - TOP_PAD - BOTTOM_PAD)

  const region = useCallback((): CurveRegion => {
    const d = dragRef.current
    const list = d
      ? chans.map((c) => {
          const keys = d.chans.get(c.id)
          const m = d.maps.get(c.id) ?? c.m
          return keys || m !== c.m ? { ...c, keys: keys ?? c.keys, m } : c
        })
      : chans
    return { y: TOP_PAD, h: plotH, ts: s, vv: d ? d.vv : view, chans: list }
  }, [chans, plotH, s, view])

  const latest = useRef({ region, props, view, fitAll, hover })
  latest.current = { region, props, view, fitAll, hover }

  const draw = useCallback(() => {
    rafRef.current = 0
    const cv = canvasRef.current
    if (!cv) return
    const { region: getR, props: P, hover: hv } = latest.current
    const w = P.width
    const H = P.height
    const dpr = window.devicePixelRatio || 1
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(H * dpr)
    }
    const g = cv.getContext('2d')
    if (!g) return
    const C = readPalette()
    const R = getR()
    const d = dragRef.current
    const selNow = d?.sel ?? P.sel
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, H)
    g.font = '9px ui-sans-serif, system-ui, -apple-system, sans-serif'
    const end = xOf(R.ts, P.clip.length)
    g.fillStyle = 'rgba(0,0,0,0.18)'
    g.fillRect(end, 0, Math.max(0, w - end), H)
    for (const tk of timeTicks(R.ts, P.fps, P.frames)) {
      g.globalAlpha = tk.major ? 0.09 : 0.04
      g.fillStyle = C.ink
      g.fillRect(Math.round(xOf(R.ts, tk.t)), 0, 1, H)
    }
    const span = R.vv.hi - R.vv.lo
    const step = niceStep(span, R.h, 30)
    const dec = Math.max(0, -Math.floor(Math.log10(step)))
    const lines: number[] = []
    for (let v = Math.ceil(R.vv.lo / step) * step; v <= R.vv.hi + 1e-9 && lines.length < 200; v += step) lines.push(v)
    for (const v of lines) {
      g.globalAlpha = Math.abs(v) < step * 1e-6 ? 0.22 : 0.07
      g.fillStyle = C.ink
      g.fillRect(0, Math.round(py(R, v)), w, 1)
    }
    g.globalAlpha = 1
    g.fillStyle = C.ink3
    for (const v of lines) {
      const y = Math.round(py(R, v))
      if (y >= 8 && y <= H - 2) g.fillText(fmt(v, dec), 4, y - 3)
    }
    g.save()
    g.beginPath()
    g.rect(0, R.y - 8, w, R.h + 16)
    g.clip()
    const hovered = hv?.hit ? hv.hit.c.id : null
    for (const c of R.chans) {
      const ks = c.keys
      if (ks.length === 0) continue
      const on = !hovered || hovered === c.id
      const first = ks[0]
      const last = ks[ks.length - 1]
      g.strokeStyle = c.color
      g.globalAlpha = on ? 0.4 : 0.2
      g.lineWidth = 1.2
      g.setLineDash([3, 3])
      g.beginPath()
      g.moveTo(0, vy(R, c.m, first.v))
      g.lineTo(xOf(R.ts, first.t), vy(R, c.m, first.v))
      g.moveTo(xOf(R.ts, last.t), vy(R, c.m, last.v))
      g.lineTo(w, vy(R, c.m, last.v))
      g.stroke()
      g.setLineDash([])
      g.globalAlpha = on ? 1 : 0.45
      g.lineWidth = hovered === c.id ? 2.2 : 1.6
      g.beginPath()
      g.moveTo(xOf(R.ts, first.t), vy(R, c.m, first.v))
      for (let i = 0; i < ks.length - 1; i++) {
        const a = ks[i]
        const b = ks[i + 1]
        const dt = b.t - a.t
        if (a.out === null || b.in === null) {
          g.lineTo(xOf(R.ts, b.t), vy(R, c.m, a.v))
          g.lineTo(xOf(R.ts, b.t), vy(R, c.m, b.v))
          continue
        }
        const ow = a.wm & 2 ? a.outW : 1 / 3
        const iw = b.wm & 1 ? b.inW : 1 / 3
        g.bezierCurveTo(
          xOf(R.ts, a.t + ow * dt),
          vy(R, c.m, a.v + a.out * ow * dt),
          xOf(R.ts, b.t - iw * dt),
          vy(R, c.m, b.v - b.in * iw * dt),
          xOf(R.ts, b.t),
          vy(R, c.m, b.v)
        )
      }
      g.stroke()
    }
    g.globalAlpha = 1
    for (const c of R.chans) {
      c.keys.forEach((k, i) => {
        const x = xOf(R.ts, k.t)
        if (x < -8 || x > w + 8) return
        const y = vy(R, c.m, k.v)
        const on = selNow.has(selId(c.id, frameOf(k.t, P.fps)))
        if (on)
          for (const side of ['in', 'out'] as const) {
            const hp = handlePt(R, c, i, side)
            if (!hp) continue
            const hot = hv?.hit?.kind === 'tan' && hv.hit.c.id === c.id && hv.hit.i === i && hv.hit.side === side
            g.strokeStyle = C.ink3
            g.lineWidth = 1
            g.beginPath()
            g.moveTo(x, y)
            g.lineTo(hp.x, hp.y)
            g.stroke()
            g.fillStyle = hot ? C.accent : C.ink2
            g.strokeStyle = C.panel
            g.beginPath()
            if (hp.weighted) g.rect(hp.x - 3.5, hp.y - 3.5, 7, 7)
            else g.arc(hp.x, hp.y, 3.4, 0, Math.PI * 2)
            g.fill()
            g.stroke()
          }
        const hot = hv?.hit?.kind === 'key' && hv.hit.c.id === c.id && hv.hit.i === i
        g.fillStyle = on ? C.accent : c.color
        g.strokeStyle = on ? C.ink : C.panel
        g.lineWidth = on ? 1.2 : 1.5
        g.beginPath()
        g.arc(x, y, on || hot ? 4.4 : 3.6, 0, Math.PI * 2)
        g.fill()
        g.stroke()
      })
    }
    g.restore()
    const phx = Math.round(xOf(R.ts, P.time)) + 0.5
    g.strokeStyle = C.accent
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(phx, 0)
    g.lineTo(phx, H)
    g.stroke()
    const st = statsRef.current
    st.draws++
    const gst = gestureRef.current
    if (gst && (gst.kind === 'keys' || gst.kind === 'tan') && gst.moved) {
      const p = pointerRef.current
      if (gst.kind === 'keys') {
        const c = R.chans.find((x) => x.id === gst.grab.id)
        const k = c?.keys.find((q) => frameOf(q.t, P.fps) === gst.grab.frame + gst.df)
        if (c && k) {
          const ky = vy(R, c.m, k.v)
          const kx = xOf(R.ts, k.t)
          const errY = gst.lock === 'x' ? 0 : Math.abs(ky - p.y - gst.grab.offY)
          const errX = gst.lock === 'y' ? 0 : Math.abs(kx - p.x - gst.grab.offX)
          st.samples.push({ t: performance.now(), err: errY, ex: errX })
        }
      } else {
        const c = R.chans.find((x) => x.id === gst.id)
        const hp = c ? handlePt(R, c, gst.i, gst.side) : null
        if (c && hp) {
          const k = c.keys[gst.i]
          const kx = xOf(R.ts, k.t)
          const ky = vy(R, c.m, k.v)
          const ax = hp.x - kx
          const ay = hp.y - ky
          const l = Math.hypot(ax, ay) || 1
          const err = Math.abs((p.x - kx) * ay - (p.y - ky) * ax) / l
          st.samples.push({ t: performance.now(), err, ex: 0 })
        }
      }
      if (st.samples.length > 4000) st.samples.splice(0, 1000)
    }
  }, [])

  const schedule = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(draw)
  }, [draw])

  useLayoutEffect(() => {
    schedule()
  })

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const el = canvasRef.current
    if (!el) return [0, 0]
    const r = el.getBoundingClientRect()
    const k = zoomOf(el)
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k]
  }

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const api = {
      keyPos(id: string, frame: number): { x: number; y: number } | null {
        const R = latest.current.region()
        const c = R.chans.find((x) => x.id === id)
        const k = c?.keys.find((q) => frameOf(q.t, latest.current.props.fps) === frame)
        const r = el.getBoundingClientRect()
        const z = zoomOf(el)
        return c && k ? { x: r.left + xOf(R.ts, k.t) * z, y: r.top + vy(R, c.m, k.v) * z } : null
      },
      handlePos(id: string, frame: number, side: 'in' | 'out'): { x: number; y: number } | null {
        const R = latest.current.region()
        const c = R.chans.find((x) => x.id === id)
        const i = c ? c.keys.findIndex((q) => frameOf(q.t, latest.current.props.fps) === frame) : -1
        const shownSel = dragRef.current?.sel ?? latest.current.props.sel
        const hp = c && i >= 0 && shownSel.has(selId(id, frame)) ? handlePt(R, c, i, side) : null
        const r = el.getBoundingClientRect()
        const z = zoomOf(el)
        return hp ? { x: r.left + hp.x * z, y: r.top + hp.y * z } : null
      },
      curvePos(id: string, t: number): { x: number; y: number } | null {
        const R = latest.current.region()
        const c = R.chans.find((x) => x.id === id)
        const r = el.getBoundingClientRect()
        const z = zoomOf(el)
        return c ? { x: r.left + xOf(R.ts, t) * z, y: r.top + vy(R, c.m, evalKeys(c.keys, t)) * z } : null
      },
      valueAt(id: string, clientY: number): number | null {
        const R = latest.current.region()
        const c = R.chans.find((x) => x.id === id)
        return c ? vAt(R, c.m, (clientY - el.getBoundingClientRect().top) / zoomOf(el)) : null
      },
      view(): { lo: number; hi: number; chans: string[]; normalize: boolean } {
        const R = latest.current.region()
        return { lo: R.vv.lo, hi: R.vv.hi, chans: R.chans.map((c) => c.id), normalize: latest.current.props.normalize }
      },
      lastDrag(): Record<string, TunerAnimKey[]> {
        return lastRef.current
      },
      stats(reset?: boolean): { draws: number; moves: number; samples: Sample[] } {
        const st = statsRef.current
        const out = { draws: st.draws, moves: st.moves, samples: st.samples.slice() }
        if (reset) statsRef.current = { draws: 0, moves: 0, samples: [] }
        return out
      }
    }
    Object.assign(el, { __curves: api })
  }, [])

  const showAll = (): void => {
    setVv(null)
    props.onView(null)
  }

  const frameSelection = (): void => {
    const R = latest.current.region()
    let lo = Infinity
    let hi = -Infinity
    for (const c of R.chans)
      for (const k of c.keys)
        if (sel.has(selId(c.id, frameOf(k.t, fps)))) {
          lo = Math.min(lo, k.t)
          hi = Math.max(hi, k.t)
        }
    if (!Number.isFinite(lo)) {
      showAll()
      return
    }
    props.onView(hi - lo < 1e-6 ? frameView(Math.max(0, lo - 5 / fps), hi + 5 / fps, fps) : frameView(lo, hi, fps))
    const f = fitSelected(R.chans, sel, fps)
    if (f) setVv(f)
  }

  useImperativeHandle(ref, () => ({ showAll, frameSelection }))

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
      e.preventDefault()
      e.stopPropagation()
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
      const cur = latest.current.view
      const d = ((e.deltaY * k) / Math.max(1, latest.current.region().h)) * (cur.hi - cur.lo)
      setVv({ lo: cur.lo - d, hi: cur.hi - d })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.setAttribute('data-drift-wheel', '')
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const materialize = (): ValueView => {
    const cur = latest.current.view
    setVv(cur)
    return cur
  }

  const tipOf = (h: { hit: CurveHit | null; x: number; y: number }): { title: string; body: string } | null => {
    const hit = h.hit
    if (!hit) return null
    const c = hit.c
    if (hit.kind === 'key' || hit.kind === 'tan') {
      const k = c.keys[hit.i]
      if (!k) return null
      const f = frameOf(k.t, fps)
      if (hit.kind === 'tan') {
        const weighted = hit.side === 'in' ? (k.wm & 1) !== 0 : (k.wm & 2) !== 0
        const slope = hit.side === 'in' ? k.in : k.out
        const wgt = hit.side === 'in' ? k.inW : k.outW
        return {
          title: `${hit.side === 'in' ? 'In' : 'Out'} tangent ${slope === null ? 'constant' : fmt(slope)}${weighted ? ` · weight ${fmt(wgt, 2)}` : ''}`,
          body: weighted ? 'Weighted tangent: dragging sets both the slope and the handle length.' : 'Drag to set the slope. To set the length as well, right-click the key and pick Weighted.'
        }
      }
      const mode = !k.broken && k.lm === k.rm ? (k.lm === 0 ? (k.in === 0 && k.out === 0 ? 'Flat' : 'Free Smooth') : TM_NAMES[k.lm] ?? '') : `Broken: ${TM_NAMES[k.lm] ?? ''} / ${TM_NAMES[k.rm] ?? ''}`
      const w = k.wm === 3 ? ', weighted' : k.wm === 1 ? ', in weighted' : k.wm === 2 ? ', out weighted' : ''
      return { title: `${c.label} · frame ${f} · ${fmt(k.v)}`, body: `${mode}${w}. Drag to move it, or right-click for tangent modes.` }
    }
    const v = evalKeys(c.keys, hit.t)
    const a = c.keys[hit.i]
    const b = c.keys[hit.i + 1]
    const ease = a && b ? easeName(a, b) : ''
    return { title: `${c.label} · frame ${fmt(hit.t * fps, 1)} · ${fmt(v)}`, body: `${ease ? `${ease} between frames ${frameOf(a.t, fps)} and ${frameOf(b.t, fps)}. ` : ''}Double-click to add a key here, right-click to edit the easing.` }
  }

  const startKeyDrag = (x: number, y: number, c: CurveChan, i: number, cur: Set<string>, click: string | null): Gesture | null => {
    if (readOnly) return null
    const R = region()
    const per = new Map<string, { base: TunerAnimKey[]; frames: Set<number> }>()
    const byId = new Map(R.chans.map((ch) => [ch.id, ch]))
    let minF = Infinity
    for (const id of cur) {
      const p = parseSelId(id)
      if (!p) continue
      const ch = byId.get(p.channel)
      if (!ch || !ch.keys.some((k) => frameOf(k.t, fps) === p.frame)) continue
      let e = per.get(p.channel)
      if (!e) per.set(p.channel, (e = { base: ch.keys.map(cloneKey), frames: new Set() }))
      e.frames.add(p.frame)
      minF = Math.min(minF, p.frame)
    }
    if (per.size === 0) return null
    const k = c.keys[i]
    return {
      kind: 'keys',
      x0: x,
      y0: y,
      moved: false,
      lock: null,
      per,
      minF: Number.isFinite(minF) ? minF : 0,
      grab: { id: c.id, frame: frameOf(k.t, fps), offX: xOf(R.ts, k.t) - x, offY: vy(R, c.m, k.v) - y },
      click,
      df: 0,
      dp: 0,
      sent: false
    }
  }

  const beginDrag = (): void => {
    const R = region()
    const maps = new Map<string, CurveMap>()
    for (const c of R.chans) maps.set(c.id, c.m)
    dragRef.current = { chans: new Map(), sel: null, maps, vv: materialize(), info: '' }
    props.onDragStart()
  }

  const moveKeysTo = (g: Extract<Gesture, { kind: 'keys' }>, x: number, y: number, shift: boolean): void => {
    let dx = x - g.x0
    let dy = y - g.y0
    if (shift) {
      if (!g.lock) g.lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      if (g.lock === 'x') dy = 0
      else dx = 0
    } else g.lock = null
    const d = dragRef.current
    if (!d) return
    const R = region()
    const df = Math.max(-g.minF, Math.round((tOf(R.ts, g.x0 + dx) - tOf(R.ts, g.x0)) * fps))
    const dp = pAt(R, g.y0 + dy) - pAt(R, g.y0)
    g.df = df
    g.dp = dp
    const nextSel = new Set<string>([...(d.sel ?? sel)].filter((id) => !g.per.has(parseSelId(id)?.channel ?? '')))
    const keys: { id: string; t: number; dv?: number }[] = []
    for (const [id, e] of g.per) {
      const m = d.maps.get(id) ?? IDENTITY_MAP
      const dv = dp / m.s
      d.chans.set(id, moveKeysLocal(e.base, e.frames, df, dv, fps))
      for (const f of e.frames) {
        nextSel.add(selId(id, f + df))
        const bk = e.base.find((k) => frameOf(k.t, fps) === f)
        if (bk) keys.push(normalize ? { id, t: bk.t, dv } : { id, t: bk.t })
      }
    }
    d.sel = nextSel
    const n = keys.length
    const shownDv = dp / (d.maps.get(g.grab.id)?.s ?? 1)
    d.info = `Moving ${n} key${n === 1 ? '' : 's'}: ${df >= 0 ? '+' : ''}${df} f, value ${shownDv >= 0 ? '+' : ''}${fmt(shownDv)}${g.lock ? ' (one axis)' : ' · hold Shift to lock one axis'}`
    g.sent = true
    props.live({ op: 'moveKeys', keys, df, dv: normalize ? 0 : dp, live: true })
  }

  const tangentKeys = (d: DragState, targets: Map<string, number[]>): TunerAnimKeyArg[] => {
    const out: TunerAnimKeyArg[] = []
    for (const [id, idx] of targets) {
      const ks = d.chans.get(id)
      if (!ks) continue
      for (const i of idx) {
        const k = ks[i]
        out.push({ id, t: k.t, hasTan: true, inT: k.in ?? 1e30, outT: k.out ?? 1e30, inW: k.inW, outW: k.outW, wm: k.wm, lm: k.lm, rm: k.rm, broken: k.broken })
      }
    }
    return out
  }

  const moveTangentTo = (g: Extract<Gesture, { kind: 'tan' }>, x: number, y: number): void => {
    const d = dragRef.current
    if (!d) return
    const R = region()
    const base = g.base.get(g.id)
    const c0 = R.chans.find((c) => c.id === g.id)
    if (!base || !c0) return
    const { slope, weight } = tangentFromPointer(R, { ...c0, keys: base }, g.i, g.side, x, y)
    for (const [id, idx] of g.targets) {
      const ks = (g.base.get(id) ?? []).map(cloneKey)
      for (const i of idx) applyTangentDrag(ks, i, g.side, slope, weight)
      updateTangents(ks)
      d.chans.set(id, ks)
    }
    const wk = d.chans.get(g.id)?.[g.i]
    const weighted = wk ? (g.side === 'in' ? (wk.wm & 1) !== 0 : (wk.wm & 2) !== 0) : false
    d.info = `${g.side === 'in' ? 'In' : 'Out'} tangent ${fmt(slope)}${weighted ? ` · weight ${fmt(weight, 2)}` : ''}`
    g.sent = true
    props.live({ op: 'setTangents', keys: tangentKeys(d, g.targets), live: true })
  }

  const finishDrag = (g: Extract<Gesture, { kind: 'keys' | 'tan' }>): void => {
    const d = dragRef.current
    dragRef.current = null
    setDragInfo(null)
    if (!d || !g.sent) return
    const over = new Map(d.chans)
    lastRef.current = Object.fromEntries(over)
    if (g.kind === 'keys') {
      const keys: { id: string; t: number; dv?: number }[] = []
      for (const [id, e] of g.per) {
        const m = d.maps.get(id) ?? IDENTITY_MAP
        for (const f of e.frames) {
          const bk = e.base.find((k) => frameOf(k.t, fps) === f)
          if (bk) keys.push(normalize ? { id, t: bk.t, dv: g.dp / m.s } : { id, t: bk.t })
        }
      }
      if (d.sel) props.onSelect(d.sel)
      props.commit({ op: 'moveKeys', keys, df: g.df, dv: normalize ? 0 : g.dp }, over)
      return
    }
    props.commit({ op: 'setTangents', keys: tangentKeys(d, g.targets) }, over)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const [x, y] = local(e)
    props.onFocus()
    pointerRef.current = { x, y }
    if (e.button === 2 && !e.altKey) return
    e.preventDefault()
    const R = region()
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.currentTarget.setPointerCapture(e.pointerId)
      gestureRef.current = { kind: 'pan', x0: x, y0: y, s0: s, vv0: materialize() }
      return
    }
    if (e.button === 2 && e.altKey) {
      e.currentTarget.setPointerCapture(e.pointerId)
      gestureRef.current = { kind: 'zoom', x0: x, y0: y, s0: s, vv0: materialize() }
      return
    }
    if (e.button !== 0) return
    const hit = hitCurves(R, x, y, sel, fps)
    if ((!hit || hit.kind === 'seg') && x >= width - VBAR_W && y >= TOP_PAD && y <= TOP_PAD + plotH) {
      onBarDown(e, y - TOP_PAD)
      return
    }
    if (hit?.kind === 'tan') {
      if (readOnly) return
      const base = new Map<string, TunerAnimKey[]>()
      const targets = new Map<string, number[]>()
      for (const c of R.chans) {
        const idx: number[] = []
        c.keys.forEach((k, i) => {
          if (sel.has(selId(c.id, frameOf(k.t, fps))) && sideEditable(c.keys, i, hit.side)) idx.push(i)
        })
        if (c.id === hit.c.id && !idx.includes(hit.i)) idx.push(hit.i)
        if (idx.length === 0) continue
        base.set(c.id, c.keys.map(cloneKey))
        targets.set(c.id, idx)
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      gestureRef.current = { kind: 'tan', id: hit.c.id, i: hit.i, side: hit.side, base, targets, moved: false, sent: false }
      return
    }
    if (hit?.kind === 'key') {
      const id = selId(hit.c.id, frameOf(hit.c.keys[hit.i].t, fps))
      const toggle = e.metaKey || e.ctrlKey
      if (toggle) {
        const next = new Set(sel)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        props.onSelect(next)
        return
      }
      let cur: Set<string>
      if (e.shiftKey) cur = new Set([...sel, id])
      else if (!sel.has(id)) cur = new Set([id])
      else cur = new Set(sel)
      if (cur.size !== sel.size || !sel.has(id)) props.onSelect(cur)
      const click = !e.shiftKey && sel.has(id) && sel.size > 1 ? id : null
      const g = startKeyDrag(x, y, hit.c, hit.i, cur, click)
      if (!g) return
      e.currentTarget.setPointerCapture(e.pointerId)
      gestureRef.current = g
      return
    }
    const add = e.shiftKey || e.metaKey || e.ctrlKey
    e.currentTarget.setPointerCapture(e.pointerId)
    gestureRef.current = { kind: 'marquee', x0: x, y0: y, base: add ? new Set(sel) : new Set(), add, moved: false }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const [x, y] = local(e)
    pointerRef.current = { x, y }
    const g = gestureRef.current
    if (!g) {
      const hit = hitCurves(region(), x, y, sel, fps)
      const bar = (!hit || hit.kind === 'seg') && x >= width - VBAR_W && y >= TOP_PAD && y <= TOP_PAD + plotH
      setHover(bar ? null : { hit, x, y })
      if (bar) e.currentTarget.setAttribute('data-ti-tip', 'Drag to scroll the values, or drag an end of the bar to zoom. Double-click fits every curve.')
      else e.currentTarget.removeAttribute('data-ti-tip')
      const by = y - TOP_PAD
      e.currentTarget.style.cursor = bar ? (Math.abs(by - thumbY) <= VBAR_EDGE || Math.abs(by - (thumbY + thumbH)) <= VBAR_EDGE ? 'ns-resize' : 'default') : hit && hit.kind !== 'seg' ? 'pointer' : 'default'
      return
    }
    if (g.kind === 'vbar') {
      onBarMove(e.clientY)
      return
    }
    if (g.kind === 'keys') {
      if (!g.moved && Math.hypot(x - g.x0, y - g.y0) < CLICK_PX) return
      if (!g.moved) {
        g.moved = true
        beginDrag()
        setHover(null)
      }
      statsRef.current.moves++
      moveKeysTo(g, x, y, e.shiftKey)
      setDragInfo({ text: dragRef.current?.info ?? '', x, y })
      schedule()
      return
    }
    if (g.kind === 'tan') {
      if (!g.moved) {
        g.moved = true
        beginDrag()
        setHover(null)
      }
      statsRef.current.moves++
      moveTangentTo(g, x, y)
      setDragInfo({ text: dragRef.current?.info ?? '', x, y })
      schedule()
      return
    }
    if (g.kind === 'marquee') {
      if (!g.moved && Math.hypot(x - g.x0, y - g.y0) < CLICK_PX) return
      g.moved = true
      setMarquee({ x0: g.x0, y0: g.y0, x1: x, y1: y })
      const ids = curveKeysInRect(region(), fps, g.x0, g.y0, x, y)
      props.onSelect(new Set([...g.base, ...ids]))
      return
    }
    if (g.kind === 'pan') {
      props.onView(panView(g.s0, g.x0 - x))
      const dv = ((y - g.y0) / plotH) * (g.vv0.hi - g.vv0.lo)
      setVv({ lo: g.vv0.lo + dv, hi: g.vv0.hi + dv })
      return
    }
    if (g.kind === 'zoom') {
      props.onView(zoomView(g.s0, Math.exp(-(x - g.x0) * 0.01), g.x0, fps))
      const f = Math.exp((y - g.y0) * 0.01)
      const at = g.vv0.lo + ((TOP_PAD + plotH - g.y0) / plotH) * (g.vv0.hi - g.vv0.lo)
      setVv({ lo: at - (at - g.vv0.lo) * f, hi: at + (g.vv0.hi - at) * f })
    }
  }

  const onPointerUp = (): void => {
    const g = gestureRef.current
    gestureRef.current = null
    if (!g) return
    if (g.kind === 'vbar') {
      setBarDrag(false)
      return
    }
    if (g.kind === 'keys' || g.kind === 'tan') {
      if (g.moved) finishDrag(g)
      else if (g.kind === 'keys' && g.click) props.onSelect(new Set([g.click]))
      schedule()
      return
    }
    if (g.kind === 'marquee') {
      setMarquee(null)
      if (!g.moved && !g.add) props.onSelect(new Set())
    }
  }

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    e.preventDefault()
    if (e.altKey) return
    const [x, y] = local(e)
    const R = region()
    const hit = hitCurves(R, x, y, sel, fps)
    if (hit && (hit.kind === 'key' || hit.kind === 'tan')) {
      const id = selId(hit.c.id, frameOf(hit.c.keys[hit.i].t, fps))
      const cur = sel.has(id) ? new Set(sel) : new Set([id])
      if (!sel.has(id)) props.onSelect(cur)
      props.onContext(e, { kind: 'key', ids: cur, clicked: id })
      return
    }
    if (hit?.kind === 'seg') {
      const a = hit.c.keys[hit.i]
      const b = hit.c.keys[hit.i + 1]
      const t = Math.max(0, Math.round(hit.t * fps)) / fps
      props.onContext(e, { kind: 'seg', id: hit.c.id, name: hit.c.label, fa: frameOf(a.t, fps), fb: frameOf(b.t, fps), t, v: evalKeys(hit.c.keys, t) })
      return
    }
    props.onContext(e, { kind: 'empty' })
  }

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const [x, y] = local(e)
    const hit = hitCurves(region(), x, y, sel, fps)
    if ((!hit || hit.kind === 'seg') && x >= width - VBAR_W) {
      setVv(null)
      return
    }
    if (readOnly) return
    if (hit?.kind !== 'seg') return
    const t = Math.max(0, Math.round(hit.t * fps)) / fps
    props.onAddKey(hit.c.id, t, evalKeys(hit.c.keys, t))
  }

  const total: ValueView = { lo: Math.min(fitAll.lo, view.lo), hi: Math.max(fitAll.hi, view.hi) }
  const barH = Math.max(1, plotH)
  const tspan = Math.max(1e-9, total.hi - total.lo)
  const thumbH = Math.min(barH, Math.max(16, ((view.hi - view.lo) / tspan) * barH))
  const thumbY = Math.max(0, Math.min(barH - thumbH, ((total.hi - view.hi) / tspan) * barH))

  const onBarDown = (e: React.PointerEvent<HTMLCanvasElement>, y: number): void => {
    const mode = Math.abs(y - thumbY) <= VBAR_EDGE ? 'top' : Math.abs(y - (thumbY + thumbH)) <= VBAR_EDGE ? 'bottom' : y > thumbY && y < thumbY + thumbH ? 'pan' : 'jump'
    let vv0 = view
    if (mode === 'jump') {
      const span = view.hi - view.lo
      const center = total.hi - (y / barH) * tspan
      vv0 = { lo: center - span / 2, hi: center + span / 2 }
      setVv(vv0)
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    gestureRef.current = { kind: 'vbar', mode: mode === 'jump' ? 'pan' : mode, y0: e.clientY, vv0, total, barH }
    setBarDrag(true)
  }

  const onBarMove = (clientY: number): void => {
    const g = gestureRef.current
    if (!g || g.kind !== 'vbar') return
    const dv = ((clientY - g.y0) / g.barH) * (g.total.hi - g.total.lo)
    const minSpan = Math.max(1e-6, (g.total.hi - g.total.lo) * 0.002)
    if (g.mode === 'pan') setVv({ lo: g.vv0.lo - dv, hi: g.vv0.hi - dv })
    else if (g.mode === 'top') setVv({ lo: g.vv0.lo, hi: Math.max(g.vv0.lo + minSpan, g.vv0.hi - dv) })
    else setVv({ lo: Math.min(g.vv0.hi - minSpan, g.vv0.lo - dv), hi: g.vv0.hi })
  }

  const tip = !dragInfo && hover ? tipOf(hover) : null
  const n = chans.length
  const empty = n === 0
  const floatX = (x: number, w: number): number => (x + 14 + w > width - VBAR_W ? Math.max(4, x - w - 10) : x + 14)

  return (
    <div
      ref={boxRef}
      data-anim-curves
      data-curves-count={n}
      data-curves-norm={normalize ? 'on' : 'off'}
      data-curves-vv={`${view.lo.toFixed(4)}:${view.hi.toFixed(4)}`}
      data-curves-plot={`${TOP_PAD}:${plotH}`}
      className="relative shrink-0 select-none"
      style={{ width, height }}
    >
      <canvas
        ref={canvasRef}
        data-anim-curves-canvas
        className="block touch-none"
        style={{ width, height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          if (!gestureRef.current) setHover(null)
        }}
        onContextMenu={onContextMenu}
        onDoubleClick={onDoubleClick}
      />
      {marquee && (
        <div
          data-anim-curves-marquee
          className="pointer-events-none absolute border border-dashed border-accent bg-accent/15"
          style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
        />
      )}
      <div className="absolute right-[14px] top-1 flex items-center gap-1 text-[10px]">
        <span className="pointer-events-none rounded bg-panel/80 px-1 text-ink-3" data-anim-curves-info>
          {empty ? '' : `${n} curve${n === 1 ? '' : 's'} · ${props.why === 'all' ? 'all rows' : 'selected rows'}${normalize ? ' · normalized' : ''}`}
        </span>
        <button
          type="button"
          data-anim-btn="normalize"
          aria-pressed={normalize}
          disabled={empty}
          onClick={() => props.onNormalize(!normalize)}
          data-ti-tip="Scales each curve into -1 to 1 so you can compare curves with very different ranges. Unity has no such view, and the keys keep their real values."
          className={`h-[18px] rounded border px-1.5 transition-colors disabled:opacity-40 ${normalize ? 'border-accent bg-accent/20 text-ink' : 'border-hairline bg-panel/80 text-ink-2 hover:text-ink'}`}
        >
          Normalize
        </button>
        <button type="button" data-anim-btn="curves-all" disabled={empty} onClick={showAll} data-ti-tip="Show all curves (A)" className="h-[18px] w-[18px] rounded border border-hairline bg-panel/80 text-ink-2 hover:text-ink disabled:opacity-40">
          A
        </button>
        <button type="button" data-anim-btn="curves-frame" disabled={empty} onClick={frameSelection} data-ti-tip="Frame the selected keys (F)" className="h-[18px] w-[18px] rounded border border-hairline bg-panel/80 text-ink-2 hover:text-ink disabled:opacity-40">
          F
        </button>
      </div>
      {empty && (
        <div data-anim-curves-empty className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-ink-3">
          {props.why === 'rows' ? 'None of the selected rows has a curve. Click Summary to see all of them.' : 'This clip has no curves yet. Use Add Property to start one.'}
        </div>
      )}
      {!empty && (
        <div data-anim-vbar className="pointer-events-none absolute right-0" style={{ top: TOP_PAD, height: barH, width: VBAR_W }}>
          <div className="pointer-events-none absolute bottom-0 left-[2px] right-[2px] top-0 rounded-full" style={{ background: 'color-mix(in srgb, var(--ink) 5%, transparent)' }} />
          <div
            data-anim-vbar-thumb
            className="pointer-events-none absolute left-[2px] right-[2px] rounded-full transition-colors"
            style={{ top: thumbY, height: thumbH, background: barDrag ? 'color-mix(in srgb, var(--accent) 70%, transparent)' : 'color-mix(in srgb, var(--ink) 30%, transparent)' }}
          />
        </div>
      )}
      {tip && hover && (
        <FloatingTip origin={boxRef} x={hover.x + 14} y={hover.y + 16} attrs={{ 'data-anim-curves-tip': '' }} className="surface-overlay rounded px-2 py-1 text-[10px] leading-snug text-ink-2">
          <div className="font-medium text-ink">{tip.title}</div>
          <div className="text-ink-3">{tip.body}</div>
        </FloatingTip>
      )}
      {dragInfo && (
        <div data-anim-curves-drag className="surface-overlay pointer-events-none absolute z-30 rounded px-2 py-0.5 text-[10px] tabular-nums text-ink" style={{ left: floatX(dragInfo.x, 240), top: Math.max(2, dragInfo.y - 26) }}>
          {dragInfo.text}
        </div>
      )}
      {hover && !dragInfo && (
        <div className="pointer-events-none absolute bottom-0.5 left-1 rounded bg-panel/80 px-1 text-[10px] tabular-nums text-ink-3" data-anim-curves-readout>
          frame {fmt(tOf(s, hover.x) * fps, 1)} · {normalize ? 'normalized ' : 'value '}
          {fmt(pAt({ y: TOP_PAD, h: plotH, ts: s, vv: view, chans: [] }, hover.y))}
        </div>
      )}
    </div>
  )
})
