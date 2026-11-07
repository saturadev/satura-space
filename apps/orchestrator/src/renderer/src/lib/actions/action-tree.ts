import { useEffect, useRef, type ReactNode } from 'react'

export interface ActionInput {
  title: string
  message?: string
  placeholder?: string
  initial?: string
  submit?: string
}

export interface ActionNode {
  id: string
  label: string
  icon?: string
  glyph?: ReactNode
  hint?: string
  enabled?: boolean
  checked?: boolean
  destructive?: boolean
  primary?: boolean
  inline?: boolean
  bar?: boolean
  header?: ReactNode
  footer?: ReactNode
  desktopClass?: string
  children?: ActionNode[]
  input?: ActionInput
  shortcut?: string
  role?: 'undo' | 'redo'
  expand?: (at: { x: number; y: number }) => void
  swipe?: string
  run?: (value?: string, at?: { x: number; y: number }) => unknown
}

export interface WireAction {
  id: string
  label: string
  icon?: string
  hint?: string
  enabled: boolean
  checked?: boolean
  destructive?: boolean
  primary?: boolean
  inline?: boolean
  bar?: boolean
  children?: WireAction[]
  input?: ActionInput
  shortcut?: string
  role?: 'undo' | 'redo'
  swipe?: string
}

export function toWire(nodes: readonly ActionNode[], prefix = ''): WireAction[] {
  return nodes.map((n) => {
    const out: WireAction = { id: prefix + n.id, label: n.label, enabled: n.enabled !== false }
    if (n.icon) out.icon = n.icon
    if (n.hint) out.hint = n.hint
    else if (n.shortcut) out.hint = shortcutHint(n.shortcut)
    if (n.shortcut) out.shortcut = n.shortcut
    if (n.role) out.role = n.role
    if (n.swipe) out.swipe = n.swipe
    if (n.checked !== undefined) out.checked = n.checked
    if (n.destructive) out.destructive = true
    if (n.primary) out.primary = true
    if (n.inline) out.inline = true
    if (n.bar) out.bar = true
    if (n.input) out.input = n.input
    if (n.children) out.children = toWire(n.children, prefix)
    return out
  })
}

const GLYPH: Record<string, string> = { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃', enter: '↩', esc: '⎋', left: '←', right: '→', up: '↑', down: '↓', plus: '+', minus: '−', tab: '⇥' }

export function shortcutHint(shortcut: string): string {
  return shortcut
    .split(' ')
    .map((chord) =>
      chord
        .split('+')
        .map((k) => GLYPH[k] ?? k.toUpperCase())
        .join('')
    )
    .join(' ')
}

export function findAction(nodes: readonly ActionNode[], id: string): ActionNode | null {
  for (const n of nodes) {
    if (n.id === id && !n.children) return n
    if (n.children) {
      const hit = findAction(n.children, id)
      if (hit) return hit
    }
  }
  return null
}

export function leafIds(nodes: readonly { id: string; children?: readonly unknown[] }[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n.children) out.push(...leafIds(n.children as { id: string; children?: readonly unknown[] }[]))
    else out.push(n.id)
  }
  return out
}

export async function runAction(nodes: readonly ActionNode[], id: string, value?: string): Promise<unknown> {
  const node = findAction(nodes, id)
  if (!node) throw new Error("That action isn't available anymore")
  if (node.enabled === false) throw new Error(`${node.label} isn't available right now`)
  if (!node.run) throw new Error(`${node.label} can't run from here`)
  return await node.run(value)
}

export function section(id: string, children: (ActionNode | false | null | undefined | '' | 0)[], label = '', extra?: Partial<ActionNode>): ActionNode {
  return { id, label, inline: true, ...extra, children: children.filter(Boolean) as ActionNode[] }
}

export function compact(nodes: (ActionNode | false | null | undefined | '' | 0)[]): ActionNode[] {
  return (nodes.filter(Boolean) as ActionNode[]).filter((n) => !n.children || n.children.length > 0)
}

type Listener = () => void

const providers = new Map<string, Map<number, ActionNode[]>>()
const listeners = new Set<Listener>()
const wireCache = new Map<number, string>()
let nextToken = 1

function notify(): void {
  for (const l of listeners) l()
}

export function panelActions(scope: string | null | undefined): ActionNode[] {
  if (!scope) return []
  const byToken = providers.get(scope)
  if (!byToken) return []
  return [...byToken.values()].flat()
}

export function onPanelActionsChange(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function registeredScopes(): string[] {
  return [...providers.keys()]
}

export function usePanelActions(scope: string | null | undefined, nodes: ActionNode[]): void {
  const token = useRef(0)
  if (!token.current) token.current = nextToken++
  const wire = JSON.stringify(toWire(nodes))
  useEffect(() => {
    if (!scope) return
    const t = token.current
    let byToken = providers.get(scope)
    if (!byToken) providers.set(scope, (byToken = new Map()))
    byToken.set(t, nodes)
    if (wireCache.get(t) !== wire) {
      wireCache.set(t, wire)
      notify()
    }
  })
  useEffect(() => {
    if (!scope) return
    const t = token.current
    return () => {
      const byToken = providers.get(scope)
      byToken?.delete(t)
      if (byToken && byToken.size === 0) providers.delete(scope)
      wireCache.delete(t)
      notify()
    }
  }, [scope])
}
