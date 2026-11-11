import { Frame, functionSource, type Rpc } from '../playwright/client/frame'
import { aimAt, filteredOpen, tunerApi } from './tuner'
import { driftApi } from './drift'
import { showPane, useLayoutRpc } from './layout'
import { kindOf, opts as checked, text as textArg, unityApis } from './unity'
import { Locator, testIdAttributeName, type LocatorOptions } from '../playwright/client/locator'
import {
  getByAltTextSelector,
  getByLabelSelector,
  getByPlaceholderSelector,
  getByRoleSelector,
  getByTestIdSelector,
  getByTextSelector,
  getByTitleSelector,
  type ByRoleOptions
} from '../playwright/isomorphic/locatorUtils'

type Send = (json: string) => void
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; site: Error }
type Options = Record<string, unknown>
type TextOptions = { exact?: boolean }

const g = globalThis as unknown as Record<string, unknown>
const send = g.__saturaHost as Send
delete g.__saturaHost

const SCRIPT_FILE = 'satura_exec.js'
const pending = new Map<number, Pending>()
let nextId = 1

function cleanStack(stack: string | undefined, fallback: string): string {
  const lines = (stack ?? '').split('\n')
  const head = lines.filter((l) => !/^\s+at /.test(l)).join('\n') || fallback
  const frames = lines.filter((l) => /^\s+at /.test(l) && (l.includes(SCRIPT_FILE) || l.includes('.sspace/plugins/')))
  return [head, ...frames].join('\n')
}

const rpc: Rpc = (method, params) => {
  const id = nextId++
  const site = new Error()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, site })
    send(JSON.stringify({ t: 'call', id, method, params }))
  })
}

type WindowInfo = { id: number; title: string; focused: boolean; visible: boolean; caller: boolean }

const startup = JSON.parse(String(g.__saturaInit ?? '{}')) as { windows?: WindowInfo[]; drift?: boolean; plugins?: Record<string, string[]> }
const driftOn = startup.drift !== false
let windowRows: WindowInfo[] = Array.isArray(startup.windows) ? startup.windows : []

function settle(json: string): void {
  const msg = JSON.parse(json) as { id: number; ok: boolean; value?: string; name?: string; message?: string; windows?: WindowInfo[] }
  if (Array.isArray(msg.windows)) {
    windowRows = msg.windows
    return
  }
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  if (msg.ok) {
    p.resolve(msg.value === undefined ? undefined : JSON.parse(msg.value))
    return
  }
  const error = p.site
  error.name = msg.name || 'Error'
  error.message = msg.message || 'Unknown error'
  const frames = (error.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l))
  error.stack = [`${error.name}: ${error.message}`, ...frames].join('\n')
  p.reject(error)
}

function toPlain(v: unknown, path: object[]): unknown {
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
  if (typeof v === 'symbol') return v.toString()
  if (typeof v === 'function') return undefined
  if (typeof v !== 'object' || v === null) return v
  if (path.includes(v)) return '[Circular]'
  if (v instanceof Error) return `${v.name}: ${v.message}`
  const toJSON = (v as { toJSON?: unknown }).toJSON
  if (typeof toJSON === 'function') return toPlain(toJSON.call(v), path)
  const next = [...path, v]
  if (v instanceof Map) {
    const entries = [...v]
    if (entries.every(([k]) => typeof k === 'string' || typeof k === 'number')) return Object.fromEntries(entries.map(([k, x]) => [String(k), toPlain(x, next)]))
    return entries.map(([k, x]) => [toPlain(k, next), toPlain(x, next)])
  }
  if (v instanceof Set) return [...v].map((x) => toPlain(x, next) ?? null)
  if (ArrayBuffer.isView(v)) return 'length' in v ? Array.from(v as unknown as ArrayLike<number | bigint>, (x) => toPlain(x, next)) : `[${v.constructor.name} ${v.byteLength} bytes]`
  if (v instanceof ArrayBuffer) return `[ArrayBuffer ${v.byteLength} bytes]`
  if (Array.isArray(v)) return v.map((x) => toPlain(x, next) ?? null)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v)) {
    const x = toPlain((v as Record<string, unknown>)[k], next)
    if (x !== undefined) out[k] = x
  }
  return out
}

