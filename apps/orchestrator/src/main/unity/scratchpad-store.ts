import { constants as fsConstants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { SSPACE_DIR, ensureSspaceDir } from '../sspace'
import { killProcessesUnderPath } from '../git/kill-cwd-processes'
import { trashPath } from '../safe-fs'
import {
  SCRATCHPADS_REL,
  SCRATCHPAD_META_FILE,
  cleanScratchpadName,
  isScratchpadPath,
  scratchpadParentProject
} from '@shared/scratchpads'

const ENGINE_PKG_NAME = 'com.saturaspace.engine'
const WIN_RM_RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])
const WIN_RM_ATTEMPTS = 5
const WIN_RM_BACKOFF_MS = 1000
const PACKAGE_FILES = new Set(['manifest.json', 'packages-lock.json'])
const GUID_REF = /guid: ([0-9a-f]{32})/g
const LINKED_SKIP_EXT = new Set(['.unity', '.cs', '.asmdef', '.asmref', '.dll'])
const LINKED_MAX = 200

export interface ScratchpadMeta {
  id: string
  name: string
  createdAt: number
  path: string
}

export function canonicalProject(projectPath: string): string {
  const raw = (projectPath ?? '').trim().replace(/[\\/]+$/, '')
  if (!raw) return ''
  const parent = scratchpadParentProject(raw) ?? raw
  try {
    return realpathSync(parent)
  } catch {
    return resolve(parent)
  }
}

export function isUnityProjectDir(p: string): boolean {
  return (
    !!p &&
    existsSync(join(p, 'Assets')) &&
    existsSync(join(p, 'ProjectSettings', 'ProjectVersion.txt'))
  )
}

export function readScratchpadName(dir: string): string | null {
  if (!isScratchpadPath(dir)) return null
  const id = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return readMeta(dir, id)?.name ?? null
}

export function editorNotRunningError(projectPath: string): string {
  if (!isScratchpadPath(projectPath)) return 'No Unity editor is running for this project. Open its Unity panel first.'
  const name = readScratchpadName(projectPath)
  return `Scratchpad ${name ? `“${name}” ` : ''}is not running. Start it from the Scratchpads panel.`
}

export function scratchpadsRoot(projectPath: string): string {
  return join(projectPath, SCRATCHPADS_REL)
}

function readMeta(dir: string, id: string): ScratchpadMeta | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, SCRATCHPAD_META_FILE), 'utf8')) as Partial<ScratchpadMeta>
    const name = cleanScratchpadName(raw.name) || id
    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : statSync(dir).birthtimeMs
    return { id, name, createdAt, path: dir }
  } catch {
    return null
  }
}

export async function listScratchpads(projectPath: string): Promise<ScratchpadMeta[]> {
  const root = scratchpadsRoot(projectPath)
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const out: ScratchpadMeta[] = []
  for (const id of names) {
    const meta = readMeta(join(root, id), id)
    if (meta) out.push(meta)
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name))
}

export function findScratchpad(metas: ScratchpadMeta[], ref: unknown): ScratchpadMeta | null {
  const want = cleanScratchpadName(ref)
  if (!want) return null
  const byId = metas.find((m) => m.id === want)
  if (byId) return byId
  const lower = want.toLowerCase()
  return metas.find((m) => m.name.toLowerCase() === lower) ?? null
}

