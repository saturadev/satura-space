import type { DropZone } from '../../lib/tab-drag'

function zoneClass(zone: DropZone): string {
  switch (zone) {
    case 'center':
      return 'inset-0'
    case 'left':
      return 'inset-y-0 left-0 w-1/2'
    case 'right':
      return 'inset-y-0 right-0 w-1/2'
    case 'top':
      return 'inset-x-0 top-0 h-1/2'
    case 'bottom':
      return 'inset-x-0 bottom-0 h-1/2'
  }
}

export function PaneDropZones({ zone }: { zone: DropZone | null }) {
  if (!zone) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-[65]" data-pane-drop-zone={zone}>
      <div className={`absolute border border-sky-400/60 bg-sky-500/25 ${zoneClass(zone)}`} />
    </div>
  )
}
