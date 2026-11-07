import type { Guide } from './guide'
import type { WorkspaceScope } from '../../main/satura-exec/page/scope'
import { aimAt, reveal } from './reveal'
import type { Box } from '../../main/satura-exec/page/bubble'
import { anchorOn, whole, type Part } from './aim'
import { edgePoint, fracOf, type Anchor } from '../../main/satura-exec/page/anchor'
import { collapseExpanded } from '@renderer/remote/expand'

export class Paused extends Error {
  constructor() {
    super('paused')
  }
}

export interface Gate {
  paused: () => boolean
  gate: () => Promise<void>
}

function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

export class Driver {
  x = 0
  y = 0
  private down = false
  private aimed: Element | null = null
  private part: Part = whole
  private sx = 0
  private sy = 0
  private shift = { x: 0, y: 0 }
  private ref: { el: Element; part: Part; base: Box } | null = null
  private readonly scope: WorkspaceScope

  constructor(
    private readonly guide: Guide,
    private readonly g: Gate
  ) {
    this.scope = guide.scope
  }

  private get drift(): Guide['drift'] {
    return this.guide.drift
  }

  private send(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', extra: Record<string, unknown> = {}): void {
    this.scope.input('Input.dispatchMouseEvent', { type, x: this.x, y: this.y, button: 'left', clickCount: 1, ...extra })
  }

  private begin(): void {
    this.guide.ensure()
  }

  release(): void {
    if (!this.down) return
    this.down = false
    this.send('mouseReleased')
    this.drift.release()
  }

  leave(): void {
    this.release()
    this.guide.leave()
  }

  private frame(): Promise<void> {
    return new Promise((r) => requestAnimationFrame(() => r()))
  }

  private check(): void {
    collapseExpanded('Drift is acting')
    if (this.g.paused()) {
      this.leave()
      throw new Paused()
    }
  }

  async moveTo(x: number, y: number, line = '', slide: boolean | Box = false): Promise<void> {
    await this.g.gate()
    this.check()
    this.begin()
    const el = this.aimed
    this.aimed = null
    const er = el?.isConnected ? this.part(el) : null
    const own = !!er && x >= er.x - 0.5 && x <= er.x + er.width + 0.5 && y >= er.y - 0.5 && y <= er.y + er.height + 0.5
    const box = own && er ? er : { x: x - 8, y: y - 8, width: 16, height: 16 }
    const key = line || 'move'
    const target = own && el && er ? anchorOn(el, this.part, fracOf(er, { x, y }), key, this.scope) : this.pin(x, y, key)
    this.ref = own && el && er ? { el, part: this.part, base: er } : this.pinned
    const r = this.drift.point({ x, y, box, text: line, slide: own && slide !== false, within: typeof slide === 'object' ? slide : null, mark: own, target })
    this.x = r.x
    this.y = r.y
    this.sx = r.x - x
    this.sy = r.y - y
    this.shift = { x: 0, y: 0 }
    aimAt(null)
    await this.pause(r.travel + (line ? r.read : 0))
    this.send('mouseMoved')
  }

  private pinned: { el: Element; part: Part; base: Box } | null = null

  private pin(x: number, y: number, key: string): Anchor | null {
    this.pinned = null
    const on = document.elementsFromPoint(x, y).find((e) => this.scope.inside(e) && !e.closest('[data-demo-shield], [data-satura-drift]'))
    const b = on ? whole(on) : null
    if (!on || !b) return null
    const f = fracOf(b, { x, y })
    const part: Part = (e) => {
      const r = whole(e)
      if (!r) return null
      const p = edgePoint(r, b, f)
      return { x: p.x - 8, y: p.y - 8, width: 16, height: 16 }
    }
    this.pinned = { el: on, part: whole, base: b }
    return anchorOn(on, part, { x: 0.5, y: 0.5 }, key, this.scope)
  }

  private follow(p: { x: number; y: number }, from: Box, to: Box): { x: number; y: number } {
    return {
      x: to.x + (from.width > 0 ? ((p.x - from.x) * to.width) / from.width : p.x - from.x),
      y: to.y + (from.height > 0 ? ((p.y - from.y) * to.height) / from.height : p.y - from.y)
    }
  }

  private refBox(): Box | null {
    const r = this.ref
    return r && r.el.isConnected ? r.part(r.el) : null
  }

  private sync(): void {
    const s = this.drift.state()
    if (!s.on || this.down) return
    this.shift = { x: this.shift.x + s.x - this.x, y: this.shift.y + s.y - this.y }
    this.x = s.x
    this.y = s.y
  }

  async aim(el: Element | null, part: Part = whole): Promise<DOMRect | null> {
    if (!el?.isConnected) return null
    await this.g.gate()
    this.check()
    this.begin()
    await reveal(this.drift, el, () => this.tick(), this.scope)
    const b = part(el)
    if (!b || b.width <= 0 || b.height <= 0) return null
    aimAt(el)
    this.aimed = el
    this.part = part
    return new DOMRect(b.x, b.y, b.width, b.height)
  }

  private async tick(): Promise<void> {
    this.check()
    await this.frame()
  }

  async press(): Promise<void> {
    this.check()
    this.sync()
    this.down = true
    this.drift.press(this.x, this.y)
    this.send('mousePressed')
    await this.frame()
  }

  async lift(): Promise<void> {
    this.release()
    await this.frame()
  }

  async click(x: number, y: number, line = '', slide = false): Promise<void> {
    await this.moveTo(x, y, line, slide)
    this.sync()
    x = this.x
    y = this.y
    const hit = this.scope.hitTest(x, y)
    if (hit?.closest('[draggable="true"]')) {
      this.check()
      const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, detail: 1 }
      this.drift.press(x, y)
      hit.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }))
      await this.pause(70)
      hit.dispatchEvent(new MouseEvent('mouseup', init))
      hit.dispatchEvent(new MouseEvent('click', init))
      this.drift.release()
      return
    }
    await this.press()
    await this.pause(70)
    await this.lift()
  }

  async dragTo(x: number, y: number, ms = 700, frame: { el: Element; base: Box } | null = null): Promise<void> {
    if (frame) this.ref = { el: frame.el, part: whole, base: frame.base }
    const base = this.ref?.base ?? null
    const goal = base ? { x: x + this.sx, y: y + this.sy } : { x: x + this.sx + this.shift.x, y: y + this.sy + this.shift.y }
    const now0 = this.refBox()
    const from = base && now0 ? this.follow({ x: this.x, y: this.y }, now0, base) : { x: this.x, y: this.y }
    const t0 = performance.now()
    for (;;) {
      this.check()
      const t = Math.min(1, (performance.now() - t0) / Math.max(1, ms))
      const k = ease(t)
      const q = { x: from.x + (goal.x - from.x) * k, y: from.y + (goal.y - from.y) * k }
      const now = base ? this.refBox() : null
      const p = base && now ? this.follow(q, base, now) : q
      this.x = p.x
      this.y = p.y
      this.drift.drag(this.x, this.y)
      this.send('mouseMoved')
      if (t >= 1) break
      await this.frame()
    }
  }

  say(line: string): number {
    this.begin()
    const r = this.drift.sayFor(line)
    return r.shown ? r.travel + r.read : 0
  }

  async pause(ms: number): Promise<void> {
    const t0 = performance.now()
    while (performance.now() - t0 < ms) {
      this.check()
      await this.frame()
    }
  }

  dispose(): void {
    this.release()
  }
}
