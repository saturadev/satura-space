import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { chassisFormOf, cleanHostKind, hostKindLabel, macFormOf, type HostKind } from '@shared/remote-host-kind'
import { debugLog } from '@shared/debug-log'

const JUNK = /to be filled|system product name|default string|not specified|^o\.?e\.?m\b/i

let detected: Promise<HostKind> | null = null

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, out) => resolve(err ? '' : String(out))))
}

function json(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return {}
  }
}

function model(text: unknown): string {
  const t = String(text ?? '').trim()
  return JUNK.test(t) ? '' : t
}

async function detect(): Promise<HostKind> {
  const [os, form, ...name] = (process.env.SATURA_DEV_INSTANCE ? process.env.SATURA_REMOTE_HOST_KIND ?? '' : '').split(':')
  if (os) return cleanHostKind({ os, form, model: name.join(':') }) ?? { os: 'other', form: 'unknown', model: '' }
  if (process.platform === 'darwin') {
    const hw = (json(await run('/usr/sbin/system_profiler', ['SPHardwareDataType', '-json', '-detailLevel', 'mini'])).SPHardwareDataType as Record<string, unknown>[] | undefined)?.[0]
    const name = model(hw?.machine_name)
    return { os: 'macos', form: macFormOf(name), model: name }
  }
  if (process.platform === 'win32') {
    const r = json(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$c=Get-CimInstance Win32_ComputerSystem;[pscustomobject]@{pc=$c.PCSystemType;chassis=@((Get-CimInstance Win32_SystemEnclosure).ChassisTypes);model=$c.Model}|ConvertTo-Json -Compress']))
    return { os: 'windows', form: chassisFormOf([r.chassis].flat().map(Number), Number(r.pc)), model: model(r.model) }
  }
  const dmi = (f: string): Promise<string> => readFile(`/sys/class/dmi/id/${f}`, 'utf8').catch(() => '')
  const [chassis, product] = await Promise.all([dmi('chassis_type'), dmi('product_name')])
  return { os: process.platform === 'linux' ? 'linux' : 'other', form: chassisFormOf([Number(chassis)]), model: model(product) }
}

export function hostKind(): Promise<HostKind> {
  detected ??= detect().then((k) => {
    const kind = cleanHostKind(k) ?? { os: 'other', form: 'unknown', model: '' }
    debugLog(`[remote] this desktop is a ${kind.os} ${kind.form}${kind.model ? ` (${kind.model})` : ''}, phones show it as ${hostKindLabel(kind)}${process.env.SATURA_DEV_INSTANCE && process.env.SATURA_REMOTE_HOST_KIND ? ', set by SATURA_REMOTE_HOST_KIND' : ''}`)
    return kind
  })
  return detected
}
