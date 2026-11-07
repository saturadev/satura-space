import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DashboardHandleRequest, DashboardHandleResult } from '@shared/dashboard'
import { unityProvider } from '../unity/unity-instance-provider'
import { primaryOf } from '../handles/unity'
import { withExecLock } from './exec-lock'

const EXEC_TIMEOUT_S = 20
const RUN_WAIT_MS = 10_000
let seq = 0
const busy = new Map<string, Promise<unknown>>()

function directArgs(args: unknown[]): { types: string[]; values: string[] } {
  const types: string[] = []
  const values: string[] = []
  for (const v of args) {
    let t = 's'
    let val = ''
    if (v === null || v === undefined) t = 'n'
    else if (typeof v === 'boolean') {
      t = 'b'
      val = v ? 'true' : 'false'
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error(`Can't pass ${v} to a handle.`)
      t = Number.isInteger(v) ? (v >= -(2 ** 31) && v < 2 ** 31 ? 'i' : 'l') : 'd'
      val = String(v)
    } else if (Array.isArray(v) && v.every((x) => typeof x === 'number')) val = v.join(',')
    else if (typeof v === 'object') val = JSON.stringify(v)
    else val = String(v)
    types.push(t)
    values.push(val)
  }
  return { types, values }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function execOp(project: string, op: Record<string, unknown>): Promise<Record<string, unknown>> {
  return withExecLock(project, `dashboard ${String(op.op)} ${String(op.name ?? op.run ?? '')}`.trim(), 30, () => execLocked(project, op))
}

async function execLocked(project: string, op: Record<string, unknown>): Promise<Record<string, unknown>> {
  const uid = `dash${Date.now().toString(16)}${(++seq).toString(16)}`
  const sspace = join(project, '.sspace')
  const script = join(sspace, 'exec', `_MCPExec_${uid}.json`)
  const results = join(sspace, `.mcp_exec_results.${uid}.json`).replace(/\\/g, '/')
  await mkdir(join(sspace, 'exec'), { recursive: true })
  await writeFile(script, JSON.stringify(op))
  try {
    const enq = await unityProvider.enqueueExec(project, { nonce: uid, results, timeoutSeconds: EXEC_TIMEOUT_S })
    if (!enq.ok) throw new Error(enq.error ?? 'Unity did not take the call.')
    const until = Date.now() + EXEC_TIMEOUT_S * 1000
    while (Date.now() < until) {
      await sleep(120)
      let data: { status?: string; nonce?: string; output?: string; error?: string } | null = null
      try {
        data = JSON.parse(await readFile(results, 'utf8'))
      } catch {
        data = null
      }
      if (!data || data.nonce !== uid || (data.status !== 'completed' && data.status !== 'error')) continue
      if (data.status === 'error') throw new Error(String(data.error || 'The handle call failed in Unity.'))
      const text = String(data.output ?? '')
        .split('\n')
        .filter((l) => !l.startsWith('__MCP_'))
        .join('\n')
        .trim()
        .replace(/SaturaHandles\.(List|Result|Stop|Call)\(/g, (_m, w: string) => `handles.${w.toLowerCase()}(`)
      try {
        return JSON.parse(text) as Record<string, unknown>
      } catch {
        return { status: 'error', error: text || 'The handle call printed nothing.' }
      }
    }
    throw new Error(`Unity did not answer in ${EXEC_TIMEOUT_S} s. It may be compiling, importing or showing a dialog.`)
  } finally {
    await unlink(script).catch(() => undefined)
    await unlink(results).catch(() => undefined)
  }
}

function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (busy.get(key) ?? Promise.resolve()).then(job, job)
  const tail = run.catch(() => null)
  busy.set(key, tail)
  void tail.then(() => {
    if (busy.get(key) === tail) busy.delete(key)
  })
  return run
}

export async function callUnityHandle(projectRoot: string, req: DashboardHandleRequest): Promise<DashboardHandleResult> {
  const t0 = Date.now()
  const done = (r: Omit<DashboardHandleResult, 'at' | 'ms'>): DashboardHandleResult => ({ ...r, at: Date.now(), ms: Date.now() - t0 })
  const name = String(req.name ?? '').trim()
  if (!name) return done({ ok: false, error: "useHandle needs the handle's name." })
  if (req.player && req.player !== 'primary') return done({ ok: false, error: 'Dashboard handles run on the primary editor only.' })
  const primary = primaryOf(projectRoot)
  if (!primary) return done({ ok: false, error: `No Unity editor is open for ${projectRoot}. Open the Unity Player panel first.` })
  try {
    return await serial(primary.project, async () => {
      let r = await execOp(primary.project, { op: 'call', name, ...directArgs(Array.isArray(req.args) ? req.args : []) })
      const until = Date.now() + RUN_WAIT_MS
      while ((r.status === 'running' || r.status === 'scheduled') && r.run && Date.now() < until) {
        await sleep(400)
        r = await execOp(primary.project, { op: 'result', run: r.run })
      }
      const logs = Array.isArray(r.logs) ? r.logs.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))) : []
      if (r.status === 'error') return done({ ok: false, status: 'error', error: String(r.error ?? 'The handle failed.'), logs })
      return done({ ok: true, status: String(r.status ?? 'done'), value: r.value, logs })
    })
  } catch (e) {
    return done({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
