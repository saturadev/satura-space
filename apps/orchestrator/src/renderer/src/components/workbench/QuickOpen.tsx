import { useEffect, useMemo, useRef, useState } from 'react'
import type { FsPathInfo } from '@shared/api'
import { useAppStore } from '../../store'
import { pathBasename } from '../../lib/path'
import { rankQuickOpenFiles } from '../../lib/quick-open/quick-open-search'
import { useWorktreeFileList } from '../../lib/quick-open/use-worktree-file-list'
import { openFileFromExplorer } from '../../lib/editor/open-file-from-explorer'

function looksLikePath(query: string): boolean {
  return /^['"]?(~|\/)/.test(query.trim())
}

type QItem = { kind: 'path'; abs: string } | { kind: 'file'; rel: string }

export function QuickOpen() {
  const quickOpen = useAppStore((s) => s.quickOpen)
  if (!quickOpen) return null
  return <QuickOpenInner key={quickOpen.worktreeId} />
}

function QuickOpenInner() {
  const target = useAppStore((s) => s.quickOpen)!
  const closeQuickOpen = useAppStore((s) => s.closeQuickOpen)
  const { files, loading, error } = useWorktreeFileList(target.rootPath)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [pathInfo, setPathInfo] = useState<FsPathInfo | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const trimmed = query.trim()
  const isPathQuery = looksLikePath(query)
  const results = useMemo(
    () => (isPathQuery ? [] : rankQuickOpenFiles(query, files)),
    [query, files, isPathQuery]
  )

  useEffect(() => {
    setPathInfo(null)
    if (!isPathQuery) return
    let alive = true
    const t = setTimeout(() => {
      void window.api.fs.statPath(trimmed).then((info) => {
        if (alive) setPathInfo(info)
      })
    }, 100)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [trimmed, isPathQuery])

  const pathFile = pathInfo?.isFile ? pathInfo.resolved : null

  const items = useMemo<QItem[]>(
    () =>
      isPathQuery
        ? pathFile
          ? [{ kind: 'path', abs: pathFile }]
          : []
        : results.map((rel) => ({ kind: 'file', rel })),
    [isPathQuery, pathFile, results]
  )

  useEffect(() => setSelected(0), [query])
  useEffect(() => inputRef.current?.focus(), [])

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selected}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const openAbs = (abs: string): void => {
    openFileFromExplorer(target.workspaceId, target.worktreeId, target.groupId, abs, { preview: false })
    closeQuickOpen()
  }
  const openRel = (rel: string): void => {
    openAbs(target.rootPath ? `${target.rootPath}/${rel}` : rel)
  }
  const activate = (item: QItem): void => {
    if (item.kind === 'path') openAbs(item.abs)
    else openRel(item.rel)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (isPathQuery) {
        if (pathFile) openAbs(pathFile)
        else void window.api.fs.statPath(trimmed).then((info) => info.isFile && openAbs(info.resolved))
        return
      }
      const item = items[selected]
      if (item) activate(item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeQuickOpen()
    }
  }

  const root = target.rootPath
  const isExternal = (abs: string): boolean => !root || !(abs === root || abs.startsWith(`${root}/`))

  return (
    <div
      className="animate-bfade-in fixed inset-0 z-[70] flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={() => closeQuickOpen()}
    >
      <div
        className="animate-menu-pop-in surface-overlay flex max-h-[60vh] w-[36rem] max-w-[90vw] origin-top flex-col overflow-hidden rounded-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          placeholder="Search files by name, or paste a full path…"
          className="border-b border-white/10 bg-transparent px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
        />
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {isPathQuery ? (
            pathFile ? (
              <button
                data-idx={0}
                onMouseMove={() => setSelected(0)}
                onClick={() => openAbs(pathFile)}
                className={`flex w-full items-baseline gap-2 px-4 py-1.5 text-left text-sm ${
                  selected === 0 ? 'bg-white/10 text-white' : 'text-zinc-300'
                }`}
              >
                <span className="shrink-0 text-zinc-500">Open</span>
                <span className="shrink-0 truncate">{pathBasename(pathFile)}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-600">{pathFile}</span>
                {isExternal(pathFile) && (
                  <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300/90">
                    external
                  </span>
                )}
              </button>
            ) : pathInfo === null ? (
              <p className="px-4 py-2 text-xs text-zinc-500">Checking path…</p>
            ) : pathInfo.isDirectory ? (
              <p className="px-4 py-2 text-xs text-zinc-500">
                That&rsquo;s a folder, not a file — <span className="text-zinc-400">{pathInfo.resolved}</span>
              </p>
            ) : (
              <p className="px-4 py-2 text-xs text-zinc-500">No file at that path</p>
            )
          ) : loading ? (
            <p className="px-4 py-2 text-xs text-zinc-500">Scanning files…</p>
          ) : error ? (
            <p className="px-4 py-2 text-xs text-rose-400">Couldn&rsquo;t list files</p>
          ) : results.length === 0 ? (
            <p className="px-4 py-2 text-xs text-zinc-500">No matching files</p>
          ) : (
            results.map((rel, i) => {
              const name = pathBasename(rel)
              const dir = rel.slice(0, rel.length - name.length).replace(/\/$/, '')
              return (
                <button
                  key={rel}
                  data-idx={i}
                  onMouseMove={() => setSelected(i)}
                  onClick={() => openRel(rel)}
                  className={`flex w-full items-baseline gap-2 px-4 py-1.5 text-left text-sm ${
                    i === selected ? 'bg-white/10 text-white' : 'text-zinc-300'
                  }`}
                >
                  <span className="shrink-0 truncate">{name}</span>
                  {dir && <span className="min-w-0 truncate text-xs text-zinc-600">{dir}</span>}
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
