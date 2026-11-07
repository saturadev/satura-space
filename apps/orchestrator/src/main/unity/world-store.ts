
import {
  defaultInstanceDesired,
  emptyWorldDesired,
  emptyWorldObserved,
  MAX_FPS_CAP,
  normalizeStreamRes,
  type CompileState,
  type EditorFaultKind,
  type InstanceDesired,
  type InstanceObserved,
  type InstanceRole,
  type Lifecycle,
  type UnityMode,
  type WorldDesired,
  type WorldObserved
} from '@shared/unity/world'
import {
  WORLD_EVENT,
  type ProgressOp,
  type WorldDesiredPatchEvent,
  type WorldPatchEvent,
  type WorldProgressEvent,
  type WorldSnapshotEvent
} from '@shared/unity/protocol'
import { diffDesired, diffWorld, isEmptyDesiredPatch, isEmptyPatch } from '@shared/unity/patch'
import { readFpsCapPref, readStoppedPref, readStreamPrefs, writeFpsCapPref, writeStoppedPref, writeStreamPrefs } from './project-prefs'
import { censusTrack } from '@shared/census'
import { debugLog } from '@shared/debug-log'

export const WORLD_CHANNEL = 'unity:world'

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export interface MainSignal {
  alive?: boolean
  reachable?: boolean
  connected?: boolean
  bootPhase?: Lifecycle
  launchPhase?: string
  launchPct?: number
  compileError?: string | null
  restarting?: boolean
  exited?: boolean
  unityMode?: UnityMode
  error?: string | null
  warning?: string | null
  fps?: number
  ping?: number
  pid?: number | null
  fault?: EditorFaultKind | ''
  faultReason?: string
  faultLine?: number
  stall?: string
  logPath?: string
}

interface EditorFacts {
  scene: string
  compile: CompileState
  compileError: string | null
  refreshGen: number
  sceneGen: number
  playGen: number
  pauseGen: number
  assetSeq: number
  paused: boolean
  hotReloadActive: boolean
  sceneDirty: boolean
  dirtyScenes: string
  saving: boolean
  progressLabel: string
  progressPct: number
  noCamera: boolean
}

interface InstanceRaw {
  id: string
  role: InstanceRole
  playerIndex: number
  editor: EditorFacts | null
  editorLifecycle: Lifecycle | null
  main: MainSignal
  lastIngestTs: number
}

interface ProjectState {
  projectPath: string
  desired: WorldDesired
  desiredSent: WorldDesired
  composed: WorldObserved
  instances: Map<string, InstanceRaw>
  editorProject: { isUnityProject: boolean; editorVersion?: string; scenes: string[] }
  tearingDown: boolean
}

export interface WorldFanout {

  subscribers(projectPath: string): Array<{ unityId: string; wcId: number }>

  instanceSubscribers(instanceId: string): Array<{ unityId: string; wcId: number }>
  send(wcId: number, channel: string, payload: unknown): void
}

const NO_FANOUT: WorldFanout = { subscribers: () => [], instanceSubscribers: () => [], send: () => {} }

type ChangeListener = (projectPath: string) => void

export type WorldBroadcast = WorldPatchEvent | WorldDesiredPatchEvent | WorldProgressEvent
type BroadcastListener = (projectPath: string, event: WorldBroadcast) => void

export class WorldStore {
  private readonly projects = censusTrack('world-store.projects', new Map<string, ProjectState>())
  private readonly instanceIndex = censusTrack('world-store.instanceIndex', new Map<string, string>())
  private fanout: WorldFanout = NO_FANOUT
  private readonly onDesired = censusTrack('world-store.onDesired', new Set<ChangeListener>())
  private readonly onObserved = censusTrack('world-store.onObserved', new Set<ChangeListener>())
  private readonly onBroadcast = censusTrack('world-store.onBroadcast', new Set<BroadcastListener>())
  private readonly onBlocked = censusTrack('world-store.onPlayBlocked', new Set<ChangeListener>())
  private readonly watchers = censusTrack('world-store.watchers', new Map<string, Set<number>>())
  private readonly now: () => number
  private refreshGate: ((projectPath: string, beforePlay?: boolean) => boolean) | null = null

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  setFanout(fanout: WorldFanout): void {
    this.fanout = fanout
  }