function format(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return cleanStack(value.stack, `${value.name}: ${value.message}`)
  if (value === undefined) return 'undefined'
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
  if (typeof value !== 'object' || value === null) return String(value)
  try {
    const text = JSON.stringify(toPlain(value, []))
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

function log(level: string, args: unknown[]): void {
  send(JSON.stringify({ t: 'log', level, text: args.map(format).join(' ') }))
}

const sandboxConsole = {
  log: (...a: unknown[]) => log('log', a),
  info: (...a: unknown[]) => log('info', a),
  warn: (...a: unknown[]) => log('warn', a),
  error: (...a: unknown[]) => log('error', a),
  debug: (...a: unknown[]) => log('debug', a)
}

function sleep(ms: number): Promise<void> {
  return rpc('sleep', { ms: Number(ms) || 0 }).then(() => undefined)
}

const cancelled = new Set<number>()
let nextTimer = 1

function setTimeoutShim(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): number {
  const id = nextTimer++
  void sleep(ms ?? 0).then(() => {
    if (cancelled.delete(id)) return
    callback(...args)
  })
  return id
}

function clearTimeoutShim(id: number): void {
  cancelled.add(id)
}

class Mouse {
  constructor(private _window: number | null) {}

  private _input(action: string, options: Options): Promise<unknown> {
    return rpc('input', { window: this._window, device: 'mouse', action, options })
  }

  async move(x: number, y: number, options: { steps?: number } = {}): Promise<void> {
    await this._input('move', { ...options, x, y })
  }

  async down(options: { button?: string; clickCount?: number } = {}): Promise<void> {
    await this._input('down', options)
  }

  async up(options: { button?: string; clickCount?: number } = {}): Promise<void> {
    await this._input('up', options)
  }

  async click(x: number, y: number, options: Options = {}): Promise<void> {
    await this._input('click', { ...options, x, y })
  }

  async dblclick(x: number, y: number, options: Options = {}): Promise<void> {
    await this._input('click', { ...options, x, y, clickCount: 2 })
  }

  async wheel(deltaX: number, deltaY: number): Promise<void> {
    await this._input('wheel', { deltaX, deltaY })
  }
}

class Keyboard {
  constructor(private _window: number | null) {}

  private _input(action: string, options: Options): Promise<unknown> {
    return rpc('input', { window: this._window, device: 'keyboard', action, options })
  }

  async down(key: string): Promise<void> {
    await this._input('down', { key })
  }

  async up(key: string): Promise<void> {
    await this._input('up', { key })
  }

  async press(key: string, options: { delay?: number } = {}): Promise<void> {
    await this._input('press', { ...options, key })
  }

  async type(text: string, options: { delay?: number } = {}): Promise<void> {
    await this._input('type', { ...options, text })
  }

  async insertText(text: string): Promise<void> {
    await this._input('insertText', { text })
  }
}

class Page {
  readonly mouse: Mouse
  readonly keyboard: Keyboard
  readonly _frame: Frame

  constructor(readonly _window: number | null) {
    this.mouse = new Mouse(_window)
    this.keyboard = new Keyboard(_window)
    this._frame = new Frame(rpc, _window, this)
  }

  locator(selector: string, options?: LocatorOptions): Locator {
    if (typeof selector !== 'string') throw new TypeError(`page.locator() takes a selector string, got ${selector === undefined || selector === null ? String(selector) : typeof selector === 'object' ? kindOf(selector) : typeof selector}`)
    return new Locator(this._frame, selector, options)
  }

  getByTestId(testId: string | RegExp): Locator {
    return this.locator(getByTestIdSelector(testIdAttributeName(), testId))
  }

  getByAltText(text: string | RegExp, options?: TextOptions): Locator {
    return this.locator(getByAltTextSelector(text, options))
  }

  getByLabel(text: string | RegExp, options?: TextOptions): Locator {
    return this.locator(getByLabelSelector(text, options))
  }

  getByPlaceholder(text: string | RegExp, options?: TextOptions): Locator {
    return this.locator(getByPlaceholderSelector(text, options))
  }

  getByText(text: string | RegExp, options?: TextOptions): Locator {
    return this.locator(getByTextSelector(text, options))
  }

  getByTitle(text: string | RegExp, options?: TextOptions): Locator {
    return this.locator(getByTitleSelector(text, options))
  }

  getByRole(role: string, options: ByRoleOptions = {}): Locator {
    return this.locator(getByRoleSelector(role, options))
  }

  async click(selector: string, options: Options = {}): Promise<void> {
    await this._frame.click(selector, options)
  }

  async dblclick(selector: string, options: Options = {}): Promise<void> {
    await this._frame.dblclick(selector, options)
  }

  async hover(selector: string, options: Options = {}): Promise<void> {
    await this._frame.hover(selector, options)
  }

  async fill(selector: string, value: string, options: Options = {}): Promise<void> {
    await this._frame.fill(selector, value, options)
  }

  async press(selector: string, key: string, options: Options = {}): Promise<void> {
    await this._frame.press(selector, key, options)
  }

  async type(selector: string, text: string, options: Options = {}): Promise<void> {
    await this._frame.type(selector, text, options)
  }

  async textContent(selector: string, options: Options = {}): Promise<string | null> {
    return this._frame.textContent(selector, options)
  }

  async isVisible(selector: string, options: Options = {}): Promise<boolean> {
    return this._frame.isVisible(selector, options)
  }

  async dragAndDrop(source: string, target: string, options: Options = {}): Promise<void> {
    await this._frame.dragAndDrop(source, target, options)
  }

  async waitForSelector(selector: string, options: Options = {}): Promise<void> {
    await this._frame._call('waitFor', selector, options)
  }

  async evaluate(pageFunction: Function | string, arg?: unknown): Promise<any> {
    const { source, isFunction } = functionSource(pageFunction)
    return rpc('page', { window: this._window, action: 'evaluate', options: { source, isFunction, arg } })
  }

  async title(): Promise<string> {
    return this.evaluate(() => document.title)
  }

  async url(): Promise<string> {
    return this.evaluate(() => location.href)
  }

  async viewportSize(): Promise<{ width: number; height: number }> {
    return this.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  }

  async waitForTimeout(ms: number): Promise<void> {
    await sleep(ms)
  }

  async waitForFunction(pageFunction: Function | string, arg?: unknown, options: Options = {}): Promise<any> {
    const timeout = Number(options.timeout ?? 30_000)
    const polling = Math.max(16, Number(options.polling) || 100)
    const until = Date.now() + timeout
    for (;;) {
      const value = await this.evaluate(pageFunction, arg)
      if (value) return value
      if (timeout > 0 && Date.now() > until) throw new Error(`page.waitForFunction: Timeout ${timeout}ms exceeded.`)
      await sleep(polling)
    }
  }

  async screenshot(options: Options = {}): Promise<unknown> {
    return shot(this, options)
  }

  toString(): string {
    return this._window === null ? 'page' : `page(window ${this._window})`
  }

  toJSON(): string {
    return this.toString()
  }
}

const SHOT_KEYS = ['drift', 'timeout', 'type', 'quality']

async function shot(target?: unknown, raw?: unknown): Promise<unknown> {
  const options = checked(raw, 'shot()', SHOT_KEYS)
  if (target instanceof Locator) {
    const window = (target._frame as Frame)._window
    return rpc('shot', { window, selector: target._selector, options })
  }
  const t = target as Record<string, any> | null | undefined
  if (t && typeof t._pane === 'function') {
    if (typeof t._ensure === 'function') await t._ensure()
    const why = typeof t._absent === 'function' ? await t._absent() : ''
    if (why) throw new Error(why)
    return rpc('shot', { window: typeof t._window === 'number' ? t._window : null, selector: t._pane()._selector, options })
  }
  if (t && !(t instanceof Page) && typeof t === 'object' && !Array.isArray(t)) return rpc('shot', { window: null, options: checked(t, 'shot()', SHOT_KEYS) })
  if (t !== undefined && t !== null && !(t instanceof Page)) {
    throw new TypeError('shot() takes a locator, a Tuner pane like tuner.inspector, an options object, or nothing for your whole workspace')
  }
  const window = t instanceof Page ? t._window : null
  return rpc('shot', { window, options })
}

const SNAPSHOT_KEYS = ['depth', 'offscreen', 'max', 'timeout']

async function snapshot(target?: unknown, options?: unknown): Promise<unknown> {
  const opts = checked(options, 'snapshot()', SNAPSHOT_KEYS)
  if (target instanceof Locator) return rpc('snapshot', { window: (target._frame as Frame)._window, selector: target._selector, options: opts })
  const t = target as Record<string, any> | null | undefined
  if (t && typeof t._pane === 'function') {
    if (typeof t._ensure === 'function') await t._ensure()
    const fallback = typeof t._root === 'function' ? t._root()._selector : '[data-tuner-pane]'
    return rpc('snapshot', { window: typeof t._window === 'number' ? t._window : null, selector: t._pane()._selector, options: { ...opts, fallback } })
  }
  if (t === undefined || t === null || t instanceof Page) return rpc('snapshot', { window: t instanceof Page ? t._window : null, selector: null, options: opts })
  if (typeof t === 'object' && !Array.isArray(t)) return rpc('snapshot', { window: null, selector: null, options: checked(t, 'snapshot()', SNAPSHOT_KEYS) })
  throw new TypeError('snapshot() takes a locator, a Tuner pane like tuner.inspector, or nothing for your whole workspace')
}

type Spot = { window: number | null; target: Options }

async function spotOf(target: unknown): Promise<Spot> {
  const side = (target as { _part?: unknown } | null)?._part
  const part = side === 'value' || side === 'label' ? { part: side } : {}
  if (target instanceof Locator) return { window: (target._frame as Frame)._window, target: { selector: target._selector, ...part } }
  const t = target as Record<string, any> | null
  if (t && typeof t === 'object' && typeof t.box === 'function') {
    const b = (await (typeof t._aimBox === 'function' ? t._aimBox() : typeof t._need === 'function' ? t._need() : t.box())) as Options | null
    if (!b) throw new Error(`${String(t)} isn't on screen`)
    const live = typeof t._sel === 'string' && t._sel ? { live: t._sel, gizmo: t._gizmo ?? null } : {}
    const mark = t._mark === false ? { mark: false } : {}
    return { window: typeof t._window === 'number' ? t._window : null, target: { x: b.x, y: b.y, width: b.width, height: b.height, ...live, ...mark, ...part } }
  }
  if (t && typeof t === 'object' && typeof t.x === 'number' && typeof t.y === 'number') {
    return { window: typeof t.window === 'number' ? t.window : null, target: { x: t.x, y: t.y, width: t.width, height: t.height } }
  }
  throw new TypeError('Pass a locator, a Tuner target or { x, y }')
}

const HOLD_MAX_MS = 60_000
const MAX_BUTTONS = 4
const MAX_BUTTON_CHARS = 40

function holdOf(name: string, opts: Options): number | undefined {
  if (opts.ms === undefined || opts.ms === null) return undefined
  const ms = typeof opts.ms === 'number' ? opts.ms : Number.NaN
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError(`${name}: ms is how long the bubble stays, in milliseconds. It must be more than 0, got ${String(opts.ms)}`)
  if (ms > HOLD_MAX_MS) throw new RangeError(`${name}: ms can be at most ${HOLD_MAX_MS} (60 s), got ${ms}`)
  return Math.round(ms)
}

let quietNoted = false

async function driftOff(name: string): Promise<boolean> {
  if (driftOn) return false
  if (!quietNoted) {
    quietNoted = true
    await rpc('layout', { window: null, action: 'note', text: `${name} drew nothing: Drift is off. Pass drift: true only when the user asked you to show or explain something` }).catch(() => null)
  }
  return true
}

async function prepare(target: unknown): Promise<void> {
  const t = target as Record<string, any> | null
  if (!t || typeof t !== 'object' || typeof t._show !== 'function') return
  if (typeof t._ensure === 'function') await t._ensure()
  await t._show()
}

async function point(target: unknown, text: unknown = '', options?: unknown): Promise<void> {
  const opts = checked(options, 'point()', ['ms', 'camera', 'spotlight', 'timeout'])
  const ms = holdOf('point()', opts)
  if (await driftOff('point()')) return
  await prepare(target)
  await aimAt(mainPage, tunerRpc, target, opts.camera)
  const spot = await spotOf(target)
  await rpc('point', { window: spot.window, target: spot.target, text: String(text ?? ''), options: { ms, timeout: opts.timeout, spotlight: opts.spotlight === true } })
}

async function say(text: unknown, options?: unknown): Promise<void> {
  const opts = checked(options, 'say()', ['at', 'ms', 'wait', 'spotlight', 'camera', 'window'])
  const ms = holdOf('say()', opts)
  if (await driftOff('say()')) return
  await prepare(opts.at)
  await aimAt(mainPage, tunerRpc, opts.at, opts.camera)
  if (opts.at !== undefined && opts.at !== null) {
    const spot = await spotOf(opts.at)
    await rpc('point', { window: spot.window, target: spot.target, text: String(text ?? ''), options: { ms, wait: opts.wait === true, spotlight: opts.spotlight === true } })
    return
  }
  await rpc('say', { text: String(text ?? ''), window: typeof opts.window === 'number' ? opts.window : null, options: { ms, wait: opts.wait === true, spotlight: opts.spotlight === true } })
}

async function ask(text: unknown, options?: unknown): Promise<string | null> {
  const opts = checked(options, 'ask()', ['buttons', 'at', 'camera', 'window'])
  const raw = opts.buttons === undefined || opts.buttons === null ? ['Next'] : opts.buttons
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_BUTTONS) {
    throw new TypeError(`ask(): buttons takes 1 to ${MAX_BUTTONS} labels, like ['Next'] or ['Finish']`)
  }
  const buttons = raw.map((b) => String(b ?? '').replace(/\s+/g, ' ').trim())
  if (buttons.some((b) => !b || b.length > MAX_BUTTON_CHARS)) throw new TypeError(`ask(): each button label needs 1 to ${MAX_BUTTON_CHARS} characters`)
  if (new Set(buttons).size !== buttons.length) throw new TypeError('ask(): button labels must differ, because ask() returns the label')
  const line = String(text ?? '').trim()
  if (!line) throw new TypeError('ask() needs the text to show')
  if (!driftOn) throw new Error('ask() needs drift: true: Drift only appears when the user asked you to show or explain something')
  await prepare(opts.at)
  await aimAt(mainPage, tunerRpc, opts.at, opts.camera)
  const spot = opts.at !== undefined && opts.at !== null ? await spotOf(opts.at) : null
  const window = spot ? spot.window : typeof opts.window === 'number' ? opts.window : null
  return (await rpc('ask', { window, target: spot ? spot.target : null, text: line, buttons })) as string | null
}

const pages = new Map<number, Page>()

function pageFor(id: number): Page {
  let p = pages.get(id)
  if (!p) pages.set(id, (p = new Page(id)))
  return p
}

const app = {
  windows(): (WindowInfo & { page: Page })[] {
    return windowRows.map((row) => ({ ...row, page: pageFor(row.id) }))
  },
  window(id: number): Page {
    if ((typeof id === 'object' && id !== null) || typeof id === 'function') throw new TypeError(`app.window() takes a window id number, got ${kindOf(id)}`)
    const n = Number(id)
    if (!windowRows.some((w) => w.id === n)) {
      const ids = windowRows.map((w) => w.id).join(', ') || 'none'
      throw new Error(`No Satura Space window with id ${String(id)}. Open windows: ${ids}. See app.windows().`)
    }
    return pageFor(n)
  },
  handles: (filter?: string) => rpc('handle', { action: 'list', filter: filter == null ? '' : String(filter) }),
  handle: (name: string, params?: Options, options?: unknown) =>
    rpc('handle', { action: 'call', name: String(name ?? ''), params: params ?? {}, wait: checked(options, 'app.handle()', ['wait']).wait }),
  result: (run: number, options?: unknown) => rpc('handle', { action: 'result', run: Number(run), wait: checked(options, 'app.result()', ['wait']).wait }),
  stop: (run: number) => rpc('handle', { action: 'stop', run: Number(run) }),
  tabs: () => rpc('tabs', { window: null, action: 'list' }),
  switchTab: (tab: unknown, options?: unknown) => {
    const o = checked(options, 'app.switchTab()', ['phone'])
    const row = tab as Options | null
    const ref = row && typeof row === 'object' && typeof row.id === 'string' ? row.id : textArg(tab, "app.switchTab() takes the tab's id, label or kind, or a row of app.tabs()").trim()
    if (!ref) throw new TypeError("app.switchTab() takes the tab's id, label or kind, like app.switchTab('Console')")
    const phone = o.phone === true
    return step(`app.switchTab ${ref}${phone ? ' on the phone' : ''}`, () => rpc('tabs', { window: null, action: 'switch', tab: ref, phone }))
  },
  phone: () => rpc('tabs', { action: 'phone' })
}

const agents = {
  status: () => rpc('agents', { command: 'status', args: {} }),
  spawn: (options: unknown) => rpc('agents', { command: 'spawn', args: { ...checked(options, 'agents.spawn()', ['prompt', 'placement', 'agent', 'model', 'effort', 'label']) } }),
  send: (id: string, text: string) => rpc('agents', { command: 'send', args: { id, text } }),
  report: (text: string) => rpc('agents', { command: 'report', args: { text } }),
  close: (id: string) => rpc('agents', { command: 'close', args: { id } })
}

function logQuery(name: string, raw: unknown, allowed: string[]): Options {
  const { lines, ...options } = checked(raw, name, ['lines', ...allowed])
  if (lines !== undefined && options.tail === undefined) options.tail = lines
  const grep = options.grep
  return grep instanceof RegExp ? { ...options, grep: { source: grep.source, flags: grep.flags } } : { ...options }
}

const logs = {
  app: (options?: unknown) => rpc('logs', { source: 'app', options: logQuery('logs.app()', options, ['tail', 'grep']) }),
  console: (options?: unknown) => rpc('logs', { source: 'console', options: logQuery('logs.console()', options, ['tail', 'grep', 'window']) })
}

function serialize(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'function') return JSON.stringify(`[function ${value.name || 'anonymous'}]`)
  try {
    const text = JSON.stringify(toPlain(value, []))
    return text === undefined ? JSON.stringify(String(value)) : text
  } catch {
    return JSON.stringify(String(value))
  }
}

