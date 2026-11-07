import './window/background'
import './dev-isolation'
import './remote/ipc-tap'
import { app, BrowserWindow, nativeImage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { devInstanceName } from './dev-instance'
import './gpu-preference'
import { registerMediaProtocol } from './media-protocol'
import { registerReportProtocol } from './report/report-protocol'
import { registerReportFrameProtocol } from './report/report-frame-protocol'
import { installNavigationGuard } from './window/navigation-guard'
import { stopReportCompilerForQuit } from './report/compile'
import { stopAllAlerts } from './dashboard/alerts'
import { terminateAllScriptWorkers } from './satura-exec/sandbox/worker-host'
import { unityLogTailers } from './unity/unity-log-tailer'
import { registerCoreHandlers } from './ipc/register-core-handlers'
import { startRemoteHost, stopRemoteHost } from './remote/host'
import { registerPushEvents } from './remote/push-events'
import { registerAccountUsage } from './remote/account-usage'
import { startPhoneAwake } from './remote/phone-awake'
import { registerGpuRecovery } from './gpu-recovery'
import { disconnectDaemon, shutdownDaemon } from './daemon/daemon-init'
import { unityProvider, unityQuitBudgetMs } from './unity/unity-instance-provider'
import { releaseRemoteVideo, startRemoteVideo } from './remote-video'
import { startLayoutCapture } from './remote/layout-capture'
import {
  isQuitting,
  isRestoreQuit,
  isQuitConfirmed,
  markQuitConfirmed,
  markQuitting,
  markRelaunchOnQuit,
  setCloseTerminalsOnQuit,
  shouldCloseTerminalsOnQuit,
  shouldRelaunchOnQuit
} from './quit-state'
import { askWindowToConfirm } from './confirm-quit'
import {
  broadcastToAllWindows,
  createAppWindow,
  hasWindows,
  listWindows,
  focusWindow,
  getManagedWindow,
  windowIdForWebContents
} from './window/window-manager'
import { hasAnyWorkspaces, hasLiveTerminals } from './session-registry'
import { acquireShutdownStatus, setShutdownSubtitle } from './window/shutdown-window'
import { setLaunchStep, showLaunchSplash } from './window/splash-window'
import { installAppMenu } from './window/app-menu'
import { initUpdater, registerUpdaterIpc } from './updater'
import { flushStateSync } from './persistence'
import { abortProjectCreationOnQuit, killProjectCreationNow, recoverInterruptedProjectCreation } from './unity/project-create'
import { restoreClosedWindowsOrCreate, restoreOnLaunch } from './session-restore'
import {
  applyDevRelaunchRendererUrl,
  performPendingDevRelaunch,
  wasDevRelaunchSpawned
} from './dev-relaunch'

applyDevRelaunchRendererUrl()
installNavigationGuard()

app.whenReady().then(() => {
  showLaunchSplash()
  app.setAboutPanelOptions({
    applicationName: 'Satura Space',
    applicationVersion: app.getVersion(),
    copyright: 'Copyright © 2026 Satura Space contributors'
  })

  if (!app.isPackaged && process.platform === 'darwin') {
    const own = devInstanceName() && join(app.getAppPath(), `build/icon-${devInstanceName()}.png`)
    const devIcon = nativeImage.createFromPath(own && existsSync(own) ? own : join(app.getAppPath(), 'build/icon-dev.png'))
    if (!devIcon.isEmpty()) app.dock?.setIcon(devIcon)
  }

  installAppMenu()
  registerMediaProtocol()
  registerReportProtocol()
  registerReportFrameProtocol()
  startRemoteVideo()
  startLayoutCapture()
  registerCoreHandlers()
  void recoverInterruptedProjectCreation()
  registerGpuRecovery()
  registerUpdaterIpc()
  initUpdater()
  startRemoteHost()
  registerPushEvents()
  registerAccountUsage()
  startPhoneAwake()

  if (!restoreOnLaunch()) createAppWindow(undefined, { role: 'primary' })
  unityProvider.scheduleHandoffSweep()
  setLaunchStep('interface')

  app.on('activate', () => {
    if (isQuitting()) return
    if (!hasWindows()) restoreClosedWindowsOrCreate()
  })
})

app.on('second-instance', () => {
  if (isQuitting()) {
    markRelaunchOnQuit()
    setShutdownSubtitle('Satura Space will reopen after shutdown completes')
    return
  }
  const win = listWindows()[0]
  if (win) focusWindow(win.id)
  else if (!hasWindows()) restoreClosedWindowsOrCreate()
})

app.on('window-all-closed', () => {
  app.quit()
})

let confirmingQuit = false
let unityGracefulDone = false
let tearingDown = false

function quitConfirmWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed() && windowIdForWebContents(focused.webContents.id))
    return focused
  const firstId = listWindows()[0]?.id
  return firstId ? getManagedWindow(firstId) : null
}

