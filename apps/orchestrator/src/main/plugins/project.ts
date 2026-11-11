import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { cleanProjectPath, projectPluginFile, projectPluginNameProblem, projectPluginsDir, type ProjectPluginInfo } from '@shared/project-plugins'
import type { RendererHandleReply } from '@shared/app-handles'
import { compileReport } from '../report/compile'
import { rendererCall } from '../agent-exec'

export interface BuiltInPluginInfo {
  name: string
  title: string
  description: string
  functions: string[]
}

export interface ProjectExecModule {
  name: string
  code?: string
  error?: string
}

type Ctx = { window: number; projectRoot: string; paneKey: string; workspace: string | null }

const text = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function readPlugin(project: string, name: string, builtIn: string[]): Promise<ProjectPluginInfo> {
  const has = (file: 'panel.tsx' | 'exec.ts' | 'agent.md'): boolean => existsSync(projectPluginFile(project, name, file))
  let title = name
  let description = ''
  let problem = projectPluginNameProblem(name, builtIn)
  const raw = await readFile(projectPluginFile(project, name, 'plugin.json'), 'utf8').catch(() => null)
  if (raw === null) problem ??= `.sspace/plugins/${name}/plugin.json is missing. Add { "title": "…", "description": "…" }.`
  else {
    try {
      const json = JSON.parse(raw) as unknown
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('it must be an object with "title" and "description"')
      const o = json as Record<string, unknown>
      if (typeof o.title === 'string' && o.title.trim()) title = o.title.trim()
      if (typeof o.description === 'string') description = o.description.trim()
    } catch (e) {
      problem ??= `.sspace/plugins/${name}/plugin.json is not valid: ${text(e)}`
    }
  }
  return { name, title, description, dir: `${projectPluginsDir(project)}/${name}`, panel: has('panel.tsx'), exec: has('exec.ts'), guide: has('agent.md'), problem }
}

export async function listProjectPlugins(project: string, builtIn: string[]): Promise<ProjectPluginInfo[]> {
  const root = cleanProjectPath(project)
  if (!root) return []
  let names: string[]
  try {
    names = (await readdir(projectPluginsDir(root), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
  return Promise.all(names.map((name) => readPlugin(root, name, builtIn)))
}

async function compiled(project: string, name: string, file: 'panel.tsx' | 'exec.ts'): Promise<{ ok: boolean; code?: string; text: string }> {
  const res = await compileReport(projectPluginFile(project, name, file), project)
  return { ok: res.ok, code: res.code, text: res.ok ? 'ok' : res.text }
}

export async function projectExecModules(project: string, builtIn: string[]): Promise<ProjectExecModule[]> {
  const root = cleanProjectPath(project)
  const list = await listProjectPlugins(root, builtIn)
  return Promise.all(
    list
      .filter((p) => p.exec || p.problem)
      .map(async (p): Promise<ProjectExecModule> => {
        if (p.problem) return { name: p.name, error: p.problem }
        const res = await compiled(root, p.name, 'exec.ts')
        return res.ok ? { name: p.name, code: res.code ?? '' } : { name: p.name, error: `.sspace/plugins/${p.name}/exec.ts did not compile:\n${res.text}` }
      })
  )
}

async function openPanel(ctx: Ctx, params: Record<string, unknown>): Promise<{ key: string; tabId: string; reused: boolean }> {
  const reply = (await rendererCall(ctx.window, { kind: 'handle', payload: { name: 'plugins.open', params, workspaceId: ctx.workspace, projectRoot: ctx.projectRoot } })) as RendererHandleReply | null
  if (!reply) throw new Error('The app window did not answer. Open the project in Satura Space and try again.')
  if (!reply.ok) throw new Error(reply.error)
  return reply.value as { key: string; tabId: string; reused: boolean }
}

async function projectRows(project: string, builtIn: string[]): Promise<(Omit<ProjectPluginInfo, 'problem'> & { source: 'project'; errors: string[] })[]> {
  const list = await listProjectPlugins(project, builtIn)
  return Promise.all(
    list.map(async ({ problem, ...p }) => {
      const errors: string[] = problem ? [problem] : []
      if (!problem && p.panel) {
        const r = await compiled(project, p.name, 'panel.tsx')
        if (!r.ok) errors.push(`panel.tsx did not compile:\n${r.text}`)
      }
      if (!problem && p.exec) {
        const r = await compiled(project, p.name, 'exec.ts')
        if (!r.ok) errors.push(`exec.ts did not compile:\n${r.text}`)
      }
      return { ...p, source: 'project' as const, errors }
    })
  )
}

export async function projectPluginsCall(args: Record<string, unknown>, ctx: Ctx, builtIn: BuiltInPluginInfo[]): Promise<unknown> {
  const project = cleanProjectPath(ctx.projectRoot || '')
  const names = builtIn.map((b) => b.name)
  if (args.action === 'list') {
    return { project, builtIn: builtIn.map((b) => ({ ...b, source: 'built-in' as const })), own: await projectRows(project, names) }
  }
  if (args.action === 'open') {
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!name) throw new TypeError("plugins.open() takes the plugin's name, like plugins.open('scene-stats')")
    const own = project ? (await listProjectPlugins(project, names)).find((p) => p.name === name) : undefined
    const base = builtIn.find((b) => b.name === name)
    if (base && (!own || own.problem)) {
      const opened = await openPanel(ctx, { name, project })
      return { name, source: 'built-in', title: base.title, ...opened }
    }
    if (!own) throw new Error(`No plugin "${name}" in ${project || 'this project'}. A project plugin is a folder .sspace/plugins/${name}/ with plugin.json; plugins.list() shows what there is.`)
    if (own.problem) throw new Error(own.problem)
    if (!own.panel) throw new Error(`${name} has no panel.tsx. Write .sspace/plugins/${name}/panel.tsx to give it a panel; its functions work without one.`)
    const panel = await compiled(project, name, 'panel.tsx')
    const exec = own.exec ? await compiled(project, name, 'exec.ts') : null
    const opened = await openPanel(ctx, { name, project, title: own.title })
    return { name, source: 'project', title: own.title, project, ...opened, compile: { panel: panel.text, ...(exec ? { exec: exec.text } : {}) } }
  }
  throw new Error(`Unknown plugins call ${String(args.action)}`)
}
