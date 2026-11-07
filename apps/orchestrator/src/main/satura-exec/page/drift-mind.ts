import type { Face } from './drift-frames'

export type Emotion =
  | 'curious'
  | 'pleased'
  | 'puzzled'
  | 'worried'
  | 'startled'
  | 'polite'
  | 'relieved'
  | 'blink'
  | 'sleepy'
  | 'goodbye'

export const EMOTION_MS = {
  pleased: 280,
  worried: 500,
  startled: 160,
  relieved: 240,
  blink: 110,
  wave: 90,
  grab: 240
} as const

export const STILL_BEFORE_BLINK_MS = 1500
export const BLINK_EVERY_MS = 2500
export const BLINK_SPREAD_MS = 2000
export const FIRST_BLINK_MS = 1800
const SLEEPY_PAUSED_MS = 4000
const SLEEPY_WAITING_MS = 2000
export const SWAY_MS = 1100
export const QUIET_MS = 1500

export const NONE: Face = { e: 'none' }

export interface Point {
  x: number
  y: number
}

export function lookToward(from: Point, to: Point): Face {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const f: Face = { e: 'look', dx: Math.abs(dx) > 6 ? Math.sign(dx) : 0, dy: Math.abs(dy) > 6 ? Math.sign(dy) : 0 }
  return f.dx || f.dy ? f : NONE
}

export function lookAtTip(mirror: boolean, pose: 'reach' | 'side' | 'up'): Face {
  return { e: 'look', dx: mirror ? -1 : 1, dy: pose === 'side' ? 0 : pose === 'up' ? -1 : 1 }
}

interface Transient {
  face: Face
  bob: number
  ms: number
}

export interface Tick {
  sway: boolean
  quiet: boolean
}

export class DriftMind {
  base: Face = NONE
  tipDim = false
  bob = 0
  watch: Point | null = null
  paused = false
  attentive = false
  pausedSince = 0
  lastUser = Number.NEGATIVE_INFINITY
  sleepy = false
  waitingSince: number | null = null
  movedAt = 0
  nextBlink = 0
  emotion: Emotion | null = null
  readonly fired: Emotion[] = []
  private _tr: (Transient & { until: number }) | null = null
  private _queue: Transient[] = []
  private _saved: Face | null = null
  private _swayAt = 0
  private _grabBase: Face | null = null

  constructor(private readonly _rand: () => number = Math.random) {}

  private _fire(e: Emotion): void {
    this.emotion = e
    this.fired.push(e)
    if (this.fired.length > 64) this.fired.splice(0, this.fired.length - 64)
  }

  private _emote(face: Face, ms: number, now: number, bob = 0, then: Transient[] = []): void {
    this._tr = { face, bob, ms, until: now + ms }
    this._queue = then
  }

  reset(now: number): void {
    this.attentive = false
    this.base = NONE
    this.tipDim = false
    this.bob = 0
    this.watch = null
    this.paused = false
    this.sleepy = false
    this.waitingSince = null
    this._tr = null
    this._queue = []
    this._saved = null
    this.movedAt = now
    this.nextBlink = now + FIRST_BLINK_MS
  }

  vanish(): void {
    this.attentive = false
    this.base = NONE
    this.tipDim = false
    this.bob = 0
    this.sleepy = false
    this.watch = null
    this.waitingSince = null
    this._tr = null
    this._queue = []
  }

  appear(now: number): void {
    this.movedAt = now
    this.nextBlink = now + FIRST_BLINK_MS
  }

  private _wake(now: number): void {
    if (!this.sleepy) return
    this.sleepy = false
    this.bob = 0
    this._emote({ e: 'closed' }, EMOTION_MS.blink, now)
  }

  travel(from: Point, to: Point, now: number): void {
    this.base = lookToward(from, to)
    this.tipDim = false
    this.waitingSince = null
    if (this.bob > 0 && !this.sleepy) this.bob = 0
    this._wake(now)
    this._fire('curious')
  }

  arrive(mirror: boolean, pose: 'reach' | 'side' | 'up', now: number): void {
    this.base = lookAtTip(mirror, pose)
    this.tipDim = false
    this.waitingSince = null
    if (this.bob > 0 && !this.sleepy) this.bob = 0
    this._wake(now)
  }

  pleased(now: number): void {
    this._emote({ e: 'happy' }, EMOTION_MS.pleased, now)
    this._fire('pleased')
  }