function withTimeout(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))])
}

const DAEMON_SHUTDOWN_MS = 6500
const WORKERS_SHUTDOWN_MS = 2000
const PROJECT_CREATE_ABORT_MS = 3000
const QUIT_CLEANUP_MARGIN_MS = 3000

function quitFailsafeMs(): number {
  return Math.max(unityQuitBudgetMs(), DAEMON_SHUTDOWN_MS, WORKERS_SHUTDOWN_MS, PROJECT_CREATE_ABORT_MS) + QUIT_CLEANUP_MARGIN_MS
}

let finalQuitStepsDone = false

function runFinalQuitSteps(): void {
  if (finalQuitStepsDone) return
  finalQuitStepsDone = true
  killProjectCreationNow()
  stopRemoteHost()
  if (!wasDevRelaunchSpawned()) flushStateSync()
}

function forceExit(why: string): void {
  console.error(`[quit] ${why}`)
  try {
    runFinalQuitSteps()
  } catch (e) {
    console.error('[quit] final steps failed:', e)
  }
  releaseRemoteVideo()
  app.exit(0)
}

app.on('before-quit', (event) => {
  if (isRestoreQuit() || isQuitConfirmed() || !hasWindows()) {
    if (unityGracefulDone) return
    event.preventDefault()
    if (tearingDown) return
    tearingDown = true
    markQuitting()
    broadcastToAllWindows('app:quitting')
    const updateQuit = isRestoreQuit()
    const releaseStatus = acquireShutdownStatus(
      updateQuit ? 'Restarting Satura Space…' : 'Closing Satura Space…',
      updateQuit
        ? 'Unity instances, agents, and terminals keep running'
        : shouldCloseTerminalsOnQuit()
          ? 'Stopping Unity instances, agents, and terminals'
          : 'Stopping Unity instances and agents'
    )
    const daemonOp = shouldCloseTerminalsOnQuit()
      ? withTimeout(shutdownDaemon(), DAEMON_SHUTDOWN_MS)
      : withTimeout(disconnectDaemon(), 1500)
    const unityOp = updateQuit ? unityProvider.detachAllForUpdate() : unityProvider.gracefulKillAll()
    stopAllAlerts()
    const workersOp = withTimeout(
      Promise.allSettled([terminateAllScriptWorkers(), unityLogTailers.stopForQuit(), stopReportCompilerForQuit()]),
      WORKERS_SHUTDOWN_MS
    )
    const createOp = withTimeout(abortProjectCreationOnQuit(), PROJECT_CREATE_ABORT_MS)
    const relaunchIfRequested = (): void => {
      if (shouldRelaunchOnQuit() && !isRestoreQuit()) app.relaunch()
    }
    const failsafeMs = quitFailsafeMs()
    const failsafe = setTimeout(() => {
      if (!updateQuit) unityProvider.killAllNow()
      relaunchIfRequested()
      forceExit(`teardown did not finish within ${failsafeMs}ms — forcing exit`)
    }, failsafeMs)
    void Promise.allSettled([daemonOp, unityOp, workersOp, createOp]).then(async () => {
      clearTimeout(failsafe)
      unityGracefulDone = true
      try {
        await performPendingDevRelaunch()
      } catch (e) {
        console.error('[dev-relaunch] relaunch failed:', e)
      }
      relaunchIfRequested()
      releaseStatus()
      setTimeout(() => forceExit('app did not exit after teardown — forcing exit'), 4000)
      app.quit()
    })
    return
  }

  event.preventDefault()
  if (confirmingQuit) return
  const win = quitConfirmWindow()
  if (!win || !hasAnyWorkspaces()) {
    markQuitConfirmed()
    app.quit()
    return
  }
  confirmingQuit = true
  void askWindowToConfirm(win, {
    variant: 'quit',
    title: 'Quit Satura Space?',
    message: 'This stops all running Unity instances and agents, ending any work in progress.',
    confirmLabel: 'Quit',
    showCloseTerminals: hasLiveTerminals()
  }).then((result) => {
    confirmingQuit = false
    if (result.confirmed) {
      setCloseTerminalsOnQuit(result.closeTerminals)
      markQuitConfirmed()
      app.quit()
    }
  })
})

app.on('will-quit', () => {
  runFinalQuitSteps()
})

let signalQuitInProgress = false
const onQuitSignal = (): void => {
  if (signalQuitInProgress) return
  signalQuitInProgress = true
  markQuitConfirmed()
  app.quit()
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, onQuitSignal)
void app.whenReady().then(() =>
  setTimeout(() => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.removeListener(signal, onQuitSignal)
      process.on(signal, onQuitSignal)
    }
  }, 0)
)
