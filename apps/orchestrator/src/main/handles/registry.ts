import { app } from 'electron'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  handleMatches,
  withDefaults,
  type HandleInfo,
  type HandleParams,
  type HandleResult,
  type RendererHandleReply
} from '@shared/app-handles'
import { rendererCall } from '../agent-exec'
import { linesSince, logCursor, type LogCursor } from '../satura-exec/logs'
import { censusTrack } from '@shared/census'
import { TEST_PROJECT } from '../../../scripts/test-project.mjs'

export { TEST_PROJECT }

export class BlockedError extends Error {
  constructor(message: string, readonly dialogs: unknown[]) {
    super(message)
    this.name = 'BlockedError'
  }
}

export interface HandleCtx {
  window: number | null
  workspace: string | null
  projectRoot: string
  paneKey: string
  owner: string
  signal: AbortSignal
  answered: string[]
  log(line: string): void
  renderer(name: string, params?: HandleParams, timeoutMs?: number): Promise<unknown>
  writableProject(): string
}

export interface MainHandle {
  name: string
  description: string
  side: 'main'
  params: HandleParams
  long?: boolean
  agentOnly?: boolean
  released?: boolean
  run(params: HandleParams, ctx: HandleCtx): Promise<unknown>
}

export interface CallCtx {
  window: number | null
  workspace: string | null
  projectRoot: string
  paneKey: string
  run?: number
  origin?: string
}

const AGENT_ONLY = 'only runs from an agent\'s satura_exec or the satura.mjs CLI, not from a report or dashboard action or the phone.'

interface Run {
  id: number
  handle: string
  started: number
  ended: number
  status: HandleResult['status']
  value?: unknown
  error?: string
  cursor: LogCursor
  answered: string[]
  abort: AbortController
  done: Promise<void>
}

const MAX_LOG_LINES = 200
const MAX_RUNS = 50
const DEFAULT_WAIT_S = 30
const RENDERER_MS = 60_000

const handles = new Map<string, MainHandle>()
const runs = new Map<number, Run>()
censusTrack('handles.runs', runs)
let nextRun = 1

export function defineHandle(handle: MainHandle): MainHandle {
  if (!app.isPackaged || handle.released) handles.set(handle.name, handle)
  return handle
}

