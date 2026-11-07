import { routeInput, type PressedVia } from '../drift-rules'
import { eventScale } from './rect'

type Win = Window & typeof globalThis

const VIEW_ATTR = 'data-workspace-view'
const FOCUSABLE = 'input,textarea,select,button,a[href],[tabindex],[contenteditable=""],[contenteditable="true"]'
const TEXT_INPUTS = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'])
const BUTTON_BITS = [1, 4, 2]
const BUTTONS: Record<string, number> = { left: 0, middle: 1, right: 2 }

export type SynthResult = 'done' | 'hold'

export type PaneKind = 'player' | 'scene' | 'hierarchy' | 'inspector' | 'terminal' | 'panel'

export interface PanePlan {
  kind: PaneKind
  ok: boolean
  spot: { x: number; y: number } | null
  where: string
  before: string
  group: boolean
}

interface PaneRegion {
  kind: PaneKind
  region: Element
  target: HTMLElement | null
  group: Element
}

const PANE_SKIP = '[role="menu"],[role="dialog"],[role="listbox"],[data-tuner-popup],[data-tuner-window]'
const BAR_UNSAFE = 'button,input,a,[role="tab"],[data-tabbar-tab]'

export interface ViewInfo {
  active: boolean
  rect: { x: number; y: number; width: number; height: number } | null
}

function parentOf(node: Node): Element | null {
  if (node.parentElement) return node.parentElement
  const root = node.parentNode
  return root && (root as ShadowRoot).host ? (root as ShadowRoot).host : null
}

function closestDeep(el: Element | null, selector: string): Element | null {
  let cur: Element | null = el
  while (cur) {
    if (cur.matches(selector)) return cur
    cur = parentOf(cur)
  }
  return null
}

function chain(el: Element | null): Element[] {
  const out: Element[] = []
  for (let cur = el; cur; cur = parentOf(cur)) out.push(cur)
  return out
}

export class WorkspaceScope {
  private _focused: Element | null = null
  private _over: Element | null = null
  private _downTarget: Element | null = null
  private _buttons = 0
  private _allSelected = false
  private _keyWatch: ((e: Event) => void) | null = null
  private _lastKey: { key: string; target: Element | null; n: number } | null = null
  private _keySeq = 0
  holdWhy = ''

  constructor(
    private readonly _win: Win,
    readonly id: string
  ) {}

  private get _doc(): Document {
    return this._win.document
  }

  reset(): void {
    this._focused = null
    this._over = null
    this._downTarget = null
    this._buttons = 0
    this._allSelected = false
  }

  view(): Element | null {
    if (!this.id) return null
    return this._doc.querySelector(`[${VIEW_ATTR}="${this._win.CSS.escape(this.id)}"]`)
  }

  active(): boolean {
    if (!this.id) return true
    const inner = this._doc.querySelector(`[data-workspace="${this._win.CSS.escape(this.id)}"]`)
    return !!inner && inner.getAttribute('data-active') === 'true'
  }

  background(): boolean {
    return !!this.id && !this.active()
  }

  info(): ViewInfo {
    const active = this.active()
    const el = this.view()
    const r = el?.getBoundingClientRect()
    return { active, rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null }
  }

  owns(el: Element): boolean {
    if (!this.id) return true
    const view = closestDeep(el, `[${VIEW_ATTR}]`)
    return !view || view.getAttribute(VIEW_ATTR) === this.id
  }

  inside(el: Element | null): boolean {
    if (!el || !this.id) return !!el
    const view = closestDeep(el, `[${VIEW_ATTR}]`)
    return !!view && view.getAttribute(VIEW_ATTR) === this.id
  }

  hitTest(x: number, y: number): Element | null {
    let hit: Element | null = null
    let root: Document | ShadowRoot = this._doc
    for (let depth = 0; depth < 32; depth++) {
      const els: Element[] = root.elementsFromPoint(x, y)
      const next: Element | undefined = els.find((el: Element) => el !== hit && !el.hasAttribute('data-satura-drift') && (hit ? (root as ShadowRoot).contains(el) : this.inside(el)))
      if (!next) break
      hit = next
      if (!next.shadowRoot) break
      root = next.shadowRoot
    }
    return hit
  }

