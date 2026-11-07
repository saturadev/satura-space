import type { Tab, TabGroup, TabGroupLayoutNode } from '@shared/types'

export type SplitDirection = 'horizontal' | 'vertical'

export function buildSplitNode(
  existingGroupId: string,
  newGroupId: string,
  direction: SplitDirection,
  position: 'first' | 'second'
): TabGroupLayoutNode {
  const existingLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: existingGroupId }
  const newLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: newGroupId }
  return {
    type: 'split',
    direction,
    first: position === 'first' ? newLeaf : existingLeaf,
    second: position === 'second' ? newLeaf : existingLeaf,
    ratio: 0.5
  }
}

export function wrapRootSplit(
  root: TabGroupLayoutNode,
  newGroupId: string,
  direction: SplitDirection,
  position: 'first' | 'second'
): TabGroupLayoutNode {
  const newLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: newGroupId }
  return {
    type: 'split',
    direction,
    first: position === 'first' ? newLeaf : root,
    second: position === 'second' ? newLeaf : root,
    ratio: position === 'first' ? 1 / 3 : 2 / 3
  }
}

export function replaceLeaf(
  root: TabGroupLayoutNode,
  targetGroupId: string,
  replacement: TabGroupLayoutNode
): TabGroupLayoutNode {
  if (root.type === 'leaf') {
    return root.groupId === targetGroupId ? replacement : root
  }
  return {
    ...root,
    first: replaceLeaf(root.first, targetGroupId, replacement),
    second: replaceLeaf(root.second, targetGroupId, replacement)
  }
}

export function removeLeaf(
  root: TabGroupLayoutNode,
  targetGroupId: string
): TabGroupLayoutNode | null {
  if (root.type === 'leaf') {
    return root.groupId === targetGroupId ? null : root
  }
  if (root.first.type === 'leaf' && root.first.groupId === targetGroupId) {
    return root.second
  }
  if (root.second.type === 'leaf' && root.second.groupId === targetGroupId) {
    return root.first
  }
  const first = removeLeaf(root.first, targetGroupId)
  const second = removeLeaf(root.second, targetGroupId)
  if (first === null) return second
  if (second === null) return first
  return { ...root, first, second }
}

export function findSiblingGroupId(
  root: TabGroupLayoutNode,
  targetGroupId: string
): string | null {
  if (root.type === 'leaf') return null
  if (root.first.type === 'leaf' && root.first.groupId === targetGroupId) {
    return root.second.type === 'leaf' ? root.second.groupId : findFirstLeaf(root.second)
  }
  if (root.second.type === 'leaf' && root.second.groupId === targetGroupId) {
    return root.first.type === 'leaf' ? root.first.groupId : findFirstLeaf(root.first)
  }
  return (
    findSiblingGroupId(root.first, targetGroupId) ??
    findSiblingGroupId(root.second, targetGroupId)
  )
}

export function findFirstLeaf(root: TabGroupLayoutNode): string {
  return root.type === 'leaf' ? root.groupId : findFirstLeaf(root.first)
}

export function updateSplitRatio(
  root: TabGroupLayoutNode,
  path: string[],
  ratio: number
): TabGroupLayoutNode {
  if (path.length === 0) {
    return root.type === 'split' ? { ...root, ratio } : root
  }
  if (root.type !== 'split') return root
  const [segment, ...rest] = path
  if (segment === 'first') return { ...root, first: updateSplitRatio(root.first, rest, ratio) }
  if (segment === 'second') return { ...root, second: updateSplitRatio(root.second, rest, ratio) }
  return root
}

export function linearSplit(
  nodes: TabGroupLayoutNode[],
  direction: SplitDirection
): TabGroupLayoutNode {
  if (nodes.length === 1) return nodes[0]
  const [first, ...rest] = nodes
  return {
    type: 'split',
    direction,
    first,
    second: linearSplit(rest, direction),
    ratio: 1 / nodes.length
  }
}

export function collectGroupIds(root: TabGroupLayoutNode | undefined): string[] {
  if (!root) return []
  if (root.type === 'leaf') return [root.groupId]
  return [...collectGroupIds(root.first), ...collectGroupIds(root.second)]
}

export function isValidLayoutNode(node: unknown): node is TabGroupLayoutNode {
  if (!node || typeof node !== 'object') return false
  const n = node as Record<string, unknown>
  if (n.type === 'leaf') return typeof n.groupId === 'string'
  if (n.type === 'split') {
    return (
      (n.direction === 'horizontal' || n.direction === 'vertical') &&
      isValidLayoutNode(n.first) &&
      isValidLayoutNode(n.second)
    )
  }
  return false
}

export function shownTab<T extends Pick<Tab, 'id'>>(group: TabGroup, tabs: readonly T[]): T | undefined {
  const ordered = group.tabOrder
    .map((id) => tabs.find((t) => t.id === id))
    .filter((t): t is T => Boolean(t))
  return ordered.find((t) => t.id === group.activeTabId) ?? ordered[0]
}

export function slottedTabIds(
  layout: TabGroupLayoutNode | undefined,
  groups: readonly TabGroup[],
  tabs: readonly Pick<Tab, 'id'>[],
  fullscreenGroupId: string | null
): Set<string> {
  const out = new Set<string>()
  if (!isValidLayoutNode(layout)) return out
  const laidOut = collectGroupIds(layout)
  const rendered = fullscreenGroupId && laidOut.includes(fullscreenGroupId) ? [fullscreenGroupId] : laidOut
  for (const groupId of rendered) {
    const group = groups.find((g) => g.id === groupId)
    if (!group || group.hidden) continue
    const tab = shownTab(group, tabs)
    if (tab) out.add(tab.id)
  }
  return out
}
