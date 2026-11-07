import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { HubState } from '@shared/api'

const execFileAsync = promisify(execFile)

const HUB_PROCESS_MAC = 'Unity Hub'
const HUB_PROCESS_WIN = 'Unity Hub.exe'
const HUB_IPC_MAC = '/tmp/Unity-hubIPCService.sock'
const HUB_IPC_WIN = ['\\\\.\\pipe\\tmp-Unity-hubIPCService.sock', '\\\\.\\pipe\\tmp-Unity-hubIPCService', '\\\\.\\pipe\\Unity-hubIPCService']
const IPC_GRACE_MS = 20_000
const STATES: HubState[] = ['ready', 'starting', 'signed-out', 'not-running', 'not-installed']

function envOverride(): HubState | null {
  if (app.isPackaged) return null
  const env = process.env.SATURA_DEV_HUB_STATE as HubState | undefined
  return env && STATES.includes(env) ? env : null
}

let override: HubState | null = envOverride()
let simulatedStart: NodeJS.Timeout | null = null
let runningSince = 0
let registryPath: string | null | undefined

function devOverride(): HubState | null {
  return app.isPackaged ? null : override
}

export function setHubOverride(state: HubState | null): HubState | null {
  if (app.isPackaged) return null
  override = state && STATES.includes(state) ? state : null
  if (simulatedStart) clearTimeout(simulatedStart)
  simulatedStart = null
  console.log(`[unity-hub] dev override ${override ?? 'cleared'}`)
  return devOverride()
}

function hubCandidates(): string[] {
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles'], process.env['ProgramW6432'], 'C:\\Program Files']
    const out = roots.filter((r): r is string => !!r).map((r) => join(r, 'Unity Hub', 'Unity Hub.exe'))
    if (process.env['LOCALAPPDATA']) out.push(join(process.env['LOCALAPPDATA'], 'Programs', 'Unity Hub', 'Unity Hub.exe'))
    return [...new Set(out)]
  }
  return ['/Applications/Unity Hub.app', join(homedir(), 'Applications', 'Unity Hub.app')]
}

export function hubAppPathSync(): string | null {
  for (const p of hubCandidates()) {
    try {
      if (existsSync(p)) return p
    } catch {
    }
  }
  return null
}

async function hubFromRegistry(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  if (registryPath !== undefined) return registryPath
  registryPath = null
  for (const root of ['HKLM', 'HKCU']) {
    try {
      const { stdout } = await execFileAsync(
        'reg',
        ['query', `${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/f', 'Unity Hub.exe', '/d'],
        { encoding: 'utf8', timeout: 4000, windowsHide: true }
      )
      for (const line of stdout.split(/\r?\n/)) {
        const m = /REG_(?:EXPAND_)?SZ\s+"?([^"]*?Unity Hub\.exe)"?(?:,\d+)?\s*$/i.exec(line)
        if (m && !/uninstall/i.test(m[1]) && existsSync(m[1])) {
          registryPath = m[1]
          return registryPath
        }
      }
    } catch {
    }
  }
  return registryPath
}

export async function hubAppPath(): Promise<string | null> {
  return hubAppPathSync() ?? (await hubFromRegistry())
}

export async function isHubInstalled(): Promise<boolean> {
  const forced = devOverride()
  if (forced) return forced !== 'not-installed'
  return (await hubAppPath()) !== null
}

async function hubProcessRunning(): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${HUB_PROCESS_WIN}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true
      })
      return stdout.toLowerCase().includes(`"${HUB_PROCESS_WIN.toLowerCase()}"`)
    }
    await execFileAsync('pgrep', ['-x', HUB_PROCESS_MAC], { encoding: 'utf8', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

function canConnect(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(path)
    const done = (ok: boolean): void => {
      clearTimeout(timer)
      sock.removeAllListeners()
      sock.on('error', () => {})
      sock.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), 1000)
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

async function hubIpcUp(): Promise<boolean> {
  if (process.platform === 'win32') {
    for (const p of HUB_IPC_WIN) if (await canConnect(p)) return true
    return false
  }
  return existsSync(HUB_IPC_MAC) && (await canConnect(HUB_IPC_MAC))
}

function hubDataDir(): string {
  if (process.platform === 'win32') return join(process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'), 'UnityHub')
  return join(homedir(), 'Library', 'Application Support', 'UnityHub')
}

export function hubSignedIn(): boolean | null {
  const file = join(hubDataDir(), 'accounts.db')
  if (!existsSync(file)) return null
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const row = db
      .prepare(
        "SELECT a.foreign_key AS account FROM active_account x LEFT JOIN accounts a ON a.foreign_key = x.foreign_key WHERE x.consumer = 'hub'"
      )
      .get() as { account: string | null } | undefined
    return !!row?.account
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
    }
  }
}

export async function hubState(): Promise<HubState> {
  const forced = devOverride()
  if (forced) return forced
  if (await hubProcessRunning()) {
    if (!runningSince) runningSince = Date.now()
    const up = (await hubIpcUp()) || Date.now() - runningSince > IPC_GRACE_MS
    if (!up) return 'starting'
    return hubSignedIn() === false ? 'signed-out' : 'ready'
  }
  runningSince = 0
  return (await hubAppPath()) ? 'not-running' : 'not-installed'
}

export function hubBlockMessage(state: HubState): string {
  if (state === 'not-installed')
    return "Unity Hub isn't installed, and Unity can't check its license without it. Ask the user to install it from unity.com/download."
  if (state === 'starting')
    return 'Unity Hub is still starting. The Unity panel launches the editor once Hub is ready.'
  if (state === 'signed-out')
    return "Unity Hub isn't signed in, and Unity can't check its license without it. Ask the user to sign in to Unity Hub. The editor launches once they do."
  return "Unity Hub isn't running, and Unity can't check its license without it. Ask the user to click Start Unity Hub in the Unity panel. The editor launches once Hub is up."
}

export async function hubLaunchCommand(): Promise<{ cmd: string; args: string[] } | null> {
  const path = await hubAppPath()
  if (!path) return null
  return process.platform === 'win32' ? { cmd: path, args: [] } : { cmd: 'open', args: ['-a', path] }
}

export async function startHub(dryRun = false): Promise<{ ok: boolean; error?: string; command?: string[] }> {
  const launch = await hubLaunchCommand()
  if (!launch) return { ok: false, error: "Unity Hub isn't installed." }
  const command = [launch.cmd, ...launch.args]
  if (dryRun) return { ok: true, command }
  if (devOverride() === 'not-running') {
    console.log(`[unity-hub] dev override: simulating start instead of ${command.join(' ')}`)
    override = 'starting'
    simulatedStart = setTimeout(() => {
      simulatedStart = null
      override = null
      console.log('[unity-hub] dev override: simulated Hub is ready')
    }, 4000)
    return { ok: true, command }
  }
  try {
    const p = spawn(launch.cmd, launch.args, { detached: true, stdio: 'ignore', windowsHide: false })
    p.on('error', (e) => console.log(`[unity-hub] start failed: ${e.message}`))
    p.unref()
    console.log(`[unity-hub] starting: ${command.join(' ')}`)
    return { ok: true, command }
  } catch (e) {
    return { ok: false, error: (e as Error).message, command }
  }
}
