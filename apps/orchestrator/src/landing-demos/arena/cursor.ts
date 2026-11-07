export interface Cursor {
  x: number
  y: number
  inside: boolean
  down: boolean
}

let now: Cursor = { x: 0, y: 0, inside: false, down: false }
const subs = new Set<() => void>()

function set(next: Cursor): void {
  if (next.x === now.x && next.y === now.y && next.inside === now.inside && next.down === now.down) return
  now = next
  for (const s of subs) s()
}

const move = (e: PointerEvent): void => {
  if (!e.isTrusted) return
  if (e.pointerType !== 'mouse') {
    if (now.inside) set({ ...now, inside: false })
    return
  }
  set({ x: e.clientX, y: e.clientY, inside: true, down: e.type === 'pointerdown' ? true : e.type === 'pointerup' ? false : now.down })
}

const out = (e: MouseEvent): void => {
  if (e.isTrusted && !e.relatedTarget) set({ ...now, inside: false, down: false })
}

window.addEventListener('pointermove', move, { capture: true, passive: true })
window.addEventListener('pointerdown', move, { capture: true, passive: true })
window.addEventListener('pointerup', move, { capture: true, passive: true })
window.addEventListener('mouseout', out, { capture: true, passive: true })
window.addEventListener('blur', () => set({ ...now, inside: false, down: false }))

export function cursor(): Cursor {
  return now
}

export function onCursor(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}
