import { isUnityAssetPath, unityAssetKind } from './unity-assets'

export interface TunerTabInfo {
  tabId: string
  view: string
  base?: string
  label: string
  shown: boolean
  focused: boolean
  scratchpad?: string
  phone?: boolean
}

export interface TunerFound {
  view: string
  label: string
  count: number
  others: string[]
  activated?: boolean
}

export function tunerTabTarget(t: Pick<TunerTabInfo, 'scratchpad'>): string {
  return t.scratchpad ?? 'project'
}

export function chooseTunerTab(tabs: readonly TunerTabInfo[], view?: string, target?: string): TunerTabInfo | null {
  const named = tabs.filter((t) => (view ? t.view === view : !!t.view) && (!target || tunerTabTarget(t) === target))
  const pool = named.length || view ? named : tabs
  return pool.find((t) => t.phone) ?? pool.find((t) => t.shown && t.focused) ?? pool.find((t) => t.shown) ?? pool.find((t) => t.focused) ?? pool[0] ?? null
}

export function tunerSearchOrder(tabs: readonly TunerTabInfo[], start: string): TunerTabInfo[] {
  const named = tabs.filter((t) => !!t.view)
  const kind = (t: TunerTabInfo): number => (t.view.startsWith('@asset:') ? 2 : (t.base || t.view) === 'scene' ? 0 : 1)
  const rank = (t: TunerTabInfo): number => (t.view === start ? 0 : t.phone ? 1 : t.shown && t.focused ? 2 : t.shown ? 3 : 4 + kind(t))
  return named.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t)
}

