import { Drift } from '../../main/satura-exec/page/drift'
import { WorkspaceScope } from '../../main/satura-exec/page/scope'
import { bubbleMs } from '../../main/satura-exec/page/bubble'
import { aimAt, nudge, reveal } from './reveal'
import { anchorOn, fracPoint, valuePart, whole, type Part } from './aim'
import { PRIORITY, TOPICS, type ComponentTopics } from './topics'
import { collapseExpanded } from '@renderer/remote/expand'

export const SCOPE = 'landing-arena'

function aborted(): DOMException {
  return new DOMException('aborted', 'AbortError')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(aborted())
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(aborted())
      },
      { once: true }
    )
  })
}

export function mainComponent(sections: string[]): string | null {
  for (const k of PRIORITY) if (sections.includes(k) && TOPICS[k]) return k
  return null
}

export class Guide {
  readonly drift: Drift
  readonly scope: WorkspaceScope
  private run: AbortController | null = null
  private bound = false
  private keeping = 0
  busy = false
  onBusy: ((on: boolean, section: string | null) => void) | null = null

  constructor() {
    this.scope = new WorkspaceScope(window, SCOPE)
    this.drift = new Drift(window, this.scope)
    if (window.innerWidth < 860) this.drift.cell = 0.62
  }

  private inspector(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-tuner-inspector]')
  }

  sections(): string[] {
    const root = this.inspector()
    return root ? [...root.querySelectorAll('[data-ti-section]')].map((e) => e.getAttribute('data-ti-section') ?? '') : []
  }

  private target(section: string, prop: string | null): Element | null {
    const root = this.inspector()
    const sec = root?.querySelector(`[data-ti-section="${CSS.escape(section)}"]`)
    if (!sec) return null
    if (!prop) return sec.querySelector('[data-ti-style="IN TitleText"], [data-ti-style="IN Title"], [data-ti-style="BoldTextField"]') ?? sec
    const all = [...sec.querySelectorAll('[data-ti-prop]')]
    return all.find((e) => e.getAttribute('data-ti-prop') === prop) ?? all.find((e) => (e.getAttribute('data-ti-prop') ?? '').startsWith(`${prop}.`)) ?? null
  }

  private async point(el: Element, part: Part, text: string, signal: AbortSignal): Promise<void> {
    if (collapseExpanded('Drift points')) await sleep(32, signal)
    await reveal(this.drift, el, () => sleep(16, signal), this.scope)
    const box = part(el)
    if (!box) return
    const frac = { x: 0.5, y: 0.5 }
    const p = fracPoint(box, frac)
    aimAt(el)
    const shown = this.drift.point({ x: p.x, y: p.y, box, text, target: anchorOn(el, part, frac, `explain ${text}`, this.scope) })
    aimAt(null)
    await sleep(shown.travel + shown.read + 250, signal)
  }

  private async line(text: string, signal: AbortSignal, tail: number): Promise<void> {
    if (collapseExpanded('Drift talks')) await sleep(32, signal)
    const said = this.drift.sayFor(text)
    await sleep(said.travel + (said.shown ? said.read : bubbleMs(said.text)) + tail, signal)
  }

  keep(on: boolean): void {
    if (!on) {
      cancelAnimationFrame(this.keeping)
      this.keeping = 0
      return
    }
    if (this.keeping) return
    const tick = (): void => {
      const el = this.drift.on ? this.drift.aimedAt() : null
      if (el?.isConnected) nudge(el)
      this.keeping = requestAnimationFrame(tick)
    }
    this.keeping = requestAnimationFrame(tick)
  }

  ensure(): void {
    collapseExpanded('Drift acts')
    if (this.bound) return
    this.drift.begin('Drift')
    this.bound = true
  }

  leave(hush = false): void {
    if (!this.bound && !this.drift.on) return
    this.bound = false
    if (hush) this.drift.hush()
    this.drift.bye(false)
  }

  stop(): void {
    this.run?.abort()
    this.run = null
    if (this.busy) {
      this.busy = false
      this.onBusy?.(false, null)
      this.leave()
    }
  }

  async explain(section: string, limit = 99, keep = false): Promise<void> {
    const topic: ComponentTopics | undefined = TOPICS[section]
    if (!topic) return
    this.run?.abort()
    const ctl = new AbortController()
    this.run = ctl
    const signal = ctl.signal
    this.busy = true
    this.onBusy?.(true, section)
    this.ensure()
    try {
      const head = this.target(section, null)
      if (!head) return
      await this.point(head, whole, topic.intro, signal)
      let n = 0
      for (const f of topic.fields) {
        if (n >= limit) break
        const el = this.target(section, f.prop)
        if (!el) continue
        n++
        await this.point(el, valuePart, f.lines[0], signal)
        for (const line of f.lines.slice(1)) await this.line(line, signal, 250)
      }
      const said = this.drift.sayFor(topic.outro)
      this.drift.done(true)
      await sleep(said.travel + (said.shown ? said.read : bubbleMs(said.text)) + 300, signal)
      if (!keep) this.leave()
    } finally {
      if (this.run === ctl) {
        this.run = null
        this.busy = false
        this.onBusy?.(false, null)
      }
    }
  }

  dispose(): void {
    this.keep(false)
    this.run?.abort()
    this.drift.remove()
  }
}
