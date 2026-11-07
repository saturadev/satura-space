import { TUNER_SCENE_PARENT, type TunerMember, type TunerObject, type TunerPrefabMark } from '@shared/tuner'
import { tunerVariantScenes } from './tab-titles'

export type HierarchyRowKind = 'scene' | 'ancestor' | 'object' | 'group' | 'assets' | 'asset' | 'ghosts' | 'ghost'

export interface HierarchyRow {
  key: string
  kind: HierarchyRowKind
  name: string
  depth: number
  objectId: string | null
  label?: string
  active: boolean
  error?: string
  parent: string | null
  hasChildren: boolean
  targeted: boolean
  path: string
  scene: string
  icon?: string
  types?: string
  env?: boolean
  runtime?: boolean
  count?: number
  prefab?: TunerPrefabMark
  prefabAsset?: string
  pf?: number
  staging?: boolean
  uid?: string
}

export const CLONE_GROUP_MIN = 3
const GROUP_SUFFIX = '~clones'

export function isGroupKey(key: string): boolean {
  return key.endsWith(GROUP_SUFFIX)
}

function objectIcon(o: TunerObject): string | undefined {
  const c = o.components
  return c.length > 1 && /Transform$/.test(c[0].type) ? c[1].type : undefined
}

export const ASSETS_ROW_KEY = 'assets:'

export function sceneRowName(scene: string): string {
  if (!/\.prefab$/i.test(scene)) return scene || 'Scene'
  return scene.slice(scene.lastIndexOf('/') + 1).replace(/\.prefab$/i, '')
}

export const GHOSTS_ROW_KEY = 'ghosts:'

interface Node {
  key: string
  name: string
  path: string
  object: TunerObject | null
  member: TunerMember | null
  order: number
  children: Node[]
  byName: Map<string, Node>
}

function node(key: string, name: string, path = ''): Node {
  return { key, name, path, object: null, member: null, order: Number.POSITIVE_INFINITY, children: [], byName: new Map() }
}

function filled(n: Node): boolean {
  return !!n.object || !!n.member
}

function attachMembers(members: readonly TunerMember[], nodeById: Map<string, Node>): void {
  const sort = new Set<Node>()
  for (const m of members) {
    const parent = nodeById.get(m.parent)
    if (!parent) continue
    const slot = m.runtime ? `${m.name}~${m.id}` : m.dup ? `${m.name}~${m.index}` : m.name
    let n = parent.byName.get(slot)
    if (!n) {
      const seg = m.dup && m.nth && m.nth > 1 ? `${m.name}[${m.nth}]` : m.name
      n = node(`${parent.key}/${slot}`, m.name, parent.path ? `${parent.path}/${seg}` : seg)
      parent.byName.set(slot, n)
      parent.children.push(n)
    }
    n.member = m
    n.order = m.index
    if (n.object?.kind === 'opened') n.object = null
    nodeById.set(m.id, n)
    sort.add(parent)
  }
  for (const p of sort) p.children.sort((a, b) => a.order - b.order)
}

function child(parent: Node, name: string, slot = name): Node {
  let n = parent.byName.get(slot)
  if (!n) {
    n = node(`${parent.key}/${slot}`, name.replace(/\[\d+\]$/, ''), parent.path ? `${parent.path}/${name}` : name)
    parent.byName.set(slot, n)
    parent.children.push(n)
  }
  return n
}

export function objectSegments(o: TunerObject): string[] {
  const own = o.path.slice(o.path.lastIndexOf('/') + 1)
  if (!o.error && o.ancestors.length) return [...o.ancestors, own]
  return o.path.split('/').filter(Boolean)
}

