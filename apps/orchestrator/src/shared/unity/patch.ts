
import type { InstanceDesired, InstanceObserved, WorldDesired, WorldObserved } from './world'
import { defaultInstanceDesired } from './world'
import type { InstanceDesiredPatch, InstancePatch, WorldDesiredPatch, WorldPatch } from './protocol'

const INSTANCE_DESIRED_KEYS: readonly (keyof InstanceDesired)[] = [
  'role',
  'present',
  'playing',
  'paused',
  'scene',
  'hotReload',
  'refreshGen',
  'sceneGen',
  'playGen',
  'pauseGen',
  'streamRes',
  'muted',
  'volume',
  'fpsCap'
]

const INSTANCE_KEYS: readonly (keyof InstanceObserved)[] = [
  'id',
  'role',
  'playerIndex',
  'lifecycle',
  'compile',
  'compileError',
  'error',
  'warning',
  'progressLabel',
  'progressPct',
  'noCamera',
  'scene',
  'refreshGen',
  'sceneGen',
  'playGen',
  'pauseGen',
  'assetSeq',
  'paused',
  'hotReloadActive',
  'sceneDirty',
  'dirtyScenes',
  'saving',
  'connected',
  'alive',
  'reachable',
  'fault',
  'faultReason',
  'faultLine',
  'stall',
  'logPath',
  'unityMode',
  'fps',
  'ping'
]

function shallowArrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function diffInstance(prev: InstanceObserved, next: InstanceObserved): Partial<InstanceObserved> | null {
  const out: Partial<InstanceObserved> = {}
  let changed = false
  for (const k of INSTANCE_KEYS) {
    if (prev[k] !== next[k]) {
      ;(out as Record<string, unknown>)[k] = next[k]
      changed = true
    }
  }
  if (!changed) return null
  out.id = next.id
  out.role = next.role
  out.playerIndex = next.playerIndex
  return out
}

export function diffWorld(prev: WorldObserved, next: WorldObserved): WorldPatch {
  const patch: WorldPatch = {}

  if (!shallowArrayEqual(prev.scenes, next.scenes)) patch.scenes = next.scenes

  if (
    prev.project.path !== next.project.path ||
    prev.project.isUnityProject !== next.project.isUnityProject ||
    prev.project.editorVersion !== next.project.editorVersion
  ) {
    patch.project = { ...next.project }
  }

  const instances: Record<string, InstancePatch> = {}
  let touchedInstances = false

  for (const [id, nextInst] of Object.entries(next.instances)) {
    const prevInst = prev.instances[id]
    if (!prevInst) {
      instances[id] = { ...nextInst }
      touchedInstances = true
      continue
    }
    const d = diffInstance(prevInst, nextInst)
    if (d) {
      instances[id] = d
      touchedInstances = true
    }
  }
  for (const id of Object.keys(prev.instances)) {
    if (!next.instances[id]) {
      instances[id] = null
      touchedInstances = true
    }
  }
  if (touchedInstances) patch.instances = instances

  return patch
}

export function isEmptyPatch(patch: WorldPatch): boolean {
  return (
    patch.scenes === undefined &&
    patch.project === undefined &&
    (patch.instances === undefined || Object.keys(patch.instances).length === 0)
  )
}

export function applyWorldPatch(base: WorldObserved, patch: WorldPatch): WorldObserved {
  const next: WorldObserved = {
    version: base.version,
    project: patch.project ? { ...base.project, ...patch.project } : base.project,
    scenes: patch.scenes ?? base.scenes,
    instances: { ...base.instances }
  }

  if (patch.instances) {
    for (const [id, entry] of Object.entries(patch.instances)) {
      if (entry === null) {
        delete next.instances[id]
        continue
      }
      const prev = next.instances[id]
      if (prev) {
        next.instances[id] = { ...prev, ...entry }
        continue
      }
      const merged: Partial<InstanceObserved> = { ...entry }
      if (!isCompleteInstance(merged)) {
        console.log(`[patch] skipping incomplete new-instance patch for '${id}'`)
        continue
      }
      next.instances[id] = merged
    }
  }

  return next
}

function isCompleteInstance(p: Partial<InstanceObserved>): p is InstanceObserved {
  return (
    typeof p.id === 'string' &&
    (p.role === 'primary' || p.role === 'clone') &&
    typeof p.playerIndex === 'number' &&
    typeof p.lifecycle === 'string'
  )
}

function diffInstanceDesired(prev: InstanceDesired, next: InstanceDesired): Partial<InstanceDesired> | null {
  const out: Partial<InstanceDesired> = {}
  let changed = false
  for (const k of INSTANCE_DESIRED_KEYS) {
    if (prev[k] !== next[k]) {
      ;(out as Record<string, unknown>)[k] = next[k]
      changed = true
    }
  }
  return changed ? out : null
}

export function diffDesired(prev: WorldDesired, next: WorldDesired): WorldDesiredPatch {
  const patch: WorldDesiredPatch = {}
  if (prev.playerCount !== next.playerCount) patch.playerCount = next.playerCount
  if (!!prev.stopped !== !!next.stopped) patch.stopped = !!next.stopped

  const instances: Record<string, InstanceDesiredPatch> = {}
  let touched = false
  for (const [id, nextInst] of Object.entries(next.instances)) {
    const prevInst = prev.instances[id]
    if (!prevInst) {
      instances[id] = { ...nextInst }
      touched = true
      continue
    }
    const d = diffInstanceDesired(prevInst, nextInst)
    if (d) {
      instances[id] = d
      touched = true
    }
  }
  for (const id of Object.keys(prev.instances)) {
    if (!next.instances[id]) {
      instances[id] = null
      touched = true
    }
  }
  if (touched) patch.instances = instances
  return patch
}

export function isEmptyDesiredPatch(patch: WorldDesiredPatch): boolean {
  return (
    patch.playerCount === undefined &&
    patch.stopped === undefined &&
    (patch.instances === undefined || Object.keys(patch.instances).length === 0)
  )
}

export function applyDesiredPatch(base: WorldDesired, patch: WorldDesiredPatch): WorldDesired {
  const next: WorldDesired = {
    version: base.version,
    playerCount: patch.playerCount ?? base.playerCount,
    stopped: patch.stopped ?? base.stopped ?? false,
    instances: { ...base.instances }
  }
  if (patch.instances) {
    for (const [id, entry] of Object.entries(patch.instances)) {
      if (entry === null) {
        delete next.instances[id]
        continue
      }
      const prev = next.instances[id]
      if (prev) {
        next.instances[id] = { ...prev, ...entry }
        continue
      }
      next.instances[id] = { ...defaultInstanceDesired((entry.role as InstanceDesired['role']) ?? 'clone'), ...entry }
    }
  }
  return next
}