  watch(projectPath: string, wcId: number): void {
    if (!projectPath) return
    let set = this.watchers.get(projectPath)
    if (!set) {
      set = new Set()
      this.watchers.set(projectPath, set)
    }
    set.add(wcId)
  }

  unwatchAll(wcId: number): void {
    for (const [pp, set] of [...this.watchers]) {
      set.delete(wcId)
      if (set.size === 0) this.watchers.delete(pp)
    }
  }

  private targets(projectPath: string): Array<{ unityId: string; wcId: number }> {
    const subs = this.fanout.subscribers(projectPath)
    const watching = this.watchers.get(projectPath)
    if (!watching?.size) return subs
    const covered = new Set(subs.map((s) => s.wcId))
    return [...subs, ...[...watching].filter((wcId) => !covered.has(wcId)).map((wcId) => ({ unityId: '', wcId }))]
  }

  setRefreshGate(cb: ((projectPath: string, beforePlay?: boolean) => boolean) | null): void {
    this.refreshGate = cb
  }

  onDesiredChange(cb: ChangeListener): () => void {
    this.onDesired.add(cb)
    return () => this.onDesired.delete(cb)
  }

  onObservedChange(cb: ChangeListener): () => void {
    this.onObserved.add(cb)
    return () => this.onObserved.delete(cb)
  }

  onPlayBlocked(cb: ChangeListener): () => void {
    this.onBlocked.add(cb)
    return () => this.onBlocked.delete(cb)
  }

  onWorldBroadcast(cb: BroadcastListener): () => void {
    this.onBroadcast.add(cb)
    return () => this.onBroadcast.delete(cb)
  }

  private publish(projectPath: string, event: WorldBroadcast): void {
    for (const cb of this.onBroadcast) {
      try {
        cb(projectPath, event)
      } catch (e) {
        console.log(`[world-store] onWorldBroadcast listener threw: ${(e as Error).message}`)
      }
    }
  }

  attachInstance(projectPath: string, instanceId: string, role: InstanceRole, playerIndex: number): void {
    const ps = this.ensureProject(projectPath)
    this.instanceIndex.set(instanceId, projectPath)
    const existing = ps.instances.get(instanceId)
    if (existing) {
      existing.role = role
      existing.playerIndex = playerIndex
      existing.editor = null
      existing.editorLifecycle = null
      existing.main = {}
      existing.lastIngestTs = 0
    } else {
      ps.instances.set(instanceId, {
        id: instanceId,
        role,
        playerIndex,
        editor: null,
        editorLifecycle: null,
        main: {},
        lastIngestTs: 0
      })
    }
    if (!ps.desired.instances[instanceId]) {
      const desired = defaultInstanceDesired(role)
      const stream = readStreamPrefs(projectPath)
      if (stream) desired.streamRes = stream.res
      desired.fpsCap = readFpsCapPref(projectPath, playerIndex)
      ps.desired.instances[instanceId] = desired
      ps.desired.version++
      this.notifyDesired(projectPath)
    }
    this.recompute(ps)
  }

  detachInstance(instanceId: string): void {
    const projectPath = this.instanceIndex.get(instanceId)
    if (!projectPath) return
    this.instanceIndex.delete(instanceId)
    const ps = this.projects.get(projectPath)
    if (!ps) return
    ps.instances.delete(instanceId)
    if (ps.desired.instances[instanceId]) {
      delete ps.desired.instances[instanceId]
      ps.desired.version++
      this.notifyDesired(projectPath)
    }
    this.recompute(ps)
  }

  forgetProject(projectPath: string): boolean {
    const ps = this.projects.get(projectPath)
    if (!ps || ps.instances.size > 0) return false
    this.projects.delete(projectPath)
    for (const [id, pp] of this.instanceIndex) if (pp === projectPath) this.instanceIndex.delete(id)
    return true
  }

