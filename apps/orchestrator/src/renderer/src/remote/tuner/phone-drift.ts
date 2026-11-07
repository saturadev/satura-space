import { Drift } from '../../../../main/satura-exec/page/drift'
import { WorkspaceScope } from '../../../../main/satura-exec/page/scope'
import { Anchor, type PartBox } from '../../../../main/satura-exec/page/anchor'
import { exactPart, labelPart, valuePart, whole, type Part } from '../../../../main/satura-exec/page/field-part'
import { gizmoBox } from '../../../../main/satura-exec/page/gizmo'
import { clientRect } from '../../../../main/satura-exec/page/rect'
import { describeDriftSpot, type DriftSpot, type PhoneDriftCue } from '@shared/drift-spot'
import { collapseExpanded } from '../expand'
import { phoneTunerControls } from '../../components/tuner/PaneTunerSlot'
import { phoneShows } from '../phone-panels'

const FIND_MS = 2500
const ASK_POLL_MS = 120
const SMALL_PX = 860
const REVEAL_PAD = 28
const LAG_MAX_MS = 2000
const IDLE_MS = 15_000
const WATCH_MS = 1000
const STALE_AFTER = 3
const ANSWERED_MAX = 16

type Spot = (el: Element) => PartBox | null

interface Hit {
  el: Element
  part: Spot
}

interface RowsApi {
  find: (want: string) => { key: string } | null
  load?: (want: string) => boolean
  reveal: (key: string) => boolean
}

const queue: PhoneDriftCue[] = []
let working = false
let drift: Drift | null = null
let scope: WorkspaceScope | null = null
let run = -1
let asking: { run: number; seq: number } | null = null
let busyUntil = 0
let heardAt = 0
let runWorkspace = ''
let watchdog: ReturnType<typeof setInterval> | null = null
const answered = new Map<string, string | null>()

function log(c: PhoneDriftCue, line: string): void {
  console.info(`[drift] phone #${c.seq} ${c.op}: ${line}`)
}

function frame(): Promise<void> {
  return new Promise((r) => {
    requestAnimationFrame(() => r())
    setTimeout(r, 100)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function until<T>(get: () => T | null | undefined, ms = FIND_MS): Promise<T | null> {
  const end = performance.now() + ms
  for (;;) {
    const v = get()
    if (v) return v
    if (performance.now() > end) return null
    await sleep(50)
  }
}

function shown(el: Element | null | undefined): el is Element {
  if (!el || !el.isConnected) return false
  const r = clientRect(el)
  return r.width > 0 && r.height > 0
}

function ensure(c: PhoneDriftCue): Drift {
  if (!drift) {
    scope = new WorkspaceScope(window, '')
    drift = new Drift(window, scope)
  }
  drift.cell = window.innerWidth < SMALL_PX ? 0.62 : 1
  if (run !== c.run) {
    run = c.run
    asking = null
    drift.begin(c.name || 'Drift')
  }
  return drift
}

function tunerRoot(tab: string): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>('.remote-tuner [data-tuner-pane]')).filter(shown)
  return all.find((el) => !tab || el.getAttribute('data-tuner-tab') === tab) ?? null
}

function unfold(tab: string, pane: 'hierarchy' | 'inspector', why: string): void {
  phoneTunerControls.get(tab)?.fold(pane, true, why)
}

async function applySearch(root: HTMLElement, tab: string, q: string, c: PhoneDriftCue): Promise<void> {
  let box = root.querySelector<HTMLInputElement>('[data-hierarchy-search]')
  if (!box && q) {
    unfold(tab, 'hierarchy', 'Drift searches the hierarchy')
    box = await until(() => root.querySelector<HTMLInputElement>('[data-hierarchy-search]'), 1000)
  }
  if (!box || box.value === q) return
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, q)
  box.dispatchEvent(new Event('input', { bubbles: true }))
  log(c, q ? `hierarchy search "${q}" as on the Mac` : 'hierarchy search cleared as on the Mac')
}

function onScreenIn(el: Element, list: Element): boolean {
  const b = clientRect(el)
  const l = clientRect(list)
  return b.height > 0 && b.top >= l.top - 1 && b.bottom <= l.bottom + 1
}

function at(frac: { x: number; y: number }): Spot {
  return (e) => {
    const r = whole(e)
    return r ? { x: r.x + frac.x * r.width - 8, y: r.y + frac.y * r.height - 8, width: 16, height: 16 } : null
  }
}

