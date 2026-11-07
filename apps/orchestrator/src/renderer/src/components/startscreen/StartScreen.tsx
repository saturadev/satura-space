import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentId } from '@shared/types'
import type {
  CreateWorktreeResult,
  NewProjectProgress,
  ProjectWorktree,
  UnityEditorForCreate,
  RemoveWorktreeResult,
  WorktreeCopyProgress,
  WorktreeRemoveProgress
} from '@shared/api'
import type { UnityMode } from '@shared/unity/world'
import { useUnityLifecycle } from '../../lib/unity/lifecycle-store'
import { buildAgentLaunchCommand, getAgentEntry, getAgentLabel } from '@shared/agent-catalog'
import { useAppStore } from '../../store'
import { pathBasename } from '../../lib/path'
import { IS_PRIMARY_WINDOW } from '../../lib/window-role'
import { showDropFeedback } from '../../lib/drop-feedback'
import { AgentIcon } from '../../lib/agent-icon'
import { AgentModelEffort, agentHasModelEffort } from '../AgentModelEffort'
import type { TerminalAgentLaunch } from '../../store/slices/workspaces'
import { requestConfirm, anchorFromElement } from '../../lib/confirm/confirm-store'
import { SquaresBackdrop } from './SquaresBackdrop'
import { PanelScroll } from './PanelScroll'
import { pickPath, pickerMemory } from '../../lib/file-picker/file-picker-store'
import { NewProjectSentence, type NewProjectDraft } from './NewProjectSentence'
import {
  clearProjectCreationError,
  projectCreationState,
  runProjectCreation,
  useProjectCreation
} from './project-creation'

const TERMINAL_COUNTS = [1, 2, 4, 6] as const
const UNITY_MODE_OPTIONS: { id: UnityMode; label: string; hint: string }[] = [
  {
    id: 'normal',
    label: 'Normal',
    hint: 'Windowed editor hidden off-screen, streamed live — can be revealed. Best fidelity.'
  },
  {
    id: 'headless-graphics',
    label: 'Headless Graphics',
    hint: 'Batch mode with a GPU — no editor window, live view still streams. Lighter.'
  },
  {
    id: 'headless-nographics',
    label: 'Headless NoGraphics',
    hint: 'Batch mode, no rendering or live view. Fastest — for compiling & running. No multiplayer support.'
  }
]
const COUNT_GRID: Record<number, { rows: number; cols: number }> = {
  1: { rows: 1, cols: 1 },
  2: { rows: 1, cols: 2 },
  4: { rows: 2, cols: 2 },
  6: { rows: 3, cols: 2 }
}
const UNITY_COUNT_GRID: Record<number, { rows: number; cols: number }> = {
  2: { rows: 2, cols: 1 }
}
const NEW_PROJECT_KEY = 'satura.newProject'
const DEFAULT_PROJECT_NAME = 'MyGame'

type StartMode = 'open' | 'create'

