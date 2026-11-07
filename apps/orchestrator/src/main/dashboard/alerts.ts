import { BrowserWindow, Notification } from 'electron'
import { join } from 'node:path'
import {
  buildAlertMessage,
  dashboardDir,
  maskSecrets,
  snapshotText,
  type DashboardAlertState,
  type DashboardAlertsEvent
} from '@shared/dashboard'
import { censusTrack } from '@shared/census'
import { compileReport } from '../report/compile'
import { workerHost } from '../satura-exec/sandbox/worker-host'
import type { ScriptHost } from '../satura-exec/runner'
import { agentExecService } from '../agent-exec'
import alertBootstrap from './alert-bootstrap.ts?iife'
import { cleanProject, listAlertIds, readSecrets } from './files'
import { dashboardOwner } from './owners'
import { proxyFetch } from './proxy'
import { callUnityHandle } from './unity-handle'
import { dashboardGit, dashboardLogs } from './sources'
import { watchDashboard } from './watch'
import { debugLog } from '@shared/debug-log'
import { alertFired } from '../remote/push-events'

const MIN_EVERY_S = 5
const DEFAULT_COOLDOWN_S = 600
const WHEN_TIMEOUT_MS = 5000

type Source = { kind: 'fetch' | 'handle' | 'git' | 'logs'; cfg: Record<string, unknown> }

interface Running {
  id: string
  file: string
  state: DashboardAlertState
  host: ScriptHost | null
  source: Source | null
  cooldown: number
  timer: ReturnType<typeof setTimeout> | null
  seq: number
  waiting: Map<number, (r: { value?: string | null; error?: string }) => void>
  lastFiredAt: number
  stopped: boolean
}

function wrap(code: string): string {
  return [
    'const module = { exports: {} }',
    "const require = (name) => { if (name === '@satura/dashboard/alert') return { alert: (c) => c }; throw new Error(`Alerts can import only '@satura/dashboard/alert', not '${name}'.`) }",
    ';(function (module, exports, require) {',
    code,
    '})(module, module.exports, require)',
    '__alertRegister(module.exports.default)'
  ].join('\n')
}

function sourceOf(cfg: Record<string, unknown>): Source | null {
  for (const kind of ['fetch', 'handle', 'git', 'logs'] as const) {
    const v = cfg[kind]
    if (v && typeof v === 'object') return { kind, cfg: v as Record<string, unknown> }
  }
  return null
}

class ProjectAlerts {
  private alerts = new Map<string, Running>()
  private unwatch: (() => void) | null
  private syncing: Promise<void> | null = null
  private again = false

  constructor(readonly project: string, private readonly emit: (p: ProjectAlerts) => void) {
    this.unwatch = watchDashboard(project, (files) => {
      if (files.some((f) => f === '' || f.startsWith('alerts') || f === 'secrets.json')) void this.sync(files)
    })
    void this.sync([])
  }

  states(): DashboardAlertState[] {
    return [...this.alerts.values()].map((a) => ({ ...a.state }))
  }

  markSent(id: string, to: string): void {
    const a = this.alerts.get(id)
    if (!a) return
    a.state = { ...a.state, undelivered: false, deliveredTo: to }
    this.emit(this)
  }

  dispose(): void {
    this.unwatch?.()
    this.unwatch = null
    for (const a of this.alerts.values()) this.stop(a)
    this.alerts.clear()
  }

