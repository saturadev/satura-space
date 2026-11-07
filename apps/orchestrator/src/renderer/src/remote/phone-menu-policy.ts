import type { WireAction } from '../lib/actions/action-tree'

export const PHONE_EXCLUDED: readonly (readonly [RegExp, string])[] = [
  [/^d:tab\.fullscreen$/, 'layout'],
  [/^d:tab\.hide$/, 'layout'],
  [/^d:tab\.finder$/, 'mac-screen'],
  [/^d:workspace\.newWindow$/, 'window'],
  [/^d:workspace\.moveTo/, 'window'],
  [/^d:workbench\.sidebar$/, 'sidebar'],
  [/^d:workbench\.findInFiles$/, 'sidebar'],
  [/^d:terminal\.font\./, 'desktop-zoom'],
  [/^d:agent:[^:]+:split$/, 'layout'],
  [/^l:diff\.reveal$/, 'mac-screen'],
  [/^l:diff\.(sideBySide|inline)$/, 'phone-width'],
  [/^l:viewer\.reveal$/, 'mac-screen'],
  [/^l:viewer\.export$/, 'mac-dialog'],
  [/^l:viewer\.zoom\./, 'pinch'],
  [/^l:editor\.font\./, 'pinch'],
  [/^l:editor\.idea\./, 'keymap'],
  [/^l:editor\.selectAll$/, 'keymap'],
  [/^l:unity\.reveal(Split)?$/, 'mac-screen'],
  [/^l:tuner\.ui:(alphastopped|betastopped)$/, 'debug'],
  [/^l:tuner\.ui:(not-saved-yet|using-the-main-project)$/, 'status'],
  [/^l:tuner\.search$/, 'keymap'],
  [/^(l:)?scm\.reveal$/, 'mac-screen'],
  [/^(l:)?scm\.openFileEditor$/, 'same-as-open-file']
]

export function phoneExclusion(id: string): string | null {
  for (const [re, why] of PHONE_EXCLUDED) if (re.test(id)) return why
  return null
}

export interface PhoneMenus {
  panel: WireAction[]
  tab: WireAction[]
  workspace: WireAction[]
  excluded: string[]
}

function prune(nodes: WireAction[], excluded: string[]): WireAction[] {
  const out: WireAction[] = []
  for (const n of nodes) {
    if (n.children) {
      const kids = prune(n.children, excluded)
      if (kids.length) out.push({ ...n, children: kids })
      continue
    }
    const why = phoneExclusion(n.id)
    if (why) excluded.push(`${n.id.replace(/^[ld]:/, '')}(${why})`)
    else out.push(n.id === 'd:tab.explorer' ? { ...n, label: 'Show in Files', icon: 'folder' } : n)
  }
  return out
}

export function pruneForPhone(tree: WireAction[]): { tree: WireAction[]; excluded: string[] } {
  const excluded: string[] = []
  return { tree: prune(tree, excluded), excluded }
}

const TAB_ROOTS = new Set(['d:tab'])
const WORKSPACE_ROOTS = new Set(['d:new', 'd:workspace'])

export function splitPhoneMenus(tree: WireAction[]): PhoneMenus {
  const excluded: string[] = []
  const panel: WireAction[] = []
  const tab: WireAction[] = []
  const workspace: WireAction[] = []
  for (const n of tree) {
    const kept = prune([n], excluded)
    if (!kept.length) continue
    if (TAB_ROOTS.has(n.id)) tab.push(...kept)
    else if (n.id === 'd:workspace') workspace.push(...kept.map((k) => ({ ...k, label: 'Workspace options' })))
    else if (WORKSPACE_ROOTS.has(n.id)) workspace.push(...kept)
    else if (n.id.startsWith('d:')) workspace.push(...kept)
    else panel.push(...kept)
  }
  const destructiveLast = (nodes: WireAction[]): WireAction[] => [...nodes.filter((n) => !isDestructive(n)), ...nodes.filter(isDestructive)]
  return { panel: unfoldLong(destructiveLast(panel)), tab: unfoldLong(tab), workspace: unfoldLong(workspace), excluded }
}

export const PHONE_SUBMENU_MAX_ROWS = 6

export function menuRows(nodes: WireAction[]): number {
  return nodes.reduce((sum, n) => sum + (n.inline && n.children ? menuRows(n.children) : 1), 0)
}

export function unfoldLong(nodes: WireAction[]): WireAction[] {
  return nodes.map((n) => {
    if (!n.children) return n
    if (n.inline) return { ...n, children: unfoldLong(n.children) }
    return menuRows(n.children) > PHONE_SUBMENU_MAX_ROWS ? { ...n, inline: true } : n
  })
}

function isDestructive(n: WireAction): boolean {
  if (!n.children) return !!n.destructive
  return n.children.length > 0 && n.children.every(isDestructive)
}
