import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const PS_LIST_PIDS_UNDER = `
$ErrorActionPreference = 'SilentlyContinue'
$target = $env:SATURA_CWD_TARGET
if (-not $target) { exit 0 }
$target = $target.TrimEnd('\\','/').ToLower()
Add-Type -Namespace Win32 -Name Ntdll -MemberDefinition @'
[DllImport("ntdll.dll")]
public static extern int NtQueryInformationProcess(IntPtr h, int c, ref PROCESS_BASIC_INFORMATION i, int l, ref int r);
[StructLayout(LayoutKind.Sequential)]
public struct PROCESS_BASIC_INFORMATION { public IntPtr Reserved1; public IntPtr PebBaseAddress; public IntPtr Reserved2_0; public IntPtr Reserved2_1; public IntPtr UniqueProcessId; public IntPtr Reserved3; }
[DllImport("kernel32.dll")]
public static extern bool ReadProcessMemory(IntPtr h, IntPtr b, byte[] buf, int size, ref int read);
'@
foreach ($p in Get-Process) {
  try {
    $h = $p.Handle
    $pbi = New-Object Win32.Ntdll+PROCESS_BASIC_INFORMATION
    $rl = 0
    if ([Win32.Ntdll]::NtQueryInformationProcess($h, 0, [ref]$pbi, [System.Runtime.InteropServices.Marshal]::SizeOf($pbi), [ref]$rl) -ne 0) { continue }
    $peb = $pbi.PebBaseAddress
    $procParamsPtr = [IntPtr]::Zero
    $buf = New-Object byte[] 8; $r = 0
    if (-not [Win32.Ntdll]::ReadProcessMemory($h, [IntPtr]([Int64]$peb + 0x20), $buf, 8, [ref]$r)) { continue }
    $procParams = [IntPtr][BitConverter]::ToInt64($buf, 0)
    $buf2 = New-Object byte[] 16
    if (-not [Win32.Ntdll]::ReadProcessMemory($h, [IntPtr]([Int64]$procParams + 0x38), $buf2, 16, [ref]$r)) { continue }
    $len = [BitConverter]::ToUInt16($buf2, 0)
    $strPtr = [IntPtr][BitConverter]::ToInt64($buf2, 8)
    if ($len -le 0 -or $strPtr -eq [IntPtr]::Zero) { continue }
    $sbuf = New-Object byte[] $len
    if (-not [Win32.Ntdll]::ReadProcessMemory($h, $strPtr, $sbuf, $len, [ref]$r)) { continue }
    $cwd = [System.Text.Encoding]::Unicode.GetString($sbuf).TrimEnd([char]0).TrimEnd('\\','/').ToLower()
    if ($cwd -eq $target -or $cwd.StartsWith($target + '\\')) { Write-Output $p.Id }
  } catch {}
}
exit 0
`

export async function pidsWithCwdUnder(dirPath: string): Promise<number[]> {
  if (process.platform !== 'win32' || !dirPath) return []
  const target = dirPath.replace(/\//g, '\\')
  try {
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_LIST_PIDS_UNDER],
      {
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, SATURA_CWD_TARGET: target }
      }
    )
    return stdout
      .split(/\r?\n/)
      .map((l) => parseInt(l.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

export async function killTree(pid: number): Promise<void> {
  if (!pid || pid <= 0) return
  if (process.platform === 'win32') {
    await exec('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        return
      }
    }
  }
}

export async function killProcessesUnderPath(dirPath: string): Promise<number> {
  const pids = await pidsWithCwdUnder(dirPath)
  for (const pid of pids) await killTree(pid)
  return pids.length
}
