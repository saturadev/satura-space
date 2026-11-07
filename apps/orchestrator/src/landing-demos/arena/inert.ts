import { TIP_CLASS, TIP_EDGE, TIP_GAP } from '@renderer/lib/tuner/inspector/tooltip'

export const INERT_TIP = 'Not available in demo'

const INERT: string[] = ['[data-hierarchy-add-asset]']

const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown'] as const

const HINT_DELAY_MS = 300

function mark(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>(INERT.join(','))) {
    if (el.hasAttribute('title')) el.removeAttribute('title')
    if (el.hasAttribute('data-ti-tip')) el.removeAttribute('data-ti-tip')
    if (el.hasAttribute('data-demo-inert')) continue
    el.setAttribute('data-demo-inert', INERT_TIP)
    el.setAttribute('aria-disabled', 'true')
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.readOnly = true
  }
}

export function installInert(): () => void {
  let hint: HTMLDivElement | null = null
  let owner: Element | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const hide = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    hint?.remove()
    hint = null
    owner = null
  }
  const show = (el: Element): void => {
    hide()
    owner = el
    const r = el.getBoundingClientRect()
    hint = document.createElement('div')
    hint.setAttribute('data-demo-inert-hint', '')
    hint.setAttribute('role', 'tooltip')
    hint.className = TIP_CLASS
    hint.textContent = el.getAttribute('data-demo-inert') || INERT_TIP
    hint.style.visibility = 'hidden'
    document.body.appendChild(hint)
    const w = hint.offsetWidth
    const h = hint.offsetHeight
    const left = Math.max(TIP_EDGE, Math.min(r.left, window.innerWidth - w - TIP_EDGE))
    const below = r.bottom + TIP_GAP + h <= window.innerHeight - TIP_EDGE
    hint.style.left = `${left}px`
    hint.style.top = `${below ? r.bottom + TIP_GAP : r.top - TIP_GAP - h}px`
    hint.style.visibility = 'visible'
  }
  const block = (e: Event): void => {
    if (!e.isTrusted) return
    const t = (e.target as Element | null)?.closest?.('[data-demo-inert]')
    if (!t) return
    if (e.type === 'keydown' && !['Enter', ' '].includes((e as KeyboardEvent).key)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.type === 'click' || e.type === 'keydown') show(t)
  }
  const over = (e: PointerEvent): void => {
    const t = (e.target as Element | null)?.closest?.('[data-demo-inert]') ?? null
    if (t === owner && (hint || timer)) return
    if (!t && !owner) return
    hide()
    if (!t || e.pointerType === 'touch') return
    owner = t
    timer = setTimeout(() => {
      timer = null
      if (owner === t && t.isConnected) show(t)
    }, HINT_DELAY_MS)
  }
  const out = (e: PointerEvent): void => {
    if (!owner) return
    const to = e.relatedTarget as Node | null
    if (to && owner.contains(to)) return
    if ((e.target as Node | null) && owner.contains(e.target as Node)) hide()
  }
  for (const t of BLOCKED) window.addEventListener(t, block, { capture: true })
  window.addEventListener('pointermove', over, true)
  window.addEventListener('pointerout', out, true)
  window.addEventListener('scroll', hide, true)
  mark(document)
  let queued = false
  const mo = new MutationObserver(() => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      mark(document)
      if (owner && !owner.isConnected) hide()
    })
  })
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title', 'data-ti-tip'] })
  return () => {
    mo.disconnect()
    hide()
    for (const t of BLOCKED) window.removeEventListener(t, block, { capture: true })
    window.removeEventListener('pointermove', over, true)
    window.removeEventListener('pointerout', out, true)
    window.removeEventListener('scroll', hide, true)
  }
}
