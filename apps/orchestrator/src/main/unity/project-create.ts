import { app, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createGunzip } from 'node:zlib'
import type {
  NewProjectArgs,
  NewProjectKind,
  NewProjectProgress,
  NewProjectResult,
  UnityEditorForCreate
} from '@shared/api'
import { trackEditorStatus } from './launch-progress'
import { assignToKillJob } from './shared-surface'
import { unityExecutableFor, unityHubEditorRoot } from './editor-install'
import { isCreateProjectCommand, processInfoSync } from './unity-process-match'
import { isFinishedProject, shouldRemovePartialProject } from './project-create-marker'
import { trashPath } from '../safe-fs'

const TEMPLATE_PACKAGES: Record<NewProjectKind, string[]> = {
  '2d': ['com.unity.template.universal-2d'],
  '3d': ['com.unity.template.urp-blank']
}
const INVALID_NAME = /[\\/:*?"<>|\x00-\x1f]/
const MAX_NAME = 64

const templateNames = new Map<string, Promise<string | null>>()
const cancelRequested = new WeakSet<object>()
let active: { proc: ChildProcess; cancelled: boolean; target: string; existed: boolean } | null = null

interface PendingCreate {
  pid: number
  target: string
  existed: boolean
}

function markerPath(): string {
  return join(app.getPath('userData'), 'project-create.json')
}

function writeMarker(m: PendingCreate): void {
  try {
    writeFileSync(markerPath(), JSON.stringify(m))
  } catch (e) {
    console.log(`[unity] could not write the project-create marker: ${(e as Error).message}`)
  }
}

function clearMarker(): void {
  rmSync(markerPath(), { force: true })
}


async function trashPartialProject(m: { existed?: unknown; target?: unknown }): Promise<boolean> {
  if (!shouldRemovePartialProject(m)) return true
  const target = m.target as string
  try {
    await trashPath(target)
    console.log(`[unity] moved the unfinished project ${target} to the Trash`)
    return true
  } catch (e) {
    console.log(`[unity] could not move the unfinished project ${target} to the Trash: ${(e as Error).message}`)
    return false
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killPidAndWait(pid: number, timeoutMs = 3000): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return
  }
  const pause = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 50)
}

function isCreateProcess(pid: number, target: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return false
  return isCreateProjectCommand(processInfoSync(pid), target)
}

export async function recoverInterruptedProjectCreation(): Promise<void> {
  let m: Partial<PendingCreate>
  try {
    m = JSON.parse(readFileSync(markerPath(), 'utf8')) as Partial<PendingCreate>
  } catch {
    return
  }
  if (!m || typeof m !== 'object') {
    clearMarker()
    return
  }
  console.log(`[unity] cleaning up an interrupted project creation: ${String(m.target)} (existed before: ${String(m.existed)})`)
  if (typeof m.pid === 'number' && typeof m.target === 'string') {
    if (isCreateProcess(m.pid, m.target)) killPidAndWait(m.pid)
    else if (isAlive(m.pid)) console.log(`[unity] pid ${m.pid} is not the Unity that was creating ${m.target}; left it alone`)
  }
  if (await trashPartialProject(m)) clearMarker()
}

export async function abortProjectCreationOnQuit(): Promise<void> {
  if (!active) return
  const { proc, target, existed } = active
  active.cancelled = true
  active = null
  if (proc.pid) killPidAndWait(proc.pid)
  if (await trashPartialProject({ target, existed })) clearMarker()
}

export function killProjectCreationNow(): void {
  if (!active) return
  const { proc } = active
  active.cancelled = true
  active = null
  if (proc.pid) killPidAndWait(proc.pid)
}

function expandHome(p: string): string {
  const t = p.trim()
  if (t === '~') return homedir()
  if (t.startsWith('~/') || t.startsWith('~\\')) return join(homedir(), t.slice(2))
  return t
}

function templatesDir(version: string): string {
  const root = join(unityHubEditorRoot(), version)
  return process.platform === 'win32'
    ? join(root, 'Editor', 'Data', 'Resources', 'PackageManager', 'ProjectTemplates')
    : join(root, 'Unity.app', 'Contents', 'Resources', 'PackageManager', 'ProjectTemplates')
}

