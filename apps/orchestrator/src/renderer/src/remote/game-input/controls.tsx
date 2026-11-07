import { useEffect, useRef, useState } from 'react'
import { RC_PAD_WIRE, type RcControl, type RcOutput, type RcPlace, type RcTrackpadEff } from '@shared/remote-controls'
import { fitLabel, maxSize, snapSize, type FrRect, type FrSpot } from '@shared/remote-frame'
import { moveBy, own, press, release, setStick, wheel, type GiTarget } from './link'
import { capture, haptic, toLocal } from './geometry'

const DEAD = 0.25
const DIAG = 0.383
const PAD_DEAD = 0.06
const AIM_SLOP = 12
const LOOK_K = 2.5
const ZONE = 1.6

export function targetsOf(o: RcOutput): GiTarget[] {
  switch (o.type) {
    case 'key':
      return [{ t: 'key', key: o.key }]
    case 'chord':
      return o.keys.map((key) => ({ t: 'key', key }))
    case 'mouse':
      return [{ t: 'mouse', b: o.button }]
    case 'wheel':
      return [{ t: 'wheel', dir: o.dir }]
    case 'gamepad':
      if ('button' in o) return [{ t: 'pad', b: RC_PAD_WIRE[o.button] }]
      if ('trigger' in o) return [{ t: 'pad', b: o.trigger === 'left' ? 'LeftTrigger' : 'RightTrigger' }]
      return []
    default:
      return []
  }
}

export function down(ts: GiTarget[]): void {
  for (const t of ts) press(t)
}

export function up(ts: GiTarget[]): void {
  for (let i = ts.length - 1; i >= 0; i--) if (ts[i].t !== 'wheel') release(ts[i])
}

function dirKeys(vx: number, vy: number, k: { up?: string; down?: string; left?: string; right?: string }): string[] {
  const len = Math.hypot(vx, vy)
  if (len < DEAD) return []
  const nx = vx / len
  const ny = vy / len
  const out: string[] = []
  if (ny > DIAG && k.up) out.push(k.up)
  if (ny < -DIAG && k.down) out.push(k.down)
  if (nx > DIAG && k.right) out.push(k.right)
  if (nx < -DIAG && k.left) out.push(k.left)
  return out
}

function Label({ text, hint, width, max = 13 }: { text: string; hint: string; width: number; max?: number }): React.JSX.Element {
  const f = fitLabel(text, width, max)
  return (
    <span className="gi-label" style={{ fontSize: f.font }} data-gi-lines={f.lines.length}>
      {f.lines.map((l, i) => (
        <span key={i}>{l}</span>
      ))}
      {hint ? <small>{hint}</small> : null}
    </span>
  )
}

interface StickTouch {
  id: number
  bx: number
  by: number
  r: number
  held: GiTarget[]
}

export interface ControlsProps {
  controls: RcControl[]
  spots: Record<string, FrSpot>
  area: FrRect
  R: number
  mode: 'play' | 'preview' | 'edit'
  selected: string | null
  onSelect: (id: string | null) => void
  onPlace: (c: RcControl, place: RcPlace, commit: boolean) => void
  fixed: Set<string>
  look: boolean
  tp: RcTrackpadEff
}

