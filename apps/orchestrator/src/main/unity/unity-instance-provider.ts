import { tunerHandedOff } from '../remote/push-events'
import dgram from 'node:dgram'
import { spawn, spawnSync, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  rmSync,
  renameSync,
  statSync,
  readdirSync,
  copyFileSync,
  symlinkSync,
  openSync,
  closeSync,
  watch,
  type FSWatcher
} from 'node:fs'
import { readdir as readdirAsync, cp, mkdir, rm, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { UnityStartResult, PlayerInfo, UnityCursorImage } from '@shared/api'
import { trackEditorStatus } from './launch-progress'
import { scanLogForCrash, watchEditor, type EditorCrash } from './editor-watchdog'
import { createServer, type Server } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { NdjsonParser, encodeMessage, helloToken } from '@shared/control-protocol'
import { newSecretToken, tokenMatches, writePrivateFile } from '../secret-token'
import { primaryWorldId } from '@shared/unity/ids'
import {
  COMMAND_ACK_FILE,
  COMMAND_LOG_FILE,
  FEEDBACK_FILE,
  TRANSIENT_COMMAND_KINDS,
  WORLD_SNAPSHOT_FILE,
  type CommandKind
} from '@shared/unity/protocol'
import { DEFAULT_STREAM_RES, TRANSITIONAL_LIFECYCLES, type EditorFaultKind, type InstanceObserved, type Lifecycle, type UnityMode } from '@shared/unity/world'
import { DEFAULT_PANE, MAX_STREAM_DIM, MIN_STREAM_DIM, formatSize, normalizeStreamRes, streamSizeFor, type PixelSize } from '@shared/unity/stream-size'
import { removeCodexMcpServer, upsertCodexMcpServer } from '@shared/unity/codex-mcp-config'
import { app, BrowserWindow } from 'electron'
import { UnityControlClient, setEditorControlToken } from './unity-control-client'
import { resolveResource, repoPackagePath } from '../bundled-resources'
import { pinExeToHighPerfGpu } from '../win-gpu-affinity'
import { worldStore } from './world-store'
import { openFileInApp } from '../window/open-file-in-app'
import { awaitTunerMissing, openTunerInApp, type TunerMissingTarget } from './tuner-open'
import { isTunerViewName } from '@shared/tuner'
import { readLastScene, writeObservedScene } from './project-scene-state'
import { readUnityModePref, writeUnityModePref } from './project-prefs'
import { Reconciler } from './reconciler'
import { FileChannel } from './transport/file-channel'
import { SocketChannel } from './transport/socket-channel'
import { AssetRefreshWatcher, changedSince } from './asset-refresh-watch'
import { ProjectDirtyTracker } from './project-dirty-tracker'
import { unityLogTailers } from './unity-log-tailer'
import { classifyHotReloadLine, STARTED_SUPPRESS_MS } from './hot-reload-log'
import { withMonoInlineDisabled } from './mono-env'
import { syncTreeIncremental } from './engine-sync'
import { enginePluginKeep, syncEnginePlugins } from '../plugins/engine'
import { EDITOR_QUIT_TIMINGS, describeQuit, quitEditor } from './editor-quit'
import { ProjectStops } from './project-stops'
import { SURFACE_PACKET, parseSurfacePacket, presentSurface, releaseHeld, resendSurface, launchWithHook, assignToKillJob, setJobKillOnClose } from './shared-surface'
import { HoldBook, StreamGate } from '@shared/unity/stream-state'
import { videoRecorder, type VideoArgs } from './video-recorder'
import { remoteVideo } from '../remote-video'
import { consumeUpdateHandoff, writeUpdateHandoff, type HandoffInstance } from '../update-handoff'
import type { RevealBounds } from '../window/reveal-layout'
import { ensureProjectSspaceSync } from '../sspace'
import { MCP_LOGS_DIR, clearProjectState, guardSspace } from './sspace-state'
import { removeCloneDirSafely } from './clone-dir'
import { atomicWriteFileSync, readJsonForUpdateSync } from '../safe-fs'
import { materializeRuntime, pruneRuntimes, runtimeDirFor, runtimePathFor, runtimeRootFor } from './unity-runtime'
import { clonePidsUnder, listUnityProcesses, listUnityProcessesSync, pidRunsPath } from './unity-process-match'
import { devInstanceName, devInstancePortBase, devInstanceProjectConflict, sharedConfigOwner } from '../dev-instance'
import { EventEmitter } from 'node:events'
import { hubBlockMessage, hubState } from './unity-hub'
import { editorBinary, editorVersionFacts, readProjectVersion, unityExecutableFor, unityHubEditorRoot } from './editor-install'
import { unityLifecycle } from './lifecycle'
import { dialogButtonLabel, dialogText, lifecycleText, missingError, missingNext, stateLabel, type EditorInstanceFacts, type UnityFailCode, type UnityLifecycle, type UnityStateTransition } from '@shared/unity/lifecycle'
import { answerDialog, openDialogs } from './modal-dialogs'
import { inputGateCheck } from './input-gate'
import { ensureSaturaDefine, hideSaturaFiles, removeSaturaLeftovers } from './project-side'
import { logSizeOf, relevantLogLines, type EditorWaitState } from './editor-wait-state'
import { BoundedMap } from '@shared/bounded-map'
import { censusTrack } from '@shared/census'
import { debugLog } from '@shared/debug-log'

const TUNER_OPEN_WAIT_MS = 8000
const REFRESH_MTIME_SLACK_MS = 2000

const execFileAsync = promisify(execFile)

const ENGINE_PKG_NAME = 'com.saturaspace.engine'

export type ScratchpadCommandHandler = (
  args: Record<string, unknown>
) => Promise<{ ok: boolean; error?: string | null } & Record<string, unknown>>

function engineSource(): string {
  return app.isPackaged ? resolveResource('engine') : repoPackagePath('saturaspace-engine')
}
function comparablePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
function readPkgVersion(pkgJsonPath: string): string | null {
  try {
    return (JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version?: string }).version ?? null
  } catch {
    return null
  }
}
const ENGINE_STAMP_FILE = '.satura-engine.json'
const APP_STAMP_FILE = '.satura-app.json'

function appChannel(): string {
  return app.isPackaged ? 'prod' : 'dev'
}
function appVersion(): string {
  return readPkgVersion(join(engineSource(), 'package.json')) ?? app.getVersion()
}
function engineBuildId(): string {
  return `${appChannel()}@${appVersion()}`
}
function readEngineStamp(dest: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dest, ENGINE_STAMP_FILE), 'utf8')) as { buildId?: string })
      .buildId ?? null
  } catch {
    return null
  }
}
function writeEngineStamp(dir: string, buildId: string): void {
  atomicWriteFileSync(join(dir, ENGINE_STAMP_FILE), JSON.stringify({ buildId }) + '\n')
}

type JsonObject = Record<string, unknown>

function readJsonObjectForUpdate(path: string): { state: 'missing' } | { state: 'ok'; value: JsonObject } | { state: 'invalid'; error: string } {
  const r = readJsonForUpdateSync<unknown>(path)
  if (r.state !== 'ok') return r
  const v = r.value
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { state: 'invalid', error: 'the top level is not a JSON object' }
  return { state: 'ok', value: v as JsonObject }
}

function leftUntouched(path: string, error: string, what: string): void {
  console.error(`[unity] ${path} is not valid JSON (${error.replace(/\s+/g, ' ').trim()}); left it untouched, so ${what}. Fix the file and reopen the project.`)
}
async function syncEngineInPlace(src: string, dest: string): Promise<boolean> {
  try {
    const r = await syncTreeIncremental(src, dest, [ENGINE_STAMP_FILE, ...enginePluginKeep()])
    const plugins = await syncEnginePlugins(src, dest)
    const changed = [...r.copied, ...r.removed, ...plugins]
    console.log(
      `[unity] engine ${ENGINE_PKG_NAME} in-place sync → ${dest}: ${changed.length ? `${r.copied.length + plugins.length} updated, ${r.removed.length} removed (${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ', …' : ''})` : 'unchanged'}`
    )
    return true
  } catch (e) {
    console.log(`[unity] engine in-place sync failed, doing a full sync: ${(e as Error).message}`)
    return false
  }
}
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (e) {
      if (attempt >= 4) throw e
      await delay(150 * attempt)
    }
  }
}

const MCP_SERVER_NAME = 'satura-space'
const RETIRED_MCP_SERVER_NAME = 'satura-space-assets'

let unityRuntimeDir: string | null = null
let unityRuntimePrep: Promise<void> | null = null

function usesIsolatedUnityRuntime(): boolean {
  return app.isPackaged && process.platform === 'win32'
}

function ensureUnityRuntime(): Promise<void> {
  if (!usesIsolatedUnityRuntime()) return Promise.resolve()
  if (!unityRuntimePrep)
    unityRuntimePrep = (async () => {
      const userData = app.getPath('userData')
      const dir = runtimeDirFor(userData, app.getVersion())
      try {
        await materializeRuntime(dir, resolveResource)
        unityRuntimeDir = dir
        console.log(`[unity] runtime copy of the window hook and MCP server ready at ${dir}`)
      } catch (e) {
        console.error(`[unity] could not prepare the runtime copy at ${dir}, using the installed files: ${(e as Error).message}`)
        return
      }
      const pruned = pruneRuntimes(runtimeRootFor(userData), app.getVersion())
      if (pruned.length) console.log(`[unity] removed unused runtime copies: ${pruned.join(', ')}`)
    })()
  return unityRuntimePrep
}

function unityRuntimePath(...segments: string[]): string {
  return runtimePathFor(usesIsolatedUnityRuntime() ? unityRuntimeDir : null, resolveResource, segments)
}

function mcpServerCommand(): { command: string; args: string[] } {
  if (app.isPackaged) {
    const exe = process.platform === 'win32' ? 'satura-space-mcp.exe' : 'satura-space-mcp'
    return { command: unityRuntimePath('mcp', exe), args: [] }
  }
  const mcpDir = repoPackagePath('mcp')
  const venvPython =
    process.platform === 'win32'
      ? join(mcpDir, '.venv', 'Scripts', 'python.exe')
      : join(mcpDir, '.venv', 'bin', 'python')
  return { command: venvPython, args: [join(mcpDir, 'server.py')] }
}

const PORT_BASE = app.isPackaged ? 9210 : devInstanceName() ? devInstancePortBase(devInstanceName()) : 10210
const CONTROL_PORT_OFFSET = 600
const CONTROL_HELLO_MS = 5000
const CONTROL_HELLO_MAX = 4096
const PORT_SCAN_LIMIT = 128

function portFreeTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      srv.close(() => resolve(true))
    })
  })
}

function portFreeUdp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    sock.once('error', () => resolve(false))
    try {
      sock.bind({ port, address: '127.0.0.1', exclusive: true }, () => {
        sock.close(() => resolve(true))
      })
    } catch {
      resolve(false)
    }
  })
}
const STREAM_REASSERT_MS = 2000
const CRASH_EXIT_GRACE_MS = 3000
const STREAM_RES_SETTLE_MS = 400
const SCENE = 'Assets/Scenes/Prototype.unity'

const CLONE_SEP = '::'
function cloneIndexOf(cloneId: string | undefined): number {
  return Number(cloneId?.split(CLONE_SEP)[1]) || 1
}
let frameSeq = 0
const MAX_PLAYERS = 4
const MAX_CLONE_LAUNCH_RETRIES = 2
const WINHOOK = process.platform === 'darwin' ? resolveResource('winhook', 'winhook.dylib') : null
function winhookEnv(): NodeJS.ProcessEnv {
  if (process.env.SATURA_DISABLE_WINHOOK === '1') return {}
  if (!WINHOOK) return {}
  return { DYLD_INSERT_LIBRARIES: WINHOOK }
}
function winHookDll(): string | null {
  return process.platform === 'win32' ? unityRuntimePath('winhook', 'unityhook.dll') : null
}

const MODAL_STATUS_FILE = '.modal_status.json'
const MODAL_CMD_FILE = '.modal_cmd.json'
function modalFilesEnv(instanceDir: string): NodeJS.ProcessEnv {
  return {
    SATURA_MODAL_STATUS_FILE: sf(instanceDir, MODAL_STATUS_FILE),
    SATURA_MODAL_CMD_FILE: sf(instanceDir, MODAL_CMD_FILE)
  }
}
function clearModalFiles(instanceDir: string): void {
  rmSafe(sf(instanceDir, MODAL_STATUS_FILE))
  rmSafe(sf(instanceDir, `${MODAL_STATUS_FILE}.tmp`))
  rmSafe(sf(instanceDir, MODAL_CMD_FILE))
  rmSafe(sf(instanceDir, `${MODAL_CMD_FILE}.tmp`))
}

export { unityHubEditorRoot, unityExecutableFor }

function forceGraphicsApiArgs(): string[] {
  return process.platform === 'win32' ? ['-force-d3d11'] : []
}

function cloneWindowArgs(): string[] {
  return process.platform === 'win32' ? [] : ['-noMainWindow']
}

function winEnvBlock(env: NodeJS.ProcessEnv): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    parts.push(`${k}=${v}`)
  }
  return parts.join('\0') + '\0\0'
}

class HookedProc extends EventEmitter {
  pid: number
  private timer: ReturnType<typeof setInterval> | null
  constructor(pid: number) {
    super()
    this.pid = pid
    this.timer = setInterval(() => {
      let alive = true
      try {
        process.kill(pid, 0)
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === 'EPERM'
      }
      if (!alive) {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        this.emit('exit', 0, null)
      }
    }, 500)
    if (this.timer.unref) this.timer.unref()
  }
  kill(_signal?: NodeJS.Signals | number): boolean {
    try {
      process.kill(this.pid, 'SIGKILL')
      return true
    } catch {
      return false
    }
  }
  unref(): void {}
}

const SCENE_RESULTS = '.mcp_scene_results.json'
const STOP_RESULTS = '.mcp_stopplay_results.json'
const REFRESH_RESULTS = '.mcp_refresh_results.json'
const STATUS_FILE = '.mcp_status.json'
const QUEUE_FILES = [COMMAND_LOG_FILE, COMMAND_ACK_FILE, WORLD_SNAPSHOT_FILE]
const PLAYERS_COMMAND_FILE = '.mcp_players_command.json'
const PLAYERS_RESULT_FILE = '.mcp_players_result.json'
const MPPM_LINKS_FILE = '.mppm_clone_links.json'
const ORCHESTRATOR_FILE = '.mcp_orchestrator.json'
const PANE_KEY_ENV = 'SATURA_PANE_KEY'

