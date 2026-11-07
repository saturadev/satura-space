import { useEffect, useRef, useState } from 'react'
import { AppActions, SidebarToggle, useWorkspaceWindowIdentity } from './components/workspace/WorkspaceList'
import { X } from 'lucide-react'
import { WindowControls } from './components/workspace/WindowControls'
import { IS_MAC } from './lib/shortcuts/shortcuts'
import { BottomBar } from './components/workspace/BottomBar'
import { Workbench } from './components/workbench/Workbench'
import { SettingsPanel } from './components/panels/SettingsPanel'
import { useAppStore } from './store'
import { resolveDropZoneAt } from './lib/tab-drag'
import { isDragSourceWindow } from './lib/tab-drag-controller'
import { mountDragGhost, positionDragGhost, unmountDragGhost } from './lib/drag-ghost'
import { useDropFeedback } from './lib/drop-feedback'
import { QuickOpen } from './components/workbench/QuickOpen'
import { useGlobalHotkeys } from './lib/shortcuts/useGlobalHotkeys'
import { useAppMenuPaste } from './lib/shortcuts/useAppMenuPaste'
import { useAgentAlerts } from './lib/agent-alerts/use-agent-alerts'
import { ConfirmDialog } from './components/ui/ConfirmDialog'
import { FileVersionsDialog } from './components/ui/FileVersionsDialog'
import { FilePickerHost } from './components/ui/FilePicker'
import { QuitDialog } from './components/ui/QuitDialog'
import { requestConfirm, useConfirmStore } from './lib/confirm/confirm-store'
import { watchPairAsks } from './lib/remote/pair-ask'
import { editorUnsavedScenes, resolveEditorUnsaved, resolveTunerUnsaved, tunerUnsavedProjects } from './lib/tuner/unsaved'
import { resolveUnsavedFiles, windowUnsavedFiles } from './lib/editor/unsaved-files'
import { remapMovedPath } from './lib/editor/move-file'
import { startSessionWriteSubscriber } from './lib/session-write-subscriber'
import {
  settleTerminalSnapshotsForRestart,
  storeTerminalSnapshotsForReload
} from './lib/terminal/serialize'
import { useThemeSync } from './lib/theme/use-theme-sync'
import { IS_PRIMARY_WINDOW } from './lib/window-role'
import { wireAppQuitting } from './lib/app-quitting'
import { handleExternalOpenFile } from './lib/editor/open-file'
import { installFileDropOpen } from './lib/editor/file-drop-open'
import { openTunerView } from './lib/tuner/open-tuner'
import { installSceneTunerGate } from './lib/tuner/scene-gate'
import { installIconLabels } from './lib/a11y/icon-labels'
import { installTunerTips } from './lib/tuner/inspector/tooltip'
import { openScratchpadPanel } from './lib/unity/open-scratchpad-panel'
import { installAgentExecBridge } from './lib/agent-exec/bridge'
import { beginLaunchRestore } from './lib/claude-sessions/launch-restore'
import { useClaudeSessionTracking } from './lib/claude-sessions/session-tracking'
import { ClaudeSessionPicker } from './components/workbench/ClaudeSessionPicker'
import { ReportsPicker } from './components/report/ReportsPicker'
import { useRemoteDesktopBridge } from './remote/desktop-bridge'
import { useCapture } from './lib/capture'
import { installDashboardBridge } from './lib/dashboard/bridge'