export function matchTunerName(tabs: readonly TunerTabInfo[], name: string): TunerTabInfo | null {
  const want = String(name ?? '').trim()
  if (!want) return null
  const low = want.toLowerCase()
  const bare = (s: string): string => s.toLowerCase().replace(/^@asset:/, '').replace(/^[a-z]+:\s*/, '')
  const file = (s: string): string => bare(s).replace(/^.*\//, '').replace(/\.(unity|prefab|asset|mat)$/, '')
  const named = tabs.filter((t) => !!t.view)
  const tiers = [
    named.filter((t) => t.view === want),
    named.filter((t) => t.view.toLowerCase() === low || t.label.toLowerCase() === low),
    named.filter((t) => bare(t.view) === bare(want) || bare(t.label) === bare(want)),
    named.filter((t) => file(t.view) === file(want) || file(t.label) === file(want))
  ]
  const hit = tiers.find((t) => t.length)
  return hit ? chooseTunerTab(hit) : null
}

export function sceneLabel(scene: string): string {
  const base = scene.slice(scene.lastIndexOf('/') + 1)
  return /\.(unity|prefab)$/i.test(base) ? base.replace(/\.(unity|prefab)$/i, '') : scene
}

export function cleanObjectPath(path: string): string {
  return String(path ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '')
}

function splitScenePath(path: string, scenes: readonly string[]): { path: string; scene: string | null } {
  const clean = cleanObjectPath(path)
  const i = clean.indexOf('/')
  if (i > 0) {
    const head = clean.slice(0, i)
    if (scenes.some((s) => s === head || sceneLabel(s) === head)) return { path: clean.slice(i + 1), scene: head }
  }
  return { path: clean, scene: null }
}

export interface TunerRowInfo {
  key: string
  path: string
  scene: string
  name: string
  error?: string
}

export function rowFullPath(row: Pick<TunerRowInfo, 'path' | 'scene'>): string {
  return row.scene ? `${sceneLabel(row.scene)}/${row.path}` : row.path
}

export function findTunerRow<T extends TunerRowInfo>(rows: readonly T[], want: string): T | null {
  const w = cleanObjectPath(want)
  if (!w) return null
  const objects = rows.filter((r) => r.path)
  const exact = objects.find((r) => r.path === w) ?? objects.find((r) => rowFullPath(r) === w || `${r.scene}/${r.path}` === w)
  if (exact) return exact
  const low = w.toLowerCase()
  return objects.find((r) => r.path.toLowerCase() === low || rowFullPath(r).toLowerCase() === low) ?? null
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

export function closestTunerRows(rows: readonly TunerRowInfo[], want: string, max = 6, fallback = true): string[] {
  const w = cleanObjectPath(want).toLowerCase()
  const leaf = w.slice(w.lastIndexOf('/') + 1)
  const words = w.split(/[\s/._()-]+/).filter((x) => x.length > 1)
  const objects = rows.filter((r) => r.path)
  const scored = objects.map((r) => {
    const full = rowFullPath(r).toLowerCase()
    const name = full.slice(full.lastIndexOf('/') + 1)
    let near = 0
    if (leaf && name === leaf) near = 6
    else if (leaf && (name.includes(leaf) || leaf.includes(name))) near = 3
    else if (leaf && editDistance(name, leaf) <= Math.max(1, Math.floor(leaf.length / 3))) near = 4
    const hits = words.filter((x) => full.includes(x)).length
    return { r, near, hits }
  })
  const close = scored.filter((x) => x.near > 0)
  const pool = close.length ? close : scored.filter((x) => x.hits > 0)
  if (!pool.length && !fallback) return []
  const pick = pool.length ? [...pool].sort((a, b) => b.near - a.near || b.hits - a.hits).map((x) => x.r) : objects.filter((r) => !r.path.includes('/'))
  return pick.slice(0, max).map((r) => r.path)
}

export type TunerOpenPlan =
  | { kind: 'scene' }
  | { kind: 'asset'; path: string }
  | { kind: 'objects'; path: string; scene: string | null }
  | { kind: 'error'; message: string }

const OPEN_HELP = "Pass { scene: true }, { scene: 'Assets/Scenes/Level.unity' }, { prefab: 'Assets/Prefabs/Crate.prefab' } or { object: 'Level/Crate' }."

const isPrefabAsset = (path: string): boolean => unityAssetKind(path) === 'prefab' || unityAssetKind(path) === 'model'

export function tunerOpenPlan(args: { scene?: unknown; prefab?: unknown; object?: unknown }, scenes: readonly string[], exists: (path: string) => boolean): TunerOpenPlan {
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const object = text(args.object)
  const sceneText = text(args.scene)
  const sceneAsked = args.scene !== undefined && args.scene !== false && args.scene !== null
  let prefab = text(args.prefab)
  if (args.prefab !== undefined && args.prefab !== null && !prefab) return { kind: 'error', message: `tuner.open({ prefab }) takes the prefab's asset path, like 'Assets/Prefabs/Crate.prefab'.` }
  if (!prefab && sceneText && isPrefabAsset(sceneText)) prefab = sceneText
  else if (prefab && sceneAsked) return { kind: 'error', message: 'tuner.open() takes scene or prefab, not both.' }
  if (prefab) {
    if (object) return { kind: 'error', message: `tuner.open() takes prefab or object, not both. Open the prefab with tuner.open({ prefab: '${prefab}' }), then select a child with tuner.row('${sceneLabel(prefab)}/Child').click().` }
    if (!isUnityAssetPath(prefab) || !isPrefabAsset(prefab)) return { kind: 'error', message: `tuner.open({ prefab }) takes a prefab asset path like 'Assets/Prefabs/Crate.prefab', got '${prefab}'.` }
    if (!exists(prefab)) return { kind: 'error', message: `There is no ${prefab} in the project. Check the path from the Assets folder, including the .prefab extension.` }
    return { kind: 'asset', path: prefab }
  }
  if (object) {
    if (sceneAsked) return { kind: 'error', message: 'tuner.open() takes scene or object, not both.' }
    const split = splitScenePath(object, scenes)
    return { kind: 'objects', path: split.path, scene: split.scene }
  }
  if (!sceneAsked) return { kind: 'error', message: `tuner.open() needs to know what to open. ${OPEN_HELP}` }
  if (args.scene !== true && !sceneText) return { kind: 'error', message: `tuner.open({ scene }) takes true or a scene. ${OPEN_HELP}` }
  if (args.scene === true || scenes.some((s) => s === sceneText || sceneLabel(s) === sceneLabel(sceneText))) return { kind: 'scene' }
  if (isUnityAssetPath(sceneText) && unityAssetKind(sceneText) === 'scene') {
    if (!exists(sceneText)) return { kind: 'error', message: `There is no ${sceneText} in the project. Check the path from the Assets folder.` }
    return { kind: 'asset', path: sceneText }
  }
  const open = scenes.length ? scenes.map((s) => `'${sceneLabel(s)}'`).join(', ') : 'none'
  return { kind: 'error', message: `The scene '${sceneText}' isn't open in the Unity editor (open: ${open}). Use tuner.open({ scene: true }) for the open scenes, or pass the scene's asset path, like 'Assets/Scenes/${sceneLabel(sceneText)}.unity', to open it in its own Tuner.` }
}
