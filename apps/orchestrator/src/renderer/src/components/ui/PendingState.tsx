import { useEffect, useState } from 'react'
import { debugLog } from '@shared/debug-log'

export const PENDING_DELAY_MS = 200

export function PendingState({
  label,
  tag,
  delay = PENDING_DELAY_MS,
  size = 'sm',
  bare = false,
  className = ''
}: {
  label: string
  tag: string
  delay?: number
  size?: 'sm' | 'lg'
  bare?: boolean
  className?: string
}) {
  const [shown, setShown] = useState(delay <= 0)
  useEffect(() => {
    if (delay <= 0) return
    const t = setTimeout(() => setShown(true), delay)
    return () => clearTimeout(t)
  }, [delay])
  useEffect(() => {
    if (!shown) return
    debugLog(`[pending] ${tag}: ${label}`)
    return () => debugLog(`[pending] ${tag}: done (${label})`)
  }, [shown, tag, label])
  if (!shown) return null
  const ring = size === 'lg' ? 'h-5 w-5' : 'h-3.5 w-3.5'
  if (bare)
    return (
      <div data-pending={tag} role="status" aria-label={label} title={label} className={`flex shrink-0 items-center justify-center ${className}`}>
        <span className={`${ring} animate-spin rounded-full border-2 border-white/15 border-t-white/70`} />
      </div>
    )
  return (
    <div data-pending={tag} role="status" className={`flex items-center justify-center gap-2 text-[11px] leading-snug text-zinc-400 ${className}`}>
      <span className={`${ring} shrink-0 animate-spin rounded-full border-2 border-white/15 border-t-white/70`} />
      <span className="min-w-0">{label}</span>
    </div>
  )
}
