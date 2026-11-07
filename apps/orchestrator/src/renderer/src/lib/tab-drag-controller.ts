import type { DropTarget } from '@shared/api'
import type { WorkspaceIdentity } from '@shared/workspace-identity'
import { useAppStore } from '../store'
import { resolveDropZoneAt, zoneToSplit } from './tab-drag'
import { moveTabToWindow } from './panel-move'
import { mountDragGhost, positionDragGhost, unmountDragGhost } from './drag-ghost'
import { reorderSegment } from './terminal/report-groups'
import { useTabInsert, type TabInsert } from './tab-insert'
import { showDropFeedback } from './drop-feedback'
import { isWorkspaceDriven } from './agent-exec/driven'

function originForTab(tabId: string): WorkspaceIdentity {
  const st = useAppStore.getState()
  for (const ws of st.workspaces) {
    if ((st.tabsByWorkspace[ws.id] ?? []).some((t) => t.id === tabId)) {
      return { folderPath: ws.folderPath ?? '', worktreePath: ws.worktreePath ?? ws.folderPath ?? '' }
    }
  }
  return { folderPath: '', worktreePath: '' }
}

function scriptDriven(tabId: string): boolean {
  const st = useAppStore.getState()
  return st.workspaces.some((ws) => isWorkspaceDriven(ws.id) && (st.tabsByWorkspace[ws.id] ?? []).some((t) => t.id === tabId))
}

function isUnityPlayerTab(tabId: string): boolean {
  const st = useAppStore.getState()
  for (const tabs of Object.values(st.tabsByWorkspace)) {
    const tab = tabs.find((t) => t.id === tabId)
    if (tab) return tab.contentType === 'unity-instance-player' || tab.contentType === 'unity-scratchpad'
  }
  return false
}

const THRESHOLD_PX = 5
const EDGE_SCROLL_PX = 28
const EDGE_SCROLL_STEP = 8

type DragMode = { kind: 'unit' } | { kind: 'seg'; owner: string; parent: string }

let pending: { tabId: string; label: string; startX: number; startY: number; mode: DragMode } | null = null
let lastPoint: { x: number; y: number } | null = null
let scrollRaf = 0
let active = false
let captureEl: HTMLElement | null = null
let capturePointerId: number | null = null
let dragTabId: string | null = null
let scriptDrag = false

export function isDragSourceWindow(): boolean {
  return active
}

window.api.window.onDragComplete((target) => {
  const tabId = dragTabId
  dragTabId = null
  if (!tabId) return
  clearLocalDragUi()
  if (target.target === 'self') return
  void applyDrop(tabId, target, { x: 0, y: 0 })
})

function teardown(): void {
  window.removeEventListener('pointermove', onPointerMove, true)
  window.removeEventListener('pointerup', onPointerUp, true)
  window.removeEventListener('pointercancel', onPointerUp, true)
  window.removeEventListener('lostpointercapture', onLostCapture, true)
  window.removeEventListener('keydown', onKeyDown, true)
  if (captureEl != null && capturePointerId != null) {
    try {
      if (captureEl.hasPointerCapture(capturePointerId))
        captureEl.releasePointerCapture(capturePointerId)
    } catch {
    }
  }
  captureEl = null
  capturePointerId = null
  document.body.classList.remove('dragging')
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
  scrollRaf = 0
  lastPoint = null
  useTabInsert.setState({ target: null })
  pending = null
  active = false
  scriptDrag = false
}

function dragMode(tabId: string): DragMode {
  const st = useAppStore.getState()
  for (const tabs of Object.values(st.tabsByWorkspace)) {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) continue
    const owner = tab.attachedTo ? tabs.find((t) => t.id === tab.attachedTo && t.groupId === tab.groupId && t.contentType === 'terminal') : undefined
    if (!owner) return { kind: 'unit' }
    const el = document.querySelector(`[data-seg-tab="${CSS.escape(tabId)}"]`)
    return { kind: 'seg', owner: owner.id, parent: el?.getAttribute('data-seg-parent') ?? '' }
  }
  return { kind: 'unit' }
}

function barAt(x: number, y: number): HTMLElement | null {
  return (document.elementFromPoint(x, y)?.closest('[data-tabbar]') as HTMLElement | null) ?? null
}

function unitTargetAt(x: number, y: number): TabInsert | null {
  const bar = barAt(x, y)
  const groupId = bar?.getAttribute('data-tabbar-group')
  if (!bar || !groupId) return null
  for (const u of Array.from(bar.querySelectorAll<HTMLElement>('[data-tab-unit]'))) {
    const r = u.getBoundingClientRect()
    if (x < r.left + r.width / 2) return { kind: 'unit', groupId, before: u.getAttribute('data-tab-unit') }
  }
  return { kind: 'unit', groupId, before: null }
}

