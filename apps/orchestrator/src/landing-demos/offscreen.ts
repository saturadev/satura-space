type Timer = ReturnType<typeof setTimeout>

function install(): void {
  if (window.parent === window || typeof IntersectionObserver === 'undefined') return
  const w = window
  const raf = w.requestAnimationFrame.bind(w)
  const caf = w.cancelAnimationFrame.bind(w)
  const set = w.setTimeout.bind(w)
  const clear = w.clearTimeout.bind(w)
  const every = w.setInterval.bind(w)
  let shown = true
  let next = -1
  const frames = new Map<number, FrameRequestCallback>()
  const held = new Map<Timer, () => void>()

  w.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    if (shown) return raf(cb)
    const id = next--
    frames.set(id, cb)
    return id
  }
  w.cancelAnimationFrame = (id: number): void => {
    if (id < 0) frames.delete(id)
    else caf(id)
  }
  w.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]): Timer => {
    if (typeof fn !== 'function') return set(fn, ms)
    const id: Timer = set(() => {
      const run = (): void => void fn(...args)
      if (shown) run()
      else held.set(id, run)
    }, ms)
    return id
  }) as typeof w.setTimeout
  w.clearTimeout = ((id: Timer | undefined): void => {
    if (id === undefined) return
    held.delete(id)
    clear(id)
  }) as typeof w.clearTimeout
  w.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]): Timer => {
    if (typeof fn !== 'function') return every(fn, ms)
    return every(() => {
      if (shown) fn(...args)
    }, ms)
  }) as typeof w.setInterval

  const wake = (): void => {
    const cbs = [...frames.values()]
    frames.clear()
    for (const cb of cbs) raf(cb)
    const runs = [...held.values()]
    held.clear()
    for (const r of runs) r()
  }
  const probe = document.createElement('div')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none;z-index:-1'
  const watch = (): void => {
    document.body.appendChild(probe)
    new IntersectionObserver(
      (entries) => {
        const on = entries.some((e) => e.isIntersecting)
        if (on === shown) return
        shown = on
        if (on) wake()
      },
      { rootMargin: '200px 0px', threshold: 0 }
    ).observe(probe)
  }
  if (document.body) watch()
  else document.addEventListener('DOMContentLoaded', watch, { once: true })
}

install()
