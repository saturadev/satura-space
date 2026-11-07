import { useEffect, useRef, useState } from 'react'
import type { RcTrackpadEff } from '@shared/remote-controls'
import type { FrRect } from '@shared/remote-frame'
import { click, moveBy, ownedByControl, pointer, pressMouse, release, setPointer, wheel } from './link'
import { capture, haptic } from './geometry'

const TAP_MS = 230
const SLOP = 9
const HOLD_MS = 380
const DOUBLE_MS = 300
const DOUBLE_SLOP = 48
const WHEEL_PX = 28
const LOOK_K = 2.5

type Mode = 'idle' | 'pending' | 'move' | 'drag' | 'two' | 'three'

interface Pt {
  x: number
  y: number
  sx: number
  sy: number
  at: number
}

export function gain(tp: RcTrackpadEff, speedPxMs: number): number {
  return tp.speed * (0.6 + tp.acceleration * Math.min(3, 1.8 * Math.pow(Math.max(0, speedPxMs), 1.2)))
}

export function Trackpad({ video, vw, vh, locked, tp, onUse }: { video: FrRect; vw: number; vh: number; locked: boolean; tp: RcTrackpadEff; onUse: () => void }): React.JSX.Element {
  const pts = useRef(new Map<number, Pt>())
  const g = useRef({ mode: 'idle' as Mode, start: 0, hold: 0 as ReturnType<typeof setTimeout> | 0, lastTapAt: 0, lastTapX: 0, lastTapY: 0, dbl: false, moved: false, cy: 0, wheelAcc: 0, speed: 0 })
  const [cursor, setCursor] = useState(() => pointer())
  const [dragging, setDragging] = useState(false)
  const lockedRef = useRef(locked)
  lockedRef.current = locked
  const tpRef = useRef(tp)
  tpRef.current = tp
  const videoRef = useRef(video)
  videoRef.current = video

  useEffect(
    () => () => {
      const s = g.current
      if (s.hold) clearTimeout(s.hold)
      if (s.mode === 'drag') release({ t: 'mouse', b: 0 })
    },
    []
  )

  const centroidY = (): number => {
    let y = 0
    for (const p of pts.current.values()) y += p.y
    return pts.current.size ? y / pts.current.size : 0
  }

  const startDrag = (count: number, why: string): void => {
    const s = g.current
    s.mode = 'drag'
    pressMouse(0, count)
    setDragging(true)
    haptic()
    console.info(`[game-input] trackpad drag start (${why})`)
  }

  const down = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (ownedByControl(e.pointerId) || document.elementsFromPoint(e.clientX, e.clientY).some((el) => el.closest('[data-gi-item]'))) {
      console.info(`[game-input] trackpad ignores touch ${e.pointerId}: a control owns it`)
      return
    }
    capture(e.currentTarget, e.pointerId)
    onUse()
    const now = performance.now()
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, at: now })
    const s = g.current
    const n = pts.current.size
    if (n === 1) {
      s.start = now
      s.moved = false
      s.speed = 0
      s.wheelAcc = 0
      s.dbl = now - s.lastTapAt < DOUBLE_MS && Math.hypot(e.clientX - s.lastTapX, e.clientY - s.lastTapY) < DOUBLE_SLOP
      if (s.dbl) {
        startDrag(2, 'double tap')
        return
      }
      s.mode = 'pending'
      s.hold = setTimeout(() => {
        s.hold = 0
        if (s.mode === 'pending' && pts.current.size === 1) startDrag(1, 'press and hold')
      }, HOLD_MS)
      return
    }
    if (s.hold) clearTimeout(s.hold)
    s.hold = 0
    if (s.mode === 'drag') return
    s.mode = n >= 3 ? 'three' : 'two'
    s.cy = centroidY()
    s.wheelAcc = 0
  }

  const moveCursor = (dx: number, dy: number, dt: number): void => {
    const s = g.current
    const v = Math.hypot(dx, dy) / Math.max(1, dt)
    s.speed = s.speed * 0.55 + v * 0.45
    const k = gain(tpRef.current, s.speed)
    if (lockedRef.current) {
      moveBy(dx * k * LOOK_K * tpRef.current.lookSpeed, dy * k * LOOK_K * tpRef.current.lookSpeed * (tpRef.current.invertY ? -1 : 1))
      return
    }
    const box = videoRef.current
    if (box.w <= 0 || box.h <= 0) return
    const p = pointer()
    const nx = Math.min(0.9999, Math.max(0, p.x + (dx * k) / box.w))
    const ny = Math.min(0.9999, Math.max(0, p.y + (dy * k) / box.h))
    setPointer(nx, ny, (nx - p.x) * vw, (ny - p.y) * vh)
    setCursor({ x: nx, y: ny, known: true })
  }

  const move = (e: React.PointerEvent<HTMLDivElement>): void => {
    const p = pts.current.get(e.pointerId)
    if (!p || ownedByControl(e.pointerId)) return
    const now = performance.now()
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    const dt = now - p.at
    p.x = e.clientX
    p.y = e.clientY
    p.at = now
    const s = g.current
    if (!s.moved && Math.hypot(p.x - p.sx, p.y - p.sy) > SLOP) {
      s.moved = true
      if (s.hold) clearTimeout(s.hold)
      s.hold = 0
      if (s.mode === 'pending') s.mode = 'move'
    }
    if (s.mode === 'two' || s.mode === 'three') {
      if (s.mode === 'three') return
      const cy = centroidY()
      const d = cy - s.cy
      s.cy = cy
      s.wheelAcc += (-d / WHEEL_PX) * (tpRef.current.naturalScroll ? -1 : 1)
      const step = Math.trunc(s.wheelAcc * 4) / 4
      if (step) {
        s.wheelAcc -= step
        wheel(step)
      }
      return
    }
    if (s.mode === 'move' || s.mode === 'drag') moveCursor(dx, dy, dt)
  }

  const up = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!pts.current.delete(e.pointerId)) return
    if (pts.current.size > 0) return
    const s = g.current
    if (s.hold) clearTimeout(s.hold)
    s.hold = 0
    const now = performance.now()
    const quick = now - s.start < TAP_MS + 120 && !s.moved
    const mode = s.mode
    s.mode = 'idle'
    if (mode === 'drag') {
      release({ t: 'mouse', b: 0 })
      setDragging(false)
      s.lastTapAt = 0
      console.info(`[game-input] trackpad drag end${s.dbl && !s.moved ? ' (double click)' : ''}`)
      return
    }
    if (mode === 'pending' && now - s.start < TAP_MS) {
      click(0)
      haptic()
      s.lastTapAt = now
      s.lastTapX = e.clientX
      s.lastTapY = e.clientY
      console.info('[game-input] trackpad tap: left click')
      return
    }
    if (mode === 'two' && quick) {
      click(1)
      haptic()
      console.info('[game-input] trackpad two-finger tap: right click')
      return
    }
    if (mode === 'three' && quick) {
      click(2)
      haptic()
      console.info('[game-input] trackpad three-finger tap: middle click')
    }
  }

  return (
    <div className="gi-pad absolute inset-0" data-gi-surface="trackpad" data-gi-dragging={dragging ? '1' : undefined} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {!locked && video.w > 0 && (
        <svg className="pointer-events-none absolute" data-gi-cursor width="18" height="24" viewBox="0 0 18 24" style={{ left: video.x + cursor.x * video.w - 2, top: video.y + cursor.y * video.h - 1 }}>
          <path d="M2 1 L2 19 L6.5 15 L9.6 22 L12.6 20.7 L9.6 14 L15.5 14 Z" fill="white" stroke="black" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  )
}