function start(run: () => Promise<unknown>): void {
  let promise: Promise<unknown>
  try {
    promise = Promise.resolve(run())
  } catch (e) {
    promise = Promise.reject(e)
  }
  promise.then(
    (value) => send(JSON.stringify({ t: 'done', ok: true, value: serialize(value) })),
    (e: unknown) => {
      const error = e instanceof Error ? e : new Error(format(e))
      const stack = cleanStack(error.stack, `${error.name}: ${error.message}`)
      send(JSON.stringify({ t: 'done', ok: false, name: error.name, message: error.message, stack }))
    }
  )
}

const mainPage = new Page(null)
const tunerRpc = (args: Options): Promise<unknown> => rpc('tuner', { window: null, ...args })

async function show(target: unknown): Promise<unknown> {
  if (target instanceof Locator) {
    const window = (target._frame as Frame)._window
    return showPane(window === null ? mainPage : pageFor(window), target)
  }
  const t = target as Record<string, any> | null
  if (t && typeof t._pane === 'function' && t._page) {
    if (typeof t._ensure === 'function') await t._ensure()
    return showPane(t._page, t._pane())
  }
  throw new TypeError('show() takes a locator or a Tuner target, for example show(tuner.inspector) or show(page.getByRole(...))')
}

useLayoutRpc((args) => rpc('layout', args))

