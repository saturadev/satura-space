import type { StateCreator } from 'zustand'
import {
  clampAppZoom,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_SETTINGS,
  DEFAULT_THEME,
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  type AgentConfig,
  type AgentId,
  type Settings,
  type ThemeId,
  stepReportZoom
} from '@shared/types'
import { applyTheme, isThemeId } from '../../lib/theme/themes'
import type { AppState } from '../index'

const clampFont = (n: number): number =>
  Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(n)))

export interface SettingsSlice {
  settings: Settings | null
  detectedAgents: AgentId[] | null

  loadSettings: () => Promise<void>
  detectAgents: () => Promise<void>
  updateSettings: (patch: Partial<Settings>) => void
  setAgentConfig: (id: AgentId, patch: Partial<AgentConfig>) => void
  setFavoriteAgents: (ids: AgentId[]) => void

  setTerminalFontSize: (px: number) => void
  setEditorFontSize: (px: number) => void
  adjustFontSize: (target: 'terminal' | 'editor', delta: number | 'reset') => void
  adjustReportZoom: (delta: number | 'reset') => void
  setAppZoomFactor: (factor: number) => void
  setTheme: (theme: ThemeId) => void
  setDefaultTerminalCount: (count: number) => void
}

export const createSettingsSlice: StateCreator<AppState, [], [], SettingsSlice> = (set, get) => ({
  settings: null,
  detectedAgents: null,

  loadSettings: async () => {
    const loaded = await window.api.settings.get()
    const settings = isThemeId(loaded.theme) ? loaded : { ...loaded, theme: DEFAULT_THEME }
    set({ settings })
    applyTheme(settings.theme)
  },

  detectAgents: async () => {
    const detectedAgents = await window.api.agents.detect()
    set({ detectedAgents })
  },

  updateSettings: (patch) => {
    const current = get().settings ?? DEFAULT_SETTINGS
    const next: Settings = { ...current, ...patch }
    set({ settings: next })
    void window.api.settings.set(next)
  },

  setAgentConfig: (id, patch) => {
    const current = get().settings ?? DEFAULT_SETTINGS
    const prev = current.agents[id] ?? { enabled: true }
    get().updateSettings({ agents: { ...current.agents, [id]: { ...prev, ...patch } } })
  },

  setFavoriteAgents: (ids) => get().updateSettings({ favoriteAgents: ids.slice(0, 3) }),

  setTerminalFontSize: (px) => get().updateSettings({ terminalFontSize: clampFont(px) }),
  setEditorFontSize: (px) => get().updateSettings({ editorFontSize: clampFont(px) }),
  adjustFontSize: (target, delta) => {
    const s = get()
    const settings = s.settings ?? DEFAULT_SETTINGS
    if (target === 'terminal') {
      const next =
        delta === 'reset' ? DEFAULT_TERMINAL_FONT_SIZE : (settings.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE) + delta
      s.setTerminalFontSize(next)
    } else {
      const next =
        delta === 'reset' ? DEFAULT_EDITOR_FONT_SIZE : (settings.editorFontSize ?? DEFAULT_EDITOR_FONT_SIZE) + delta
      s.setEditorFontSize(next)
    }
  },

  adjustReportZoom: (delta) => {
    const settings = get().settings ?? DEFAULT_SETTINGS
    get().updateSettings({ reportZoom: stepReportZoom(settings.reportZoom, delta) })
  },

  setAppZoomFactor: (factor) => {
    const zoom = clampAppZoom(factor)
    get().updateSettings({ appZoomFactor: zoom })
    void window.api.app.setZoomFactor(zoom)
  },

  setTheme: (theme) => {
    applyTheme(theme)
    get().updateSettings({ theme })
  },

  setDefaultTerminalCount: (count) => {
    get().updateSettings({ defaultTerminalCount: count })
  }
})
