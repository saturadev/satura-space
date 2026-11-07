import { useAppStore } from '../../store'

function bandClass(zone: 'left' | 'right' | 'top' | 'bottom'): string {
  switch (zone) {
    case 'left':
      return 'inset-y-0 left-0 w-1/3'
    case 'right':
      return 'inset-y-0 right-0 w-1/3'
    case 'top':
      return 'inset-x-0 top-0 h-1/3'
    case 'bottom':
      return 'inset-x-0 bottom-0 h-1/3'
  }
}

export function RootDropZones() {
  const target = useAppStore((s) => s.externalDropTarget)
  if (!target || target.scope !== 'root' || target.zone === 'center') return null
  return (
    <div className="pointer-events-none absolute inset-0 z-[65]" data-root-drop-zone={target.zone}>
      <div className={`absolute border-2 border-sky-400/80 bg-sky-500/25 ${bandClass(target.zone)}`} />
    </div>
  )
}
