import { announceFind, findRanges, revealRange, scrollRangeIntoView, setFindHighlights } from '../lib/find-in-view'
import { emit } from './channel'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function hostEl(): HTMLElement {
  const host = document.querySelector<HTMLElement>('.rk-host')
  if (!host) throw new Error('The report is not on screen.')
  return host
}

function readView(host: HTMLElement): Record<string, unknown> {
  const hb = host.getBoundingClientRect()
  const unit = host.clientHeight > 0 ? hb.height / host.clientHeight || 1 : 1
  const items = [...host.querySelectorAll<HTMLElement>('[data-rk-item]')]
  const shown = items
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.bottom > hb.top + 1 && r.top < hb.bottom - 1)
    .sort((a, b) => a.r.top - b.r.top)
  const first = shown[0]
  return {
    blocks: Number(host.querySelector<HTMLElement>('[data-rk-blocks]')?.dataset.rkBlocks ?? 0),
    mounted: items.map((el) => Number(el.dataset.rkItem)).sort((a, b) => a - b),
    visible: shown.map(({ el }) => Number(el.dataset.rkItem)),
    first: first ? { index: Number(first.el.dataset.rkItem), top: Math.round((first.r.top - hb.top) / unit), text: (first.el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) } : null,
    scrollTop: Math.round(host.scrollTop),
    scrollHeight: host.scrollHeight,
    clientHeight: host.clientHeight,
    nodes: host.getElementsByTagName('*').length
  }
}

export async function probeView(p: { scrollTop?: number; anchor?: string; click?: string }): Promise<Record<string, unknown>> {
  let host = hostEl()
  const out: Record<string, unknown> = {}
  const top = Number(p.scrollTop)
  if (Number.isFinite(top) && top >= 0) {
    host.scrollTop = top
    await wait(700)
  }
  const anchor = String(p.anchor ?? '')
  if (anchor) {
    const link = document.createElement('a')
    link.href = `#${encodeURIComponent(anchor)}`
    link.hidden = true
    host.appendChild(link)
    link.click()
    link.remove()
    await wait(1500)
    host = hostEl()
    const target = host.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`)
    const hb = host.getBoundingClientRect()
    const unit = host.clientHeight > 0 ? hb.height / host.clientHeight || 1 : 1
    out.anchor = target ? { top: Math.round((target.getBoundingClientRect().top - hb.top) / unit), scrollTop: Math.round(host.scrollTop) } : null
  }
  const click = String(p.click ?? '')
  if (click) {
    const el = host.querySelector<HTMLElement>(click)
    if (!el) throw new Error(`Nothing in the report matches ${click}.`)
    el.click()
    await wait(2500)
    host = hostEl()
  }
  return { ...readView(host), ...out }
}

const owner = Symbol('frame-find')
let ranges: Range[] = []
let watching: MutationObserver | null = null
let changedTimer = 0

function findRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.rk-host') ?? document.querySelector<HTMLElement>('.dk-tile-content') ?? document.querySelector<HTMLElement>('#root')
}

export async function findOpen(open: boolean): Promise<boolean> {
  const root = findRoot()
  if (!open) {
    watching?.disconnect()
    watching = null
    ranges = []
    setFindHighlights(owner, [], null)
    await announceFind(root, false)
    return true
  }
  await announceFind(root, true)
  watching?.disconnect()
  watching = new MutationObserver(() => {
    window.clearTimeout(changedTimer)
    changedTimer = window.setTimeout(() => emit({ e: 'findChanged' }), 150)
  })
  if (root) watching.observe(root, { childList: true, subtree: true, characterData: true })
  return true
}

export function findText(text: string): number {
  const root = findRoot()
  ranges = root ? findRanges(root, text) : []
  setFindHighlights(owner, ranges, null)
  return ranges.length
}

export function findShow(index: number, scroll: boolean): Record<string, number> | null {
  const root = findRoot()
  const current = index >= 0 ? (ranges[index] ?? null) : null
  setFindHighlights(owner, ranges, current)
  if (!current || !root || !scroll) return null
  if (revealRange(current, root)) requestAnimationFrame(() => requestAnimationFrame(() => scrollRangeIntoView(current, root)))
  else scrollRangeIntoView(current, root)
  const r = current.getBoundingClientRect()
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: window.innerHeight }
}
