import { InjectedScript, type Builtins } from '../playwright/injected/injectedScript'
import { parentElementOrShadowHost } from '../playwright/injected/domUtils'
import { getAriaRole, getElementAccessibleName } from '../playwright/injected/roleUtils'
import { normalizeWhiteSpace } from '../playwright/isomorphic/stringUtils'
import type { ParsedSelector } from '../playwright/isomorphic/selectorParser'
import { Drift, type GrabTrace } from './drift'
import { Anchor, fracOf, viewportBox, type Point } from './anchor'
import type { Box } from './bubble'
import { gizmoBox, type GizmoSpec } from './gizmo'
import { exactPart, fieldBox, labelPart, valuePart, type FieldSide } from './field-part'
import { GIZMO_OBJECT } from '../../../shared/gizmo-pick'
import { WorkspaceScope, type PanePlan } from './scope'
import { leanSnapshot, type SnapshotOptions } from './snapshot'
import { UserWatch } from './user-watch'
import type { PressedVia } from '../drift-rules'
import { driftSpotOf, type DriftSide, type DriftSpot } from '../../../shared/drift-spot'

const RAF_FALLBACK_MS = 100
const NAME_CHARS = 28

function builtins(win: Window & typeof globalThis): Builtins {
  return {
    performance: win.performance,
    requestAnimationFrame: (callback) => {
      let done = false
      const fire = (time: number): void => {
        if (done) return
        done = true
        callback(time)
      }
      win.requestAnimationFrame(fire)
      win.setTimeout(() => fire(win.performance.now()), RAF_FALLBACK_MS)
    }
  }
}

export class SaturaInjected extends InjectedScript {
  scope: WorkspaceScope
  drift: Drift
  watch: UserWatch

  constructor(private readonly _saturaWin: Window & typeof globalThis) {
    super(_saturaWin, {
      isUnderTest: false,
      testIdAttributeName: 'data-testid',
      stableRafCount: 1,
      browserName: 'chromium',
      isUtilityWorld: true,
      customEngines: [],
      builtins: builtins(_saturaWin)
    })
    this.scope = new WorkspaceScope(_saturaWin, '')
    this.drift = new Drift(_saturaWin, this.scope)
    this.watch = new UserWatch(_saturaWin, () => this.scope)
  }

  bind(workspace: string, name: string, spotlight = true, show = true): { workspace: string; found: boolean; active: boolean } {
    if (this.scope.id !== workspace) {
      this.drift.remove()
      this.scope = new WorkspaceScope(this._saturaWin, workspace)
      this.drift = new Drift(this._saturaWin, this.scope)
    }
    this.scope.reset()
    this.scope.watchKeys()
    this.watch.reset()
    this.drift.allowSpotlight(spotlight)
    if (show) this.drift.begin(name)
    else this.drift.remove()
    return { workspace, found: !workspace || !!this.scope.view(), active: this.scope.active() }
  }

  anchorFor(node: Node | null | undefined, frac: Point | null, parsed: ParsedSelector | null, gizmo: GizmoSpec | null = null, side: FieldSide | null = null): Anchor | null {
    if (!node || node.nodeType !== 1) return null
    const el = node as Element
    const find = parsed
      ? (): Element | null => {
          try {
            return this.querySelector(parsed, this.document, false) ?? null
          } catch {
            return null
          }
        }
      : null
    const part = gizmo ? (e: Element): Box | null => gizmoBox(e, gizmo, this._saturaWin) : side ? exactPart(side === 'label' ? labelPart : valuePart, side) : null
    const desc = gizmo ? (gizmo.kind === GIZMO_OBJECT ? `${gizmo.path || 'the selection'} in the scene view` : `gizmo handle ${['x', 'y', 'z'][gizmo.axis] ?? gizmo.axis}`) : this.previewNode(el)
    return new Anchor(this._saturaWin, el, frac ?? { x: 0.5, y: 0.5 }, desc, this.scope, find, (e) => this.previewNode(e), part)
  }

  anchorSelector(parsed: ParsedSelector, how: { box: Box | null; gizmo: GizmoSpec | null; part?: FieldSide | null } | null = null): Anchor | null {
    let el: Element | undefined
    try {
      el = this.querySelector(parsed, this.document, false)
    } catch {
      return null
    }
    if (!el) return null
    if (how?.gizmo) return this.anchorFor(el, null, parsed, how.gizmo)
    if (how?.part && fieldBox(el, how.part)) return this.anchorFor(el, null, parsed, null, how.part)
    const b = how?.box
    const frac = b ? fracOf(viewportBox(el, this._saturaWin), { x: b.x + b.width / 2, y: b.y + b.height / 2 }) : null
    return this.anchorFor(el, frac, parsed)
  }