function defaultName(metas: ScratchpadMeta[]): string {
  const taken = new Set(metas.map((m) => m.name.toLowerCase()))
  for (let n = 1; ; n++) {
    const candidate = `Scratchpad ${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

function nameTaken(metas: ScratchpadMeta[], name: string, exceptId?: string): boolean {
  const lower = name.toLowerCase()
  return metas.some((m) => m.id !== exceptId && (m.name.toLowerCase() === lower || m.id === name))
}

function newId(metas: ScratchpadMeta[]): string {
  const ids = new Set(metas.map((m) => m.id))
  for (;;) {
    const id = `sp-${randomBytes(3).toString('hex')}`
    if (!ids.has(id)) return id
  }
}

function absolutizeFileRef(value: unknown, packagesDir: string): unknown {
  if (typeof value !== 'string' || !value.startsWith('file:')) return value
  const target = value.slice('file:'.length)
  if (!target || isAbsolute(target)) return value
  return `file:${resolve(packagesDir, target).replace(/\\/g, '/')}`
}

async function copyPackages(projectPath: string, dir: string): Promise<void> {
  const srcDir = join(projectPath, 'Packages')
  const dstDir = join(dir, 'Packages')
  await mkdir(dstDir, { recursive: true })

  const manifest = JSON.parse(await readFile(join(srcDir, 'manifest.json'), 'utf8')) as {
    dependencies?: Record<string, unknown>
  }
  for (const [name, value] of Object.entries(manifest.dependencies ?? {}))
    manifest.dependencies![name] = absolutizeFileRef(value, srcDir)
  await writeFile(join(dstDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  const lockPath = join(srcDir, 'packages-lock.json')
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
        dependencies?: Record<string, { version?: unknown }>
      }
      for (const entry of Object.values(lock.dependencies ?? {}))
        if (entry && typeof entry === 'object') entry.version = absolutizeFileRef(entry.version, srcDir)
      await writeFile(join(dstDir, 'packages-lock.json'), JSON.stringify(lock, null, 2) + '\n')
    } catch {
    }
  }

  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || PACKAGE_FILES.has(entry.name)) continue
    if (entry.name === ENGINE_PKG_NAME || entry.name.startsWith(`${ENGINE_PKG_NAME}.`)) continue
    if (entry.name.endsWith('~') || entry.name.startsWith('.')) continue
    await cp(join(srcDir, entry.name), join(dstDir, entry.name), {
      recursive: true,
      mode: fsConstants.COPYFILE_FICLONE
    })
  }
}

async function metaGuids(dir: string, out: Map<string, string>): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!e.name.startsWith('.') && !e.name.endsWith('~')) await metaGuids(p, out)
      continue
    }
    if (!e.name.endsWith('.meta')) continue
    const m = /^guid: ([0-9a-f]{32})/m.exec(await readFile(p, 'utf8').catch(() => ''))
    if (m) out.set(m[1], p.slice(0, -'.meta'.length))
  }
}

function guidRefs(text: string): string[] {
  return [...text.matchAll(GUID_REF)].map((m) => m[1])
}

async function copySettingsAssets(projectPath: string, dir: string): Promise<void> {
  const settingsDir = join(projectPath, 'ProjectSettings')
  const queue: string[] = []
  for (const name of await readdir(settingsDir)) {
    if (!name.endsWith('.asset')) continue
    queue.push(...guidRefs(await readFile(join(settingsDir, name), 'utf8').catch(() => '')))
  }
  if (!queue.length) return
  const byGuid = new Map<string, string>()
  await metaGuids(join(projectPath, 'Assets'), byGuid)
  const seen = new Set<string>()
  let copied = 0
  while (queue.length && copied < LINKED_MAX) {
    const guid = queue.shift()!
    if (seen.has(guid)) continue
    seen.add(guid)
    const src = byGuid.get(guid)
    if (!src || LINKED_SKIP_EXT.has(extname(src).toLowerCase())) continue
    try {
      if (!statSync(src).isFile()) continue
    } catch {
      continue
    }
    const dst = join(dir, relative(projectPath, src))
    await mkdir(dirname(dst), { recursive: true })
    await cp(src, dst, { mode: fsConstants.COPYFILE_FICLONE })
    await cp(`${src}.meta`, `${dst}.meta`, { mode: fsConstants.COPYFILE_FICLONE })
    copied++
    const head = await readFile(src, 'utf8').catch(() => '')
    if (head.startsWith('%YAML')) queue.push(...guidRefs(head))
  }
  console.log(`[scratchpad] copied ${copied} asset(s) the project settings use`)
}

export async function createScratchpad(projectPath: string, rawName?: unknown): Promise<ScratchpadMeta> {
  if (!isUnityProjectDir(projectPath)) throw new Error(`Not a Unity project: ${projectPath}`)
  const metas = await listScratchpads(projectPath)
  const name = cleanScratchpadName(rawName) || defaultName(metas)
  if (nameTaken(metas, name)) throw new Error(`A scratchpad named “${name}” already exists.`)
  const id = newId(metas)
  const dir = join(scratchpadsRoot(projectPath), id)
  try {
    await ensureSspaceDir(join(projectPath, SSPACE_DIR))
    await mkdir(join(dir, 'Assets', 'Scratchpad'), { recursive: true })
    await writeFile(
      join(dir, 'Assets', 'Scratchpad', 'README.md'),
      `# ${name}\n\nScratchpad of ${projectPath}. Same Unity version, packages and project settings, with the assets those settings use (render pipeline, input actions). The rest of Assets starts empty.\n`
    )
    await cp(join(projectPath, 'ProjectSettings'), join(dir, 'ProjectSettings'), {
      recursive: true,
      mode: fsConstants.COPYFILE_FICLONE
    })
    await copyPackages(projectPath, dir)
    await copySettingsAssets(projectPath, dir)
    const meta = { id, name, createdAt: Date.now() }
    await writeFile(join(dir, SCRATCHPAD_META_FILE), JSON.stringify(meta, null, 2) + '\n')
    return { ...meta, path: dir }
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}

