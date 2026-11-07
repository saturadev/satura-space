import { useEffect, useRef, useState } from 'react'
import { FRAME_HISTORY, SAMPLE_HISTORY, getPerfHistory } from '../../lib/unity/unity-metrics'

const BUCKET_MS = 150
const BUCKETS = 120
const WINDOW_MS = BUCKET_MS * BUCKETS
const MAX_SPIKES = 64
const STALE_AFTER_MS = 3000

interface GraphStats {
  min: number
  avg: number
  max: number
  pingAvg: number
  buckets: number
}

const EMPTY_STATS: GraphStats = { min: 0, avg: 0, max: 0, pingAvg: -1, buckets: 0 }

const GOOD = [52, 211, 153] as const
const CAUTION = [251, 191, 36] as const
const CRITICAL = [251, 113, 133] as const

type Color = readonly [number, number, number]

function rgb(c: Color, a = 1): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`
}

function bucketColor(fps: number, worstGap: number, target: number, targetInterval: number): Color {
  if (worstGap <= targetInterval * 1.5) return GOOD
  if (fps >= target * 0.95) return worstGap <= targetInterval * 2.5 ? GOOD : CAUTION
  if (worstGap <= targetInterval * 2.5) return CAUTION
  return CRITICAL
}

interface BucketScratch {
  fps: Float32Array
  worst: Float32Array
  frames: Float32Array
  spikes: Float32Array
}

function computeBuckets(
  id: string,
  now: number,
  spikeLimit: number,
  s: BucketScratch
): { valid: number; spikeCount: number } {
  s.fps.fill(0)
  s.worst.fill(0)
  s.frames.fill(0)
  const h = getPerfHistory(id)
  if (!h || h.frameCount === 0 || h.lastFrameAt <= 0) return { valid: 0, spikeCount: 0 }

  let t = h.lastFrameAt
  let covered = now - t
  let spikeCount = 0
  for (let i = 0; i < h.frameCount; i++) {
    const idx = (h.frameHead - 1 - i + FRAME_HISTORY) % FRAME_HISTORY
    const dt = h.frameMs[idx]
    const age = now - t
    const b0 = Math.floor(age / BUCKET_MS)
    if (b0 >= BUCKETS) {
      covered = WINDOW_MS
      break
    }
    if (b0 >= 0) {
      s.frames[b0]++
      s.fps[b0] += dt
      const bEnd = Math.min(BUCKETS - 1, Math.floor((age + dt) / BUCKET_MS))
      for (let b = b0; b <= bEnd; b++) {
        if (dt > s.worst[b]) s.worst[b] = dt
      }
      if (dt > spikeLimit && spikeCount < MAX_SPIKES) s.spikes[spikeCount++] = age
    }
    t -= dt
    covered = now - t
  }

  const valid = Math.min(BUCKETS, Math.floor(covered / BUCKET_MS))
  for (let b = 1; b < valid; b++) {
    const spanMs = s.fps[b]
    s.fps[b] = spanMs > 0 ? (s.frames[b] * 1000) / spanMs : 0
  }
  return { valid, spikeCount }
}

function readPing(id: string, out: Float32Array): number {
  const h = getPerfHistory(id)
  if (!h || h.sampleCount === 0) return 0
  const n = h.sampleCount
  const start = (h.sampleHead - n + SAMPLE_HISTORY) % SAMPLE_HISTORY
  for (let i = 0; i < n; i++) out[i] = h.ping[(start + i) % SAMPLE_HISTORY]
  return n
}

export function PerfGraph({
  sessionId,
  targetFps,
  currentFps,
  active
}: {
  sessionId: string
  targetFps: number
  currentFps: number
  active: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pingCanvasRef = useRef<HTMLCanvasElement>(null)
  const scratchRef = useRef<BucketScratch>({
    fps: new Float32Array(BUCKETS),
    worst: new Float32Array(BUCKETS),
    frames: new Float32Array(BUCKETS),
    spikes: new Float32Array(MAX_SPIKES)
  })
  const pingBuf = useRef<Float32Array>(new Float32Array(SAMPLE_HISTORY))
  const [stats, setStats] = useState<GraphStats>(EMPTY_STATS)
  const currentRef = useRef(currentFps)
  currentRef.current = currentFps

  useEffect(() => {
    if (!active) return
    let raf = 0

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const target = Math.max(1, targetFps > 0 ? targetFps : currentRef.current)
      const targetInterval = 1000 / target
      const canvas = canvasRef.current
      const pingCanvas = pingCanvasRef.current
      if (!canvas) return
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      ctx.clearRect(0, 0, w, h)

      const now = performance.now()
      const qnow = Math.floor(now / BUCKET_MS) * BUCKET_MS
      const slide = now - qnow
      const hist = getPerfHistory(sessionId)
      const stale = !hist || hist.lastFrameAt <= 0 || now - hist.lastFrameAt > STALE_AFTER_MS
      const s = scratchRef.current
      const { valid, spikeCount } = stale
        ? { valid: 0, spikeCount: 0 }
        : computeBuckets(sessionId, qnow, targetInterval * 2.5, s)

      let ceiling = target * 1.25
      let min = Infinity
      let max = 0
      let sum = 0
      let n = 0
      for (let b = 1; b < valid; b++) {
        const v = s.fps[b]
        n++
        sum += v
        if (v < min) min = v
        if (v > max) max = v
        if (v > ceiling) ceiling = v
      }
      const avg = n > 0 ? sum / n : 0
      if (n === 0) min = 0

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)'
      ctx.lineWidth = 1
      for (const frac of [0.25, 0.5, 0.75]) {
        const y = Math.round(h * frac) + 0.5
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }

      const targetY = Math.round(h - (target / ceiling) * h) + 0.5
      ctx.strokeStyle = rgb(GOOD, 0.28)
      ctx.setLineDash([4 * dpr, 4 * dpr])
      ctx.beginPath()
      ctx.moveTo(0, targetY)
      ctx.lineTo(w, targetY)
      ctx.stroke()
      ctx.setLineDash([])

      const drawable = n >= 2
      if (drawable) {
        const xAt = (age: number): number => w - ((age + slide) / WINDOW_MS) * w
        const bx = (b: number): number => xAt((b + 0.5) * BUCKET_MS)
        const by = (b: number): number => h - Math.min(1, s.fps[b] / ceiling) * h

        const newestColor = bucketColor(s.fps[1], s.worst[1], target, targetInterval)
        const grad = ctx.createLinearGradient(0, 0, 0, h)
        grad.addColorStop(0, rgb(newestColor, 0.28))
        grad.addColorStop(1, rgb(newestColor, 0.02))
        ctx.beginPath()
        ctx.moveTo(bx(valid - 1), h)
        for (let b = valid - 1; b >= 1; b--) ctx.lineTo(bx(b), by(b))
        ctx.lineTo(bx(1), h)
        ctx.closePath()
        ctx.fillStyle = grad
        ctx.fill()

        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.lineWidth = 1.5 * dpr
        for (let b = valid - 1; b >= 2; b--) {
          const c = bucketColor(s.fps[b - 1], s.worst[b - 1], target, targetInterval)
          ctx.strokeStyle = rgb(c, 0.95)
          ctx.beginPath()
          ctx.moveTo(bx(b), by(b))
          ctx.lineTo(bx(b - 1), by(b - 1))
          ctx.stroke()
        }

        ctx.fillStyle = rgb(newestColor, 1)
        ctx.beginPath()
        ctx.arc(bx(1), by(1), 2 * dpr, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = rgb(CRITICAL, 0.9)
        for (let i = 0; i < spikeCount; i++) {
          const x = xAt(s.spikes[i])
          ctx.fillRect(x - dpr / 2, 0, dpr, 4 * dpr)
        }
      }

      let pingAvg = -1
      if (pingCanvas) {
        const pw = Math.max(1, Math.round(pingCanvas.clientWidth * dpr))
        const ph = Math.max(1, Math.round(pingCanvas.clientHeight * dpr))
        if (pingCanvas.width !== pw || pingCanvas.height !== ph) {
          pingCanvas.width = pw
          pingCanvas.height = ph
        }
        const pctx = pingCanvas.getContext('2d')
        if (pctx) {
          pctx.clearRect(0, 0, pw, ph)
          const pbuf = pingBuf.current
          const pcount = readPing(sessionId, pbuf)
          let pmax = 0
          let psum = 0
          let pn = 0
          for (let i = 0; i < pcount; i++) {
            const v = pbuf[i]
            if (v < 0) continue
            pn++
            psum += v
            if (v > pmax) pmax = v
          }
          pingAvg = pn > 0 ? psum / pn : -1
          const scale = Math.max(50, pmax)
          if (pn >= 2) {
            const step = pw / (SAMPLE_HISTORY - 1)
            for (let i = 0; i < pcount; i++) {
              const v = pbuf[i]
              if (v < 0) continue
              const bh = Math.max(1, (v / scale) * ph)
              const alpha = 0.35 + 0.4 * Math.min(1, v / scale)
              pctx.fillStyle = `rgba(125, 211, 252, ${alpha})`
              const x = pw - (pcount - 1 - i) * step
              pctx.fillRect(x - step / 2, ph - bh, Math.max(1, step - dpr), bh)
            }
          }
        }
      }

      setStats((prev) => {
        const nb = drawable ? n : 0
        if (
          prev.buckets === nb &&
          Math.round(prev.min) === Math.round(min) &&
          Math.round(prev.avg) === Math.round(avg) &&
          Math.round(prev.max) === Math.round(max) &&
          Math.round(prev.pingAvg) === Math.round(pingAvg)
        ) {
          return prev
        }
        return { min, avg, max, pingAvg, buckets: nb }
      })
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [sessionId, targetFps, active])

  const idle = stats.buckets < 2
  const fmt = (v: number): string => (idle ? '—' : String(Math.round(v)))

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">Performance</span>
        <span className="text-[10px] tabular-nums text-zinc-500">
          {idle ? 'idle' : `${currentFps} fps`}
        </span>
      </div>

      <div className="relative overflow-hidden rounded border border-white/10 bg-sunken">
        <canvas ref={canvasRef} className="block h-16 w-full" />
        {idle && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="text-[10px] text-zinc-600">Waiting for frames…</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-4 gap-1 text-center">
        <Stat label="min" value={fmt(stats.min)} tone="min" />
        <Stat label="avg" value={fmt(stats.avg)} tone="avg" />
        <Stat label="max" value={fmt(stats.max)} tone="max" />
        <Stat label="fps" value={idle ? '—' : String(currentFps)} tone="cur" />
      </div>

      <div className="mt-0.5 flex items-center gap-1.5">
        <span className="w-8 shrink-0 text-[9px] uppercase tracking-wide text-zinc-500">Ping</span>
        <div className="relative h-4 flex-1 overflow-hidden rounded-sm border border-white/10 bg-sunken">
          <canvas ref={pingCanvasRef} className="block h-full w-full" />
        </div>
        <span className="w-8 shrink-0 text-right text-[9px] tabular-nums text-zinc-400">
          {stats.pingAvg >= 0 ? `${Math.round(stats.pingAvg)}` : '—'}
        </span>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone: 'min' | 'avg' | 'max' | 'cur'
}) {
  const color =
    tone === 'min'
      ? 'text-rose-300/90'
      : tone === 'max'
        ? 'text-emerald-300/90'
        : tone === 'cur'
          ? 'text-sky-200'
          : 'text-zinc-200'
  return (
    <div className="flex flex-col rounded bg-white/[0.03] py-0.5">
      <span className={`text-[11px] font-medium tabular-nums leading-tight ${color}`}>{value}</span>
      <span className="text-[8px] uppercase tracking-wide text-zinc-500">{label}</span>
    </div>
  )
}
