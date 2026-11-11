import {
  MAX_LOG_CHARS,
  cutResult,
  MAX_SCRIPT_CHARS,
  MAX_SHOTS,
  clampTimeoutSeconds,
  cleanPaneKey,
  type SaturaExecReply,
  type SaturaExecRequest,
  type ScriptFailure,
  type ScriptLog,
  type ScriptShot,
  type ScriptStep,
  type ExecPeer
} from '@shared/satura-exec'
import type { SandboxMessage } from './sandbox/vm'
import type { Shot } from './driver'
import { DriftBudget, claimScope, releaseScopes } from './drift-rules'
import { censusTrack } from '@shared/census'

export interface ScriptHost {
  onMessage(listener: (msg: SandboxMessage) => void): void
  onExit(listener: (error?: Error) => void): void
  send(msg: { t: 'reply'; json: string }): void
  terminate(): void
}

interface DriverLike {
  pausedMs(): number
  readonly paused: boolean
  start(): Promise<void>
  frameAction(action: string, selector: string, options: Record<string, unknown>): Promise<unknown>
  evaluate(options: Record<string, unknown>): Promise<unknown>
  input(device: string, action: string, options: Record<string, unknown>): Promise<void>
  screenshot(selector: string | null, options: Record<string, unknown>): Promise<Shot>
  snapshot(selector: string | null, options: Record<string, unknown>): Promise<string>
  say(text: string, options: Record<string, unknown>): Promise<string>
  tunerReady(options: Record<string, unknown>): Promise<string | null>
  note(text: string): void
  report(): string
  point(target: Record<string, unknown>, text: string, options: Record<string, unknown>): Promise<{ shown: boolean; text: string }>
  driftClock(step: boolean): Promise<boolean>
  driftAdvance(ms: number): Promise<number>
  ask(target: Record<string, unknown> | null, text: string, buttons: string[]): Promise<string | null>
  hold(ms: number): Promise<void>
  front(what: string, why: string): Promise<void>
  trace(line: string): void
  aimFree?(quietMs: number): boolean
  dispose(failed?: boolean): Promise<void>
}

export interface WindowInfo {
  id: number
  title: string
  focused: boolean
  visible: boolean
}

export interface CallerInfo {
  window: number | null
  name: string
  workspace?: string | null
  error?: string
}

export interface DriverSetup {
  name: string
  signal: AbortSignal
  log: (line: string) => void
  workspace: string
  budget: DriftBudget
  run: number
  drift: boolean
  autoFront: boolean
}

interface RunnerDeps {
  spawnHost(code: string, init: string): ScriptHost
  caller(paneKey: string, projectRoot: string): Promise<CallerInfo>
  windows(): WindowInfo[]
  driver(window: number, options: DriverSetup): DriverLike
  agents(command: string, args: Record<string, unknown>, paneKey: string, projectRoot: string): Promise<Record<string, unknown>>
  logs(source: string, options: Record<string, unknown>, ctx: { window: number | null; projectRoot: string }): Promise<string>
  tuner(args: Record<string, unknown>, ctx: { window: number; projectRoot: string; paneKey: string; workspace: string | null }): Promise<unknown>
  layout(args: Record<string, unknown>, ctx: { window: number; paneKey: string; workspace: string | null }): Promise<unknown>
  tabs?(args: Record<string, unknown>, ctx: { window: number | null; paneKey: string; workspace: string | null }): Promise<unknown>
  video(args: Record<string, unknown>, ctx: { window: number; projectRoot: string; paneKey: string }): Promise<unknown>
  report(args: Record<string, unknown>, ctx: { window: number; projectRoot: string; paneKey: string }): Promise<unknown>
  dashboard?(args: Record<string, unknown>, ctx: { window: number; projectRoot: string; paneKey: string }): Promise<unknown>
  handles(args: Record<string, unknown>, ctx: { window: number | null; workspace: string | null; projectRoot: string; paneKey: string; caller: string; run: number; origin: string }): Promise<unknown>
  runEnded?(run: number): void
  unityMode?(args: Record<string, unknown>, projectRoot: string): Promise<unknown>
  unity?(args: Record<string, unknown>, projectRoot: string, signal: AbortSignal): Promise<unknown>
  plugins?(): Record<string, string[]>
  plugin?(args: Record<string, unknown>, ctx: { window: number | null; projectRoot: string; signal: AbortSignal }): Promise<unknown>
  requireGraphics?(call: string, path: string): void
  log(line: string): void
  now(): number
  exclusive?: boolean
}

