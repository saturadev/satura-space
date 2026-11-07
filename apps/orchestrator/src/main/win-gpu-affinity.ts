import { execFile } from 'node:child_process'
import { censusTrack } from '@shared/census'

const KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences'
const HIGH_PERF = 'GpuPreference=2;'
const pinned = new Set<string>()
censusTrack('win-gpu-affinity.pinned', pinned)

export function pinExeToHighPerfGpu(exePath: string): void {
  if (process.platform !== 'win32' || !exePath || pinned.has(exePath)) return
  pinned.add(exePath)
  const child = execFile(
    'reg',
    ['add', KEY, '/v', exePath, '/t', 'REG_SZ', '/d', HIGH_PERF, '/f'],
    { windowsHide: true, timeout: 5000 },
    () => {}
  )
  child.on('error', () => {})
  child.unref()
}
