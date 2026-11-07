import { TUNER_SCENE_PARENT, type TunerEntryTarget, type TunerMember, type TunerObject } from '@shared/tuner'

export interface MemberIndex {
  byId: Map<string, TunerMember>
}

export const NO_MEMBERS: TunerMember[] = []

export function indexMembers(members: readonly TunerMember[]): MemberIndex {
  const byId = new Map<string, TunerMember>()
  for (const m of members) byId.set(m.id, m)
  return { byId }
}

export function isMemberId(id: string | null | undefined): id is string {
  return !!id && id.startsWith('m')
}

function memberChain(id: string, ix: MemberIndex): TunerMember[] {
  const chain: TunerMember[] = []
  const seen = new Set<string>()
  let cur = ix.byId.get(id)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.push(cur)
    cur = ix.byId.get(cur.parent)
  }
  return chain.reverse()
}

interface MemberBase {
  path: string
  ancestors: string[]
  scene: string
  inspectScene: string
  at?: number[]
  ambiguous: boolean
}

function memberBase(parent: string, anchors: ReadonlyMap<string, TunerObject>): MemberBase | null {
  if (parent.startsWith(TUNER_SCENE_PARENT)) {
    const scene = parent.slice(TUNER_SCENE_PARENT.length)
    return { path: '', ancestors: [], scene, inspectScene: scene, at: [], ambiguous: false }
  }
  const anchor = anchors.get(parent)
  if (!anchor || anchor.error) return null
  const inspect = anchor.inspect?.kind === 'object' ? anchor.inspect : null
  return {
    path: anchor.path,
    ancestors: [...anchor.ancestors, anchor.path.slice(anchor.path.lastIndexOf('/') + 1)],
    scene: anchor.scene,
    inspectScene: inspect?.scene ?? anchor.scene,
    at: anchor.at,
    ambiguous: !!inspect?.at
  }
}

export function memberObject(id: string, ix: MemberIndex, anchors: ReadonlyMap<string, TunerObject>): TunerObject | null {
  const chain = memberChain(id, ix)
  if (chain.length === 0) return null
  const base = memberBase(chain[0].parent, anchors)
  if (!base) return null
  const names = chain.map((m) => m.name)
  const segs = chain.map((m) => (m.dup && m.nth && m.nth > 1 ? `${m.name}[${m.nth}]` : m.name))
  const path = base.path ? `${base.path}/${segs.join('/')}` : segs.join('/')
  const scene = base.inspectScene
  const ambiguous = base.ambiguous || chain.some((m) => m.dup)
  const at = ambiguous && base.at ? [...base.at, ...chain.map((m) => m.index)] : undefined
  const inspect: TunerEntryTarget = at ? { kind: 'object', path, scene, at } : { kind: 'object', path, scene }
  const own = chain[chain.length - 1]
  return {
    id,
    path,
    scene: base.scene,
    label: own.name,
    ancestors: [...base.ancestors, ...names.slice(0, -1)],
    active: own.active,
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    localPosition: [0, 0, 0],
    localRotation: [0, 0, 0, 1],
    localScale: [1, 1, 1],
    bounds: null,
    components: [],
    kind: 'member',
    inspect
  }
}
