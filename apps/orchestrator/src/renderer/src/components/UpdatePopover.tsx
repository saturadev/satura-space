import { useState } from 'react'
import { FloatingMenu } from './ui/FloatingMenu'
import { useUpdaterStatus, useUpdateBlockReason } from '../lib/updater/use-updater'

export function UpdatePopover() {
  const status = useUpdaterStatus()
  const actionable =
    status.state === 'available' || status.state === 'downloading' || status.state === 'ready'
  const blockReason = useUpdateBlockReason(actionable)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)

  if (!actionable) return null

  const version = 'version' in status ? status.version : ''
  const percent = status.state === 'downloading' ? Math.max(0, Math.min(100, status.percent)) : 0

  return (
    <>
      <button
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setAnchor({ x: r.right - 288, y: r.bottom + 6 })
        }}
        title={status.state === 'downloading' ? `Downloading update · ${percent}%` : 'Update available'}
        className="relative flex h-6 min-w-[72px] items-center justify-center gap-1.5 overflow-hidden rounded bg-sky-500/15 px-2 text-accent transition-colors hover:bg-sky-500/25 [-webkit-app-region:no-drag]"
      >
        {status.state === 'downloading' && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 bg-sky-400/20 transition-[width] duration-150 ease-linear"
            style={{ width: `${percent}%` }}
          />
        )}
        <svg viewBox="0 0 24 24" className="relative h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
        </svg>
        <span className="relative text-xs font-medium tabular-nums">
          {status.state === 'downloading' ? `${percent}%` : 'Update'}
        </span>
      </button>

      {anchor && (
        <FloatingMenu x={anchor.x} y={anchor.y} onDismiss={() => setAnchor(null)} className="w-72 p-3">
          <div className="text-sm font-semibold text-zinc-100">
            {status.state === 'downloading'
              ? 'Downloading update…'
              : status.state === 'ready'
                ? 'Update ready'
                : 'Preparing update…'}
          </div>
          <div className="mt-0.5 text-xs text-zinc-400">
            {status.state === 'ready'
              ? `Version ${version} is ready to install.`
              : status.state === 'downloading'
                ? `Version ${version} · ${status.percent}%`
                : `Version ${version} is available.`}
          </div>
          {status.state === 'ready' && (
            <div className="mt-1.5 text-[11px] text-zinc-500">
              Your sessions and Unity editors stay open across the update.
            </div>
          )}

          {status.state === 'ready' ? (
            <>
              <button
                disabled={!!blockReason}
                onClick={() => {
                  window.api.updater.install()
                  setAnchor(null)
                }}
                className="mt-3 w-full rounded bg-sky-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-zinc-500"
              >
                Restart to update
              </button>
              {blockReason && (
                <div className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-300/90">
                  <svg viewBox="0 0 24 24" className="mt-0.5 h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  </svg>
                  <span>{blockReason}</span>
                </div>
              )}
            </>
          ) : status.state === 'available' ? (
            <div className="mt-2 text-[11px] text-zinc-500">The download starts automatically.</div>
          ) : (
            <div className="mt-2 text-[11px] text-zinc-500">You can keep working while it downloads.</div>
          )}
        </FloatingMenu>
      )}
    </>
  )
}
