import { ActionMenu } from '../../lib/actions/ActionMenu'
import type { ActionNode } from '../../lib/actions/action-tree'

export function TabContextMenu({ x, y, nodes, onDismiss }: { x: number; y: number; nodes: ActionNode[]; onDismiss: () => void }) {
  return <ActionMenu x={x} y={y} nodes={nodes} onDismiss={onDismiss} />
}
