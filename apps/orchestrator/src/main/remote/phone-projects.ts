import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import type { NewProjectArgs, NewProjectKind, NewProjectProgress, NewProjectResult } from '@shared/api'
import type { PhoneProjectCreation, PhoneProjectDir, PhoneProjectsHome, PhoneProjectRow, PhoneProjectWorktree } from '@shared/remote-projects'
import { loadState } from '../persistence'
import { isUnityProjectDir } from '../unity/scratchpad-store'
import { cancelCreateProject, checkNewProject, createProject, listEditorsForCreate } from '../unity/project-create'
import { openScope } from '../open-roots'
import { listProjectWorktrees } from '../git/worktrees'
import { SSPACE_DIR } from '../sspace'

export interface PhoneProjectsHost {
  openOnMac(path: string, root: string | null): Promise<{ workspaceId: string; created: boolean; unity: boolean }>
  broadcast(ch: string, args: unknown[]): void
  log(line: string): void
}

const ENTRIES_MAX = 400
const RECENTS_MAX = 20
const HIDDEN = new Set(['Library', 'Applications', '.Trash'])
const WORKTREE_PATH = /^(.+)[\\/]\.sspace[\\/]worktrees[\\/][^\\/]+$/

let host: PhoneProjectsHost | null = null
let creation: PhoneProjectCreation = { active: null, last: null }

export function configurePhoneProjects(h: PhoneProjectsHost): void {
  host = h
}

function log(line: string): void {
  host?.log(`projects: ${line}`)
}

function real(p: string): string {
  let cur = resolve(p)
  const rest: string[] = []
  while (!existsSync(cur)) {
    const up = dirname(cur)
    if (up === cur) return resolve(p)
    rest.unshift(basename(cur))
    cur = up
  }
  try {
    return join(realpathSync(cur), ...rest)
  } catch {
    return resolve(p)
  }
}

