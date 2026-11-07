import { BrowserWindow, type NativeImage, type WebContents } from 'electron'
import injectedSource from './page/injected.ts?iife'
import { DebuggerSession, type CRSession } from './playwright/server/cdp'
import { ElementHandle } from './playwright/server/dom'
import { Page, type InputInstrumentation } from './playwright/server/page'
import { ProgressController, type PauseClock, type Progress } from './playwright/server/progress'
import { isStaleContextError, type JSHandle } from './playwright/server/js'
import type * as types from './playwright/server/types'
import { USER_IDLE_MS, type UserGate, type InputEcho } from './user-gate'
import { readyTunerPane, tunerNotReadyMessage, tunerStillLoadingMessage, type TunerPaneState } from '@shared/tuner-ready'
import { ARRIVAL_SLACK_MS, DriftBudget, WAIT_LINES, capFor, failLine, inOrder, typingDelay, userInputCounts, waitLine, waitWhy, type PressedVia, type ViewState } from './drift-rules'
import type { PanePlan } from './page/scope'
import { DriftSession, type AskPoll, type AskShown, type MoveResult, type PointShown } from './drift-session'
import { parseSelector, type ParsedSelector } from './playwright/isomorphic/selectorParser'
import { fracOf } from './page/anchor'
import type { AimSample, LineShown, SayStats, ScrollResult, Where } from './page/drift'
import { censusTrack } from '@shared/census'
import type { DriftSpot, PhoneDriftCue } from '@shared/drift-spot'
import { phoneDriftOn, sendPhoneDrift, takePhoneDriftAnswer } from './phone-drift'
import { bubbleMs, bubbleText } from './page/bubble'

export const DEFAULT_ACTION_MS = 15_000
const GRAB_LOG_MS = 400
const MAX_SHOT_WIDTH = 1600
const WORLD = '__satura_exec_utility__'
const VIEW_POLL_MS = 250
const HOLD_POLL_MS = 120
const LOOK_EVERY_MS = 80
const PUZZLED_AFTER_MS = 300
const DRIVEN_WAIT_MS = 400
const FREE_LEFT_MS = 1e9
const SETTLE_MS = 600
const GESTURE_SLACK_MS = 900
const GESTURE_ROUNDS = 4
const WHEEL_STEP_PX = 60
const WHEEL_STEPS = 6
const WHEEL_GAP_MS = 16
const TUNER_POLL_MS = 150
const SCENE_WAIT_MS = 180_000
const TUNER_FREE = new Set(['count', 'isVisible', 'isHidden'])
const PHONE_SPOT_MS = 1000
const PHONE_ARRIVE_MS = 700
const PHONE_ASK_RESEND_MS = 3000
const HOLD = Symbol('hold')
const DRAG = Symbol('drag')

export const DRIFT_LINES = {
  typing: 'typing',
  dragging: 'dragging',
  scrolling: 'scrolling',
  loading: 'waiting for the scene to load'
} as const

const POINTER_ACTS = new Set(['click', 'dblclick', 'hover', 'dragAndDrop'])
const FOCUS_TRIES = 5
const KEY_ACTS = new Set(['fill', 'type', 'press', 'selectText', 'focus', 'blur'])
const PUZZLE_ACTS = new Set([...POINTER_ACTS, ...KEY_ACTS, 'waitFor', 'scrollIntoViewIfNeeded'])
const PLEASED = new Set(['click', 'dblclick', 'dragAndDrop', 'fill', 'type', 'press'])
const LABELED = new Set(['click', 'dblclick'])
const CHANGES_UI = new Set(['click', 'dblclick', 'dragAndDrop', 'fill', 'type', 'press', 'selectText', 'mouse.down', 'mouse.click', 'mouse.wheel', 'keyboard.down', 'keyboard.press', 'keyboard.type', 'keyboard.insertText'])

export interface Shot {
  mime: string
  data: Buffer
  width: number
  height: number
}

type Options = Record<string, any>

function pick(options: Options, keys: string[]): Options {
  const out: Options = {}
  for (const k of keys) if (options[k] !== undefined) out[k] = options[k]
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const POINTER_KEYS = ['force', 'trial', 'modifiers', 'position', 'noWaitAfter']
const CLICK_KEYS = [...POINTER_KEYS, 'button', 'clickCount', 'delay']

interface Shared {
  session: DebuggerSession
  refs: number
}

const sessions = new Map<number, Shared>()
censusTrack('driver.sessions', sessions)

function acquireSession(wc: WebContents): DebuggerSession {
  let shared = sessions.get(wc.id)
  if (!shared || shared.session.closed) {
    shared = { session: new DebuggerSession(wc.debugger), refs: 0 }
    sessions.set(wc.id, shared)
  }
  shared.refs++
  return shared.session
}

async function releaseSession(wc: WebContents, session: DebuggerSession): Promise<void> {
  const shared = sessions.get(wc.id)
  if (!shared || shared.session !== session) {
    session.dispose()
    return
  }
  if (--shared.refs > 0) return
  sessions.delete(wc.id)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
  session.dispose()
}

class InputSession implements CRSession {
  private _subs: [string, (params: any) => void][] = []

  constructor(
    private _inner: CRSession,
    private _driver: WindowDriver
  ) {}

  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (!method.startsWith('Input.') || method === 'Input.setInterceptDrags') return this._inner.send(method, params)
    return this._driver.dispatchInput(method, params ?? {}, () => this._inner.send(method, params))
  }

  _sendMayFail(method: string, params?: Record<string, unknown>): Promise<any> {
    return this.send(method, params).catch(() => undefined)
  }

  on(event: string, listener: (params: any) => void): void {
    this._subs.push([event, listener])
    this._inner.on(event, listener)
  }

  off(event: string, listener: (params: any) => void): void {
    this._inner.off(event, listener)
  }

  detach(): void {
    for (const [event, listener] of this._subs) this._inner.off(event, listener)
    this._subs = []
  }
}

export interface DriverOptions {
  name: string
  signal: AbortSignal
  log: (line: string) => void
  now?: () => number
  workspace?: string
  budget?: DriftBudget
  run?: number
  drive?: (on: boolean) => Promise<unknown>
  spotlight?: () => boolean
  drift?: boolean
  bringFront?: () => Promise<unknown>
}

function parsedOf(selector: unknown): ParsedSelector | null {
  if (typeof selector !== 'string' || !selector) return null
  try {
    return parseSelector(selector)
  } catch {
    return null
  }
}

function describeInput(method: string, params: Options): string {
  if (method === 'Input.dispatchMouseEvent') return `${params.type} at (${Math.round(params.x)}, ${Math.round(params.y)})`
  if (method === 'Input.dispatchKeyEvent') return `${params.type} ${params.key}`
  if (method === 'Input.insertText') return 'text input'
  return method
}

interface SayShown {
  text: string
  travel: number
  read: number
  shown: boolean
}

interface Waiting {
  meta: Record<string, unknown>
  reason: string
  since: number
  shown: string
  target: unknown
  timer?: ReturnType<typeof setTimeout>
}

export class WindowDriver implements PauseClock {
  readonly gate: UserGate
  readonly session: DriftSession
  private _session: DebuggerSession
  private _input: InputSession
  private _page: Page
  private _disposed = false
  private _closing = false
  private _offInput: () => void
  private readonly _workspace: string
  private readonly _budget: DriftBudget
  private readonly _now: () => number
  private _view: ViewState
  private _viewTimer: ReturnType<typeof setInterval> | undefined
  private _mouseVia: PressedVia = null
  private _keyVia: PressedVia = null
  private _buttons = 0
  private _keys = new Set<string>()
  private _driftMs = 0
  private _stepping = false
  private _holdMs = 0
  private _holding = false
  private _lookAt = 0
  private _deferred: Options | null = null
  private _replay: Options | null = null
  private readonly _inOrder = inOrder()
  private _zoom = 1
  private _wait: Waiting | null = null
  private _lastReason: string | null = null
  private _show: boolean
  private readonly _asked: boolean
  private _phoneSeq = 0
  private readonly _phoneRun: number

