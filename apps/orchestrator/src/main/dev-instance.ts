import { execFile } from 'node:child_process'
import { readFileSync, readlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const DEV_INSTANCE_ENV = 'SATURA_DEV_INSTANCE'
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const MAIN_USER_DATA_DIRS = ['satura-space', 'satura-space-dev']

export function parseDevInstanceName(raw: string | undefined): string {
  const name = (raw ?? '').trim().toLowerCase()
  return NAME.test(name) ? name : ''
}

export function devInstanceName(): string {
  return parseDevInstanceName(process.env[DEV_INSTANCE_ENV])
}

const FIXED_SLOTS: Record<string, number> = { alt: 0, t2d: 1, t3d: 2, anim: 3 }
const FIXED_SLOT_COUNT = 4
const DEV_INSTANCE_SLOTS = 32

export function devInstanceSlot(name: string): number {
  if (name in FIXED_SLOTS) return FIXED_SLOTS[name]
  let h = 2166136261
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0
  return FIXED_SLOT_COUNT + (h % (DEV_INSTANCE_SLOTS - FIXED_SLOT_COUNT))
}

export function devInstancePortBase(name: string): number {
  return 12210 + 1000 * devInstanceSlot(name)
}

export function sharedConfigOwner(): string {
  const name = devInstanceName()
  return name ? `dev instance "${name}"` : ''
}

export function foldersInState(state: unknown): string[] {
  if (!state || typeof state !== 'object') return []
  const s = state as { recentFolders?: unknown; session?: { windows?: unknown } }
  const out: string[] = []
  if (Array.isArray(s.recentFolders)) {
    for (const f of s.recentFolders) if (typeof f === 'string' && f) out.push(f)
  }
  const windows = s.session?.windows
  if (Array.isArray(windows)) {
    for (const w of windows) {
      const id = (w as { identity?: { folderPath?: unknown; worktreePath?: unknown } } | null)?.identity
      if (typeof id?.folderPath === 'string' && id.folderPath) out.push(id.folderPath)
      if (typeof id?.worktreePath === 'string' && id.worktreePath) out.push(id.worktreePath)
    }
  }
  return out
}

export function lockOwnerPid(link: string): number | null {
  const m = /-(\d+)$/.exec(link.trim())
  return m ? parseInt(m[1], 10) : null
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function mainAppRunning(userDataDir: string): boolean {
  if (process.platform === 'win32') return true
  try {
    const pid = lockOwnerPid(readlinkSync(join(userDataDir, 'SingletonLock')))
    return pid !== null && pid !== process.pid && alive(pid)
  } catch {
    return false
  }
}

function mainInstanceFolders(appData: string): string[] {
  return MAIN_USER_DATA_DIRS.flatMap((dir) => {
    if (!mainAppRunning(join(appData, dir))) return []
    try {
      return foldersInState(JSON.parse(readFileSync(join(appData, dir, 'satura-space-data.json'), 'utf8')))
    } catch {
      return []
    }
  })
}

function comparable(p: string): string {
  const r = resolve(p)
  return process.platform === 'darwin' || process.platform === 'win32' ? r.toLowerCase() : r
}

export function pathsOverlap(a: string, b: string): boolean {
  const x = comparable(a)
  const y = comparable(b)
  return x === y || x.startsWith(y + sep) || y.startsWith(x + sep)
}

function foreignEditorPid(psOutput: string, projectPath: string, selfPid: number, selfExec = ''): { pid: number; ours: boolean } | null {
  const editors: [number, number, boolean][] = []
  const commands = new Map<number, string>()
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) commands.set(parseInt(m[1], 10), m[3])
    if (!line.includes('Unity.app/Contents/MacOS/Unity')) continue
    if (!line.includes(`-projectPath ${projectPath} `) && !line.endsWith(`-projectPath ${projectPath}`)) continue
    const [pid, ppid] = line.trim().split(/\s+/).map((n) => parseInt(n, 10))
    if (Number.isFinite(pid) && Number.isFinite(ppid)) editors.push([pid, ppid, /AssetImportWorker/.test(line)])
  }
  const pids = new Set(editors.map(([pid]) => pid))
  for (const [pid, ppid, worker] of editors) {
    if (ppid === 1 || ppid === selfPid || pids.has(ppid)) continue
    const parent = commands.get(ppid) ?? ''
    const ours = (!!selfExec && parent.startsWith(selfExec)) || /(^|\/|\()Unity\b/.test(parent) || (worker && !parent)
    return { pid, ours }
  }
  return null
}

async function foreignEditorOn(projectPath: string): Promise<{ pid: number; ours: boolean } | null> {
  if (process.platform === 'win32') return null
  try {
    const r = await execFileAsync('ps', ['-ax', '-o', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 16 * 1024 * 1024
    })
    return foreignEditorPid(r.stdout ?? '', projectPath, process.pid, process.execPath)
  } catch {
    return null
  }
}

const OLD_EDITOR_EXIT_MS = 90_000

export async function devInstanceProjectConflict(
  projectPath: string,
  appData: string
): Promise<string | null> {
  const name = devInstanceName()
  if (!name) return null
  const owned = mainInstanceFolders(appData).find((f) => pathsOverlap(projectPath, f))
  if (owned)
    return `Dev instance "${name}" won't touch ${projectPath}: the main Satura Space is running with ${owned} open or in its recent folders. Quit it there, or use a separate project copy here.`
  const until = Date.now() + OLD_EDITOR_EXIT_MS
  let logged = false
  while (true) {
    const hit = await foreignEditorOn(projectPath)
    if (!hit) return null
    if (!hit.ours || Date.now() > until)
      return `Dev instance "${name}" won't touch ${projectPath}: Unity pid ${hit.pid} belongs to another app.`
    if (!logged) {
      logged = true
      console.log(`[dev-instance] Unity pid ${hit.pid} on ${projectPath} belongs to a previous run of this app; waiting for it to exit`)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}