  resolveProject(projectPath: string): string {
    if (!projectPath || this.projects.has(projectPath)) return projectPath
    const norm = (p: string): string => {
      const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
      return process.platform === 'win32' ? s.toLowerCase() : s
    }
    const want = norm(projectPath)
    for (const key of this.projects.keys()) if (norm(key) === want) return key
    return projectPath
  }

  getWorld(projectPath: string): { observed: WorldObserved; desired: WorldDesired } {
    const ps = this.projects.get(projectPath)
    if (!ps) return { observed: emptyWorldObserved(projectPath), desired: { ...emptyWorldDesired(), stopped: readStoppedPref(projectPath) } }
    return { observed: ps.composed, desired: ps.desired }
  }

  isStopped(projectPath: string): boolean {
    if (!projectPath) return false
    return this.ensureProject(projectPath).desired.stopped === true
  }

  playModeActive(projectPath: string): boolean {
    const ps = this.projects.get(projectPath)
    if (!ps) return false
    for (const inst of Object.values(ps.composed.instances)) {
      if (
        inst.lifecycle === 'playing' ||
        inst.lifecycle === 'entering-play' ||
        inst.lifecycle === 'exiting-play'
      )
        return true
    }
    for (const d of Object.values(ps.desired.instances)) if (d.playing) return true
    return false
  }

  anyPlaying(): boolean {
    for (const ps of this.projects.values()) {
      for (const inst of Object.values(ps.composed.instances)) {
        if (inst.lifecycle === 'playing' || inst.lifecycle === 'entering-play') return true
      }
    }
    return false
  }

  resyncSubscriber(projectPath: string, unityId: string, wcId: number): void {
    const ps = this.projects.get(projectPath)
    const world = ps ? ps.composed : emptyWorldObserved(projectPath)
    const desired = ps ? ps.desired : emptyWorldDesired()
    const snap: WorldSnapshotEvent = { type: 'event', event: WORLD_EVENT.snapshot, world, desired }
    this.fanout.send(wcId, WORLD_CHANNEL, { ...snap, projectPath, id: unityId })
  }

  setDesired(projectPath: string, patch: DeepPartial<WorldDesired>): WorldDesired {
    const ps = this.ensureProject(projectPath)
    const d = ps.desired
    if (patch.playerCount !== undefined) d.playerCount = patch.playerCount
    if (patch.stopped !== undefined && (patch.stopped === true) !== d.stopped) {
      d.stopped = patch.stopped === true
      console.log(`[world-store] ${projectPath} stopped=${d.stopped}`)
      writeStoppedPref(projectPath, d.stopped)
    }
    let enteringPlay = false
    let refreshBumped = false
    if (patch.instances) {
      for (const [id, ipRaw] of Object.entries(patch.instances)) {
        if (!ipRaw) continue
        let ip = ipRaw
        const base = d.instances[id] ?? defaultInstanceDesired((ip.role as InstanceRole) ?? 'clone')
        if (
          ip.refreshGen !== undefined &&
          ip.refreshGen > base.refreshGen &&
          ps.instances.get(id)?.role === 'primary' &&
          !(this.refreshGate?.(projectPath) ?? true)
        ) {
          debugLog(
            `[refreshgen] setDesired ${id}: bump ${base.refreshGen} → ${ip.refreshGen} dropped — no asset changes since the last refresh`
          )
          ip = { ...ip }
          delete ip.refreshGen
        }
        if (ip.refreshGen !== undefined && ip.refreshGen !== base.refreshGen) {
          debugLog(`[refreshgen] setDesired ${id}: ${base.refreshGen} → ${ip.refreshGen}`)
          if (ps.instances.get(id)?.role === 'primary') refreshBumped = true
        }
        const next = { ...base, ...(ip as Partial<InstanceDesired>) }
        if (ip.streamRes !== undefined) next.streamRes = normalizeStreamRes(String(ip.streamRes)) ?? base.streamRes
        if (ip.fpsCap !== undefined) {
          const cap = Number(ip.fpsCap)
          next.fpsCap = Number.isFinite(cap) && cap > 0 ? Math.min(MAX_FPS_CAP, Math.round(cap)) : 0
        }
        if (ip.playGen === undefined && ip.playing !== undefined && ip.playing !== base.playing)
          next.playGen = base.playGen + 1
        if (ip.pauseGen === undefined && ip.paused !== undefined && ip.paused !== base.paused)
          next.pauseGen = base.pauseGen + 1
        if (ip.playing === true && base.playing !== true) enteringPlay = true
        if (ip.sceneGen === undefined && ip.scene !== undefined && ip.scene !== '' && ip.scene !== base.scene)
          next.sceneGen = base.sceneGen + 1
        d.instances[id] = next
        if (ip.streamRes !== undefined) writeStreamPrefs(projectPath, { res: next.streamRes })
        if (ip.fpsCap !== undefined && next.fpsCap !== base.fpsCap) {
          const playerIndex = ps.instances.get(id)?.playerIndex
          if (playerIndex !== undefined) writeFpsCapPref(projectPath, playerIndex, next.fpsCap)
        }
      }
    }
    if (enteringPlay && !refreshBumped && (this.refreshGate?.(projectPath, true) ?? true))
      this.bumpPrimaryRefresh(ps)
    d.version++
    this.notifyDesired(projectPath)
    return d
  }

