import { create } from 'zustand'
import type { TunerTarget } from '@shared/types'
import { TUNER_SCENE_PARENT, type TunerMember, type TunerObject } from '@shared/tuner'
import { unityAssetKind } from '@shared/unity-assets'

export type TunerTabTitleKind = 'scene' | 'prefab' | 'variant' | 'staging'

export interface TunerTabTitle {
  name: string
  kind: TunerTabTitleKind
}

export const DDOL_SCENE = 'DontDestroyOnLoad'

const useTitles = create<{ titles: Record<string, TunerTabTitle> }>(() => ({ titles: {} }))

export function setTunerTabTitle(tabId: string, title: TunerTabTitle | null): void {
  const titles = useTitles.getState().titles
  const cur = titles[tabId]
  if (title ? cur && cur.name === title.name && cur.kind === title.kind : !cur) return
  const next = { ...titles }
  if (title) next[tabId] = title
  else delete next[tabId]
  useTitles.setState({ titles: next })
}

export function useTunerTabTitle(tabId: string): TunerTabTitle | null {
  return useTitles((s) => s.titles[tabId] ?? null)
}

export function useTunerTabTitles(): Record<string, TunerTabTitle> {
  return useTitles((s) => s.titles)
}

function assetName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
}

export function tunerScenesOf(objects: readonly TunerObject[], members: readonly TunerMember[]): string[] {
  const out: string[] = []
  const add = (s: string): void => {
    if (s && s !== DDOL_SCENE && !out.includes(s)) out.push(s)
  }
  for (const m of members) if (m.parent.startsWith(TUNER_SCENE_PARENT)) add(m.parent.slice(TUNER_SCENE_PARENT.length))
  for (const o of objects) add(o.scene)
  return out
}

export function tunerVariantScenes(members: readonly TunerMember[]): Set<string> {
  const envScene = new Map<string, string>()
  for (const m of members) if (m.env && m.parent.startsWith(TUNER_SCENE_PARENT)) envScene.set(m.id, m.parent.slice(TUNER_SCENE_PARENT.length))
  const out = new Set<string>()
  for (const m of members) {
    if (m.env || !m.prefab || m.prefab === 'missing') continue
    const scene = m.parent.startsWith(TUNER_SCENE_PARENT) ? m.parent.slice(TUNER_SCENE_PARENT.length) : envScene.get(m.parent)
    if (scene && /\.prefab$/i.test(scene)) out.add(scene.toLowerCase())
  }
  return out
}

export function tunerStagingScenes(members: readonly TunerMember[]): Set<string> {
  const envScene = new Map<string, string>()
  for (const m of members) if (m.env && m.parent.startsWith(TUNER_SCENE_PARENT)) envScene.set(m.id, m.parent.slice(TUNER_SCENE_PARENT.length))
  const out = new Set<string>()
  for (const m of members) {
    if (m.env || !m.staging) continue
    const scene = m.parent.startsWith(TUNER_SCENE_PARENT) ? m.parent.slice(TUNER_SCENE_PARENT.length) : envScene.get(m.parent)
    if (scene && /\.prefab$/i.test(scene)) out.add(scene.toLowerCase())
  }
  return out
}

export function tunerTitleFor(
  target: TunerTarget | null | undefined,
  scenes: readonly string[],
  variants: ReadonlySet<string> = new Set(),
  staging: ReadonlySet<string> = new Set()
): TunerTabTitle | null {
  if (target?.kind === 'file') {
    const k = unityAssetKind(target.id)
    if (k === 'scene') return { name: assetName(target.id), kind: 'scene' }
    if (k === 'prefab') return { name: assetName(target.id), kind: staging.has(target.id.toLowerCase()) ? 'staging' : variants.has(target.id.toLowerCase()) ? 'variant' : 'prefab' }
    if (k === 'model') return { name: assetName(target.id), kind: 'prefab' }
    return null
  }
  if (scenes.length === 0) return null
  const prefab = scenes.every((s) => /\.prefab$/i.test(s))
  const variant = prefab && scenes.every((s) => variants.has(s.toLowerCase()))
  const stagingPrefab = prefab && scenes.every((s) => staging.has(s.toLowerCase()))
  const names = scenes.map((s) => (/\.(unity|prefab)$/i.test(s) ? assetName(s) : s))
  return { name: names.join(', '), kind: stagingPrefab ? 'staging' : variant ? 'variant' : prefab ? 'prefab' : 'scene' }
}
