import { useContext, useEffect, useState, type ReactElement } from 'react'
import type { MediaSaveAsk } from '../../lib/media-loader'
import { ReportContext, type ReportBridge } from './report-context'
import { plainError } from './media-gate'

type SaveState = { state: 'idle' | 'busy' | 'done' | 'error'; text: string }

const IDLE: SaveState = { state: 'idle', text: '' }

export interface SaveVia {
  bridge: ReportBridge
  file: string
  root: string
}

export function SaveMedia({ ask, label = 'Save', className = '', via }: { ask: MediaSaveAsk | null; label?: string; className?: string; via?: SaveVia }): ReactElement | null {
  const api = useContext(ReportContext)
  const bridge = via?.bridge ?? api?.bridge
  const save = bridge?.saveMedia
  const file = via?.file ?? api?.host.file ?? ''
  const root = via?.root ?? api?.host.root ?? ''
  const [st, setSt] = useState<SaveState>(IDLE)
  useEffect(() => {
    if (st.state !== 'done') return
    const t = window.setTimeout(() => setSt(IDLE), 4000)
    return () => window.clearTimeout(t)
  }, [st])
  if (!save || !ask || bridge?.recording) return null
  const run = (): void => {
    if (st.state === 'busy') return
    console.info(`[save] ${ask.name}: Save tapped in the report`)
    setSt({ state: 'busy', text: 'Saving' })
    save(file, root, ask, (p) => setSt({ state: 'busy', text: p.total && p.got < p.total ? `Downloading ${Math.min(99, Math.floor((p.got / p.total) * 100))}%` : 'Saving' })).then(
      (r) => {
        console.info(`[save] ${ask.name}: ${r.saved ? `saved (${r.how ?? 'done'}${r.file ? ` to ${r.file}` : ''})` : 'not saved'}`)
        setSt(r.saved ? { state: 'done', text: r.how === 'file' && r.file ? `Saved to ${r.file.split(/[\\/]/).slice(-2).join('/')}` : r.how === 'download' ? 'Downloaded' : 'Saved' } : IDLE)
      },
      (e: unknown) => {
        console.warn(`[save] ${ask.name}: ${plainError(e)}`)
        setSt({ state: 'error', text: `Couldn't save it. ${plainError(e)}` })
      }
    )
  }
  return (
    <span className={`rk-save-wrap ${className}`} data-save-state={st.state}>
      {st.state === 'error' && <span className="rk-save-err">{st.text}</span>}
      <button type="button" className="rk-save" data-save-media={ask.kind} data-save-state={st.state} aria-busy={st.state === 'busy'} onClick={run} title={`Save ${ask.name}`} aria-label={`Save ${ask.name}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" />
        </svg>
        <span>{st.state === 'idle' ? label : st.state === 'error' ? 'Try again' : st.text}</span>
      </button>
    </span>
  )
}