  constructor(
    readonly wc: WebContents,
    private _opts: DriverOptions
  ) {
    const now = _opts.now ?? Date.now
    this._now = now
    this._workspace = _opts.workspace ?? ''
    this._asked = _opts.drift !== false
    this._show = this._asked
    this._phoneRun = Math.floor(Math.random() * 1e9)
    this._budget = _opts.budget ?? new DriftBudget(now)
    this._view = { scoped: !!this._workspace, active: true, rect: null }
    this.session = new DriftSession({
      now,
      sleep,
      log: (line) => this._log(line),
      window: wc.id,
      workspace: this._workspace,
      inFront: () => !this._view.scoped || this._view.active,
      resume: () => void this._drift('resume')
    })
    this.gate = this.session.gate
    this._session = acquireSession(wc)
    this._input = new InputSession(this._session, this)
    const instrumentation: InputInstrumentation = {
      onBeforeInputAction: async (target, metadata, point, box) => {
        this._settled(metadata)
        await this.gate.idle(_opts.signal)
        await this._approach(target, metadata, point, box)
      },
      onActionWaiting: (target, metadata, reason) => this._waiting(target, metadata, reason),
      onScrollIntoView: (handle, rect) => this._scrollInto(handle, rect)
    }
    const world = this._workspace ? `${WORLD}:${this._workspace}` : WORLD
    this._page = new Page(this._input, injectedSource, instrumentation, process.platform === 'darwin', world)
    const onKey = (_e: unknown, input: { type: string; key: string }): void => {
      if (input.type !== 'keyDown' || !userInputCounts(this._view, { kind: 'key' })) return
      if (this.gate.noteUserInput({ kind: 'key', key: input.key })) {
        this.session.userSeen('key input')
        this._userSeen(null)
      }
    }
    const onMouse = (_e: unknown, mouse: { type: string; x: number; y: number }): void => {
      const at = { x: mouse.x / this._zoom, y: mouse.y / this._zoom }
      if (!userInputCounts(this._view, { kind: 'mouse', ...at })) return
      if (this.gate.noteUserInput({ kind: 'mouse', ...at })) {
        this.session.userSeen(mouse.type)
        this._userSeen(at)
      }
    }
    wc.on('before-input-event', onKey as never)
    wc.on('before-mouse-event', onMouse as never)
    this._offInput = () => {
      wc.removeListener('before-input-event', onKey as never)
      wc.removeListener('before-mouse-event', onMouse as never)
    }
  }

  get paused(): boolean {
    return this.gate.paused || this._holding || this.session.asking
  }

  pausedMs(): number {
    return this.gate.pausedMs() + this._driftMs + this._holdMs + this.session.askedMs()
  }

  private _log(line: string): void {
    this._opts.log(this._opts.run !== undefined ? `run ${this._opts.run}: ${line}` : line)
  }

  async start(): Promise<void> {
    await this._session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    const inj = await this._injected().catch(() => null)
    await inj?.evaluate((i: any) => i.drift.takeEvents()).catch(() => null)
    const bound = (await inj
      ?.evaluate((i: any, a: { w: string; n: string; d: boolean; s: boolean }) => i.bind(a.w, a.n, a.d, a.s), { w: this._workspace, n: this._opts.name, d: this._opts.spotlight?.() ?? true, s: this._show })
      .catch(() => null)) as { found: boolean; active: boolean } | null
    if (this._workspace) {
      this._view.active = bound?.active ?? true
      this.session.view(this._view.active, true)
      this._log(`${this._show ? 'drift' : 'script'} bound to workspace ${this._workspace}${bound?.found === false ? ' (not found in this window)' : ''}, ${this._view.active ? 'in front' : 'in the background'}`)
      await this._opts.drive?.(true)
      const until = this._now() + DRIVEN_WAIT_MS
      while (this._now() < until) {
        const ok = await inj?.evaluate((i: any) => i.driven()).catch(() => true)
        if (ok !== false) break
        await sleep(30)
      }
    }
    if (!this._closing) this._viewTimer = setInterval(() => void this._viewInfo(), VIEW_POLL_MS)
  }

  private async _viewInfo(): Promise<{ active: boolean } | null> {
    if (this._disposed) return null
    try {
      this._zoom = this.wc.getZoomFactor() || 1
    } catch {
      this._zoom = 1
    }
    const inj = await this._injected().catch(() => null)
    const r = (await inj
      ?.evaluate((i: any) => ({ ...i.scope.info(), ...i.drift.takeEvents(), user: i.watch.take() }))
      .catch(() => null)) as {
      active: boolean
      rect: ViewState['rect']
      fired: string[]
      said: string[]
      user: { kind: 'mouse' | 'key'; type: string; x?: number; y?: number; t: number } | null
    } | null
    if (!r) return null
    this.session.events(r.fired, r.said)
    if (!this._view.scoped) return r
    this._setView(r.active, r.rect)
    if (r.user && r.active) {
      this.session.userAt(r.user.t, r.user.type)
      this._userSeen(r.user.kind === 'mouse' ? { x: r.user.x ?? 0, y: r.user.y ?? 0 } : null)
    }
    return r
  }

  private _setView(active: boolean, rect?: ViewState['rect']): void {
    this._view = { scoped: true, active, rect: rect === undefined ? this._view.rect : rect }
    this.session.view(active)
  }

  private _userSeen(at: { x: number; y: number } | null): void {
    const now = this._now()
    if (now - this._lookAt < LOOK_EVERY_MS) return
    this._lookAt = now
    void this._drift<boolean>('user', at?.x ?? null, at?.y ?? null).then((startled) => {
      if (startled) this._log('drift startled: you used this workspace, the script waits')
    })
  }

  private async _wake(why: string): Promise<void> {
    if (this._show || this._disposed) return
    this._show = true
    this._log(`drift appears: the script ${why}`)
    const inj = await this._injected().catch(() => null)
    await inj?.evaluate((i: any, n: string) => i.drift.begin(n), this._opts.name).catch(() => {})
  }

  private async _approach(target: unknown, metadata: Record<string, unknown>, point?: types.Point, box?: types.Rect): Promise<void> {
    if (!this._show && metadata.free !== true && CHANGES_UI.has(String(metadata.action ?? ''))) await this._wake(`changes the UI (${String(metadata.action)})`)
    if (this._disposed || this._buttons > 0 || !this._show) return
    const action = String(metadata.action ?? '')
    if (action === 'mouse.wheel') return
    const el = target instanceof ElementHandle ? target : null
    let A = point
    let B: types.Rect | null = box ?? null
    let line = ''
    if (!A && el && KEY_ACTS.has(action)) {
      const b = await this._page.delegate.getBoundingBox(el).catch(() => null)
      if (b) {
        B = b
        A = { x: b.x + Math.max(b.width / 2, b.width - 12), y: b.y + b.height / 2 }
      }
      if (action === 'fill' || action === 'type') line = DRIFT_LINES.typing
    }
    if (!A) return
    if (action === 'dragAndDrop') line = DRIFT_LINES.dragging
    if ((action === 'scroll' || action === 'mouse.wheel') && !this._asked) line = DRIFT_LINES.scrolling
    const free = metadata.free === true
    const left = free ? FREE_LEFT_MS : this._budget.left
    const frac = fracOf(B, A)
    const parsed = parsedOf(metadata.selector)
    const args = { x: A.x, y: A.y, box: B, left, line, label: !!el && LABELED.has(action) && !!point, frac, parsed }
    const t0 = this._now()
    const call = el
      ? el.evaluateInUtility(([i, node, a]: [any, any, typeof args]) => {
          const line = a.label ? i.label(node) || a.line : a.line
          return i.drift.approach({ ...a, line, target: i.anchorFor(node, a.frac, a.parsed) })
        }, args)
      : this._injected().then((i) => i.evaluate((inj: any, a: typeof args) => inj.drift.approach(a), args))
    const res = (await Promise.race([
      Promise.resolve(call).catch(() => null),
      sleep(capFor(true, left) + ARRIVAL_SLACK_MS).then(() => null)
    ])) as MoveResult | 'error:notconnected' | null
    const waited = Math.max(0, this._now() - t0)
    if (!free) this._budget.charge(waited)
    this._driftMs += waited
    const r = res && typeof res === 'object' ? res : null
    this.session.move(action, A, r, waited, this._budget.left)
    this.session.anchor(action || 'input', r?.where, A)
  }

  private _waiting(target: unknown, metadata: Record<string, unknown>, reason: string): void {
    if (this._disposed || !PUZZLE_ACTS.has(String(metadata.action ?? ''))) return
    const now = this._now()
    let w = this._wait
    if (!w || w.meta !== metadata) {
      if (w) this._settled(w.meta)
      w = this._wait = { meta: metadata, reason, since: now, shown: '', target }
    }
    w.reason = reason
    w.target = target
    this._lastReason = reason
    const due = w.since + PUZZLED_AFTER_MS - now
    if (due <= 0) void this._puzzle(w)
    else if (!w.timer) w.timer = setTimeout(() => void this._puzzle(w), due)
  }

  private _settled(metadata: Record<string, unknown>): void {
    const w = this._wait
    if (!w || w.meta !== metadata) return
    clearTimeout(w.timer)
    this._wait = null
  }

  private async _puzzle(w: Waiting): Promise<void> {
    w.timer = undefined
    if (this._wait !== w || this._disposed || !this._show) return
    const line = waitLine(w.reason)
    if (w.shown === line) return
    w.shown = line
    const el = w.target instanceof ElementHandle ? w.target : null
    const box = el ? await this._page.delegate.getBoundingBox(el).catch(() => null) : null
    if (this._wait !== w || this._disposed || !this._show) return
    const args_ = { box, line, parsed: parsedOf(w.meta.selector) }
    const shown = el
      ? ((await el
          .evaluateInUtility(([i, node, a]: [any, any, typeof args_]) => i.drift.puzzled(a.box, a.line, i.anchorFor(node, null, a.parsed)), args_)
          .catch(() => null)) as boolean | null)
      : await this._drift<boolean>('puzzled', box, line)
    if (shown) this._log(`drift puzzled: ${waitWhy(w.reason)}, says "${line}"`)
  }