  spot(parsed: ParsedSelector | null, how: { gizmo: GizmoSpec | null; part?: FieldSide | null } | null, at: Point | null): { spot: DriftSpot | null; search: string | null } {
    let el: Element | null = null
    if (parsed) {
      try {
        el = this.querySelector(parsed, this.document, false) ?? null
      } catch {
        el = null
      }
    }
    if (!el && at) el = this.scope.hitTest(at.x, at.y)
    const side: DriftSide | null = how?.part === 'value' || how?.part === 'label' ? how.part : null
    const spot = driftSpotOf(el, how?.gizmo ?? null, side, at)
    const pane = (el?.closest('[data-tuner-pane]') ?? this.tunerPaneEl()) as Element | null
    const box = pane?.querySelector<HTMLInputElement>('[data-hierarchy-search]')
    return { spot, search: box ? box.value : null }
  }

  private tunerPaneEl(): Element | null {
    const doc = this._saturaWin.document
    return Array.from(doc.querySelectorAll('[data-tuner-pane]')).find((el) => this.scope.owns(el) && el.getBoundingClientRect().width > 0) ?? null
  }

  bye(failed: boolean): number {
    this.watch.reset()
    return this.drift.bye(failed, () => this.watch.take())
  }

  driven(): boolean {
    const view = this.scope.view()
    return !view || view.getAttribute('data-driven') === 'true' || this.scope.active()
  }

  label(node: Node): string {
    if (node.nodeType !== 1) return ''
    const el = node as Element
    let name = ''
    try {
      name = getElementAccessibleName(el, false)
    } catch {
    }
    if (!name) name = el.getAttribute('title') || el.getAttribute('placeholder') || ''
    name = name.replace(/\s+/g, ' ').trim()
    return name.length > NAME_CHARS ? `${name.slice(0, NAME_CHARS - 1).trimEnd()}…` : name
  }

