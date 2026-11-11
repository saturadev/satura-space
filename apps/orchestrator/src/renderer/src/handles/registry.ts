import { withDefaults, type HandleInfo, type HandleParams, type RendererHandleCall, type RendererHandleReply } from '@shared/app-handles'
import { useAppStore, type AppState } from '../store'
import { tunerTip } from '../lib/tuner/inspector/tooltip'

export interface RendererCtx {
  workspaceId: string
  projectRoot: string
}

export interface RendererHandle {
  name: string
  description: string
  side: 'renderer'
  params: HandleParams
  agentOnly?: boolean
  released?: boolean
  run(params: HandleParams, ctx: RendererCtx): unknown
}

const handles = new Map<string, RendererHandle>()

export function defineHandle(handle: RendererHandle): RendererHandle {
  if (import.meta.env.DEV || handle.released) handles.set(handle.name, handle)
  return handle
}

function comparablePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function workspaceByPath(s: AppState, root: string): string | null {
  const want = comparablePath(root)
  if (!want) return null
  for (const ws of s.workspaces) {
    const paths = [ws.folderPath, ws.worktreePath, ...(s.worktreesByWorkspace[ws.id] ?? []).map((w) => w.path)]
    if (paths.some((p) => !!p && comparablePath(p) === want)) return ws.id
  }
  return null
}

export function rendererHandleList(): HandleInfo[] {
  return [...handles.values()].map((h) => ({ name: h.name, description: h.description, side: 'renderer', params: h.params, ...(h.agentOnly ? { agentOnly: true } : {}), ...(h.released ? { released: true } : {}) }))
}

export async function runRendererHandle(call: RendererHandleCall): Promise<RendererHandleReply> {
  const handle = handles.get(call.name)
  if (!handle) return { ok: false, error: `There is no window handle ${call.name}.` }
  const s = useAppStore.getState()
  const workspaceId = (call.workspaceId && s.workspaces.some((w) => w.id === call.workspaceId) ? call.workspaceId : null) ?? workspaceByPath(s, call.projectRoot) ?? s.activeWorkspaceId ?? ''
  try {
    tunerTip.releaseTitle()
    const value = await handle.run(withDefaults(handle.params, call.params), { workspaceId, projectRoot: call.projectRoot })
    return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) }
  }
}
