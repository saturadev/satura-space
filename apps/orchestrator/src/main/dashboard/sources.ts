import { realpathSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { DashboardFileResult, DashboardGitRequest, DashboardGitResult, DashboardLogsRequest, DashboardLogsResult } from '@shared/dashboard'
import { gitScmService } from '../git/scm/repository'
import { mainLog, readTail, unityEditorLogPath } from '../satura-exec/logs'
import { primaryOf } from '../handles/unity'

const MAX_FILE_BYTES = 5 * 1024 * 1024
const STATUS = ['M', 'A', 'D', 'R', 'C', 'M', 'D', '?', '!', 'A', 'R', 'T', 'U', 'U', 'U', 'U', 'U', 'U', 'U']

function statusText(s: unknown): string {
  if (typeof s === 'number') return STATUS[s] ?? String(s)
  return typeof s === 'string' ? s : '?'
}

export async function dashboardGit(root: string, req: DashboardGitRequest): Promise<DashboardGitResult> {
  const at = Date.now()
  try {
    const out: DashboardGitResult = { ok: true, at }
    if (req.status !== false) {
      const st = await gitScmService.getState(root)
      if (!st.ok) return { ok: false, error: st.error.message, at }
      const v = st.value
      out.branch = v.HEAD?.name ?? (v.HEAD?.commit ? v.HEAD.commit.slice(0, 8) : null)
      out.ahead = v.HEAD?.ahead ?? 0
      out.behind = v.HEAD?.behind ?? 0
      out.changes = [
        ...v.indexChanges.map((c) => ({ path: c.path, status: statusText(c.status), staged: true })),
        ...v.workingTreeChanges.map((c) => ({ path: c.path, status: statusText(c.status), staged: false }))
      ].map((c) => ({ ...c, path: relative(root, c.path).replace(/\\/g, '/') || c.path }))
    }
    const n = Math.max(0, Math.min(200, Math.round(Number(req.log ?? 0)) || 0))
    if (n > 0) {
      const log = await gitScmService.log(root, { refNames: [], maxEntries: n })
      if (!log.ok) return { ok: false, error: log.error.message, at }
      out.log = log.value.map((c) => ({
        hash: c.hash,
        message: c.message.split('\n')[0],
        author: c.authorName ?? '',
        date: c.authorDate ?? c.commitDate ?? 0
      }))
    }
    return out
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), at }
  }
}

export function dashboardLogs(root: string, req: DashboardLogsRequest): DashboardLogsResult {
  const at = Date.now()
  const tail = Math.max(1, Math.min(2000, Math.round(Number(req.tail ?? 100)) || 100))
  try {
    if (req.source === 'app') {
      const text = mainLog({ tail, grep: req.grep || undefined })
      return { ok: true, lines: text ? text.split('\n') : [], at }
    }
    const project = primaryOf(root)?.project ?? root
    let lines = readTail(unityEditorLogPath(project))
    if (req.grep) {
      let re: RegExp
      try {
        re = new RegExp(req.grep, 'i')
      } catch {
        return { ok: false, lines: [], error: `grep is not a valid pattern: ${req.grep}`, at }
      }
      lines = lines.filter((l) => re.test(l))
    }
    return { ok: true, lines: lines.slice(-tail), at }
  } catch (e) {
    return { ok: false, lines: [], error: e instanceof Error ? e.message : String(e), at }
  }
}

export function projectFile(root: string, path: string): string | null {
  const file = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(resolve(root), file)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  if (/(^|[\\/])\.sspace[\\/]dashboard[\\/]secrets\.json$/i.test(file)) return null
  let real: string
  let realRoot: string
  try {
    real = realpathSync(file)
    realRoot = realpathSync(root)
  } catch {
    return file
  }
  const realRel = relative(realRoot, real)
  if (realRel.startsWith('..') || isAbsolute(realRel)) return null
  if (/(^|[\\/])\.sspace[\\/]dashboard[\\/]secrets\.json$/i.test(real)) return null
  return real
}

export async function dashboardFile(root: string, path: string, as?: 'json' | 'text'): Promise<DashboardFileResult> {
  const at = Date.now()
  const file = projectFile(root, String(path ?? ''))
  if (!file) return { ok: false, error: `useFile reads files inside the project only, got ${path}`, at, path: String(path) }
  try {
    const info = await stat(file)
    if (info.size > MAX_FILE_BYTES) return { ok: false, error: 'The file is larger than 5 MB.', at, path: file }
    const text = await readFile(file, 'utf8')
    const json = as === 'json' || (as !== 'text' && /\.json$/i.test(file))
    if (!json) return { ok: true, data: text, at, path: file }
    try {
      return { ok: true, data: JSON.parse(text), at, path: file }
    } catch (e) {
      return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`, at, path: file }
    }
  } catch {
    return { ok: false, error: `No file at ${file}`, at, path: file }
  }
}
