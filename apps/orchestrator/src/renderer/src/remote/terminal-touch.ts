import type { Terminal } from '@xterm/xterm'
import { setTermScrolling } from './term-perf'

const LONG_PRESS_MS = 450
const TAP_SLOP = 8
const TAP_MAX_MS = 350
const DECELERATION = 0.998
const MIN_SPEED = 0.02
const VELOCITY_WINDOW_MS = 100

export interface TerminalTouchOptions {
  term: () => Terminal | undefined
  onTapRow: (text: string, y: number) => boolean
  onSelect: (text: string) => void
  onLongPress: () => void
  onTapLink?: (x: number, y: number) => boolean
  onPinch?: (phase: 'start' | 'move' | 'end', k: number, mid: { x: number; y: number }) => void
}

function rowAt(term: Terminal, y: number): { text: string; y: number } | null {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) return null
  const r = screen.getBoundingClientRect()
  if (y < r.top || y > r.bottom || term.rows <= 0) return null
  const row = Math.min(term.rows - 1, Math.floor((y - r.top) / (r.height / term.rows)))
  const buf = term.buffer.active
  const line = buf.getLine(buf.viewportY + row)
  return line ? { text: line.translateToString(true), y: buf.viewportY + row } : null
}

function mouse(type: string, x: number, y: number, extra: MouseEventInit = {}): void {
  const target = type === 'mousemove' || type === 'mouseup' ? document : document.elementFromPoint(x, y)
  target?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y, detail: 1, button: 0, buttons: type === 'mouseup' ? 0 : 1, view: window, ...extra }))
}

function wheelLine(x: number, y: number, lines: number): void {
  const target = document.elementFromPoint(x, y)
  target?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: lines, deltaMode: 1, view: window }))
}

function screenOf(term: Terminal): HTMLElement | null {
  return term.element?.querySelector<HTMLElement>('.xterm-screen') ?? null
}

function cellHeight(term: Terminal): number {
  const screen = screenOf(term)
  const h = screen ? screen.getBoundingClientRect().height / Math.max(1, term.rows) : 0
  return h > 0 ? h : 16
}

function sendsWheel(term: Terminal): boolean {
  return term.buffer.active.type === 'alternate' || term.modes.mouseTrackingMode !== 'none'
}

function createScroller(term: () => Terminal | undefined) {
  let rest = 0
  const shift = (t: Terminal, px: number): void => {
    const screen = screenOf(t)
    if (screen) screen.style.transform = px ? `translateY(${px}px)` : ''
  }
  return {
    by(dy: number, x: number, y: number): boolean {
      const t = term()
      if (!t || dy === 0) return false
      const cell = cellHeight(t)
      rest += dy
      const lines = rest > 0 ? Math.floor(rest / cell) : Math.ceil(rest / cell)
      if (sendsWheel(t)) {
        if (lines) {
          rest -= lines * cell
          wheelLine(x, y, -lines)
        }
        return true
      }
      const buf = t.buffer.active
      if (lines) {
        const target = Math.max(0, Math.min(buf.baseY, buf.viewportY - lines))
        const moved = buf.viewportY - target
        if (moved) t.scrollLines(-moved)
        rest -= lines * cell
        if (moved !== lines) rest = 0
      }
      if ((rest > 0 && buf.viewportY <= 0) || (rest < 0 && buf.viewportY >= buf.baseY)) {
        rest = 0
        shift(t, 0)
        return false
      }
      shift(t, rest)
      return true
    },
    settle(): void {
      rest = 0
      const t = term()
      if (t) shift(t, 0)
    }
  }
}

function blurTerminal(): void {
  const el = document.activeElement
  if (el instanceof HTMLElement && el.closest('.xterm')) el.blur()
}

