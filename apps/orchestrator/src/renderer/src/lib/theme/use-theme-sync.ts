import { useEffect } from 'react'
import { DEFAULT_THEME } from '@shared/types'
import { useAppStore } from '../../store'
import { retintTerminals } from '../terminal/terminal-registry'

// Pushes the active app theme into surfaces that render outside the DOM/CSS and therefore can't pick
// up the theme's CSS variables on their own — currently the xterm canvases. Monaco re-themes via its
// own prop in MonacoEditor (kept there so the heavy editor bundle stays lazily loaded).
export function useThemeSync(): void {
  const theme = useAppStore((s) => s.settings?.theme ?? DEFAULT_THEME)
  useEffect(() => {
    retintTerminals(theme)
  }, [theme])
}