const VIDEO_OPEN_MS = 15000

const unityParts = unityApis(rpc)

async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  try {
    const value = await run()
    await rpc('step', { label, ok: true, ms: Date.now() - t0 }).catch(() => null)
    return value
  } catch (e) {
    await rpc('step', { label, ok: false, ms: Date.now() - t0 }).catch(() => null)
    throw e
  }
}

function fileName(path: unknown): string {
  const parts = (typeof path === 'string' ? path : '').split(/[\\/]/)
  return parts.length > 1 && /^report\.tsx$/i.test(parts[parts.length - 1]) ? parts[parts.length - 2] : parts[parts.length - 1]
}

const video = {
  ...unityParts.video,
  open: (path: string) => step(`video.open ${fileName(path)}`, () => openVideo(textArg(path, 'video.open() takes the video path as a string')))
}

async function openVideo(path: string): Promise<string> {
  const file = String(await rpc('video', { window: null, action: 'open', path: String(path ?? '') }))
  const player = mainPage.locator('[data-viewer-video] [data-frame-player] >> visible=true').first()
  await player.waitFor({ state: 'visible', timeout: VIDEO_OPEN_MS })
  await showPane(mainPage, player).catch(() => null)
  await mainPage
    .evaluate(() => {
      document.querySelector('[data-viewer-video] [data-frame-player]')?.dispatchEvent(new CustomEvent('frame-player:play'))
    })
    .catch(() => null)
  return file
}

