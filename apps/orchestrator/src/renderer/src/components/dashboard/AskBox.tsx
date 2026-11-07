import { useEffect, useRef, useState } from 'react'
import { AnchoredLayer } from '../ui/AnchoredLayer'
import { AskDriftPicker, type AskDriftTo } from '../tuner/AskDriftPicker'

export function AskBox({
  anchor,
  workspaceId,
  title,
  onSend,
  onClose
}: {
  anchor: HTMLElement
  workspaceId: string
  title: string
  onSend: (question: string, to: AskDriftTo) => Promise<{ sent: true; label: string } | { sent: false; error: string }>
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState<HTMLElement | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const askRef = useRef<HTMLButtonElement>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const t = window.setTimeout(() => fieldRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!note) return
    const t = window.setTimeout(onClose, 1600)
    return () => window.clearTimeout(t)
  }, [note, onClose])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Element | null
      if (boxRef.current?.contains(t) || anchor.contains(t) || t?.closest?.('[data-tuner-ask-picker]') || t?.closest?.('[data-menu-layer]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !picker) onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose, picker])

  const deliver = (to: AskDriftTo): void => {
    setPicker(null)
    const q = text.trim()
    if (!q) {
      setError('Write your question first.')
      return
    }
    setBusy(true)
    setError('')
    void onSend(q, to).then(
      (r) => {
        setBusy(false)
        if (r.sent) setNote(`Sent to ${r.label}.`)
        else setError(r.error)
      },
      () => {
        setBusy(false)
        setError('That did not go through. Try again.')
      }
    )
  }

  return (
    <AnchoredLayer anchor={anchor} side="bottom" align="end" gap={6} className="animate-menu-pop-in surface-overlay z-50 w-80 rounded-lg p-2">
      <div ref={boxRef} className="flex flex-col gap-2" data-dashboard-ask>
        <div className="truncate text-xs text-ink-3">Ask an agent about {title}</div>
        <textarea
          ref={fieldRef}
          value={text}
          rows={3}
          disabled={busy || !!note}
          placeholder="Why did this drop? Add a chart for…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (text.trim()) setPicker(askRef.current)
            }
          }}
          className="w-full resize-none rounded border border-white/10 bg-black/20 px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent/60"
        />
        {error && <div className="text-xs text-[#ef6e6b]">{error}</div>}
        {note && <div className="text-xs text-[#4cc38a]">{note}</div>}
        <div className="flex justify-end">
          <button
            ref={askRef}
            type="button"
            disabled={!text.trim() || busy || !!note}
            onClick={() => setPicker(askRef.current)}
            className="rounded bg-accent/80 px-3 py-1 text-xs font-medium text-white hover:bg-accent disabled:opacity-40"
          >
            {busy ? 'Asking…' : 'Ask…'}
          </button>
        </div>
      </div>
      {picker && <AskDriftPicker anchor={picker} workspaceId={workspaceId} current="" onPick={deliver} onClose={() => setPicker(null)} />}
    </AnchoredLayer>
  )
}
