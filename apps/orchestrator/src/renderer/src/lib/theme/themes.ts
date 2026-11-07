import { DEFAULT_THEME, type ThemeId } from '@shared/types'

export interface ThemeMeta {
  id: ThemeId
  label: string
  description: string
  family: 'dark' | 'light'
  swatch: {
    canvas: string
    panel: string
    ink: string
    accent: string
  }
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'dark',
    label: 'Tonal',
    description: 'Graphite panels on a darker window, separated by space instead of lines.',
    family: 'dark',
    swatch: { canvas: '#0f1013', panel: '#1a1c20', ink: '#e5e7eb', accent: '#8196ff' }
  }
]

const VALID_THEMES = new Set<ThemeId>(THEMES.map((t) => t.id))

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && VALID_THEMES.has(value as ThemeId)
}

export function applyTheme(theme: ThemeId): void {
  const id = isThemeId(theme) ? theme : DEFAULT_THEME
  document.documentElement.dataset.theme = id
}

export function activeThemeId(): ThemeId {
  const attr = document.documentElement.dataset.theme
  return isThemeId(attr) ? attr : DEFAULT_THEME
}
