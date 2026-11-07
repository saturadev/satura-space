import { useAppStore } from '@renderer/store'
import { tunerLabel } from '@renderer/lib/tuner/open-tuner'
import { tunerMemory } from '@renderer/lib/tuner/session-memory'
import { demoCopied, onDemoCopy } from '../mock/clipboard'
import { orbitFromLookAt } from '@renderer/lib/tuner/orbit'
import { tunerShot } from '@renderer/lib/tuner/shot'
import { Driver, Paused } from './driver'
import { mainComponent, type Guide } from './guide'
import type { ArenaSim } from './sim'
import { Camera, SHOTS } from './camera'
import { Coach, type CoachStep } from './coach'
import { labelPart, valuePart, whole, type Part } from './aim'
import { isPhoneView } from '@renderer/lib/tuner/view-mirror'
import { revealInside } from '../contain-scroll'
import { collapseExpanded } from '@renderer/remote/expand'
import { clientRect } from '../../main/satura-exec/page/rect'
import { intersect } from '../../main/satura-exec/page/anchor'
import { swapFade } from './fade'
import { phoneTunerControls } from '@renderer/components/tuner/PaneTunerSlot'

const DRIVING = 'data-drift-driving'

export type HandoffKind = 'tune' | 'anim'
export type StartCase = HandoffKind | 'free'
export type HandoffStage = 'idle' | 'ask' | 'agent' | 'tool' | 'tuning' | 'yours' | 'drift' | 'sent'
export type Phase = 'intro' | 'prep' | 'yours' | 'asking' | 'showing' | 'sending' | 'done' | 'explore' | 'animating'

export const OPEN_PHASES: Phase[] = ['yours', 'explore']

export interface HandoffCard {
  kind: HandoffKind
  stage: HandoffStage
  prompt: string
  beat: number
  edited?: boolean
  replied?: boolean
}

export const FOCUS_VIEW = 'landing-focus'
const ARENA_VIEW = 'landing-arena'
const ARRIVAL = 'Assets/SaturaLanding/Anim/MonolithArrival.anim'
export const DOOR = { position: [0, 1.75, -6.4] as [number, number, number], lookAt: [0, 1.7, 1.6] as [number, number, number] }
const DRIFT_AFTER_MS = 7000
const EXPLORE_IDLE_MS = 25000
const REPLY_MS = 500
const RESULT_HOLD_MS = 3400
const ORANGE = 0.085
const AMBER = 0.07

const SIZE = 'InitialModule.startSize'
const COLOR = 'InitialModule.startColor'
const RATE = 'EmissionModule.rateOverTime'

const INTRO_LINE = 'Your agent is setting up this scene for you.'

const COACH = {
  size: 'Drag the Start Size label to the right. The motes get bigger.',
  color: 'Now click the Start Color bar and pick a warm one.',
  picker: 'Drag to the top-right corner of this box for a strong color, then click outside.',
  copy: 'When you like it, Copy Changes sends your numbers to the agent.'
}

export class Handoff {
  phase: Phase = 'intro'
  private kind: StartCase = 'tune'
  private gen = 0
  private halted = false
  private before: Phase = 'yours'
  private driver: Driver
  private cam: Camera
  private coach: Coach
  private copied = false
  private freeing = false
  private tookOver = false
  private lastInput = 0
  private timers: ReturnType<typeof setTimeout>[] = []
  private card: HandoffCard = { kind: 'tune', stage: 'idle', prompt: '', beat: 0 }
  private offs: (() => void)[] = []
  private disposed = false
  private readonly phone = isPhoneView()
  private peeking = false
  onPhase: ((p: Phase) => void) | null = null
  onIdle: (() => void) | null = null