export function Controls(p: ControlsProps): React.JSX.Element {
  const { controls, spots, area, R, mode, selected, onSelect, onPlace, fixed, look, tp } = p
  const editing = mode === 'edit'
  const [latched, setLatched] = useState<Set<string>>(() => new Set())
  const [active, setActive] = useState<Set<string>>(() => new Set())
  const latchRef = useRef(new Map<string, GiTarget[]>())
  const pressed = useRef(new Map<number, { id: string; ts: GiTarget[] }>())
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const sticks = useRef(new Map<string, StickTouch>())
  const [stickView, setStickView] = useState<Record<string, { bx: number; by: number; r: number }>>({})
  const knobs = useRef(new Map<string, HTMLDivElement>())
  const axisHeld = useRef(new Map<number, { id: string; key: string | null }>())
  const aim = useRef(new Map<number, { x: number; y: number; sx: number; sy: number; on: boolean }>())

  const releaseAllHere = (): void => {
    for (const ts of latchRef.current.values()) up(ts)
    latchRef.current.clear()
    for (const v of pressed.current.values()) up(v.ts)
    pressed.current.clear()
    for (const t of timers.current) clearTimeout(t)
    timers.current.clear()
    for (const [id, s] of sticks.current) {
      up(s.held)
      const c = controls.find((x) => x.id === id)
      if (c?.output?.type === 'gamepad' && 'stick' in c.output && c.output.stick !== 'dpad') setStick(c.output.stick === 'left' ? 'l' : 'r', 0, 0)
    }
    sticks.current.clear()
    for (const a of axisHeld.current.values()) if (a.key) release({ t: 'key', key: a.key })
    axisHeld.current.clear()
  }

  useEffect(() => () => releaseAllHere(), [])

  const ids = `${mode}|${controls.map((c) => `${c.id}:${JSON.stringify(c.output)}:${c.behavior}`).join('|')}`
  const lastIds = useRef(ids)
  useEffect(() => {
    if (lastIds.current === ids) return
    lastIds.current = ids
    releaseAllHere()
    setLatched(new Set())
    setActive(new Set())
    setStickView({})
  }, [ids])

  const flag = (id: string, on: boolean): void =>
    setActive((s) => {
      const n = new Set(s)
      if (on) n.add(id)
      else n.delete(id)
      return n
    })

  const later = (ms: number, fn: () => void): void => {
    const t = setTimeout(() => {
      timers.current.delete(t)
      fn()
    }, ms)
    timers.current.add(t)
  }

  const local = toLocal

  const buttonDown = (c: RcControl, e: React.PointerEvent<HTMLButtonElement>): void => {
    e.stopPropagation()
    own(e.pointerId, true)
    capture(e.currentTarget, e.pointerId)
    const o = c.output
    if (!o) return
    const ts = targetsOf(o)
    haptic()
    const q = local(e, e.currentTarget)
    aim.current.set(e.pointerId, { x: q.x, y: q.y, sx: q.x, sy: q.y, on: false })
    if (o.type === 'wheel') {
      wheel(o.dir)
      flag(c.id, true)
      later(120, () => flag(c.id, false))
      return
    }
    if (c.behavior === 'toggle') {
      const cur = latchRef.current
      if (cur.has(c.id)) {
        up(cur.get(c.id)!)
        cur.delete(c.id)
      } else {
        down(ts)
        cur.set(c.id, ts)
      }
      console.info(`[game-input] ${c.label} toggled ${cur.has(c.id) ? 'on' : 'off'}`)
      setLatched(new Set(cur.keys()))
      return
    }
    if (c.behavior === 'tap' || c.behavior === 'multiTap') {
      const n = c.behavior === 'multiTap' ? Math.max(1, c.taps) : 1
      const ms = Math.max(30, c.tapMs || 60)
      flag(c.id, true)
      for (let i = 0; i < n; i++) {
        later(i * ms * 2.5, () => down(ts))
        later(i * ms * 2.5 + ms, () => up(ts))
      }
      later((n - 1) * ms * 2.5 + ms + 40, () => flag(c.id, false))
      console.info(`[game-input] ${c.label} ${n > 1 ? `${n} taps` : 'tap'}`)
      return
    }
    pressed.current.set(e.pointerId, { id: c.id, ts })
    down(ts)
    flag(c.id, true)
  }

  const buttonMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const a = aim.current.get(e.pointerId)
    if (!a || !look) return
    const q = local(e, e.currentTarget)
    if (!a.on && Math.hypot(q.x - a.sx, q.y - a.sy) > AIM_SLOP) a.on = true
    if (a.on) moveBy((q.x - a.x) * LOOK_K * tp.lookSpeed * tp.speed, (q.y - a.y) * LOOK_K * tp.lookSpeed * tp.speed * (tp.invertY ? -1 : 1))
    a.x = q.x
    a.y = q.y
  }

  const buttonUp = (c: RcControl, e: React.PointerEvent<HTMLButtonElement>): void => {
    e.stopPropagation()
    own(e.pointerId, false)
    aim.current.delete(e.pointerId)
    const p = pressed.current.get(e.pointerId)
    if (!p) return
    pressed.current.delete(e.pointerId)
    up(p.ts)
    flag(c.id, false)
  }

  const driveStick = (c: RcControl, s: StickTouch, vx: number, vy: number): void => {
    const o = c.output
    if (!o) return
    if (o.type === 'gamepad' && 'stick' in o && o.stick !== 'dpad') {
      const side = o.stick === 'left' ? 'l' : 'r'
      if (Math.hypot(vx, vy) < PAD_DEAD) setStick(side, 0, 0)
      else setStick(side, Math.round(vx * 1000) / 1000, Math.round(vy * 1000) / 1000)
      return
    }
    let want: GiTarget[] = []
    if (o.type === 'keys' && ('up' in o || 'down' in o || 'left' in o || 'right' in o)) want = dirKeys(vx, vy, o as { up?: string }).map((key) => ({ t: 'key', key }))
    else if (o.type === 'gamepad' && 'stick' in o) want = dirKeys(vx, vy, { up: 'DpadUp', down: 'DpadDown', left: 'DpadLeft', right: 'DpadRight' }).map((b) => ({ t: 'pad', b }))
    const key = (t: GiTarget): string => (t.t === 'key' ? `k${t.key}` : t.t === 'pad' ? `p${t.b}` : '')
    const wantK = new Set(want.map(key))
    const heldK = new Set(s.held.map(key))
    for (const t of want) if (!heldK.has(key(t))) press(t)
    for (const t of s.held) if (!wantK.has(key(t))) release(t)
    if (want.map(key).join() !== s.held.map(key).join()) console.info(`[game-input] ${c.label} stick ${want.map(key).join(' ') || 'center'}`)
    s.held = want
  }

  const stickDown = (c: RcControl, e: React.PointerEvent<HTMLDivElement>): void => {
    e.stopPropagation()
    own(e.pointerId, true)
    if (sticks.current.has(c.id)) return
    capture(e.currentTarget, e.pointerId)
    const r = R * (spots[c.id]?.size ?? 1)
    const q = local(e, e.currentTarget)
    const bx = Math.min(area.x + area.w - r, Math.max(area.x + r, q.x))
    const by = Math.min(area.y + area.h - r, Math.max(area.y + r, q.y))
    const s: StickTouch = { id: e.pointerId, bx, by, r, held: [] }
    sticks.current.set(c.id, s)
    setStickView((v) => ({ ...v, [c.id]: { bx, by, r } }))
    stickMove(c, e)
  }

  const stickMove = (c: RcControl, e: React.PointerEvent<HTMLDivElement>): void => {
    const s = sticks.current.get(c.id)
    if (!s || s.id !== e.pointerId) return
    const q = local(e, e.currentTarget)
    let dx = q.x - s.bx
    let dy = q.y - s.by
    const len = Math.hypot(dx, dy)
    if (len > s.r) {
      const over = len - s.r
      s.bx += (dx / len) * over
      s.by += (dy / len) * over
      dx = q.x - s.bx
      dy = q.y - s.by
      setStickView((v) => ({ ...v, [c.id]: { bx: s.bx, by: s.by, r: s.r } }))
    }
    const k = knobs.current.get(c.id)
    if (k) k.style.transform = `translate(${dx}px, ${dy}px)`
    driveStick(c, s, dx / s.r, -dy / s.r)
  }

  const stickUp = (c: RcControl, e: React.PointerEvent<HTMLDivElement>): void => {
    e.stopPropagation()
    own(e.pointerId, false)
    const s = sticks.current.get(c.id)
    if (!s || s.id !== e.pointerId) return
    driveStick(c, s, 0, 0)
    sticks.current.delete(c.id)
    setStickView((v) => {
      const n = { ...v }
      delete n[c.id]
      return n
    })
  }

  const axisKeyAt = (c: RcControl, e: React.PointerEvent<HTMLDivElement>): string | null => {
    const o = c.output as { negative?: string; positive?: string } | null
    if (!o) return null
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientX < r.left + r.width / 2 ? o.negative ?? null : o.positive ?? null
  }

  const axisDown = (c: RcControl, e: React.PointerEvent<HTMLDivElement>): void => {
    e.stopPropagation()
    own(e.pointerId, true)
    capture(e.currentTarget, e.pointerId)
    const key = axisKeyAt(c, e)
    axisHeld.current.set(e.pointerId, { id: c.id, key })
    if (key) press({ t: 'key', key })
    flag(`${c.id}:${key}`, true)
    haptic()
  }

  const axisMove = (c: RcControl, e: React.PointerEvent<HTMLDivElement>): void => {
    const h = axisHeld.current.get(e.pointerId)
    if (!h) return
    const key = axisKeyAt(c, e)
    if (key === h.key) return
    if (h.key) release({ t: 'key', key: h.key })
    flag(`${c.id}:${h.key}`, false)
    h.key = key
    if (key) press({ t: 'key', key })
    flag(`${c.id}:${key}`, true)
  }

  const axisUp = (c: RcControl, e: React.PointerEvent<HTMLDivElement>): void => {
    e.stopPropagation()
    own(e.pointerId, false)
    const h = axisHeld.current.get(e.pointerId)
    if (!h) return
    axisHeld.current.delete(e.pointerId)
    if (h.key) release({ t: 'key', key: h.key })
    flag(`${c.id}:${h.key}`, false)
  }

  const play = mode === 'play'
  const cls = (c: RcControl): string => `${editing ? 'gi-edit' : ''} ${selected === c.id ? 'gi-selected' : ''}`

  return (
    <div className={`gi-controls ${mode === 'preview' ? 'gi-preview' : ''}`} data-gi-controls={mode}>
      {controls.map((c) => {
        const s = spots[c.id]
        if (!s || c.kind === 'pointer') return null
        const { cx, cy, rect } = s
        if (c.kind === 'stick') {
          const r = rect.w / 2
          const z = play ? r * ZONE : r
          const zx = Math.max(area.x, cx - z)
          const zy = Math.max(area.y, cy - z)
          const zone = { x: zx, y: zy, w: Math.min(area.x + area.w, cx + z) - zx, h: Math.min(area.y + area.h, cy + z) - zy }
          const v = stickView[c.id]
          return (
            <div key={c.id}>
              <div
                className={`gi-stick-zone absolute ${cls(c)}`}
                style={{ left: zone.x, top: zone.y, width: zone.w, height: zone.h }}
                data-gi-item={c.id}
                data-gi-kind="stick"
                data-gi-label={c.label}
                data-gi-rect={`${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`}
                onPointerDown={play ? (e) => stickDown(c, e) : undefined}
                onPointerMove={play ? (e) => stickMove(c, e) : undefined}
                onPointerUp={play ? (e) => stickUp(c, e) : undefined}
                onPointerCancel={play ? (e) => stickUp(c, e) : undefined}
              >
                <div className={`gi-stick-rest absolute ${v ? 'opacity-0' : ''}`} style={{ left: cx - r - zone.x, top: cy - r - zone.y, width: r * 2, height: r * 2 }}>
                  <Label text={c.label} hint={c.hint} width={r * 1.1} max={12} />
                </div>
              </div>
              {v && (
                <div className="gi-stick pointer-events-none absolute" style={{ left: v.bx - v.r, top: v.by - v.r, width: v.r * 2, height: v.r * 2 }} data-gi-stick={c.id}>
                  <div
                    ref={(el) => {
                      if (el) knobs.current.set(c.id, el)
                      else knobs.current.delete(c.id)
                    }}
                    className="gi-knob"
                    style={{ width: v.r * 0.84, height: v.r * 0.84, left: v.r * 0.58, top: v.r * 0.58 }}
                  />
                </div>
              )}
            </div>
          )
        }
        if (c.kind === 'axis') {
          const o = (c.output ?? {}) as { negative?: string; positive?: string }
          return (
            <div
              key={c.id}
              className={`gi-axis absolute ${cls(c)}`}
              style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
              data-gi-item={c.id}
              data-gi-kind="axis"
              data-gi-label={c.label}
              data-gi-rect={`${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`}
              onPointerDown={play ? (e) => axisDown(c, e) : undefined}
              onPointerMove={play ? (e) => axisMove(c, e) : undefined}
              onPointerUp={play ? (e) => axisUp(c, e) : undefined}
              onPointerCancel={play ? (e) => axisUp(c, e) : undefined}
            >
              <span className={`gi-axis-half ${active.has(`${c.id}:${o.negative}`) ? 'gi-on' : ''}`}>−</span>
              <Label text={c.label} hint={c.hint} width={rect.w * 0.4} max={12} />
              <span className={`gi-axis-half ${active.has(`${c.id}:${o.positive}`) ? 'gi-on' : ''}`}>+</span>
            </div>
          )
        }
        const on = latched.has(c.id) || active.has(c.id)
        return (
          <button
            key={c.id}
            type="button"
            tabIndex={-1}
            className={`gi-button absolute ${on ? 'gi-on' : ''} ${cls(c)}`}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, ['--gi-hold' as string]: `${Math.max(1, c.holdMs)}ms` }}
            data-gi-item={c.id}
            data-gi-kind="button"
            data-gi-label={c.label}
            data-gi-behavior={c.behavior}
            data-gi-rect={`${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`}
            data-gi-holding={c.behavior === 'hold' && active.has(c.id) ? '1' : undefined}
            onPointerDown={play ? (e) => buttonDown(c, e) : undefined}
            onPointerMove={play ? buttonMove : undefined}
            onPointerUp={play ? (e) => buttonUp(c, e) : undefined}
            onPointerCancel={play ? (e) => buttonUp(c, e) : undefined}
          >
            {c.behavior === 'hold' && c.holdMs > 0 && (
              <svg className="gi-hold-ring pointer-events-none absolute inset-0" viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="16.5" pathLength="100" />
              </svg>
            )}
            <Label text={c.label} hint={`${c.hint}${c.behavior === 'toggle' ? ' ⇄' : c.behavior === 'multiTap' ? ` ×${c.taps}` : ''}`} width={rect.w * 0.86} />
          </button>
        )
      })}
      {editing && <EditSurface controls={controls} spots={spots} area={area} selected={selected} onSelect={onSelect} onPlace={onPlace} fixed={fixed} />}
    </div>
  )
}

