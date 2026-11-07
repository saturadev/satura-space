import { useLayoutEffect } from 'react'
import { useAppStore } from '../../store'

export function WorkspaceCreatingOverlay(): React.JSX.Element {
  const phase = useAppStore((s) => s.overlayPhase)
  const setOverlayMounted = useAppStore((s) => s.setOverlayMounted)
  const overlayEntered = useAppStore((s) => s.overlayEntered)
  const overlayLeft = useAppStore((s) => s.overlayLeft)

  useLayoutEffect(() => {
    setOverlayMounted(true)
    return () => setOverlayMounted(false)
  }, [setOverlayMounted])

  return (
    <div
      className={`absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-canvas ${phase === 'leaving' ? 'animate-bfade-out' : 'animate-bfade-in'}`}
      onAnimationEnd={(e) => {
        if (e.target !== e.currentTarget) return
        if (phase === 'leaving') overlayLeft()
        else overlayEntered()
      }}
    >
      <p className="animate-pulse text-xs font-medium tracking-wide text-zinc-500">
        Setting up workspace…
      </p>
    </div>
  )
}
