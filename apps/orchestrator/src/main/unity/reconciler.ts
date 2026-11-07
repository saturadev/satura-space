import type { CommandAckFile, CommandKind, UnityCommand } from '@shared/unity/protocol'
import type { CompileState, InstanceObserved, Lifecycle, WorldDesired, WorldObserved } from '@shared/unity/world'
import { defaultInstanceDesired } from '@shared/unity/world'
import type { FileChannel } from './transport/file-channel'
import type { WorldStore } from './world-store'
import { censusTrack } from '@shared/census'
import { debugLog } from '@shared/debug-log'

export interface InstanceMeta {
  projectPath: string
  isPrimary: boolean
  cloneId?: string
}

export interface ProcessHost {
  addClone(projectPath: string): Promise<unknown>
  removeClone(projectPath: string, cloneId: string): Promise<unknown>
  restart(instanceId: string): Promise<unknown>
  kill(instanceId: string): Promise<unknown>
}

export interface ReconcilerDeps {
  store: Pick<WorldStore, 'getWorld' | 'setMainSignal' | 'setDesired'>
  channelFor(instanceId: string): FileChannel | null
  meta(instanceId: string): InstanceMeta | null
  process: ProcessHost
  applyStream(instanceId: string, res: string): void
  now?: () => number
  heartbeatMs?: number
  maxRetries?: number
}

interface InFlight {
  id: number
  deadline: number
  attempts: number
  sig: string
  gen: number
}

interface TransientFlight {
  id: number
  instanceId: string
  kind: CommandKind
  deadline: number
}

const TIMEOUTS: Record<CommandKind, number> = {
  loadScene: 30_000,
  play: 30_000,
  stop: 60_000,
  pause: 5_000,
  step: 5_000,
  recompile: 120_000,
  reload: 120_000,
  setHotReload: 5_000,
  hotReloadPatch: 10_000,
  exec: 300_000,
  flushLogs: 10_000,
  screenshot: 30_000,
  quit: 10_000
}

const DEFAULT_HEARTBEAT_MS = 500
const DEFAULT_MAX_RETRIES = 3

const NOT_READY: ReadonlySet<Lifecycle> = new Set<Lifecycle>(['init', 'launching', 'restarting', 'exited', 'error'])

function playingNow(inst: InstanceObserved): boolean {
  return inst.lifecycle === 'playing' || inst.lifecycle === 'entering-play'
}

export class Reconciler {
  private readonly deps: ReconcilerDeps
  private readonly now: () => number
  private readonly heartbeatMs: number
  private readonly maxRetries: number

  private readonly inflight = censusTrack('reconciler.inflight', new Map<string, InFlight>())
  private readonly transient = censusTrack('reconciler.transient', new Map<string, TransientFlight>())
  private readonly failed = censusTrack('reconciler.failed', new Map<string, string>())
  private readonly done = censusTrack('reconciler.done', new Map<string, string>())
  private readonly lastPrimaryCompile = censusTrack('reconciler.lastPrimaryCompile', new Map<string, CompileState>())
  private readonly streamSig = censusTrack('reconciler.streamSig', new Map<string, string>())
  private readonly restartReq = censusTrack('reconciler.restartReq', new Map<string, number>())
  private readonly restartApplied = censusTrack('reconciler.restartApplied', new Map<string, number>())

  private readonly heartbeats = censusTrack('reconciler.heartbeats', new Map<string, ReturnType<typeof setInterval>>())
  private readonly reconciling = censusTrack('reconciler.reconciling', new Set<string>())
  private readonly dirty = censusTrack('reconciler.dirty', new Set<string>())
  private readonly processBusy = censusTrack('reconciler.processBusy', new Set<string>())

  constructor(deps: ReconcilerDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES
  }

  track(projectPath: string): void {
    if (!this.heartbeats.has(projectPath)) {
      this.heartbeats.set(
        projectPath,
        setInterval(() => void this.reconcile(projectPath), this.heartbeatMs)
      )
    }
    void this.reconcile(projectPath)
  }

  untrack(projectPath: string): void {
    const t = this.heartbeats.get(projectPath)
    if (t) {
      clearInterval(t)
      this.heartbeats.delete(projectPath)
    }
  }

  kick(projectPath: string): void {
    void this.reconcile(projectPath)
  }

