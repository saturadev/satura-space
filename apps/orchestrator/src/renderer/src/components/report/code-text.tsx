import type { ReactElement } from 'react'
import { DEFAULT_EDITOR_FONT_SIZE, DEFAULT_THEME } from '@shared/types'
import { useAppStore } from '../../store'
import { languageFromPath } from '../../lib/editor/language-from-path'
import MonacoEditor from '../workbench/MonacoEditor'

const noop = (): void => {}

export default function CodeText({
  path,
  rel,
  text,
  root,
  line,
  endLine
}: {
  path: string
  rel: string
  text: string
  root: string
  line?: number
  endLine?: number
}): ReactElement {
  const fontSize = useAppStore((s) => s.settings?.editorFontSize ?? DEFAULT_EDITOR_FONT_SIZE)
  const themeId = useAppStore((s) => s.settings?.theme ?? DEFAULT_THEME)
  return (
    <MonacoEditor
      path={`satura-report-code:///${path.replace(/^\/+/, '')}`}
      rootPath={root}
      value={text}
      language={languageFromPath(rel)}
      onChange={noop}
      onSave={noop}
      wrap={false}
      onToggleWrap={noop}
      fontSize={fontSize}
      themeId={themeId}
      readOnly
      highlight={line ? { line, endLine } : undefined}
    />
  )
}