async function findRow(root: HTMLElement, s: Extract<DriftSpot, { kind: 'row' }>): Promise<Hit | null> {
  unfold(s.tab, 'hierarchy', 'Drift shows a row')
  const list = await until(() => root.querySelector('[data-scene-hierarchy]'))
  if (!list) return null
  let key = ''
  let asked = false
  const el = await until(() => {
    const api = (list as Element & { __tunerRows?: RowsApi }).__tunerRows
    if (api && !key) {
      const hit = api.find(s.path) ?? null
      if (hit) {
        key = hit.key
        api.reveal(key)
      } else if (!asked) {
        asked = true
        api.load?.(s.path)
      }
    }
    const row = list.querySelector(`[data-row-key="${CSS.escape(key || s.key)}"]`)
    return row && onScreenIn(row, list) ? (row.querySelector('[data-row-label]') ?? row) : null
  })
  return el ? { el, part: exactPart(whole, 'row') } : null
}

async function findField(root: HTMLElement, s: Extract<DriftSpot, { kind: 'field' }>): Promise<Hit | null> {
  unfold(s.tab, 'inspector', 'Drift shows a field')
  const section = (): Element | null => root.querySelector(`[data-tuner-inspector] [data-ti-section="${CSS.escape(s.section)}"]`)
  const head = (sec: Element): Element => sec.querySelector('[data-ti-style="IN TitleText"], [data-ti-style="IN Title"], [data-ti-style="BoldTextField"]') ?? sec
  if (!s.prop) {
    const sec = await until(section)
    return sec ? { el: head(sec), part: exactPart(whole, 'component') } : null
  }
  const el = await until(() => section()?.querySelector(s.prop))
  if (el) {
    const side: Part = s.side === 'value' ? valuePart : s.side === 'label' ? labelPart : whole
    return { el, part: exactPart(side, s.side ?? 'field') }
  }
  const sec = section()
  return sec ? { el: head(sec), part: exactPart(whole, 'component') } : null
}

async function find(root: HTMLElement | null, s: DriftSpot): Promise<Hit | null> {
  if (s.kind === 'part' && (!root || !s.pane || !root.querySelector(s.pane))) {
    const pane = s.pane ? Array.from(document.querySelectorAll(s.pane)).find(shown) : null
    const own = pane && s.own ? Array.from(pane.querySelectorAll(s.own)).find(shown) : null
    if (s.own) return own ? { el: own, part: exactPart(whole, 'part') } : null
    return pane ? { el: pane, part: at(s) } : null
  }
  if (!root) return null
  if (s.kind === 'row') return findRow(root, s)
  if (s.kind === 'field') return findField(root, s)
  const viewport = (): Element | null => Array.from(root.querySelectorAll('[data-scene-viewport]')).find(shown) ?? null
  if (s.kind === 'gizmo') {
    const el = await until(() => {
      const v = viewport()
      return v && gizmoBox(v, s.gizmo, window) ? v : null
    })
    return el ? { el, part: (e) => gizmoBox(e, s.gizmo, window) } : null
  }
  if (s.kind === 'scene') {
    const el = await until(viewport)
    return el ? { el, part: at(s) } : null
  }
  const pane = Array.from(root.querySelectorAll(s.pane)).find(shown) ?? (root.matches(s.pane) ? root : null)
  if (!pane) return null
  if (!s.own) return { el: pane, part: at(s) }
  const own = await until(() => Array.from(pane.querySelectorAll(s.own)).find(shown), 600)
  return own ? { el: own, part: exactPart(whole, 'part') } : null
}

function scrolls(el: HTMLElement): boolean {
  const st = getComputedStyle(el)
  return (/(auto|scroll|overlay)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1) || (/(auto|scroll|overlay)/.test(st.overflowX) && el.scrollWidth > el.clientWidth + 1)
}

function need(a0: number, a1: number, v0: number, v1: number): number {
  const pad = Math.min(REVEAL_PAD, Math.max(0, (v1 - v0 - (a1 - a0)) / 2))
  const end = Math.min(a1, a0 + (v1 - v0) - 2 * pad)
  if (a0 < v0 + pad) return a0 - v0 - pad
  if (end > v1 - pad) return end - v1 + pad
  return 0
}

function plan(el: Element, box: PartBox): { pane: HTMLElement; dx: number; dy: number } | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (!scrolls(p)) continue
    const v = clientRect(p)
    const k = p.offsetWidth > 0 ? v.width / p.offsetWidth : 1
    const dy = need(box.y, box.y + box.height, v.top, v.top + p.clientHeight * k) / (k || 1)
    const dx = need(box.x, box.x + box.width, v.left, v.left + p.clientWidth * k) / (k || 1)
    const y = Math.max(0, Math.min(p.scrollHeight - p.clientHeight, p.scrollTop + dy)) - p.scrollTop
    const x = Math.max(0, Math.min(p.scrollWidth - p.clientWidth, p.scrollLeft + dx)) - p.scrollLeft
    if (Math.abs(x) >= 1 || Math.abs(y) >= 1) return { pane: p, dx: x, dy: y }
  }
  return null
}

