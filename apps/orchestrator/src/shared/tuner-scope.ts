import { TUNER_SCENE_VIEW, type TunerView } from './tuner'
import { sceneLabel } from './tuner-find'
import { assetTunerViewName, assetTunerViewPath, isUnityAssetPath, unityAssetKind } from './unity-assets'

export interface TunerBase {
  kind: 'view' | 'file'
  id: string
}

export type TunerScope = { kind: 'scene'; scene: string } | { kind: 'prefab'; path: string } | { kind: 'other'; key: string }

export type TunerScopeView = Pick<TunerView, 'kind' | 'scene' | 'prefabs' | 'objects' | 'ui'>

const scene = (s: string | undefined): TunerScope => ({ kind: 'scene', scene: s ? sceneLabel(s).toLowerCase() : '' })

function fileScope(rel: string): TunerScope {
  const k = unityAssetKind(rel)
  if (k === 'scene') return scene(rel)
  if (k === 'prefab' || k === 'model') return { kind: 'prefab', path: rel.toLowerCase() }
  return { kind: 'other', key: `file:${rel}` }
}

export function viewScope(v: TunerScopeView): TunerScope {
  if (v.kind === 'prefabs') {
    const p = v.prefabs ?? []
    return p.length === 1 ? fileScope(p[0]) : { kind: 'other', key: `prefabs:${p.join('|')}` }
  }
  if (v.kind === 'scene') return scene(v.scene)
  if (v.kind === 'ui') return scene(v.ui?.scene)
  return scene(v.objects.find((o) => o.scene)?.scene)
}

export function baseScope(base: TunerBase, view: TunerScopeView | null | undefined): TunerScope {
  if (base.kind === 'file') return fileScope(base.id)
  if (base.id === TUNER_SCENE_VIEW) return scene('')
  return view ? viewScope(view) : { kind: 'other', key: `view:${base.id}` }
}

export function sameScope(a: TunerScope, b: TunerScope): boolean {
  if (a.kind === 'scene' && b.kind === 'scene') return a.scene === b.scene || !a.scene || !b.scene
  if (a.kind === 'prefab' && b.kind === 'prefab') return a.path === b.path
  return a.kind === 'other' && b.kind === 'other' && a.key === b.key
}

export function scopeRank(a: TunerScope, b: TunerScope): number {
  if (!sameScope(a, b)) return 0
  return a.kind === 'scene' && b.kind === 'scene' && a.scene !== b.scene ? 1 : 2
}

export function isBaseView(name: string): boolean {
  return name === TUNER_SCENE_VIEW || assetTunerViewPath(name) != null
}

export function baseOfView(name: string): TunerBase {
  const rel = assetTunerViewPath(name)
  return rel ? { kind: 'file', id: rel } : { kind: 'view', id: name }
}

export function filterBase(v: TunerScopeView): TunerBase {
  const p = v.kind === 'prefabs' ? (v.prefabs ?? []) : []
  if (p.length === 1 && isUnityAssetPath(p[0])) return { kind: 'file', id: p[0] }
  if (v.kind === 'scene' && v.scene && isUnityAssetPath(v.scene) && unityAssetKind(v.scene) === 'scene') return { kind: 'file', id: v.scene }
  return { kind: 'view', id: TUNER_SCENE_VIEW }
}

export function tunerTargetView(t: { kind: 'view' | 'file'; id: string; filter?: string } | null | undefined): string {
  if (!t) return ''
  if (t.filter) return t.filter
  return t.kind === 'view' ? t.id : assetTunerViewName(t.id)
}

export function tunerBaseKey(t: { kind: 'view' | 'file'; id: string } | null | undefined): string {
  if (!t) return ''
  return t.kind === 'file' ? `file:${t.id.toLowerCase()}` : `view:${t.id}`
}

export function isSceneTuner(t: { kind: 'view' | 'file'; id: string } | null | undefined): boolean {
  if (!t) return true
  return t.kind === 'file' ? unityAssetKind(t.id) === 'scene' : t.id === TUNER_SCENE_VIEW
}