const OLD_CLIENT =
  'This version of Satura Space replaced satura_orchestrator_exec with satura_exec. Restart the agent so it loads the new tool.'
const UNKNOWN_PANE =
  "Satura Space has no terminal with this call's SATURA_PANE_KEY. Run the agent in a terminal tab of the Satura Space app that's running now."
const BUSY =
  'Another satura_exec script is driving this workspace right now. Wait for it to finish, then retry. Scripts in other workspaces can run at the same time.'
const NO_WINDOW =
  "This call isn't tied to a Satura Space window, so there is no page to drive. Run the agent in a Satura Space terminal tab, or pick one with app.windows()."
const AIM_QUIET_MS = 2000
const ASK_NEEDS_DRIFT = 'ask() needs drift: true: Drift only appears when the user asked you to show or explain something'
const MAX_LOG_LINES = 1000
const CLEANUP_MS = 8000
const NO_PEER =
  'Unity calls need the satura_exec MCP tool of an agent: this script came from somewhere else, like a report button, so only the app API works here.'

const busyScopes = new Map<number, Map<string, number>>()
censusTrack('runner.busyScopes', busyScopes)
let nextRun = 1

function errorOf(e: unknown): { name: string; message: string } {
  const error = e as Error
  return { name: error?.name || 'Error', message: error?.message || String(e) }
}

const SHOTS_CUT = `A script can return at most ${MAX_SHOTS} images; the rest were left out.`

const UNSAVED_NOTE = / has unsaved changes\. The user saves them/

function dropUnsaved(notes: string[]): void {
  for (let i = notes.length - 1; i >= 0; i--) if (UNSAVED_NOTE.test(notes[i])) notes.splice(i, 1)
}

function named(message: string, name: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, Math.max(0, Math.min(ms, 2_147_483_647)))
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

function whoOf(req: SaturaExecRequest, fallback: string): string {
  const raw = typeof req.caller === 'string' ? req.caller.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
  return raw || fallback
}

function whatOf(code: unknown): string {
  const text = typeof code === 'string' ? code : ''
  const handle = /app\.(handle|result|stop|handles)\(\s*("[^"]*"|\d+)?/.exec(text)
  if (handle) return handle[2] ? `${handle[1]} ${handle[2].replace(/"/g, '')}` : handle[1]
  return `a script (${text.replace(/\s+/g, ' ').trim().slice(0, 40)})`
}

function pngSize(base64: string): { width: number; height: number } {
  const head = Buffer.from(base64.slice(0, 44), 'base64')
  if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47) return { width: 0, height: 0 }
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}