export function buildHierarchyRows(
  objects: TunerObject[],
  compress = true,
  assets: TunerObject[] = [],
  members: readonly TunerMember[] = [],
  ghosts: TunerObject[] = []
): HierarchyRow[] {
  const scenes: Node[] = []
  const sceneByName = new Map<string, Node>()
  const nodeById = new Map<string, Node>()
  const sceneNode = (sceneName: string): Node => {
    let scene = sceneByName.get(sceneName)
    if (!scene) {
      scene = node(`${TUNER_SCENE_PARENT}${sceneName}`, sceneName)
      sceneByName.set(sceneName, scene)
      scenes.push(scene)
    }
    return scene
  }
  for (const o of objects) {
    let cur = sceneNode(o.scene || '')
    const segs = objectSegments(o)
    for (let i = 0; i < segs.length; i++) {
      const next = child(cur, segs[i])
      cur = i === segs.length - 1 && next.object && next.object.kind !== 'opened' && o.kind !== 'opened' && !o.error ? child(cur, segs[i], `${segs[i]}~${o.id}`) : next
    }
    if (!cur.object || (cur.object.kind === 'opened' && o.kind !== 'opened')) cur.object = o
    if (o.at?.length) cur.order = o.at[o.at.length - 1]
    nodeById.set(o.id, cur)
  }
  for (const m of members)
    if (m.parent.startsWith(TUNER_SCENE_PARENT) && !nodeById.has(m.parent))
      nodeById.set(m.parent, sceneNode(m.parent.slice(TUNER_SCENE_PARENT.length)))
  if (members.length > 0) attachMembers(members, nodeById)

  const rows: HierarchyRow[] = []
  const walk = (n: Node, depth: number, parent: string | null, sceneName: string): void => {
    let name = n.name
    let cur = n
    if (compress) {
      while (!filled(cur) && cur.children.length === 1 && !filled(cur.children[0])) {
        cur = cur.children[0]
        name = `${name} / ${cur.name}`
      }
    }
    const o = cur.object
    const m = o ? null : cur.member
    rows.push({
      key: cur.key,
      kind: o || m ? 'object' : 'ancestor',
      name,
      depth,
      objectId: o?.id ?? m?.id ?? null,
      label: o && o.label && o.label !== cur.name ? o.label : undefined,
      active: o ? o.active : m ? m.active : true,
      error: o?.error,
      parent,
      hasChildren: cur.children.length > 0 || (cur.member?.kids ?? 0) > 0,
      targeted: o ? o.kind !== 'opened' : !!m,
      path: cur.path,
      scene: sceneName,
      icon: o ? objectIcon(o) : m?.icon,
      types: cur.member?.types,
      env: cur.member?.env || undefined,
      runtime: (!o && m?.runtime) || undefined,
      prefab: o?.prefab ?? cur.member?.prefab,
      prefabAsset: cur.member?.asset,
      pf: o?.pf ?? cur.member?.pf,
      staging: cur.member?.staging || undefined,
      uid: cur.member?.uid
    })
    walkChildren(cur, depth + 1, sceneName)
  }
  const walkChildren = (parent: Node, depth: number, sceneName: string, parentKey: string | null = parent.key): void => {
    let groups: Map<string, Node[]> | null = null
    for (const c of parent.children) {
      if (!c.member?.runtime || c.object) continue
      groups ??= new Map()
      const list = groups.get(c.name)
      if (list) list.push(c)
      else groups.set(c.name, [c])
    }
    for (const c of parent.children) {
      const group = groups && c.member?.runtime && !c.object ? groups.get(c.name) : undefined
      if (!group || group.length < CLONE_GROUP_MIN) {
        walk(c, depth, parentKey, sceneName)
        continue
      }
      if (group[0] !== c) continue
      const key = `${parent.key}/${c.name}${GROUP_SUFFIX}`
      rows.push({
        key,
        kind: 'group',
        name: c.name,
        depth,
        objectId: null,
        active: true,
        parent: parentKey,
        hasChildren: true,
        targeted: false,
        path: '',
        scene: sceneName,
        icon: c.member?.icon,
        runtime: true,
        count: group.length
      })
      for (const g of group) walk(g, depth + 1, key, sceneName)
    }
  }
  const showScenes = scenes.length > 1 || (scenes.length === 1 && scenes[0].name !== '')
  const variants = tunerVariantScenes(members)
  for (const s of scenes) {
    if (showScenes)
      rows.push({
        key: s.key,
        kind: 'scene',
        name: sceneRowName(s.name),
        depth: 0,
        objectId: null,
        active: true,
        parent: null,
        hasChildren: s.children.length > 0,
        targeted: false,
        path: '',
        scene: s.name,
        prefab: variants.has(s.name.toLowerCase()) ? 'variant' : undefined
      })
    walkChildren(s, showScenes ? 1 : 0, s.name, showScenes ? s.key : null)
  }
  if (ghosts.length > 0) {
    rows.push({
      key: GHOSTS_ROW_KEY,
      kind: 'ghosts',
      name: 'Pinged',
      depth: 0,
      objectId: null,
      active: true,
      parent: null,
      hasChildren: true,
      targeted: false,
      path: '',
      scene: ''
    })
    for (const g of ghosts)
      rows.push({
        key: `${GHOSTS_ROW_KEY}${g.id}`,
        kind: 'ghost',
        name: g.path,
        depth: 1,
        objectId: g.id,
        active: g.active,
        error: g.error,
        parent: GHOSTS_ROW_KEY,
        hasChildren: false,
        targeted: false,
        path: g.path,
        scene: g.scene
      })
  }
  if (assets.length > 0) {
    rows.push({
      key: ASSETS_ROW_KEY,
      kind: 'assets',
      name: 'Assets',
      depth: 0,
      objectId: null,
      active: true,
      parent: null,
      hasChildren: true,
      targeted: false,
      path: '',
      scene: ''
    })
    for (const a of assets)
      rows.push({
        key: `${ASSETS_ROW_KEY}${a.path}`,
        kind: 'asset',
        name: a.label || a.path.slice(a.path.lastIndexOf('/') + 1),
        depth: 1,
        objectId: a.id,
        label: a.type || undefined,
        active: true,
        error: a.error,
        parent: ASSETS_ROW_KEY,
        hasChildren: false,
        targeted: !a.opened,
        path: a.path,
        scene: '',
        prefabAsset: /\.prefab$/i.test(a.path) ? a.path : undefined
      })
  }
  return rows
}

