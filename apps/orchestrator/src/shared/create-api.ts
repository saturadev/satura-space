import type { AppCacheId } from './app-caches'
import type { RvSignal } from './remote-video'
import type { UnityLifecycle } from './unity/lifecycle'
import type {
  TunerEndedEvent,
  TunerLiveEvent,
  TunerMirror,
  TunerOpenRequest,
  TunerStateEvent,
  TunerViewsChanged
} from './tuner'
import type { PhoneDriftCue } from './drift-spot'
import type { TunerInspectorCaptureEvent } from './tuner-inspector'
import type {
  PreloadApi,
  AgentHookEvent,
  PtyDataEvent,
  PtyExitEvent,
  PanelDrop,
  DropTarget,
  MovedWorkspace,
  UnitySharedErrorEvent,
  InputGateProblem,
  UnityAgentFeedbackEvent,
  UnityPongEvent,
  UnityCursorEvent,
  UnityVideoEvent,
  UnityMouseDeltaEvent,
  UnityLogEvent,
  UnityWorldEvent,
  NewProjectProgress,
  OpenFileRequest,
  UpdaterStatus,
  AuthUser,
  WindowSession,
  SearchProgress,
  SearchDone,
  WorktreeCopyProgress,
  WorktreeRemoveProgress,
  QuitConfirmRequest,
  UsageProvider,
  UsageSnapshot
} from './api'
import type { Settings } from './types'
import type { ExecRendererRequest } from './agent-exec'
import type { ReportExportPayload } from './report-export'
import type { PickerNativeOptions } from './file-picker'
import type { ClaudeSessionEvent } from './claude-sessions'
import type { GitScmApi, ScmRemoteProgress } from './git-scm'
import type { DashboardApi } from './dashboard-api'

export interface IpcTransport {
  invoke: (channel: string, ...args: unknown[]) => Promise<any>
  send: (channel: string, ...args: unknown[]) => void
  sendSync: (channel: string, ...args: unknown[]) => any
  on: (channel: string, listener: (...args: any[]) => void) => () => void
}

export interface ApiPlatform {
  getZoomFactor: () => number
  getPathForFile: (file: File) => string
  dropSharedTexture: (id: string) => void
  sharedStats: PreloadApi['unity']['sharedStats']
  onSharedFrame: PreloadApi['unity']['onSharedFrame']
  onTunerFrame: PreloadApi['tuner']['onFrame']
  tunerSurface: PreloadApi['tuner']['surface']
  dropTunerSurface: PreloadApi['tuner']['dropSurface']
}