  grabbing(on: boolean, now: number): void {
    if (on) {
      this._grabBase = this.base
      this.base = { e: 'lines' }
      this._emote({ e: 'wide' }, EMOTION_MS.grab, now)
      return
    }
    if (this._grabBase && this.base.e === 'lines') this.base = this._grabBase
    this._grabBase = null
  }

  puzzled(now: number): boolean {
    const fresh = this.waitingSince === null
    this.base = { e: 'puzzled' }
    this.tipDim = true
    if (fresh) {
      this.waitingSince = now
      this._fire('puzzled')
    }
    return fresh
  }

  worried(): void {
    this.base = { e: 'low' }
    this.bob = 1
    this.tipDim = false
    this.waitingSince = null
    this.sleepy = false
    this._tr = null
    this._queue = []
    this._fire('worried')
  }

  user(at: Point | null, now: number): boolean {
    this.lastUser = now
    if (at && !this.sleepy) this.watch = at
    if (this.paused) return false
    this.paused = true
    this.pausedSince = now
    this._saved = this.base
    this._emote({ e: 'wide' }, EMOTION_MS.startled, now, -1)
    this._fire('startled')
    return true
  }

  look(at: Point): void {
    if ((this.paused || this.attentive) && !this.sleepy) this.watch = at
  }

  asking(on: boolean): void {
    if (on === this.attentive) return
    this.attentive = on
    if (on) {
      this.waitingSince = null
      this._fire('curious')
      return
    }
    if (!this.paused) {
      this.watch = null
      this.base = NONE
    }
  }

  resume(now: number): boolean {
    if (!this.paused) return false
    this.paused = false
    const wasSleepy = this.sleepy
    this.sleepy = false
    this.watch = null
    this.bob = 0
    if (this._saved) this.base = this._saved
    this._saved = null
    const relieved: Transient = { face: { e: 'lines' }, bob: 1, ms: EMOTION_MS.relieved }
    if (wasSleepy) this._emote({ e: 'closed' }, EMOTION_MS.blink, now, 0, [relieved])
    else this._emote(relieved.face, relieved.ms, now, relieved.bob)
    this._fire('relieved')
    return true
  }

  goodbye(): void {
    this.base = { e: 'happy' }
    this.tipDim = false
    this.waitingSince = null
    this._tr = null
    this._queue = []
    this._fire('goodbye')
  }

  rest(): void {
    this.base = NONE
  }

  moved(now: number): void {
    this.movedAt = now
  }

  tick(now: number, center: Point, blinkable: boolean): Tick {
    while (this._tr && this._tr.until <= now) {
      const next = this._queue.shift()
      this._tr = next ? { ...next, until: this._tr.until + next.ms } : null
    }
    let sway = false
    if (this.paused && this.emotion === 'startled' && !this._tr) this._fire('polite')
    const sleepyNow =
      (this.paused && now - this.pausedSince > SLEEPY_PAUSED_MS) ||
      (!this.paused && this.waitingSince !== null && now - this.waitingSince > SLEEPY_WAITING_MS)
    if (sleepyNow && !this.sleepy) {
      this.sleepy = true
      this.watch = null
      this.bob = 1
      this._swayAt = now + SWAY_MS
      this.base = { e: 'lines' }
      this._fire('sleepy')
    }
    if (this.watch && !this.sleepy) {
      const dx = this.watch.x - center.x
      const dy = this.watch.y - center.y
      this.base = { e: 'look', dx: Math.abs(dx) > 10 ? Math.sign(dx) : 0, dy: Math.abs(dy) > 10 ? Math.sign(dy) : 0, keep: true }
    }
    if (blinkable && !this._tr && now - this.movedAt > STILL_BEFORE_BLINK_MS && now > this.nextBlink) {
      this.nextBlink = now + BLINK_EVERY_MS + this._rand() * BLINK_SPREAD_MS
      this._emote({ e: 'closed' }, EMOTION_MS.blink, now)
      this._fire('blink')
    }
    if (this.sleepy && now > this._swayAt) {
      this._swayAt = now + SWAY_MS
      sway = true
    }
    const quiet = this.paused && now - this.lastUser >= QUIET_MS
    return { sway, quiet }
  }

  face(now: number): Face {
    if (this._tr && this._tr.until > now) return this._tr.face
    return this.base
  }

  bobAt(now: number): number {
    if (this._tr && this._tr.until > now && this._tr.bob) return this._tr.bob
    return this.bob
  }
}