export function visibleRows(rows: HierarchyRow[], collapsed: ReadonlySet<string>): HierarchyRow[] {
  if (collapsed.size === 0) return rows
  const out: HierarchyRow[] = []
  let hideBelow = -1
  for (const r of rows) {
    if (hideBelow >= 0) {
      if (r.depth > hideBelow) continue
      hideBelow = -1
    }
    out.push(r)
    if (r.hasChildren && collapsed.has(r.key)) hideBelow = r.depth
  }
  return out
}

const OPEN_BY_DEFAULT = '!'

function isObjectRow(r: HierarchyRow | undefined): boolean {
  return r?.kind === 'object' || r?.kind === 'ancestor'
}

function opensByDefault(r: HierarchyRow, byKey: ReadonlyMap<string, HierarchyRow>): boolean {
  if (!isObjectRow(r)) return true
  return /\.prefab$/i.test(r.scene) && !isObjectRow(byKey.get(r.parent ?? ''))
}

export function collapsedFromExpanded(rows: HierarchyRow[], expanded: ReadonlySet<string>): Set<string> {
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const out = new Set<string>()
  for (const r of rows) {
    if (!r.hasChildren) continue
    if (opensByDefault(r, byKey) ? expanded.has(OPEN_BY_DEFAULT + r.key) : !expanded.has(r.key)) out.add(r.key)
  }
  return out
}

export function expandedFromCollapsed(
  rows: HierarchyRow[],
  prev: ReadonlySet<string>,
  collapsed: ReadonlySet<string>,
  base?: ReadonlySet<string>
): Set<string> {
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const next = new Set(prev)
  for (const r of rows) {
    if (!r.hasChildren || (base && base.has(r.key) === collapsed.has(r.key))) continue
    if (opensByDefault(r, byKey)) {
      if (collapsed.has(r.key)) next.add(OPEN_BY_DEFAULT + r.key)
      else next.delete(OPEN_BY_DEFAULT + r.key)
    } else if (collapsed.has(r.key)) next.delete(r.key)
    else next.add(r.key)
  }
  return next
}

export function pruneExpanded(expanded: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const out = new Set(expanded)
  for (const key of keys) {
    const under = `${key}/`
    for (const k of expanded) if (k.startsWith(under)) out.delete(k)
  }
  return out
}

export function moveExpanded(expanded: ReadonlySet<string>, from: string, to: string): Set<string> | null {
  let out: Set<string> | null = null
  for (const k of expanded) {
    const open = k.startsWith(OPEN_BY_DEFAULT)
    const bare = open ? k.slice(OPEN_BY_DEFAULT.length) : k
    if (bare !== from && !bare.startsWith(`${from}/`)) continue
    out ??= new Set(expanded)
    out.delete(k)
    out.add((open ? OPEN_BY_DEFAULT : '') + to + bare.slice(from.length))
  }
  return out
}