const REPORT_RENDER_MS = 30000

interface ReportOpened {
  file: string
  stamp: string
  ms: number
}

const report = {
  open: (path: string, options?: unknown) =>
    step(`report.open ${fileName(path)}`, async () => {
      const out = checked(options, 'report.open()', ['exportHtml']).exportHtml
      const opened = await openReport(textArg(path, 'report.open() takes the report path as a string'))
      if (out === undefined || out === null || out === false) return opened
      const exported = await report.export(path, typeof out === 'string' && out !== 'auto' ? out : undefined)
      return { ...opened, html: exported.file }
    }),
  check: (path: string) => step(`report.check ${fileName(path)}`, () => checkReport(textArg(path, 'report.check() takes the report path as a string'))),
  export: (path: string, out?: string) => step(`report.export ${fileName(path)}`, () => exportReport(textArg(path, 'report.export() takes the report path as a string'), out))
}

async function openReport(path: string): Promise<{ file: string; warnings: string[] }> {
  const res = (await rpc('report', { window: null, action: 'open', path: String(path ?? '') })) as ReportOpened
  if (!res.stamp) {
    const frame = mainPage.locator('[data-viewer-page] iframe >> visible=true').first()
    await frame.waitFor({ state: 'visible', timeout: VIDEO_OPEN_MS })
    await showPane(mainPage, frame).catch(() => null)
    return { file: res.file, warnings: [] }
  }
  const selector = `[data-viewer-report][data-report-stamp="${res.stamp}"][data-report-settled]`
  const panel = mainPage.locator(selector).first()
  await panel.waitFor({ state: 'attached', timeout: REPORT_RENDER_MS })
  await showPane(mainPage, panel).catch(() => null)
  const state = (await mainPage.evaluate((sel: string) => {
    const el = document.querySelector(sel)
    return {
      status: el?.getAttribute('data-report-status') ?? '',
      error: el?.querySelector('[data-report-error]')?.textContent ?? '',
      warnings: el ? Array.from(el.querySelectorAll('[data-report-warning]'), (w) => w.textContent ?? '') : []
    }
  }, selector)) as { status: string; error: string; warnings: string[] }
  if (state.status !== 'ok') throw new Error(`The report compiled but failed while rendering:\n${state.error}`)
  return { file: res.file, warnings: state.warnings }
}

async function checkReport(path: string): Promise<{ file: string; ms: number }> {
  const res = (await rpc('report', { window: null, action: 'open', check: true, path: String(path ?? '') })) as ReportOpened
  return { file: res.file, ms: res.ms }
}

async function exportReport(path: string, out?: string): Promise<{ file: string; bytes: number; pages: number; media: number; warnings: string[] }> {
  return (await rpc('report', { window: null, action: 'export', path: String(path ?? ''), out: out == null ? '' : String(out) })) as {
    file: string
    bytes: number
    pages: number
    media: number
    warnings: string[]
  }
}

const DASHBOARD_RENDER_MS = 30000

type DashboardOpened = { project: string; page: string; compile: Record<string, string>; [k: string]: unknown }
type DashboardTileState = { widget: string; title: string; status: string; error: string; hooks: unknown[] }

const dashboardPanel = (page: string): string => `[data-dashboard-panel][data-dashboard-page="${page.replace(/"/g, '\\"')}"]`

async function dashboardTiles(page: string, widget: string): Promise<{ title: string; problems: string; tiles: DashboardTileState[] }> {
  return (await mainPage.evaluate(
    (a: { sel: string; widget: string }) => {
      const panel = document.querySelector(a.sel)
      const tiles = panel ? Array.from(panel.querySelectorAll('[data-dashboard-tile]')) : []
      return {
        title: panel?.getAttribute('data-dashboard-title') ?? '',
        problems: panel?.querySelector('[data-dashboard-problems]')?.textContent ?? '',
        tiles: tiles
          .filter((t) => !a.widget || t.getAttribute('data-dashboard-tile') === a.widget)
          .map((t) => {
            let hooks: unknown[] = []
            try {
              hooks = JSON.parse(t.querySelector('[data-dashboard-hooks]')?.textContent || '[]')
            } catch {
              hooks = []
            }
            return {
              widget: t.getAttribute('data-dashboard-tile') ?? '',
              title: t.getAttribute('data-dashboard-title') ?? '',
              status: t.getAttribute('data-dashboard-status') ?? '',
              error: t.querySelector('[data-dashboard-error]')?.textContent ?? '',
              hooks
            }
          })
      }
    },
    { sel: dashboardPanel(page), widget }
  )) as { title: string; problems: string; tiles: DashboardTileState[] }
}

async function dashboardSettled(page: string): Promise<void> {
  const panel = mainPage.locator(`${dashboardPanel(page)}[data-dashboard-settled]`).first()
  await panel.waitFor({ state: 'attached', timeout: DASHBOARD_RENDER_MS })
  await showPane(mainPage, panel).catch(() => null)
}