  private _activeEl(): Element | null {
    if (this.background()) return this._focused
    let a: Element | null = this._doc.activeElement
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement
    return a && a !== this._doc.body && a !== this._doc.documentElement ? a : null
  }

  private _regionOf(el: Element): PaneRegion | null {
    if (closestDeep(el, PANE_SKIP)) return null
    const group = closestDeep(el, '[data-pane-group]')
    if (!group) return null
    const scene = closestDeep(el, '[data-tuner-viewport-area]')
    if (scene) return { kind: 'scene', region: scene, target: scene.querySelector<HTMLElement>('[data-scene-viewport]'), group }
    const tree = closestDeep(el, '[data-tuner-hierarchy-pane]')
    if (tree) return { kind: 'hierarchy', region: tree, target: tree.querySelector<HTMLElement>('[data-scene-hierarchy]'), group }
    const insp = closestDeep(el, '[data-tuner-inspector-column]')
    if (insp) return { kind: 'inspector', region: insp, target: closestDeep(insp, '[data-tuner-pane]') as HTMLElement | null, group }
    const canvas = el.matches('canvas[data-unity-session]') ? el : el.querySelector(':scope > canvas[data-unity-session]') ?? closestDeep(el, 'canvas[data-unity-session]')
    const host = canvas?.parentElement ?? (el.querySelector(':scope > canvas[data-unity-session]') ? el : null)
    if (host) return { kind: 'player', region: host, target: host as HTMLElement, group }
    const term = closestDeep(el, '.xterm')
    if (term) return { kind: 'terminal', region: term, target: term.querySelector<HTMLElement>('textarea.xterm-helper-textarea'), group }
    return { kind: 'panel', region: group, target: null, group }
  }

  private _pane(x: number, y: number): PaneRegion | null {
    const hit = this.hitTest(x, y)
    return hit ? this._regionOf(hit) : null
  }

  private _groupActive(p: PaneRegion): boolean {
    return p.group.getAttribute('data-group-focused') === 'true'
  }

  private _paneFocused(p: PaneRegion): boolean {
    if (!this._groupActive(p)) return false
    const a = this._activeEl()
    if (!a || !a.isConnected) return false
    if (p.kind === 'inspector' && a === p.target) return true
    return chain(a).includes(p.region)
  }

  focusDesc(): string {
    const a = this._activeEl()
    if (!a || !a.isConnected) return 'nothing'
    const r = this._regionOf(a)
    const tag = a.nodeName.toLowerCase()
    if (!r) return closestDeep(a, PANE_SKIP) ? `${tag} in a popup` : `${tag} outside the panels`
    if (r.kind === 'inspector' || a.matches('[data-tuner-pane]')) return 'tuner pane'
    return r.kind === 'panel' ? `${tag} in a panel` : r.kind
  }

  private _barSpot(group: Element): { x: number; y: number; where: string } | null {
    const bar = group.querySelector('[data-tabbar]')
    if (!bar) return null
    const b = bar.getBoundingClientRect()
    if (b.width < 8 || b.height < 8) return null
    const y = b.y + b.height / 2
    const safe = (x: number): boolean => {
      const h = this.hitTest(x, y)
      return !!h && chain(h).includes(bar) && !closestDeep(h, BAR_UNSAFE)
    }
    const tabs = Array.from(bar.querySelectorAll('[data-tabbar-tab]'))
    const strip = tabs[0]?.parentElement?.getBoundingClientRect() ?? b
    const lastRight = tabs.reduce((m, t) => Math.max(m, t.getBoundingClientRect().right), strip.x)
    const room = Math.min(strip.right, b.right) - lastRight
    if (room >= 16) {
      const x = lastRight + Math.min(48, room / 2)
      if (safe(x)) return { x, y, where: 'empty tab bar' }
    }
    for (let x = b.right - 8; x > b.x; x -= 12) if (safe(x)) return { x, y, where: 'tab bar' }
    return null
  }

