import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { defineHandle } from '../handles/registry'
import { broadcastToAllWindows } from '../window/window-manager'
import { unityProvider } from '../unity/unity-instance-provider'
import { UnityControlClient } from '../unity/unity-control-client'
import type { HandleParams } from '@shared/app-handles'
import type { MainPlugin, MainPluginSetup, PluginCtx, PluginExecFn, PluginHandleDef, PluginManifest } from './api'

const manifests = import.meta.glob<PluginManifest>('../../../../../plugins/*/plugin.json', { eager: true, import: 'default' })
const setups = import.meta.glob<MainPluginSetup>('../../../../../plugins/*/main.ts', { eager: true, import: 'default' })

const NAME = /^[a-z][a-z0-9]{0,31}$/
const CONNECT_MS = 10_000
const UNITY_MS = 120_000

const execs = new Map<string, Map<string, PluginExecFn>>()
const handleDefs = new Map<string, Map<string, PluginHandleDef>>()

function folderOf(key: string): string {
  return key.split('/').slice(-2)[0]
}

function cacheRoot(): string {
  const data = app.getPath('userData')
  return process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', basename(data), 'plugins') : join(data, 'plugin-cache')
}

async function unityCommand(plugin: string, projectRoot: string, command: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const ctl = unityProvider.primaryControl(projectRoot)
  if (!ctl || !ctl.alive) throw new Error(`No Unity editor is running for ${projectRoot || 'this project'}. Open the project's Unity Player first.`)
  const client = new UnityControlClient(ctl.port)
  try {
    const deadline = Date.now() + CONNECT_MS
    while (!client.isConnected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    if (!client.isConnected) throw new Error('The Unity editor control socket is not reachable yet. It may be compiling or reloading.')
    const r = await client.command(`plugin/${plugin}.${command}`, args, timeoutMs)
    if (!r) throw new Error(`Unity did not answer ${plugin}.${command} within ${Math.round(timeoutMs / 1000)}s. It may be importing or showing a dialog.`)
    if (r.status !== 'completed') throw new Error(typeof r.error === 'string' && r.error ? r.error : `${plugin}.${command} failed in Unity.`)
    return r.value ?? null
  } finally {
    client.close()
  }
}

function pluginFor(name: string, manifest: PluginManifest): MainPlugin {
  const fns = new Map<string, PluginExecFn>()
  const defs = new Map<string, PluginHandleDef>()
  execs.set(name, fns)
  handleDefs.set(name, defs)
  const log = (line: string): void => console.log(`[plugin:${name}] ${line}`)
  return {
    name,
    manifest,
    appVersion: app.getVersion(),
    cacheDir: join(cacheRoot(), name),
    handle(def) {
      defs.set(def.name, def)
      defineHandle({
        name: `${name}.${def.name}`,
        description: def.description,
        side: 'main',
        params: def.params,
        ...(def.long ? { long: true } : {}),
        ...(def.agentOnly ? { agentOnly: true } : {}),
        released: def.released ?? true,
        run: (params, ctx) => def.run(params, { projectRoot: ctx.projectRoot, window: ctx.window, signal: ctx.signal, log: ctx.log })
      })
    },
    exec(fn, run) {
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(fn)) throw new Error(`${name}.${fn} is not a valid function name`)
      fns.set(fn, run)
    },
    emit(event, data) {
      broadcastToAllWindows('plugin:event', name, event, data)
    },
    unity: (projectRoot, command, args = {}, timeoutMs = UNITY_MS) => unityCommand(name, projectRoot, command, args, timeoutMs),
    log
  }
}

export function pluginGlobals(): Record<string, string[]> {
  return Object.fromEntries([...execs].filter(([, fns]) => fns.size > 0).map(([name, fns]) => [name, [...fns.keys()]]))
}

export async function callPluginExec(plugin: string, fn: string, args: unknown[], ctx: Omit<PluginCtx, 'log'>): Promise<unknown> {
  const run = execs.get(plugin)?.get(fn)
  if (!run) throw new Error(`There is no ${plugin}.${fn}(). ${plugin} has ${[...(execs.get(plugin)?.keys() ?? [])].map((f) => `${f}()`).join(', ') || 'no functions'}.`)
  return run({ ...ctx, log: (line) => console.log(`[plugin:${plugin}] ${fn}: ${line}`) }, ...args)
}

export async function callPluginHandle(plugin: string, handle: string, params: HandleParams, ctx: Omit<PluginCtx, 'log'>): Promise<unknown> {
  const def = handleDefs.get(plugin)?.get(handle)
  if (!def) throw new Error(`There is no handle ${plugin}.${handle}.`)
  return def.run({ ...def.params, ...params }, { ...ctx, log: (line) => console.log(`[plugin:${plugin}] ${handle}: ${line}`) })
}

let loaded = false

export function registerPluginHandlers(): void {
  if (loaded) return
  loaded = true
  for (const [key, setup] of Object.entries(setups)) {
    const name = folderOf(key)
    if (!NAME.test(name)) {
      console.error(`[plugin] ${name}: a plugin folder name is lowercase letters and digits, so it is skipped`)
      continue
    }
    const manifest = Object.entries(manifests).find(([k]) => folderOf(k) === name)?.[1] ?? { name, title: name, description: '' }
    try {
      setup(pluginFor(name, manifest))
      console.log(`[plugin] ${name} loaded: ${[...(execs.get(name)?.keys() ?? [])].join(', ') || 'no exec functions'}`)
    } catch (e) {
      console.error(`[plugin] ${name} setup failed: ${(e as Error)?.message ?? e}`)
    }
  }
  ipcMain.handle('plugin:call', async (e: IpcMainInvokeEvent, plugin: unknown, handle: unknown, projectRoot: unknown, params: unknown) => {
    try {
      const given = params && typeof params === 'object' && !Array.isArray(params) ? (params as HandleParams) : {}
      const value = await callPluginHandle(String(plugin), String(handle), given, { projectRoot: typeof projectRoot === 'string' ? projectRoot : '', window: e.sender.id })
      return { ok: true, value: value === undefined ? null : value }
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) }
    }
  })
}