function readTemplateName(tgz: string): Promise<string | null> {
  return new Promise((done) => {
    const input = createReadStream(tgz)
    const gunzip = createGunzip()
    let buf = Buffer.alloc(0)
    let skip = 0
    let want: number | null = null
    let settled = false
    const finish = (name: string | null): void => {
      if (settled) return
      settled = true
      input.destroy()
      gunzip.destroy()
      done(name)
    }
    gunzip.on('data', (chunk: Buffer) => {
      if (settled) return
      if (skip >= chunk.length) {
        skip -= chunk.length
        return
      }
      buf = Buffer.concat([buf, skip ? chunk.subarray(skip) : chunk])
      skip = 0
      for (;;) {
        if (want !== null) {
          if (buf.length < want) return
          try {
            const pkg = JSON.parse(buf.subarray(0, want).toString('utf8')) as { name?: unknown }
            finish(typeof pkg.name === 'string' ? pkg.name : null)
          } catch {
            finish(null)
          }
          return
        }
        if (buf.length < 512) return
        const header = buf.subarray(0, 512)
        if (header.every((b) => b === 0)) return finish(null)
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
        const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8)
        const padded = Math.ceil(size / 512) * 512
        buf = buf.subarray(512)
        if (name === 'package/package.json') {
          want = size
          continue
        }
        if (buf.length >= padded) {
          buf = buf.subarray(padded)
          continue
        }
        skip = padded - buf.length
        buf = Buffer.alloc(0)
        return
      }
    })
    gunzip.on('end', () => finish(null))
    gunzip.on('error', () => finish(null))
    input.on('error', () => finish(null))
    input.pipe(gunzip)
  })
}

function templateName(tgz: string): Promise<string | null> {
  let key = tgz
  try {
    const st = statSync(tgz)
    key = `${tgz}:${st.size}:${st.mtimeMs}`
  } catch {
    return Promise.resolve(null)
  }
  let p = templateNames.get(key)
  if (!p) {
    p = readTemplateName(tgz)
    templateNames.set(key, p)
  }
  return p
}

async function editorTemplates(version: string): Promise<Partial<Record<NewProjectKind, string>>> {
  const dir = templatesDir(version)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('com.unity.template.') && f.endsWith('.tgz'))
  } catch {
    return {}
  }
  const names = await Promise.all(files.map((f) => templateName(join(dir, f))))
  const out: Partial<Record<NewProjectKind, string>> = {}
  for (const kind of Object.keys(TEMPLATE_PACKAGES) as NewProjectKind[]) {
    const i = names.findIndex((n) => n !== null && TEMPLATE_PACKAGES[kind].includes(n))
    if (i >= 0) out[kind] = join(dir, files[i])
  }
  return out
}

function versionKey(v: string): number[] {
  const m = /^(\d+)\.(\d+)\.(\d+)([abfp]?)(\d*)/.exec(v)
  if (!m) return [0]
  const stage = { a: 0, b: 1, f: 3, p: 4 }[m[4] as 'a' | 'b' | 'f' | 'p'] ?? 2
  return [+m[1], +m[2], +m[3], stage, +(m[5] || 0)]
}

function compareVersionsDesc(a: string, b: string): number {
  const ka = versionKey(a)
  const kb = versionKey(b)
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (kb[i] ?? 0) - (ka[i] ?? 0)
    if (d) return d
  }
  return b.localeCompare(a)
}

export async function listEditorsForCreate(): Promise<{ editors: UnityEditorForCreate[]; home: string }> {
  let versions: string[] = []
  try {
    versions = readdirSync(unityHubEditorRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(unityExecutableFor(d.name)))
      .map((d) => d.name)
  } catch {
    versions = []
  }
  versions.sort(compareVersionsDesc)
  const editors = await Promise.all(
    versions.map(async (version) => {
      const t = await editorTemplates(version)
      return { version, kinds: (Object.keys(t) as NewProjectKind[]).sort() }
    })
  )
  return { editors, home: homedir() }
}