async function openDashboard(page?: unknown): Promise<unknown> {
  const res = (await rpc('dashboard', { window: null, action: 'open', page: page == null ? '' : String(page) })) as DashboardOpened
  await dashboardSettled(res.page)
  const seen = await dashboardTiles(res.page, '')
  const errors: Record<string, string> = {}
  for (const [id, text] of Object.entries(res.compile)) if (text !== 'ok') errors[id] = text
  for (const t of seen.tiles) if (t.status === 'error' && !errors[t.widget]) errors[t.widget] = t.error
  const { compile: _compile, ...rest } = res
  return { ...rest, ...(seen.problems ? { layoutProblems: seen.problems } : {}), widgets: seen.tiles.map((t) => ({ widget: t.widget, title: t.title, status: t.status })), errors }
}

async function readDashboard(options?: unknown): Promise<unknown> {
  const o = checked(options, 'dashboard.read()', ['page', 'widget'])
  const widget = o.widget == null ? '' : String(o.widget)
  let page = o.page == null ? '' : String(o.page)
  const shown = (await mainPage.evaluate(() => document.querySelector('[data-dashboard-panel]')?.getAttribute('data-dashboard-page') ?? '')) as string
  if (!page || page !== shown) page = ((await openDashboard(page || undefined)) as { page: string }).page
  else await dashboardSettled(page)
  const seen = await dashboardTiles(page, widget)
  if (widget && !seen.tiles.length) throw new Error(`No tile for widget "${widget}" on page "${page}".`)
  const tiles = []
  for (const t of seen.tiles) {
    const aria = await snapshot(mainPage.locator(`${dashboardPanel(page)} [data-dashboard-tile="${t.widget}"] [data-dashboard-body]`).first()).catch((e: Error) => `(no snapshot: ${e.message})`)
    tiles.push({ ...t, ...(t.error ? {} : { error: undefined }), aria })
  }
  const alerts = await rpc('dashboard', { window: null, action: 'alerts' })
  return { page, title: seen.title, ...(seen.problems ? { layoutProblems: seen.problems } : {}), tiles, alerts }
}

const dashboard = {
  open: (page?: string) => step(`dashboard.open ${page ?? ''}`.trim(), () => openDashboard(page)),
  read: (options?: unknown) => step('dashboard.read', () => readDashboard(options)),
  tile: (id: string) => mainPage.locator(`[data-dashboard-panel] [data-dashboard-tile="${textArg(id, 'dashboard.tile() takes the widget id as a string').replace(/"/g, '\\"')}"]`)
}

const PLUGIN_RENDER_MS = 30000

type PluginLoad = { load: ((exports: Options) => void) | null; error: string }
type PluginSeen = { title: string; status: string; error: string; problem: string; hooks: unknown[]; tile: boolean; outline: string }
type PluginOpened = { name: string; source: string; title: string; tabId: string; compile?: { panel: string; exec?: string } }
type BuiltInRow = { name: string; title: string; description: string; functions: string[]; source: 'built-in' }
type ProjectRow = { name: string; title: string; description: string; dir: string; panel: boolean; exec: boolean; guide: boolean; source: 'project'; errors: string[] }

const pluginLoads = new Map<string, PluginLoad>()
const pluginExports = new Map<string, Options | Error>()

const pluginCall = (name: string, fn: string): string => (/^[A-Za-z_$][\w$]*$/.test(name) ? `plugins.${name}.${fn}()` : `plugins['${name}'].${fn}()`)

function pluginModule(name: string): Options | Error {
  const have = pluginExports.get(name)
  if (have) return have
  const entry = pluginLoads.get(name)
  let out: Options | Error
  if (!entry) out = new Error(`There is no project plugin "${name}" with an exec.ts. plugins.list() shows the plugins.`)
  else if (!entry.load) out = new Error(`plugins.${name} can't run: ${entry.error}`)
  else {
    const exports: Options = {}
    try {
      entry.load(exports)
      out = exports
    } catch (e) {
      out = new Error(`plugins.${name} can't run: .sspace/plugins/${name}/exec.ts threw while loading: ${format(e)}`)
    }
  }
  pluginExports.set(name, out)
  return out
}

function pluginFunctions(name: string): string[] {
  const m = pluginModule(name)
  return m instanceof Error ? [] : Object.keys(m).filter((k) => typeof m[k] === 'function' && k !== 'default')
}

function pluginObject(name: string): Options {
  return new Proxy(Object.create(null) as Options, {
    get(_t, key) {
      if (typeof key !== 'string' || key === 'then' || key === 'toJSON') return undefined
      return (...args: unknown[]) =>
        step(`plugins.${name}.${key}`, async () => {
          const m = pluginModule(name)
          if (m instanceof Error) throw m
          const fn = m[key]
          if (typeof fn !== 'function') throw new TypeError(`There is no ${pluginCall(name, key)}. ${name} has ${pluginFunctions(name).map((f) => `${f}()`).join(', ') || 'no exported functions'}.`)
          return (fn as (...a: unknown[]) => unknown)(...args)
        })
    }
  })
}

const pluginPanel = (name: string): string => `[data-plugin-panel="${name.replace(/["\\]/g, '\\$&')}"]`

async function pluginSettled(name: string): Promise<void> {
  const panel = mainPage.locator(`${pluginPanel(name)}[data-plugin-settled]`).first()
  await panel.waitFor({ state: 'attached', timeout: PLUGIN_RENDER_MS })
  await showPane(mainPage, panel).catch(() => null)
}

async function pluginSeen(name: string): Promise<PluginSeen> {
  return (await mainPage.evaluate((sel: string) => {
    const panel = document.querySelector(sel)
    const tile = panel?.querySelector('[data-dashboard-tile]')
    let hooks: unknown[] = []
    try {
      hooks = JSON.parse(tile?.querySelector('[data-dashboard-hooks]')?.textContent || '[]')
    } catch {
      hooks = []
    }
    return {
      title: tile?.getAttribute('data-dashboard-title') ?? panel?.getAttribute('data-plugin-title') ?? '',
      status: tile?.getAttribute('data-dashboard-status') ?? (panel?.querySelector('[data-plugin-problem]') ? 'error' : panel ? 'ok' : ''),
      error: tile?.querySelector('[data-dashboard-error]')?.textContent ?? '',
      problem: panel?.querySelector('[data-plugin-problem]')?.textContent ?? '',
      hooks,
      tile: !!tile,
      outline: tile?.querySelector('[data-dashboard-outline]')?.textContent ?? ''
    }
  }, pluginPanel(name))) as PluginSeen
}

