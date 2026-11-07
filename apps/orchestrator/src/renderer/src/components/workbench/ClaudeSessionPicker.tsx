import { useEffect, useRef, useState, type ReactNode } from 'react'
import { relativeTimeShort } from '../../lib/relative-time'
import { RESTORE_NOTE, RESTORE_OPEN_LABEL, RESTORE_OTHER_LABEL } from '@shared/claude-sessions'
import {
  applyRestoreChoice,
  dismissClaudePicker,
  pickClaudeSession,
  setRestoreRow,
  skipRestore,
  useClaudePickerStore,
  useClaudeRestoreStore,
  type ClaudePicker,
  type ClaudeRestorePrompt as RestorePrompt,
  type ClaudeSessionRow
} from '../../lib/claude-sessions/launch-restore'

const PICK_TITLE = 'Resume a Claude session'

function useDialogKeys(handler: (e: KeyboardEvent) => boolean, enabled = true): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (!ref.current(e)) return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [enabled])
}

function useScrollSelected(listRef: React.RefObject<HTMLDivElement | null>, selected: number): void {
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [listRef, selected])
}

function Shell({
  label,
  title,
  contained = false,
  focused = true,
  card,
  onBackdrop,
  children,
  footer
}: {
  label: string
  title: ReactNode
  contained?: boolean
  focused?: boolean
  card: Record<`data-${string}`, string | boolean>
  onBackdrop?: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focused) cardRef.current?.focus()
  }, [focused])
  return (
    <div
      className={`animate-bfade-in ${contained ? 'absolute' : 'fixed'} inset-0 z-[90] flex items-start justify-center bg-black/50 pt-[14vh] [-webkit-app-region:no-drag]`}
      onMouseDown={onBackdrop}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        {...card}
        className="animate-menu-pop-in surface-overlay flex max-h-[64vh] w-[30rem] max-w-[90vw] origin-top flex-col overflow-hidden rounded-lg outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="truncate px-4 pt-3 pb-2 text-xs text-zinc-400">{title}</div>
        {children}
        {footer}
      </div>
    </div>
  )
}

function CheckMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-white/30 bg-white/5"
    >
      {checked && (
        <svg
          viewBox="0 0 24 24"
          className="h-3 w-3 text-sky-400"
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
  )
}

