import type { Locator } from '../playwright/client/locator'
import { notePlacement, showPane, type LayoutPage } from './layout'
import { opts as checked } from './unity'
import { GIZMO_ASK_ATTR, GIZMO_AT_ATTR, GIZMO_EVENT } from '../../../shared/gizmo-pick'
import { chooseTunerTab, matchTunerName, tunerTabTarget, type TunerTabInfo } from '../../../shared/tuner-find'

type Box = { x: number; y: number; width: number; height: number }
type Point = { x: number; y: number }
type Options = Record<string, unknown>
type Found = Box & Options

export interface PageLike extends LayoutPage {
  readonly _window: number | null
  readonly mouse: LayoutPage['mouse'] & {
    click(x: number, y: number, options?: Options): Promise<void>
    dblclick(x: number, y: number, options?: Options): Promise<void>
    wheel(dx: number, dy: number): Promise<void>
  }
  getByRole(role: string, options?: Options): Locator
  waitForTimeout(ms: number): Promise<void>
}

export type TunerRpc = (args: Options) => Promise<unknown>

const AXES: Record<string, number> = { x: 0, y: 1, z: 2 }
const TOOLS: Record<string, string> = { move: 'axis', plane: 'plane', rotate: 'ring', scale: 'scale' }
const WAIT_MS = 5000
const FIELD_GRACE_MS = 1200
const OPEN_MS = 90_000

function q(value: string): string {
  return JSON.stringify(String(value))
}

type FieldValue = string | number | boolean | null | { [key: string]: FieldValue }