function comparable(p: string): string {
  try {
    return realpathSync(resolve(p))
  } catch {
    return resolve(p)
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal?.aborted) return done()
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      done()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

export async function waitUntil<T>(
  what: string,
  read: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  timeoutMs: number,
  signal: AbortSignal,
  pollMs = 500
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (signal.aborted) throw new Error(`Stopped while waiting for ${what}.`)
    if (Date.now() >= deadline) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}.`)
    await sleep(pollMs, signal)
  }
}

function markOf(cursor: LogCursor): string {
  return `m${cursor.main}.c${cursor.console}.w${cursor.window ?? 'x'}`
}

export function parseMark(mark: unknown): LogCursor | null {
  const m = /^m(\d+)\.c(\d+)\.w(\d+|x)$/.exec(typeof mark === 'string' ? mark.trim() : '')
  if (!m) return null
  return { main: Number(m[1]), console: Number(m[2]), window: m[3] === 'x' ? null : Number(m[3]) }
}

export function currentMark(window: number | null): string {
  return markOf(logCursor(window))
}

function messageCore(line: string): string {
  return line.replace(/^\[[^\]]*\]\s*/, '').replace(/\s*\([^()]*:\d+\)$/, '')
}

const NOISE = /^\[shared-surface\] imported /

function callLogs(cursor: LogCursor): string[] {
  const since = linesSince(cursor)
  const main = since.main.filter((l) => !NOISE.test(l))
  const console = since.console
  const mirrored = new Set(main.filter((l) => /^\[w\d+:/.test(l)).map(messageCore))
  const all = [...main, ...console.filter((l) => !mirrored.has(messageCore(l))).map((l) => `[window] ${l}`)]
  return all.length > MAX_LOG_LINES ? [`… ${all.length - MAX_LOG_LINES} earlier lines cut`, ...all.slice(-MAX_LOG_LINES)] : all
}

async function rendererHandle(ctx: CallCtx, name: string, params: HandleParams, timeoutMs = RENDERER_MS): Promise<unknown> {
  if (ctx.window === null) throw new Error('No Satura Space window is open, so there is no page for this handle.')
  const reply = (await rendererCall(
    ctx.window,
    { kind: 'handle', payload: { name, params, workspaceId: ctx.workspace, projectRoot: ctx.projectRoot } },
    timeoutMs
  )) as RendererHandleReply | { error?: string } | null
  if (!reply) throw new Error(`The window did not answer ${name} within ${Math.round(timeoutMs / 1000)}s.`)
  if ('ok' in reply) {
    if (reply.ok) return reply.value
    throw new Error(reply.error)
  }
  throw new Error(reply.error ?? `${name} failed in the window.`)
}

function contextFor(base: CallCtx, name: string, abort: AbortController, answered: string[]): HandleCtx {
  return {
    ...base,
    owner: base.run ? `run ${base.run}` : 'kept',
    signal: abort.signal,
    answered,
    log: (line) => console.log(`[handle] ${name}: ${line}`),
    renderer: (n, params = {}, timeoutMs) => rendererHandle(base, n, params, timeoutMs),
    writableProject: () => {
      const want = comparable(base.projectRoot || TEST_PROJECT)
      if (want !== comparable(TEST_PROJECT))
        throw new Error(`${name} writes files, so it only runs on ${TEST_PROJECT}. This call targets ${base.projectRoot || 'no project'}.`)
      return want
    }
  }
}

function resultOf(run: Run): HandleResult {
  const end = run.ended || Date.now()
  return {
    handle: run.handle,
    status: run.status,
    ...(run.value !== undefined ? { value: run.value } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.status === 'running' ? { run: run.id } : {}),
    ...(run.answered.length ? { dialogs: run.answered } : {}),
    logs: callLogs(run.cursor),
    ms: end - run.started,
    mark: currentMark(run.cursor.window)
  }
}

function prune(): void {
  if (runs.size <= MAX_RUNS) return
  for (const [id, run] of runs) {
    if (runs.size <= MAX_RUNS) break
    if (run.status !== 'running') runs.delete(id)
  }
}

function waitFor(run: Run, seconds: number): Promise<void> {
  if (run.status !== 'running' || seconds <= 0) return Promise.resolve()
  const stop = new AbortController()
  return Promise.race([run.done, sleep(seconds * 1000, stop.signal)]).finally(() => stop.abort())
}

function waitSeconds(raw: unknown): number {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 3600) : DEFAULT_WAIT_S
}

async function rendererList(ctx: CallCtx): Promise<HandleInfo[]> {
  if (ctx.window === null) return []
  const list = await rendererCall(ctx.window, { kind: 'handles' }).catch(() => null)
  return Array.isArray(list) ? (list as HandleInfo[]) : []
}

export async function listHandles(filter: string, ctx: CallCtx): Promise<HandleInfo[]> {
  const main: HandleInfo[] = [...handles.values()].filter((h) => !app.isPackaged || h.released).map((h) => ({
    name: h.name,
    description: h.description,
    side: 'main',
    params: h.params,
    ...(h.long ? { long: true } : {}),
    ...(h.agentOnly ? { agentOnly: true } : {})
  }))
  const theirs = await rendererList(ctx)
  const all = [...main, ...(app.isPackaged ? theirs.filter((h) => h.released) : theirs)]
  return all.filter((h) => handleMatches(h, filter)).sort((a, b) => a.name.localeCompare(b.name))
}

export async function callHandle(name: string, rawParams: unknown, ctx: CallCtx, wait?: unknown): Promise<HandleResult> {
  const started = Date.now()
  const cursor = logCursor(ctx.window)
  const fail = (error: string): HandleResult => ({ handle: name, status: 'error', error, logs: callLogs(cursor), ms: Date.now() - started, mark: currentMark(ctx.window) })
  const handle = handles.get(name)
  const devOnly = `${name} exists only in dev builds. app.handles() lists the ones this build has.`
  if (app.isPackaged && handle && !handle.released) return fail(devOnly)
  if (!handle) {
    const theirs = (await rendererList(ctx)).find((h) => h.name === name)
    if (theirs && app.isPackaged && !theirs.released) return fail(devOnly)
    if (!theirs) return fail(app.isPackaged ? devOnly : `There is no handle ${name}. app.handles() lists them.`)
    if (theirs.agentOnly && ctx.origin === 'report') return fail(`${name} ${AGENT_ONLY}`)
    try {
      const value = await rendererHandle(ctx, name, withDefaults(theirs.params, rawParams))
      return { handle: name, status: 'done', value, logs: callLogs(cursor), ms: Date.now() - started, mark: currentMark(ctx.window) }
    } catch (e) {
      return fail((e as Error)?.message ?? String(e))
    }
  }
  if (handle.agentOnly && ctx.origin === 'report') return fail(`${name} ${AGENT_ONLY}`)
  const abort = new AbortController()
  const run: Run = { id: nextRun++, handle: name, started, ended: 0, status: 'running', cursor, answered: [], abort, done: Promise.resolve() }
  const params = withDefaults(handle.params, rawParams)
  console.log(`[handle] ${name} run ${run.id} ${JSON.stringify(params).slice(0, 300)}`)
  run.done = handle.run(params, contextFor(ctx, name, abort, run.answered)).then(
    (value) => {
      run.value = value
      run.status = abort.signal.aborted ? 'stopped' : 'done'
    },
    (e: unknown) => {
      run.error = (e as Error)?.message ?? String(e)
      if (e instanceof BlockedError) {
        run.value = { dialogs: e.dialogs }
        run.status = 'blocked'
      } else run.status = abort.signal.aborted ? 'stopped' : 'error'
    }
  ).finally(() => {
    run.ended = Date.now()
    console.log(`[handle] ${name} run ${run.id} ${run.status} in ${run.ended - run.started}ms${run.error ? `: ${run.error.split('\n')[0]}` : ''}`)
  })
  runs.set(run.id, run)
  prune()
  if (handle.long) await waitFor(run, waitSeconds(wait))
  else await run.done
  return resultOf(run)
}

export async function handleResult(id: unknown, wait?: unknown): Promise<HandleResult> {
  const run = runs.get(Number(id))
  if (!run) return { handle: '', status: 'error', error: `There is no run ${String(id)}. Runs are lost when the app restarts.`, logs: [], ms: 0 }
  await waitFor(run, wait === undefined ? 0 : waitSeconds(wait))
  return resultOf(run)
}

export async function stopHandle(id: unknown): Promise<HandleResult> {
  const run = runs.get(Number(id))
  if (!run) return { handle: '', status: 'error', error: `There is no run ${String(id)}.`, logs: [], ms: 0 }
  if (run.status === 'running') {
    run.abort.abort()
    const stop = new AbortController()
    await Promise.race([run.done, sleep(15_000, stop.signal)]).finally(() => stop.abort())
  }
  return resultOf(run)
}
