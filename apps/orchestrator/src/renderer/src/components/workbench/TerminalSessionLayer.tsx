import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { TerminalSession } from './TerminalSession'
import { PaneErrorBoundary } from './PaneErrorBoundary'

const SEP = ''

export function TerminalSessionLayer({
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
        const groups = s.groupsByWorkspace[wsId] ?? []
        const worktrees = s.worktreesByWorkspace[wsId] ?? []
        const activeGroupId = s.activeGroupIdByWorkspace[wsId]
        for (const tab of tabs) {
          if (tab.contentType !== 'terminal') continue
          const group = groups.find((g) => g.id === tab.groupId)
          const foreground = wsId === activeWorkspaceId && group?.activeTabId === tab.id && !group.hidden
          const focused = foreground && tab.groupId === activeGroupId
          const cwd = worktrees.find((w) => w.id === tab.worktreeId)?.path ?? ''
          out.push(`${tab.ptyId}${SEP}${cwd}${SEP}${foreground ? '1' : '0'}${SEP}${focused ? '1' : '0'}`)
        }
      }
      return out
    })
  )

  return (
    <>
      {keys.map((k) => {
        const [ptyId, cwd, fg, focus] = k.split(SEP)
        return (
          <PaneErrorBoundary key={ptyId}>
            <TerminalSession
              ptyId={ptyId}
              cwd={cwd || undefined}
              active={fg === '1'}
              focused={focus === '1'}
            />
          </PaneErrorBoundary>
        )
      })}
    </>
  )
}