  panePlan(x: number, y: number): PanePlan | null {
    const p = this._pane(x, y)
    if (!p) return null
    const before = this.focusDesc()
    const a = this._activeEl()
    if (this._paneFocused(p) || (a?.isConnected && closestDeep(a, PANE_SKIP))) return { kind: p.kind, ok: true, spot: null, where: '', before, group: true }
    const group = this._groupActive(p)
    const spot = group ? null : this._barSpot(p.group)
    return { kind: p.kind, ok: false, spot: spot && { x: spot.x, y: spot.y }, where: spot?.where ?? '', before, group }
  }

  focusPane(x: number, y: number): boolean {
    const p = this._pane(x, y)
    if (!p) return false
    if (this._paneFocused(p)) return true
    if (p.target && p.target.isConnected && !chain(this._activeEl() ?? p.group).includes(p.region)) {
      if (this.background()) this.focus(p.target)
      else p.target.focus({ preventScroll: true })
    }
    return this._paneFocused(p)
  }

  watchKeys(): void {
    if (this._keyWatch) return
    this._keyWatch = (e: Event) => {
      this._lastKey = { key: (e as KeyboardEvent).key, target: e.target as Element | null, n: ++this._keySeq }
    }
    this._win.addEventListener('keydown', this._keyWatch, true)
    this._win.addEventListener('pointerdown', (e: PointerEvent) => {
      this.lastDown = { x: e.clientX, y: e.clientY, target: e.target as Element | null }
      this.dragMoves = {}
      this.dragDown = this.regionName(e.target as Element | null)
    }, true)
    this._win.addEventListener('pointermove', (e: PointerEvent) => {
      if (!e.buttons) return
      const lock = this._doc.pointerLockElement
      const k = lock ? `locked ${this.regionName(lock)}` : this.regionName(e.target as Element | null)
      this.dragMoves[k] = (this.dragMoves[k] ?? 0) + 1
    }, true)
  }

  dragMoves: Record<string, number> = {}
  dragDown = ''

  lockedBy(): string {
    const lock = this._doc.pointerLockElement
    return lock ? this.regionName(lock) : ''
  }

  releaseLock(x: number, y: number): string {
    const lock = this._doc.pointerLockElement
    if (!lock) return ''
    const p = this._pane(x, y)
    if (p && chain(lock).includes(p.region)) return ''
    const was = this.regionName(lock)
    this._doc.exitPointerLock()
    return was
  }

  lastDown: { x: number; y: number; target: Element | null } | null = null

  regionName(el: Element | null): string {
    if (!el) return 'nothing'
    const r = this._regionOf(el)
    return r ? r.kind : el.nodeName.toLowerCase()
  }

  keySeq(): number {
    return this._keySeq
  }

  keyLanded(x: number, y: number, since: number): string {
    const k = this._lastKey
    if (!k || k.n <= since) return 'no keydown reached the page'
    const p = this._pane(x, y)
    const t = k.target
    if (!p || !t) return 'ok'
    if (p.kind === 'inspector' && t === p.target) return 'ok'
    if (chain(t).includes(p.region)) return 'ok'
    const r = this._regionOf(t)
    return `went to ${r ? r.kind : t.nodeName.toLowerCase()}`
  }

  route(method: string, params: Record<string, any>, via: PressedVia, defer = false): 'cdp' | 'hold' | 'defer' | SynthResult {
    this.holdWhy = ''
    const r = routeInput({ scoped: !!this.id, active: this.active(), pressedVia: via })
    if (r === 'hold') this.holdWhy = 'started before you switched'
    if (r !== 'dom') return r
    if (defer && method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
      const target = this.hitTest(params.x, params.y)
      if (!target) return this._hold('outside the workspace')
      return closestDeep(target, '[draggable="true"]') ? this._hold('native drag') : 'defer'
    }
    return this.input(method, params)
  }

  private _hold(why: string): 'hold' {
    this.holdWhy = why
    return 'hold'
  }

