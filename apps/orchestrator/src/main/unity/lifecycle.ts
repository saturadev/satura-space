import { app } from 'electron'
import type { HubState } from '@shared/api'
import {
  BUSY_PHASES,
  GATE_PHASES,
  START_PREPARE_DEADLINE_MS,
  composeLifecycle,
  failActions,
  sameLifecycle,
  dialogText,
  stateLabel,
  stateWhy,
  type EditorInstanceFacts,
  type EditorVersionFacts,
  type LifecycleFacts,
  type UnityFailCode,
  type UnityLifecycle,
  type UnityStateTransition
} from '@shared/unity/lifecycle'
import { censusTrack } from '@shared/census'

interface ProjectFacts {
  stopped: boolean
  closing: boolean
  wanted: boolean
  relaunch: boolean
  launching: boolean
  launches: number
  refusal: string
  refusalCode: UnityFailCode
  failure: string
  failureCode: UnityFailCode
}

export interface LifecycleSource {
  version(project: string): EditorVersionFacts
  hub(): Promise<HubState>
  hubError(state: HubState): string
  instance(project: string): EditorInstanceFacts | null
  project(project: string): ProjectFacts
}

type Listener = (l: UnityLifecycle, prev: UnityLifecycle | null) => void

interface Entry {
  record: UnityLifecycle
  version: EditorVersionFacts
  versionAt: number
  composed: string
  composedSince: number
}

const HISTORY_MAX = 60

function prepareDeadlineMs(): number {
  const dev = app.isPackaged ? 0 : Number(process.env.SATURA_DEV_START_PREPARE_MS)
  return dev > 0 ? dev : START_PREPARE_DEADLINE_MS
}

const POLL_MS = 1000
const VERSION_TTL_MS = 900
const VERSION_TTL_ALIVE_MS = 10_000
const HUB_TTL_MS = 1500

const BOOT = `${Date.now().toString(36)}-${process.pid}`

const NO_VERSION: EditorVersionFacts = { version: '', revision: '', installed: true, editors: [], install: null }

class UnityLifecycleStore {
  private readonly entries = censusTrack('unity-lifecycle.entries', new Map<string, Entry>())
  private readonly watchers = censusTrack('unity-lifecycle.watchers', new Map<string, Map<number, number>>())
  private readonly waiters = censusTrack('unity-lifecycle.waiters', new Map<string, number>())
  private readonly listeners = new Set<Listener>()
  private readonly histories = censusTrack('unity-lifecycle.histories', new Map<string, UnityStateTransition[]>())
  private readonly causes = censusTrack('unity-lifecycle.causes', new Map<string, string>())
  private source: LifecycleSource | null = null
  private resume: ((project: string) => void) | null = null
  private hub: HubState = 'ready'
  private hubAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private ticking = false

  constructor(
    private readonly now: () => number = Date.now,
    private readonly pollMs = POLL_MS
  ) {}

  setSource(source: LifecycleSource | null): void {
    this.source = source
  }

  setResume(cb: ((project: string) => void) | null): void {
    this.resume = cb
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  noteHub(state: HubState): void {
    this.hub = state
    this.hubAt = this.now()
  }

  get(project: string): UnityLifecycle {
    return this.refresh(project)
  }

  peek(project: string): UnityLifecycle | null {
    return this.entries.get(project)?.record ?? null
  }

  projects(): string[] {
    return [...this.entries.keys()]
  }

  cause(project: string, why: string | null): void {
    if (why) this.causes.set(project, why)
    this.refresh(project)
    if (!why) this.causes.delete(project)
  }

  history(project: string): UnityStateTransition[] {
    return [...(this.histories.get(project) ?? [])]
  }

  private noteTransition(project: string, prev: UnityLifecycle | null, record: UnityLifecycle, at: number): void {
    const from = prev ? stateLabel(prev) : 'new'
    const to = stateLabel(record)
    if (from === to) return
    const why = this.causes.get(project) ?? stateWhy(record)
    console.log(`[unity] state ${from} -> ${to} (${why}) ${project}`)
    const list = this.histories.get(project) ?? []
    list.push({ at, seq: record.seq, from, to, why })
    if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX)
    this.histories.set(project, list)
  }

  private noteDialog(project: string, prev: UnityLifecycle | null, record: UnityLifecycle): void {
    if ((prev?.dialog?.id ?? '') === (record.dialog?.id ?? '')) return
    if (prev?.dialog) console.log(`[unity] dialog '${prev.dialog.title || 'untitled'}' closed ${project}`)
    if (record.dialog) console.log(`[unity] dialog ${dialogText(record.dialog)} waits for an answer ${project}`)
  }

  watch(project: string, wcId: number): UnityLifecycle {
    let m = this.watchers.get(project)
    if (!m) {
      m = new Map()
      this.watchers.set(project, m)
    }
    m.set(wcId, (m.get(wcId) ?? 0) + 1)
    const rec = this.refresh(project, true)
    this.schedule()
    return rec
  }

  unwatch(project: string, wcId: number): void {
    const m = this.watchers.get(project)
    if (!m) return
    const n = (m.get(wcId) ?? 0) - 1
    if (n > 0) m.set(wcId, n)
    else m.delete(wcId)
    if (m.size === 0) this.watchers.delete(project)
  }

  unwatchAll(wcId: number): void {
    for (const [project, m] of [...this.watchers]) {
      m.delete(wcId)
      if (m.size === 0) this.watchers.delete(project)
    }
  }