  requestStop(projectPath: string, instanceId: string): void {
    const ps = this.projects.get(projectPath)
    if (!ps) return
    const obs = ps.composed.instances[instanceId]
    const stillPlaying = !!obs && (obs.lifecycle === 'playing' || obs.lifecycle === 'entering-play')
    if (!stillPlaying) {
      this.setDesired(projectPath, { instances: { [instanceId]: { playing: false } } })
      return
    }
    const cur = ps.desired.instances[instanceId]
    const nextGen = Math.max(cur?.playGen ?? 0, obs.playGen) + 1
    this.setDesired(projectPath, { instances: { [instanceId]: { playing: false, playGen: nextGen } } })
  }

  private bumpPrimaryRefresh(ps: ProjectState): void {
    let primaryId: string | undefined
    for (const [id, raw] of ps.instances) if (raw.role === 'primary') primaryId = id
    if (!primaryId) return
    const cur = ps.desired.instances[primaryId] ?? defaultInstanceDesired('primary')
    const nextGen = cur.refreshGen + 1
    debugLog(`[refreshgen] refresh-before-play ${primaryId}: ${cur.refreshGen} → ${nextGen}`)
    ps.desired.instances[primaryId] = { ...cur, refreshGen: nextGen }
  }

  setTearingDown(projectPath: string, value: boolean): void {
    const ps = this.projects.get(projectPath)
    if (!ps || ps.tearingDown === value) return
    ps.tearingDown = value
  }

