import type { ResourceSession, ResourceWindowInfo, ResourceWorkspaceInfo } from '@shared/api'

export interface WorkspaceGroup {
  info: ResourceWorkspaceInfo | null
  rows: ResourceSession[]
  memory: number
}

export interface WindowGroup {
  info: ResourceWindowInfo | null
  workspaces: WorkspaceGroup[]
  memory: number
}

export type LocalAttribution = (session: ResourceSession) => string | null

const sumMemory = (rows: ResourceSession[]): number =>
  rows.reduce((n, r) => n + (r.memory ?? 0), 0)

const byMemoryDesc = (a: ResourceSession, b: ResourceSession): number =>
  (b.memory ?? 0) - (a.memory ?? 0)

export function mergeWindowInfos(
  snapshotWindows: ResourceWindowInfo[],
  currentWindowId: string | null,
  localWorkspaces: ResourceWorkspaceInfo[],
  fallbackLabel: string
): ResourceWindowInfo[] {
  const merged = snapshotWindows.map((w) => {
    if (w.id === currentWindowId) return { ...w, focused: true, workspaces: localWorkspaces }
    return currentWindowId ? { ...w, focused: false } : w
  })
  if (
    currentWindowId &&
    localWorkspaces.length > 0 &&
    !merged.some((w) => w.id === currentWindowId)
  ) {
    merged.unshift({
      id: currentWindowId,
      label: fallbackLabel,
      focused: true,
      workspaces: localWorkspaces
    })
  }
  return merged
}

const localAttributionIsAuthoritative = (session: ResourceSession): boolean =>
  session.kind === 'terminal'

export function groupRunningSessions(
  running: ResourceSession[],
  windowInfos: ResourceWindowInfo[],
  currentWindowId: string | null,
  localWorkspaceOf: LocalAttribution
): WindowGroup[] {
  const workspaceIdsByWindow = new Map(
    windowInfos.map((w) => [w.id, new Set(w.workspaces.map((ws) => ws.id))])
  )
  const currentWorkspaceIds = currentWindowId
    ? workspaceIdsByWindow.get(currentWindowId)
    : undefined

  const localAttribution = (session: ResourceSession): string | null => {
    if (!currentWorkspaceIds) return null
    const local = localWorkspaceOf(session)
    return local && currentWorkspaceIds.has(local) ? local : null
  }

  const grouped = new Map<string | null, Map<string | null, ResourceSession[]>>()
  for (const session of running) {
    const mainWindowId =
      session.windowId && workspaceIdsByWindow.has(session.windowId) ? session.windowId : null
    const mainWorkspaces = mainWindowId ? workspaceIdsByWindow.get(mainWindowId) : undefined

    let windowId: string | null = mainWindowId
    let workspaceId: string | null =
      mainWorkspaces && session.workspaceId && mainWorkspaces.has(session.workspaceId)
        ? session.workspaceId
        : null

    const localWins =
      !mainWindowId ||
      mainWindowId === currentWindowId ||
      localAttributionIsAuthoritative(session)
    const local = localWins ? localAttribution(session) : null
    if (local && currentWindowId) {
      windowId = currentWindowId
      workspaceId = local
    }

    let inner = grouped.get(windowId)
    if (!inner) {
      inner = new Map()
      grouped.set(windowId, inner)
    }
    const rows = inner.get(workspaceId)
    if (rows) rows.push(session)
    else inner.set(workspaceId, [session])
  }

  const groups: WindowGroup[] = []
  const ordered = windowInfos
    .filter((w) => grouped.has(w.id))
    .sort((a, b) => Number(b.focused) - Number(a.focused))

  for (const w of ordered) {
    const inner = grouped.get(w.id)
    if (!inner) continue
    const workspaces: WorkspaceGroup[] = []
    for (const ws of w.workspaces) {
      const rows = inner.get(ws.id)
      if (rows) workspaces.push({ info: ws, rows: rows.sort(byMemoryDesc), memory: sumMemory(rows) })
    }
    const orphans = inner.get(null)
    if (orphans) {
      workspaces.push({ info: null, rows: orphans.sort(byMemoryDesc), memory: sumMemory(orphans) })
    }
    groups.push({
      info: w,
      workspaces,
      memory: workspaces.reduce((n, g) => n + g.memory, 0)
    })
  }

  const leftover = grouped.get(null)
  if (leftover) {
    const rows = [...leftover.values()].flat().sort(byMemoryDesc)
    groups.push({
      info: null,
      workspaces: [{ info: null, rows, memory: sumMemory(rows) }],
      memory: sumMemory(rows)
    })
  }

  return groups
}
