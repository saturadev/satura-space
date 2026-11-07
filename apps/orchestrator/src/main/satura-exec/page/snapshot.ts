import { ariaNodeElement, generateAriaTree, renderAriaTree, type AriaSnapshot } from '../playwright/injected/ariaSnapshot'
import { parentElementOrShadowHost } from '../playwright/injected/domUtils'
import { beginAriaCaches, endAriaCaches, isElementHiddenForAria } from '../playwright/injected/roleUtils'
import type { AriaNode } from '../playwright/isomorphic/ariaSnapshot'

export const SNAPSHOT_MAX = 8000
export const TEXT_MAX = 160
export const NAME_MAX = 100
const ROWS_MAX = 60
const FIELDS_MAX = 60
const KEYS_MAX = 12

const ACTIONABLE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
  'separator',
  'listbox',
  'gridcell',
  'row'
])

export interface SnapshotOptions {
  depth?: number
  offscreen?: boolean
  max?: number
}

type Rect = { left: number; top: number; right: number; bottom: number }
type Part = 'hierarchy' | 'inspector' | 'timeline' | 'viewport' | null

interface Ctx {
  root: Element
  done: Set<Element>
  owns: (el: Element) => boolean
  offscreen: boolean
  view: Rect
  clips: Map<Element, Rect>
  blocks: string[][]
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function meet(a: Rect, b: Rect): Rect {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) }
}

function clipOf(el: Element, ctx: Ctx): Rect {
  const known = ctx.clips.get(el)
  if (known) return known
  const win = el.ownerDocument.defaultView
  const parent = parentElementOrShadowHost(el)
  let out = ctx.view
  if (parent && win && win.getComputedStyle(el).position !== 'fixed') {
    out = clipOf(parent, ctx)
    const s = win.getComputedStyle(parent)
    if (s.overflowX !== 'visible' || s.overflowY !== 'visible') out = meet(out, parent.getBoundingClientRect())
  }
  ctx.clips.set(el, out)
  return out
}

function onScreen(el: Element, ctx: Ctx): boolean {
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return true
  const c = clipOf(el, ctx)
  return r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom
}

function placeholder(node: AriaNode, ctx: Ctx, lines: string[]): AriaNode {
  ctx.blocks.push(lines)
  return { role: 'group', name: `@@block${ctx.blocks.length - 1}@@`, children: [], props: {}, box: { visible: true, inline: false }, receivesPointerEvents: node.receivesPointerEvents }
}

function leanChildren(node: AriaNode, ctx: Ctx): (AriaNode | string)[] {
  const out: (AriaNode | string)[] = []
  for (const child of node.children) {
    for (const c of typeof child === 'string' ? [child] : leanNode(child, ctx)) {
      const last = out[out.length - 1]
      if (typeof c === 'string' && typeof last === 'string') out[out.length - 1] = clip(`${last} ${c}`, TEXT_MAX)
      else out.push(typeof c === 'string' ? clip(c, TEXT_MAX) : c)
    }
  }
  return out
}

function leanNode(node: AriaNode, ctx: Ctx): (AriaNode | string)[] {
  const el = ariaNodeElement(node)
  if (el) {
    const special = el.closest('[data-tuner-pane], .xterm')
    if (special && !special.contains(ctx.root)) {
      if (ctx.done.has(special)) return []
      ctx.done.add(special)
      if (!ctx.owns(special) || isElementHiddenForAria(special) || (!ctx.offscreen && !onScreen(special, ctx))) return []
      return [placeholder(node, ctx, special.classList.contains('xterm') ? ['- terminal'] : tunerLines(special, null, ctx))]
    }
    if (!ctx.owns(el) || isElementHiddenForAria(el)) return []
    if (!ctx.offscreen && !onScreen(el, ctx)) return []
  }
  if (node.role === 'img') return node.name ? [{ ...node, name: clip(node.name, NAME_MAX), children: [], ref: undefined }] : []
  const children = leanChildren(node, ctx)
  if (node.role === 'generic' && !node.name) return children
  const name = clip(node.name, NAME_MAX)
  const kept: AriaNode = { ...node, name, children: children.length === 1 && children[0] === name ? [] : children, box: { ...node.box, cursor: undefined } }
  if (!ACTIONABLE.has(node.role)) kept.ref = undefined
  return [kept]
}