export function StartScreen() {
  const createWorkspaceWithGrid = useAppStore((s) => s.createWorkspaceWithGrid)
  const createWorkspaceWithDefaultView = useAppStore((s) => s.createWorkspaceWithDefaultView)
  const beginWorkspaceOverlay = useAppStore((s) => s.beginWorkspaceOverlay)
  const settleWorkspaceOverlay = useAppStore((s) => s.settleWorkspaceOverlay)
  const setWorktreeBusy = useAppStore((s) => s.setWorktreeBusy)
  const openWorkspaces = useAppStore((s) => s.workspaces)
  const settings = useAppStore((s) => s.settings)
  const defaultProjectsFolder = settings?.defaultProjectsFolder ?? ''
  const detectedAgents = useAppStore((s) => s.detectedAgents)
  const detectAgents = useAppStore((s) => s.detectAgents)
  const [folder, setFolder] = useState('')
  const [isUnityProject, setIsUnityProject] = useState<boolean | null>(false)
  const [terminalCount, setTerminalCount] = useState(1)
  const [layoutOpen, setLayoutOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [unityMode, setUnityMode] = useState<UnityMode>('normal')
  const [hubInstalled, setHubInstalled] = useState<boolean | null>(null)
  const [isDev, setIsDev] = useState(false)
  const [agentCounts, setAgentCounts] = useState<Record<AgentId, number>>({})
  const [customizeAgents, setCustomizeAgents] = useState(false)
  const [recents, setRecents] = useState<string[]>([])

  const [isRepo, setIsRepo] = useState(false)
  const [worktrees, setWorktrees] = useState<ProjectWorktree[]>([])
  const [worktreesOpen, setWorktreesOpen] = useState(false)
  const [createWorktreeOn, setCreateWorktreeOn] = useState(false)
  const [worktreeName, setWorktreeName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [selectedWorktreePath, setSelectedWorktreePath] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [copyProgress, setCopyProgress] = useState<WorktreeCopyProgress | null>(null)
  const [removingPath, setRemovingPath] = useState<string | null>(null)
  const [removeProgress, setRemoveProgress] = useState<WorktreeRemoveProgress | null>(null)
  const [worktreeError, setWorktreeError] = useState<string | null>(null)
  const [worktreeNotice, setWorktreeNotice] = useState<string | null>(null)

  const [mode, setMode] = useState<StartMode>(() => {
    const c = projectCreationState()
    return c.active || c.error ? 'create' : 'open'
  })
  const [editors, setEditors] = useState<UnityEditorForCreate[] | null>(null)
  const [home, setHome] = useState('')
  const [draft, setDraft] = useState<NewProjectDraft>({ kind: '3d', version: '', parent: '', name: '' })
  const [draftProblem, setDraftProblem] = useState<string | null>(null)
  const creation = useProjectCreation()
  const creatingProject = creation.active !== null
  const createError = creation.error

  useEffect(() => {
    window.api.recents
      .list()
      .then(setRecents)
      .catch(() => setRecents([]))
    window.api.app.isDev().then(setIsDev).catch(() => setIsDev(false))
  }, [])

  const removeRecent = (path: string): void => {
    window.api.recents.remove(path)
    setRecents((prev) => prev.filter((p) => p !== path))
  }

  const refreshHub = useCallback(() => {
    window.api.unity
      .isHubInstalled()
      .then(setHubInstalled)
      .catch(() => setHubInstalled(true))
  }, [])
  useEffect(() => {
    refreshHub()
  }, [refreshHub])

  const simulateNoHub = isDev && (settings?.devSimulateNoUnityHub ?? false)
  const hubAvailable: boolean | null = simulateNoHub ? false : hubInstalled

  const seededFolder = useRef(false)
  useEffect(() => {
    if (seededFolder.current) return
    if (defaultProjectsFolder) {
      setFolder(defaultProjectsFolder)
      seededFolder.current = true
    }
  }, [defaultProjectsFolder])

  useEffect(() => {
    const path = folder.trim()
    if (!path) {
      setIsUnityProject(false)
      return
    }
    let alive = true
    const slow = setTimeout(() => {
      if (alive) setIsUnityProject(null)
    }, 250)
    void window.api.unity.isProject(path).then((ok) => {
      if (!alive) return
      clearTimeout(slow)
      setIsUnityProject(ok)
      if (ok) void window.api.unity.getMode(path).then((m) => alive && setUnityMode(m))
    })
    return () => {
      alive = false
      clearTimeout(slow)
    }
  }, [folder])

  useEffect(() => {
    const path = folder.trim()
    setSelectedWorktreePath(null)
    setWorktreeError(null)
    setWorktreeNotice(null)
    if (!path) {
      setIsRepo(false)
      setWorktrees([])
      return
    }
    let alive = true
    void window.api.git.isRepo(path).then((ok) => {
      if (!alive) return
      setIsRepo(ok)
      if (ok) void window.api.git.listWorktrees(path).then((w) => alive && setWorktrees(w))
      else setWorktrees([])
    })
    return () => {
      alive = false
    }
  }, [folder])

  useEffect(() => {
    if (createWorktreeOn && !nameEdited) setWorktreeName(nextWorktreeName(worktrees))
  }, [createWorktreeOn, worktrees, nameEdited])

  useEffect(() => {
    if (editors !== null) return
    let alive = true
    void window.api.unity.listEditorsForCreate().then(async (r) => {
      if (!alive) return
      const saved = readNewProjectPrefs()
      const kind = saved.kind && r.editors.some((e) => e.kinds.includes(saved.kind!)) ? saved.kind : '3d'
      const version =
        r.editors.find((e) => e.version === saved.version && e.kinds.includes(kind))?.version ??
        r.editors.find((e) => e.kinds.includes(kind))?.version ??
        r.editors[0]?.version ??
        ''
      const parent =
        defaultProjectsFolder ||
        pickerMemory('new-project')?.dir ||
        (recents[0] ? parentDir(recents[0]) : '') ||
        r.home
      let name = DEFAULT_PROJECT_NAME
      for (let i = 2; i < 50; i += 1) {
        const taken = (await window.api.unity.checkNewProject(parent, name))?.includes('already exists')
        if (!taken) break
        name = `${DEFAULT_PROJECT_NAME}${i}`
      }
      if (!alive) return
      setHome(r.home)
      setDraft({ kind, version, parent, name })
      setEditors(r.editors)
    })
    return () => {
      alive = false
    }
  }, [editors, defaultProjectsFolder, recents])

  useEffect(() => {
    if (!draft.parent) return
    let alive = true
    const t = setTimeout(() => {
      void window.api.unity.checkNewProject(draft.parent, draft.name).then((p) => alive && setDraftProblem(p))
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [draft.parent, draft.name])

  const updateDraft = (patch: Partial<NewProjectDraft>): void => {
    clearProjectCreationError()
    setDraft((d) => {
      const next = { ...d, ...patch }
      writeNewProjectPrefs({ kind: next.kind, version: next.version })
      return next
    })
  }

  const browseNewProjectParent = async (): Promise<void> => {
    const path = await pickPath({
      mode: 'openFolder',
      purpose: 'new-project',
      title: 'Choose where to create the project',
      confirmLabel: 'Choose',
      defaultPath: draft.parent || undefined
    })
    if (path) updateDraft({ parent: path })
  }

  const refreshWorktrees = useCallback((): void => {
    const path = folder.trim()
    if (path) void window.api.git.listWorktrees(path).then(setWorktrees)
  }, [folder])

  const openWorktreePaths = useMemo(
    () => new Set(openWorkspaces.map((ws) => normPath(ws.worktreePath ?? ''))),
    [openWorkspaces]
  )
  const isWorktreeOpen = useCallback(
    (w: ProjectWorktree): boolean => openWorktreePaths.has(normPath(w.path)),
    [openWorktreePaths]
  )

  const existingMatch = useMemo(() => {
    const sanitized = sanitizeWorktreeName(worktreeName)
    if (!sanitized) return null
    return worktrees.find((w) => w.name === sanitized) ?? null
  }, [worktreeName, worktrees])

  const removeWorktree = async (
    w: ProjectWorktree,
    anchorEl: HTMLElement | null
  ): Promise<void> => {
    if (isWorktreeOpen(w)) {
      await requestConfirm({
        title: `“${w.name}” is open`,
        message: `Close the workspace using this worktree before removing it.`,
        confirmLabel: 'OK',
        hideCancel: true,
        danger: false,
        anchor: anchorFromElement(anchorEl)
      })
      return
    }
    const branchLine = w.branch ? `\n• delete the branch “${w.branch}” (you're asked again if it has commits not merged yet)` : ''
    const ok = await requestConfirm({
      title: `Remove worktree “${w.name}”?`,
      message: `This will:\n• remove the git worktree\n• move the folder ${w.path} to the Trash${branchLine}\n\nThe files stay in the Trash until you empty it.`,
      confirmLabel: 'Remove Worktree',
      anchor: anchorFromElement(anchorEl)
    })
    if (!ok) return
    setWorktreeError(null)
    setWorktreeNotice(null)
    setRemovingPath(w.path)
    setWorktreeBusy(true)
    setRemoveProgress(null)
    const stopProgress = window.api.git.onWorktreeRemoveProgress((p) => {
      if (normPath(p.worktreePath) === normPath(w.path)) setRemoveProgress(p)
    })
    let res: RemoveWorktreeResult
    try {
      res = await window.api.git.removeWorktree(folder.trim(), w.path)
    } finally {
      stopProgress()
      setRemovingPath(null)
      setWorktreeBusy(false)
      setRemoveProgress(null)
    }
    refreshWorktrees()
    if (!res.ok) {
      setWorktreeError(res.message ?? `Failed to remove “${w.name}”.`)
      setWorktreesOpen(true)
      return
    }
    if (selectedWorktreePath === w.path) setSelectedWorktreePath(null)
    const unmerged = res.unmergedBranch
    if (!unmerged) return
    const commits = unmerged.commits === 1 ? '1 commit' : `${unmerged.commits} commits`
    const drop = await requestConfirm({
      title: `Delete branch “${unmerged.branch}”?`,
      message: `The worktree folder is in the Trash, but the branch is still here.\n\nBranch “${unmerged.branch}” has ${commits} not merged into ${unmerged.into}; deleting it loses them.`,
      confirmLabel: 'Delete Branch',
      cancelLabel: 'Keep Branch',
      anchor: anchorFromElement(anchorEl)
    })
    if (!drop) {
      setWorktreeNotice(`Kept the branch “${unmerged.branch}”.`)
      return
    }
    const deleted = await window.api.git.forceDeleteWorktreeBranch(folder.trim(), unmerged.branch)
    refreshWorktrees()
    if (!deleted.ok) {
      setWorktreeError(deleted.message ?? `Failed to delete the branch “${unmerged.branch}”.`)
      setWorktreesOpen(true)
    }
  }

  const unityLayout = mode === 'create' ? true : isUnityProject
  const life = useUnityLifecycle(mode !== 'create' && isUnityProject ? folder.trim() : null)
  const editorGate = life && (life.phase === 'missing' || life.phase === 'installing') ? life : null
  const selectedEditor = editors?.find((e) => e.version === draft.version)
  const canCreate =
    !!selectedEditor && selectedEditor.kinds.includes(draft.kind) && !draftProblem && !creatingProject
  const grid = COUNT_GRID[terminalCount] ?? COUNT_GRID[2]
  const unityGrid = UNITY_COUNT_GRID[terminalCount] ?? grid

  useEffect(() => {
    if (detectedAgents === null) void detectAgents()
  }, [detectedAgents, detectAgents])

  const availableAgents = useMemo<AgentId[]>(() => {
    const installed = detectedAgents ?? []
    const enabled = installed.filter((id) => settings?.agents?.[id]?.enabled !== false)
    const favs = (settings?.favoriteAgents ?? []).filter((id) => enabled.includes(id))
    const rest = enabled
      .filter((id) => !favs.includes(id))
      .sort((a, b) => getAgentLabel(a).localeCompare(getAgentLabel(b)))
    return [...favs, ...rest]
  }, [detectedAgents, settings])

  const topAgent = useMemo<AgentId | null>(() => {
    const prefs = [settings?.defaultAgent, ...(settings?.favoriteAgents ?? [])].filter(
      (x): x is AgentId => Boolean(x)
    )
    return prefs.find((id) => availableAgents.includes(id)) ?? availableAgents[0] ?? null
  }, [settings, availableAgents])

  useEffect(() => {
    setAgentCounts((prev) => {
      let budget = terminalCount
      const next: Record<AgentId, number> = {}
      for (const id of availableAgents) {
        const capped = Math.min(prev[id] ?? 0, Math.max(0, budget))
        if (capped > 0) next[id] = capped
        budget -= capped
      }
      const sameKeys = Object.keys(next).length === Object.keys(prev).length
      const unchanged = sameKeys && Object.keys(next).every((k) => next[k] === prev[k])
      return unchanged ? prev : next
    })
  }, [terminalCount, availableAgents])

  const assigned = availableAgents.reduce((sum, id) => sum + (agentCounts[id] ?? 0), 0)
  const remaining = Math.max(0, terminalCount - assigned)
  const otherAgents = availableAgents.filter((id) => id !== topAgent)

  const summaryParts: string[] = []
  for (const id of availableAgents) {
    const c = agentCounts[id] ?? 0
    if (c > 0) summaryParts.push(`${c} ${getAgentLabel(id)}`)
  }
  if (remaining > 0 && topAgent) summaryParts.push(`${remaining} ${getAgentLabel(topAgent)}`)

  const bumpAgent = (id: AgentId, delta: number): void => {
    setAgentCounts((prev) => {
      const cur = prev[id] ?? 0
      const otherAssigned = assigned - cur
      const max = Math.max(0, terminalCount - otherAssigned)
      const nextVal = Math.min(max, Math.max(0, cur + delta))
      const next = { ...prev }
      if (nextVal > 0) next[id] = nextVal
      else delete next[id]
      return next
    })
  }

  const terminalsLabel = `${terminalCount} ${terminalCount === 1 ? 'terminal' : 'terminals'}`
  const layoutSummary =
    unityLayout === null
      ? 'Detecting…'
      : unityLayout
        ? `Unity Layout · ${terminalsLabel} · ${UNITY_MODE_OPTIONS.find((o) => o.id === unityMode)?.label ?? 'Normal'}`
        : `Explorer · ${terminalsLabel}`
  const agentsSummary = topAgent
    ? summaryParts.join(' · ')
    : detectedAgents === null
      ? 'Detecting…'
      : 'No agents detected'

  const fillAllTop = (): void => setAgentCounts({})
  const oneOfEach = (): void => {
    const next: Record<AgentId, number> = {}
    let budget = terminalCount
    for (const id of otherAgents) {
      if (budget <= 0) break
      next[id] = 1
      budget -= 1
    }
    setAgentCounts(next)
  }
  const splitEvenly = (): void => {
    const n = availableAgents.length
    if (n === 0) return
    const next: Record<AgentId, number> = {}
    availableAgents.forEach((id, i) => {
      if (id === topAgent) return
      const share = Math.floor(terminalCount / n) + (i < terminalCount % n ? 1 : 0)
      if (share > 0) next[id] = share
    })
    setAgentCounts(next)
  }

  const buildTerminalAgents = (): (TerminalAgentLaunch | null)[] | undefined => {
    if (!topAgent) return undefined
    const ids: AgentId[] = []
    for (const id of availableAgents) {
      const c = agentCounts[id] ?? 0
      for (let i = 0; i < c && ids.length < terminalCount; i += 1) ids.push(id)
    }
    while (ids.length < terminalCount) ids.push(topAgent)
    return ids.slice(0, terminalCount).map((id) => {
      const entry = getAgentEntry(id)
      if (!entry) return null
      return {
        command: buildAgentLaunchCommand(entry, settings?.agents?.[id]),
        label: entry.label,
        agentId: id
      }
    })
  }

  const browse = async (): Promise<void> => {
    const path = await pickPath({
      mode: 'openFolder',
      purpose: 'project',
      title: 'Open a project folder',
      confirmLabel: 'Choose',
      defaultPath: defaultProjectsFolder || undefined,
      unity: true
    })
    if (path) setFolder(path)
  }

  const prepareOpen = async (
    folderPath: string | undefined,
    worktreePath: string | undefined
  ): Promise<(() => void) | null> => {
    const cwd = worktreePath ?? folderPath
    if (cwd) {
      const claim = await window.api.window.claimWorkspace({
        folderPath: folderPath ?? '',
        worktreePath: cwd
      })
      if (!claim.ok) {
        showDropFeedback('This project is already open in another window')
        return null
      }
    }
    const unity = cwd ? await window.api.unity.isProject(cwd) : false
    if (unity && cwd) await window.api.unity.setMode(cwd, unityMode)
    const terminalAgents = buildTerminalAgents()
    return unity
      ? () =>
          createWorkspaceWithDefaultView(
            folderPath,
            worktreePath,
            unityGrid.rows,
            unityGrid.cols,
            terminalAgents
          )
      : () => createWorkspaceWithGrid(folderPath, worktreePath, grid.rows, grid.cols, terminalAgents)
  }

  const createAndLaunch = async (): Promise<void> => {
    const res = await runProjectCreation({ ...draft, name: draft.name.trim() })
    if (!res.ok) return
    setFolder(res.path)
    setMode('open')
    setEditors(null)
    beginWorkspaceOverlay()
    try {
      settleWorkspaceOverlay((await prepareOpen(res.path, undefined)) ?? undefined)
    } catch (e) {
      settleWorkspaceOverlay()
      throw e
    }
  }

  const launch = async (): Promise<void> => {
    if (mode === 'create') {
      await createAndLaunch()
      return
    }
    const folderPath = folder.trim()

    if (folderPath && createWorktreeOn && isRepo) {
      setWorktreeError(null)
      setWorktreeNotice(null)
      setCreating(true)
      setWorktreeBusy(true)
      setCopyProgress(null)
      const stopProgress = window.api.git.onWorktreeProgress((p) => {
        if (p.rootPath === folderPath && p.name === worktreeName) setCopyProgress(p)
      })
      let res: CreateWorktreeResult
      try {
        res = await window.api.git.createWorktree(folderPath, worktreeName)
      } finally {
        stopProgress()
        setCreating(false)
        setWorktreeBusy(false)
        setCopyProgress(null)
      }
      if (!res.ok) {
        setWorktreeError(worktreeErrorMessage(res, worktreeName))
        setWorktreesOpen(true)
        return
      }
      if (openWorktreePaths.has(normPath(res.path))) {
        setWorktreeError(`“${worktreeName}” is already open in another workspace.`)
        setWorktreesOpen(true)
        return
      }
      if (res.behindHead) {
        refreshWorktrees()
        setSelectedWorktreePath(res.path)
        setWorktreeNotice(
          `Reused a leftover branch named “${worktreeName}” from an earlier worktree — it points at a different commit than your current checkout. It's ready below; open it if that's what you want.`
        )
        setWorktreesOpen(true)
        return
      }
      beginWorkspaceOverlay()
      try {
        settleWorkspaceOverlay((await prepareOpen(folderPath, res.path)) ?? undefined)
      } catch (e) {
        settleWorkspaceOverlay()
        throw e
      }
      return
    }

    beginWorkspaceOverlay()
    try {
      if (!folderPath) {
        settleWorkspaceOverlay((await prepareOpen(undefined, undefined)) ?? undefined)
        return
      }
      settleWorkspaceOverlay(
        (await prepareOpen(folderPath, selectedWorktreePath ?? undefined)) ?? undefined
      )
    } catch (e) {
      settleWorkspaceOverlay()
      throw e
    }
  }

  return (
    <div className="animate-bfade-in relative flex h-full w-full flex-col overflow-hidden bg-canvas">
      {(settings?.startScreenEffect ?? true) && <SquaresBackdrop />}

      <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-panel p-[3px]">
          {IS_PRIMARY_WINDOW && (
            <>
              <button
                onClick={() => void window.api.window.create()}
                title="Open another window"
                className="flex h-[26px] items-center gap-2 whitespace-nowrap rounded-full px-3 text-xs font-semibold text-ink-2 transition-colors hover:bg-elevated hover:text-ink"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M12 8v8M8 12h8" />
                </svg>
                New window
              </button>
              <span className="mx-1 h-4 w-px bg-white/[0.06]" />
            </>
          )}
          {hubAvailable === false ? (
            <button
              onClick={() => void window.api.shell.openExternal('https://unity.com/download')}
              title="Unity Hub is required to launch Unity projects. Click to download it."
              className="flex h-[26px] items-center gap-2 whitespace-nowrap rounded-full bg-amber-500/10 px-3 text-xs font-semibold text-amber-200 transition-colors hover:bg-amber-500/20"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <path d="M12 9v4M12 17h.01" />
              </svg>
              Get Unity Hub
            </button>
          ) : (
            <button
              onClick={() => void window.api.unity.openHub()}
              disabled={hubAvailable === null}
              title="Open Unity Hub to manage editor versions and licenses"
              className="flex h-[26px] items-center gap-2 whitespace-nowrap rounded-full px-3 text-xs font-semibold text-ink-2 transition-colors hover:bg-elevated hover:text-ink disabled:opacity-60"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${hubAvailable === null ? 'bg-elevated' : 'bg-emerald-400'}`} />
              {hubAvailable === null ? 'Checking Unity Hub…' : 'Unity Hub'}
            </button>
          )}
        </div>
      </div>

      <div className="relative z-10 mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col px-6 pb-16 pt-6">
        <div className="max-h-[12vh] min-h-0 flex-1" />
        <div className="mx-auto mb-6 w-full max-w-xl shrink-0 text-center">
          <div className="mb-4 flex justify-center">
            <StartModeTabs mode={mode} onChange={setMode} disabled={creatingProject} />
          </div>
          <h1 className="mb-2 text-3xl font-bold tracking-tight text-ink">
            {mode === 'create' ? 'New project' : 'Your workspace'}
          </h1>
          <p className="text-[15px] text-ink-2">
            {mode === 'create'
              ? 'Unity sets it up first, then it opens here.'
              : 'Pick a folder to work in and choose how it should open.'}
          </p>
        </div>

        <div className="relative flex min-h-0 max-h-full flex-col overflow-hidden rounded-xl bg-panel">
        <PanelScroll
          wrapperClassName="relative min-h-0 flex-1"
          className="h-full overflow-y-auto overflow-x-hidden px-4 py-5"
        >
        <div className="w-full space-y-6">
          {mode === 'create' && (
            <div className="rounded-lg bg-sunken p-4">
              <NewProjectSentence
                draft={draft}
                onChange={updateDraft}
                editors={editors}
                home={home}
                problem={draftProblem}
                error={createError}
                onBrowse={() => void browseNewProjectParent()}
              />
            </div>
          )}

          {mode === 'open' && (
          <div className="space-y-3 rounded-lg bg-sunken p-4">
            <div className="flex items-center gap-3">
              <CardIcon>
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </CardIcon>
              <label className="shrink-0 text-[15px] font-semibold text-ink">Working folder</label>
              <span className="min-w-0 truncate text-xs text-ink-3">Where your panes will start</span>
            </div>
            <div className="flex items-center gap-2 rounded-md border border-transparent bg-canvas p-2.5 transition-colors focus-within:border-accent/50">
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-ink-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              <input
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                spellCheck={false}
                placeholder="~  (defaults to your home folder)"
                className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink placeholder:text-ink-4/50 focus:outline-none"
              />
              <button
                onClick={() => void browse()}
                className="rounded-md border border-transparent bg-panel px-2.5 py-1 text-xs font-medium text-ink-3 transition-all hover:bg-elevated hover:text-ink"
              >
                Browse
              </button>
            </div>

            {recents.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <span className="text-xs text-ink-3">Recent</span>
                {recents.map((path) => {
                  const selected = folder === path
                  return (
                    <span
                      key={path}
                      title={path}
                      className={`group flex items-center rounded-md border text-[11px] transition-colors ${
                        selected
                          ? 'border-accent/60 bg-accent/10 text-accent'
                          : 'border-transparent bg-panel text-ink-3 hover:bg-elevated hover:text-ink'
                      }`}
                    >
                      <button
                        onClick={() => setFolder(path)}
                        className="max-w-[11rem] truncate py-0.5 pl-2 pr-1"
                      >
                        {pathBasename(path)}
                      </button>
                      <button
                        onClick={() => removeRecent(path)}
                        title="Remove from recent"
                        aria-label={`Remove ${pathBasename(path)} from recent`}
                        className="flex h-full items-center rounded-r-md py-0.5 pl-0.5 pr-1.5 text-ink-4 opacity-70 transition-colors hover:text-rose-300 hover:opacity-100"
                      >
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </span>
                  )
                })}
              </div>
            )}

            {isRepo && (
              <div className="rounded-md border border-transparent bg-canvas">
                <button
                  onClick={() => setWorktreesOpen((v) => !v)}
                  className="flex w-full items-center gap-2.5 p-2.5 text-left"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-ink-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="6" r="2.5" />
                    <circle cx="6" cy="18" r="2.5" />
                    <circle cx="18" cy="8" r="2.5" />
                    <path d="M6 8.5v7M18 10.5c0 3-2.5 4-6 4.5" />
                  </svg>
                  <span className="min-w-0 flex-1 text-xs font-medium text-ink">
                    Worktrees
                    {worktrees.length > 0 && (
                      <span className="ml-1.5 rounded bg-white/5 px-1 py-px text-[10px] tabular-nums text-ink-3">
                        {worktrees.length}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-ink-3">
                    {createWorktreeOn ? 'New' : selectedWorktreePath ? 'Existing' : 'Off'}
                    <svg
                      viewBox="0 0 24 24"
                      className={`h-3.5 w-3.5 transition-transform ${worktreesOpen ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </span>
                </button>

                <div
                  className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                    worktreesOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                  }`}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="border-t border-white/[0.04] p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-ink">Create a new worktree</span>
                      <button
                        role="switch"
                        aria-checked={createWorktreeOn}
                        onClick={() => {
                          setCreateWorktreeOn((v) => {
                            const next = !v
                            if (next) setSelectedWorktreePath(null)
                            return next
                          })
                          setWorktreeError(null)
                          setWorktreeNotice(null)
                        }}
                        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                          createWorktreeOn ? 'bg-accent' : 'bg-white/10'
                        }`}
                      >
                        <span
                          className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform duration-200 ${
                            createWorktreeOn ? 'translate-x-4' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>

                    <div
                      className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                        createWorktreeOn ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                      }`}
                    >
                      <div className="min-h-0 overflow-hidden">
                        <div className="space-y-1.5 pt-3">
                        <div className="flex items-center gap-1 rounded border border-transparent bg-canvas px-2.5 py-1.5 transition-colors focus-within:border-accent/50">
                          <span className="shrink-0 font-mono text-[11px] text-ink-4">.sspace/worktrees/</span>
                          <input
                            value={worktreeName}
                            onChange={(e) => {
                              setWorktreeName(e.target.value)
                              setNameEdited(true)
                              setWorktreeError(null)
                              setWorktreeNotice(null)
                            }}
                            spellCheck={false}
                            placeholder="worktree1"
                            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink placeholder:text-ink-4/50 focus:outline-none"
                          />
                        </div>
                        <p className="text-[11px] leading-snug text-ink-3">
                          Isolated branch off HEAD. Uncommitted changes and the Unity Library are
                          copied — instant &amp; disk-free on macOS.
                        </p>
                        {worktreeError && (
                          <p className="text-[11px] leading-snug text-rose-300">{worktreeError}</p>
                        )}
                        {worktreeNotice && (
                          <p className="text-[11px] leading-snug text-amber-300/90">{worktreeNotice}</p>
                        )}
                        </div>
                      </div>
                    </div>

                    {worktrees.length > 0 && (
                      <div className="space-y-1 pt-3">
                        <span className="px-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-4">
                          Existing
                        </span>
                        {worktrees.map((w) => {
                          const selected =
                            selectedWorktreePath === w.path ||
                            (createWorktreeOn && existingMatch?.path === w.path)
                          const open = isWorktreeOpen(w)
                          const removing = removingPath === w.path
                          return (
                            <div
                              key={w.path}
                              className={`group flex items-center gap-2 rounded-lg border px-2 py-1 transition-colors ${
                                removing ? 'opacity-60' : ''
                              } ${
                                selected
                                  ? 'border-accent/60 bg-accent/[0.08]'
                                  : 'border-transparent bg-panel hover:bg-elevated'
                              }`}
                            >
                              <button
                                onClick={() => {
                                  setSelectedWorktreePath(selected ? null : w.path)
                                  setCreateWorktreeOn(false)
                                }}
                                disabled={removing}
                                title={w.path}
                                className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
                              >
                                <span
                                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                    selected ? 'bg-accent' : 'bg-elevated'
                                  }`}
                                />
                                <span
                                  className={`truncate text-xs font-medium ${
                                    selected ? 'text-accent' : 'text-ink-2'
                                  }`}
                                >
                                  {w.name}
                                </span>
                                {w.branch && (
                                  <span className="shrink-0 truncate font-mono text-[10px] text-ink-4">
                                    {w.branch}
                                  </span>
                                )}
                              </button>
                              <button
                                onClick={(e) => void removeWorktree(w, e.currentTarget)}
                                disabled={removing}
                                title={
                                  removing
                                    ? 'Removing worktree…'
                                    : open
                                      ? 'Close the workspace using this worktree to remove it'
                                      : 'Remove worktree'
                                }
                                aria-label={`Remove worktree ${w.name}`}
                                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors ${
                                  removing
                                    ? 'text-ink-3'
                                    : open
                                      ? 'cursor-not-allowed text-ink-4/40'
                                      : 'text-ink-4 hover:text-rose-300'
                                }`}
                              >
                                {removing ? (
                                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                                  </svg>
                                ) : (
                                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
                                  </svg>
                                )}
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
          )}

          <Foldout
            title="Starting layout"
            icon={
              <>
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18M9 12h12" />
              </>
            }
            summary={layoutSummary}
            open={layoutOpen}
            onToggle={() => setLayoutOpen((v) => !v)}
          >
            <div className="flex items-center gap-3 rounded-md border border-transparent bg-canvas p-3">
              <div className="w-24 shrink-0">
                {unityLayout ? (
                  <UnityLayoutPreview rows={unityGrid.rows} cols={unityGrid.cols} />
                ) : (
                  <GridLayoutPreview rows={grid.rows} cols={grid.cols} />
                )}
              </div>
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm font-semibold text-ink">
                  {unityLayout === null
                    ? 'Detecting…'
                    : unityLayout
                      ? 'Unity Layout'
                      : `Explorer + ${terminalCount} ${terminalCount === 1 ? 'terminal' : 'terminals'}`}
                </div>
                <div className="text-xs leading-snug text-ink-2">
                  {unityLayout === null
                    ? 'Checking whether this is a Unity project'
                    : unityLayout
                      ? `Explorer · ${terminalCount} ${terminalCount === 1 ? 'terminal' : 'terminals'} · Unity Player + Console`
                      : 'Explorer alongside a grid of terminals'}
                </div>
              </div>
            </div>

            {editorGate && (
              <div
                data-unity-editor={editorGate.phase}
                className="flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-snug text-amber-200"
              >
                <span className="min-w-0 flex-1">
                  {editorGate.phase === 'installing'
                    ? `Unity Hub is installing Unity ${editorGate.version}${editorGate.install && editorGate.install.pct >= 0 ? ` (${Math.round(editorGate.install.pct)}%)` : ''}. The editor starts when it's done.`
                    : `This project needs Unity ${editorGate.version}, which isn't installed.`}
                </span>
                {editorGate.phase === 'missing' && (
                  <button
                    onClick={() => void window.api.unity.installEditor(editorGate.project)}
                    className="shrink-0 rounded-full bg-amber-500/20 px-2.5 py-1 font-semibold transition-colors hover:bg-amber-500/30"
                  >
                    Install in Unity Hub
                  </button>
                )}
              </div>
            )}

            {}
            {unityLayout !== null && (
              <div className="flex items-center gap-2 pt-0.5">
                <span className="text-xs text-ink-3">Terminals</span>
                <div className="flex gap-1.5">
                  {TERMINAL_COUNTS.map((n) => {
                    const active = n === terminalCount
                    return (
                      <button
                        key={n}
                        onClick={() => setTerminalCount(n)}
                        aria-pressed={active}
                        className={`h-7 w-9 rounded-lg border text-xs font-semibold tabular-nums transition-all ${
                          active
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-transparent bg-panel text-ink-3 hover:bg-elevated hover:text-ink'
                        }`}
                      >
                        {n}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {}
            {unityLayout === true && (
              <div className="space-y-1.5 pt-1">
                <span className="text-xs text-ink-3">Unity mode</span>
                <UnityModeToggle value={unityMode} onChange={setUnityMode} />
              </div>
            )}
          </Foldout>

          <Foldout
            title="AI agents"
            icon={
              <>
                <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
                <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
              </>
            }
            summary={agentsSummary}
            open={agentsOpen}
            onToggle={() => setAgentsOpen((v) => !v)}
          >

            {topAgent ? (
              <div className="rounded-md border border-transparent bg-canvas">
                <button
                  onClick={() => otherAgents.length > 0 && setCustomizeAgents((v) => !v)}
                  className={`flex w-full items-center gap-2.5 p-3 text-left ${otherAgents.length === 0 ? 'cursor-default' : ''}`}
                >
                  <AgentIcon id={topAgent} className="h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
                    {summaryParts.join(' · ')}
                  </span>
                  {otherAgents.length > 0 && (
                    <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-ink-3">
                      {customizeAgents ? 'Done' : 'Customize'}
                      <svg
                        viewBox="0 0 24 24"
                        className={`h-3.5 w-3.5 transition-transform ${customizeAgents ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </span>
                  )}
                </button>

                <div
                  className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                    customizeAgents && otherAgents.length > 0 ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                  }`}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="space-y-3 border-t border-white/[0.04] p-3">
                    <p className="text-xs leading-snug text-ink-2">
                      Each of your {terminalCount} {terminalCount === 1 ? 'terminal' : 'terminals'} runs
                      one agent. Slots you don&apos;t assign run {getAgentLabel(topAgent)}.
                    </p>

                    {}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="mr-1 text-xs text-ink-3">Quick fill:</span>
                      <QuickFill label={`All ${getAgentLabel(topAgent)}`} onClick={fillAllTop} />
                      <QuickFill label="One of each" onClick={oneOfEach} />
                      <QuickFill label="Split evenly" onClick={splitEvenly} />
                    </div>

                    {}
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      <div className="flex items-center justify-between gap-2 rounded border border-accent/60 bg-accent/[0.06] px-2.5 py-1.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <AgentIcon id={topAgent} className="h-4 w-4" />
                          <span className="truncate text-xs font-medium text-ink">
                            {getAgentLabel(topAgent)}
                          </span>
                          <span className="shrink-0 rounded bg-accent/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-accent">
                            Default
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <span className="text-[10px] text-ink-4">fills rest</span>
                          <span className="w-5 text-center text-[11px] font-bold tabular-nums text-ink">
                            {remaining}
                          </span>
                        </span>
                      </div>

                      {otherAgents.map((id) => {
                        const c = agentCounts[id] ?? 0
                        return (
                          <div
                            key={id}
                            className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 transition-colors ${
                              c > 0
                                ? 'border-accent/60 bg-accent/[0.06]'
                                : 'border-transparent bg-panel'
                            }`}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <AgentIcon id={id} className="h-4 w-4" />
                              <span
                                className={`truncate text-xs font-medium ${c > 0 ? 'text-ink' : 'text-ink-3'}`}
                              >
                                {getAgentLabel(id)}
                              </span>
                            </span>
                            <span className="flex shrink-0 items-center justify-center rounded-lg bg-panel/60 p-0.5">
                              <button
                                onClick={() => bumpAgent(id, -1)}
                                disabled={c === 0}
                                className="grid h-5 w-5 place-items-center rounded leading-none text-ink-3 transition-colors hover:text-ink disabled:opacity-30"
                              >
                                −
                              </button>
                              <span className="grid h-5 w-5 place-items-center text-[11px] font-bold leading-none tabular-nums text-ink">
                                {c}
                              </span>
                              <button
                                onClick={() => bumpAgent(id, 1)}
                                disabled={remaining === 0}
                                className="grid h-5 w-5 place-items-center rounded leading-none text-ink-3 transition-colors hover:text-ink disabled:opacity-30"
                              >
                                +
                              </button>
                            </span>
                          </div>
                        )
                      })}
                    </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-transparent bg-canvas p-3 text-xs text-ink-2">
                {detectedAgents === null
                  ? 'Detecting installed agents…'
                  : 'No agents detected — terminals will open empty. Install a CLI (e.g. Claude Code) and enable it in Settings.'}
              </div>
            )}

            {availableAgents.filter(agentHasModelEffort).map((id) => (
              <div
                key={id}
                className="space-y-2 rounded-md border border-transparent bg-canvas p-3"
              >
                <div className="flex items-center gap-2">
                  <AgentIcon id={id} className="h-4 w-4" />
                  <span className="text-xs font-medium text-ink">{getAgentLabel(id)}</span>
                  <span className="text-[11px] text-ink-3">model &amp; reasoning effort</span>
                </div>
                <AgentModelEffort id={id} />
              </div>
            ))}
          </Foldout>

        </div>
        </PanelScroll>
        </div>

        {}
        <div className="mt-5 w-full shrink-0">
          <div
            className="launch-edge"
            data-disabled={(mode === 'create' && !canCreate && !creatingProject) || undefined}
          >
            <button
              onClick={() => void launch()}
              disabled={creating || (mode === 'create' && !canCreate)}
              aria-busy={creating || creatingProject}
              className="launch-button flex h-11 w-full items-center justify-center gap-2.5 px-5 text-sm font-semibold tracking-[0.01em]"
            >
              {creating || creatingProject ? (
                <>
                  <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  {creatingProject
                    ? 'Creating project…'
                    : existingMatch
                      ? 'Opening worktree…'
                      : 'Creating worktree…'}
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" className="launch-play h-4 w-4" fill="currentColor">
                    <path d="M7 4.5v15l12-7.5z" />
                  </svg>
                  {mode === 'create' ? 'Create & Launch' : 'Launch'}
                </>
              )}
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1" />
      </div>

      {creating && !existingMatch && <WorktreeCopyOverlay progress={copyProgress} />}
      {removingPath && <WorktreeRemovingOverlay progress={removeProgress} />}
      {creation.active && (
        <ProjectCreateOverlay
          name={creation.active.name}
          version={creation.active.version}
          progress={creation.active.progress}
          onCancel={() => window.api.unity.cancelCreateProject()}
        />
      )}
    </div>
  )
}

function CardIcon({ children }: { children: ReactNode }) {
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent/10 text-accent ring-1 ring-inset ring-accent/15">
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </span>
  )
}

function Foldout({
  title,
  icon,
  summary,
  open,
  onToggle,
  children
}: {
  title: string
  icon: ReactNode
  summary: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="rounded-lg bg-sunken">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="group flex w-full items-center gap-3 rounded-lg p-4 text-left"
      >
        <CardIcon>{icon}</CardIcon>
        <span className="shrink-0 text-[15px] font-semibold text-ink">{title}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-3">{summary}</span>
        <svg
          viewBox="0 0 24 24"
          className={`h-4 w-4 shrink-0 text-ink-3 transition-transform duration-200 group-hover:text-ink ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-3 px-4 pb-4">{children}</div>
        </div>
      </div>
    </div>
  )
}

function StartModeTabs({
  mode,
  onChange,
  disabled
}: {
  mode: StartMode
  onChange: (m: StartMode) => void
  disabled: boolean
}) {
  const tabs: { id: StartMode; label: string }[] = [
    { id: 'open', label: 'Open' },
    { id: 'create', label: 'Create' }
  ]
  return (
    <div role="tablist" className="pointer-events-auto flex gap-0.5 rounded-full bg-panel p-[3px]">
      {tabs.map((t) => {
        const active = t.id === mode
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onChange(t.id)}
            className={`h-[26px] rounded-full px-4 text-[11px] font-bold uppercase tracking-[0.14em] transition-colors disabled:cursor-default ${
              active ? 'bg-accent text-accent-fg' : 'text-ink-3 enabled:hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

function ProjectCreateOverlay({
  name,
  version,
  progress,
  onCancel
}: {
  name: string
  version: string
  progress: NewProjectProgress | null
  onCancel: () => void
}) {
  const pct = progress?.pct ?? 0
  return (
    <div className="animate-bfade-in absolute inset-0 z-40 flex flex-col items-center justify-center gap-6 bg-canvas/90 backdrop-blur-sm">
      <div className="w-full max-w-sm space-y-3 px-8">
        <p className="text-center text-xs font-medium tracking-wide text-ink-3">
          Creating <span className="text-ink">{name}</span> with Unity{' '}
          <span className="font-mono text-ink-2">{version}</span>
        </p>
        <div className="space-y-1.5">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
            {pct > 0 ? (
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
                style={{ width: `${pct}%` }}
              />
            ) : (
              <div className="worktree-copy-indeterminate h-full rounded-full bg-accent" />
            )}
          </div>
          <div className="flex items-center justify-between text-[11px] text-ink-3">
            <span className="truncate">{progress?.phase ?? 'Starting Unity…'}</span>
            <span className="shrink-0">The first import can take several minutes</span>
          </div>
        </div>
        <div className="flex justify-center pt-1">
          <button
            onClick={onCancel}
            className="rounded-md bg-panel px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-elevated hover:text-ink"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function parentDir(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return i > 0 ? trimmed.slice(0, i) : ''
}

function readNewProjectPrefs(): Partial<Pick<NewProjectDraft, 'kind' | 'version'>> {
  try {
    const v = JSON.parse(localStorage.getItem(NEW_PROJECT_KEY) ?? '{}') as Partial<NewProjectDraft>
    return {
      kind: v.kind === '2d' || v.kind === '3d' ? v.kind : undefined,
      version: typeof v.version === 'string' ? v.version : undefined
    }
  } catch {
    return {}
  }
}

function writeNewProjectPrefs(v: Pick<NewProjectDraft, 'kind' | 'version'>): void {
  try {
    localStorage.setItem(NEW_PROJECT_KEY, JSON.stringify(v))
  } catch {
    return
  }
}

function WorktreeCopyOverlay({ progress }: { progress: WorktreeCopyProgress | null }) {
  return (
    <div className="animate-bfade-in absolute inset-0 z-40 flex flex-col items-center justify-center gap-6 bg-canvas/90 backdrop-blur-sm">
      <div className="w-full max-w-sm px-8">
        <p className="mb-3 text-center text-xs font-medium tracking-wide text-ink-3">
          Creating worktree…
        </p>
        <WorktreeCopyBar progress={progress} />
      </div>
    </div>
  )
}

function WorktreeRemovingOverlay({ progress }: { progress: WorktreeRemoveProgress | null }) {
  return (
    <div className="animate-bfade-in absolute inset-0 z-40 flex flex-col items-center justify-center gap-6 bg-canvas/90 backdrop-blur-sm">
      <div className="w-full max-w-sm px-8">
        <p className="mb-3 text-center text-xs font-medium tracking-wide text-ink-3">
          Removing worktree…
        </p>
        <WorktreeRemoveBar progress={progress} />
      </div>
    </div>
  )
}

function WorktreeRemoveBar({ progress }: { progress: WorktreeRemoveProgress | null }) {
  const determinate =
    progress != null &&
    progress.phase === 'removing' &&
    !progress.indeterminate &&
    progress.totalBytes > 0
  const pct = determinate
    ? Math.min(100, Math.round((progress.removedBytes / progress.totalBytes) * 100))
    : 0
  const label =
    progress == null || progress.phase === 'preparing'
      ? 'Scanning worktree…'
      : determinate
        ? `Moving to Trash — ${formatGiB(progress.removedBytes)} / ${formatGiB(progress.totalBytes)}`
        : 'Moving to Trash…'

  return (
    <div className="space-y-1.5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        {determinate ? (
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className="worktree-copy-indeterminate h-full rounded-full bg-accent" />
        )}
      </div>
      <div className="flex items-center justify-between text-[11px] text-ink-3">
        <span className="truncate">{label}</span>
        {determinate && <span className="shrink-0 tabular-nums">{pct}%</span>}
      </div>
    </div>
  )
}

function UnityModeIcon({ id, className }: { id: UnityMode; className?: string }) {
  const common = {
    viewBox: '0 0 24 24',
    className,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  if (id === 'normal')
    return (
      <svg {...common}>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    )
  if (id === 'headless-graphics')
    return (
      <svg {...common}>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    )
  return (
    <svg {...common}>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 8 10 8a9.1 9.1 0 0 0 5.39-1.61" />
      <path d="M1 1l22 22" />
    </svg>
  )
}

function UnityModeToggle({
  value,
  onChange
}: {
  value: UnityMode
  onChange: (m: UnityMode) => void
}) {
  const active = UNITY_MODE_OPTIONS.find((o) => o.id === value) ?? UNITY_MODE_OPTIONS[0]
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-3 gap-1 rounded-md border border-transparent bg-canvas p-1">
        {UNITY_MODE_OPTIONS.map((o) => {
          const sel = o.id === value
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => onChange(o.id)}
              aria-pressed={sel}
              title={o.hint}
              className={`flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-semibold transition-all ${
                sel
                  ? 'bg-accent text-accent-fg'
                  : 'text-ink-2 hover:bg-white/[0.04] hover:text-ink'
              }`}
            >
              <UnityModeIcon id={o.id} className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{o.label}</span>
            </button>
          )
        })}
      </div>
      <p className="text-xs leading-snug text-ink-3">{active.hint}</p>
    </div>
  )
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

function sanitizeWorktreeName(raw: string): string {
  return raw
    .trim()
    .replace(/[\\/]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .replace(/^[-.]+/, '')
    .slice(0, 64)
}

function formatGiB(bytes: number): string {
  const gib = bytes / 1024 ** 3
  if (gib >= 1) return `${gib.toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

function WorktreeCopyBar({ progress }: { progress: WorktreeCopyProgress | null }) {
  const determinate =
    progress != null &&
    progress.phase === 'copying' &&
    !progress.indeterminate &&
    progress.totalBytes > 0
  const pct = determinate
    ? Math.min(100, Math.round((progress.copiedBytes / progress.totalBytes) * 100))
    : 0
  const label =
    progress == null || progress.phase === 'preparing'
      ? 'Measuring project files…'
      : determinate
        ? `Copying project files — ${formatGiB(progress.copiedBytes)} / ${formatGiB(progress.totalBytes)}`
        : 'Copying project files…'

  return (
    <div className="space-y-1.5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        {determinate ? (
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className="worktree-copy-indeterminate h-full rounded-full bg-accent" />
        )}
      </div>
      <div className="flex items-center justify-between text-[11px] text-ink-3">
        <span className="truncate">{label}</span>
        {determinate && <span className="shrink-0 tabular-nums">{pct}%</span>}
      </div>
    </div>
  )
}

function nextWorktreeName(existing: ProjectWorktree[]): string {
  const names = new Set(existing.map((w) => w.name))
  let n = 1
  while (names.has(`worktree${n}`)) n += 1
  return `worktree${n}`
}

function worktreeErrorMessage(res: CreateWorktreeResult, name: string): string {
  if (res.ok) return ''
  switch (res.code) {
    case 'branch-exists':
      return `The branch “${name}” is checked out in another worktree. Choose another name.`
    case 'exists':
      return `A worktree folder “${name}” already exists.`
    case 'invalid-name':
      return 'Enter a valid worktree name (letters, numbers, dashes).'
    case 'not-a-repo':
      return "This folder isn't a git repository."
    default:
      return res.message || 'Failed to create the worktree.'
  }
}

function QuickFill({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-md border border-transparent bg-panel px-2.5 py-1 text-[11px] font-medium text-ink-3 transition-colors hover:bg-elevated hover:text-ink"
    >
      {label}
    </button>
  )
}

function UnityLayoutPreview({ rows, cols }: { rows: number; cols: number }) {
  const block = 'bg-accent'
  return (
    <div className="flex h-9 w-full gap-[3px]">
      <span className={`w-1/5 rounded-sm ${block}`} />
      <div
        className="grid flex-1 gap-[3px]"
        style={{
          gridTemplateColumns: `repeat(${cols},1fr)`,
          gridTemplateRows: `repeat(${rows},1fr)`
        }}
      >
        {Array.from({ length: rows * cols }).map((_, i) => (
          <span key={i} className={`rounded-sm ${block}`} />
        ))}
      </div>
      <span className="flex flex-1 flex-col gap-[3px]">
        <span className={`flex-1 rounded-sm ${block}`} />
        <span className={`flex-1 rounded-sm ${block}`} />
      </span>
    </div>
  )
}

function GridLayoutPreview({ rows, cols }: { rows: number; cols: number }) {
  const block = 'bg-accent'
  return (
    <div className="flex h-9 w-full gap-[3px]">
      <span className={`w-1/5 rounded-sm ${block}`} />
      <div
        className="grid flex-1 gap-[3px]"
        style={{
          gridTemplateColumns: `repeat(${cols},1fr)`,
          gridTemplateRows: `repeat(${rows},1fr)`
        }}
      >
        {Array.from({ length: rows * cols }).map((_, i) => (
          <span key={i} className={`rounded-sm ${block}`} />
        ))}
      </div>
    </div>
  )
}
