import type { TunerCamera, TunerSceneIcon } from '@shared/tuner'
import { toScreen } from './markers'

type Cam = Pick<TunerCamera, 'position' | 'rotation' | 'fov' | 'ortho'>

const ICON_PICK_PX = 12
const INK = '236,236,240'
const FULL_SIZE_M = 14
const MIN_SCALE = 0.55
const FADE_NEAR_M = 0.4
const FADE_NEAR_END_M = 1.6
const FADE_FAR_M = 25
const FADE_FAR_END_M = 120
const MIN_ALPHA = 0.55
const GROUP_PX = 14

export interface SceneIconSpot {
  id: string
  kind: string
  x: number
  y: number
  scale: number
  alpha: number
  members: string[]
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export interface SceneIconStyle {
  use3d: boolean
  texelWorldSize: number
}

const ICON_TEXELS = 32
const MIN_ICON_SCALE = 0.12

function iconScale(cam: Cam, h: number, d: number, style: SceneIconStyle | undefined): number {
  if (!style) return cam.ortho ? 1 : Math.max(MIN_SCALE, Math.min(1, FULL_SIZE_M / Math.max(d, 1e-3)))
  if (!style.use3d) return 1
  if (style.texelWorldSize <= 0) return 0
  const worldPerPx = cam.ortho ? (2 * cam.ortho) / Math.max(1, h) : (2 * Math.max(d, 1e-3) * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, h)
  return Math.min(1, (style.texelWorldSize * ICON_TEXELS) / (ICON_TEXELS * worldPerPx))
}

export function sceneIconSpots(cam: Cam, w: number, h: number, icons: readonly TunerSceneIcon[], style?: SceneIconStyle): SceneIconSpot[] {
  const placed: (SceneIconSpot & { d: number })[] = []
  for (const ic of icons) {
    const s = toScreen(cam, ic.position, w, h)
    if (!s || s[0] < -16 || s[1] < -16 || s[0] > w + 16 || s[1] > h + 16) continue
    const p = cam.position
    const d = Math.hypot(ic.position[0] - p[0], ic.position[1] - p[1], ic.position[2] - p[2])
    const scale = iconScale(cam, h, d, style)
    if (scale < MIN_ICON_SCALE) continue
    const near = cam.ortho ? 1 : clamp01((d - FADE_NEAR_M) / (FADE_NEAR_END_M - FADE_NEAR_M))
    const far = cam.ortho ? 1 : 1 - (1 - MIN_ALPHA) * clamp01((d - FADE_FAR_M) / (FADE_FAR_END_M - FADE_FAR_M))
    const alpha = near * far
    if (alpha < 0.05) continue
    placed.push({ id: ic.id, kind: ic.kind, x: s[0], y: s[1], scale, alpha, members: [ic.id], d })
  }
  placed.sort((a, b) => a.d - b.d)
  const out: SceneIconSpot[] = []
  for (const sp of placed) {
    const lead = out.find((o) => Math.hypot(o.x - sp.x, o.y - sp.y) < GROUP_PX * Math.max(o.scale, sp.scale))
    if (lead) lead.members.push(sp.id)
    else out.push({ id: sp.id, kind: sp.kind, x: sp.x, y: sp.y, scale: sp.scale, alpha: sp.alpha, members: sp.members })
  }
  return out.reverse()
}

export function pickSceneIcon(
  spots: readonly SceneIconSpot[],
  x: number,
  y: number,
  current: string | null = null,
  radius = ICON_PICK_PX
): string | null {
  let best: SceneIconSpot | null = null
  let bestD = radius
  for (const s of spots) {
    const d = Math.hypot(s.x - x, s.y - y)
    if (d <= bestD * Math.max(s.scale, 0.75)) {
      bestD = d
      best = s
    }
  }
  if (!best) return null
  const at = current ? best.members.indexOf(current) : -1
  return at >= 0 ? best.members[(at + 1) % best.members.length] : best.id
}

function glyph(ctx: CanvasRenderingContext2D, kind: string): void {
  ctx.beginPath()
  if (kind === 'camera') {
    ctx.roundRect(-8, -5, 11, 10, 2)
    ctx.moveTo(3, -1.5)
    ctx.lineTo(8, -4.5)
    ctx.lineTo(8, 4.5)
    ctx.lineTo(3, 1.5)
  } else if (kind === 'light-dir') {
    ctx.arc(0, 0, 3.4, 0, Math.PI * 2)
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4
      ctx.moveTo(Math.cos(a) * 5.6, Math.sin(a) * 5.6)
      ctx.lineTo(Math.cos(a) * 8.2, Math.sin(a) * 8.2)
    }
  } else if (kind === 'light-spot') {
    ctx.arc(0, -4.5, 2.6, 0, Math.PI * 2)
    ctx.moveTo(-2.2, -2.2)
    ctx.lineTo(-6.5, 7)
    ctx.lineTo(6.5, 7)
    ctx.lineTo(2.2, -2.2)
  } else if (kind === 'light-area') {
    ctx.rect(-6, -6, 12, 7)
    for (const x of [-4, 0, 4]) {
      ctx.moveTo(x, 3)
      ctx.lineTo(x, 7.5)
    }
  } else if (kind === 'audio') {
    ctx.moveTo(-7, -2.5)
    ctx.lineTo(-4, -2.5)
    ctx.lineTo(0, -6.5)
    ctx.lineTo(0, 6.5)
    ctx.lineTo(-4, 2.5)
    ctx.lineTo(-7, 2.5)
    ctx.closePath()
    ctx.moveTo(3.5, -3.5)
    ctx.arc(1, 0, 4.3, -Math.PI / 4, Math.PI / 4)
    ctx.moveTo(5.6, -6)
    ctx.arc(1, 0, 7.6, -Math.PI / 4, Math.PI / 4)
  } else if (kind === 'particles') {
    for (const [x, y, r] of [[-3.5, 2.5, 2.4], [3.2, 3.6, 1.7], [1.2, -3.2, 2]] as const) {
      ctx.moveTo(x + r, y)
      ctx.arc(x, y, r, 0, Math.PI * 2)
    }
    ctx.moveTo(-6.5, -3.5)
    ctx.lineTo(-4.8, -5.2)
    ctx.moveTo(5.5, -1)
    ctx.lineTo(7.5, -1.5)
    ctx.moveTo(-1, 7)
    ctx.lineTo(-1.5, 8.5)
  } else if (kind === 'probe') {
    ctx.arc(0, 0, 6.5, 0, Math.PI * 2)
    ctx.moveTo(-3.5, -1.5)
    ctx.arc(-1.5, -1.5, 2, Math.PI, Math.PI * 1.5)
  } else {
    ctx.arc(0, -2, 4.6, Math.PI * 0.8, Math.PI * 2.2)
    ctx.lineTo(1.6, 4.5)
    ctx.lineTo(-1.6, 4.5)
    ctx.closePath()
    ctx.moveTo(-1.6, 6.8)
    ctx.lineTo(1.6, 6.8)
  }
}

