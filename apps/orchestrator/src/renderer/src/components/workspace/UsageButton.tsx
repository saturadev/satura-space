import { Fragment, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { RateLimitWindow, UsageRemaining } from '@shared/api'
import { Popover } from '../ui/Popover'

function leftPercent(w: RateLimitWindow): number {
  return Math.max(0, Math.round(100 - w.usedPercent))
}

function barColorGray(left: number): string {
  if (left > 40) return 'bg-ink-2'
  if (left > 20) return 'bg-warn'
  return 'bg-err'
}

function barColorVivid(left: number): string {
  if (left > 40) return 'bg-accent'
  if (left > 20) return 'bg-warn'
  return 'bg-err'
}

function formatResetCountdown(resetsAt: number | null): string {
  if (!resetsAt) return ''
  const ms = resetsAt - Date.now()
  if (ms <= 0) return 'Resets now'
  const mins = Math.floor(ms / 60_000)
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (days > 0) return `Resets in ${days}d ${hours}h`
  if (hours > 0) return `Resets in ${hours}h ${m}m`
  return `Resets in ${m}m`
}

function formatResetShort(resetsAt: number | null): string {
  if (!resetsAt) return ''
  const ms = resetsAt - Date.now()
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60_000)
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${m}m`
  return `${m}m`
}

function windowSuffix(w: RateLimitWindow): string {
  return w.model || formatResetShort(w.resetsAt)
}

function formatTimeAgo(ts: number | undefined, verb: string): string {
  if (!ts) return ''
  const mins = Math.floor((Date.now() - ts) / 60_000)
  if (mins < 1) return `${verb} just now`
  if (mins < 60) return `${verb} ${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${verb} ${hours}h ago`
  return `${verb} ${Math.floor(hours / 24)}d ago`
}

function WindowRow({ label, window: w }: { label: string; window: RateLimitWindow }) {
  const left = leftPercent(w)
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="text-ink-2">{label}</span>
        <span className="tabular-nums text-ink">{left}% left</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
        <div className={`h-full rounded-full ${barColorVivid(left)}`} style={{ width: `${left}%` }} />
      </div>
      <div className="text-xs text-ink-3">{formatResetCountdown(w.resetsAt)}</div>
    </div>
  )
}

function StripBar({ left }: { left: number }) {
  return (
    <span className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-white/[0.08]">
      <span
        className={`block h-full rounded-full ${barColorGray(left)}`}
        style={{ width: `${left}%` }}
      />
    </span>
  )
}

function WarnIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 shrink-0 text-amber-500/80"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  )
}

export interface UsageButtonProps {
  data: UsageRemaining | null
  loading: boolean
  fetchRemaining: (force?: boolean) => Promise<void>
  icon: (size: number) => ReactNode
  brandColor: string
  title: string
  browserUrl?: string
  browserLabel?: string
  unavailableHint: string
  shortHint: string
  freshnessVerb: string
}

export function UsageButton({
  data,
  loading,
  fetchRemaining,
  icon,
  brandColor,
  title,
  browserUrl,
  browserLabel,
  unavailableHint,
  shortHint,
  freshnessVerb
}: UsageButtonProps) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void fetchRemaining()
    const id = setInterval(() => void fetchRemaining(), 60_000)
    return () => clearInterval(id)
  }, [fetchRemaining])

  const windows = [data?.session, data?.weekly, ...(data?.weeklyScoped ?? [])].filter(
    (w): w is RateLimitWindow => !!w
  )
  const hasWindows = windows.length > 0
  const stripLeft = data?.session
    ? leftPercent(data.session)
    : hasWindows
      ? Math.min(...windows.map(leftPercent))
      : 100

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      width="w-64"
      align="left"
      placement="top"
      trigger={({ toggle }) => (
        <button
          onClick={toggle}
          title={title}
          className="flex h-6 min-w-0 items-center gap-2 rounded px-2 text-ink-2 transition-colors hover:bg-white/[0.06] hover:text-ink"
        >
          <span className="flex shrink-0" style={{ color: brandColor }}>
            {icon(15)}
          </span>
          {hasWindows ? (
            <span className="flex items-center gap-2">
              {data?.stale ? <WarnIcon /> : <StripBar left={stripLeft} />}
              <span className="flex items-center gap-1 whitespace-nowrap text-xs tabular-nums">
                {windows.map((w, i) => (
                  <Fragment key={i}>
                    {i > 0 && <span className="text-ink-4">·</span>}
                    <span className="text-ink">{leftPercent(w)}% left</span>
                    <span className="text-ink-3">{windowSuffix(w)}</span>
                  </Fragment>
                ))}
              </span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-3">
              {!loading && data?.status === 'error' && <WarnIcon />}
              {loading ? '…' : shortHint}
            </span>
          )}
        </button>
      )}
    >
      <div className="space-y-3 p-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-xs font-medium text-ink-2">
            <span className="flex h-4 w-4 items-center justify-center" style={{ color: brandColor }}>
              {icon(14)}
            </span>
            {title}
          </span>
          <button
            onClick={() => void fetchRemaining(true)}
            title="Refresh"
            className="flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:bg-white/[0.07] hover:text-ink"
          >
            <svg
              viewBox="0 0 24 24"
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
          </button>
        </div>

        {hasWindows ? (
          <div className="space-y-3">
            {data?.session && <WindowRow label="Session · 5h" window={data.session} />}
            {data?.weekly && <WindowRow label="Weekly · 7d" window={data.weekly} />}
            {(data?.weeklyScoped ?? []).map((w, i) => (
              <WindowRow key={i} label={`Weekly · ${w.model ?? 'model'}`} window={w} />
            ))}
          </div>
        ) : loading ? (
          <div className="py-2 text-center text-[13px] text-ink-3">…</div>
        ) : data?.status === 'unavailable' ? (
          <div className="py-1 text-xs leading-relaxed text-ink-2">
            {data.error ?? unavailableHint}
          </div>
        ) : data?.status === 'error' ? (
          <div className="flex items-start gap-2 py-1 text-xs leading-relaxed text-amber-400">
            <svg
              viewBox="0 0 24 24"
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
              <path d="M12 9v4M12 17h.01" />
            </svg>
            <span>{data.error ?? 'Could not load usage.'}</span>
          </div>
        ) : (
          <div className="py-2 text-center text-[13px] text-ink-3">—</div>
        )}

        {hasWindows && data?.error && (
          <div className="flex items-start gap-2 text-xs leading-relaxed text-warn">
            <span className="mt-px">
              <WarnIcon />
            </span>
            <span>{data.error}</span>
          </div>
        )}

        {hasWindows && (
          <div className="text-xs text-ink-3">
            {formatTimeAgo(data?.updatedAt, freshnessVerb)}
          </div>
        )}

        {browserUrl && (
          <button
            onClick={() => void window.api.shell.openExternal(browserUrl)}
            className="flex items-center gap-1.5 text-xs text-accent transition-colors hover:text-sky-300"
          >
            <span>{browserLabel}</span>
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <path d="M15 3h6v6M10 14 21 3" />
            </svg>
          </button>
        )}
      </div>
    </Popover>
  )
}