  issueTransient(instanceId: string, kind: CommandKind, args: Record<string, unknown>): number | null {
    const ch = this.deps.channelFor(instanceId)
    if (!ch) {
      this.deps.store.setMainSignal(instanceId, { reachable: false })
      return null
    }
    const cmd = ch.appendCommand({ target: instanceId, kind, args })
    this.transient.set(`${instanceId}|${kind}|${cmd.id}`, {
      id: cmd.id,
      instanceId,
      kind,
      deadline: this.now() + (TIMEOUTS[kind] ?? 30_000)
    })
    if (kind !== 'exec') debugLog(`[reconciler] → ${kind} ${instanceId} #${cmd.id} (transient)`)
    return cmd.id
  }

  issuedIdFor(instanceId: string, kind: CommandKind, minGen: number): number {
    const flight = this.inflight.get(`${instanceId}|${kind}`)
    if (!flight || flight.gen < minGen) return 0
    return flight.id
  }

  requestRestart(instanceId: string): void {
    this.restartReq.set(instanceId, (this.restartReq.get(instanceId) ?? 0) + 1)
    const meta = this.deps.meta(instanceId)
    if (meta) this.kick(meta.projectPath)
  }

  forgetInstance(instanceId: string): void {
    for (const key of [...this.inflight.keys()]) {
      if (key.startsWith(`${instanceId}|`)) this.inflight.delete(key)
    }
    for (const key of [...this.transient.keys()]) {
      if (key.startsWith(`${instanceId}|`)) this.transient.delete(key)
    }
    for (const key of [...this.failed.keys()]) {
      if (key.startsWith(`${instanceId}|`)) this.failed.delete(key)
    }
    for (const key of [...this.done.keys()]) {
      if (key.startsWith(`${instanceId}|`)) this.done.delete(key)
    }
    this.streamSig.delete(instanceId)
    this.lastPrimaryCompile.delete(instanceId)
    this.restartReq.delete(instanceId)
    this.restartApplied.delete(instanceId)
  }

  dispose(): void {
    for (const t of this.heartbeats.values()) clearInterval(t)
    this.heartbeats.clear()
    this.inflight.clear()
    this.transient.clear()
    this.failed.clear()
    this.done.clear()
    this.lastPrimaryCompile.clear()
    this.streamSig.clear()
    this.restartReq.clear()
    this.restartApplied.clear()
  }

  async reconcile(projectPath: string): Promise<void> {
    if (!this.heartbeats.has(projectPath)) return
    if (this.reconciling.has(projectPath)) {
      this.dirty.add(projectPath)
      return
    }
    this.reconciling.add(projectPath)
    try {
      const { observed, desired } = this.deps.store.getWorld(projectPath)
      if (!desired.stopped) this.reconcileEditorCommands(observed, desired)
      this.reconcileTransients()
      if (!desired.stopped) await this.reconcileProcesses(projectPath, observed, desired)
    } catch (e) {
      console.log(`[reconciler] reconcile ${projectPath} threw: ${(e as Error).message}`)
    } finally {
      this.reconciling.delete(projectPath)
      if (this.dirty.delete(projectPath)) queueMicrotask(() => void this.reconcile(projectPath))
    }
  }

  private reconcileTransients(): void {
    if (this.transient.size === 0) return
    const now = this.now()
    for (const [key, flight] of [...this.transient.entries()]) {
      const acks = this.deps.channelFor(flight.instanceId)?.readAcks()
      const status = acks?.acks.find((a) => a.id === flight.id)?.status
      if (status === 'applied' || status === 'error' || status === 'skipped') {
        if (status !== 'applied' || flight.kind !== 'exec') debugLog(`[reconciler] ${flight.kind} ${flight.instanceId} #${flight.id} ${status} (transient)`)
        this.transient.delete(key)
        continue
      }
      if (now >= flight.deadline) {
        debugLog(`[reconciler] ${flight.kind} ${flight.instanceId} #${flight.id} timed out (transient)`)
        this.transient.delete(key)
      }
    }
  }