  ingestEditorSnapshot(instanceId: string, world: WorldObserved): void {
    const projectPath = this.instanceIndex.get(instanceId)
    if (!projectPath) return
    const ps = this.projects.get(projectPath)
    if (!ps) return
    const raw = ps.instances.get(instanceId)
    if (!raw) return

    const ids = Object.keys(world.instances)
    const entry = world.instances[instanceId] ?? (ids.length === 1 ? world.instances[ids[0]] : undefined)
    if (!entry) {
      console.log(`[world-store] ingest: no instance '${instanceId}' in snapshot (instances=${ids.length})`)
      return
    }
    raw.editor = {
      scene: entry.scene ?? '',
      compile: entry.compile ?? 'idle',
      compileError: entry.compileError ?? null,
      refreshGen: entry.refreshGen ?? 0,
      sceneGen: entry.sceneGen ?? 0,
      playGen: entry.playGen ?? 0,
      pauseGen: entry.pauseGen ?? 0,
      assetSeq: entry.assetSeq ?? 0,
      paused: entry.paused ?? false,
      hotReloadActive: entry.hotReloadActive ?? false,
      sceneDirty: entry.sceneDirty === true,
      dirtyScenes: typeof entry.dirtyScenes === 'string' ? entry.dirtyScenes : '',
      saving: entry.saving === true,
      progressLabel: entry.progressLabel ?? '',
      progressPct: typeof entry.progressPct === 'number' ? entry.progressPct : -1,
      noCamera: entry.noCamera === true
    }
    raw.editorLifecycle = entry.lifecycle ?? null
    if (entry.compile === 'compiling' && raw.main.compileError) raw.main.compileError = null
    raw.main.reachable = true
    raw.lastIngestTs = this.now()

    if (raw.role === 'primary') {
      ps.editorProject.scenes = world.scenes
      ps.editorProject.isUnityProject = world.project.isUnityProject
      ps.editorProject.editorVersion = world.project.editorVersion
    }
    this.recompute(ps)
  }

  setMainSignal(instanceId: string, signal: MainSignal): void {
    const projectPath = this.instanceIndex.get(instanceId)
    if (!projectPath) return
    const ps = this.projects.get(projectPath)
    if (!ps) return
    const raw = ps.instances.get(instanceId)
    if (!raw) return
    raw.main = { ...raw.main, ...signal }
    this.recompute(ps)
  }

  emitProgress(instanceId: string, op: ProgressOp, phase: string, pct?: number, message?: string): void {
    const projectPath = this.instanceIndex.get(instanceId)
    if (!projectPath) return
    const evt: WorldProgressEvent = {
      type: 'event',
      event: WORLD_EVENT.progress,
      instanceId,
      op,
      phase,
      ...(pct !== undefined ? { pct } : {}),
      ...(message !== undefined ? { message } : {})
    }
    for (const { unityId, wcId } of this.targets(projectPath)) {
      this.fanout.send(wcId, WORLD_CHANNEL, { ...evt, projectPath, id: unityId })
    }
    this.publish(projectPath, evt)
  }

  private ensureProject(projectPath: string): ProjectState {
    let ps = this.projects.get(projectPath)
    if (!ps) {
      const desired = emptyWorldDesired()
      desired.stopped = readStoppedPref(projectPath)
      ps = {
        projectPath,
        desired,
        desiredSent: cloneDesired(desired),
        composed: emptyWorldObserved(projectPath),
        instances: new Map(),
        editorProject: { isUnityProject: true, scenes: [] },
        tearingDown: false
      }
      this.projects.set(projectPath, ps)
    }
    return ps
  }

  private notifyDesired(projectPath: string): void {
    const ps = this.projects.get(projectPath)
    if (ps) this.broadcastDesired(ps)
    for (const cb of this.onDesired) {
      try {
        cb(projectPath)
      } catch (e) {
        console.log(`[world-store] onDesired listener threw: ${(e as Error).message}`)
      }
    }
  }

  private broadcastDesired(ps: ProjectState): void {
    const prev = ps.desiredSent
    const patch = diffDesired(prev, ps.desired)
    if (isEmptyDesiredPatch(patch)) return
    const evt: WorldDesiredPatchEvent = {
      type: 'event',
      event: WORLD_EVENT.desired,
      baseVersion: prev.version,
      version: ps.desired.version,
      patch
    }
    for (const { unityId, wcId } of this.targets(ps.projectPath)) {
      this.fanout.send(wcId, WORLD_CHANNEL, { ...evt, projectPath: ps.projectPath, id: unityId })
    }
    ps.desiredSent = cloneDesired(ps.desired)
    this.publish(ps.projectPath, evt)
  }

  private playWasBlocked(projectPath: string): void {
    for (const cb of this.onBlocked) {
      try {
        cb(projectPath)
      } catch (e) {
        console.log(`[world-store] onPlayBlocked listener threw: ${(e as Error).message}`)
      }
    }
  }