function text(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function visibleIn(el: Element, ctx: Ctx | null): boolean {
  if (!ctx || ctx.offscreen) return true
  return onScreen(el, ctx)
}

function hierarchyLines(pane: Element, ctx: Ctx | null): string[] {
  const list = pane.querySelector('[data-scene-hierarchy]')
  if (!list) return []
  const rows = Array.from(list.querySelectorAll('[data-row-key]'))
    .filter((r) => visibleIn(r, ctx))
    .map((r) => ({ r, top: r.getBoundingClientRect().top }))
    .sort((a, b) => a.top - b.top)
  const total = Number(list.getAttribute('data-row-count')) || rows.length
  const picked = list.getAttribute('data-selected-path')
  const out = [`  - hierarchy${total > rows.length ? ` (${rows.length} of ${total} rows shown)` : ''}${picked ? `, selected ${JSON.stringify(picked)}` : ''}:`]
  for (const { r } of rows.slice(0, ROWS_MAX)) {
    const depth = Math.max(0, Number(r.getAttribute('data-row-depth')) || 0)
    const name = (r.getAttribute('data-row-name') || text(r)).replace(/ \/ /g, '/')
    const flags = `${r.getAttribute('data-selected') === 'true' ? ' [selected]' : ''}${r.getAttribute('data-ghost') !== null ? ' [not in this Tuner]' : ''}${r.getAttribute('data-row-error') ? ' [missing]' : ''}`
    out.push(`    ${'  '.repeat(depth)}- ${clip(name, NAME_MAX)}${flags}`)
  }
  if (rows.length > ROWS_MAX) out.push(`    - and ${rows.length - ROWS_MAX} more`)
  return out
}

function fieldText(el: Element): string | null {
  const raw = el.getAttribute('data-ti-value')
  if (raw === null) return null
  let v: unknown = raw
  try {
    v = JSON.parse(raw)
  } catch {
  }
  if (typeof v !== 'string') return String(v)
  return v ? clip(v.replace(/\s+/g, ' ').trim(), NAME_MAX) : '""'
}

function inspectorLines(pane: Element, ctx: Ctx | null): string[] {
  const root = pane.querySelector('[data-tuner-inspector]')
  if (!root) {
    const why = pane.querySelector('[data-tuner-inspector-empty]')?.getAttribute('data-tuner-inspector-empty')
    if (!why) return []
    const picked = pane.querySelector('[data-scene-hierarchy]')?.getAttribute('data-selected-path')
    return [`  - inspector${picked ? ` ${JSON.stringify(picked)}` : ''}: ${clip(why, TEXT_MAX)}`]
  }
  const target = root.getAttribute('data-ti-target') ?? ''
  const what = target.includes('|') ? target.slice(target.indexOf('|') + 1) : target
  const out: string[] = []
  let n = 0
  let more = 0
  let total = 0
  for (const section of Array.from(root.querySelectorAll('[data-ti-section]'))) {
    const name = section.getAttribute('data-ti-section') ?? ''
    const seen = new Set<string>()
    const props: { el: Element; path: string; name: string; parent: string | null; aux: boolean }[] = []
    for (const el of Array.from(section.querySelectorAll('[data-ti-prop]'))) {
      const path = el.getAttribute('data-ti-prop') ?? ''
      if (seen.has(path)) continue
      seen.add(path)
      props.push({ el, path, name: el.getAttribute('data-ti-name') || el.getAttribute('data-ti-label') || path, parent: el.getAttribute('data-ti-parent'), aux: el.hasAttribute('data-ti-aux') })
    }
    const valueOf = (p: (typeof props)[number]): string | null => {
      const kids = props.filter((q) => q.parent === p.path)
      if (!kids.length) return fieldText(p.el)
      return `{${kids.map((q) => `${q.path.slice(p.path.length + 1)}: ${valueOf(q) ?? '?'}`).join(', ')}}`
    }
    for (const p of props) {
      if (p.parent !== null || p.aux) continue
      total++
      if (!visibleIn(p.el, ctx)) continue
      if (n >= FIELDS_MAX) {
        more++
        continue
      }
      const value = valueOf(p)
      out.push(`    - ${name} > ${clip(p.name, NAME_MAX)}${value === null ? '' : `: ${clip(value, TEXT_MAX)}`}`)
      n++
    }
  }
  if (more) out.push(`    - and ${more} more fields`)
  if (total === 0) out.push('    - nothing selected')
  const hidden = total > n + more ? ` (${n} of ${total} fields shown)` : ''
  return [`  - inspector${what ? ` ${JSON.stringify(what)}` : ''}${hidden}:`, ...out]
}

function timelineLines(pane: Element, ctx: Ctx | null): string[] {
  const root = pane.querySelector('[data-tuner-animator]')
  if (!root) return []
  const clipName = root.getAttribute('data-anim-clip') ?? ''
  const out = [`  - timeline${clipName ? ` ${JSON.stringify(clipName)}` : ''}, frame ${root.getAttribute('data-anim-frame') ?? '?'} at ${root.getAttribute('data-anim-fps') ?? '?'} fps:`]
  const keys = Array.from(root.querySelectorAll('[data-anim-key]')).map((k) => k.getAttribute('data-anim-key') ?? '')
  for (const row of Array.from(root.querySelectorAll('[data-anim-row]')).filter((r) => visibleIn(r, ctx)).slice(0, ROWS_MAX)) {
    const id = row.getAttribute('data-anim-row') ?? ''
    const frames = [...new Set(keys.filter((k) => k.startsWith(`${id}@`)).map((k) => Number(k.slice(id.length + 1))))].sort((a, b) => a - b)
    const shown = frames.slice(0, KEYS_MAX).join(', ') + (frames.length > KEYS_MAX ? `, and ${frames.length - KEYS_MAX} more` : '')
    const sel = row.getAttribute('data-anim-row-selected') === 'yes' ? ' [selected]' : ''
    out.push(`    - ${clip(text(row), NAME_MAX)}${sel}${frames.length ? `: keys at ${shown}` : ''}`)
  }
  return out
}

export function tunerLines(pane: Element, part: Part, ctx: Ctx | null): string[] {
  const view = pane.getAttribute('data-tuner-view') ?? ''
  const head = `- tuner ${JSON.stringify(view)}`
  if (pane.getAttribute('data-tuner-ready') !== 'true') return [`${head} isn't ready: ${pane.getAttribute('data-tuner-state') || "it's still starting"}`]
  const out = [`${head}:`]
  if (!part || part === 'hierarchy') out.push(...hierarchyLines(pane, ctx))
  if (!part || part === 'inspector') out.push(...inspectorLines(pane, ctx))
  if (!part || part === 'timeline') out.push(...timelineLines(pane, ctx))
  if (!part || part === 'viewport') out.push('  - viewport: a picture of the scene. Drag gizmos with tuner.handle()')
  return out
}

function partOf(el: Element): Part {
  if (el.closest('[data-tuner-inspector]')) return 'inspector'
  if (el.closest('[data-scene-hierarchy]')) return 'hierarchy'
  if (el.closest('[data-tuner-animator]')) return 'timeline'
  if (el.closest('[data-scene-viewport]')) return 'viewport'
  return null
}

export function capSnapshot(text: string, max = SNAPSHOT_MAX): string {
  if (text.length <= max) return text
  const note = `- note: cut at ${max} characters. Pass a locator or a Tuner pane like tuner.inspector to read one part, or { depth: 4 } to read less`
  const room = Math.max(0, max - note.length - 1)
  const cut = text.lastIndexOf('\n', room)
  return `${text.slice(0, cut > 0 ? cut : room)}\n${note}`
}

export function leanSnapshot(root: Element, options: SnapshotOptions = {}, owns: (el: Element) => boolean = () => true): { text: string; snapshot: AriaSnapshot | null } {
  const max = typeof options.max === 'number' && options.max > 0 ? options.max : SNAPSHOT_MAX
  const win = root.ownerDocument.defaultView
  const ctx: Ctx = {
    root,
    done: new Set(),
    owns,
    offscreen: !!options.offscreen,
    view: { left: 0, top: 0, right: win?.innerWidth ?? 0, bottom: win?.innerHeight ?? 0 },
    clips: new Map(),
    blocks: []
  }
  const pane = root.closest('[data-tuner-pane]')
  if (pane) return { text: capSnapshot(tunerLines(pane, partOf(root), ctx).join('\n'), max), snapshot: null }
  const snapshot = generateAriaTree(root, { mode: 'ai' })
  beginAriaCaches()
  try {
    snapshot.root.children = leanChildren(snapshot.root, ctx)
  } finally {
    endAriaCaches()
  }
  const depth = typeof options.depth === 'number' && options.depth > 0 ? options.depth : undefined
  const rendered = renderAriaTree(snapshot, { mode: 'ai', depth }).text
  const filled = rendered.replace(/^( *)- group "@@block(\d+)@@"$/gm, (_m, pad: string, i: string) =>
    (ctx.blocks[Number(i)] ?? []).map((l) => pad + l).join('\n')
  )
  return { text: capSnapshot(filled, max), snapshot }
}
