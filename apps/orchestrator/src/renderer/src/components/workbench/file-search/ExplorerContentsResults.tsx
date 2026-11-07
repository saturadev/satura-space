import { useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { buildSearchRegex } from '@shared/search-regex'
import { useAppStore } from '../../../store'
import { DEFAULT_FILE_SEARCH } from '../../../store/slices/ui'
import { openFileFromExplorer } from '../../../lib/editor/open-file-from-explorer'
import { requestGoto } from '../../../lib/editor/goto-line'
import { buildSearchRows } from './search-rows'
import { ContextRow, FileResultRow, MatchRow } from './SearchResultItems'
import { useFileSearchRunner } from './use-file-search-runner'
import { replacementForMatch, type ReplaceContext } from './replace-preview'
import { matchTargets, runReplaceInFiles } from './run-replace'

export function ExplorerContentsResults({
  workspaceId,
  groupId,
  worktreeId,
  rootPath
}: {
  workspaceId: string
  groupId: string
  worktreeId: string
  rootPath: string
}) {
  const search = useAppStore((s) => s.searchStateByWorktree[worktreeId]) ?? DEFAULT_FILE_SEARCH
  const updateSearchState = useAppStore((s) => s.updateSearchState)
  const bumpSearchRun = useAppStore((s) => s.bumpSearchRun)

  const cancel = useFileSearchRunner({
    worktreeId,
    rootPath,
    query: search.query,
    caseSensitive: search.caseSensitive,
    wholeWord: search.wholeWord,
    regex: search.regex,
    includeGlobs: search.includeGlobs,
    excludeGlobs: search.excludeGlobs,
    useGitignore: search.useGitignore,
    contextLines: search.contextLines,
    runNonce: search.runNonce
  })

  const collapsedSet = useMemo(() => new Set(search.collapsed), [search.collapsed])
  const rows = useMemo(
    () => buildSearchRows(search.result?.files ?? [], collapsedSet, search.contextLines > 0),
    [search.result, collapsedSet, search.contextLines]
  )

  const replaceCtx = useMemo<ReplaceContext>(
    () => ({
      regex: search.replaceOpen
        ? buildSearchRegex({
            query: search.query,
            regex: search.regex,
            wholeWord: search.wholeWord,
            caseSensitive: search.caseSensitive
          })
        : null,
      template: search.replaceQuery,
      preserveCase: search.preserveCase
    }),
    [
      search.replaceOpen,
      search.query,
      search.regex,
      search.wholeWord,
      search.caseSensitive,
      search.replaceQuery,
      search.preserveCase
    ]
  )

  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 22,
    overscan: 12
  })

  const toggleCollapse = (rel: string): void => {
    const next = collapsedSet.has(rel)
      ? search.collapsed.filter((p) => p !== rel)
      : [...search.collapsed, rel]
    updateSearchState(worktreeId, { collapsed: next })
  }

  const openAt = (filePath: string, line: number, column: number): void => {
    openFileFromExplorer(workspaceId, worktreeId, groupId, filePath)
    requestGoto(filePath, line, column)
  }

  const replaceTargets = (target: ReturnType<typeof matchTargets>): void => {
    void runReplaceInFiles(rootPath, search, [target])
      .then(() => bumpSearchRun(worktreeId))
      .catch((err) => console.error('[search] replace failed:', err))
  }

  if (search.query.trim() === '') {
    return <p className="px-3 py-2 text-xs text-zinc-600">Type to search in files</p>
  }

  const files = search.result?.files ?? []
  const fileCount = files.length
  const matchCount = files.reduce((n, f) => n + f.matches.length, 0)
  const searching = search.status === 'searching'
  const limitHit = search.result?.truncated

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-6 shrink-0 items-center gap-1.5 px-3 text-[11px] text-zinc-500">
        <span>
          {matchCount} {matchCount === 1 ? 'match' : 'matches'} in {fileCount}{' '}
          {fileCount === 1 ? 'file' : 'files'}
          {limitHit && ' (limit reached)'}
        </span>
        {searching && (
          <>
            <span className="h-2.5 w-2.5 animate-spin rounded-full border border-zinc-600 border-t-zinc-300" />
            <button
              onClick={cancel}
              className="ml-auto rounded px-1.5 text-[11px] text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
            >
              Cancel
            </button>
          </>
        )}
      </div>
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index]
            return (
              <div
                key={vi.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`
                }}
              >
                {row.type === 'file' ? (
                  <FileResultRow
                    file={row.file}
                    collapsed={collapsedSet.has(row.file.relativePath)}
                    onToggle={() => toggleCollapse(row.file.relativePath)}
                    onReplaceFile={
                      search.replaceOpen
                        ? () => replaceTargets(matchTargets(row.file, row.file.matches))
                        : undefined
                    }
                  />
                ) : row.type === 'context' ? (
                  <ContextRow
                    line={row.line}
                    text={row.text}
                    onOpen={() => openAt(row.file.filePath, row.line, 1)}
                  />
                ) : (
                  <MatchRow
                    file={row.file}
                    match={row.match}
                    onOpen={() => openAt(row.file.filePath, row.match.line, row.match.column)}
                    replacement={
                      replaceCtx.regex ? replacementForMatch(row.match, replaceCtx) : undefined
                    }
                    onReplace={
                      search.replaceOpen
                        ? () => replaceTargets(matchTargets(row.file, [row.match]))
                        : undefined
                    }
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