  dispatchInput<T>(method: string, params: Record<string, any>, send: () => Promise<T>): Promise<T> {
    return this._inOrder(() => this._dispatch(method, params, send))
  }

  private async _dispatch<T>(method: string, params: Record<string, any>, send: () => Promise<T>): Promise<T> {
    const key = method === 'Input.dispatchKeyEvent' || method === 'Input.insertText'
    const mouse = method === 'Input.dispatchMouseEvent'
    if (!this._show && (key || (mouse && (params.type === 'mousePressed' || params.type === 'mouseWheel')))) await this._wake('sends input to the window')
    if (mouse && params.type === 'mouseWheel' && this._show && this._buttons === 0) return this._wheel(method, params, send)
    return this._send(method, params, send)
  }

  private async _wheel<T>(method: string, params: Record<string, any>, send: () => Promise<T>): Promise<T> {
    let dx = Number(params.deltaX) || 0
    let dy = Number(params.deltaY) || 0
    for (let round = 0; round < GESTURE_ROUNDS && !this._disposed; round++) {
      await this.gate.idle(this._opts.signal)
      if (this._opts.signal.aborted) throw new Error('The script was stopped.')
      const r = await this._gesture({ kind: 'wheel', x: params.x, y: params.y, dx, dy }, null)
      if (!r || r.mode !== 'thumb') {
        if (round > 0) return {} as T
        break
      }
      this._gestureLog('wheel', r)
      if (r.gone || !r.interrupted) return {} as T
      dx = r.remaining.dx
      dy = r.remaining.dy
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return {} as T
      this._log('drift scroll waits for you, then goes on from where the list is now')
    }
    return this._wheelSteps(method, params, send)
  }

