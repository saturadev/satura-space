import { postToShell } from '../shell-bus'

const SLOP_PX = 8
const DRAG_SLOP_PX = 3
const HOLD_MS = 500
const TAP_GAP_MS = 380
const DBL_TAP_MS = 700
const TAP_NEAR_PX = 30
const HANDLE_SNAP_PX = 16
const HANDLE_MAX_PX = 32
const TRACK_PAD_PX = 10
const DOT_MAX_PX = 20
const DOT_NEAR_PX = 6
const THUMB_SNAP_PX = 16
const SMALL_SNAP_PX = 12
const SMALL_MAX_PX = 24
const PRIMER_MS = 2500
const FRICTION = 0.92

const TWO_D_CURSORS = new Set(['move', 'crosshair', 'grab', 'nwse-resize', 'nesw-resize', 'ns-resize', 'row-resize', 'zoom-in'])
const SCRUB_CURSORS = new Set(['ew-resize', 'col-resize'])
const SMALL_WIDGETS = new Set([
  'toggle',
  'foldout',
  'titlebarFoldout',
  'iconButton',
  'paneOptions',
  'plusButton',
  'miniButton',
  'objectPicker',
  'dropdownArrow',
  'linkButton',
  'listFooterButton',
  'objectThumbMini',
  'objectThumbSelect'
])
const HIT_WIDGETS = new Set([...SMALL_WIDGETS, 'field', 'boldField', 'searchField', 'popup', 'button', 'colorField', 'sliderTrack', 'sliderThumb', 'objectThumb', 'tab', 'command', 'dragHandle'])
const TEXT_WIDGETS = new Set(['field', 'boldField', 'searchField'])
const UITK_HIT = new Set(['Toggle', 'Button', 'Foldout', 'PopupField', 'EnumField', 'DropdownField', 'ObjectField', 'ColorField', 'CurveField', 'GradientField', 'Slider', 'SliderInt', 'MinMaxSlider', 'TextField', 'FloatField', 'IntegerField'])
const PASS_THROUGH = '[data-psc-count], input, textarea, [contenteditable=""], [contenteditable="true"], [data-ti-text-overlay], [data-uitk-edit]'

type Mode = 'pending' | 'drag' | 'scrub' | 'scroll' | 'held' | 'idle'

interface Point {
  x: number
  y: number
}

interface Hint {
  at: Point
  zone: '2d' | 'x' | null
  text: boolean
  why: string
}

interface Gesture {
  pointerId: number
  canvas: HTMLElement
  target: Element
  start: Point
  hint: Hint
  mode: Mode
  out: Point
  last: Point
  timer: ReturnType<typeof setTimeout> | null
  box: HTMLElement | null
  zoom: number
  lastY: number
  lastT: number
  velocity: number
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

function rectOf(el: Element): Rect {
  const b = el.getBoundingClientRect()
  return { x: b.left, y: b.top, w: b.width, h: b.height }
}

function inside(r: Rect, p: Point, pad = 0): boolean {
  return p.x >= r.x - pad && p.y >= r.y - pad && p.x <= r.x + r.w + pad && p.y <= r.y + r.h + pad
}

function center(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

function distTo(r: Rect, p: Point): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w))
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h))
  return Math.hypot(dx, dy)
}

function scrollerOf(el: Element): HTMLElement | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight) return n
  }
  return null
}

function zoomOf(box: HTMLElement | null): number {
  if (!box || !box.offsetHeight) return 1
  const k = box.getBoundingClientRect().height / box.offsetHeight
  return k > 0.2 && k < 5 ? k : 1
}

function visible(r: Rect): boolean {
  return r.w > 0.5 && r.h > 0.5
}

function trackball(canvas: Element, p: Point): Rect | null {
  for (const thumb of canvas.querySelectorAll('[data-ti-style$="2DThumb"]')) {
    const c = center(rectOf(thumb))
    const scope = thumb.closest('[data-ti-imgui-island], [data-ti-section]') ?? canvas
    for (const tex of scope.querySelectorAll('[data-ti-tex]')) {
      const r = rectOf(tex)
      if (r.w < 40 || Math.abs(r.w - r.h) > 4 || !inside(r, c)) continue
      const o = center(r)
      if (Math.hypot(p.x - o.x, p.y - o.y) <= r.w * 0.4 + 6) return r
    }
  }
  return null
}

