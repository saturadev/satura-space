import type { ITerminalOptions } from '@xterm/xterm'
import type { ThemeId } from '@shared/types'
import { activeThemeId } from '../theme/themes'
import { terminalThemeFor } from './terminal-themes'

const TERMINAL_SCROLLBAR_WIDTH = 8

export function buildDefaultTerminalOptions(
  fontSize = 14,
  themeId: ThemeId = activeThemeId()
): ITerminalOptions {
  return {
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: 'block',
    cursorInactiveStyle: 'outline',
    fontSize,
    fontFamily:
      '"JetBrains Mono Variable", "SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace',
    fontWeight: '400',
    fontWeightBold: '600',
    scrollback: 10000,
    overviewRuler: { width: TERMINAL_SCROLLBAR_WIDTH },
    allowTransparency: false,
    macOptionIsMeta: false,
    macOptionClickForcesSelection: true,
    drawBoldTextInBrightColors: true,
    theme: terminalThemeFor(themeId)
  }
}
