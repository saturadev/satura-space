import type { HandleParams } from '@shared/app-handles'

export { unzipSync, zipSync } from 'fflate'
export { applyCliAugmentedPath, resolveCliCommand } from '../agents/cli-command-resolver'

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

export interface PluginPageOptions {
  width?: number
  height?: number
  scale?: number
  frameRate?: number
  loadTimeoutMs?: number
  allowNetwork?(url: string): boolean
}

export interface PluginPageMessage {
  type: string
  text: string
}

export interface PluginPage {
  readonly messages: PluginPageMessage[]
  readonly requests: string[]
  readonly opened: string[]
  load(target: string, query?: Record<string, string | number>): Promise<void>
  evaluate<T = unknown>(code: string, timeoutMs?: number): Promise<T>
  screenshot(): Promise<Buffer>
  resize(width: number, height: number): Promise<void>
  close(): void
}

export type PluginExecFn = (ctx: PluginCtx, ...args: any[]) => unknown

export interface MainPlugin {
  readonly name: string
  readonly manifest: PluginManifest
  readonly appVersion: string
  readonly cacheDir: string
  readonly sourceDir: string | null
  handle(def: PluginHandleDef): void
  exec(name: string, fn: PluginExecFn): void
  emit(event: string, data: unknown): void
  unity(projectRoot: string, command: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  page(options?: PluginPageOptions): Promise<PluginPage>
  log(line: string): void
}

export type MainPluginSetup = (p: MainPlugin) => void