function subtreeKeys(rows: HierarchyRow[], key: string): string[] {
  const at = rows.findIndex((r) => r.key === key)
  if (at < 0) return []
  const out = [key]
  for (let i = at + 1; i < rows.length && rows[i].depth > rows[at].depth; i++) if (rows[i].hasChildren) out.push(rows[i].key)
  return out
}

export function setExpanded(
  rows: HierarchyRow[],
  collapsed: ReadonlySet<string>,
  key: string,
  expanded: boolean,
  recursive: boolean
): Set<string> {
  const next = new Set(collapsed)
  const keys = recursive ? subtreeKeys(rows, key) : [key]
  for (const k of keys) {
    if (expanded) next.delete(k)
    else next.add(k)
  }
  return next
}

export function toggleCollapsed(rows: HierarchyRow[], collapsed: ReadonlySet<string>, key: string, recursive: boolean): Set<string> {
  return setExpanded(rows, collapsed, key, collapsed.has(key), recursive)
}

function ancestorKeys(rows: HierarchyRow[], key: string): string[] {
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const out: string[] = []
  let p = byKey.get(key)?.parent ?? null
  while (p) {
    out.push(p)
    p = byKey.get(p)?.parent ?? null
  }
  return out
}

export function revealRow(rows: HierarchyRow[], collapsed: ReadonlySet<string>, key: string): Set<string> | null {
  const hidden = ancestorKeys(rows, key).filter((k) => collapsed.has(k))
  if (hidden.length === 0) return null
  const next = new Set(collapsed)
  for (const k of hidden) next.delete(k)
  return next
}

export function rowForObject(rows: HierarchyRow[], id: string | null): HierarchyRow | null {
  if (!id) return null
  return rows.find((r) => r.objectId === id) ?? null
}

export function hiddenChanges(rows: HierarchyRow[], changed: ReadonlySet<string> | undefined): Set<string> {
  const out = new Set<string>()
  if (!changed || changed.size === 0) return out
  const byKey = new Map(rows.map((r) => [r.key, r]))
  for (const r of rows) {
    if (!r.objectId || !changed.has(r.objectId)) continue
    let p = r.parent
    while (p) {
      out.add(p)
      p = byKey.get(p)?.parent ?? null
    }
  }
  return out
}

export type HierarchyKeyAction =
  | { kind: 'collapse'; collapsed: Set<string> }
  | { kind: 'focus'; key: string }
  | null

export function hierarchyKey(
  rows: HierarchyRow[],
  collapsed: ReadonlySet<string>,
  key: string,
  arrow: 'left' | 'right',
  recursive: boolean
): HierarchyKeyAction {
  const row = rows.find((r) => r.key === key)
  if (!row) return null
  if (arrow === 'right') {
    if (!row.hasChildren) return null
    if (!recursive && !collapsed.has(key)) return null
    return { kind: 'collapse', collapsed: setExpanded(rows, collapsed, key, true, recursive) }
  }
  if (row.hasChildren && (recursive || !collapsed.has(key)))
    return { kind: 'collapse', collapsed: setExpanded(rows, collapsed, key, false, recursive) }
  return row.parent ? { kind: 'focus', key: row.parent } : null
}

export function selectableRows(rows: HierarchyRow[]): HierarchyRow[] {
  return rows.filter((r) => !!r.objectId && !r.error && (r.kind === 'object' || r.kind === 'ghost'))
}

export function rowForPath(rows: HierarchyRow[], path: string, scene: string): HierarchyRow | null {
  const clean = path.replace(/^\/+|\/+$/g, '')
  let loose: HierarchyRow | null = null
  for (const r of rows) {
    if (r.kind !== 'object' && r.kind !== 'ancestor' && r.kind !== 'ghost') continue
    if (r.path !== clean) continue
    if (r.scene === scene) return r
    if (!loose && (!scene || !r.scene)) loose = r
  }
  return loose
}

export function bulkyRows(rows: readonly HierarchyRow[], seen: Set<string>, limit = 8): string[] {
  const out: string[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.kind !== 'object' || !r.objectId?.startsWith('m') || !r.hasChildren || seen.has(r.key)) continue
    seen.add(r.key)
    let n = 0
    for (let j = i + 1; j < rows.length && rows[j].depth > r.depth; j++) n++
    if (n > limit) out.push(r.key)
  }
  return out
}