  virtually<T>(fn: () => T): T {
    const win = this._win
    const protos = [win.HTMLElement.prototype, win.SVGElement.prototype]
    const saved = protos.map((p) => ({ p, focus: p.focus, blur: p.blur }))
    const self = this
    for (const p of protos) {
      p.focus = function (this: Element) {
        self.focus(this)
      }
      p.blur = function (this: Element) {
        if (self._focused === this) self.focus(null)
      }
    }
    const select = win.HTMLInputElement.prototype.select
    win.HTMLInputElement.prototype.select = function (this: HTMLInputElement) {
      self._allSelected = true
      select.call(this)
    }
    try {
      return fn()
    } finally {
      for (const s of saved) {
        s.p.focus = s.focus
        s.p.blur = s.blur
      }
      win.HTMLInputElement.prototype.select = select
    }
  }

  focus(el: Element | null): void {
    const prev = this._focused
    if (prev === el) return
    this._focused = el
    this._allSelected = false
    if (prev && prev.isConnected) {
      this._fire(prev, new this._win.FocusEvent('blur', { relatedTarget: el, composed: true }))
      this._fire(prev, new this._win.FocusEvent('focusout', { bubbles: true, relatedTarget: el, composed: true }))
    }
    if (el) {
      this._fire(el, new this._win.FocusEvent('focus', { relatedTarget: prev, composed: true }))
      this._fire(el, new this._win.FocusEvent('focusin', { bubbles: true, relatedTarget: prev, composed: true }))
    }
  }

  focused(): Element | null {
    return this._focused
  }

  input(method: string, p: Record<string, any>): SynthResult {
    if (method === 'Input.dispatchMouseEvent') return this._mouse(p)
    if (method === 'Input.dispatchKeyEvent') return this._key(p)
    if (method === 'Input.insertText') return this._insert(String(p.text ?? ''))
    return this._hold('needs the workspace in front')
  }

  private _fire<E extends Event>(target: EventTarget, ev: E): E {
    Object.defineProperty(ev, '__pwTrustedSynthetic', { value: true })
    target.dispatchEvent(ev)
    return ev
  }

  private _mods(bits: number): { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean } {
    return { altKey: !!(bits & 1), ctrlKey: !!(bits & 2), metaKey: !!(bits & 4), shiftKey: !!(bits & 8) }
  }

