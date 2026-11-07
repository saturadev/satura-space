import type { AppCacheId, AppCaches, AppCachesCleared } from './app-caches'
import type { RvSignal } from './remote-video'
import type { ReportCompileResult, ReportEntry } from './report-compile'
import type { DashboardApi } from './dashboard-api'
import type { ReportExportPayload, ReportExportResult, ReportExportScan } from './report-export'
import type { SaturaExecReply } from './satura-exec'
import type { RemoteAccountUsage, RemoteForgetResult, RemoteMediaInfo, RemotePairAnswer, RemotePairAsk, RemotePairInfo, RemotePairedPhone, RemotePresence, RemoteStatus, RemoteStoreActionRequest } from './remote-protocol'
import type { PhonePanel } from './phone-panel'
import type { PathHoverInfo, PtyHoverInfo, ReportHoverInfo } from './hover-info'
import type { PickerListing, PickerMkdirResult, PickerNativeOptions, PickerPlaces, PickerStat } from './file-picker'
import type { CodeFileResult, CodeRefResolution } from './report-code'
import type {
  AgentId,
  RemotePrefs,
  Settings,
  Workspace,
  Worktree,
  Tab,
  TabGroup,
  TabGroupLayoutNode,
  TabContentType,
  TunerTarget
} from './types'
import type { WorkspaceIdentity } from './workspace-identity'
import type { GitScmApi } from './git-scm'
import type {
  ClaudeRestorePromptState,
  ClaudeSessionEvent,
  ClaudeSessionRef,
  ClaudeSessionSummary,
  LaunchRestoreInfo
} from './claude-sessions'
import type { TunerApi } from './tuner'
import type { TunerInspectorApi } from './tuner-inspector'
import type { TunerPopupApi } from './tuner-inspector-popups'
import type { ScratchpadInfo, ScratchpadResult } from './scratchpads'
import type { AgentTellResult, ExecRendererHandler } from './agent-exec'
import type {
  WorldObserved,
  WorldDesired,
  InstanceObserved,
  InstanceDesired,
  UnityMode
} from './unity/world'
import type { SavedStreamResolution } from './unity/stream-size'
import type { UnityFailCode, UnityLifecycle, UnityStateTransition } from './unity/lifecycle'
import type {
  WorldSnapshotEvent,
  WorldPatchEvent,
  WorldDesiredPatchEvent,
  WorldProgressEvent
} from './unity/protocol'

export type { WorldObserved, WorldDesired, InstanceObserved, InstanceDesired, UnityMode }
export type { WorldSnapshotEvent, WorldPatchEvent, WorldDesiredPatchEvent, WorldProgressEvent }

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

export type UnityWorldEvent =
  (WorldSnapshotEvent | WorldPatchEvent | WorldDesiredPatchEvent | WorldProgressEvent) & {
    projectPath: string
    id: string
  }

export interface OpenFileRequest {
  file: string
  line?: number
  column?: number
  projectPath?: string
  ptyId?: string
  preview?: boolean
  source?: 'unity' | 'terminal' | 'link' | 'os'
}

export interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface DirWatchHandle {
  setDirs: (dirs: string[]) => void
  stop: () => void
}

export interface FsReadFileResult {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  dataUrl?: string
  tooLarge?: boolean
  byteLength?: number
  notFound?: boolean
}

export interface FsReadFileFromResult {
  text: string
  size: number
  next: number
  reset: boolean
  sig: string
  isBinary?: boolean
  tooLarge?: boolean
  notFound?: boolean
}

export interface FsPathInfo {
  resolved: string
  exists: boolean
  isFile: boolean
  isDirectory: boolean
  size?: number
}

export type FsTrashResult =
  | { ok: true }
  | { ok: false; code: 'locked' | 'error'; message?: string }

export type FsMoveResult =
  | { ok: true }
  | { ok: false; code: 'exists' | 'locked' | 'error'; message?: string }

export type FsRenameResult = FsMoveResult

export type FsWriteResult =
  | { ok: true; stamp: string }
  | { ok: false; code: 'conflict'; stamp: string; disk?: string }

export interface SearchMatch {
  line: number
  column: number
  lineText: string
  matchStart: number
  matchEnd: number
}

export interface SearchContextLine {
  line: number
  text: string
}

export interface SearchFileResult {
  filePath: string
  relativePath: string
  matches: SearchMatch[]
  context?: SearchContextLine[]
}