function allowed(raw: unknown): string {
  const p = typeof raw === 'string' ? raw.trim() : ''
  if (!p || !isAbsolute(p)) throw new Error('That is not a folder on the desktop')
  return real(p)
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function openPaths(): Set<string> {
  return new Set(openScope().roots.map((r) => real(r)))
}

function row(path: string, open: Set<string>): PhoneProjectRow {
  const exists = isDir(path)
  const name = basename(path) || path
  return { path, name, exists, unity: exists && isUnityProjectDir(path), open: open.has(real(path)), hidden: name.startsWith('.') }
}

async function worktreesOf(root: string, open: Set<string>): Promise<PhoneProjectWorktree[]> {
  if (!isDir(join(root, SSPACE_DIR, 'worktrees'))) return []
  return (await listProjectWorktrees(root))
    .filter((w) => isDir(w.path))
    .map((w) => ({ path: w.path, name: w.name, branch: w.branch, unity: isUnityProjectDir(w.path), open: open.has(real(w.path)) }))
}

async function home(): Promise<PhoneProjectsHome> {
  const h = homedir()
  const settings = loadState().settings
  const defaultFolder = String(settings?.defaultProjectsFolder ?? '').trim()
  const open = openPaths()
  const recents = await Promise.all(
    (loadState().recentFolders ?? [])
      .filter((p): p is string => typeof p === 'string' && isAbsolute(p))
      .slice(0, RECENTS_MAX)
      .map(async (p) => {
        const r = row(p, open)
        return r.exists && !WORKTREE_PATH.test(p) ? { ...r, worktrees: await worktreesOf(p, open) } : r
      })
  )
  const places: { label: string; path: string }[] = [{ label: 'Home', path: h }]
  for (const [label, p] of [
    ['Projects folder', defaultFolder],
    ['Projects', join(h, 'projects')],
    ['Unity Projects', join(h, 'Unity Projects')],
    ['Documents', join(h, 'Documents')],
    ['Desktop', join(h, 'Desktop')]
  ] as const)
    if (p && isDir(p) && !places.some((x) => x.path === p)) places.push({ label, path: p })
  if (process.platform === 'darwin' && isDir('/Volumes')) places.push({ label: 'Drives', path: '/Volumes' })
  const top = parse(h).root
  if (top && !places.some((x) => x.path === top)) places.push({ label: 'Computer', path: top })
  const fallback = recents.find((r) => r.exists)?.path
  return { home: h, defaultFolder: defaultFolder || (fallback ? dirname(fallback) : places[1]?.path ?? h), places, recents }
}

async function browse(raw: unknown): Promise<PhoneProjectDir> {
  const dir = allowed(raw)
  if (!isDir(dir)) throw new Error(`${dir} isn't a folder`)
  const open = openPaths()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (e) {
    throw new Error(`Can't read ${dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`)
  }
  const atHome = dir === real(homedir())
  const byName = (a: string, b: string): number => basename(a).localeCompare(basename(b), undefined, { sensitivity: 'base', numeric: true })
  const dirs = names
    .filter((n) => n !== 'node_modules' && !(atHome && HIDDEN.has(n)))
    .map((n) => join(dir, n))
    .filter(isDir)
  const dot = (p: string): boolean => basename(p).startsWith('.')
  const entries = [...dirs.filter((p) => !dot(p)).sort(byName), ...dirs.filter(dot).sort(byName)]
  const top = dirname(dir) === dir
  return {
    dir,
    name: basename(dir) || dir,
    parent: top ? null : dirname(dir),
    unity: isUnityProjectDir(dir),
    open: open.has(dir),
    worktrees: await worktreesOf(dir, open),
    entries: entries.slice(0, ENTRIES_MAX).map((p) => row(p, open)),
    more: Math.max(0, entries.length - ENTRIES_MAX)
  }
}

function cleanArgs(raw: unknown): NewProjectArgs {
  const r = (raw ?? {}) as Partial<NewProjectArgs>
  const kind: NewProjectKind = r.kind === '2d' ? '2d' : '3d'
  return { version: String(r.version ?? '').slice(0, 40), kind, parent: allowed(r.parent), name: String(r.name ?? '').trim().slice(0, 120) }
}

function progress(p: NewProjectProgress): void {
  if (!creation.active) return
  creation = { ...creation, active: { ...creation.active, progress: { phase: String(p.phase ?? ''), pct: Number(p.pct) || 0 } } }
  host?.broadcast('remote:projects:creation', [creation])
}

async function create(raw: unknown): Promise<PhoneProjectCreation> {
  if (creation.active) throw new Error(`${creation.active.name} is being created already`)
  const args = cleanArgs(raw)
  const problem = checkNewProject(args.parent, args.name)
  if (problem) throw new Error(problem)
  creation = { active: { name: args.name, version: args.version, kind: args.kind, parent: args.parent, startedAt: Date.now(), progress: null }, last: null }
  log(`the phone creates ${args.kind.toUpperCase()} project ${args.name} in ${args.parent} with Unity ${args.version}`)
  host?.broadcast('remote:projects:creation', [creation])
  void createProject(args, progress)
    .catch((e: unknown): NewProjectResult => ({ ok: false, error: (e as Error)?.message || 'Project creation failed.' }))
    .then(async (res) => {
      let opened: { workspaceId: string } | null = null
      let error = res.ok ? '' : res.error
      if (res.ok) {
        try {
          opened = await (host?.openOnMac(res.path, null) ?? Promise.reject(new Error('No Satura window is open')))
        } catch (e) {
          error = `Made ${res.path}, but couldn't open it on the desktop: ${(e as Error).message}`
        }
      }
      creation = { active: null, last: { at: Date.now(), ok: res.ok, path: res.ok ? res.path : null, error: error || null, cancelled: !res.ok && !!res.cancelled, workspaceId: opened?.workspaceId ?? null } }
      log(res.ok ? `created ${res.path}${opened ? `, open as workspace ${opened.workspaceId}` : ''}` : `creating ${args.name} ${res.cancelled ? 'was cancelled' : `failed: ${error.split('\n')[0]}`}`)
      host?.broadcast('remote:projects:creation', [creation])
    })
  return creation
}

async function open(raw: unknown): Promise<{ workspaceId: string; created: boolean; unity: boolean; path: string }> {
  const path = allowed(raw)
  if (!isDir(path)) throw new Error(`${path} isn't a folder`)
  if (!host) throw new Error('No Satura window is open')
  const root = WORKTREE_PATH.exec(path)?.[1] ?? null
  const r = await host.openOnMac(path, root)
  log(`the phone ${r.created ? 'opened' : 'switched to'} ${root ? `worktree ${basename(path)} of ${root}` : path} (workspace ${r.workspaceId}${r.unity ? ', Unity' : ''})`)
  return { ...r, path }
}

export async function phoneProjectsInvoke(ch: string, args: unknown[]): Promise<unknown> {
  const a = (args[0] ?? {}) as Record<string, unknown>
  if (ch === 'remote:projects:home') return home()
  if (ch === 'remote:projects:browse') return browse(a.dir)
  if (ch === 'remote:projects:editors') return listEditorsForCreate()
  if (ch === 'remote:projects:check') return { problem: checkNewProject(allowed(a.parent), String(a.name ?? '')) }
  if (ch === 'remote:projects:create') return create(a)
  if (ch === 'remote:projects:creation') return creation
  if (ch === 'remote:projects:cancel') {
    if (creation.active) {
      log(`the phone cancels creating ${creation.active.name}`)
      cancelCreateProject()
    }
    return creation
  }
  if (ch === 'remote:projects:open') return open(a.path)
  return undefined
}
