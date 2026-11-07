import { BUSY_PHASES, lifecycleText, relaunchStep, type UnityLifecycle, type UnityPhase } from '@shared/unity/lifecycle'

export interface RelaunchDeps {
  relaunch(project: string): Promise<{ ok: boolean; error?: string; note?: string; pending?: boolean }>
  lifecycle(project: string): UnityLifecycle
  next(project: string, afterSeq: number, ms: number, signal?: AbortSignal): Promise<UnityLifecycle>
  dialogs?(project: string, signal: AbortSignal): Promise<string | null>
  settle?(project: string): void
  now?(): number
  log?(line: string): void
}

export interface RelaunchOutcome {
  ok: boolean
  name: string
  message: string
  life: UnityLifecycle
}

const TICK_MS = 1000
const IDLE_GRACE_MS = 15_000
const HOLD_GRACE_MS = 45_000
const STALL_GRACE_MS = 60_000

export async function relaunchAndWait(deps: RelaunchDeps, project: string, timeoutMs: number, signal: AbortSignal = new AbortController().signal): Promise<RelaunchOutcome> {
  try {
    return await follow(deps, project, timeoutMs, signal)
  } finally {
    deps.settle?.(project)
  }
}

async function follow(deps: RelaunchDeps, project: string, timeoutMs: number, signal: AbortSignal): Promise<RelaunchOutcome> {
  const now = deps.now ?? Date.now
  const before = deps.lifecycle(project)
  const startedAt = now()
  const deadline = startedAt + Math.max(0, timeoutMs)
  const r = await deps.relaunch(project)
  let life = deps.lifecycle(project)
  if (!r.ok) return { ok: false, name: 'UnityError', message: `RELAUNCH FAILED: ${r.error ?? 'unknown'}\n  ${lifecycleText(life)}`, life }
  if (r.note) deps.log?.(r.note)
  let shown = ''
  let idleSince: number | null = null
  let stallSince: number | null = null
  for (;;) {
    const t = now()
    const mark = `${life.phase}|${life.error}|${life.install?.state ?? ''}|${Math.floor((life.install?.pct ?? -10) / 10)}`
    if (mark !== shown) {
      shown = mark
      deps.log?.(lifecycleText(life).split('\n')[0])
    }
    const step = relaunchStep(life, before)
    if (step === 'done') {
      const said = r.pending ? `It waited for Unity ${life.version} to be installed first.` : (r.note ?? '')
      return { ok: true, name: '', message: `${lifecycleText(life)}${said ? `\n  ${said}` : ''}`, life }
    }
    if (step === 'fail') return { ok: false, name: 'UnityError', message: `RELAUNCH FAILED: ${lifecycleText(life)}`, life }
    if (signal.aborted) return { ok: false, name: 'AbortedError', message: 'The call was cancelled.', life }
    if (deps.dialogs && BUSY_PHASES.has(life.phase)) {
      const blocked = await deps.dialogs(life.project, signal)
      if (blocked) return { ok: false, name: 'DialogBlocked', message: `BLOCKED BY DIALOG: ${blocked}`, life }
    }
    if (life.phase === 'idle') {
      idleSince ??= t
      if (t - idleSince >= IDLE_GRACE_MS) return { ok: false, name: 'UnityError', message: `RELAUNCH FAILED: the relaunch didn't start an editor.\n  ${lifecycleText(life)}`, life }
    } else idleSince = null
    if (life.phase === 'ready' && life.gen === before.gen && t - startedAt >= HOLD_GRACE_MS)
      return { ok: false, name: 'UnityError', message: `RELAUNCH FAILED: the old editor (pid ${life.pid ?? '?'}) is still running and no new one started.\n  ${lifecycleText(life)}`, life }
    if (life.stall && BUSY_PHASES.has(life.phase)) {
      stallSince ??= t
      if (t - stallSince >= STALL_GRACE_MS)
        return { ok: false, name: 'UnityError', message: `RELAUNCH FAILED: Unity showed no progress while ${life.phase}. ${lifecycleText(life)}\n  Check unity.logs({ source: 'editor' }). If it stays stuck, unity.relaunch() again, or ask the user.`, life }
    } else stallSince = null
    if (t >= deadline)
      return {
        ok: false,
        name: 'UnityTimeout',
        message: `TIMEOUT: Unity is still ${life.phase} after ${Math.round(timeoutMs / 1000)} s, so unity.relaunch() stopped waiting.\n  ${lifecycleText(life)}`,
        life
      }
    life = await deps.next(life.project, life.seq, Math.min(TICK_MS, deadline - t), signal)
  }
}

export interface LifecycleCallDeps extends RelaunchDeps {
  manages(project: string): boolean
}

const DETAIL_PHASES: ReadonlySet<UnityPhase> = new Set<UnityPhase>(['idle', 'stopped', 'refused', 'failed'])
const DEFAULT_RELAUNCH_S = 180
export const MAX_RELAUNCH_S = 3600

function named(message: string, name: string): Error {
  const e = new Error(message)
  e.name = name
  return e
}

function relaunchSeconds(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_RELAUNCH_S
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw named(`unity.relaunch(): timeout is a number of seconds, got ${JSON.stringify(raw)}`, 'TypeError')
  return Math.min(Math.ceil(n), MAX_RELAUNCH_S)
}

export function lifecycleCall(deps: LifecycleCallDeps): (params: Record<string, unknown>, projectRoot: string, signal?: AbortSignal) => Promise<unknown> {
  return async (params, projectRoot, signal) => {
    const path = typeof params.path === 'string' && params.path.trim() ? params.path.trim() : projectRoot
    const op = String(params.op ?? '')
    if (!path || !deps.manages(path)) return { managed: false, delegate: true }
    if (op === 'status') {
      const life = deps.lifecycle(path)
      return { managed: true, up: life.booted || DETAIL_PHASES.has(life.phase), text: lifecycleText(life), lifecycle: life }
    }
    if (op === 'relaunch') {
      const secs = relaunchSeconds(params.timeout)
      const out = await relaunchAndWait(deps, path, secs * 1000, signal)
      if (!out.ok) throw named(out.message, out.name)
      const note = Number(params.timeout) > MAX_RELAUNCH_S ? `timeout is capped at ${MAX_RELAUNCH_S} s.` : ''
      return { managed: true, text: out.message, up: out.life.booted, lifecycle: out.life, ...(note ? { note } : {}) }
    }
    throw named(`Unknown unity call ${op}.`, 'TypeError')
  }
}