async function openPlugin(name: string): Promise<unknown> {
  const res = (await rpc('plugins', { window: null, action: 'open', name })) as PluginOpened
  await pluginSettled(name)
  const seen = await pluginSeen(name)
  const errors: Options = {}
  if (res.compile && res.compile.panel !== 'ok') errors.panel = res.compile.panel
  else if (seen.status === 'error' && seen.error) errors.panel = seen.error
  if (seen.problem) errors.plugin = seen.problem
  if (res.compile?.exec && res.compile.exec !== 'ok') errors.exec = res.compile.exec
  else if (res.compile?.exec) {
    const m = pluginModule(name)
    if (m instanceof Error) errors.exec = m.message
  }
  return { name, source: res.source, title: seen.title || res.title, status: seen.status, tab: res.tabId, errors }
}

async function readPlugin(name: string): Promise<unknown> {
  const shown = (await mainPage.evaluate((sel: string) => !!document.querySelector(sel), pluginPanel(name))) as boolean
  if (shown) await pluginSettled(name)
  else await openPlugin(name)
  const seen = await pluginSeen(name)
  const aria = seen.tile ? seen.outline : await snapshot(mainPage.locator(pluginPanel(name)).first()).catch((e: Error) => `(no snapshot: ${e.message})`)
  const loaded = seen.tile && pluginLoads.has(name) ? pluginModule(name) : null
  const execError = loaded instanceof Error ? loaded.message : ''
  return {
    name,
    title: seen.title,
    status: seen.status,
    ...(seen.error ? { error: seen.error } : {}),
    ...(seen.problem ? { problem: seen.problem } : {}),
    ...(execError ? { execError } : {}),
    hooks: seen.hooks,
    aria
  }
}

async function listPlugins(): Promise<unknown[]> {
  const r = (await rpc('plugins', { action: 'list' })) as { project: string; builtIn: BuiltInRow[]; own: ProjectRow[] }
  const own = r.own.map(({ dir: _dir, ...p }) => {
    const errors = [...p.errors]
    let functions: string[] = []
    if (p.exec && !errors.length) {
      const m = pluginModule(p.name)
      if (m instanceof Error) errors.push(m.message)
      else functions = pluginFunctions(p.name).map((f) => pluginCall(p.name, f))
    }
    return { ...p, functions, errors }
  })
  return [...r.builtIn.map((b) => ({ ...b, functions: b.functions.map((f) => `${f}()`), errors: [] })), ...own]
}

const pluginsApi: Options = {
  list: () => step('plugins.list', listPlugins),
  open: (name?: unknown) => {
    const n = textArg(name, "plugins.open() takes the plugin's name as a string, like plugins.open('scene-stats')").trim()
    return step(`plugins.open ${n}`, () => openPlugin(n))
  },
  read: (name?: unknown) => {
    const n = textArg(name, "plugins.read() takes the plugin's name as a string, like plugins.read('scene-stats')").trim()
    return step(`plugins.read ${n}`, () => readPlugin(n))
  }
}

type LiveInstance = { lifecycle?: string }

async function unityRoot(folder: string): Promise<string> {
  const dir = (await playerRows(folder)).find((r) => r.role === 'primary')?.dir
  if (!dir) throw new Error(folder ? `No Unity editor is running in ${folder}. Start it with scratchpad.start().` : 'No Unity editor is running for this project. Start one with unity.relaunch().')
  return dir.replace(/\\/g, '/')
}

async function liveInstances(root: string): Promise<LiveInstance[]> {
  const world = (await mainPage.evaluate((p: string) => (window as any).api.unity.getWorld(p), root)) as { observed?: { instances?: Record<string, LiveInstance> } } | null
  return Object.values(world?.observed?.instances ?? {}).filter((i) => i.lifecycle !== 'exited')
}

async function playerRows(folder: string): Promise<{ role: string; dir: string }[]> {
  return ((await rpc('mcp', { fn: 'unity.players', args: folder ? { project: folder } : {}, quiet: true })) as { value: { role: string; dir: string }[] }).value
}

async function changePlayers(add: boolean, options: unknown, folder = ''): Promise<unknown> {
  const call = add ? 'unity.addPlayer' : 'unity.removePlayer'
  const o = checked(options, `${call}()`, ['timeout'])
  if (/[\\/]Library[\\/]VP[\\/]mppm[0-9a-f]{8}[\\/]*$/.test(folder)) throw new TypeError(`${folder} is a multiplayer clone. Players are added and removed on the project or a scratchpad.`)
  return step(folder ? `${call} ${fileName(folder)}` : call, async () => {
    const root = await unityRoot(folder)
    const before = (await liveInstances(root)).length
    const rowsBefore = (await playerRows(folder)).length
    if (!add && before < 2) throw new Error('There is only the primary editor: no multiplayer player to remove.')
    const r = (await mainPage.evaluate((a: { p: string; add: boolean }) => (a.add ? (window as any).api.unity.addPlayer(a.p) : (window as any).api.unity.removePlayer(a.p)), { p: root, add })) as { ok?: boolean; error?: string } | null
    if (r && r.ok === false) {
      const err = new Error(r.error || (add ? 'Adding a player failed.' : 'Removing a player failed.'))
      if (r.error?.startsWith('INPUT SYSTEM REQUIRED')) err.name = 'InputSystemRequired'
      throw err
    }
    const limit = (Number(o.timeout) || 300) * 1000
    const until = Date.now() + limit
    for (;;) {
      const live = await liveInstances(root)
      const rows = (await playerRows(folder)).length
      const changed = add ? live.length > before && rows > rowsBefore : live.length < before && rows < rowsBefore
      if (changed && live.every((i) => i.lifecycle === 'editmode')) break
      if (Date.now() > until) throw new Error(`The player count didn't change within ${limit / 1000}s. Check unity.status() and unity.logs().`)
      await sleep(1000)
    }
    return playerRows(folder)
  })
}

Object.assign(unityParts.unity, {
  addPlayer: (options?: unknown) => changePlayers(true, options),
  removePlayer: (options?: unknown) => changePlayers(false, options)
})

