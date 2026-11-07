import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { parsePsInfo, parsePsUnity, parseWinProcInfo, parseWinProcLines, type UnityProc } from './unity-process-parse'

const execFileAsync = promisify(execFile)

export { clonePidsUnder, isCreateProjectCommand, normalizeCommandPath, pidRunsPath } from './unity-process-parse'

const WIN_LIST_UNITY =
  "$ErrorActionPreference = 'SilentlyContinue'\n" +
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' +
  "Get-CimInstance Win32_Process -Filter \"Name='Unity.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }\n"

const WIN_PROC_BY_PID =
  "$ErrorActionPreference = 'SilentlyContinue'\n" +
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' +
  '$id = [int]$env:SATURA_QUERY_PID\n' +
  "Get-CimInstance Win32_Process -Filter \"ProcessId=$id\" | ForEach-Object { \"$($_.Name)`t$($_.CommandLine)\" }\n"

const PS_ARGS = ['-ax', '-o', 'pid=,command=']

export async function listUnityProcesses(): Promise<UnityProc[]> {
  try {
    if (process.platform === 'win32') {
      const r = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_LIST_UNITY], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      })
      return parseWinProcLines(r.stdout ?? '')
    }
    const r = await execFileAsync('ps', PS_ARGS, { encoding: 'utf8', timeout: 4000, maxBuffer: 16 * 1024 * 1024 })
    return parsePsUnity(r.stdout ?? '')
  } catch {
    return []
  }
}

export function listUnityProcessesSync(): UnityProc[] {
  if (process.platform === 'win32') return []
  try {
    const r = spawnSync('ps', PS_ARGS, { encoding: 'utf8', timeout: 4000, maxBuffer: 16 * 1024 * 1024 })
    return parsePsUnity(r.stdout ?? '')
  } catch {
    return []
  }
}

export function processInfoSync(pid: number): { image: string; command: string } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PROC_BY_PID], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        env: { ...process.env, SATURA_QUERY_PID: String(pid) }
      })
      return parseWinProcInfo(r.stdout ?? '')
    }
    const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 4000 })
    return parsePsInfo(r.stdout ?? '')
  } catch {
    return null
  }
}
