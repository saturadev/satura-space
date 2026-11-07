import { useAppStore, type AppState } from '../store'
import { defineHandle, workspaceByPath, type RendererCtx } from './registry'
import { settle } from './layout'

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function summary(s: AppState): unknown {
  return {
    active: s.activeWorkspaceId,
    workspaces: s.workspaces.map((w) => ({ id: w.id, name: w.name, folder: w.folderPath, active: w.id === s.activeWorkspaceId }))
  }
}

function pick(s: AppState, p: Record<string, unknown>, ctx: RendererCtx): string {
  const id = String(p.id ?? '').trim()
  if (id) {
    if (!s.workspaces.some((w) => w.id === id)) throw new Error(`There is no workspace ${id}. app.state lists them.`)
    return id
  }
  const folder = String(p.folder ?? '').trim()
  if (folder) {
    const found = workspaceByPath(s, folder)
    if (!found) throw new Error(`No workspace is open for ${folder}.`)
    return found
  }
  if (!ctx.workspaceId) throw new Error('Pass folder or id: this call has no project workspace.')
  return ctx.workspaceId
}

defineHandle({
  name: 'workspace.focus',
  side: 'renderer',
  description:
    'Brings a workspace to the front, like clicking it in the sidebar. id or folder picks it; without them it is the project workspace. Clicks, drags and screenshots only work in the front workspace, so call this after a handle opened another one (git.seed does). Returns the active workspace and the list.',
  params: { id: '', folder: '' },
  async run(p, ctx: RendererCtx) {
    const s = useAppStore.getState()
    const ws = pick(s, p, ctx)
    if (s.activeWorkspaceId !== ws) s.setActiveWorkspace(ws)
    await settle()
    return summary(useAppStore.getState())
  }
})

defineHandle({
  name: 'workspace.close',
  side: 'renderer',
  description:
    "Closes workspaces the way their X button in the sidebar does, but without the confirm. id or folder closes one; under: '<dir>' closes every workspace whose folder is inside dir, except keep. A workspace with a Unity Player is never closed, because that would stop its editor. Returns the closed folders, the active workspace and the list.",
  params: { id: '', folder: '', under: '', keep: '' },
  async run(p, ctx: RendererCtx) {
    let s = useAppStore.getState()
    const under = norm(String(p.under ?? '').trim())
    const keep = norm(String(p.keep ?? '').trim())
    const targets = under
      ? s.workspaces.filter((w) => {
          const f = norm(w.folderPath ?? '')
          return f.startsWith(`${under}/`) && f !== keep
        }).map((w) => w.id)
      : [pick(s, p, ctx)]
    const closed: string[] = []
    for (const id of targets) {
      s = useAppStore.getState()
      const ws = s.workspaces.find((w) => w.id === id)
      if (!ws) continue
      if ((s.tabsByWorkspace[id] ?? []).some((t) => t.contentType === 'unity-instance-player')) {
        if (!under) throw new Error(`${ws.folderPath} has a Unity Player, so closing it would stop its editor. Close that panel first.`)
        continue
      }
      const identity = { folderPath: ws.folderPath ?? '', worktreePath: ws.worktreePath ?? ws.folderPath ?? '' }
      s.deleteWorkspace(id)
      window.api.window.closeWorkspaceWindows(identity)
      closed.push(ws.folderPath ?? id)
    }
    await settle()
    return { closed, ...(summary(useAppStore.getState()) as object) }
  }
})