export function installTerminalTouch(root: HTMLElement, opts: TerminalTouchOptions): () => void {
  let start: { x: number; y: number; t: number } | null = null
  let last = { x: 0, y: 0, t: 0 }
  let samples: { y: number; t: number }[] = []
  const scroller = createScroller(opts.term)
  let moved = false
  let selecting = false
  let pressTimer = 0
  let coast = 0
  let pinch: { d: number; k: number; mid: { x: number; y: number } } | null = null

  const stopCoast = (): void => {
    if (coast) cancelAnimationFrame(coast)
    if (coast) scroller.settle()
    coast = 0
    setTermScrolling(false)
  }
  const inTerminal = (e: TouchEvent): boolean => e.target instanceof Element && !!e.target.closest('.xterm')
  const spread = (t: TouchList): number => Math.max(1, Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY))
  const middle = (t: TouchList): { x: number; y: number } => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 })

  const dropSingle = (): void => {
    window.clearTimeout(pressTimer)
    if (selecting) mouse('mouseup', last.x, last.y, { shiftKey: true })
    if (selecting) opts.term()?.clearSelection()
    selecting = false
    stopCoast()
    scroller.settle()
    start = null
    moved = false
  }

  const onStart = (e: TouchEvent): void => {
    if (e.touches.length === 2 && pinch) {
      e.preventDefault()
      pinch.d = spread(e.touches) / pinch.k
      return
    }
    if (e.touches.length === 2 && opts.onPinch && (start || inTerminal(e))) {
      e.preventDefault()
      dropSingle()
      pinch = { d: spread(e.touches), k: 1, mid: middle(e.touches) }
      opts.onPinch('start', 1, pinch.mid)
      return
    }
    if (pinch) {
      e.preventDefault()
      return
    }
    if (e.touches.length !== 1 || !inTerminal(e)) return
    e.preventDefault()
    stopCoast()
    const t = e.touches[0]
    start = { x: t.clientX, y: t.clientY, t: performance.now() }
    last = { ...start }
    samples = [{ y: t.clientY, t: start.t }]
    moved = false
    selecting = false
    window.clearTimeout(pressTimer)
    pressTimer = window.setTimeout(() => {
      if (!start || moved) return
      selecting = true
      opts.onLongPress()
      mouse('mousedown', start.x, start.y, { shiftKey: opts.term()?.modes.mouseTrackingMode !== 'none' })
    }, LONG_PRESS_MS)
  }

  const onMove = (e: TouchEvent): void => {
    if (pinch) {
      e.preventDefault()
      if (e.touches.length < 2) return
      pinch.k = spread(e.touches) / pinch.d
      pinch.mid = middle(e.touches)
      opts.onPinch?.('move', pinch.k, pinch.mid)
      return
    }
    if (!start || e.touches.length !== 1) return
    e.preventDefault()
    const t = e.touches[0]
    if (selecting) {
      mouse('mousemove', t.clientX, t.clientY, { shiftKey: true })
      return
    }
    if (!moved && Math.hypot(t.clientX - start.x, t.clientY - start.y) < TAP_SLOP) return
    moved = true
    setTermScrolling(true)
    window.clearTimeout(pressTimer)
    const now = performance.now()
    const dy = t.clientY - last.y
    if (dy !== 0) scroller.by(dy, t.clientX, t.clientY)
    samples.push({ y: t.clientY, t: now })
    while (samples.length > 2 && now - samples[0].t > VELOCITY_WINDOW_MS) samples.shift()
    last = { x: t.clientX, y: t.clientY, t: now }
  }

  const onEnd = (e: TouchEvent): void => {
    if (pinch) {
      e.preventDefault()
      if (e.touches.length >= 2) return
      const p = pinch
      pinch = null
      start = null
      opts.onPinch?.('end', p.k, p.mid)
      return
    }
    if (!start) return
    e.preventDefault()
    window.clearTimeout(pressTimer)
    const s = start
    start = null
    if (selecting) {
      selecting = false
      mouse('mouseup', last.x, last.y, { shiftKey: true })
      const text = opts.term()?.getSelection() ?? ''
      blurTerminal()
      if (text) opts.onSelect(text)
      return
    }
    if (moved) {
      const first = samples[0]
      const end = performance.now()
      const span = first ? end - first.t : 0
      let v = first && span > 0 && end - last.t < VELOCITY_WINDOW_MS ? (last.y - first.y) / span : 0
      const x = last.x
      const y = last.y
      let prev = end
      const step = (now: number): void => {
        const dt = Math.max(1, Math.min(64, now - prev))
        prev = now
        const go = scroller.by(v * dt, x, y)
        v *= Math.pow(DECELERATION, dt)
        if (!go || Math.abs(v) < MIN_SPEED) {
          coast = 0
          scroller.settle()
          setTermScrolling(false)
          return
        }
        coast = requestAnimationFrame(step)
      }
      if (Math.abs(v) > MIN_SPEED * 5) coast = requestAnimationFrame(step)
      else {
        scroller.settle()
        setTermScrolling(false)
      }
      return
    }
    if (performance.now() - s.t > TAP_MAX_MS) return
    const term = opts.term()
    const row = term ? rowAt(term, s.y) : null
    if (row && opts.onTapRow(row.text, row.y)) return
    if (term && opts.onTapLink?.(s.x, s.y)) return
    term?.clearSelection()
    if (!term || term.modes.mouseTrackingMode === 'none') {
      console.info('[terminal] tap: no menu row, mouse reporting off')
      return
    }
    console.info(`[terminal] tap sends a ${term.modes.mouseTrackingMode} mouse click`)
    mouse('mousedown', s.x, s.y)
    mouse('mouseup', s.x, s.y)
    blurTerminal()
  }

  const cancel = (): void => {
    if (pinch) {
      const p = pinch
      pinch = null
      opts.onPinch?.('end', p.k, p.mid)
    }
    window.clearTimeout(pressTimer)
    if (selecting) mouse('mouseup', last.x, last.y, { shiftKey: true })
    start = null
    selecting = false
  }

  const opt = { capture: true, passive: false } as const
  root.addEventListener('touchstart', onStart, opt)
  root.addEventListener('touchmove', onMove, opt)
  root.addEventListener('touchend', onEnd, opt)
  root.addEventListener('touchcancel', cancel, opt)
  return () => {
    stopCoast()
    window.clearTimeout(pressTimer)
    root.removeEventListener('touchstart', onStart, opt)
    root.removeEventListener('touchmove', onMove, opt)
    root.removeEventListener('touchend', onEnd, opt)
    root.removeEventListener('touchcancel', cancel, opt)
  }
}