function isTrack(el: Element): boolean {
  return el.getAttribute('data-ti-widget') === 'sliderTrack' || el.getAttribute('data-uitk-name') === 'unity-drag-container'
}

function hits(el: Element): boolean {
  const w = el.getAttribute('data-ti-widget')
  if (w) return HIT_WIDGETS.has(w)
  return UITK_HIT.has(el.getAttribute('data-uitk-type') ?? '')
}

function hintAt(canvas: HTMLElement, target: Element, p: Point): Hint {
  if (trackball(canvas, p)) return { at: p, zone: '2d', text: false, why: 'trackball' }
  const controls = [...canvas.querySelectorAll('[data-ti-widget], [data-uitk-type], [data-uitk-name="unity-drag-container"]')].filter((el) => hits(el) || isTrack(el))
  const direct = controls.filter((el) => inside(rectOf(el), p))
  const onTrack = direct.find(isTrack) ?? null
  const onOther = direct.some((el) => !isTrack(el) && el.getAttribute('data-ti-widget') !== 'sliderThumb' && !el.querySelector('[data-uitk-name="unity-drag-container"]'))
  let text = false
  let scrub = false
  let area = false
  const dots = [...canvas.querySelectorAll('[data-ti-rect], [data-ti-style], [data-ti-tex], [data-ti-vector]')]
    .map(rectOf)
    .filter((r) => visible(r) && r.w <= DOT_MAX_PX && r.h <= DOT_MAX_PX)
    .map(center)
  const drawn = (r: Rect): boolean => {
    const c = center(r)
    return dots.some((d) => Math.abs(d.x - c.x) <= DOT_NEAR_PX && Math.abs(d.y - c.y) <= DOT_NEAR_PX)
  }
  let best: { at: Point; d: number; why: string } | null = null
  const offer = (r: Rect, radius: number, why: string): void => {
    if (!visible(r)) return
    const c = center(r)
    const d = Math.hypot(c.x - p.x, c.y - p.y)
    if (d > radius + Math.max(r.w, r.h) / 2 || (best && best.d <= d)) return
    best = { at: c, d, why }
  }
  for (const el of canvas.querySelectorAll('[data-ti-cursor]')) {
    const kind = el.getAttribute('data-ti-cursor') ?? ''
    const r = rectOf(el)
    if (kind === 'text' && inside(r, p)) text = true
    else if (SCRUB_CURSORS.has(kind) && inside(r, p)) scrub = true
    else if (TWO_D_CURSORS.has(kind)) {
      if (r.w <= HANDLE_MAX_PX && r.h <= HANDLE_MAX_PX) {
        if (!onOther && drawn(r)) offer(r, HANDLE_SNAP_PX, `${kind} handle`)
      } else if (inside(r, p)) area = true
    }
  }
  if (!onOther) for (const el of canvas.querySelectorAll('[data-ti-widget="dragHandle"], [data-uitk-class*="reorderable-handle"]')) offer(rectOf(el), HANDLE_SNAP_PX, 'drag handle')
  const handle = best as { at: Point; d: number; why: string } | null
  if (handle) return { at: handle.at, zone: '2d', text: false, why: handle.why }
  if (area) return { at: p, zone: '2d', text: false, why: '2D area' }
  if (!onOther) {
    let thumb: { at: Point; d: number } | null = null
    for (const el of canvas.querySelectorAll('[data-ti-widget="sliderThumb"], [data-uitk-name="unity-dragger"]')) {
      const r = rectOf(el)
      const c = center(r)
      const d = Math.hypot(c.x - p.x, c.y - p.y)
      if (visible(r) && d <= THUMB_SNAP_PX + r.w / 2 && (!thumb || d < thumb.d)) thumb = { at: c, d }
    }
    if (thumb) return { at: thumb.at, zone: 'x', text: false, why: 'slider thumb' }
    const track =
      onTrack ??
      controls.find((el) => {
        const r = rectOf(el)
        return isTrack(el) && visible(r) && inside(r, p, TRACK_PAD_PX) && p.x >= r.x && p.x <= r.x + r.w
      })
    if (track) {
      const r = rectOf(track)
      return { at: { x: p.x, y: r.y + r.h / 2 }, zone: 'x', text: false, why: 'slider track' }
    }
  }
  if (scrub || target.closest('[data-uitk-class*="label--with-dragger"]')) return { at: p, zone: 'x', text: false, why: 'scrub label' }
  if (text || direct.some((el) => TEXT_WIDGETS.has(el.getAttribute('data-ti-widget') ?? '') && !el.hasAttribute('data-ti-off'))) return { at: p, zone: null, text: true, why: 'text field' }
  if (direct.length) return { at: p, zone: null, text: false, why: 'control' }
  let near: { r: Rect; d: number } | null = null
  for (const el of controls) {
    const w = el.getAttribute('data-ti-widget')
    if (!w || !SMALL_WIDGETS.has(w)) continue
    const r = rectOf(el)
    if (!visible(r) || r.w > SMALL_MAX_PX * 2 || r.h > SMALL_MAX_PX) continue
    const d = distTo(r, p)
    if (d <= SMALL_SNAP_PX && (!near || d < near.d)) near = { r, d }
  }
  if (near) return { at: center(near.r), zone: null, text: false, why: 'small control' }
  return { at: p, zone: null, text: false, why: 'plain' }
}

