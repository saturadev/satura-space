
export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom'
export type SplitDirection = 'horizontal' | 'vertical'

export type ResolvedDropTarget = {
  scope: 'leaf' | 'root'
  groupId: string | null
  zone: DropZone
}

const OUTER_EDGE_PX = 30

export function zoneToSplit(zone: DropZone): [SplitDirection, 'first' | 'second'] {
  switch (zone) {
    case 'left':
      return ['horizontal', 'first']
    case 'right':
      return ['horizontal', 'second']
    case 'top':
      return ['vertical', 'first']
    case 'bottom':
      return ['vertical', 'second']
    default:
      return ['horizontal', 'second']
  }
}

const EDGE = 0.25

export function resolveDropZoneAt(x: number, y: number): ResolvedDropTarget | null {
  if (document.elementFromPoint(x, y)?.closest('[data-tabbar]')) return null
  const rootEl = document.querySelector('[data-workspace][data-active="true"]') as HTMLElement | null
  if (rootEl) {
    const r = rootEl.getBoundingClientRect()
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      const dl = x - r.left
      const dr = r.right - x
      const dt = y - r.top
      const db = r.bottom - y
      const min = Math.min(dl, dr, dt, db)
      if (min <= OUTER_EDGE_PX) {
        const zone: DropZone =
          min === dt ? 'top' : min === db ? 'bottom' : min === dl ? 'left' : 'right'
        return { scope: 'root', groupId: null, zone }
      }
    }
  }
  const el = document.elementFromPoint(x, y)
  const pane = el?.closest('[data-group-id]') as HTMLElement | null
  const groupId = pane?.getAttribute('data-group-id')
  if (!pane || !groupId) return null
  return { scope: 'leaf', groupId, zone: zoneFromPoint(pane.getBoundingClientRect(), x, y) }
}

export function zoneFromPoint(rect: DOMRect, x: number, y: number): DropZone {
  const px = (x - rect.left) / rect.width
  const py = (y - rect.top) / rect.height
  const left = px
  const right = 1 - px
  const top = py
  const bottom = 1 - py
  const min = Math.min(left, right, top, bottom)
  if (min > EDGE) return 'center'
  if (min === top) return 'top'
  if (min === bottom) return 'bottom'
  if (min === left) return 'left'
  return 'right'
}
