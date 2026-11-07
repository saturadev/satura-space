import type { SearchFileResult, SearchMatch } from '@shared/api'

export type SearchRow =
  | { type: 'file'; file: SearchFileResult }
  | { type: 'match'; file: SearchFileResult; match: SearchMatch }
  | { type: 'context'; file: SearchFileResult; line: number; text: string }

export function buildSearchRows(
  files: SearchFileResult[],
  collapsed: Set<string>,
  showContext: boolean
): SearchRow[] {
  const rows: SearchRow[] = []
  for (const file of files) {
    rows.push({ type: 'file', file })
    if (collapsed.has(file.relativePath)) continue

    if (showContext && file.context && file.context.length) {
      const matchLines = new Set(file.matches.map((m) => m.line))
      const entries: { line: number; row: SearchRow }[] = []
      for (const match of file.matches) entries.push({ line: match.line, row: { type: 'match', file, match } })
      for (const c of file.context) {
        if (matchLines.has(c.line)) continue
        entries.push({ line: c.line, row: { type: 'context', file, line: c.line, text: c.text } })
      }
      entries.sort((a, b) => a.line - b.line)
      for (const e of entries) rows.push(e.row)
    } else {
      for (const match of file.matches) rows.push({ type: 'match', file, match })
    }
  }
  return rows
}
