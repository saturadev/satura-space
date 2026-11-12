import type { ComponentType } from 'react'
import type { HandleParams } from '@shared/app-handles'

export { Select, type SelectOption } from '../components/ui/Select'
export { Tooltip } from '../components/ui/Tooltip'
export { debugLog } from '@shared/debug-log'
export { isMobileLayout, useMobileBack } from '../lib/mobile/mobile-back'

export interface PanelProps {
  projectPath: string
  tabId: string
  focused: boolean
}

export type PanelIcon = ComponentType<{ size?: number; strokeWidth?: number; absoluteStrokeWidth?: boolean; className?: string; 'aria-hidden'?: boolean }>

export interface PanelDef {
  id: string
  title: string
  icon: PanelIcon
  component: ComponentType<PanelProps>
  hint?: string
  symbol?: string
  unityOnly?: boolean
}

export interface RendererHandleCtx {
  workspaceId: string
  projectRoot: string
}

export interface RendererHandleDef {
  name: string
  description: string
  params: HandleParams
  agentOnly?: boolean
  run(params: HandleParams, ctx: RendererHandleCtx): unknown
}

export interface PluginManifest {
  name: string
  title: string
  description: string
}

export interface RendererPlugin {
  readonly name: string
  readonly manifest: PluginManifest
  panel(def: PanelDef): void
  handle(def: RendererHandleDef): void
  call<T = unknown>(handle: string, projectRoot: string, params?: HandleParams): Promise<T>
  on<T = unknown>(event: string, cb: (data: T) => void): () => void
  openPanel(id: string, projectRoot: string): { tabId: string; reused: boolean } | null
  openExternal(url: string): void
}

export type RendererPluginSetup = (p: RendererPlugin) => void
