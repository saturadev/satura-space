import { BELL, COLS, ROWS, bellShade, build, pixelSize, shadeBox, shadeSvg, snap, svgRects, wiggleAt, FLOAT_MS, type Body, type Cells } from './drift-frames'
import { CELL_BASE, areaPoint, exactPose, isArea, overlaps, placeHand, poseGeo, type Pose, type PoseGeo } from './drift-pose'
import { DriftMind, EMOTION_MS, type Emotion, type Point } from './drift-mind'
import { bubbleGap, bubbleMs, bubbleText, placeBubble, type Box } from './bubble'
import { CAP_FIRST_MS, CAP_NEXT_MS, RISE, SWIM_LEAVE_MS, budgetPlan, capFor, planApproach, planTotal, type Plan } from '../drift-rules'
import { DIM_FADE_MS, DIM_LIFT_MS, DIM_OPACITY, DIM_COLOR, dimWanted, followCircle, spotlightCircle, spotlightMask, type Box as SpotBox, type Circle } from './spotlight'
import type { WorkspaceScope } from './scope'
import { Anchor, edgePoint, fracOf, sameBox, type AnchorRead, type AnchorState } from './anchor'
import { GOAL_ATTR, GOAL_EVENT, alive, goalAttr, landGoal, scrollerAt, scrollerFor, setPos, stateOf, thumbOf, wantFor, type Axis, type ScrollState } from './drift-scroll'
import { clientRect } from './rect'

type Win = Window & typeof globalThis

const CANCEL = Symbol('cancel')
const FLOAT_PX = 2
const SAY_SETTLE_MS = 160
const WAITING = 'is waiting for you'
const REPLY_CALM_MS = 800
const FOLLOW_GAP_MS = 150
const AIM_MAX = 900
const round1 = (v: number): number => Math.round(v * 10) / 10

export type SayFrame = { t: number; bell: Box; say: Box; side: string; gap: number }
export type SayStats = { n: number; sum: number; max: SayFrame | null; sides: string[]; odd: SayFrame[]; last: string }
export const SAY_GAP_OK = 14
export type LineShown = { text: string; read: number; up: number; how: 'read' | 'cut' | 'replaced' | 'up' }

export interface AimSample {
  t: number
  tip: Point
  at: Point
  via: string
  keep: Box | null
  d: number
}
const POINTING = new Set<Body>(['reach', 'press', 'up', 'side', 'sidePress'])

export const LOST_LINES: Record<AnchorState, string> = { ok: '', gone: "it's gone", hidden: "it's hidden now", offscreen: 'it scrolled away' }

const STYLE = `
:host { all: initial; }
.stage { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
.stage * { pointer-events: none; }
.drift, .clip, .fx { position: absolute; inset: 0; }
.mark { position: absolute; left: 0; top: 0; width: 0; height: 0; box-sizing: border-box; border: 2px solid ${BELL}; border-radius: 6px; box-shadow: 0 0 0 1px rgba(5, 10, 28, .55), 0 0 14px rgba(138, 164, 255, .45); opacity: 0; transition: opacity .15s ease-out; visibility: hidden; }
.mark.on { opacity: 1; visibility: visible; }
.grip { position: absolute; left: 0; top: 0; width: 0; height: 0; box-sizing: border-box; border-radius: 4px; background: rgba(138, 164, 255, .9); box-shadow: 0 0 0 1px rgba(5, 10, 28, .6), 0 0 10px rgba(138, 164, 255, .55); opacity: 0; transition: opacity .12s ease-out; visibility: hidden; }
.grip.on { opacity: 1; visibility: visible; }
.dim { position: absolute; left: 0; top: 0; width: 0; height: 0; background: ${DIM_COLOR}; opacity: 0; transition: opacity ${DIM_FADE_MS}ms ease-out; visibility: hidden; }
.dim.on { visibility: visible; }
.dim.lift { transition-duration: ${DIM_LIFT_MS}ms; }
.mw { position: absolute; left: 0; top: 0; will-change: transform; }
svg { display: block; overflow: visible; position: relative; }
.mw > svg:not(.shade), .badge { filter: drop-shadow(1px 0 0 #0b1020) drop-shadow(-1px 0 0 #0b1020) drop-shadow(0 1px 0 #0b1020) drop-shadow(0 -1px 0 #0b1020); }
.limbs { position: absolute; left: 0; top: 0; }
.shade { position: absolute; left: 0; top: 0; fill: #050a1c; opacity: .38; transition: opacity .12s; }
.shade.off { opacity: 0; }
.tag { position: absolute; white-space: nowrap; font: 600 10px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #10162a; background: ${BELL}; padding: 3px 6px; border-radius: 5px; opacity: 0; transform: translateX(-50%); transition: opacity .12s; }
.tag.on { opacity: 1; }
.rip { position: absolute; border: 2px solid ${BELL}; border-radius: 50%; transform: translate(-50%, -50%); animation: rip 380ms ease-out forwards; }
@keyframes rip { from { width: 10px; height: 10px; opacity: .9; } to { width: 46px; height: 46px; opacity: 0; } }
.say { position: absolute; left: 0; top: 0; box-sizing: border-box; max-width: 300px; width: max-content; white-space: normal; font: 600 15px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; letter-spacing: -.005em; color: #121833; background: #f5f7ff; border: 2px solid ${BELL}; padding: 9px 14px; border-radius: 14px; filter: drop-shadow(0 3px 0 rgba(0, 0, 0, .5)); opacity: 0; transition: opacity .1s ease-out; visibility: hidden; }
.say::after { content: ''; position: absolute; width: 11px; height: 11px; background: #f5f7ff; border: 0 solid ${BELL}; transform: rotate(45deg); }
.say[data-side=above]::after { left: calc(var(--t, 50%) - 7.5px); bottom: -7.5px; border-width: 0 2px 2px 0; }
.say[data-side=below]::after { left: calc(var(--t, 50%) - 7.5px); top: -7.5px; border-width: 2px 0 0 2px; }
.say[data-side=left]::after { top: calc(var(--t, 50%) - 7.5px); right: -7.5px; border-width: 2px 2px 0 0; }
.say[data-side=right]::after { top: calc(var(--t, 50%) - 7.5px); left: -7.5px; border-width: 0 0 2px 2px; }
.say.on { opacity: 1; visibility: visible; }
.say.off { opacity: 0; visibility: visible; transition: opacity .18s ease-in; }
.say.ask { max-width: 340px; padding: 11px 14px 12px; filter: drop-shadow(0 3px 0 rgba(0, 0, 0, .5)) drop-shadow(0 0 12px rgba(138, 164, 255, .55)); }
.say.menu { max-width: 340px; padding: 11px 14px 12px; }
.stage .say.ask.on, .stage .say.ask.on *, .stage .say.menu.on, .stage .say.menu.on * { pointer-events: auto; }
.say .q { display: block; padding-right: 20px; }
.say.menu .q { padding-right: 0; }
.say.menu .row:first-child { margin-top: 0; flex-direction: column; align-items: stretch; }
.say.menu .row button { white-space: nowrap; }
@media (pointer: coarse) { .say.menu .row button { padding: 9px 12px; } }
.say .row { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 11px; }
.say .row button { font: 700 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #121833; background: #f5f7ff; border: 2px solid ${BELL}; border-radius: 9px; padding: 7px 14px; cursor: pointer; }
.say .row button.go { background: ${BELL}; color: #10162a; border-color: #5f7cf0; }
.say .row button:hover { filter: brightness(1.06); }
.say .row button:active { transform: translateY(1px); }
.say button:focus-visible { outline: 2px solid #121833; outline-offset: 2px; }
.say .x { position: absolute; top: 5px; right: 5px; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: #5a6380; font: 400 17px/22px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; cursor: pointer; }
.say .x:hover { background: rgba(18, 24, 51, .08); color: #121833; }
.badge { position: absolute; left: 0; top: 0; display: none; }
.badge.on { display: block; }
@media (prefers-reduced-motion: reduce) { .tag, .say, .say.off, .shade, .dim { transition: none; } }
`

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const GRAB_PX = 4
interface Grab { x: number; y: number }
export interface GrabTrace { mid: ReturnType<Drift['state']> | null; after: ReturnType<Drift['state']> | null; moves: number }
const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const USER_TYPES = ['wheel', 'mousedown', 'keydown', 'touchstart'] as const
const GOAL_LEFT_MS = 900
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))

function quiet(e: unknown): void {
  if (e !== CANCEL) throw e
}

export interface ApproachArgs {
  x: number
  y: number
  box: Box | null
  left: number
  line?: string
  target?: Anchor | null
  rest?: boolean
}

export interface ScrollArgs {
  kind: 'wheel' | 'into' | 'to'
  x?: number
  y?: number
  dx?: number
  dy?: number
  rect?: Box | null
  left: number
  line?: string
}

export interface ScrollResult {
  mode: 'thumb' | 'none' | 'visible' | 'hidden'
  axis: Axis | null
  native: boolean
  moved: number
  remaining: { dx: number; dy: number }
  interrupted: boolean
  gone: boolean
  ms: number
  travel: number
  frames: number
  maxStep: number
  outside: number
}

export interface Where {
  on: boolean
  shown: boolean
  hand: Point
  target: string
  box: Box | null
  hit: string
  state: AnchorState | 'none'
  lost: boolean
  follows: number
  refound: number
}

export interface ApproachResult {
  ms: number
  full: number
  first: boolean
  shown: boolean
  reduced: boolean
  where?: Where
}

export interface MenuItem {
  id: string
  label: string
  go?: boolean
}

interface AskState {
  text: string
  buttons: string[]
  answer: { label: string | null; how: string } | null
  back: Element | null
  focus: boolean
  focused: boolean
}

export interface UserSeen {
  kind: 'mouse' | 'key'
  x?: number
  y?: number
}

interface EmergePlan {
  edge: number
  start: Point
  end: Point
  keep: boolean
}

