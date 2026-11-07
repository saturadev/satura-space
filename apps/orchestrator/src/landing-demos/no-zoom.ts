export function installNoZoom(): void {
  document.documentElement.style.touchAction = 'pan-x pan-y'
  const stop = (e: Event): void => {
    if (e.cancelable) e.preventDefault()
  }
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, stop, { passive: false })
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1) stop(e)
    },
    { passive: false }
  )
}
