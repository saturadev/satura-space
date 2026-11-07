import type { ReplaceResult, ReplaceTarget, SearchFileResult, SearchMatch } from '@shared/api'
import type { FileSearchState } from '../../../store/slices/ui'

export function matchTargets(file: SearchFileResult, matches: SearchMatch[]): ReplaceTarget {
  return { filePath: file.filePath, matches: matches.map((m) => ({ line: m.line, column: m.column })) }
}

export function allTargets(files: SearchFileResult[]): ReplaceTarget[] {
  return files.map((f) => matchTargets(f, f.matches))
}

export function runReplaceInFiles(
  rootPath: string,
  search: FileSearchState,
  targets: ReplaceTarget[]
): Promise<ReplaceResult> {
  return window.api.fs.replace({
    rootPath,
    query: search.query,
    caseSensitive: search.caseSensitive,
    wholeWord: search.wholeWord,
    regex: search.regex,
    replace: search.replaceQuery,
    preserveCase: search.preserveCase,
    targets
  })
}
