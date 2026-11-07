import { useEffect, useState } from 'react'

export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api.window.isMaximized().then((value) => {
      if (!cancelled) setMaximized(value)
    })
    const unsubscribe = window.api.window.onMaximizeChanged(setMaximized)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return (
    <div className="flex h-full shrink-0 items-stretch [-webkit-app-region:no-drag]">
      <button
        onClick={() => window.api.window.minimize()}
        title="Minimize"
        aria-label="Minimize"
        className="flex h-full w-11 items-center justify-center text-ink-2 transition-colors hover:bg-elevated hover:text-ink"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5h10v1H0z" fill="currentColor" />
        </svg>
      </button>
      <button
        onClick={() => window.api.window.maximize()}
        title={maximized ? 'Restore' : 'Maximize'}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        className="flex h-full w-11 items-center justify-center text-ink-2 transition-colors hover:bg-elevated hover:text-ink"
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2 0v2H0v8h8V8h2V0H2zm6 9H1V3h7v6zM9 7H8V2H3V1h6v6z" fill="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M0 0v10h10V0H0zm9 9H1V1h8v8z" fill="currentColor" />
          </svg>
        )}
      </button>
      <button
        onClick={() => window.api.window.close()}
        title="Close"
        aria-label="Close"
        className="flex h-full w-11 items-center justify-center text-ink-2 transition-colors hover:bg-[#e81123] hover:text-white"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1 0L0 1l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4-4-4z" fill="currentColor" />
        </svg>
      </button>
    </div>
  )
}