  private async _wheelSteps<T>(method: string, params: Record<string, any>, send: () => Promise<T>): Promise<T> {
    const dx = Number(params.deltaX) || 0
    const dy = Number(params.deltaY) || 0
    const n = Math.max(1, Math.min(WHEEL_STEPS, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / WHEEL_STEP_PX)))
    if (n === 1) return this._send(method, params, send)
    await this._approach(this._page, { action: 'scroll' }, { x: params.x, y: params.y })
    this._log(`drift wheel: no scrollbar under the pointer, ${n} wheel steps`)
    let out = {} as T
    for (let i = 0; i < n; i++) {
      const p = { ...params, deltaX: dx / n, deltaY: dy / n }
      out = await this._send(method, p, () => this._session.send(method, p) as Promise<T>)
      if (i < n - 1) await sleep(WHEEL_GAP_MS)
    }
    return out
  }

  private async _scrollInto(handle: ElementHandle, rect?: types.Rect): Promise<void> {
    if (!this._show || this._disposed || this._buttons > 0) return
    for (let round = 0; round < GESTURE_ROUNDS && !this._disposed; round++) {
      await this.gate.idle(this._opts.signal)
      if (this._opts.signal.aborted) return
      const r = await this._gesture({ kind: 'into', rect: rect ?? null }, handle)
      if (!r || r.mode !== 'thumb') return
      this._gestureLog('scroll into view', r)
      if (r.gone || !r.interrupted) return
      this._log('drift scroll waits for you, then goes on from where the list is now')
    }
  }

  private async _gesture(a: Record<string, unknown>, handle: ElementHandle | null): Promise<ScrollResult | null> {
    const left = this._budget.left
    const args = { ...a, left, line: this._asked ? '' : DRIFT_LINES.scrolling }
    const t0 = this._now()
    const call = handle
      ? handle.evaluateInUtility(([i, node, x]: [any, any, typeof args]) => i.drift.scroll(x, node), args)
      : this._injected().then((i) => i.evaluate((inj: any, x: typeof args) => inj.drift.scroll(x, null), args))
    const res = (await Promise.race([Promise.resolve(call).catch(() => null), sleep(capFor(true, left) + GESTURE_SLACK_MS).then(() => null)])) as ScrollResult | 'error:notconnected' | null
    const r = res && typeof res === 'object' ? res : null
    if (r?.mode === 'thumb') {
      const waited = Math.max(0, this._now() - t0)
      this._budget.charge(waited)
      this._driftMs += waited
    }
    return r
  }

  private _gestureLog(what: string, r: ScrollResult): void {
    const extra = [r.native ? '' : 'drawn thumb', r.outside ? `followed ${r.outside} outside changes` : '', r.interrupted ? 'interrupted by you' : '', r.gone ? 'the list went away' : ''].filter(Boolean).join(', ')
    this._log(`drift ${what}: dragged the ${r.axis === 'x' ? 'horizontal' : 'vertical'} thumb ${r.moved}px in ${r.ms}ms (reach ${r.travel}ms, ${r.frames} frames, max step ${r.maxStep}px${extra ? `, ${extra}` : ''})`)
  }

  private async _send<T>(method: string, params: Record<string, any>, send: () => Promise<T>): Promise<T> {
    let echo: InputEcho | null = null
    if (method === 'Input.dispatchMouseEvent') echo = { kind: 'mouse', x: params.x, y: params.y }
    else if (method === 'Input.dispatchKeyEvent') echo = { kind: 'key', key: params.key }
    const key = method === 'Input.dispatchKeyEvent' || method === 'Input.insertText'
    const mouse = method === 'Input.dispatchMouseEvent'
    while (true) {
      let why = ''
      const out = await this.gate.dispatch<T | typeof HOLD | typeof DRAG>(
        echo,
        async () => {
          if (mouse && this._replay) {
            const press = this._replay
            this._replay = null
            await this._session.send('Input.dispatchMouseEvent', press)
            this._mouseVia = 'cdp'
            this._log(`input mousePressed at (${Math.round(press.x)}, ${Math.round(press.y)}) via CDP`)
          } else if (this._deferred) {
            const press = this._deferred
            this._deferred = null
            if (mouse && params.type === 'mouseMoved') {
              this._replay = press
              return DRAG
            }
            await this._route('Input.dispatchMouseEvent', press, 'dom')
            this._log(`input mousePressed at (${Math.round(press.x)}, ${Math.round(press.y)}) via DOM events`)
          }
          const pressing = mouse && params.type === 'mousePressed'
          const route = await this._route(method, params, key ? this._keyVia : this._mouseVia, pressing)
          if (route.startsWith('hold')) {
            why = route.slice(5) || 'needs the workspace in front'
            return HOLD
          }
          this._visual(method, params)
          if (route === 'defer') {
            this._deferred = { ...params }
            this._track(method, params, 'dom', true)
            return {} as T
          }
          const result = route === 'done' ? ({} as T) : await send()
          this._track(method, params, route === 'done' ? 'dom' : 'cdp')
          if (mouse && params.type === 'mousePressed') void this._pressProbe(params.x, params.y)
          if (mouse && params.type === 'mouseReleased') void this._dragProbe()
          return result
        },
        this._opts.signal
      )
      if (out === HOLD) await this._holdUntilActive(describeInput(method, params), why)
      else if (out === DRAG) await this._holdUntilActive('a drag', 'drags only work in front')
      else return out as T
    }
  }

  private async _route(method: string, params: Options, via: PressedVia, defer = false): Promise<string> {
    if (!this._workspace) return 'cdp'
    const inj = await this._injected().catch(() => null)
    const r = (await inj
      ?.evaluate((i: any, a: { m: string; p: Options; v: PressedVia; d: boolean }) => i.route(a.m, a.p, a.v, a.d), { m: method, p: params, v: via, d: defer })
      .catch(() => null)) as string | null
    if (r === 'done' || r === 'defer') this._setView(false)
    return r ?? 'cdp'
  }

  private _visual(method: string, params: Options): void {
    if (method !== 'Input.dispatchMouseEvent') return
    if (params.type === 'mousePressed') void this._drift('press', params.x, params.y)
    else if (params.type === 'mouseReleased') void this._drift('release')
    else if (params.type === 'mouseMoved' && this._buttons > 0) void this._drift('drag', params.x, params.y)
    else if (params.type === 'mouseWheel') void this._drift('stroke', params.deltaX ?? 0, params.deltaY ?? 0)
  }

  private _track(method: string, params: Options, via: 'cdp' | 'dom', quiet = false): void {
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mousePressed') {
        this._buttons++
        this._mouseVia = via
        if (!quiet) this._log(`input mousePressed at (${Math.round(params.x)}, ${Math.round(params.y)}) via ${via === 'cdp' ? 'CDP' : 'DOM events'}`)
      } else if (params.type === 'mouseReleased') {
        this._buttons = Math.max(0, this._buttons - 1)
        if (this._buttons === 0) this._mouseVia = null
      } else if (params.type === 'mouseWheel') {
        this._log(`input wheel via ${via === 'cdp' ? 'CDP' : 'DOM events'}`)
      }
    } else if (method === 'Input.dispatchKeyEvent') {
      if (params.type === 'keyUp') this._keys.delete(String(params.key))
      else {
        this._keys.add(String(params.key))
        this._keyVia = via
      }
      if (this._keys.size === 0) this._keyVia = null
    } else if (method === 'Input.insertText') {
      this._log(`input text via ${via === 'cdp' ? 'CDP' : 'DOM events'}`)
    }
  }

  private async _front(what: string, why: string): Promise<boolean> {
    if (!this._opts.bringFront) return false
    this._log(`bringing workspace ${this._workspace} to the front for ${what} (${why}): the caller is outside the app`)
    await this._opts.bringFront().catch((e: unknown) => this._log(`could not bring the workspace to the front: ${(e as Error)?.message ?? e}`))
    for (let i = 0; i < 20 && !this._opts.signal.aborted; i++) {
      if ((await this._viewInfo())?.active) return true
      await sleep(100)
    }
    return false
  }

  private async _holdUntilActive(what: string, why: string): Promise<void> {
    const t0 = this._now()
    if (this._opts.bringFront && (await this._front(what, why))) return
    this._holding = true
    this._log(`holding ${what} (${why}): it needs workspace ${this._workspace} in front, waiting for you`)
    void this._drift('hold', true)
    try {
      while (!this._opts.signal.aborted && !this._disposed) {
        const info = await this._viewInfo()
        if (info?.active) break
        await sleep(HOLD_POLL_MS)
      }
    } finally {
      this._holding = false
      this._holdMs += this._now() - t0
      this.session.held(what, why, this._now() - t0)
      void this._drift('hold', false)
    }
    if (this._opts.signal.aborted || this._disposed) throw new Error('The script was stopped.')
    this._log(`resumed ${what} after waiting ${this._now() - t0}ms for you`)
  }

  async driftClock(step: boolean): Promise<boolean> {
    this._stepping = (await this._drift<boolean>('clock', step)) === true
    return this._stepping
  }

  async driftAdvance(ms: number): Promise<number> {
    return (await this._drift<number>('advance', ms)) ?? -1
  }

  private _toPhone(cue: Omit<PhoneDriftCue, 'run' | 'seq' | 'workspace' | 'name'>, seq = 0): { seq: number; sent: boolean } {
    if (!this._asked || !this._workspace) return { seq: 0, sent: false }
    const n = seq || ++this._phoneSeq
    const sent = sendPhoneDrift({ run: this._phoneRun, seq: n, workspace: this._workspace, name: this._opts.name, ...cue }, (line) => this._log(line))
    return { seq: n, sent }
  }

  private async _phoneRead(sent: boolean, macHeld: boolean, text: string, ms: unknown): Promise<void> {
    if (!sent || macHeld || !text || this._stepping) return
    const hold = PHONE_ARRIVE_MS + bubbleMs(text, ms)
    this._log(`drift holds the script ${hold}ms so the phone can read "${text}"`)
    await this.gate.hold(hold, this._opts.signal)
  }

  private async _phoneSpot(target: Options | null | undefined, at: { x: number; y: number } | null): Promise<{ spot: DriftSpot | null; search: string | null } | null> {
    if (!this._asked || !this._workspace || !phoneDriftOn()) return null
    const live = typeof target?.selector !== 'string' && typeof target?.live === 'string'
    const parsed = target ? parsedOf(live ? target.live : target.selector) : null
    const part = target?.part === 'value' || target?.part === 'label' ? target.part : null
    const how = { gizmo: live ? (target!.gizmo ?? null) : null, part }
    const read = this._injected()
      .then((injected) => injected.evaluate((inj: any, a: { p: unknown; how: unknown; at: unknown }) => inj.spot(a.p, a.how, a.at), { p: parsed, how, at: target ? at : null }))
      .catch(() => null) as Promise<{ spot: DriftSpot | null; search: string | null } | null>
    const r = await Promise.race([read, sleep(PHONE_SPOT_MS).then(() => null)])
    return r ?? { spot: null, search: null }
  }

  async say(text: string, options: Options): Promise<string> {
    if (!this._asked) return ''
    let phone = false
    const r = await this.session.say(async () => {
      const shown = (await this._drift<SayShown>('sayFor', text, options?.ms, options?.spotlight === true)) ?? { text: '', travel: 0, read: 0, shown: false }
      const line = shown.text || bubbleText(text)
      if (line && phoneDriftOn()) phone = this._toPhone({ op: 'say', text: line, ms: typeof options?.ms === 'number' ? options.ms : undefined }).sent
      return shown
    }, this._opts.signal)
    if (options?.wait === true && r.text && !this._stepping) {
      const ms = r.travel + (r.shown ? r.read : Number(options.ms) || 0)
      this._log(`drift holds the script ${ms}ms for "${r.text}"`)
      await this.gate.hold(ms, this._opts.signal)
    }
    if (options?.wait === true) await this._phoneRead(phone, !!r.text && r.shown, r.text || bubbleText(text), options?.ms)
    return r.text
  }

  async ask(target: Options | null, text: string, buttons: string[]): Promise<string | null> {
    await this._targetGate(target, 'ask()', undefined)
    const box = target ? await this._boxOf(target, {}, 'ask()') : null
    const at = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2, box: box.width || box.height ? box : null } : { x: null, y: null, box: null }
    const idle = (): boolean => this.gate.userIdleFor() >= USER_IDLE_MS
    const center = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null
    const offered = new Set(buttons.map((b) => bubbleText(b)))
    let phone: { spot: DriftSpot | null; search: string | null } | null = null
    let seq = 0
    let sentAt = Number.NEGATIVE_INFINITY
    const toPhone = async (): Promise<void> => {
      sentAt = this._now()
      if (!phoneDriftOn()) return
      phone ??= await this._phoneSpot(target, center)
      if (!phone) return
      seq = this._toPhone({ op: 'ask', text: bubbleText(text), buttons, spot: phone.spot, search: phone.search }, seq).seq
    }
    const label = await this.session.ask(
      text,
      buttons,
      async () => {
        const shown = await this._driftAt<AskShown>('ask', target, { ...at, text, buttons, focus: idle() })
        if (!seq) await toPhone()
        return shown
      },
      async () => {
        if (this._disposed) return { done: false, label: null, how: '' }
        if (this._now() - sentAt >= PHONE_ASK_RESEND_MS) await toPhone()
        const tapped = seq ? takePhoneDriftAnswer(this._phoneRun, seq) : null
        if (tapped && (tapped.label === null || offered.has(tapped.label))) {
          this._log(`drift's question was answered on the phone: ${tapped.label === null ? 'closed' : JSON.stringify(tapped.label)}`)
          await this._drift('answer', tapped.label, 'tapped on the phone')
        } else if (tapped) this._log(`the phone answered ${JSON.stringify(tapped.label)}, which isn't one of the buttons, so the question stays open`)
        return this._drift<AskPoll | null>('asked', idle())
      },
      this._opts.signal
    )
    if (seq) this._toPhone({ op: 'answered', label })
    if (target) this.session.anchor('ask', (await this._drift<Where | null>('askWhere')) ?? (await this._drift<Where>('where')), null)
    return label
  }

  hold(ms: number): Promise<void> {
    return this.session.sleep(ms, this._opts.signal)
  }

  async front(what: string, why: string): Promise<void> {
    if (this._workspace && !(await this._viewInfo())?.active) await this._holdUntilActive(what, why)
  }

  private _driftAt<T = unknown>(method: string, target: Options | null | undefined, args: Record<string, unknown>): Promise<T | null> {
    const live = typeof target?.selector !== 'string' && typeof target?.live === 'string'
    const parsed = parsedOf(live ? target!.live : target?.selector)
    if (!parsed) return this._drift<T>(method, args)
    if (this._disposed || !this._show) return Promise.resolve(null)
    const part = target?.part === 'value' || target?.part === 'label' ? target.part : null
    const how = live || part ? { box: args.box ?? null, gizmo: live ? (target!.gizmo ?? null) : null, part } : null
    return this._injected()
      .then((injected) =>
        injected.evaluate(
          (inj: any, a: { m: string; args: Record<string, unknown>; p: unknown; how: unknown }) => inj.drift[a.m]({ ...a.args, target: inj.anchorSelector(a.p, a.how) }),
          { m: method, args, p: parsed, how }
        )
      )
      .then((v) => v as T)
      .catch(() => null)
  }

  private _drift<T = unknown>(method: string, ...args: unknown[]): Promise<T | null> {
    if (this._disposed || !this._show) return Promise.resolve(null)
    return this._injected()
      .then((injected) =>
        injected.evaluate((inj: any, a: { m: string; args: unknown[] }) => inj.drift[a.m](...a.args), { m: method, args })
      )
      .then((v) => v as T)
      .catch(() => null)
  }

  private async _injected(): Promise<JSHandle<any>> {
    const utility = await this._page.mainFrame().utilityContext()
    return utility.injectedScript()
  }

  private _progress(title: string, timeout: unknown, action: string): ProgressController {
    const ms = typeof timeout === 'number' && timeout >= 0 ? timeout : DEFAULT_ACTION_MS
    const controller = new ProgressController(ms, this._opts.signal, title, this)
    controller.metadata.action = action
    return controller
  }

  private async _run<T>(title: string, timeout: unknown, action: string, task: (progress: Progress) => Promise<T>): Promise<T> {
    let retried = false
    while (true) {
      const controller = this._progress(title, timeout, action)
      try {
        return await controller.run(task)
      } catch (e) {
        if (!retried && isStaleContextError(e)) {
          retried = true
          this._page.mainFrame().invalidateContexts()
          continue
        }
        throw e
      } finally {
        this._settled(controller.metadata)
      }
    }
  }

  async tunerReady(options: Options): Promise<string | null> {
    const view = typeof options.view === 'string' && options.view ? options.view : undefined
    const quick = typeof options.timeout === 'number' && options.timeout >= 0 ? options.timeout : DEFAULT_ACTION_MS
    const cap = typeof options.limit === 'number' && options.limit > 0 ? options.limit : SCENE_WAIT_MS
    const t0 = this._now()
    let other: number | null = null
    let waited: number | null = null
    let on = false
    try {
      while (true) {
        if (this._opts.signal.aborted || this._disposed) throw new Error('The script was stopped.')
        const panes = await this._tunerPanes()
        if (!view && !panes.length) return null
        const r = readyTunerPane(panes, view, typeof options.target === 'string' && options.target ? options.target : undefined)
        if (r.ready) {
          if (waited !== null) this._log(`tuner ready resumed after waiting ${this._now() - waited}ms for the scene`)
          if (on) void this._drift('done', false)
          return r.ready.view
        }
        const now = this._now()
        if (r.blocked?.show === 'loading') {
          other = null
          if (waited === null) {
            waited = now
            this._log(`tuner ready waits: ${tunerNotReadyMessage(r.blocked)}`)
            on = !!(this._show && (await this._drift<{ on: boolean }>('state'))?.on)
            if (on) void this._drift('puzzled', null, DRIFT_LINES.loading)
          }
        } else if (other === null) other = now
        if (other !== null && now - other >= quick) {
          if (!r.blocked) return null
          throw this._tunerFailed(r.blocked)
        }
        if (r.blocked && now - t0 >= cap) {
          const message = tunerStillLoadingMessage(r.blocked, now - t0)
          if (this._show) this._log(`drift worried: ${message}`)
          void this._drift('worried', message)
          throw new Error(message)
        }
        await sleep(TUNER_POLL_MS)
      }
    } finally {
      if (waited !== null) this._holdMs += this._now() - waited
    }
  }

  private async _tunerPanes(): Promise<TunerPaneState[]> {
    const inj = await this._injected().catch(() => null)
    return ((await inj?.evaluate((i: any) => i.tunerPanes()).catch(() => null)) as TunerPaneState[] | null) ?? []
  }

  private async _tunerBlocked(selector: string): Promise<TunerPaneState | null> {
    const resolved = await this._page.mainFrame().resolveInjectedForSelector(selector).catch(() => null)
    if (!resolved) return null
    return resolved.injected
      .evaluate((i: any, { info }: any) => {
        const el = i.querySelector(info.parsed, document, false)
        const pane = el ? i.tunerPane(el) : null
        return pane && !pane.ready ? pane : null
      }, { info: resolved.info })
      .catch(() => null) as Promise<TunerPaneState | null>
  }

  private async _tunerGate(selector: string, timeout: unknown): Promise<void> {
    await this._sceneGate(() => this._tunerBlocked(selector), selector, timeout)
  }

  private async _paneBlockedAt(p: types.Point): Promise<TunerPaneState | null> {
    const inj = await this._injected().catch(() => null)
    const pane = (await inj?.evaluate((i: any, a: types.Point) => i.tunerPaneAt(a.x, a.y), p).catch(() => null)) as TunerPaneState | null
    return pane && pane.show === 'loading' ? pane : null
  }

  private async _targetGate(target: Options | null | undefined, what: string, timeout: unknown): Promise<void> {
    if (!target) return
    const sel = typeof target.selector === 'string' ? target.selector : typeof target.live === 'string' ? target.live : null
    if (sel) {
      return this._sceneGate(async () => {
        const b = await this._tunerBlocked(sel)
        return b?.show === 'loading' ? b : null
      }, what, timeout)
    }
    const x = Number(target.x)
    const y = Number(target.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const at = { x: x + (Number(target.width) || 0) / 2, y: y + (Number(target.height) || 0) / 2 }
    await this._sceneGate(() => this._paneBlockedAt(at), what, timeout)
  }

  private async _sceneGate(probe: () => Promise<TunerPaneState | null>, what: string, timeout: unknown): Promise<void> {
    let blocked = await probe()
    if (!blocked) return
    const t0 = this._now()
    const quick = typeof timeout === 'number' && timeout > 0 ? timeout : DEFAULT_ACTION_MS
    let other = blocked.show === 'loading' ? null : t0
    this._log(`${what} waits: ${tunerNotReadyMessage(blocked)}`)
    const st = this._show ? await this._drift<{ on: boolean }>('state') : null
    if (st?.on) void this._drift('puzzled', null, DRIFT_LINES.loading)
    try {
      while (true) {
        if (this._opts.signal.aborted || this._disposed) throw new Error('The script was stopped.')
        await sleep(TUNER_POLL_MS)
        blocked = await probe()
        if (!blocked) break
        const now = this._now()
        if (blocked.show === 'loading') other = null
        else if (other === null) other = now
        if (other !== null && now - other >= quick) throw this._tunerFailed(blocked)
        if (now - t0 >= SCENE_WAIT_MS) {
          const message = tunerStillLoadingMessage(blocked, now - t0)
          if (this._show) this._log(`drift worried: ${message}`)
          void this._drift('worried', message)
          throw new Error(message)
        }
      }
    } finally {
      this._holdMs += this._now() - t0
    }
    this._log(`${what} resumed after waiting ${this._now() - t0}ms for the scene`)
    if (st?.on) void this._drift('done', false)
  }

  private _tunerFailed(pane: TunerPaneState): Error {
    const message = tunerNotReadyMessage(pane)
    if (this._show) this._log(`drift worried: ${message}`)
    void this._drift('worried', message)
    return new Error(message)
  }

  private async _foregroundWhy(selector: string): Promise<string> {
    const frame = this._page.mainFrame()
    const resolved = await frame.resolveInjectedForSelector(selector).catch(() => null)
    if (!resolved) return ''
    return resolved.injected
      .evaluate((i: any, { info }: any) => {
        const el = i.querySelector(info.parsed, document, false)
        return el ? i.foregroundWhy(el) : ''
      }, { info: resolved.info })
      .catch(() => '') as Promise<string>
  }

  private async _scrollVisual(selector: string): Promise<{ dx: number; dy: number } | null> {
    const frame = this._page.mainFrame()
    const resolved = await frame.resolveInjectedForSelector(selector).catch(() => null)
    if (!resolved) return null
    const plan = (await resolved.injected
      .evaluate((i: any, { info }: any) => {
        const el = i.querySelector(info.parsed, document, false)
        return el ? i.scrollPlan(el) : null
      }, { info: resolved.info })
      .catch(() => null)) as { x: number; y: number; box: types.Rect; dx: number; dy: number } | null
    if (!plan) return null
    await this.gate.idle(this._opts.signal)
    await this._approach(this._page, { action: 'scroll' }, { x: plan.x, y: plan.y }, plan.box)
    return plan
  }

  private async _boxOf(target: Options, options: Options, what: string): Promise<types.Rect> {
    if (typeof target.selector === 'string') {
      await this.frameAction('scrollIntoViewIfNeeded', target.selector, { timeout: options.timeout })
      const b = (await this._frameAction('boundingBox', target.selector, { timeout: options.timeout })) as types.Rect | null
      if (!b) throw new Error(`${target.selector} has no box to point at`)
      return b
    }
    const x = Number(target.x)
    const y = Number(target.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${what} needs a locator, a Tuner target or { x, y }`)
    return { x, y, width: Math.max(0, Number(target.width) || 0), height: Math.max(0, Number(target.height) || 0) }
  }

  async point(target: Options, text: string, options: Options): Promise<{ shown: boolean; text: string }> {
    if (!this._asked) return { shown: false, text: '' }
    await this._targetGate(target, 'point()', options.timeout)
    const box = await this._boxOf(target, options, 'point()')
    const A = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const args = { x: A.x, y: A.y, box: box.width || box.height ? box : null, text, ms: options.ms, slide: true, spotlight: options.spotlight === true, mark: target?.mark !== false }
    const phone = await this._phoneSpot(target, A)
    let sent = false
    const show = async (): Promise<PointShown> => {
      const r = (await this._driftAt<PointShown>('point', target, args)) ?? { travel: 0, read: 0, shown: false, text: '' }
      if (phone) sent = this._toPhone({ op: 'point', text: r.text || bubbleText(text), ms: typeof options.ms === 'number' ? options.ms : undefined, spot: phone.spot, search: phone.search }).sent
      return r
    }
    const r = await this.session.point(show, A, options.wait !== false && !this._stepping, this._opts.signal)
    if (options.wait !== false) await this._phoneRead(sent, r.shown, r.text || bubbleText(text), options.ms)
    this.session.anchor('point', await this._drift<Where>('where'), null)
    if (target?.gizmo || target?.part || typeof target?.live === 'string') await this._logAim()
    if (options.wait !== false) void this._drift('done', false)
    return { shown: r.shown, text: r.text }
  }

  private _logSay(st: SayStats): void {
    const m = st.max!
    this._log(`drift bubble: ${st.n} frames, sides ${st.sides.join('+')}, gap to Drift max ${m.gap.toFixed(1)}px at ${m.t} (bell ${m.bell.x},${m.bell.y} bubble ${m.say.x},${m.say.y} ${m.say.width}x${m.say.height}), mean ${(st.sum / st.n).toFixed(1)}px`)
    if (st.odd.length) this._log(`drift bubble far or flipped frames: ${st.odd.map((f) => `${f.t}:b(${f.bell.x},${f.bell.y})s(${f.say.x},${f.say.y})${f.side}g${f.gap}`).join(' ')}`)
  }

  private async _logAim(): Promise<void> {
    const tr = await this._drift<{ target: string; samples: AimSample[] }>('aimTrace')
    const list = tr?.samples ?? []
    if (!list.length) return
    const max = Math.max(...list.map((x) => x.d))
    const mean = list.reduce((a, x) => a + x.d, 0) / list.length
    const via = [...new Set(list.map((x) => x.via || '?'))].join('+')
    const k = list[list.length - 1].keep
    this._log(`drift aim at ${tr!.target} via ${via}: ${list.length} frames, tip off ${via === 'box' ? 'the box ' : ''}by max ${max.toFixed(1)}px, mean ${mean.toFixed(1)}px${k ? `, ${via === 'box' ? 'target' : 'object'} box (${k.x}, ${k.y}, ${k.width}x${k.height})` : ''}`)
    this._log(`drift aim frames: ${list.map((x) => `${x.t}:tip(${x.tip.x},${x.tip.y})at(${x.at.x},${x.at.y})${x.via === 'gizmo' ? 'g' : 'c'}d${x.d}`).join(' ')}`)
  }

  async frameAction(action: string, selector: string, options: Options): Promise<unknown> {
    if (!TUNER_FREE.has(action)) await this._tunerGate(selector, options.timeout)
    if (this._workspace && KEY_ACTS.has(action)) {
      const why = await this._foregroundWhy(selector)
      if (why) await this._holdUntilActive(`${action} on ${selector}`, why)
    }
    if (action === 'scrollIntoViewIfNeeded') {
      const plan = await this._scrollVisual(selector).catch(() => null)
      const result = await this._frameAction(action, selector, options)
      if (plan) {
        void this._drift('stroke', plan.dx * 100, plan.dy * 100)
        void this._drift('done', false)
      }
      return result
    }
    const acting = POINTER_ACTS.has(action) || KEY_ACTS.has(action)
    const away = options.state === 'hidden' || options.state === 'detached'
    this._lastReason = null
    let puzzle: ReturnType<typeof setTimeout> | undefined
    if (action === 'waitFor' && away) puzzle = setTimeout(() => void this._drift('puzzled', null, ''), PUZZLED_AFTER_MS)
    try {
      const result = await this._frameAction(action, selector, options)
      if (acting || action === 'waitFor') void this._drift('done', PLEASED.has(action))
      if (acting) this.session.action()
      return result
    } catch (e) {
      if (acting || action === 'waitFor') {
        const error = e as Error
        if (error?.name !== 'AbortedError') {
          const message = String(error?.message ?? '')
          const line = away ? '' : failLine(error, this._lastReason)
          if (this._show) this._log(`drift worried: ${action} failed with ${error?.name ?? 'Error'}${line ? `, says "${line}"` : ''}`)
          void this._drift('worried', line)
          if (line === WAIT_LINES.nomatch && error && !/Nothing on the page matched/.test(message)) {
            error.message = `${message.split('\n')[0]}\nNothing on the page matched. Buttons are named by their text, or by their tooltip when they only show an icon: try getByRole('button', { name }), getByTitle() or getByLabel(). In the Tuner use tuner.field(), tuner.row() or tuner.handle().${message.includes('\n') ? `\n${message.slice(message.indexOf('\n') + 1)}` : ''}`
          }
        }
      }
      throw e
    } finally {
      clearTimeout(puzzle)
    }
  }

  private async _frameAction(action: string, selector: string, options: Options): Promise<unknown> {
    const frame = this._page.mainFrame()
    const title = `locator.${action}(${JSON.stringify(selector)})`
    const strict = options.strict !== false
    const s = { strict }
    return this._run(title, options.timeout, action, async (progress) => {
      progress.metadata.selector = selector
      switch (action) {
        case 'click':
          return frame.click(progress, selector, { ...s, ...pick(options, CLICK_KEYS) })
        case 'dblclick':
          return frame.dblclick(progress, selector, { ...s, ...pick(options, CLICK_KEYS) })
        case 'hover':
          return frame.hover(progress, selector, { ...s, ...pick(options, POINTER_KEYS) })
        case 'dragAndDrop':
          return frame.dragAndDrop(progress, selector, String(options.target), {
            ...s,
            ...pick(options, ['force', 'trial', 'sourcePosition', 'targetPosition', 'steps'])
          })
        case 'fill':
          return frame.fill(progress, selector, String(options.value ?? ''), { ...s, ...pick(options, ['force']) })
        case 'press':
          return frame.press(progress, selector, String(options.key), { ...s, ...pick(options, ['delay', 'noWaitAfter']) })
        case 'type':
          return frame.type(progress, selector, String(options.text ?? ''), { ...s, delay: typingDelay(String(options.text ?? ''), options.delay) })
        case 'focus':
          return frame.focus(progress, selector, s)
        case 'blur':
          return frame.blur(progress, selector, s)
        case 'count':
          return frame.queryCount(progress, selector)
        case 'getAttribute':
          return frame.getAttribute(progress, selector, String(options.name), s)
        case 'innerHTML':
          return frame.innerHTML(progress, selector, s)
        case 'innerText':
          return frame.innerText(progress, selector, s)
        case 'inputValue':
          return frame.inputValue(progress, selector, s)
        case 'textContent':
          return frame.textContent(progress, selector, s)
        case 'isChecked':
          return frame.isChecked(progress, selector, s)
        case 'isDisabled':
          return frame.isDisabled(progress, selector, s)
        case 'isEditable':
          return frame.isEditable(progress, selector, s)
        case 'isEnabled':
          return frame.isEnabled(progress, selector, s)
        case 'isHidden':
          return frame.isHidden(progress, selector, s)
        case 'isVisible':
          return frame.isVisible(progress, selector, s)
        case 'boundingBox':
          return frame.boundingBox(progress, selector)
        case 'scrollIntoViewIfNeeded':
          return frame.scrollIntoViewIfNeeded(progress, selector, s)
        case 'selectText': {
          const handle = await frame.waitForSelector(progress, selector, { ...s, state: 'attached' })
          if (!handle) throw new Error(`Could not resolve ${selector} to DOM Element`)
          try {
            return await handle.selectText(progress, pick(options, ['force']))
          } finally {
            handle.dispose()
          }
        }
        case 'waitFor': {
          const state = options.state ?? 'visible'
          await frame.waitForSelector(progress, selector, { ...s, state, omitReturnValue: true })
          return undefined
        }
        case 'evaluateOn':
          return frame.evaluateOnSelector(progress, selector, String(options.source), !!options.isFunction, options.arg)
        case 'evaluateAll':
          return this._evaluateAll(progress, selector, String(options.source), !!options.isFunction, options.arg)
        default:
          throw new Error(`Unknown locator action ${action}`)
      }
    })
  }

  private async _evaluateAll(progress: Progress, selector: string, source: string, isFunction: boolean, arg: unknown): Promise<unknown> {
    const frame = this._page.mainFrame()
    const resolved = await progress.race(frame.resolveInjectedForSelector(selector))
    const array = await progress.race(resolved.injected.evaluateHandle((injected: any, { info }: any) => injected.querySelectorAll(info.parsed, document), { info: resolved.info }))
    const session = this._session
    const ids: string[] = []
    try {
      const props = await session.send('Runtime.getProperties', { objectId: array._objectId, ownProperties: true })
      for (const p of props.result as { name: string; value?: { objectId?: string } }[]) {
        if (!/^\d+$/.test(p.name) || !p.value?.objectId) continue
        const node = await session.send('DOM.describeNode', { objectId: p.value.objectId })
        const main = await session.send('DOM.resolveNode', { backendNodeId: node.node.backendNodeId })
        ids.push(main.object.objectId)
      }
      const global = await session.send('Runtime.evaluate', { expression: 'globalThis', returnByValue: false })
      const body = isFunction ? `return await (${source})(__els, __arg);` : `return await (${source});`
      const res = await session.send('Runtime.callFunctionOn', {
        functionDeclaration: `async function(__arg, ...__els) { ${body} }`,
        objectId: global.result.objectId,
        arguments: [{ value: arg }, ...ids.map((objectId) => ({ objectId }))],
        returnByValue: true,
        awaitPromise: true
      })
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text)
      return res.result.value
    } finally {
      array.dispose()
      for (const objectId of ids) void session._sendMayFail('Runtime.releaseObject', { objectId })
    }
  }

  async evaluate(options: Options): Promise<unknown> {
    const frame = this._page.mainFrame()
    return this._run('page.evaluate', 0, 'evaluate', (progress) =>
      frame.evaluateExpression(progress, String(options.source), !!options.isFunction, options.arg)
    )
  }

  async input(device: string, action: string, options: Options): Promise<void> {
    const page = this._page
    const title = `${device}.${action}`
    const show = options.__show === true
    if (action !== 'up' && this._buttons === 0 && this._keys.size === 0) {
      const m = page.mouse as unknown as { _x: number; _y: number }
      const xy = device === 'mouse' && (action === 'move' || action === 'click')
      const at = xy ? { x: Number(options.x), y: Number(options.y) } : { x: m._x, y: m._y }
      await this._sceneGate(() => this._paneBlockedAt(at), title, undefined)
    }
    await this._run(title, 0, title, async (progress) => {
      if (show) progress.metadata.free = true
      const before = (point?: types.Point): Promise<void> =>
        page.instrumentation.onBeforeInputAction(page, progress.metadata, point)
      if (device === 'mouse') {
        const x = Number(options.x)
        const y = Number(options.y)
        if (action === 'move') {
          await before({ x, y })
          return page.mouse.move(progress, x, y, pick(options, ['steps']))
        }
        if (action === 'down') {
          await before()
          const m = page.mouse as unknown as { _x: number; _y: number }
          await this._unlock({ x: m._x, y: m._y }, 'mouse down')
          return page.mouse.down(progress, pick(options, ['button', 'clickCount']))
        }
        if (action === 'up') {
          await before()
          return page.mouse.up(progress, pick(options, ['button', 'clickCount']))
        }
        if (action === 'click') {
          await before({ x, y })
          await this._unlock({ x, y }, 'click')
          return page.mouse.click(progress, x, y, pick(options, ['button', 'clickCount', 'delay', 'steps']))
        }
        if (action === 'wheel') {
          const m = page.mouse as unknown as { _x: number; _y: number }
          await before({ x: m._x, y: m._y })
          await this._focusPane(progress, 'wheel')
          return page.mouse.apiWheel(progress, Number(options.deltaX) || 0, Number(options.deltaY) || 0)
        }
      }
      if (device === 'keyboard') {
        await before()
        if (action === 'up') return page.keyboard.up(progress, String(options.key))
        const what = action === 'type' || action === 'insertText' ? `${action} text` : `${action} '${String(options.key)}'`
        const f = await this._focusPane(progress, what)
        if (action === 'down') await page.keyboard.down(progress, String(options.key))
        else if (action === 'press') await page.keyboard.press(progress, String(options.key), pick(options, ['delay']))
        else if (action === 'type') await page.keyboard.type(progress, String(options.text ?? ''), { delay: typingDelay(String(options.text ?? ''), options.delay) })
        else if (action === 'insertText') await page.keyboard.insertText(progress, String(options.text ?? ''))
        else throw new Error(`Unknown input ${device}.${action}`)
        if (action !== 'insertText') await this._keyLanded(f, what)
        return
      }
      throw new Error(`Unknown input ${device}.${action}`)
    })
    if (device === 'mouse' && action !== 'down' && this._buttons === 0) void this._drift('done', false)
    if (!show) this.session.action()
  }

  private async _focusPane(progress: Progress, what: string): Promise<{ inj: JSHandle<any>; at: types.Point; kind: string; mark: number } | null> {
    if (this._keys.size > 0 || this._buttons > 0 || this._disposed) return null
    const page = this._page
    const m = page.mouse as unknown as { _x: number; _y: number }
    const at = { x: m._x, y: m._y }
    const inj = await this._injected().catch(() => null)
    if (!inj) return null
    await this._unlock(at, `focus ${what}`)
    const plan = (await inj.evaluate((i: any, p: types.Point) => i.panePlan(p.x, p.y), at).catch(() => null)) as PanePlan | null
    if (!plan) return null
    const mark = (await inj.evaluate((i: any) => i.keyMark()).catch(() => 0)) as number
    if (plan.ok) {
      this._log(`focus ${what} -> ${plan.kind}: already focused`)
      return { inj, at, kind: plan.kind, mark }
    }
    let clicked = ''
    let ok = false
    let tries = 0
    let after = ''
    for (let n = 0; n < FOCUS_TRIES && !ok && !this._disposed; n++) {
      tries = n + 1
      const now = n === 0 ? plan : ((await inj.evaluate((i: any, p: types.Point) => i.panePlan(p.x, p.y), at).catch(() => null)) as PanePlan | null)
      if (!now) break
      if (now.ok) {
        ok = true
        break
      }
      if (now.spot && (n === 0 || !now.group)) {
        await page.instrumentation.onBeforeInputAction(page, progress.metadata, now.spot)
        await page.mouse.click(progress, now.spot.x, now.spot.y)
        clicked = clicked ? `${clicked}, again` : `clicked the ${now.where} at (${Math.round(now.spot.x)}, ${Math.round(now.spot.y)})`
      }
      await inj.evaluate((i: any) => i.frames(2)).catch(() => {})
      ok = (await inj.evaluate((i: any, p: types.Point) => i.focusPane(p.x, p.y), at).catch(() => false)) as boolean
      if (ok) {
        await inj.evaluate((i: any) => i.frames(2)).catch(() => {})
        const again = (await inj.evaluate((i: any, p: types.Point) => i.panePlan(p.x, p.y), at).catch(() => null)) as PanePlan | null
        ok = !!again?.ok
      }
    }
    after = ((await inj.evaluate((i: any) => i.focusDesc()).catch(() => '')) as string) || '?'
    this._log(`focus ${what} -> ${plan.kind}: before ${plan.before}${plan.group ? '' : ' (group inactive)'}, ${clicked || 'no click'}, after ${after}, ${ok ? `confirmed after ${tries} tr${tries > 1 ? 'ies' : 'y'}` : 'MISS: focus did not take'}`)
    if (clicked && plan.kind !== 'player') {
      await page.instrumentation.onBeforeInputAction(page, progress.metadata, at)
      await page.mouse.move(progress, at.x, at.y)
    }
    return { inj, at, kind: plan.kind, mark }
  }

  private async _pressProbe(x: number, y: number): Promise<void> {
    const inj = await this._injected().catch(() => null)
    const r = (await inj?.evaluate((i: any) => i.pressProbe()).catch(() => null)) as { event: { x: number; y: number; at: string } | null; marker: types.Point | null; tip: types.Point | null } | null
    if (!r) return
    const f = (p: types.Point | null): string => (p ? `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})` : 'none')
    const off = (p: types.Point | null): number => (p ? Math.hypot(p.x - x, p.y - y) : 0)
    const worst = Math.max(off(r.event), off(r.marker), off(r.tip))
    this._log(`click at (${x.toFixed(1)}, ${y.toFixed(1)}) on ${r.event?.at ?? '?'}: event ${f(r.event)}, marker ${f(r.marker)}, fingertip ${f(r.tip)}, ${worst <= 1 ? 'aligned' : `MISMATCH ${worst.toFixed(1)}px`}`)
  }

  private async _dragProbe(): Promise<void> {
    const inj = await this._injected().catch(() => null)
    setTimeout(() => void this._grabProbe(), GRAB_LOG_MS)
    const r = (await inj?.evaluate((i: any) => i.dragProbe()).catch(() => null)) as { down: string; moves: Record<string, number>; lock: string } | null
    if (!r) return
    const keys = Object.keys(r.moves)
    if (!keys.length) return
    const stray = keys.filter((k) => k !== r.down)
    this._log(`drag on ${r.down}: moves ${keys.map((k) => `${k} ${r.moves[k]}`).join(', ')}${r.lock ? `, pointer locked by ${r.lock}` : ''}, ${stray.length ? `MISS: moves went to ${stray.join(', ')}` : 'all moves on target'}`)
  }

  private async _grabProbe(): Promise<void> {
    const inj = await this._injected().catch(() => null)
    const g = (await inj?.evaluate((i: any) => i.grabProbe()).catch(() => null)) as { mid: { body: string; dragging: boolean; face: string } | null; after: { body: string; dragging: boolean } | null; moves: number } | null
    if (g?.mid && g.after) this._log(`drift grab: ${g.moves} moves as body ${g.mid.body} dragging ${g.mid.dragging} face ${g.mid.face}; after release body ${g.after.body} dragging ${g.after.dragging}`)
  }

  private async _unlock(at: types.Point, what: string): Promise<void> {
    const inj = await this._injected().catch(() => null)
    if (!inj) return
    const was = (await inj.evaluate((i: any, p: types.Point) => i.releaseLock(p.x, p.y), at).catch(() => '')) as string
    if (!was) return
    let left = ''
    for (let n = 0; n < FOCUS_TRIES; n++) {
      await inj.evaluate((i: any) => i.frames(2)).catch(() => {})
      left = (await inj.evaluate((i: any) => i.lockedBy()).catch(() => '')) as string
      if (!left) break
      await inj.evaluate((i: any, p: types.Point) => i.releaseLock(p.x, p.y), at).catch(() => '')
    }
    this._log(`${what}: released the ${was} pointer lock first${left ? `, MISS: still locked by ${left}` : ''}`)
  }

  private async _keyLanded(f: { inj: JSHandle<any>; at: types.Point; kind: string; mark: number } | null, what: string): Promise<void> {
    if (!f) return
    const r = (await f.inj.evaluate((i: any, a: { x: number; y: number; m: number }) => i.keyLanded(a.x, a.y, a.m), { x: f.at.x, y: f.at.y, m: f.mark }).catch(() => '?')) as string
    this._log(`key ${what} -> ${f.kind}: ${r === 'ok' ? 'landed' : `MISS: ${r}`}`)
  }

  async snapshot(selector: string | null, options: Options): Promise<string> {
    const opts = pick(options, ['depth', 'offscreen', 'max'])
    if (!selector) {
      const inj = await this._injected()
      return (await inj.evaluate((i: any, o: Options) => i.snapshot(null, o), opts)) as string
    }
    if (typeof options.fallback === 'string') {
      const r = (await this._snapshotNow(selector, opts)) ?? (await this._snapshotNow(options.fallback, opts))
      if (r === null) throw new Error('No Tuner is open in your workspace.')
      return r
    }
    const frame = this._page.mainFrame()
    return this._run(`snapshot(${JSON.stringify(selector)})`, options.timeout, 'snapshot', async (progress) => {
      const handle = await frame.waitForSelector(progress, selector, { strict: false, state: 'attached' })
      if (!handle) throw new Error(`Nothing matches ${selector}`)
      try {
        const r = await handle.evaluateInUtility(([i, node, o]: [any, any, Options]) => i.snapshot(node, o), opts)
        if (r === 'error:notconnected') throw new Error('The element went away while it was being read.')
        return r as string
      } finally {
        handle.dispose()
      }
    })
  }

  private async _snapshotNow(selector: string, opts: Options): Promise<string | null> {
    const resolved = await this._page.mainFrame().resolveInjectedForSelector(selector).catch(() => null)
    if (!resolved) return null
    return resolved.injected
      .evaluate((i: any, { info, o }: any) => {
        const el = i.querySelector(info.parsed, document, false)
        return el ? i.snapshot(el, o) : null
      }, { info: resolved.info, o: opts })
      .catch(() => null) as Promise<string | null>
  }

  async screenshot(selector: string | null, options: Options): Promise<Shot> {
    if (this._workspace && !(await this._viewInfo())?.active) await this._holdUntilActive('a screenshot', 'screenshots only work in front')
    let rect: types.Rect | undefined
    if (selector) {
      await this._frameAction('scrollIntoViewIfNeeded', selector, { timeout: options.timeout })
      const box = (await this._frameAction('boundingBox', selector, { timeout: options.timeout })) as types.Rect | null
      if (!box) throw new Error(`${selector} has no box to capture`)
      const x = Math.max(0, Math.floor(box.x))
      const y = Math.max(0, Math.floor(box.y))
      rect = { x, y, width: Math.max(1, Math.ceil(box.width + box.x - x)), height: Math.max(1, Math.ceil(box.height + box.y - y)) }
    }
    const capture = async (): Promise<NativeImage> => {
      this.wc.invalidate()
      await sleep(50)
      return this.wc.capturePage(rect, { stayHidden: true, stayAwake: true })
    }
    if (options.drift === true) await this._driftSettled()
    const image = options.drift === true ? await capture() : await this._withDriftHidden(capture)
    const size = image.getSize()
    const dipWidth = rect ? rect.width : (BrowserWindow.fromWebContents(this.wc)?.getContentSize()[0] ?? size.width)
    const width = Math.min(MAX_SHOT_WIDTH, Math.max(1, Math.round(dipWidth)))
    const resized = width < size.width ? image.resize({ width, quality: 'good' }) : image
    const out = resized.getSize()
    const png = options.type === 'png'
    const data = png ? resized.toPNG() : resized.toJPEG(typeof options.quality === 'number' ? options.quality : 80)
    return { mime: png ? 'image/png' : 'image/jpeg', data, width: out.width, height: out.height }
  }

  private async _driftSettled(): Promise<void> {
    const until = this._now() + SETTLE_MS
    while (this._now() < until && (await this._drift<boolean>('moving'))) await sleep(40)
  }

  private async _withDriftHidden<T>(capture: () => Promise<T>): Promise<T> {
    if (!this._show) return capture()
    const injected = await this._injected().catch(() => null)
    if (!injected) return capture()
    const t0 = this._now()
    await injected
      .evaluate((inj: any) => {
        inj.drift.visible(false)
        return new Promise<void>((r) => {
          requestAnimationFrame(() => requestAnimationFrame(() => r()))
          setTimeout(r, 120)
        })
      })
      .catch(() => {})
    this._driftMs += this._now() - t0
    try {
      return await capture()
    } finally {
      void injected.evaluate((inj: any) => inj.drift.visible(true)).catch(() => {})
    }
  }

  async releaseInput(): Promise<void> {
    const page = this._page
    const progress = new ProgressController(2000, undefined, 'release input')
    try {
      for (const button of ['left', 'right', 'middle'] as const) {
        if ((page.mouse as any)._buttons?.has(button)) await page.mouse.up(progress, { button }).catch(() => {})
      }
      const modifiers = ['Alt', 'Control', 'Meta', 'Shift'] as const
      for (const key of [...this._keys]) {
        if (!(modifiers as readonly string[]).includes(key)) await page.keyboard.up(progress, key).catch(() => {})
      }
      for (const modifier of modifiers) {
        if (page.keyboard._modifiers().has(modifier)) await page.keyboard.up(progress, modifier).catch(() => {})
      }
    } finally {
      progress.dispose()
    }
  }

  report(): string {
    return this.session.report()
  }

  note(text: string): void {
    this.session.note(text)
  }

  trace(line: string): void {
    if (line) this._log(line)
  }

  aimFree(quietMs: number): boolean {
    return this._asked && !this._disposed && !this.gate.paused && this.gate.userIdleFor() >= quietMs
  }

  async dispose(failed = false): Promise<void> {
    if (this._disposed || this._closing) return
    this._closing = true
    this._offInput()
    clearInterval(this._viewTimer)
    if (this._wait) this._settled(this._wait.meta)
    this._deferred = null
    this._replay = null
    await this.releaseInput().catch(() => {})
    await this._viewInfo().catch(() => null)
    const injected = await this._injected().catch(() => null)
    const says = (await injected?.evaluate((inj: any) => inj.drift.sayTrace()).catch(() => null)) as SayStats | null
    if (says?.n) this._logSay(says)
    const lines = (await injected?.evaluate((inj: any) => inj.drift.lineTrace()).catch(() => null)) as LineShown[] | null
    for (const l of lines ?? []) this._log(`drift line "${l.text}" ${l.how === 'up' ? 'still up' : l.how} after ${l.up}ms of its ${l.read}ms read`)
    if (this._phoneSeq) {
      const last = await this._phoneSpot(null, null).catch(() => null)
      this._toPhone({ op: 'bye', search: last?.search ?? null })
    }
    this._disposed = true
    const linger = await injected?.evaluate((inj: any, f: boolean) => inj.bye(f), failed).catch(() => 0)
    const late = (await injected?.evaluate((inj: any) => inj.drift.takeEvents()).catch(() => null)) as { fired: string[]; said: string[] } | null
    if (late) this.session.events(late.fired, late.said)
    if (typeof linger === 'number' && linger > 0) {
      this.session.linger(linger)
      this._log(`drift stays ${linger}ms after the script for the last bubble`)
    }
    if (this._workspace) await Promise.resolve(this._opts.drive?.(false)).catch(() => {})
    this._page.markClosed()
    this._input.detach()
    await releaseSession(this.wc, this._session)
  }
}
