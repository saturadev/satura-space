import { setTypingItem } from '../expand'
import { expectKeyboard } from '../../lib/floating'
import { primedField } from './inspector-touch'

const PANES: [string, string][] = [
  ['inspector', '[data-tuner-inspector-column]'],
  ['hierarchy', '[data-tuner-hierarchy-pane]']
]

function editable(el: Element | null): el is HTMLElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)
}

function paneLayout(root: Element): string {
  return ['[data-tuner-hierarchy-pane]', '[data-tuner-phone-scene]', '[data-tuner-phone-timeline]', '[data-tuner-inspector-column]']
    .map((sel) => {
      const el = root.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return `${sel.slice(12, -1)} ${Math.round(r.top)}+${Math.round(r.height)}`
    })
    .filter(Boolean)
    .join(', ')
}

let typing: { root: HTMLElement; pane: string } | null = null
const revealedBy = new Map<HTMLElement, number>()

export function typingPane(): string | null {
  return typing && document.querySelector("[data-phone-expanded='typing']") ? typing.pane : null
}

const SLOP_PX = 10
const AFTER_SCROLL_MS = 800
const REVEAL_PAD = 10
const KEYBOARD_MIN = 60
const KEYBOARD_GUESS = { portrait: 0.42, landscape: 0.6 }

const keyboardSeen: Record<'portrait' | 'landscape', number> = { portrait: 0, landscape: 0 }

function orientation(): 'portrait' | 'landscape' {
  return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait'
}

function keyboardNow(): { up: boolean; px: number } {
  const vv = window.visualViewport
  const keyboard = vv ? window.innerHeight - vv.height : 0
  const side = orientation()
  if (keyboard > KEYBOARD_MIN) {
    keyboardSeen[side] = keyboard
    return { up: true, px: Math.round(keyboard) }
  }
  return { up: false, px: keyboardSeen[side] || Math.round(window.innerHeight * KEYBOARD_GUESS[side]) }
}

function visibleBottom(): { bottom: number; how: string } {
  const vv = window.visualViewport
  const top = vv ? Math.max(0, vv.offsetTop) : 0
  const height = vv ? vv.height : window.innerHeight
  const k = keyboardNow()
  if (k.up) return { bottom: top + height, how: `keyboard ${k.px} px` }
  return { bottom: top + height - k.px, how: `keyboard not up yet, expecting ${k.px} px` }
}

let popupExpect = 0

function popupTyping(): void {
  const active = document.activeElement
  const popup = editable(active) ? active.closest<HTMLElement>('[data-tuner-popup]') : null
  const k = keyboardNow()
  const want = popup && !k.up ? k.px : 0
  if (want === popupExpect) return
  popupExpect = want
  expectKeyboard(want)
  if (!popup || !want) return
  const before = popup.getBoundingClientRect()
  requestAnimationFrame(() => {
    const r = popup.getBoundingClientRect()
    const f = active?.getBoundingClientRect()
    console.info(
      `[tuner] typing in the ${popup.dataset.tunerPopup ?? ''} popup: placed above the ${want} px keyboard it expects, popup ${Math.round(before.top)}..${Math.round(before.bottom)} -> ${Math.round(r.top)}..${Math.round(r.bottom)}, field ${f ? `${Math.round(f.top)}+${Math.round(f.height)}` : '-'}`
    )
  })
}

function unreveal(): string {
  const back: string[] = []
  for (const [box, by] of revealedBy) {
    if (!box.isConnected) continue
    const before = box.scrollTop
    box.scrollTop = Math.max(0, before - by)
    back.push(`${Math.round(before)} -> ${Math.round(box.scrollTop)}`)
  }
  revealedBy.clear()
  return back.length ? `, scroll back ${back.join(', ')}` : ''
}

function scrollerOf(el: Element, stop: Element): HTMLElement | null {
  for (let n = el.parentElement; n && n !== stop.parentElement; n = n.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight) return n
  }
  return null
}

export function revealTyping(why: string): void {
  const field = document.activeElement
  if (!typing || !editable(field) || !field.isConnected || primedField(field)) return
  const item = field.closest<HTMLElement>("[data-phone-expanded='typing']")
  const box = item ? scrollerOf(field, item) : null
  if (!item || !box) return
  const b = box.getBoundingClientRect()
  const f = field.getBoundingClientRect()
  const view = visibleBottom()
  const top = b.top + REVEAL_PAD
  const bottom = Math.min(b.bottom, view.bottom) - REVEAL_PAD
  const shift = f.bottom > bottom ? Math.min(f.bottom - bottom, f.top - top) : f.top < top ? f.top - top : 0
  const zoom = box.offsetHeight ? b.height / box.offsetHeight : 1
  const before = box.scrollTop
  if (Math.abs(shift) >= 1) box.scrollTop += shift / (zoom > 0.2 && zoom < 5 ? zoom : 1)
  if (box.scrollTop !== before) revealedBy.set(box, (revealedBy.get(box) ?? 0) + box.scrollTop - before)
  const moved = Math.round((box.scrollTop - before) * zoom)
  const now = field.getBoundingClientRect()
  console.info(
    `[tuner] typing field ${moved ? `scrolled ${moved} px into view` : 'already in view'} (${why}): field ${Math.round(now.top)}+${Math.round(now.height)}, ${typing.pane} shows ${Math.round(b.top)}..${Math.round(b.bottom)}, visible to ${Math.round(view.bottom)} (${view.how})`
  )
}

