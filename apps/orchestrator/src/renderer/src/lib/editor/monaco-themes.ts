import type * as Monaco from 'monaco-editor'
import { DEFAULT_THEME, type ThemeId } from '@shared/types'
import { textMateThemeRules } from './textmate/textmate'

interface MonacoThemeSpec {
  base: 'vs' | 'vs-dark'
  bg: string
  fg: string
  lineNum: string
  lineNumActive: string
  cursor: string
  selection: string
  lineHighlight: string
  panel: string
  hairline: string
}

// Editor chrome colours per app theme. `base` supplies the syntax token colours (which read well on
// the matching surface); we only override the editor's own background/gutter/cursor/selection so the
// viewport matches the theme. Values mirror the CSS tokens in index.css.
const SPECS: Record<ThemeId, MonacoThemeSpec> = {
  dark: {
    base: 'vs-dark',
    bg: '#1a1c20',
    fg: '#d9dce1',
    lineNum: '#50555e',
    lineNumActive: '#9aa0a9',
    cursor: '#e5e7eb',
    selection: '#8196ff40',
    lineHighlight: '#ffffff08',
    panel: '#23262b',
    hairline: '#ffffff14'
  }
}

export function monacoThemeName(themeId: ThemeId): string {
  return `satura-${themeId in SPECS ? themeId : DEFAULT_THEME}`
}

let defined = false

export function defineMonacoThemes(monaco: typeof Monaco): void {
  if (defined) return
  defined = true
  for (const [id, s] of Object.entries(SPECS)) {
    monaco.editor.defineTheme(monacoThemeName(id as ThemeId), {
      base: s.base,
      inherit: true,
      rules: textMateThemeRules(),
      colors: {
        'editor.background': s.bg,
        'editor.foreground': s.fg,
        'editorGutter.background': s.bg,
        'editorLineNumber.foreground': s.lineNum,
        'editorLineNumber.activeForeground': s.lineNumActive,
        'editorCursor.foreground': s.cursor,
        'editor.selectionBackground': s.selection,
        'editor.inactiveSelectionBackground': s.selection,
        'editor.lineHighlightBackground': s.lineHighlight,
        'editor.lineHighlightBorder': '#00000000',
        'editorWidget.background': s.panel,
        'editorWidget.border': s.hairline,
        'editorSuggestWidget.background': s.panel,
        'editorHoverWidget.background': s.panel,
        'editorHoverWidget.border': s.hairline,
        'input.background': s.panel,
        'scrollbarSlider.background': `${s.fg}22`,
        'scrollbarSlider.hoverBackground': `${s.fg}44`
      }
    })
  }
}
