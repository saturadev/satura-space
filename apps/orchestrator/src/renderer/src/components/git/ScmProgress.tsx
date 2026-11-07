import { useEffect, useState } from 'react'
import type { ScmRemoteProgress } from '@shared/git-scm'
import type { ScmProgress } from './use-scm-repository'

function remoteFor(latest: ScmProgress | undefined, remote: ScmRemoteProgress | null | undefined): ScmRemoteProgress | undefined {
  return latest && remote && remote.operation === latest.operation ? remote : undefined
}

export function ScmProgressBar({ progress, remote, className }: { progress: readonly ScmProgress[]; remote?: ScmRemoteProgress | null; className?: string }) {
  const latest = progress[progress.length - 1]
  if (!latest) return null
  const percent = remoteFor(latest, remote)?.percent
  return (
    <div className={`scm-progress ${className ?? ''}`} role="progressbar" aria-label={latest.label} aria-valuenow={percent}>
      {percent === undefined ? (
        <div className="scm-progress-bit bg-accent" />
      ) : (
        <div className="absolute inset-y-0 left-0 bg-accent transition-[width] duration-150" style={{ width: `${percent}%` }} />
      )}
    </div>
  )
}

export function ScmProgressLabel({ progress, remote, className }: { progress: readonly ScmProgress[]; remote?: ScmRemoteProgress | null; className?: string }) {
  const latest = progress[progress.length - 1]
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!latest) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [latest])
  if (!latest) return null
  const seconds = Math.floor((now - latest.started) / 1000)
  const more = progress.length > 1 ? ` (+${progress.length - 1})` : ''
  const live = remoteFor(latest, remote)
  const label = live?.cancelling
    ? `Stopping ${latest.operation.toLowerCase()}…`
    : live?.text
      ? `${latest.label.replace(/…$/, '')} · ${live.text}`
      : latest.label
  return (
    <span
      data-scm-progress
      className={`truncate text-[11px] tabular-nums text-ink-3 ${className ?? ''}`}
      title={[label, ...progress.slice(0, -1).map((p) => p.label)].join('\n')}
    >
      {label}
      {more}
      {seconds >= 10 ? `${live?.text ? ' ·' : ''} ${seconds}s` : ''}
    </span>
  )
}
