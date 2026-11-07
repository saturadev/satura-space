import { Suspense, lazy, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { findScmRoot } from '../../lib/git/scm-root'
import { openFileInWorkbench } from '../../lib/editor/open-file'
import { slottedTabIds } from '../../lib/tab-tree'
import { getViewHost, releaseViewHost } from '../../lib/view-host-registry'
import { BoundedMap } from '@shared/bounded-map'
import { censusTrack } from '@shared/census'
import { PaneErrorBoundary } from './PaneErrorBoundary'

type SessionKey = [
  ptyId: string,
  workspaceId: string,
  groupId: string,
  projectPath: string,
  slotted: boolean,
  visible: boolean
]

const GitScmView = lazy(() => import('../git/GitScmView').then((m) => ({ default: m.GitScmView })))

const rootByProject = new BoundedMap<string, string>(32)
censusTrack('GitScmSessionLayer.rootByProject', rootByProject)

const exists = (path: string): Promise<boolean> =>
  window.api.fs.statPath(path).then(
    (info) => info.exists,
    () => false
  )

export function GitScmSessionLayer({
  workspaceIds,
  activeWorkspaceId
}: {
  workspaceIds: string[]
  activeWorkspaceId: string | null
}) {
  const keys = useAppStore(
    useShallow((s) => {
      const out: string[] = []
      for (const wsId of workspaceIds) {
        const tabs = s.tabsByWorkspace[wsId] ?? []
        if (!tabs.some((t) => t.contentType === 'git-scm')) continue
        const slotted = slottedTabIds(
          s.layoutByWorkspace[wsId],
          s.groupsByWorkspace[wsId] ?? [],
          tabs,
          s.fullscreenGroupIdByWorkspace[wsId] ?? null
        )
        const worktrees = s.worktreesByWorkspace[wsId] ?? []
        for (const tab of tabs) {
          if (tab.contentType !== 'git-scm') continue
          const inSlot = slotted.has(tab.id)
          const projectPath = worktrees.find((w) => w.id === tab.worktreeId)?.path ?? ''
          const key: SessionKey = [
            tab.ptyId,
            wsId,
            tab.groupId,
            projectPath,
            inSlot,
            inSlot && wsId === activeWorkspaceId
          ]
          out.push(JSON.stringify(key))
        }
      }
      return out
    })
  )

  return (
    <>
      {keys.map((k) => {
        const [ptyId, workspaceId, groupId, projectPath, slotted, visible] = JSON.parse(k) as SessionKey
        return (
          <GitScmSession
            key={ptyId}
            ptyId={ptyId}
            workspaceId={workspaceId}
            groupId={groupId}
            projectPath={projectPath}
            slotted={slotted}
            visible={visible}
          />
        )
      })}
    </>
  )
}

function GitScmSession({
  ptyId,
  workspaceId,
  groupId,
  projectPath,
  slotted,
  visible
}: {
  ptyId: string
  workspaceId: string
  groupId: string
  projectPath: string
  slotted: boolean
  visible: boolean
}) {
  const [live, setLive] = useState(slotted)
  if (slotted && !live) setLive(true)

  useEffect(() => () => releaseViewHost(ptyId), [ptyId])

  if (!live) return null
  const activateGroup = (): void => {
    const s = useAppStore.getState()
    if (s.activeGroupIdByWorkspace[workspaceId] !== groupId) s.setActiveGroup(workspaceId, groupId)
  }
  return createPortal(
    <GitScmPane viewId={ptyId} projectPath={projectPath} visible={visible} onMouseDown={activateGroup} />,
    getViewHost(ptyId)
  )
}

function GitScmPane({
  viewId,
  projectPath,
  visible,
  onMouseDown
}: {
  viewId: string
  projectPath: string
  visible: boolean
  onMouseDown: () => void
}) {
  const [root, setRoot] = useState<string | null>(() => rootByProject.get(projectPath) ?? null)

  useEffect(() => {
    const known = rootByProject.get(projectPath)
    if (known) {
      setRoot(known)
      return
    }
    setRoot(null)
    if (!projectPath) return
    let alive = true
    void findScmRoot(projectPath, exists).then((found) => {
      if (found) rootByProject.set(projectPath, found)
      if (alive) setRoot(found ?? projectPath)
    })
    return () => {
      alive = false
    }
  }, [projectPath])

  return (
    <div className="absolute inset-0 overflow-hidden" data-scm-root={root ?? undefined} onMouseDown={onMouseDown}>
      {root !== null && (
        <PaneErrorBoundary label="Git">
          <Suspense fallback={null}>
            <GitScmView
              rootPath={root}
              projectPath={projectPath}
              visible={visible}
              viewId={viewId}
              actionScope={viewId}
              onOpenFile={(file) => void openFileInWorkbench({ file, projectPath })}
            />
          </Suspense>
        </PaneErrorBoundary>
      )}
    </div>
  )
}
