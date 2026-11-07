import { RV_PRESETS, type RvSettings } from '@shared/remote-video'
import { pathHostId } from '../macs'

export type StreamPrefs = Pick<RvSettings, 'preset' | 'filter'>

const KEY = 'satura-stream'

function read(key: string): Partial<StreamPrefs> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<StreamPrefs> | null
    if (!v || typeof v !== 'object') return {}
    const out: Partial<StreamPrefs> = {}
    if (typeof v.preset === 'string' && v.preset in RV_PRESETS) out.preset = v.preset
    if (v.filter === 'smooth' || v.filter === 'pixel') out.filter = v.filter
    return out
  } catch {
    return {}
  }
}

function write(key: string, patch: Partial<StreamPrefs>): void {
  try {
    localStorage.setItem(key, JSON.stringify({ ...read(key), ...patch }))
  } catch {
  }
}

function keys(project: string | null): { project: string | null; desktop: string | null } {
  const host = pathHostId()
  return { project: host && project ? `${KEY}:${host}:${project}` : null, desktop: host ? `${KEY}:${host}` : null }
}

export function streamPrefs(project: string | null): StreamPrefs {
  const k = keys(project)
  return { preset: 'auto', filter: 'smooth', ...read(KEY), ...(k.desktop ? read(k.desktop) : {}), ...(k.project ? read(k.project) : {}) }
}

export function saveStreamPrefs(project: string | null, patch: Partial<RvSettings>): void {
  const k = keys(project)
  const own = k.project ?? k.desktop
  if (patch.preset) {
    write(KEY, { preset: patch.preset })
    if (k.desktop) write(k.desktop, { preset: patch.preset })
    if (k.project) write(k.project, { preset: patch.preset })
  }
  if (patch.filter && own) write(own, { filter: patch.filter })
  console.log(`video: saved stream prefs ${JSON.stringify(patch)} for ${project ?? 'this desktop'}`)
}