  constructor(
    private readonly sim: ArenaSim,
    private readonly guide: Guide,
    private readonly tab: string,
    private readonly onCard: (c: HandoffCard) => void
  ) {
    this.driver = new Driver(guide, { paused: () => this.halted, gate: () => Promise.resolve() })
    this.cam = new Camera(sim.session, tab, sim.root, () => (sim.focused ? FOCUS_VIEW : ARENA_VIEW))
    this.coach = new Coach(guide, () => this.coachStep())
    this.offs.push(
      onDemoCopy((text) => {
        if (/Tuner/.test(text)) this.copied = true
      })
    )
    const touch = (e: Event): void => {
      if (!e.isTrusted || !OPEN_PHASES.includes(this.phase)) return
      this.lastInput = performance.now()
      if (this.phase === 'explore') this.armIdle()
      if (e.type !== 'pointermove' && (e.target as Element | null)?.closest?.('[data-workspace-view]')) this.tookOver = true
    }
    for (const t of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'touchstart'] as const) {
      window.addEventListener(t, touch, { capture: true, passive: true })
      this.offs.push(() => window.removeEventListener(t, touch, { capture: true }))
    }
    if (this.phone) {
      const fold = new MutationObserver(() => this.foldHierarchy())
      fold.observe(document.body, { childList: true, subtree: true })
      this.offs.push(() => fold.disconnect())
    }
  }

  private foldHierarchy(): void {
    if (!this.phone || this.peeking || this.disposed || OPEN_PHASES.includes(this.phase)) return
    phoneTunerControls.get(this.tab)?.fold('hierarchy', false, `the ${this.phase} script runs`)
  }

  private async select(name: string, within?: string): Promise<boolean> {
    const find = (): Element | null => (within ? document.querySelector(`[data-scene-hierarchy] [data-row-key*="${CSS.escape(within)}"][data-row-key$="/${CSS.escape(name)}"]`) : this.row(name))
    collapseExpanded('Drift picks a row')
    if (this.phone && !document.querySelector('[data-tuner-hierarchy-pane]') && phoneTunerControls.get(this.tab)?.pick(name, within)) return true
    this.peeking = true
    const root = document.documentElement
    const driving = root.hasAttribute(DRIVING)
    root.removeAttribute(DRIVING)
    try {
      if (!document.querySelector('[data-tuner-hierarchy-pane]')) document.querySelector<HTMLElement>('[data-tuner-hierarchy-crumb]')?.click()
      let row = await this.until(() => find(), 1200)
      if (!row) {
        await this.expandAll()
        row = await this.seek(find)
      }
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      return !!row
    } finally {
      this.peeking = false
      this.foldHierarchy()
      if (driving) await this.afterFrames(3, () => document.querySelector('[data-satura-drift]') && root.setAttribute(DRIVING, ''))
    }
  }

  private async afterFrames(n: number, fn: () => void): Promise<void> {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null)))
    fn()
  }

  private async choose(name: string, line: string, within?: string): Promise<boolean> {
    if (!(await this.select(name, within))) return false
    await this.wait(line ? this.driver.say(line) + 250 : 250)
    return true
  }

  coachTarget(): { x: number; y: number; el: Element } | null {
    return this.phase === 'yours' && !this.coach.pressed ? this.coach.target() : null
  }

  get locked(): boolean {
    return !OPEN_PHASES.includes(this.phase)
  }

  get startCase(): StartCase {
    return this.kind
  }

  private show(patch: Partial<HandoffCard>): void {
    this.card = { ...this.card, ...patch }
    this.onCard(this.card)
  }

  private later(ms: number, fn: () => void): void {
    const g = this.gen
    this.timers.push(
      setTimeout(() => {
        if (g === this.gen && !this.disposed) fn()
      }, ms)
    )
  }

  private enter(p: Phase): number {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    this.gen++
    const from = this.phase
    this.phase = p
    this.guide.keep(!OPEN_PHASES.includes(p) && p !== 'done' && p !== 'intro')
    if (this.phone && p === 'animating') document.documentElement.dataset.demoFold = 'inspector'
    else delete document.documentElement.dataset.demoFold
    this.foldHierarchy()
    if (p !== 'yours') this.coach.stop()
    if (from === 'yours' && p !== 'yours') {
      this.guide.drift.hush()
      if (p !== 'showing') this.guide.leave()
    }
    switch (p) {
      case 'yours':
        this.lastInput = performance.now()
        this.show({ stage: 'yours', beat: 5 })
        this.watch()
        this.coach.start()
        break
      case 'explore':
        this.armIdle()
        break
      case 'sending':
        this.sending()
        break
      default:
        break
    }
    console.log(`[demo] phase ${from} -> ${p}`)
    this.onPhase?.(p)
    return this.gen
  }

  private script(phase: Phase, fn: () => Promise<void>, ok: () => void, cut: () => void): void {
    const g = this.enter(phase)
    this.halted = false
    this.freeing = false
    void (async () => {
      let fine = false
      try {
        await fn()
        fine = true
      } catch (e) {
        if (!(e instanceof Paused)) console.warn(`[handoff] ${(e as Error).message}`)
      }
      this.driver.leave()
      if (g !== this.gen || this.disposed) return
      if (fine) ok()
      else if (this.freeing) this.toExplore()
      else cut()
    })()
  }

  private toExplore(): void {
    this.freeing = false
    this.sim.holdFocus = false
    this.sim.releaseFocus()
    this.enter('explore')
  }

  free(): void {
    if (this.disposed) return
    switch (this.phase) {
      case 'intro':
        this.enter('explore')
        break
      case 'prep':
      case 'showing':
      case 'animating':
        this.freeing = true
        this.halted = true
        break
      case 'asking':
        this.guide.stop()
        this.enter('explore')
        break
      case 'yours':
        this.enter('explore')
        break
      default:
        break
    }
  }

  start(kind: StartCase): void {
    if (this.phase !== 'intro' || this.disposed) return
    this.kind = kind
    if (kind === 'free') {
      this.enter('explore')
      return
    }
    if (kind === 'anim') {
      this.show({ kind: 'anim', stage: 'agent', prompt: '', beat: 0 })
      this.script(
        'animating',
        () => this.anim(),
        () => this.enter('sending'),
        () => this.enter('explore')
      )
      return
    }
    this.copied = false
    this.tookOver = false
    this.script(
      'prep',
      () => this.prep(),
      () => this.enter('yours'),
      () => {
        this.tookOver = true
        this.finishPrep()
        this.enter('yours')
      }
    )
  }

  poke(): void {
    switch (this.phase) {
      case 'intro':
        if (this.kind === 'anim') this.enter('explore')
        else {
          this.start(this.kind)
          this.halted = true
        }
        break
      case 'prep':
      case 'showing':
      case 'animating':
        this.halted = true
        break
      case 'asking':
        this.stopAsk()
        break
      case 'sending':
        this.enter('done')
        break
      default:
        break
    }
  }

  showNow(): void {
    if (this.phase !== 'yours') return
    const dirty = this.sim.overrides.length > 0 || this.sim.undoDepth > 0 || this.sim.isUnsaved
    if (dirty) this.sim.reset()
    this.copied = false
    this.tookOver = false
    this.show({ edited: false })
    this.showMe(dirty)
  }

  ask(section: string | null = mainComponent(this.guide.sections())): void {
    if (!section || !OPEN_PHASES.includes(this.phase)) return
    this.before = this.phase
    const back = this.phase
    const g = this.enter('asking')
    void this.guide
      .explain(section, 99)
      .catch(() => undefined)
      .then(() => {
        if (g === this.gen && !this.disposed) this.enter(back)
      })
  }

  askAbout(name: string, section: string): void {
    if (!OPEN_PHASES.includes(this.phase)) return
    const g = this.gen
    const live = (): boolean => g === this.gen && !this.disposed
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 100))
    void (async () => {
      if (!this.section(section) && this.phone) {
        await this.select(name)
        for (let i = 0; i < 30 && live() && !this.section(section); i++) await tick()
        await tick()
      } else if (!this.section(section)) {
        if (!this.row(name)) await this.expandAll()
        const row = await this.seek(() => this.row(name))
        if (!live() || !row) return
        revealInside(row)
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        for (let i = 0; i < 30 && live() && !this.section(section); i++) await tick()
        await tick()
        await tick()
      }
      if (live()) this.ask(section)
    })()
  }

  stopAsk(): void {
    if (this.phase !== 'asking') return
    this.guide.stop()
    this.enter(this.before)
  }

  stay(): void {
    if (this.phase === 'done') this.enter('explore')
  }

  private armIdle(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    this.later(EXPLORE_IDLE_MS, () => {
      if (this.phase === 'explore') this.onIdle?.()
    })
  }

  private watch(): void {
    const g = this.gen
    const depth = this.sim.undoDepth
    const tick = (): void => {
      if (g !== this.gen || this.disposed || this.phase !== 'yours') return
      if (this.copied) {
        this.enter('sending')
        return
      }
      if (this.sim.undoDepth !== depth) this.tookOver = true
      const edited = this.sim.overrides.length > 0
      if (edited !== !!this.card.edited) this.show({ edited })
      if (!this.tookOver && performance.now() - this.lastInput > DRIFT_AFTER_MS) {
        this.showMe()
        return
      }
      setTimeout(tick, 150)
    }
    setTimeout(tick, 150)
  }

  private showMe(fresh = false): void {
    this.show({ stage: 'drift' })
    this.script(
      'showing',
      () => this.showMeScript(fresh),
      () => this.enter(this.copied ? 'sending' : 'yours'),
      () => {
        this.tookOver = true
        this.enter('yours')
      }
    )
  }

  private sending(): void {
    this.guide.leave(true)
    const tune = this.card.kind === 'tune'
    const prompt = tune ? demoCopied() : this.card.prompt
    this.show({ stage: 'sent', beat: 6, prompt, replied: false })
    if (tune) this.frame(1400)
    this.later(REPLY_MS, () => this.show({ replied: true }))
    this.later(REPLY_MS + RESULT_HOLD_MS, () => this.enter('done'))
  }

  private changed(field: string): boolean {
    return this.sim.overrides.some((o) => o.field.startsWith(field))
  }

  private coachStep(): CoachStep | null {
    const picker = document.querySelector('[data-color-picker] [data-color-box]')
    if (picker) return { key: 'picker', el: picker, text: COACH.picker, fx: 0.9, fy: 0.1 }
    const size = this.prop('ParticleSystem', SIZE)
    const color = this.prop('ParticleSystem', COLOR)
    const n = this.sim.overrides.length
    const copy = (): CoachStep | null => {
      const btn = this.button('Copy Changes')
      return btn ? { key: 'copy', el: btn, text: COACH.copy } : null
    }
    if (n >= 2) return copy()
    if (!size || !color) {
      if (n >= 1) return copy()
      if (this.phase === 'yours') setTimeout(() => this.free(), 0)
      return null
    }
    if (!this.changed(SIZE) && !this.changed(COLOR)) return { key: 'size', el: size, text: COACH.size, part: labelPart, fx: 0.35 }
    if (!this.changed(COLOR)) return { key: 'color', el: color, text: COACH.color, part: valuePart }
    return copy()
  }

  private async wait(ms: number): Promise<void> {
    await this.driver.pause(ms)
  }

  private rect(el: Element | null, part?: Part): Promise<DOMRect | null> {
    return this.driver.aim(el, part)
  }

  private async until<T>(fn: () => T | null, ms = 6000): Promise<T | null> {
    const t0 = performance.now()
    while (performance.now() - t0 < ms) {
      const v = fn()
      if (v) return v
      await this.wait(100)
    }
    return null
  }

  private async seek(find: () => Element | null): Promise<Element | null> {
    const list = document.querySelector<HTMLElement>('[data-scene-hierarchy]')
    let row = find()
    if (row || !list) return row
    const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    for (let top = 0; top <= list.scrollHeight; top += Math.max(40, list.clientHeight - 24)) {
      list.scrollTop = top
      await frame()
      row = find()
      if (row) return row
    }
    return null
  }

  private row(name: string): Element | null {
    return document.querySelector(`[data-scene-hierarchy] [data-row-key$="/${CSS.escape(name)}"]`)
  }

  private section(name: string): Element | null {
    return document.querySelector(`[data-tuner-inspector] [data-ti-section="${CSS.escape(name)}"]`)
  }

  private prop(section: string, prop: string): Element | null {
    const sec = this.section(section)
    return sec ? ([...sec.querySelectorAll('[data-ti-prop]')].find((e) => (e.getAttribute('data-ti-prop') ?? '').startsWith(prop)) ?? null) : null
  }

  private button(text: string): HTMLElement | null {
    return [...document.querySelectorAll<HTMLElement>('[data-workspace-view] button')].find((b) => b.textContent?.trim() === text) ?? null
  }

  private async tap(el: Element | null, line = ''): Promise<boolean> {
    const r = await this.rect(el)
    if (!r) return false
    await this.driver.click(r.left + r.width / 2, r.top + r.height / 2, line, true)
    return true
  }

  private async pick(name: string, line: string): Promise<boolean> {
    if (this.phone) return this.choose(name, line)
    const r = await this.rect(await this.until(() => this.row(name)))
    if (!r) return false
    await this.driver.click(r.left + Math.min(90, r.width / 2), r.top + r.height / 2, line, true)
    await this.wait(500)
    return true
  }

  private async scrub(section: string, prop: string, dx: number, line: string): Promise<void> {
    const r = await this.rect(await this.until(() => this.prop(section, prop), 3000), labelPart)
    if (!r) return
    const x = r.left + Math.min(20, r.width / 3)
    const y = r.top + r.height / 2
    await this.driver.moveTo(x, y, line)
    await this.wait(120)
    await this.driver.press()
    await this.driver.dragTo(x + dx, y, 1200)
    await this.driver.lift()
    console.log(`[handoff] ${section}.${prop} -> ${this.sim.readFocus(section, prop) ?? '?'}`)
  }

  private async recolor(section: string, prop: string, hue: number, line: string, pickLine: string): Promise<void> {
    const r = await this.rect(await this.until(() => this.prop(section, prop), 3000), valuePart)
    if (!r) return
    await this.driver.click(r.left + r.width / 2, r.top + r.height / 2, line)
    const box = await this.rect(await this.until(() => document.querySelector('[data-color-picker] [data-color-box]'), 2000))
    if (!box) return
    const bx = box.right - 5
    const by = box.top + 5
    await this.driver.moveTo(bx - 30, by + 30, pickLine)
    await this.driver.press()
    await this.driver.dragTo(bx, by, 500)
    await this.driver.lift()
    const track = await this.rect(document.querySelector('[data-color-picker] [aria-label="Hue"]'))
    if (track) {
      const tx = track.left + track.width / 2
      const ty = track.top + track.height * hue
      await this.driver.moveTo(tx, track.top + track.height * 0.6)
      await this.driver.press()
      await this.driver.dragTo(tx, ty, 900)
      await this.driver.lift()
    }
    await this.wait(250)
    const ins = document.querySelector('[data-tuner-inspector]')
    const col = ins?.closest('[data-tuner-inspector-column]') ?? null
    const pane = ins ? (col ? intersect(clientRect(ins), clientRect(col)) : clientRect(ins)) : null
    if (pane) await this.driver.click(pane.x + 30, pane.y + pane.height - 24)
    await this.wait(250)
    console.log(`[handoff] ${section}.${prop} color -> ${document.querySelector('[data-color-picker]') ? 'still open' : 'set'}`)
  }

  private agentClick(el: Element | null): boolean {
    if (!el) return false
    const r = clientRect(el)
    if (!r.width) return false
    const x = r.left + Math.min(90, r.width / 2)
    const y = r.top + r.height / 2
    const send = (type: string): void => {
      this.guide.scope.input('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
    send('mouseMoved')
    send('mousePressed')
    send('mouseReleased')
    return true
  }

  private filtered(): boolean {
    return this.sim.focused && (this.phone || !!this.row('Motes'))
  }

  private async expandAll(): Promise<void> {
    if (this.phone && !this.peeking) return
    for (let i = 0; i < 6; i++) {
      const shut = [...document.querySelectorAll<HTMLElement>('[data-scene-hierarchy] [data-chevron][aria-label="Expand"]')]
      if (!shut.length) return
      for (const c of shut) c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true, view: window }))
      await new Promise((r) => setTimeout(r, 120))
    }
  }

  private applyFilter(): void {
    swapFade(() => this.setFilter())
  }

  private setFilter(): void {
    const orbit = tunerMemory(this.tab, ARENA_VIEW, this.sim.root).orbit
    const next = tunerMemory(this.tab, FOCUS_VIEW, this.sim.root)
    next.orbit = orbit ? structuredClone(orbit) : null
    next.animOpen = false
    useAppStore.getState().setTabTuner(this.tab, { kind: 'view', id: ARENA_VIEW, filter: FOCUS_VIEW }, tunerLabel('motes-and-lights'))
  }

  private frame(ms: number): void {
    tunerShot({ session: this.sim.session, orbit: orbitFromLookAt(DOOR.position, DOOR.lookAt, 50), ms })
  }

  private motesSelected(): boolean {
    return !!document.querySelector('[data-tuner-inspector] [data-ti-section="ParticleSystem"]')
  }

  private async prep(): Promise<void> {
    tunerShot({ session: this.sim.session, orbit: { target: [0, 1.3, 1.4], yaw: 36, pitch: 27, distance: 15.5, fov: 50 }, ms: 1 })
    this.show({ kind: 'tune', stage: 'ask', beat: 0, prompt: '', edited: false, replied: false })
    this.frame(2600)
    this.guide.ensure()
    const intro = this.guide.drift.sayFor(INTRO_LINE)
    await this.wait(2000)
    this.show({ stage: 'agent' })
    await this.wait(Math.max(400, intro.travel + intro.read + 80 - 2000))
    this.sim.holdFocus = true
    this.show({ stage: 'tool', beat: 1 })
    this.applyFilter()
    await this.until(() => (this.filtered() ? true : null), 8000)
    if (document.querySelector('[data-anim-ruler]')) document.querySelector<HTMLElement>('[data-tuner-animation-toggle]')?.click()
    await this.expandAll()
    await this.wait(400)
    this.show({ beat: 2 })
    this.sim.releaseFocus()
    await this.wait(1000)
    this.show({ beat: 3 })
    this.frame(1900)
    await this.wait(2200)
    this.show({ beat: 4 })
    if (this.phone) await this.select('Motes')
    else this.agentClick(await this.until(() => this.row('Motes'), 3000))
    await this.until(() => (this.motesSelected() ? true : null), 2000)
    await this.wait(400)
  }

  private finishPrep(): void {
    const g = this.gen
    this.show({ kind: 'tune', stage: 'tool', beat: 4 })
    if (!this.sim.focused) this.applyFilter()
    this.sim.releaseFocus()
    this.frame(500)
    const t0 = performance.now()
    const poll = async (): Promise<void> => {
      if (this.disposed || g + 1 < this.gen) return
      if (this.phone) {
        if (!this.sim.focused && performance.now() - t0 < 4000) setTimeout(() => void poll(), 100)
        else if (this.phase === 'yours' && !this.motesSelected() && this.sim.overrides.length === 0) void this.select('Motes')
        return
      }
      const row = this.row('Motes')
      if (!row) {
        if (performance.now() - t0 < 4000) setTimeout(() => void poll(), 100)
        return
      }
      await this.expandAll()
      if (this.phase === 'yours' && !this.motesSelected() && this.sim.overrides.length === 0) this.agentClick(this.row('Motes'))
    }
    void poll()
  }

  private async showMeScript(fresh: boolean): Promise<void> {
    if (fresh) {
      await this.wait(300)
      if (!this.filtered()) {
        this.applyFilter()
        await this.until(() => (this.filtered() ? true : null), 4000)
      }
      await this.expandAll()
    }
    this.cam.mark()
    if (!this.motesSelected() && !(await this.pick('Motes', 'Let me show you. First the motes.'))) return
    await this.shot('motes')
    await this.scrub('ParticleSystem', SIZE, 7, 'Start Size makes each mote much bigger.')
    await this.wait(250)
    await this.recolor('ParticleSystem', COLOR, ORANGE, "Start Color. I'll pick something warm.", 'Strong orange, so you can see them from the door.')
    await this.wait(250)
    await this.scrub('ParticleSystem', RATE, 200, 'Rate Over Time adds more of them every second.')
    await this.wait(250)
    const lampLine = 'Now the left lamp, four levels down.'
    const lamp = this.phone ? null : (document.querySelector('[data-scene-hierarchy] [data-row-key*="Niche L"][data-row-key$="/Lamp"]') ?? this.row('Lamp'))
    const lr = lamp ? await this.rect(lamp) : null
    if (lr || (this.phone && (await this.choose('Lamp', lampLine, 'Niche L')))) {
      if (lr) await this.driver.click(lr.left + Math.min(90, lr.width / 2), lr.top + lr.height / 2, lampLine, true)
      await this.wait(250)
      await this.shot('nicheL')
      await this.recolor('Light', 'm_Color', AMBER, 'Same warm color on the lamp.', 'The statue picks it up.')
      await this.scrub('Light', 'm_Intensity', 150, 'Turn up Intensity and the niche glows.')
      await this.wait(250)
    }
    this.frame(1500)
    await this.wait(300)
    const copy = await this.until(() => this.button('Copy Changes'))
    await this.tap(copy, 'Copy Changes sends the new values back to the agent.')
    await this.wait(300)
  }

  private async shot(name: keyof typeof SHOTS, ms = 1700): Promise<void> {
    await this.wait(this.cam.shot(SHOTS[name], ms) + 100)
  }

  private async home(ms = 1500): Promise<void> {
    await this.wait(this.cam.back(ms) + 100)
  }

  private keyFrames(): number[] {
    return [...document.querySelectorAll('[data-anim-key]')].map((k) => Number(k.getAttribute('data-anim-key')?.split('@').pop())).filter((f) => Number.isFinite(f))
  }

  private keyAt(frame: number): Element | null {
    return document.querySelector(`[data-anim-key$="@${frame}"]`)
  }

  private async anim(): Promise<void> {
    this.show({ kind: 'anim', stage: 'tool', prompt: '', beat: 0 })
    this.cam.mark()
    if (!(await this.pick('Monolith', 'The monolith carries the clip.'))) return
    void this.cam.shot(SHOTS.monolith, 1800)
    if (!document.querySelector('[data-anim-ruler]')) {
      const toggle = document.querySelector('[data-tuner-animation-toggle]')
      if (toggle) revealInside(toggle, 'nearest', 'nearest', true)
      await this.tap(toggle, 'Open the Animation timeline.')
      await this.wait(250)
    }
    this.show({ kind: 'anim', stage: 'tuning', prompt: '', beat: 0 })
    const picker = await this.until(() => document.querySelector('[data-anim-clip-picker]'))
    if (!(document.querySelector('[data-anim-clip-name]')?.textContent ?? '').includes('Arrival')) {
      await this.tap(picker, 'Switch to the Arrival clip.')
      await this.wait(200)
      await this.tap(await this.until(() => document.querySelector(`[data-anim-menu-item="${CSS.escape(ARRIVAL)}"]`)))
      await this.until(() => ((document.querySelector('[data-anim-clip-name]')?.textContent ?? '').includes('Arrival') ? this.keyAt(150) : null))
      await this.wait(250)
    }
    void this.cam.shot(SHOTS.rise, 2000)
    const rulerEl = await this.until(() => document.querySelector('[data-anim-ruler]'))
    const ruler = await this.rect(rulerEl)
    if (!ruler || !rulerEl) return
    const y = ruler.top + ruler.height / 2
    await this.driver.moveTo(ruler.left + 8, y, 'Scrub the ruler. The slab rises out of the floor.')
    await this.driver.press()
    await this.driver.dragTo(ruler.left + ruler.width * 0.86, y, 2600)
    await this.wait(300)
    await this.driver.dragTo(ruler.left + ruler.width * 0.3, y, 1200)
    await this.driver.lift()
    const k0 = await this.rect(this.keyAt(0))
    const k150 = await this.rect(this.keyAt(150))
    if (!k150 || !k0) return
    const perFrame = (k150.left - k0.left) / 150
    const kx = k150.left + k150.width / 2
    const ky = k150.top + k150.height / 2
    await this.driver.click(kx, ky, 'This key ends the rise, at frame 150.')
    await this.wait(250)
    const k2 = await this.rect(this.keyAt(150))
    const lane = { el: rulerEl, base: whole(rulerEl) ?? ruler }
    const kx2 = k2 ? k2.left + k2.width / 2 : kx
    const ky2 = k2 ? k2.top + k2.height / 2 : ky
    const key0 = this.keyAt(0)
    const k0b = key0 ? clientRect(key0) : null
    const step = k2 && k0b ? (k2.left - k0b.left) / 150 : perFrame
    await this.driver.moveTo(kx2, ky2, 'I drag it later, so the rise takes longer.')
    await this.driver.press()
    await this.driver.dragTo(Math.min(kx2 + step * 26, lane.base.x + lane.base.width - 2), ky2, 1300, lane)
    await this.driver.lift()
    await this.wait(250)
    const pill = await this.until(() => document.querySelector('[data-anim-seg$="@0"]'), 3000)
    if (await this.tap(pill, 'The pill between two keys is the easing.')) {
      const back = await this.until(() => document.querySelector('[data-anim-ease="backOut"]'), 3000)
      await this.tap(back, 'Back Out overshoots a little, then settles.')
      await this.wait(250)
      await this.tap(document.querySelector('[data-anim-ease-close]'))
    }
    await this.tap(document.querySelector('[data-anim-btn="first"]'))
    const clip = Math.max(0, ...this.keyFrames()) / 30 * 1000
    await this.tap(document.querySelector('[data-anim-btn="play"]'), 'Play it from the start.')
    await this.shot('slab', 2600)
    await this.wait(Math.max(300, clip - 2700 + 300))
    await this.tap(document.querySelector('[data-anim-btn="play"]'))
    await this.home()
    const frames = this.keyFrames().filter((f) => f > 0 && f < 180)
    const end = frames.length ? Math.max(...frames) : 176
    this.show({ kind: 'anim', stage: 'tuning', prompt: `Monolith › MonolithArrival: the rise now ends at frame ${end} (${(end / 30).toFixed(1)} s) with Back Out easing.` })
  }

  dispose(): void {
    delete document.documentElement.dataset.demoFold
    this.disposed = true
    this.halted = true
    this.gen++
    for (const t of this.timers) clearTimeout(t)
    for (const o of this.offs) o()
    this.coach.dispose()
    this.driver.dispose()
  }
}