function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

async function reveal(d: Drift, hit: Hit): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    const box = hit.part(hit.el)
    const p = box ? plan(hit.el, box) : null
    if (!p) return
    const v = clientRect(p.pane)
    const f = { x: 0.5, y: p.dy > 0 ? 0.62 : p.dy < 0 ? 0.38 : 0.5 }
    const shown = d.point({ x: v.left + v.width * f.x, y: v.top + v.height * f.y, box: null, text: '', mark: false, target: new Anchor(window, p.pane, f, 'the list it scrolls', scope!, null, () => 'the list it scrolls', exactPart(at(f), 'scroll')) })
    await sleep(shown.travel)
    const y0 = p.pane.scrollTop
    const x0 = p.pane.scrollLeft
    const ms = Math.max(320, Math.min(900, 240 + Math.hypot(p.dx, p.dy) * 0.9))
    const t0 = performance.now()
    let beat = -1
    for (;;) {
      const t = Math.min(1, (performance.now() - t0) / ms)
      const b = Math.floor((t * ms) / 260)
      if (b !== beat && t < 0.9) {
        beat = b
        d.stroke(p.dx, p.dy)
      }
      const k = ease(t)
      p.pane.scrollTop = y0 + p.dy * k
      p.pane.scrollLeft = x0 + p.dx * k
      if (t >= 1) break
      await frame()
    }
    await frame()
  }
}

async function aim(d: Drift, c: PhoneDriftCue, root: HTMLElement | null): Promise<{ box: PartBox; target: Anchor } | null> {
  const hit = c.spot ? await find(root, c.spot) : null
  if (!hit) {
    if (c.spot) log(c, `no ${describeDriftSpot(c.spot)} on the phone${root ? '' : ' (the phone shows another panel)'}, Drift says it without pointing`)
    return null
  }
  await reveal(d, hit)
  const box = hit.part(hit.el)
  if (!box) {
    log(c, `${describeDriftSpot(c.spot)} has no box on the phone, Drift says it without pointing`)
    return null
  }
  const desc = describeDriftSpot(c.spot)
  return { box, target: new Anchor(window, hit.el, { x: 0.5, y: 0.5 }, desc, scope!, null, () => desc, hit.part) }
}

function leave(why: string): void {
  if (!drift || run === -1) return
  asking = null
  run = -1
  runWorkspace = ''
  busyUntil = 0
  stopWatchdog()
  drift.bye(false)
  console.info(`[drift] phone: Drift leaves, ${why}`)
}

function stopWatchdog(): void {
  if (watchdog) clearInterval(watchdog)
  watchdog = null
}

function startWatchdog(): void {
  if (watchdog) return
  watchdog = setInterval(() => {
    if (run === -1) return stopWatchdog()
    const quiet = performance.now() - heardAt
    if (quiet > IDLE_MS) return leave(`no word from the desktop for ${Math.round(quiet / 1000)} s`)
    const here = phoneShows()
    if (!here.visible) return leave('the phone app went to the background')
    if (here.screen !== 'panel' || here.workspaceId !== runWorkspace) leave(`the phone left that workspace's panels (now ${here.screen})`)
  }, WATCH_MS)
}

function remember(c: PhoneDriftCue, label: string | null): void {
  answered.set(`${c.run}:${c.seq}`, label)
  while (answered.size > ANSWERED_MAX) answered.delete(answered.keys().next().value as string)
}

async function watchAsk(d: Drift, c: PhoneDriftCue): Promise<void> {
  for (;;) {
    await sleep(ASK_POLL_MS)
    if (!asking || asking.run !== c.run || asking.seq !== c.seq) return
    const r = d.asked(true)
    if (!r) {
      asking = null
      log(c, 'the question went away without an answer')
      return
    }
    if (!r.done) continue
    asking = null
    remember(c, r.label)
    log(c, `answered on the phone: ${r.label === null ? 'closed' : JSON.stringify(r.label)}`)
    window.api.tuner.driftAnswer({ run: c.run, seq: c.seq, label: r.label })
    return
  }
}

function dropStaleAsk(c: PhoneDriftCue): void {
  if (!asking || !drift) return
  if (asking.run === c.run && asking.seq === c.seq) return
  log(c, `the Mac moved on, the open question #${asking.seq} closes`)
  asking = null
  drift.cancelAsk()
}

