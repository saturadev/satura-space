import { dismissPopovers } from './popover-dismiss'

interface Slot {
  parent?: HTMLElement | null
  before?: Element | null
  className?: string
  strip?: string
}

interface Rule {
  scope: string
  frame: string
  noun: (key: string) => string
  items: (frame: HTMLElement) => [string, HTMLElement][]
  slot: (key: string, item: HTMLElement) => Slot
}

const TUNER_PANES: [string, string][] = [
  ['hierarchy', '[data-tuner-hierarchy-pane]'],
  ['scene', '[data-tuner-phone-scene]'],
  ['timeline', '[data-tuner-phone-timeline]'],
  ['inspector', '[data-tuner-inspector-column]']
]

const RICH_CONTENT = 'img, video, canvas, table, pre, .srv, .sr-compare, .rk-carousel, .rk-chart, .rk-log, .rk-media-wait, .monaco-editor'

function worthExpanding(el: HTMLElement, frame: HTMLElement): boolean {
  if (el.dataset.phoneExpanded || el.dataset.phoneExpandItem != null) return true
  if (el.classList.contains('rk-section')) return true
  if (el.classList.contains('rk-stat')) return false
  if (el.querySelector(RICH_CONTENT)) return true
  return el.getBoundingClientRect().height > frame.getBoundingClientRect().height * 0.5
}

const reportKeys = new WeakMap<HTMLElement, string>()
let reportSeq = 0

function reportKey(el: HTMLElement): string {
  let key = reportKeys.get(el)
  if (!key) reportKeys.set(el, (key = `${el.classList.contains('rk-section') ? 'section' : 'card'}${++reportSeq}`))
  return key
}

const RULES: Rule[] = [
  {
    scope: 'tuner',
    frame: '.remote-tuner [data-tuner-phone-stack], .remote-tuner [data-tuner-phone-columns]',
    noun: (key) => (key === 'scene' ? 'scene view' : key),
    items: (frame) =>
      TUNER_PANES.flatMap(([key, sel]): [string, HTMLElement][] => {
        const el = frame.querySelector<HTMLElement>(sel)
        return el ? [[key, el]] : []
      }),
    slot: (key, item) => {
      if (key === 'hierarchy') return { parent: item.querySelector('[data-hierarchy-search]')?.closest('label')?.parentElement ?? null, className: 'phone-expand-inline' }
      if (key === 'scene') return { parent: item.querySelector<HTMLElement>(':scope > [data-tuner-toolbar]'), className: 'phone-expand-inline' }
      return { strip: key === 'timeline' ? 'Animation' : 'Inspector' }
    }
  },
  {
    scope: 'dashboard',
    frame: "[data-phone-panel='dashboard'] .dk-host",
    noun: () => 'widget',
    items: (frame) => [...frame.querySelectorAll<HTMLElement>('[data-dashboard-tile]')].map((el): [string, HTMLElement] => [el.dataset.dashboardTile ?? '', el]),
    slot: (_key, item) => {
      const head = item.querySelector<HTMLElement>(':scope > .dk-tile-head')
      return head ? { parent: head, before: head.querySelector(':scope > button:last-of-type'), className: 'dk-icon-btn' } : { strip: '' }
    }
  },
  {
    scope: 'report',
    frame: '[data-phone-panel] [data-viewer-report] .rk-host',
    noun: (key) => (key.startsWith('section') ? 'section' : 'widget'),
    items: (frame) =>
      [...frame.querySelectorAll<HTMLElement>('.rk-section, .rk-card')]
        .map((el): [string, HTMLElement] => [reportKey(el), el])
        .filter(([, el]) => worthExpanding(el, frame)),
    slot: (_key, item) => {
      const head = item.querySelector<HTMLElement>(':scope > .rk-card-title, :scope > .rk-section-head, :scope > summary, :scope.rk-figure > figcaption')
      return head ? { parent: head } : { strip: '' }
    }
  }
]

const EXPAND_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/></svg>'
const COLLAPSE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 6.5h-4v-4M9.5 6.5 14 2M2.5 9.5h4v4M6.5 9.5 2 14"/></svg>'

const expanded = new Map<string, string>()
const shown = new WeakMap<HTMLElement, string>()
const anchors = new WeakMap<HTMLElement, { el: HTMLElement; offset: number }>()
const watched = new WeakSet<HTMLElement>()
const held = new WeakMap<HTMLElement, HTMLElement>()
let typingItem: HTMLElement | null = null
let queued = false
let resizes: ResizeObserver | null = null
let lastOrientation = ''
let panels = ''

function tabOf(el: Element): string {
  return el.closest<HTMLElement>('[data-tab-id]')?.dataset.tabId ?? ''
}

function orientation(): string {
  return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait'
}

function itemRule(item: HTMLElement): { rule: Rule; frame: HTMLElement } | null {
  for (const rule of RULES) {
    const frame = item.parentElement?.closest<HTMLElement>(rule.frame)
    if (frame) return { rule, frame }
  }
  return null
}

