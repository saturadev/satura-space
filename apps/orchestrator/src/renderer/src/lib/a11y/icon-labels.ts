const CONTROLS = 'button,[role="button"],[role="tab"],[role="menuitem"],[role="switch"],[role="checkbox"],a[href]'
const WORDS = /[\p{L}\p{N}]/u

const ours = new WeakSet<Element>()

export function iconLabel(el: Element): string | null {
  if (el.hasAttribute('aria-labelledby')) return null
  if (el.hasAttribute('aria-label') && !ours.has(el)) return null
  const tip = (el.getAttribute('title') || el.getAttribute('data-ti-tip') || '').trim()
  if (!tip) return null
  const text = (el.textContent ?? '').trim()
  if (WORDS.test(text)) return null
  return tip.split(/\s+\(/)[0].trim() || tip
}

function label(el: Element): void {
  const name = iconLabel(el)
  if (name === null) {
    if (ours.has(el) && WORDS.test((el.textContent ?? '').trim())) {
      ours.delete(el)
      el.removeAttribute('aria-label')
    }
    return
  }
  if (el.getAttribute('aria-label') === name) return
  ours.add(el)
  el.setAttribute('aria-label', name)
}

function sweep(node: Node): void {
  if (node.nodeType !== 1) return
  const el = node as Element
  if (el.matches(CONTROLS)) label(el)
  for (const c of Array.from(el.querySelectorAll(CONTROLS))) label(c)
}

export function installIconLabels(root: HTMLElement = document.body): () => void {
  sweep(root)
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        const el = r.target as Element
        if (el.matches(CONTROLS)) label(el)
        continue
      }
      for (const n of Array.from(r.addedNodes)) sweep(n)
      const parent = r.target.nodeType === 1 ? (r.target as Element).closest(CONTROLS) : r.target.parentElement?.closest(CONTROLS)
      if (parent) label(parent)
    }
  })
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'data-ti-tip', 'aria-label'] })
  return () => observer.disconnect()
}