export function createRunner(deps: RunnerDeps): { run: (req: SaturaExecRequest, signal: AbortSignal, peer?: ExecPeer) => Promise<SaturaExecReply> } {
  let external: { who: string; what: string; since: number } | null = null

  const run = async (req: SaturaExecRequest, outer: AbortSignal, peer?: ExecPeer): Promise<SaturaExecReply> => {
    if (!deps.exclusive || cleanPaneKey(req.paneKey)) return runOnce(req, outer, peer)
    const who = whoOf(req, 'Agent')
    if (external) {
      const secs = Math.round((deps.now() - external.since) / 1000)
      return { ok: false, error: `busy: ${external.who} is running ${external.what} (${secs}s). One caller at a time drives this instance; retry when it finishes.`, logs: [], shots: [], ms: 0 }
    }
    external = { who, what: whatOf(req.code), since: deps.now() }
    try {
      return await runOnce(req, outer, peer)
    } finally {
      external = null
    }
  }

  const runOnce = async (req: SaturaExecRequest, outer: AbortSignal, peer?: ExecPeer): Promise<SaturaExecReply> => {
    const started = deps.now()
    const logs: ScriptLog[] = []
    const shots: ScriptShot[] = []
    const steps: ScriptStep[] = []
    const notes: string[] = []
    const inflight = new Map<number, { label: string; t0: number }>()
    let nextCall = 0
    const reply = (extra: Partial<SaturaExecReply>): SaturaExecReply => ({
      ok: false,
      logs,
      shots,
      ms: deps.now() - started,
      ...(steps.length ? { steps } : {}),
      ...(notes.length ? { notes } : {}),
      ...extra
    })
    if (typeof req.code !== 'string') {
      return reply({ error: typeof req.command === 'string' ? OLD_CLIENT : 'Pass the script as code.' })
    }
    if (!req.code.trim()) return reply({ error: 'The script is empty.' })
    if (req.code.length > MAX_SCRIPT_CHARS) return reply({ error: `The script is too long: keep it under ${MAX_SCRIPT_CHARS} characters.` })
    const paneKey = cleanPaneKey(req.paneKey)
    const projectRoot = typeof req.projectRoot === 'string' ? req.projectRoot : ''
    const caller = await deps.caller(paneKey, projectRoot)
    if (paneKey && caller.window === null) return reply({ error: caller.error ?? UNKNOWN_PANE })

    const runId = nextRun++
    const timeoutMs = clampTimeoutSeconds(req.timeout) * 1000
    const abort = new AbortController()
    const onOuterAbort = (): void => abort.abort()
    outer.addEventListener('abort', onOuterAbort, { once: true })
    if (outer.aborted) abort.abort()
    const drivers = new Map<number, Promise<DriverLike>>()
    const made = new Map<number, DriverLike>()
    const ready = new Map<number, DriverLike>()
    const budget = new DriftBudget(deps.now)
    const drift = req.drift === true
    let logChars = 0
    let truncatedLogs = false

    const pushLog = (level: string, text: string): void => {
      if (logs.length >= MAX_LOG_LINES || logChars >= MAX_LOG_CHARS) {
        if (!truncatedLogs) logs.push({ level: 'warn', text: `[satura_exec] more console output was cut: a script keeps ${MAX_LOG_LINES} lines or ${MAX_LOG_CHARS} characters. Log less, or return a summary.` })
        truncatedLogs = true
        return
      }
      logChars += text.length
      logs.push({ level, text: text.length > 8000 ? `${text.slice(0, 8000)}…` : text })
    }

    const resolveWindow = (raw: unknown): number => {
      const id = raw === null || raw === undefined ? caller.window : Number(raw)
      if (id === null || !Number.isFinite(id)) throw new Error(NO_WINDOW)
      if (!deps.windows().some((w) => w.id === id)) throw new Error(`No Satura Space window with id ${raw}. See app.windows().`)
      return id
    }

    const driverFor = (raw: unknown): Promise<DriverLike> => {
      const id = resolveWindow(raw)
      const existing = drivers.get(id)
      if (existing) return existing
      const workspace = id === caller.window ? (caller.workspace ?? '') : ''
      if (!claimScope(busyScopes, id, workspace, runId)) throw new Error(BUSY)
      const created = (async () => {
        const driver = deps.driver(id, { name: caller.name, signal: abort.signal, log: deps.log, workspace, budget, run: runId, drift, autoFront: !!deps.exclusive && !paneKey })
        made.set(id, driver)
        await driver.start()
        ready.set(id, driver)
        return driver
      })()
      drivers.set(id, created)
      return created
    }

    const pausedMs = (): { total: number; paused: boolean } => {
      let total = 0
      let paused = false
      for (const driver of ready.values()) {
        total += driver.pausedMs()
        paused ||= driver.paused
      }
      return { total, paused }
    }

    const call = async (method: string, params: Record<string, any>): Promise<unknown> => {
      switch (method) {
        case 'sleep': {
          const ms = Number(params.ms) || 0
          const driver = caller.window === null ? undefined : ready.get(caller.window)
          if (driver) await driver.hold(ms)
          else await sleep(ms, abort.signal)
          return undefined
        }
        case 'frame':
          return (await driverFor(params.window)).frameAction(String(params.action), String(params.selector), params.options ?? {})
        case 'page':
          return (await driverFor(params.window)).evaluate(params.options ?? {})
        case 'input':
          await (await driverFor(params.window)).input(String(params.device), String(params.action), params.options ?? {})
          return undefined
        case 'say': {
          if (caller.window === null && (params.window === null || params.window === undefined)) return ''
          return (await driverFor(params.window)).say(String(params.text ?? ''), params.options ?? {})
        }
        case 'tuner': {
          if (params.action === 'saved') {
            dropUnsaved(notes)
            return null
          }
          const window = resolveWindow(params.window)
          const driver = await driverFor(window)
          if (params.action === 'ready') return driver.tunerReady({ view: params.view, timeout: params.timeout, limit: params.limit, target: params.target })
          if (params.action === 'aim') {
            if (typeof params.log === 'string') {
              driver.trace(params.log)
              return null
            }
            if (typeof params.note === 'string') {
              driver.note(params.note)
              return null
            }
            return drift && (driver.aimFree?.(AIM_QUIET_MS) ?? false)
          }
          if (params.action === 'front') {
            await driver.front(String(params.what ?? 'this step'), String(params.why ?? 'needs the workspace in front'))
            return null
          }
          const found = await deps.tuner(params, { window, projectRoot, paneKey, workspace: window === caller.window ? caller.workspace ?? null : null })
          if (params.action === 'find' && found && typeof found === 'object') {
            const f = found as { view?: string; count?: number }
            if ((f.count ?? 0) > 1 && f.view) driver.note(`used ${f.view === 'scene' ? 'the scene Tuner' : f.view.startsWith('@asset:') ? `the Tuner of ${f.view.slice(7)}` : `the Tuner "${f.view}"`} of ${f.count} open`)
          }
          return found
        }
        case 'video': {
          const window = resolveWindow(params.window)
          await driverFor(window)
          return deps.video(params, { window, projectRoot, paneKey })
        }
        case 'report': {
          const window = resolveWindow(params.window)
          await driverFor(window)
          return deps.report(params, { window, projectRoot, paneKey })
        }
        case 'dashboard': {
          if (!deps.dashboard) throw new Error('The dashboard is not available here.')
          const window = resolveWindow(params.window)
          await driverFor(window)
          return deps.dashboard(params, { window, projectRoot, paneKey })
        }
        case 'layout': {
          const window = resolveWindow(params.window)
          const driver = await driverFor(window)
          if (params.action === 'log') {
            driver.trace(String(params.text ?? ''))
            return null
          }
          if (params.action === 'note') {
            driver.note(String(params.text ?? ''))
            return null
          }
          return deps.layout(params, { window, paneKey, workspace: window === caller.window ? caller.workspace ?? null : null })
        }
        case 'tabs': {
          if (!deps.tabs) throw new Error('Tabs are not available here.')
          const window = params.action === 'phone' ? caller.window : resolveWindow(params.window)
          return deps.tabs(params, { window, paneKey, workspace: window !== null && window === caller.window ? caller.workspace ?? null : null })
        }
        case 'snapshot':
          return (await driverFor(params.window)).snapshot(typeof params.selector === 'string' ? params.selector : null, params.options ?? {})
        case 'ask': {
          if (!drift) throw new Error(ASK_NEEDS_DRIFT)
          const buttons = Array.isArray(params.buttons) ? params.buttons.map((b: unknown) => String(b)) : ['Next']
          const target = params.target && typeof params.target === 'object' ? (params.target as Record<string, unknown>) : null
          return (await driverFor(params.window)).ask(target, String(params.text ?? ''), buttons)
        }
        case 'point':
          return (await driverFor(params.window)).point(params.target ?? {}, String(params.text ?? ''), params.options ?? {})
        case 'driftClock': {
          if (!drift) throw new Error('drift.clock() needs drift: true')
          const driver = await driverFor(params.window)
          return params.advance !== undefined ? driver.driftAdvance(Number(params.advance)) : driver.driftClock(params.step === true)
        }
        case 'shot': {
          if (shots.length >= MAX_SHOTS) throw new Error(`A script can take at most ${MAX_SHOTS} screenshots.`)
          const driver = await driverFor(params.window)
          const shot = await driver.screenshot(typeof params.selector === 'string' ? params.selector : null, params.options ?? {})
          shots.push({ mime: shot.mime, data: shot.data.toString('base64'), width: shot.width, height: shot.height })
          return { shot: shots.length, width: shot.width, height: shot.height }
        }
        case 'agents': {
          const res = await deps.agents(String(params.command), params.args ?? {}, paneKey, projectRoot)
          if (!res.ok) throw new Error(String(res.error ?? 'The agents call failed.'))
          const { ok: _ok, ...rest } = res
          return rest
        }
        case 'handle': {
          const rows = deps.windows()
          const window = caller.window ?? (rows.find((w) => w.focused) ?? rows.find((w) => w.visible) ?? rows[0])?.id ?? null
          return deps.handles(params, { window, workspace: window === caller.window ? (caller.workspace ?? null) : null, projectRoot, paneKey, caller: whoOf(req, caller.name), run: runId, origin: req.origin === 'report' ? 'report' : 'agent' })
        }
        case 'logs':
          return deps.logs(String(params.source), params.options ?? {}, { window: caller.window, projectRoot })
        case 'step': {
          if (steps.length < 200) steps.push({ label: String(params.label ?? '').slice(0, 120), ok: params.ok !== false, ms: Number(params.ms) || 0 })
          return null
        }
        case 'unityMode': {
          if (!deps.unityMode) throw new Error('Unity modes are not available here.')
          return deps.unityMode(params, projectRoot)
        }
        case 'unity': {
          if (!deps.unity) return { delegate: true, managed: false }
          const label = `unity.${String(params.op ?? '')}`
          const t0 = deps.now()
          const key = ++nextCall
          inflight.set(key, { label, t0 })
          try {
            const value = await deps.unity(params, projectRoot, abort.signal)
            const v = value as { delegate?: boolean; note?: string } | null
            if (!v?.delegate && steps.length < 200) steps.push({ label, ok: true, ms: deps.now() - t0 })
            if (v?.note && !notes.includes(v.note) && notes.length < 50) notes.push(v.note)
            return value
          } catch (e) {
            if (steps.length < 200) steps.push({ label, ok: false, ms: deps.now() - t0 })
            throw e
          } finally {
            inflight.delete(key)
          }
        }
        case 'plugin': {
          if (!deps.plugin) throw new Error('Plugins are not available here.')
          const label = `${String(params.plugin ?? '')}.${String(params.fn ?? '')}`
          const t0 = deps.now()
          const key = ++nextCall
          inflight.set(key, { label, t0 })
          try {
            const value = await deps.plugin(params, { window: caller.window, projectRoot, signal: abort.signal })
            if (steps.length < 200) steps.push({ label, ok: true, ms: deps.now() - t0 })
            return value
          } catch (e) {
            if (steps.length < 200) steps.push({ label, ok: false, ms: deps.now() - t0 })
            throw e
          } finally {
            inflight.delete(key)
          }
        }
        case 'mcp': {
          const fn = String(params.fn ?? '')
          const label = typeof params.label === 'string' && params.label ? params.label.slice(0, 120) : fn
          if (typeof params.graphics === 'string' && deps.requireGraphics) {
            const args = (params.args ?? {}) as Record<string, unknown>
            deps.requireGraphics(params.graphics, typeof args.project === 'string' && args.project ? args.project : projectRoot)
          }
          if (!peer) throw named(NO_PEER, 'UnityError')
          const t0 = deps.now()
          const key = ++nextCall
          if (params.quiet !== true) inflight.set(key, { label, t0 })
          let answer: Awaited<ReturnType<typeof peer.call>>
          try {
            answer = await peer.call(fn, (params.args ?? {}) as Record<string, unknown>)
          } finally {
            inflight.delete(key)
          }
          if (steps.length < 200 && params.quiet !== true) steps.push({ label, ok: answer.ok, ms: deps.now() - t0 })
          if (answer.ok && fn === 'unity.exec') dropUnsaved(notes)
          for (const n of answer.notes ?? []) if (n && !notes.includes(n) && notes.length < 50) notes.push(String(n))
          const images: number[] = []
          for (const img of answer.images ?? []) {
            if (shots.length >= MAX_SHOTS) {
              if (!notes.includes(SHOTS_CUT)) notes.push(SHOTS_CUT)
              break
            }
            shots.push({ mime: img.mime, data: img.data, ...pngSize(img.data) })
            images.push(shots.length)
          }
          if (!answer.ok) throw named(answer.error ?? `${fn} failed`, answer.name || 'UnityError')
          return images.length ? { value: answer.value, images } : { value: answer.value }
        }
        default:
          throw new Error(`Unknown call ${method}`)
      }
    }

    deps.log(`run ${runId}: start, window ${caller.window ?? 'none'}, workspace ${caller.workspace || 'none'}, limit ${timeoutMs / 1000}s, drift ${drift ? 'on' : 'off'}`)
    const windowRows = (): string => JSON.stringify(deps.windows().map((w) => ({ ...w, caller: w.id === caller.window })))
    let sentWindows = windowRows()
    const host = deps.spawnHost(req.code, JSON.stringify({ windows: JSON.parse(sentWindows), drift, plugins: deps.plugins?.() ?? {} }))
    const outcome = await new Promise<{ result?: string; failure?: ScriptFailure }>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let credited = 0
      const finish = (value: { result?: string; failure?: ScriptFailure }): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(value)
      }
      const arm = (ms: number): void => {
        timer = setTimeout(() => {
          const { total, paused } = pausedMs()
          if (paused || total > credited) {
            const extra = total - credited
            credited = total
            arm(Math.max(extra, 250))
            return
          }
          const waiting = [...inflight.values()]
          for (const w of waiting) if (steps.length < 200) steps.push({ label: `${w.label} (unfinished)`, ok: false, ms: deps.now() - w.t0 })
          const on = waiting.map((w) => `${w.label} (${((deps.now() - w.t0) / 1000).toFixed(1)}s)`).join(', ')
          finish({
            failure: {
              name: 'TimeoutError',
              message: `The script ran past its ${timeoutMs / 1000}s limit and was stopped.${on ? ` It was still waiting on ${on}.` : ''}`,
              stack: ''
            }
          })
        }, ms)
      }
      arm(timeoutMs)
      abort.signal.addEventListener(
        'abort',
        () => finish({ failure: { name: 'AbortedError', message: 'The call was cancelled.', stack: '' } }),
        { once: true }
      )
      host.onExit((error) =>
        finish({
          failure: {
            name: 'Error',
            message: error ? (error.name === 'ScriptOutOfMemory' ? error.message : `The script stopped: ${error.message}`) : 'The script stopped before it finished.',
            stack: ''
          }
        })
      )
      host.onMessage((msg) => {
        if (msg.t === 'log') {
          pushLog(String(msg.level ?? 'log'), String(msg.text ?? ''))
          return
        }
        if (msg.t === 'done') {
          if (msg.ok) {
            const value = typeof msg.value === 'string' ? msg.value : undefined
            finish({
              result: value === undefined ? undefined : cutResult(value)
            })
          } else {
            finish({
              failure: {
                name: String(msg.name ?? 'Error'),
                message: String(msg.message ?? ''),
                stack: String(msg.stack ?? '')
              }
            })
          }
          return
        }
        if (msg.t === 'call') {
          const id = msg.id as number
          void call(String(msg.method), (msg.params ?? {}) as Record<string, any>).then(
            (value) => {
              if (settled) return
              const rows = windowRows()
              if (rows !== sentWindows) {
                sentWindows = rows
                host.send({ t: 'reply', json: JSON.stringify({ windows: JSON.parse(rows) }) })
              }
              let json: string | undefined
              try {
                json = value === undefined ? undefined : JSON.stringify(value)
              } catch {
                json = JSON.stringify(String(value))
              }
              host.send({ t: 'reply', json: JSON.stringify({ id, ok: true, value: json }) })
            },
            (e) => {
              if (settled) return
              host.send({ t: 'reply', json: JSON.stringify({ id, ok: false, ...errorOf(e) }) })
            }
          )
        }
      })
    })

    host.terminate()
    abort.abort()
    outer.removeEventListener('abort', onOuterAbort)
    const reports: string[] = []
    try {
      for (const [id, driver] of made) {
        const clean = await within(driver.dispose(!!outcome.failure).then(() => true, () => true), CLEANUP_MS)
        if (!clean) deps.log(`run ${runId}: window ${id} did not finish cleaning up in ${CLEANUP_MS / 1000}s`)
        try {
          const line = driver.report()
          if (line) reports.push(line)
        } catch {
        }
      }
    } finally {
      releaseScopes(busyScopes, runId)
      deps.runEnded?.(runId)
    }
    const how = outcome.failure ? `${outcome.failure.name}: ${outcome.failure.message.split('\n')[0]}` : 'ok'
    deps.log(`run ${runId}: done in ${deps.now() - started}ms, ${how}, ${shots.length} shot(s), ${logs.length} log line(s)`)
    return reply({ ok: !outcome.failure, ...outcome, ...(reports.length ? { drift: reports.join(' | ') } : {}) })
  }

  return { run }
}