function scrubGain(dy: number): number {
  const d = Math.abs(dy)
  return d < 48 ? 1 : d < 96 ? 0.5 : d < 144 ? 0.25 : 0.1
}

let primer: HTMLInputElement | null = null
let primerCanvas: HTMLElement | null = null
let primerTimer: ReturnType<typeof setTimeout> | null = null
const PRIMER_INSET_PX = 8

export function primedField(el: Element | null): HTMLElement | null {
  return el && el === primer && el.isConnected ? primerCanvas : null
}

function primeKeyboard(canvas: HTMLElement, p: Point): void {
  const el = primer ?? document.createElement('input')
  primer = el
  primerCanvas = canvas
  el.type = 'text'
  el.tabIndex = -1
  el.setAttribute('aria-hidden', 'true')
  el.setAttribute('data-ti-keyboard-primer', '')
  const top = (canvas.closest('[data-phone-panel]') ?? canvas).getBoundingClientRect().top + PRIMER_INSET_PX
  Object.assign(el.style, { position: 'fixed', left: `${Math.round(p.x)}px`, top: `${Math.round(top)}px`, width: '1px', height: '1px', opacity: '0', fontSize: '16px', border: '0', padding: '0', pointerEvents: 'none' })
  if (!el.isConnected) document.body.appendChild(el)
  el.focus({ preventScroll: true })
  if (primerTimer) clearTimeout(primerTimer)
  primerTimer = setTimeout(() => {
    primerTimer = null
    if (document.activeElement === el) el.blur()
    el.remove()
  }, PRIMER_MS)
}

