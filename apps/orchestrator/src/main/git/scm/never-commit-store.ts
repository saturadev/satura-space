import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join, normalize } from 'node:path'
import {
  ENV_BLOB_DIR,
  NEVER_COMMIT_DIR,
  NEVER_COMMIT_FILE,
  normalizeNeverCommitEntries,
  type EnvSnapshot,
  type NeverCommitFile
} from '@shared/git-scm'
import { ensureSspaceDir } from '../../sspace'
import { getGit } from './git'
import { censusTrack } from '@shared/census'
import { withFileLock } from '../../dashboard/exec-lock'

export { ENV_BLOB_DIR }

export interface NeverCommitData {
  readonly entries: string[]
  readonly snapshots: ReadonlyMap<string, EnvSnapshot>
}

const commonDirs = new Map<string, string>()
censusTrack('never-commit-store.commonDirs', commonDirs)
const sspaceDirs = new Map<string, string>()
censusTrack('never-commit-store.sspaceDirs', sspaceDirs)
const SHA = /^[0-9a-f]{40}$/
export const NEVER_COMMIT_LOCK = '.never-commit.lock'
export const BLOB_GRACE_MS = 60_000
const LOCK_WAIT_S = 10

export type NeverCommitRead =
  | { readonly state: 'missing' }
  | { readonly state: 'ok'; readonly data: NeverCommitData }
  | { readonly state: 'invalid'; readonly error: string }

export async function resolveGitCommonDir(root: string): Promise<string> {
  const cached = commonDirs.get(root)
  if (cached) return cached
  const git = await getGit()
  const result = await git.exec(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    noOptionalLocks: true
  })
  const dir = normalize(result.stdout.trimStart().replace(/[\r\n]+$/, ''))
  commonDirs.set(root, dir)
  return dir
}

export async function resolveNeverCommitDir(root: string): Promise<string> {
  const cached = sspaceDirs.get(root)
  if (cached) return cached
  const commonDir = await resolveGitCommonDir(root)
  let project: string
  if (basename(commonDir) === '.git') {
    project = dirname(commonDir)
  } else {
    const git = await getGit()
    project = normalize(await git.getRepositoryRoot(root))
  }
  const dir = join(project, NEVER_COMMIT_DIR)
  sspaceDirs.set(root, dir)
  return dir
}

export function neverCommitFilePath(sspaceDir: string): string {
  return join(sspaceDir, NEVER_COMMIT_FILE)
}

export function gitBlobSha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}

export function envBlobPath(sspaceDir: string, sha: string): string {
  return join(sspaceDir, ENV_BLOB_DIR, sha)
}

export function parseNeverCommitData(raw: string): NeverCommitData {
  const read = parseNeverCommitForUpdate(raw)
  return read.state === 'ok' ? read.data : { entries: [], snapshots: new Map() }
}

export function parseNeverCommitForUpdate(raw: string): NeverCommitRead {
  const snapshots = new Map<string, EnvSnapshot>()
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  if (!text.trim()) return { state: 'ok', data: { entries: [], snapshots } }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { state: 'invalid', error: (e as Error).message }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { state: 'invalid', error: 'not a JSON object' }
  const o = data as { entries?: unknown; snapshots?: unknown }
  if (!Array.isArray(o.entries)) return { state: 'invalid', error: 'no entries list' }
  const entries = normalizeNeverCommitEntries(o.entries.filter((e): e is string => typeof e === 'string'))
  if (o.snapshots && typeof o.snapshots === 'object' && !Array.isArray(o.snapshots)) {
    const known = new Set(entries)
    for (const [path, value] of Object.entries(o.snapshots)) {
      const s = value as Partial<EnvSnapshot> | null
      if (known.has(path) && s && typeof s.env === 'string' && SHA.test(s.env) && typeof s.base === 'string' && SHA.test(s.base)) {
        snapshots.set(path, { env: s.env, base: s.base })
      }
    }
  }
  return { state: 'ok', data: { entries, snapshots } }
}

export async function readNeverCommitData(sspaceDir: string): Promise<NeverCommitData> {
  const read = await readNeverCommitForUpdate(sspaceDir)
  return read.state === 'ok' ? read.data : { entries: [], snapshots: new Map() }
}

export async function readNeverCommitForUpdate(sspaceDir: string): Promise<NeverCommitRead> {
  let raw: string
  try {
    raw = await readFile(neverCommitFilePath(sspaceDir), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    return { state: 'invalid', error: (e as Error).message }
  }
  return parseNeverCommitForUpdate(raw)
}

export async function updateNeverCommitData(
  sspaceDir: string,
  mutate: (data: NeverCommitData) => Promise<NeverCommitData>
): Promise<NeverCommitData> {
  await ensureSspaceDir(sspaceDir)
  const busy = 'The Env Changes list is busy: another window or agent is changing it. Try again.'
  return withFileLock(join(sspaceDir, NEVER_COMMIT_LOCK), LOCK_WAIT_S, busy, async () => {
    const read = await readNeverCommitForUpdate(sspaceDir)
    if (read.state === 'invalid') {
      throw new Error(`Can't read the Env Changes list ${neverCommitFilePath(sspaceDir)} (${read.error}), so nothing was changed. Fix or delete that file and try again.`)
    }
    const current = read.state === 'ok' ? read.data : { entries: [], snapshots: new Map<string, EnvSnapshot>() }
    return writeNeverCommitData(sspaceDir, await mutate(current))
  })
}

export async function writeSspaceFile(sspaceDir: string, name: string, content: string | Buffer): Promise<void> {
  await ensureSspaceDir(sspaceDir)
  const file = join(sspaceDir, name)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, content)
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

export async function writeEnvBlob(sspaceDir: string, content: Buffer): Promise<string> {
  const sha = gitBlobSha(content)
  const file = envBlobPath(sspaceDir, sha)
  if (await access(file).then(() => true, () => false)) {
    const now = new Date()
    await utimes(file, now, now).catch(() => undefined)
  } else {
    await writeSspaceFile(sspaceDir, join(ENV_BLOB_DIR, sha), content)
  }
  return sha
}

async function dropUnreferencedBlobs(sspaceDir: string, snapshots: ReadonlyMap<string, EnvSnapshot>): Promise<void> {
  const keep = new Set<string>()
  for (const s of snapshots.values()) keep.add(s.env).add(s.base)
  let names: string[]
  try {
    names = await readdir(join(sspaceDir, ENV_BLOB_DIR))
  } catch {
    return
  }
  const cutoff = Date.now() - BLOB_GRACE_MS
  await Promise.all(
    names.filter((n) => SHA.test(n) && !keep.has(n)).map(async (n) => {
      const file = envBlobPath(sspaceDir, n)
      const info = await stat(file).catch(() => undefined)
      if (!info || info.mtimeMs > cutoff) return
      await rm(file, { force: true }).catch(() => undefined)
    })
  )
}

async function writeNeverCommitData(sspaceDir: string, data: NeverCommitData): Promise<NeverCommitData> {
  const entries = normalizeNeverCommitEntries(data.entries)
  const known = new Set(entries)
  const snapshots = new Map([...data.snapshots].filter(([path]) => known.has(path)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const body: NeverCommitFile = { version: 1, entries }
  if (snapshots.size > 0) body.snapshots = Object.fromEntries(snapshots)
  await writeSspaceFile(sspaceDir, NEVER_COMMIT_FILE, `${JSON.stringify(body, null, 2)}\n`)
  await dropUnreferencedBlobs(sspaceDir, snapshots)
  return { entries, snapshots }
}