export function createApi(t: IpcTransport, p: ApiPlatform): PreloadApi {
  let quitRequestCb: ((req: QuitConfirmRequest) => void) | null = null
  let quitDismissCb: (() => void) | null = null
  let bufferedQuitRequest: QuitConfirmRequest | null = null

  t.on('app:quit-requested', (req: QuitConfirmRequest) => {
    if (quitRequestCb) quitRequestCb(req)
    else bufferedQuitRequest = req
  })
  t.on('app:quit-dismissed', () => {
    bufferedQuitRequest = null
    quitDismissCb?.()
  })

  let panelDropCb: ((drop: PanelDrop) => void) | null = null
  const bufferedPanelDrops: PanelDrop[] = []
  let workspaceDropCb: ((workspace: MovedWorkspace) => void) | null = null
  const bufferedWorkspaceDrops: MovedWorkspace[] = []

  t.on('window:panelDropped', (payload: PanelDrop) => {
    if (panelDropCb) panelDropCb(payload)
    else bufferedPanelDrops.push(payload)
  })
  t.on('window:workspaceDropped', (payload: MovedWorkspace) => {
    if (workspaceDropCb) workspaceDropCb(payload)
    else bufferedWorkspaceDrops.push(payload)
  })

  const api: PreloadApi = {
    app: {
      getVersion: () => t.invoke('app:getVersion'),
      isDev: () => t.invoke('app:isDev'),
      reportBug: () => t.invoke('app:reportBug'),
      setZoomFactor: (factor: number) => t.invoke('app:set-zoom-factor', factor),
      getZoomFactor: () => p.getZoomFactor(),
      onQuitRequested: (cb: (req: QuitConfirmRequest) => void) => {
        quitRequestCb = cb
        const buffered = bufferedQuitRequest
        bufferedQuitRequest = null
        if (buffered) cb(buffered)
        return () => {
          if (quitRequestCb === cb) quitRequestCb = null
        }
      },
      onQuitDismissed: (cb: () => void) => {
        quitDismissCb = cb
        return () => {
          if (quitDismissCb === cb) quitDismissCb = null
        }
      },
      respondQuit: (
        token: number,
        confirmed: boolean,
        closeTerminals?: boolean,
        scope?: 'app' | 'window'
      ) =>
        t.send('app:quit-response', {
          token,
          confirmed,
          closeTerminals: closeTerminals ?? false,
          scope: scope ?? 'app'
        }),
      notifyRendererWarm: () => t.send('app:renderer-warm'),
      launchStep: (step) => t.send('app:launch-step', step),
      onQuitting: (cb: () => void) => {
        const handler = (): void => cb()
        return t.on('app:quitting', handler)
      },
      onCloseAllWorkspaces: (cb: () => void) => {
        const handler = (): void => cb()
        return t.on('app:close-all-workspaces', handler)
      },
      openFile: (req) => t.invoke('app:openFile', req),
      compileReport: (file: string, root?: string) => t.invoke('app:compileReport', file, root),
      listReports: (root: string) => t.invoke('app:listReports', root),
      onReportsChanged: (cb) => {
        const handler = (ev: { file: string }): void => cb(ev)
        return t.on('app:reportsChanged', handler)
      },
      reportAction: (file: string, code: string, root: string) => t.invoke('app:reportAction', file, code, root),
      reportDiag: (line: string) => t.send('app:reportDiag', line),
      reportCodeRefs: (file: string, root: string | undefined, refs: string[]) => t.invoke('app:reportCodeRefs', file, root, refs),
      reportReadCode: (file: string, root: string | undefined, rel: string) => t.invoke('app:reportReadCode', file, root, rel),
      reportStat: (file: string, root: string, path: string) => t.invoke('app:reportStat', file, root, path),
      reportFrameMedia: (file: string, root: string) => t.invoke('app:reportFrameMedia', file, root),
      reportMediaInfo: (file: string, root: string, path: string) => t.invoke('app:reportMediaInfo', file, root, path),
      reportMediaRead: (file: string, root: string, path: string, offset: number, length: number) => t.invoke('app:reportMediaRead', file, root, path, offset, length),
      reportSaveMedia: (file: string, root: string, path: string, dest: string) => t.invoke('app:reportSaveMedia', file, root, path, dest),
      caches: () => t.invoke('app:caches'),
      clearCaches: (ids: AppCacheId[]) => t.invoke('app:clearCaches', ids),
      pathInfo: (path: string, git?: boolean) => t.invoke('app:pathInfo', path, git),
      reportInfo: (file: string, root: string) => t.invoke('app:reportInfo', file, root),
      reportExportScan: (file: string) => t.invoke('app:reportExportScan', file),
      reportExportWrite: (out: string, payload: ReportExportPayload) => t.invoke('app:reportExportWrite', out, payload),
      onOpenFile: (cb) => {
        const handler = (req: OpenFileRequest): void => cb(req)
        return t.on('app:openFile', handler)
      }
    },
    auth: {
      configured: () => t.invoke('auth:configured'),
      getSession: () => t.invoke('auth:get-session'),
      startSignIn: (open?: boolean) => t.invoke('auth:start-sign-in', open),
      signOut: () => t.invoke('auth:sign-out'),
      onSignedIn: (cb: (user: AuthUser) => void) => {
        const handler = (user: AuthUser): void => cb(user)
        return t.on('auth:signed-in', handler)
      },
      onSignedOut: (cb: () => void) => {
        const handler = (): void => cb()
        return t.on('auth:signed-out', handler)
      }
    },
    updater: {
      onStatus: (cb: (status: UpdaterStatus) => void) => {
        const handler = (status: UpdaterStatus): void => cb(status)
        return t.on('updater:status', handler)
      },
      check: () => t.send('updater:check'),
      simulate: () => t.send('updater:simulate'),
      install: () => t.send('updater:install')
    },
    settings: {
      get: () => t.invoke('settings:get'),
      set: (settings: Settings) => t.invoke('settings:set', settings)
    },
    agents: {
      detect: () => t.invoke('agents:detect')
    },
    session: {
      putWindowSync: (session: WindowSession) => t.sendSync('session:put-window', session),
      updateWindow: (session: WindowSession) => t.send('session:update-window', session),
      consumeWindow: (restoreId: string) => t.invoke('session:consume-window', restoreId),
      launchRestore: (restoreId: string) => t.invoke('session:launch-restore', restoreId),
      onPrepareRestore: (cb: () => void) => {
        const handler = (): void => cb()
        return t.on('updater:prepare-restore', handler)
      }
    },
    dialog: {
      native: (opts: PickerNativeOptions) => t.invoke('dialog:native', opts)
    },
    picker: {
      places: () => t.invoke('picker:places'),
      list: (dir: string, opts?: { unity?: boolean }) => t.invoke('picker:list', dir, opts),
      stat: (path: string) => t.invoke('picker:stat', path),
      mkdir: (parent: string, name: string) => t.invoke('picker:mkdir', parent, name)
    },
    fs: {
      readDir: (dirPath: string) => t.invoke('fs:readDir', dirPath),
      readFile: (filePath: string) => t.invoke('fs:readFile', filePath),
      readFileFrom: (filePath: string, offset: number, sig?: string) =>
        t.invoke('fs:readFileFrom', filePath, offset, sig),
      statPath: (inputPath: string) => t.invoke('fs:statPath', inputPath),
      writeFile: (filePath: string, content: string, opts?: { expected?: string }) =>
        t.invoke('fs:writeFile', opts?.expected === undefined ? { filePath, content } : { filePath, content, expected: opts.expected }),
      listFiles: (rootPath: string) => t.invoke('fs:listFiles', rootPath),
      searchStart: (requestId, opts) => t.send('fs:search:start', requestId, opts),
      searchCancel: (requestId) => t.send('fs:search:cancel', requestId),
      onSearchResult: (cb) => {
        const handler = (payload: SearchProgress): void => cb(payload)
        return t.on('fs:search:result', handler)
      },
      onSearchDone: (cb) => {
        const handler = (payload: SearchDone): void => cb(payload)
        return t.on('fs:search:done', handler)
      },
      replace: (req) => t.invoke('fs:replace', req),
      createFile: (filePath: string) => t.invoke('fs:createFile', filePath),
      createDir: (dirPath: string) => t.invoke('fs:createDir', dirPath),
      rename: (oldPath: string, newPath: string) =>
        t.invoke('fs:rename', { oldPath, newPath }),
      move: (oldPath: string, newPath: string) =>
        t.invoke('fs:move', { oldPath, newPath }),
      onPathMoved: (cb: (moved: { from: string; to: string }) => void) => {
        const handler = (payload: { from: string; to: string }): void => cb(payload)
        return t.on('fs:pathMoved', handler)
      },
      trash: (path: string) => t.invoke('fs:trash', path),
      duplicate: (path: string) => t.invoke('fs:duplicate', path),
      watchFile: (filePath: string, cb: () => void) => {
        const watchId = `fw-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const handler = (payload: { watchId: string }): void => {
          if (payload?.watchId === watchId) cb()
        }
        const off = t.on('fs:watch:changed', handler)
        t.send('fs:watch:start', { watchId, filePath })
        return () => {
          off()
          t.send('fs:watch:stop', { watchId })
        }
      },
      watchDirs: (cb: (dirs: string[]) => void) => {
        const watchId = `dw-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const handler = (payload: { watchId: string; dirs: string[] }): void => {
          if (payload?.watchId === watchId) cb(payload.dirs)
        }
        const off = t.on('fs:watchDirs:changed', handler)
        return {
          setDirs: (dirs: string[]) => t.send('fs:watchDirs:set', { watchId, dirs }),
          stop: () => {
            off()
            t.send('fs:watchDirs:stop', { watchId })
          }
        }
      }
    },
    ui: {
      writeClipboardText: (text: string) => t.invoke('ui:writeClipboardText', text),
      writeTerminalClipboard: (args: { text: string; ptyId: string; terminalFocused: boolean }) => t.invoke('ui:writeTerminalClipboard', args),
      readClipboardText: () => t.invoke('ui:readClipboardText'),
      readClipboardFilePaths: () => t.invoke('ui:readClipboardFilePaths'),
      saveClipboardImageAsTempFile: () => t.invoke('ui:saveClipboardImageAsTempFile'),
      onAppMenuPaste: (cb: () => void) => {
        const handler = (): void => cb()
        return t.on('ui:appMenuPaste', handler)
      },
      getPathForFile: (file: File) => p.getPathForFile(file)
    },
    shell: {
      openPath: (path: string) => t.invoke('shell:openPath', path),
      showItemInFolder: (path: string) => t.invoke('shell:showItemInFolder', path),
      openExternal: (url: string) => t.invoke('shell:openExternal', url)
    },
    resources: {
      getSnapshot: () => t.invoke('resources:getSnapshot')
    },
    system: {
      load: (since?: number) => t.invoke('system:load', since ?? 0)
    },
    claudeSessions: {
      list: (args) => t.invoke('claude-sessions:list', args),
      describe: (args) => t.invoke('claude-sessions:describe', args)
    },
    claudeUsage: {
      getRemaining: (force?: boolean) => t.invoke('claudeUsage:getRemaining', { force })
    },
    codexUsage: {
      getRemaining: (force?: boolean) => t.invoke('codexUsage:getRemaining', { force })
    },
    kimiUsage: {
      getRemaining: (force?: boolean) => t.invoke('kimiUsage:getRemaining', { force })
    },
    usage: {
      snapshot: (force?: boolean, provider?: UsageProvider) => t.invoke('usage:snapshot', { force, provider }),
      onChanged: (cb: (snapshot: UsageSnapshot) => void) => {
        const handler = (snapshot: UsageSnapshot): void => cb(snapshot)
        return t.on('usage:changed', handler)
      }
    },
    git: {
      listIgnored: (path: string) => t.invoke('git:listIgnored', path),
      blame: (rootPath: string, filePath: string, ref?: string) =>
        t.invoke('git:blame', { rootPath, filePath, ref }),
      isTracked: (rootPath: string, filePath: string) =>
        t.invoke('git:isTracked', { rootPath, filePath }),
      isRepo: (path: string) => t.invoke('git:isRepo', path),
      listWorktrees: (rootPath: string) => t.invoke('git:listWorktrees', rootPath),
      createWorktree: (rootPath: string, name: string) =>
        t.invoke('git:createWorktree', { rootPath, name }),
      onWorktreeProgress: (cb: (e: WorktreeCopyProgress) => void) => {
        const handler = (payload: WorktreeCopyProgress): void => cb(payload)
        return t.on('git:worktreeProgress', handler)
      },
      onWorktreeRemoveProgress: (cb: (e: WorktreeRemoveProgress) => void) => {
        const handler = (payload: WorktreeRemoveProgress): void => cb(payload)
        return t.on('git:worktreeRemoveProgress', handler)
      },
      removeWorktree: (rootPath: string, worktreePath: string) =>
        t.invoke('git:removeWorktree', { rootPath, worktreePath }),
      forceDeleteWorktreeBranch: (rootPath: string, branch: string) =>
        t.invoke('git:forceDeleteWorktreeBranch', { rootPath, branch }),
      releaseWorktreeProcesses: (worktreePath: string) =>
        t.invoke('git:releaseWorktreeProcesses', worktreePath)
    },
    gitScm: createGitScmApi(t),
    recents: {
      list: () => t.invoke('recents:list'),
      add: (path: string) => t.send('recents:add', path),
      remove: (path: string) => t.send('recents:remove', path)
    },
    window: {
      create: () => t.invoke('window:create'),
      createForWorkspace: (seed) => t.invoke('window:createForWorkspace', seed),
      list: () => t.invoke('window:list'),
      focus: (id: string) => t.send('window:focus', id),
      minimize: () => t.send('window:minimize'),
      maximize: () => t.send('window:maximize'),
      close: () => t.send('window:close'),
      isMaximized: () => t.invoke('window:isMaximized'),
      exitRevealLayout: () => t.invoke('window:exitRevealLayout'),
      onMaximizeChanged: (cb: (maximized: boolean) => void) => {
        const handler = (maximized: boolean): void => cb(maximized)
        return t.on('window:maximize-changed', handler)
      },
      onGpuReset: (cb: () => void) => {
        const handler = (): void => cb()
        return t.on('gpu:reset', handler)
      },
      setWorkspaceIdentity: (identity) => t.send('window:setWorkspaceIdentity', identity),
      movePanel: (args) => t.invoke('window:movePanel', args),
      dragBegin: (label, origin) => t.send('window:dragBegin', { label, origin }),
      dragEnd: () => t.invoke('window:dragEnd'),
      dragAbort: () => t.send('window:dragAbort'),
      dropReleased: () => t.send('window:dropReleased'),
      onDragComplete: (cb: (target: DropTarget) => void) => {
        const handler = (target: DropTarget): void => cb(target)
        return t.on('window:dragComplete', handler)
      },
      onDragActive: (cb: (active: boolean) => void) => {
        const handler = (active: boolean): void => cb(active)
        return t.on('window:dragActive', handler)
      },
      onDragHover: (
        cb: (e: { x: number; y: number; label: string; allowed: boolean }) => void
      ) => {
        const handler = (p: { x: number; y: number; label: string; allowed: boolean }
        ): void => cb(p)
        return t.on('window:dragHover', handler)
      },
      onDragHoverEnd: (cb: () => void) => {
        const handler = (): void => cb()
        return t.on('window:dragHoverEnd', handler)
      },
      onDragAbort: (cb: () => void) => {
        const handler = (): void => cb()
        return t.on('window:dragAbort', handler)
      },
      onPanelDropped: (cb: (drop: PanelDrop) => void) => {
        panelDropCb = cb
        while (bufferedPanelDrops.length) cb(bufferedPanelDrops.shift()!)
        return () => {
          if (panelDropCb === cb) panelDropCb = null
        }
      },
      claimWorkspace: (identity) => t.invoke('window:claimWorkspace', identity),
      moveWorkspaceToNewWindow: (workspace) =>
        t.invoke('window:moveWorkspace', workspace),
      moveWorkspaceToWindow: (targetId, workspace) =>
        t.invoke('window:moveWorkspaceToWindow', { targetId, workspace }),
      onWorkspaceDropped: (cb: (workspace: MovedWorkspace) => void) => {
        workspaceDropCb = cb
        while (bufferedWorkspaceDrops.length) cb(bufferedWorkspaceDrops.shift()!)
        return () => {
          if (workspaceDropCb === cb) workspaceDropCb = null
        }
      },
      closeWorkspaceWindows: (identity) =>
        t.send('window:closeWorkspaceWindows', identity)
    },
    pty: {
      spawn: (args) => t.invoke('pty:spawn', args),
      listShells: () => t.invoke('pty:listShells'),
      info: (id: string) => t.invoke('pty:info', { id }),
      write: (id, data) => t.send('pty:write', { id, data }),
      resize: (id, cols, rows) => t.send('pty:resize', { id, cols, rows }),
      kill: (id) => t.invoke('pty:kill', { id }),
      ackData: (id, charCount) => t.send('pty:ackData', { id, charCount }),
      restartDaemon: () => t.invoke('pty:restartDaemon'),
      onData: (cb) => {
        const handler = (payload: PtyDataEvent): void => cb(payload)
        return t.on('pty:data', handler)
      },
      onExit: (cb) => {
        const handler = (payload: PtyExitEvent): void => cb(payload)
        return t.on('pty:exit', handler)
      },
      onAgentHook: (cb) => {
        const handler = (payload: AgentHookEvent): void => cb(payload)
        return t.on('pty:agent-hook', handler)
      },
      agentStates: () => t.invoke('pty:agentStates'),
      reportAgentPanes: (panes) => t.send('pty:agentPanes', panes),
      onFocusAgent: (cb) => t.on('pty:focusAgent', (payload: { id: string }) => cb(payload)),
      onClaudeSession: (cb) => {
        const handler = (payload: ClaudeSessionEvent): void => cb(payload)
        return t.on('pty:claude-session', handler)
      },
      onSizeOwner: (cb) => t.on('pty:sizeOwner', cb)
    },
    unity: {
      start: (args) => t.invoke('unity:start', args),
      stop: (id) => t.invoke('unity:stop', { id }),
      release: (projectPath) => t.invoke('unity:release', { projectPath }),
      restart: (id) => t.invoke('unity:restart', { id }),
      stopProject: (projectPath) => t.invoke('unity:stopProject', { projectPath }),
      refresh: (id) => t.send('unity:refresh', { id }),
      revealEditor: (projectPath, opts) =>
        t.invoke('unity:revealEditor', { projectPath, split: opts?.split }),
      hideEditor: (projectPath, opts) => t.invoke('unity:hideEditor', { projectPath, force: opts?.force }),
      isEditorRevealed: (projectPath) => t.invoke('unity:isEditorRevealed', { projectPath }),
      onEditorRevealChanged: (cb) => {
        const handler = (payload: { projectPath: string; revealed: boolean }): void => cb(payload)
        return t.on('unity:editorRevealChanged', handler)
      },
      stepFrame: (projectPath) => t.invoke('unity:stepFrame', { projectPath }),
      getMode: (projectPath) => t.invoke('unity:getMode', { projectPath }),
      setMode: (projectPath, mode) => t.invoke('unity:setMode', { projectPath, mode }),
      closeExternalEditor: (projectPath, force) =>
        t.invoke('unity:closeExternalEditor', { projectPath, force }),
      isHubInstalled: () => t.invoke('unity:isHubInstalled'),
      listEditorsForCreate: () => t.invoke('unity:listEditorsForCreate'),
      checkNewProject: (parent, name) => t.invoke('unity:checkNewProject', { parent, name }),
      createProject: (args) => t.invoke('unity:createProject', args),
      cancelCreateProject: () => t.send('unity:cancelCreateProject'),
      onCreateProgress: (cb) => {
        const handler = (payload: NewProjectProgress): void => cb(payload)
        return t.on('unity:createProgress', handler)
      },
      openHub: () => t.invoke('unity:openHub'),
      hubState: () => t.invoke('unity:hubState'),
      startHub: () => t.invoke('unity:startHub'),
      lifecycle: (projectPath) => t.invoke('unity:lifecycle', { projectPath }),
      retry: (projectPath) => t.invoke('unity:retry', { projectPath }),
      cancel: (projectPath) => t.invoke('unity:cancel', { projectPath }),
      answerDialog: (projectPath, id, button) => t.invoke('unity:answerDialog', { projectPath, id, button }),
      watchLifecycle: (projectPath) => t.invoke('unity:watchLifecycle', { projectPath }),
      unwatchLifecycle: (projectPath) => t.send('unity:unwatchLifecycle', { projectPath }),
      onLifecycle: (cb) => {
        const handler = (payload: UnityLifecycle): void => cb(payload)
        return t.on('unity:lifecycle', handler)
      },
      installEditor: (projectPath) => t.invoke('unity:installEditor', { projectPath }),
      setHotReload: (id, enabled) => t.send('unity:setHotReload', { id, enabled }),
      setDesired: (projectPath, patch) => t.send('unity:setDesired', { projectPath, patch }),
      getWorld: (projectPath) => t.invoke('unity:getWorld', { projectPath }),
      onWorld: (cb) => {
        const handler = (payload: UnityWorldEvent): void => cb(payload)
        return t.on('unity:world', handler)
      },
      isProject: (projectPath) => t.invoke('unity:isProject', { projectPath }),
      ensureProjectEnv: (projectPath) =>
        t.invoke('unity:ensureProjectEnv', { projectPath }),
      getRecentScenes: (projectPath) =>
        t.invoke('unity:getRecentScenes', { projectPath }),
      setLastScene: (projectPath, scene) =>
        t.send('unity:setLastScene', { projectPath, scene }),
      removeRecentScene: (projectPath, scene) =>
        t.send('unity:removeRecentScene', { projectPath, scene }),
      getConsolePrefs: (projectPath) => t.invoke('unity:getConsolePrefs', { projectPath }),
      setConsolePrefs: (projectPath, prefs) =>
        t.send('unity:setConsolePrefs', { projectPath, prefs }),
      getRemotePrefs: (projectPath) => t.invoke('unity:getRemotePrefs', { projectPath }),
      setRemotePrefs: (projectPath, prefs) => t.invoke('unity:setRemotePrefs', { projectPath, prefs }),
      getStreamResolutions: (projectPath) => t.invoke('unity:getStreamResolutions', { projectPath }),
      setStreamResolutions: (projectPath, resolutions) =>
        t.invoke('unity:setStreamResolutions', { projectPath, resolutions }),
      sendInput: (id, json) => t.send('unity:input', { id, json }),
      ping: (id, pingId) => t.send('unity:ping', { id, pingId }),
      markLive: (id) => t.send('unity:markLive', { id }),
      viewHint: (id, hint) => t.send('unity:viewHint', { id, hint }),
      dropShared: (id) => {
        p.dropSharedTexture(id)
        t.send('unity:resendShared', { id })
      },
      sharedStats: () => p.sharedStats(),
      onSharedFrame: (cb) => p.onSharedFrame(cb),
      onInputGate: (cb) => {
        const handler = (payload: { projectPath: string; problem: InputGateProblem }): void => cb(payload)
        return t.on('unity:inputGate', handler)
      },
      onSharedError: (cb) => {
        const handler = (payload: UnitySharedErrorEvent): void => cb(payload)
        return t.on('unity:sharedError', handler)
      },
      onAgentFeedback: (cb) => {
        const handler = (payload: UnityAgentFeedbackEvent): void => cb(payload)
        return t.on('unity:agentFeedback', handler)
      },
      onPong: (cb) => {
        const handler = (payload: UnityPongEvent): void => cb(payload)
        return t.on('unity:pong', handler)
      },
      onCursor: (cb) => {
        const handler = (payload: UnityCursorEvent): void => cb(payload)
        return t.on('unity:cursor', handler)
      },
      onVideo: (cb) => {
        const handler = (payload: UnityVideoEvent): void => cb(payload)
        return t.on('unity:video', handler)
      },
      mouseDeltaAvailable: () => t.invoke('unity:mouseDeltaAvailable'),
      onMouseDelta: (cb) => {
        const handler = (payload: UnityMouseDeltaEvent): void => cb(payload)
        return t.on('unity:mouseDelta', handler)
      },
      setPointerLocked: (id, locked) => t.send('unity:pointerLocked', { id, locked }),
      instanceDir: (projectPath, worldId) => t.invoke('unity:instanceDir', { projectPath, worldId }),
      addPlayer: (projectPath) => t.invoke('unity:addPlayer', { projectPath }),
      removePlayer: (projectPath, cloneId) =>
        t.invoke('unity:removePlayer', { projectPath, cloneId }),
      players: (projectPath) => t.invoke('unity:players', { projectPath }),
      subscribeLog: (projectPath) => t.invoke('unity:console:subscribe', { projectPath }),
      unsubscribeLog: (projectPath) =>
        t.send('unity:console:unsubscribe', { projectPath }),
      onLog: (cb) => {
        const handler = (payload: UnityLogEvent): void => cb(payload)
        return t.on('unity:console:log', handler)
      }
    },
    tunerInspector: {
      open: (projectPath, session, target, width) =>
        t.invoke('tunerInspector:open', { projectPath, session, target, width }),
      input: (projectPath, session, input) => t.invoke('tunerInspector:input', { projectPath, session, input }),
      resize: (projectPath, session, width) => t.invoke('tunerInspector:resize', { projectPath, session, width }),
      capture: (projectPath, session, force) =>
        t.invoke('tunerInspector:capture', { projectPath, session, force }),
      close: (projectPath, session) => t.invoke('tunerInspector:close', { projectPath, session }),
      fonts: (fontDir) => t.invoke('tunerInspector:fonts', { fontDir }),
      onCapture: (cb) => {
        const handler = (payload: TunerInspectorCaptureEvent): void => cb(payload)
        return t.on('tunerInspector:capture', handler)
      }
    },
    tunerPopup: {
      objects: (projectPath, query) => t.invoke('tunerPopup:objects', { projectPath, query })
    },
    tuner: {
      listViews: (projectPath) => t.invoke('tuner:listViews', { projectPath }),
      watchViews: (projectPath) => t.invoke('tuner:watchViews', { projectPath }),
      unwatchViews: (projectPath) => t.invoke('tuner:unwatchViews', { projectPath }),
      canvases: (projectPath) => t.invoke('tuner:canvases', { projectPath }),
      writeQuickView: (projectPath, quick) => t.invoke('tuner:writeQuickView', { projectPath, quick }),
      addObject: (projectPath, view, object) => t.invoke('tuner:addObject', { projectPath, view, object }),
      onViewsChanged: (cb) => {
        const handler = (payload: TunerViewsChanged): void => cb(payload)
        return t.on('tuner:viewsChanged', handler)
      },
      onOpen: (cb) => {
        const handler = (payload: TunerOpenRequest): void => cb(payload)
        return t.on('tuner:open', handler)
      },
      start: (projectPath, session, view, restore) =>
        t.invoke('tuner:start', { projectPath, session, view, restore }),
      stop: (projectPath, session) => t.invoke('tuner:stop', { projectPath, session }),
      refresh: (projectPath, session) => t.invoke('tuner:refresh', { projectPath, session }),
      camera: (projectPath, session, camera) => t.send('tuner:camera', { projectPath, session, camera }),
      edit: (projectPath, session, edit) => t.invoke('tuner:edit', { projectPath, session, edit }),
      transform: (projectPath, session, transform) =>
        t.send('tuner:transform', { projectPath, session, transform }),
      open: (projectPath, session, target, ghost) => t.invoke('tuner:open', { projectPath, session, target, ghost }),
      close: (projectPath, session, id) => t.invoke('tuner:close', { projectPath, session, id }),
      button: (projectPath, session, index) => t.invoke('tuner:button', { projectPath, session, index }),
      select: (projectPath, session, state) => t.invoke('tuner:select', { projectPath, session, state }),
      reset: (projectPath, session, reset) => t.invoke('tuner:reset', { projectPath, session, reset }),
      save: (projectPath, session, stopPlay) => t.invoke('tuner:save', { projectPath, session, stopPlay: stopPlay === true }),
      discard: (projectPath, session, stopPlay) => t.invoke('tuner:discard', { projectPath, session, stopPlay: stopPlay === true }),
      discardScene: (projectPath) => t.invoke('tuner:discardScene', { projectPath }),
      saveScene: (projectPath) => t.invoke('tuner:saveScene', { projectPath }),
      newScene: (projectPath, path) => t.invoke('tuner:newScene', { projectPath, path }),
      particles: (projectPath, session, op, speed) => t.invoke('tuner:particles', { projectPath, session, op, speed }),
      animator: (projectPath, session, req) => t.invoke('tuner:animator', { projectPath, session, req }),
      staging: (projectPath, session, req) => t.invoke('tuner:staging', { projectPath, session, req }),
      hierarchy: (projectPath, session, req) => t.invoke('tuner:hierarchy', { projectPath, session, req }),
      canvasView: (projectPath, session, canvas, scene) => t.invoke('tuner:canvasView', { projectPath, session, canvas, scene }),
      watch: (projectPath, session, id, ids) => t.send('tuner:watch', { projectPath, session, id, ids }),
      tree: (projectPath, session, req) => t.send('tuner:tree', { projectPath, session, req }),
      pick: (projectPath, session, req) => t.invoke('tuner:pick', { projectPath, session, req }),
      clearView: (projectPath, session, req) => t.invoke('tuner:clearView', { projectPath, session, req }),
      pickRect: (projectPath, session, req) => t.invoke('tuner:pickRect', { projectPath, session, req }),
      rect: (projectPath, session, req) => t.invoke('tuner:rect', { projectPath, session, req }),
      rects: (projectPath, session, req) => t.invoke('tuner:rects', { projectPath, session, req }),
      handles: (projectPath, session, req) => t.invoke('tuner:handles', { projectPath, session, req }),
      sceneSelection: (projectPath, session, sel) => t.send('tuner:sceneSelection', { projectPath, session, sel }),
      theme: (projectPath, session, theme) => t.send('tuner:theme', { projectPath, session, theme }),
      sceneSettings: (projectPath, session, settings) => t.send('tuner:sceneSettings', { projectPath, session, settings }),
      annotations: (projectPath, session, req) => t.invoke('tuner:annotations', { projectPath, session, req }),
      visibility: (projectPath, session, visible) =>
        t.send('tuner:visibility', { projectPath, session, visible }),
      onFrame: (cb) => p.onTunerFrame(cb),
      surface: (projectPath, session) => p.tunerSurface(projectPath, session),
      dropSurface: (projectPath, session) => p.dropTunerSurface(projectPath, session),
      onState: (cb) => {
        const handler = (payload: TunerStateEvent): void => cb(payload)
        return t.on('tuner:state', handler)
      },
      onEnded: (cb) => {
        const handler = (payload: TunerEndedEvent): void => cb(payload)
        return t.on('tuner:ended', handler)
      },
      onLive: (cb) => {
        const handler = (payload: TunerLiveEvent): void => cb(payload)
        return t.on('tuner:live', handler)
      },
      attach: (projectPath, session) => t.invoke('tuner:attach', { projectPath, session }),
      mirror: (payload) => t.send('tuner:mirror', payload),
      onMirror: (cb) => {
        const handler = (payload: TunerMirror): void => cb(payload)
        return t.on('tuner:mirror', handler)
      },
      onDrift: (cb) => {
        const handler = (payload: PhoneDriftCue): void => cb(payload)
        return t.on('tuner:drift', handler)
      },
      driftAnswer: (payload) => t.send('tuner:driftAnswer', payload)
    },
    scratchpads: {
      attach: (projectPath) => t.invoke('scratchpads:attach', { projectPath }),
      list: (projectPath) => t.invoke('scratchpads:list', { projectPath }),
      create: (projectPath, name) => t.invoke('scratchpads:create', { projectPath, name }),
      rename: (projectPath, id, name) => t.invoke('scratchpads:rename', { projectPath, id, name }),
      start: (projectPath, id) => t.invoke('scratchpads:start', { projectPath, id }),
      stop: (projectPath, id) => t.invoke('scratchpads:stop', { projectPath, id }),
      restart: (projectPath, id) => t.invoke('scratchpads:restart', { projectPath, id }),
      remove: (projectPath, id) => t.invoke('scratchpads:remove', { projectPath, id }),
      stopAll: (projectPath) => t.invoke('scratchpads:stopAll', { projectPath }),
      setPanels: (projectPaths) => t.send('scratchpads:panels', { projectPaths }),
      onChanged: (cb) => {
        const handler = (payload: { projectPath: string }): void => cb(payload)
        return t.on('scratchpads:changed', handler)
      },
      onOpenPanel: (cb) => {
        const handler = (payload: { projectPath: string; id: string }): void => cb(payload)
        return t.on('scratchpads:openPanel', handler)
      }
    },
    agentExec: {
      onRequest: (cb) => {
        const handler = ({ reqId, request }: { reqId: number; request: ExecRendererRequest }): void => {
          void Promise.resolve()
            .then(() => cb(request))
            .then(
              (result) => t.send('agent-exec:reply', { reqId, result: result ?? null }),
              (e: unknown) =>
                t.send('agent-exec:reply', {
                  reqId,
                  result: { error: (e as Error)?.message ?? String(e) }
                })
            )
        }
        return t.on('agent-exec:request', handler)
      },
      tell: (paneKey, text, wait) => t.invoke('agent-exec:tell', { paneKey, text, wait })
    },
    remote: {
      status: () => t.invoke('remote:status'),
      newPairCode: () => t.invoke('remote:newPairCode'),
      pairInfo: () => t.invoke('remote:pairInfo'),
      setEnabled: (on) => t.invoke('remote:setEnabled', on),
      usage: () => t.invoke('remote:usage'),
      onPhones: (cb) => t.on('remote:phones', cb),
      pairedPhones: () => t.invoke('remote:pairedPhones'),
      onPairedPhones: (cb) => t.on('remote:pairedPhones', cb),
      forgetPhone: (phoneId) => t.invoke('remote:forgetPhone', phoneId),
      forgetAllPhones: () => t.invoke('remote:forgetAllPhones'),
      newKeys: () => t.invoke('remote:newKeys'),
      pairAsks: () => t.invoke('remote:pairAsks'),
      onPairAsk: (cb) => t.on('remote:pairAsk', cb),
      onPairAskDone: (cb) => t.on('remote:pairAskDone', cb),
      answerPair: (id, allow) => t.invoke('remote:answerPair', id, allow),
      presence: () => t.invoke('remote:presence'),
      onPresence: (cb) => t.on('remote:presence', cb),
      phonePanel: () => t.invoke('remote:phonePanel'),
      onPhonePanel: (cb) => t.on('remote:phonePanel', cb),
      onStoreAction: (cb) => t.on('remote:storeAction', cb),
      storeActionDone: (reqId, error, value) => t.send('remote:storeActionDone', { reqId, error, value }),
      setRestorePrompts: (list) => t.send('remote:setRestorePrompts', list)
    },
    remoteVideo: {
      signal: (msg) => t.send('rvideo:signal', msg),
      onSignal: (cb) => t.on('rvideo:signal', (msg: RvSignal) => cb(msg))
    },
    dashboard: createDashboardApi(t)
  }
  return api
}

