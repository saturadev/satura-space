import { useCallback, useState } from 'react'
import type { TabGroupLayoutNode } from '@shared/types'
import { RATIO_MAX, RATIO_MIN, pathKey, type Side } from '@shared/pane-plan'
import { useAppStore } from '../../store'
import { collectGroupIds, isValidLayoutNode } from '../../lib/tab-tree'
import { TabGroupPanel, type GroupEdges } from './TabGroupPanel'

function ResizeHandle({
  direction,
  path,
  onRatioChange
}: {
  direction: 'horizontal' | 'vertical'
  path: string[]
  onRatioChange: (ratio: number) => void
}) {
  const isHorizontal = direction === 'horizontal'
  const [dragging, setDragging] = useState(false)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const handle = event.currentTarget
      const container = handle.parentElement
      if (!container) return
      setDragging(true)
      handle.setPointerCapture(event.pointerId)

      const onPointerMove = (move: PointerEvent): void => {
        if (!handle.hasPointerCapture(event.pointerId)) return
        const rect = container.getBoundingClientRect()
        const ratio = isHorizontal
          ? (move.clientX - rect.left) / rect.width
          : (move.clientY - rect.top) / rect.height
        onRatioChange(Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio)))
      }
      const cleanup = (): void => {
        setDragging(false)
        try {
          if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
        } catch {
        }
        handle.removeEventListener('pointermove', onPointerMove)
        handle.removeEventListener('pointerup', cleanup)
        handle.removeEventListener('pointercancel', cleanup)
      }
      handle.addEventListener('pointermove', onPointerMove)
      handle.addEventListener('pointerup', cleanup)
      handle.addEventListener('pointercancel', cleanup)
    },
    [isHorizontal, onRatioChange]
  )

  return (
    <div
      role="separator"
      aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
      aria-label="Resize panes"
      data-split-path={pathKey(path as Side[])}
      onPointerDown={onPointerDown}
      className={`group relative shrink-0 ${
        isHorizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
      }`}
    >
      <div
        className={`absolute rounded-full ${
          isHorizontal ? 'inset-y-1 left-[1px] w-0.5' : 'inset-x-1 top-[1px] h-0.5'
        } ${dragging ? 'bg-accent/60' : 'group-hover:bg-accent/40'}`}
      />
    </div>
  )
}

export function TabGroupSplitLayout({ workspaceId }: { workspaceId: string }) {
  const layout = useAppStore((s) => s.layoutByWorkspace[workspaceId])
  const setLayoutRatio = useAppStore((s) => s.setLayoutRatio)
  const fullscreenGroupId = useAppStore((s) => s.fullscreenGroupIdByWorkspace[workspaceId] ?? null)

  const fullscreenActive =
    !!fullscreenGroupId &&
    isValidLayoutNode(layout) &&
    collectGroupIds(layout).includes(fullscreenGroupId)

  if (!isValidLayoutNode(layout)) return null

  const allEdges: GroupEdges = { top: true, left: true, right: true }

  const full = fullscreenActive ? fullscreenGroupId : null

  const renderNode = (node: TabGroupLayoutNode, path: string[], edges: GroupEdges): React.ReactNode => {
    if (node.type === 'leaf') {
      const isFull = node.groupId === full
      return (
        <div className={isFull ? 'visible absolute inset-0 z-10' : 'h-full w-full'} data-fullscreen-group={isFull ? '' : undefined}>
          <TabGroupPanel workspaceId={workspaceId} groupId={node.groupId} edges={isFull ? allEdges : edges} />
        </div>
      )
    }
    if (!node.first || !node.second) return null
    const ratio = node.ratio ?? 0.5
    const isHorizontal = node.direction === 'horizontal'
    return (
      <div className={`flex h-full w-full min-h-0 min-w-0 ${isHorizontal ? 'flex-row' : 'flex-col'}`}>
        <div className="min-h-0 min-w-0" style={{ flex: `${ratio} 1 0%` }}>
          {renderNode(node.first, [...path, 'first'], isHorizontal ? { ...edges, right: false } : edges)}
        </div>
        <ResizeHandle
          direction={node.direction}
          path={path}
          onRatioChange={(r) => setLayoutRatio(workspaceId, path, r)}
        />
        <div className="min-h-0 min-w-0" style={{ flex: `${1 - ratio} 1 0%` }}>
          {renderNode(
            node.second,
            [...path, 'second'],
            isHorizontal ? { ...edges, left: false } : { ...edges, top: false }
          )}
        </div>
      </div>
    )
  }

  return <div className={`relative h-full w-full${full ? ' invisible' : ''}`}>{renderNode(layout, [], allEdges)}</div>
}