function ownViewer(item: HTMLElement): HTMLElement | null {
  const el = item.matches('[data-phone-expand-open]') ? item : item.querySelector<HTMLElement>('[data-phone-expand-open]')
  return el && el.closest('[data-phone-expand-item]') === item ? el : null
}

function toggle(item: HTMLElement): void {
  const found = itemRule(item)
  const key = item.dataset.phoneExpandItem
  if (!found || key == null) return
  const tab = tabOf(found.frame)
  const id = `${found.rule.scope}:${key}`
  if (expanded.get(tab) === id) expanded.delete(tab)
  else expanded.set(tab, id)
  dismissPopovers(`${found.rule.scope} ${key} ${expanded.get(tab) === id ? 'expanded' : 'collapsed'}`)
  pass()
}

function ensureButton(rule: Rule, key: string, item: HTMLElement): HTMLButtonElement | null {
  const slot = rule.slot(key, item)
  if ('parent' in slot && !slot.parent) return null
  let parent = slot.parent ?? null
  if (parent) for (const strip of item.querySelectorAll<HTMLElement>(':scope > [data-phone-expand-strip]')) strip.remove()
  else {
    parent = item.querySelector<HTMLElement>(':scope > [data-phone-expand-strip]')
    if (!parent) {
      parent = document.createElement('div')
      parent.dataset.phoneExpandStrip = rule.scope
      const label = document.createElement('span')
      label.textContent = slot.strip ?? ''
      parent.appendChild(label)
      item.insertBefore(parent, item.firstChild)
    }
  }
  for (const old of item.querySelectorAll<HTMLElement>('[data-phone-expand-btn]'))
    if (old.parentElement !== parent && old.closest('[data-phone-expand-item]') === item) old.remove()
  let btn = parent.querySelector<HTMLButtonElement>(':scope > [data-phone-expand-btn]')
  if (!btn) {
    btn = document.createElement('button')
    btn.type = 'button'
    btn.dataset.phoneExpandBtn = rule.scope
    if (slot.className) btn.className = slot.className
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick'])
      btn.addEventListener(type, (e) => e.stopPropagation(), { passive: type === 'touchstart' })
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const owner = btn!.closest<HTMLElement>('[data-phone-expand-item]')
      const viewer = owner ? ownViewer(owner) : null
      if (viewer) {
        console.info(`[expand] ${owner!.dataset.phoneExpandItem} opens its ${viewer.dataset.phoneExpandOpen || 'content'} full screen`)
        dismissPopovers(`${owner!.dataset.phoneExpandItem} full screen`)
        viewer.dispatchEvent(new CustomEvent('phone-expand-open'))
      } else if (owner) toggle(owner)
    })
    parent.insertBefore(btn, slot.before && slot.before.parentElement === parent ? slot.before : null)
  }
  const on = item.dataset.phoneExpanded === 'on'
  const own = ownViewer(item)?.dataset.phoneExpandOpen
  const label = on ? `Back to the split` : own ? `Open the ${own} full screen` : `Expand the ${rule.noun(key)}`
  if (btn.getAttribute('aria-label') !== label) {
    btn.setAttribute('aria-label', label)
    btn.innerHTML = on ? COLLAPSE_ICON : EXPAND_ICON
  }
  return btn
}