let dashboardWatchSeq = 0

function createDashboardApi(t: IpcTransport): DashboardApi {
  return {
    load: (project) => t.invoke('dashboard:load', project),
    edit: (project, edit) => t.invoke('dashboard:edit', project, edit),
    saveState: (project, widget, key, value) => t.send('dashboard:state', project, widget, key, value),
    fetch: (project, req) => t.invoke('dashboard:fetch', project, req),
    abort: (id) => t.send('dashboard:abort', id),
    handle: (project, req) => t.invoke('dashboard:handle', project, req),
    git: (project, req) => t.invoke('dashboard:git', project, req),
    logs: (project, req) => t.invoke('dashboard:logs', project, req),
    file: (project, path, as) => t.invoke('dashboard:file', project, path, as),
    watch: (project, cb) => {
      const id = `dw${++dashboardWatchSeq}-${Math.random().toString(36).slice(2, 8)}`
      const off = t.on('dashboard:changed', (ev: { id: string; files: string[] }) => {
        if (ev?.id === id) cb(ev.files)
      })
      t.send('dashboard:watch', id, project)
      return () => {
        off()
        t.send('dashboard:unwatch', id)
      }
    },
    setProjects: (projects) => t.send('dashboard:projects', projects),
    alerts: (project) => t.invoke('dashboard:alerts', project),
    alertSent: (project, id, to) => t.send('dashboard:alertSent', project, id, to),
    onAlerts: (cb) => t.on('dashboard:alerts', cb),
    onOpen: (cb) => t.on('dashboard:open', cb),
    onSpawnAgent: (cb) => t.on('dashboard:spawnAgent', cb)
  }
}