const tunerFilter = async (args: Options): Promise<string> =>
  String(((await rpc('mcp', { fn: 'tuner.filter', args, label: `tuner.open ${String(args.name ?? '')}` })) as { value: unknown }).value ?? '')
const tunerObject = tunerApi(mainPage, tunerRpc, tunerFilter)
const tunerOpen = tunerObject.open as (options?: Options) => Promise<string>
tunerObject.open = (options?: Options) => {
  const o = options && typeof options === 'object' ? options : {}
  const what = ['scene', 'prefab', 'object', 'ui'].map((k) => (typeof o[k] === 'string' ? fileName(o[k]) : o[k] === true ? k : '')).find(Boolean) ?? ''
  return filteredOpen(o) ? tunerOpen(o) : step(`tuner.open ${what}`.trim(), () => tunerOpen(o))
}

const unityAt = unityParts.unity.at as (folder: unknown) => Options
unityParts.unity.at = (folder: unknown) => {
  const bound = unityAt(folder)
  const dir = String(folder).trim()
  return {
    ...bound,
    addPlayer: (options?: unknown) => changePlayers(true, options, dir),
    removePlayer: (options?: unknown) => changePlayers(false, options, dir),
    tuner: { open: (options?: Options) => (tunerObject.open as (o: Options) => Promise<string>)({ ...(options && typeof options === 'object' ? options : {}), scratchpad: dir }) }
  }
}

type PadState = { kind?: string; path: string; scratchpad?: string; scratchpadName?: string }

async function scratchpadObject(ref: string, report?: unknown): Promise<Options> {
  const st = (await rpc('unityMode', /[\\/]/.test(ref) ? { op: 'get', path: ref } : { op: 'get', scratchpad: ref })) as PadState
  if (st.kind !== 'scratchpad') throw new TypeError(`${ref} is not a scratchpad of this project. scratchpad.list() shows them.`)
  const pad: Options = { id: st.scratchpad ?? ref, name: st.scratchpadName ?? ref, path: st.path }
  if (report !== undefined) pad.report = report
  const { at: _at, ...calls } = (unityParts.unity.at as (folder: unknown) => Options)(st.path)
  for (const [key, value] of Object.entries(calls)) Object.defineProperty(pad, key, { value, enumerable: false })
  return pad
}

const padCalls = unityParts.scratchpad as Record<string, (...args: unknown[]) => Promise<unknown>>
for (const call of ['create', 'start', 'restart']) {
  const run = padCalls[call]
  padCalls[call] = async (id?: unknown, options?: unknown) => {
    const report = await run(id, options)
    const ref = typeof id === 'string' && id.trim() ? id.trim() : (/ {2}id=(\S+) {2}/.exec(String(report ?? ''))?.[1] ?? '')
    return scratchpadObject(ref, report)
  }
}
padCalls.get = (id?: unknown) => {
  const ref = textArg(id, "scratchpad.get() takes the scratchpad's name, id or folder as a string, from scratchpad.list()").trim()
  if (!ref) throw new TypeError("scratchpad.get() takes the scratchpad's name, id or folder as a string, from scratchpad.list()")
  return scratchpadObject(ref)
}

const driftObject = driftApi(mainPage as any, tunerObject, point, say, ask, (tab) => rpc('tabs', { window: null, action: 'switch', tab }))
const lookHere = driftObject.look as (target?: unknown) => Promise<unknown>
driftObject.look = async (target?: unknown): Promise<unknown> => {
  const seen = await lookHere(target)
  const wide = target === undefined || target === null || target === '' || target === 'scene' || (typeof target === 'string' && /^ui:?$/i.test(target.trim()))
  if (!wide || !seen || typeof seen !== 'object') return seen
  const phone = (await rpc('tabs', { action: 'phone' }).catch(() => null)) as Options | null
  return phone?.connected ? { ...(seen as Options), phone: phone.summary } : seen
}
Object.assign(driftObject, {
  clock: async (mode?: unknown): Promise<boolean> => {
    if (mode !== 'step' && mode !== 'real') throw new TypeError("drift.clock() takes 'step' or 'real'")
    if (await driftOff('drift.clock()')) return false
    return (await rpc('driftClock', { window: null, step: mode === 'step' })) === true
  },
  advance: async (ms?: unknown): Promise<number> => {
    const n = typeof ms === 'number' ? ms : Number.NaN
    if (!Number.isFinite(n) || n < 0 || n > 10000) throw new RangeError(`drift.advance(ms) moves Drift's clock 0 to 10000 ms, got ${String(ms)}`)
    if (await driftOff('drift.advance()')) return -1
    return Number(await rpc('driftClock', { window: null, advance: n }))
  }
})

const api: Record<string, unknown> = {
  page: mainPage,
  tuner: tunerObject,
  drift: driftObject,
  show,
  unity: unityParts.unity,
  handles: unityParts.handles,
  scratchpad: unityParts.scratchpad,
  env: unityParts.env,
  video,
  report,
  dashboard,
  plugins: pluginsApi,
  app,
  agents,
  logs,
  shot,
  snapshot,
  say,
  point,
  ask,
  sleep,
  console: sandboxConsole,
  setTimeout: setTimeoutShim,
  clearTimeout: clearTimeoutShim
}

for (const [name, value] of Object.entries(api)) {
  Object.defineProperty(g, name, { value, writable: false, configurable: false, enumerable: true })
}

for (const [name, fns] of Object.entries(startup.plugins && typeof startup.plugins === 'object' ? startup.plugins : {})) {
  if (name in g || !Array.isArray(fns)) continue
  const calls = Object.fromEntries(fns.map((fn) => [String(fn), (...args: unknown[]) => rpc('plugin', { plugin: name, fn: String(fn), args })]))
  Object.defineProperty(g, name, { value: Object.freeze(calls), writable: false, configurable: false, enumerable: true })
}
g.__saturaModule = (name: string, load: unknown, error: string): void => {
  if (name in pluginsApi) return
  pluginLoads.set(name, { load: typeof load === 'function' ? (load as (exports: Options) => void) : null, error })
  Object.defineProperty(pluginsApi, name, { get: () => pluginObject(name), enumerable: true })
}
g.__saturaDeliver = settle
g.__saturaStart = start