  private enforceDesiredInvariants(ps: ProjectState): boolean {
    let changed = false
    let primaryStopAdopted = false
    let targetGen = 0
    for (const d of Object.values(ps.desired.instances)) if (d.refreshGen > targetGen) targetGen = d.refreshGen
    let primaryObs: InstanceObserved | undefined
    for (const [pid, raw] of ps.instances)
      if (raw.role === 'primary') primaryObs = ps.composed.instances[pid]
    const compileBlocked =
      !!primaryObs && primaryObs.compile === 'error' && primaryObs.refreshGen >= targetGen
    for (const [id, d] of Object.entries(ps.desired.instances)) {
      const obs = ps.composed.instances[id]
      const playing = !!obs && (obs.lifecycle === 'playing' || obs.lifecycle === 'entering-play')
      let nd = d
      if (compileBlocked && nd.playing && !playing) {
        console.log(`[world-store] cancelling pending play for ${id} — compile errors block Play Mode`)
        nd = { ...nd, playing: false }
        if (ps.instances.get(id)?.role === 'primary') queueMicrotask(() => this.playWasBlocked(ps.projectPath))
      }
      if (nd.hotReload && !playing) nd = { ...nd, hotReload: false }
      if (obs && obs.refreshGen > nd.refreshGen) nd = { ...nd, refreshGen: obs.refreshGen }
      if (obs && obs.playGen > nd.playGen) nd = { ...nd, playGen: obs.playGen }
      if (obs && obs.playGen >= nd.playGen && nd.playing !== playing) {
        if (!playing && ps.instances.get(id)?.role === 'primary') primaryStopAdopted = true
        nd = { ...nd, playing }
      }
      if (obs && obs.pauseGen > nd.pauseGen) nd = { ...nd, pauseGen: obs.pauseGen }
      if (obs && playing && obs.pauseGen >= nd.pauseGen && nd.paused !== obs.paused)
        nd = { ...nd, paused: obs.paused }
      if (nd.paused && !playing) nd = { ...nd, paused: false }
      if (obs && obs.sceneGen > nd.sceneGen) nd = { ...nd, sceneGen: obs.sceneGen }
      if (
        obs &&
        obs.sceneGen >= nd.sceneGen &&
        obs.lifecycle === 'editmode' &&
        obs.scene !== '' &&
        nd.scene !== '' &&
        nd.scene !== obs.scene
      )
        nd = { ...nd, scene: obs.scene }
      if (nd !== d) {
        ps.desired.instances[id] = nd
        changed = true
      }
    }
    if (primaryStopAdopted) {
      for (const [id, d] of Object.entries(ps.desired.instances)) {
        if (ps.instances.get(id)?.role === 'primary') continue
        const obs = ps.composed.instances[id]
        const stillPlaying = !!obs && (obs.lifecycle === 'playing' || obs.lifecycle === 'entering-play')
        if (!d.playing && !stillPlaying) continue
        const nextGen = Math.max(d.playGen, obs?.playGen ?? 0) + 1
        console.log(`[world-store] primary stop adopted — stopping ${id} playGen → ${nextGen}`)
        ps.desired.instances[id] = { ...d, playing: false, playGen: nextGen }
        changed = true
      }
    }
    if (changed) ps.desired.version++
    return changed
  }

  private recompute(ps: ProjectState): void {
    const prev = ps.composed
    const next = this.compose(ps, prev.version)
    const patch = diffWorld(prev, next)
    if (isEmptyPatch(patch)) return

    next.version = prev.version + 1
    ps.composed = next

    const patchEvt: WorldPatchEvent = {
      type: 'event',
      event: WORLD_EVENT.patch,
      baseVersion: prev.version,
      version: next.version,
      patch
    }
    for (const { unityId, wcId } of this.targets(ps.projectPath)) {
      this.fanout.send(wcId, WORLD_CHANNEL, { ...patchEvt, projectPath: ps.projectPath, id: unityId })
    }
    this.publish(ps.projectPath, patchEvt)

    for (const cb of this.onObserved) {
      try {
        cb(ps.projectPath)
      } catch (e) {
        console.log(`[world-store] onObserved listener threw: ${(e as Error).message}`)
      }
    }

    if (this.enforceDesiredInvariants(ps)) this.notifyDesired(ps.projectPath)
  }

