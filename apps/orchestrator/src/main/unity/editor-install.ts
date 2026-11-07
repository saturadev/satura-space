import { app } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EditorVersionFacts, UnityInstall } from '@shared/unity/lifecycle'

const VERSION_RE = /^\d+\.\d+\.\d+[abfpx]\d+$/
const REVISION_RE = /^[0-9a-f]{12}$/
const SAFE_VERSION_RE = /^\d[\w.+-]*$/
const STALE_ROW_MS = 30 * 60_000

function devEnv(name: string): string {
  if (app?.isPackaged !== false) return ''
  return (process.env[name] ?? '').trim()
}

export function hubDataDir(): string {
  if (process.platform === 'win32') return join(process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'), 'UnityHub')
  return join(homedir(), 'Library', 'Application Support', 'UnityHub')
}

export function unityHubEditorRoot(): string {
  const dev = devEnv('SATURA_DEV_UNITY_EDITORS')
  if (dev) return dev
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
    return join(programFiles, 'Unity', 'Hub', 'Editor')
  }
  return '/Applications/Unity/Hub/Editor'
}

function executableIn(root: string, version: string): string {
  if (!SAFE_VERSION_RE.test(version)) return ''
  return process.platform === 'win32'
    ? join(root, version, 'Editor', 'Unity.exe')
    : join(root, version, 'Unity.app', 'Contents', 'MacOS', 'Unity')
}

export function unityExecutableFor(version: string): string {
  return executableIn(unityHubEditorRoot(), version)
}

function secondaryRoot(): string {
  if (devEnv('SATURA_DEV_UNITY_EDITORS')) return ''
  try {
    const raw = JSON.parse(readFileSync(join(hubDataDir(), 'secondaryInstallPath.json'), 'utf8')) as unknown
    return typeof raw === 'string' ? raw.trim() : ''
  } catch {
    return ''
  }
}

export function editorRoots(): string[] {
  const roots = [unityHubEditorRoot(), secondaryRoot()].filter((r) => !!r)
  return [...new Set(roots)]
}

export function hubInstallDb(): string {
  return devEnv('SATURA_DEV_HUB_INSTALL_STATE') || join(hubDataDir(), 'install-state', 'install-state.db')
}

export function readProjectVersion(projectPath: string): { version: string; revision: string } {
  try {
    const txt = readFileSync(join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8')
    const raw = /^m_EditorVersion:\s*(\S+)/m.exec(txt)?.[1] ?? ''
    const version = SAFE_VERSION_RE.test(raw) ? raw : ''
    const revision = /^m_EditorVersionWithRevision:\s*\S+\s*\(([0-9a-f]+)\)/m.exec(txt)?.[1] ?? ''
    return { version, revision }
  } catch {
    return { version: '', revision: '' }
  }
}

export function installedEditorsIn(roots: string[]): string[] {
  const out = new Set<string>()
  for (const root of roots) {
    try {
      for (const d of readdirSync(root, { withFileTypes: true }))
        if ((d.isDirectory() || d.isSymbolicLink()) && existsSync(executableIn(root, d.name))) out.add(d.name)
    } catch {
    }
  }
  return [...out].sort()
}

export function editorBinaryIn(roots: string[], version: string): string | null {
  if (!version) return null
  for (const root of roots) {
    const p = executableIn(root, version)
    if (existsSync(p)) return p
  }
  return null
}

export function readHubInstall(dbPath: string, version: string, now = Date.now()): UnityInstall | null {
  if (!version || !existsSync(dbPath)) return null
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const fresh = now - STALE_ROW_MS
    const inst = db.prepare('SELECT phase, updated_at FROM installs WHERE version = ?').get(version) as
      | { phase: string; updated_at: number }
      | undefined
    if (inst && Number(inst.updated_at) >= fresh)
      return { state: inst.phase === 'queued' ? 'queued' : 'installing', pct: -1 }
    const dl = db
      .prepare(
        "SELECT state, bytes_total, bytes_done, updated_at FROM downloads WHERE version = ? AND state IN ('queued', 'downloading') ORDER BY updated_at DESC LIMIT 1"
      )
      .get(version) as { state: string; bytes_total: number; bytes_done: number; updated_at: number } | undefined
    if (!dl || Number(dl.updated_at) < fresh) return null
    const total = Number(dl.bytes_total) || 0
    const pct = total > 0 ? Math.min(100, (Number(dl.bytes_done) / total) * 100) : -1
    return { state: dl.state === 'queued' ? 'queued' : 'downloading', pct }
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
    }
  }
}

export function versionFactsFor(projectPath: string, roots: string[], dbPath: string, now = Date.now()): EditorVersionFacts {
  const { version, revision } = readProjectVersion(projectPath)
  const editors = installedEditorsIn(roots)
  if (!version) return { version, revision, installed: false, editors, install: null }
  const install = readHubInstall(dbPath, version, now)
  const present = editorBinaryIn(roots, version) !== null
  return { version, revision, installed: present && !install, editors: editors.filter((e) => e !== version || !install), install }
}

export function editorVersionFacts(projectPath: string): EditorVersionFacts {
  return versionFactsFor(projectPath, editorRoots(), hubInstallDb())
}

export function editorBinary(version: string): string | null {
  return editorBinaryIn(editorRoots(), version)
}

export function hubInstallLink(version: string, revision: string): string | null {
  if (!VERSION_RE.test(version)) return null
  return REVISION_RE.test(revision) ? `unityhub://${version}/${revision}` : `unityhub://${version}`
}