export function drawSceneIcons(
  ctx: CanvasRenderingContext2D,
  spots: readonly SceneIconSpot[],
  dpr: number,
  opts: { hover: string | null; selected: ReadonlySet<string>; accent: string }
): void {
  if (spots.length === 0) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const s of spots) {
    const on = s.members.some((m) => opts.selected.has(m))
    const hot = s.members.includes(opts.hover ?? '')
    const k = s.scale * (hot ? 1.15 : 1)
    const a = hot || on ? 1 : s.alpha
    ctx.globalAlpha = a
    ctx.setTransform(dpr * k, 0, 0, dpr * k, s.x * dpr, s.y * dpr)
    glyph(ctx, s.kind)
    ctx.shadowColor = 'rgba(0,0,0,0.75)'
    ctx.shadowBlur = 2.5 * dpr * k
    ctx.lineWidth = 3.2
    ctx.strokeStyle = 'rgba(16,17,20,0.55)'
    ctx.stroke()
    ctx.shadowBlur = 0
    ctx.lineWidth = 1.5
    ctx.strokeStyle = on ? opts.accent : `rgba(${INK},0.95)`
    ctx.stroke()
    if (s.members.length > 1) {
      ctx.setTransform(dpr, 0, 0, dpr, s.x * dpr, s.y * dpr)
      const label = String(s.members.length)
      ctx.font = '600 9px Inter, system-ui, sans-serif'
      const tw = ctx.measureText(label).width
      const bx = 6 * k
      const by = -9 * k
      const bw = Math.max(11, tw + 6)
      ctx.beginPath()
      ctx.roundRect(bx, by - 6, bw, 12, 6)
      ctx.fillStyle = 'rgba(16,17,20,0.78)'
      ctx.fill()
      ctx.fillStyle = on ? opts.accent : `rgba(${INK},0.95)`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, bx + bw / 2, by + 0.5)
    }
  }
  ctx.globalAlpha = 1
  ctx.restore()
}