  refresh(project: string, probeVersion = false): UnityLifecycle {
    const prev = this.entries.get(project)
    const now = this.now()
    const src = this.source
    const instance = src?.instance(project) ?? null
    const alive = !!instance && !instance.exited
    const ttl = alive ? VERSION_TTL_ALIVE_MS : VERSION_TTL_MS
    const version =
      !src ? NO_VERSION : !probeVersion && prev && now - prev.versionAt < ttl ? prev.version : src.version(project)
    const versionAt = prev && version === prev.version ? prev.versionAt : now
    const p = src?.project(project) ?? { stopped: false, closing: false, wanted: false, relaunch: false, launching: false, launches: 0, refusal: '', refusalCode: '', failure: '', failureCode: '' }
    const facts: LifecycleFacts = {
      version,
      hub: this.hub,
      hubError: src?.hubError(this.hub) ?? '',
      stopped: p.stopped,
      closing: p.closing,
      wanted: p.wanted,
      relaunch: p.relaunch,
      launching: p.launching,
      launches: p.launches,
      refusal: p.refusal,
      refusalCode: p.refusalCode,
      failure: p.failure,
      failureCode: p.failureCode,
      instance
    }
    const raw = composeLifecycle(facts)
    const composed = stateLabel(raw)
    const composedSince = prev && prev.composed === composed ? prev.composedSince : now
    const view =
      raw.state === 'starting' && raw.stage === 'preparing' && now - composedSince >= prepareDeadlineMs()
        ? {
            ...raw,
            phase: 'failed' as const,
            state: 'failed' as const,
            stage: '' as const,
            code: 'timeout' as const,
            actions: failActions('timeout'),
            error: `Satura Space spent over ${Math.round(prepareDeadlineMs() / 1000)} s preparing the project and Unity still hasn't started.`,
            next: 'Retry, or check the app log for what the start is waiting on.'
          }
        : raw
    if (prev && sameLifecycle(prev.record, view)) {
      prev.version = version
      prev.versionAt = versionAt
      prev.composed = composed
      prev.composedSince = composedSince
      this.maybeSchedule(prev.record)
      return prev.record
    }
    const record: UnityLifecycle = {
      ...view,
      project,
      boot: BOOT,
      seq: (prev?.record.seq ?? 0) + 1,
      since: prev && prev.record.phase === view.phase ? prev.record.since : now,
      stateSince: prev && stateLabel(prev.record) === stateLabel(view) ? (prev.record.stateSince ?? prev.record.since) : now
    }
    this.entries.set(project, { record, version, versionAt, composed, composedSince })
    this.noteTransition(project, prev?.record ?? null, record, now)
    this.noteDialog(project, prev?.record ?? null, record)
    for (const cb of this.listeners) {
      try {
        cb(record, prev?.record ?? null)
      } catch (e) {
        console.log(`[unity-lifecycle] listener threw: ${(e as Error).message}`)
      }
    }
    if (prev && GATE_PHASES.has(prev.record.phase) && !GATE_PHASES.has(record.phase) && record.waiting) {
      console.log(`[unity-lifecycle] ${project}: ${prev.record.phase} cleared, starting the editor that was waiting`)
      try {
        this.resume?.(project)
      } catch (e) {
        console.log(`[unity-lifecycle] resume threw: ${(e as Error).message}`)
      }
    }
    this.maybeSchedule(record)
    return record
  }

  next(project: string, afterSeq: number, timeoutMs: number, signal?: AbortSignal): Promise<UnityLifecycle> {
    const cur = this.refresh(project)
    if (cur.seq > afterSeq || signal?.aborted) return Promise.resolve(cur)
    this.waiters.set(project, (this.waiters.get(project) ?? 0) + 1)
    this.schedule()
    return new Promise((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        off()
        signal?.removeEventListener('abort', finish)
        const n = (this.waiters.get(project) ?? 1) - 1
        if (n > 0) this.waiters.set(project, n)
        else this.waiters.delete(project)
        resolve(this.peek(project) ?? cur)
      }
      const off = this.onChange((l) => {
        if (l.project === project && l.seq > afterSeq) finish()
      })
      const timer = setTimeout(finish, Math.max(0, timeoutMs))
      signal?.addEventListener('abort', finish, { once: true })
    })
  }

  private active(project: string, r: UnityLifecycle): boolean {
    if (this.waiters.has(project) || this.watchers.has(project)) return true
    return r.waiting || BUSY_PHASES.has(r.phase)
  }

  private maybeSchedule(r: UnityLifecycle): void {
    if (this.active(r.project, r)) this.schedule()
  }

  private schedule(): void {
    if (this.timer || !this.source) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, this.pollMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  async tick(): Promise<void> {
    if (this.ticking || !this.source) return
    this.ticking = true
    try {
      const projects = new Set<string>([...this.watchers.keys(), ...this.waiters.keys()])
      for (const [project, e] of this.entries) if (this.active(project, e.record)) projects.add(project)
      if (projects.size === 0) return
      const needHub = [...projects].some((p) => {
        const r = this.entries.get(p)?.record
        return !r || r.phase === 'hub' || (r.waiting && !r.booted) || this.watchers.has(p)
      })
      if (needHub && this.now() - this.hubAt >= HUB_TTL_MS) {
        try {
          this.noteHub(await this.source.hub())
        } catch {
        }
      }
      for (const project of projects) {
        const r = this.entries.get(project)?.record
        this.refresh(project, !r || !r.booted || GATE_PHASES.has(r.phase))
      }
    } finally {
      this.ticking = false
      const any = [...this.watchers.keys(), ...this.waiters.keys()].length > 0 || [...this.entries].some(([p, e]) => this.active(p, e.record))
      if (any) this.schedule()
    }
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.entries.clear()
    this.histories.clear()
    this.watchers.clear()
    this.waiters.clear()
  }
}

export const unityLifecycle = new UnityLifecycleStore()
