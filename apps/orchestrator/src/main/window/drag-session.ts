import type { DropTarget } from '@shared/api'
import { sameWorkspace, type WorkspaceIdentity } from '@shared/workspace-identity'
import { screen } from 'electron'
import {
  getManagedWindow,
  getWindowIdentity,
  listWindows,
  topWindowAt,
  windowContentOrigin,
  windowIdForWebContents
} from './window-manager'

const POLL_MS = 16

let sourceWcId: number | null = null
let dragLabel = ''
let dragOrigin: WorkspaceIdentity | null = null
let lastHoverId: string | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let lastCursor = { x: NaN, y: NaN }

function isAllowedTarget(windowId: string): boolean {
  if (sourceWcId != null && windowId === windowIdForWebContents(sourceWcId)) return true
  const targetIdentity = getWindowIdentity(windowId)
  if (!targetIdentity) return true
  return sameWorkspace(dragOrigin, targetIdentity)
}

function sendHoverEnd(windowId: string | null): void {
  if (!windowId) return
  const win = getManagedWindow(windowId)
  if (win) win.webContents.send('window:dragHoverEnd')
}

function clearHover(): void {
  if (lastHoverId) {
    sendHoverEnd(lastHoverId)
    lastHoverId = null
  }
}

function broadcastDragActive(activeState: boolean): void {
  for (const info of listWindows()) {
    const w = getManagedWindow(info.id)
    if (w) w.webContents.send('window:dragActive', activeState)
  }
}

export function beginDrag(
  sourceWebContentsId: number,
  label: string,
  origin: WorkspaceIdentity | null
): void {
  endDrag()
  sourceWcId = sourceWebContentsId
  dragLabel = label || ''
  dragOrigin = origin
  lastHoverId = null
  lastCursor = { x: NaN, y: NaN }
  pollTimer = setInterval(tick, POLL_MS)
  broadcastDragActive(true)
}

function localCursorOver(windowId: string, cursor: { x: number; y: number }): { x: number; y: number } | null {
  const origin = windowContentOrigin(windowId)
  return origin ? { x: cursor.x - origin.x, y: cursor.y - origin.y } : null
}

function tick(): void {
  if (sourceWcId == null) return
  const cursor = screen.getCursorScreenPoint()
  if (cursor.x === lastCursor.x && cursor.y === lastCursor.y) return
  lastCursor = cursor

  const topId = topWindowAt(cursor.x, cursor.y)
  if (!topId) {
    clearHover()
    return
  }
  if (lastHoverId && lastHoverId !== topId) sendHoverEnd(lastHoverId)
  lastHoverId = topId
  const win = getManagedWindow(topId)
  const local = localCursorOver(topId, cursor)
  if (win && local)
    win.webContents.send('window:dragHover', {
      x: local.x,
      y: local.y,
      label: dragLabel,
      allowed: isAllowedTarget(topId)
    })
}

export function currentDropTarget(): DropTarget {
  if (sourceWcId == null) return { target: 'self' }
  const cursor = screen.getCursorScreenPoint()
  const topId = topWindowAt(cursor.x, cursor.y)
  if (!topId) return { target: 'new' }
  if (topId === windowIdForWebContents(sourceWcId)) return { target: 'self' }
  if (!isAllowedTarget(topId)) return { target: 'rejected' }
  const local = localCursorOver(topId, cursor)
  return { target: topId, point: local ?? undefined }
}

export function completeDropFromRelease(): void {
  if (sourceWcId == null) return
  const target = currentDropTarget()
  const sourceId = windowIdForWebContents(sourceWcId)
  const source = sourceId ? getManagedWindow(sourceId) : null
  endDrag()
  if (source) source.webContents.send('window:dragComplete', target)
}

export function abortDrag(): void {
  for (const info of listWindows()) {
    const w = getManagedWindow(info.id)
    if (w) w.webContents.send('window:dragAbort')
  }
  endDrag()
}

export function endDrag(): void {
  const wasActive = sourceWcId != null
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  clearHover()
  sourceWcId = null
  dragLabel = ''
  dragOrigin = null
  if (wasActive) broadcastDragActive(false)
}
