import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isUnityMode, migrateStoredStreamRes, type UnityMode } from '@shared/unity/world'
import { clampPhoneReportScale, clampPhoneTerminalFont, type RemotePrefs } from '@shared/types'
import { SSPACE_DIR as SSPACE, ensureProjectSspaceSync } from '../sspace'

export const PREFS_FILE = 'prefs.json'

export interface ConsolePrefs {
  showLog: boolean
  showWarn: boolean
  showError: boolean
  collapse: boolean
}

export interface StreamPrefs {
  res: string
}

interface ProjectPrefs {
  stream: StreamPrefs | null
  console: ConsolePrefs | null
  unityMode: UnityMode
  stopped: boolean
  fpsCaps: Record<string, number>
  remote: RemotePrefs | null
}

const EMPTY: ProjectPrefs = {
  stream: null,
  console: null,
  unityMode: 'normal',
  stopped: false,
  fpsCaps: {},
  remote: null
}

function prefsFile(projectPath: string): string {
  return join(projectPath, SSPACE, PREFS_FILE)
}

function read(projectPath: string): ProjectPrefs {
  if (!projectPath) return { ...EMPTY }
  try {
    const parsed = JSON.parse(readFileSync(prefsFile(projectPath), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY }
    const raw = parsed as Record<string, unknown>
    const stream = parseStream(raw.stream)
    const console = parseConsole(raw.console)
    const unityMode = isUnityMode(raw.unityMode)
      ? raw.unityMode
      : raw.headless === true
        ? 'headless-nographics'
        : 'normal'
    return { stream, console, unityMode, stopped: raw.stopped === true, fpsCaps: parseFpsCaps(raw.fpsCaps), remote: parseRemote(raw.remote) }
  } catch {
    return { ...EMPTY }
  }
}

function parseStream(raw: unknown): StreamPrefs | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const res = o.res
  if (typeof res !== 'string') return null
  return { res: migrateStoredStreamRes(res) }
}

function parseFpsCaps(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>))
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v
  return out
}

function parseRemote(raw: unknown): RemotePrefs | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const out: RemotePrefs = {}
  if (typeof o.reportScale === 'number' && Number.isFinite(o.reportScale)) out.reportScale = clampPhoneReportScale(o.reportScale)
  if (typeof o.terminalFontSize === 'number' && Number.isFinite(o.terminalFontSize)) out.terminalFontSize = clampPhoneTerminalFont(o.terminalFontSize)
  return out
}

function parseConsole(raw: unknown): ConsolePrefs | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const b = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  return {
    showLog: b(o.showLog, true),
    showWarn: b(o.showWarn, true),
    showError: b(o.showError, true),
    collapse: b(o.collapse, true)
  }
}

function write(projectPath: string, prefs: ProjectPrefs): boolean {
  try {
    ensureProjectSspaceSync(projectPath)
    writeFileSync(prefsFile(projectPath), JSON.stringify(prefs), 'utf8')
    return true
  } catch {
    return false
  }
}

export function readStreamPrefs(projectPath: string): StreamPrefs | null {
  return read(projectPath).stream
}

export function writeStreamPrefs(projectPath: string, stream: StreamPrefs): boolean {
  if (!projectPath) return false
  return write(projectPath, { ...read(projectPath), stream })
}

export function readFpsCapPref(projectPath: string, playerIndex: number): number {
  return read(projectPath).fpsCaps[String(playerIndex)] ?? 0
}

export function writeFpsCapPref(projectPath: string, playerIndex: number, cap: number): boolean {
  if (!projectPath) return false
  const prev = read(projectPath)
  const key = String(playerIndex)
  if ((prev.fpsCaps[key] ?? 0) === cap) return true
  const fpsCaps = { ...prev.fpsCaps }
  if (cap > 0) fpsCaps[key] = cap
  else delete fpsCaps[key]
  return write(projectPath, { ...prev, fpsCaps })
}

export function readUnityModePref(projectPath: string): UnityMode {
  return read(projectPath).unityMode
}

export function writeUnityModePref(projectPath: string, unityMode: UnityMode): boolean {
  if (!projectPath) return false
  return write(projectPath, { ...read(projectPath), unityMode })
}

export function readStoppedPref(projectPath: string): boolean {
  return read(projectPath).stopped
}

export function writeStoppedPref(projectPath: string, stopped: boolean): boolean {
  if (!projectPath) return false
  const prev = read(projectPath)
  if (prev.stopped === stopped) return true
  return write(projectPath, { ...prev, stopped })
}

export function readConsolePrefs(projectPath: string): ConsolePrefs | null {
  return read(projectPath).console
}

export function writeConsolePrefs(projectPath: string, console: ConsolePrefs): boolean {
  if (!projectPath) return false
  return write(projectPath, { ...read(projectPath), console })
}

export function readRemotePrefs(projectPath: string): RemotePrefs {
  return read(projectPath).remote ?? {}
}

export function writeRemotePrefs(projectPath: string, patch: RemotePrefs): RemotePrefs {
  if (!projectPath) return {}
  const prev = read(projectPath)
  const remote = parseRemote({ ...prev.remote, ...patch }) ?? {}
  write(projectPath, { ...prev, remote })
  return remote
}