function SessionRow({
  row,
  idx,
  selected,
  checked,
  onHover,
  onActivate
}: {
  row: ClaudeSessionRow
  idx: number
  selected: boolean
  checked?: boolean
  onHover: () => void
  onActivate: () => void
}) {
  return (
    <div
      data-idx={idx}
      data-claude-session-row
      data-session-id={row.sessionId}
      data-row-key={row.key}
      data-open={row.open ? 'true' : undefined}
      {...(checked !== undefined
        ? { role: 'checkbox', 'aria-checked': checked, 'data-checked': checked ? 'true' : 'false' }
        : { role: 'option', 'aria-selected': selected })}
      onMouseMove={onHover}
      onClick={onActivate}
      className={`flex cursor-default items-center gap-2.5 px-4 py-2 ${
        selected ? 'bg-white/[0.06]' : ''
      }`}
    >
      {checked !== undefined && <CheckMark checked={checked} />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-zinc-200">{row.title}</div>
        {row.hint && (
          <div className={`truncate text-[11px] ${row.open ? 'text-sky-400/80' : 'text-zinc-500'}`}>{row.hint}</div>
        )}
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">
        {relativeTimeShort(row.updatedAt)}
      </span>
    </div>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-4 pb-1 pt-2.5 text-[11px] font-medium text-zinc-500">{children}</div>
}

function RestoreView({ prompt, active }: { prompt: RestorePrompt; active: boolean }) {
  const rows = [...prompt.open, ...prompt.other]
  const checked = new Set(prompt.checked)
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  useScrollSelected(listRef, selected)
  const current = Math.min(selected, rows.length - 1)

  const toggle = (key: string): void => {
    try {
      setRestoreRow(prompt.workspaceId, key, !checked.has(key))
    } catch (e) {
      console.warn(`[claude-resume] ${(e as Error).message}`)
    }
  }
  const restore = (): void => {
    applyRestoreChoice(prompt.workspaceId, { restore: true, checked })
  }
  const skip = (): void => skipRestore(prompt.workspaceId)

  useDialogKeys((e) => {
    if (e.key === 'ArrowDown') setSelected(Math.min(current + 1, rows.length - 1))
    else if (e.key === 'ArrowUp') setSelected(Math.max(current - 1, 0))
    else if (e.key === ' ') {
      const row = rows[current]
      if (row) toggle(row.key)
    } else if (e.key === 'Enter') restore()
    else if (e.key === 'Escape') skip()
    else return false
    return true
  }, active)

  const name = prompt.projectName || 'this project'
  return (
    <Shell
      label={`Restore Claude sessions in ${name}?`}
      title={
        <>
          Restore Claude sessions in <span className="text-zinc-200">{name}</span>?
        </>
      }
      contained
      focused={active}
      card={{ 'data-claude-restore': true, 'data-workspace-id': prompt.workspaceId }}
      footer={
        <div className="flex justify-end gap-2 border-t border-white/10 px-3 py-2">
          <button
            onClick={skip}
            className="rounded px-3 py-1 text-xs font-medium text-zinc-300 hover:bg-white/10 hover:text-white"
          >
            Skip
          </button>
          <button
            onClick={restore}
            className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500"
          >
            Restore
          </button>
        </div>
      }
    >
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto border-t border-white/10" data-claude-restore-rows>
        <p className="px-4 pt-2 text-[11px] text-zinc-500">{RESTORE_NOTE}</p>
        <SectionLabel>{RESTORE_OPEN_LABEL}</SectionLabel>
        <div className="divide-y divide-white/5">
          {prompt.open.map((row, i) => (
            <SessionRow
              key={row.key}
              row={row}
              idx={i}
              selected={i === current}
              checked={checked.has(row.key)}
              onHover={() => setSelected(i)}
              onActivate={() => toggle(row.key)}
            />
          ))}
        </div>
        {prompt.other.length > 0 && <SectionLabel>{RESTORE_OTHER_LABEL}</SectionLabel>}
        <div className="divide-y divide-white/5">
          {prompt.other.map((row, j) => {
            const i = prompt.open.length + j
            return (
              <SessionRow
                key={row.key}
                row={row}
                idx={i}
                selected={i === current}
                checked={checked.has(row.key)}
                onHover={() => setSelected(i)}
                onActivate={() => toggle(row.key)}
              />
            )
          })}
        </div>
      </div>
    </Shell>
  )
}

function PickView({ picker }: { picker: ClaudePicker }) {
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  useScrollSelected(listRef, selected)
  const rows = picker.rows
  const current = Math.min(selected, Math.max(rows.length - 1, 0))

  useDialogKeys((e) => {
    if (e.key === 'ArrowDown') setSelected(Math.min(current + 1, Math.max(rows.length - 1, 0)))
    else if (e.key === 'ArrowUp') setSelected(Math.max(current - 1, 0))
    else if (e.key === 'Enter') {
      const row = rows[current]
      if (row) pickClaudeSession(row.sessionId)
    } else if (e.key === 'Escape') dismissClaudePicker()
    else return false
    return true
  })

  return (
    <Shell
      label={PICK_TITLE}
      title={PICK_TITLE}
      card={{ 'data-claude-session-picker': true }}
      onBackdrop={dismissClaudePicker}
    >
      <div ref={listRef} role="listbox" className="min-h-0 flex-1 divide-y divide-white/5 overflow-y-auto border-t border-white/10">
        {picker.loading ? (
          <p className="px-4 py-2.5 text-xs text-zinc-500">Loading sessions…</p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-2.5 text-xs text-zinc-500">No Claude sessions in this folder</p>
        ) : (
          rows.map((row, i) => (
            <SessionRow
              key={row.key}
              row={row}
              idx={i}
              selected={i === current}
              onHover={() => setSelected(i)}
              onActivate={() => pickClaudeSession(row.sessionId)}
            />
          ))
        )}
      </div>
    </Shell>
  )
}

export function ClaudeSessionPicker() {
  const picker = useClaudePickerStore((s) => s.picker)
  if (!picker) return null
  return <PickView key={picker.target.projectPath} picker={picker} />
}

export function ClaudeRestorePrompt({ workspaceId, active }: { workspaceId: string; active: boolean }) {
  const prompt = useClaudeRestoreStore((s) => s.prompts[workspaceId])
  if (!prompt) return null
  return <RestoreView prompt={prompt} active={active} />
}
