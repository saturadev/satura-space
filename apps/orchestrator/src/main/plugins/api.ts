import type { HandleParams } from '@shared/app-handles'

export { unzipSync } from 'fflate'

export interface PluginManifest {
  name: string
  title: string
  description: string
}

export interface PluginCtx {
  projectRoot: string
  window: number | null
  signal?: AbortSignal
  log(line: string): void
}

export interface PluginHandleDef {
  name: string
  description: string
  params: HandleParams
  long?: boolean
  agentOnly?: boolean
  released?: boolean
  run(params: HandleParams, ctx: PluginCtx): Promise<unknown>
}

export type PluginExecFn = (ctx: PluginCtx, ...args: any[]) => unknown

export interface MainPlugin {
  readonly name: string
  readonly manifest: PluginManifest
  readonly appVersion: string
  readonly cacheDir: string
  handle(def: PluginHandleDef): void
  exec(name: string, fn: PluginExecFn): void
  emit(event: string, data: unknown): void
  unity(projectRoot: string, command: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  log(line: string): void
}

export type MainPluginSetup = (p: MainPlugin) => void
