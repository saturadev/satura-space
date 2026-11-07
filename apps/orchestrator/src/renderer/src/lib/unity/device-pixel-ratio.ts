export const currentDpr = (): number => window.devicePixelRatio || 1

export function watchDevicePixelRatio(cb: (dpr: number) => void): () => void {
  let mql: MediaQueryList | null = null
  const onChange = (): void => {
    listen()
    cb(currentDpr())
  }
  const listen = (): void => {
    mql?.removeEventListener('change', onChange)
    mql = window.matchMedia(`(resolution: ${currentDpr()}dppx)`)
    mql.addEventListener('change', onChange)
  }
  listen()
  return () => {
    mql?.removeEventListener('change', onChange)
    mql = null
  }
}