export class Drift {
  readonly mind = new DriftMind()
  x = 0
  y = 0
  on = false
  alpha = 0
  body: Body = 'idle'
  rest: Body = 'idle'
  mirror = false
  pose: Pose = 'reach'
  private _host: HTMLElement | null = null
  private _layer!: HTMLElement
  private _clip!: HTMLElement
  private _mw!: HTMLElement
  private _svg!: SVGSVGElement
  private _limbs!: SVGSVGElement
  private _shade!: SVGSVGElement
  private _tag!: HTMLElement
  private _fx!: HTMLElement
  private _dim!: HTMLElement
  private _dimAllowed = true
  private _spotUntil: number | null = null
  private _dimOn = false
  private _dimKey = ''
  private _dimRect: SpotBox | null = null
  private _dimRectAt = 0
  private _dimCircle: Circle | null = null
  private _dimAt = 0
  private _say!: HTMLElement
  private _mark: HTMLElement | null = null
  private _gripEl: HTMLElement | null = null
  private _markKey = ''
  private _markClip: Box | null = null
  private _markOff = false
  private _badge!: SVGSVGElement
  private _name = 'Agent'
  private _captureHidden = false
  private _gen = 0
  private _snapGen = -1
  private _S = 3
  cell = 1
  private _box: Box | null = null
  private _anchor: Point | null = null
  private _target: Anchor | null = null
  private _handOff: Point = { x: 0, y: 0 }
  private _slide = false
  private _exactAt: Point | null = null
  private _aim: AimSample[] = []
  private _travelling = false
  private _pending: { line: string; ms?: number } | null = null
  private _follows = 0
  private _movedAt = Number.NEGATIVE_INFINITY
  private _lost: { desc: string; state: AnchorState } | null = null
  private _watch: Anchor | null = null
  private _stuck = false
  private _loudUntil: number | null = null
  private _keepClip: number | null = null
  private _pressed = false
  private _down: Point | null = null
  private _grab: Grab | null = null
  lastGrab: GrabTrace | null = null
  private _leaving = false
  private _lingerAt: number | null = null
  private _hold = false
  private _sayTimer: ReturnType<typeof setTimeout> | undefined
  private _sayUntil: number | null = null
  private _puzzleLine = ''
  private _sayOn = false
  private _sayText = ''
  private _sayKey = ''
  private _menu: { items: MenuItem[]; key: string; pick: (id: string) => void } | null = null
  private _base: Point = { x: Number.NaN, y: Number.NaN }
  private _baseAt = 0
  private _said: string[] = []
  private _lineMs: number | undefined
  private _vt = 0
  private _last = 0
  private _frozen = false
  private _clock: number | null = null
  private _ticks = new Set<() => void>()
  private _scheduled = false
  floatY = 0
  private _raf = 0
  private _timer: ReturnType<typeof setTimeout> | undefined
  private _lastKey = ''
  private _shadeKey = ''
  private _shadeCells: Cells | null = null
  private _shadeOn = true
  private _sayBox: Box | null = null
  private _sayAnchor: { dx: number; dy: number; side: string } | null = null
  private _saySize: { width: number; height: number } | null = null
  private _sayTrace: SayStats = { n: 0, sum: 0, max: null, sides: [], odd: [], last: '' }
  private _badgeKey = ''
  private _lx = Number.NaN
  private _ly = Number.NaN
  private _cursor: Point | null = null
  private _ask: AskState | null = null
  private _askWhere: Where | null = null
  private _sayEnd: number | null = null
  private _lines: { text: string; read: number; at: number; end: number | null; how: LineShown['how'] | null }[] = []
  private _repliedAt = Number.NEGATIVE_INFINITY
  private _badgeBlinkAt = 0
  private _shown = true
  private readonly _onMove = (e: MouseEvent): void => {
    if (!e.isTrusted) return
    this._cursor = { x: e.clientX, y: e.clientY }
    this.mind.look(this._cursor)
    if (this._hold || this.mind.paused) this._schedule()
  }
  private readonly _onKey = (e: KeyboardEvent): void => {
    const ask = this._ask
    if (!ask || ask.answer || !e.isTrusted || !this._sayOn || !this._shownNow()) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      this._reply(null, 'the user pressed Escape')
      return
    }
    if (e.key !== 'Enter' || e.isComposing) return
    const doc = this._win.document
    const active = doc.activeElement
    if (active === this._host) return
    if (active && active !== doc.body && active !== doc.documentElement) return
    e.preventDefault()
    this._reply(ask.buttons[0], 'Enter')
  }
  private readonly _onGoal = (e: Event): void => {
    const el = e.target
    if (!(el instanceof this._win.Element) || !el.hasAttribute(GOAL_ATTR) || this._goals.has(el)) return
    if (!this.on || this._leaving) {
      landGoal(el, 'y')
      return
    }
    this._goals.add(el)
    void this.scroll({ kind: 'to', left: GOAL_LEFT_MS }, el)
      .catch(() => null)
      .finally(() => this._goals.delete(el))
  }
  private readonly _goals = new Set<Element>()
  private readonly _onScroll = (): void => {
    if (this.on && !this._pressed && this._ticks.size === 0 && (this.body === 'reach' || this.body === 'side' || this.body === 'up')) {
      this.body = 'idle'
      this._draw()
    }
  }

  constructor(
    private readonly _win: Win,
    private readonly _scope: WorkspaceScope
  ) {}

  private _now(): number {
    return this._clock ?? this._win.performance.now()
  }

  clock(step: boolean): boolean {
    if (step && this._clock === null) {
      this._clock = this._win.performance.now()
      this._last = this._clock
    } else if (!step && this._clock !== null) {
      this._clock = null
      this._last = this._win.performance.now()
    }
    return this._clock !== null
  }

  advance(ms: number): number {
    if (this._clock === null) return -1
    const total = Math.max(0, Number(ms) || 0)
    const n = Math.max(1, Math.ceil(total / 50))
    for (let i = 0; i < n; i++) {
      this._clock += total / n
      this._frame()
    }
    return this._clock
  }

  private _reduced(): boolean {
    try {
      return this._win.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      return false
    }
  }

  private _shownNow(): boolean {
    return this._win.document.visibilityState === 'visible' && this._scope.active()
  }

  private _ensure(): void {
    if (this._host && this._host.isConnected) return
    const doc = this._win.document
    const host = doc.createElement('div')
    host.setAttribute('data-satura-drift', this._scope.id)
    if (!this._menu) host.setAttribute('aria-hidden', 'true')
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:strict;display:block'
    const shadow = host.attachShadow({ mode: 'closed' })
    const style = doc.createElement('style')
    style.textContent = STYLE
    const stage = doc.createElement('div')
    stage.className = 'stage'
    const dim = doc.createElement('div')
    dim.className = 'dim'
    const mark = doc.createElement('div')
    mark.className = 'mark'
    const layer = doc.createElement('div')
    layer.className = 'drift'
    const clip = doc.createElement('div')
    clip.className = 'clip'
    const mw = doc.createElement('div')
    mw.className = 'mw'
    const NS = 'http://www.w3.org/2000/svg'
    const svg = doc.createElementNS(NS, 'svg') as SVGSVGElement
    svg.setAttribute('viewBox', `0 0 ${COLS} ${ROWS}`)
    svg.setAttribute('shape-rendering', 'crispEdges')
    const shade = doc.createElementNS(NS, 'svg') as SVGSVGElement
    shade.setAttribute('viewBox', `0 0 ${COLS} ${ROWS}`)
    shade.setAttribute('class', 'shade')
    const limbs = doc.createElementNS(NS, 'svg') as SVGSVGElement
    limbs.setAttribute('viewBox', `0 0 ${COLS} ${ROWS}`)
    limbs.setAttribute('shape-rendering', 'crispEdges')
    limbs.setAttribute('class', 'limbs')
    const tag = doc.createElement('span')
    tag.className = 'tag'
    mw.append(shade, limbs, svg, tag)
    clip.appendChild(mw)
    const fx = doc.createElement('div')
    fx.className = 'fx'
    const say = doc.createElement('div')
    say.className = 'say'
    this._sayBox = null
    this._sayAnchor = null
    layer.append(clip, fx, say)
    const badge = doc.createElementNS(NS, 'svg') as SVGSVGElement
    badge.setAttribute('viewBox', `0 0 ${COLS} ${ROWS}`)
    badge.setAttribute('shape-rendering', 'crispEdges')
    badge.setAttribute('class', 'badge')
    const grip = doc.createElement('div')
    grip.className = 'grip'
    stage.append(dim, mark, grip, layer, badge)
    shadow.append(style, stage)
    doc.documentElement.appendChild(host)
    doc.documentElement.setAttribute('data-drift-driving', '')
    doc.addEventListener('mousemove', this._onMove, { capture: true, passive: true })
    doc.addEventListener('scroll', this._onScroll, { capture: true, passive: true })
    doc.addEventListener(GOAL_EVENT, this._onGoal, { capture: true })
    this._host = host
    this._layer = layer
    this._clip = clip
    this._mw = mw
    this._svg = svg
    this._limbs = limbs
    this._shade = shade
    this._tag = tag
    host.setAttribute('data-dim', 'off')
    this._fx = fx
    this._dim = dim
    this._dimOn = false
    this._dimKey = ''
    this._dimRect = null
    this._say = say
    this._mark = mark
    this._gripEl = grip
    this._markKey = ''
    this._badge = badge
    this._lastKey = ''
    this._shadeKey = ''
    this._shadeOn = true
    this._badgeKey = ''
    this._lx = Number.NaN
    this._ly = Number.NaN
  }

  private _schedule(): void {
    if (this._scheduled) return
    if (!this._busy()) this._last = this._now()
    this._scheduled = true
    const run = (): void => {
      if (!this._scheduled) return
      this._scheduled = false
      this._win.cancelAnimationFrame(this._raf)
      clearTimeout(this._timer)
      this._frame()
    }
    this._raf = this._win.requestAnimationFrame(run)
    this._timer = setTimeout(run, 100)
  }

  private _busy(): boolean {
    return this._ticks.size > 0 || this.on || this._hold || this.mind.paused || this._sayOn
  }

  private _frame(): void {
    const now = this._now()
    const dt = Math.min(250, Math.max(0, now - this._last))
    this._last = now
    if (!this._frozen) this._vt += dt
    if (this._sayUntil !== null && this._vt >= this._sayUntil) this._fadeSay()
    this._track(now)
    this._drawMark()
    for (const f of [...this._ticks]) f()
    if (this._menu && !this._sayOn && this.on && !this._leaving && !this._travelling && this._ticks.size === 0 && (!this._ask || this._ask.answer)) this._bubble('')
    if (this.on && !this._pressed && this._lingerAt !== null && this._vt >= this._lingerAt) {
      this._lingerAt = null
      const gen = ++this._gen
      void this._leave(gen).catch(quiet)
    }
    const g = this._geo()
    const center = { x: this.x + (g.bx0 + g.bx1) / 2, y: this.y + (g.by0 + g.by1) / 2 }
    const tick = this.mind.tick(now, center, this.on && this.body !== 'ring' && this.body !== 'dust')
    if (tick.quiet) this.resume()
    if (tick.sway && !this._reduced() && (this.body === 'idle' || this.body === 'swim')) this.body = this.body === 'idle' ? 'swim' : 'idle'
    this._draw()
    this._drawBadge(now)
    this._sampleAim(now)
    if (this._busy()) this._schedule()
  }

  private _sampleAim(now: number): void {
    const t = this._target
    if (!t || (t.exact && !this._exactAt) || !this.on || this._leaving || this._travelling || this._pressed) return
    const tip = this._tip()
    if (!tip) return
    const r = t.read(now)
    if (!t.exact && (r.state !== 'ok' || !r.box || !r.point)) return
    const p = r.point ?? this._exactAt!
    if (this._aim.length >= AIM_MAX) this._aim.shift()
    const k = t.exact ? (r.keep ?? null) : r.box!
    const off = t.exact ? Math.hypot(tip.x - p.x, tip.y - p.y) : Math.hypot(Math.max(0, k!.x - tip.x, tip.x - k!.x - k!.width), Math.max(0, k!.y - tip.y, tip.y - k!.y - k!.height))
    this._aim.push({ t: Math.round(now), tip: { x: round1(tip.x), y: round1(tip.y) }, at: { x: round1(p.x), y: round1(p.y) }, via: t.exact ? (r.via ?? '') : 'box', keep: k ? { x: Math.round(k.x), y: Math.round(k.y), width: Math.round(k.width), height: Math.round(k.height) } : null, d: round1(off) })
  }

  sayTrace(): SayStats {
    const out = this._sayTrace
    this._sayTrace = { n: 0, sum: 0, max: null, sides: [], odd: [], last: '' }
    return out
  }

  lineTrace(): LineShown[] {
    const out = this._lines.map((l) => ({ text: l.text, read: Math.round(l.read), up: Math.round((l.end ?? this._vt) - l.at), how: l.how ?? 'up' }))
    this._lines = this._lines.filter((l) => l.how === null)
    return out
  }

  private _lineEnd(how: 'read' | 'cut' | 'replaced'): void {
    const l = this._lines[this._lines.length - 1]
    if (!l || l.how !== null) return
    l.end = this._vt
    l.how = how
  }

  aimTrace(): { target: string; samples: AimSample[] } {
    return { target: this._target?.desc ?? '', samples: this._aim.splice(0) }
  }

  private _tween(gen: number, ms: number, fn: (t: number) => void, start?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const t0 = start ?? this._vt
      const f = (): void => {
        if (gen !== this._gen) {
          this._ticks.delete(f)
          reject(CANCEL)
          return
        }
        const instant = ms <= 0 || this._snapGen === gen || !this._shownNow()
        const t = instant ? 1 : Math.min(1, (this._vt - t0) / ms)
        fn(t)
        if (t >= 1) {
          this._ticks.delete(f)
          resolve()
        }
      }
      this._ticks.add(f)
      f()
      this._schedule()
    })
  }

  private _wait(gen: number, ms: number, start?: number): Promise<void> {
    return this._tween(gen, ms, () => {}, start)
  }

  private _geo(): PoseGeo {
    return poseGeo(this.pose, this.mirror, this._S)
  }

  private _reachBody(): Body {
    return this.pose
  }

  private _pressBody(): Body {
    return this.pose === 'side' ? 'sidePress' : this.pose === 'up' ? 'up' : 'press'
  }

  private _choosePose(A: Point): void {
    const before = this._geo()
    const view = { width: this._win.innerWidth, height: this._win.innerHeight }
    const next = this._target?.exact && !this._slide ? exactPose(A, this._box, view, this._S) : placeHand(A, this._box, view, this._S, false)
    this.pose = next.pose
    this.mirror = next.mirror
    const after = this._geo()
    if (this.on) {
      this.x += before.bx0 - after.bx0
      this.y += before.by0 - after.by0
    }
  }

  private _setClip(at: number | null): void {
    if (!this._host) return
    this._clip.style.clipPath = at === null ? 'none' : `inset(0 0 ${Math.max(0, this._win.innerHeight - at)}px 0)`
  }

  private _paneBottom(A: Point): number {
    const H = this._win.innerHeight
    let best: DOMRect | null = null
    for (const el of Array.from(this._win.document.querySelectorAll('[data-group-id],[data-pane]'))) {
      if (!this._scope.owns(el)) continue
      const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility
      if (check && !check.call(el, { checkOpacity: true, checkVisibilityCSS: true })) continue
      const r = clientRect(el)
      if (r.width < 2 || r.height < 2) continue
      if (A.x < r.left || A.x > r.right || A.y < r.top || A.y > r.bottom) continue
      if (!best || r.width * r.height < best.width * best.height) best = r
    }
    return Math.min(best ? best.bottom : H, H)
  }

  private _planEmerge(T: Point): EmergePlan {
    const g = this._geo()
    const S = this._S
    const edge = this._paneBottom({ x: T.x + g.hx, y: T.y + g.hy })
    const out = edge - g.by1 - 2
    const start = { x: T.x, y: edge - g.by0 }
    let end = { x: T.x, y: out }
    let keep = false
    const a0 = T.y + g.by0
    const a1 = T.y + g.by1
    const vf = clamp(edge - a0, 0, a1 - a0) / (a1 - a0)
    if (T.y >= out && vf >= 0.45 && T.y + g.ey + S <= edge) {
      end = { x: T.x, y: T.y }
      keep = vf < 1
    }
    return { edge, start, end, keep }
  }

  private _place(A: Point): void {
    this._choosePose(A)
    const g = this._geo()
    this.x = A.x - g.hx
    this.y = A.y - g.hy
  }

  private _live(t: Anchor | null | undefined): { box: Box; point: Point; clip: Box | null } | null {
    if (!t) return null
    const r = t.read(this._now())
    return r.state === 'ok' && r.box && r.point ? { box: t.exact && r.keep ? r.keep : r.box, point: r.point, clip: r.clip ?? null } : null
  }

  private _areaLive(t: Anchor | null | undefined): { box: Box; point: Point } | null {
    const live = this._live(t)
    if (!live || !t || t.exact || !isArea(live.box, this._S)) return live
    t.frac = fracOf(live.box, areaPoint(live.box, this._S))
    return this._live(t)
  }

  private _bind(target: Anchor | null, A: Point, slide: boolean): void {
    const live = this._live(target)
    this._target = live ? target : null
    this._watch = null
    this._stuck = false
    this._slide = slide
    this._lost = null
    this._loudUntil = null
    this._follows = 0
    this._movedAt = Number.NEGATIVE_INFINITY
    this._exactAt = live && target?.exact ? live.point : null
    this._aim = []
    if (!live) return
    this._box = live.box
    this._markClip = live.clip
    this._handOff = { x: A.x - live.point.x, y: A.y - live.point.y }
  }

  private _track(now: number): void {
    const t = this._target
    if (!this.on || this._leaving || this._pressed || !this._shownNow()) return
    if (!t) {
      this._rewatch(now)
      return
    }
    const r = t.read(now)
    if (r.state !== 'ok') {
      this._lose(t, r.state)
      return
    }
    this._markClip = r.clip ?? null
    const box = t.exact && r.keep ? r.keep : r.box
    if (!box || !r.point) return
    const still = !this._exactAt || (Math.abs(this._exactAt.x - r.point.x) < 0.25 && Math.abs(this._exactAt.y - r.point.y) < 0.25)
    if (sameBox(box, this._box) && still) return
    if (t.exact) this._exactAt = r.point
    const hand = { x: r.point.x + this._handOff.x, y: r.point.y + this._handOff.y }
    const prev = this._anchor ?? hand
    this._box = box
    this._anchor = hand
    if (now - this._movedAt > FOLLOW_GAP_MS) this._follows++
    this._movedAt = now
    if (this._travelling) return
    this.x += hand.x - prev.x
    this.y += hand.y - prev.y
    this._fit(box, r.point)
    if (this._sayOn) this._placeSay()
  }

  private _drawMark(): void {
    const el = this._mark
    if (!el) return
    const b = this._box
    const show = !!b && !this._markOff && !this._stuck && !this._win.document.documentElement.hasAttribute('data-capture') && this.on && !this._leaving && this._shownNow() && b.width > 0 && b.height > 0
    if (!show) {
      if (this._markKey !== '') {
        this._markKey = ''
        el.classList.remove('on')
      }
      return
    }
    const pad = 3
    const outer = { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }
    const c = this._markClip
    const fit = c ? { x: Math.max(outer.x, c.x + 1), y: Math.max(outer.y, c.y + 1), width: 0, height: 0 } : outer
    if (c) {
      fit.width = Math.min(outer.x + outer.width, c.x + c.width - 1) - fit.x
      fit.height = Math.min(outer.y + outer.height, c.y + c.height - 1) - fit.y
    }
    if (!(fit.width > 4 && fit.height > 4)) {
      if (this._markKey !== '') {
        this._markKey = ''
        el.classList.remove('on')
      }
      return
    }
    const x = Math.round(fit.x)
    const y = Math.round(fit.y)
    const w = Math.round(fit.x + fit.width) - x
    const h = Math.round(fit.y + fit.height) - y
    const key = `${x},${y},${w},${h}`
    if (key === this._markKey) return
    this._markKey = key
    el.style.transform = `translate3d(${x}px,${y}px,0)`
    el.style.width = `${w}px`
    el.style.height = `${h}px`
    el.classList.add('on')
  }

  private _fit(box: Box, point: Point): void {
    const g = this._geo()
    const bell = { x: this.x + g.bx0, y: this.y + g.by0, width: g.bx1 - g.bx0, height: g.by1 - g.by0 }
    const view = { width: this._win.innerWidth, height: this._win.innerHeight }
    const off = bell.x < 2 || bell.y < 2 || bell.x + bell.width > view.width - 2 || bell.y + bell.height > view.height - 2
    if (!off && !overlaps(bell, box)) return
    const at = this._slide ? placeHand(point, box, view, this._S, true) : { x: point.x + this._handOff.x, y: point.y + this._handOff.y }
    this._handOff = { x: at.x - point.x, y: at.y - point.y }
    this._anchor = { x: at.x, y: at.y }
    this._place(this._anchor)
  }

  private _rewatch(now: number): void {
    const w = this._watch
    if (!w || this._travelling) return
    const r = w.read(now)
    if (r.state === 'gone') this._watch = null
    if (r.state !== 'ok' || !r.box || !r.point) return
    this._regain(w, r)
  }

  private _regain(t: Anchor, r: AnchorRead): void {
    const point = r.point!
    const box = t.exact && r.keep ? r.keep : r.box!
    this._watch = null
    this._target = t
    this._lost = null
    this._box = box
    this._markClip = r.clip ?? null
    if (t.exact) this._exactAt = point
    const hand = { x: point.x + this._handOff.x, y: point.y + this._handOff.y }
    this._anchor = hand
    this._place(hand)
    this.body = this._reachBody()
    this._fit(box, point)
    if (this._sayOn && Object.values(LOST_LINES).includes(this._sayText)) this._fadeSay()
    else if (this._sayOn) this._placeSay()
    this._draw()
  }

  private _stick(): void {
    const at = this._anchor
    if (!at || !this.on || this._target) return
    const el = this._scope.hitTest(at.x, at.y)
    if (!el) return
    const r = clientRect(el)
    if (!(r.width > 0 && r.height > 0)) return
    const base = { x: r.x, y: r.y, width: r.width, height: r.height }
    const f = fracOf(base, at)
    const spot = (e: Element): Box | null => {
      const b = clientRect(e)
      if (!(b.width > 0 && b.height > 0)) return null
      const p = edgePoint({ x: b.x, y: b.y, width: b.width, height: b.height }, base, f)
      return { x: p.x - 8, y: p.y - 8, width: 16, height: 16 }
    }
    const t = new Anchor(this._win, el, { x: 0.5, y: 0.5 }, 'where it let go', this._scope, null, () => 'where it let go', spot)
    this._bind(t, at, false)
    this._stuck = true
  }

  private _lose(t: Anchor, state: AnchorState): void {
    this._target = null
    this._watch = state === 'gone' ? null : t
    if (POINTING.has(this.body)) this.body = 'idle'
    this._box = null
    this._markClip = null
    const loud = this._loudUntil !== null && this._vt <= this._loudUntil
    this._loudUntil = null
    if (!loud) return
    this._lost = { desc: t.desc, state }
    this.mind.puzzled(this._now())
    if (!this._ask || this._ask.answer) {
      this._hideSay()
      this._lingerAt = null
      this._bubble(LOST_LINES[state])
    }
    this._draw()
  }

  aimedAt(): Element | null {
    return this._travelling || this._pressed ? null : ((this._target ?? this._watch)?.el ?? null)
  }

  where(): Where {
    const now = this._now()
    this._track(now)
    const g = this._geo()
    const t = this._target
    let box: Box | null = null
    let hit = ''
    let state: AnchorState | 'none' = 'none'
    if (t) {
      const r = t.read(now)
      state = r.state
      box = r.box
      if (r.state === 'ok' && r.point && this._shownNow()) {
        const h = t.hit(r.point)
        hit = h.ok ? 'ok' : `covered by ${h.by}`
      }
    }
    return {
      on: this.on,
      shown: this._shownNow(),
      hand: { x: this.x + g.hx, y: this.y + g.hy },
      target: t?.desc ?? this._lost?.desc ?? '',
      box,
      hit,
      state: this._lost ? this._lost.state : state,
      lost: !!this._lost,
      follows: this._follows,
      refound: t?.refound ?? 0
    }
  }

  bind(name: string): void {
    this._name = name || 'Agent'
  }

  begin(name: string): void {
    this._dropAsk()
    this._spotUntil = null
    this._dimRect = null
    this._dimCircle = null
    this._name = name || 'Agent'
    this._gen++
    this._hold = false
    this._pressed = false
    this._ungrab()
    this._lingerAt = null
    this._frozen = false
    this._anchor = null
    this._box = null
    this._markClip = null
    this._lost = null
    this.mind.reset(this._now())
    this._hide()
    this._ensure()
  }

  approach(a: ApproachArgs): Promise<ApproachResult> {
    this._ensure()
    this._spotUntil = null
    const first = !this.on || this._leaving
    const cap = capFor(first, a.left)
    const live = this._live(a.target)
    const { ms, full } = this._go(live ? live.point : { x: a.x, y: a.y }, live ? live.box : a.box, cap, this._travelling && this._pending ? '' : (a.line ?? ''), a.rest ? 'rest' : 'arrive', undefined, live ? a.target! : null)
    const shown = this._shownNow()
    const reduced = this._reduced()
    return new Promise((resolve) => setTimeout(() => resolve({ ms, full, first, shown, reduced, where: this.where() }), this._clock === null ? ms : 0))
  }

  point(a: { x: number; y: number; box: Box | null; text: string; ms?: number; slide?: boolean; within?: Box | null; spotlight?: boolean; target?: Anchor | null; mark?: boolean }): { travel: number; read: number; shown: boolean; text: string; x: number; y: number } {
    this._ensure()
    this._markOff = a.mark === false
    const text = bubbleText(a.text)
    const first = !this.on || this._leaving
    const read = text ? bubbleMs(text, a.ms) : 0
    this._S = pixelSize(this._win.devicePixelRatio || 1, CELL_BASE * this.cell)
    const live = this._areaLive(a.target)
    const box = live ? live.box : a.box
    const P = live ? live.point : box && isArea(box, this._S) ? areaPoint(box, this._S) : { x: a.x, y: a.y }
    const slide = !!a.slide && !!box
    const at = slide && box ? placeHand(P, box, { width: this._win.innerWidth, height: this._win.innerHeight }, this._S, true, a.within ?? null) : P
    const travel = this._go({ x: at.x, y: at.y }, box, first ? CAP_FIRST_MS : CAP_NEXT_MS, text, 'arrive', read, live ? a.target! : null, slide).ms
    if (text) this._sayEnd = this._vt + travel + read
    if (this._target) this._loudUntil = this._vt + travel + read
    this._spotUntil = a.spotlight === true ? this._vt + travel + read : null
    const shown = this._shownNow()
    if (this.on) this._lingerAt = null
    return { travel, read: shown ? read : 0, shown, text, x: at.x, y: at.y }
  }

  stroke(dx: number, dy: number): void {
    if (!this.on || this._reduced() || !this._shownNow()) return
    const gen = this._gen
    this._lingerAt = null
    const S = this._S
    const horizontal = Math.abs(dx) > Math.abs(dy)
    const d = horizontal ? dx : dy
    if (!d) return
    const off = -Math.sign(d) * S
    const x0 = this.x
    const y0 = this.y
    const body = this.body === 'press' || this.body === 'sidePress' ? this.body : this._reachBody()
    void this._tween(gen, 140, (t) => {
      const k = t < 0.5 ? easeOut(t * 2) : 1 - easeOut((t - 0.5) * 2)
      const b = this._goal({ x: x0, y: y0 })
      this.x = horizontal ? b.x + off * k : b.x
      this.y = horizontal ? b.y : b.y + off * k
      this.body = t < 0.5 ? this._pressBody() : body
      this._draw()
    }).catch(quiet)
  }

  scroll(a: ScrollArgs, node: Element | null = null): Promise<ScrollResult> {
    const t0 = this._now()
    const out = (r: Partial<ScrollResult>): ScrollResult => ({ mode: 'none', axis: null, native: false, moved: 0, remaining: { dx: a.dx ?? 0, dy: a.dy ?? 0 }, interrupted: false, gone: false, ms: Math.round(this._now() - t0), travel: 0, frames: 0, maxStep: 0, outside: 0, ...r })
    const win = this._win
    if (!this._shownNow() || this._reduced()) {
      if (a.kind === 'to' && node) landGoal(node, 'y')
      return Promise.resolve(out({ mode: 'hidden' }))
    }
    let axis: Axis = 'y'
    let el: Element | null = null
    let delta = 0
    if (a.kind === 'wheel') {
      const dx = Number(a.dx) || 0
      const dy = Number(a.dy) || 0
      axis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x'
      delta = axis === 'y' ? dy : dx
      if (!delta) return Promise.resolve(out({ mode: 'none' }))
      el = scrollerAt(win, Number(a.x) || 0, Number(a.y) || 0, axis, Math.sign(delta))
    } else if (a.kind === 'to') {
      if (!node || !node.isConnected) return Promise.resolve(out({ gone: true }))
      if (stateOf(node, 'y').max < 1 || !alive(win, node)) {
        landGoal(node, 'y')
        return Promise.resolve(out({ mode: 'none' }))
      }
      el = node
      node = null
    } else {
      if (!node || !node.isConnected) return Promise.resolve(out({ gone: true }))
      el = scrollerFor(win, node, 'y')
      if (!el) {
        axis = 'x'
        el = scrollerFor(win, node, 'x')
      }
      if (!el) return Promise.resolve(out({ mode: 'visible' }))
    }
    if (!el || (el !== win.document.scrollingElement && !alive(win, el))) return Promise.resolve(out({ mode: 'none', axis }))
    this._ensure()
    return this._thumbDrag(el, axis, delta, node, a, out)
  }

  private _goalOf(el: Element, axis: Axis, a: ScrollArgs, node: Element | null, s: ScrollState, base: number, delta: number): number {
    if (node) return wantFor(this._win, el, node, axis, a.rect, true) ?? s.pos
    if (a.kind === 'to') return goalAttr(el, s)
    return clamp(base + delta, 0, s.max)
  }

  private async _thumbDrag(el: Element, axis: Axis, delta: number, node: Element | null, a: ScrollArgs, out: (r: Partial<ScrollResult>) => ScrollResult): Promise<ScrollResult> {
    const win = this._win
    const first = !this.on || this._leaving
    const start = thumbOf(win, el, axis)
    const travel = this._go(start.center, start.box, capFor(first, a.left), a.line ?? '', 'arrive').ms
    if (travel > 0) await new Promise((r) => setTimeout(r, travel))
    let interrupted = false
    const stop = (e: Event): void => {
      if (e.isTrusted) interrupted = true
    }
    for (const t of USER_TYPES) win.addEventListener(t, stop, { capture: true, passive: true })
    const s0 = stateOf(el, axis)
    const goal0 = this._goalOf(el, axis, a, node, s0, s0.pos, delta)
    const span = Math.max(0, s0.view - (axis === 'y' ? start.box.height : start.box.width))
    const dist = Math.abs(goal0 - s0.pos)
    const thumbPx = s0.max > 0 ? (dist / s0.max) * span : 0
    const ms = Math.round(Math.min(clamp(Math.max(90 + thumbPx * 1.1, 110 + dist * 0.16), 140, 280), Math.max(70, (a.left - travel) * 0.5)))
    let from = s0.pos
    let base = s0.pos
    let last = s0.pos
    let moved = 0
    let frames = 0
    let maxStep = 0
    let outside = 0
    let gone = false
    const gen = ++this._gen
    this._pressed = true
    this._lingerAt = null
    const g = this._geo()
    const pressBody = this._pressBody()
    this._box = null
    this._markClip = null
    this._gripEl?.classList.add('on')
    try {
      await new Promise<void>((resolve) => {
        const v0 = this._vt
        const f = (): void => {
          const done = (): void => {
            this._ticks.delete(f)
            resolve()
          }
          if (gen !== this._gen || interrupted) return done()
          if ((el !== win.document.scrollingElement && !alive(win, el)) || (node && !node.isConnected)) {
            gone = true
            return done()
          }
          const k = ms <= 0 || !this._shownNow() ? 1 : Math.min(1, (this._vt - v0) / ms)
          const s = stateOf(el, axis)
          if (Math.abs(s.pos - last) > 1) {
            outside++
            from += s.pos - last
            base += s.pos - last
          }
          const goal = this._goalOf(el, axis, a, node, s, base, delta)
          const got = setPos(el, axis, from + (goal - from) * easeInOut(k))
          maxStep = Math.max(maxStep, Math.abs(got - s.pos))
          moved += got - s.pos
          last = got
          frames++
          const th = thumbOf(win, el, axis)
          this._grip(th.box)
          this._anchor = th.center
          this.x = th.center.x - g.hx
          this.y = th.center.y - g.hy
          this.body = pressBody
          if (k >= 1) done()
        }
        this._ticks.add(f)
        f()
        this._schedule()
      })
    } finally {
      if (a.kind === 'to') {
        if (gen === this._gen && !interrupted && !gone) landGoal(el, axis)
        else el.removeAttribute(GOAL_ATTR)
      }
      for (const t of USER_TYPES) win.removeEventListener(t, stop, { capture: true })
      this._gripEl?.classList.remove('on')
      this._pressed = false
      if (gen === this._gen) {
        this.body = this._reachBody()
        this._draw()
      }
    }
    const s = el.isConnected ? stateOf(el, axis) : null
    const left = !node && s ? clamp(base + delta, 0, s.max) - s.pos : 0
    const remaining = axis === 'y' ? { dx: 0, dy: left } : { dx: left, dy: 0 }
    return out({ mode: 'thumb', axis, native: start.native, moved: Math.round(moved), remaining, interrupted, gone, travel, frames, maxStep: Math.round(maxStep), outside })
  }

  private _grip(b: Box | null): void {
    const el = this._gripEl
    if (!el || !b) return
    el.style.left = `${b.x}px`
    el.style.top = `${b.y}px`
    el.style.width = `${b.width}px`
    el.style.height = `${b.height}px`
  }

  private _go(A: Point, box: Box | null, cap: number, line: string, then: 'arrive' | 'puzzled' | 'rest' | 'worried', lineMs?: number, target: Anchor | null = null, slide = false): { ms: number; full: number } {
    const now = this._now()
    const gen = ++this._gen
    if (!line && this._travelling && this._pending) {
      line = this._pending.line
      lineMs = this._pending.ms
    }
    this._pending = null
    this._lineMs = lineMs
    const first = !this.on || this._leaving
    this._lingerAt = null
    this._leaving = false
    this._pressed = false
    this._ungrab()
    this._S = pixelSize(this._win.devicePixelRatio || 1, CELL_BASE * this.cell)
    const stay = !line && !!this._anchor && Math.hypot(this._anchor.x - A.x, this._anchor.y - A.y) < 2
    this._anchor = A
    if (!stay) {
      this._box = box
      this._markClip = null
      this._hideSay()
    }
    this._bind(target, A, slide)
    this._travelling = false
    let full = 0
    let trip: { T: Point; em: EmergePlan | null; plan: Plan } | null = null
    if (this._shownNow() && !this._reduced()) {
      this._choosePose(A)
      const g = this._geo()
      const T = { x: A.x - g.hx, y: A.y - g.hy }
      const em = first ? this._planEmerge(T) : null
      const from = em ? em.end : { x: this.x, y: this.y }
      const raw = planApproach(first, Math.hypot(T.x - from.x, T.y - from.y))
      full = planTotal(raw)
      const plan = budgetPlan(raw, cap)
      if (planTotal(plan) > 0) trip = { T, em, plan }
    }
    if (!trip) {
      this._place(A)
      this.on = true
      this.alpha = 1
      this.rest = 'idle'
      this._keepClip = null
      this._setClip(null)
      if (first) this.mind.appear(now)
      this._arrived(then, line)
      this._schedule()
      return { ms: 0, full }
    }
    this._travelling = true
    if (line) this._pending = { line, ms: lineMs }
    void this._approachSeq(gen, trip.T, trip.em, trip.plan, line, then, this._vt).catch(quiet)
    return { ms: planTotal(trip.plan), full }
  }

  private _goal(T0: Point): Point {
    const A = this._anchor
    if (!this._target || !A) return T0
    const g = this._geo()
    return { x: A.x - g.hx, y: A.y - g.hy }
  }

  private _arrived(then: 'arrive' | 'puzzled' | 'rest' | 'worried', line: string): void {
    const now = this._now()
    this._travelling = false
    this._pending = null
    if (this._target && this._box && this._anchor) this._fit(this._box, { x: this._anchor.x - this._handOff.x, y: this._anchor.y - this._handOff.y })
    if (then === 'worried') {
      this.mind.worried()
      this.body = 'limp'
      this.rest = 'limp'
    } else if (then === 'rest') {
      this.body = 'idle'
      this.mind.rest()
    } else {
      this.body = this._reachBody()
      if (!this._target && this._watch) this.body = 'idle'
      this.mind.arrive(this.mirror, this.pose, now)
      if (then === 'puzzled') this.mind.puzzled(now)
    }
    this._draw()
    if (line) this._bubble(line, this._lineMs)
  }

  private async _approachSeq(gen: number, T: Point, em: EmergePlan | null, plan: Plan, line: string, then: 'arrive' | 'puzzled' | 'rest' | 'worried', s0: number): Promise<void> {
    if (em) await this._emerge(gen, T, em, plan.emerge, s0)
    await this._travel(gen, T, plan.travel, s0 + plan.emerge)
    this._arrived(then, line)
    if (plan.beat) await this._wait(gen, plan.beat, s0 + plan.emerge + plan.travel)
  }

  private async _emerge(gen: number, T: Point, p: EmergePlan, ms: number, start: number): Promise<void> {
    this.x = p.start.x
    this.y = p.start.y
    this.on = true
    this.alpha = 1
    this.body = 'idle'
    this.rest = 'idle'
    this.mind.vanish()
    this.mind.appear(this._now())
    this._setClip(p.edge)
    this.mind.travel(p.start, T, this._now())
    await this._tween(gen, ms, (t) => {
      const e = easeOut(t)
      const G = this._goal(T)
      this.x = lerp(p.start.x, p.end.x, e) + G.x - T.x
      this.y = lerp(p.start.y, p.end.y + G.y - T.y, e)
      this.body = t < 0.35 ? 'swim' : 'idle'
      this._draw()
    }, start)
    this._keepClip = p.keep ? p.edge : null
    if (!p.keep) this._setClip(null)
  }

  private async _travel(gen: number, T: Point, ms: number, start: number): Promise<void> {
    const P = { x: this.x, y: this.y }
    const d = Math.hypot(T.x - P.x, T.y - P.y)
    const kc = this._keepClip
    this._keepClip = null
    if (d < 0.5) {
      const G = this._goal(T)
      this.x = G.x
      this.y = G.y
      if (kc !== null) this._keepClip = kc
      return
    }
    if (kc === null) this._setClip(null)
    this.mind.travel(P, T, this._now())
    const H = this._win.innerHeight
    await this._tween(gen, ms, (t) => {
      if (kc !== null) this._setClip(lerp(kc, H, Math.min(1, t * 2)))
      const e = easeOut(t)
      const G = this._goal(T)
      this.x = lerp(P.x, G.x, e)
      this.y = lerp(P.y, G.y, e)
      this.body = t < 0.3 ? 'swim' : 'idle'
      this._draw()
    }, start)
    if (kc !== null) this._setClip(null)
  }

  press(x: number, y: number): void {
    if (!this.on) return
    this._pressed = true
    this._lingerAt = null
    const at = { x, y }
    if (this._ticks.size > 0) this._snapGen = this._gen
    this._travelling = false
    const live = this._live(this._target)
    if (live) this._handOff = { x: at.x - live.point.x, y: at.y - live.point.y }
    this._anchor = at
    this._ungrab()
    this._down = { x, y }
    this._place(at)
    this.body = this._pressBody()
    this._draw()
    this.lastPress = { marker: null, tip: this._tip() }
    if (this._reduced() || !this._shownNow() || !this._host) return
    const el = this._win.document.createElement('div')
    el.className = 'rip'
    el.style.left = `${at.x}px`
    el.style.top = `${at.y}px`
    this._fx.appendChild(el)
    const r = el.getBoundingClientRect()
    this.lastPress.marker = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    setTimeout(() => el.remove(), 420)
  }

  lastPress: { marker: Point | null; tip: Point | null } | null = null

  private _tip(): Point | null {
    if (!this._host || !this._shownNow()) return null
    const r = this._limbs.querySelector('rect[fill="#ffffff"]')?.getBoundingClientRect()
    return r && r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
  }

  drag(x: number, y: number): void {
    if (!this.on || !this._pressed) return
    if (this._ticks.size > 0) this._snapGen = this._gen
    this._target = null
    this._watch = null
    this._travelling = false
    const now = this._now()
    const d = this._down
    if (!this._grab && d && Math.hypot(x - d.x, y - d.y) > GRAB_PX) this._startGrab(d, now)
    const g = this._geo()
    this.x = x - g.hx
    this.y = y - g.hy
    this._anchor = { x, y }
    const G = this._grab
    if (G) {
      G.x = x
      G.y = y
    }
    this.body = this._pressBody()
    this._hideSay()
    this._draw()
    if (G && this.lastGrab) {
      this.lastGrab.moves++
      this.lastGrab.mid = this.state()
    }
  }

  private _startGrab(d: Point, now: number): void {
    this._grab = { x: d.x, y: d.y }
    this.lastGrab = { mid: null, after: null, moves: 0 }
    this.mind.grabbing(true, now)
  }

  private _ungrab(): void {
    const G = this._grab
    this._down = null
    if (!G) return
    this._grab = null
    this.mind.grabbing(false, this._now())
  }

  release(): void {
    if (!this._pressed) return
    this._pressed = false
    const grabbed = !!this._grab
    this._ungrab()
    this._stick()
    if (this.on && (this.body === 'press' || this.body === 'sidePress')) {
      this.body = this._reachBody()
      this._draw()
    }
    if (grabbed && this.lastGrab) this.lastGrab.after = this.state()
  }

  done(pleased: boolean): void {
    this._puzzleLine = ''
    if (!this.on) return
    this._pressed = false
    this._ungrab()
    if (this.body === 'press' || this.body === 'sidePress') this.body = this._reachBody()
    if (this.mind.waitingSince !== null) this.mind.arrive(this.mirror, this.pose, this._now())
    if (pleased) this.mind.pleased(this._now())
    const read = this._sayEnd !== null && (this._sayOn || this._travelling) ? this._sayEnd : 0
    this._lingerAt = Math.max(this._vt + (this._reduced() ? RISE.reducedLinger : RISE.linger), read)
    this._schedule()
  }

  puzzled(raw: Box | null, line: string, target?: Anchor | null): boolean {
    this._ensure()
    const before = this._puzzleLine
    const live = this._live(target)
    const box = live ? live.box : raw
    if (box) {
      const A = live ? live.point : { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      const bound = !!live && this._target?.el === target!.el
      const there = this.on && !this._leaving && this._anchor && (bound || Math.hypot(this._anchor.x - A.x, this._anchor.y - A.y) < 2)
      if (!there) {
        this._puzzleLine = line
        this._go(A, box, capFor(!this.on, CAP_FIRST_MS), this.mind.waitingSince === null || line !== before ? line : '', 'puzzled', undefined, live ? target! : null)
        return true
      }
    } else if ((!this.on || this._leaving) && line) {
      if (!this._shownNow()) return false
      this._puzzleLine = line
      this._go(this._peekPoint(), null, CAP_FIRST_MS, line, 'puzzled')
      return true
    }
    if (!this.on) return false
    this._lingerAt = null
    const fresh = this.mind.puzzled(this._now())
    const changed = !!line && line !== before
    this._puzzleLine = line
    if (line && (fresh || changed)) this._bubble(line)
    this._draw()
    this._schedule()
    return fresh || changed
  }

  private _peekPoint(): Point {
    const info = this._scope.info()
    const view = info.rect ?? { x: 0, y: 0, width: this._win.innerWidth, height: this._win.innerHeight }
    const panels: Box[] = []
    for (const el of Array.from(this._win.document.querySelectorAll('[data-group-id]'))) {
      if (!this._scope.owns(el)) continue
      const r = clientRect(el)
      const x0 = Math.max(r.x, view.x)
      const y0 = Math.max(r.y, view.y)
      const x1 = Math.min(r.x + r.width, view.x + view.width)
      const y1 = Math.min(r.y + r.height, view.y + view.height)
      if (x1 - x0 >= 120 && y1 - y0 >= 120) panels.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
    }
    const a = this._anchor
    const inside = (b: Box): boolean => !!a && a.x >= b.x && a.x <= b.x + b.width && a.y >= b.y && a.y <= b.y + b.height
    const pick = panels.find(inside) ?? panels.sort((p, q) => q.width * q.height - p.width * p.height)[0] ?? view
    return { x: pick.x + pick.width / 2, y: pick.y + pick.height / 2 }
  }

  worried(line: string): void {
    this._ensure()
    this._puzzleLine = ''
    const gen = ++this._gen
    this._lingerAt = null
    this._pressed = false
    this._ungrab()
    if (!this.on) {
      if (line && this._shownNow()) this._peek(line, 'worried')
      return
    }
    this.mind.worried()
    this.body = 'limp'
    this.rest = 'limp'
    this._draw()
    if (line) this._bubble(line)
    void (async () => {
      await this._wait(gen, EMOTION_MS.worried)
      await this._leave(gen)
    })().catch(quiet)
  }

  user(x: number | null, y: number | null): boolean {
    const at = typeof x === 'number' && typeof y === 'number' ? { x, y } : null
    if (at) this._cursor = at
    if ((this._ask && !this._ask.answer) || this._now() - this._repliedAt < REPLY_CALM_MS) {
      if (at) this.mind.look(at)
      this._schedule()
      return false
    }
    const startled = this.mind.user(at, this._now())
    if (startled) {
      this._frozen = true
      this._showTag()
    }
    this._draw()
    this._schedule()
    return startled
  }

  resume(): boolean {
    if (!this.mind.resume(this._now())) return false
    this._frozen = false
    if (this._ticks.size > 0) this._snapGen = this._gen
    this._showTag()
    this._draw()
    this._schedule()
    return true
  }

  private _showTag(): void {
    if (!this._host) return
    const on = this.mind.paused && this.on && this._reduced()
    this._tag.textContent = `${this._name} ${WAITING}`
    this._tag.classList.toggle('on', on)
  }

  say(raw: unknown, ms?: unknown, spotlight?: unknown): string {
    return this.sayFor(raw, ms, spotlight).text
  }

  sayFor(raw: unknown, ms?: unknown, spotlight?: unknown): { text: string; travel: number; read: number; shown: boolean } {
    const text = bubbleText(raw)
    if (!text) return { text: '', travel: 0, read: 0, shown: false }
    this._ensure()
    this._spotUntil = null
    if (!this._shownNow()) return { text, travel: 0, read: 0, shown: false }
    const read = bubbleMs(text, ms)
    let travel = 0
    if (this.on && !this._leaving && this._target) {
      this._bubble(text, read)
      if (this._lingerAt !== null) this._lingerAt = Math.max(this._lingerAt, this._vt + read)
    } else if (this.on && !this._leaving) {
      travel = this._go(this._peekPoint(), null, CAP_NEXT_MS, text, 'rest', read).ms
      this._sayEnd = this._vt + travel + read
      if (this._lingerAt !== null) this._lingerAt = Math.max(this._lingerAt, this._vt + travel + read)
    } else {
      travel = this._peek(text, 'rest', ms)
      this._sayEnd = this._vt + travel + read
    }
    if (spotlight === true) this._spotUntil = this._vt + travel + read
    return { text, travel, read, shown: true }
  }

  ask(a: { x?: number | null; y?: number | null; box?: Box | null; text: string; buttons: string[]; focus?: boolean; target?: Anchor | null }): { travel: number; shown: boolean; text: string } {
    this._ensure()
    this._spotUntil = null
    const text = bubbleText(a.text)
    const buttons = a.buttons.map((b) => bubbleText(b)).filter(Boolean)
    this._ask = { text, buttons: buttons.length ? buttons : ['Next'], answer: null, back: null, focus: a.focus === true, focused: false }
    this._win.document.addEventListener('keydown', this._onKey, { capture: true })
    this._host?.removeAttribute('aria-hidden')
    let travel = 0
    const first = !this.on || this._leaving
    this._S = pixelSize(this._win.devicePixelRatio || 1, CELL_BASE * this.cell)
    const live = this._areaLive(a.target)
    if (live || (typeof a.x === 'number' && typeof a.y === 'number')) {
      const box = live ? live.box : (a.box ?? null)
      const P = live ? live.point : box && isArea(box, this._S) ? areaPoint(box, this._S) : { x: a.x as number, y: a.y as number }
      const at = box ? placeHand(P, box, { width: this._win.innerWidth, height: this._win.innerHeight }, this._S, true, null) : P
      travel = this._go(at, box, first ? CAP_FIRST_MS : CAP_NEXT_MS, text, 'arrive', undefined, live ? a.target! : null, !!box).ms
      if (this._target) this._loudUntil = Number.POSITIVE_INFINITY
    } else if (!first && this._target) {
      this._lingerAt = null
      this._bubble(text)
    } else travel = this._go(this._peekPoint(), null, first ? CAP_FIRST_MS : CAP_NEXT_MS, text, 'rest').ms
    this._lingerAt = null
    this.mind.asking(true)
    if (this._cursor) this.mind.look(this._cursor)
    this._schedule()
    return { travel, shown: this._shownNow(), text }
  }

  askWhere(): Where | null {
    const w = this._askWhere
    this._askWhere = null
    return w
  }

  asked(focus?: boolean): { done: boolean; label: string | null; how: string; shown: boolean } | null {
    const ask = this._ask
    if (!ask) return null
    if (focus === true && !ask.focus && !ask.answer) {
      ask.focus = true
      if (this._sayOn) this._focusAsk()
    }
    if (ask.answer) {
      this._ask = null
      return { done: true, label: ask.answer.label, how: ask.answer.how, shown: true }
    }
    const shown = this._shownNow()
    if (shown && !this._sayOn && this._ticks.size === 0) {
      if (!this.on || this._leaving) this._go(this._peekPoint(), null, CAP_FIRST_MS, ask.text, 'rest')
      else this._bubble(ask.text)
      this._lingerAt = null
      this.mind.asking(true)
    }
    return { done: false, label: null, how: '', shown }
  }

  cancelAsk(): boolean {
    if (!this._ask) return false
    this._dropAsk()
    return true
  }

  answer(label: string | null, how: string): boolean {
    if (!this._ask || this._ask.answer) return false
    this._reply(label, how)
    return true
  }

  private _reply(label: string | null, how: string): void {
    const ask = this._ask
    if (!ask || ask.answer) return
    this._askWhere = this._target ? this.where() : null
    ask.answer = { label, how }
    this._loudUntil = null
    this._repliedAt = this._now()
    this._endAsk()
    const back = ask.back
    if (back && this._host && this._host.matches(':focus-within') && (back as HTMLElement).isConnected) (back as HTMLElement).focus?.({ preventScroll: true })
    else if (this._host?.matches(':focus-within')) (this._win.document.activeElement as HTMLElement | null)?.blur?.()
    if (this._sayOn) this._fadeSay()
    this.done(label !== null)
  }

  private _endAsk(): void {
    this._win.document.removeEventListener('keydown', this._onKey, { capture: true })
    if (!this._menu) this._host?.setAttribute('aria-hidden', 'true')
    this.mind.asking(false)
  }

  private _dropAsk(): void {
    if (!this._ask) return
    const pending = !this._ask.answer
    this._ask = null
    this._loudUntil = null
    this._endAsk()
    if (pending) this._hideSay()
  }

  private _fillAsk(el: HTMLElement, ask: AskState): void {
    const doc = this._win.document
    const q = doc.createElement('span')
    q.className = 'q'
    q.textContent = ask.text
    const row = doc.createElement('div')
    row.className = 'row'
    ask.buttons.forEach((label, i) => {
      const b = doc.createElement('button')
      b.type = 'button'
      b.textContent = label
      if (i === 0) b.className = 'go'
      b.addEventListener('click', (e) => {
        if (e.isTrusted) this._reply(label, 'click')
      })
      row.appendChild(b)
    })
    const x = doc.createElement('button')
    x.type = 'button'
    x.className = 'x'
    x.textContent = '×'
    x.title = 'Close (Esc)'
    x.setAttribute('aria-label', 'Close')
    x.addEventListener('click', (e) => {
      if (e.isTrusted) this._reply(null, 'the user closed it')
    })
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-label', ask.text)
    el.replaceChildren(q, row, x)
  }

  private _focusAsk(): void {
    const ask = this._ask
    if (!ask || ask.answer || !ask.focus || ask.focused) return
    const go = this._say.querySelector<HTMLButtonElement>('button.go')
    if (!go) return
    const doc = this._win.document
    if (doc.activeElement !== this._host) ask.back = doc.activeElement
    go.focus({ preventScroll: true })
    ask.focused = this._host?.matches(':focus-within') ?? false
  }

  private _peek(line: string, mood: 'rest' | 'worried', ms?: unknown): number {
    const s0 = this._vt
    const read = bubbleMs(line, ms)
    const travel = this._go(this._peekPoint(), null, CAP_FIRST_MS, line, mood, read).ms
    const gen = this._gen
    void (async () => {
      await this._wait(gen, travel + read, s0)
      await this._leave(gen)
    })().catch(quiet)
    return travel
  }

  private _bubble(raw: string, ms?: unknown): void {
    const text = bubbleText(raw)
    if ((!text && !this._menu) || !this._host || !this._shownNow()) return
    const el = this._say
    clearTimeout(this._sayTimer)
    const ask = this._ask && !this._ask.answer && this._ask.text === text ? this._ask : null
    const menu = ask ? null : this._menu
    const key = ask ? `ask\n${text}` : `${text}\n${menu?.key ?? ''}`
    const same = this._sayOn && this._sayKey === key && el.classList.contains('on')
    el.classList.remove('off')
    if (!same) {
      el.classList.remove('on')
      el.classList.toggle('ask', !!ask)
      el.classList.toggle('menu', !!menu)
      if (ask) this._fillAsk(el, ask)
      else {
        el.removeAttribute('role')
        el.removeAttribute('aria-label')
        if (menu) this._fillMenu(el, text, menu.items)
        else el.textContent = text
      }
    }
    if (!same && text) this._said.push(text)
    if (!same && text && !ask && !menu) {
      this._lineEnd('replaced')
      this._lines.push({ text, read: typeof ms === 'number' && Number.isFinite(ms) ? ms : bubbleMs(text), at: this._vt, end: null, how: null })
      if (this._lines.length > 40) this._lines.shift()
    }
    this._sayText = text
    this._sayKey = key
    this._placeSay()
    if (!same) void el.offsetWidth
    el.classList.add('on')
    this._sayOn = true
    this._sayUntil = ask || menu ? null : this._vt + (typeof ms === 'number' && Number.isFinite(ms) ? ms : bubbleMs(text))
    this._sayEnd = menu && !text ? null : this._sayUntil
    if (ask && !same) this._focusAsk()
    this._schedule()
  }

  private _fillMenu(el: HTMLElement, text: string, items: MenuItem[]): void {
    const doc = this._win.document
    const row = doc.createElement('div')
    row.className = 'row'
    for (const it of items) {
      const b = doc.createElement('button')
      b.type = 'button'
      b.textContent = it.label
      b.setAttribute('data-act', it.id)
      if (it.go) b.className = 'go'
      b.addEventListener('click', (e) => {
        if (e.isTrusted) this._menu?.pick(it.id)
      })
      row.appendChild(b)
    }
    if (!text) {
      el.replaceChildren(row)
      return
    }
    const q = doc.createElement('span')
    q.className = 'q'
    q.textContent = text
    el.replaceChildren(q, row)
  }

  menu(items: MenuItem[], pick: (id: string) => void): void {
    const list = items.filter((i) => i.id && i.label)
    const key = list.map((i) => `${i.id}:${i.label}:${i.go ? 1 : 0}`).join('|')
    const before = this._menu?.key ?? ''
    this._menu = list.length ? { items: list, key, pick } : null
    if (key === before || !this._host) return
    if (this._menu) this._host.removeAttribute('aria-hidden')
    else if (!this._ask) this._host.setAttribute('aria-hidden', 'true')
    if (this._ask && !this._ask.answer) return
    if (this._sayOn && this._say.classList.contains('on')) {
      if (this._sayText || this._menu) this._bubble(this._sayText)
      else this._hideSay()
    }
    this._schedule()
  }

  private _placeSay(): void {
    const el = this._say
    const dpr = this._win.devicePixelRatio || 1
    this._saySize = { width: el.offsetWidth, height: el.offsetHeight }
    this._laySay(snap(this.x, dpr), snap(this.y, dpr), dpr)
  }

  private _followSay(x: number, y: number, dpr: number, now: number): void {
    if (!this._sayOn || !this._saySize) return
    if (this._menu && now - this._baseAt < SAY_SETTLE_MS) return
    this._laySay(x, y, dpr)
  }

  private _laySay(x0: number, y0: number, dpr: number): void {
    const size = this._saySize
    if (!size) return
    const g = this._geo()
    const bell = { x: x0 + g.bx0, y: y0 + g.by0, width: g.bx1 - g.bx0, height: g.by1 - g.by0 }
    const view = { width: this._win.innerWidth, height: this._win.innerHeight }
    const target = this._box && (this._target?.exact || !isArea(this._box, this._S)) ? this._box : null
    const p = placeBubble({ bell, target, size, view, prefer: this._sayAnchor?.side ?? null })
    const box = this._sayBox
    const el = this._say
    const moved = !box || Math.abs(p.x - box.x) >= 0.01 || Math.abs(p.y - box.y) >= 0.01 || box.width !== size.width || box.height !== size.height
    if (moved) el.style.transform = `translate3d(${snap(p.x, dpr)}px,${snap(p.y, dpr)}px,0)`
    if (this._sayAnchor?.side !== p.side) el.dataset.side = p.side
    const vertical = p.side === 'above' || p.side === 'below'
    const along = vertical ? bell.x + bell.width / 2 - p.x : bell.y + bell.height / 2 - p.y
    el.style.setProperty('--t', `${Math.max(16, Math.min((vertical ? size.width : size.height) - 16, along))}px`)
    this._sayBox = { x: p.x, y: p.y, width: size.width, height: size.height }
    this._sayAnchor = { dx: p.x - x0, dy: p.y - y0, side: p.side }
    const f: SayFrame = { t: Math.round(this._vt), bell: { x: round1(bell.x), y: round1(bell.y), width: round1(bell.width), height: round1(bell.height) }, say: { x: round1(p.x), y: round1(p.y), width: size.width, height: size.height }, side: p.side, gap: round1(bubbleGap(bell, this._sayBox)) }
    const st = this._sayTrace
    st.n++
    st.sum += f.gap
    if (!st.max || f.gap > st.max.gap) st.max = f
    if (!st.sides.includes(f.side)) st.sides.push(f.side)
    if ((f.gap > SAY_GAP_OK || (st.last && st.last !== f.side)) && st.odd.length < 40) st.odd.push(f)
    st.last = f.side
  }

  private _fadeSay(): void {
    this._sayUntil = null
    this._lineEnd('read')
    if (!this._host) return
    const el = this._say
    clearTimeout(this._sayTimer)
    el.classList.remove('on')
    el.classList.add('off')
    this._sayTimer = setTimeout(() => {
      el.classList.remove('off')
      this._sayOn = false
    }, 200)
  }

  private _hideSay(): void {
    this._sayUntil = null
    this._lineEnd('cut')
    this._sayEnd = null
    if (!this._host) return
    clearTimeout(this._sayTimer)
    this._say.classList.remove('on', 'off')
    this._sayOn = false
  }

  async wave(raw: unknown, frames = 8, ms = 170): Promise<void> {
    if (!this.on || this._leaving) return
    const gen = this._gen
    const text = bubbleText(raw)
    for (let i = 0; i < frames; i++) {
      if (gen !== this._gen) return
      this.body = i % 2 ? 'waveB' : 'waveA'
      this._draw()
      await new Promise((r) => setTimeout(r, ms))
    }
    this.body = 'idle'
    this._draw()
    if (text && gen === this._gen) this._bubble(text, bubbleMs(text))
  }

  private async _goodbye(gen: number): Promise<void> {
    this.mind.goodbye()
    for (const b of ['waveA', 'waveB', 'waveA'] as const) {
      this.body = b
      this._draw()
      await this._wait(gen, EMOTION_MS.wave)
    }
    this.body = 'idle'
    this.mind.rest()
    this._draw()
  }

  private async _leave(gen: number): Promise<void> {
    if (!this.on) return
    this._leaving = true
    this._lingerAt = null
    this._hideSay()
    this.mind.tipDim = false
    if (this._reduced() || !this._shownNow()) {
      this._hide()
      return
    }
    const y0 = this.y
    const S = this._S
    await this._tween(gen, SWIM_LEAVE_MS, (t) => {
      this.y = y0 - 3 * S * easeOut(t)
      this.body = t < 0.3 ? this.rest : t < 0.65 ? 'ring' : 'dust'
      this.alpha = t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35
      this._draw()
    })
    this._hide()
  }

  private _hide(): void {
    this._target = null
    this._watch = null
    this._travelling = false
    this.on = false
    this.alpha = 0
    this._leaving = false
    this._lingerAt = null
    this._pressed = false
    this._ungrab()
    this.body = 'idle'
    this.rest = 'idle'
    this._keepClip = null
    this.mind.vanish()
    this._setClip(null)
    this._hideSay()
    if (this._host) this._tag.classList.remove('on')
    this._draw()
  }

  bye(failed: boolean, seen?: () => UserSeen | null): number {
    this._dropAsk()
    const end = this._sayEnd
    const linger = !failed && end !== null && this.on ? Math.max(0, Math.round(end - this._vt)) : 0
    let gen = linger > 0 ? this._gen : ++this._gen
    this._lingerAt = null
    this._hold = false
    this._pressed = false
    this._ungrab()
    if (this.mind.paused) {
      this.mind.resume(this._now())
      this._frozen = false
    }
    void (async () => {
      if (linger > 0 && end !== null) {
        await this._untilQuiet(gen, seen, () => !this.on || (!this._sayOn && this._vt >= end))
        if (this._leaving) {
          await this._untilQuiet(gen, seen, () => !this.on)
          if (gen === this._gen) this.remove()
          return
        }
        gen = ++this._gen
      }
      if (this.on) {
        if (failed) {
          this.mind.worried()
          this.body = 'limp'
          this.rest = 'limp'
          this._draw()
          await this._wait(gen, EMOTION_MS.worried)
        } else {
          const reduced = this._reduced()
          await this._wait(gen, reduced ? RISE.reducedLinger : RISE.hold)
          if (!reduced) await this._goodbye(gen)
        }
        await this._leave(gen)
      }
      if (gen === this._gen) this.remove()
    })().catch(quiet)
    return linger
  }

  private _untilQuiet(gen: number, seen: (() => UserSeen | null) | undefined, done: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const f = (): void => {
        if (gen !== this._gen) {
          this._ticks.delete(f)
          reject(CANCEL)
          return
        }
        const u = seen?.()
        if (u) this.user(u.kind === 'mouse' ? (u.x ?? null) : null, u.kind === 'mouse' ? (u.y ?? null) : null)
        if (done()) {
          this._ticks.delete(f)
          resolve()
        }
      }
      this._ticks.add(f)
      f()
      this._schedule()
    })
  }

  hush(): void {
    this._hideSay()
  }

  hold(on: boolean): void {
    this._ensure()
    this._hold = on
    this._badgeKey = ''
    this._drawBadge(this._now())
    this._schedule()
  }

  moving(): boolean {
    return this._ticks.size > 0
  }

  visible(on: boolean): void {
    this._captureHidden = !on
    if (this._host) this._host.style.display = on ? 'block' : 'none'
  }

  state(): { on: boolean; x: number; y: number; body: Body; dragging: boolean; face: string; emotion: Emotion | null; shown: boolean; holding: boolean; paused: boolean } {
    const g = this._geo()
    return {
      on: this.on,
      x: this.x + g.hx,
      y: this.y + g.hy,
      body: this.body,
      dragging: !!this._grab,
      face: this.mind.face(this._now()).e,
      emotion: this.mind.emotion,
      shown: this._shownNow(),
      holding: this._hold,
      paused: this.mind.paused
    }
  }

  takeEvents(): { fired: Emotion[]; said: string[] } {
    return { fired: this.mind.fired.splice(0), said: this._said.splice(0) }
  }

  allowSpotlight(on: boolean): void {
    this._dimAllowed = on !== false
    if (this._host) this._drawDim(this._shownNow())
  }

  private _area(now: number): SpotBox | null {
    if (!this._scope.id) return null
    if (!this._dimRect || now - this._dimRectAt > 400) {
      const r = this._scope.info().rect
      this._dimRect = r && r.width > 0 && r.height > 0 ? r : null
      this._dimRectAt = now
    }
    return this._dimRect
  }

  private _drawDim(shown: boolean): void {
    const now = this._now()
    const area = this._area(now)
    const want = dimWanted({
      enabled: this._dimAllowed,
      asked: this._spotUntil !== null && this._vt < this._spotUntil,
      on: this.on,
      leaving: this._leaving,
      shown,
      paused: this.mind.paused,
      hidden: this._captureHidden,
      area
    })
    const dim = this._dim
    if (want && area) {
      const g = this._geo()
      const bell = { x: this.x + g.bx0, y: this.y + g.by0, width: g.bx1 - g.bx0, height: g.by1 - g.by0 }
      const say = this._sayOn ? this._sayBox : null
      const boxes = [bell, say, this._box]
      const goal = spotlightCircle(boxes)!
      const still = this._reduced() || !this._dimOn
      this._dimCircle = followCircle(still ? null : this._dimCircle, goal, boxes, now - this._dimAt)
      this._dimAt = now
      const mask = spotlightMask(this._dimCircle, area)
      const key = `${area.x}|${area.y}|${area.width}|${area.height}|${mask}`
      if (key !== this._dimKey) {
        this._dimKey = key
        dim.style.left = `${area.x}px`
        dim.style.top = `${area.y}px`
        dim.style.width = `${area.width}px`
        dim.style.height = `${area.height}px`
        dim.style.setProperty('-webkit-mask-image', mask)
        dim.style.setProperty('mask-image', mask)
      }
    }
    if (want !== this._dimOn) {
      this._dimOn = want
      this._host?.setAttribute('data-dim', want ? 'on' : 'off')
      dim.classList.toggle('lift', !want && this.mind.paused)
      if (want) dim.classList.add('on')
      dim.style.opacity = want ? String(DIM_OPACITY) : '0'
      if (!want) {
        const gone = (): void => {
          if (!this._dimOn) dim.classList.remove('on')
        }
        setTimeout(gone, DIM_FADE_MS + 50)
      }
    }
  }

  private _float(now: number, reduced: boolean): number {
    this.floatY = reduced ? 0 : FLOAT_PX * Math.sin((now / FLOAT_MS) * Math.PI * 2)
    return this.floatY
  }

  private _draw(): void {
    if (!this._host) return
    const shown = this._shownNow()
    this._drawDim(shown)
    if (shown !== this._shown) {
      this._shown = shown
      this._layer.style.display = shown ? 'block' : 'none'
    }
    if (!shown) return
    const now = this._now()
    const face = this.mind.face(now)
    const tipDim = this.mind.tipDim
    const S = this._S
    const reduced = this._reduced()
    const shift = reduced ? 0 : wiggleAt(now)
    const key = [this.body, this.mirror ? 1 : 0, face.e, face.dx || 0, face.dy || 0, tipDim ? 1 : 0, S, shift].join('|')
    if (key !== this._lastKey) {
      this._lastKey = key
      const g = build(this.body, this.mirror, face, tipDim, shift)
      const limb = (c: string): boolean => c === 'd' || c === 'h'
      this._svg.innerHTML = svgRects(g.map((r) => r.map((c) => (limb(c) ? '.' : c))))
      this._limbs.innerHTML = svgRects(g.map((r) => r.map((c) => (limb(c) ? c : '.'))))
      for (const el of [this._svg, this._limbs]) {
        el.setAttribute('width', String(COLS * S))
        el.setAttribute('height', String(ROWS * S))
      }
    }
    const pressing = this.body === 'press' || this.body === 'sidePress'
    const bob = reduced || pressing ? 0 : this.mind.bobAt(now)
    const dpr = this._win.devicePixelRatio || 1
    const x = snap(this.x, dpr)
    const y = snap(this.y + bob * S, dpr)
    if (x !== this._lx || y !== this._ly) {
      this._lx = x
      this._ly = y
      this.mind.moved(now)
    }
    const fy = this._float(now, reduced || pressing)
    this._mw.style.transform = `translate3d(${x}px,${y}px,0)`
    const by = snap(this.y, dpr)
    if (x !== this._base.x || by !== this._base.y) {
      this._base = { x, y: by }
      this._baseAt = now
    }
    this._followSay(x, by, dpr, now)
    this._svg.style.transform = fy ? `translateY(${fy.toFixed(2)}px)` : ''
    this._limbs.style.transform = this._svg.style.transform
    this._shade.style.transform = this._svg.style.transform
    this._mw.style.opacity = this.on ? String(this.alpha) : '0'
    this._drawShade(x, y + fy, S)
    const g = this._geo()
    this._tag.style.left = `${(g.bx0 + g.bx1) / 2}px`
    this._tag.style.top = `${g.by1 + 4}px`
  }

  private _drawShade(x: number, y: number, S: number): void {
    const key = [this.body, this.mirror ? 1 : 0, S].join('|')
    if (key !== this._shadeKey) {
      this._shadeKey = key
      const sh = bellShade(this.body, this.mirror)
      this._shadeCells = sh.cells
      this._shade.innerHTML = shadeSvg(sh.rects)
      this._shade.setAttribute('width', String(COLS * S))
      this._shade.setAttribute('height', String(ROWS * S))
    }
    const cells = this._shadeCells
    const box = cells ? shadeBox(x, y, cells, S) : null
    const say = this._sayOn ? this._sayBox : null
    const on = !!box && !(this._box && overlaps(box, this._box)) && !(say && overlaps(box, say))
    if (on !== this._shadeOn) {
      this._shadeOn = on
      this._shade.classList.toggle('off', !on)
    }
  }

  private _drawBadge(now: number): void {
    if (!this._host) return
    const chip = this._hold
      ? this._win.document.querySelector(`[data-workspace-chip="${this._win.CSS.escape(this._scope.id)}"]`)
      : null
    const r = chip?.getBoundingClientRect()
    const on = !!r && r.width > 0 && !this._captureHidden
    this._badge.classList.toggle('on', on)
    if (!on || !r) return
    const dpr = this._win.devicePixelRatio || 1
    const S = pixelSize(dpr, 1.5)
    const w = COLS * S
    const h = ROWS * S
    const x = snap(r.right - 24 - w, dpr)
    const y = snap(r.top + (r.height - h) / 2 + S, dpr)
    if (now > this._badgeBlinkAt + 3600) this._badgeBlinkAt = now
    const blink = now - this._badgeBlinkAt < EMOTION_MS.blink && this._badgeBlinkAt > 0
    const c = this._cursor
    const cx = x + 4.5 * S
    const cy = y + 4.5 * S
    const dx = c && Math.abs(c.x - cx) > 10 ? Math.sign(c.x - cx) : 0
    const dy = c && Math.abs(c.y - cy) > 10 ? Math.sign(c.y - cy) : c ? 0 : 1
    const key = [blink ? 1 : 0, dx, dy, S].join('|')
    if (key !== this._badgeKey) {
      this._badgeKey = key
      this._badge.innerHTML = svgRects(build('idle', false, blink ? { e: 'closed' } : { e: 'look', dx, dy }, false))
      this._badge.setAttribute('width', String(w))
      this._badge.setAttribute('height', String(h))
    }
    this._badge.style.transform = `translate3d(${x}px,${y}px,0)`
  }

  remove(): void {
    this._dropAsk()
    this._gen++
    this._ticks.clear()
    this._scheduled = false
    this._win.cancelAnimationFrame(this._raf)
    clearTimeout(this._timer)
    clearTimeout(this._sayTimer)
    const host = this._host
    this._host = null
    this.on = false
    this._hold = false
    this._sayOn = false
    this._win.document.removeEventListener('mousemove', this._onMove, { capture: true })
    this._win.document.removeEventListener('scroll', this._onScroll, { capture: true })
    this._win.document.removeEventListener(GOAL_EVENT, this._onGoal, { capture: true })
    host?.remove()
    const doc = this._win.document
    if (!doc.querySelector('[data-satura-drift]')) doc.documentElement.removeAttribute('data-drift-driving')
  }
}