export interface SearchResult {
  files: SearchFileResult[]
  truncated: boolean
}

export interface SearchOptions {
  rootPath: string
  query: string
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  includeGlobs?: string
  excludeGlobs?: string
  useGitignore?: boolean
  contextLines?: number
  maxResults?: number
}

export interface SearchProgress {
  requestId: number
  files: SearchFileResult[]
}

export interface SearchDone {
  requestId: number
  fileCount: number
  matchCount: number
  limitHit: boolean
  error?: string
}

export interface ReplaceTarget {
  filePath: string
  matches?: { line: number; column: number }[]
}

export interface ReplaceRequest {
  rootPath: string
  query: string
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  replace: string
  preserveCase?: boolean
  targets: ReplaceTarget[]
}

export interface ReplaceResult {
  filesChanged: number
  replacements: number
}

export interface BlameRange {
  hash: string
  startLine: number
  endLine: number
  author: string
  email?: string
  dateMs: number
  summary: string
  uncommitted: boolean
}

export interface ProjectWorktree {
  name: string
  path: string
  branch: string
}

export type CreateWorktreeResult =
  | { ok: true; path: string; adopted?: boolean; reusedBranch?: boolean; behindHead?: boolean }
  | { ok: false; code: 'not-a-repo' | 'invalid-name' | 'exists' | 'branch-exists' | 'error'; message?: string }

export interface WorktreeCopyProgress {
  rootPath: string
  name: string
  phase: 'preparing' | 'copying' | 'done'
  copiedBytes: number
  totalBytes: number
  indeterminate: boolean
}

export interface WorktreeRemoveProgress {
  worktreePath: string
  phase: 'preparing' | 'removing' | 'done'
  removedBytes: number
  totalBytes: number
  indeterminate: boolean
}

export interface RemoveWorktreeResult {
  ok: boolean
  message?: string
  unmergedBranch?: { branch: string; commits: number; into: string }
}

export interface PtySpawnArgs {
  id: string
  cols: number
  rows: number
  cwd?: string
  shell?: string
  env?: Record<string, string>
}

export interface PtySpawnResult {
  pid: number
  attached: boolean
  snapshot: string | null
  snapshotCols?: number
  snapshotRows?: number
  isReattach?: boolean
  isAlternateScreen?: boolean
  error?: string
}

export interface PtyDataEvent {
  id: string
  data: string
  seq?: number
  rawLength?: number
}

export interface PtyExitEvent {
  id: string
  exitCode: number
}

export type AgentHookKind = 'working' | 'finished' | 'attention' | 'idle'

export interface AgentHookEvent {
  id: string
  kind: AgentHookKind
}

export interface AgentPaneReport {
  ptyId: string
  agentId: string | null
  label: string
  workspace: string
  visible: boolean
}

export interface UnityStartArgs {
  id: string
  projectPath: string
}

export interface PlayerInfo {
  id: string
  kind: 'primary' | 'clone'
  vpId: string | null
  pid: number | null
  playing: boolean
  state: 'editmode' | 'launching' | 'streaming'
}

export type HubState = 'ready' | 'starting' | 'signed-out' | 'not-running' | 'not-installed'

export type NewProjectKind = '2d' | '3d'

export interface UnityEditorForCreate {
  version: string
  kinds: NewProjectKind[]
}

export interface NewProjectArgs {
  version: string
  kind: NewProjectKind
  parent: string
  name: string
}

export type NewProjectResult =
  | { ok: true; path: string }
  | { ok: false; error: string; cancelled?: boolean }

export interface NewProjectProgress {
  phase: string
  pct: number
}

export interface InputGateProblem {
  handler: number
  packageMissing: boolean
  settingsFile: string
  settingsLine?: number
  manifestFile: string
}

export interface UnityStartResult {
  ok: boolean
  hub?: Exclude<HubState, 'ready'>
  missing?: string
  inputGate?: InputGateProblem
  mediaPort?: number
  inputPort?: number
  error?: string
  standalone?: boolean
  stopped?: boolean
  code?: UnityFailCode
}

export interface UnityViewHint {
  visible: boolean
  width: number
  height: number
}

export interface UnitySharedErrorEvent {
  id: string
  message: string
}

export interface UnityAgentFeedbackEvent {
  id: string
  projectPath: string
  seq: number
  dataUrl: string
  timestamp: number
}