function setAttr(el: HTMLElement, name: string, value: string | null): void {
  if (value == null) {
    if (el.hasAttribute(name)) el.removeAttribute(name)
  } else if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

function holdBlock(frame: HTMLElement, item: HTMLElement): void {
  const block = item.closest<HTMLElement>('[data-rk-item]')
  if (!block || !frame.contains(block)) return
  block.style.minHeight = `${block.offsetHeight}px`
  held.set(frame, block)
}

function releaseBlock(frame: HTMLElement): void {
  const block = held.get(frame)
  if (!block) return
  held.delete(frame)
  block.style.removeProperty('min-height')
}

function containingBlock(item: HTMLElement): HTMLElement | null {
  for (let n = item.parentElement; n; n = n.parentElement) {
    const cs = getComputedStyle(n)
    if (cs.position !== 'static' || cs.transform !== 'none' || cs.filter !== 'none' || /paint|layout|strict|content/.test(cs.contain)) return n
  }
  return null
}

function place(frame: HTMLElement, item: HTMLElement): void {
  const s = item.style
  const set = (k: string, v: number): void => {
    const px = `${Math.round(v)}px`
    if (s.getPropertyValue(k) !== px) s.setProperty(k, px)
  }
  let top = frame.scrollTop
  let left = frame.scrollLeft
  const box = containingBlock(item)
  if (box && box !== frame && frame.contains(box)) {
    const f = frame.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    const scale = f.height / (frame.clientHeight || 1) || 1
    top = (f.top - b.top) / scale
    left = (f.left - b.left) / scale
  }
  set('--phone-expand-top', top)
  set('--phone-expand-left', left)
  set('--phone-expand-w', frame.clientWidth)
  set('--phone-expand-h', frame.clientHeight)
}

function pass(): void {
  queued = false
  const panelKey = [...document.querySelectorAll<HTMLElement>('[data-phone-panel]')].map((el) => el.dataset.tabId ?? '').join(',')
  if (panelKey !== panels) {
    if (panels) dismissPopovers('panel switch')
    panels = panelKey
  }
  for (const rule of RULES) {
    for (const frame of document.querySelectorAll<HTMLElement>(rule.frame)) {
      if (!watched.has(frame)) {
        watched.add(frame)
        resizes?.observe(frame)
      }
      const tab = tabOf(frame)
      const want = expanded.get(tab)
      const wasExpanding = frame.hasAttribute('data-phone-expanding')
      const items = rule.items(frame)
      const kept = new Set(items.map(([, el]) => el))
      for (const old of frame.querySelectorAll<HTMLElement>('[data-phone-expand-item]')) {
        if (kept.has(old) || old.parentElement?.closest(rule.frame) !== frame) continue
        for (const extra of old.querySelectorAll<HTMLElement>('[data-phone-expand-btn], [data-phone-expand-strip]'))
          if (extra.closest('[data-phone-expand-item]') === old) extra.remove()
        setAttr(old, 'data-phone-expand-item', null)
        setAttr(old, 'data-phone-expanded', null)
      }
      const typing = typingItem && items.some(([, el]) => el === typingItem) ? typingItem : null
      let solo: HTMLElement | null = null
      let soloKey = ''
      for (const [key, el] of items) {
        setAttr(el, 'data-phone-expand-item', key)
        const state = typing ? (el === typing ? 'typing' : null) : want === `${rule.scope}:${key}` ? 'on' : null
        if (state && !wasExpanding) {
          anchors.set(frame, { el, offset: el.getBoundingClientRect().top - frame.getBoundingClientRect().top })
          holdBlock(frame, el)
        }
        setAttr(el, 'data-phone-expanded', state)
        if (state) {
          solo = el
          soloKey = key
        }
        ensureButton(rule, key, el)
      }
      setAttr(frame, 'data-phone-expanding', solo ? rule.scope : null)
      if (!solo && wasExpanding) {
        releaseBlock(frame)
        const anchor = anchors.get(frame)
        anchors.delete(frame)
        frame.style.overflowAnchor = 'none'
        window.setTimeout(() => {
          if (!frame.hasAttribute('data-phone-expanding')) frame.style.removeProperty('overflow-anchor')
        }, 1500)
        if (anchor) {
          const settle = (): number => {
            if (!anchor.el.isConnected) return 0
            const box = frame.getBoundingClientRect()
            const scale = box.height / (frame.clientHeight || 1) || 1
            const shift = (anchor.el.getBoundingClientRect().top - box.top - anchor.offset) / scale
            if (Math.abs(shift) >= 1) frame.scrollTop += shift
            return shift
          }
          const first = settle()
          requestAnimationFrame(() => {
            const late = settle()
            console.info(`[expand] ${rule.scope} kept its place: scrolled ${Math.round(first)} px, then ${Math.round(late)} px, to ${Math.round(frame.scrollTop)}`)
          })
        }
      }
      if (solo) place(frame, solo)
      const now = solo ? `${soloKey} ${solo.dataset.phoneExpanded}` : ''
      if ((shown.get(frame) ?? '') !== now) {
        const was = shown.get(frame) ?? ''
        shown.set(frame, now)
        if (solo) console.info(`[expand] ${rule.scope} ${soloKey} fills the panel (${solo.dataset.phoneExpanded === 'typing' ? 'typing' : 'expanded'}) in tab ${tab}, ${orientation()} ${frame.clientWidth}x${frame.clientHeight}`)
        else if (was) console.info(`[expand] ${rule.scope} ${was.split(' ')[0]} back to the split in tab ${tab}, ${orientation()}`)
      }
    }
  }
}

function schedule(): void {
  if (queued) return
  queued = true
  requestAnimationFrame(pass)
}

export function expandedItem(tab: string): string | null {
  return expanded.get(tab) ?? null
}

export function collapseExpanded(why: string): boolean {
  if (!expanded.size) return false
  const was = [...expanded.values()].join(', ')
  expanded.clear()
  console.info(`[expand] ${was} back to the split: ${why}`)
  pass()
  return true
}

export function setTypingItem(el: HTMLElement | null): void {
  if (typingItem === el) return
  typingItem = el
  pass()
}

export function installPhoneExpand(): void {
  lastOrientation = orientation()
  resizes = new ResizeObserver(schedule)
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })
  window.addEventListener('resize', () => {
    console.info(`[expand] ${orientation()} ${window.innerWidth}x${window.innerHeight}, expanded: ${[...expanded.values()].join(', ') || 'none'}`)
    if (orientation() !== lastOrientation) {
      lastOrientation = orientation()
      dismissPopovers(`rotation to ${lastOrientation}`)
    }
    schedule()
  })
  schedule()
}
