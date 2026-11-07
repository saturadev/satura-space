import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { RESTORE_NOTE, RESTORE_OPEN_LABEL, RESTORE_OTHER_LABEL, type ClaudeRestorePromptState, type ClaudeRestoreRow } from '@shared/claude-sessions'
import { relativeTimeShort } from '../lib/relative-time'
import { desktopCall } from './phone-actions'
import { dropRestorePrompt, takeChecked } from './restore-prompts'

const DEADLINE_MS = 10_000

type Answer = 'restore' | 'skip'

interface AnswerResult {
  resume: number
  close: number
  open: number
}

function withDeadline<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the desktop didn't answer in ${DEADLINE_MS / 1000} s`)), DEADLINE_MS)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

function Row({ row, checked, pending, locked, onToggle }: { row: ClaudeRestoreRow; checked: boolean; pending: boolean; locked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={locked}
      onClick={onToggle}
      className={`flex min-h-[54px] w-full items-center gap-3 px-3.5 py-2 text-left transition-opacity active:bg-white/[0.08] ${pending ? 'opacity-60' : ''}`}
      data-restore-row={row.key}
      data-restore-pending={pending ? 'true' : undefined}
    >
      <span
        aria-hidden
        className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border ${checked ? 'border-[#0a84ff] bg-[#0a84ff] text-white' : 'border-white/30 bg-transparent'}`}
      >
        {checked && <Check size={14} strokeWidth={3} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="line-clamp-2 text-[15px] leading-snug text-zinc-100">{row.title}</span>
        <span className="truncate text-[12.5px] text-zinc-400">
          {pending ? (checked ? 'Checking on the desktop…' : 'Unchecking on the desktop…') : [row.hint, row.updatedAt ? relativeTimeShort(row.updatedAt) : ''].filter(Boolean).join(' · ')}
        </span>
      </span>
    </button>
  )
}

export function RestorePromptCard({ prompt }: { prompt: ClaudeRestorePromptState }) {
  const [want, setWant] = useState<Record<string, boolean>>({})
  const [answering, setAnswering] = useState<Answer | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setWant({})
    setAnswering(null)
    setError('')
    console.info(`[claude-resume] phone shows the restore prompt of ${prompt.projectName || prompt.workspaceId}: ${prompt.open.length} tab(s), ${prompt.other.length} other, ${prompt.checked.length} checked`)
  }, [prompt.id])
  const rows = [...prompt.open, ...prompt.other]
  const isChecked = (key: string): boolean => (key in want ? want[key] : prompt.checked.includes(key))
  const name = prompt.projectName || 'this project'

  const toggle = (row: ClaudeRestoreRow): void => {
    if (answering) return
    const on = !isChecked(row.key)
    setWant((w) => ({ ...w, [row.key]: on }))
    setError('')
    console.info(`[claude-resume] phone ${on ? 'checks' : 'unchecks'} ${row.key} in the restore prompt of ${name}`)
    const settle = (): void =>
      setWant((w) => {
        if (w[row.key] !== on) return w
        const next = { ...w }
        delete next[row.key]
        return next
      })
    withDeadline(desktopCall<{ checked: string[] }>('restoreToggle', [prompt.workspaceId, prompt.id, row.key, on])).then(
      (r) => {
        takeChecked(prompt.workspaceId, prompt.id, r?.checked)
        settle()
      },
      (e: Error) => {
        settle()
        console.warn(`[claude-resume] phone ${on ? 'check' : 'uncheck'} of ${row.key} failed: ${e.message}`)
        setError(`Couldn't ${on ? 'check' : 'uncheck'} "${row.title}": ${e.message}`)
      }
    )
  }

  const answer = (kind: Answer): void => {
    if (answering) return
    const restore = kind === 'restore'
    const checked = rows.filter((r) => isChecked(r.key)).map((r) => r.key)
    setAnswering(kind)
    setError('')
    console.info(`[claude-resume] phone pressed ${restore ? 'Restore' : 'Skip'} in the restore prompt of ${name} with ${checked.length} checked`)
    withDeadline(desktopCall<AnswerResult>('restoreAnswer', [prompt.workspaceId, prompt.id, restore, checked])).then(
      (r) => {
        console.info(`[claude-resume] the desktop took the phone's ${restore ? 'Restore' : 'Skip'} for ${name}: resume ${r?.resume ?? 0}, close ${r?.close ?? 0}, open ${r?.open ?? 0}`)
        dropRestorePrompt(prompt.workspaceId, prompt.id)
      },
      (e: Error) => {
        console.warn(`[claude-resume] phone ${restore ? 'Restore' : 'Skip'} for ${name} failed: ${e.message}`)
        setAnswering(null)
        setError(`${restore ? 'Restore' : 'Skip'} didn't go through: ${e.message.replace(/\.$/, '')}. Tap ${restore ? 'Restore' : 'Skip'} to try again.`)
      }
    )
  }

  const busy = !!answering
  const section = (label: string, list: ClaudeRestoreRow[]) =>
    list.length > 0 && (
      <div className="mt-4">
        <div className="px-1 pb-1.5 text-[12.5px] font-medium text-zinc-400">{label}</div>
        <div className="overflow-hidden rounded-[12px] bg-white/[0.06]">
          {list.map((row, i) => (
            <div key={row.key} className={i > 0 ? 'border-t border-white/[0.08]' : ''}>
              <Row row={row} checked={isChecked(row.key)} pending={row.key in want} locked={busy} onToggle={() => toggle(row)} />
            </div>
          ))}
        </div>
      </div>
    )

  return (
    <div className="ws-swap absolute inset-0 flex flex-col bg-canvas" data-phone-restore={prompt.id} data-workspace-id={prompt.workspaceId} data-restore-state={answering ?? 'open'} data-own-pending>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-5">
        <div className="mx-auto w-full max-w-[460px]">
          <p className="text-[11px] uppercase tracking-wide text-amber-300/80">Waiting for your answer</p>
          <h2 className="mt-1.5 text-[19px] font-semibold leading-snug text-zinc-100">
            Restore Claude sessions in <span className="text-white">{name}</span>?
          </h2>
          <p className="mt-1 text-[13px] leading-snug text-zinc-400">{RESTORE_NOTE}</p>
          {section(RESTORE_OPEN_LABEL, prompt.open)}
          {section(RESTORE_OTHER_LABEL, prompt.other)}
        </div>
      </div>
      <div className="shrink-0 border-t border-white/[0.08] px-5 pb-3 pt-3">
        <div className="mx-auto flex w-full max-w-[460px] flex-col gap-2">
          {error && (
            <p className="text-[13px] leading-snug text-rose-300" role="alert" data-restore-error>
              {error}
            </p>
          )}
          <div className="flex gap-2.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => answer('skip')}
              className={`ws-press h-[46px] flex-1 rounded-full text-[16px] font-semibold text-zinc-100 disabled:opacity-60 ${answering === 'skip' ? 'bg-white/20' : 'bg-white/[0.1]'}`}
              data-restore-action="skip"
            >
              {answering === 'skip' ? 'Skipping…' : 'Skip'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => answer('restore')}
              className={`ws-press h-[46px] flex-1 rounded-full text-[16px] font-semibold text-white disabled:opacity-60 ${answering === 'restore' ? 'bg-[#0a84ff]/70' : 'bg-[#0a84ff]'}`}
              data-restore-action="restore"
            >
              {answering === 'restore' ? 'Restoring…' : 'Restore'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
