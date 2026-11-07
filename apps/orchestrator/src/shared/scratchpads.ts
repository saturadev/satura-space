import type { EditorFaultKind, UnityMode } from './unity/world'

export const SCRATCHPADS_REL = '.sspace/scratchpads'
export const SCRATCHPAD_META_FILE = 'scratchpad.json'
export const SCRATCHPAD_HOST_FILE = '.mcp_scratchpad_host.json'
export const SCRATCHPAD_NAME_MAX = 64

export type ScratchpadStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export type ScratchpadPlay = 'edit' | 'entering' | 'playing' | 'paused' | 'exiting'

export interface ScratchpadInfo {
  id: string
  name: string
  path: string
  createdAt: number
  status: ScratchpadStatus
  lifecycle: string | null
  play: ScratchpadPlay | null
  pid: number | null
  error: string | null
  fault: ScratchpadFault | null
  unityMode: UnityMode
}

export interface ScratchpadFault {
  kind: EditorFaultKind
  reason: string
  log: string
  line: number
}

export type ScratchpadResult<T> = { ok: true; data: T } | { ok: false; error: string }

export function scratchpadPlayOf(lifecycle: string | null | undefined, paused: boolean): ScratchpadPlay | null {
  switch (lifecycle) {
    case 'editmode':
      return 'edit'
    case 'entering-play':
      return 'entering'
    case 'playing':
      return paused ? 'paused' : 'playing'
    case 'exiting-play':
      return 'exiting'
    default:
      return null
  }
}

export function cleanScratchpadName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, SCRATCHPAD_NAME_MAX) : ''
}

export function isScratchpadPath(p: string | null | undefined): boolean {
  return !!p && /[\\/]\.sspace[\\/]scratchpads[\\/][^\\/]+[\\/]?$/.test(p)
}

export function scratchpadParentProject(p: string): string | null {
  const m = /^(.*?)[\\/]\.sspace[\\/]scratchpads[\\/][^\\/]+[\\/]?$/.exec(p)
  return m ? m[1] : null
}

export function scratchpadIdOf(p: string | null | undefined): string | null {
  const m = /[\\/]\.sspace[\\/]scratchpads[\\/]([^\\/]+)[\\/]?$/.exec(p ?? '')
  return m ? m[1] : null
}

export function scratchpadPromptScope(info: Pick<ScratchpadInfo, 'name' | 'path'> | null | undefined): string {
  return info ? `in scratchpad "${info.name}" at ${info.path}` : ''
}

export function scratchpadOfRel(rel: string): { id: string; inner: string } | null {
  const m = /^\.sspace\/scratchpads\/([^/]+)(?:\/(.*))?$/.exec(rel.replace(/\\/g, '/'))
  return m ? { id: m[1], inner: m[2] ?? '' } : null
}

export function scratchpadOwnerOf(projectRoot: string, file: string): { id: string; root: string; rel: string } | null {
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const f = file.replace(/\\/g, '/')
  if (!root || !f.startsWith(`${root}/`)) return null
  const pad = scratchpadOfRel(f.slice(root.length + 1))
  return pad && pad.inner ? { id: pad.id, root: `${root}/${SCRATCHPADS_REL}/${pad.id}`, rel: pad.inner } : null
}

export function assetProjectRoot(projectRoot: string, scratchpadId: string | null | undefined): string {
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  return scratchpadId ? `${root}/${SCRATCHPADS_REL}/${scratchpadId}` : root
}
