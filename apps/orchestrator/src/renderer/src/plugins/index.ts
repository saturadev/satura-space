import { useAppStore } from '../store'
import { defineHandle, workspaceByPath } from '../handles/registry'
import { debugLog } from '@shared/debug-log'
import { remoteLink } from '../lib/remote-link'
import { projectPluginKey } from '@shared/project-plugins'
import type { PanelDef, PluginManifest, RendererPlugin, RendererPluginSetup } from './api'

export interface PluginPanel extends PanelDef {
  key: string
  plugin: string
}

const manifests = import.meta.glob<PluginManifest>('../../../../../../plugins/*/plugin.json', { eager: true, import: 'default' })
const setups = import.meta.glob<RendererPluginSetup>('../../../../../../plugins/*/renderer.tsx', { eager: true, import: 'default' })

const panels = new Map<string, PluginPanel>()

function folderOf(key: string): string {
  return key.split('/').slice(-2)[0]
}

function comparable(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function panelKey(plugin: string, id: string): string {
  return id === plugin ? plugin : `${plugin}.${id}`
}

export function pluginPanels(): PluginPanel[] {
  return [...panels.values()]
}

export function pluginPanel(key: string | null | undefined): PluginPanel | null {
  return (key && panels.get(key)) || null
}

export function openPluginPanel(key: string, projectRoot: string, title?: string): { tabId: string; reused: boolean } | null {
  const label = panels.get(key)?.title ?? title
  if (!label) return null
  const s = useAppStore.getState()
  const ws = workspaceByPath(s, projectRoot) ?? s.activeWorkspaceId
  if (!ws) return null
  const worktrees = s.worktreesByWorkspace[ws] ?? []
  const wt = worktrees.find((w) => comparable(w.path) === comparable(projectRoot)) ?? worktrees[0]
  if (!wt) return null
  if (s.activeWorkspaceId !== ws) s.setActiveWorkspace(ws)
  const existing = (s.tabsByWorkspace[ws] ?? []).find((t) => t.contentType === 'plugin' && t.plugin === key && t.worktreeId === wt.id)
  if (existing) {
    s.activateTab(existing.id)
    return { tabId: existing.id, reused: true }
  }
  const group = s.activeGroupIdByWorkspace[ws] ?? s.ensureWorkbench(ws)
  const full = s.fullscreenGroupIdByWorkspace[ws]
  if (full && full !== group) s.exitFullscreen(ws)
  const tab = useAppStore.getState().openTabBeside(ws, group, wt.id, { label, contentType: 'plugin', plugin: key })
  debugLog(`[plugin] opened ${key} for ${wt.path}`)
  return { tabId: tab.id, reused: false }
}

function pluginFor(name: string, manifest: PluginManifest): RendererPlugin {
  return {
    name,
    manifest,
    panel(def) {
      const key = panelKey(name, def.id)
      panels.set(key, { ...def, key, plugin: name })
    },
    handle(def) {
      defineHandle({ ...def, name: `${name}.${def.name}`, side: 'renderer', released: true })
    },
    async call<T>(handle: string, projectRoot: string, params: Record<string, unknown> = {}): Promise<T> {
      const r = await window.api.plugins.call(name, handle, projectRoot, params)
      if (!r.ok) throw new Error(r.error)
      return r.value as T
    },
    on<T>(event: string, cb: (data: T) => void) {
      return window.api.plugins.onEvent((plugin, ev, data) => {
        if (plugin === name && ev === event) cb(data as T)
      })
    },
    openPanel: (id, projectRoot) => openPluginPanel(panelKey(name, id), projectRoot),
    openExternal: (url) => {
      if (!/^https:\/\//.test(url)) return
      if (!remoteLink()) return void window.api.shell.openExternal(url)
      const win = window.open(url, '_blank')
      if (win) win.opener = null
      else console.warn(`[plugin] ${name}: the browser didn't open ${url}`)
    }
  }
}

defineHandle({
  name: 'plugins.open',
  side: 'renderer',
  released: true,
  description:
    "Opens a plugin's panel the way Plugins in the New session menu does: a built-in plugin (name: assets) or a project plugin from .sspace/plugins/<name>/ (title is its tab label). project is the folder, default the call's project. Reuses an open tab of that panel. Returns the panel key, the tab id and whether it was reused. satura_exec plugins.open() calls this after compiling the panel.",
  params: { name: '', project: '', title: '' },
  run(p, ctx) {
    const name = String(p.name ?? '').trim()
    const project = String(p.project ?? '').trim() || ctx.projectRoot
    if (!name) throw new Error('Pass the plugin name.')
    const builtIn = [...panels.values()].find((x) => x.plugin === name)
    const key = builtIn && !p.title ? builtIn.key : projectPluginKey(name)
    const opened = openPluginPanel(key, project, String(p.title ?? '').trim() || name)
    if (!opened) throw new Error(`No workspace has ${project || 'this project'} open, so there is nowhere to show the panel.`)
    return { key, ...opened }
  }
})

for (const [key, setup] of Object.entries(setups)) {
  const name = folderOf(key)
  const manifest = Object.entries(manifests).find(([k]) => folderOf(k) === name)?.[1] ?? { name, title: name, description: '' }
  try {
    setup(pluginFor(name, manifest))
  } catch (e) {
    console.error(`[plugin] ${name} renderer setup failed: ${(e as Error)?.message ?? e}`)
  }
}