function createGitScmApi(t: IpcTransport): GitScmApi {
  return {
    getState: (root) => t.invoke('gitScm:getState', root),
    log: (root, options) => t.invoke('gitScm:log', root, options),
    getCommit: (root, ref) => t.invoke('gitScm:getCommit', root, ref),
    getMergeBase: (root, ref1, ref2) => t.invoke('gitScm:getMergeBase', root, ref1, ref2),
    diffBetweenWithStats: (root, ref1, ref2) =>
      t.invoke('gitScm:diffBetweenWithStats', root, ref1, ref2),
    diffBetween: (root, ref1, ref2) => t.invoke('gitScm:diffBetween', root, ref1, ref2),
    patch: (root, path, originalPath, originalRef, modifiedRef) =>
      t.invoke('gitScm:patch', root, path, originalPath, originalRef, modifiedRef),
    explainDiff: (root, path, originalPath, originalRef, modifiedRef, checkContent) =>
      t.invoke('gitScm:explainDiff', root, path, originalPath, originalRef, modifiedRef, checkContent),
    diffStats: (root, ref1, ref2, paths) => t.invoke('gitScm:diffStats', root, ref1, ref2, paths),
    compareCommits: (root, ref1, ref2) => t.invoke('gitScm:compareCommits', root, ref1, ref2),
    compareCommitsStats: (root, ref1, ref2, paths) =>
      t.invoke('gitScm:compareCommitsStats', root, ref1, ref2, paths),
    show: (root, path, ref) => t.invoke('gitScm:show', root, path, ref),
    showImage: (root, path, ref) => t.invoke('gitScm:showImage', root, path, ref),
    revealInFolder: (root, path) => t.invoke('gitScm:revealInFolder', root, path),
    add: (root, paths) => t.invoke('gitScm:add', root, paths),
    revert: (root, paths) => t.invoke('gitScm:revert', root, paths),
    stageContent: (root, path, content, unstage) => t.invoke('gitScm:stageContent', root, path, content, unstage),
    discardOutsideEnv: (root, paths) => t.invoke('gitScm:discardOutsideEnv', root, paths),
    discardEnvLines: (root, path, content, expected) => t.invoke('gitScm:discardEnvLines', root, path, content, expected),
    rm: (root, paths) => t.invoke('gitScm:rm', root, paths),
    commit: (root, message) => t.invoke('gitScm:commit', root, message),
    fetch: (root) => t.invoke('gitScm:fetch', root),
    pull: (root, options) => t.invoke('gitScm:pull', root, options),
    push: (root, options) => t.invoke('gitScm:push', root, options),
    cancelRemote: (root) => t.invoke('gitScm:cancelRemote', root),
    rebaseAbort: (root) => t.invoke('gitScm:rebaseAbort', root),
    clean: (root, paths) => t.invoke('gitScm:clean', root, paths),
    merge: (root, ref) => t.invoke('gitScm:merge', root, ref),
    mergeAbort: (root) => t.invoke('gitScm:mergeAbort', root),
    stash: (root, options) => t.invoke('gitScm:stash', root, options),
    stashApply: (root, index) => t.invoke('gitScm:stashApply', root, index),
    stashPop: (root, index) => t.invoke('gitScm:stashPop', root, index),
    stashDrop: (root, index) => t.invoke('gitScm:stashDrop', root, index),
    stashShow: (root, index) => t.invoke('gitScm:stashShow', root, index),
    writeFile: (root, path, content, expected) => t.invoke('gitScm:writeFile', root, path, content, expected),
    trackedPaths: (root, entries) => t.invoke('gitScm:trackedPaths', root, entries),
    addToGitignore: (root, entries, untrack) => t.invoke('gitScm:addToGitignore', root, entries, untrack),
    updateNeverCommit: (root, change) => t.invoke('gitScm:updateNeverCommit', root, change),
    keepEnv: (root, paths) => t.invoke('gitScm:keepEnv', root, paths),
    getSettings: (root) => t.invoke('gitScm:getSettings', root),
    setSettings: (root, settings) => t.invoke('gitScm:setSettings', root, settings),
    watch: (root) => t.invoke('gitScm:watch', root),
    unwatch: (root) => t.invoke('gitScm:unwatch', root),
    onDidChange: (cb) => {
      const handler = (root: string): void => cb(root)
      return t.on('gitScm:didChange', handler)
    },
    onRemoteProgress: (cb) => t.on('gitScm:remoteProgress', (root: string, progress: ScmRemoteProgress | null) => cb(root, progress))
  }
}
