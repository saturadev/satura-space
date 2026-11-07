import { useEffect, useRef, useState } from 'react'
import { History } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { getAgentEntry } from '@shared/agent-catalog'
import { useAppStore } from '../../store'
import { IS_PRIMARY_WINDOW } from '../../lib/window-role'
import { AgentIcon } from '../../lib/agent-icon'
import { AgentModelEffort } from '../AgentModelEffort'
import { MoreAgentsSubmenu } from './MoreAgentsSubmenu'
import { AnchoredLayer } from '../ui/AnchoredLayer'
import { AgentLaunchRow } from './AgentLaunchRow'
import { newSessionModel } from '../../lib/actions/new-session-actions'
import { menuItemClass } from '../ui/FloatingMenu'
import { PANEL_KIND, PanelGlyph } from './PanelIcon'

function Separator() {
  return <div className="mx-1 my-1 h-px bg-white/[0.06]" />
}

export function NewSessionMenu({
  workspaceId,
  groupId,
  defaultWorktreeId,
  onClose
}: {
  workspaceId: string
  groupId: string
  defaultWorktreeId: string
  onClose: () => void
}) {
  useAppStore(useShallow((s) => s.worktreesByWorkspace[workspaceId] ?? []))
  useAppStore(useShallow((s) => s.tabsByWorkspace[workspaceId] ?? []))
  useAppStore((s) => s.settings)
  useAppStore((s) => s.detectedAgents)
  const ref = useRef<HTMLDivElement>(null)
  const [isUnityProject, setIsUnityProject] = useState<boolean | null>(null)
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Element | null
      if (t?.closest?.('[data-menu-layer]')) return
      if (ref.current && !ref.current.contains(t)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const m = newSessionModel(useAppStore.getState(), { workspaceId, groupId, defaultWorktreeId, isUnityProject, isGitRepo, onClose })
  const { targetPath, existingUnityTab, existingConsoleTab, existingScmTab, existingScratchpadTab, existingDashboardTab, canOpenUnity, canOpenConsole, canOpenScm, favs, more, optionAgents, canResumeClaude } = m
  const { openAgent, openClaudeResume, openTerminal, openUnity, openConsole, openScm, openReports, openDashboardPanel, openScratchpads, openTuner } = m

  useEffect(() => {
    if (!targetPath) {
      setIsUnityProject(false)
      return
    }
    let alive = true
    setIsUnityProject(null)
    void window.api.unity.isProject(targetPath).then((ok) => {
      if (alive) setIsUnityProject(ok)
    })
    return () => {
      alive = false
    }
  }, [targetPath])

  useEffect(() => {
    if (!targetPath) {
      setIsGitRepo(false)
      return
    }
    let alive = true
    setIsGitRepo(null)
    void window.api.git.isRepo(targetPath).then(
      (ok) => {
        if (alive) setIsGitRepo(ok)
      },
      () => {
        if (alive) setIsGitRepo(false)
      }
    )
    return () => {
      alive = false
    }
  }, [targetPath])

  const otherRow =
    'flex w-full items-center gap-2 whitespace-nowrap rounded px-2 py-1.5 text-left text-[13px] text-ink hover:bg-accent/[0.14] hover:text-ink disabled:cursor-not-allowed disabled:text-zinc-500 disabled:hover:bg-transparent disabled:hover:text-zinc-500'

  return (
    <AnchoredLayer
      ref={ref}
      side="bottom"
      align="end"
      className="animate-menu-pop-in surface-overlay w-80 origin-top-right rounded-lg p-1"
    >
      {}
      {favs.length === 0 && more.length === 0 ? (
        <button
          disabled
          title="No installed agents detected — set them up in Settings"
          className="flex w-full items-center gap-2 whitespace-nowrap px-2 py-1.5 text-left text-[13px] text-ink-3"
        >
          No agents detected — open Settings
        </button>
      ) : (
        <>
          {favs.map((id) => (
            <AgentLaunchRow key={id} id={id} onPick={openAgent} />
          ))}
          {more.length > 0 && <MoreAgentsSubmenu agents={more} onPick={openAgent} />}
          {canResumeClaude && (
            <button
              onClick={openClaudeResume}
              title="Open an earlier Claude Code conversation from this folder"
              className={menuItemClass}
            >
              <History className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
              Resume Claude session…
            </button>
          )}
        </>
      )}

      {optionAgents.length > 0 && (
        <>
          <Separator />
          {optionAgents.map((id) => (
            <div key={id} className="px-2 py-1.5">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-3">
                <AgentIcon id={id} className="h-3 w-3" />
                {getAgentEntry(id)?.label ?? id} options
              </div>
              <AgentModelEffort id={id} />
            </div>
          ))}
        </>
      )}

      {IS_PRIMARY_WINDOW && (
        <>
      <Separator />
      <button
        onClick={openUnity}
        disabled={!canOpenUnity}
        title={
          existingUnityTab
            ? 'Show the existing Unity player for this folder'
            : isUnityProject === false
              ? 'This folder is not a Unity project'
              : 'Open a live Unity player for this folder'
        }
        className={otherRow}
      >
        <PanelGlyph kind={PANEL_KIND.unity} />
        {existingUnityTab ? 'Show Unity Player' : 'Open Unity Player'}
        {existingUnityTab ? (
          <span className="ml-auto text-[10px] text-zinc-500">already open</span>
        ) : (
          isUnityProject === false && (
            <span className="ml-auto text-[10px] text-zinc-600">not a Unity project</span>
          )
        )}
      </button>

      {

}
      <button
        onClick={openConsole}
        disabled={!canOpenConsole}
        title={
          existingConsoleTab
            ? 'Show the existing Unity console for this folder'
            : isUnityProject === false
              ? 'This folder is not a Unity project'
              : 'Open a Unity console (Debug.Log / warnings / errors) for this folder'
        }
        className={otherRow}
      >
        <PanelGlyph kind={PANEL_KIND.console} />
        {existingConsoleTab ? 'Show Unity Console' : 'Open Unity Console'}
        {existingConsoleTab ? (
          <span className="ml-auto text-[10px] text-zinc-500">already open</span>
        ) : (
          isUnityProject === false && (
            <span className="ml-auto text-[10px] text-zinc-600">not a Unity project</span>
          )
        )}
      </button>
      <button
        onClick={openTuner}
        disabled={isUnityProject !== true}
        title={
          isUnityProject === false
            ? 'This folder is not a Unity project'
            : 'Move, rotate and tweak scene objects an agent picked, live in Play Mode'
        }
        className={otherRow}
      >
        <PanelGlyph kind={PANEL_KIND.tuner} />
        Open Tuner
        {isUnityProject === false && (
          <span className="ml-auto text-[10px] text-zinc-600">not a Unity project</span>
        )}
      </button>
      <button
        onClick={openScratchpads}
        disabled={!existingScratchpadTab && isUnityProject !== true}
        title={
          existingScratchpadTab
            ? 'Show the existing scratchpads panel for this folder'
            : isUnityProject === false
              ? 'This folder is not a Unity project'
              : "Empty Unity projects with this project's settings, for trying things out on the side"
        }
        className={otherRow}
      >
        <PanelGlyph kind={PANEL_KIND.scratchpad} />
        {existingScratchpadTab ? 'Show Scratchpads' : 'Open Scratchpads'}
        {existingScratchpadTab ? (
          <span className="ml-auto text-[10px] text-zinc-500">already open</span>
        ) : (
          isUnityProject === false && (
            <span className="ml-auto text-[10px] text-zinc-600">not a Unity project</span>
          )
        )}
      </button>
        </>
      )}

      <Separator />
      <button
        onClick={openReports}
        disabled={!targetPath}
        title="This folder's agent reports, newest first, linked reports nested"
        className={otherRow}
      >
        <PanelGlyph kind={PANEL_KIND.report} />
        Reports…
      </button>
      <button
        onClick={openDashboardPanel}
        disabled={!targetPath}
        title={existingDashboardTab ? "Show this folder's dashboard" : 'Live widgets for this project: server numbers, Unity handles, git, logs and alerts'}
        className={otherRow}
      >
        <PanelGlyph kind={PANEL_KIND.dashboard} />
        {existingDashboardTab ? 'Show Dashboard' : 'Dashboard'}
        {existingDashboardTab && <span className="ml-auto text-[10px] text-zinc-500">already open</span>}
      </button>
      <button
        onClick={openScm}
        disabled={!canOpenScm}
        title={
          existingScmTab
            ? 'Show the existing Git panel for this folder'
            : isGitRepo === false
              ? 'This folder is not in a Git repository'
              : "See this folder's Git changes and commit history"
        }
        className={otherRow}
      >
        <PanelGlyph kind={PANEL_KIND.git} />
        {existingScmTab ? 'Show Git' : 'Open Git'}
        {existingScmTab ? (
          <span className="ml-auto text-[10px] text-zinc-500">already open</span>
        ) : (
          isGitRepo === false && (
            <span className="ml-auto text-[10px] text-zinc-600">not a Git repository</span>
          )
        )}
      </button>

      <Separator />
      <button
        onClick={openTerminal}
        className="flex w-full items-center gap-2 whitespace-nowrap rounded px-2 py-1.5 text-left text-[13px] text-ink-2 hover:bg-accent/[0.14] hover:text-ink"
      >
        <PanelGlyph kind={PANEL_KIND.terminal} />
        Open terminal
      </button>
    </AnchoredLayer>
  )
}
