import { app } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { copyFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  SCHEMA_VERSION,
  type PersistedState,
  type Settings
} from '@shared/types'
import type { PersistedSession, WindowSnapshot } from '@shared/api'

const SAVE_DEBOUNCE_MS = 300
const BACKUP_COUNT = 5
const BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000

let cache: PersistedState | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null
let pendingWrite: Promise<void> = Promise.resolve()
let flushGeneration = 0

function statePath(): string {
  return join(app.getPath('userData'), 'satura-space-data.json')
}

function backupPath(index: number): string {
  return `${statePath()}.bak.${index}`
}

function serialize(): string {
  return JSON.stringify(cache, null, 2)
}

function parseFile(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function legacySession(raw: Record<string, unknown>): PersistedSession | null {
  const legacy = raw.restoreSession as { windows?: WindowSnapshot[] } | null | undefined
  return Array.isArray(legacy?.windows) && legacy.windows.length > 0
    ? { windows: legacy.windows }
    : null
}

function migrate(raw: Record<string, unknown> | null): PersistedState {
  if (!raw) return structuredClone(DEFAULT_STATE)
  const session = raw.session as PersistedSession | null | undefined
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { ...DEFAULT_SETTINGS, ...((raw.settings as Partial<Settings> | undefined) ?? {}) },
    recentFolders: Array.isArray(raw.recentFolders) ? (raw.recentFolders as string[]) : [],
    auth: (raw.auth as PersistedState['auth']) ?? null,
    session: Array.isArray(session?.windows) ? session : legacySession(raw)
  }
}

function restoreFromBackup(): Record<string, unknown> | null {
  for (let i = 0; i < BACKUP_COUNT; i++) {
    const candidate = backupPath(i)
    if (!existsSync(candidate)) continue
    const parsed = parseFile(candidate)
    if (!parsed) continue
    try {
      copyFileSync(candidate, statePath())
      console.warn(`[persist] recovered state from backup ${candidate}`)
    } catch {}
    return parsed
  }
  return null
}

export function loadState(): PersistedState {
  if (cache) return cache
  const file = statePath()
  if (!existsSync(file)) {
    cache = migrate(null)
    return cache
  }
  let raw = parseFile(file)
  if (!raw) {
    console.error('[persist] state file unreadable, trying backups')
    raw = restoreFromBackup()
  }
  cache = migrate(raw)
  return cache
}

function shouldRotateBackups(): boolean {
  try {
    const age = Date.now() - statSync(backupPath(0)).mtimeMs
    return age >= BACKUP_MIN_INTERVAL_MS
  } catch {
    return true
  }
}

async function rotateBackupsAsync(): Promise<void> {
  if (!shouldRotateBackups()) return
  for (let i = BACKUP_COUNT - 2; i >= 0; i--) {
    try {
      await rename(backupPath(i), backupPath(i + 1))
    } catch {}
  }
  try {
    await copyFile(statePath(), backupPath(0))
  } catch {}
}

function rotateBackupsSync(): void {
  if (!shouldRotateBackups()) return
  for (let i = BACKUP_COUNT - 2; i >= 0; i--) {
    try {
      renameSync(backupPath(i), backupPath(i + 1))
    } catch {}
  }
  try {
    copyFileSync(statePath(), backupPath(0))
  } catch {}
}

function tempPath(file: string): string {
  return `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
}

async function writeToDiskAsync(): Promise<void> {
  const generation = flushGeneration
  const file = statePath()
  const tmp = tempPath(file)
  try {
    mkdirSync(dirname(file), { recursive: true })
    await writeFile(tmp, serialize(), 'utf-8')
    if (generation !== flushGeneration) {
      await rm(tmp, { force: true })
      return
    }
    await rename(tmp, file)
    await rotateBackupsAsync()
  } catch (err) {
    console.error('[persist] async write failed', err)
    await rm(tmp, { force: true }).catch(() => {})
  }
}

function writeToDiskSync(): void {
  const file = statePath()
  const tmp = tempPath(file)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, serialize(), 'utf-8')
    renameSync(tmp, file)
    rotateBackupsSync()
  } catch (err) {
    console.error('[persist] sync write failed', err)
    try {
      rmSync(tmp, { force: true })
    } catch {}
  }
}

function scheduleSave(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    pendingWrite = pendingWrite.then(writeToDiskAsync)
  }, SAVE_DEBOUNCE_MS)
}

export function saveState(next: PersistedState): void {
  cache = next
  scheduleSave()
}

export function flushStateSync(): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  flushGeneration++
  loadState()
  writeToDiskSync()
}