export function installTunerTypingPane(): void {
  let touch: { x: number; y: number; moved: boolean; focused: boolean } | null = null
  let scrolledAt = -Infinity
  const scrolling = (): boolean => !!touch?.moved || performance.now() - scrolledAt < AFTER_SCROLL_MS
  const refuse = (why: string): void => {
    const active = document.activeElement
    if (!editable(active) || !active.closest('.remote-tuner') || !PANES.some(([, sel]) => active.closest(sel))) return
    console.info(`[tuner] no typing pane: ${why}`)
    active.blur()
  }
  document.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0]
      touch = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY, moved: false, focused: false } : null
    },
    { capture: true, passive: true }
  )
  document.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0]
      if (!touch || touch.moved || !t || Math.hypot(t.clientX - touch.x, t.clientY - touch.y) < SLOP_PX) return
      touch.moved = true
      if (touch.focused) refuse('the touch turned into a scroll')
    },
    { capture: true, passive: true }
  )
  const lift = (): void => {
    if (touch?.moved) scrolledAt = performance.now()
    touch = null
  }
  document.addEventListener('touchend', lift, { capture: true, passive: true })
  document.addEventListener('touchcancel', lift, { capture: true, passive: true })
  let revealed: Element | null = null
  const update = (): void => {
    const active = document.activeElement
    if (active instanceof HTMLTextAreaElement && active.matches('[data-tuner-ask-input]')) return askTyping(active)
    const field = primedField(active) ?? active
    const root = field?.closest<HTMLElement>('.remote-tuner') ?? null
    const hit = editable(active) && field && root ? PANES.find(([, sel]) => field.closest(sel)) : undefined
    const pane = hit?.[0] ?? null
    if (hit && !typing) {
      if (scrolling()) return refuse('focus came from a scroll, not a tap')
      if (touch) touch.focused = true
    }
    if (typing && (typing.root !== root || typing.pane !== pane)) {
      const was = typing.root
      typing = null
      revealed = null
      const back = unreveal()
      setTypingItem(null)
      console.info(`[tuner] typing done, panes back: ${paneLayout(was)}${back}`)
    }
    if (typing && active !== revealed) {
      revealed = active
      revealTyping('focus moved')
    }
    if (!root || !pane || !hit || !field || typing) return
    console.info(`[tuner] typing in the ${pane}${field !== active ? ', keyboard opened by the tap' : ''}, panes before: ${paneLayout(root)}`)
    typing = { root, pane }
    revealed = active
    setTypingItem(field.closest<HTMLElement>(hit[1]))
    revealTyping('typing started')
    requestAnimationFrame(() => console.info(`[tuner] only the ${pane} shows while typing: ${paneLayout(root)}`))
  }
  const askTyping = (field: HTMLElement): void => {
    const root = document.querySelector<HTMLElement>('.remote-tuner [data-tuner-ask][aria-expanded="true"]')?.closest<HTMLElement>('.remote-tuner') ?? null
    const scene = root?.querySelector<HTMLElement>('[data-tuner-phone-scene]') ?? null
    if (typing && typing.root === root && typing.pane === 'ask') return
    if (typing) {
      unreveal()
      setTypingItem(null)
    }
    typing = null
    if (!root || !scene) return
    typing = { root, pane: 'ask' }
    setTypingItem(scene)
    const dock = field.closest('[data-tuner-ask-dock]')?.getBoundingClientRect()
    console.info(`[tuner] typing in Ask Drift: the scene view shows under it${dock ? `, card ${Math.round(dock.top)}+${Math.round(dock.height)}` : ''}`)
    requestAnimationFrame(() => {
      const r = scene.getBoundingClientRect()
      const vv = window.visualViewport
      console.info(`[tuner] Ask Drift typing layout: scene ${Math.round(r.top)}+${Math.round(r.height)}, visual viewport ${vv ? `${Math.round(vv.offsetTop)}+${Math.round(vv.height)}` : '-'}`)
    })
  }
  document.addEventListener(
    'focusin',
    () => {
      update()
      popupTyping()
    },
    true
  )
  document.addEventListener(
    'focusout',
    () =>
      setTimeout(() => {
        update()
        popupTyping()
      }, 0),
    true
  )
}