function segSiblings(mode: { owner: string; parent: string }): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-seg-tab][data-seg-owner="${CSS.escape(mode.owner)}"]`)).filter(
    (el) => el.getAttribute('data-seg-parent') === mode.parent
  )
}

function segTargetAt(x: number, y: number, mode: { owner: string; parent: string }): TabInsert | null {
  const unit = document.querySelector<HTMLElement>(`[data-tab-unit="${CSS.escape(mode.owner)}"]`)
  if (!unit) return null
  const box = unit.getBoundingClientRect()
  if (y < box.top - 10 || y > box.bottom + 10 || x < box.left - 16 || x > box.right + 16) return null
  const sibs = segSiblings(mode)
  if (sibs.length < 2) return null
  if (x < sibs[0].getBoundingClientRect().left - 24) return null
  for (const el of sibs) {
    const r = el.getBoundingClientRect()
    if (x < r.left + r.width / 2) return { kind: 'seg', owner: mode.owner, parent: mode.parent, before: el.getAttribute('data-seg-tab') }
  }
  return { kind: 'seg', owner: mode.owner, parent: mode.parent, before: null }
}

function targetAt(x: number, y: number): TabInsert | null {
  if (!pending) return null
  return pending.mode.kind === 'seg' ? segTargetAt(x, y, pending.mode) : unitTargetAt(x, y)
}

function updateTarget(): void {
  if (!lastPoint) return
  const next = targetAt(lastPoint.x, lastPoint.y)
  const cur = useTabInsert.getState().target
  if (JSON.stringify(cur) !== JSON.stringify(next)) useTabInsert.setState({ target: next })
}

function scrollerOf(bar: HTMLElement | null): HTMLElement | null {
  return (bar?.querySelector('[data-tab-unit]')?.parentElement as HTMLElement | null) ?? null
}

function edgeScroll(): void {
  scrollRaf = 0
  if (!active || !lastPoint) return
  const el = scrollerOf(barAt(lastPoint.x, lastPoint.y))
  if (el && el.scrollWidth > el.clientWidth) {
    const r = el.getBoundingClientRect()
    const dx = lastPoint.x < r.left + EDGE_SCROLL_PX ? -EDGE_SCROLL_STEP : lastPoint.x > r.right - EDGE_SCROLL_PX ? EDGE_SCROLL_STEP : 0
    if (dx) {
      const before = el.scrollLeft
      el.scrollLeft += dx
      if (el.scrollLeft !== before) updateTarget()
    }
  }
  scrollRaf = requestAnimationFrame(edgeScroll)
}

function clearLocalDragUi(): void {
  const s = useAppStore.getState()
  s.setDraggingTabId(null)
  s.setExternalDropTarget(null)
  unmountDragGhost()
}

function onPointerMove(e: PointerEvent): void {
  if (!pending) return
  lastPoint = { x: e.clientX, y: e.clientY }
  if (active) {
    if (pending.mode.kind === 'seg' || scriptDrag) positionDragGhost(e.clientX, e.clientY)
    if (scriptDrag) useAppStore.getState().setExternalDropTarget(resolveDropZoneAt(e.clientX, e.clientY))
    updateTarget()
    return
  }
  if (
    Math.abs(e.clientX - pending.startX) < THRESHOLD_PX &&
    Math.abs(e.clientY - pending.startY) < THRESHOLD_PX
  ) {
    return
  }
  active = true
  document.body.classList.add('dragging')
  useAppStore.getState().setDraggingTabId(pending.tabId)
  if (pending.mode.kind === 'seg') {
    mountDragGhost(pending.label)
    positionDragGhost(e.clientX, e.clientY)
  } else if (scriptDriven(pending.tabId)) {
    scriptDrag = true
    mountDragGhost(pending.label)
    positionDragGhost(e.clientX, e.clientY)
    useAppStore.getState().setExternalDropTarget(resolveDropZoneAt(e.clientX, e.clientY))
  } else {
    dragTabId = pending.tabId
    window.api.window.dragBegin(pending.label, originForTab(pending.tabId))
  }
  updateTarget()
  if (!scrollRaf) scrollRaf = requestAnimationFrame(edgeScroll)
}

function applySegmentDrop(tabId: string, target: TabInsert | null): void {
  if (!target || target.kind !== 'seg' || target.before === tabId) return
  const st = useAppStore.getState()
  const owner = Object.values(st.tabsByWorkspace).flat().find((t) => t.id === target.owner)
  if (!owner) return
  let flat: [string, string][] = []
  try {
    flat = JSON.parse(document.querySelector(`[data-tab-unit="${CSS.escape(target.owner)}"]`)?.getAttribute('data-seg-flat') ?? '[]') as [string, string][]
  } catch {
    flat = []
  }
  const ids = flat.filter(([id, parent]) => parent === target.parent && id !== tabId).map(([id]) => id)
  const at = target.before ? ids.indexOf(target.before) : -1
  if (at >= 0) ids.splice(at, 0, tabId)
  else ids.push(tabId)
  const files = ids.map((id) => st.viewerFileByTab[id]).filter((f): f is string => !!f)
  reorderSegment(owner, files)
}

async function onPointerUp(e: PointerEvent): Promise<void> {
  const wasActive = active
  const tabId = pending?.tabId
  const mode = pending?.mode
  const release = { x: e.clientX, y: e.clientY }
  const local = scriptDrag
  const segTarget = wasActive && mode?.kind === 'seg' ? segTargetAt(release.x, release.y, mode) : null
  teardown()
  if (!wasActive || !tabId) return
  if (mode?.kind === 'seg') {
    useAppStore.getState().setDraggingTabId(null)
    unmountDragGhost()
    applySegmentDrop(tabId, segTarget)
    return
  }
  dragTabId = null
  clearLocalDragUi()
  if (local) {
    await applyDrop(tabId, { target: 'self' }, release)
    return
  }
  if (scriptDriven(tabId) && release.x >= 0 && release.y >= 0 && release.x <= window.innerWidth && release.y <= window.innerHeight) {
    window.api.window.dragAbort()
    await applyDrop(tabId, { target: 'self' }, release)
    return
  }
  const target = await window.api.window.dragEnd()
  await applyDrop(tabId, target, release)
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  const wasActive = active
  const seg = pending?.mode.kind === 'seg' || scriptDrag
  teardown()
  if (!wasActive) return
  e.preventDefault()
  e.stopPropagation()
  dragTabId = null
  clearLocalDragUi()
  if (!seg) window.api.window.dragAbort()
}

function onLostCapture(): void {
  if (!pending && !active) return
  if (captureEl == null || capturePointerId == null) return
  try {
    captureEl.setPointerCapture(capturePointerId)
  } catch {
  }
}

async function applyDrop(
  tabId: string,
  target: DropTarget,
  release: { x: number; y: number }
): Promise<void> {
  if (target.target === 'self') {
    const bar = unitTargetAt(release.x, release.y)
    if (bar && bar.kind === 'unit') {
      if (bar.before !== tabId) useAppStore.getState().moveTab(tabId, bar.groupId, bar.before ?? undefined)
      return
    }
    const dz = resolveDropZoneAt(release.x, release.y)
    if (!dz) return
    const st = useAppStore.getState()
    if (dz.scope === 'root') {
      const [dir, pos] = zoneToSplit(dz.zone)
      st.moveTabToRootSplit(tabId, dir, pos)
    } else if (dz.zone === 'center') {
      st.moveTab(tabId, dz.groupId!)
    } else {
      const [dir, pos] = zoneToSplit(dz.zone)
      st.moveTabToSplit(tabId, dz.groupId!, dir, pos)
    }
    return
  }
  if (target.target === 'rejected') {
    showDropFeedback("Can't move here — that window is a different workspace")
    return
  }
  if (isUnityPlayerTab(tabId)) {
    showDropFeedback("The Unity panel can't be moved to another window")
    return
  }
  if (target.target === 'new') {
    await moveTabToWindow(tabId, 'new')
    return
  }
  const ok = await moveTabToWindow(tabId, target.target, target.point)
  if (ok) window.api.window.focus(target.target)
}

export function beginTabPointerDrag(
  e: {
    button: number
    clientX: number
    clientY: number
    pointerId: number
    currentTarget: HTMLElement
  },
  tabId: string,
  label: string
): void {
  if (e.button !== 0) return
  teardown()
  pending = { tabId, label, startX: e.clientX, startY: e.clientY, mode: dragMode(tabId) }
  active = false
  captureEl = e.currentTarget
  capturePointerId = e.pointerId
  try {
    captureEl.setPointerCapture(e.pointerId)
  } catch {
    captureEl = null
    capturePointerId = null
  }
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', onPointerUp, true)
  window.addEventListener('pointercancel', onPointerUp, true)
  window.addEventListener('lostpointercapture', onLostCapture, true)
  window.addEventListener('keydown', onKeyDown, true)
}
