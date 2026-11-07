import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { build, runs, wiggleAt, FLOAT_MS, type Body, type Face } from '../../../../main/satura-exec/page/drift-frames'
import { lookToward } from '../../../../main/satura-exec/page/drift-mind'

export type DriftMood = 'idle' | 'curious' | 'listening' | 'happy' | 'wave' | 'puzzled' | 'low'

const MOODS: Record<DriftMood, { body: Body | readonly Body[]; face: Face; float: boolean }> = {
  idle: { body: 'idle', face: { e: 'none' }, float: false },
  curious: { body: 'idle', face: { e: 'wide' }, float: false },
  listening: { body: 'idle', face: { e: 'look', dy: 1 }, float: true },
  happy: { body: 'idle', face: { e: 'happy' }, float: true },
  wave: { body: ['waveA', 'waveB'], face: { e: 'happy' }, float: false },
  puzzled: { body: 'idle', face: { e: 'puzzled' }, float: true },
  low: { body: 'limp', face: { e: 'low' }, float: false }
}

const OUTLINE = 'drop-shadow(1px 0 0 #0b1020) drop-shadow(-1px 0 0 #0b1020) drop-shadow(0 1px 0 #0b1020) drop-shadow(0 -1px 0 #0b1020)'

function useTick(ms: number, on: boolean): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!on) return
    const id = window.setInterval(() => setN((v) => v + 1), ms)
    return () => window.clearInterval(id)
  }, [ms, on])
  return n
}

function useBlink(on: boolean): boolean {
  const [shut, setShut] = useState(false)
  useEffect(() => {
    if (!on) return
    let t = 0
    const next = (): void => {
      t = window.setTimeout(() => {
        setShut(true)
        t = window.setTimeout(() => {
          setShut(false)
          next()
        }, 120)
      }, 2600 + Math.random() * 2400)
    }
    next()
    return () => {
      window.clearTimeout(t)
      setShut(false)
    }
  }, [on])
  return shut
}

const DEAD_ZONE = 28

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function useGaze(ref: RefObject<SVGSVGElement | null>, on: boolean): { dx: number; dy: number } | null {
  const [gaze, setGaze] = useState<{ dx: number; dy: number } | null>(null)
  useEffect(() => {
    if (!on || reducedMotion()) return
    let last = ''
    let seen = 0
    const apply = (at: { x: number; y: number }): void => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      const dx = at.x - c.x
      const dy = at.y - c.y
      const near = Math.hypot(dx, dy) < DEAD_ZONE
      const f = near ? null : lookToward(c, { x: c.x + (Math.abs(dx) > Math.abs(dy) / 3 ? dx : 0), y: c.y + (Math.abs(dy) > Math.abs(dx) / 3 ? dy : 0) })
      const next = f && f.e === 'look' ? { dx: f.dx ?? 0, dy: f.dy ?? 0 } : null
      const key = next ? `${next.dx},${next.dy}` : ''
      if (key === last) return
      last = key
      setGaze(next)
    }
    const onMove = (e: PointerEvent): void => {
      if (e.timeStamp - seen < 40) return
      seen = e.timeStamp
      apply({ x: e.clientX, y: e.clientY })
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      setGaze(null)
    }
  }, [ref, on])
  return gaze
}

const TOUCH_MS = 900
const HOP_MS = 150

function useTouch(external: number, local: number): { on: boolean; hop: number } {
  const [on, setOn] = useState(false)
  const [hop, setHop] = useState(0)
  const count = external + local
  useEffect(() => {
    if (!count) return
    setOn(true)
    setHop(0)
    const still = reducedMotion()
    let n = 0
    const id = still ? 0 : window.setInterval(() => setHop((++n) % 2 ? -1 : 0), HOP_MS)
    const t = window.setTimeout(() => {
      window.clearInterval(id)
      setHop(0)
      setOn(false)
    }, TOUCH_MS)
    return () => {
      window.clearInterval(id)
      window.clearTimeout(t)
    }
  }, [count])
  return { on, hop }
}

export function DriftGlyph({
  mood = 'idle',
  cell = 2,
  crop = false,
  outline = true,
  follow = false,
  pettable = false,
  touch = 0,
  still = false,
  className
}: {
  mood?: DriftMood
  cell?: number
  crop?: boolean
  outline?: boolean
  follow?: boolean
  pettable?: boolean
  touch?: number
  still?: boolean
  className?: string
}) {
  const [pets, setPets] = useState(0)
  const touched = useTouch(touch, pets)
  const svgRef = useRef<SVGSVGElement>(null)
  const m = MOODS[mood]
  const gaze = useGaze(svgRef, follow)
  const frames = typeof m.body === 'string' ? null : m.body
  const tick = useTick(frames ? 200 : FLOAT_MS / 4, !still && (!!frames || m.float))
  const shut = useBlink(!still && (m.face.e === 'none' || m.face.e === 'look' || m.face.e === 'wide'))
  const body: Body = frames ? frames[tick % frames.length] : (m.body as Body)
  const shift = m.float && !still ? wiggleAt((tick * FLOAT_MS) / 4) : 0
  const face: Face = touched.on ? { e: 'lines' } : shut ? { e: 'closed' } : gaze ? { e: 'look', dx: gaze.dx, dy: gaze.dy } : m.face
  const cells = useMemo(() => runs(build(body, false, face, false, shift)), [body, face.e, face.dx, face.dy, shift])
  const view = crop ? { x: 0, y: 1, w: 9, h: 7 } : { x: 0, y: 0, w: 12, h: 10 }
  return (
    <svg
      ref={svgRef}
      aria-hidden
      data-drift-glyph={mood}
      data-drift-touched={touched.on ? '' : undefined}
      onClick={
        pettable
          ? (e) => {
              e.preventDefault()
              e.stopPropagation()
              setPets((n) => n + 1)
            }
          : undefined
      }
      width={view.w * cell}
      height={view.h * cell}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      shapeRendering="crispEdges"
      className={className}
      style={{
        overflow: 'visible',
        imageRendering: 'pixelated',
        cursor: pettable ? 'pointer' : undefined,
        transform: touched.hop ? `translateY(${touched.hop * cell}px)` : undefined,
        ...(outline ? { filter: OUTLINE } : {})
      }}
    >
      {cells.map((r) => (
        <rect key={`${r.x},${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} fillOpacity={r.fill === '#ffffff' ? 0.7 : undefined} />
      ))}
    </svg>
  )
}