  private _pointerInit(p: Record<string, any>, button: number, buttons: number): PointerEventInit {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: this._win,
      clientX: p.x,
      clientY: p.y,
      screenX: p.x,
      screenY: p.y,
      button,
      buttons,
      detail: p.clickCount ?? 0,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: buttons ? 0.5 : 0,
      ...this._mods(p.modifiers ?? 0)
    }
  }

  private _hover(target: Element | null, p: Record<string, any>): void {
    const prev = this._over
    if (prev === target) return
    this._over = target
    const W = this._win
    const init = (bubbles: boolean, related: Element | null): PointerEventInit => ({
      ...this._pointerInit(p, -1, this._buttons),
      bubbles,
      cancelable: bubbles,
      relatedTarget: related
    })
    const oldChain = chain(prev)
    const newChain = chain(target)
    if (prev && prev.isConnected) {
      this._fire(prev, new W.PointerEvent('pointerout', init(true, target)))
      this._fire(prev, new W.MouseEvent('mouseout', init(true, target)))
      for (const el of oldChain) {
        if (newChain.includes(el)) break
        this._fire(el, new W.PointerEvent('pointerleave', init(false, target)))
        this._fire(el, new W.MouseEvent('mouseleave', init(false, target)))
      }
    }
    if (target) {
      this._fire(target, new W.PointerEvent('pointerover', init(true, prev)))
      this._fire(target, new W.MouseEvent('mouseover', init(true, prev)))
      const enter = newChain.filter((el) => !oldChain.includes(el)).reverse()
      for (const el of enter) {
        this._fire(el, new W.PointerEvent('pointerenter', init(false, prev)))
        this._fire(el, new W.MouseEvent('mouseenter', init(false, prev)))
      }
    }
  }

  private _mouse(raw: Record<string, any>): SynthResult {
    const W = this._win
    const target = this.hitTest(raw.x, raw.y)
    const k = eventScale(target ?? this._downTarget)
    const p = k === 1 ? raw : { ...raw, x: raw.x / k, y: raw.y / k }
    if (p.type === 'mousePressed' && !target) return this._hold('outside the workspace')
    if (p.type === 'mousePressed' && closestDeep(target!, '[draggable="true"]')) return this._hold('native drag')
    if (p.type === 'mouseWheel') {
      if (!target) return this._hold('outside the workspace')
      const ev = this._fire(
        target,
        new W.WheelEvent('wheel', { ...this._pointerInit(p, -1, this._buttons), deltaX: p.deltaX ?? 0, deltaY: p.deltaY ?? 0, deltaMode: 0 })
      )
      if (!ev.defaultPrevented) this._scroll(target, p.deltaX ?? 0, p.deltaY ?? 0)
      return 'done'
    }
    this._hover(target, p)
    const button = BUTTONS[p.button] ?? 0
    if (p.type === 'mouseMoved') {
      if (!target) return 'done'
      this._fire(target, new W.PointerEvent('pointermove', this._pointerInit(p, -1, this._buttons)))
      this._fire(target, new W.MouseEvent('mousemove', this._pointerInit(p, 0, this._buttons)))
      return 'done'
    }
    if (p.type === 'mousePressed' && target) {
      const first = this._buttons === 0
      this._buttons |= BUTTON_BITS[button]
      if (first) this._fire(target, new W.PointerEvent('pointerdown', this._pointerInit(p, button, this._buttons)))
      const down = this._fire(target, new W.MouseEvent('mousedown', this._pointerInit(p, button, this._buttons)))
      if (!down.defaultPrevented && button === 0) {
        const f = closestDeep(target, FOCUSABLE)
        this.focus(f && this.inside(f) && !(f as HTMLButtonElement).disabled ? f : null)
      }
      this._downTarget = target
      return 'done'
    }
    if (p.type === 'mouseReleased') {
      this._buttons &= ~BUTTON_BITS[button]
      const at = target ?? this._downTarget
      if (!at) return 'done'
      if (this._buttons === 0) this._fire(at, new W.PointerEvent('pointerup', this._pointerInit(p, button, 0)))
      this._fire(at, new W.MouseEvent('mouseup', this._pointerInit(p, button, this._buttons)))
      const down = this._downTarget
      this._downTarget = null
      const common = down ? chain(down).find((el) => chain(at).includes(el)) ?? null : null
      if (!common) return 'done'
      if (button === 0) {
        this._fire(common, new W.PointerEvent('click', this._pointerInit(p, 0, this._buttons)))
        if ((p.clickCount ?? 1) === 2) this._fire(common, new W.MouseEvent('dblclick', this._pointerInit(p, 0, this._buttons)))
      } else {
        this._fire(common, new W.PointerEvent('auxclick', this._pointerInit(p, button, this._buttons)))
        if (button === 2) this._fire(common, new W.PointerEvent('contextmenu', this._pointerInit(p, button, this._buttons)))
      }
      return 'done'
    }
    return 'done'
  }

  private _scroll(from: Element, dx: number, dy: number): void {
    for (let el: Element | null = from; el && this.inside(el); el = parentOf(el)) {
      const s = this._win.getComputedStyle(el)
      const canY = dy !== 0 && /(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight
      const canX = dx !== 0 && /(auto|scroll|overlay)/.test(s.overflowX) && el.scrollWidth > el.clientWidth
      if (canX || canY) {
        el.scrollBy({ left: canX ? dx : 0, top: canY ? dy : 0, behavior: 'instant' as ScrollBehavior })
        return
      }
    }
  }

  private _editable(): HTMLInputElement | HTMLTextAreaElement | null {
    const el = this._focused
    if (!el || !el.isConnected || !this.inside(el)) return null
    if (closestDeep(el, '.xterm')) return null
    const tag = el.nodeName.toLowerCase()
    if (tag === 'textarea') return el as HTMLTextAreaElement
    if (tag === 'input' && TEXT_INPUTS.has((el as HTMLInputElement).type.toLowerCase())) return el as HTMLInputElement
    return null
  }

  private _edit(el: HTMLInputElement | HTMLTextAreaElement, inputType: string, text: string): void {
    const W = this._win
    const before = this._fire(el, new W.InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType, data: text || null }))
    if (before.defaultPrevented) return
    const value = el.value
    let start = el.selectionStart
    let end = el.selectionEnd
    if (start === null || end === null) {
      start = this._allSelected ? 0 : value.length
      end = value.length
    }
    let next: string
    let caret: number
    if (inputType === 'deleteContentBackward' && start === end) {
      next = value.slice(0, Math.max(0, start - 1)) + value.slice(end)
      caret = Math.max(0, start - 1)
    } else if (inputType === 'deleteContentForward' && start === end) {
      next = value.slice(0, start) + value.slice(end + 1)
      caret = start
    } else {
      next = value.slice(0, start) + text + value.slice(end)
      caret = start + text.length
    }
    this._allSelected = false
    const proto = el.nodeName.toLowerCase() === 'textarea' ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, next)
    try {
      el.setSelectionRange(caret, caret)
    } catch {
    }
    this._fire(el, new W.InputEvent('input', { bubbles: true, composed: true, inputType, data: text || null }))
  }

  private _insert(text: string): SynthResult {
    const el = this._editable()
    if (!el) return this._hold('no text field has focus')
    this._edit(el, 'insertText', text)
    return 'done'
  }

  private _key(p: Record<string, any>): SynthResult {
    const el = this._focused
    if (!el || !el.isConnected || !this.inside(el)) return this._hold('nothing in the workspace has focus')
    if (closestDeep(el, '.xterm')) return this._hold('terminal input')
    if ((el as HTMLElement).isContentEditable) return this._hold('rich text field')
    const key = String(p.key ?? '')
    const mods = p.modifiers ?? 0
    const commands: string[] = Array.isArray(p.commands) ? p.commands : []
    const shortcut = (mods & 6) !== 0 && !['Control', 'Meta', 'Alt', 'Shift'].includes(key)
    const edit = this._editable()
    if (shortcut && !(edit && commands.length > 0 && commands.every((c) => c === 'selectAll'))) return this._hold('keyboard shortcut')
    const W = this._win
    const init: KeyboardEventInit & { keyCode?: number; which?: number } = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: this._win,
      key,
      code: String(p.code ?? ''),
      location: p.location ?? 0,
      repeat: !!p.autoRepeat,
      keyCode: p.windowsVirtualKeyCode ?? 0,
      which: p.windowsVirtualKeyCode ?? 0,
      ...this._mods(mods)
    }
    if (p.type === 'keyUp') {
      const up = this._fire(el, new W.KeyboardEvent('keyup', init))
      if (!up.defaultPrevented && key === ' ' && el.nodeName.toLowerCase() === 'button') this._activate(el)
      return 'done'
    }
    const down = this._fire(el, new W.KeyboardEvent('keydown', init))
    if (down.defaultPrevented) return 'done'
    if (edit && commands.includes('selectAll')) {
      edit.select()
      this._allSelected = true
      return 'done'
    }
    const text = typeof p.text === 'string' ? p.text : ''
    if (text && text !== '\r') {
      const press = this._fire(el, new W.KeyboardEvent('keypress', { ...init, charCode: text.charCodeAt(0) }))
      if (!press.defaultPrevented && edit) this._edit(edit, 'insertText', text)
      return 'done'
    }
    if (key === 'Enter') {
      this._fire(el, new W.KeyboardEvent('keypress', { ...init, charCode: 13 }))
      if (edit && edit.nodeName.toLowerCase() === 'textarea') this._edit(edit, 'insertLineBreak', '\n')
      else if (!edit && ['button', 'a'].includes(el.nodeName.toLowerCase())) this._activate(el)
      return 'done'
    }
    if (edit && key === 'Backspace') this._edit(edit, 'deleteContentBackward', '')
    else if (edit && key === 'Delete') this._edit(edit, 'deleteContentForward', '')
    return 'done'
  }

  private _activate(el: Element): void {
    const r = el.getBoundingClientRect()
    this._fire(el, new this._win.PointerEvent('click', this._pointerInit({ x: r.x + r.width / 2, y: r.y + r.height / 2, clickCount: 1 }, 0, 0)))
  }
}