async function centerOf(target: unknown): Promise<Point> {
  if (target instanceof Spot) return target._center()
  const t = target as Record<string, any> | null
  if (t && typeof t.boundingBox === 'function') {
    const b = (await t.boundingBox()) as Box | null
    if (!b) throw new Error(`${String(t)} isn't on screen`)
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  if (t && typeof t.x === 'number' && typeof t.y === 'number') {
    return { x: t.x + (Number(t.width) || 0) / 2, y: t.y + (Number(t.height) || 0) / 2 }
  }
  throw new TypeError('Pass a locator, a Tuner target or { x, y }')
}

const chosen = new WeakMap<PageLike, string>()
const pinned = new WeakMap<PageLike, string>()
const aimed = new WeakMap<PageLike, string>()

function paneOf(page: PageLike): Locator {
  const view = chosen.get(page)
  const target = aimed.get(page)
  const at = target ? `[data-tuner-target=${q(target)}]` : ''
  return page.locator(view ? `[data-tuner-pane][data-tuner-view=${q(view)}]${at} >> visible=true` : `[data-tuner-pane]${at} >> visible=true`).first()
}

function inspector(page: PageLike): Locator {
  return paneOf(page).locator('[data-tuner-inspector]').first()
}

function hierarchy(page: PageLike): Locator {
  return paneOf(page).locator('[data-scene-hierarchy]').first()
}

function viewport(page: PageLike): Locator {
  return paneOf(page).locator('[data-scene-viewport]').first()
}

function animator(page: PageLike): Locator {
  return paneOf(page).locator('[data-tuner-animator]').first()
}

const NO_TUNER = "No Tuner is open in your workspace. Open one with tuner.open({ scene: true }) or tuner.open({ prefab: 'Assets/Prefabs/Crate.prefab' })."

type FoundTuner = { view: string; count?: number; activated?: boolean } | null
type Gate = {
  find: (view?: string, target?: string) => Promise<FoundTuner>
  ready: (view?: string, timeout?: number, limit?: number, target?: string) => Promise<string | null>
  list: () => Promise<TunerTabInfo[]>
}

const gates = new WeakMap<PageLike, Gate>()

export function tunerTitle(t: { view: string }): string {
  if (t.view === 'scene') return 'the scene Tuner'
  if (t.view.startsWith('@asset:')) return `the Tuner of ${t.view.slice(7)}`
  return `the Tuner "${t.view}"`
}

export function tunerPinned(page: PageLike): string | null {
  return pinned.get(page) ?? null
}

export async function tunerTabList(page: PageLike): Promise<TunerTabInfo[]> {
  return (await gates.get(page)?.list()) ?? []
}

export async function tunerReady(page: PageLike, view?: string, timeout?: number): Promise<string> {
  const gate = gates.get(page)
  if (!gate) return view ?? ''
  const prior = chosen.get(page)
  const target = aimed.get(page)
  let found = await gate.find(view ?? prior, target)
  if (!found && target) {
    found = await gate.find(view ?? prior)
    if (found) aimed.delete(page)
  }
  if (!found && !view && prior) found = await gate.find()
  if (!found) throw new Error(view ? `No Tuner "${view}" is open in your workspace. ${NO_TUNER.slice(NO_TUNER.indexOf('Open'))}` : NO_TUNER)
  if (found.view) chosen.set(page, found.view)
  else chosen.delete(page)
  const ready = await gate.ready(found.view || undefined, timeout ?? (found.activated ? OPEN_MS : undefined), undefined, aimed.get(page))
  if (ready === null) throw new Error(NO_TUNER)
  chosen.set(page, ready)
  return ready
}

function inspectorTrouble(pane: Element): string {
  const view = pane.getAttribute('data-tuner-view') ?? ''
  const path = pane.querySelector('[data-scene-hierarchy]')?.getAttribute('data-selected-path') ?? ''
  const root = pane.querySelector('[data-tuner-inspector]')
  const target = root?.getAttribute('data-ti-target') ?? ''
  const subject = (path || target.slice(target.indexOf('|') + 1)).split('/').pop() || 'The selected object'
  const end = (t: string): string => (/[.!?]$/.test(t) ? t : `${t}.`)
  if (!root) {
    const why = pane.querySelector('[data-tuner-inspector-empty]')?.getAttribute('data-tuner-inspector-empty') ?? ''
    if (!path || why === 'nothing is selected') return `Nothing is selected in the Tuner "${view}". Select an object with tuner.row(path).click().`
    return end(`${subject} has no inspector fields: ${why || 'the inspector is empty'}`)
  }
  const text = (sel: string): string => (root.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const error = text('[data-ti-error]') || text('[data-ti-target-error]')
  if (error) return end(`${subject} has no inspector fields: ${error}`)
  if ((root.getAttribute('data-ti-seq') ?? '0') === '0') return `The inspector of ${subject} is still loading.`
  if (!root.querySelector('[data-ti-prop]')) {
    const note = Array.from(root.querySelectorAll('[data-ti-widget="helpBox"]')).map((e) => e.getAttribute('data-ti-text') ?? '').find(Boolean)
    return end(`${subject} has no inspector fields: ${note || 'the inspector shows no properties'}`)
  }
  return ''
}

async function troubleOf(page: PageLike): Promise<string> {
  const pane = paneOf(page)
  if (!(await pane.count())) return NO_TUNER
  return String((await pane.evaluate(inspectorTrouble)) ?? '')
}

export class Spot {
  private _shown = false
  _sel: string | null = null
  _gizmo: { axis: number; kind: string | null; path?: string } | null = null

  constructor(
    readonly _page: PageLike,
    protected readonly _find: () => Promise<Found | null>,
    readonly _name: string,
    readonly _pane: (() => Locator) | null = null,
    private readonly _missing: (() => Promise<string>) | null = null
  ) {}

  get _window(): number | null {
    return this._page._window
  }

  toString(): string {
    return this._name
  }

  toJSON(): string {
    return this._name
  }

  async _show(): Promise<void> {
    if (this._shown || !this._pane) return
    this._shown = true
    await showPane(this._page, this._pane()).catch(() => null)
  }

  async box(): Promise<Box | null> {
    await tunerReady(this._page)
    await this._show()
    const b = await this._find()
    return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null
  }

  async _ensure(): Promise<void> {
    await tunerReady(this._page)
  }

  _root(): Locator {
    return paneOf(this._page)
  }

  async _absent(waitMs = 1500): Promise<string> {
    if (!this._pane) return ''
    const until = Date.now() + waitMs
    while (!(await this._pane().count())) {
      if (Date.now() > until) return this._missing ? await this._missing() : `${this._name} isn't on screen`
      await this._page.waitForTimeout(100)
    }
    return ''
  }

  async _need(): Promise<Found> {
    await tunerReady(this._page)
    await this._show()
    const until = Date.now() + WAIT_MS
    while (true) {
      const b = await this._find()
      if (b) return b
      if (Date.now() > until || ((await this._gone()) && !(await this._back()))) throw new Error(this._missing ? await this._missing() : `${this._name} isn't on screen`)
      await this._page.waitForTimeout(100)
    }
  }

  async _gone(): Promise<boolean> {
    return false
  }

  async _back(): Promise<boolean> {
    return false
  }

  async _center(): Promise<Point> {
    const b = await this._need()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }

  async hover(): Promise<void> {
    const p = await this._center()
    await this._page.mouse.move(p.x, p.y)
  }

  async click(options: Options = {}): Promise<void> {
    const p = await this._center()
    await this._page.mouse.click(p.x, p.y, options)
  }

  async dblclick(options: Options = {}): Promise<void> {
    const p = await this._center()
    await this._page.mouse.dblclick(p.x, p.y, options)
  }

  async drag(dx: number, dy: number, options: { steps?: number } = {}): Promise<void> {
    const p = await this._center()
    await this._dragBetween(p, { x: p.x + Number(dx || 0), y: p.y + Number(dy || 0) }, options.steps)
  }

  async dragTo(target: unknown, options: { steps?: number } = {}): Promise<void> {
    const p = await this._center()
    await this._dragBetween(p, await centerOf(target), options.steps)
  }

  async wheel(dx: number, dy: number): Promise<void> {
    await this.hover()
    await this._page.mouse.wheel(Number(dx || 0), Number(dy || 0))
  }

  protected async _dragBetween(from: Point, to: Point, steps = 12): Promise<void> {
    const m = this._page.mouse
    await m.move(from.x, from.y)
    await m.down()
    await m.move(to.x, to.y, { steps: Math.max(1, Math.min(60, Math.round(steps))) })
    await m.up()
  }
}

type FieldQuery = { name: string; section?: string; part?: string; widget?: string; shown?: string }

function fieldName(q: FieldQuery): string {
  return `inspector field ${q.section ? `${q.section} > ` : ''}${q.shown ?? q.name}${q.part ? `.${q.part}` : ''}`
}

function findField(root: Element, q: FieldQuery): Options {
  const norm = (s: unknown): string => String(s ?? '').toLowerCase().replace(/^m_/, '').replace(/[^a-z0-9]/g, '')
  const sections = Array.from(root.querySelectorAll('[data-ti-section]'))
  const secs = q.section ? sections.filter((s) => norm(s.getAttribute('data-ti-section')) === norm(q.section)) : sections
  type Prop = { sec: Element; el: Element; path: string; label: string; name: string; parent: string | null; aux: boolean; uitk?: boolean }
  const props: Prop[] = []
  const UITK_FIELD = '[data-uitk-value][data-uitk-label], [data-uitk-value][data-uitk-path]'
  for (const sec of secs) {
    const best = new Map<string, Element>()
    const shown = new Map<string, string>()
    for (const el of Array.from(sec.querySelectorAll('[data-ti-prop]'))) {
      const path = el.getAttribute('data-ti-prop') || ''
      const was = best.get(path)
      if (!was || (!was.hasAttribute('data-ti-value') && el.hasAttribute('data-ti-value'))) best.set(path, el)
      const n = el.getAttribute('data-ti-name') || ''
      if (n && (!shown.has(path) || (shown.get(path) === el.getAttribute('data-ti-label') && n !== shown.get(path)))) shown.set(path, n)
    }
    for (const el of Array.from(sec.querySelectorAll('[data-ti-prop]'))) {
      const path = el.getAttribute('data-ti-prop') || ''
      if (best.get(path) !== el) continue
      const label = el.getAttribute('data-ti-label') || ''
      props.push({ sec, el, path, label, name: shown.get(path) || label, parent: el.getAttribute('data-ti-parent'), aux: el.hasAttribute('data-ti-aux') })
    }
    for (const el of Array.from(sec.querySelectorAll(UITK_FIELD))) {
      const outer = el.parentElement?.closest(UITK_FIELD)
      if (outer && sec.contains(outer)) continue
      const bp = el.getAttribute('data-uitk-path') ?? ''
      const tail = bp.split('.').filter((x) => x !== 'Array' && !/^data\[\d+\]$/.test(x)).pop() ?? ''
      const label = el.getAttribute('data-uitk-label') || tail.replace(/^m_/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())
      const path = bp || label
      if (!path || best.has(path)) continue
      props.push({ sec, el, path, label, name: label, parent: null, aux: false, uitk: true })
    }
  }
  const childrenOf = (a: Prop): Prop[] => props.filter((b) => b.sec === a.sec && b.parent === a.path)
  const uitkValue = (el: Element): unknown => {
    const type = el.getAttribute('data-uitk-type') ?? ''
    const raw = el.getAttribute('data-uitk-value') ?? ''
    const popup = el.querySelector('[data-uitk-type="PopupTextElement"], [data-uitk-type="TextElement"][data-uitk-text]')
    const label = el.getAttribute('data-uitk-label') ?? ''
    const shown = Array.from(el.querySelectorAll('[data-uitk-type="Label"][data-uitk-text]')).map((l) => l.getAttribute('data-uitk-text') ?? '').filter((t) => t && t !== label).pop()
    if (/Foldout/.test(type)) return undefined
    if (/Popup|Enum|Mask|Layer|Tag|Dropdown/.test(type) && popup) return popup.getAttribute('data-uitk-text') ?? raw
    if (/ObjectField/.test(type)) return el.hasAttribute('data-uitk-value') && raw ? raw : shown && !/^None \(/.test(shown) ? shown : null
    if (/ColorField/.test(type) && /^#[0-9a-f]{8}$/i.test(raw)) return raw.toUpperCase().replace(/^(#[0-9A-F]{6})FF$/, '$1')
    const n = raw.split(',').map(Number)
    if (raw && n.every(Number.isFinite)) {
      if (/^Vector[234](Int)?Field$/.test(type) && n.length >= 2 && n.length <= 4) return Object.fromEntries(n.map((v, i) => ['xyzw'[i], v]))
      if (/^Rect(Int)?Field$/.test(type) && n.length === 4) return { x: n[0], y: n[1], width: n[2], height: n[3] }
      if (/^BoundsField$/.test(type) && n.length === 6) return { center: { x: n[0], y: n[1], z: n[2] }, extent: { x: n[3], y: n[4], z: n[5] } }
      if (/^BoundsIntField$/.test(type) && n.length === 6) return { position: { x: n[0], y: n[1], z: n[2] }, size: { x: n[3], y: n[4], z: n[5] } }
    }
    if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true'
    if (/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(raw)) return Number(raw)
    return raw
  }
  const SHAPED = /^(Color|ObjectReference|Vector[234](Int)?|Quaternion|Rect(Int)?|Bounds(Int)?|AnimationCurve)$/
  const fromEngine = (engine: string | null): unknown => {
    if (engine === null || !/^[[{"]|^null$/.test(engine)) return undefined
    try {
      return JSON.parse(engine)
    } catch {
      return undefined
    }
  }
  const valueOf = (a: Prop): unknown => {
    if (a.uitk) return uitkValue(a.el)
    const kids = childrenOf(a)
    const engine = a.el.getAttribute('data-ti-v')
    const vector = kids.length > 0 && kids.every((b) => /^[xyzw]$/.test(b.path.slice(a.path.length + 1)))
    const pkind = a.el.getAttribute('data-ti-prop-kind') ?? ''
    if (!vector && (SHAPED.test(pkind) || (pkind === 'Generic' && engine?.startsWith('{')))) {
      const v = fromEngine(engine)
      if (v !== undefined) return v
    }
    if (vector) return Object.fromEntries([...kids].sort((p, q) => 'xyzw'.indexOf(p.path.slice(-1)) - 'xyzw'.indexOf(q.path.slice(-1))).map((b) => [b.path.slice(a.path.length + 1), valueOf(b)]))
    if (kids.length && (engine === null || kids.some((b) => !b.path.endsWith('.Array.size')))) return Object.fromEntries(kids.map((b) => [b.path.slice(a.path.length + 1), valueOf(b)]))
    const raw = a.el.getAttribute('data-ti-value')
    if (raw === null) {
      const v = fromEngine(engine)
      return v === undefined ? engine : v
    }
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  const find = (name: string): Prop | undefined => {
    const n = norm(name)
    return (
      props.find((a) => a.path === name || a.name === name || a.label === name) ??
      props.find((a) => a.name.endsWith(` ${name}`) || a.label.endsWith(` ${name}`)) ??
      props.find((a) => !!n && (norm(a.path) === n || norm(a.name) === n || norm(a.label) === n)) ??
      props.find((a) => n.length >= 3 && (norm(a.name).endsWith(n) || norm(a.label).endsWith(n) || norm(a.path).endsWith(n)))
    )
  }
  const describe = (a: Prop): string => {
    const kids = childrenOf(a).map((b) => b.path.slice(a.path.length + 1))
    return `${a.sec.getAttribute('data-ti-section')} > ${a.name || a.path}${kids.length ? ` (${kids.join(', ')})` : ''}`
  }
  const nearby = (name: string): string[] => {
    const n = norm(name)
    const words = String(name).toLowerCase().split(/[\s._]+/).filter((w) => w.length > 1)
    const top = props.filter((a) => a.parent === null && !a.aux)
    const scored = top
      .map((a) => {
        const l = norm(a.name)
        const p = norm(a.path)
        let s = 0
        if (n && (l.includes(n) || (l.length > 2 && n.includes(l)))) s += 3
        if (n && (p.includes(n) || (p.length > 2 && n.includes(p)))) s += 2
        for (const w of words) if (a.name.toLowerCase().includes(w) || a.path.toLowerCase().includes(w)) s += 1
        return { a, s }
      })
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
    const out: string[] = []
    for (const { a } of scored.length ? scored : top.map((a) => ({ a, s: 0 }))) {
      const text = describe(a)
      if (!out.includes(text)) out.push(text)
      if (out.length >= 6) break
    }
    return out
  }
  let hit = find(q.name)
  let part = q.part ? String(q.part) : ''
  if (!hit) {
    const m = /^(.*?)[\s.]+([^\s.]+)$/.exec(q.name)
    const base = m ? find(m[1]) : undefined
    if (m && base && childrenOf(base).length) {
      hit = base
      part = m[2]
    }
  }
  if (!hit) return { ok: false, near: nearby(q.name), sections: secs.map((s) => s.getAttribute('data-ti-section')) }
  const parts = childrenOf(hit)
  if (part) {
    const want = part.toLowerCase()
    const p = parts.find((b) => b.path.slice(hit!.path.length + 1).toLowerCase() === want || b.name.toLowerCase() === want || b.label.toLowerCase() === want)
    if (!p) return { ok: false, near: [describe(hit)], sections: [] }
    hit = p
  }
  const kinds = q.widget ? [q.widget] : ['field', 'toggle', 'popup', 'colorField', 'button']
  const uitkWidget = (a: Prop): Options => {
    const type = a.el.getAttribute('data-uitk-type') ?? ''
    const cls = (e: Element): string => e.getAttribute('data-uitk-class') ?? ''
    const kids = Array.from(a.el.querySelectorAll('[data-uitk-id]'))
    const box = (e: Element, kind: string, extra: Options = {}): Options => {
      const r = e.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height, kind, on: false, text: null, uitk: type, disabled: a.el.hasAttribute('data-uitk-disabled'), ...extra }
    }
    const pick = (re: RegExp): Element | undefined => {
      const all = kids.filter((e) => re.test(cls(e)))
      return all.filter((e) => e.getBoundingClientRect().width > 0).pop() ?? all.pop()
    }
    if (q.widget === 'label') {
      const lab = kids.find((e) => e.getAttribute('data-uitk-type') === 'Label' && /base-field__label/.test(cls(e)))
      return lab ? box(lab, 'label') : box(a.el, 'none')
    }
    if (q.widget) return box(a.el, 'none')
    if (/Toggle/.test(type)) {
      const mark = pick(/unity-toggle__checkmark/) ?? pick(/__input/) ?? a.el
      return box(mark, 'toggle', { on: uitkValue(a.el) === true })
    }
    if (/ObjectField/.test(type)) return box(kids.find((e) => e.getAttribute('data-uitk-type') === 'ObjectFieldSelector') ?? a.el, 'uitkObject')
    if (/ColorField/.test(type)) return box(pick(/__input/) ?? a.el, 'colorField')
    if (/Popup|Enum|Mask|Layer|Tag|Dropdown/.test(type)) return box(pick(/__input/) ?? a.el, 'popup')
    const text = pick(/text-field__input|unity-text-input|__input--single-line|__input--multiline/)
    if (text) return box(text, 'uitkText')
    return box(pick(/__input/) ?? a.el, 'uitkOther')
  }
  const widget = (a: Prop): Options => {
    if (a.uitk) return uitkWidget(a)
    const pr = a.el.getBoundingClientRect()
    const at = (a.el.getAttribute('data-ti-value-at') ?? '').split(' ').map(Number)
    const own = a.el.getAttribute('data-ti-value-widget')
    if (!q.widget && own && at.length === 4 && at.every(Number.isFinite)) {
      const w = parseFloat((a.el as HTMLElement).style.width)
      const s = w > 0 && pr.width > 0 ? pr.width / w : 1
      const v = valueOf(a)
      const extra: Options = { off: a.el.hasAttribute('data-ti-off') }
      const oat = (a.el.getAttribute('data-ti-override-at') ?? '').split(' ').map(Number)
      if (a.el.hasAttribute('data-ti-override') && oat.length === 4 && oat.every(Number.isFinite)) {
        extra.override = a.el.getAttribute('data-ti-override') === 'true'
        extra.overrideAt = { x: pr.x + (oat[0] + oat[2] / 2) * s, y: pr.y + (oat[1] + oat[3] / 2) * s }
      }
      const cut = a.path.indexOf('/')
      if (cut > 0 && a.el.hasAttribute('data-ti-island-prop')) {
        const owner = a.path.slice(0, cut)
        const head = Array.from(a.sec.querySelectorAll('[data-ti-prop]')).find((e) => e.getAttribute('data-ti-prop') === `${owner}/active`)
        if (head && head !== a.el) {
          extra.owner = owner
          extra.ownerOn = head.getAttribute('data-ti-value') === 'true'
        }
      }
      return { x: pr.x + at[0] * s, y: pr.y + at[1] * s, width: at[2] * s, height: at[3] * s, kind: own, on: v === true, text: typeof v === 'string' ? v : null, ...extra }
    }
    for (const k of kinds) {
      const e = Array.from(a.sec.querySelectorAll(`[data-ti-widget="${k}"]`)).find((w) => {
        const r = w.getBoundingClientRect()
        const cy = r.top + r.height / 2
        return cy >= pr.top && cy <= pr.bottom && r.right > pr.left && r.left < pr.right
      })
      if (e) {
        const r = e.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height, kind: k, on: e.getAttribute('data-ti-on') === 'true', text: e.getAttribute('data-ti-text') }
      }
    }
    return { x: pr.x, y: pr.y, width: pr.width, height: pr.height, kind: 'prop', on: false, text: null }
  }
  const compound = !part && parts.length > 0 && q.widget !== 'label'
  const pr = hit.el.getBoundingClientRect()
  const own = compound ? { x: pr.x, y: pr.y, width: pr.width, height: pr.height, kind: 'compound', on: false, text: null } : widget(hit)
  const sub = compound ? parts.map((b) => ({ key: b.path.slice(hit!.path.length + 1), ...widget(b), value: valueOf(b) })) : []
  const anchor = hit.uitk ? (hit.el.getAttribute('data-uitk-path') ? `[data-uitk-path="${hit.path.replace(/"/g, '\\"')}"]` : `[data-uitk-label="${hit.label.replace(/"/g, '\\"')}"]`) : `[data-ti-prop="${hit.path.replace(/"/g, '\\"')}"]`
  const value = valueOf(hit)
  const vectorPart = !hit.uitk && hit.parent !== null && /^[xyzw]$/.test(hit.path.slice(hit.parent.length + 1))
  return { ok: true, ...own, value, valueJson: value && typeof value === 'object' ? JSON.stringify(value) : undefined, path: hit.path, label: hit.name, section: hit.sec.getAttribute('data-ti-section'), type: hit.el.getAttribute('data-ti-prop-kind'), parts: sub, anchor, vectorPart }
}

const fieldRpcs = new WeakMap<object, TunerRpc>()

class CustomControl extends Error {}

const CURVE_KINDS = /^(AnimationCurve|Curve)$/
const ENGINE_KINDS = /^(AnimationCurve|Curve|Vector[234](Int)?|Quaternion|Color|Rect|Bounds)$/

function isRgba(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && ['r', 'g', 'b'].every((k) => k in (v as Options))
}

function numbersOf(name: string, kind: string, value: unknown, keys: string[], current: unknown): number[] {
  const cur = current && typeof current === 'object' ? (current as Options) : {}
  let list: unknown[] | null = null
  if (Array.isArray(value)) list = value
  else if (typeof value === 'string' && /^\s*\(?[-\d.eE+,\s]+\)?\s*$/.test(value)) list = value.replace(/[()\s]/g, '').split(',')
  else if (value && typeof value === 'object') {
    const v = value as Options
    const alias: Record<string, string> = { r: 'x', g: 'y', b: 'z', a: 'w', offset: 'w' }
    const pick = (k: string): unknown => {
      if (k in v) return v[k]
      const a = Object.keys(alias).find((x) => alias[x] === k && x in v)
      return a !== undefined ? v[a] : cur[k]
    }
    list = keys.map(pick)
  }
  const out = (list ?? []).map((x) => Number(x))
  if (!list || out.length !== keys.length || out.some((x) => !Number.isFinite(x))) {
    const shape = `{ ${keys.map((k) => `${k}: 1`).join(', ')} }`
    throw new TypeError(`${name} is a ${kind}: pass ${shape} or [${keys.map(() => '1').join(', ')}]`)
  }
  return out
}

const NUMBER_FIELD = /^(Float|Integer|ArraySize)$|^(Float|Double|Integer|Long|Unsigned\w*)Field$|^Slider(Int)?$/

function numberish(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v !== 'string') return false
  const t = v.trim()
  return /^-?Infinity$/.test(t) || (/\d/.test(t) && /^[-+*/%().\d\seE]+$/.test(t))
}

function plainNumber(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
}

function plainObject(v: unknown): v is Options {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function engineRaw(name: string, kind: string, value: unknown, current: unknown): string {
  if (kind === 'Generic') {
    if (!plainObject(current)) throw new Error(`${name} is a list or a custom control the Tuner can't set as a whole. Set its size with '${name}.Array.size' and its elements one by one.`)
    if (!plainObject(value)) throw new TypeError(`${name} is a group of fields: pass an object with the ones to change, like set({ ${Object.keys(current)[0] ?? 'name'}: ... }). Its fields are ${Object.keys(current).join(', ')}.`)
    return JSON.stringify(value)
  }
  if (CURVE_KINDS.test(kind)) {
    const keys = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as Options).keys) ? ((value as Options).keys as unknown[]) : null
    const how = `${name} is a curve: pass its keys, like set([{ time: 0, value: 0 }, { time: 1, value: 1 }]). inTangent and outTangent are optional; without them the curve is smoothed.`
    if (!keys) throw new TypeError(how)
    const times = new Set<number>()
    return keys
      .map((k) => {
        const o = Array.isArray(k) ? { time: k[0], value: k[1], inTangent: k[2], outTangent: k[3] } : k && typeof k === 'object' ? (k as Options) : null
        if (!o) throw new TypeError(how)
        const t = Number(o.time)
        const v = Number(o.value)
        if (!Number.isFinite(t) || !Number.isFinite(v)) throw new TypeError(how)
        if (times.has(t)) throw new TypeError(`${name}: two keys share time ${t}. Each key needs its own time.`)
        times.add(t)
        const has = (x: unknown): boolean => x !== undefined && x !== null
        if (!has(o.inTangent) && !has(o.outTangent)) return `${t}:${v}:auto:auto`
        const a = Number(has(o.inTangent) ? o.inTangent : o.outTangent)
        const b = Number(has(o.outTangent) ? o.outTangent : o.inTangent)
        if (Number.isNaN(a) || Number.isNaN(b)) throw new TypeError(how)
        return `${t}:${v}:${a}:${b}`
      })
      .join(';')
  }
  if (kind === 'Color') {
    if (typeof value === 'string') {
      const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim())
      if (!m) throw new TypeError(`${name} is a color: pass '#FF8800', '#FF880080' or { r, g, b, a } (0 to 1, above 1 for HDR)`)
      const n = (i: number): number => parseInt((m[1] + (m[2] ?? 'FF')).slice(i, i + 2), 16) / 255
      return [n(0), n(2), n(4), n(6)].join(',')
    }
    const c = value && typeof value === 'object' && !Array.isArray(value) ? { a: 1, ...(value as Options) } : value
    return numbersOf(name, 'color', c, ['r', 'g', 'b', 'a'], {}).join(',')
  }
  if (/^(Float|Integer)$/.test(kind)) {
    const n = typeof value === 'string' && value.trim() ? Number(value) : value
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new TypeError(`${name} is a number: pass one, like set(0.5)`)
    return String(n)
  }
  if (kind === 'Rect') return numbersOf(name, 'rect', value, ['x', 'y', 'width', 'height'], current).join(',')
  if (kind === 'Bounds') {
    const v = value && typeof value === 'object' ? (value as Options) : {}
    const c = (current && typeof current === 'object' ? current : {}) as Options
    return [...numbersOf(`${name}.center`, 'vector', v.center ?? c.center, ['x', 'y', 'z'], c.center), ...numbersOf(`${name}.extent`, 'vector', v.extent ?? c.extent, ['x', 'y', 'z'], c.extent)].join(',')
  }
  if (kind === 'Quaternion') return numbersOf(name, 'rotation in degrees', value, ['x', 'y', 'z'], current).join(',')
  const m = /^Vector([234])/.exec(kind)
  if (m) return numbersOf(name, 'vector', value, ['x', 'y', 'z', 'w'].slice(0, Number(m[1])), current).join(',')
  throw new Error(`${name} is a ${kind} the Tuner can't set this way.`)
}

function engineValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true'
  if (/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(raw)) return Number(raw)
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export class Field extends Spot {
  constructor(
    page: PageLike,
    private readonly _q: FieldQuery
  ) {
    super(page, () => this._resolve(), fieldName(_q), () => inspector(page), () => this._why())
  }

  get x(): Field {
    return this.part('x')
  }

  get y(): Field {
    return this.part('y')
  }

  get z(): Field {
    return this.part('z')
  }

  get w(): Field {
    return this.part('w')
  }

  part(name: string): Field {
    return new Field(this._page, { ...this._q, part: String(name) })
  }

  get _part(): 'value' | 'label' | null {
    return this._q.widget === 'label' ? 'label' : this._q.widget ? null : 'value'
  }

  private async _lookup(): Promise<Options | null> {
    const root = inspector(this._page)
    if (!(await root.count())) return null
    return (await root.evaluate(findField, { ...this._q })) as Options
  }

  private async _resolve(): Promise<Found | null> {
    const r = await this._lookup()
    if (!r?.ok) return null
    const prop = inspector(this._page).locator(`[data-ti-section=${q(String(r.section))}] ${typeof r.anchor === 'string' ? r.anchor : `[data-ti-prop=${q(String(r.path))}]`}`).first()
    if (await prop.count()) {
      await prop.scrollIntoViewIfNeeded()
      this._sel = prop._selector
      const again = await this._lookup()
      if (again?.ok) return again as Found
    }
    return r as Found
  }

  private async _why(): Promise<string> {
    const r = await this._lookup()
    const trouble = r?.ok ? '' : await troubleOf(this._page)
    if (!r || trouble) return trouble || NO_TUNER
    const near = (r.near as string[] | undefined) ?? []
    const sel = await selectedPath(this._page).catch(() => '')
    const where = this._q.section ? ` in ${this._q.section}${sel ? ` of ${sel}` : ''}` : sel ? ` on ${sel}` : ''
    if (this._q.section && Array.isArray(r.sections) && !r.sections.length) {
      const list = (await inspector(this._page).locator('[data-ti-section]').evaluateAll((els: Element[]) => [...new Set(els.map((e) => e.getAttribute('data-ti-section') ?? ''))]).catch(() => [])) as string[]
      const comps = list.filter((k) => k && k !== 'GameObject' && k !== 'AddComponent')
      return `${sel || 'The selected object'} has no ${this._q.section} component. It has: ${comps.join(', ') || 'none'}. Select another object with tuner.row(path).click().`
    }
    return `No inspector field "${this._q.name}${this._q.part ? `.${this._q.part}` : ''}"${where}.${near.length ? ` Closest: ${near.join('; ')}. A field inside a folded group or list shows once you expand it: tuner.field('Group').expand().` : ' The inspector shows no fields yet: select an object with tuner.row(path).click().'}`
  }

  async _need(): Promise<Found> {
    await tunerReady(this._page)
    await this._show()
    const until = Date.now() + WAIT_MS
    let settled = 0
    while (true) {
      const b = await this._find()
      if (b) return b
      const r = await this._lookup().catch(() => null)
      const shown = !!r && !r.ok && Array.isArray(r.sections) && r.sections.length > 0 && (await this._current())
      settled = shown ? settled || Date.now() : 0
      if (Date.now() > until || (settled && Date.now() - settled > FIELD_GRACE_MS)) throw new Error(await this._why())
      await this._page.waitForTimeout(100)
    }
  }

  private async _current(): Promise<boolean> {
    const target = String((await inspector(this._page).getAttribute('data-ti-target').catch(() => null)) ?? '')
    const tpath = target.includes('|') ? target.slice(target.indexOf('|') + 1) : target
    const sel = await selectedPath(this._page).catch(() => '')
    return !!tpath && !!sel && (tpath === sel || tpath.endsWith(`/${sel}`) || sel.endsWith(`/${tpath}`))
  }

  private async _engine(): Promise<Options | null> {
    const rpc = fieldRpcs.get(this._page)
    if (!rpc) return null
    const session = await inspector(this._page).getAttribute('data-ti-session').catch(() => null)
    if (!session) return null
    const name = this._q.part ? `${this._q.name}.${this._q.part}` : this._q.name
    const r = await rpc({ action: 'field', session, section: this._q.section ?? '', name }).catch(() => null)
    return r && typeof r === 'object' && typeof (r as Options).path === 'string' ? (r as Options) : null
  }

  private async _hidden(): Promise<boolean> {
    const r = await this._lookup().catch(() => null)
    return !!r && !r.ok && Array.isArray(r.sections) && r.sections.length > 0 && (await this._current())
  }

  private async _reach(): Promise<{ found: Found } | { hit: Options }> {
    if (await this._hidden()) {
      const hit = await this._engine()
      if (hit) return { hit }
    }
    try {
      return { found: await this._need() }
    } catch (e) {
      if (await this._openMaterial().catch(() => false)) {
        try {
          return { found: await this._need() }
        } catch {
        }
      }
      const hit = await this._engine()
      if (hit) return { hit }
      throw e
    }
  }

  private async _openMaterial(): Promise<boolean> {
    const name = this._q.section ?? ''
    if (!/^Material(#\d+)?$/.test(name)) return false
    const sec = inspector(this._page).locator(`[data-ti-section=${q(name)}][data-ti-kind="material"]`).first()
    if (!(await sec.count()) || (await sec.locator('[data-ti-prop]').count())) return false
    const m = /^(.*)#(\d+)$/.exec(name)
    await new Component(this._page, { name: m ? m[1] : name, index: m ? Number(m[2]) : undefined }).expand(true)
    const until = Date.now() + 3000
    while (Date.now() < until && !(await sec.locator('[data-ti-prop]').count())) await this._page.waitForTimeout(100)
    return true
  }

  private async _open(hit: Options): Promise<Field> {
    const section = String(hit.section ?? '')
    const path = String(hit.path)
    const there = new Field(this._page, { name: path, section, shown: this._q.shown ?? (this._q.part ? `${this._q.name}.${this._q.part}` : this._q.name) })
    const shows = async (): Promise<boolean> => !!(await there._lookup().catch(() => null))?.ok
    if (hit.expanded === false) {
      const m = /^(.*)#(\d+)$/.exec(section)
      await new Component(this._page, { name: m ? m[1] : section, index: m ? Number(m[2]) : undefined })._reveal()
    }
    const cut = path.indexOf('/')
    if (cut > 0 && !(await shows())) await new Field(this._page, { name: `${path.slice(0, cut)}/active`, section }).expand(true).catch(() => null)
    for (const parent of String(hit.parents ?? '').split('|').filter(Boolean)) {
      if (await shows()) break
      await new Field(this._page, { name: parent, section }).expand(true).catch(() => null)
    }
    if (cut <= 0 && !(await shows())) {
      const sel = `[data-ti-section=${q(section)}] [data-ti-widget="foldout"][data-ti-on="false"]`
      const n = Math.min(8, await inspector(this._page).locator(sel).count())
      for (let i = 0; i < n && !(await shows()); i++) {
        const fold = inspector(this._page).locator(sel).first()
        const box = (await fold.boundingBox().catch(() => null)) as Box | null
        if (!box) break
        await this._page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await this._page.waitForTimeout(350)
        if (await shows()) break
        await this._page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await this._page.waitForTimeout(250)
      }
    }
    if (!(await shows())) throw new CustomControl(`${this._name} (${String(hit.label)} in ${section}) is drawn as a custom control the Tuner can't open, such as a hidden group. Its value is ${JSON.stringify(engineValue(hit.value))}. Change it from a script with unity.exec.`)
    return there
  }

  private async _engineAt(b: Options): Promise<Options | null> {
    return new Field(this._page, { name: String(b.path), section: String(b.section ?? '') })._engine()
  }

  private async _engineSet(hit: Options, value: unknown): Promise<void> {
    const rpc = fieldRpcs.get(this._page)
    const session = await inspector(this._page).getAttribute('data-ti-session').catch(() => null)
    if (!rpc || !session) throw new Error(`${this._name} can't be set: the Tuner inspector isn't connected to Unity.`)
    const raw = engineRaw(this._name, String(hit.kind ?? ''), value, engineValue(hit.value))
    try {
      await rpc({ action: 'setField', session, section: String(hit.section ?? ''), name: String(hit.path), value: raw })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const label = String(hit.label ?? '')
      if (hit.kind === 'Generic' && label && (msg.startsWith(`${label} `) || msg.startsWith(`${label}.`))) throw new Error(`${this._name}${msg.slice(label.length)}`)
      throw new Error(`${this._name} wasn't set: ${msg}`)
    }
    await this._page.waitForTimeout(150)
  }

  private async _undoGroup(step: 'mark' | 'collapse', group?: number): Promise<number | null> {
    const rpc = fieldRpcs.get(this._page)
    const session = await inspector(this._page).getAttribute('data-ti-session').catch(() => null)
    if (!rpc || !session) return null
    const r = await rpc({ action: 'undoGroup', session, step, group: group === undefined ? '' : String(group) }).catch(() => null)
    return typeof r === 'number' ? r : null
  }

  private async _settle(old: unknown, want: unknown): Promise<void> {
    if (String(old) === String(want)) return
    const until = Date.now() + 1500
    while (Date.now() < until) {
      const r = await this._lookup().catch(() => null)
      if (r?.ok && String(r.value) !== String(old)) return
      await this._page.waitForTimeout(80)
    }
  }

  async _reveal(): Promise<Field> {
    const r = await this._reach()
    return 'hit' in r ? this._open(r.hit) : this
  }

  async value(): Promise<FieldValue> {
    const r = await this._reach()
    if ('hit' in r) return engineValue(r.hit.value) as FieldValue
    const b = r.found
    if (b.value === undefined || b.value === null || CURVE_KINDS.test(String(b.type ?? '')) || /CurveField/.test(String(b.uitk ?? ''))) {
      const hit = await this._engineAt(b)
      if (hit) return engineValue(hit.value) as FieldValue
    }
    return (typeof b.valueJson === 'string' ? JSON.parse(b.valueJson) : (b.value ?? null)) as FieldValue
  }

  async set(value: unknown): Promise<void> {
    const r = await this._reach()
    if ('hit' in r && r.hit.kind === 'Generic') return this._engineSet(r.hit, value)
    if ('found' in r && (r.found.type === 'Generic' || /Foldout/.test(String(r.found.uitk ?? '')))) {
      const hit = await this._engineAt(r.found)
      if (hit?.kind === 'Generic' && plainObject(engineValue(hit.value))) return this._engineSet(hit, value)
    }
    if ('hit' in r) {
      if (CURVE_KINDS.test(String(r.hit.kind ?? '')) || (r.hit.kind === 'Color' && isRgba(value))) return this._engineSet(r.hit, value)
      let there: Field
      try {
        there = await this._open(r.hit)
      } catch (e) {
        if (e instanceof CustomControl && ENGINE_KINDS.test(String(r.hit.kind ?? ''))) return this._engineSet(r.hit, value)
        throw e
      }
      return there.set(value)
    }
    const b = r.found
    const parts = b.parts as Options[]
    const type = String(b.type ?? '')
    const custom = CURVE_KINDS.test(type) || /CurveField|Foldout/.test(String(b.uitk ?? '')) || (/^(Vector[234](Int)?|Rect(Int)?|Bounds(Int)?)Field$/.test(String(b.uitk ?? '')) && !!value && typeof value === 'object') || ((b.kind === 'colorField' || type === 'Color') && isRgba(value)) || (!parts.length && b.kind === 'prop' && ENGINE_KINDS.test(type))
    if (custom) {
      const hit = await this._engineAt(b)
      if (hit && ENGINE_KINDS.test(String(hit.kind ?? ''))) return this._engineSet(hit, value)
    }
    if (parts.length) {
      const entries = Array.isArray(value)
        ? value.slice(0, parts.length).map((v, i) => [String(parts[i].key), v] as const)
        : value && typeof value === 'object'
          ? Object.entries(value as Options)
          : null
      if (!entries) throw new TypeError(`${this._name} has parts ${parts.map((p) => p.key).join(', ')}: pass { ${parts.map((p) => `${p.key}: ...`).join(', ')} }, an array, or set one part like field.${parts[0].key}.set(v)`)
      for (const [k, v] of entries) if (v !== undefined) await this.part(k).set(v)
      return
    }
    const page = this._page
    const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    if (b.uitk) {
      if (b.disabled) throw new Error(`${this._name} is greyed out right now, so it can't be set. Read it with value().`)
      if (b.kind === 'uitkText') {
        if (NUMBER_FIELD.test(String(b.uitk)) && !numberish(value)) throw new TypeError(`${this._name} is a number: pass one, like set(0.5)`)
        await page.mouse.click(at.x, at.y)
        const box = page.locator('[data-uitk-edit]').first()
        try {
          await box.waitFor({ state: 'visible', timeout: 5000 })
        } catch {
          throw new Error(`${this._name} didn't open for typing. It may be read-only right now. Read it with value().`)
        }
        await box.fill(String(value))
        await box.press((await box.evaluate((el: Element) => el.tagName === 'TEXTAREA')) ? 'Control+Enter' : 'Enter')
        await this._settle(b.value, value)
        return
      }
      if (b.kind === 'uitkObject') {
        await page.mouse.click(at.x, at.y)
        await pickObject(page, this._name, value)
        return
      }
      if (b.kind === 'uitkOther') throw new Error(`${this._name} is a ${String(b.uitk)} the Tuner can't type into. Drag it with drag(dx, 0), or read it with value().`)
    }
    if (b.override === false && b.overrideAt && b.ownerOn !== false) {
      const o = b.overrideAt as Point
      const group = await this._undoGroup('mark')
      await page.mouse.click(o.x, o.y)
      const until = Date.now() + 3000
      let now = b
      while (Date.now() < until) {
        await page.waitForTimeout(100)
        const r = await this._lookup()
        if (r?.ok && r.override === true && !r.off) {
          now = r as Found
          break
        }
      }
      if (now !== b) {
        try {
          return await this.set(value)
        } finally {
          if (group !== null) await this._undoGroup('collapse', group)
        }
      }
    }
    if (b.off) {
      if (b.owner && b.ownerOn === false) throw new Error(`${this._name} is greyed out because the ${String(b.owner)} override is switched off. Turn it on first with tuner.field('${String(b.owner)}').set(true).`)
      throw new Error(`${this._name} is greyed out in the inspector right now, so it can't be set. A checkbox next to it or the component's own toggle may be off.`)
    }
    if (b.type === 'ObjectReference' || b.type === 'ExposedReference') {
      await new Field(page, { ...this._q, widget: 'objectPicker' }).click()
      await pickObject(page, this._name, value)
      return
    }
    if (b.kind === 'colorField' || b.type === 'Color') {
      colorHex(this._name, value)
      await page.mouse.click(at.x, at.y)
      await pickColor(page, this._name, value)
      return
    }
    if (b.kind === 'toggle') {
      if (typeof value !== 'boolean') throw new TypeError(`${this._name} is a toggle: pass true or false`)
      if (value !== !!b.on) {
        await page.mouse.click(b.x + Math.min(8, b.width / 2), at.y)
        await this._settle(b.value, value)
      }
      return
    }
    if (b.kind === 'popup') {
      await page.mouse.click(at.x, at.y)
      await pickMenu(page, Array.isArray(value) ? value.map(String) : String(value))
      if (!Array.isArray(value)) await this._settle(b.value, value)
      return
    }
    if (b.kind === 'field' || b.kind === 'prop') {
      if (NUMBER_FIELD.test(String(b.type ?? '')) && !numberish(value)) throw new TypeError(`${this._name} is a number: pass one, like set(0.5)`)
      if (b.kind === 'prop' && (b.parts as Options[]).length === 0 && b.type === 'Generic') throw new Error(`${this._name} is a list or a group the Tuner can't type into. Set a list's size with '${String(b.label || b.path)}.Array.size', or expand() it and set its fields one by one.`)
      const direct = /^(Float|Integer)$/.test(String(b.type ?? '')) && plainNumber(value) && !b.off && b.section && fieldRpcs.has(page)
      if (direct && b.vectorPart) {
        await this._engineSet({ section: b.section, path: b.path, kind: b.type, label: b.label, value: b.value }, value)
        await this._settle(b.value, value)
        return
      }
      await page.mouse.click(at.x, at.y)
      const overlay = page.locator('[data-ti-text-overlay]').first()
      try {
        await overlay.waitFor({ state: 'visible', timeout: 5000 })
      } catch {
        throw new Error(`${this._name} didn't open for typing${b.type ? ` (it's a ${String(b.type)} field)` : ''}. It may be read-only right now, for example in Play Mode or under a custom editor. Read it with value(), or right-click it with menu(item).`)
      }
      await overlay.fill(String(value))
      const multiline = await overlay.evaluate((el: Element) => el.tagName === 'TEXTAREA')
      await overlay.press(multiline ? 'Control+Enter' : 'Enter')
      await this._settle(b.value, value)
      if (direct && Number((await this._lookup().catch(() => null))?.value) !== Number(value)) {
        await this._engineSet({ section: b.section, path: b.path, kind: b.type, label: b.label, value: b.value }, value)
        await this._settle(b.value, value)
      }
      return
    }
    throw new Error(`${this._name} is a ${String(b.kind)}: use click() on it`)
  }

  async menu(item: string): Promise<void> {
    const label = this._q.widget ? null : await new Field(this._page, { ...this._q, widget: 'label' })._need().catch(() => null)
    const at = label && label.kind === 'label' && label.width > 0 ? { x: label.x + Math.min(label.width / 2, 40), y: label.y + label.height / 2 } : await this._center()
    await this._page.mouse.click(at.x, at.y, { button: 'right' })
    await pickMenu(this._page, item)
  }

  async expand(open = true): Promise<void> {
    const fold = new Field(this._page, { ...this._q, widget: 'foldout' })
    const b = await fold._need()
    if (b.kind !== 'foldout') throw new Error(`${this._name} has no foldout arrow`)
    const before = await this._kids()
    if (open === (before > 0 || (!before && b.on === true))) return
    await this._page.mouse.click(b.x + Math.min(8, b.width / 2), b.y + b.height / 2)
    const until = Date.now() + WAIT_MS
    while (Date.now() < until) {
      const kids = await this._kids()
      if (open === kids > 0) break
      if (!before && !kids) {
        const now = await fold._lookup().catch(() => null)
        if (now?.ok && now.kind === 'foldout' && (now.on === true) === open) break
      }
      await this._page.waitForTimeout(100)
    }
  }

  private async _kids(): Promise<number> {
    const r = await this._lookup()
    return r?.ok ? ((r.parts as Options[] | undefined)?.length ?? 0) : 0
  }

  async scrub(dx: number, options: { steps?: number } = {}): Promise<void> {
    const label = new Field(this._page, { ...this._q, widget: 'label' })
    await label.drag(dx, 0, options)
  }
}

async function closePopup(popup: Locator): Promise<void> {
  await popup.press('Escape').catch(() => null)
}

const MASK_ITEM = '[data-ti-widget="toggle"][data-ti-style="MenuItem"]'

async function pickMask(page: PageLike, popup: Locator, want: string | string[]): Promise<void> {
  const items = (await popup.locator(MASK_ITEM).evaluateAll((els: Element[]) =>
    els.map((e) => ({ text: e.getAttribute('data-ti-text') ?? '', on: e.getAttribute('data-ti-on') === 'true' }))
  )) as { text: string; on: boolean }[]
  const names = Array.isArray(want) ? want : [want]
  const missing = names.filter((n) => !items.some((i) => i.text === n))
  if (missing.length) {
    await closePopup(popup)
    throw new Error(`The mask has no ${missing.map((m) => `"${m}"`).join(', ')}. It has: ${items.map((i) => i.text).join(', ')}.`)
  }
  const click = async (name: string): Promise<void> => {
    const b = (await popup.locator(`${MASK_ITEM}[data-ti-text=${q(name)}]`).first().boundingBox()) as Box | null
    if (!b) throw new Error(`"${name}" isn't on screen in the mask menu`)
    await page.mouse.click(b.x + Math.min(10, b.width / 2), b.y + b.height / 2)
    await page.waitForTimeout(250)
  }
  if (Array.isArray(want)) {
    if (items.some((i) => i.text === 'Nothing')) await click('Nothing')
    for (const n of names) if (n !== 'Nothing') await click(n)
  } else await click(want)
  await closePopup(popup)
}

async function pickMenu(page: PageLike, wanted: string | string[]): Promise<void> {
  const label = Array.isArray(wanted) ? wanted.join(', ') : wanted
  const popup = page.locator(`[data-ti-menu], [data-tuner-popup="menu"], [data-tuner-popup="dropdown"], [data-tuner-popup="window"]:has(${MASK_ITEM}) >> visible=true`).last()
  try {
    await popup.waitFor({ state: 'visible', timeout: 10_000 })
  } catch {
    throw new Error(`No menu opened, so "${label}" wasn't picked. Check that the click landed on the right control.`)
  }
  if ((await popup.getAttribute('data-tuner-popup')) === 'window') return pickMask(page, popup, wanted)
  if (Array.isArray(wanted)) {
    await closePopup(popup)
    throw new TypeError(`This menu picks one item: pass a string, not a list`)
  }
  if ((await popup.getAttribute('data-tuner-popup')) === 'dropdown') return pickDropdown(page, label)
  const item = (surface: Locator, name: string): Locator => surface.locator(`[role="menuitem"][data-menu-label=${q(name)}]`).first()
  const path = (await item(popup, label).count()) ? [label] : label.split('/').map((x) => x.trim()).filter(Boolean)
  let surface = popup
  for (let i = 0; i < path.length; i++) {
    let it = item(surface, path[i])
    const where = i ? ` under "${path.slice(0, i).join('/')}"` : ''
    if (!(await it.count())) {
      const labels = (await surface.locator('[role="menuitem"]').evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('data-menu-label') ?? ''))) as string[]
      const near = labels.filter((l) => l.startsWith(`${path[i]} `))
      if (near.length === 1) it = item(surface, near[0])
    }
    if (!(await it.count())) {
      const items = (await surface.locator('[role="menuitem"]').evaluateAll((els: Element[]) =>
        els.map((e) => `${e.getAttribute('data-menu-label') ?? ''}${e.getAttribute('aria-haspopup') ? '/...' : ''}${e.getAttribute('aria-disabled') ? ' (greyed out)' : ''}`)
      )) as string[]
      await closePopup(popup)
      throw new Error(`The menu has no "${path[i]}"${where}. It has: ${items.filter(Boolean).join(', ') || 'nothing'}. Name an item in a submenu as 'Submenu/Item'.`)
    }
    if (await it.getAttribute('aria-disabled')) {
      await closePopup(popup)
      throw new Error(`"${path.slice(0, i + 1).join('/')}" is greyed out in this menu, so Unity can't do it here.`)
    }
    const sub = !!(await it.getAttribute('aria-haspopup'))
    if (i === path.length - 1) {
      if (sub) {
        await it.click()
        const kids = page.locator('[data-tuner-popup="submenu"] >> visible=true').last()
        const names = (await kids.locator('[role="menuitem"]').evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('data-menu-label') ?? '')).catch(() => [])) as string[]
        await closePopup(popup)
        throw new Error(`"${label}" is a submenu. Pick one of its items, like '${label}/${names[0] ?? 'Item'}'. It has: ${names.filter(Boolean).join(', ')}.`)
      }
      await it.click()
      return
    }
    if (!sub) {
      await closePopup(popup)
      throw new Error(`"${path.slice(0, i + 1).join('/')}" is an item, not a submenu.`)
    }
    await it.click()
    surface = page.locator('[data-tuner-popup="submenu"] >> visible=true').last()
    await surface.waitFor({ state: 'visible', timeout: 5000 })
  }
}

async function pickDropdown(page: PageLike, label: string): Promise<void> {
  const picker = page.locator('[data-tuner-popup="dropdown"] >> visible=true').last().locator('[data-dropdown-picker]').first()
  const path = label.split('/').map((x) => x.trim()).filter(Boolean)
  const leaf = path[path.length - 1] ?? label
  const search = picker.locator('[data-dropdown-search]').first()
  const listed = async (): Promise<string[]> =>
    (await picker.locator('[data-dropdown-item]').evaluateAll((els: Element[]) => els.map((e) => `${e.getAttribute('data-dropdown-item') ?? ''}${e.hasAttribute('data-dropdown-group') ? '/...' : ''}`))) as string[]
  const leafItem = (name: string): Locator => picker.locator(`[data-dropdown-item=${q(name)}]:not([data-dropdown-group])`).first()
  if (await search.count()) {
    await search.fill(leaf)
    const until = Date.now() + 2000
    while (!(await leafItem(leaf).count()) && Date.now() < until) await page.waitForTimeout(100)
    const hit = leafItem(leaf)
    if (await hit.count()) {
      if (await hit.getAttribute('aria-disabled')) {
        await closePopup(picker)
        throw new Error(`"${leaf}" is greyed out in this list.`)
      }
      await hit.click()
      return
    }
    const near = await listed()
    await closePopup(picker)
    throw new Error(`Searching the list for "${leaf}" finds ${near.length ? near.slice(0, 12).join(', ') : 'nothing'}. Pass the exact name as the list shows it.`)
  }
  for (let i = 0; i < path.length; i++) {
    const last = i === path.length - 1
    const it = last ? leafItem(path[i]) : picker.locator(`[data-dropdown-item=${q(path[i])}][data-dropdown-group]`).first()
    if (!(await it.count())) {
      const near = await listed()
      await closePopup(picker)
      throw new Error(`The list has no "${path[i]}". It has: ${near.join(', ') || 'nothing'}. Name an item in a group as 'Group/Item'.`)
    }
    await it.click()
  }
}

const NONE_REFS = new Set(['', 'none', 'null'])

async function pickObject(page: PageLike, name: string, value: unknown): Promise<void> {
  const raw = value === null || value === undefined ? '' : String(value).trim()
  const popup = page.locator('[data-tuner-popup="object"] >> visible=true').last()
  try {
    await popup.waitFor({ state: 'visible', timeout: 10_000 })
  } catch {
    throw new Error(`${name}: the object picker didn't open. Is this an object field?`)
  }
  const picker = popup.locator('[data-object-picker]').first()
  const none = NONE_REFS.has(raw.toLowerCase())
  const asset = /^(Assets|Packages)\//.test(raw)
  const tab = picker.locator('[data-segmented="object-tab"] button')
  if (!none && (await tab.count())) {
    const want = tab.filter({ hasText: asset ? 'Assets' : 'Scene' }).first()
    if ((await want.count()) && (await want.getAttribute('data-active')) === null) await want.click()
  }
  const leaf = raw.slice(raw.lastIndexOf('/') + 1).replace(/\.[A-Za-z0-9]+$/, '')
  if (!none) await picker.locator('[data-object-search]').first().fill(leaf)
  const until = Date.now() + 10_000
  while (true) {
    const index = (await picker.locator('[data-object-list] [role="option"]').evaluateAll(
      (els: Element[], a: { raw: string; leaf: string; none: boolean }) => {
        const rows = els.map((e, i) => ({ i, name: e.getAttribute('data-object-name') ?? '', path: e.getAttribute('data-object-path') ?? '' }))
        if (a.none) return rows.length ? 0 : -1
        const low = (s: string): string => s.toLowerCase()
        const hit =
          rows.find((r) => r.path === a.raw) ??
          rows.find((r) => r.path && (low(r.path) === low(a.raw) || low(r.path).endsWith(`/${low(a.raw)}`))) ??
          rows.find((r) => r.i > 0 && low(r.name) === low(a.raw)) ??
          rows.find((r) => r.i > 0 && low(r.name) === low(a.leaf))
        return hit ? hit.i : -1
      },
      { raw, leaf, none }
    )) as number
    if (index >= 0) {
      await picker.locator('[data-object-list] [role="option"]').nth(index).dblclick()
      return
    }
    if (Date.now() > until) break
    await page.waitForTimeout(150)
  }
  const seen = (await picker.locator('[data-object-list] [role="option"]').evaluateAll((els: Element[]) =>
    els.slice(1, 13).map((e) => e.getAttribute('data-object-path') || e.getAttribute('data-object-name') || '')
  )) as string[]
  await closePopup(picker)
  throw new Error(`${name}: the picker has no "${raw}". Searching "${leaf}" finds ${seen.filter(Boolean).join(', ') || 'nothing'}. Pass a hierarchy path like 'Level/Crate', an asset path like 'Assets/Materials/Red.mat', or null for None.`)
}

function colorHex(name: string, value: unknown): string {
  const hex = typeof value === 'string' ? value.trim().replace(/^#?/, '#') : ''
  if (!/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) throw new TypeError(`${name} is a color: pass '#FF8800', '#FF880080' with alpha, or { r, g, b, a } from 0 to 1`)
  return hex
}

async function pickColor(page: PageLike, name: string, value: unknown): Promise<void> {
  const hex = colorHex(name, value)
  const picker = page.locator('[data-tuner-popup="color"] >> visible=true').last().locator('[data-color-picker]').first()
  try {
    await picker.waitFor({ state: 'visible', timeout: 10_000 })
  } catch {
    throw new Error(`${name}: the color picker didn't open.`)
  }
  const input = picker.locator('[data-color-hex]').first()
  await input.fill(hex.slice(1).toUpperCase())
  await input.press('Enter')
  await picker.press('Enter')
}

function findInspectorButton(root: Element, a: { text: string; section?: string }): Options {
  const norm = (s: unknown): string => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  const key = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9#]/g, '')
  const sections = Array.from(root.querySelectorAll('[data-ti-section]'))
  const names = sections.map((s) => s.getAttribute('data-ti-section') ?? '')
  let scope: Element[] = [root, ...Array.from(root.ownerDocument.querySelectorAll('[data-tuner-window]'))]
  if (a.section) {
    const exact = sections.filter((s) => key(s.getAttribute('data-ti-section')) === key(a.section))
    scope = exact.length ? exact.slice(0, 1) : sections.filter((s) => key((s.getAttribute('data-ti-section') ?? '').replace(/#\d+$/, '')) === key(a.section)).slice(0, 1)
    if (!scope.length) return { ok: false, buttons: [], sections: names }
  }
  const widgets = scope.flatMap((s) => Array.from(s.querySelectorAll('[data-ti-widget]')))
  const kinds = new Set(['button', 'miniButton', 'command', 'iconButton', 'popup', 'listFooterButton', 'plusButton', 'tab', 'dropdownArrow', 'paneOptions'])
  const isButton = (e: Element): boolean => kinds.has(e.getAttribute('data-ti-widget') ?? '')
  const text = (e: Element): string => norm(e.getAttribute('data-ti-text'))
  const want = norm(a.text)
  let el = widgets.find((e) => isButton(e) && text(e) === want)
  if (!el) {
    const label = widgets.find((e) => !isButton(e) && text(e) === want)
    if (label) {
      const lr = label.getBoundingClientRect()
      const cy = lr.top + lr.height / 2
      const cx = lr.left + lr.width / 2
      const row = widgets.filter((e) => {
        if (e === label || !isButton(e)) return false
        const r = e.getBoundingClientRect()
        return r.top <= cy && r.bottom >= cy
      })
      const dist = (e: Element): number => {
        const r = e.getBoundingClientRect()
        return Math.abs(r.left + r.width / 2 - cx)
      }
      el = row.sort((x, y) => dist(x) - dist(y))[0]
    }
  }
  if (!el && want.length >= 3) el = widgets.find((e) => isButton(e) && text(e).includes(want))
  if (!el) {
    const buttons = [...new Set(widgets.filter(isButton).map((e) => (e.getAttribute('data-ti-text') ?? '').trim()).filter(Boolean))]
    const labels = [...new Set(widgets.filter((e) => !isButton(e) && /label/i.test(e.getAttribute('data-ti-widget') ?? '')).map((e) => (e.getAttribute('data-ti-text') ?? '').trim()).filter(Boolean))]
    return { ok: false, buttons: buttons.slice(0, 20), labels: labels.slice(0, 20), sections: names }
  }
  ;(el as HTMLElement).scrollIntoView?.({ block: 'nearest' })
  const r = el.getBoundingClientRect()
  return { ok: true, x: r.x, y: r.y, width: r.width, height: r.height, kind: el.getAttribute('data-ti-widget'), on: el.getAttribute('data-ti-on') === 'true' }
}

function findComponent(root: Element, a: { name: string; index?: number; still?: boolean }): Options {
  const key = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9#]/g, '')
  const sections = Array.from(root.querySelectorAll('[data-ti-section]')).filter((s) => s.getAttribute('data-ti-kind') !== 'addComponent' && s.getAttribute('data-ti-section') !== 'AddComponent')
  const keys = sections.map((s) => s.getAttribute('data-ti-section') ?? '')
  const want = key(a.name)
  const same = keys.map((k, j) => ({ k, j })).filter((x) => key(x.k.replace(/#\d+$/, '')) === want)
  const nth = Math.max(0, Math.round(Number(a.index) || 0))
  const i = nth > 0 ? (same[nth]?.j ?? -1) : keys.findIndex((k) => key(k) === want) >= 0 ? keys.findIndex((k) => key(k) === want) : (same[0]?.j ?? -1)
  if (i < 0) return { ok: false, sections: keys }
  const sec = sections[i]
  const bar = sec.querySelector('[data-ti-widget="titlebar"]') ?? sec.querySelector('[data-ti-widget="bigTitle"]')
  if (!a.still) ((bar ?? sec) as HTMLElement).scrollIntoView?.({ block: 'nearest' })
  let scroller = sec.parentElement
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement
  if (scroller && !a.still) {
    const view = scroller.getBoundingClientRect()
    const top = (bar ?? sec).getBoundingClientRect().top
    if (top > view.top + view.height * 0.45) scroller.scrollTop += top - view.top - 4
  }
  const vr = scroller ? scroller.getBoundingClientRect() : null
  const room = scroller ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop : 0
  const r = (bar ?? sec).getBoundingClientRect()
  const box = { x: r.x, y: r.y, width: r.width, height: bar ? r.height : Math.min(r.height, 22) }
  const cy = box.y + box.height / 2
  const onBar = (e: Element): boolean => {
    const t = e.getBoundingClientRect()
    return t.top <= cy && t.bottom >= cy
  }
  const toggle = Array.from(sec.querySelectorAll('[data-ti-widget="toggle"]')).find(onBar)
  const folds = Array.from(sec.querySelectorAll('[data-ti-widget="titlebarFoldout"]'))
  const fold = folds.find(onBar) ?? (bar?.getAttribute('data-ti-widget') === 'bigTitle' ? folds.find((e) => e.getBoundingClientRect().top <= r.bottom + 4) : undefined)
  const at = (e: Element | undefined): Options | null => {
    if (!e) return null
    const t = e.getBoundingClientRect()
    return { x: t.x + t.width / 2, y: t.y + t.height / 2, on: e.getAttribute('data-ti-on') === 'true' }
  }
  const expanded = sec.getAttribute('data-ti-expanded')
  return { ok: true, key: keys[i], ...box, toggle: at(toggle), fold: at(fold), expanded: expanded === null ? null : expanded === 'true', view: vr ? { x: vr.x, y: vr.y, width: vr.width, height: vr.height, room } : null }
}

export class Component extends Spot {
  constructor(
    page: PageLike,
    private readonly _q: { name: string; index?: number }
  ) {
    super(page, () => this._resolve(), `component ${_q.name}${_q.index ? ` #${_q.index}` : ''}`, () => inspector(page), () => this._why())
  }

  private async _lookup(): Promise<Options | null> {
    const root = inspector(this._page)
    if (!(await root.count())) return null
    return (await root.evaluate(findComponent, { ...this._q })) as Options
  }

  private async _resolve(): Promise<Found | null> {
    const r = await this._lookup()
    if (!r?.ok) return null
    this._sel = inspector(this._page).locator(`[data-ti-section=${q(String(r.key))}]`).first()._selector
    return r as Found
  }

  private async _why(): Promise<string> {
    const r = await this._lookup()
    const trouble = r?.ok ? '' : await troubleOf(this._page)
    if (!r || trouble) return trouble || NO_TUNER
    const list = ((r.sections as string[] | undefined) ?? []).filter((k) => k !== 'GameObject' && k !== 'AddComponent')
    const sel = await selectedPath(this._page).catch(() => '')
    return `${sel || 'The selected object'} has no ${this._q.name} component. It has: ${list.join(', ') || 'none'}. Select another object with tuner.row(path).click().`
  }

  async menu(item: string): Promise<void> {
    const at = await this._center()
    await this._page.mouse.click(at.x, at.y, { button: 'right' })
    await pickMenu(this._page, item)
  }

  async remove(): Promise<void> {
    await this.menu('Remove Component')
  }

  async enabled(on?: boolean): Promise<boolean> {
    const b = await this._need()
    const t = b.toggle as Options | null
    if (!t) throw new Error(`${this._name} has no enable checkbox`)
    if (typeof on === 'boolean' && on !== t.on) {
      await this._page.mouse.click(Number(t.x), Number(t.y))
      const until = Date.now() + WAIT_MS
      while (Date.now() < until) {
        const now = (await this._lookup())?.toggle as Options | null
        if (now && now.on === on) return on
        await this._page.waitForTimeout(100)
      }
    }
    return !!(((await this._lookup())?.toggle as Options | null)?.on ?? t.on)
  }

  async expand(open = true): Promise<void> {
    const b = await this._need()
    const f = b.fold as Options | null
    if (!f || b.expanded === open) return
    await this._page.mouse.click(Number(f.x), Number(f.y))
  }

  private async _still(): Promise<Options | null> {
    const root = inspector(this._page)
    if (!(await root.count())) return null
    const r = (await root.evaluate(findComponent, { ...this._q, still: true })) as Options
    return r?.ok ? r : null
  }

  async _reveal(): Promise<boolean> {
    let r = await this._still()
    if (!r) {
      await this._need()
      return false
    }
    const head = inspector(this._page).locator(`[data-ti-section=${q(String(r.key))}] [data-ti-widget="titlebar"], [data-ti-section=${q(String(r.key))}] [data-ti-widget="bigTitle"]`).first()
    if (await head.count()) await head.scrollIntoViewIfNeeded()
    r = (await this._still()) ?? r
    let opened = false
    const f = r.fold as Options | null
    if (f && r.expanded === false) {
      await this._page.mouse.click(Number(f.x), Number(f.y))
      opened = true
      const until = Date.now() + WAIT_MS
      while (Date.now() < until) {
        await this._page.waitForTimeout(100)
        const now = await this._still()
        if (now && now.expanded !== false) {
          r = now
          break
        }
      }
      await this._page.waitForTimeout(250)
      r = (await this._still()) ?? r
    }
    const view = r.view as Options | null
    if (view) {
      const top = Number(r.y) - Number(view.y)
      const want = Math.min(top - 4, Number(view.room) || 0)
      if (top > Number(view.height) * 0.3 && want > 8) {
        await this._page.mouse.move(Number(view.x) + Number(view.width) / 2, Number(view.y) + Number(view.height) / 2)
        await this._page.mouse.wheel(0, Math.round(want))
        await this._page.waitForTimeout(200)
      }
    }
    return opened
  }
}

export class InspectorButton extends Spot {
  constructor(
    page: PageLike,
    private readonly _q: { text: string; section?: string }
  ) {
    super(page, () => this._resolve(), `inspector button ${_q.section ? `${_q.section} > ` : ''}${_q.text}`, () => inspector(page), () => this._why())
  }

  private async _lookup(): Promise<Options | null> {
    const root = inspector(this._page)
    if (!(await root.count())) return null
    return (await root.evaluate(findInspectorButton, { ...this._q })) as Options
  }

  private async _resolve(): Promise<Found | null> {
    const r = await this._lookup()
    return r?.ok ? (r as Found) : null
  }

  private async _why(): Promise<string> {
    const r = await this._lookup()
    const trouble = r?.ok ? '' : await troubleOf(this._page)
    if (!r || trouble) return trouble || NO_TUNER
    if (this._q.section && !((r.buttons as string[]).length || (r.labels as string[]).length)) return `The inspector has no ${this._q.section} section. It has: ${(r.sections as string[]).join(', ')}.`
    const buttons = (r.buttons as string[]) ?? []
    return `No inspector button "${this._q.text}"${this._q.section ? ` in ${this._q.section}` : ''}. Buttons: ${buttons.join(', ') || 'none with text'}.${(r.labels as string[])?.length ? ` Labels next to icon buttons can name them too: ${(r.labels as string[]).slice(0, 10).join(', ')}.` : ''}`
  }

  async pick(item: string): Promise<void> {
    const label = String(item ?? '').trim()
    if (!label) throw new TypeError(`${this._name}.pick() needs the item to pick, like 'Bloom' or 'Post-processing/Bloom'`)
    await this.click()
    await pickMenu(this._page, label)
  }
}

async function addComponent(page: PageLike, name: string): Promise<void> {
  const label = String(name ?? '').trim()
  if (!label) throw new TypeError("tuner.addComponent() needs a component name, like 'Box Collider'")
  await new InspectorButton(page, { text: 'Add Component', section: 'AddComponent' }).click()
  await pickMenu(page, label)
}

async function undoRedo(page: PageLike, redo: boolean): Promise<void> {
  await tunerReady(page)
  const canvas = inspector(page).locator('[data-ti-canvas]').first()
  const key = redo ? 'ControlOrMeta+Shift+z' : 'ControlOrMeta+z'
  if (await canvas.count()) {
    const seq = async (): Promise<string | null> => inspector(page).getAttribute('data-ti-seq').catch(() => null)
    const before = await seq()
    await canvas.press(key)
    const until = Date.now() + 1500
    while (before !== null && Date.now() < until && (await seq()) === before) await page.waitForTimeout(60)
    return
  }
  const list = hierarchy(page)
  if (!(await list.count())) throw new Error(`The Tuner "${chosen.get(page) ?? ''}" has no inspector or hierarchy to ${redo ? 'redo' : 'undo'} in.`)
  await list.press(key)
}

type RowAt = { key: string; uid: string | null; at: number; pending: boolean; top: number | null; scrollTop: number; max: number }

const ROW_SETTLE_MS = 4000
const ROW_ROUNDS = 4
const ROW_GONE_MS = 1000
const ROW_SURE_MS = 250

export class Row extends Spot {
  private _key = ''
  private _goneSince = 0
  private _sureSince = 0
  private _rowsSeen = ''
  private _unfiltered = false

  constructor(
    page: PageLike,
    readonly _path: string
  ) {
    super(page, () => this._resolve(), `hierarchy row ${_path}`, () => hierarchy(page), () => this._why())
  }

  private async _where(id: string): Promise<RowAt | null> {
    return (await hierarchy(this._page).evaluate((el: any, i: string) => el.__tunerRows?.where?.(i) ?? null, id).catch(() => null)) as RowAt | null
  }

  private async _settle(id: string, known = -1): Promise<RowAt | null> {
    const list = hierarchy(this._page)
    const until = Date.now() + ROW_SETTLE_MS
    let last = -1
    let calm = 0
    let opened = 0
    let w: RowAt | null = null
    while (true) {
      w = await this._where(id)
      if (!w) return null
      if (known >= 0 && w.at === known && !w.pending) return w
      known = -1
      if (w.at < 0) {
        calm = 0
        if (Date.now() - opened > 500) {
          opened = Date.now()
          await list.evaluate((el: any, k: string) => el.__tunerRows?.open?.(k), w.key)
        }
      } else if (w.pending || w.at !== last) {
        calm = 0
        last = w.at
      } else if (++calm >= 3) return w
      if (Date.now() > until) return w.at < 0 ? null : w
      await this._page.waitForTimeout(50)
    }
  }

  private async _onScreen(key: string): Promise<Box | null> {
    return (await hierarchy(this._page).evaluate((el: Element, k: string) => {
      const node = el.querySelector(`[data-row-key="${CSS.escape(k)}"]`)
      if (!node) return null
      const b = node.getBoundingClientRect()
      const l = el.getBoundingClientRect()
      if (b.top < l.top - 1 || b.bottom > l.bottom + 1) return null
      const hit = document.elementFromPoint(b.left + Math.min(60, b.width / 2), b.top + b.height / 2)
      if (!hit || !node.contains(hit)) return null
      return { x: b.x, y: b.y, width: b.width, height: b.height }
    }, key).catch(() => null)) as Box | null
  }

  private async _calm(): Promise<void> {
    const list = hierarchy(this._page)
    let last = Number.NaN
    for (let i = 0; i < 20; i++) {
      const top = (await list.evaluate((el: Element) => el.scrollTop).catch(() => Number.NaN)) as number
      if (top === last) return
      last = top
      await this._page.waitForTimeout(50)
    }
  }

  private async _bring(id: string): Promise<RowAt | null> {
    const list = hierarchy(this._page)
    let known = -1
    for (let round = 0; round < ROW_ROUNDS; round++) {
      const w = await this._settle(id, known)
      if (!w) return null
      known = w.at
      if (await this._onScreen(w.key)) return w
      const dy = (w.top ?? w.scrollTop) - w.scrollTop
      if (Math.abs(dy) < 1 || round === ROW_ROUNDS - 1) {
        await list.evaluate((el: any, k: string) => el.__tunerRows?.reveal?.(k), w.key)
        await this._calm()
        continue
      }
      const r = (await list.evaluate((el: Element) => {
        const b = el.getBoundingClientRect()
        return { x: b.left + b.width / 2, y: b.top + Math.min(b.height / 2, 60) }
      })) as Point
      await this._page.mouse.move(r.x, r.y)
      await this._page.mouse.wheel(0, dy)
      await this._calm()
    }
    return this._where(id)
  }

  private async _resolve(): Promise<Found | null> {
    const list = hierarchy(this._page)
    if (!(await list.count())) return null
    const hit = (await list.evaluate((el: any, want: string) => {
      const api = el.__tunerRows
      const row = api ? api.find(want) : null
      if (!row) {
        api?.load?.(want)
        return null
      }
      return { key: row.key as string, id: (row.uid ?? row.key) as string }
    }, this._path)) as { key: string; id: string } | null
    if (!hit) return this._unfilter()
    const w = await this._bring(hit.id)
    if (!w) return this._unfilter()
    const box = await this._onScreen(w.key)
    if (!box) return this._unfilter()
    this._key = w.key
    this._sel = list.locator(`[data-row-key=${q(w.key)}]`).first()._selector
    return box
  }

  private async _unfilter(): Promise<null> {
    if (this._unfiltered) return null
    this._unfiltered = true
    const search = paneOf(this._page).locator('[data-hierarchy-search]').first()
    if ((await search.count()) && (await search.inputValue().catch(() => ''))) await search.fill('')
    return null
  }

  async _gone(): Promise<boolean> {
    const [gone, rows, sure] = (await hierarchy(this._page)
      .evaluate((el: any, want: string) => {
        const api = el.__tunerRows
        const all = (api?.rows?.() ?? []) as { key: string }[]
        return [!!api?.missing?.(want), `${all.length}:${all[0]?.key ?? ''}:${all[all.length - 1]?.key ?? ''}`, !!api?.sure?.(want)]
      }, this._path)
      .catch(() => [false, '', false])) as [boolean, string, boolean]
    if (gone && sure) {
      if (!this._sureSince) this._sureSince = Date.now()
      if (Date.now() - this._sureSince >= ROW_SURE_MS) return true
    } else this._sureSince = 0
    if (!gone || rows !== this._rowsSeen) {
      this._goneSince = 0
      this._rowsSeen = rows
      if (!gone) return false
    }
    if (!this._goneSince) this._goneSince = Date.now()
    return Date.now() - this._goneSince >= ROW_GONE_MS
  }

  async _back(): Promise<boolean> {
    if (!(await this._there())) return false
    this._goneSince = 0
    return true
  }

  private async _there(): Promise<boolean> {
    return (await hierarchy(this._page)
      .evaluate((el: any, want: string) => !!el.__tunerRows?.find?.(want), this._path)
      .catch(() => false)) as boolean
  }

  async _aimBox(): Promise<Found> {
    const row = await this._need()
    const list = hierarchy(this._page)
    const label = (await list.evaluate((el: Element, k: string) => {
      const node = el.querySelector(`[data-row-key="${CSS.escape(k)}"] [data-row-label]`)
      const b = node?.getBoundingClientRect()
      return b && b.width > 0 ? { x: b.x, y: b.y, width: b.width, height: b.height } : null
    }, this._key).catch(() => null)) as Box | null
    if (!label) return row
    this._sel = list.locator(`[data-row-key=${q(this._key)}] [data-row-label]`).first()._selector
    return label
  }

  private async _why(): Promise<string> {
    const list = hierarchy(this._page)
    if (!(await list.count())) return (await paneOf(this._page).count()) ? `The Tuner "${chosen.get(this._page) ?? ''}" has no hierarchy.` : NO_TUNER
    if (await this._there()) return `The hierarchy row "${this._path}" is in the Tuner but didn't come on screen within ${WAIT_MS / 1000} s, so it couldn't be used. The hierarchy may still be reloading: call again.`
    const near = (await list.evaluate((el: any, want: string) => (el.__tunerRows ? el.__tunerRows.near(want) : []), this._path)) as string[]
    const tag = paneOf(this._page).locator('[data-tuner-filter]').first()
    const filter = (await tag.count()) ? await tag.getAttribute('data-tuner-filter').catch(() => null) : null
    const hint = filter ? ` The Tuner is filtered to "${filter}"; tuner.open({ scene: true }), or tuner.open({ prefab }) for a prefab Tuner, clears the filter.` : ''
    const top = near.length ? [] : ((await list.evaluate((el: any) => (el.__tunerRows?.list?.() ?? []).map((r: { path: string }) => r.path).filter((p: string) => !p.includes('/')))) as string[])
    const lead = near.length ? `Closest: ${near.join(', ')}.` : `Nothing in this Tuner is named like that.${top.length ? ` Its top-level objects: ${top.slice(0, 12).join(', ')}${top.length > 12 ? ` and ${top.length - 12} more` : ''}.` : ''}`
    return `No hierarchy row "${this._path}". ${lead} Pass the full path from the root, like "Level/Crate", or with the scene or prefab name in front, like "SaveModel/Level/Crate".${hint}`
  }
}

async function selectedPath(page: PageLike): Promise<string> {
  await tunerReady(page)
  const list = hierarchy(page)
  if (await list.count()) return (await list.getAttribute('data-selected-path')) ?? ''
  const root = inspector(page)
  if (!(await root.count())) return ''
  const t = (await root.getAttribute('data-ti-target')) ?? ''
  return t.includes('|') ? t.slice(t.indexOf('|') + 1) : t
}

async function canvasViewOf(page: PageLike, name?: unknown): Promise<{ showing: string; options: string[]; note?: string }> {
  await tunerReady(page)
  const bar = paneOf(page).locator('[data-tuner-canvas-selector]').first()
  if (!(await bar.count())) {
    if (name == null || name === '' || String(name).toLowerCase() === 'scene') return { showing: 'Scene', options: ['Scene'], note: 'this scene has no UI overlay canvases, so the view always shows the scene' }
    throw new Error(`tuner.canvasView(${JSON.stringify(name)}): this Tuner has no UI overlay canvases to show. Only the scene Tuner has a canvas view, and only when the scene has a Screen Space - Overlay canvas.`)
  }
  const read = async (): Promise<{ showing: string; options: string[] }> => {
    const sel = (await bar.getAttribute('data-tuner-canvas-selector')) ?? 'scene'
    let options: string[] = []
    try {
      options = JSON.parse((await bar.getAttribute('data-canvas-view-options')) ?? '[]') as string[]
    } catch {
      options = []
    }
    return { showing: sel === 'scene' ? 'Scene' : sel, options }
  }
  if (name == null) return read()
  const want = String(name).trim()
  const now = await read()
  const target = want === '' || want.toLowerCase() === 'scene' ? '' : now.options.find((p) => p === want) ?? now.options.find((p) => p !== 'Scene' && (p.split('/').pop() ?? '').toLowerCase() === want.toLowerCase())
  if (target === undefined) throw new Error(`tuner.canvasView(${JSON.stringify(want)}): no UI overlay canvas with that name. Pick one of: ${now.options.join(', ')}.`)
  if (!(await bar.locator('[data-canvas-view-menu]').count())) await bar.locator('[data-canvas-view-button]').first().click()
  await bar.locator(`[data-canvas-view-menu] [data-canvas-view-option=${q(target)}]`).first().click()
  for (let i = 0; i < 40; i++) {
    const r = await read()
    if (r.showing === (target || 'Scene')) return r
    await new Promise((res) => setTimeout(res, 50))
  }
  return read()
}

async function selectRows(page: PageLike, paths: unknown): Promise<string> {
  const list = (Array.isArray(paths) ? paths : [paths]).map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean)
  if (!list.length || list.length !== (Array.isArray(paths) ? paths.length : 1))
    throw new TypeError("tuner.select() takes hierarchy paths, like tuner.select(['Lights/Room Light', 'Lights/Room Light[2]']). Same-name siblings take an index: 'Room Light[2]' is the second one.")
  const keys = (page as PageLike & { keyboard?: { down(key: string): Promise<void>; up(key: string): Promise<void> } }).keyboard
  if (list.length > 1 && !keys) throw new Error('Selecting several objects needs the app window: tuner.select() only works from satura_exec.')
  await new Row(page, list[0]).click()
  for (const path of list.slice(1)) {
    const at = await new Row(page, path)._center()
    await keys!.down('ControlOrMeta')
    try {
      await page.mouse.click(at.x, at.y)
    } finally {
      await keys!.up('ControlOrMeta')
    }
  }
  const want = new Set(list).size
  const read = async (): Promise<{ count: number; paths: string[] | null }> => {
    const count = Number((await hierarchy(page).getAttribute('data-selected-count').catch(() => null)) ?? NaN)
    let paths: string[] | null = null
    try {
      paths = JSON.parse((await hierarchy(page).getAttribute('data-selected-paths').catch(() => null)) ?? 'null') as string[] | null
    } catch {
      paths = null
    }
    return { count, paths }
  }
  let now = await read()
  const until = Date.now() + WAIT_MS
  while (Number.isFinite(now.count) && now.count !== want && Date.now() < until) {
    await page.waitForTimeout(50)
    now = await read()
  }
  if (Number.isFinite(now.count) && now.count !== want)
    throw new Error(`Asked to select ${want} objects, but the Tuner has ${now.count} selected${now.paths?.length ? ` (${now.paths.join(', ')})` : ''}. Check the paths with tuner.row(path).`)
  const shown = now.paths?.length ? now.paths : [...new Set(list)]
  return `Selected ${shown.length} object${shown.length === 1 ? '' : 's'} in the Tuner: ${shown.join(', ')}.`
}

async function rowPath(page: PageLike, want: string): Promise<string> {
  const clean = want.replace(/^\/+/, '')
  const list = hierarchy(page)
  if (!(await list.count())) return clean
  const p = await list.evaluate((el: any, w: string) => (el.__tunerRows ? el.__tunerRows.find(w)?.path ?? null : null), clean)
  return typeof p === 'string' && p ? p : clean
}

export class Handle extends Spot {
  private _selected = false
  private _switched = false

  constructor(
    page: PageLike,
    readonly _object: string | null,
    private readonly _axis: number,
    private readonly _kind: string | null,
    tool: string | null
  ) {
    super(
      page,
      () => this._resolve(),
      `${tool ?? 'gizmo'} handle ${['x', 'y', 'z'][_axis] ?? _axis}${_object ? ` of ${_object}` : ''}`,
      () => viewport(page),
      () => this._why()
    )
  }

  private async _select(): Promise<void> {
    if (this._selected || !this._object) return
    this._selected = true
    const want = this._object.replace(/^\/+/, '')
    await tunerReady(this._page)
    const target = await rowPath(this._page, want)
    const done = (t: string): boolean => t === target
    if (done(await selectedPath(this._page))) return
    await new Row(this._page, want).click()
    const until = Date.now() + WAIT_MS
    while (Date.now() < until && !done(await selectedPath(this._page))) await this._page.waitForTimeout(100)
  }

  private async _parts(): Promise<{ kind: string; axis: number; x: number; y: number }[] | null> {
    const vp = viewport(this._page)
    if (!(await vp.count())) return null
    return (await vp.evaluate((el: any) => (el.__motion && typeof el.__motion.parts === 'function' ? el.__motion.parts() : []))) as {
      kind: string
      axis: number
      x: number
      y: number
    }[]
  }

  private async _resolve(): Promise<Found | null> {
    await this._select()
    const vp = viewport(this._page)
    if (!(await vp.count())) return null
    this._sel = vp._selector
    this._gizmo = { axis: this._axis, kind: this._kind }
    const hit = await this._point(vp)
    if ((hit && (!this._kind || hit.kind === this._kind)) || !this._kind || this._switched) return hit
    const parts = await this._parts()
    if (!parts?.length || parts.some((p) => p.kind === this._kind)) return null
    this._switched = true
    const tool = ({ axis: 'Move', plane: 'Move', ring: 'Rotate', scale: 'Scale' } as Record<string, string>)[this._kind]
    const button = paneOf(this._page).getByRole('button', { name: tool, exact: true }).first()
    if (!tool || !(await button.count())) return null
    await button.click()
    const until = Date.now() + WAIT_MS
    while (Date.now() < until && !(await this._parts())?.some((p) => p.kind === this._kind)) await this._page.waitForTimeout(50)
    return null
  }

  private async _point(vp: Locator): Promise<Found | null> {
    return (await vp.evaluate(
      (el: Element, a: { spec: { axis: number; kind: string | null }; ask: string; at: string; ev: string }) => {
        el.setAttribute(a.ask, JSON.stringify(a.spec))
        el.removeAttribute(a.at)
        el.dispatchEvent(new Event(a.ev))
        const raw = el.getAttribute(a.at)
        if (!raw) return null
        const p = JSON.parse(raw) as { x: number; y: number; kind: string }
        const r = el.getBoundingClientRect()
        return { x: r.x + p.x - 3, y: r.y + p.y - 3, width: 6, height: 6, kind: p.kind }
      },
      { spec: { axis: this._axis, kind: this._kind }, ask: GIZMO_ASK_ATTR, at: GIZMO_AT_ATTR, ev: GIZMO_EVENT }
    )) as Found | null
  }

  private async _why(): Promise<string> {
    const parts = await this._parts()
    if (!parts) return NO_TUNER
    if (!parts.length) return `No gizmo is showing${this._object ? ` for ${this._object}` : ''}. Select the object first with tuner.row(path).click().`
    const names = Object.fromEntries(Object.entries(TOOLS).map(([tool, kind]) => [kind, tool]))
    const showing = [...new Set(parts.map((p) => `${names[p.kind] ?? p.kind} ${['x', 'y', 'z'][p.axis] ?? 'all'}`))].join(', ')
    return `No ${this._kind ? `${names[this._kind]} ` : ''}handle on ${['x', 'y', 'z'][this._axis]}. Showing: ${showing}. The tool buttons are on the Tuner toolbar: Move, Rotate, Scale.`
  }
}

type Unsaved = { items: string[]; playing: boolean; notice: string; error: boolean }

export function unsavedState(pane: Element): Unsaved | null {
  const marker = pane.querySelector('[data-tuner-unsaved-items]')
  if (!marker) return null
  let items: string[] = []
  try {
    const raw = JSON.parse(marker.getAttribute('data-tuner-unsaved-items') ?? '[]')
    if (Array.isArray(raw)) items = raw.map(String)
  } catch {
    items = []
  }
  const notice = pane.querySelector('[data-tuner-notice]')
  return {
    items,
    playing: marker.getAttribute('data-tuner-playing') === 'true',
    notice: notice ? (notice.textContent ?? '').trim() : '',
    error: notice?.getAttribute('data-tuner-notice') === 'error'
  }
}

const FINISH_MS = 60_000
const SETTLE_MS = 1500

async function finishEdits(page: PageLike, rpc: TunerRpc, kind: 'save' | 'discard'): Promise<string[]> {
  await tunerReady(page)
  const pane = paneOf(page)
  const name = chosen.get(page) ?? ''
  let before = (await pane.evaluate(unsavedState)) as Unsaved | null
  for (let waited = 0; before && !before.playing && !before.items.length && waited < SETTLE_MS; waited += 150) {
    await page.waitForTimeout(150)
    before = (await pane.evaluate(unsavedState)) as Unsaved | null
  }
  if (!before) throw new Error(`The Tuner "${name}" has no Save or Discard button yet. It may still be connecting.`)
  if (before.playing) throw new Error(`The Tuner "${name}" is in Play Mode. Stop Play Mode first, then ${kind}.`)
  if (!before.items.length) return []
  if (kind === 'discard') await rpc({ action: 'front', what: 'Discard', why: 'its dialog covers the window' })
  await pane.locator(kind === 'save' ? '[data-tuner-save]' : '[data-tuner-discard]').first().click()
  if (kind === 'discard') await page.locator('[data-confirm-dialog]').getByRole('button', { name: 'Discard', exact: true }).click({ timeout: 10_000 })
  const until = Date.now() + FINISH_MS
  while (true) {
    const now = (await pane.evaluate(unsavedState)) as Unsaved | null
    if (now) {
      const fresh = !!now.notice && now.notice !== before.notice
      const changed = now.items.join('\n') !== before.items.join('\n')
      if (now.error && fresh) throw new Error(now.notice)
      if (fresh || changed) {
        if (kind === 'save') await rpc({ action: 'saved' }).catch(() => null)
        return before.items.filter((p) => !now.items.includes(p))
      }
    }
    if (Date.now() > until) throw new Error(`The Tuner "${name}" didn't finish the ${kind} in ${FINISH_MS / 1000}s.`)
    await page.waitForTimeout(150)
  }
}

function paneSpot(page: PageLike, pane: () => Locator, name: string, why?: () => Promise<string>): Spot {
  const spot: Spot = new Spot(
    page,
    async () => {
      const p = pane()
      if (!(await p.count())) return null
      spot._sel = p._selector
      return p.boundingBox()
    },
    name,
    pane,
    async () => ((await paneOf(page).count()) ? (why && (await why())) || `The Tuner "${chosen.get(page) ?? ''}" shows no ${name.replace(/^the Tuner /, '')}.` : NO_TUNER)
  )
  return spot
}

type CamState = { target: number[]; yaw: number; pitch: number; distance: number; ortho: number | null; view: string; animating: boolean; note?: string }
type CamReply = { ok: boolean; why?: string; note?: string; moved?: boolean; subject?: string; ms?: number; missing?: string[]; state?: CamState | null; box?: Box | null; inView?: boolean; invisible?: boolean }

const AIM_MS = 650
const SETTLE_MAX_MS = 2000

async function camCall(page: PageLike, cmd: Options): Promise<CamReply | null> {
  const vp = viewport(page)
  if (!(await vp.count())) return null
  return (await vp.evaluate((el: any, c: Options) => (el.__motion && typeof el.__motion.camera === 'function' ? el.__motion.camera(c) : null), cmd)) as CamReply | null
}

async function camSettle(page: PageLike, ms: number): Promise<void> {
  if (ms > 0) await page.waitForTimeout(ms + 30)
  const until = Date.now() + SETTLE_MAX_MS
  while (Date.now() < until) {
    const r = await camCall(page, { op: 'get' })
    if (!r?.state?.animating) return
    await page.waitForTimeout(50)
  }
}

function camList(what: unknown, name: string): string[] {
  const list = Array.isArray(what) ? what : [what]
  if (!list.length || list.some((x) => typeof x !== 'string' || !x.trim())) throw new TypeError(`${name} takes a hierarchy path like 'Level/Crate', an array of paths, null for the whole scene, or nothing for the selection`)
  return list.map((x) => String(x).trim().replace(/^\/+/, ''))
}

async function camPaths(page: PageLike, list: string[]): Promise<string[]> {
  return Promise.all(list.map((p) => rowPath(page, p)))
}

async function camRun(page: PageLike, cmd: Options): Promise<CamState | null> {
  await tunerReady(page)
  await showPane(page, viewport(page)).catch(() => null)
  const until = Date.now() + WAIT_MS
  let r = await camCall(page, cmd)
  while (r && !r.ok && /not showing/.test(r.why ?? '') && Date.now() < until) {
    await page.waitForTimeout(100)
    r = await camCall(page, cmd)
  }
  if (!r) throw new Error(`The Tuner "${chosen.get(page) ?? ''}" shows no viewport.`)
  if (!r.ok && r.missing?.length === 1 && cmd.op === 'frame' && Array.isArray(cmd.paths) && cmd.paths.length === 1) {
    const row = hierarchy(page).locator(`[data-row-path="${String(cmd.paths[0]).replace(/"/g, '\\"')}"]`).first()
    if (await row.count()) {
      await row.click()
      await page.waitForTimeout(150)
      r = await camCall(page, { ...cmd, paths: undefined })
    }
  }
  if (!r) throw new Error(`The Tuner "${chosen.get(page) ?? ''}" shows no viewport.`)
  if (!r.ok) {
    if (r.missing?.length) {
      const list = hierarchy(page)
      const near = (await list.count()) ? ((await list.evaluate((el: any, want: string) => (el.__tunerRows ? el.__tunerRows.near(want) : []), r.missing[0])) as string[]) : []
      throw new Error(`tuner.camera.frame(): the Tuner viewport has no object "${r.missing[0]}". Closest rows: ${near.join(', ') || 'none'}.`)
    }
    throw new Error(`tuner.camera.${String(cmd.op)}(): ${r.why ?? 'failed'}`)
  }
  await camSettle(page, r.ms ?? 0)
  const state = (await camCall(page, { op: 'get' }))?.state ?? null
  return r.note ? ({ ...(state ?? {}), note: r.note } as CamState) : state
}

function cameraApi(page: PageLike): Record<string, unknown> {
  const ms = (raw: unknown, name: string): number | undefined => {
    const o = checked(raw, name, ['ms'])
    return typeof o.ms === 'number' ? o.ms : undefined
  }
  return {
    async frame(what?: string | string[] | null, raw?: unknown): Promise<CamState | null> {
      const options = checked(raw, 'tuner.camera.frame()', ['pad', 'ms'])
      const paths = what === undefined ? undefined : what === null ? null : await (async () => {
        const list = camList(what, 'tuner.camera.frame()')
        await tunerReady(page)
        return camPaths(page, list)
      })()
      return camRun(page, { op: 'frame', paths, pad: typeof options.pad === 'number' ? options.pad : undefined, ms: typeof options.ms === 'number' ? options.ms : undefined })
    },
    view: async (name: string, options?: unknown) => camRun(page, { op: 'view', view: String(name), ms: ms(options, 'tuner.camera.view()') }),
    orbit: async (yaw: number, pitch = 0, options?: unknown) => camRun(page, { op: 'orbit', yaw: Number(yaw) || 0, pitch: Number(pitch) || 0, ms: ms(options, 'tuner.camera.orbit()') }),
    zoom: async (factor: number, options?: unknown) => camRun(page, { op: 'zoom', factor: Number(factor), ms: ms(options, 'tuner.camera.zoom()') }),
    set: async (raw?: unknown, options?: unknown) => {
      const pose = checked(raw, 'tuner.camera.set()', ['yaw', 'pitch', 'distance', 'target', 'ortho'])
      return camRun(page, { op: 'set', yaw: pose.yaw, pitch: pose.pitch, distance: pose.distance, target: pose.target, ortho: pose.ortho, ms: ms(options, 'tuner.camera.set()') })
    },
    async get(): Promise<CamState | null> {
      await tunerReady(page)
      return (await camCall(page, { op: 'get' }))?.state ?? null
    }
  }
}

const FOCUS_FLY_MS = 1200

async function selectRow(page: PageLike, path: string): Promise<string> {
  await tunerReady(page)
  const want = await rowPath(page, path)
  const same = (now: string): boolean => !!now && (now === want || now.endsWith(`/${want}`) || want.endsWith(`/${now}`))
  if (same(await selectedPath(page))) return want
  await new Row(page, path).click()
  const until = Date.now() + WAIT_MS
  let again = Date.now() + 1500
  while (Date.now() < until) {
    const now = await selectedPath(page)
    if (same(now)) return now
    if (Date.now() > again) {
      again = Date.now() + 1500
      await new Row(page, path).click()
    }
    await page.waitForTimeout(80)
  }
  const now = await selectedPath(page)
  if (same(now)) return now
  throw new Error(`Clicked the row ${path}, but the Tuner selected ${now ? `"${now}"` : 'nothing'}.`)
}

function angleOf(options: Options): Options {
  const a = options.angle
  if (a && typeof a === 'object') return { yaw: (a as Options).yaw, pitch: (a as Options).pitch }
  if (a !== undefined && a !== null && typeof a !== 'string') throw new TypeError("angle is 'auto', 'front', 'back', 'left', 'right', 'top', 'three-quarter', 'current' or { yaw, pitch }")
  return { angle: a ?? null, yaw: options.yaw, pitch: options.pitch }
}

async function focusOn(page: PageLike, path: unknown, options: Options): Promise<Options> {
  if (typeof path !== 'string' || !path.trim()) throw new TypeError("tuner.focus() takes a hierarchy path like 'Level/Crate'")
  const selected = await selectRow(page, path.trim())
  await showPane(page, viewport(page)).catch(() => null)
  const cmd: Options = {
    op: 'focus',
    ...angleOf(options),
    distance: typeof options.distance === 'number' ? options.distance : undefined,
    pad: typeof options.pad === 'number' ? options.pad : undefined,
    ms: typeof options.ms === 'number' ? options.ms : FOCUS_FLY_MS,
    ...(options.shot === true ? { solid: true, nice: true } : {})
  }
  const until = Date.now() + WAIT_MS
  let r = await camCall(page, cmd)
  while (r && !r.ok && (r.why === 'pending' || /not showing/.test(r.why ?? '')) && Date.now() < until) {
    await page.waitForTimeout(100)
    r = await camCall(page, cmd)
  }
  if (!r) throw new Error(`The Tuner "${chosen.get(page) ?? ''}" shows no viewport.`)
  if (!r.ok && r.why === 'pending') return { selected, camera: null, note: `${selected} is selected, but it has nothing the scene view can frame, so the camera stayed put` }
  if (!r.ok) throw new Error(`tuner.focus(${JSON.stringify(path)}): ${r.why}`)
  if (r.invisible) return { selected, invisible: true }
  await camSettle(page, r.ms ?? 0)
  const cam = (await camCall(page, { op: 'get' }))?.state ?? null
  const aimed = (options.angle != null && options.angle !== 'auto') || typeof options.yaw === 'number' || typeof options.pitch === 'number'
  const note = cam?.view === '2D' && aimed ? 'the 2D view always faces the XY plane, so the angle option was ignored' : undefined
  return { selected, camera: cam ? { distance: Math.round(cam.distance * 100) / 100, yaw: Math.round(cam.yaw), pitch: Math.round(cam.pitch), view: cam.view } : null, ...(note ? { note } : {}) }
}

export class SceneObject extends Spot {
  constructor(
    page: PageLike,
    readonly _path: string
  ) {
    super(page, () => this._resolve(), `${_path} in the scene view`, () => viewport(page), () => this._why())
  }

  private async _box(): Promise<CamReply | null> {
    return camCall(this._page, { op: 'box', paths: [await rowPath(this._page, this._path)] })
  }

  readonly _mark = false

  async _ensure(): Promise<void> {
    await selectRow(this._page, this._path)
  }

  private async _resolve(): Promise<Found | null> {
    const path = await rowPath(this._page, this._path)
    const r = await camCall(this._page, { op: 'box', paths: [path] })
    if (!r?.ok || !r.box) return null
    this._sel = viewport(this._page)._selector
    this._gizmo = { axis: -1, kind: 'object', path }
    return r.box as Found
  }

  private async _why(): Promise<string> {
    const r = await this._box()
    if (!r) return `The Tuner "${chosen.get(this._page) ?? ''}" shows no viewport.`
    if (!r.ok) return `The scene view has no object "${this._path}". Select it first with tuner.focus('${this._path}'), or check the path with tuner.row().`
    return `${this._path} is outside the camera's view. Call await tuner.focus('${this._path}') first.`
  }
}

class ScenePoint extends Spot {
  constructor(
    page: PageLike,
    readonly _path: string,
    private readonly _at: string
  ) {
    super(page, () => this._resolve(), `${_path} in the scene view`, () => viewport(page))
  }

  readonly _mark = false

  async _resolve(): Promise<Found | null> {
    const vp = viewport(this._page)
    if (!(await vp.count())) return null
    const r = (await vp.evaluate((el: any, path: string) => (el.__motion && typeof el.__motion.camera === 'function' ? el.__motion.camera({ op: 'aim', paths: [path] }) : null), this._at)) as { ok: boolean; aim?: { x: number; y: number } | null } | null
    const aim = r?.ok ? r.aim : null
    if (!aim) return null
    const at = (await vp.evaluate((el: Element, p: { x: number; y: number }) => {
      const b = el.getBoundingClientRect()
      if (b.width < 40 || b.height < 40 || p.x < 2 || p.y < 2 || p.x > b.width - 2 || p.y > b.height - 2) return null
      const x = b.left + p.x
      const y = b.top + p.y
      const hit = document.elementFromPoint(x, y)
      return hit && (el === hit || el.contains(hit)) ? { x, y } : null
    }, aim).catch(() => null)) as { x: number; y: number } | null
    if (!at) return null
    this._sel = vp._selector
    this._gizmo = { axis: -1, kind: 'object', path: this._at }
    return { x: at.x - 3, y: at.y - 3, width: 6, height: 6 }
  }
}

export async function scenePoint(page: PageLike, path: string): Promise<Spot | null> {
  const spot = new ScenePoint(page, path, await rowPath(page, path))
  return (await spot._resolve()) ? spot : null
}

function readInspector(root: Element, a: { want: string; max: number; component: string; fresh?: Record<string, [string, string, string?, string?][]> | null; names?: boolean; json?: boolean }): Options | string | null {
  if ((root.getAttribute('data-ti-seq') ?? '0') === '0') return null
  const target = root.getAttribute('data-ti-target') ?? ''
  const tpath = target.includes('|') ? target.slice(target.indexOf('|') + 1) : target
  if (a.want && tpath && tpath !== a.want && !tpath.endsWith(`/${a.want}`) && !a.want.endsWith(`/${tpath}`)) return null
  const norm = (v: unknown): string => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const short = (v: unknown): unknown => {
    if (typeof v === 'number') return Math.round(v * 1000) / 1000
    if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 77)}...` : v
    return v
  }
  const components: Options[] = []
  for (const sec of Array.from(root.querySelectorAll('[data-ti-section]'))) {
    const name = sec.getAttribute('data-ti-section') ?? ''
    if (!name || name === 'GameObject' || name === 'AddComponent' || sec.getAttribute('data-ti-kind') === 'addComponent') continue
    if (a.component && norm(name.replace(/#\d+$/, '')) !== norm(a.component)) continue
    const props = Array.from(sec.querySelectorAll('[data-ti-prop]'))
    const valueOf = (el: Element): unknown => {
      const path = el.getAttribute('data-ti-prop') ?? ''
      const engine = el.getAttribute('data-ti-v')
      const kids = props.filter((k) => k.getAttribute('data-ti-parent') === path)
      const parts = kids.map((k) => [String(k.getAttribute('data-ti-prop') ?? '').slice(path.length + 1), valueOf(k)] as const)
      if (parts.length && parts.every(([key, v]) => /^[xyzw]$/.test(key) && typeof v === 'number')) return Object.fromEntries([...parts].sort((p, q) => 'xyzw'.indexOf(p[0]) - 'xyzw'.indexOf(q[0])).map(([key, v]) => [key, short(v)]))
      if (engine !== null) {
        if (/^-?\d+(\.\d+)?$/.test(engine)) return Number(engine)
        if (/^[[{"]|^null$/.test(engine)) {
          try {
            return JSON.parse(engine)
          } catch {
            return engine
          }
        }
        return engine
      }
      if (parts.length) return Object.fromEntries(parts.slice(0, 8))
      const raw = el.getAttribute('data-ti-value')
      if (raw === null) return null
      try {
        return short(JSON.parse(raw))
      } catch {
        return short(raw)
      }
    }
    const bar = sec.querySelector('[data-ti-widget="titlebar"]')
    const br = bar?.getBoundingClientRect()
    const toggle = br ? Array.from(sec.querySelectorAll('[data-ti-widget="toggle"]')).find((e) => {
      const r = e.getBoundingClientRect()
      return r.top + r.height / 2 >= br.top && r.top + r.height / 2 <= br.bottom
    }) : undefined
    const entry: Options = { name }
    const cut = /^(\d+)\/(\d+)$/.exec(sec.getAttribute('data-ti-filter') ?? '')
    if (cut) entry.filter = { shown: Number(cut[1]), total: Number(cut[2]) }
    if (toggle) entry.enabled = toggle.getAttribute('data-ti-on') === 'true'
    if (sec.getAttribute('data-ti-expanded') === 'false') entry.folded = true
    const fields: Options = {}
    const seen = new Set<string>()
    const names: Record<string, { path: string; from: string; alt: string[] }> = {}
    const named = (label: string, path: string, from: string, ...alt: (string | null | undefined)[]): void => {
      if (a.names && !(label in names)) names[label] = { path, from, alt: [...new Set(alt.filter((x): x is string => !!x && x !== label))] }
    }
    let more = 0
    const best = new Map<string, Element>()
    const shown = new Map<string, string>()
    for (const el of props) {
      if (el.getAttribute('data-ti-parent') !== null || el.hasAttribute('data-ti-aux')) continue
      const path = el.getAttribute('data-ti-prop') ?? ''
      const was = best.get(path)
      if (!was || (!was.hasAttribute('data-ti-value') && !was.hasAttribute('data-ti-v') && (el.hasAttribute('data-ti-value') || el.hasAttribute('data-ti-v')))) best.set(path, el)
      const n = el.getAttribute('data-ti-name') || ''
      if (n && (!shown.has(path) || (shown.get(path) === el.getAttribute('data-ti-label') && n !== shown.get(path)))) shown.set(path, n)
    }
    for (const el of props) {
      if (el.getAttribute('data-ti-parent') !== null || el.hasAttribute('data-ti-aux')) continue
      const path = el.getAttribute('data-ti-prop') ?? ''
      if (best.get(path) !== el || seen.has(path)) continue
      seen.add(path)
      const label = shown.get(path) || el.getAttribute('data-ti-label') || path
      if (path === 'm_Script') {
        entry.script = valueOf(el)
        continue
      }
      if (path === 'm_Enabled' && toggle) {
        named('enabled', path, 'prop', path, label)
        continue
      }
      if (Object.keys(fields).length >= a.max) {
        more++
        continue
      }
      fields[label] = valueOf(el)
      named(label, path, 'prop', path, el.getAttribute('data-ti-label'), el.getAttribute('data-ti-name'))
    }
    const FIELD = '[data-uitk-value][data-uitk-label], [data-uitk-value][data-uitk-path]'
    for (const el of Array.from(sec.querySelectorAll(FIELD))) {
      if (el.parentElement?.closest(FIELD) && sec.contains(el.parentElement.closest(FIELD))) continue
      const path = el.getAttribute('data-uitk-path') ?? ''
      const tail = path.split('.').filter((x) => x !== 'Array' && !/^data\[\d+\]$/.test(x)).pop() ?? ''
      const label = el.getAttribute('data-uitk-label') || tail.replace(/^m_/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())
      if (!label || label in fields || seen.has(path) || /Foldout/.test(el.getAttribute('data-uitk-type') ?? '')) continue
      seen.add(path)
      if (path === 'm_Enabled' && toggle) {
        named('enabled', path, 'uitk', path, label)
        continue
      }
      if (Object.keys(fields).length >= a.max) {
        more++
        continue
      }
      const type = el.getAttribute('data-uitk-type') ?? ''
      const popup = el.querySelector('[data-uitk-type="PopupTextElement"], [data-uitk-type="TextElement"][data-uitk-text]')
      const shown = Array.from(el.querySelectorAll('[data-uitk-type="Label"][data-uitk-text]')).map((l) => l.getAttribute('data-uitk-text') ?? '').filter((t) => t && t !== label).pop()
      const raw = el.getAttribute('data-uitk-value') ?? ''
      let value: unknown = raw
      const n = raw.split(',').map(Number)
      const nums = !!raw && n.every(Number.isFinite)
      const xyz = (from: number): Options => ({ x: n[from], y: n[from + 1], z: n[from + 2] })
      if (/Popup|Enum|Mask|Layer|Tag/.test(type) && popup) value = popup.getAttribute('data-uitk-text') ?? raw
      else if (/ObjectField/.test(type)) value = raw || (shown && !/^None \(/.test(shown) ? shown : null)
      else if (/ColorField/.test(type) && /^#[0-9a-f]{8}$/i.test(raw)) value = raw.toUpperCase().replace(/^(#[0-9A-F]{6})FF$/, '$1')
      else if (nums && /^Vector[234](Int)?Field$/.test(type) && n.length >= 2 && n.length <= 4) value = Object.fromEntries(n.map((v, i) => ['xyzw'[i], short(v)]))
      else if (nums && /^Rect(Int)?Field$/.test(type) && n.length === 4) value = { x: n[0], y: n[1], width: n[2], height: n[3] }
      else if (nums && /^BoundsField$/.test(type) && n.length === 6) value = { center: xyz(0), extent: xyz(3) }
      else if (nums && /^BoundsIntField$/.test(type) && n.length === 6) value = { position: xyz(0), size: xyz(3) }
      else if (/^(true|false)$/i.test(raw)) value = raw.toLowerCase() === 'true'
      else if (/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(raw)) value = Number(raw)
      fields[label] = short(value)
      named(label, path, 'uitk', path, tail, el.getAttribute('data-uitk-label'))
    }
    let vals: [string, string, string?, string?][] = []
    try {
      vals = a.fresh?.[name] ?? (JSON.parse(sec.getAttribute('data-ti-vals') ?? '[]') as [string, string, string?, string?][])
    } catch {
      vals = []
    }
    const shownLabels = ((window as unknown as { __tiShownLabels?: Record<string, string> }).__tiShownLabels ?? {}) as Record<string, string>
    const type = name.replace(/#\d+$/, '')
    const hidden: Options = {}
    for (const [display, raw, vpath, flag] of vals) {
      const shown = vpath ? shownLabels[`${type}|${vpath}`] : undefined
      const label = shown || display
      if (!label || label in fields || (vpath && seen.has(vpath))) continue
      if (vpath === 'm_Enabled' && toggle) {
        named('enabled', vpath, 'vals', vpath, display, label)
        continue
      }
      if (flag === 'h') {
        if (!a.names || label in hidden) continue
        let value: unknown = raw
        try {
          value = JSON.parse(raw)
        } catch {
          value = raw
        }
        hidden[label] = short(value)
        named(label, vpath ?? '', 'hidden', vpath, display)
        continue
      }
      if (Object.keys(fields).length >= a.max) {
        more++
        continue
      }
      let value: unknown = raw
      try {
        value = JSON.parse(raw)
      } catch {
        value = raw
      }
      fields[label] = short(value)
      named(label, vpath ?? '', 'vals', vpath, display)
    }
    entry.fields = fields
    if (a.names) {
      entry.names = names
      if (Object.keys(hidden).length) entry.hidden = hidden
    }
    if (more) entry.more = more
    components.push(entry)
  }
  return a.json ? JSON.stringify({ path: tpath, components }) : { path: tpath, components }
}

export function inspectQuiet(page: PageLike, path: string): Promise<Options> {
  return inspectOf(page, path, { fields: 0, _quiet: true })
}

async function freshValues(page: PageLike, rpc: TunerRpc | undefined): Promise<Record<string, [string, string, string?, string?][]> | null> {
  if (!rpc) return null
  const root = inspector(page)
  const session = await root
    .evaluate((el: Element) => (Array.from(el.querySelectorAll('[data-ti-section]')).some((s) => s.hasAttribute('data-ti-vals') || s.getAttribute('data-ti-expanded') === 'false') ? el.getAttribute('data-ti-session') : null))
    .catch(() => null)
  if (typeof session !== 'string' || !session) return null
  const r = await rpc({ action: 'values', session }).catch(() => null)
  return r && typeof r === 'object' ? (r as Record<string, [string, string, string?, string?][]>) : null
}

async function inspectOf(page: PageLike, path: unknown, options: Options, rpc?: TunerRpc): Promise<Options> {
  if (path !== undefined && path !== null && (typeof path !== 'string' || !path.trim())) throw new TypeError("tuner.inspect() takes a hierarchy path like 'Level/Player', or nothing for the selection")
  const want = typeof path === 'string' ? await selectRow(page, path.trim()) : await selectedPath(page)
  if (!want) throw new Error("Nothing is selected in the Tuner. Pass a path: await tuner.inspect('Level/Player').")
  if (options._quiet !== true) await showPane(page, inspector(page)).catch(() => null)
  const component = typeof options.component === 'string' ? options.component : ''
  const max = typeof options.fields === 'number' && options.fields >= 0 ? Math.floor(options.fields) : component ? 200 : 12
  const until = Date.now() + WAIT_MS
  while (Date.now() < until) {
    const root = inspector(page)
    const names = options._names === true
    const read = async (fresh?: unknown): Promise<Options | null> => {
      const r = await root.evaluate(readInspector, { want, max, component, names, fresh, json: true })
      return typeof r === 'string' ? (JSON.parse(r) as Options) : ((r as Options | null) ?? null)
    }
    let out = (await root.count()) ? await read() : null
    if (out && Array.isArray(out.components) && (out.components.length || !component)) {
      const fresh = options._quiet === true ? null : await freshValues(page, rpc)
      if (fresh) out = (await read(fresh)) ?? out
      const tag = paneOf(page).locator('[data-tuner-filter]').first()
      const view = (await tag.count()) ? await tag.getAttribute('data-tuner-filter').catch(() => null) : null
      return view ? { ...out, filter: view } : out
    }
    if (out && component) {
      const all = (await root.evaluate(readInspector, { want, max: 0, component: '' })) as Options | null
      const names = ((all?.components as Options[] | undefined) ?? []).map((c) => String(c.name))
      throw new Error(`${want} has no ${component} component. It has: ${names.join(', ') || 'none'}.`)
    }
    await page.waitForTimeout(120)
  }
  throw new Error((await troubleOf(page)) || `The inspector of ${want} didn't load.`)
}

async function searchFor(page: PageLike, text: unknown, options: Options): Promise<Options> {
  await tunerReady(page)
  await showPane(page, hierarchy(page)).catch(() => null)
  const box = paneOf(page).locator('[data-hierarchy-search]').first()
  if (!(await box.count())) throw new Error(`The Tuner "${chosen.get(page) ?? ''}" has no hierarchy search.`)
  const want = String(text ?? '').trim()
  if (!want) {
    if (await box.inputValue()) await box.fill('')
    return { query: '', matches: [] }
  }
  await box.click()
  await box.fill(want)
  const max = typeof options.max === 'number' && options.max > 0 ? Math.floor(options.max) : 30
  const read = async (): Promise<string[]> =>
    (await hierarchy(page).evaluate((el: any, q: string) => {
      const rows = (el.__tunerRows?.rows?.() ?? []) as { path: string; name: string }[]
      return rows.filter((r) => r.path && String(r.name ?? '').toLowerCase().includes(q)).map((r) => r.path)
    }, want.toLowerCase())) as string[]
  let last = await read()
  let calm = 0
  const until = Date.now() + 3000
  while (Date.now() < until && calm < 3) {
    await page.waitForTimeout(150)
    const now = await read()
    calm = now.length === last.length ? calm + 1 : 0
    last = now
  }
  const matches = [...new Set(last)]
  return { query: want, matches: matches.slice(0, max), ...(matches.length > max ? { more: matches.length - max } : {}) }
}

export type SceneRow = { path: string; name: string; icon: string; types?: string; active: boolean; kids: boolean; depth: number; key?: string; scene?: string }

export async function tunerOpen(page: PageLike): Promise<boolean> {
  return (await paneOf(page).count()) > 0
}

export async function sceneRows(page: PageLike, find = '', path = ''): Promise<SceneRow[]> {
  await tunerReady(page)
  const list = hierarchy(page)
  if (!(await list.count())) return []
  const read = async (): Promise<SceneRow[]> => ((await list.evaluate((el: any) => el.__tunerRows?.list?.() ?? [])) as SceneRow[]) ?? []
  const want = find.trim().toLowerCase()
  if (!want) return read()
  const lazy = await list.evaluate((el: any, t: string) => el.__tunerRows?.lookup?.(t) ?? false, find.trim())
  if (!lazy) return read()
  try {
    const exact = path.replace(/^\/+|\/+$/g, '').toLowerCase()
    const hit = (rows: SceneRow[]): boolean => rows.some((r) => (exact ? r.path.toLowerCase() === exact || r.path.toLowerCase().endsWith(`/${exact}`) : r.name.toLowerCase().includes(want)))
    let last = await read()
    const until = Date.now() + 2500
    let calm = 0
    while (Date.now() < until && !(hit(last) && calm >= 2)) {
      await page.waitForTimeout(120)
      const now = await read()
      calm = now.length === last.length ? calm + 1 : 0
      last = now
      if (!hit(last) && calm >= 8) break
    }
    return last
  } finally {
    await list.evaluate((el: any) => el.__tunerRows?.lookup?.('')).catch(() => null)
  }
}

export async function aimAt(page: PageLike, rpc: TunerRpc, at: unknown, camera: unknown): Promise<void> {
  if (camera === false) return
  try {
    let paths: string[] | null | undefined
    let pivot = false
    const spot = at instanceof Spot && at._page === page ? at : null
    if (camera === null) paths = null
    else if (typeof camera === 'string' || Array.isArray(camera)) paths = camList(camera, 'The camera option')
    else if (spot instanceof Row || spot instanceof SceneObject) paths = [spot._path]
    else if (spot instanceof Handle) {
      if (spot._object) paths = [spot._object]
      pivot = true
    } else if (!spot && at !== undefined && at !== null) return
    if (!spot && !chosen.has(page) && paths === undefined) return
    if (!(await rpc({ action: 'aim' }))) return
    await tunerReady(page)
    const cmd = { op: 'frame', paths: paths ? await camPaths(page, paths) : paths, pivot, auto: true, ms: AIM_MS }
    let r = await camCall(page, cmd)
    if (r && !r.ok && r.missing?.length && Array.isArray(cmd.paths) && cmd.paths.length === 1) {
      const want = cmd.paths[0]
      const sel = await selectedPath(page)
      if (sel && (sel === want || sel.endsWith(`/${want}`) || want.endsWith(`/${sel}`))) {
        const until = Date.now() + 2000
        while (r && !r.ok && r.missing?.length && Date.now() < until) {
          await page.waitForTimeout(100)
          r = await camCall(page, cmd)
        }
      }
    }
    if (r && !r.ok && r.missing?.length) await rpc({ action: 'aim', note: `camera: the Tuner has no object "${r.missing[0]}", so the camera stayed put. Pass a full hierarchy path like 'Level/Crate'` })
    if (!r?.ok || !r.moved) return
    await rpc({ action: 'aim', log: `drift frames the Tuner camera on ${r.subject ?? 'its subject'}` })
    await camSettle(page, r.ms ?? 0)
  } catch (e) {
    if (e instanceof TypeError) throw e
  }
}

const FILTER_KEYS = ['objects', 'ui', 'prefabs', 'assets', 'buttons', 'note', 'states', 'camera', 'animator', 'merge', 'mode', 'title']

const OPEN_KEYS = ['scene', 'prefab', 'object', 'name', 'select', 'frame', 'open', 'scratchpad', 'wait', ...FILTER_KEYS]

const OPEN_WAIT_S = 300

type TargetState = { name: string; scratchpad: string | null; status: string; detail: string; problem: string | null }

export type TunerFilter = (args: Options) => Promise<string>

export function filteredOpen(o: Options): boolean {
  return FILTER_KEYS.some((k) => o[k] !== undefined) || (typeof o.scene === 'string' && typeof o.name === 'string')
}

export function tunerApi(page: PageLike, rpc: TunerRpc, filter?: TunerFilter): Record<string, unknown> {
  fieldRpcs.set(page, rpc)
  gates.set(page, {
    find: async (view, target) => {
      const r = await rpc({ action: 'find', view, target })
      return r && typeof r === 'object' && typeof (r as Options).view === 'string' ? (r as NonNullable<FoundTuner>) : null
    },
    ready: async (view, timeout, limit, target) => {
      const r = await rpc({ action: 'ready', view, timeout, limit, target })
      return typeof r === 'string' ? r : null
    },
    list: async () => {
      const r = await rpc({ action: 'list' })
      return Array.isArray(r) ? (r as TunerTabInfo[]) : []
    }
  })
  const NO_TIMELINE = 'No animation timeline is open. It shows under the viewport when the selected object has an animation clip: select it with tuner.row(path).click().'
  const timelinePane: Spot = new Spot(
    page,
    async () => {
      const p = animator(page)
      if (!(await p.count())) return null
      timelinePane._sel = p._selector
      return p.boundingBox()
    },
    'the Tuner timeline',
    () => animator(page),
    async () => ((await paneOf(page).count()) ? NO_TIMELINE : NO_TUNER)
  )
  const timeline = Object.assign(timelinePane, {
    frame(n: number): Spot {
      const frame = Math.round(Number(n))
      const find = async (): Promise<Found | null> => {
        const tl = animator(page)
        if (!(await tl.count())) return null
        return (await tl.evaluate(
          (root: Element, f: number) => {
            const ruler = root.querySelector('svg[data-anim-ruler]')
            if (!ruler) return null
            const r = ruler.getBoundingClientRect()
            const [start, span] = String(root.getAttribute('data-anim-view') ?? '0:1').split(':').map(Number)
            const fps = Number(root.getAttribute('data-anim-fps')) || 60
            const x = r.x + 10 + ((f / fps - start) / (span || 1)) * (r.width - 20)
            if (!(x >= r.x && x <= r.x + r.width)) return null
            return { x: x - 1, y: r.y, width: 2, height: r.height }
          },
          frame
        )) as Found | null
      }
      const why = async (): Promise<string> => {
        const tl = animator(page)
        if (!(await tl.count())) return NO_TIMELINE
        const view = String((await tl.getAttribute('data-anim-view')) ?? '0:1').split(':').map(Number)
        const fps = Number(await tl.getAttribute('data-anim-fps')) || 60
        return `Frame ${frame} is outside the timeline's view, which shows frames ${Math.round(view[0] * fps)} to ${Math.round((view[0] + view[1]) * fps)}. Call await tuner.timeline.showAll() first.`
      }
      return new Spot(page, find, `timeline frame ${frame}`, () => animator(page), why)
    },
    key(frame: number, options?: unknown): Spot {
      const f = Math.round(Number(frame))
      const o = checked(options, 'tuner.timeline.key()', ['row'])
      const row = typeof o.row === 'string' ? o.row : ''
      const find = async (): Promise<Found | null> => {
        const tl = animator(page)
        if (!(await tl.count())) return null
        const id = (await tl.evaluate(
          (root: Element, a: { f: number; row: string }) => {
            const rows = Array.from(root.querySelectorAll('[data-anim-row]'))
            const want = a.row.toLowerCase()
            const pick = a.row
              ? rows.find((r) => (r.textContent ?? '').trim().toLowerCase() === want) ?? rows.find((r) => (r.textContent ?? '').trim().toLowerCase().endsWith(want))
              : rows.find((r) => r.getAttribute('data-anim-row-kind') === 'summary')
            const keys = Array.from(root.querySelectorAll('[data-anim-key]')).filter((k) => (k.getAttribute('data-anim-key') ?? '').endsWith(`@${a.f}`))
            const key = pick ? keys.find((k) => k.getAttribute('data-anim-key') === `${pick.getAttribute('data-anim-row')}@${a.f}`) : keys[0]
            const el = key ?? (a.row ? null : keys[0])
            return el ? el.getAttribute('data-anim-key') : null
          },
          { f, row }
        )) as string | null
        if (!id) return null
        const key = tl.locator(`[data-anim-key=${q(id)}]`).first()
        await key.scrollIntoViewIfNeeded()
        return (await key.boundingBox()) as Found | null
      }
      return new Spot(page, find, `key at frame ${f}${row ? ` on ${row}` : ''}`, () => animator(page), async () => ((await animator(page).count()) ? `No key at frame ${f}${row ? ` on the row "${row}"` : ''}.` : NO_TIMELINE))
    },
    async playhead(): Promise<number> {
      await tunerReady(page)
      const tl = animator(page)
      if (!(await tl.count())) throw new Error(NO_TIMELINE)
      return Number((await tl.getAttribute('data-anim-frame')) ?? NaN)
    },
    async showAll(): Promise<void> {
      await tunerReady(page)
      if (!(await animator(page).count())) throw new Error(NO_TIMELINE)
      await animator(page).press('a')
    },
    async seek(n: number): Promise<number> {
      const want = Math.round(Number(n))
      await tunerReady(page)
      if (!(await animator(page).count())) throw new Error(NO_TIMELINE)
      if (!(await timeline.frame(want).box())) {
        await animator(page).press('a').catch(() => null)
        await page.waitForTimeout(150)
        if (!(await timeline.frame(want).box())) {
          const tl = animator(page)
          const view = String((await tl.getAttribute('data-anim-view')) ?? '0:1').split(':').map(Number)
          const fps = Number(await tl.getAttribute('data-anim-fps')) || 60
          throw new Error(`Frame ${want} is outside this clip, which runs from frame ${Math.round(view[0] * fps)} to ${Math.round((view[0] + view[1]) * fps)}. Read the range with tuner.timeline.showAll(), then seek inside it.`)
        }
      }
      await timeline.frame(want).click()
      const until = Date.now() + 2000
      while ((await timeline.playhead()) !== want && Date.now() < until) await page.waitForTimeout(50)
      return timeline.playhead()
    },
    async step(n = 1): Promise<number> {
      await tunerReady(page)
      if (!(await animator(page).count())) throw new Error(NO_TIMELINE)
      const count = Math.round(Number(n) || 0)
      const button = animator(page).getByRole('button', { name: count < 0 ? 'Previous frame' : 'Next frame', exact: true })
      for (let i = 0; i < Math.abs(count); i++) await button.click()
      return timeline.playhead()
    }
  })
  return {
    async open(options: Options = {}): Promise<string> {
      const o = options && typeof options === 'object' ? options : {}
      const extra = Object.keys(o).filter((k) => !OPEN_KEYS.includes(k))
      if (extra.length) throw new TypeError(`tuner.open(): unknown option ${extra.join(', ')}. Options: ${OPEN_KEYS.join(', ')}.`)
      const { select, frame, open: show, scratchpad, wait, ...rest } = o
      if (scratchpad !== undefined && scratchpad !== null && scratchpad !== false && (typeof scratchpad !== 'string' || !scratchpad.trim()))
        throw new TypeError("tuner.open(): scratchpad is the scratchpad's name, id or folder, from scratchpad.list(), or null for the project's own editor")
      if (wait !== undefined && typeof wait !== 'boolean' && !(typeof wait === 'number' && Number.isFinite(wait) && wait > 0))
        throw new TypeError(`tuner.open(): wait is how many seconds to wait for the editor to be ready, or false to open the Tuner and return at once, got ${String(wait)}`)
      const waitS: number | false | undefined = wait === true ? OPEN_WAIT_S : (wait as number | false | undefined)
      const filtered = filteredOpen(rest)
      const at = pinned.get(page)
      const before = aimed.get(page)
      const pad =
        typeof scratchpad === 'string'
          ? String(await rpc({ action: 'scratchpad', ref: scratchpad }))
          : scratchpad === null || scratchpad === false
            ? undefined
            : before !== undefined
              ? before === 'project' ? undefined : before
              : at ? chooseTunerTab(await tunerTabList(page), at)?.scratchpad : undefined
      const where = pad ? { scratchpad: pad } : {}
      const key = pad ?? 'project'
      const aim = pad || scratchpad === null || scratchpad === false || before !== undefined ? key : undefined
      const targetNow = async (): Promise<TargetState> => (await rpc({ action: 'target', ...where, wait: waitS })) as TargetState
      let view: string
      let text: string
      if (filtered) {
        if (!filter) throw new Error('A filtered Tuner needs the satura_exec MCP tool of an agent.')
        const { prefab, object, name, ...keys } = rest
        const args: Options = { ...keys, ...where, name: typeof name === 'string' && name ? name : 'tuner', open: show !== false }
        if (typeof prefab === 'string') args.prefabs = [...(Array.isArray(keys.prefabs) ? keys.prefabs : []), prefab]
        if (typeof object === 'string') args.objects = [...(Array.isArray(keys.objects) ? keys.objects : []), { path: object, children: true }]
        const target = await targetNow()
        if (target.problem) throw new Error(target.problem)
        text = await filter(args)
        view = String(args.name)
        if (show === false) return text
      } else {
        const scene = rest.scene
        const prefab = rest.prefab
        const object = typeof rest.object === 'string' ? rest.object : ''
        if ((scene === undefined || scene === false) && (prefab === undefined || prefab === false) && !object)
          throw new TypeError("tuner.open() needs { scene: true }, { scene: 'Assets/Scenes/Level.unity' }, { prefab: 'Assets/Prefabs/Crate.prefab' }, { object: 'Level/Crate' }, or a filter such as { objects: [...] } or { ui: 'Canvas' }")
        const sceneAsk = scene !== undefined && scene !== false && (prefab === undefined || prefab === false) && !object
        const mine = async (): Promise<TunerTabInfo[]> => (await tunerTabList(page)).filter((t) => tunerTabTarget(t) === key)
        const had = sceneAsk ? (await mine()).find((t) => t.view === 'scene' || /\.unity$/i.test(t.view)) : undefined
        const elsewhere = had ? [] : (await tunerTabList(page)).filter((t) => tunerTabTarget(t) !== key)
        view = String(await rpc({ action: 'open', scene, prefab, object, name: rest.name, ...where, ...(waitS === undefined ? {} : { wait: waitS }) }))
        text = view
        if (had) {
          await new Promise((r) => setTimeout(r, 300))
          const now = (await mine()).find((t) => t.view === view) ?? (await mine()).find((t) => t.view === 'scene' || /\.unity$/i.test(t.view))
          if (now) view = now.view
          text = `${view} (the ${pad ? "scratchpad's" : "project's"} scene Tuner was already open, so it was reused)`
        } else if (elsewhere.length) {
          await new Promise((r) => setTimeout(r, 300))
          const now = await mine()
          const moved = elsewhere.find((t) => now.some((n) => n.tabId === t.tabId))
          const shows = moved && now.find((n) => n.tabId === moved.tabId)
          if (moved && shows) {
            view = shows.view
            const name = async (target: string): Promise<string> => {
              if (target === 'project') return 'the project'
              const t = (await rpc({ action: 'target', scratchpad: target, wait: false }).catch(() => null)) as TargetState | null
              return t ? `${t.name.charAt(0).toLowerCase()}${t.name.slice(1)}` : `scratchpad ${target}`
            }
            text = `${view} (the user's Tuner "${moved.label}" switched from ${await name(tunerTabTarget(moved))} to ${await name(key)} instead of opening a second Tuner)`
          }
        }
      }
      chosen.set(page, view)
      pinned.set(page, view)
      if (aim) aimed.set(page, aim)
      else aimed.delete(page)
      if (waitS === false) {
        const now = await targetNow()
        if (now.status !== 'running')
          await rpc({ action: 'aim', note: `${now.name} is ${now.status === 'starting' ? 'still starting' : now.status}${now.detail ? ` (${now.detail})` : ''}. The Tuner "${view}" shows its scene once it's ready.` })
        return text
      }
      const ms = typeof waitS === 'number' ? waitS * 1000 : OPEN_MS
      let ready: string | null | undefined
      try {
        ready = await gates.get(page)?.ready(view, ms, typeof waitS === 'number' ? ms : undefined, aim)
      } catch (e) {
        if (typeof waitS !== 'number') throw e
        const now = await targetNow()
        if (now.status === 'running') throw e
        throw new Error(`${now.name} was still ${now.status === 'starting' ? 'starting' : now.status}${now.detail ? ` (${now.detail})` : ''} after ${waitS} s. The Tuner "${view}" stays on it and shows the scene when it's ready.`)
      }
      if (ready === null) throw new Error(`The Tuner "${view}" didn't open in your workspace.`)
      const lead = await notePlacement(page, `the Tuner "${view}"`).catch(() => null)
      await showPane(page, viewport(page), lead).catch(() => null)
      if (typeof select === 'string' && select) await new Row(page, select).click()
      if (frame !== undefined && frame !== false) {
        const cam = cameraApi(page) as { frame: (what?: string | string[] | null) => Promise<unknown> }
        await cam.frame(frame === true ? (typeof select === 'string' ? select : undefined) : (frame as string | string[]))
      }
      return text
    },
    field: (name: string, options?: unknown) => {
      const o = checked(options, 'tuner.field()', ['section'])
      return new Field(page, { name: String(name), section: typeof o.section === 'string' ? o.section : undefined })
    },
    row: (path: string) => new Row(page, String(path)),
    select: (paths: unknown) => selectRows(page, paths),
    canvasView: (name?: unknown) => canvasViewOf(page, name),
    object: (path: string) => new SceneObject(page, String(path ?? '').trim()),
    focus: async (path: string, options?: unknown) => focusOn(page, path, checked(options, 'tuner.focus()', ['angle', 'distance', 'pad', 'ms', 'yaw', 'pitch', 'shot'])),
    search: async (text: string, options?: unknown) => searchFor(page, text, checked(options, 'tuner.search()', ['max'])),
    inspect: async (path?: string, options?: unknown) => inspectOf(page, path, checked(options, 'tuner.inspect()', ['component', 'fields']), rpc),
    _named: async (path: string, component?: string) => inspectOf(page, path, { ...(component ? { component } : {}), fields: 400, _names: true }, rpc),
    component: (name: string, options?: unknown) => {
      const o = checked(options, 'tuner.component()', ['index'])
      return new Component(page, { name: String(name), index: typeof o.index === 'number' ? o.index : undefined })
    },
    button: (text: string, options?: unknown) => {
      const o = checked(options, 'tuner.button()', ['section'])
      return new InspectorButton(page, { text: String(text), section: typeof o.section === 'string' ? o.section : undefined })
    },
    addComponent: (name: string) => addComponent(page, String(name ?? '')),
    undo: () => undoRedo(page, false),
    redo: () => undoRedo(page, true),
    handle: (object: string | null, axis: string | number, tool?: string) => {
      const a = typeof axis === 'number' ? axis : AXES[String(axis).toLowerCase()]
      if (a === undefined) throw new TypeError(`Unknown axis ${String(axis)}: use 'x', 'y' or 'z'`)
      const t = tool ? String(tool).toLowerCase() : null
      if (t && !TOOLS[t]) throw new TypeError(`Unknown tool ${String(tool)}: use 'move', 'rotate', 'scale' or 'plane'`)
      return new Handle(page, object ? String(object) : null, a, t ? TOOLS[t] : null, t)
    },
    async selected(): Promise<string> {
      return selectedPath(page)
    },
    async use(name: string): Promise<string> {
      if (typeof name !== 'string' || !name.trim()) throw new TypeError("tuner.use(name) needs the Tuner's name: 'scene', a prefab path like 'Assets/Prefabs/Crate.prefab', or the name of a filtered Tuner")
      const tabs = await tunerTabList(page)
      const hit = matchTunerName(tabs, name)
      if (!hit) {
        const open = tabs.filter((t) => t.view).map((t) => `'${t.view.replace(/^@asset:/, '')}'`)
        const how = name.trim() === 'scene' ? ' tuner.open({ scene: true }) opens the scene Tuner.' : ''
        throw new Error(open.length ? `No Tuner "${name}" is open. Open Tuners: ${open.join(', ')}.${how}` : NO_TUNER)
      }
      aimed.set(page, tunerTabTarget(hit))
      const view = await tunerReady(page, hit.view)
      pinned.set(page, view)
      return view
    },
    save: () => finishEdits(page, rpc, 'save'),
    discard: () => finishEdits(page, rpc, 'discard'),
    changes: async () => {
      await tunerReady(page)
      const text = await paneOf(page).evaluate((el: any) => (typeof el.__tunerChanges === 'function' ? String(el.__tunerChanges()) : null)).catch(() => null)
      if (typeof text !== 'string') throw new Error((await troubleOf(page)) || NO_TUNER)
      return text
    },
    hierarchy: paneSpot(page, () => hierarchy(page), 'the Tuner hierarchy'),
    inspector: paneSpot(page, () => inspector(page), 'the Tuner inspector', () => troubleOf(page)),
    viewport: paneSpot(page, () => viewport(page), 'the Tuner viewport'),
    camera: cameraApi(page),
    timeline
  }
}