  private reconcileEditorCommands(observed: WorldObserved, desired: WorldDesired): void {
    const instances = Object.values(observed.instances)
    const primary = instances.find((i) => i.role === 'primary')

    let targetGen = 0
    for (const d of Object.values(desired.instances)) if (d.refreshGen > targetGen) targetGen = d.refreshGen
    const primaryClean =
      !!primary && primary.compile === 'idle' && primary.lifecycle !== 'restarting' && primary.refreshGen >= targetGen
    const cloneTargetGen = primaryClean ? Math.max(targetGen, primary!.refreshGen) : 0
    const playActive = instances.some((i) => playingNow(i) || this.inflight.has(`${i.id}|play`))

    if (primary) {
      if (this.lastPrimaryCompile.get(primary.id) === 'error' && primary.compile === 'idle') {
        for (const inst of instances)
          if (inst.role === 'clone') {
            this.failed.delete(`${inst.id}|reload`)
            this.done.delete(`${inst.id}|reload`)
          }
      }
      this.lastPrimaryCompile.set(primary.id, primary.compile)
    }

    for (const inst of instances) {
      if (inst.lifecycle === 'error' || inst.lifecycle === 'exited') continue
      const id = inst.id
      const want = desired.instances[id] ?? defaultInstanceDesired(inst.role)
      const acks = this.deps.channelFor(id)?.readAcks()
      const ready = !NOT_READY.has(inst.lifecycle)

      this.ensureCommand(
        id,
        'loadScene',
        ready && want.scene !== '' && want.sceneGen > inst.sceneGen,
        {
          scene: want.scene,
          gen: want.sceneGen,
          ...(want.sceneGen > 0 && want.sceneForceGen === want.sceneGen ? { force: true } : {})
        },
        acks
      )

      const playPending = want.playGen > inst.playGen
      const otherEntering = instances.some((o) => o.id !== id && o.lifecycle === 'entering-play')
      const refreshSettled =
        inst.role === 'primary'
          ? inst.refreshGen >= targetGen
          : primaryClean && inst.refreshGen >= cloneTargetGen
      const playInFlight = this.inflight.has(`${id}|play`)
      this.ensureCommand(
        id,
        'play',
        ready && playPending && want.playing && inst.compile !== 'error' && !otherEntering && (refreshSettled || playInFlight),
        { gen: want.playGen },
        acks
      )
      this.ensureCommand(
        id,
        'stop',
        ready && playPending && !want.playing && inst.lifecycle !== 'exiting-play',
        { gen: want.playGen },
        acks
      )

      this.ensureCommand(
        id,
        'pause',
        ready && want.pauseGen > inst.pauseGen && !playPending,
        { enabled: want.paused, gen: want.pauseGen },
        acks
      )

      if (inst.role === 'primary') {
        this.ensureCommand(
          id,
          'recompile',
          inst.lifecycle === 'editmode' &&
            inst.compile !== 'compiling' &&
            inst.refreshGen < targetGen &&
            !playActive,
          { gen: targetGen },
          acks
        )
      } else {
        const clonePlaying = playingNow(inst) || this.inflight.has(`${id}|play`)
        const assetsBehind =
          primaryClean && !playActive && !!primary && inst.assetSeq < primary.assetSeq
        this.ensureCommand(
          id,
          'reload',
          ((primaryClean && inst.refreshGen < cloneTargetGen) || assetsBehind) && !clonePlaying,
          assetsBehind
            ? { gen: Math.max(cloneTargetGen, 1), assetSeq: primary!.assetSeq }
            : { gen: cloneTargetGen },
          acks
        )
      }

      this.ensureCommand(
        id,
        'setHotReload',
        ready && want.hotReload !== inst.hotReloadActive,
        { enabled: want.hotReload },
        acks
      )

      if (playingNow(inst)) {
        const explicit = desired.instances[id]
        const base = primary ? desired.instances[primary.id] : undefined
        const streamRes = explicit?.streamRes ?? base?.streamRes ?? want.streamRes
        if (this.streamSig.get(id) !== streamRes) {
          this.deps.applyStream(id, streamRes)
          this.streamSig.set(id, streamRes)
        }
      } else if (this.streamSig.has(id)) {
        this.streamSig.delete(id)
      }
    }
  }