export interface UnityPongEvent {
  id: string
  pingId: number
}

export interface UnityCursorImage {
  id: number
  url: string
  x: number
  y: number
}

export interface UnityCursorEvent {
  id: string
  locked: boolean
  visible: boolean
  image: UnityCursorImage | null
}

export interface UnityVideoEvent {
  id: string
  active: boolean
  recording: boolean
  width: number
  height: number
  seconds: number
  audio: boolean
}

export interface UnityMouseDeltaEvent {
  dx: number
  dy: number
}

export interface UnityLogLine {
  seq: number
  severity: 'log' | 'warn' | 'error'

  kind?: 'play' | 'restart'
  frame: number
  time: number
  message: string
  stack?: string
}

export interface UnityLogEvent {
  projectPath: string
  lines: UnityLogLine[]
}

export interface UnityConsolePrefs {
  showLog: boolean
  showWarn: boolean
  showError: boolean
  collapse: boolean
}

export interface WorkspaceState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  worktreesByWorkspace: Record<string, Worktree[]>
  tabsByWorkspace: Record<string, Tab[]>
  groupsByWorkspace: Record<string, TabGroup[]>
  layoutByWorkspace: Record<string, TabGroupLayoutNode>
  activeGroupIdByWorkspace: Record<string, string>
  exitedPtyIds?: string[]
}

export interface DraftMeta {
  base: string
  by: 'mac' | 'phone'
}

export interface FilesState {
  viewerFileByTab: Record<string, string>
  markdownViewByTab: Record<string, 'preview' | 'source'>
  selectedFileByWorktree: Record<string, string>
  expandedDirsByWorktree: Record<string, string[]>
  blameEnabledByPath: Record<string, boolean>
  draftsByPath: Record<string, string>
  draftMetaByPath?: Record<string, DraftMeta>
  liveByTab?: Record<string, boolean>
}

export interface WindowSession {
  workspace: WorkspaceState
  files: FilesState
  terminalSnapshots?: Record<string, string>
}

export interface WindowSnapshot {
  bounds?: { x: number; y: number; width: number; height: number }
  maximized?: boolean
  identity: WorkspaceIdentity | null
  label: string
  role?: 'primary' | 'secondary'
  session: WindowSession
}

export interface PersistedSession {
  windows: WindowSnapshot[]
}

export interface WindowInfo {
  id: string
  label: string
  focused: boolean
  role: 'primary' | 'secondary'
}

export interface MoveWorkspaceResult {
  ok: boolean
  reason?: 'duplicate' | 'no-window'
}

export interface MovedPanelTab {
  ptyId: string
  contentType: TabContentType
  label: string
  customLabel?: string | null
  generatedLabel?: string | null
  agentId?: AgentId | null
  claudeSessionId?: string | null
  parentPtyId?: string | null
  worktreeName: string
  worktreePath: string
  scrollback?: string | null
  viewerFile?: string | null
  markdownView?: 'preview' | 'source' | null
  draft?: string | null
  blameEnabled?: boolean
  tuner?: TunerTarget | null
  scratchpadId?: string | null
}

export interface MovedPanel {
  tabs: MovedPanelTab[]
  activeTabIndex: number
  originFolderPath: string
  originWorktreePath: string
}

export interface MovedWorkspace {
  workspace: Workspace
  worktrees: Worktree[]
  tabs: Tab[]
  groups: TabGroup[]
  layout: TabGroupLayoutNode
  activeGroupId: string
  scrollbackByPty: Record<string, string>
  viewerFileByTab: Record<string, string>
  markdownViewByTab: Record<string, 'preview' | 'source'>
  selectedFileByWorktree: Record<string, string>
  expandedDirsByWorktree: Record<string, string[]>
  draftsByPath: Record<string, string>
}

export interface DropTarget {
  target: string | 'new' | 'self' | 'rejected'
  point?: { x: number; y: number }
}

export interface PanelDrop {
  panel: MovedPanel
  point?: { x: number; y: number }
}

export interface ResourceSession {
  kind: 'app' | 'terminal' | 'unity'
  id: string
  pid: number
  label: string
  cpu: number | null
  memory: number | null
  cwd?: string
  projectPath?: string
  unityKind?: 'primary' | 'clone'
  scratchpadName?: string
  windowId?: string
  workspaceId?: string
}

export interface ResourceWorkspaceInfo {
  id: string
  name: string
  isWorktree: boolean
  worktreeLabel: string | null
}

