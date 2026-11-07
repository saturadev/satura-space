import { useEffect } from 'react'

export function QuitDialog({
  mode = 'quit',
  showKeep,
  onQuit,
  onKeep,
  onCloseWindow,
  onCancel
}: {
  mode?: 'quit' | 'close-primary'
  showKeep: boolean
  onQuit: () => void
  onKeep: () => void
  onCloseWindow?: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const closePrimary = mode === 'close-primary'
  const keepClass = closePrimary
    ? 'w-full rounded border border-white/15 bg-transparent px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-white/10 focus:outline-none'
    : 'w-full rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 focus:outline-none'

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 [-webkit-app-region:no-drag]"
      onMouseDown={onCancel}
    >
      <div
        className="animate-menu-pop-in surface-overlay w-[420px] max-w-[90vw] overflow-hidden rounded-xl [-webkit-app-region:no-drag]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-3">
          <h2 className="text-sm font-semibold text-zinc-100">
            {closePrimary ? 'Close this window?' : 'Quit Satura Space?'}
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
            {closePrimary
              ? 'Closing this window ends its workspaces, terminals, and Unity instances. Other windows stay open — or quit Satura Space entirely.'
              : 'This stops all running Unity instances and agents, ending any work in progress.'}
          </p>
        </div>
        <div className="flex flex-col gap-2 border-t border-white/10 bg-sunken px-4 py-3">
          <button
            onClick={onQuit}
            className="w-full rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 focus:outline-none"
          >
            {closePrimary ? 'Quit Satura Space' : 'Quit'}
          </button>
          {showKeep && (
            <div>
              <button onClick={onKeep} className={keepClass}>
                Quit but keep terminals
              </button>
              <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
                Quits the app but keeps your terminal sessions — and the agents running in them —
                alive in the background. Unity instances and streaming stop. Reopen Satura Space to
                reconnect to your terminals.
              </p>
            </div>
          )}
          {closePrimary && onCloseWindow && (
            <button
              onClick={onCloseWindow}
              className="w-full rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 focus:outline-none"
            >
              Close this window
            </button>
          )}
          <button
            onClick={onCancel}
            className="w-full rounded px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-white/10 hover:text-white"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
