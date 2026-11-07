import { useEffect, useState, type ReactElement } from 'react'
import { useReport } from '../components/report/report-context'
import { parsePatch, splitRows, type PatchHunk } from './patch'

const MAX_ROWS = 4000

function Num({ n }: { n?: number }): ReactElement {
  return <td className="rk-sd-no">{n ?? ''}</td>
}

function Inline({ hunks }: { hunks: PatchHunk[] }): ReactElement {
  let left = MAX_ROWS
  return (
    <table className="rk-sd">
      <tbody>
        {hunks.map((h, hi) => {
          const rows = h.lines.slice(0, Math.max(0, left))
          left -= rows.length
          return [
            <tr key={`h${hi}`} className="rk-sd-hunk">
              <td colSpan={4}>{h.header}</td>
            </tr>,
            ...rows.map((l, i) => (
              <tr key={`${hi}.${i}`} className={`rk-sd-${l.kind}`}>
                <Num n={l.old} />
                <Num n={l.new} />
                <td className="rk-sd-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</td>
                <td className="rk-sd-text">{l.text}</td>
              </tr>
            ))
          ]
        })}
      </tbody>
    </table>
  )
}

function Split({ hunks }: { hunks: PatchHunk[] }): ReactElement {
  let left = MAX_ROWS
  return (
    <table className="rk-sd split">
      <tbody>
        {hunks.map((h, hi) => {
          const rows = splitRows(h).slice(0, Math.max(0, left))
          left -= rows.length
          return [
            <tr key={`h${hi}`} className="rk-sd-hunk">
              <td colSpan={4}>{h.header}</td>
            </tr>,
            ...rows.map((r, i) => (
              <tr key={`${hi}.${i}`}>
                <Num n={r.a?.old} />
                <td className={`rk-sd-text ${r.a ? `rk-sd-${r.a.kind}` : 'rk-sd-none'}`}>{r.a?.text ?? ''}</td>
                <Num n={r.b?.new} />
                <td className={`rk-sd-text ${r.b ? `rk-sd-${r.b.kind}` : 'rk-sd-none'}`}>{r.b?.text ?? ''}</td>
              </tr>
            ))
          ]
        })}
      </tbody>
    </table>
  )
}

export default function FileDiff({
  root,
  path,
  oldPath,
  ref1,
  ref2,
  sideBySide
}: {
  root: string
  path: string
  oldPath?: string
  ref1: string
  ref2: string
  sideBySide: boolean
}): ReactElement {
  const api = useReport()
  const [patch, setPatch] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    api.bridge.git.patch(root, path, oldPath ?? path, ref1, ref2).then(
      (r) => {
        if (!alive) return
        if (r.ok) setPatch(r.value)
        else setError(r.error.message ?? 'This diff is not in the export')
      },
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e))
    )
    return () => {
      alive = false
    }
  }, [api, root, path, oldPath, ref1, ref2])
  if (error) return <div className="rk-gd-note">{error}</div>
  if (patch === null) return <div className="rk-gd-loading">Loading diff…</div>
  const parsed = parsePatch(patch)
  if (parsed.binary) return <div className="rk-gd-note">binary file</div>
  if (!parsed.hunks.length) return <div className="rk-gd-note">No text changes</div>
  const total = parsed.hunks.reduce((n, h) => n + h.lines.length, 0)
  return (
    <div className="rk-gd-static" data-static-diff={path}>
      {sideBySide ? <Split hunks={parsed.hunks} /> : <Inline hunks={parsed.hunks} />}
      {total > MAX_ROWS && <div className="rk-gd-note">{total - MAX_ROWS} more lines not shown</div>}
    </div>
  )
}
