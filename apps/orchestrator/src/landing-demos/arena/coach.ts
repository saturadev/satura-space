import type { Guide } from './guide'
import { anchorOn, fracPoint, whole, type Part } from './aim'

export interface CoachStep {
  key: string
  el: Element
  text: string
  part?: Part
  fx?: number
  fy?: number
}

const HOLD_MS = 60000
const REPEAT_MS = 50000

export class Coach {
  private timer: ReturnType<typeof setInterval> | null = null
  private key = ''
  private el: Element | null = null
  private last: CoachStep | null = null
  private at = 0
  private down = false
  private offs: (() => void)[] = []

  constructor(
    private readonly guide: Guide,
    private readonly step: () => CoachStep | null
  ) {
    const press = (e: PointerEvent): void => {
      if (e.isTrusted) this.down = e.type === 'pointerdown'
    }
    for (const t of ['pointerdown', 'pointerup', 'pointercancel'] as const) {
      window.addEventListener(t, press, { capture: true, passive: true })
      this.offs.push(() => window.removeEventListener(t, press, { capture: true }))
    }
  }

  get on(): boolean {
    return this.timer !== null
  }

  get current(): string {
    return this.key
  }

  get pressed(): boolean {
    return this.down
  }

  target(): { x: number; y: number; el: Element } | null {
    const s = this.last
    if (!this.timer || !s || !s.el.isConnected) return null
    const box = (s.part ?? whole)(s.el)
    if (!box || box.width <= 0 || box.height <= 0) return null
    return { ...fracPoint(box, { x: s.fx ?? 0.5, y: s.fy ?? 0.5 }), el: s.el }
  }

  start(): void {
    if (this.timer) return
    this.key = ''
    this.el = null
    this.last = null
    this.timer = setInterval(() => this.tick(), 200)
    this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.key = ''
    this.el = null
    this.last = null
  }

  private tick(): void {
    if (this.down) return
    const s = this.step()
    this.last = s
    if (!s) {
      if (this.key) {
        this.key = ''
        this.el = null
        this.guide.leave()
      }
      return
    }
    const box = (s.part ?? whole)(s.el)
    if (!box || box.width <= 0 || box.height <= 0) return
    if (s.key === this.key && s.el === this.el && performance.now() - this.at < REPEAT_MS) return
    this.key = s.key
    this.el = s.el
    this.at = performance.now()
    this.guide.ensure()
    const frac = { x: s.fx ?? 0.5, y: s.fy ?? 0.5 }
    const p = fracPoint(box, frac)
    this.guide.drift.point({
      x: p.x,
      y: p.y,
      box,
      text: s.text,
      ms: HOLD_MS,
      target: anchorOn(s.el, s.part ?? whole, frac, s.key, this.guide.scope)
    })
  }

  dispose(): void {
    this.stop()
    for (const o of this.offs) o()
  }
}