function whenHydrated(fn: () => void): void {
  if (useAppStore.getState().hydrationSucceeded) {
    fn()
    return
  }
  const unsub = useAppStore.subscribe((s) => {
    if (!s.hydrationSucceeded) return
    unsub()
    fn()
  })
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [blockedHover, setBlockedHover] = useState(false)
  const [quitReq, setQuitReq] = useState<{
    token: number
    showKeep: boolean
    variant: 'quit' | 'close-primary'
  } | null>(null)
  const pendingQuitToken = useRef<number | null>(null)
  useThemeSync()

  const settleQuit = (
    confirmed: boolean,
    closeTerminals: boolean,
    scope: 'app' | 'window' = 'app'
  ): void => {
    const token = quitReq?.token ?? pendingQuitToken.current
    setQuitReq(null)
    if (confirmed && scope === 'window' && token != null) {
      void resolveUnsavedFiles(windowUnsavedFiles(), 'window').then((ok) => {
        if (pendingQuitToken.current !== token) return
        pendingQuitToken.current = null
        window.api.app.respondQuit(token, ok, closeTerminals, scope)
      })
      return
    }
    pendingQuitToken.current = null
    if (token != null) window.api.app.respondQuit(token, confirmed, closeTerminals, scope)
  }

  useEffect(() => {
    void useAppStore.getState().loadSettings()
    void useAppStore.getState().detectAgents()
    void useAppStore.getState().checkSession()
    const offAuth = useAppStore.getState().bindAuthEvents()
    return () => {
      offAuth()
    }
  }, [])

  useEffect(
    () =>
      window.api.fs.onPathMoved(({ from, to }) => {
        const drafts = remapMovedPath(from, to)
        if (drafts) console.info(`[fs] ${from} moved to ${to}, ${drafts} unsaved edit(s) moved along`)
      }),
    []
  )

  useEffect(
    () =>
      window.api.session.onPrepareRestore(() => {
        if (!useAppStore.getState().hydrationSucceeded) return
        void settleTerminalSnapshotsForRestart().then(() => {
          if (!useAppStore.getState().hydrationSucceeded) return
          window.api.session.putWindowSync(useAppStore.getState().buildWindowSession())
        })
      }),
    []
  )

  useEffect(() => {
    const offRequested = window.api.app.onQuitRequested((req) => {
      pendingQuitToken.current = req.token
      void (async () => {
        if (pendingQuitToken.current !== req.token) return
        if (req.variant === 'close-unsaved') {
          const ok = await resolveUnsavedFiles(windowUnsavedFiles(), 'window')
          if (pendingQuitToken.current !== req.token) return
          pendingQuitToken.current = null
          window.api.app.respondQuit(req.token, ok, false)
          return
        }
        const tunerProjects = tunerUnsavedProjects()
        for (const projectPath of tunerProjects) {
          const ok = await resolveTunerUnsaved(projectPath, 'quit')
          if (pendingQuitToken.current !== req.token) return
          if (!ok) {
            pendingQuitToken.current = null
            window.api.app.respondQuit(req.token, false, false)
            return
          }
        }
        if (req.variant !== 'close-window') {
          for (const { projectPath, scene } of editorUnsavedScenes(tunerProjects)) {
            const ok = await resolveEditorUnsaved(projectPath, scene)
            if (pendingQuitToken.current !== req.token) return
            if (!ok) {
              pendingQuitToken.current = null
              window.api.app.respondQuit(req.token, false, false)
              return
            }
          }
        }
        if (req.variant === 'close-window') {
          const files = windowUnsavedFiles()
          const asked = files.length
            ? resolveUnsavedFiles(files, 'window', { note: req.message })
            : requestConfirm({
                title: req.title,
                message: req.message,
                confirmLabel: req.confirmLabel
              })
          void asked.then((ok) => {
            if (pendingQuitToken.current !== req.token) return
            pendingQuitToken.current = null
            window.api.app.respondQuit(req.token, ok, false)
          })
          return
        }
        setQuitReq({
          token: req.token,
          showKeep: req.showCloseTerminals === true,
          variant: req.variant === 'close-primary' ? 'close-primary' : 'quit'
        })
      })()
    })
    const offDismissed = window.api.app.onQuitDismissed(() => {
      if (pendingQuitToken.current === null) return
      pendingQuitToken.current = null
      setQuitReq(null)
      useConfirmStore.getState().respond(false)
    })
    return () => {
      offRequested()
      offDismissed()
    }
  }, [])

  useEffect(() => watchPairAsks(), [])

  useEffect(() => {
    const handler = (): void => {
      if (!useAppStore.getState().hydrationSucceeded) return
      const session = useAppStore.getState().buildWindowSession()
      storeTerminalSnapshotsForReload(session.terminalSnapshots ?? {})
      try {
        window.api.session.putWindowSync(session)
      } catch {
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  useEffect(
    () =>
      window.api.app.onCloseAllWorkspaces(() => {
        useAppStore.getState().closeAllWorkspaces()
      }),
    []
  )

  useEffect(() => wireAppQuitting(), [])

  useEffect(
    () => window.api.app.onOpenFile((req) => void handleExternalOpenFile(req)),
    []
  )

  useEffect(() => window.api.tuner.onOpen((req) => void openTunerView(req)), [])
  useEffect(() => installSceneTunerGate(), [])
  useEffect(() => installIconLabels(), [])
  useEffect(() => installFileDropOpen(), [])
  useEffect(() => installTunerTips(), [])
  useEffect(() => window.api.scratchpads.onOpenPanel((req) => void openScratchpadPanel(req)), [])

  useEffect(() => installAgentExecBridge(), [])
  useEffect(() => installDashboardBridge(), [])

  useEffect(() => {
    let last = ''
    const report = (): void => {
      const s = useAppStore.getState()
      const step = !s.hydrationSucceeded || s.overlayPhase !== 'idle' ? 'workspaces' : 'ready'
      if (step === last) return
      last = step
      window.api.app.launchStep(step)
      if (step === 'ready') unsub()
    }
    const unsub = useAppStore.subscribe(report)
    report()
    return unsub
  }, [])

  useEffect(() => {
    let cancelled = false
    let stopWriter: (() => void) | null = null
    const startWriter = (): void => {
      if (!cancelled && !stopWriter) stopWriter = startSessionWriteSubscriber()
    }
    const params = new URLSearchParams(window.location.search)
    const hydrateFresh = (): void => {
      const seedFolder = params.get('seedFolder')
      const seedWorktree = params.get('seedWorktree')
      const seedName = params.get('seedName')
      if (seedFolder && !useAppStore.getState().activeWorkspaceId) {
        useAppStore
          .getState()
          .createWorkspace(seedName ?? undefined, seedFolder, seedWorktree ?? seedFolder)
      }
      useAppStore.getState().setHydrationSucceeded(true)
      startWriter()
    }
    const wid = params.get('wid')
    if (wid) {
      useAppStore.getState().beginWorkspaceOverlay()
      void window.api.session
        .consumeWindow(wid)
        .then((session) => {
          if (cancelled) {
            useAppStore.getState().settleWorkspaceOverlay()
            return
          }
          useAppStore.getState().settleWorkspaceOverlay(() => {
            if (session) {
              beginLaunchRestore(wid)
              useAppStore.getState().hydrateWindowSession(session)
              startWriter()
            } else {
              hydrateFresh()
            }
          })
        })
        .catch((err) => {
          console.error('session restore failed; leaving saved session untouched', err)
          useAppStore.getState().settleWorkspaceOverlay()
        })
    } else {
      hydrateFresh()
    }
    return () => {
      cancelled = true
      stopWriter?.()
    }
  }, [])

  const capturing = useCapture((c) => c.on)
  useWorkspaceWindowIdentity()
  useGlobalHotkeys(!settingsOpen)
  useAppMenuPaste()
  useAgentAlerts()
  useClaudeSessionTracking()
  useRemoteDesktopBridge()

  useEffect(() => {
    if (!settingsOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [settingsOpen])

  useEffect(() => {
    const toClientCss = (x: number, y: number): { x: number; y: number } => {
      const zoom = window.api.app.getZoomFactor() || 1
      return { x: x / zoom, y: y / zoom }
    }
    let dragActive = false
    const offDragActive = window.api.window.onDragActive((activeState) => {
      dragActive = activeState
    })
    const offHover = window.api.window.onDragHover(({ x, y, label, allowed }) => {
      dragActive = true
      const p = toClientCss(x, y)
      mountDragGhost(label)
      positionDragGhost(p.x, p.y)
      if (allowed) {
        setBlockedHover(false)
        useAppStore.getState().setExternalDropTarget(resolveDropZoneAt(p.x, p.y))
      } else {
        setBlockedHover(true)
        useAppStore.getState().setExternalDropTarget(null)
      }
    })
    const clear = (): void => {
      setBlockedHover(false)
      useAppStore.getState().setExternalDropTarget(null)
      unmountDragGhost()
    }
    const offHoverEnd = window.api.window.onDragHoverEnd(clear)
    const onDropRelease = (): void => {
      if (!dragActive) return
      dragActive = false
      if (isDragSourceWindow()) return
      window.api.window.dropReleased()
    }
    window.addEventListener('pointerup', onDropRelease, true)
    const offAbort = window.api.window.onDragAbort(() => {
      dragActive = false
      const s = useAppStore.getState()
      s.setDraggingTabId(null)
      s.setExternalDropTarget(null)
      setBlockedHover(false)
      unmountDragGhost()
    })
    const offDrop = window.api.window.onPanelDropped(({ panel, point }) => {
      dragActive = false
      setBlockedHover(false)
      unmountDragGhost()
      whenHydrated(() => {
        const local = point ? toClientCss(point.x, point.y) : null
        useAppStore
          .getState()
          .setExternalDropTarget(local ? resolveDropZoneAt(local.x, local.y) : null)
        useAppStore.getState().importPanel(panel)
      })
    })
    const offWorkspaceDrop = window.api.window.onWorkspaceDropped((workspace) => {
      whenHydrated(() => useAppStore.getState().importWorkspace(workspace))
    })
    return () => {
      window.removeEventListener('pointerup', onDropRelease, true)
      offDragActive()
      offHover()
      offHoverEnd()
      offAbort()
      offDrop()
      offWorkspaceDrop()
    }
  }, [])

  const overlays = (
    <>
      <FilePickerHost />
      <ConfirmDialog />
      <FileVersionsDialog />
      {quitReq && (
        <QuitDialog
          mode={quitReq.variant}
          showKeep={quitReq.showKeep}
          onQuit={() => settleQuit(true, true, 'app')}
          onKeep={() => settleQuit(true, false, 'app')}
          onCloseWindow={() => settleQuit(true, false, 'window')}
          onCancel={() => settleQuit(false, false, 'app')}
        />
      )}
    </>
  )

  return (
    <div className="flex h-full flex-col bg-window text-zinc-200">
      <div className="flex min-h-0 flex-1 flex-col">
        <main className="min-h-0 flex-1">
          <Workbench isPrimary={IS_PRIMARY_WINDOW} />
        </main>
        {!capturing && (
          <BottomBar
            trailing={IS_PRIMARY_WINDOW ? <AppActions onOpenSettings={() => setSettingsOpen(true)} /> : null}
          />
        )}
      </div>
      {IS_PRIMARY_WINDOW && <SidebarToggle />}
      {!IS_MAC && (
        <div className="fixed right-0 top-0 z-[190] flex h-[38px] overflow-hidden rounded-tr-lg">
          <WindowControls />
        </div>
      )}

      {blockedHover && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-red-950/25 ring-2 ring-inset ring-red-500/50">
          <div className="rounded-lg bg-red-950/85 px-3 py-1.5 text-sm font-medium text-red-100 shadow-lg">
            Different workspace — can’t drop here
          </div>
        </div>
      )}

      {!capturing && <DropFeedbackToast />}

      <QuickOpen />

      <ClaudeSessionPicker />
      <ReportsPicker />

      {overlays}

      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="surface-overlay relative h-[70%] w-[60%] max-w-2xl overflow-hidden rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setSettingsOpen(false)}
              title="Close settings"
              className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-white/10 hover:text-white"
            >
              <X size={16} strokeWidth={1.5} />
            </button>
            <SettingsPanel />
          </div>
        </div>
      )}
    </div>
  )
}

function DropFeedbackToast() {
  const message = useDropFeedback()
  if (!message) return null
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] -translate-x-1/2">
      <div className="surface-overlay rounded-lg px-3 py-1.5 text-sm text-zinc-200">
        {message}
      </div>
    </div>
  )
}