export interface ResourceWindowInfo {
  id: string
  label: string
  focused: boolean
  workspaces: ResourceWorkspaceInfo[]
}

export interface ResourceSnapshot {
  sessions: ResourceSession[]
  windows: ResourceWindowInfo[]
  totalCpu: number
  totalMemory: number
  hostMemory: number
  freeMemory: number
}

export interface SystemSample {
  t: number
  cpu: number
  mem: number
}

export interface SystemDisk {
  path: string
  total: number
  free: number
}

export interface SystemLoad {
  samples: SystemSample[]
  memTotal: number
  disk: SystemDisk | null
  intervalMs: number
  windowMs: number
  cores: number
}

export interface RateLimitWindow {
  usedPercent: number
  windowMinutes: number
  resetsAt: number | null
  model?: string | null
}

export type UsageProvider = 'claude' | 'codex' | 'kimi'

export interface UsageRemaining {
  provider: UsageProvider
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  weeklyScoped?: RateLimitWindow[]
  updatedAt: number
  error: string | null
  status: 'ok' | 'error' | 'unavailable'
  stale?: boolean
}

export interface UsageSnapshot {
  providers: UsageProvider[]
  usage: Partial<Record<UsageProvider, UsageRemaining>>
  checking: UsageProvider[]
}

export type ClaudeUsageRemaining = UsageRemaining
export type CodexUsageRemaining = UsageRemaining
export type KimiUsageRemaining = UsageRemaining

export type UpdaterStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'not-available' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

export interface AuthUser {
  email: string
}

export interface QuitConfirmRequest {
  title: string
  message: string
  confirmLabel: string
  showCloseTerminals?: boolean
  variant?: 'quit' | 'close-window' | 'close-primary' | 'close-unsaved'
  token: number
}