  private ensureCommand(
    id: string,
    kind: CommandKind,
    want: boolean,
    args: Record<string, unknown>,
    acks: CommandAckFile | undefined
  ): void {
    const key = `${id}|${kind}`
    const flight = this.inflight.get(key)
    const now = this.now()
    const sig = JSON.stringify(args)

    if (!want) {
      if (flight) this.inflight.delete(key)
      this.failed.delete(key)
      this.done.delete(key)
      return
    }

    if (this.failed.get(key) === sig) return
    this.failed.delete(key)
    if (this.done.get(key) === sig) return
    this.done.delete(key)

    if (flight) {
      const status = acks?.acks.find((a) => a.id === flight.id)?.status

      if (status === 'applied' || status === 'skipped') {
        debugLog(`[reconciler] ${kind} ${id} #${flight.id} ${status}`)
        this.inflight.delete(key)
        this.done.set(key, flight.sig)
        return
      }
      if (status === 'error') {
        flight.attempts++
        if (flight.attempts > this.maxRetries) {
          this.inflight.delete(key)
          this.failed.set(key, sig)
          console.log(`[reconciler] ${kind} ${id} #${flight.id} errored ${flight.attempts}x — giving up (unreachable)`)
          this.deps.store.setMainSignal(id, { reachable: false })
          return
        }
        console.log(`[reconciler] ${kind} ${id} #${flight.id} errored — retry ${flight.attempts}/${this.maxRetries}`)
        this.inflight.delete(key)
      } else if (now < flight.deadline) {
        if (flight.sig === sig) return
      } else {
        flight.attempts++
        if (flight.attempts > this.maxRetries) {
          this.inflight.delete(key)
          this.failed.set(key, sig)
          console.log(`[reconciler] ${kind} ${id} #${flight.id} timed out ${flight.attempts}x — giving up (unreachable)`)
          this.deps.store.setMainSignal(id, { reachable: false })
          return
        }
        console.log(`[reconciler] ${kind} ${id} #${flight.id} deadline expired — retry ${flight.attempts}/${this.maxRetries}`)
        this.inflight.delete(key)
      }
    }

    const ch = this.deps.channelFor(id)
    if (!ch) {
      this.deps.store.setMainSignal(id, { reachable: false })
      return
    }
    const cmd: UnityCommand = ch.appendCommand({ target: id, kind, args })
    this.inflight.set(key, {
      id: cmd.id,
      deadline: now + (TIMEOUTS[kind] ?? 30_000),
      attempts: flight?.attempts ?? 0,
      sig,
      gen: typeof args.gen === 'number' ? args.gen : 0
    })
    debugLog(`[reconciler] → ${kind} ${id} #${cmd.id}${flight ? ' (reissue)' : ''} ${sig}`)
  }

  private async reconcileProcesses(
    projectPath: string,
    observed: WorldObserved,
    desired: WorldDesired
  ): Promise<void> {
    if (this.processBusy.has(projectPath)) return

    const all = Object.values(observed.instances)
    const instances = all.filter((i) => i.lifecycle !== 'exited')
    const primary = instances.find((i) => i.role === 'primary')

    for (const inst of instances) {
      if (desired.instances[inst.id]?.present === false) {
        this.runProcess(projectPath, () => this.deps.process.kill(inst.id))
        return
      }
    }

    for (const inst of all) {
      const req = this.restartReq.get(inst.id) ?? 0
      if (req > (this.restartApplied.get(inst.id) ?? 0)) {
        this.restartApplied.set(inst.id, req)
        this.runProcess(projectPath, () => this.deps.process.restart(inst.id))
        return
      }
    }

    const clones = instances.filter((i) => i.role === 'clone').sort((a, b) => a.playerIndex - b.playerIndex)
    const wantClones = Math.max(0, desired.playerCount - 1)
    const primaryReady = !!primary && !NOT_READY.has(primary.lifecycle)
    const playActive = instances.some(
      (i) => playingNow(i) || i.lifecycle === 'exiting-play' || this.inflight.has(`${i.id}|play`)
    )

    if (clones.length < wantClones && primaryReady && !playActive) {
      this.runProcess(projectPath, () => this.deps.process.addClone(projectPath))
      return
    }
    if (clones.length > wantClones) {
      const extra = clones.find((c) => c.playerIndex >= desired.playerCount) ?? clones[clones.length - 1]
      const cloneId = this.deps.meta(extra.id)?.cloneId
      if (cloneId) {
        this.runProcess(projectPath, () => this.deps.process.removeClone(projectPath, cloneId))
        return
      }
    }
  }

  private runProcess(projectPath: string, fn: () => Promise<unknown>): void {
    this.processBusy.add(projectPath)
    void fn()
      .catch((e) => console.log(`[reconciler] process op ${projectPath} failed: ${(e as Error).message}`))
      .finally(() => {
        this.processBusy.delete(projectPath)
        setTimeout(() => this.kick(projectPath), this.heartbeatMs)
      })
  }
}