  private sync(files: string[]): Promise<void> {
    if (this.syncing) {
      this.again = true
      return this.syncing
    }
    this.syncing = (async () => {
      do {
        this.again = false
        const ids = await listAlertIds(this.project)
        const changed = new Set(files.filter((f) => f.startsWith('alerts/')).map((f) => f.slice(7).replace(/\.ts$/, '')))
        for (const [id, a] of this.alerts) {
          if (!ids.includes(id) || changed.has(id)) {
            this.stop(a)
            this.alerts.delete(id)
          }
        }
        for (const id of ids) if (!this.alerts.has(id) && this.unwatch) await this.load(id)
        files = []
        this.emit(this)
      } while (this.again && this.unwatch)
    })().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  private async load(id: string): Promise<void> {
    const file = join(dashboardDir(this.project), 'alerts', `${id}.ts`)
    const a: Running = {
      id,
      file,
      state: { id, file, status: 'starting', every: 60, to: 'agent' },
      host: null,
      source: null,
      cooldown: DEFAULT_COOLDOWN_S,
      timer: null,
      seq: 0,
      waiting: new Map(),
      lastFiredAt: 0,
      stopped: false
    }
    this.alerts.set(id, a)
    const res = await compileReport(file, this.project).catch((e: unknown) => ({ ok: false, text: e instanceof Error ? e.message : String(e), code: '' }))
    if (a.stopped) return
    if (!res.ok || !res.code) {
      this.setError(a, res.text || 'The alert did not compile.')
      return
    }
    this.spawn(a, res.code)
  }

  private spawn(a: Running, code: string): void {
    const host = workerHost(join(__dirname, 'satura-exec-worker.js'), wrap(code), alertBootstrap)
    a.host = host
    host.onExit((error) => {
      if (a.host !== host) return
      a.host = null
      for (const w of a.waiting.values()) w({ error: error?.message ?? 'The alert stopped.' })
      a.waiting.clear()
      if (!a.stopped) this.setError(a, error ? `The alert stopped: ${error.message}` : 'The alert stopped.')
    })
    host.onMessage((msg) => {
      if (a.host !== host) return
      if (msg.t === 'bad') this.setError(a, String(msg.message ?? 'The alert failed to load.'))
      else if (msg.t === 'done' && msg.ok === false) this.setError(a, `${String(msg.name ?? 'Error')}: ${String(msg.message ?? '')}`)
      else if (msg.t === 'config') this.configure(a, msg)
      else if (msg.t === 'result') {
        const w = a.waiting.get(Number(msg.seq))
        a.waiting.delete(Number(msg.seq))
        w?.({ value: (msg.value as string | null | undefined) ?? null, error: typeof msg.error === 'string' ? msg.error : undefined })
      }
    })
  }

  private configure(a: Running, msg: Record<string, unknown>): void {
    const every = Math.max(MIN_EVERY_S, Number(msg.every) || 60)
    const source = sourceOf(msg)
    a.source = source
    a.cooldown = Number.isFinite(Number(msg.cooldown)) && Number(msg.cooldown) >= 0 ? Number(msg.cooldown) : DEFAULT_COOLDOWN_S
    a.state = { ...a.state, every, to: msg.to === 'new' ? 'new' : 'agent' }
    if (!source) {
      this.setError(a, 'The alert needs a source: fetch, handle, git or logs.')
      return
    }
    a.state = { ...a.state, status: 'ok', error: undefined }
    debugLog(`[dashboard] alert ${a.id} in ${this.project} runs every ${every}s on ${source.kind}`)
    this.emit(this)
    this.schedule(a, 1000)
  }

  private schedule(a: Running, ms: number): void {
    if (a.stopped) return
    if (a.timer) clearTimeout(a.timer)
    a.timer = setTimeout(() => {
      a.timer = null
      void this.tick(a).finally(() => this.schedule(a, a.state.every * 1000))
    }, ms)
  }

  private async gather(a: Running): Promise<{ data?: unknown; error?: string }> {
    const s = a.source
    if (!s) return { error: 'No source.' }
    if (s.kind === 'fetch') {
      const r = await proxyFetch(this.project, s.cfg as never)
      return r.ok ? { data: r.data } : { error: r.error ?? `HTTP ${r.status}` }
    }
    if (s.kind === 'handle') {
      const r = await callUnityHandle(this.project, s.cfg as never)
      return r.ok ? { data: r.value } : { error: r.error ?? 'The handle failed.' }
    }
    if (s.kind === 'git') {
      const r = await dashboardGit(this.project, s.cfg)
      return r.ok ? { data: r } : { error: r.error }
    }
    const r = dashboardLogs(this.project, s.cfg)
    return r.ok ? { data: r.lines } : { error: r.error }
  }

  private when(a: Running, data: unknown): Promise<{ value?: string | null; error?: string }> {
    const host = a.host
    if (!host) return Promise.resolve({ error: 'The alert is not running.' })
    const seq = ++a.seq
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        a.waiting.delete(seq)
        resolve({ error: `when() ran longer than ${WHEN_TIMEOUT_MS / 1000} s, so the alert was stopped. Save the file to start it again.` })
        a.host = null
        host.terminate()
      }, WHEN_TIMEOUT_MS)
      a.waiting.set(seq, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      host.send({ t: 'reply', json: JSON.stringify({ t: 'when', seq, data: data ?? null }) })
    })
  }

  private async tick(a: Running): Promise<void> {
    if (a.stopped || !a.host) return
    const secrets = await readSecrets(this.project)
    const got = await this.gather(a)
    if (a.stopped) return
    const now = Date.now()
    if (got.error !== undefined) {
      this.setError(a, maskSecrets(`${a.source?.kind ?? 'source'}: ${got.error}`, secrets), true)
      return
    }
    const r = await this.when(a, got.data)
    if (a.stopped) return
    if (r.error) {
      this.setError(a, maskSecrets(r.error, secrets), !!a.host)
      return
    }
    const was = a.state.status
    if (!r.value) {
      a.state = { ...a.state, status: 'ok', message: undefined, error: undefined, checkedAt: now }
      this.emit(this)
      return
    }
    const message = maskSecrets(r.value, secrets)
    a.state = { ...a.state, status: 'firing', message, error: undefined, checkedAt: now }
    if (was !== 'firing' && now - a.lastFiredAt >= a.cooldown * 1000) {
      a.lastFiredAt = now
      a.state.firedAt = now
      await this.fire(a, message, maskSecrets(snapshotText(got.data), secrets))
    }
    this.emit(this)
  }

  private async fire(a: Running, message: string, data: string): Promise<void> {
    const rel = `.sspace/dashboard/alerts/${a.id}.ts`
    const text = buildAlertMessage({ id: a.id, file: rel, message, data })
    console.log(`[dashboard] alert ${a.id} fired: ${message}`)
    alertFired({ project: this.project, id: a.id, message })
    let to: string | null = null
    try {
      const svc = agentExecService()
      if (a.state.to === 'new') {
        const wcId = await svc.windowForProject(this.project)
        const wc = wcId == null ? null : BrowserWindow.getAllWindows().find((w) => w.webContents.id === wcId)?.webContents
        if (wc && !wc.isDestroyed()) {
          wc.send('dashboard:spawnAgent', { projectPath: this.project, text, alert: a.id })
          to = 'a new agent'
        }
      } else {
        const owner = dashboardOwner(this.project)
        const tried = new Set<string>()
        for (const pick of [owner, await svc.paneForProject(this.project, owner ?? undefined)]) {
          if (!pick || tried.has(pick)) continue
          tried.add(pick)
          if ((await svc.tell(pick, text)) === 'sent') {
            to = pick
            break
          }
        }
      }
    } catch (e) {
      console.warn(`[dashboard] alert ${a.id} delivery failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    a.state = { ...a.state, deliveredTo: to, undelivered: !to }
    console.log(`[dashboard] alert ${a.id} ${to ? `sent to ${to}` : 'had no agent to go to: showing it in the dashboard'}`)
    if (!to) this.notify(a, message)
  }

  private notify(a: Running, message: string): void {
    if (!Notification.isSupported()) {
      console.log(`[dashboard] alert ${a.id}: desktop notifications are not supported here`)
      return
    }
    const n = new Notification({ title: `Dashboard alert: ${a.id}`, body: message.slice(0, 240) })
    n.on('click', () => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (!win) return
      win.show()
      win.webContents.send('dashboard:open', { projectPath: this.project })
    })
    n.show()
    debugLog(`[dashboard] alert ${a.id}: desktop notification shown`)
  }

  private setError(a: Running, error: string, keepRunning = false): void {
    a.state = { ...a.state, status: 'error', error, checkedAt: Date.now() }
    if (!keepRunning && a.timer) {
      clearTimeout(a.timer)
      a.timer = null
    }
    console.log(`[dashboard] alert ${a.id}: ${error.split('\n')[0]}`)
    this.emit(this)
  }

  private stop(a: Running): void {
    a.stopped = true
    if (a.timer) clearTimeout(a.timer)
    a.timer = null
    const host = a.host
    a.host = null
    host?.terminate()
    for (const w of a.waiting.values()) w({ error: 'stopped' })
    a.waiting.clear()
  }
}

const byWindow = new Map<number, Set<string>>()
const running = new Map<string, ProjectAlerts>()
let quitting = false
censusTrack('dashboard.alerts', running)

function broadcast(p: ProjectAlerts): void {
  const ev: DashboardAlertsEvent = { project: p.project, alerts: p.states() }
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('dashboard:alerts', ev)
}

function reconcile(): void {
  const want = new Set<string>()
  for (const set of byWindow.values()) for (const p of set) want.add(p)
  for (const [p, r] of running) {
    if (want.has(p)) continue
    r.dispose()
    running.delete(p)
    console.log(`[dashboard] alerts stopped for ${p}: the project is closed`)
  }
  for (const p of want) if (!running.has(p)) running.set(p, new ProjectAlerts(p, broadcast))
}

export function setOpenProjects(wcId: number, projects: string[]): void {
  if (quitting) return
  const next = new Set(projects.filter((p) => typeof p === 'string' && p).map(cleanProject))
  if (next.size) byWindow.set(wcId, next)
  else byWindow.delete(wcId)
  reconcile()
}

export function stopAllAlerts(): void {
  quitting = true
  byWindow.clear()
  reconcile()
}

export function forgetWindow(wcId: number): void {
  if (byWindow.delete(wcId)) reconcile()
}

export function alertStates(project: string): DashboardAlertState[] {
  return running.get(cleanProject(project))?.states() ?? []
}

export function markAlertSent(project: string, id: string, to: string): void {
  running.get(cleanProject(project))?.markSent(id, to)
}