export function checkNewProject(parent: string, name: string): string | null {
  const n = name.trim()
  if (!n) return 'Give the project a name.'
  if (INVALID_NAME.test(n) || n.startsWith('.') || n.length > MAX_NAME)
    return 'Use letters, numbers, spaces, dashes or dots in the name.'
  const dir = expandHome(parent)
  if (!dir) return 'Pick a folder for the project.'
  try {
    if (!statSync(dir).isDirectory()) return `${parent} isn't a folder.`
  } catch {
    return `${parent} doesn't exist.`
  }
  const target = resolve(dir, n)
  if (existsSync(target)) return `${n} already exists in ${parent}. Pick another name.`
  try {
    mkdirSync(target)
    rmdirSync(target)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return `You can't create folders in ${parent}.`
    if (code === 'ENAMETOOLONG') return 'That name is too long for a folder.'
    return `Your system won't allow a folder named ${n}.`
  }
  return null
}

function logErrors(logPath: string): string {
  let lines: string[]
  try {
    lines = readFileSync(logPath, 'utf8').split(/\r?\n/)
  } catch {
    return ''
  }
  const hits = lines.filter((l) =>
    /: error CS\d+|No valid Unity Editor license|Aborting batchmode|\bFatal error\b|Couldn't|Failed to|\w*Exception: /i.test(l)
  )
  const pick = hits.length ? hits : lines.filter((l) => l.trim()).slice(-6)
  return [...new Set(pick.map((l) => l.trim()))].slice(0, 6).join('\n')
}

export async function createProject(
  args: NewProjectArgs,
  onProgress: (p: NewProjectProgress) => void
): Promise<NewProjectResult> {
  if (active) return { ok: false, error: 'A project is already being created.' }
  const problem = checkNewProject(args.parent, args.name)
  if (problem) return { ok: false, error: problem }
  const editor = unityExecutableFor(args.version)
  if (!existsSync(editor)) return { ok: false, error: `Unity ${args.version} isn't installed.` }
  const template = (await editorTemplates(args.version))[args.kind]
  if (!template)
    return {
      ok: false,
      error: `Unity ${args.version} has no ${args.kind.toUpperCase()} URP template. Pick another version or add it in Unity Hub.`
    }

  const target = resolve(expandHome(args.parent), args.name.trim())
  const existed = existsSync(target)
  const logPath = join(tmpdir(), `satura-create-${Date.now()}.log`)
  console.log(`[unity] creating ${args.kind} project ${target} with ${args.version}`)
  onProgress({ phase: 'Unpacking the template…', pct: 5 })

  const proc = spawn(
    editor,
    ['-batchmode', '-quit', '-createProject', target, '-cloneFromTemplate', template, '-logFile', logPath],
    { stdio: 'ignore' }
  )
  assignToKillJob(proc.pid)
  const job = { proc, cancelled: false, target, existed }
  active = job
  if (proc.pid) writeMarker({ pid: proc.pid, target, existed })
  const stopTracking = trackEditorStatus(logPath, (e) => {
    if (e.kind === 'loading' && e.phase) onProgress({ phase: e.phase, pct: e.pct })
  })

  const code = await new Promise<number | null>((done) => {
    proc.once('exit', (c) => done(c))
    proc.once('error', () => done(-1))
  })
  stopTracking()
  const quitAbort = job.cancelled && active !== job && !cancelRequested.has(job)
  if (active === job) active = null
  if (!quitAbort) clearMarker()

  if (job.cancelled) {
    if (!quitAbort && !existed && existsSync(target)) await shell.trashItem(target).catch(() => {})
    console.log(`[unity] project creation cancelled: ${target}`)
    return { ok: false, cancelled: true, error: 'Cancelled.' }
  }
  if (code === 0 && isFinishedProject(target)) {
    console.log(`[unity] created project ${target}`)
    onProgress({ phase: 'Done', pct: 100 })
    return { ok: true, path: target }
  }
  if (!existed && existsSync(target) && !isFinishedProject(target)) await shell.trashItem(target).catch(() => {})
  const detail = logErrors(logPath)
  console.log(`[unity] project creation failed (exit ${code}): ${detail}`)
  return {
    ok: false,
    error: `Unity couldn't create the project (exit code ${code}).${detail ? `\n${detail}` : ''}`
  }
}

export function cancelCreateProject(): void {
  if (!active) return
  cancelRequested.add(active)
  active.cancelled = true
  active.proc.kill()
}
