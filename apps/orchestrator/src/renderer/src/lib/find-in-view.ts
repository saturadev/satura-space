export const FIND_REVEAL_EVENT = 'satura-find-reveal'
export const FIND_OPEN_EVENT = 'satura-find-open'
export const FIND_LIMIT = 5000

export interface FindOpenDetail {
  open: boolean
  ready: Promise<void> | null
}

const openFinds = new WeakMap<HTMLElement, number>()

export function findIsOpen(root: HTMLElement): boolean {
  return (openFinds.get(root) ?? 0) > 0
}

export function announceFind(root: HTMLElement | null, open: boolean): Promise<void> {
  if (!root) return Promise.resolve()
  openFinds.set(root, Math.max(0, (openFinds.get(root) ?? 0) + (open ? 1 : -1)))
  const detail: FindOpenDetail = { open, ready: null }
  root.dispatchEvent(new CustomEvent(FIND_OPEN_EVENT, { detail }))
  return detail.ready ?? Promise.resolve()
}

const SKIP = 'script, style, noscript, textarea, input, select, .monaco-editor, [data-find-skip], [aria-hidden="true"]'
const INLINE = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'I', 'INS', 'KBD', 'MARK', 'Q', 'S',
  'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'LABEL', 'FONT', 'BIG', 'TT', 'STRIKE'
])

interface Piece {
  node: Text
  start: number
}

function blockOf(node: Node, root: Node): Node {
  let el = node.parentElement
  while (el && el !== root && INLINE.has(el.tagName)) el = el.parentElement
  return el ?? root
}

function fold(text: string): string {
  const low = text.toLowerCase()
  if (low.length === text.length) return low
  let out = ''
  for (const ch of text) {
    const l = ch.toLowerCase()
    out += l.length === ch.length ? l : ch
  }
  return out
}

function locate(pieces: Piece[], at: number): { node: Text; offset: number } {
  let lo = 0
  let hi = pieces.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (pieces[mid].start <= at) lo = mid
    else hi = mid - 1
  }
  const p = pieces[lo]
  return { node: p.node, offset: Math.min(at - p.start, p.node.data.length) }
}

export function findRanges(root: HTMLElement, query: string, limit = FIND_LIMIT): Range[] {
  const needle = fold(query)
  if (!needle.trim()) return []
  const out: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  let block: Node | null = null
  let pieces: Piece[] = []
  let text = ''
  const flush = (): void => {
    if (!pieces.length) return
    const hay = fold(text)
    let from = 0
    while (out.length < limit) {
      const at = hay.indexOf(needle, from)
      if (at < 0) break
      const a = locate(pieces, at)
      const b = locate(pieces, at + needle.length - 1)
      const r = document.createRange()
      r.setStart(a.node, a.offset)
      r.setEnd(b.node, b.offset + 1)
      out.push(r)
      from = at + Math.max(1, needle.length)
    }
    pieces = []
    text = ''
  }
  for (let n = walker.nextNode(); n && out.length < limit; n = walker.nextNode()) {
    const t = n as Text
    if (!t.data) continue
    const b = blockOf(t, root)
    if (b !== block) {
      flush()
      block = b
    }
    pieces.push({ node: t, start: text.length })
    text += t.data
  }
  flush()
  return out
}

export function revealRange(range: Range, root: HTMLElement): boolean {
  let changed = false
  for (let el = range.startContainer.parentElement; el && el !== root; el = el.parentElement) {
    if (el instanceof HTMLDetailsElement && !el.open) {
      el.open = true
      changed = true
    }
    if (el.hasAttribute('data-find-reveal')) {
      el.dispatchEvent(new Event(FIND_REVEAL_EVENT))
      changed = true
    }
  }
  return changed
}

function scrollable(el: HTMLElement, axis: 'x' | 'y'): boolean {
  const cs = getComputedStyle(el)
  const o = axis === 'y' ? cs.overflowY : cs.overflowX
  if (!/(auto|scroll|overlay)/.test(o)) return false
  return axis === 'y' ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1
}

export function scrollRangeIntoView(range: Range, stop: HTMLElement): void {
  for (let el = range.startContainer.parentElement; el; el = el.parentElement) {
    const y = scrollable(el, 'y')
    const x = scrollable(el, 'x')
    if (x || y) {
      const r = range.getBoundingClientRect()
      if (!r.width && !r.height) return
      const box = el.getBoundingClientRect()
      const sy = el.offsetHeight ? box.height / el.offsetHeight : 1
      const sx = el.offsetWidth ? box.width / el.offsetWidth : 1
      const margin = 24
      if (y && (r.top < box.top + margin || r.bottom > box.top + el.clientHeight * sy - margin)) {
        el.scrollTop += (r.top - (box.top + (el.clientHeight * sy) / 2 - r.height / 2)) / (sy || 1)
      }
      if (x && (r.left < box.left + margin || r.right > box.left + el.clientWidth * sx - margin)) {
        el.scrollLeft += (r.left - (box.left + (el.clientWidth * sx) / 3)) / (sx || 1)
      }
    }
    if (el === stop) return
  }
}

const owners = new Map<symbol, { all: Range[]; active: Range | null }>()

function paint(): void {
  if (typeof CSS === 'undefined' || !CSS.highlights) return
  const all: Range[] = []
  const active: Range[] = []
  for (const o of owners.values()) {
    for (const r of o.all) if (r !== o.active) all.push(r)
    if (o.active) active.push(o.active)
  }
  if (all.length) CSS.highlights.set('satura-find', new Highlight(...all))
  else CSS.highlights.delete('satura-find')
  if (active.length) CSS.highlights.set('satura-find-active', new Highlight(...active))
  else CSS.highlights.delete('satura-find-active')
}

export function setFindHighlights(owner: symbol, all: Range[], active: Range | null): void {
  if (!all.length && !active) owners.delete(owner)
  else owners.set(owner, { all, active })
  paint()
}