export function syncCodexMcpConfig(codexHome: string): 'written' | 'unchanged' | 'failed' {
  try {
    const { command, args } = mcpServerCommand()
    const configPath = join(codexHome, 'config.toml')
    let content = ''
    try {
      content = readFileSync(configPath, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[unity] could not read ${configPath} (${(e as Error).message}); left it untouched`)
        return 'failed'
      }
    }
    const next = upsertCodexMcpServer(
      removeCodexMcpServer(content, RETIRED_MCP_SERVER_NAME),
      MCP_SERVER_NAME,
      command,
      args,
      [PANE_KEY_ENV]
    )
    if (next === content) return 'unchanged'
    mkdirSync(codexHome, { recursive: true })
    atomicWriteFileSync(configPath, next)
    console.log(`[unity] registered MCP server '${MCP_SERVER_NAME}' in ${configPath}`)
    return 'written'
  } catch (e) {
    console.error(`[unity] ensureCodexMcpConfig failed: ${(e as Error).message}`)
    return 'failed'
  }
}

const HOOKS_ENDPOINT_ENV = 'SATURA_AGENT_HOOKS_ENDPOINT'
const OPEN_EDITOR_REQUEST_FILE = '.open_editor_request.json'
const OPEN_EDITOR_REQUEST_TTL_MS = 15000
const COMMAND_POLL_MS = 300
const COMMAND_WATCHED_POLL_MS = 1000
const RESULT_FILES = [SCENE_RESULTS, STOP_RESULTS, REFRESH_RESULTS]

const SSPACE = '.sspace'
const sf = (root: string, ...rest: string[]): string => join(root, SSPACE, ...rest)

function appBundlePath(): string {
  const exe = process.execPath
  if (process.platform === 'darwin') {
    const i = exe.indexOf('.app/')
    if (i !== -1) return exe.slice(0, i + 4)
  }
  return exe
}

const CONSOLE_LOG_BACKUPS = 5

function consoleLogPath(sspaceDir: string): string {
  return join(sspaceDir, MCP_LOGS_DIR, 'console.log')
}

function rotateConsoleLog(sspaceDir: string): void {
  const base = consoleLogPath(sspaceDir)
  const backup = (n: number): string => join(sspaceDir, '.mcp_logs', `console.prev${n}.log`)
  try {
    if (!existsSync(base)) return
    let size = 0
    try {
      size = statSync(base).size
    } catch {}
    if (size === 0) return
    try {
      rmSync(backup(CONSOLE_LOG_BACKUPS), { force: true })
    } catch {}
    for (let n = CONSOLE_LOG_BACKUPS - 1; n >= 1; n--) {
      if (existsSync(backup(n))) {
        try {
          renameSync(backup(n), backup(n + 1))
        } catch {}
      }
    }
    renameSync(base, backup(1))
  } catch (e) {
    console.log(`[unity] could not rotate console log: ${(e as Error).message}`)
  }
}

function resetRunLogs(rawLogPath: string): void {
  const ss = dirname(rawLogPath)
  const instanceDir = dirname(ss)
  rotateConsoleLog(ss)
  if (existsSync(rawLogPath)) {
    try {
      writeFileSync(rawLogPath, '')
    } catch (e) {
      console.log(`[unity] could not reset ${rawLogPath}: ${(e as Error).message}`)
    }
  }
  unityLogTailers.reset(instanceDir)
}

type Sink = (wcId: number, channel: string, payload: unknown) => void

interface ViewHint {
  visible: boolean
  width: number
  height: number
}

interface Instance {

  cursorImage?: UnityCursorImage
  cursorState?: { locked: boolean; visible: boolean }
  projectPath: string
  realProjectPath: string
  kind: 'primary' | 'clone'
  primaryId?: string
  cloneId?: string
  mediaPort: number
  inputPort: number
  controlPort: number
  controlToken: string
  recv: dgram.Socket
  send: dgram.Socket
  proc: ChildProcess | HookedProc | null
  logPath: string
  subscribers: Map<string, number>
  viewHints: Map<string, ViewHint>
  baseRes: string
  fpsCap: number
  pane: PixelSize
  streamSig: string
  streamPushTimer: NodeJS.Timeout | null
  resCandidate: string
  resCandidateAt: number
  revealEpoch: number
  revealed: boolean
  hidePending: Promise<{ ok: boolean; error?: string; cancelled?: boolean }> | null
  hookInjectFailed: boolean
  unityMode: UnityMode
  live: boolean
  streamPushedForPlay: boolean
  observedPlaying: boolean
  exited: boolean
  exitCode: number | null
  exitSignal: string | null
  safeMode: boolean
  stuck: boolean
  fault: { kind: EditorFaultKind; reason: string; line: number } | null
  watchdogStop: (() => void) | null

  editModeReady: boolean
  sawEditor: boolean
  bootCompileErrors: number
  bootCompileFirst: string
  restarting: boolean
  disposed: boolean
  failed: boolean
  commandWatcher: FSWatcher | null
  assetWatcher: AssetRefreshWatcher | null
  hotReloadLogSub: (() => void) | null
  hotReloadTerminalAt: number
  launchProgressStop: (() => void) | null

  worldId: string
  channel: FileChannel | null
  socketChannel: SocketChannel | null
  worldWatchStop: (() => void) | null
  lastFeedbackSeq: number
  gate: StreamGate
  holds: HoldBook
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const HANDOFF_CLAIM_MS = 60_000

export const UNITY_QUIT_TIMINGS = { launchSettleMs: 4000, graceMs: 8000, killWaitMs: 3000 }

export function unityQuitBudgetMs(): number {
  return Math.max(UNITY_QUIT_TIMINGS.graceMs, UNITY_QUIT_TIMINGS.launchSettleMs) + UNITY_QUIT_TIMINGS.killWaitMs
}

const rmSafe = (p: string): void => {
  try {
    rmSync(p, { force: true })
  } catch {
  }
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const LSOF_TIMEOUT_MS = 2000
const LSOF_RETRY_TIMEOUT_MS = 6000

const isProjectLockedLive = async (projectPath: string): Promise<boolean> => {
  const lock = join(projectPath, 'Temp', 'UnityLockfile')
  if (!existsSync(lock)) return false
  if (process.platform === 'win32') {
    try {
      const fd = openSync(lock, 'r+')
      closeSync(fd)
      return false
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return true
      return false
    }
  }
  const first = await lsofHolders(lock, LSOF_TIMEOUT_MS)
  if (first !== 'timeout') return first
  const second = await lsofHolders(lock, LSOF_RETRY_TIMEOUT_MS)
  const locked = second !== false
  console.log(
    `[unity] lsof on ${lock} timed out after ${LSOF_TIMEOUT_MS}ms; ${second === 'timeout' ? `the ${LSOF_RETRY_TIMEOUT_MS}ms retry timed out too, treating it as locked` : `retry says ${locked ? 'locked' : 'not locked'}`}`
  )
  return locked
}

async function lsofHolders(lock: string, timeout: number): Promise<boolean | 'timeout'> {
  try {
    const r = await execFileAsync('lsof', ['-t', lock], { encoding: 'utf8', timeout })
    return r.stdout.trim().length > 0
  } catch (e) {
    const err = e as { code?: unknown; killed?: boolean; stdout?: unknown }
    if (typeof err.code === 'number' && !err.killed)
      return typeof err.stdout === 'string' && err.stdout.trim().length > 0
    return 'timeout'
  }
}

const STOPPED_ERROR = 'Unity is stopped. Relaunch it from the Player menu.'
const STOPPED_RESULT: UnityStartResult = { ok: false, stopped: true, error: STOPPED_ERROR }
const STOPPED_COMMAND_ERROR =
  'Unity is stopped in Satura Space. Start it again first (unity.relaunch(), or Relaunch in the Player menu).'
const FPS_CAP_FILE = 'fps-cap'
const ALLOWED_WHILE_STOPPED = new Set(['status', 'relaunch', 'stop_editor', 'open_tuner'])
const AUDIO_PACKET = 0x41

async function hubBlock(what: string): Promise<UnityStartResult | null> {
  const state = await hubState()
  unityLifecycle.noteHub(state)
  if (state === 'ready') return null
  console.log(`[unity] ${what} refused: Unity Hub is ${state}`)
  return { ok: false, hub: state, error: hubBlockMessage(state) }
}

async function requireHub(what: string): Promise<void> {
  const blocked = await hubBlock(what)
  if (blocked) throw new LaunchFailure(blocked)
}

function missingEditor(projectPath: string, what: string): UnityStartResult | null {
  const v = editorVersionFacts(projectPath)
  if (!v.version || v.installed) return null
  console.log(`[unity] ${what} waits: ${projectPath} needs Unity ${v.version}, ${v.install ? `which Unity Hub is ${v.install.state === 'installing' ? 'installing' : 'downloading'}` : "which isn't installed"}`)
  const error = v.install
    ? `Unity Hub is installing Unity ${v.version}, which this project needs. The editor starts when the install finishes.`
    : `${missingError(v.version, v.editors)} ${missingNext(v.version)}`
  return { ok: false, missing: v.version, error, code: 'version-missing' }
}

function requireEditor(projectPath: string, what: string): string {
  const blocked = missingEditor(projectPath, what)
  if (blocked) throw new LaunchFailure(blocked)
  const { version } = readProjectVersion(projectPath)
  const editor = editorBinary(version)
  if (!editor) throw new LaunchFailure({ ok: false, code: 'project', error: 'Could not read the Unity version from ProjectSettings/ProjectVersion.txt' })
  return editor
}

class LaunchFailure extends Error {
  result: UnityStartResult
  constructor(result: UnityStartResult) {
    super(typeof result.error === 'string' ? result.error : 'Unity launch failed')
    this.result = result
  }
}

const inputGateRefused = new Map<string, string>()

function cut<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(new LaunchFailure(STOPPED_RESULT))
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(new LaunchFailure(STOPPED_RESULT))
    signal.addEventListener('abort', stop, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

function inputGateRefusal(projectPath: string, what: string): UnityStartResult | null {
  const gate = inputGateCheck(projectPath)
  if (!gate) {
    inputGateRefused.delete(projectPath)
    return null
  }
  inputGateRefused.set(projectPath, gate.message)
  const { handler, packageMissing } = gate.problem
  console.log(
    `[unity] input gate refused ${what} for ${projectPath}: activeInputHandler=${handler} inputSystemPackage=${packageMissing ? 'missing' : 'present'}`
  )
  return { ok: false, error: gate.message, inputGate: gate.problem, code: 'input-system' }
}

function blockedOf(result: UnityStartResult, fallback: string): { kind: 'refused' | 'failed'; error: string; code: UnityFailCode } {
  const code: UnityFailCode = result.code ?? (result.standalone ? 'locked' : result.inputGate ? 'input-system' : 'error')
  return { kind: result.standalone || result.inputGate || code === 'guard' ? 'refused' : 'failed', error: result.error ?? fallback, code }
}

function requireInputSystem(projectPath: string, what: string): void {
  const refused = inputGateRefusal(projectPath, what)
  if (!refused) return
  if (what !== 'launch clone')
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send('unity:inputGate', { projectPath, problem: refused.inputGate })
  throw new LaunchFailure(refused)
}

class UnityInstanceProvider {
  private instances = censusTrack('unity-instance-provider.instances', new Map<string, Instance>())
  private projectEnvPromises = censusTrack('unity-instance-provider.projectEnvPromises', new Map<string, Promise<void>>())
  private launching = censusTrack('unity-instance-provider.launching', new Map<string, Promise<Instance>>())
  private launchAborts = censusTrack('unity-instance-provider.launchAborts', new Map<string, AbortController>())
  private cancelling = censusTrack('unity-instance-provider.cancelling', new Set<string>())
  private subIndex = censusTrack('unity-instance-provider.subIndex', new Map<string, string>())
  private lastPane = censusTrack('unity-instance-provider.lastPane', new Map<string, PixelSize>())
  private byWorldId = censusTrack('unity-instance-provider.byWorldId', new Map<string, Instance>())
  private cursorListeners = new Set<(worldId: string, state: { locked: boolean; visible: boolean }) => void>()
  private cloneFailCount = censusTrack('unity-instance-provider.cloneFailCount', new Map<string, number>())
  private mppmLinks = censusTrack('unity-instance-provider.mppmLinks', new Map<string, Map<string, number>>())
  private tearingDown = censusTrack('unity-instance-provider.tearingDown', new Map<string, Set<string>>())
  private stops = new ProjectStops(
    worldStore,
    (m) => console.log(m),
    (pp) => this.syncStoppedMarker(pp)
  )
  private stopping = censusTrack('unity-instance-provider.stopping', new Map<string, Promise<{ ok: boolean; error?: string }>>())
  private videoOverrides = censusTrack('unity-instance-provider.videoOverrides', new Map<string, string>())
  private mcpControlServer: Server | null = null
  private startWaiting = censusTrack('unity-instance-provider.startWaiting', new Map<string, { ids: Map<string, number>; error: string }>())
  private relaunchPending = censusTrack('unity-instance-provider.relaunchPending', new Set<string>())
  private launchCount = censusTrack('unity-instance-provider.launchCount', new Map<string, number>())
  private launchedVersion = censusTrack('unity-instance-provider.launchedVersion', new Map<string, string>())
  private launchBlocked = censusTrack('unity-instance-provider.launchBlocked', new Map<string, { kind: 'refused' | 'failed'; error: string; code: UnityFailCode }>())
  private lifecycleWired = false
  private relaunchWaiter: ((projectPath: string, timeoutMs: number) => Promise<{ ok: boolean; error?: string; note?: string }>) | null = null
  private mcpControlPort = 0
  private readonly mcpControlToken = newSecretToken()
  private mcpControlReady: Promise<number> | null = null
  private scratchpadCommandHandler: ScratchpadCommandHandler | null = null
  private managedProjects = censusTrack('unity-instance-provider.managedProjects', new Set<string>())
  private commandPolls = censusTrack('unity-instance-provider.commandPolls', new Map<string, ReturnType<typeof setInterval>>())
  private lastSceneWritten = new BoundedMap<string, string>(32)
  private dirtyTrackers = censusTrack('unity-instance-provider.dirtyTrackers', new Map<string, ProjectDirtyTracker>())
  private sink: Sink = () => {}
  private reconciler!: Reconciler
  private worldInstalled = false
  private streamReassert: ReturnType<typeof setInterval> | null = null

  setSink(fn: Sink): void {
    this.sink = fn
  }

  private installVideoHooks(): void {
    remoteVideo.setConsumersChanged((worldId) => this.consumersChanged(worldId))
    videoRecorder.setHooks({
      setOverride: (worldId, res) => {
        if (res) this.videoOverrides.set(worldId, res)
        else this.videoOverrides.delete(worldId)
        const inst = this.byWorldId.get(worldId)
        if (!inst || inst.exited || inst.disposed) return
        inst.streamSig = ''
        this.pushStreamControl(inst)
      },
      audioTap: (worldId, on) => {
        const inst = this.byWorldId.get(worldId)
        if (inst) this.sendUdp(inst, Buffer.from(JSON.stringify({ audioTap: on ? 1 : 0 })))
      },
      clockLock: (worldId, fps) => {
        const inst = this.byWorldId.get(worldId)
        if (inst) this.sendUdp(inst, Buffer.from(JSON.stringify({ videoLock: fps })))
      },
      consumers: (worldId) => this.consumersChanged(worldId),
      emitState: (worldId, state) => {
        const inst = this.byWorldId.get(worldId)
        if (inst) this.emit(inst, 'unity:video', { ...state })
      }
    })
  }

  private ensureWorld(): void {
    if (!this.streamReassert) {
      this.streamReassert = setInterval(() => {
        for (const inst of this.instances.values())
          if (inst.live && !inst.exited && !inst.disposed) this.pushStreamControl(inst)
      }, STREAM_REASSERT_MS)
    }
    if (this.worldInstalled) return
    this.worldInstalled = true
    this.installVideoHooks()
    worldStore.setFanout({
      subscribers: (pp) => this.worldSubscribers(pp),
      instanceSubscribers: (iid) => this.instanceSubscribersOf(iid),
      send: (wcId, ch, p) => this.sink(wcId, ch, p)
    })
    this.reconciler = new Reconciler({
      store: worldStore,
      channelFor: (iid) => this.byWorldId.get(iid)?.channel ?? null,
      meta: (iid) => {
        const i = this.byWorldId.get(iid)
        return i
          ? {
              projectPath: i.realProjectPath,
              isPrimary: i.kind === 'primary',
              cloneId: i.kind === 'clone' ? i.cloneId : undefined
            }
          : null
      },
      process: {
        addClone: (pp) => this.addPlayer(pp),
        removeClone: (pp, cid) => this.removePlayer(pp, cid),
        restart: (iid) => this.restartByWorldId(iid),
        kill: (iid) => this.killByWorldId(iid)
      },
      applyStream: (iid, res) => {
        const inst = this.byWorldId.get(iid)
        if (inst) this.sendStreamControl(inst, res)
      }
    })
    worldStore.setRefreshGate((pp, beforePlay) => {
      const tracker = this.dirtyTrackers.get(pp)
      return !tracker || (beforePlay ? tracker.needsRefreshBeforePlay() : tracker.needsRefresh())
    })
    worldStore.onDesiredChange((pp) => {
      for (const inst of this.orderedInstances(pp)) this.syncFpsCap(inst)
      this.feedDirtyTracker(pp, 'desired')
      this.reconciler.kick(pp)
    })
    worldStore.onObservedChange((pp) => {
      this.feedDirtyTracker(pp, 'observed')
      this.reconciler.kick(pp)
      this.persistLastScene(pp)
      this.rearmStreamOnPlayExit(pp)
    })
  }

  private feedDirtyTracker(projectPath: string, phase: 'desired' | 'observed'): void {
    const tracker = this.dirtyTrackers.get(projectPath)
    if (!tracker) return
    const { observed, desired } = worldStore.getWorld(projectPath)
    const primary = Object.values(observed.instances).find((i) => i.role === 'primary')
    if (!primary) return
    if (phase === 'desired')
      tracker.onDesired(desired.instances[primary.id]?.refreshGen ?? 0, primary.refreshGen)
    else tracker.onObserved(primary.refreshGen, primary.compile)
  }

  private rearmStreamOnPlayExit(projectPath: string): void {
    const { observed } = worldStore.getWorld(projectPath)
    for (const obs of Object.values(observed.instances)) {
      const inst = this.byWorldId.get(obs.id)
      if (!inst) continue
      const playing = obs.lifecycle === 'playing' || obs.lifecycle === 'entering-play'
      const wasPlaying = inst.observedPlaying
      inst.observedPlaying = playing
      if (playing || !wasPlaying) continue
      inst.streamPushedForPlay = false
      if (inst.gate.phase === 'streaming') this.stopStream(inst, `lifecycle ${obs.lifecycle}`)
    }
  }

  private persistLastScene(projectPath: string): void {
    const { observed } = worldStore.getWorld(projectPath)
    const primary = Object.values(observed.instances).find((i) => i.role === 'primary')
    if (!primary || primary.lifecycle !== 'editmode' || !primary.scene) return
    if (this.lastSceneWritten.get(projectPath) === primary.scene) return
    this.lastSceneWritten.set(projectPath, primary.scene)
    writeObservedScene(projectPath, primary.scene)
  }

  private worldSubscribers(pp: string): Array<{ unityId: string; wcId: number }> {
    const out: Array<{ unityId: string; wcId: number }> = []
    const seen = new Set<string>()
    const add = (unityId: string, wcId: number): void => {
      const k = `${unityId}:${wcId}`
      if (!seen.has(k)) {
        seen.add(k)
        out.push({ unityId, wcId })
      }
    }
    for (const i of this.instances.values()) {
      if (i.realProjectPath !== pp) continue
      for (const [unityId, wcId] of i.subscribers) add(unityId, wcId)
    }
    for (const [unityId, wcId] of this.stops.subscribers(pp)) add(unityId, wcId)
    return out
  }

  private instanceSubscribersOf(worldId: string): Array<{ unityId: string; wcId: number }> {
    const i = this.byWorldId.get(worldId)
    if (!i) return []
    return [...i.subscribers].map(([unityId, wcId]) => ({ unityId, wcId }))
  }

  private snapshotState(inst: Instance): 'streaming' | 'launching' | 'editmode' {
    if (inst.live) return 'streaming'
    if (inst.editModeReady) return 'editmode'
    const lc = worldStore.getWorld(inst.realProjectPath).observed.instances[inst.worldId]?.lifecycle
    if (lc && lc !== 'init' && lc !== 'launching' && lc !== 'restarting' && lc !== 'exited' && lc !== 'error')
      return 'editmode'
    return 'launching'
  }

  private currentScene(realProjectPath: string, fallback: string): string {
    const w = worldStore.getWorld(realProjectPath)
    const primary = Object.values(w.observed.instances).find((i) => i.role === 'primary')
    const desiredScene = primary ? w.desired.instances[primary.id]?.scene : undefined
    return primary?.scene || desiredScene || fallback
  }

  resumeStopped(projectPath: string, why: string): void {
    if (!this.stops.isStopped(projectPath)) return
    console.log(`[unity] ${projectPath} was stopped; ${why} runs it again`)
    this.stops.resume(projectPath)
  }

  async start(id: string, projectPath: string, wcId: number): Promise<UnityStartResult> {
    this.ensureWorld()
    if (id.includes(CLONE_SEP)) return this.startClone(id, projectPath, wcId)
    if (!this.stops.admit(projectPath, id, wcId)) {
      console.log(`[unity] start ${id} skipped: ${projectPath} is stopped`)
      return STOPPED_RESULT
    }
    const integrityError = this.validateProjectIntegrity(projectPath)
    if (integrityError) {
      this.launchBlocked.set(projectPath, { kind: 'refused', error: integrityError, code: 'project' })
      this.markStartWaiting(projectPath, id, wcId, integrityError)
      return { ok: false, error: integrityError }
    }

    const existing = this.instances.get(projectPath)
    if (existing && !existing.exited) {
      existing.subscribers.set(id, wcId)
      resendSurface(existing.worldId, wcId, id)
      this.subIndex.set(id, projectPath)
      existing.primaryId = id
      worldStore.resyncSubscriber(projectPath, id, wcId)
      this.clearStartWaiting(projectPath, id)
      return {
        ok: true,
        mediaPort: existing.mediaPort,
        inputPort: existing.inputPort
      }
    }

    try {
      const inst = await this.acquirePrimary(projectPath)
      inst.subscribers.set(id, wcId)
      resendSurface(inst.worldId, wcId, id)
      this.subIndex.set(id, projectPath)
      inst.primaryId = id
      worldStore.resyncSubscriber(projectPath, id, wcId)
      this.clearStartWaiting(projectPath, id)
      return {
        ok: true,
        mediaPort: inst.mediaPort,
        inputPort: inst.inputPort
      }
    } catch (e) {
      const result: UnityStartResult = e instanceof LaunchFailure ? e.result : { ok: false, error: (e as Error).message }
      if (!(e instanceof LaunchFailure)) console.log(`[unity] start threw: ${(e as Error).stack ?? (e as Error).message}`)
      if (result.stopped) {
        this.stops.park(projectPath, [[id, wcId]])
        if (!this.stops.isStopped(projectPath)) worldStore.setDesired(projectPath, { stopped: true })
        console.log(`[unity] start ${id} ended: ${projectPath} was stopped while it started`)
        return result
      }
      if (!this.stops.isStopped(projectPath)) {
        if (!result.hub && !result.missing)
          this.launchBlocked.set(projectPath, blockedOf(result, 'Unity failed to start.'))
        this.markStartWaiting(projectPath, id, wcId, result.error ?? '')
      }
      return result
    }
  }

  private acquirePrimary(projectPath: string): Promise<Instance> {
    const pending = this.launching.get(projectPath)
    if (pending) return pending
    const abort = new AbortController()
    this.launchAborts.set(projectPath, abort)
    const p = this.launchPrimaryInstance(projectPath, abort.signal).catch((e: unknown) => {
      const result: UnityStartResult = e instanceof LaunchFailure ? e.result : { ok: false, error: (e as Error).message }
      if (!result.hub && !result.missing && !result.stopped && !this.stops.isStopped(projectPath)) this.launchBlocked.set(projectPath, blockedOf(result, 'Unity failed to start.'))
      throw e
    })
    this.launching.set(projectPath, p)
    unityLifecycle.refresh(projectPath)
    return p.finally(() => {
      if (this.launching.get(projectPath) === p) this.launching.delete(projectPath)
      if (this.launchAborts.get(projectPath) === abort) this.launchAborts.delete(projectPath)
      unityLifecycle.refresh(projectPath)
    })
  }

  private reclaimStale(key: string): void {
    const stale = this.instances.get(key)
    if (!stale || !stale.exited) return
    this.teardownInstanceResources(stale)
    this.instances.delete(key)
    if (this.byWorldId.get(stale.worldId) === stale) this.byWorldId.delete(stale.worldId)
  }

  private async launchPrimaryInstance(projectPath: string, signal?: AbortSignal): Promise<Instance> {
    this.launchBlocked.delete(projectPath)
    const handoff = this.loadHandoffRecords().has(projectPath)
    if (!handoff) {
      const missing = missingEditor(projectPath, 'start')
      if (missing) throw new LaunchFailure(missing)
      await cut(requireHub('start'), signal)
    }
    const conflict = await cut(devInstanceProjectConflict(projectPath, app.getPath('appData')), signal)
    if (conflict) {
      console.log(`[dev-instance] ${conflict}`)
      throw new LaunchFailure({ ok: false, error: conflict, code: 'guard' })
    }
    requireInputSystem(projectPath, 'start')
    this.reclaimStale(projectPath)
    const envAttempt = (): Promise<Error | null> =>
      cut(
        this.ensureProjectEnv(projectPath).then(
          () => null,
          (e: unknown) => e as Error
        ),
        signal
      )
    const adopted = await this.tryAdoptPrimary(projectPath)
    await cut(this.projectEnvPromises.get(comparablePath(projectPath))?.catch(() => undefined) ?? Promise.resolve(), signal)
    if (adopted) {
      this.instances.set(projectPath, adopted)
      const adoptedEnvError = await envAttempt()
      if (adoptedEnvError) console.log(`[unity] project env refresh after adoption failed: ${adoptedEnvError.message}`)
      return adopted
    }
    const lockedBeforeEnv = await isProjectLockedLive(projectPath)
    let envError = await envAttempt()
    const lockedAtStart = await isProjectLockedLive(projectPath)
    if (lockedAtStart) {
      const reaped = await this.reapOwnEditors(projectPath)
      if (reaped) {
        const deadline = Date.now() + 2000
        while (Date.now() < deadline && (await isProjectLockedLive(projectPath))) await delay(150)
      }
      if (await isProjectLockedLive(projectPath))
        throw new LaunchFailure({
          ok: false,
          standalone: true,
          code: 'locked',
          error: 'Another Unity is open on this project.'
        })
    }
    if (lockedBeforeEnv || lockedAtStart || envError) envError = await envAttempt()
    if (envError)
      throw new LaunchFailure({
        ok: false,
        code: /won't touch/.test(envError.message) ? 'guard' : 'env',
        error: /won't touch/.test(envError.message) ? envError.message : `Could not prepare Satura Space packages: ${envError.message}`
      })
    const engineDest = join(projectPath, 'Packages', ENGINE_PKG_NAME)
    if (readEngineStamp(engineDest) !== engineBuildId()) {
      await cut(this.ensureEngine(projectPath), signal)
      if (readEngineStamp(engineDest) !== engineBuildId())
        throw new LaunchFailure({
          ok: false,
          code: 'engine',
          error:
            'Could not update the Satura Space engine package — another program may be holding files in Packages/com.saturaspace.engine. Close it and launch again.'
        })
    }
    const editor = requireEditor(projectPath, 'start')
    const inst = await this.launch(projectPath, editor, readLastScene(projectPath) ?? SCENE, signal)
    this.instances.set(projectPath, inst)
    return inst
  }

  private handoffRecords: Map<string, HandoffInstance> | null = null
  private quitting = false
  private closingAll = false
  private finalized = false
  private liveEditors = censusTrack('unity-instance-provider.liveEditors', new Set<Instance>())

  isQuitting(): boolean {
    return this.quitting
  }

  private refuseIfQuitting(what: string, inst?: Instance): void {
    if (!this.quitting) return
    if (inst) {
      inst.disposed = true
      this.teardownInstanceResources(inst)
      if (this.byWorldId.get(inst.worldId) === inst) this.byWorldId.delete(inst.worldId)
      worldStore.detachInstance(inst.worldId)
    }
    console.log(`[unity] ${what} refused: Satura Space is quitting`)
    throw new LaunchFailure({ ok: false, error: 'Satura Space is quitting.' })
  }

  private loadHandoffRecords(): Map<string, HandoffInstance> {
    if (this.handoffRecords) return this.handoffRecords
    this.handoffRecords = new Map()
    for (const rec of consumeUpdateHandoff()?.instances ?? []) {
      this.handoffRecords.set(rec.projectPath, rec)
    }
    return this.handoffRecords
  }

  private async tryAdoptPrimary(projectPath: string): Promise<Instance | null> {
    const records = this.loadHandoffRecords()
    const rec = records.get(projectPath)
    if (!rec || rec.kind !== 'primary') return null
    records.delete(projectPath)
    const cloneRecs: HandoffInstance[] = []
    for (const [key, cloneRec] of [...records]) {
      if (cloneRec.kind !== 'clone' || cloneRec.realProjectPath !== projectPath) continue
      records.delete(key)
      cloneRecs.push(cloneRec)
    }
    const primaryLive =
      pidAlive(rec.pid) &&
      (await isProjectLockedLive(projectPath)) &&
      (await this.isHandoffUnityPid(rec.pid, rec.projectPath))
    if (!primaryLive) {
      console.log(`[unity] handoff editor for ${projectPath} is gone (pid=${rec.pid}) — launching fresh`)
      await this.killHandoffLeftovers([rec, ...cloneRecs])
      return null
    }
    const wantId = engineBuildId()
    const haveId = readEngineStamp(join(projectPath, 'Packages', ENGINE_PKG_NAME))
    if (haveId !== wantId) {
      console.log(
        `[unity] handoff editor for ${projectPath} runs engine ${haveId ?? 'none'} but the app ships ${wantId} — restarting it to sync the engine`
      )
      await this.quitHandoffEditors([rec, ...cloneRecs], projectPath)
      return null
    }
    const inst = this.adoptInstance(rec)
    let players = 1
    for (const cloneRec of cloneRecs) {
      const cloneLive =
        pidAlive(cloneRec.pid) &&
        (await this.isHandoffUnityPid(cloneRec.pid, cloneRec.projectPath))
      if (!cloneLive) {
        console.log(`[unity] handoff clone ${cloneRec.worldId} is gone (pid=${cloneRec.pid})`)
        await this.killHandoffLeftovers([cloneRec])
        continue
      }
      this.instances.set(cloneRec.projectPath, this.adoptInstance(cloneRec))
      players++
    }
    if (players > 1) worldStore.setDesired(projectPath, { playerCount: players })
    console.log(`[unity] adopted ${players} running editor(s) for ${projectPath} after update`)
    return inst
  }

  private async isHandoffUnityPid(pid: number, instanceDir: string): Promise<boolean> {
    return pidRunsPath(await listUnityProcesses(), pid, instanceDir)
  }

  private async quitHandoffEditors(recs: HandoffInstance[], projectPath: string): Promise<void> {
    await Promise.all(recs.map((rec) => this.quitHandoffRecord(rec)))
    const lockDeadline = Date.now() + 10_000
    while (Date.now() < lockDeadline && (await isProjectLockedLive(projectPath))) await delay(200)
  }

  private async quitHandoffRecord(rec: HandoffInstance): Promise<boolean> {
    if (!pidAlive(rec.pid)) return false
    if (!(await this.isHandoffUnityPid(rec.pid, rec.projectPath))) {
      console.log(`[unity] handoff ${rec.kind} pid=${rec.pid} is no longer the Unity of ${rec.projectPath}; left it alone`)
      return false
    }
    const quit = sf(rec.projectPath, '.mcp_quit_trigger.json')
    const outcome = await quitEditor(
      {
        exited: () => !pidAlive(rec.pid),
        requestQuit: () => {
          guardSspace(rec.projectPath)
          writeFileSync(quit, '{}')
        },
        signal: (sig) => {
          try {
            process.kill(rec.pid, sig)
          } catch {
          }
        }
      },
      { reachable: true }
    )
    console.log(`[unity] quit handoff ${rec.kind} ${rec.worldId} pid=${rec.pid}: ${describeQuit(outcome, EDITOR_QUIT_TIMINGS.graceMs)}`)
    rmSafe(quit)
    return true
  }

  private pendingHandoffPrimary(projectPath: string): HandoffInstance | null {
    const key = comparablePath(projectPath)
    for (const rec of this.loadHandoffRecords().values())
      if (rec.kind === 'primary' && comparablePath(rec.projectPath) === key) return rec
    return null
  }

  private handoffSweepTimer: ReturnType<typeof setTimeout> | null = null

  scheduleHandoffSweep(delayMs = HANDOFF_CLAIM_MS): void {
    if (this.handoffSweepTimer || this.loadHandoffRecords().size === 0) return
    console.log(`[unity] ${this.loadHandoffRecords().size} editor(s) from before the update wait to be adopted; unclaimed ones quit in ${delayMs}ms`)
    this.handoffSweepTimer = setTimeout(() => {
      this.handoffSweepTimer = null
      void this.sweepUnclaimedHandoffs()
    }, delayMs)
    this.handoffSweepTimer.unref?.()
  }

  async sweepUnclaimedHandoffs(): Promise<number> {
    if (this.quitting) return 0
    const records = this.loadHandoffRecords()
    const claimed = (rec: HandoffInstance): boolean => {
      const root = rec.kind === 'clone' ? rec.realProjectPath : rec.projectPath
      return this.launching.has(root) || this.instances.has(root) || this.launching.has(rec.projectPath) || this.instances.has(rec.projectPath)
    }
    const unclaimed = [...records.entries()].filter(([, rec]) => !claimed(rec))
    for (const [key] of unclaimed) records.delete(key)
    if (!unclaimed.length) return 0
    console.log(`[unity] ${unclaimed.length} editor(s) from before the update were not adopted; quitting them`)
    let quit = 0
    await Promise.all(
      unclaimed.map(async ([, rec]) => {
        if (!(await this.quitHandoffRecord(rec))) return
        quit++
        if (pidAlive(rec.pid)) return
        if (rec.kind === 'clone') this.removeCloneDir(rec.projectPath)
        else clearProjectState(rec.projectPath)
      })
    )
    return quit
  }

  private async killHandoffLeftovers(recs: HandoffInstance[]): Promise<void> {
    for (const rec of recs) {
      if (!pidAlive(rec.pid)) continue
      if (!(await this.isHandoffUnityPid(rec.pid, rec.projectPath))) continue
      try {
        process.kill(rec.pid, 'SIGKILL')
        console.log(
          `[unity] killed leftover handoff ${rec.kind} editor pid=${rec.pid} (${rec.projectPath})`
        )
      } catch {
      }
    }
  }

  private adoptInstance(rec: HandoffInstance): Instance {
    const inst = this.buildInstance({
      projectPath: rec.projectPath,
      realProjectPath: rec.realProjectPath,
      kind: rec.kind,
      worldId: rec.worldId,
      cloneId: rec.cloneId,
      mediaPort: rec.mediaPort,
      inputPort: rec.inputPort,
      controlPort: rec.controlPort,
      controlToken: rec.controlToken,
      logPath: rec.logPath,
      unityMode: rec.unityMode
    })
    inst.editModeReady = true
    inst.sawEditor = true
    const proc = new HookedProc(rec.pid)
    inst.proc = proc
    this.liveEditors.add(inst)
    assignToKillJob(rec.pid)
    this.attachProcHandlers(inst, proc)
    const wf = inst.channel?.readWorld()
    if (wf) worldStore.ingestEditorSnapshot(rec.worldId, wf.world)
    worldStore.setMainSignal(rec.worldId, { bootPhase: 'editmode' })
    if (rec.kind === 'primary') this.launchedVersion.set(rec.projectPath, readProjectVersion(rec.projectPath).version)
    console.log(
      `[unity] adopted running ${rec.kind} editor pid=${rec.pid} udp=${rec.mediaPort}/${rec.inputPort} project=${rec.projectPath}`
    )
    return inst
  }

  private async startClone(id: string, projectPath: string, wcId: number): Promise<UnityStartResult> {
    this.ensureWorld()
    if (this.stops.isStopped(projectPath)) return STOPPED_RESULT
    const integrityError = this.validateProjectIntegrity(projectPath)
    if (integrityError) {
      return { ok: false, error: integrityError }
    }
    const primary = this.instances.get(projectPath)
    if (!primary || primary.exited || primary.kind !== 'primary') {
      return { ok: false, error: 'Primary editor not ready' }
    }
    const known = this.cloneAt(projectPath, cloneIndexOf(id))
    const cloneId = known?.cloneId ?? id
    const cloneDir = known?.projectPath ?? this.cloneDirFor(projectPath, cloneId)

    const existingClone = known && !known.exited ? known : undefined
    if (existingClone) {
      existingClone.subscribers.set(id, wcId)
      resendSurface(existingClone.worldId, wcId, id)
      this.subIndex.set(id, cloneDir)
      worldStore.resyncSubscriber(projectPath, id, wcId)
      return {
        ok: true,
        mediaPort: existingClone.mediaPort,
        inputPort: existingClone.inputPort
      }
    }

    try {
      const inst = await this.acquireClone(projectPath, cloneDir, cloneId)
      inst.subscribers.set(id, wcId)
      resendSurface(inst.worldId, wcId, id)
      this.subIndex.set(id, cloneDir)
      worldStore.resyncSubscriber(projectPath, id, wcId)
      return {
        ok: true,
        mediaPort: inst.mediaPort,
        inputPort: inst.inputPort
      }
    } catch (e) {
      if (e instanceof LaunchFailure) return e.result
      return { ok: false, error: (e as Error).message }
    }
  }

  private acquireClone(projectPath: string, cloneDir: string, id: string): Promise<Instance> {
    const pending = this.launching.get(cloneDir)
    if (pending) return pending
    const p = this.launchCloneInstance(projectPath, cloneDir, id)
    this.launching.set(cloneDir, p)
    return p.finally(() => {
      if (this.launching.get(cloneDir) === p) this.launching.delete(cloneDir)
    })
  }

  private async launchCloneInstance(
    projectPath: string,
    cloneDir: string,
    id: string
  ): Promise<Instance> {
    this.reclaimStale(cloneDir)
    const editor = this.resolveEditor(projectPath)
    if (!editor) throw new LaunchFailure({ ok: false, error: 'Unity editor not found' })
    const inst = await this.launchClone(projectPath, editor, id, this.currentScene(projectPath, SCENE))
    this.instances.set(cloneDir, inst)
    return inst
  }

  async stop(id: string): Promise<boolean> {
    this.stops.release(id)
    for (const pp of [...this.startWaiting.keys()]) this.clearStartWaiting(pp, id)
    const projectPath = this.subIndex.get(id)
    this.subIndex.delete(id)
    if (!projectPath) return false
    const inst = this.instances.get(projectPath)
    if (!inst) return false
    const wcId = inst.subscribers.get(id)
    if (wcId != null) resendSurface(inst.worldId, wcId, id)
    inst.subscribers.delete(id)
    inst.viewHints.delete(id)
    this.pushHeld(inst)
    if (inst.kind === 'clone') {
      if (inst.live) this.pushStreamControl(inst)
      return true
    }
    if (inst.subscribers.size === 0) {
      this.instances.delete(projectPath)
      this.relaunchPending.delete(projectPath)
      this.reconciler?.untrack(projectPath)
      await this.shutdownClonesOf(inst.projectPath)
      await this.shutdown(inst)
    } else if (inst.live) {
      this.pushStreamControl(inst)
    }
    return true
  }

  async stopForWebContents(wcId: number): Promise<void> {
    const ids: string[] = []
    for (const inst of this.instances.values()) {
      for (const [subId, w] of inst.subscribers) {
        if (w === wcId) ids.push(subId)
      }
    }
    for (const id of ids) await this.stop(id)
    for (const [pp, entry] of [...this.startWaiting]) {
      for (const [id, w] of [...entry.ids]) if (w === wcId) this.clearStartWaiting(pp, id)
    }
    this.stops.releaseWebContents(wcId)
  }

  reassignSubscribers(sessionIds: string[], fromWcId: number, toWcId: number): void {
    const matches = (subId: string): boolean =>
      sessionIds.some((id) => subId === id || subId.startsWith(`${id}${CLONE_SEP}`))
    for (const inst of this.instances.values()) {
      for (const [subId, w] of inst.subscribers) {
        if (w === fromWcId && matches(subId)) inst.subscribers.set(subId, toWcId)
      }
    }
    this.stops.reassign(matches, fromWcId, toWcId)
  }

  private async shutdownClonesOf(realProjectPath: string): Promise<void> {
    const clones = [...this.instances.values()].filter(
      (i) => i.kind === 'clone' && i.realProjectPath === realProjectPath
    )
    await Promise.all(
      clones.map(async (c) => {
        this.instances.delete(c.projectPath)
        if (c.cloneId) this.cloneFailCount.delete(c.cloneId)
        for (const subId of c.subscribers.keys()) this.subIndex.delete(subId)
        this.beginTeardown(realProjectPath, c.projectPath)
        try {
          await this.shutdown(c)
        } finally {
          this.endTeardown(realProjectPath, c.projectPath)
        }
      })
    )
  }

  private playersFor(realProjectPath: string): PlayerInfo[] {
    return this.orderedInstances(realProjectPath).map((i) => this.playerInfo(i))
  }

  private playerInfo(inst: Instance): PlayerInfo {
    const obs = worldStore.getWorld(inst.realProjectPath).observed.instances[inst.worldId]
    const playing = obs ? obs.lifecycle === 'playing' || obs.lifecycle === 'entering-play' : false
    return {
      id: (inst.kind === 'primary' ? inst.primaryId : inst.cloneId) ?? '',
      kind: inst.kind,
      vpId: inst.kind === 'clone' ? basename(inst.projectPath) : null,
      pid: inst.proc?.pid ?? null,
      playing,
      state: this.snapshotState(inst)
    }
  }

  playersForProject(realProjectPath: string): PlayerInfo[] {
    return this.playersFor(realProjectPath)
  }

  private cloneAt(realProjectPath: string, index: number): Instance | undefined {
    let exited: Instance | undefined
    for (const inst of this.instances.values()) {
      if (inst.kind !== 'clone' || inst.realProjectPath !== realProjectPath || cloneIndexOf(inst.cloneId) !== index) continue
      if (!inst.exited) return inst
      exited ??= inst
    }
    return exited
  }

  private nextCloneId(realProjectPath: string, primaryId: string): string | null {
    for (let k = 1; k < 64; k++) {
      const inst = this.cloneAt(realProjectPath, k)
      if (!inst) return `${primaryId}${CLONE_SEP}${k}`
      if (inst.exited && !inst.failed) return inst.cloneId ?? `${primaryId}${CLONE_SEP}${k}`
    }
    return null
  }

  async addPlayer(
    realProjectPath: string
  ): Promise<{ ok: boolean; cloneId?: string; vpId?: string; error?: string }> {
    if (this.stops.isStopped(realProjectPath)) return { ok: false, error: STOPPED_ERROR }
    const primary = this.instances.get(realProjectPath)
    if (!primary || primary.exited || primary.kind !== 'primary')
      return { ok: false, error: 'No primary editor for this project' }
    if (!primary.primaryId) return { ok: false, error: 'Primary not ready' }
    if (this.isTearingDown(realProjectPath))
      return {
        ok: false,
        error: 'A player is still shutting down — wait for teardown to finish before adding.'
      }
    if (this.playersFor(realProjectPath).length >= MAX_PLAYERS)
      return { ok: false, error: `Player limit (${MAX_PLAYERS}) reached` }
    const cloneId = this.nextCloneId(realProjectPath, primary.primaryId)
    if (!cloneId) return { ok: false, error: 'No free player slot' }
    const missing = missingEditor(realProjectPath, 'add player')
    if (missing) return { ok: false, error: missing.error }
    const editor = this.resolveEditor(realProjectPath)
    if (!editor) return { ok: false, error: 'Could not read the Unity version from ProjectSettings/ProjectVersion.txt' }
    const cloneDir = this.cloneDirFor(realProjectPath, cloneId)
    const existing = this.instances.get(cloneDir)
    if (existing && !existing.exited) return { ok: true, cloneId, vpId: basename(cloneDir) }
    const hub = await hubBlock('add player')
    if (hub) return { ok: false, error: hub.error }
    this.reclaimStale(cloneDir)
    let inst: Instance
    try {
      inst = await this.launchClone(realProjectPath, editor, cloneId, this.currentScene(realProjectPath, SCENE))
    } catch (e) {
      return { ok: false, error: e instanceof LaunchFailure ? e.result.error : (e as Error).message }
    }
    if (this.stops.isStopped(realProjectPath)) {
      await this.shutdown(inst)
      return { ok: false, error: STOPPED_ERROR }
    }
    this.instances.set(cloneDir, inst)
    return { ok: true, cloneId, vpId: basename(cloneDir) }
  }

  async removePlayer(realProjectPath: string, cloneId: string): Promise<{ ok: boolean; error?: string }> {
    const cloneDir = this.cloneDirFor(realProjectPath, cloneId)
    const inst = this.instances.get(cloneDir)
    if (!inst || inst.kind !== 'clone') return { ok: false, error: `No such player: ${cloneId}` }
    if (this.groupWorking(realProjectPath))
      return { ok: false, error: 'Players are still loading — wait until the group is idle to remove one.' }
    const cloneWorldId = inst.worldId
    this.instances.delete(cloneDir)
    this.byWorldId.delete(cloneWorldId)
    this.cloneFailCount.delete(cloneId)
    this.lastPane.delete(cloneWorldId)
    for (const subId of inst.subscribers.keys()) this.subIndex.delete(subId)
    this.beginTeardown(realProjectPath, cloneDir)
    worldStore.setTearingDown(realProjectPath, true)
    worldStore.detachInstance(cloneWorldId)
    try {
      await this.shutdown(inst)
    } finally {
      this.endTeardown(realProjectPath, cloneDir)
      worldStore.setTearingDown(realProjectPath, this.isTearingDown(realProjectPath))
    }
    return { ok: true }
  }

  private markStartWaiting(projectPath: string, id: string, wcId: number, error: string): void {
    const entry = this.startWaiting.get(projectPath) ?? { ids: new Map<string, number>(), error }
    entry.ids.set(id, wcId)
    entry.error = error
    this.startWaiting.set(projectPath, entry)
    this.managedProjects.add(projectPath)
    this.ensureMcpControlServer()
    this.publishOrchestratorFile(projectPath)
    unityLifecycle.refresh(projectPath, true)
  }

  private clearStartWaiting(projectPath: string, id?: string): void {
    const entry = this.startWaiting.get(projectPath)
    if (!entry) return
    if (id !== undefined) entry.ids.delete(id)
    if (id !== undefined && entry.ids.size > 0) return
    this.startWaiting.delete(projectPath)
    if (!this.relaunchPending.has(projectPath)) this.launchBlocked.delete(projectPath)
    if (this.commandPolls.has(projectPath)) this.publishOrchestratorFile(projectPath)
    else this.syncStoppedMarker(projectPath)
    unityLifecycle.refresh(projectPath)
  }

  private publishOrchestratorFile(projectPath: string): void {
    const life = unityLifecycle.peek(projectPath)
    const base = {
      pid: process.pid,
      controlPort: this.mcpControlPort,
      controlToken: this.mcpControlToken,
      ...(life?.phase === 'hub' ? { hubBlocked: life.error } : {})
    }
    this.writeTrigger(
      projectPath,
      ORCHESTRATOR_FILE,
      JSON.stringify(
        this.stops.isStopped(projectPath) ? { ...base, stopped: true } : { ...base, appPath: appBundlePath() }
      ),
      true
    )
  }

  private syncStoppedMarker(projectPath: string): void {
    if (this.commandPolls.has(projectPath)) return
    if (this.startWaiting.has(projectPath) || this.relaunchPending.has(projectPath)) {
      this.managedProjects.add(projectPath)
      this.ensureMcpControlServer()
      this.publishOrchestratorFile(projectPath)
      return
    }
    if (this.stops.subscribers(projectPath).length > 0 && this.stops.isStopped(projectPath)) {
      this.managedProjects.add(projectPath)
      this.ensureMcpControlServer()
      this.publishOrchestratorFile(projectPath)
      return
    }
    this.managedProjects.delete(projectPath)
    rmSafe(sf(projectPath, ORCHESTRATOR_FILE))
  }

  private handleOpenEditorRequest(inst: Instance): void {
    const f = sf(inst.projectPath, OPEN_EDITOR_REQUEST_FILE)
    if (!existsSync(f)) return
    let req: { seq?: number; ts?: number; file?: string; line?: number; column?: number }
    try {
      req = JSON.parse(readFileSync(f, 'utf8'))
    } catch {
      rmSafe(f)
      return
    }
    rmSafe(f)
    const ts = typeof req.ts === 'number' ? req.ts : 0
    if (ts > 0 && Math.abs(Date.now() - ts) > OPEN_EDITOR_REQUEST_TTL_MS) return
    const wcId = inst.subscribers.values().next().value
    if (typeof wcId !== 'number') return
    openFileInApp(
      {
        file: typeof req.file === 'string' ? req.file : '',
        line: typeof req.line === 'number' ? req.line : -1,
        column: typeof req.column === 'number' ? req.column : -1,
        projectPath: inst.realProjectPath,
        source: 'unity'
      },
      wcId
    )
    debugLog(`[unity] open editor file request project=${inst.realProjectPath} file=${req.file ?? ''}`)
  }

  private startCommandWatch(inst: Instance): void {
    if (inst.commandWatcher || this.commandPolls.has(inst.projectPath)) return
    this.managedProjects.add(inst.projectPath)
    this.ensureMcpControlServer()
    this.publishOrchestratorFile(inst.projectPath)
    const handle = (): void => {
      const f = sf(inst.projectPath, PLAYERS_COMMAND_FILE)
      if (!existsSync(f)) return
      let cmd: {
        requestId?: string
        action?: string
        scenePath?: string
        enterPlayMode?: boolean
        target?: string
        view?: string
        paneKey?: string
      }
      try {
        cmd = JSON.parse(readFileSync(f, 'utf8'))
      } catch {
        return
      }
      rmSafe(f)
      void this.handlePlayersCommand(inst.realProjectPath, cmd).then((r) => {
        try {
          guardSspace(inst.realProjectPath)
          writeFileSync(
            sf(inst.realProjectPath, PLAYERS_RESULT_FILE),
            JSON.stringify({ requestId: cmd.requestId ?? '', ...r })
          )
        } catch (e) {
          console.log(`[unity] players result write failed: ${(e as Error).message}`)
        }
      })
    }
    const handleOpen = (): void => this.handleOpenEditorRequest(inst)
    const startPoll = (ms: number): void => {
      const prev = this.commandPolls.get(inst.projectPath)
      if (prev) clearInterval(prev)
      this.commandPolls.set(
        inst.projectPath,
        setInterval(() => {
          handle()
          handleOpen()
        }, ms)
      )
    }
    rmSafe(sf(inst.projectPath, OPEN_EDITOR_REQUEST_FILE))
    try {
      const watcher = watch(sf(inst.projectPath), (_evt, fname) => {
        const name = fname?.toString()
        if (name === PLAYERS_COMMAND_FILE) handle()
        if (name === OPEN_EDITOR_REQUEST_FILE) handleOpen()
      })
      watcher.on('error', (e) => {
        console.log(`[unity] command watch error: ${e.message}`)
        if (inst.commandWatcher === watcher && this.commandPolls.has(inst.projectPath))
          startPoll(COMMAND_POLL_MS)
      })
      inst.commandWatcher = watcher
    } catch (e) {
      console.log(`[unity] command watch failed: ${(e as Error).message}`)
    }
    startPoll(inst.commandWatcher ? COMMAND_WATCHED_POLL_MS : COMMAND_POLL_MS)
    handle()
  }

  private ensureMcpControlServer(): void {
    if (this.mcpControlServer) return
    try {
      const server = createServer((socket) => {
        const parser = new NdjsonParser()
        const decoder = new StringDecoder('utf8')
        let pending: string | null = ''
        const helloTimer = setTimeout(() => socket.destroy(), CONTROL_HELLO_MS)
        socket.on('close', () => clearTimeout(helloTimer))
        socket.on('data', (chunk) => {
          let text = decoder.write(chunk)
          if (pending !== null) {
            pending += text
            const nl = pending.indexOf('\n')
            if (nl < 0) {
              if (pending.length > CONTROL_HELLO_MAX) socket.destroy()
              return
            }
            if (!tokenMatches(this.mcpControlToken, helloToken(pending.slice(0, nl).trim()))) {
              socket.destroy()
              return
            }
            clearTimeout(helloTimer)
            text = pending.slice(nl + 1)
            pending = null
          }
          for (const msg of parser.push(text)) {
            if (msg.type !== 'command') continue
            if (msg.cmd === 'scratchpads') {
              const handler = this.scratchpadCommandHandler
              const reply = handler
                ? handler((msg.args ?? {}) as Record<string, unknown>)
                : Promise.resolve({ ok: false, error: 'Scratchpads are not available in this build.' })
              void reply
                .catch((e: unknown) => ({ ok: false, error: (e as Error)?.message ?? String(e) }))
                .then((r) => {
                  try {
                    socket.write(
                      encodeMessage({ type: 'result', id: msg.id, status: r.ok ? 'completed' : 'error', ...r })
                    )
                  } catch {
                  }
                })
              continue
            }
            if (msg.cmd !== 'players') continue
            const args = (msg.args ?? {}) as {
              projectRoot?: string
              action?: string
              scenePath?: string
              enterPlayMode?: boolean
              target?: string
              view?: string
              paneKey?: string
            }
            const root = args.projectRoot ?? ''
            void this.handlePlayersCommand(root, args).then((r) => {
              try {
                socket.write(
                  encodeMessage({ type: 'result', id: msg.id, status: r.ok ? 'completed' : 'error', ...r })
                )
              } catch {
              }
            })
          }
        })
        socket.on('error', () => {
        })
      })
      server.on('error', (e) => console.log(`[unity] MCP control server error: ${e.message}`))
      this.mcpControlReady = new Promise<number>((resolveReady) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          this.mcpControlPort = addr && typeof addr === 'object' ? addr.port : 0
          console.log(`[unity] MCP control server listening on 127.0.0.1:${this.mcpControlPort}`)
          for (const pp of this.managedProjects) this.publishOrchestratorFile(pp)
          resolveReady(this.mcpControlPort)
        })
      })
      this.mcpControlServer = server
    } catch (e) {
      console.log(`[unity] MCP control server failed to start: ${(e as Error).message}`)
    }
  }

  setScratchpadCommandHandler(handler: ScratchpadCommandHandler | null): void {
    this.scratchpadCommandHandler = handler
  }

  async controlServerPort(): Promise<number> {
    this.ensureMcpControlServer()
    return this.mcpControlReady ? this.mcpControlReady : 0
  }

  controlServerToken(): string {
    return this.mcpControlToken
  }

  primaryStatus(projectPath: string): {
    launching: boolean
    running: boolean
    exited: boolean
    pid: number | null
    lifecycle: Lifecycle | null
    paused: boolean
  } {
    const key = this.canonicalProjectKey(projectPath)
    const inst = this.instances.get(key)
    const obs = worldStore.getWorld(key).observed.instances[primaryWorldId(key)]
    return {
      launching: this.launching.has(key),
      running: !!inst && !inst.exited,
      exited: !!inst && inst.exited,
      pid: inst?.proc?.pid ?? null,
      lifecycle: inst ? (obs?.lifecycle ?? null) : null,
      paused: !!inst && !!obs?.paused
    }
  }

  bootFailure(projectPath: string): string | null {
    const key = this.canonicalProjectKey(projectPath)
    const inst = this.instances.get(key)
    if (!inst || inst.disposed || inst.restarting || inst.live || inst.editModeReady || inst.fault) return null
    const crashed = inst.exited && inst.exitCode !== null && inst.exitCode !== 0
    if (!crashed && !inst.safeMode && !inst.failed && !(inst.exited && inst.bootCompileErrors > 0)) return null
    const errors = this.readLaunchErrors(inst.logPath).filter((l) => /: error CS\d+/.test(l))
    const shown = errors.slice(0, 10)
    const more = errors.length - shown.length
    const headline = errors.length
      ? `Unity can't start: ${errors.length} C# compile error${errors.length === 1 ? '' : 's'}${inst.safeMode ? ' (the editor is in Safe Mode)' : ''}.`
      : inst.safeMode
        ? "Unity can't start: it entered Safe Mode because of C# compile errors."
        : `Unity stopped before it could start (exit ${inst.exitCode}).`
    const obs = worldStore.getWorld(key).observed.instances[inst.worldId]
    const detail = shown.length ? shown : (obs?.error ? [obs.error] : relevantLogLines(inst.logPath))
    return [headline, ...detail, ...(more > 0 ? [`(+${more} more)`] : [])].join('\n')
  }

  setRelaunchWaiter(fn: ((projectPath: string, timeoutMs: number) => Promise<{ ok: boolean; error?: string; note?: string }>) | null): void {
    this.relaunchWaiter = fn
  }

  wireLifecycle(): void {
    if (this.lifecycleWired) return
    this.lifecycleWired = true
    unityLifecycle.setSource({
      version: (pp) => editorVersionFacts(pp),
      hub: () => hubState(),
      hubError: (state) => (state === 'ready' ? '' : hubBlockMessage(state)),
      instance: (pp) => this.lifecycleInstance(pp),
      project: (pp) => {
        const blocked = this.launchBlocked.get(pp)
        return {
          stopped: worldStore.getWorld(pp).desired.stopped,
          closing: this.closingAll,
          wanted: (this.startWaiting.get(pp)?.ids.size ?? 0) > 0,
          relaunch: this.relaunchPending.has(pp),
          launching: this.launching.has(pp),
          launches: this.launchCount.get(pp) ?? 0,
          refusal: (blocked?.kind === 'refused' ? blocked.error : '') || inputGateRefused.get(pp) || '',
          refusalCode: blocked?.kind === 'refused' ? blocked.code : inputGateRefused.has(pp) ? 'input-system' : '',
          failure: blocked?.kind === 'failed' ? blocked.error : '',
          failureCode: blocked?.kind === 'failed' ? blocked.code : ''
        }
      }
    })
    unityLifecycle.setResume((pp) => void this.resumeWaiting(pp))
    unityLifecycle.onChange((life, prev) => {
      if (prev && prev.phase === life.phase) return
      if (this.managedProjects.has(life.project) && (life.phase === 'hub' || prev?.phase === 'hub')) this.publishOrchestratorFile(life.project)
    })
    worldStore.onObservedChange((pp) => {
      unityLifecycle.refresh(pp)
    })
  }

  lifecycle(rawProjectPath: string): UnityLifecycle {
    return unityLifecycle.get(this.canonicalProjectKey(rawProjectPath))
  }

  lifecycleHistory(rawProjectPath: string): UnityStateTransition[] {
    return unityLifecycle.history(this.canonicalProjectKey(rawProjectPath))
  }

  async retryProject(rawProjectPath: string, from: string): Promise<{ ok: boolean; error?: string; note?: string }> {
    const pp = this.canonicalProjectKey(rawProjectPath)
    const before = unityLifecycle.get(pp)
    console.log(`[unity] retry from ${from} for ${pp} (state ${before.state}${before.code ? `, ${before.code}` : ''})`)
    if (before.state === 'starting' || before.state === 'stopping') return { ok: true, note: `Unity is ${before.state}; nothing to retry.` }
    if (before.state === 'ready') return { ok: true, note: 'Unity is ready.' }
    this.launchBlocked.delete(pp)
    inputGateRefused.delete(pp)
    unityLifecycle.refresh(pp, true)
    const r = await this.relaunchProject(pp)
    if (!r.ok) console.log(`[unity] retry of ${pp} failed: ${r.error ?? 'unknown'}`)
    return r
  }

  async cancelProject(rawProjectPath: string, from: string): Promise<{ ok: boolean; error?: string; note?: string }> {
    const pp = this.canonicalProjectKey(rawProjectPath)
    const before = unityLifecycle.get(pp)
    const label = stateLabel(before)
    if (before.state !== 'starting' && before.state !== 'stopping') return { ok: true, note: `Unity is ${label}; nothing to cancel.` }
    const why = `cancelled by the user${from === 'the phone' ? ' from the phone' : ''}`
    const started = Date.now()
    console.log(`[unity] cancel from ${from} for ${pp} (state ${label})`)
    unityLifecycle.cause(pp, why)
    this.cancelling.add(pp)
    this.dropPendingRelaunch(pp)
    try {
      const stop = this.stopProject(pp)
      this.launchAborts.get(pp)?.abort()
      for (const inst of this.liveEditors) if (inst.realProjectPath === pp && !inst.exited && before.state === 'stopping') inst.proc?.kill('SIGTERM')
      const r = await stop
      await new Promise((r) => setImmediate(r))
      const after = unityLifecycle.get(pp)
      console.log(`[unity] cancel: ${label} -> ${stateLabel(after)} (${why}) in ${Date.now() - started} ms ${pp}`)
      return r.ok ? { ok: true, note: `Cancelled: Unity is ${stateLabel(after)}.` } : r
    } finally {
      this.cancelling.delete(pp)
      unityLifecycle.cause(pp, null)
    }
  }

  watchLifecycle(rawProjectPath: string, wcId: number): UnityLifecycle {
    return unityLifecycle.watch(this.canonicalProjectKey(rawProjectPath), wcId)
  }

  unwatchLifecycle(rawProjectPath: string, wcId: number): void {
    unityLifecycle.unwatch(this.canonicalProjectKey(rawProjectPath), wcId)
  }

  managesProject(rawProjectPath: string): boolean {
    const pp = this.canonicalProjectKey(rawProjectPath)
    if (this.instances.get(pp)?.kind === 'clone') return false
    return (
      this.instances.has(pp) ||
      this.launching.has(pp) ||
      this.startWaiting.has(pp) ||
      this.relaunchPending.has(pp) ||
      this.managedProjects.has(pp) ||
      this.stops.subscribers(pp).length > 0
    )
  }

  private lifecycleInstance(pp: string): EditorInstanceFacts | null {
    const inst = this.instances.get(pp)
    const obs = worldStore.getWorld(pp).observed.instances[primaryWorldId(pp)]
    if (!inst || inst.kind !== 'primary' || inst.disposed) {
      if (!obs || this.launching.has(pp)) return null
      return {
        pid: null,
        version: '',
        exited: obs.lifecycle === 'exited' || !obs.alive,
        exitCode: null,
        exitSignal: null,
        restarting: obs.lifecycle === 'restarting',
        booted: false,
        lifecycle: obs.lifecycle,
        compile: obs.compile,
        compileError: obs.compileError,
        error: obs.error,
        stuck: false,
        fault: obs.fault ? obs.faultReason || `Unity ${obs.fault}.` : '',
        faultKind: obs.fault || '',
        bootFailure: '',
        bootCode: '',
        progressLabel: obs.progressLabel,
        progressPct: obs.progressPct,
        stall: obs.stall,
        dialog: null
      }
    }
    const boot = this.bootFailure(pp)
    return {
      pid: inst.proc?.pid ?? null,
      version: this.launchedVersion.get(pp) ?? '',
      exited: inst.exited,
      exitCode: inst.exitCode,
      exitSignal: inst.exitSignal,
      restarting: inst.restarting,
      booted: inst.editModeReady || inst.live || inst.sawEditor,
      lifecycle: obs?.lifecycle ?? null,
      compile: obs?.compile ?? null,
      compileError: obs?.compileError ?? null,
      error: obs?.error ?? null,
      stuck: inst.stuck,
      fault: inst.fault ? inst.fault.reason || `Unity ${inst.fault.kind}.` : '',
      faultKind: inst.fault?.kind ?? '',
      bootFailure: boot ?? '',
      bootCode: !boot ? '' : /C# compile error/.test(boot) ? 'compile' : /Safe Mode/.test(boot) ? 'safe-mode' : /No valid Unity Editor license/i.test(boot) ? 'license' : 'exited-early',
      progressLabel: obs?.progressLabel ?? '',
      progressPct: obs?.progressPct ?? -1,
      stall: obs?.stall ?? '',
      dialog: inst.exited ? null : (openDialogs(inst.projectPath, inst.proc?.pid ?? null)[0] ?? null)
    }
  }

  async answerDialog(rawProjectPath: string, id: string, button: string, from: string): Promise<{ ok: boolean; error?: string; note?: string }> {
    const pp = this.canonicalProjectKey(rawProjectPath)
    const inst = this.instances.get(pp)
    if (!inst || inst.kind !== 'primary' || inst.exited) return { ok: false, error: 'No Unity editor runs for this project.' }
    const d = openDialogs(inst.projectPath, inst.proc?.pid ?? null).find((x) => x.id === id)
    if (!d) {
      unityLifecycle.refresh(pp)
      return { ok: true, note: 'That Unity dialog is already closed.' }
    }
    if (!d.buttons.includes(button)) return { ok: false, error: `The Unity dialog has no '${dialogButtonLabel(button)}' button.` }
    console.log(`[unity] dialog ${dialogText(d)}: ${from} pressed '${dialogButtonLabel(button)}' ${pp}`)
    const r = await answerDialog(inst.projectPath, id, button, undefined, 8000)
    console.log(`[unity] dialog '${d.title || 'untitled'}' ${r.ok ? `took '${dialogButtonLabel(button)}'` : `is still open: ${r.error}`} ${pp}`)
    unityLifecycle.refresh(pp)
    return r
  }

  private async resumeWaiting(pp: string): Promise<void> {
    if (this.relaunchPending.has(pp)) {
      const r = await this.relaunchProject(pp)
      if (!r.ok) console.log(`[unity] the relaunch that waited for ${pp} failed: ${r.error}`)
    }
    const entry = this.startWaiting.get(pp)
    for (const [id, wcId] of [...(entry?.ids ?? [])]) {
      const r = await this.start(id, pp, wcId)
      if (!r.ok) console.log(`[unity] the panel that waited for ${pp} still can't start: ${r.error}`)
    }
  }

  async relaunchProject(rawProjectPath: string): Promise<{ ok: boolean; error?: string; note?: string; pending?: boolean; hub?: UnityStartResult['hub'] }> {
    this.ensureWorld()
    const pp = this.canonicalProjectKey(rawProjectPath)
    const integrityError = this.validateProjectIntegrity(pp)
    if (integrityError) return { ok: false, error: integrityError }
    const gate = inputGateRefusal(pp, 'relaunch')
    if (gate) {
      unityLifecycle.refresh(pp)
      return { ok: false, error: gate.error }
    }
    const missing = missingEditor(pp, 'relaunch')
    if (missing) {
      const fresh = !this.relaunchPending.has(pp)
      this.relaunchPending.add(pp)
      this.managedProjects.add(pp)
      this.ensureMcpControlServer()
      this.publishOrchestratorFile(pp)
      unityLifecycle.refresh(pp, true)
      if (fresh) console.log(`[unity] relaunch of ${pp} waits for Unity ${missing.missing}`)
      return { ok: true, pending: true, note: `Waiting for Unity ${missing.missing}: ${missing.error}` }
    }
    this.relaunchPending.delete(pp)
    const hub = await hubBlock('relaunch')
    if (hub) {
      unityLifecycle.refresh(pp)
      return { ok: false, error: hub.error, hub: hub.hub }
    }
    const wasStopped = this.stops.isStopped(pp)
    const existing = this.instances.get(pp)
    if (existing && existing.kind === 'primary' && !existing.exited) {
      const cloneCount = this.orderedInstances(pp).filter((i) => i.kind === 'clone').length
      worldStore.setDesired(pp, { playerCount: 1 })
      this.reconciler.requestRestart(existing.worldId)
      unityLifecycle.refresh(pp)
      return { ok: true, note: cloneCount > 0 ? `Relaunching the primary; ${cloneCount} clone(s) removed.` : 'Relaunching the primary.' }
    }
    const r = await this.launchPrimary(pp)
    unityLifecycle.refresh(pp)
    if (!r.ok) return { ok: false, error: r.error }
    void this.attachWaiting(pp)
    return { ok: true, note: wasStopped ? 'Unity was stopped — started the primary again.' : 'No editor was running — launched the primary.' }
  }

  dropPendingRelaunch(rawProjectPath: string): void {
    const pp = this.canonicalProjectKey(rawProjectPath)
    if (!this.relaunchPending.delete(pp)) return
    console.log(`[unity] the relaunch of ${pp} stopped waiting for its Unity version`)
    this.syncStoppedMarker(pp)
    unityLifecycle.refresh(pp)
  }

  private async attachWaiting(pp: string): Promise<void> {
    const entry = this.startWaiting.get(pp)
    for (const [id, wcId] of [...(entry?.ids ?? [])]) await this.start(id, pp, wcId)
  }

  editorWaitState(rawProjectPath: string, target?: string): EditorWaitState {
    const realProjectPath = this.canonicalProjectKey(rawProjectPath)
    const id = target && target !== '*' ? target : primaryWorldId(realProjectPath)
    const inst = this.byWorldId.get(id)
    const logPath = inst?.logPath ?? sf(realProjectPath, '.mcp_rawstream_editor.log')
    const obs = worldStore.getWorld(realProjectPath).observed.instances[id]
    const base: EditorWaitState = {
      state: 'up',
      pid: inst && !inst.exited ? (inst.proc?.pid ?? null) : null,
      code: inst?.exitCode ?? null,
      signal: inst?.exitSignal ?? null,
      booted: !!inst && (inst.editModeReady || inst.live || inst.sawEditor),
      error: null,
      lifecycle: obs?.lifecycle ?? null,
      progress: obs?.progressLabel ? `${obs.progressLabel}${obs.progressPct >= 0 ? ` ${Math.round(obs.progressPct)}%` : ''}` : '',
      logSize: logSizeOf(logPath),
      log: []
    }
    const withLog = (s: Partial<EditorWaitState>): EditorWaitState => ({ ...base, ...s, log: relevantLogLines(logPath) })
    if (id === primaryWorldId(realProjectPath)) {
      const life = unityLifecycle.get(realProjectPath)
      const said = [life.error, life.next].filter((s) => !!s).join(' ')
      switch (life.phase) {
        case 'missing':
        case 'installing':
          return { ...base, state: 'missing', error: said, booted: false }
        case 'hub':
          return withLog({ state: 'hub', error: life.error })
        case 'refused':
          return { ...base, state: 'refused', error: life.error }
        case 'stopped':
          return { ...base, state: 'stopped' }
        case 'idle':
          return inst?.exited ? withLog({ state: 'exited', error: obs?.error ?? null }) : withLog({ state: 'none' })
        case 'failed':
          return inst?.exited || !inst ? withLog({ state: 'exited', error: life.error }) : withLog({ state: 'failed', error: life.error })
        case 'launching':
        case 'importing':
        case 'compiling':
          return life.booted ? base : { ...base, state: 'launching' }
        default:
          return base
      }
    }
    const refused = inputGateRefused.get(realProjectPath)
    if (refused && (!inst || inst.exited || inst.disposed) && !this.launching.has(realProjectPath)) return { ...base, state: 'refused', error: refused }
    if (this.stops.isStopped(realProjectPath)) return { ...base, state: 'stopped' }
    if (!inst || inst.disposed) return this.launching.has(realProjectPath) ? { ...base, state: 'launching' } : withLog({ state: 'none' })
    if (inst.restarting) return { ...base, state: 'launching' }
    if (inst.exited) return withLog({ state: 'exited', error: obs?.error ?? null })
    if (inst.editModeReady || inst.live) return base
    if (inst.failed || inst.stuck || inst.safeMode) return withLog({ state: 'failed', error: obs?.error ?? obs?.compileError ?? null })
    return inst.sawEditor ? base : { ...base, state: 'launching' }
  }

  private stopCommandWatch(inst: Instance): void {
    if (inst.commandWatcher) {
      try {
        inst.commandWatcher.close()
      } catch {
      }
      inst.commandWatcher = null
    }
    const poll = this.commandPolls.get(inst.projectPath)
    if (poll) {
      clearInterval(poll)
      this.commandPolls.delete(inst.projectPath)
    }
    this.syncStoppedMarker(inst.projectPath)
  }

  private startAssetWatch(inst: Instance): void {
    if (inst.assetWatcher) return
    const tracker = new ProjectDirtyTracker()
    this.dirtyTrackers.set(inst.realProjectPath, tracker)
    const watcher = new AssetRefreshWatcher(inst.realProjectPath, (rels) => {
      if (this.dead(inst)) return
      const obs = worldStore.getWorld(inst.realProjectPath).observed.instances[inst.worldId]
      if (obs?.hotReloadActive && obs.lifecycle === 'playing') {
        if (Date.now() - inst.hotReloadTerminalAt >= STARTED_SUPPRESS_MS) {
          worldStore.emitProgress(inst.worldId, 'reload', 'started', undefined, String(rels.length))
        }
        this.pushHotPatchToClones(inst.realProjectPath, rels)
      }
    })
    watcher.onAnyChange = () => tracker.fileEvent()
    watcher.onWatchError = () => tracker.markBroken()
    inst.assetWatcher = watcher
    watcher.start()
    this.startHotReloadLogWatch(inst)
  }

  private startHotReloadLogWatch(inst: Instance): void {
    if (inst.hotReloadLogSub) return
    void unityLogTailers
      .addListener(inst.realProjectPath, (lines) => {
        if (this.dead(inst)) return
        for (const l of lines) {
          const hit = classifyHotReloadLine(l.message)
          if (!hit) continue
          inst.hotReloadTerminalAt = Date.now()
          if (hit.phase === 'patched') {
            worldStore.emitProgress(inst.worldId, 'reload', 'patched', undefined, hit.methods)
          } else {
            worldStore.emitProgress(inst.worldId, 'reload', 'failed')
          }
        }
      })
      .then(({ remove }) => {
        if (this.dead(inst)) {
          remove()
          return
        }
        inst.hotReloadLogSub = remove
      })
      .catch((e) => console.log(`[unity] hot-reload log watch failed: ${(e as Error).message}`))
  }

  private pushHotPatchToClones(realProjectPath: string, rels: string[]): void {
    if (rels.length === 0) return
    const world = worldStore.getWorld(realProjectPath).observed
    for (const inst of this.instances.values()) {
      if (inst.kind !== 'clone' || inst.realProjectPath !== realProjectPath || this.dead(inst)) continue
      const obs = world.instances[inst.worldId]
      if (!obs?.hotReloadActive || obs.lifecycle !== 'playing') continue
      const ch = inst.channel
      if (!ch) continue
      const files = rels.map((r) => join(inst.projectPath, r))
      try {
        ch.appendCommand({ target: inst.worldId, kind: 'hotReloadPatch', args: { files } })
        debugLog(`[unity] hot-patch → clone ${inst.worldId} (${files.length} file(s))`)
      } catch (e) {
        console.log(`[unity] hot-patch push to ${inst.worldId} failed: ${(e as Error).message}`)
      }
    }
  }

  private stopAssetWatch(inst: Instance): void {
    if (inst.assetWatcher) {
      inst.assetWatcher.stop()
      inst.assetWatcher = null
      this.dirtyTrackers.delete(inst.realProjectPath)
    }
    if (inst.hotReloadLogSub) {
      inst.hotReloadLogSub()
      inst.hotReloadLogSub = null
    }
  }

  private canonicalProjectKey(root: string): string {
    if (this.instances.has(root)) return root
    const want = comparablePath(root)
    for (const key of this.instances.keys()) if (comparablePath(key) === want) return key
    for (const key of this.managedProjects) if (comparablePath(key) === want) return key
    return root
  }

  async enqueueExec(projectPath: string, args: Record<string, unknown>): Promise<{ ok: boolean; error: string | null; cmdId?: number }> {
    const r = await this.handlePlayersCommand(projectPath, { action: 'enqueue', kind: 'exec', cmdArgs: args })
    return { ok: r.ok, error: r.error, cmdId: r.cmdId }
  }

  private async handlePlayersCommand(
    rawProjectPath: string,
    cmd: {
      requestId?: string
      action?: string
      scenePath?: string
      enterPlayMode?: boolean
      target?: string
      view?: string
      paneKey?: string
      kind?: CommandKind
      cmdArgs?: Record<string, unknown>
      video?: VideoArgs
      fpsCap?: number | null
      streamRes?: string
      wait?: number
    }
  ): Promise<{
    ok: boolean
    error: string | null
    note: string | null
    players: PlayerInfo[]
    stopped: boolean
    cmdId?: number
    retryable?: boolean
    editor?: EditorWaitState
    lifecycle?: UnityLifecycle
    lifecycleText?: string
    video?: Record<string, unknown>
    fps?: Record<string, unknown>[]
    streams?: Record<string, unknown>[]
  }> {
    const realProjectPath = this.canonicalProjectKey(rawProjectPath)
    let ok = false
    let error: string | undefined
    let note: string | undefined
    let video: Record<string, unknown> | undefined
    let fps: Record<string, unknown>[] | undefined
    let streams: Record<string, unknown>[] | undefined
    let missing: TunerMissingTarget[] | undefined
    let cmdId: number | undefined
    let retryable = false
    try {
      if (this.stops.isStopped(realProjectPath) && !ALLOWED_WHILE_STOPPED.has(cmd.action ?? '')) {
        error = STOPPED_COMMAND_ERROR
      } else if (cmd.action === 'status') {
        ok = true
      } else if (cmd.action === 'scene') {
        if (this.groupWorking(realProjectPath) || this.isTearingDown(realProjectPath))
          error = 'Players are still loading — wait until the group is idle to switch scenes.'
        else {
          const all = this.orderedInstances(realProjectPath)
          if (!all.length) error = 'No players running'
          else {
            for (const inst of all) {
              const forceReload = !!cmd.scenePath && !cmd.enterPlayMode
              const base = worldStore.getWorld(realProjectPath).desired.instances[inst.worldId]
              const bumped = (base?.sceneGen ?? 0) + 1
              worldStore.setDesired(realProjectPath, {
                instances: {
                  [inst.worldId]: {
                    ...(cmd.scenePath ? { scene: cmd.scenePath } : {}),
                    ...(forceReload ? { sceneGen: bumped, sceneForceGen: bumped } : {}),
                    ...(cmd.enterPlayMode ? { playing: true } : {})
                  }
                }
              })
            }
            ok = true
          }
        }
      } else if (cmd.action === 'scene_wait') {
        const w = worldStore.getWorld(realProjectPath)
        const all = this.orderedInstances(realProjectPath)
        if (!all.length) error = 'No players running'
        else {
          const failed = all.map((inst) => w.observed.instances[inst.worldId]?.error).find((e) => !!e)
          const loading = all.some((inst) => {
            const want = w.desired.instances[inst.worldId]
            const obs = w.observed.instances[inst.worldId]
            return !obs || (want !== undefined && obs.sceneGen < want.sceneGen) || obs.lifecycle !== 'editmode'
          })
          if (failed) error = failed
          else {
            ok = true
            note = loading ? 'loading' : 'settled'
          }
        }
      } else if (cmd.action === 'cancel_play') {
        const all = this.orderedInstances(realProjectPath)
        if (!all.length) error = 'No players running'
        else {
          for (const inst of all) worldStore.requestStop(realProjectPath, inst.worldId)
          ok = true
          note = 'Pending Play intent cancelled; any player already in Play Mode is being stopped.'
        }
      } else if (cmd.action === 'stop') {
        const w = worldStore.getWorld(realProjectPath)
        const pending = w.desired.playerCount > Object.keys(w.observed.instances).length
        const loadingIntoPlay = Object.entries(w.desired.instances).some(([id, d]) => {
          const lc = w.observed.instances[id]?.lifecycle
          return d.playing && (lc === 'editmode' || lc === 'entering-play')
        })
        if (
          this.groupWorking(realProjectPath) ||
          this.isTearingDown(realProjectPath) ||
          pending ||
          loadingIntoPlay
        )
          error = 'Players are still loading — wait until every player is up before stopping.'
        else {
          const all = this.orderedInstances(realProjectPath)
          for (const inst of all) worldStore.requestStop(realProjectPath, inst.worldId)
          ok = true
        }
      } else if (cmd.action === 'stop_editor') {
        if (this.stops.isStopped(realProjectPath)) {
          ok = true
          note = 'Unity is already stopped.'
        } else if (!this.instances.has(realProjectPath) && !this.launching.has(realProjectPath)) {
          error = 'No Unity editor is running for this project'
        } else {
          const r = await this.stopProject(realProjectPath)
          ok = r.ok
          error = r.error
          if (ok) note = 'Unity stopped. It stays stopped across app restarts until it is relaunched.'
        }
      } else if (cmd.action === 'relaunch') {
        const wait = Number(cmd.wait) || 0
        if (wait > 0 && this.relaunchWaiter) {
          const r = await this.relaunchWaiter(realProjectPath, wait * 1000)
          ok = r.ok
          error = r.error
          note = r.note
        } else {
          const r = await this.relaunchProject(realProjectPath)
          ok = r.ok
          error = r.error
          note = r.note
        }
      } else if (cmd.action === 'arm_hotreload') {
        const all = this.orderedInstances(realProjectPath)
        const targets = all.filter((inst, i) => this.matchTarget(inst, i, cmd.target))
        if (!targets.length) error = `target '${cmd.target ?? 'all'}' matched no player`
        else {
          const { observed, desired } = worldStore.getWorld(realProjectPath)
          let armed = 0
          let already = 0
          let skipped = 0
          for (const inst of targets) {
            const o = observed.instances[inst.worldId]
            const playing = o ? o.lifecycle === 'playing' || o.lifecycle === 'entering-play' : false
            if (!playing) skipped++
            else if (o?.hotReloadActive) already++
            else {
              worldStore.setDesired(realProjectPath, {
                instances: { [inst.worldId]: { hotReload: true } }
              })
              armed++
            }
          }
          if (armed === 0 && already === 0) {
            // A compile error means the reconciler will NEVER issue play, so desired.playing stays true
            // forever — reporting "still transitioning, retry shortly" there sends the caller into a
            // retry loop that cannot succeed. Name the real blocker instead.
            const blocked = targets.some((inst) => observed.instances[inst.worldId]?.compile === 'error')
            const transitioning =
              !blocked && targets.some((inst) => desired.instances[inst.worldId]?.playing)
            if (blocked)
              error =
                'No targeted player is in Play Mode — a compile error is blocking Play. Fix it (see unity.logs()), then enter Play and arm.'
            else if (transitioning) {
              error =
                'No targeted player is in Play Mode yet — the group is still transitioning into Play. Retry shortly.'
              retryable = true
            } else error = 'No targeted player is in Play Mode — enter Play first, then arm.'
          } else {
            ok = true
            const parts = [`${armed} armed`]
            if (already) parts.push(`${already} already armed`)
            if (skipped) parts.push(`${skipped} skipped (not in Play Mode)`)
            note = parts.join(', ') + '.'
          }
        }
      } else if (cmd.action === 'enqueue') {
        const kind = cmd.kind
        if (!kind) error = 'enqueue requires a kind'
        else {
          const targetId = cmd.target && cmd.target !== '*' ? cmd.target : primaryWorldId(realProjectPath)
          const inst = this.byWorldId.get(targetId)
          if (!inst || inst.exited) error = `No live editor for '${targetId}'`
          else if (TRANSIENT_COMMAND_KINDS.has(kind)) {
            let args = cmd.cmdArgs ?? {}
            const tracker = kind === 'exec' && inst.kind === 'primary' ? this.dirtyTrackers.get(realProjectPath) : undefined
            let skip = !!tracker?.execCanSkipRefresh()
            if (skip && tracker) skip = await this.execEventsSettled(realProjectPath, inst, tracker)
            if (skip) args = { ...args, skipRefresh: true }
            const id = this.reconciler.issueTransient(targetId, kind, args)
            if (id == null) error = `Could not enqueue ${kind} — editor unreachable`
            else {
              if (!skip) tracker?.execRefreshIssued()
              cmdId = id
              ok = true
            }
          } else {
            const r = await this.enqueueConvergent(realProjectPath, targetId, kind, cmd.cmdArgs ?? {})
            if (r.error) {
              error = r.error
              retryable = r.retryable ?? false
            } else {
              cmdId = r.cmdId
              ok = true
            }
          }
        }
      } else if (cmd.action === 'video') {
        const all = this.orderedInstances(realProjectPath)
        const want = cmd.target && cmd.target.trim() ? cmd.target : 'primary'
        const inst = all.find((i, n) => this.matchTarget(i, n, want))
        if (!all.length) error = 'No players running'
        else if (!inst) error = `target '${want}' matched no player`
        else {
          const r = await videoRecorder.command(inst.worldId, realProjectPath, inst.pane, cmd.video ?? {})
          ok = r.ok
          error = r.error
          note = r.note
          video = r.video
        }
      } else if (cmd.action === 'fps_cap') {
        const all = this.orderedInstances(realProjectPath)
        const want = cmd.target && cmd.target.trim() ? cmd.target : 'primary'
        const targets = all.filter((inst, i) => this.matchTarget(inst, i, want))
        if (!all.length) error = 'No players running'
        else if (!targets.length) error = `target '${want}' matched no player`
        else {
          if (cmd.fpsCap !== undefined) {
            const cap = cmd.fpsCap === null ? 0 : Number(cmd.fpsCap)
            const instances: Record<string, { fpsCap: number }> = {}
            for (const inst of targets) instances[inst.worldId] = { fpsCap: Number.isFinite(cap) ? cap : 0 }
            worldStore.setDesired(realProjectPath, { instances })
          }
          const desired = worldStore.getWorld(realProjectPath).desired
          ok = true
          fps = targets.map((inst) => ({
            player: inst.kind === 'primary' ? 'primary' : basename(inst.projectPath),
            index: all.indexOf(inst) + 1,
            dir: inst.projectPath,
            cap: desired.instances[inst.worldId]?.fpsCap ?? 0
          }))
        }
      } else if (cmd.action === 'stream_res') {
        const all = this.orderedInstances(realProjectPath)
        const want = cmd.target && cmd.target.trim() ? cmd.target : 'primary'
        const targets = all.filter((inst, i) => this.matchTarget(inst, i, want))
        const res = cmd.streamRes === undefined ? null : normalizeStreamRes(String(cmd.streamRes))
        if (!all.length) error = 'No players running'
        else if (!targets.length) error = `target '${want}' matched no player`
        else if (cmd.streamRes !== undefined && !res) error = `stream size is WIDTHxHEIGHT from ${MIN_STREAM_DIM} to ${MAX_STREAM_DIM}, like '1920x1080', got '${String(cmd.streamRes)}'`
        else {
          if (res) {
            const instances: Record<string, { streamRes: string }> = {}
            for (const inst of targets) instances[inst.worldId] = { streamRes: res }
            worldStore.setDesired(realProjectPath, { instances })
          }
          ok = true
          streams = targets.map((inst) => ({
            player: inst.kind === 'primary' ? 'primary' : basename(inst.projectPath),
            index: all.indexOf(inst) + 1,
            size: this.launchStream(inst.worldId, realProjectPath).res,
            ...(this.videoOverrides.has(inst.worldId) ? { recording: this.videoOverrides.get(inst.worldId) } : {})
          }))
        }
      } else if (cmd.action === 'open_tuner') {
        const view = typeof cmd.view === 'string' ? cmd.view : ''
        if (!isTunerViewName(view)) error = `Invalid tuner view name '${view}'`
        else {
          const primary = this.instances.get(realProjectPath)
          const fallback = primary?.subscribers.values().next().value
          const openedAt = Date.now()
          ok = openTunerInApp(
            { projectPath: realProjectPath, view, paneKey: typeof cmd.paneKey === 'string' ? cmd.paneKey : '' },
            typeof fallback === 'number' ? fallback : undefined
          )
          if (!ok) error = 'No Satura Space window is open to show the tuner'
          else {
            tunerHandedOff({ projectPath: realProjectPath, view, paneKey: typeof cmd.paneKey === 'string' ? cmd.paneKey : '' })
            note = `Tuner '${view}' opened`
            missing = (await awaitTunerMissing(realProjectPath, view, openedAt, TUNER_OPEN_WAIT_MS)) ?? undefined
          }
        }
      } else {
        error = `Unknown action: ${cmd.action ?? '(none)'}`
      }
    } catch (e) {
      error = (e as Error).message
    }
    const life = unityLifecycle.get(realProjectPath)
    return {
      ok,
      error: error ?? null,
      note: note ?? null,
      players: this.playersFor(realProjectPath),
      stopped: this.stops.isStopped(realProjectPath),
      editor: this.editorWaitState(realProjectPath, cmd.target),
      lifecycle: life,
      lifecycleText: lifecycleText(life),
      ...(cmdId !== undefined ? { cmdId } : {}),
      ...(retryable ? { retryable } : {}),
      ...(video ? { video } : {}),
      ...(fps ? { fps } : {}),
      ...(streams ? { streams } : {}),
      ...(missing ? { missing } : {})
    }
  }

  private async execEventsSettled(realProjectPath: string, inst: Instance, tracker: ProjectDirtyTracker): Promise<boolean> {
    const watcher = inst.assetWatcher
    if (watcher?.canSync() && (await watcher.sync())) return tracker.execCanSkipRefresh()
    const since = tracker.skipSince()
    if (since === null) return false
    const missed = await changedSince(realProjectPath, since - REFRESH_MTIME_SLACK_MS)
    if (missed) {
      debugLog(`[refreshgen] ${missed} changed with no file event yet; exec refreshes`)
      tracker.fileEvent()
      return false
    }
    return tracker.execCanSkipRefresh()
  }

  private async settleFileEvents(realProjectPath: string, inst: Instance): Promise<void> {
    const tracker = this.dirtyTrackers.get(realProjectPath)
    if (!tracker || tracker.needsRefresh()) return
    const watcher = inst.assetWatcher
    if (watcher?.canSync() && (await watcher.sync())) return
    const since = tracker.cleanSince()
    if (since === null || tracker.needsRefresh()) return
    const missed = await changedSince(realProjectPath, since - REFRESH_MTIME_SLACK_MS)
    if (missed) {
      debugLog(`[refreshgen] ${missed} changed with no file event yet; refreshing anyway`)
      tracker.fileEvent()
    }
  }

  private async enqueueConvergent(
    realProjectPath: string,
    targetId: string,
    kind: CommandKind,
    args: Record<string, unknown>
  ): Promise<{ cmdId?: number; error?: string; retryable?: boolean }> {
    const before = worldStore.getWorld(realProjectPath).desired.instances[targetId]
    switch (kind) {
      case 'recompile':
      case 'reload': {
        const inst = this.byWorldId.get(targetId)
        if (inst?.kind === 'primary') await this.settleFileEvents(realProjectPath, inst)
        const gen = (before?.refreshGen ?? 0) + 1
        worldStore.setDesired(realProjectPath, { instances: { [targetId]: { refreshGen: gen } } })
        const after = worldStore.getWorld(realProjectPath).desired.instances[targetId]
        if ((after?.refreshGen ?? 0) === (before?.refreshGen ?? 0)) return { cmdId: 0 }
        return this.awaitIssued(realProjectPath, targetId, kind, after!.refreshGen)
      }
      case 'loadScene': {
        const scene = typeof args.scene === 'string' ? args.scene : ''
        if (!scene) return { error: 'loadScene requires args.scene' }
        const bumped = (before?.sceneGen ?? 0) + 1
        worldStore.setDesired(realProjectPath, {
          instances: {
            [targetId]: {
              scene,
              ...(args.force === true ? { sceneGen: bumped, sceneForceGen: bumped } : {})
            }
          }
        })
        const after = worldStore.getWorld(realProjectPath).desired.instances[targetId]
        if ((after?.sceneGen ?? 0) === (before?.sceneGen ?? 0))
          return { cmdId: this.reconciler.issuedIdFor(targetId, kind, after?.sceneGen ?? 0) }
        return this.awaitIssued(realProjectPath, targetId, kind, after!.sceneGen)
      }
      case 'play':
      case 'stop': {
        worldStore.setDesired(realProjectPath, {
          instances: { [targetId]: { playing: kind === 'play' } }
        })
        const after = worldStore.getWorld(realProjectPath).desired.instances[targetId]
        if ((after?.playGen ?? 0) === (before?.playGen ?? 0))
          return { cmdId: this.reconciler.issuedIdFor(targetId, kind, after?.playGen ?? 0) }
        return this.awaitIssued(realProjectPath, targetId, kind, after!.playGen)
      }
      case 'setHotReload': {
        const enabled = args.enabled === true
        worldStore.setDesired(realProjectPath, { instances: { [targetId]: { hotReload: enabled } } })
        const obs = worldStore.getWorld(realProjectPath).observed.instances[targetId]
        if (obs && obs.hotReloadActive === enabled) return { cmdId: 0 }
        return this.awaitIssued(realProjectPath, targetId, kind, 0)
      }
      default:
        return { error: `enqueue does not support convergent kind '${kind}'` }
    }
  }

  private async awaitIssued(
    realProjectPath: string,
    targetId: string,
    kind: CommandKind,
    minGen: number
  ): Promise<{ cmdId?: number; error?: string; retryable?: boolean }> {
    for (let i = 0; i < 10; i++) {
      const id = this.reconciler.issuedIdFor(targetId, kind, minGen)
      if (id > 0) return { cmdId: id }
      await delay(50)
      this.reconciler.kick(realProjectPath)
    }
    return {
      error:
        `${kind} was recorded as desired state but the editor cannot take it yet (busy, playing, or not ` +
        'ready). It will apply automatically when the editor frees up — check unity.status() and retry.',
      retryable: true
    }
  }

  private orderedInstances(realProjectPath: string): Instance[] {
    const out: Instance[] = []
    const primary = this.instances.get(realProjectPath)
    if (primary && !primary.exited && primary.kind === 'primary') out.push(primary)
    const clones = [...this.instances.values()]
      .filter((i) => i.kind === 'clone' && i.realProjectPath === realProjectPath && !i.exited)
      .sort((a, b) => (a.cloneId ?? '').localeCompare(b.cloneId ?? '', undefined, { numeric: true }))
    out.push(...clones)
    return out
  }

  private groupWorking(realProjectPath: string): boolean {
    return this.orderedInstances(realProjectPath).some((i) => this.snapshotState(i) === 'launching')
  }

  private beginTeardown(realProjectPath: string, cloneDir: string): void {
    let set = this.tearingDown.get(realProjectPath)
    if (!set) {
      set = new Set()
      this.tearingDown.set(realProjectPath, set)
    }
    set.add(cloneDir)
  }

  private endTeardown(realProjectPath: string, cloneDir: string): void {
    const set = this.tearingDown.get(realProjectPath)
    if (!set) return
    set.delete(cloneDir)
    if (set.size === 0) this.tearingDown.delete(realProjectPath)
  }

  private isTearingDown(realProjectPath: string): boolean {
    return (this.tearingDown.get(realProjectPath)?.size ?? 0) > 0
  }

  private matchTarget(inst: Instance, index: number, target?: string): boolean {
    const t = (target ?? 'all').trim()
    if (t === '' || t === 'all') return true
    if (t === 'primary') return inst.kind === 'primary'
    if (t === 'clones') return inst.kind === 'clone'
    if (inst.kind === 'clone' && basename(inst.projectPath) === t) return true
    if (/^\d+$/.test(t)) return index + 1 === Number(t)
    return false
  }

  private readonly revealListeners = censusTrack('unity-instance-provider.revealListeners', new Set<(projectKey: string, revealed: boolean) => void>())

  onRevealChange(cb: (projectKey: string, revealed: boolean) => void): () => void {
    this.revealListeners.add(cb)
    return () => this.revealListeners.delete(cb)
  }

  isEditorRevealed(projectPath: string): boolean {
    const inst = this.instances.get(this.canonicalProjectKey(projectPath))
    return !!inst && inst.kind === 'primary' && !inst.exited && inst.revealed
  }

  private setRevealed(inst: Instance, revealed: boolean): void {
    if (inst.kind !== 'primary' || inst.revealed === revealed) return
    inst.revealed = revealed
    const projectPath = inst.realProjectPath
    for (const cb of this.revealListeners) {
      try {
        cb(projectPath, revealed)
      } catch {}
    }
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send('unity:editorRevealChanged', { projectPath, revealed })
  }

  private writeRevealWant(inst: Instance, want: boolean, bounds?: RevealBounds): void {
    inst.revealEpoch += 1
    this.setRevealed(inst, want)
    const file = sf(inst.realProjectPath, '.winhook_reveal')
    const boundsPart = bounds
      ? `,"x":${Math.round(bounds.x)},"y":${Math.round(bounds.y)},"w":${Math.round(bounds.w)},"h":${Math.round(bounds.h)}`
      : ''
    const body = `{"want":${want ? 1 : 0},"epoch":${inst.revealEpoch}${boundsPart}}`
    guardSspace(inst.realProjectPath)
    try {
      const tmp = `${file}.tmp`
      writeFileSync(tmp, body)
      renameSync(tmp, file)
    } catch {
      try {
        writeFileSync(file, body)
      } catch {}
    }
  }

  private resolveRevealTarget(projectPath: string): { inst?: Instance; error?: string } {
    const inst = this.instances.get(projectPath)
    if (!inst || inst.exited || inst.kind !== 'primary') return { error: 'no running primary' }
    return this.checkRevealAllowed(inst)
  }

  private checkRevealAllowed(inst: Instance): { inst?: Instance; error?: string } {
    if (this.snapshotState(inst) === 'launching') return { error: 'instance is launching' }
    if (this.isTearingDown(inst.realProjectPath)) return { error: 'a player is shutting down' }
    const obs = worldStore.getWorld(inst.realProjectPath).observed.instances[inst.worldId]
    if (obs && TRANSITIONAL_LIFECYCLES.has(obs.lifecycle))
      return { error: `busy (${obs.lifecycle})` }
    return { inst }
  }

  revealEditor(projectPath: string, bounds?: RevealBounds): { ok: boolean; error?: string } {
    const { inst, error } = this.resolveRevealTarget(projectPath)
    if (!inst) return { ok: false, error }
    this.writeRevealWant(inst, true, bounds)
    debugLog(`[unity] reveal editor world=${inst.worldId} epoch=${inst.revealEpoch}`)
    return { ok: true }
  }

  async hideEditor(
    projectPath: string,
    opts: { force?: boolean } = {}
  ): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
    const { inst, error } = this.resolveRevealTarget(projectPath)
    if (!inst) return { ok: false, error }
    if (opts.force || !inst.revealed) {
      this.writeRevealWant(inst, false)
      debugLog(`[unity] hide editor world=${inst.worldId} epoch=${inst.revealEpoch}${opts.force ? ' forced' : ''}`)
      return { ok: true }
    }
    if (inst.hidePending) return inst.hidePending
    const run = async (): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> => {
      const epoch = inst.revealEpoch
      const main = await this.leaveEditorStage(inst)
      if (inst.exited || inst.disposed) return { ok: false, error: 'no running primary' }
      if (inst.revealEpoch !== epoch || !inst.revealed) return { ok: true }
      if (main === false) {
        console.log(`[unity] hide editor canceled world=${inst.worldId}: still in Prefab Mode`)
        return { ok: false, cancelled: true, error: 'Hide canceled: the editor is still in Prefab Mode' }
      }
      this.writeRevealWant(inst, false)
      debugLog(`[unity] hide editor world=${inst.worldId} epoch=${inst.revealEpoch}`)
      return { ok: true }
    }
    inst.hidePending = run().finally(() => {
      inst.hidePending = null
    })
    return inst.hidePending
  }

  private async leaveEditorStage(inst: Instance): Promise<boolean | null> {
    const client = new UnityControlClient(inst.controlPort)
    try {
      const deadline = Date.now() + 3000
      while (!client.isConnected && Date.now() < deadline && !inst.exited)
        await new Promise((r) => setTimeout(r, 50))
      if (!client.isConnected) return null
      const r = await client.command('editor/leaveStage', {}, 2_147_483_647)
      if (!r || r.status !== 'completed') return null
      return r.mainStage !== false
    } finally {
      client.close()
    }
  }

  stepFrame(projectPath: string): { ok: boolean; error?: string } {
    const inst = this.instances.get(projectPath)
    if (!inst || inst.exited) return { ok: false, error: 'no running primary' }
    const observed = worldStore.getWorld(inst.realProjectPath).observed
    let issued = 0
    for (const [wid, obs] of Object.entries(observed.instances)) {
      if (obs.lifecycle !== 'playing') continue
      if (this.reconciler.issueTransient(wid, 'step', {}) != null) issued++
    }
    if (issued === 0) return { ok: false, error: 'no player in Play Mode' }
    debugLog(`[unity] step frame project=${inst.realProjectPath} instances=${issued}`)
    return { ok: true }
  }

  primaryControl(
    projectPath: string
  ): { projectKey: string; port: number; alive: boolean; pid: number | undefined } | null {
    const key = this.canonicalProjectKey(projectPath)
    const primary = this.instances.get(key)
    if (!primary || primary.kind !== 'primary') return null
    return { projectKey: key, port: primary.controlPort, alive: !primary.exited && !primary.disposed, pid: primary.proc?.pid }
  }

  async closeExternalEditor(projectPath: string, force = false): Promise<{ ok: boolean; error?: string }> {
    if (!projectPath) return { ok: false, error: 'No project path' }
    const lock = join(projectPath, 'Temp', 'UnityLockfile')
    if (!existsSync(lock)) return { ok: true }
    if (process.platform === 'win32')
      return { ok: false, error: 'Close the other Unity manually on Windows.' }
    let stdout: string
    try {
      stdout = (await execFileAsync('lsof', ['-t', lock], { encoding: 'utf8', timeout: 3000 })).stdout
    } catch (e) {
      const err = e as { code?: unknown; stdout?: unknown }
      if (typeof err.code !== 'number') return { ok: false, error: 'Could not find the other Unity process.' }
      stdout = typeof err.stdout === 'string' ? err.stdout : ''
    }
    const pids = stdout
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid)
    if (pids.length === 0) return { ok: true }
    const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM'
    for (const pid of pids) {
      try {
        process.kill(pid, signal)
      } catch {}
    }
    return { ok: true }
  }

  getUnityMode(projectPath: string): UnityMode {
    return readUnityModePref(projectPath)
  }

  activeUnityMode(projectPath: string): UnityMode {
    const inst = this.instances.get(this.canonicalProjectKey(projectPath))
    return inst && !inst.exited ? inst.unityMode : readUnityModePref(projectPath)
  }

  async setUnityMode(projectPath: string, mode: UnityMode): Promise<UnityStartResult> {
    if (!projectPath) return { ok: false, error: 'No project path' }
    writeUnityModePref(projectPath, mode)
    const inst = this.instances.get(this.canonicalProjectKey(projectPath))
    debugLog(
      `[mode] setUnityMode ${projectPath} -> ${mode}; running=${!!inst} kind=${inst?.kind} exited=${inst?.exited} instMode=${inst?.unityMode}`
    )
    if (!inst || inst.kind !== 'primary' || inst.exited) return { ok: true }
    if (inst.unityMode === mode) return { ok: true }
    return this.restartInstance(inst, { resetScene: false })
  }

  async restart(id: string): Promise<UnityStartResult> {
    const projectPath = this.subIndex.get(id)
    if (!projectPath) {
      const parkedIn = this.stops.projectOf(id)
      if (parkedIn && this.stops.isStopped(parkedIn)) return STOPPED_RESULT
      return { ok: false, error: 'No running instance to restart' }
    }
    const old = this.instances.get(projectPath)
    if (!old) return { ok: false, error: 'No running instance to restart' }
    return this.restartInstance(old, { resetScene: true })
  }

  async restartProject(projectPath: string): Promise<UnityStartResult> {
    const inst = this.instances.get(this.canonicalProjectKey(projectPath))
    if (!inst || inst.kind !== 'primary') return { ok: false, error: 'No running instance to restart' }
    return this.restartInstance(inst, { resetScene: true })
  }

  private async restartInstance(
    old: Instance,
    opts: { resetScene?: boolean } = {}
  ): Promise<UnityStartResult> {
    this.ensureWorld()
    if (this.stops.isStopped(old.realProjectPath)) {
      console.log(`[unity] restart ${old.worldId} refused: ${old.realProjectPath} is stopped`)
      return STOPPED_RESULT
    }
    const missing = missingEditor(old.realProjectPath, 'restart')
    if (missing) {
      if (old.kind === 'primary') {
        this.relaunchPending.add(old.realProjectPath)
        this.managedProjects.add(old.realProjectPath)
        this.ensureMcpControlServer()
        this.publishOrchestratorFile(old.realProjectPath)
        unityLifecycle.refresh(old.realProjectPath, true)
      }
      return missing
    }
    const editor = this.resolveEditor(old.realProjectPath)
    if (!editor) return { ok: false, error: 'Could not read the Unity version from ProjectSettings/ProjectVersion.txt' }
    const hub = await hubBlock('restart')
    if (hub) return hub
    if (old.kind === 'primary') this.relaunchPending.delete(old.realProjectPath)

    const subs = new Map(old.subscribers)
    const scene = opts.resetScene
      ? (readLastScene(old.realProjectPath) ?? SCENE)
      : this.currentScene(old.realProjectPath, SCENE)
    old.restarting = true
    worldStore.setMainSignal(old.worldId, { restarting: true })
    this.instances.delete(old.projectPath)

    const ports = (fresh: Instance): UnityStartResult => ({
      ok: true,
      mediaPort: fresh.mediaPort,
      inputPort: fresh.inputPort
    })

    if (old.kind === 'clone') {
      const realProjectPath = old.realProjectPath
      this.beginTeardown(realProjectPath, old.projectPath)
      const relaunchClone = (async (): Promise<Instance> => {
        await this.shutdown(old)
        const fresh = await this.launchClone(realProjectPath, editor, old.cloneId!, scene)
        fresh.subscribers = subs
        fresh.pane = old.pane
        this.instances.set(fresh.projectPath, fresh)
        return fresh
      })()
      this.launching.set(old.projectPath, relaunchClone)
      try {
        const fresh = await relaunchClone
        for (const [unityId, wcId] of subs) worldStore.resyncSubscriber(realProjectPath, unityId, wcId)
        return ports(fresh)
      } catch (e) {
        if (e instanceof LaunchFailure) return e.result
        throw e
      } finally {
        if (this.launching.get(old.projectPath) === relaunchClone) this.launching.delete(old.projectPath)
        this.endTeardown(realProjectPath, old.projectPath)
      }
    }

    const projectPath = old.projectPath
    const relaunch = (async (): Promise<Instance> => {
      await Promise.all([this.shutdownClonesOf(projectPath), this.shutdown(old)])
      if (await isProjectLockedLive(projectPath)) {
        throw new LaunchFailure({
          ok: false,
          standalone: true,
          code: 'locked',
          error: 'Another Unity is open on this project. Close it, then relaunch.'
        })
      }
      const fresh = await this.launch(projectPath, editor, scene)
      fresh.subscribers = subs
      fresh.pane = old.pane
      fresh.primaryId = old.primaryId
      this.instances.set(projectPath, fresh)
      return fresh
    })()
    this.launching.set(projectPath, relaunch)
    this.launchBlocked.delete(projectPath)
    unityLifecycle.refresh(projectPath)
    try {
      const fresh = await relaunch
      for (const [unityId, wcId] of subs) worldStore.resyncSubscriber(projectPath, unityId, wcId)
      return ports(fresh)
    } catch (e) {
      const result: UnityStartResult = e instanceof LaunchFailure ? e.result : { ok: false, error: (e as Error).message }
      if (!result.hub && !result.missing)
        this.launchBlocked.set(projectPath, blockedOf(result, 'Unity failed to restart.'))
      console.log(`[unity] restart of ${projectPath} failed: ${result.error ?? 'unknown'}`)
      if (e instanceof LaunchFailure) return e.result
      throw e
    } finally {
      if (this.launching.get(projectPath) === relaunch) this.launching.delete(projectPath)
      unityLifecycle.refresh(projectPath)
    }
  }

  private restartByWorldId(worldId: string): Promise<unknown> {
    const i = this.byWorldId.get(worldId)
    return i ? this.restartInstance(i) : Promise.resolve({ ok: false })
  }

  private killByWorldId(worldId: string): Promise<unknown> {
    const i = this.byWorldId.get(worldId)
    return i ? this.killInstance(i.projectPath) : Promise.resolve(false)
  }

  private async launchPrimary(realProjectPath: string): Promise<{ ok: boolean; error?: string }> {
    this.ensureWorld()
    const integrityError = this.validateProjectIntegrity(realProjectPath)
    if (integrityError) {
      return { ok: false, error: integrityError }
    }
    const existing = this.instances.get(realProjectPath)
    if (existing && !existing.exited) return { ok: true }
    this.stops.resume(realProjectPath)
    try {
      await this.acquirePrimary(realProjectPath)
      return { ok: true }
    } catch (e) {
      const result: UnityStartResult = e instanceof LaunchFailure ? e.result : { ok: false, error: (e as Error).message }
      if (!result.hub && !result.missing)
        this.launchBlocked.set(realProjectPath, blockedOf(result, 'Unity failed to start.'))
      unityLifecycle.refresh(realProjectPath)
      return { ok: false, error: result.error ?? (e as Error).message }
    }
  }

  setHotReload(id: string, enabled: boolean): void {
    const inst = this.instanceFor(id)
    if (!inst) return
    worldStore.setDesired(inst.realProjectPath, { instances: { [inst.worldId]: { hotReload: enabled } } })
  }

  refresh(id: string): void {
    const inst = this.instanceFor(id)
    if (!inst) return
    const primary = inst.kind === 'primary' ? inst : this.instances.get(inst.realProjectPath)
    if (!primary || primary.kind !== 'primary' || this.dead(primary)) return
    const cur =
      worldStore.getWorld(inst.realProjectPath).desired.instances[primary.worldId]?.refreshGen ?? 0
    worldStore.setDesired(inst.realProjectPath, {
      instances: { [primary.worldId]: { refreshGen: cur + 1 } }
    })
  }

  private dead(inst: Instance): boolean {
    return inst.exited || inst.disposed
  }

  private teardownQueue(inst: Instance): void {
    inst.disposed = true
    this.stopWatchdog(inst)
    if (inst.streamPushTimer) {
      clearTimeout(inst.streamPushTimer)
      inst.streamPushTimer = null
    }
    this.stopCommandWatch(inst)
    this.stopAssetWatch(inst)
    this.stopLaunchProgress(inst)
    const was = inst.gate.dispose()
    inst.holds.reset()
    releaseHeld(inst.worldId)
    debugLog(`[stream] ${inst.worldId}: ${was ? `gen ${was.generation} ` : ''}-> disposed`)
  }

  isProject(projectPath: string): boolean {
    if (!projectPath) return false
    try {
      return (
        existsSync(join(projectPath, 'Assets')) &&
        existsSync(join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'))
      )
    } catch {
      return false
    }
  }

  private validateProjectIntegrity(projectPath: string): string | null {
    if (!projectPath) return 'No project path was provided.'
    const assets = join(projectPath, 'Assets')
    if (!existsSync(assets)) return `Not a Unity project: ${projectPath} has no Assets folder.`
    let assetEntries: string[]
    try {
      assetEntries = readdirSync(assets)
    } catch (e) {
      return `Could not read ${assets}: ${(e as Error).message}`
    }
    if (assetEntries.length === 0)
      return (
        `Refusing to launch: ${assets} is empty. The project looks uninitialized or its ` +
        `files are missing — launching now could let Unity overwrite it as a blank project. ` +
        `Restore the project (e.g. from version control) before launching.`
      )
    const versionTxt = join(projectPath, 'ProjectSettings', 'ProjectVersion.txt')
    if (!existsSync(versionTxt))
      return `Not a Unity project: ${projectPath} has no ProjectSettings/ProjectVersion.txt.`
    const { version } = readProjectVersion(projectPath)
    if (!version || /^Unknown/i.test(version))
      return (
        `Refusing to launch: ${versionTxt} reports version "${version || '(empty)'}", which means ` +
        `the project is uninitialized or corrupted. Restore ProjectVersion.txt before launching.`
      )
    return null
  }

  async listScenes(projectPath: string): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdirAsync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const p = join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.name.endsWith('.unity')) out.push(relative(projectPath, p))
      }
    }
    await walk(join(projectPath, 'Assets'))
    return out.sort()
  }

  private writeTrigger(projectPath: string, name: string, content: string, secret = false): void {
    try {
      this.ensureSspace(projectPath)
      if (secret) writePrivateFile(sf(projectPath, name), content)
      else writeFileSync(sf(projectPath, name), content)
    } catch (e) {
      console.log(`[unity] failed to write ${name}: ${(e as Error).message}`)
    }
  }

  private sendUdp(inst: Instance, payload: Buffer): void {
    if (inst.exited || inst.disposed) return
    try {
      inst.send.send(payload, inst.inputPort, '127.0.0.1')
    } catch {
    }
  }

  sendInput(id: string, json: string): void {
    const inst = this.instanceFor(id)
    if (inst) this.sendUdp(inst, Buffer.from(json))
  }

  sendInputToWorld(worldId: string, payload: Buffer): boolean {
    const inst = this.byWorldId.get(worldId)
    if (!inst || inst.exited || inst.disposed) return false
    this.sendUdp(inst, payload)
    return true
  }

  worldControl(worldId: string): { port: number; projectPath: string; realProjectPath: string; kind: 'primary' | 'clone'; alive: boolean } | null {
    const inst = this.byWorldId.get(worldId)
    if (!inst) return null
    return { port: inst.controlPort, projectPath: inst.projectPath, realProjectPath: inst.realProjectPath, kind: inst.kind, alive: !inst.exited && !inst.disposed }
  }

  cursorStateOf(worldId: string): { locked: boolean; visible: boolean } | null {
    return this.byWorldId.get(worldId)?.cursorState ?? null
  }

  onCursorState(cb: (worldId: string, state: { locked: boolean; visible: boolean }) => void): () => void {
    this.cursorListeners.add(cb)
    return () => this.cursorListeners.delete(cb)
  }

  private launchStream(worldId: string, realProjectPath: string): { res: string } {
    const d = worldStore.getWorld(realProjectPath).desired
    const want = d.instances[worldId]
    const base = d.instances[primaryWorldId(realProjectPath)]
    const mode = want?.streamRes ?? base?.streamRes ?? DEFAULT_STREAM_RES
    const res = formatSize(streamSizeFor(mode))
    return { res }
  }

  private syncFpsCap(inst: Instance): void {
    if (inst.exited || inst.disposed) return
    const cap = worldStore.getWorld(inst.realProjectPath).desired.instances[inst.worldId]?.fpsCap ?? 0
    if (cap === inst.fpsCap) return
    inst.fpsCap = cap
    const file = sf(inst.projectPath, FPS_CAP_FILE)
    try {
      if (cap > 0) {
        this.ensureSspace(inst.projectPath)
        writeFileSync(file, String(cap))
      } else rmSafe(file)
    } catch (e) {
      console.log(`[unity] fps cap ${inst.worldId} write failed: ${(e as Error).message}`)
    }
    debugLog(`[unity] fps cap ${inst.worldId} ${cap > 0 ? cap : 'off'}`)
    this.sendUdp(inst, Buffer.from(JSON.stringify({ fpsCap: cap })))
  }

  private sendStreamControl(inst: Instance, res: string): void {
    inst.baseRes = res
    inst.streamSig = ''
    this.pushStreamControl(inst)
  }

  private pushStreamControl(inst: Instance): void {
    let best: { pane: PixelSize; area: number } | null = null
    for (const h of inst.viewHints.values()) {
      if (!h.visible || h.width <= 0 || h.height <= 0) continue
      const pane = { width: Math.round(h.width), height: Math.round(h.height) }
      const area = pane.width * pane.height
      if (!best || area > best.area) best = { pane, area }
    }
    if (best) {
      inst.pane = best.pane
      this.lastPane.set(inst.worldId, best.pane)
    }
    const forced = this.videoOverrides.get(inst.worldId)
    const res = forced ?? formatSize(streamSizeFor(inst.baseRes))
    if (inst.streamSig === res) return
    if (res !== inst.resCandidate) {
      inst.resCandidate = res
      inst.resCandidateAt = Date.now()
    }
    const prevRes = inst.streamSig === '' ? null : inst.streamSig
    if (prevRes != null && res !== prevRes && !forced) {
      const quietFor = Date.now() - inst.resCandidateAt
      if (quietFor < STREAM_RES_SETTLE_MS) {
        if (inst.streamPushTimer) clearTimeout(inst.streamPushTimer)
        inst.streamPushTimer = setTimeout(() => {
          inst.streamPushTimer = null
          if (inst.exited || inst.disposed) return
          this.pushStreamControl(inst)
        }, STREAM_RES_SETTLE_MS - quietFor + 20)
        return
      }
    }
    inst.streamSig = res
    debugLog(
      `[unity] stream ${inst.worldId} res=${res}${forced ? ' (video recording)' : ''} mode=${inst.baseRes} pane=${formatSize(inst.pane)}`
    )
    if (inst.fpsCap >= 0) this.sendUdp(inst, Buffer.from(JSON.stringify({ fpsCap: inst.fpsCap })))
    this.sendUdp(inst, Buffer.from(JSON.stringify({ streamRes: res })))
  }

  setViewHint(id: string, hint: ViewHint): void {
    const inst = this.instanceFor(id)
    if (!inst) return
    inst.viewHints.set(id, hint)
    if (inst.live) this.pushStreamControl(inst)
  }

  sendPing(id: string, pingId: number): void {
    const inst = this.instanceFor(id)
    if (inst) this.sendUdp(inst, Buffer.from(JSON.stringify({ ping: pingId })))
  }

  private applyDesiredStream(inst: Instance): void {
    const d = worldStore.getWorld(inst.realProjectPath).desired
    const want = d.instances[inst.worldId]
    const base = d.instances[primaryWorldId(inst.realProjectPath)]
    this.sendStreamControl(inst, want?.streamRes ?? base?.streamRes ?? DEFAULT_STREAM_RES)
  }

  sharedHold(id: string, wcId: number, gen: number, upTo: number, held: number[]): void {
    const inst = id.startsWith('video:') ? this.byWorldId.get(id.slice(6)) : id.startsWith('rv:') ? this.byWorldId.get(id.slice(3)) : this.instanceFor(id)
    if (!inst || !inst.holds.ack(`${wcId}:${id}`, gen, upTo, held)) return
    this.pushHeld(inst)
  }

  private holdConsumers(inst: Instance): string[] {
    return [...remoteVideo.subscribersFor(inst.worldId, videoRecorder.subscribersFor(inst.worldId, inst.subscribers))]
      .filter(([, wcId]) => wcId >= 0)
      .map(([id, wcId]) => `${wcId}:${id}`)
  }

  private pushHeld(inst: Instance): void {
    const msg = inst.holds.message(this.holdConsumers(inst))
    if (msg) this.sendUdp(inst, Buffer.from(JSON.stringify(msg)))
  }

  consumersChanged(worldId: string): void {
    const inst = this.byWorldId.get(worldId)
    if (inst && !inst.exited && !inst.disposed) this.pushHeld(inst)
  }

  private stopStream(inst: Instance, why: string): void {
    const was = inst.gate.stop()
    inst.holds.reset()
    releaseHeld(inst.worldId)
    if (was) debugLog(`[stream] ${inst.worldId}: gen ${was.generation} ${was.width}x${was.height} -> idle (${why})`)
  }

  frameHolds(): { worldId: string; phase: string; generation: number | null; size: string; lastSeq: number; accepted: number; rejected: Record<string, number>; consumers: string[]; sent: string; lateFrames: number }[] {
    return [...this.instances.values()].map((i) => ({
      worldId: i.worldId,
      phase: i.gate.phase,
      generation: i.gate.identity?.generation ?? null,
      size: i.gate.identity ? `${i.gate.identity.width}x${i.gate.identity.height}` : '',
      lastSeq: i.gate.lastSeq,
      accepted: i.gate.accepted,
      rejected: { ...i.gate.rejected },
      consumers: i.holds.consumersWithAcks(),
      sent: i.holds.lastSent,
      lateFrames: Object.values(i.gate.rejected).reduce((a, b) => a + b, 0)
    }))
  }

  resendShared(id: string, wcId: number): void {
    const inst = this.instanceFor(id)
    if (inst) resendSurface(inst.worldId, wcId)
  }

  markLive(id: string): void {
    const inst = this.instanceFor(id)
    if (!inst || inst.live) return
    inst.live = true
    if (inst.kind === 'clone' && inst.cloneId) this.cloneFailCount.delete(inst.cloneId)
    this.applyDesiredStream(inst)
  }

  private quitTargets(): Instance[] {
    return [...new Set([...this.instances.values(), ...this.liveEditors])]
  }

  private requestQuitAll(insts: Instance[], asked: Set<Instance>): void {
    for (const inst of insts) {
      if (asked.has(inst)) continue
      asked.add(inst)
      this.teardownQueue(inst)
      try {
        inst.socketChannel?.close()
      } catch {
      }
      if (!inst.exited) {
        try {
          guardSspace(inst.projectPath)
          writeFileSync(sf(inst.projectPath, '.mcp_quit_trigger.json'), '{}')
        } catch {
        }
      }
    }
  }

  private noteClosingAll(): void {
    if (this.closingAll) return
    this.closingAll = true
    for (const pp of [...this.instances.keys()]) {
      unityLifecycle.cause(pp, 'Satura Space is quitting')
      unityLifecycle.cause(pp, null)
    }
  }

  async gracefulKillAll(): Promise<void> {
    this.quitting = true
    this.noteClosingAll()
    if (this.streamReassert) {
      clearInterval(this.streamReassert)
      this.streamReassert = null
    }
    this.reconciler?.dispose()
    const started = Date.now()
    const asked = new Set<Instance>()
    this.requestQuitAll(this.quitTargets(), asked)
    const inFlight = [...this.launching.values()]
    if (inFlight.length) {
      console.log(`[unity] quit: waiting for ${inFlight.length} launch(es) in flight`)
      await Promise.race([Promise.allSettled(inFlight), delay(UNITY_QUIT_TIMINGS.launchSettleMs)])
    }
    this.requestQuitAll(this.quitTargets(), asked)
    const insts = [...asked]
    const deadline = started + UNITY_QUIT_TIMINGS.graceMs
    while (Date.now() < deadline && insts.some((i) => !i.exited)) await delay(150)
    const clean = insts.filter((i) => i.exited).length
    console.log(`[unity] graceful shutdown: ${clean}/${insts.length} editor(s) exited cleanly`)
    for (const inst of this.quitTargets()) if (!asked.has(inst)) insts.push(inst)
    for (const inst of insts) {
      if (inst.exited) continue
      try {
        inst.proc?.kill('SIGKILL')
      } catch {
      }
    }
    const killDeadline = Date.now() + UNITY_QUIT_TIMINGS.killWaitMs
    while (Date.now() < killDeadline && insts.some((i) => !i.exited)) await delay(150)
    this.finalizeKill(insts)
    this.dropStoppedMarkers()
    console.log(`[unity] quit teardown finished in ${Date.now() - started}ms`)
  }

  killAllNow(): void {
    this.quitting = true
    this.noteClosingAll()
    const insts = this.quitTargets()
    for (const inst of insts) {
      if (inst.exited) continue
      try {
        inst.proc?.kill('SIGKILL')
      } catch {
      }
    }
    if (!this.finalized) this.finalizeKill(insts)
  }

  async detachAllForUpdate(): Promise<void> {
    this.quitting = true
    if (this.streamReassert) {
      clearInterval(this.streamReassert)
      this.streamReassert = null
    }
    this.reconciler?.dispose()
    const insts = [...this.instances.values()]
    const records: HandoffInstance[] = []
    for (const inst of insts) {
      const pid = inst.proc?.pid
      if (!inst.exited && !inst.disposed && !inst.failed && pid) {
        records.push({
          projectPath: inst.projectPath,
          realProjectPath: inst.realProjectPath,
          kind: inst.kind,
          worldId: inst.worldId,
          ...(inst.cloneId ? { cloneId: inst.cloneId } : {}),
          mediaPort: inst.mediaPort,
          inputPort: inst.inputPort,
          controlPort: inst.controlPort,
          controlToken: inst.controlToken,
          logPath: inst.logPath,
          pid,
          unityMode: inst.unityMode
        })
      }
      this.teardownInstanceResources(inst)
    }
    writeUpdateHandoff(records)
    setJobKillOnClose(false)
    this.instances.clear()
    this.subIndex.clear()
    this.byWorldId.clear()
    this.dropStoppedMarkers()
    console.log(`[unity] detached for update: ${records.length} editor(s) left running`)
  }

  private dropStoppedMarkers(): void {
    for (const pp of this.managedProjects) if (!this.commandPolls.has(pp)) rmSafe(sf(pp, ORCHESTRATOR_FILE))
  }

  private finalizeKill(insts: Instance[]): void {
    this.finalized = true
    const realProjects = new Set<string>()
    for (const inst of insts) {
      inst.exited = true
      inst.worldWatchStop?.()
      worldStore.detachInstance(inst.worldId)
      try {
        inst.proc?.kill('SIGKILL')
      } catch {
      }
      try {
        inst.recv.close()
      } catch {
      }
      try {
        inst.send.close()
      } catch {
      }
      rmSafe(sf(inst.projectPath, '.mcp_quit_trigger.json'))
      rmSafe(join(inst.projectPath, 'Temp', 'UnityLockfile'))
      realProjects.add(inst.realProjectPath)
      if (inst.kind === 'clone') {
        this.removeCloneDir(inst.projectPath)
      } else {
        clearProjectState(inst.projectPath)
      }
    }
    if (process.platform !== 'win32') {
      for (const realProjectPath of realProjects) {
        try {
          this.reapCloneProcessesSync(join(realProjectPath, 'Library', 'VP'))
        } catch {
        }
      }
    }
    this.instances.clear()
    this.subIndex.clear()
    this.byWorldId.clear()
    this.cloneFailCount.clear()
    this.reconciler?.dispose()
  }

  listInstances(): {
    id: string
    projectPath: string
    realProjectPath: string
    kind: 'primary' | 'clone'
    pid: number | null
    live: boolean
  }[] {
    return [...this.instances.values()].map((i) => ({
      id: i.worldId,
      projectPath: i.projectPath,
      realProjectPath: i.realProjectPath,
      kind: i.kind,
      pid: i.proc?.pid ?? null,
      live: i.live
    }))
  }

  subscriptions(): {
    sessions: Record<string, string>
    instances: { projectPath: string; primaryId: string | null; subscribers: string[]; pid: number | null; live: boolean; lateFrames: number }[]
  } {
    return {
      sessions: Object.fromEntries(this.subIndex),
      instances: [...this.instances.values()].map((i) => ({
        projectPath: i.projectPath,
        primaryId: i.primaryId ?? null,
        subscribers: [...i.subscribers.keys()],
        pid: i.proc?.pid ?? null,
        live: i.live,
        lateFrames: Object.values(i.gate.rejected).reduce((a, b) => a + b, 0)
      }))
    }
  }

  async killInstance(projectPath: string): Promise<boolean> {
    const inst = this.instances.get(projectPath)
    if (!inst) return false
    const subscribers = [...inst.subscribers]
    this.instances.delete(projectPath)
    for (const subId of inst.subscribers.keys()) this.subIndex.delete(subId)
    if (inst.kind === 'primary') {
      this.reconciler?.untrack(projectPath)
      await Promise.all([this.shutdownClonesOf(inst.projectPath), this.shutdown(inst)])
    } else {
      await this.shutdown(inst)
    }
    for (const [unityId, wcId] of subscribers) worldStore.resyncSubscriber(inst.realProjectPath, unityId, wcId)
    return true
  }

  stopProject(projectPath: string): Promise<{ ok: boolean; error?: string }> {
    if (!projectPath) return Promise.resolve({ ok: false, error: 'No project path' })
    const pending = this.stopping.get(projectPath)
    if (pending) return pending
    const run = this.runStopProject(projectPath).finally(() => {
      if (this.stopping.get(projectPath) === run) this.stopping.delete(projectPath)
    })
    this.stopping.set(projectPath, run)
    return run
  }

  private primarySubscribers(projectPath: string): Array<[string, number]> {
    const primary = this.instances.get(projectPath)
    return primary && primary.kind === 'primary' ? [...primary.subscribers] : []
  }

  private async runStopProject(projectPath: string): Promise<{ ok: boolean; error?: string }> {
    this.ensureWorld()
    const started = Date.now()
    const running = this.orderedInstances(projectPath).length
    console.log(`[unity] stop requested for ${projectPath} (${running} editor(s))`)
    this.stops.begin(projectPath, this.primarySubscribers(projectPath))
    try {
      const vpRoot = join(projectPath, 'Library', 'VP') + sep
      for (const [key, launch] of [...this.launching]) {
        if (key !== projectPath && !key.startsWith(vpRoot)) continue
        await launch.catch(() => undefined)
      }
      this.stops.park(projectPath, this.primarySubscribers(projectPath))
      await this.killInstance(projectPath)
      await this.shutdownClonesOf(projectPath)
    } finally {
      this.stops.finish(projectPath)
      this.syncStoppedMarker(projectPath)
    }
    console.log(`[unity] stopped ${projectPath} in ${Date.now() - started}ms`)
    return { ok: true }
  }

  async releaseForProjectPath(projectPath: string): Promise<void> {
    const norm = projectPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (!norm) return
    const under = (p: string): boolean => {
      const n = p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      return n === norm || n.startsWith(norm + '/')
    }
    const targets = [...this.instances.values()].filter(
      (i) => under(i.projectPath) || under(i.realProjectPath)
    )
    for (const inst of targets) {
      this.instances.delete(inst.projectPath)
      for (const subId of inst.subscribers.keys()) this.subIndex.delete(subId)
      if (inst.kind === 'primary') {
        this.reconciler?.untrack(inst.projectPath)
        await this.shutdownClonesOf(inst.projectPath)
      }
      await this.shutdown(inst)
    }
  }

  private instanceFor(id: string): Instance | undefined {
    const pp = this.subIndex.get(id)
    return pp ? this.instances.get(pp) : undefined
  }

  private emit(inst: Instance, channel: string, base: Record<string, unknown>): void {
    for (const [unityId, wcId] of inst.subscribers) {
      this.sink(wcId, channel, { ...base, id: unityId })
    }
  }

  private emitAgentFeedback(inst: Instance): void {
    const manifest = inst.channel?.readFeedback()
    if (!manifest || typeof manifest.seq !== 'number' || typeof manifest.file !== 'string') return
    if (manifest.seq <= inst.lastFeedbackSeq) return
    const feedbackDir = resolve(join(inst.projectPath, SSPACE, 'feedback'))
    const imagePath = resolve(join(inst.projectPath, SSPACE, manifest.file))
    if (imagePath !== feedbackDir && !imagePath.startsWith(feedbackDir + sep)) return
    let dataUrl: string
    try {
      dataUrl = `data:image/png;base64,${readFileSync(imagePath).toString('base64')}`
    } catch (e) {
      console.log(`[unity] agent feedback read failed: ${(e as Error).message}`)
      return
    }
    inst.lastFeedbackSeq = manifest.seq
    this.emit(inst, 'unity:agentFeedback', {
      projectPath: inst.realProjectPath,
      seq: manifest.seq,
      dataUrl,
      timestamp: manifest.timestamp
    })
  }

  ensureProjectEnv(projectPath: string): Promise<void> {
    const root = typeof projectPath === 'string' ? projectPath.trim() : ''
    if (!root || !existsSync(join(root, 'Packages', 'manifest.json'))) return Promise.resolve()
    const envKey = comparablePath(root)
    const pending = this.projectEnvPromises.get(envKey)
    if (pending) return pending
    const p = (async () => {
      const conflict = await devInstanceProjectConflict(root, app.getPath('appData'))
      if (conflict) {
        console.log(`[dev-instance] ${conflict}`)
        throw new Error(conflict)
      }
      await hideSaturaFiles(root)
      await ensureUnityRuntime()
      this.ensureSspace(root)
      this.writeAppStamp(root)
      this.ensureClaudeMcpConfig(root)
      this.ensureCursorMcpConfig(root)
      if (!sharedConfigOwner()) this.ensureCodexMcpConfig()
      if (this.pendingHandoffPrimary(root)) {
        console.log(`[unity] ${root} has an editor waiting for adoption after the update; packages are left as they are until it is adopted or restarted`)
        return
      }
      removeSaturaLeftovers(root)
      await this.ensureEngine(root)
      await ensureSaturaDefine(root)
    })()
      .catch((e) => {
        console.error(`[unity] ensureProjectEnv failed for ${root}: ${(e as Error).message}`)
        throw e
      })
      .finally(() => {
        this.projectEnvPromises.delete(envKey)
      })
    this.projectEnvPromises.set(envKey, p)
    return p
  }

  private async ensureEngine(projectPath: string): Promise<void> {
    try {
      const src = engineSource()
      const pkgsDir = join(projectPath, 'Packages')
      const dest = join(pkgsDir, ENGINE_PKG_NAME)
      const staging = join(pkgsDir, `${ENGINE_PKG_NAME}.staging~`)
      const retired = join(pkgsDir, `${ENGINE_PKG_NAME}.old~`)
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      await rm(retired, { recursive: true, force: true }).catch(() => {})
      const wantId = engineBuildId()
      const haveId = readEngineStamp(dest)
      const devResync = !app.isPackaged
      if (devResync || !existsSync(dest) || haveId !== wantId) {
        const inst = this.instances.get(projectPath)
        const editorLive =
          (!!inst && !inst.exited && !inst.disposed) || (await isProjectLockedLive(projectPath))
        if (editorLive && existsSync(dest)) {
          if (haveId !== wantId)
            console.log(
              `[unity] engine sync ${haveId ?? 'none'} → ${wantId} deferred — editor is running; syncing on its next launch`
            )
          return
        }
        await mkdir(pkgsDir, { recursive: true })
        const inPlace = devResync && haveId === wantId && existsSync(dest) && (await syncEngineInPlace(src, dest))
        if (!inPlace) {
          try {
            await cp(src, staging, { recursive: true })
            await syncEnginePlugins(src, staging)
            writeEngineStamp(staging, wantId)
            if (existsSync(dest)) await renameWithRetry(dest, retired)
            try {
              await renameWithRetry(staging, dest)
            } catch (renameErr) {
              if (existsSync(retired) && !existsSync(dest)) await rename(retired, dest)
              throw renameErr
            }
            await rm(retired, { recursive: true, force: true }).catch(() => {})
            console.log(`[unity] synced engine ${ENGINE_PKG_NAME} ${wantId} → ${dest}`)
          } catch (swapErr) {
            await rm(staging, { recursive: true, force: true }).catch(() => {})
            if (!existsSync(dest)) {
              await cp(src, dest, { recursive: true })
              await syncEnginePlugins(src, dest)
              writeEngineStamp(dest, wantId)
              console.log(`[unity] restored engine ${ENGINE_PKG_NAME} ${wantId} → ${dest} (swap failed: ${(swapErr as Error).message})`)
            } else if (haveId === wantId) {
              await cp(src, dest, {
                recursive: true,
                force: true,
                filter: (s) =>
                  !(/\.(dll|dylib|so|pdb)$/i.test(s) && existsSync(join(dest, relative(src, s))))
              })
              await syncEnginePlugins(src, dest)
              console.log(`[unity] overlay-synced engine ${ENGINE_PKG_NAME} ${wantId} → ${dest} (swap blocked: ${(swapErr as Error).message})`)
            } else {
              console.error(`[unity] engine swap ${haveId ?? 'none'} → ${wantId} blocked, will retry next launch: ${(swapErr as Error).message}`)
            }
          }
        }
      }
    } catch (e) {
      console.error(`[unity] ensureEngine failed: ${(e as Error).message}`)
    }
  }

  private ensureSspace(root: string): void {
    try {
      const dir = ensureProjectSspaceSync(root)
      rmSync(join(dir, FEEDBACK_FILE), { force: true })
      rmSync(join(dir, 'feedback'), { recursive: true, force: true })
    } catch (e) {
      console.log(`[unity] ensureSspace failed: ${(e as Error).message}`)
    }
  }

  private writeAppStamp(projectPath: string): void {
    const stampPath = sf(projectPath, APP_STAMP_FILE)
    const read = readJsonObjectForUpdate(stampPath)
    if (read.state === 'invalid') {
      leftUntouched(stampPath, read.error, 'the app version stamp is not refreshed')
      return
    }
    const stamp = read.state === 'ok' ? read.value : {}
    const version = appVersion()
    if (stamp[appChannel()] === version) return
    stamp[appChannel()] = version
    try {
      this.ensureSspace(projectPath)
      atomicWriteFileSync(stampPath, JSON.stringify(stamp) + '\n')
    } catch (e) {
      console.log(`[unity] failed to write ${APP_STAMP_FILE}: ${(e as Error).message}`)
    }
  }

  private ensureClaudeMcpConfig(projectPath: string): void {
    try {
      const { command, args } = mcpServerCommand()
      const env = {
        [PANE_KEY_ENV]: `\${${PANE_KEY_ENV}:-}`,
        [HOOKS_ENDPOINT_ENV]: `\${${HOOKS_ENDPOINT_ENV}:-}`
      }
      const desired = { type: 'stdio', command, args, env }

      const mcpPath = join(projectPath, '.mcp.json')
      this.upsertMcpServersFile(mcpPath, desired, 'Claude Code agents in this project do not get the Satura Space MCP server')

      const claudeDir = join(projectPath, '.claude')
      const settingsPath = join(claudeDir, 'settings.local.json')
      const read = readJsonObjectForUpdate(settingsPath)
      if (read.state === 'invalid') {
        leftUntouched(settingsPath, read.error, `Claude Code may not enable the '${MCP_SERVER_NAME}' MCP server`)
      } else {
        const settings = (read.state === 'ok' ? read.value : {}) as {
          enabledMcpjsonServers?: unknown
          enableAllProjectMcpServers?: boolean
          [k: string]: unknown
        }
        const listed = Array.isArray(settings.enabledMcpjsonServers) ? (settings.enabledMcpjsonServers as unknown[]).filter((x): x is string => typeof x === 'string') : []
        const enabled = new Set(listed)
        const enabledBefore = [...enabled].sort().join(',')
        enabled.add(MCP_SERVER_NAME)
        enabled.delete(RETIRED_MCP_SERVER_NAME)
        if (
          [...enabled].sort().join(',') !== enabledBefore ||
          !Array.isArray(settings.enabledMcpjsonServers) ||
          settings.enableAllProjectMcpServers !== true
        ) {
          settings.enabledMcpjsonServers = [...enabled]
          settings.enableAllProjectMcpServers = true
          mkdirSync(claudeDir, { recursive: true })
          atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
          console.log(`[unity] enabled MCP server '${MCP_SERVER_NAME}' in ${settingsPath}`)
        }
      }
    } catch (e) {
      console.error(`[unity] ensureClaudeMcpConfig failed: ${(e as Error).message}`)
    }
  }

  private upsertMcpServersFile(mcpPath: string, desired: Record<string, unknown>, consequence: string): void {
    const read = readJsonObjectForUpdate(mcpPath)
    if (read.state === 'invalid') {
      leftUntouched(mcpPath, read.error, consequence)
      return
    }
    const mcp = read.state === 'ok' ? read.value : {}
    const current = mcp.mcpServers
    if (current !== undefined && (!current || typeof current !== 'object' || Array.isArray(current))) {
      leftUntouched(mcpPath, '"mcpServers" is not an object', consequence)
      return
    }
    const servers = (current ?? {}) as Record<string, unknown>
    let changed = current === undefined
    if (JSON.stringify(servers[MCP_SERVER_NAME]) !== JSON.stringify(desired)) {
      servers[MCP_SERVER_NAME] = desired
      changed = true
    }
    if (servers[RETIRED_MCP_SERVER_NAME]) {
      delete servers[RETIRED_MCP_SERVER_NAME]
      changed = true
    }
    if (!changed) return
    mcp.mcpServers = servers
    mkdirSync(dirname(mcpPath), { recursive: true })
    atomicWriteFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n')
    console.log(`[unity] registered MCP server '${MCP_SERVER_NAME}' in ${mcpPath}`)
  }

  private ensureCursorMcpConfig(projectPath: string): void {
    try {
      const { command, args } = mcpServerCommand()
      const env = { [PANE_KEY_ENV]: `\${env:${PANE_KEY_ENV}}` }
      const desired = { type: 'stdio', command, args, env }

      const cursorDir = join(projectPath, '.cursor')
      const mcpPath = join(cursorDir, 'mcp.json')
      this.upsertMcpServersFile(mcpPath, desired, 'Cursor agents in this project do not get the Satura Space MCP server')
    } catch (e) {
      console.error(`[unity] ensureCursorMcpConfig failed: ${(e as Error).message}`)
    }
  }

  private ensureCodexMcpConfig(): void {
    syncCodexMcpConfig(process.env.CODEX_HOME ?? join(homedir(), '.codex'))
  }

  private readLaunchErrors(logPath: string): string[] {
    let txt: string
    try {
      txt = readFileSync(logPath, 'utf8')
    } catch {
      return []
    }
    const lines = txt.split(/\r?\n/)
    const seen = new Set<string>()
    const out: string[] = []
    const push = (s: string): void => {
      const t = s.trim()
      if (t && !seen.has(t)) {
        seen.add(t)
        out.push(t)
      }
    }

    for (const ln of lines) if (/: error CS\d+/.test(ln)) push(ln)

    if (out.length === 0) {
      for (let i = 0; i < lines.length; i++) {
        if (/Aborting batchmode due to failure/i.test(lines[i])) {
          for (let j = i + 1; j < lines.length && j <= i + 5; j++) if (lines[j].trim()) push(lines[j])
        } else if (/^An error occurred/i.test(lines[i])) {
          push(lines[i])
          for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) if (lines[j].trim()) push(lines[j])
        } else if (
          /\w*Exception: |executeMethod .*(could not be found|not found|threw)|\bFatal error\b|No valid Unity Editor license|Multiple Unity instances/i.test(
            lines[i]
          )
        ) {
          push(lines[i])
        }
      }
    }

    if (out.length === 0) {
      for (const ln of lines.filter((l) => l.trim()).slice(-10)) push(ln)
    }

    return out.slice(0, 40)
  }

  private writeCompileErrors(projectPath: string, lines: string[]): void {
    const valid = lines.map((l) => l.trim()).filter((l) => l.length > 0)
    if (valid.length === 0) return
    try {
      ensureProjectSspaceSync(projectPath)
      const dir = sf(projectPath, '.mcp_logs')
      mkdirSync(dir, { recursive: true })
      const body = valid.map((l) => `[F:-1 T:0.000] E ${l}\n`).join('')
      appendFileSync(join(dir, 'console.log'), body)
    } catch (e) {
      console.log(`[unity] failed to write compile errors: ${(e as Error).message}`)
    }
  }

  private resolveEditor(projectPath: string): string | null {
    return editorBinary(readProjectVersion(projectPath).version)
  }

  private readonly reservedPorts = censusTrack('unity-instance-provider.reservedPorts', new Set<number>())

  private async allocatePorts(): Promise<{
    mediaPort: number
    inputPort: number
    controlPort: number
  }> {
    const used = new Set<number>(this.reservedPorts)
    for (const i of this.instances.values()) {
      used.add(i.mediaPort)
      used.add(i.inputPort)
      used.add(i.controlPort)
    }
    for (let media = PORT_BASE; media <= PORT_BASE + PORT_SCAN_LIMIT; media += 2) {
      const ports = {
        mediaPort: media,
        inputPort: media + 1,
        controlPort: media + CONTROL_PORT_OFFSET
      }
      if (Object.values(ports).some((p) => used.has(p) || this.reservedPorts.has(p))) continue
      const free =
        (await portFreeUdp(ports.mediaPort)) &&
        (await portFreeUdp(ports.inputPort)) &&
        (await portFreeTcp(ports.controlPort))
      if (free) {
        const block = Object.values(ports)
        for (const p of block) this.reservedPorts.add(p)
        setTimeout(() => {
          for (const p of block) this.reservedPorts.delete(p)
        }, 60_000).unref?.()
        return ports
      }
      console.log(`[unity] port block at base ${media} occupied (stale editor?), trying next`)
    }
    throw new Error(
      `[unity] no free port block in ${PORT_BASE}..${PORT_BASE + PORT_SCAN_LIMIT}; kill stale Unity editors`
    )
  }

  private buildInstance(opts: {
    projectPath: string
    realProjectPath: string
    kind: 'primary' | 'clone'
    worldId: string
    cloneId?: string
    mediaPort: number
    inputPort: number
    controlPort: number
    controlToken?: string
    logPath: string
    unityMode?: UnityMode
  }): Instance {
    const {
      projectPath,
      realProjectPath,
      kind,
      worldId,
      cloneId,
      mediaPort,
      inputPort,
      controlPort,
      controlToken = newSecretToken(),
      logPath,
      unityMode = 'normal'
    } = opts
    setEditorControlToken(controlPort, controlToken)
    const recv = dgram.createSocket({ type: 'udp4' })
    const send = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const inst: Instance = {
      projectPath,
      realProjectPath,
      kind,
      cloneId,
      mediaPort,
      inputPort,
      controlPort,
      controlToken,
      recv,
      send,
      proc: null,
      logPath,
      subscribers: new Map(),
      viewHints: new Map(),
      baseRes: DEFAULT_STREAM_RES,
      fpsCap: -1,
      pane: this.lastPane.get(worldId) ?? DEFAULT_PANE,
      streamSig: '',
      streamPushTimer: null,
      resCandidate: '',
      resCandidateAt: 0,
      revealEpoch: 0,
      revealed: false,
      hidePending: null,
      hookInjectFailed: false,
      unityMode,
      live: false,
      streamPushedForPlay: false,
      observedPlaying: false,
      exited: false,
      exitCode: null,
      exitSignal: null,
      safeMode: false,
      stuck: false,
      fault: null,
      watchdogStop: null,
      editModeReady: false,
      sawEditor: false,
      bootCompileErrors: 0,
      bootCompileFirst: '',
      restarting: false,
      disposed: false,
      failed: false,
      commandWatcher: null,
      assetWatcher: null,
      hotReloadLogSub: null,
      hotReloadTerminalAt: 0,
      launchProgressStop: null,
      worldId,
      channel: null,
      socketChannel: null,
      worldWatchStop: null,
      lastFeedbackSeq: 0,
      gate: new StreamGate(),
      holds: new HoldBook()
    }

    inst.channel = new FileChannel(join(projectPath, SSPACE))
    inst.socketChannel = new SocketChannel({
      instanceId: worldId,
      port: controlPort,
      onSnapshot: (iid, w) => {
        inst.sawEditor = true
        worldStore.ingestEditorSnapshot(iid, w)
        this.stopLaunchProgressIfBooted(inst)
      },
      onConnectedChange: (iid, c) => worldStore.setMainSignal(iid, { connected: c })
    })
    this.byWorldId.set(worldId, inst)

    const playerIndex = kind === 'primary' ? 0 : cloneIndexOf(cloneId)
    this.reconciler?.forgetInstance(worldId)
    worldStore.attachInstance(realProjectPath, worldId, kind, playerIndex)
    this.syncFpsCap(inst)

    inst.worldWatchStop = inst.channel.watch((change) => {
      if (change.world) {
        const wf = inst.channel!.readWorld()
        if (wf) {
          inst.sawEditor = true
          worldStore.ingestEditorSnapshot(worldId, wf.world)
          this.stopLaunchProgressIfBooted(inst)
        }
      }
      if (change.acks) this.reconciler.kick(inst.realProjectPath)
      if (change.feedback && inst.kind === 'primary') this.emitAgentFeedback(inst)
    })

    worldStore.setMainSignal(worldId, { alive: true, unityMode, logPath })
    if (kind === 'primary') this.reconciler.track(inst.realProjectPath)

    if (kind === 'primary') this.startCommandWatch(inst)
    if (kind === 'primary') this.startAssetWatch(inst)

    recv.on('message', (msg) => this.onPacket(inst, msg))
    recv.on('error', (e) => console.log(`[unity] recv error: ${e.message}`))
    recv.bind(mediaPort, '127.0.0.1', () => {
      try {
        recv.setRecvBufferSize(256 * 1024)
      } catch {
      }
      console.log(
        `[unity] pong udp 127.0.0.1:${mediaPort}, input → :${inputPort} (${kind})`
      )
    })
    send.on('error', (e) => console.log(`[unity] send error: ${e.message}`))
    return inst
  }

  private spawnEditor(
    inst: Instance,
    editor: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd?: string
  ): void {
    env = withMonoInlineDisabled(env)
    console.log(
      `[unity] launching ${editor}\n  project=${inst.projectPath} udp=${inst.mediaPort}/${inst.inputPort} kind=${inst.kind}`
    )
    resetRunLogs(inst.logPath)
    pinExeToHighPerfGpu(editor)
    let proc: ChildProcess | HookedProc | null = null
    const winHookEnabled =
      process.env.SATURA_DISABLE_WINHOOK !== '1' && inst.unityMode !== 'headless-nographics'
    const hookDll = winHookDll()
    if (winHookEnabled && process.platform === 'win32' && hookDll && existsSync(hookDll)) {
      const r = launchWithHook(editor, args, cwd ?? '', winEnvBlock(env), hookDll)
      if (r && r.pid > 0) {
        proc = new HookedProc(r.pid)
        if (r.injected) {
          console.log(`[unity] launched with window hook (pid=${r.pid})`)
        } else {
          inst.hookInjectFailed = true
          console.log(
            `[unity] WARNING window-hook DLL injection FAILED (pid=${r.pid}); editor will run VISIBLE`
          )
          this.onHookInjectFailed(inst)
        }
      } else {
        console.log('[unity] window-hook launch unavailable; falling back to normal spawn')
      }
    }
    if (!proc) {
      const p = spawn(editor, args, { env, detached: true, stdio: 'ignore', ...(cwd ? { cwd } : {}) })
      p.unref()
      if (p.pid) assignToKillJob(p.pid)
      proc = p
    }
    inst.proc = proc
    this.liveEditors.add(inst)

    inst.launchProgressStop = trackEditorStatus(
      inst.logPath,
      (e) => {
        if (inst.exited) return
        if (e.kind === 'loading') {
          if (inst.editModeReady || inst.live) return
          worldStore.setMainSignal(inst.worldId, {
            bootPhase: 'launching',
            ...(e.phase ? { launchPhase: e.phase, launchPct: e.pct } : {})
          })
          if (e.phase) {
            worldStore.emitProgress(inst.worldId, 'launch', e.phase, e.pct)
          }
        } else if (e.kind === 'playEntering') {
          worldStore.setMainSignal(inst.worldId, {
            bootPhase: 'entering-play',
            launchPhase: '',
            launchPct: -1
          })
        } else if (e.kind === 'editReady') {
          inst.editModeReady = true
          worldStore.setMainSignal(inst.worldId, {
            bootPhase: 'editmode',
            launchPhase: '',
            launchPct: -1
          })
          this.stopLaunchProgressIfBooted(inst)
        } else if (e.kind === 'compileFailed') {
          if (inst.editModeReady || inst.live) return
          inst.bootCompileErrors += e.errors.length
          if (!inst.bootCompileFirst && e.errors.length) inst.bootCompileFirst = e.errors[0]
          if (e.errors.length) this.writeCompileErrors(inst.projectPath, e.errors)
          const extra = Math.max(0, inst.bootCompileErrors - 1)
          const message = inst.bootCompileFirst
            ? `${inst.bootCompileFirst}${extra ? ` (+${extra} more)` : ''}`
            : 'C# compilation failed during startup.'
          worldStore.setMainSignal(inst.worldId, { compileError: message })
        } else if (e.kind === 'safeMode') {
          if (inst.editModeReady || inst.live) return
          inst.safeMode = true
          this.writeCompileErrors(inst.projectPath, [
            'Unity entered Safe Mode — the SaturaSpace bridge did not load, so this editor never connected. Fix the compile errors, then Relaunch.'
          ])
          if (!inst.bootCompileFirst) {
            worldStore.setMainSignal(inst.worldId, {
              compileError: 'Unity entered Safe Mode — C# compile errors prevented startup.'
            })
          }
        }
      },
      () => this.onLaunchStuck(inst),
      () => this.onLaunchUnstuck(inst)
    )

    this.attachProcHandlers(inst, proc)
    this.startWatchdog(inst)
  }

  private startWatchdog(inst: Instance): void {
    inst.watchdogStop?.()
    const observed = (): InstanceObserved | undefined =>
      worldStore.getWorld(inst.realProjectPath).observed.instances[inst.worldId]
    inst.watchdogStop = watchEditor({
      pid: () => (inst.exited ? null : (inst.proc?.pid ?? null)),
      logPath: inst.logPath,
      progress: () => {
        const o = observed()
        return o ? `${o.lifecycle}|${o.compile}|${o.progressLabel}|${o.progressPct}` : ''
      },
      busy: () => {
        const o = observed()
        if (!o || inst.exited || inst.disposed || inst.restarting) return false
        return o.progressLabel !== '' || o.compile === 'compiling' || o.lifecycle === 'launching' || o.lifecycle === 'init'
      },
      onCrash: (c) => this.onEditorCrash(inst, c),
      onHung: (reason) => this.onEditorHung(inst, reason),
      onStall: (text) => {
        if (inst.disposed || inst.restarting || inst.exited) return
        worldStore.setMainSignal(inst.worldId, { stall: text })
      }
    })
  }

  private stopWatchdog(inst: Instance): void {
    inst.watchdogStop?.()
    inst.watchdogStop = null
  }

  private setFault(inst: Instance, kind: EditorFaultKind, reason: string, line: number): void {
    inst.fault = { kind, reason, line }
    worldStore.setMainSignal(inst.worldId, { fault: kind, faultReason: reason, faultLine: line, stall: '' })
  }

  private onEditorCrash(inst: Instance, crash: EditorCrash): void {
    if (inst.disposed || inst.restarting || inst.exited) return
    console.log(`[unity] ${inst.kind} ${inst.worldId} crashed (pid=${inst.proc?.pid ?? '-'}): ${crash.reason} — log line ${crash.line}`)
    this.setFault(inst, 'crashed', crash.reason, crash.line)
    this.stopLaunchProgress(inst)
    this.stopStream(inst, 'editor crashed')
    setTimeout(() => {
      if (inst.exited) return
      console.log(`[unity] crashed editor pid=${inst.proc?.pid ?? '-'} is still alive, killing it`)
      inst.proc?.kill('SIGKILL')
    }, CRASH_EXIT_GRACE_MS)
  }

  private onEditorHung(inst: Instance, reason: string | null): void {
    if (inst.disposed || inst.restarting || inst.exited) return
    if (reason) {
      console.log(`[unity] ${inst.kind} ${inst.worldId} is not responding (pid=${inst.proc?.pid ?? '-'}): ${reason}`)
      this.setFault(inst, 'hung', reason, 0)
      return
    }
    if (inst.fault?.kind !== 'hung') return
    console.log(`[unity] ${inst.kind} ${inst.worldId} is responding again`)
    inst.fault = null
    worldStore.setMainSignal(inst.worldId, { fault: '', faultReason: '', faultLine: 0 })
  }

  editorFault(projectPath: string): { kind: EditorFaultKind; reason: string; line: number; log: string } | null {
    const key = this.canonicalProjectKey(projectPath)
    const inst = this.instances.get(key)
    if (!inst || inst.disposed || inst.restarting || !inst.fault || this.launching.has(key)) return null
    return { ...inst.fault, log: inst.logPath }
  }

  private attachProcHandlers(inst: Instance, proc: ChildProcess | HookedProc): void {
    proc.on('exit', (code, signal) => {
      inst.exited = true
      this.liveEditors.delete(inst)
      inst.exitCode = code
      inst.exitSignal = signal ?? null
      this.stopWatchdog(inst)
      if (!inst.restarting && !inst.disposed && inst.fault?.kind !== 'crashed' && (code !== 0 || signal)) {
        const found = scanLogForCrash(inst.logPath)
        const reason = found?.reason ?? (signal ? `Unity was killed by ${signal}.` : '')
        if (reason) {
          this.setFault(inst, 'crashed', reason, found?.line ?? 0)
          console.log(`[unity] ${inst.kind} ${inst.worldId} died: ${reason}`)
        }
      }
      this.setRevealed(inst, false)
      this.stopLaunchProgress(inst)
      this.stopStream(inst, 'editor exited')
      console.log(`[unity] editor exited (code ${code}) project=${inst.projectPath}`)
      if (inst.restarting) {
        return
      }
      if (inst.disposed) {
        if (inst.kind === 'clone') {
          this.instances.delete(inst.projectPath)
          this.byWorldId.delete(inst.worldId)
          worldStore.detachInstance(inst.worldId)
        }
        return
      }
      let message = `Editor exited (code ${code})`
      const crashed = (code !== 0 && !inst.live) || inst.fault?.kind === 'crashed'
      if (inst.fault?.kind === 'crashed') {
        message = `Unity crashed: ${inst.fault.reason}`
      } else if (crashed) {
        const errs = this.readLaunchErrors(inst.logPath)
        const compiles = errs.filter((e) => /: error CS\d+/.test(e)).length
        const headline = compiles
          ? `Unity stopped — ${compiles} C# compile error${compiles === 1 ? '' : 's'} (exit ${code}).`
          : `Unity stopped before it could start (exit ${code}).`
        this.writeCompileErrors(inst.projectPath, errs.length ? [headline, ...errs] : [headline])
        message = headline
      }
      if (inst.kind === 'clone') {
        const key = inst.cloneId ?? inst.worldId
        if (!inst.live && !inst.editModeReady) {
          const n = (this.cloneFailCount.get(key) ?? 0) + 1
          this.cloneFailCount.set(key, n)
          if (n >= MAX_CLONE_LAUNCH_RETRIES) {
            console.log(`[unity] clone ${inst.worldId} failed to launch ${n}x — giving up (persistent failure)`)
            inst.failed = true
            worldStore.setMainSignal(inst.worldId, { error: message })
            this.teardownInstanceResources(inst)
            return
          }
          console.log(`[unity] clone ${inst.worldId} crashed on launch (${n}/${MAX_CLONE_LAUNCH_RETRIES}) — will retry`)
        }
        worldStore.setMainSignal(inst.worldId, { exited: true, error: crashed ? message : null })
        this.teardownInstanceResources(inst)
        this.instances.delete(inst.projectPath)
        this.byWorldId.delete(inst.worldId)
        worldStore.detachInstance(inst.worldId)
        this.reconciler?.forgetInstance(inst.worldId)
        return
      }
      worldStore.setMainSignal(inst.worldId, { exited: true, error: crashed ? message : null })
      this.releaseExitedPrimary(inst)
    })
    proc.on('error', (e) => {
      inst.exited = true
      this.stopLaunchProgress(inst)
      worldStore.setMainSignal(inst.worldId, { exited: true, error: e.message })
      if (inst.kind === 'primary' && !inst.disposed && !inst.restarting) this.releaseExitedPrimary(inst)
    })
  }

  private teardownInstanceResources(inst: Instance): void {
    this.teardownQueue(inst)
    try {
      inst.socketChannel?.close()
    } catch {
    }
    inst.worldWatchStop?.()
    try {
      inst.recv.close()
    } catch {
    }
    try {
      inst.send.close()
    } catch {
    }
  }

  private stopLaunchProgress(inst: Instance): void {
    if (inst.launchProgressStop) {
      inst.launchProgressStop()
      inst.launchProgressStop = null
    }
  }

  private releaseExitedPrimary(inst: Instance): void {
    if (inst.streamPushTimer) {
      clearTimeout(inst.streamPushTimer)
      inst.streamPushTimer = null
    }
    this.stopAssetWatch(inst)
    inst.worldWatchStop?.()
    try {
      inst.socketChannel?.close()
    } catch {
    }
    try {
      inst.recv.close()
    } catch {
    }
    try {
      inst.send.close()
    } catch {
    }
  }

  private stopLaunchProgressIfBooted(inst: Instance): void {
    if (inst.launchProgressStop && inst.editModeReady && inst.sawEditor) this.stopLaunchProgress(inst)
  }

  private onHookInjectFailed(inst: Instance): void {
    if (inst.kind !== 'primary') return
    const message =
      'The Unity window hook could not be installed (often antivirus or endpoint security blocking ' +
      'process injection). This editor is running visibly on your desktop instead of hidden. ' +
      'Allow Satura Space in your security software, then Relaunch.'
    worldStore.setMainSignal(inst.worldId, { warning: message })
  }

  private watchHookInjectMac(inst: Instance, revealFile: string): void {
    if (process.platform !== 'darwin') return
    if (process.env.SATURA_DISABLE_WINHOOK === '1') return
    const statusFile = `${revealFile}.status`
    const deadline = Date.now() + 12000
    const tick = (): void => {
      if (inst.exited || inst.disposed || inst.restarting) return
      if (existsSync(statusFile)) {
        console.log(`[unity] window hook loaded (pid=${inst.proc?.pid})`)
        return
      }
      if (Date.now() >= deadline) {
        inst.hookInjectFailed = true
        console.log('[unity] WARNING window-hook dylib did not load; editor may run VISIBLE')
        this.onHookInjectFailed(inst)
        return
      }
      setTimeout(tick, 500)
    }
    setTimeout(tick, 500)
  }

  private async reapOrphanPrimary(projectPath: string): Promise<void> {
    if (process.platform === 'win32') return
    if (this.instances.has(projectPath)) return
    const pids = await this.unityPidsForPrimaryPosix(projectPath)
    let killed = 0
    for (const pid of pids) {
      if (!Number.isFinite(pid) || pid === process.pid) continue
      try {
        process.kill(pid, 'SIGKILL')
        killed++
      } catch {
      }
    }
    if (killed) {
      console.log(`[unity] reaped ${killed} orphan primary editor(s) for ${projectPath}`)
      rmSafe(join(projectPath, 'Temp', 'UnityLockfile'))
    }
  }

  private lineTargetsProjectExactly(line: string, projectPath: string): boolean {
    return line.includes(`-projectPath ${projectPath} `) || line.endsWith(`-projectPath ${projectPath}`)
  }

  private async unityPidsForPrimaryPosix(projectPath: string): Promise<number[]> {
    let out: string
    try {
      const r = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], {
        encoding: 'utf8',
        timeout: 4000,
        maxBuffer: 16 * 1024 * 1024
      })
      out = r.stdout ?? ''
    } catch {
      return []
    }
    const pids: number[] = []
    for (const line of out.split('\n')) {
      if (!line.includes('Unity.app/Contents/MacOS/Unity')) continue
      if (!this.lineTargetsProjectExactly(line, projectPath)) continue
      if (line.includes('--virtual-project-clone')) continue
      pids.push(parseInt(line.trim().split(/\s+/)[0], 10))
    }
    return pids
  }

  private async reapOwnEditors(projectPath: string): Promise<number> {
    if (process.platform === 'win32') return 0
    let out: string
    try {
      const r = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], {
        encoding: 'utf8',
        timeout: 4000,
        maxBuffer: 16 * 1024 * 1024
      })
      out = r.stdout ?? ''
    } catch {
      return 0
    }
    const pids: number[] = []
    for (const line of out.split('\n')) {
      if (!line.includes('Unity.app/Contents/MacOS/Unity')) continue
      if (!this.lineTargetsProjectExactly(line, projectPath)) continue
      if (!line.includes('MCPTestBridge.StartRawStream')) continue
      const pid = parseInt(line.trim().split(/\s+/)[0], 10)
      if (Number.isFinite(pid) && pid !== process.pid) pids.push(pid)
    }
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
      }
    }
    if (pids.length)
      console.log(`[unity] reaped ${pids.length} orphaned Satura editor(s) for ${projectPath}`)
    return pids.length
  }

  private onLaunchStuck(inst: Instance): void {
    if (inst.kind !== 'primary') return
    if (inst.exited || inst.disposed || inst.restarting) return
    if (inst.live || inst.editModeReady || inst.sawEditor) return
    if (inst.socketChannel?.isConnected) return
    inst.stuck = true
    const message =
      "Unity hasn't written to its launch log for a while, so it may be stuck. " +
      'Large projects can take this long to import; this clears on its own if Unity carries on. ' +
      'Otherwise open the launch log (.sspace/.mcp_rawstream_editor.log) and Relaunch.'
    worldStore.setMainSignal(inst.worldId, { error: message })
  }

  private onLaunchUnstuck(inst: Instance): void {
    if (!inst.stuck || inst.exited || inst.disposed) return
    inst.stuck = false
    worldStore.setMainSignal(inst.worldId, { error: null })
  }

  private async launch(projectPath: string, editor: string, scene: string = SCENE, signal?: AbortSignal): Promise<Instance> {
    this.refuseIfQuitting(`launch of ${projectPath}`)
    requireInputSystem(projectPath, 'launch')
    await cut(requireHub('launch'), signal)
    await cut(ensureUnityRuntime(), signal)
    if (!existsSync(join(projectPath, scene))) {
      scene = (await this.listScenes(projectPath))[0] ?? scene
    }

    await cut(this.reapOrphanPrimary(projectPath), signal)
    await cut(this.preLaunchCleanup(projectPath), signal)
    this.clearStaleSspaceTriggers(projectPath)
    await cut(this.clearStaleCloneState(projectPath), signal)
    this.resetMpBaseline(projectPath)

    const { mediaPort, inputPort, controlPort } = await cut(this.allocatePorts(), signal)
    this.ensureSspace(projectPath)
    const logPath = sf(projectPath, '.mcp_rawstream_editor.log')
    rmSafe(logPath)
    for (const r of RESULT_FILES) rmSafe(sf(projectPath, r))
    for (const q of QUEUE_FILES) rmSafe(sf(projectPath, q))
    rmSafe(sf(projectPath, STATUS_FILE))

    const unityMode = readUnityModePref(projectPath)
    const batch = unityMode !== 'normal'
    const noGraphics = unityMode === 'headless-nographics'
    const worldId = primaryWorldId(projectPath)
    const inst = this.buildInstance({
      projectPath,
      realProjectPath: projectPath,
      kind: 'primary',
      worldId,
      mediaPort,
      inputPort,
      controlPort,
      logPath,
      unityMode
    })

    const revealFile = sf(projectPath, '.winhook_reveal')
    rmSafe(revealFile)
    rmSafe(`${revealFile}.status`)
    clearModalFiles(projectPath)
    const args = [
      ...forceGraphicsApiArgs(),
      ...(batch ? ['-batchmode'] : []),
      ...(noGraphics ? ['-nographics'] : []),
      '-accept-apiupdate',
      '-projectPath',
      projectPath,
      '-executeMethod',
      'MCPTestBridge.StartRawStream',
      '-logFile',
      logPath
    ]
    const stream = this.launchStream(worldId, projectPath)
    const env = {
      ...process.env,
      MC_UDP_PORT: String(mediaPort),
      MC_UDP_INPUT_PORT: String(inputPort),
      MC_INSTANCE_ID: worldId,
      MC_PLAYER_INDEX: '0',
      MC_CONTROL_TCP_PORT: String(controlPort),
      MC_CONTROL_TOKEN: inst.controlToken,
      MC_UDP_RES: stream.res,
      MC_STREAM_SCENE: scene,
      ...(noGraphics ? {} : winhookEnv()),
      ...(noGraphics ? {} : modalFilesEnv(projectPath)),
      ...(batch ? {} : { SATURA_WINHOOK_REVEAL_FILE: revealFile })
    }
    this.refuseIfQuitting(`launch of ${projectPath}`, inst)
    if (signal?.aborted) {
      console.log(`[unity] launch of ${projectPath} cancelled before Unity started`)
      throw new LaunchFailure(STOPPED_RESULT)
    }
    this.spawnEditor(inst, editor, args, env)
    this.launchCount.set(projectPath, (this.launchCount.get(projectPath) ?? 0) + 1)
    this.launchedVersion.set(projectPath, readProjectVersion(projectPath).version)
    this.launchBlocked.delete(projectPath)
    if (!batch) this.watchHookInjectMac(inst, revealFile)
    return inst
  }

  private cloneDirFor(realProjectPath: string, cloneId: string): string {
    const h = createHash('sha1').update(cloneId).digest('hex').slice(0, 8)
    return join(realProjectPath, 'Library', 'VP', `mppm${h}`)
  }

  instanceDir(projectPath: string, worldId: string): string | null {
    const key = this.canonicalProjectKey(projectPath)
    const inst = this.byWorldId.get(worldId)
    if (inst && comparablePath(inst.realProjectPath) === comparablePath(key)) return inst.projectPath
    if (worldId === primaryWorldId(key) || worldId === primaryWorldId(projectPath)) return key
    return /^mppm[0-9a-f]{8}$/.test(worldId) ? join(key, 'Library', 'VP', worldId) : null
  }

  private removeCloneDir(cloneDir: string): void {
    removeCloneDirSafely(cloneDir)
  }

  private async ensureCloneScaffold(realProjectPath: string, cloneDir: string): Promise<void> {
    await mkdir(join(cloneDir, 'Packages'), { recursive: true })
    await mkdir(join(cloneDir, 'Temp'), { recursive: true })
    for (const name of ['Assets', 'ProjectSettings']) {
      const link = join(cloneDir, name)
      if (!existsSync(link)) {
        try {
          symlinkSync(join(realProjectPath, name), link, process.platform === 'win32' ? 'junction' : undefined)
        } catch (e) {
          console.log(`[unity] clone symlink ${name} failed: ${(e as Error).message}`)
        }
      }
    }
    try {
      copyFileSync(join(realProjectPath, 'Packages', 'manifest.json'), join(cloneDir, 'Packages', 'manifest.json'))
      const lock = join(realProjectPath, 'Packages', 'packages-lock.json')
      if (existsSync(lock)) copyFileSync(lock, join(cloneDir, 'Packages', 'packages-lock.json'))
    } catch (e) {
      console.log(`[unity] clone manifest copy failed: ${(e as Error).message}`)
    }
    try {
      const libDir = join(cloneDir, 'Library')
      await mkdir(libDir, { recursive: true })
      for (const cache of ['ShaderCache', 'BurstCache', 'ShaderCache.db']) {
        const src = join(realProjectPath, 'Library', cache)
        const dst = join(libDir, cache)
        if (existsSync(src) && !existsSync(dst)) {
          if (process.platform === 'darwin') {
            await new Promise<void>((resolve) => {
              const child = execFile('cp', ['-cR', src, dst], { timeout: 120000 }, (err) => {
                if (err) console.log(`[unity] clone cache pre-warm ${cache} failed: ${err.message}`)
                resolve()
              })
              child.on('error', () => resolve())
            })
          } else {
            try {
              await cp(src, dst, { recursive: true })
            } catch (e) {
              console.log(`[unity] clone cache pre-warm ${cache} failed: ${(e as Error).message}`)
            }
          }
        }
      }
    } catch (e) {
      console.log(`[unity] clone cache pre-warm failed: ${(e as Error).message}`)
    }
  }

  private async launchClone(
    realProjectPath: string,
    editor: string,
    cloneId: string,
    scene: string = SCENE
  ): Promise<Instance> {
    this.refuseIfQuitting(`clone launch for ${realProjectPath}`)
    requireInputSystem(realProjectPath, 'launch clone')
    await requireHub('launch clone')
    await ensureUnityRuntime()
    if (!existsSync(join(realProjectPath, scene))) {
      scene = (await this.listScenes(realProjectPath))[0] ?? scene
    }
    const cloneDir = this.cloneDirFor(realProjectPath, cloneId)
    await this.ensureCloneScaffold(realProjectPath, cloneDir)
    this.ensureSspace(cloneDir)
    await this.preLaunchCleanup(cloneDir)
    this.requestMppmLink(realProjectPath, basename(cloneDir), cloneId)

    const { mediaPort, inputPort, controlPort } = await this.allocatePorts()
    const logPath = sf(cloneDir, '.mcp_rawstream_editor.log')
    rmSafe(logPath)
    for (const r of RESULT_FILES) rmSafe(sf(cloneDir, r))
    for (const q of QUEUE_FILES) rmSafe(sf(cloneDir, q))
    rmSafe(sf(cloneDir, STATUS_FILE))
    clearModalFiles(cloneDir)

    const worldId = basename(cloneDir)
    const inst = this.buildInstance({
      projectPath: cloneDir,
      realProjectPath,
      kind: 'clone',
      worldId,
      cloneId,
      mediaPort,
      inputPort,
      controlPort,
      logPath
    })

    const args = [
      '-editor-mode',
      'com.unity.mppm.clone',
      '-no-cloud-project-bind-popup',
      '-accept-apiupdate',
      '-noLaunchScreen',
      '-library-redirect',
      '../..',
      '-readonly',
      '-noUpm',
      '-upmRestorePackages',
      ...cloneWindowArgs(),
      '-suppressDefaultMenuEntries',
      ...forceGraphicsApiArgs(),
      '-projectPath',
      process.platform === 'win32' ? '.' : cloneDir,
      '--virtual-project-clone',
      `-vpId=${worldId}`,
      '-forgetProjectPath',
      '-DisableDirectoryMonitor',
      '-executeMethod',
      'MCPTestBridge.StartRawStream',
      '-logFile',
      logPath
    ]
    const stream = this.launchStream(worldId, realProjectPath)
    const env = {
      ...process.env,
      MC_UDP_PORT: String(mediaPort),
      MC_UDP_INPUT_PORT: String(inputPort),
      MC_INSTANCE_ID: worldId,
      MC_PLAYER_INDEX: String(cloneIndexOf(cloneId)),
      MC_CONTROL_TCP_PORT: String(controlPort),
      MC_CONTROL_TOKEN: inst.controlToken,
      MC_UDP_RES: stream.res,
      MC_STREAM_SCENE: scene,
      ...winhookEnv(),
      ...modalFilesEnv(cloneDir)
    }
    this.refuseIfQuitting(`clone launch ${worldId}`, inst)
    this.spawnEditor(inst, editor, args, env, cloneDir)
    return inst
  }

  private async preLaunchCleanup(projectPath: string): Promise<void> {
    if (!(await isProjectLockedLive(projectPath))) rmSafe(join(projectPath, 'Temp', 'UnityLockfile'))
    rmSafe(sf(projectPath, '.mcp_quit_trigger.json'))
    this.sweepOrphanExecScripts(projectPath)
  }

  private sweepOrphanExecScripts(projectPath: string): void {
    for (const dir of [join(projectPath, 'Assets', 'Editor'), join(projectPath, '.sspace', 'exec')]) {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      let removed = 0
      for (const name of names) {
        if (!name.startsWith('_MCPExec_')) continue
        if (!name.endsWith('.cs') && !name.endsWith('.cs.meta')) continue
        rmSafe(join(dir, name))
        removed++
      }
      if (removed) console.log(`[unity] removed ${removed} orphaned exec script file(s) in ${dir}`)
    }
  }

  private clearStaleSspaceTriggers(realProjectPath: string): void {
    const stale = [
      '.mcp_quit_trigger.json',
      PLAYERS_COMMAND_FILE,
      PLAYERS_RESULT_FILE,
      MPPM_LINKS_FILE,
      ORCHESTRATOR_FILE,
      STATUS_FILE,
      ...RESULT_FILES
    ]
    for (const name of stale) rmSafe(sf(realProjectPath, name))
    this.mppmLinks.delete(realProjectPath)
  }

  private requestMppmLink(realProjectPath: string, vpId: string, cloneId: string): void {
    const index = cloneIndexOf(cloneId) + 1
    let links = this.mppmLinks.get(realProjectPath)
    if (!links) {
      links = new Map()
      this.mppmLinks.set(realProjectPath, links)
    }
    for (const [id, i] of links) if (i === index && id !== vpId) links.delete(id)
    links.set(vpId, index)
    const body = JSON.stringify({ links: [...links].map(([id, i]) => ({ index: i, vpId: id })) })
    const file = sf(realProjectPath, MPPM_LINKS_FILE)
    guardSspace(realProjectPath)
    try {
      const tmp = `${file}.tmp`
      writeFileSync(tmp, body)
      renameSync(tmp, file)
    } catch (e) {
      console.log(`[unity] MPPM link request for ${vpId} failed: ${(e as Error).message}`)
    }
  }

  private resetMpBaseline(realProjectPath: string): void {
    const desired = worldStore.getWorld(realProjectPath).desired
    if (desired.playerCount !== 1) {
      console.log(`[unity] reset MP baseline ${realProjectPath}: playerCount ${desired.playerCount} → 1`)
      worldStore.setDesired(realProjectPath, { playerCount: 1 })
    }
  }

  private async clearStaleCloneState(realProjectPath: string): Promise<void> {
    const vp = join(realProjectPath, 'Library', 'VP')
    await this.reapCloneProcesses(vp)
    let names: string[]
    try {
      names = readdirSync(vp, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('mppm'))
        .map((e) => e.name)
    } catch {
      return
    }
    let cleared = 0
    for (const name of names) {
      const dir = join(vp, name)
      if (this.instances.has(dir)) continue
      this.removeCloneDir(dir)
      cleared++
    }
    if (cleared) console.log(`[unity] cleared ${cleared} stale clone dir(s) under ${vp}`)
  }

  private async reapCloneProcesses(vpDir: string): Promise<void> {
    const pids = clonePidsUnder(await listUnityProcesses(), vpDir)
    let killed = 0
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
        killed++
      } catch {
      }
    }
    if (killed) console.log(`[unity] reaped ${killed} orphan clone editor(s) under ${vpDir}: pid ${pids.join(', ')}`)
  }

  private reapCloneProcessesSync(vpDir: string): void {
    for (const pid of clonePidsUnder(listUnityProcessesSync(), vpDir)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
      }
    }
  }

  private onPacket(inst: Instance, msg: Buffer): void {
    if (msg.length < 1) return
    const type = msg[0]

    if (type === 0x50) {
      if (msg.length < 5) return
      this.emit(inst, 'unity:pong', { pingId: msg.readUInt32LE(1) })
      return
    }

    if (type === 0x43) {
      if (msg.length < 2) return
      const extended = msg.length >= 8
      const imageId = extended ? msg.readUInt32LE(4) : 0
      const image = imageId !== 0 && inst.cursorImage?.id === imageId ? inst.cursorImage : null
      const state = { locked: msg[1] === 1, visible: extended ? msg[2] !== 0 : true }
      const prev = inst.cursorState
      inst.cursorState = state
      if (!prev || prev.locked !== state.locked || prev.visible !== state.visible)
        for (const cb of this.cursorListeners) {
          try {
            cb(inst.worldId, state)
          } catch {
          }
        }
      this.emit(inst, 'unity:cursor', { ...state, image })
      return
    }

    if (type === 0x4b) {
      if (msg.length < 9) return
      const id = msg.readUInt32LE(1)
      if (inst.cursorImage?.id === id) return
      inst.cursorImage = {
        id,
        x: msg.readUInt16LE(5),
        y: msg.readUInt16LE(7),
        url: `data:image/png;base64,${msg.subarray(9).toString('base64')}`
      }
      return
    }

    if (type === SURFACE_PACKET) {
      if (!inst.streamPushedForPlay) {
        inst.streamPushedForPlay = true
        this.applyDesiredStream(inst)
      }
      const info = parseSurfacePacket(msg)
      if (info) {
        const v = inst.gate.accept(info)
        if (!v.ok) {
          if (v.count <= 5 || v.count % 100 === 0)
            debugLog(`[stream] ${inst.worldId}: rejected frame gen=${info.generation} ${info.width}x${info.height} id=${info.handleLow} seq=${info.seq ?? '-'} (${v.reason}, ${v.count} so far; current gen=${inst.gate.identity?.generation ?? '-'} ${inst.gate.identity ? `${inst.gate.identity.width}x${inst.gate.identity.height}` : ''} seq=${inst.gate.lastSeq})`)
          return
        }
        if (v.newGeneration)
          debugLog(`[stream] ${inst.worldId}: ${v.retired ? `gen ${v.retired.generation} ${v.retired.width}x${v.retired.height}` : 'idle'} -> streaming gen ${info.generation} ${info.width}x${info.height} from seq ${info.seq ?? '-'}`)
        const viewers = [...remoteVideo.subscribersFor(inst.worldId, videoRecorder.subscribersFor(inst.worldId, inst.subscribers))]
        inst.holds.onFrame(info.generation, info.seq, viewers.filter(([, wcId]) => wcId >= 0).map(([id, wcId]) => `${wcId}:${id}`))
        if (v.newGeneration) this.pushHeld(inst)
        const r = presentSurface(inst.worldId, info, inst.proc?.pid, viewers)
        if (r.error) {
          this.emit(inst, 'unity:sharedError', { message: r.error })
        }
        if (v.newGeneration) this.sendUdp(inst, Buffer.from(JSON.stringify({ genAck: info.generation })))
        if (r.surfaceId != null) {
          this.emit(inst, 'unity:sharedFrame', {
            surfaceId: r.surfaceId,
            generation: r.generation ?? undefined,
            t: performance.now(),
            seq: ++frameSeq,
            useq: info.seq ?? undefined
          })
          videoRecorder.onFrame(inst.worldId, r.surfaceId, info.generation, info.width, info.height, info.stamp, info.seq)
          remoteVideo.onFrame(inst.worldId, r.surfaceId, info.generation, info.width, info.height, info.seq ?? null)
        }
      }
      return
    }

    if (type === AUDIO_PACKET) videoRecorder.onAudio(inst.worldId, msg)
  }

  private quitReachability(inst: Instance): { reachable: boolean; why?: string } {
    if (inst.exited) return { reachable: false, why: 'already exited' }
    if (inst.fault) return { reachable: false, why: inst.fault.kind === 'hung' ? 'the editor is not responding' : 'the editor crashed' }
    if (!inst.sawEditor && !inst.editModeReady && !inst.live)
      return { reachable: false, why: 'the editor bridge never came up' }
    const obs = worldStore.getWorld(inst.realProjectPath).observed.instances[inst.worldId]
    if (obs?.reachable === false) return { reachable: false, why: 'the editor stopped responding' }
    return { reachable: true }
  }

  private async shutdown(inst: Instance): Promise<void> {
    const reach = this.quitReachability(inst)
    this.teardownQueue(inst)
    const quit = sf(inst.projectPath, '.mcp_quit_trigger.json')
    const lock = join(inst.projectPath, 'Temp', 'UnityLockfile')
    const pid = inst.proc?.pid ?? null
    const outcome = await quitEditor(
      {
        exited: () => inst.exited,
        requestQuit: () => {
          guardSspace(inst.projectPath)
          writeFileSync(quit, '{}')
        },
        signal: (sig) => {
          inst.proc?.kill(sig)
        }
      },
      { reachable: reach.reachable && !this.cancelling.has(inst.realProjectPath) }
    )
    console.log(
      `[unity] quit ${inst.kind} ${inst.worldId} pid=${pid ?? '-'}: ${describeQuit(outcome, EDITOR_QUIT_TIMINGS.graceMs, reach.why)}`
    )
    try {
      inst.socketChannel?.close()
    } catch {
    }
    inst.worldWatchStop?.()
    videoRecorder.drop(inst.worldId)
    this.byWorldId.delete(inst.worldId)
    worldStore.detachInstance(inst.worldId)
    this.reconciler?.forgetInstance(inst.worldId)
    if (inst.kind === 'primary') this.reconciler?.untrack(inst.projectPath)
    try {
      inst.recv.close()
    } catch {
    }
    try {
      inst.send.close()
    } catch {
    }
    rmSafe(quit)
    rmSafe(lock)
    clearModalFiles(inst.projectPath)
    if (inst.kind === 'clone') {
      this.removeCloneDir(inst.projectPath)
    } else {
      clearProjectState(inst.projectPath)
    }
    console.log(`[unity] shut down instance project=${inst.projectPath}`)
  }
}

export const unityProvider = new UnityInstanceProvider()
unityProvider.wireLifecycle()
