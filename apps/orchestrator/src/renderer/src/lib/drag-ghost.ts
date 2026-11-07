
let ghost: HTMLElement | null = null

export function mountDragGhost(label: string): void {
  if (ghost) {
    ghost.textContent = label || 'Terminal'
    return
  }
  const el = document.createElement('div')
  el.textContent = label || 'Terminal'
  el.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'z-index:9999',
    'pointer-events:none',
    'padding:4px 10px',
    'border-radius:6px',
    'font-size:12px',
    'line-height:1.2',
    'color:#e8ecf4',
    'background:#1b1f2a',
    'border:1px solid rgba(56,189,248,0.6)',
    'box-shadow:0 6px 20px rgba(0,0,0,0.55)',
    'white-space:nowrap',
    'max-width:240px',
    'overflow:hidden',
    'text-overflow:ellipsis',
    'visibility:hidden',
    'transform:translate(-9999px,-9999px)'
  ].join(';')
  document.body.appendChild(el)
  ghost = el
}

export function positionDragGhost(x: number, y: number): void {
  if (!ghost) return
  ghost.style.visibility = 'visible'
  ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`
}

export function unmountDragGhost(): void {
  if (ghost) {
    ghost.remove()
    ghost = null
  }
}
