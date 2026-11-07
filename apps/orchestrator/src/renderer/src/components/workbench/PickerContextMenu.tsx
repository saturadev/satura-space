import { FloatingMenu, menuItemClass } from '../ui/FloatingMenu'

export interface PickerMenuItem {
  label: string
  onClick: () => void
}

export function PickerContextMenu({
  x,
  y,
  items,
  onDismiss
}: {
  x: number
  y: number
  items: PickerMenuItem[]
  onDismiss: () => void
}) {
  return (
    <FloatingMenu x={x} y={y} onDismiss={onDismiss}>
      {items.map((it) => (
        <button
          key={it.label}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            it.onClick()
            onDismiss()
          }}
          className={menuItemClass}
        >
          {it.label}
        </button>
      ))}
    </FloatingMenu>
  )
}