  scrollPlan(node: Node): { x: number; y: number; box: { x: number; y: number; width: number; height: number }; dx: number; dy: number } | null {
    if (node.nodeType !== 1) return null
    const win = this._saturaWin
    const r = (node as Element).getBoundingClientRect()
    for (let p = parentElementOrShadowHost(node as Element); p; p = parentElementOrShadowHost(p)) {
      const s = win.getComputedStyle(p)
      const sy = /(auto|scroll|overlay)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1
      const sx = /(auto|scroll|overlay)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1
      if (!sx && !sy) continue
      const c = p.getBoundingClientRect()
      const dy = sy ? (r.top < c.top ? -1 : r.bottom > c.bottom ? 1 : 0) : 0
      const dx = sx ? (r.left < c.left ? -1 : r.right > c.right ? 1 : 0) : 0
      if (!dx && !dy) continue
      const x0 = Math.max(c.left, 0)
      const y0 = Math.max(c.top, 0)
      const x1 = Math.min(c.right, win.innerWidth)
      const y1 = Math.min(c.bottom, win.innerHeight)
      if (x1 - x0 < 4 || y1 - y0 < 4) return null
      return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, dx, dy }
    }
    return null
  }

  route(method: string, params: Record<string, any>, via: PressedVia, defer: boolean): string {
    this.watch.script(method, params)
    const r = this.scope.route(method, params, via, defer)
    return r === 'hold' ? `hold:${this.scope.holdWhy}` : r
  }

  panePlan(x: number, y: number): PanePlan | null {
    return this.scope.panePlan(x, y)
  }

  focusPane(x: number, y: number): boolean {
    return this.scope.focusPane(x, y)
  }

  focusDesc(): string {
    return this.scope.focusDesc()
  }

  pressProbe(): { event: { x: number; y: number; at: string } | null; marker: Point | null; tip: Point | null } {
    const d = this.scope.lastDown
    this.scope.lastDown = null
    const p = this.drift.lastPress
    this.drift.lastPress = null
    return { event: d && { x: d.x, y: d.y, at: this.scope.regionName(d.target) }, marker: p?.marker ?? null, tip: p?.tip ?? null }
  }

  dragProbe(): { down: string; moves: Record<string, number>; lock: string } {
    const r = { down: this.scope.dragDown, moves: this.scope.dragMoves, lock: this.scope.lockedBy() }
    this.scope.dragMoves = {}
    return r
  }

  grabProbe(): GrabTrace | null {
    const g = this.drift.lastGrab
    if (!g?.after) return null
    this.drift.lastGrab = null
    return g
  }

  releaseLock(x: number, y: number): string {
    return this.scope.releaseLock(x, y)
  }

  lockedBy(): string {
    return this.scope.lockedBy()
  }

  keyMark(): number {
    this.scope.watchKeys()
    return this.scope.keySeq()
  }

  keyLanded(x: number, y: number, since: number): string {
    return this.scope.keyLanded(x, y, since)
  }

  frames(n: number): Promise<void> {
    return new Promise((resolve) => {
      let left = n
      const step = (): void => {
        if (--left <= 0) resolve()
        else this._saturaWin.requestAnimationFrame(step)
      }
      this._saturaWin.requestAnimationFrame(step)
      this._saturaWin.setTimeout(resolve, 120)
    })
  }

  foregroundWhy(node: Node): string {
    if (!this.scope.background() || node.nodeType !== 1) return ''
    const el = node as HTMLElement
    if (el.closest('.xterm')) return 'terminal input'
    if (el.isContentEditable) return 'rich text field'
    return this.scope.inside(el) ? '' : 'outside the workspace'
  }

  snapshot(node: Node | null, options: SnapshotOptions): string {
    const root = node && node.nodeType === 1 ? (node as Element) : this._saturaWin.document.body
    const { text, snapshot } = leanSnapshot(root, options, (el) => this.scope.owns(el))
    if (snapshot) this._lastAriaSnapshotForQuery = snapshot
    return text
  }

  override previewNode(node: Node): string {
    if (node.nodeType !== 1) return super.previewNode(node)
    const el = node as Element
    const role = getAriaRole(el)
    const name = normalizeWhiteSpace(getElementAccessibleName(el, false) || '')
    const label = name || normalizeWhiteSpace(el.textContent ?? '')
    const shown = label.length > 50 ? `${label.slice(0, 49)}…` : label
    return `${role ?? el.nodeName.toLowerCase()}${shown ? ` ${JSON.stringify(shown)}` : ''}`
  }

  tunerPane(node: Node | null): { view: string; ready: boolean; state: string; show: string; target: string } | null {
    const el = node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null)
    const pane = el?.closest('[data-tuner-pane]')
    if (!pane || el?.closest('[data-tuner-state-card] button, [data-tuner-target-bar] button')) return null
    const show = pane.getAttribute('data-tuner-show') ?? ''
    return {
      view: pane.getAttribute('data-tuner-view') ?? '',
      ready: show ? show === 'scene' : pane.getAttribute('data-tuner-ready') === 'true',
      state: pane.getAttribute('data-tuner-state') ?? '',
      show,
      target: pane.getAttribute('data-tuner-target') ?? ''
    }
  }

  tunerPaneAt(x: number, y: number): { view: string; ready: boolean; state: string; show: string; target: string } | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return this.tunerPane(this.scope.hitTest(x, y))
  }

  tunerPanes(): { view: string; ready: boolean; state: string; show: string; target: string }[] {
    const doc = this._saturaWin.document
    const panes = Array.from(doc.querySelectorAll('[data-tuner-pane]')).filter((el) => this.scope.owns(el) && el.getBoundingClientRect().width > 0)
    return panes.map((el) => this.tunerPane(el)!).filter(Boolean)
  }

  override querySelectorAll(selector: ParsedSelector, root: Node): Element[] {
    const all = super.querySelectorAll(selector, root)
    return this.scope.id ? all.filter((el) => this.scope.owns(el)) : all
  }

  override expectHitTarget(hitPoint: { x: number; y: number }, targetElement: Element): 'done' | { hitTargetDescription: string } {
    if (!this.scope.background()) return super.expectHitTarget(hitPoint, targetElement)
    const hit = this.scope.hitTest(hitPoint.x, hitPoint.y)
    const parents: Element[] = []
    let el: Element | undefined = hit ?? undefined
    while (el && el !== targetElement) {
      parents.push(el)
      el = el.assignedSlot ?? parentElementOrShadowHost(el)
    }
    if (el === targetElement) return 'done'
    return { hitTargetDescription: this.previewNode(parents[0] || this.document.documentElement) }
  }

  override focusNode(node: Node, resetSelectionIfNotFocused?: boolean): 'error:notconnected' | 'done' {
    if (!this.scope.background()) return super.focusNode(node, resetSelectionIfNotFocused)
    return this.scope.virtually(() => super.focusNode(node, resetSelectionIfNotFocused))
  }

  override blurNode(node: Node): 'error:notconnected' | 'done' {
    if (!this.scope.background()) return super.blurNode(node)
    return this.scope.virtually(() => super.blurNode(node))
  }

  override fill(node: Node, value: string): 'error:notconnected' | 'needsinput' | 'done' {
    if (!this.scope.background()) return super.fill(node, value)
    return this.scope.virtually(() => super.fill(node, value))
  }

  override selectText(node: Node): 'error:notconnected' | 'done' {
    if (!this.scope.background()) return super.selectText(node)
    return this.scope.virtually(() => super.selectText(node))
  }
}

;(globalThis as unknown as { __saturaCreate: (win: Window & typeof globalThis) => SaturaInjected }).__saturaCreate =
  (win) => new SaturaInjected(win)