  private compose(ps: ProjectState, version: number): WorldObserved {
    const instances: Record<string, InstanceObserved> = {}
    for (const raw of ps.instances.values()) {
      instances[raw.id] = composeInstance(raw)
    }
    return {
      version,
      project: {
        path: ps.projectPath,
        isUnityProject: ps.editorProject.isUnityProject,
        editorVersion: ps.editorProject.editorVersion
      },
      scenes: ps.editorProject.scenes,
      instances
    }
  }

}

function cloneDesired(d: WorldDesired): WorldDesired {
  const instances: Record<string, InstanceDesired> = {}
  for (const [k, v] of Object.entries(d.instances)) instances[k] = { ...v }
  return { version: d.version, playerCount: d.playerCount, stopped: d.stopped, instances }
}

const IDLE_EDITOR: EditorFacts = {
  scene: '',
  compile: 'idle',
  compileError: null,
  refreshGen: 0,
  sceneGen: 0,
  playGen: 0,
  pauseGen: 0,
  assetSeq: 0,
  paused: false,
  hotReloadActive: false,
  sceneDirty: false,
  dirtyScenes: '',
  saving: false,
  progressLabel: '',
  progressPct: -1,
  noCamera: false
}

function composeInstance(raw: InstanceRaw): InstanceObserved {
  const ed = raw.editor ?? IDLE_EDITOR
  const m = raw.main
  const lifecycle = resolveLifecycle(raw)
  const bootLabel =
    lifecycle === 'launching' || lifecycle === 'restarting' ? (m.launchPhase ?? '') : ''
  const progressLabel = ed.progressLabel || bootLabel
  const progressPct = ed.progressLabel
    ? ed.progressPct
    : bootLabel
      ? (m.launchPct ?? -1)
      : -1
  const compileError = ed.compileError ?? m.compileError ?? null
  const compile: CompileState =
    ed.compile === 'compiling' ? 'compiling' : compileError ? 'error' : ed.compile
  return {
    id: raw.id,
    role: raw.role,
    playerIndex: raw.playerIndex,
    lifecycle,
    compile,
    compileError,
    error: m.error ?? null,
    warning: m.warning ?? null,
    progressLabel,
    progressPct,
    noCamera: lifecycle === 'playing' && ed.noCamera,
    scene: ed.scene,
    refreshGen: ed.refreshGen,
    sceneGen: ed.sceneGen,
    playGen: ed.playGen,
    pauseGen: ed.pauseGen,
    assetSeq: ed.assetSeq,
    paused: ed.paused,
    hotReloadActive: ed.hotReloadActive,
    sceneDirty: ed.sceneDirty,
    dirtyScenes: ed.dirtyScenes,
    saving: ed.saving,
    connected: m.connected === true,
    alive: m.exited ? false : (m.alive ?? raw.editor !== null),
    reachable: m.exited ? false : (m.reachable ?? true),
    fault: m.fault ?? '',
    faultReason: m.faultReason ?? '',
    faultLine: m.faultLine ?? 0,
    stall: m.stall ?? '',
    logPath: m.logPath ?? '',
    unityMode: m.unityMode ?? 'normal',
    fps: m.fps ?? 0,
    ping: m.ping ?? 0
  }
}

function resolveLifecycle(raw: InstanceRaw): Lifecycle {
  const m = raw.main
  if (m.exited) return 'exited'
  if (m.error) return 'error'
  if (m.restarting) return 'restarting'
  if (raw.editorLifecycle && raw.editorLifecycle !== 'init') return raw.editorLifecycle
  if (m.bootPhase) return m.bootPhase
  if (m.alive) return 'launching'
  return 'init'
}

export const worldStore = new WorldStore()
