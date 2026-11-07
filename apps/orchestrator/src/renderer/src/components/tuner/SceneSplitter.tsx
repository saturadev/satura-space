import { useCallback, useState } from 'react'

export function SceneSplitter({
  direction,
  onDrag,
  onEnd,
  onReset,
  title,
  label
}: {
  direction: 'horizontal' | 'vertical'
  onDrag: (clientPos: number, container: DOMRect) => void
  onEnd?: () => void
  onReset?: () => void
  title?: string
  label?: string
}) {
  const isHorizontal = direction === 'horizontal'
  const [dragging, setDragging] = useState(false)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      const handle = event.currentTarget
      const container = handle.parentElement
      if (!container) return
      setDragging(true)
      handle.setPointerCapture(event.pointerId)
      const onPointerMove = (move: PointerEvent): void => {
        if (!handle.hasPointerCapture(event.pointerId)) return
        onDrag(isHorizontal ? move.clientX : move.clientY, container.getBoundingClientRect())
      }
      let done = false
      const cleanup = (): void => {
        if (done) return
        done = true
        setDragging(false)
        try {
          if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
        } catch {
        }
        handle.removeEventListener('pointermove', onPointerMove)
        handle.removeEventListener('pointerup', cleanup)
        handle.removeEventListener('pointercancel', cleanup)
        handle.removeEventListener('lostpointercapture', cleanup)
        onEnd?.()
      }
      handle.addEventListener('pointermove', onPointerMove)
      handle.addEventListener('pointerup', cleanup)
      handle.addEventListener('pointercancel', cleanup)
      handle.addEventListener('lostpointercapture', cleanup)
    },
    [isHorizontal, onDrag, onEnd]
  )

  return (
    <div
      role="separator"
      aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
      title={title}
      aria-label={label}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      data-scene-splitter={direction}
      className={`group relative z-20 shrink-0 bg-white/5 ${isHorizontal ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'}`}
    >
      <div
        className={`absolute ${isHorizontal ? '-inset-x-1 inset-y-0' : '-inset-y-1 inset-x-0'} ${
          dragging ? 'bg-sky-500/40' : 'group-hover:bg-sky-500/30'
        }`}
      />
    </div>
  )
}