export async function renameScratchpad(
  projectPath: string,
  ref: unknown,
  rawName: unknown
): Promise<ScratchpadMeta> {
  const metas = await listScratchpads(projectPath)
  const meta = findScratchpad(metas, ref)
  if (!meta) throw new Error(`No scratchpad “${String(ref ?? '')}”.`)
  const name = cleanScratchpadName(rawName)
  if (!name) throw new Error('The new name is empty.')
  if (nameTaken(metas, name, meta.id)) throw new Error(`A scratchpad named “${name}” already exists.`)
  const next = { id: meta.id, name, createdAt: meta.createdAt }
  await writeFile(join(meta.path, SCRATCHPAD_META_FILE), JSON.stringify(next, null, 2) + '\n')
  return { ...next, path: meta.path }
}

export const SCRATCHPAD_REGENERABLE_DIRS = ['Library', 'Temp', 'Logs', 'obj'] as const

async function withWinRetry(meta: ScratchpadMeta, what: string, op: () => Promise<void>): Promise<void> {
  if (process.platform !== 'win32') return op()
  for (let attempt = 1; ; attempt++) {
    try {
      await op()
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if ((code && !WIN_RM_RETRY_CODES.has(code)) || attempt >= WIN_RM_ATTEMPTS) throw e
      const killed = await killProcessesUnderPath(meta.path).catch(() => 0)
      console.log(
        `[scratchpad] ${what} ${meta.id} hit ${code || (e as Error).message} (attempt ${attempt}), killed ${killed} process(es) inside it, retrying`
      )
      await new Promise((r) => setTimeout(r, WIN_RM_BACKOFF_MS * attempt))
    }
  }
}

export async function deleteScratchpadDir(
  projectPath: string,
  meta: ScratchpadMeta,
  trash: (path: string) => Promise<void> = trashPath
): Promise<void> {
  const rel = relative(scratchpadsRoot(projectPath), meta.path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || /[\\/]/.test(rel))
    throw new Error(`Refusing to delete a folder outside the scratchpads folder: ${meta.path}`)
  for (const name of SCRATCHPAD_REGENERABLE_DIRS) {
    const dir = join(meta.path, name)
    await withWinRetry(meta, `delete ${name} of`, () => rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }))
  }
  if (!existsSync(meta.path)) return
  await withWinRetry(meta, 'trash', () => trash(meta.path))
  console.log(`[scratchpad] moved ${meta.path} to the Trash`)
}
