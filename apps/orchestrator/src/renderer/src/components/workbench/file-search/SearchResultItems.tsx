import type { SearchFileResult, SearchMatch } from '@shared/api'
import { pathBasename } from '../../../lib/path'

const BEFORE_MAX = 80

function ReplaceGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h11a4 4 0 014 4v1" />
      <path d="M7 4L4 7l3 3" />
      <path d="M20 17H9a4 4 0 01-4-4v-1" />
      <path d="M17 20l3-3-3-3" />
    </svg>
  )
}

export function FileResultRow({
  file,
  collapsed,
  onToggle,
  onReplaceFile
}: {
  file: SearchFileResult
  collapsed: boolean
  onToggle: () => void
  onReplaceFile?: () => void
}) {
  const name = pathBasename(file.relativePath)
  const dir = file.relativePath.slice(0, file.relativePath.length - name.length).replace(/\/$/, '')
  return (
    <div className="group flex w-full items-center gap-1.5 px-2 py-px text-left text-[13px] text-zinc-200 hover:bg-white/5">
      <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <svg
          viewBox="0 0 24 24"
          className={`h-3 w-3 shrink-0 text-zinc-500 transition-transform ${collapsed ? '' : 'rotate-90'}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span className="shrink-0 font-medium">{name}</span>
        {dir && <span className="min-w-0 truncate text-xs text-zinc-600">{dir}</span>}
      </button>
      {onReplaceFile && (
        <button
          onClick={onReplaceFile}
          title="Replace all in file"
          className="hidden shrink-0 rounded p-0.5 text-zinc-400 hover:bg-white/10 hover:text-white group-hover:flex"
        >
          <ReplaceGlyph />
        </button>
      )}
      <span className="shrink-0 rounded bg-white/5 px-1.5 text-[10px] tabular-nums text-zinc-400">
        {file.matches.length}
      </span>
    </div>
  )
}

export function MatchRow({
  match,
  onOpen,
  replacement,
  onReplace
}: {
  file: SearchFileResult
  match: SearchMatch
  onOpen: () => void
  replacement?: string | null
  onReplace?: () => void
}) {
  let before = match.lineText.slice(0, match.matchStart)
  if (before.length > BEFORE_MAX) before = '…' + before.slice(before.length - BEFORE_MAX)
  const hit = match.lineText.slice(match.matchStart, match.matchEnd)
  const after = match.lineText.slice(match.matchEnd)
  const showReplaced = replacement != null

  return (
    <div className="group flex w-full items-baseline gap-2 py-px pl-6 pr-2 text-left text-xs hover:bg-white/5">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
        <span className="w-8 shrink-0 text-right tabular-nums text-zinc-600">{match.line}</span>
        <span className="min-w-0 truncate font-mono text-zinc-400">
          <span>{before}</span>
          <span
            className={
              showReplaced
                ? 'rounded-sm bg-rose-500/20 text-rose-200/80 line-through'
                : 'rounded-sm bg-amber-500/30 text-amber-100'
            }
          >
            {hit}
          </span>
          {showReplaced && (
            <span className="rounded-sm bg-emerald-500/25 text-emerald-200 no-underline">
              {replacement}
            </span>
          )}
          <span>{after}</span>
        </span>
      </button>
      {onReplace && (
        <button
          onClick={onReplace}
          title="Replace"
          className="hidden shrink-0 self-center rounded p-0.5 text-zinc-400 hover:bg-white/10 hover:text-white group-hover:flex"
        >
          <ReplaceGlyph />
        </button>
      )}
    </div>
  )
}

export function ContextRow({ line, text, onOpen }: { line: number; text: string; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-baseline gap-2 py-px pl-6 pr-2 text-left text-xs hover:bg-white/5"
    >
      <span className="w-8 shrink-0 text-right tabular-nums text-zinc-700">{line}</span>
      <span className="min-w-0 truncate font-mono text-zinc-600">{text}</span>
    </button>
  )
}
