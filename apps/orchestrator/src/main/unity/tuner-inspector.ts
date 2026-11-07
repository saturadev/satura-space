import { webContents } from 'electron'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import type { ControlEvent, ControlResult } from '@shared/control-protocol'
import {
  cleanTunerInspectTarget,
  isTunerInspectorSession,
  type TiCapture,
  type TunerInspectTarget,
  type TunerInspectorFont,
  type TunerInspectorInput,
  type TunerInspectorResult
} from '@shared/tuner-inspector'
import { UnityControlClient } from './unity-control-client'
import { unityProvider } from './unity-instance-provider'
import { editorNotRunningError } from './scratchpad-store'
import { clampTunerInspectorWidth, tunerInspectorInputArgs, tunerInspectorTargetArgs } from './tuner-inspector-args'
import { censusTrack } from '@shared/census'
import { debugLog } from '@shared/debug-log'

const CONNECT_WAIT_MS = 3000
const OPEN_TIMEOUT_MS = 20_000
const INPUT_TIMEOUT_MS = 15_000
const CLOSE_TIMEOUT_MS = 3000
const VALUES_TIMEOUT_MS = 3000
const POLL_MS = 400
const IDLE_CLOSE_MS = 30_000
const FONT_FILES = [
  'Inter-Regular.ttf',
  'Inter-SemiBold.ttf',
  'Inter-Italic.ttf',
  'Inter-SemiBoldItalic.ttf',
  'Inter-Small.ttf',
  'RobotoMono-Regular.ttf',
  'RobotoMono-Bold.ttf'
]

interface Conn {
  projectKey: string
  port: number
  client: UnityControlClient
  off: () => void
  poll: NodeJS.Timeout
  wasConnected: boolean
  everConnected: boolean
  idleSince: number
}

interface Session {
  key: string
  id: string
  projectPath: string
  projectKey: string
  wcId: number
  target: TunerInspectTarget
  width: number
  conn: Conn
  reopening: boolean
}

function toResult(r: ControlResult | null): TunerInspectorResult {
  if (!r) return { ok: false, error: 'The Unity editor did not answer in time. It may be compiling, importing or showing a dialog.' }
  if (r.status !== 'completed')
    return { ok: false, error: typeof r.error === 'string' && r.error ? r.error : 'The inspector capture failed' }
  const data = r.capture as TiCapture | undefined
  return data ? { ok: true, data } : { ok: false, error: 'The Unity editor returned no capture' }
}

function validFontDir(dir: string): boolean {
  if (typeof dir !== 'string' || !dir || dir.length > 1024 || !isAbsolute(dir)) return false
  const n = normalize(dir).replace(/[\\/]+$/, '')
  return n.endsWith(`${sep}Resources${sep}Fonts`) || n.endsWith('/Resources/Fonts')
}

class TunerInspectorService {
  private readonly conns = censusTrack('tuner-inspector.conns', new Map<string, Conn>())
  private readonly sessions = censusTrack('tuner-inspector.sessions', new Map<string, Session>())
  private readonly fontCache = censusTrack('tuner-inspector.fontCache', new Map<string, Promise<TunerInspectorFont[]>>())

  private keyFor(projectKey: string, id: string): string {
    return `${projectKey}\n${id}`
  }

  private find(projectPath: string, id: string): Session | undefined {
    const ctl = unityProvider.primaryControl(projectPath)
    return this.sessions.get(this.keyFor(ctl?.projectKey ?? projectPath, id))
  }

  private connFor(projectPath: string): Conn | string {
    const ctl = unityProvider.primaryControl(projectPath)
    if (!ctl || !ctl.alive) return editorNotRunningError(projectPath)
    const existing = this.conns.get(ctl.projectKey)
    if (existing && existing.port === ctl.port) return existing
    if (existing) this.dropConn(existing)
    const client = new UnityControlClient(ctl.port)
    const conn: Conn = {
      projectKey: ctl.projectKey,
      port: ctl.port,
      client,
      off: () => {},
      poll: setInterval(() => this.tick(conn), POLL_MS),
      wasConnected: false,
      everConnected: false,
      idleSince: Date.now()
    }
    conn.off = client.onEvent((e) => this.onEvent(conn, e))
    this.conns.set(ctl.projectKey, conn)
    for (const s of this.sessions.values()) if (s.projectKey === ctl.projectKey) s.conn = conn
    return conn
  }

  private dropConn(conn: Conn): void {
    if (this.conns.get(conn.projectKey) === conn) this.conns.delete(conn.projectKey)
    clearInterval(conn.poll)
    conn.off()
    conn.client.close()
  }

