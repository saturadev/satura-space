import { FileText, RotateCw } from 'lucide-react'
import type { EditorFaultKind } from '@shared/unity/world'
import { openFileInWorkbench } from '../../lib/editor/open-file'

export function faultTitle(kind: EditorFaultKind, subject: string): string {
  return kind === 'hung' ? `${subject} isn't responding` : `${subject} crashed`
}

export function faultNote(kind: EditorFaultKind): string {
  return kind === 'hung'
    ? 'It may recover by itself. Restart closes it and opens a fresh editor.'
    : 'The editor has closed. Restart opens it again.'
}

export function openEditorLog(log: string, line: number): void {
  if (!log) return
  openFileInWorkbench({ file: log, ...(line > 0 ? { line } : {}), text: true, highlight: true })
}

const BUTTON =
  'flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-200 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40'

function FaultActions({ onRestart, restartDisabled, log, line }: { onRestart: () => void; restartDisabled?: boolean; log: string; line: number }) {
  return (
    <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
      <button type="button" onClick={onRestart} disabled={restartDisabled} className={BUTTON} data-editor-fault-restart>
        <RotateCw className="h-3.5 w-3.5" />
        Restart
      </button>
      {log && (
        <button type="button" onClick={() => openEditorLog(log, line)} className={BUTTON} data-editor-fault-log>
          <FileText className="h-3.5 w-3.5" />
          Open log
        </button>
      )}
    </div>
  )
}

export function EditorFaultCard({
  kind,
  subject,
  reason,
  log,
  line,
  onRestart,
  restartDisabled
}: {
  kind: EditorFaultKind
  subject: string
  reason: string
  log: string
  line: number
  onRestart: () => void
  restartDisabled?: boolean
}) {
  return (
    <div className="pointer-events-auto relative flex max-w-md flex-col items-center gap-1.5 px-6 text-center" data-editor-fault={kind}>
      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-rose-400" />
      <p className="text-sm text-rose-300">{faultTitle(kind, subject)}</p>
      {reason && <p className="break-words font-mono text-[11px] leading-snug text-zinc-400">{reason}</p>}
      <p className="text-xs leading-snug text-zinc-500">{faultNote(kind)}</p>
      <FaultActions onRestart={onRestart} restartDisabled={restartDisabled} log={log} line={line} />
    </div>
  )
}

export function EditorStallNote({
  label,
  pct,
  stall,
  log,
  onRestart
}: {
  label: string
  pct: number
  stall: string
  log: string
  onRestart: () => void
}) {
  return (
    <div className="pointer-events-auto relative flex max-w-md flex-col items-center gap-1.5 px-6 text-center" data-editor-stall>
      {label && (
        <p className="text-sm text-zinc-300">
          {label}
          {pct >= 0 && <span className="ml-1.5 tabular-nums text-zinc-500">{pct}%</span>}
        </p>
      )}
      <p className="break-words text-xs leading-snug text-amber-200/80">{stall}</p>
      <FaultActions onRestart={onRestart} log={log} line={0} />
    </div>
  )
}
