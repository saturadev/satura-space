import type { ITheme } from '@xterm/xterm'
import { DEFAULT_THEME, type ThemeId } from '@shared/types'

export const TERMINAL_THEMES: Record<ThemeId, ITheme> = {
  dark: {
    background: '#1a1c20',
    foreground: '#d9dce1',
    cursor: '#e5e7eb',
    cursorAccent: '#1a1c20',
    selectionBackground: '#3a4366',
    selectionForeground: '#ffffff',
    black: '#1d1f21',
    red: '#cc6666',
    green: '#b5bd68',
    yellow: '#f0c674',
    blue: '#81a2be',
    magenta: '#b294bb',
    cyan: '#8abeb7',
    white: '#c5c8c6',
    brightBlack: '#666666',
    brightRed: '#d54e53',
    brightGreen: '#b9ca4a',
    brightYellow: '#e7c547',
    brightBlue: '#7aa6da',
    brightMagenta: '#c397d8',
    brightCyan: '#70c0b1',
    brightWhite: '#eaeaea',
    scrollbarSliderBackground: 'rgba(229, 231, 235, 0.16)',
    scrollbarSliderHoverBackground: 'rgba(229, 231, 235, 0.32)',
    scrollbarSliderActiveBackground: 'rgba(229, 231, 235, 0.45)'
  }
}

export function terminalThemeFor(themeId: ThemeId | undefined): ITheme {
  return TERMINAL_THEMES[themeId ?? DEFAULT_THEME] ?? TERMINAL_THEMES[DEFAULT_THEME]
}
