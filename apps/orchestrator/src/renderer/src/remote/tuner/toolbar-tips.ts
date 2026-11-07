const HOLD_MS = 450
const SLOP_PX = 10
const BAR = '[data-tuner-phone-scene] > [data-tuner-toolbar]'

function tipText(btn: HTMLElement): string {
  return (btn.getAttribute('data-ti-tip') || btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.textContent || '').trim()
}

export function installToolbarTips(): void {
  let timer = 0
  let start: { x: number; y: number; btn: HTMLElement } | null = null
  let bubble: HTMLElement | null = null
  let swallow: HTMLElement | null = null

  const hide = (): void => {
    if (timer) window.clearTimeout(timer)
    timer = 0
    start = null
    bubble?.remove()
    bubble = null
  }

  const show = (btn: HTMLElement): void => {
    const text = tipText(btn)
    if (!text) return
    const bar = btn.closest<HTMLElement>(BAR)
    const r = btn.getBoundingClientRect()
    const edge = bar ? bar.getBoundingClientRect().left : r.left
    bubble = document.createElement('div')
    bubble.dataset.toolbarTip = ''
    bubble.setAttribute('role', 'tooltip')
    bubble.textContent = text
    bubble.style.right = `${Math.round(window.innerWidth - edge + 8)}px`
    bubble.style.top = `${Math.round(r.top + r.height / 2)}px`
    document.body.appendChild(bubble)
    const box = bubble.getBoundingClientRect()
    if (box.top < 4) bubble.style.top = `${Math.round(r.top + r.height / 2 + 4 - box.top)}px`
    else if (box.bottom > window.innerHeight - 4) bubble.style.top = `${Math.round(r.top + r.height / 2 - (box.bottom - window.innerHeight + 4))}px`
    swallow = btn
    console.info(`[tuner] toolbar hint: ${text}`)
  }

  document.addEventListener(
    'pointerdown',
    (e) => {
      hide()
      swallow = null
      if (e.pointerType !== 'touch' || !(e.target instanceof Element)) return
      const btn = e.target.closest<HTMLElement>(`${BAR} button`)
      if (!btn || btn.closest('[data-scene-camera-menu], [role="dialog"], [role="menu"]')) return
      start = { x: e.clientX, y: e.clientY, btn }
      timer = window.setTimeout(() => {
        timer = 0
        if (start) show(start.btn)
      }, HOLD_MS)
    },
    true
  )
  document.addEventListener(
    'pointermove',
    (e) => {
      if (!start || bubble) return
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP_PX) hide()
    },
    true
  )
  const release = (): void => {
    const held = !!bubble
    hide()
    if (!held) swallow = null
  }
  document.addEventListener('pointerup', release, true)
  document.addEventListener('pointercancel', release, true)
  document.addEventListener(
    'click',
    (e) => {
      if (!swallow || !(e.target instanceof Node) || !swallow.contains(e.target)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      console.info(`[tuner] toolbar hint swallowed the click on ${tipText(swallow).slice(0, 40)}`)
      swallow = null
    },
    true
  )
  document.addEventListener(
    'contextmenu',
    (e) => {
      if (e.target instanceof Element && e.target.closest(`${BAR} button`)) e.preventDefault()
    },
    true
  )
}
