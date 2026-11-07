import type { AgentId, Tab, TabGroup, TabGroupLayoutNode } from '@shared/types'
import type { ChildPlacement } from '@shared/agent-exec'
import { buildSplitNode, collectGroupIds, replaceLeaf } from '../tab-tree'

export interface ChildTabInput {
  layout: TabGroupLayoutNode
  groups: TabGroup[]
  caller: Tab
  placement: ChildPlacement
  tabId: string
  ptyId: string
  newGroupId: string
  agentId: AgentId
  label: string
  customLabel: string | null
  sortOrder: number
  now: number
}

export interface ChildTabPlacement {
  tab: Tab
  groups: TabGroup[]
  layout: TabGroupLayoutNode
}

function emptyNeighbour(node: TabGroupLayoutNode, groupId: string, direction: 'horizontal' | 'vertical', groups: TabGroup[]): string | null {
  if (node.type === 'leaf') return null
  const second = node.second
  if (node.direction === direction && node.first.type === 'leaf' && node.first.groupId === groupId && second.type === 'leaf') {
    const next = groups.find((g) => g.id === second.groupId)
    if (next && next.tabOrder.length === 0 && !next.hidden) return next.id
  }
  return emptyNeighbour(node.first, groupId, direction, groups) ?? emptyNeighbour(node.second, groupId, direction, groups)
}

export function placeChildTab(input: ChildTabInput): ChildTabPlacement | null {
  const { layout, groups, caller, placement } = input
  if (!groups.some((g) => g.id === caller.groupId)) return null
  if (!collectGroupIds(layout).includes(caller.groupId)) return null
  const direction = placement === 'right' ? 'horizontal' : 'vertical'
  const reuse = placement === 'tab' ? null : emptyNeighbour(layout, caller.groupId, direction, groups)
  const groupId = placement === 'tab' ? caller.groupId : (reuse ?? input.newGroupId)
  const tab: Tab = {
    id: input.tabId,
    worktreeId: caller.worktreeId,
    groupId,
    contentType: 'terminal',
    ptyId: input.ptyId,
    label: input.label,
    customLabel: input.customLabel,
    agentId: input.agentId,
    parentPtyId: caller.ptyId,
    preview: false,
    sortOrder: input.sortOrder,
    createdAt: input.now
  }
  if (placement === 'tab') {
    return {
      tab,
      layout,
      groups: groups.map((g) =>
        g.id === caller.groupId
          ? { ...g, tabOrder: [...g.tabOrder, tab.id], activeTabId: g.activeTabId ?? tab.id }
          : g
      )
    }
  }
  if (reuse) {
    return {
      tab,
      layout,
      groups: groups.map((g) => (g.id === reuse ? { ...g, tabOrder: [tab.id], activeTabId: tab.id } : g))
    }
  }
  return {
    tab,
    groups: [...groups, { id: input.newGroupId, activeTabId: tab.id, tabOrder: [tab.id] }],
    layout: replaceLeaf(
      layout,
      caller.groupId,
      buildSplitNode(caller.groupId, input.newGroupId, direction, 'second')
    )
  }
}