  private async connected(conn: Conn): Promise<boolean> {
    const deadline = Date.now() + CONNECT_WAIT_MS
    while (!conn.client.isConnected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    return conn.client.isConnected
  }

  private tick(conn: Conn): void {
    const ctl = unityProvider.primaryControl(conn.projectKey)
    const mine = [...this.sessions.values()].filter((s) => s.conn === conn)
    if (mine.length === 0) {
      if (Date.now() - conn.idleSince > IDLE_CLOSE_MS) this.dropConn(conn)
      return
    }
    conn.idleSince = Date.now()
    if (ctl && ctl.alive && ctl.port !== conn.port) {
      const next = this.connFor(conn.projectKey)
      if (typeof next !== 'string') for (const s of mine) void this.reopen(s)
      return
    }
    const connected = conn.client.isConnected
    if (connected && !conn.wasConnected && conn.everConnected) {
      debugLog(`[tunerInspector] control socket back, reopening ${mine.length} session(s) project=${conn.projectKey}`)
      for (const s of mine) void this.reopen(s)
    }
    if (connected) conn.everConnected = true
    conn.wasConnected = connected
  }

  private async reopen(s: Session): Promise<void> {
    if (s.reopening || this.sessions.get(s.key) !== s) return
    s.reopening = true
    try {
      if (!(await this.connected(s.conn))) return
      const r = await s.conn.client.command(
        'tunerInspector/open',
        { session: s.id, target: tunerInspectorTargetArgs(s.target), width: s.width },
        OPEN_TIMEOUT_MS
      )
      const res = toResult(r)
      if (res.ok && res.data) this.emit(s, res.data)
    } finally {
      s.reopening = false
    }
  }

  private emit(s: Session, capture: TiCapture): void {
    const wc = webContents.fromId(s.wcId)
    if (!wc || wc.isDestroyed()) {
      void this.close(s.projectPath, s.id)
      return
    }
    wc.send('tunerInspector:capture', { projectPath: s.projectPath, session: s.id, capture })
  }

  private onEvent(conn: Conn, e: ControlEvent): void {
    if (e.event !== 'tunerInspector/capture' || typeof e.session !== 'string') return
    const s = this.sessions.get(this.keyFor(conn.projectKey, e.session))
    if (!s || !e.capture || typeof e.capture !== 'object') return
    this.emit(s, e.capture as TiCapture)
  }

  async open(
    wcId: number,
    projectPath: string,
    id: string,
    target: TunerInspectTarget,
    width: number
  ): Promise<TunerInspectorResult> {
    if (!isTunerInspectorSession(id)) return { ok: false, error: 'Invalid inspector session id' }
    const clean = cleanTunerInspectTarget(target)
    if (!clean) return { ok: false, error: 'Invalid inspector target' }
    const conn = this.connFor(projectPath)
    if (typeof conn === 'string') return { ok: false, error: conn }
    const key = this.keyFor(conn.projectKey, id)
    let s = this.sessions.get(key)
    if (!s) {
      s = { key, id, projectPath, projectKey: conn.projectKey, wcId, target: clean, width: clampTunerInspectorWidth(width), conn, reopening: false }
      this.sessions.set(key, s)
    } else {
      s.target = clean
      s.width = clampTunerInspectorWidth(width)
      s.wcId = wcId
      s.conn = conn
    }
    debugLog(`[tunerInspector] open session=${id} target=${JSON.stringify(clean)} width=${s.width}`)
    if (!(await this.connected(conn)))
      return { ok: false, error: 'The Unity editor control socket is not reachable yet. It may be reloading.' }
    const r = await conn.client.command(
      'tunerInspector/open',
      { session: id, target: tunerInspectorTargetArgs(clean), width: s.width },
      OPEN_TIMEOUT_MS
    )
    return toResult(r)
  }

  async input(projectPath: string, id: string, input: TunerInspectorInput): Promise<TunerInspectorResult> {
    const s = this.find(projectPath, id)
    if (!s) return { ok: false, error: 'The inspector session is not open' }
    const args = tunerInspectorInputArgs(input)
    if (typeof args === 'string') return { ok: false, error: args }
    if (args.op !== 'hover' && !(args.op === 'mouse' && (args.type === 'drag' || args.type === 'move')))
      debugLog(`[tunerInspector] input session=${id} ${JSON.stringify(args)}`)
    if (!(await this.connected(s.conn)))
      return { ok: false, error: 'The Unity editor control socket is not reachable yet. It may be reloading.' }
    const r = await s.conn.client.command(
      'tunerInspector/input',
      { session: id, target: tunerInspectorTargetArgs(s.target), width: s.width, input: args },
      INPUT_TIMEOUT_MS
    )
    return toResult(r)
  }

  async resize(projectPath: string, id: string, width: number): Promise<TunerInspectorResult> {
    const s = this.find(projectPath, id)
    if (!s) return { ok: false, error: 'The inspector session is not open' }
    s.width = clampTunerInspectorWidth(width)
    return this.capture(projectPath, id, false)
  }

  async capture(projectPath: string, id: string, force: boolean): Promise<TunerInspectorResult> {
    const s = this.find(projectPath, id)
    if (!s) return { ok: false, error: 'The inspector session is not open' }
    if (!(await this.connected(s.conn)))
      return { ok: false, error: 'The Unity editor control socket is not reachable yet. It may be reloading.' }
    const r = await s.conn.client.command(
      'tunerInspector/capture',
      { session: id, target: tunerInspectorTargetArgs(s.target), width: s.width, force: force === true },
      INPUT_TIMEOUT_MS
    )
    return toResult(r)
  }

  async values(projectPath: string, id: string): Promise<Record<string, string[][]> | null> {
    const s = this.find(projectPath, id) ?? [...this.sessions.values()].find((x) => x.id === id)
    if (!s || !s.conn.client.isConnected) return null
    const r = await s.conn.client.command('tunerInspector/values', { session: s.id }, VALUES_TIMEOUT_MS)
    if (!r || r.status !== 'completed' || !r.values || typeof r.values !== 'object') return null
    return r.values as Record<string, string[][]>
  }

  async field(projectPath: string, id: string, section: string, name: string): Promise<Record<string, unknown> | null> {
    const s = this.find(projectPath, id) ?? [...this.sessions.values()].find((x) => x.id === id)
    if (!s || !s.conn.client.isConnected) return null
    const r = await s.conn.client.command('tunerInspector/field', { session: s.id, section, name }, VALUES_TIMEOUT_MS)
    if (!r || r.status !== 'completed' || !r.field || typeof r.field !== 'object') return null
    return r.field as Record<string, unknown>
  }

  async setField(projectPath: string, id: string, section: string, name: string, value: string): Promise<Record<string, unknown> | null> {
    const s = this.find(projectPath, id) ?? [...this.sessions.values()].find((x) => x.id === id)
    if (!s || !s.conn.client.isConnected) throw new Error('The Tuner inspector is not connected to Unity right now. It may be reloading.')
    const r = await s.conn.client.command('tunerInspector/setField', { session: s.id, section, name, value }, VALUES_TIMEOUT_MS)
    if (!r) throw new Error('Unity did not answer.')
    if (r.status !== 'completed') throw new Error(typeof r.error === 'string' && r.error ? r.error : 'Unity did not set it.')
    return r.field && typeof r.field === 'object' ? (r.field as Record<string, unknown>) : null
  }

  async undoGroup(projectPath: string, id: string, step: string, group: string): Promise<number | null> {
    const s = this.find(projectPath, id) ?? [...this.sessions.values()].find((x) => x.id === id)
    if (!s || !s.conn.client.isConnected) return null
    const r = await s.conn.client.command('tunerInspector/undoGroup', { session: s.id, name: step, value: group }, VALUES_TIMEOUT_MS)
    return r && r.status === 'completed' && typeof r.group === 'number' ? r.group : null
  }

  async close(projectPath: string, id: string, wcId?: number): Promise<void> {
    const s = this.find(projectPath, id)
    if (!s || (wcId != null && s.wcId !== wcId)) return
    this.sessions.delete(s.key)
    debugLog(`[tunerInspector] close session=${id}`)
    if (s.conn.client.isConnected) await s.conn.client.command('tunerInspector/close', { session: id }, CLOSE_TIMEOUT_MS)
  }

  closeAllFor(wcId: number): void {
    for (const s of [...this.sessions.values()]) if (s.wcId === wcId) void this.close(s.projectPath, s.id, wcId)
  }

  fonts(fontDir: string): Promise<TunerInspectorFont[]> {
    if (!validFontDir(fontDir)) return Promise.resolve([])
    const dir = normalize(fontDir)
    const cached = this.fontCache.get(dir)
    if (cached) return cached
    const load = async (): Promise<TunerInspectorFont[]> => {
      const out: TunerInspectorFont[] = []
      for (const name of FONT_FILES) {
        try {
          const data = await readFile(join(dir, name))
          out.push({ name: name.replace(/\.ttf$/, ''), data: new Uint8Array(data) })
        } catch {
        }
      }
      return out
    }
    const p = load()
    this.fontCache.set(dir, p)
    return p
  }
}

export const tunerInspectorService = new TunerInspectorService()