export function installInspectorTouch(): void {
  let g: Gesture | null = null
  let coast = 0
  let lastTap: { t: number; p: Point; n: number; gs: Gesture } | null = null

  const stopCoast = (): void => {
    if (coast) cancelAnimationFrame(coast)
    coast = 0
  }

  const fire = (type: string, gs: Gesture, p: Point, opts: { button?: number; buttons?: number; detail?: number } = {}): void => {
    const target = gs.target.isConnected ? gs.target : (document.elementFromPoint(p.x, p.y) ?? gs.canvas)
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: gs.pointerId,
        pointerType: 'touch',
        isPrimary: true,
        clientX: p.x,
        clientY: p.y,
        screenX: p.x,
        screenY: p.y,
        button: opts.button ?? (type === 'pointermove' ? -1 : 0),
        buttons: opts.buttons ?? (type === 'pointerup' ? 0 : 1),
        detail: opts.detail ?? 0,
        view: window
      })
    )
  }

  const clearHold = (gs: Gesture): void => {
    if (gs.timer) clearTimeout(gs.timer)
    gs.timer = null
  }

  const begin = (gs: Gesture, mode: 'drag' | 'scrub'): void => {
    clearHold(gs)
    gs.mode = mode
    gs.out = { ...gs.hint.at }
    console.info(`[tuner] touch ${mode === 'drag' ? 'drags' : 'scrubs'} the ${gs.hint.why} at ${Math.round(gs.out.x)},${Math.round(gs.out.y)}`)
    fire('pointerdown', gs, gs.out, { detail: 1 })
  }

  const hold = (gs: Gesture): void => {
    gs.timer = null
    if (g !== gs || gs.mode !== 'pending') return
    gs.mode = 'held'
    lastTap = null
    console.info(`[tuner] touch long-press on the ${gs.hint.why}: context click at ${Math.round(gs.hint.at.x)},${Math.round(gs.hint.at.y)}`)
    postToShell({ type: 'haptic' })
    fire('pointerdown', gs, gs.hint.at, { button: 2, buttons: 2, detail: 1 })
    fire('pointerup', gs, gs.hint.at, { button: 2, buttons: 0, detail: 1 })
  }

  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isTrusted || e.pointerType !== 'touch' || !(e.target instanceof Element)) return
      const canvas = e.target.closest<HTMLElement>('[data-ti-canvas]')
      if (!canvas) return
      if (g) {
        e.stopImmediatePropagation()
        if (g.mode === 'pending') {
          clearHold(g)
          g.mode = 'idle'
        }
        return
      }
      if (e.target.closest(PASS_THROUGH)) return
      e.stopImmediatePropagation()
      stopCoast()
      const start = { x: e.clientX, y: e.clientY }
      const box = scrollerOf(canvas)
      const hint = hintAt(canvas, e.target, start)
      const gs: Gesture = {
        pointerId: e.pointerId,
        canvas,
        target: e.target,
        start,
        hint,
        mode: 'pending',
        out: { ...hint.at },
        last: start,
        timer: null,
        box,
        zoom: zoomOf(box),
        lastY: start.y,
        lastT: performance.now(),
        velocity: 0
      }
      gs.timer = setTimeout(() => hold(gs), HOLD_MS)
      g = gs
    },
    true
  )

  window.addEventListener(
    'pointermove',
    (e) => {
      if (!e.isTrusted || e.pointerType !== 'touch' || !g) return
      if (e.pointerId !== g.pointerId) {
        if (g.canvas.contains(e.target as Node)) e.stopImmediatePropagation()
        return
      }
      e.stopImmediatePropagation()
      const gs = g
      const p = { x: e.clientX, y: e.clientY }
      const dx = p.x - gs.start.x
      const dy = p.y - gs.start.y
      if (gs.mode === 'pending') {
        const moved = Math.hypot(dx, dy)
        if (gs.hint.zone === '2d') {
          if (moved < DRAG_SLOP_PX) return
          begin(gs, 'drag')
        } else {
          if (moved < SLOP_PX) return
          if (gs.hint.zone === 'x' && Math.abs(dx) > Math.abs(dy)) begin(gs, 'scrub')
          else {
            clearHold(gs)
            gs.mode = 'scroll'
            lastTap = null
            console.info(`[tuner] touch scrolls the inspector from ${Math.round(gs.box?.scrollTop ?? 0)}`)
          }
        }
        gs.last = gs.start
      }
      if (gs.mode === 'drag') {
        gs.out = { x: gs.hint.at.x + dx, y: gs.hint.at.y + dy }
        fire('pointermove', gs, gs.out)
      } else if (gs.mode === 'scrub') {
        gs.out = { x: gs.out.x + (p.x - gs.last.x) * scrubGain(dy), y: gs.hint.at.y }
        fire('pointermove', gs, gs.out)
      } else if (gs.mode === 'scroll' && gs.box) {
        const now = performance.now()
        const step = (p.y - gs.lastY) / gs.zoom
        gs.box.scrollTop -= step
        gs.velocity = 0.8 * (-step / Math.max(1, now - gs.lastT)) + 0.2 * gs.velocity
        gs.lastY = p.y
        gs.lastT = now
      }
      gs.last = p
    },
    true
  )

  const end = (e: PointerEvent): void => {
    if (!e.isTrusted || e.pointerType !== 'touch' || !g) return
    if (e.pointerId !== g.pointerId) {
      if (g.canvas.contains(e.target as Node)) e.stopImmediatePropagation()
      return
    }
    e.stopImmediatePropagation()
    const gs = g
    g = null
    clearHold(gs)
    if (gs.mode === 'pending' && e.type === 'pointerup') {
      const now = performance.now()
      const again = lastTap && now - lastTap.t <= TAP_GAP_MS && Math.hypot(gs.hint.at.x - lastTap.p.x, gs.hint.at.y - lastTap.p.y) <= TAP_NEAR_PX
      const n = again && lastTap ? lastTap.n + 1 : 1
      lastTap = { t: now, p: gs.hint.at, n, gs }
      console.info(`[tuner] touch ${n > 1 ? `${n}x tap` : 'tap'} on the ${gs.hint.why} at ${Math.round(gs.hint.at.x)},${Math.round(gs.hint.at.y)}`)
      fire('pointerdown', gs, gs.hint.at, { detail: n })
      fire('pointerup', gs, gs.hint.at, { detail: n })
      if (gs.hint.text && n === 1) primeKeyboard(gs.canvas, gs.hint.at)
      return
    }
    if (gs.mode === 'drag' || gs.mode === 'scrub') {
      fire('pointerup', gs, gs.out, { detail: 1 })
      console.info(`[tuner] touch ${gs.mode} ended at ${Math.round(gs.out.x)},${Math.round(gs.out.y)}`)
      return
    }
    if (gs.mode === 'pending') console.info(`[tuner] touch on the ${gs.hint.why} cancelled by the browser`)
    if (gs.mode !== 'scroll' || !gs.box) return
    const box = gs.box
    console.info(`[tuner] touch scroll ended at ${Math.round(box.scrollTop)} of ${Math.round(box.scrollHeight - box.clientHeight)}`)
    let v = gs.velocity * 16
    const step = (): void => {
      v *= FRICTION
      if (Math.abs(v) < 0.5) {
        coast = 0
        return
      }
      box.scrollTop += v
      coast = requestAnimationFrame(step)
    }
    if (Math.abs(v) > 2) coast = requestAnimationFrame(step)
  }
  window.addEventListener('pointerup', end, true)
  window.addEventListener('pointercancel', end, true)

  window.addEventListener(
    'mousedown',
    (e) => {
      if (primer && document.activeElement === primer && e.target instanceof Node && primerCanvas?.closest('.remote-tuner')?.contains(e.target)) e.preventDefault()
    },
    true
  )

  window.addEventListener(
    'dblclick',
    (e) => {
      if (!e.isTrusted || g || !(e.target instanceof Element)) return
      const canvas = e.target.closest<HTMLElement>('[data-ti-canvas]')
      if (!canvas || e.target.closest(PASS_THROUGH)) return
      const prev = lastTap
      const p = { x: e.clientX, y: e.clientY }
      if (!prev || prev.n !== 1 || performance.now() - prev.t > DBL_TAP_MS || Math.hypot(p.x - prev.p.x, p.y - prev.p.y) > TAP_NEAR_PX) return
      e.stopImmediatePropagation()
      e.preventDefault()
      const hint = hintAt(canvas, e.target, p)
      const gs: Gesture = { ...prev.gs, canvas, target: e.target, start: p, hint, out: { ...hint.at }, mode: 'idle' }
      lastTap = { t: performance.now(), p: hint.at, n: 2, gs }
      console.info(`[tuner] touch 2x tap on the ${hint.why} at ${Math.round(hint.at.x)},${Math.round(hint.at.y)}`)
      fire('pointerdown', gs, hint.at, { detail: 2 })
      fire('pointerup', gs, hint.at, { detail: 2 })
    },
    true
  )

  document.addEventListener(
    'touchmove',
    (e) => {
      if (g && e.cancelable) e.preventDefault()
    },
    { capture: true, passive: false }
  )
}