async function handle(c: PhoneDriftCue): Promise<void> {
  if (c.op === 'answered') {
    if (!asking || asking.run !== c.run || !drift) return
    asking = null
    drift.answer(c.label ?? null, 'answered on the desktop')
    log(c, 'the Mac answered, the question closes')
    return
  }
  if (c.op === 'bye') {
    if (run !== c.run || !drift) return
    const root = tunerRoot('')
    if (root && typeof c.search === 'string') await applySearch(root, root.getAttribute('data-tuner-tab') ?? '', c.search, c)
    leave('the script ended')
    return
  }
  if (c.op === 'ask') {
    const key = `${c.run}:${c.seq}`
    if (answered.has(key)) {
      const label = answered.get(key) ?? null
      log(c, `asked again, sending the answer ${label === null ? 'closed' : JSON.stringify(label)} again`)
      window.api.tuner.driftAnswer({ run: c.run, seq: c.seq, label })
      return
    }
    if (asking && asking.run === c.run && asking.seq === c.seq) return
  }
  const here = phoneShows()
  if (!here.visible || here.screen !== 'panel' || here.workspaceId !== c.workspace) {
    log(c, `skipped: the phone shows ${here.screen}${here.workspaceId && here.workspaceId !== c.workspace ? ' of another workspace' : ''}${here.visible ? '' : ' in the background'}`)
    return
  }
  const wait = Math.min(busyUntil - performance.now(), LAG_MAX_MS)
  if (wait > 0 && run === c.run) await sleep(wait)
  dropStaleAsk(c)
  collapseExpanded('Drift shows something')
  const d = ensure(c)
  runWorkspace = c.workspace
  startWatchdog()
  const tab = c.spot?.tab ?? ''
  const root = tunerRoot(tab)
  if (root && typeof c.search === 'string') await applySearch(root, tab || (root.getAttribute('data-tuner-tab') ?? ''), c.search, c)
  if (run !== c.run) return
  if (c.op === 'say') {
    const r = d.sayFor(c.text ?? '', c.ms)
    busyUntil = performance.now() + r.travel + r.read
    log(c, `says "${c.text ?? ''}"`)
    return
  }
  const spot = await aim(d, c, root)
  if (run !== c.run) return
  if (c.op === 'point') {
    if (!spot) {
      const said = d.sayFor(c.text ?? '', c.ms)
      busyUntil = performance.now() + said.travel + said.read
      return
    }
    const { box, target } = spot
    const r = d.point({ x: box.x + box.width / 2, y: box.y + box.height / 2, box, text: c.text ?? '', ms: c.ms, slide: true, target })
    busyUntil = performance.now() + r.travel + r.read
    log(c, `points at ${describeDriftSpot(c.spot)} (${Math.round(r.x)}, ${Math.round(r.y)})${c.text ? ` and says "${c.text}"` : ''}`)
    return
  }
  if (c.op === 'ask') {
    const buttons = c.buttons?.length ? c.buttons : ['Next']
    d.ask(spot ? { x: spot.box.x + spot.box.width / 2, y: spot.box.y + spot.box.height / 2, box: spot.box, target: spot.target, text: c.text ?? '', buttons, focus: true } : { text: c.text ?? '', buttons, focus: true })
    asking = { run: c.run, seq: c.seq }
    busyUntil = 0
    log(c, `asks "${c.text ?? ''}" with ${buttons.map((b) => JSON.stringify(b)).join(', ')}`)
    void watchAsk(d, c)
  }
}

function stale(c: PhoneDriftCue): boolean {
  if (c.op !== 'point' && c.op !== 'say') return false
  const later = queue.filter((q) => q.run === c.run && (q.op === 'point' || q.op === 'say' || q.op === 'ask' || q.op === 'bye')).length
  return later >= STALE_AFTER
}

async function pump(): Promise<void> {
  if (working) return
  working = true
  try {
    while (queue.length) {
      const c = queue.shift()!
      if (stale(c)) {
        log(c, `skipped "${c.text ?? ''}": the Mac is ${queue.length} steps ahead`)
        continue
      }
      try {
        await handle(c)
      } catch (e) {
        console.warn(`[drift] phone #${c.seq} ${c.op} failed: ${(e as Error)?.message ?? e}`)
      }
    }
  } finally {
    working = false
  }
}

export function onPhoneDriftCue(c: PhoneDriftCue): void {
  heardAt = performance.now()
  queue.push(c)
  void pump()
}