export interface PreloadApi {
  app: {
    getVersion: () => Promise<string>
    isDev: () => Promise<boolean>
    reportBug: () => Promise<void>
    setZoomFactor: (factor: number) => Promise<void>
    getZoomFactor: () => number
    onQuitRequested: (cb: (req: QuitConfirmRequest) => void) => () => void
    onQuitDismissed: (cb: () => void) => () => void
    respondQuit: (
      token: number,
      confirmed: boolean,
      closeTerminals?: boolean,
      scope?: 'app' | 'window'
    ) => void
    notifyRendererWarm: () => void
    launchStep: (step: 'workspaces' | 'ready') => void
    onQuitting: (cb: () => void) => () => void
    onCloseAllWorkspaces: (cb: () => void) => () => void
    openFile: (req: OpenFileRequest) => Promise<boolean>
    onOpenFile: (cb: (req: OpenFileRequest) => void) => () => void
    compileReport: (file: string, root?: string) => Promise<ReportCompileResult>
    listReports: (root: string) => Promise<ReportEntry[]>
    onReportsChanged: (cb: (ev: { file: string }) => void) => () => void
    reportAction: (file: string, code: string, root: string) => Promise<SaturaExecReply>
    reportDiag: (line: string) => void
    reportCodeRefs: (file: string, root: string | undefined, refs: string[]) => Promise<Record<string, CodeRefResolution>>
    reportReadCode: (file: string, root: string | undefined, rel: string) => Promise<CodeFileResult>
    reportStat: (file: string, root: string, path: string) => Promise<{ exists: boolean; outside?: boolean }>
    reportFrameMedia: (file: string, root: string) => Promise<string>
    reportMediaInfo: (file: string, root: string, path: string) => Promise<RemoteMediaInfo | null>
    reportMediaRead: (file: string, root: string, path: string, offset: number, length: number) => Promise<{ data: Uint8Array; size: number }>
    reportSaveMedia: (file: string, root: string, path: string, dest: string) => Promise<{ file: string; bytes: number }>
    caches: () => Promise<AppCaches>
    clearCaches: (ids: AppCacheId[]) => Promise<AppCachesCleared>
    pathInfo: (path: string, git?: boolean) => Promise<PathHoverInfo>
    reportInfo: (file: string, root: string) => Promise<ReportHoverInfo>
    reportExportScan: (file: string) => Promise<ReportExportScan>
    reportExportWrite: (out: string, payload: ReportExportPayload) => Promise<ReportExportResult>
  }
  auth: {
    configured: () => Promise<boolean>
    getSession: () => Promise<AuthUser | null>
    startSignIn: (open?: boolean) => Promise<{ url: string }>
    signOut: () => Promise<void>
    onSignedIn: (cb: (user: AuthUser) => void) => () => void
    onSignedOut: (cb: () => void) => () => void
  }
  updater: {
    onStatus: (cb: (status: UpdaterStatus) => void) => () => void
    check: () => void
    simulate: () => void
    install: () => void
  }
  settings: {
    get: () => Promise<Settings>
    set: (settings: Settings) => Promise<Settings>
  }
  agents: {
    detect: () => Promise<AgentId[]>
  }
  session: {
    putWindowSync: (session: WindowSession) => void
    updateWindow: (session: WindowSession) => void
    consumeWindow: (restoreId: string) => Promise<WindowSession | null>
    launchRestore: (restoreId: string) => Promise<LaunchRestoreInfo | null>
    onPrepareRestore: (cb: () => void) => () => void
  }
  dialog: {
    native: (opts: PickerNativeOptions) => Promise<string[] | null>
  }
  picker: {
    places: () => Promise<PickerPlaces>
    list: (dir: string, opts?: { unity?: boolean }) => Promise<PickerListing>
    stat: (path: string) => Promise<PickerStat>
    mkdir: (parent: string, name: string) => Promise<PickerMkdirResult>
  }
  fs: {
    readDir: (dirPath: string) => Promise<DirEntry[]>
    readFile: (filePath: string) => Promise<FsReadFileResult>
    readFileFrom: (filePath: string, offset: number, sig?: string) => Promise<FsReadFileFromResult>
    statPath: (inputPath: string) => Promise<FsPathInfo>
    writeFile: (filePath: string, content: string, opts?: { expected?: string }) => Promise<FsWriteResult>
    listFiles: (rootPath: string) => Promise<string[]>
    searchStart: (requestId: number, opts: SearchOptions) => void
    searchCancel: (requestId: number) => void
    onSearchResult: (cb: (e: SearchProgress) => void) => () => void
    onSearchDone: (cb: (e: SearchDone) => void) => () => void
    replace: (req: ReplaceRequest) => Promise<ReplaceResult>
    createFile: (filePath: string) => Promise<void>
    createDir: (dirPath: string) => Promise<void>
    rename: (oldPath: string, newPath: string) => Promise<FsRenameResult>
    move: (oldPath: string, newPath: string) => Promise<FsMoveResult>
    onPathMoved: (cb: (moved: { from: string; to: string }) => void) => () => void
    trash: (path: string) => Promise<FsTrashResult>
    duplicate: (path: string) => Promise<string>
    watchFile: (filePath: string, cb: () => void) => () => void
    watchDirs: (cb: (dirs: string[]) => void) => DirWatchHandle
  }
  ui: {
    writeClipboardText: (text: string) => Promise<void>
    writeTerminalClipboard: (args: { text: string; ptyId: string; terminalFocused: boolean }) => Promise<'written' | 'unfocused' | 'too-large' | 'empty'>
    readClipboardText: () => Promise<string>
    readClipboardFilePaths: () => Promise<string[]>
    saveClipboardImageAsTempFile: () => Promise<string | null>
    onAppMenuPaste: (cb: () => void) => () => void
    getPathForFile: (file: File) => string
  }
  shell: {
    openPath: (path: string) => Promise<'opened' | 'revealed' | 'missing'>
    showItemInFolder: (path: string) => Promise<void>
    openExternal: (url: string) => Promise<void>
  }
  resources: {
    getSnapshot: () => Promise<ResourceSnapshot>
  }
  system: {
    load: (since?: number) => Promise<SystemLoad>
  }
  claudeSessions: {
    list: (args: {
      projectPath: string
      limit?: number
      exclude?: string[]
      configDir?: string
    }) => Promise<ClaudeSessionSummary[]>
    describe: (args: {
      items: ClaudeSessionRef[]
      configDir?: string
    }) => Promise<(ClaudeSessionSummary | null)[]>
  }
  claudeUsage: {
    getRemaining: (force?: boolean) => Promise<ClaudeUsageRemaining>
  }
  codexUsage: {
    getRemaining: (force?: boolean) => Promise<CodexUsageRemaining>
  }
  kimiUsage: {
    getRemaining: (force?: boolean) => Promise<KimiUsageRemaining>
  }
  usage: {
    snapshot: (force?: boolean, provider?: UsageProvider) => Promise<UsageSnapshot>
    onChanged: (cb: (snapshot: UsageSnapshot) => void) => () => void
  }
  git: {
    listIgnored: (path: string) => Promise<string[]>
    blame: (rootPath: string, filePath: string, ref?: string) => Promise<BlameRange[]>
    isTracked: (rootPath: string, filePath: string) => Promise<boolean>
    isRepo: (path: string) => Promise<boolean>
    listWorktrees: (rootPath: string) => Promise<ProjectWorktree[]>
    createWorktree: (rootPath: string, name: string) => Promise<CreateWorktreeResult>
    onWorktreeProgress: (cb: (e: WorktreeCopyProgress) => void) => () => void
    removeWorktree: (rootPath: string, worktreePath: string) => Promise<RemoveWorktreeResult>
    forceDeleteWorktreeBranch: (rootPath: string, branch: string) => Promise<RemoveWorktreeResult>
    onWorktreeRemoveProgress: (cb: (e: WorktreeRemoveProgress) => void) => () => void
    releaseWorktreeProcesses: (worktreePath: string) => Promise<void>
  }
  gitScm: GitScmApi
  recents: {
    list: () => Promise<string[]>
    add: (path: string) => void
    remove: (path: string) => void
  }
  window: {
    create: () => Promise<string>
    createForWorkspace: (seed: {
      folderPath: string
      worktreePath: string
      name: string
    }) => Promise<string>
    list: () => Promise<WindowInfo[]>
    focus: (id: string) => void
    minimize: () => void
    maximize: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    exitRevealLayout: () => Promise<void>
    onMaximizeChanged: (cb: (maximized: boolean) => void) => () => void
    onGpuReset: (cb: () => void) => () => void

    setWorkspaceIdentity: (identity: {
      label: string
      folderPath: string
      worktreePath: string
    }) => void

    movePanel: (args: {
      target: string | 'new'
      panel: MovedPanel
      point?: { x: number; y: number }
    }) => Promise<{ ok: boolean; reason?: string }>

    dragBegin: (label: string, origin: WorkspaceIdentity) => void
    dragEnd: () => Promise<DropTarget>
    dragAbort: () => void
    dropReleased: () => void
    onDragComplete: (cb: (target: DropTarget) => void) => () => void
    onDragActive: (cb: (active: boolean) => void) => () => void

    onDragHover: (
      cb: (e: { x: number; y: number; label: string; allowed: boolean }) => void
    ) => () => void
    onDragHoverEnd: (cb: () => void) => () => void
    onDragAbort: (cb: () => void) => () => void
    onPanelDropped: (cb: (drop: PanelDrop) => void) => () => void

    claimWorkspace: (identity: {
      folderPath: string
      worktreePath: string
    }) => Promise<{ ok: boolean }>
    moveWorkspaceToNewWindow: (workspace: MovedWorkspace) => Promise<string>
    moveWorkspaceToWindow: (
      targetId: string,
      workspace: MovedWorkspace
    ) => Promise<MoveWorkspaceResult>
    onWorkspaceDropped: (cb: (workspace: MovedWorkspace) => void) => () => void
    closeWorkspaceWindows: (identity: { folderPath: string; worktreePath: string }) => void
  }
  pty: {
    spawn: (args: PtySpawnArgs) => Promise<PtySpawnResult>
    listShells: () => Promise<string[]>
    info: (id: string) => Promise<PtyHoverInfo>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    kill: (id: string) => Promise<boolean>
    ackData: (id: string, charCount: number) => void
    restartDaemon: () => Promise<{ killedCount: number }>
    onData: (cb: (event: PtyDataEvent) => void) => () => void
    onExit: (cb: (event: PtyExitEvent) => void) => () => void
    onAgentHook: (cb: (event: AgentHookEvent) => void) => () => void
    agentStates: () => Promise<AgentHookEvent[]>
    reportAgentPanes: (panes: AgentPaneReport[]) => void
    onFocusAgent: (cb: (event: { id: string }) => void) => () => void
    onClaudeSession: (cb: (event: ClaudeSessionEvent) => void) => () => void
    onSizeOwner: (cb: (event: { id: string; owner: 'desktop' | 'phone'; cols: number | null; rows: number | null }) => void) => () => void
  }
  unity: {
    start: (args: UnityStartArgs) => Promise<UnityStartResult>
    stop: (id: string) => Promise<boolean>
    release: (projectPath: string) => Promise<void>
    restart: (id: string) => Promise<UnityStartResult>
    stopProject: (projectPath: string) => Promise<{ ok: boolean; error?: string }>
    refresh: (id: string) => void
    revealEditor: (projectPath: string, opts?: { split?: boolean }) => Promise<{ ok: boolean; error?: string }>
    hideEditor: (
      projectPath: string,
      opts?: { force?: boolean }
    ) => Promise<{ ok: boolean; error?: string; cancelled?: boolean }>
    isEditorRevealed: (projectPath: string) => Promise<boolean>
    onEditorRevealChanged: (cb: (event: { projectPath: string; revealed: boolean }) => void) => () => void
    stepFrame: (projectPath: string) => Promise<{ ok: boolean; error?: string }>
    getMode: (projectPath: string) => Promise<UnityMode>
    setMode: (projectPath: string, mode: UnityMode) => Promise<UnityStartResult>
    closeExternalEditor: (
      projectPath: string,
      force?: boolean
    ) => Promise<{ ok: boolean; error?: string }>
    isHubInstalled: () => Promise<boolean>
    listEditorsForCreate: () => Promise<{ editors: UnityEditorForCreate[]; home: string }>
    checkNewProject: (parent: string, name: string) => Promise<string | null>
    createProject: (args: NewProjectArgs) => Promise<NewProjectResult>
    cancelCreateProject: () => void
    onCreateProgress: (cb: (e: NewProjectProgress) => void) => () => void
    openHub: () => Promise<{ ok: boolean; error?: string }>
    hubState: () => Promise<HubState>
    startHub: () => Promise<{ ok: boolean; error?: string }>
    lifecycle: (projectPath: string) => Promise<UnityLifecycle>
    retry: (projectPath: string) => Promise<{ ok: boolean; error?: string; note?: string; life: UnityLifecycle; history: UnityStateTransition[] }>
    cancel: (projectPath: string) => Promise<{ ok: boolean; error?: string; note?: string; life: UnityLifecycle; history: UnityStateTransition[] }>
    answerDialog: (projectPath: string, id: string, button: string) => Promise<{ ok: boolean; error?: string; note?: string; life: UnityLifecycle }>
    watchLifecycle: (projectPath: string) => Promise<UnityLifecycle>
    unwatchLifecycle: (projectPath: string) => void
    onLifecycle: (cb: (life: UnityLifecycle) => void) => () => void
    installEditor: (projectPath: string) => Promise<{ ok: boolean; error?: string }>
    setHotReload: (id: string, enabled: boolean) => void
    setDesired: (projectPath: string, patch: DeepPartial<WorldDesired>) => void
    getWorld: (projectPath: string) => Promise<{ observed: WorldObserved; desired: WorldDesired }>
    onWorld: (cb: (event: UnityWorldEvent) => void) => () => void
    isProject: (projectPath: string) => Promise<boolean>
    ensureProjectEnv: (projectPath: string) => Promise<void>
    getRecentScenes: (projectPath: string) => Promise<string[]>
    setLastScene: (projectPath: string, scene: string) => void
    removeRecentScene: (projectPath: string, scene: string) => void
    getConsolePrefs: (projectPath: string) => Promise<UnityConsolePrefs | null>
    setConsolePrefs: (projectPath: string, prefs: UnityConsolePrefs) => void
    getRemotePrefs: (projectPath: string) => Promise<RemotePrefs>
    setRemotePrefs: (projectPath: string, prefs: RemotePrefs) => Promise<RemotePrefs>
    getStreamResolutions: (projectPath: string) => Promise<SavedStreamResolution[]>
    setStreamResolutions: (
      projectPath: string,
      resolutions: SavedStreamResolution[]
    ) => Promise<SavedStreamResolution[]>
    sendInput: (id: string, json: string) => void
    ping: (id: string, pingId: number) => void
    markLive: (id: string) => void
    viewHint: (id: string, hint: UnityViewHint) => void
    dropShared: (id: string) => void
    sharedStats: () => { sessions: number; slots: number; early: number; stale: number; retired: number }
    onSharedFrame: (cb: (id: string, dt: number) => void) => () => void
    onSharedError: (cb: (event: UnitySharedErrorEvent) => void) => () => void
    onInputGate: (cb: (event: { projectPath: string; problem: InputGateProblem }) => void) => () => void
    onAgentFeedback: (cb: (event: UnityAgentFeedbackEvent) => void) => () => void
    onPong: (cb: (event: UnityPongEvent) => void) => () => void
    onCursor: (cb: (event: UnityCursorEvent) => void) => () => void
    onVideo: (cb: (event: UnityVideoEvent) => void) => () => void
    mouseDeltaAvailable: () => Promise<boolean>
    onMouseDelta: (cb: (event: UnityMouseDeltaEvent) => void) => () => void
    setPointerLocked: (id: string, locked: boolean) => void

    instanceDir: (projectPath: string, worldId: string) => Promise<string | null>
    addPlayer: (
      projectPath: string
    ) => Promise<{ ok: boolean; cloneId?: string; vpId?: string; error?: string }>
    removePlayer: (projectPath: string, cloneId: string) => Promise<{ ok: boolean; error?: string }>
    players: (projectPath: string) => Promise<PlayerInfo[]>
    subscribeLog: (projectPath: string) => Promise<UnityLogLine[]>
    unsubscribeLog: (projectPath: string) => void
    onLog: (cb: (event: UnityLogEvent) => void) => () => void
  }
  tuner: TunerApi
  tunerInspector: TunerInspectorApi
  tunerPopup: TunerPopupApi
  scratchpads: {
    attach: (projectPath: string) => Promise<boolean>
    list: (projectPath: string) => Promise<ScratchpadResult<ScratchpadInfo[]>>
    create: (projectPath: string, name?: string) => Promise<ScratchpadResult<ScratchpadInfo>>
    rename: (projectPath: string, id: string, name: string) => Promise<ScratchpadResult<ScratchpadInfo>>
    start: (projectPath: string, id: string) => Promise<ScratchpadResult<ScratchpadInfo>>
    stop: (projectPath: string, id: string) => Promise<ScratchpadResult<ScratchpadInfo>>
    restart: (projectPath: string, id: string) => Promise<ScratchpadResult<ScratchpadInfo>>
    remove: (projectPath: string, id: string) => Promise<ScratchpadResult<null>>
    stopAll: (projectPath: string) => Promise<ScratchpadResult<number>>
    setPanels: (projectPaths: string[]) => void
    onChanged: (cb: (e: { projectPath: string }) => void) => () => void
    onOpenPanel: (cb: (e: { projectPath: string; id: string }) => void) => () => void
  }
  agentExec: {
    onRequest: (handler: ExecRendererHandler) => () => void
    tell: (paneKey: string, text: string, wait?: boolean) => Promise<AgentTellResult>
  }
  remote: {
    status: () => Promise<RemoteStatus>
    newPairCode: () => Promise<string | null>
    pairInfo: () => Promise<RemotePairInfo | null>
    setEnabled: (on: boolean) => Promise<RemoteStatus>
    usage: () => Promise<RemoteAccountUsage>
    onPhones: (cb: (status: RemoteStatus) => void) => () => void
    pairedPhones: () => Promise<RemotePairedPhone[]>
    onPairedPhones: (cb: (list: RemotePairedPhone[]) => void) => () => void
    forgetPhone: (phoneId: string) => Promise<RemoteForgetResult>
    forgetAllPhones: () => Promise<RemoteForgetResult>
    newKeys: () => Promise<RemoteForgetResult>
    pairAsks: () => Promise<RemotePairAsk[]>
    onPairAsk: (cb: (ask: RemotePairAsk) => void) => () => void
    onPairAskDone: (cb: (done: { id: string }) => void) => () => void
    answerPair: (id: string, allow: boolean) => Promise<RemotePairAnswer>
    presence: () => Promise<RemotePresence[]>
    onPresence: (cb: (list: RemotePresence[]) => void) => () => void
    phonePanel: () => Promise<PhonePanel>
    onPhonePanel: (cb: (panel: PhonePanel) => void) => () => void
    onStoreAction: (cb: (req: RemoteStoreActionRequest) => void) => () => void
    storeActionDone: (reqId: number, error?: string, value?: unknown) => void
    setRestorePrompts: (list: ClaudeRestorePromptState[]) => void
  }
  remoteVideo: {
    signal: (msg: RvSignal) => void
    onSignal: (cb: (msg: RvSignal) => void) => () => void
  }
  dashboard: DashboardApi
}

declare global {
  interface Window {
    api: PreloadApi
  }
}
