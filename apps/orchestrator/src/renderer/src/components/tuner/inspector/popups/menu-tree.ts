import type { TunerMenuData } from '@shared/tuner-inspector-popups'

export interface MenuItemNode {
  kind: 'item'
  index: number
  label: string
  shortcut?: string
  checked: boolean
  disabled: boolean
}

export interface MenuSeparatorNode {
  kind: 'separator'
}

export interface MenuSubNode {
  kind: 'submenu'
  label: string
  path: string
  children: MenuNode[]
}

export type MenuNode = MenuItemNode | MenuSeparatorNode | MenuSubNode

const MOD_GLYPHS: Record<string, string> = { '%': '⌘', '#': '⇧', '&': '⌥', '^': '⌃' }

function splitShortcut(label: string): { label: string; shortcut?: string } {
  const m = /^(.*\S)\s+([%#&^]*_?[^\s%#&^_]{1,8})$/.exec(label)
  if (!m) return { label }
  const token = m[2]
  const mods = /^[%#&^_]+/.exec(token)?.[0] ?? ''
  if (!mods) return { label }
  const key = token.slice(mods.length)
  const glyphs = [...mods].map((c) => MOD_GLYPHS[c] ?? '').join('')
  return { label: m[1], shortcut: glyphs + key.toUpperCase() }
}

function tidy(nodes: MenuNode[]): MenuNode[] {
  const out: MenuNode[] = []
  for (const n of nodes) {
    if (n.kind === 'separator') {
      if (out.length === 0 || out[out.length - 1].kind === 'separator') continue
      out.push(n)
      continue
    }
    if (n.kind === 'submenu') {
      n.children = tidy(n.children)
      if (n.children.length === 0) continue
    }
    out.push(n)
  }
  while (out.length > 0 && out[out.length - 1].kind === 'separator') out.pop()
  return out
}

export function buildMenuTree(data: TunerMenuData): MenuNode[] {
  const root: MenuNode[] = []
  const subs = new Map<string, MenuSubNode>()
  const selected = new Set(data.selected ?? [])
  const levelFor = (parts: string[]): MenuNode[] => {
    let level = root
    let path = ''
    for (const part of parts) {
      path = path ? `${path}/${part}` : part
      let sub = subs.get(path)
      if (!sub) {
        sub = { kind: 'submenu', label: part, path, children: [] }
        subs.set(path, sub)
        level.push(sub)
      }
      level = sub.children
    }
    return level
  }
  data.options.forEach((raw, index) => {
    const text = raw ?? ''
    const isSep = data.separator?.[index] === true
    if (isSep) {
      levelFor(text.split('/').filter((p) => p.length > 0)).push({ kind: 'separator' })
      return
    }
    if (text === '') {
      root.push({ kind: 'separator' })
      return
    }
    const parts = text.split('/')
    const leaf = parts.pop() ?? ''
    const level = levelFor(parts.filter((p) => p.length > 0))
    if (leaf === '') return
    const { label, shortcut } = splitShortcut(leaf)
    level.push({
      kind: 'item',
      index,
      label,
      shortcut,
      checked: selected.has(index),
      disabled: data.enabled?.[index] === false
    })
  })
  return tidy(root)
}

export function isFocusable(n: MenuNode | undefined): boolean {
  return !!n && (n.kind === 'submenu' || (n.kind === 'item' && !n.disabled))
}

export function stepFocus(nodes: MenuNode[], from: number, dir: 1 | -1): number {
  const n = nodes.length
  if (n === 0) return -1
  let i = from
  for (let k = 0; k < n; k++) {
    i = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n
    if (isFocusable(nodes[i])) return i
  }
  return -1
}

export function edgeFocus(nodes: MenuNode[], last: boolean): number {
  return stepFocus(nodes, last ? 0 : nodes.length - 1, last ? -1 : 1)
}

export function nodeLabel(n: MenuNode): string {
  return n.kind === 'separator' ? '' : n.label
}

export function typeahead(nodes: MenuNode[], from: number, text: string): number {
  const q = text.toLowerCase()
  if (!q) return -1
  const n = nodes.length
  const start = q.length === 1 ? from + 1 : Math.max(0, from)
  for (let k = 0; k < n; k++) {
    const i = (start + k + n) % n
    const node = nodes[i]
    if (isFocusable(node) && nodeLabel(node).toLowerCase().startsWith(q)) return i
  }
  return -1
}

export function firstChecked(nodes: MenuNode[]): number {
  return nodes.findIndex((n) => n.kind === 'item' && n.checked && !n.disabled)
}
