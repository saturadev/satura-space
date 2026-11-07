const legacyByDoc = new WeakMap<Document, boolean>()

function legacyZoom(doc: Document): boolean {
  const was = legacyByDoc.get(doc)
  if (was !== undefined) return was
  const root = doc.body ?? doc.documentElement
  if (!root) return false
  const outer = doc.createElement('div')
  outer.style.cssText = 'position:absolute;left:-10000px;top:0;width:0;height:0;overflow:hidden;zoom:2;visibility:hidden'
  const inner = doc.createElement('div')
  inner.style.cssText = 'width:10px;height:10px'
  outer.appendChild(inner)
  root.appendChild(outer)
  const w = inner.getBoundingClientRect().width
  outer.remove()
  const legacy = Math.abs(w - 10) < 0.5
  legacyByDoc.set(doc, legacy)
  return legacy
}

export function zoomOf(el: Element): number {
  const view = el.ownerDocument.defaultView
  if (!view) return 1
  let z = 1
  for (let e: Element | null = el; e; e = e.parentElement) {
    const v = parseFloat(view.getComputedStyle(e).zoom)
    if (Number.isFinite(v) && v > 0) z *= v
  }
  return z
}

export function eventScale(el: Element | null): number {
  if (!el || !legacyZoom(el.ownerDocument)) return 1
  return zoomOf(el)
}

export function clientRect(el: Element): DOMRect {
  const r = el.getBoundingClientRect()
  if (!legacyZoom(el.ownerDocument)) return r
  const z = zoomOf(el)
  return Math.abs(z - 1) < 1e-6 ? r : new DOMRect(r.x * z, r.y * z, r.width * z, r.height * z)
}
