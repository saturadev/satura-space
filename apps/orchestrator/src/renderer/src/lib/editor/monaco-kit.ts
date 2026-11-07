import type * as Monaco from 'monaco-editor'
import type { ThemeId } from '@shared/types'

export interface MonacoKit {
  monaco: typeof Monaco
  NO_UNICODE_HIGHLIGHT: { ambiguousCharacters: false; invisibleCharacters: false; nonBasicASCII: false }
  defineMonacoThemes: (monaco: typeof Monaco) => void
  monacoThemeName: (id: ThemeId) => string
}

let job: Promise<MonacoKit> | null = null

export function loadMonacoKit(): Promise<MonacoKit> {
  job ??= Promise.all([import('./monaco-setup'), import('./monaco-themes')]).then(([setup, themes]) => ({
    monaco: setup.monaco,
    NO_UNICODE_HIGHLIGHT: setup.NO_UNICODE_HIGHLIGHT,
    defineMonacoThemes: themes.defineMonacoThemes,
    monacoThemeName: themes.monacoThemeName
  }))
  return job
}