interface Gesture {
  id: string
  mode: 'drag' | 'pinch'
  ox: number
  oy: number
  sx: number
  sy: number
  moved: boolean
  d0: number
  s0: number
  size: number
  limit: number
}

function EditSurface({ controls, spots, area, selected, onSelect, onPlace, fixed }: { controls: RcControl[]; spots: Record<string, FrSpot>; area: FrRect; selected: string | null; onSelect: (id: string | null) => void; onPlace: (c: RcControl, place: RcPlace, commit: boolean) => void; fixed: Set<string> }): React.JSX.Element {
  const pts = useRef(new Map<number, { x: number; y: number }>())
  const g = useRef<Gesture | null>(null)
  const tapEmpty = useRef(false)
  const live = useRef({ controls, spots, selected })
  live.current = { controls, spots, selected }

  const local = (e: React.PointerEvent): { x: number; y: number } => toLocal(e, e.currentTarget)
  const byId = (id: string): RcControl | undefined => live.current.controls.find((c) => c.id === id)
  const hit = (q: { x: number; y: number }, slack: number): string | null => {
    let best: string | null = null
    let bestD = Infinity
    for (const [id, s] of Object.entries(live.current.spots)) {
      const r = s.rect
      const dx = Math.max(r.x - q.x, 0, q.x - r.x - r.w)
      const dy = Math.max(r.y - q.y, 0, q.y - r.y - r.h)
      const d = Math.hypot(dx, dy)
      if (d <= slack && d < bestD) {
        best = id
        bestD = d
      }
    }
    return best
  }
  const norm = (cx: number, cy: number): { x: number; y: number } => ({
    x: Math.round(Math.min(1, Math.max(0, (cx - area.x) / area.w)) * 1000) / 1000,
    y: Math.round(Math.min(1, Math.max(0, (cy - area.y) / area.h)) * 1000) / 1000
  })

  const startPinch = (): void => {
    const [a, b] = [...pts.current.values()]
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const id = g.current?.id ?? live.current.selected ?? hit(a, 24) ?? hit(b, 24) ?? hit(mid, 80)
    const s = id ? live.current.spots[id] : null
    const c = id ? byId(id) : null
    if (!id || !s || !c) return
    const others = Object.entries(live.current.spots)
      .filter(([k]) => k !== id && fixed.has(k))
      .map(([, v]) => ({ rect: v.rect, round: v.round }))
    const limit = maxSize(c.kind as 'stick' | 'axis' | 'button', s.cx, s.cy, 2, area, others)
    g.current = { id, mode: 'pinch', ox: 0, oy: 0, sx: s.cx, sy: s.cy, moved: true, d0: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)), s0: s.size, size: s.size, limit }
    onSelect(id)
    console.info(`[game-input] pinch start ${c.label} size=${s.size} limit=${limit}`)
  }

  const onDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.stopPropagation()
    capture(e.currentTarget, e.pointerId)
    const q = local(e)
    pts.current.set(e.pointerId, q)
    if (pts.current.size === 1) {
      const id = hit(q, 6)
      tapEmpty.current = !id
      if (!id) {
        g.current = null
        return
      }
      const s = live.current.spots[id]
      g.current = { id, mode: 'drag', ox: q.x - s.cx, oy: q.y - s.cy, sx: q.x, sy: q.y, moved: false, d0: 0, s0: s.size, size: s.size, limit: 2 }
      onSelect(id)
      return
    }
    tapEmpty.current = false
    if (pts.current.size === 2) startPinch()
  }

  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!pts.current.has(e.pointerId)) return
    const q = local(e)
    pts.current.set(e.pointerId, q)
    const cur = g.current
    if (!cur) return
    const c = byId(cur.id)
    if (!c) return
    if (cur.mode === 'drag' && pts.current.size === 1) {
      if (!cur.moved && Math.hypot(q.x - cur.sx, q.y - cur.sy) < 5) return
      cur.moved = true
      onPlace(c, { ...norm(q.x - cur.ox, q.y - cur.oy), size: cur.s0 }, false)
      return
    }
    if (cur.mode === 'pinch' && pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()]
      const want = (cur.s0 * Math.hypot(a.x - b.x, a.y - b.y)) / cur.d0
      cur.size = Math.round(Math.min(cur.limit, Math.max(0.7, want)) * 100) / 100
      onPlace(c, { ...norm(cur.sx, cur.sy), size: cur.size }, false)
    }
  }

  const onUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.stopPropagation()
    if (!pts.current.delete(e.pointerId)) return
    const cur = g.current
    const c = cur ? byId(cur.id) : undefined
    if (cur && c && cur.mode === 'pinch' && pts.current.size < 2) {
      const size = snapSize(cur.size, cur.limit)
      onPlace(c, { ...norm(cur.sx, cur.sy), size }, true)
      console.info(`[game-input] pinch end ${c.label} size=${size}`)
      g.current = null
      return
    }
    if (cur && c && cur.mode === 'drag' && pts.current.size === 0) {
      const s = live.current.spots[cur.id]
      if (cur.moved && s) onPlace(c, { x: s.x, y: s.y, size: s.size }, true)
      g.current = null
      return
    }
    if (pts.current.size === 0 && tapEmpty.current) onSelect(null)
  }

  return (
    <div
      className="gi-edit-surface absolute"
      style={{ left: area.x, top: area.y, width: area.w, height: area.h }}
      data-gi-edit-surface
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
  )
}
