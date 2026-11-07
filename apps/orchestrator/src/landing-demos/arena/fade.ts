const OUT_MS = 140
const IN_MS = 220
const SETTLE_MS = 1500

let gen = 0

export function reduced(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function frames(n: number, fn: () => void): void {
  if (n <= 0) fn()
  else requestAnimationFrame(() => frames(n - 1, fn))
}

export function swapFade(fn: () => void): void {
  if (reduced()) {
    fn()
    return
  }
  const g = ++gen
  const root = document.documentElement
  const visible = (pane: HTMLElement): boolean => {
    const r = pane.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const top = (x: number, y: number): Element | undefined => document.elementsFromPoint(x, y).find((e) => !e.closest('[data-demo-shield], [data-satura-drift]'))
    return [0.2, 0.5, 0.8].some((fx) => [0.2, 0.5, 0.8].some((fy) => pane.contains(top(r.x + r.width * fx, r.y + r.height * fy) ?? null)))
  }
  const shown = [...document.querySelectorAll<HTMLElement>('[data-workspace-view] [data-tuner-pane]')].some(visible)
  if (!shown) root.dataset.demoSwapNow = ''
  console.info(`[demo] filter swap fades from a ${shown ? 'shown' : 'hidden'} Tuner`)
  root.dataset.demoSwap = 'out'
  setTimeout(() => {
    const seq = (): string => document.querySelector<HTMLElement>('[data-workspace-view] [data-unity-frame]')?.dataset.unityFrame ?? ''
    const before = seq()
    fn()
    const t0 = performance.now()
    let seen = 0
    let last = before
    const wait = (): void => {
      if (g !== gen) return
      const now = seq()
      if (now && now !== last) {
        last = now
        seen++
      }
      if (seen < 2 && performance.now() - t0 < SETTLE_MS) {
        requestAnimationFrame(wait)
        return
      }
      frames(2, () => {
        if (g !== gen) return
        delete root.dataset.demoSwapNow
        root.dataset.demoSwap = 'in'
        setTimeout(() => {
          if (g === gen) delete root.dataset.demoSwap
        }, IN_MS + 40)
      })
    }
    frames(2, wait)
  }, OUT_MS)
}
