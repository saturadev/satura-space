import type { TunerRectInfo, V2 } from '@shared/tuner-rect'
import { readCssRgb } from './theme'
import { zAngle } from './rect-tool'
import type { RectScreen } from './rect-overlay'

export type Box = [number, number, number, number]

export interface ProbeObject {
  id: string
  path: string
  renderer: boolean
  anchoredPosition: V2
  sizeDelta: V2
  rotZ: number
  localScale: number[]
  screen: Box | null
  outline: Box | null
  outlinePx: number
  off: Box | null
}

const OUTLINE_TOL = 10
const WINDOW_PAD = 24

function r1(v: number): number {
  return Math.round(v * 10) / 10
}

function r3(v: number): number {
  return Math.round(v * 1000) / 1000
}

export function boxOf(points: V2[]): Box | null {
  if (points.length === 0) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of points) {
    x0 = Math.min(x0, p[0])
    y0 = Math.min(y0, p[1])
    x1 = Math.max(x1, p[0])
    y1 = Math.max(y1, p[1])
  }
  return [r1(x0), r1(y0), r1(x1), r1(y1)]
}

export function screenOf(sc: RectScreen | null): { corners: V2[]; pivot: V2; box: Box } | null {
  if (!sc) return null
  return { corners: sc.corners.map((c) => [r1(c[0]), r1(c[1])] as V2), pivot: [r1(sc.pivot[0]), r1(sc.pivot[1])], box: boxOf(sc.corners)! }
}

export function outlineBox(canvas: HTMLCanvasElement | null, flipY: boolean, vw: number, vh: number, around: Box): { box: Box | null; n: number } {
  const ctx = canvas?.getContext('2d', { willReadFrequently: true })
  const acc = readCssRgb('--accent')
  if (!canvas || !ctx || !acc || canvas.width < 2 || canvas.height < 2) return { box: null, n: 0 }
  const k = vh / canvas.height
  const toCx = (x: number): number => (x - vw / 2) / k + canvas.width / 2
  const toCy = (y: number): number => (flipY ? canvas.height - y / k : y / k)
  const xa = toCx(around[0] - WINDOW_PAD)
  const xb = toCx(around[2] + WINDOW_PAD)
  const ya = toCy(around[1] - WINDOW_PAD)
  const yb = toCy(around[3] + WINDOW_PAD)
  const cx0 = Math.max(0, Math.floor(Math.min(xa, xb)))
  const cx1 = Math.min(canvas.width, Math.ceil(Math.max(xa, xb)))
  const cy0 = Math.max(0, Math.floor(Math.min(ya, yb)))
  const cy1 = Math.min(canvas.height, Math.ceil(Math.max(ya, yb)))
  if (cx1 - cx0 < 1 || cy1 - cy0 < 1) return { box: null, n: 0 }
  const d = ctx.getImageData(cx0, cy0, cx1 - cx0, cy1 - cy0).data
  const w = cx1 - cx0
  let n = 0
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i] - acc[0]) + Math.abs(d[i + 1] - acc[1]) + Math.abs(d[i + 2] - acc[2]) > OUTLINE_TOL) continue
    const p = i >> 2
    const px = cx0 + (p % w) + 0.5
    const py = cy0 + Math.floor(p / w) + 0.5
    const vx = vw / 2 + (px - canvas.width / 2) * k
    const vy = (flipY ? canvas.height - py : py) * k
    x0 = Math.min(x0, vx)
    y0 = Math.min(y0, vy)
    x1 = Math.max(x1, vx)
    y1 = Math.max(y1, vy)
    n++
  }
  return n ? { box: [r1(x0), r1(y0), r1(x1), r1(y1)], n } : { box: null, n: 0 }
}

export function probeObject(info: TunerRectInfo, path: string, sc: RectScreen | null, outline: { box: Box | null; n: number }): ProbeObject {
  const screen = sc ? boxOf(sc.corners) : null
  const o = outline.box
  return {
    id: info.id,
    path,
    renderer: info.renderer === true,
    anchoredPosition: [r3(info.anchoredPosition[0]), r3(info.anchoredPosition[1])],
    sizeDelta: [r3(info.sizeDelta[0]), r3(info.sizeDelta[1])],
    rotZ: r3(zAngle(info.localRotation)),
    localScale: info.localScale.map(r3),
    screen,
    outline: o,
    outlinePx: outline.n,
    off: screen && o ? [r1(o[0] - screen[0]), r1(o[1] - screen[1]), r1(o[2] - screen[2]), r1(o[3] - screen[3])] : null
  }
}
