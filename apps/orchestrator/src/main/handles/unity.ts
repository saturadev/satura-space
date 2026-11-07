import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { unityProvider } from '../unity/unity-instance-provider'
import { worldStore } from '../unity/world-store'
import { tunerService } from '../unity/tuner'
import { hubAppPath, hubLaunchCommand, hubState, setHubOverride, startHub } from '../unity/unity-hub'
import type { HubState } from '@shared/api'
import { MAX_PLAYERS } from '@shared/unity/world'
import { readTail, unityEditorLogPath } from '../satura-exec/logs'
import { defineHandle, sleep, waitUntil, TEST_PROJECT, type HandleCtx } from './registry'
import { guardDialogs } from './dialogs'
import { relaunchProjectAndWait } from '../unity/unity-lifecycle-call'
import { lifecycleText, stateLabel, stateTitle, type UnityLifecycle } from '@shared/unity/lifecycle'
import { unityLifecycle } from '../unity/lifecycle'

const FATAL = /Safe Mode: Only loading a subset of assemblies|Internal build system error|\berror CS\d{4}\b/
const LOG_BYTES = 256 * 1024

interface Primary {
  id: string
  project: string
}

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function primaryOf(projectRoot: string): Primary | null {
  const want = projectRoot || TEST_PROJECT
  const live = unityProvider.listInstances().filter((i) => i.kind === 'primary')
  const owner = live.filter((i) => within(want, i.realProjectPath)).sort((a, b) => b.realProjectPath.length - a.realProjectPath.length)[0]
  const inner = live.filter((i) => within(i.realProjectPath, want)).sort((a, b) => a.realProjectPath.length - b.realProjectPath.length)[0]
  const hit = owner ?? inner ?? (live.length === 1 && !projectRoot ? live[0] : undefined)
  return hit ? { id: hit.id, project: hit.realProjectPath } : null
}

export function needPrimary(ctx: HandleCtx): Primary {
  const p = primaryOf(ctx.projectRoot)
  if (!p) throw new Error(`No Unity editor is open for ${ctx.projectRoot || TEST_PROJECT}. Call unity.ready first: it opens the Unity Player panel and waits for the editor.`)
  return p
}

export function logSize(project: string): number {
  try {
    return statSync(unityEditorLogPath(project)).size
  } catch {
    return 0
  }
}

function fatalSince(project: string, offset: number): string[] {
  const size = logSize(project)
  if (size <= offset) return []
  return readTail(unityEditorLogPath(project), Math.min(size - offset, LOG_BYTES)).filter((l) => FATAL.test(l)).map((l) => l.trim()).slice(0, 12)
}

function heartbeat(project: string): { pid: number | null; ageS: number | null; ts: number | null } {
  try {
    const raw = JSON.parse(readFileSync(join(project, '.sspace', '.mcp_status.json'), 'utf8')) as { pid?: unknown; timestamp?: unknown }
    const ts = Number(raw.timestamp)
    return { pid: Number(raw.pid) || null, ageS: Number.isFinite(ts) ? Math.round(Date.now() / 1000 - ts) : null, ts: Number.isFinite(ts) ? ts : null }
  } catch {
    return { pid: null, ageS: null, ts: null }
  }
}

export function unityState(p: Primary): Record<string, unknown> {
  const world = worldStore.getWorld(p.project)
  const obs = world.observed.instances[p.id]
  const desired = world.desired.instances[p.id]
  const status = unityProvider.primaryStatus(p.project)
  return {
    project: p.project,
    pid: status.pid,
    launching: status.launching,
    heartbeat: heartbeat(p.project),
    lifecycle: obs?.lifecycle ?? null,
    compile: obs?.compile ?? null,
    compileError: obs?.compileError ?? null,
    error: obs?.error ?? null,
    warning: obs?.warning ?? null,
    scene: obs?.scene ?? '',
    sceneDirty: obs?.sceneDirty ?? false,
    saving: obs?.saving ?? false,
    paused: obs?.paused ?? false,
    hotReload: obs?.hotReloadActive ?? false,
    bridge: { connected: obs?.connected ?? false, reachable: obs?.reachable ?? false, alive: obs?.alive ?? false },
    progress: obs?.progressLabel ? `${obs.progressLabel} ${Math.round(obs.progressPct)}%` : '',
    fps: obs?.fps ?? 0,
    desired: desired ? { playing: desired.playing, scene: desired.scene } : null
  }
}

const NO_PROGRESS_MS = 30_000
const NONE_GRACE_MS = 8_000

function logBlock(lines: string[]): string {
  return lines.length ? `\nLast editor log lines:\n${lines.map((l) => `  ${l}`).join('\n')}` : ''
}

export function editorBlocker(project: string, sinceMs: number): string | null {
  const s = unityProvider.editorWaitState(project)
  const log = logBlock(s.log)
  if (s.state === 'exited') return `Unity isn't running. ${s.error ?? (s.code !== null ? `It exited with code ${s.code}.` : 'It exited.')}${log}\nRelaunch it with unity.relaunch.`
  if (s.state === 'failed') return `Unity didn't start. ${s.error ?? 'It entered Safe Mode or stopped responding while starting.'}${log}\nFix what the log shows, then unity.relaunch.`
  if (s.state === 'hub') return unityProvider.lifecycle(project).hub === 'starting' ? null : (s.error ?? 'Unity Hub isn\'t running.')
  if (s.state === 'missing') return s.error ?? "This project needs a Unity version that isn't installed."
  if (s.state === 'refused') return s.error ?? 'Satura Space refused to start Unity for this project.'
  if (s.state === 'stopped') return 'Unity is stopped for this project. unity.relaunch starts it again.'
  if (s.state === 'none' && Date.now() - sinceMs > NONE_GRACE_MS) return `Unity isn't running for this project, and nothing is starting it.${log}\nCall unity.ready to open the Unity panel, or unity.relaunch.`
  return null
}

function progressMark(project: string): string {
  const s = unityProvider.editorWaitState(project)
  const beat = heartbeat(project)
  return [s.state, s.pid, s.lifecycle, s.progress, s.logSize, logSize(project), beat.pid, beat.ts].join('|')
}

export function editorWait<T>(ctx: HandleCtx, project: string, what: string, read: () => T | null | undefined | false, timeoutMs: number): Promise<T> {
  const since = Date.now()
  let mark = ''
  let moved = since
  return waitUntil(what, async () => {
    await guardDialogs(ctx, project)
    const value = read()
    if (value) return value
    const stop = editorBlocker(project, since)
    if (stop) throw new Error(stop)
    const now = progressMark(project)
    if (now !== mark) {
      mark = now
      moved = Date.now()
    } else if (Date.now() - moved >= NO_PROGRESS_MS) {
      const s = unityProvider.editorWaitState(project)
      throw new Error(`Unity showed no progress for ${Math.round(NO_PROGRESS_MS / 1000)} s while waiting for ${what}${s.progress ? ` (last progress: ${s.progress})` : ''}, so the wait stopped. It may be frozen or waiting on something.${logBlock(s.log.length ? s.log : readTail(unityEditorLogPath(project), 8192).filter((l) => l.trim()).slice(-4))}`)
    }
    return null
  }, timeoutMs, ctx.signal)
}

export function settled(p: Primary, want: (lifecycle: string) => boolean, offset: number): Record<string, unknown> | null {
  const fatal = fatalSince(p.project, offset)
  if (fatal.length) throw new Error(`The editor hit a compile error or Safe Mode:\n${fatal.join('\n')}`)
  const state = unityState(p)
  if (state.compile === 'error') throw new Error(`The project has compile errors: ${String(state.compileError ?? '')}`)
  if (state.lifecycle === 'error' || state.lifecycle === 'exited') throw new Error(`The editor is in state ${String(state.lifecycle)}: ${String(state.error ?? '')}`)
  const beat = state.heartbeat as { pid: number | null; ageS: number | null }
  if (state.compile === 'compiling' || state.launching || beat.pid !== state.pid || beat.ageS === null || beat.ageS > 10) return null
  return want(String(state.lifecycle)) ? state : null
}

async function waitReady(ctx: HandleCtx, timeoutS: number, offset?: number): Promise<Record<string, unknown>> {
  const p = needPrimary(ctx)
  const from = offset ?? logSize(p.project)
  return editorWait(ctx, p.project, 'the editor to settle in Edit or Play Mode', () => settled(p, (l) => l === 'editmode' || l === 'playing', from), timeoutS * 1000)
}

defineHandle({
  name: 'unity.hub',
  side: 'main',
  description: 'Reports whether Unity Hub is ready, starting, not running or not installed, where it is installed and the command the Start Unity Hub button runs. With start true it runs that command; with dryRun true it only returns it.',
  params: { start: false, dryRun: true },
  async run(p) {
    const before = await hubState()
    const started = p.start ? await startHub(p.dryRun !== false) : null
    return { state: before, after: started ? await hubState() : undefined, path: await hubAppPath(), command: await hubLaunchCommand(), started }
  }
})

defineHandle({
  name: 'unity.hubOverride',
  side: 'main',
  description: 'Dev only: makes Unity Hub detection report the given state (ready, starting, not-running, not-installed). An empty state clears the override. While it says not-running, Start Unity Hub simulates a start (starting for 4 s, then ready) instead of running the Hub.',
  params: { state: '' },
  async run(p) {
    const forced = setHubOverride((String(p.state ?? '') || null) as HubState | null)
    return { override: forced, state: await hubState() }
  }
})

defineHandle({
  name: 'unity.ready',
  side: 'main',
  long: true,
  description:
    'Waits until the Unity editor for the project is up and idle in Edit or Play Mode. If no editor is running and open is true, it opens the Unity Player panel first, which launches one. Fails on a compile error, Safe Mode or a timeout, and right away when Unity Hub isn\'t running or installed (the panel then shows Start Unity Hub). Returns pid, lifecycle, compile state, scene and bridge connection. Like every handle that waits on the editor, it watches for Unity dialogs: a known-safe one (Scene Backup gets Keep Backups, a corrupted Library gets Don\'t rebuild) is answered and listed in dialogs, and any other dialog ends the call with status blocked and its title, text and buttons in value.',
  params: { timeout: 300, open: true },
  async run(p, ctx) {
    const timeout = Number(p.timeout) || 300
    if (!primaryOf(ctx.projectRoot)) {
      if (!p.open) throw new Error(`No Unity editor is open for ${ctx.projectRoot || TEST_PROJECT}.`)
      ctx.log('no editor yet, opening the Unity Player panel')
      await ctx.renderer('layout.open', { kind: 'unity' })
      await editorWait(ctx, ctx.projectRoot || TEST_PROJECT, 'the editor process to start', () => primaryOf(ctx.projectRoot), 60_000)
    }
    return waitReady(ctx, timeout)
  }
})

defineHandle({
  name: 'unity.play',
  side: 'main',
  long: true,
  description: 'Enters Play Mode in the primary editor and waits until it is playing. Fails on compile errors or a timeout. Returns the editor state.',
  params: { timeout: 120 },
  async run(p, ctx) {
    const pr = needPrimary(ctx)
    await guardDialogs(ctx, pr.project)
    const offset = logSize(pr.project)
    worldStore.setDesired(pr.project, { instances: { [pr.id]: { playing: true } } })
    return editorWait(ctx, pr.project, 'Play Mode', () => settled(pr, (l) => l === 'playing', offset), (Number(p.timeout) || 120) * 1000)
  }
})

defineHandle({
  name: 'unity.stop',
  side: 'main',
  long: true,
  description: 'Leaves Play Mode and waits until the editor is back in Edit Mode. Returns the editor state.',
  params: { timeout: 120 },
  async run(p, ctx) {
    const pr = needPrimary(ctx)
    await guardDialogs(ctx, pr.project)
    const offset = logSize(pr.project)
    worldStore.requestStop(pr.project, pr.id)
    return editorWait(ctx, pr.project, 'Edit Mode', () => settled(pr, (l) => l === 'editmode', offset), (Number(p.timeout) || 120) * 1000)
  }
})

defineHandle({
  name: 'unity.relaunch',
  side: 'main',
  long: true,
  description: 'Restarts the primary editor, or starts it when none runs, the same as unity.relaunch() in satura_exec, and follows the Unity lifecycle until the new editor is ready. A missing Unity version is waited out: the relaunch keeps waiting while Unity Hub installs it. Fails with the lifecycle reason. Returns the new pid and editor state with the lifecycle record.',
  params: { timeout: 400 },
  async run(p, ctx) {
    const project = primaryOf(ctx.projectRoot)?.project ?? (ctx.projectRoot || TEST_PROJECT)
    if (!unityProvider.managesProject(project)) throw new Error(`Satura Space doesn't run Unity for ${project}. Call unity.ready first: it opens the Unity Player panel.`)
    const out = await relaunchProjectAndWait(project, (Number(p.timeout) || 400) * 1000, ctx.signal, (line) => ctx.log(line))
    if (!out.ok) throw new Error(out.message)
    const pr = needPrimary(ctx)
    return { ...unityState(pr), lifecycle: out.life, text: lifecycleText(out.life) }
  }
})

defineHandle({
  name: 'unity.stopEditor',
  side: 'main',
  long: true,
  description: "Stops the project's editors the way Stop in the Player menu does: asks each to quit, kills one that doesn't, and leaves Unity stopped until unity.relaunch or unity.ready. Returns whether it stopped, the primary pid it stopped and whether that process is still alive, with the lifecycle record.",
  params: {},
  async run(_p, ctx) {
    const pr = primaryOf(ctx.projectRoot)
    const project = pr?.project ?? (ctx.projectRoot || TEST_PROJECT)
    if (!unityProvider.managesProject(project)) throw new Error(`Satura Space doesn't run Unity for ${project}.`)
    const pid = unityProvider.listInstances().find((i) => i.kind === 'primary' && i.realProjectPath === project)?.pid ?? null
    const r = await unityProvider.stopProject(project)
    if (!r.ok) throw new Error(r.error ?? 'Stop failed.')
    let alive = false
    if (pid) {
      try {
        process.kill(pid, 0)
        alive = true
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === 'EPERM'
      }
    }
    const life = unityProvider.lifecycle(project)
    return { stopped: true, pid, alive, lifecycle: life, text: lifecycleText(life) }
  }
})

const GUARDED_PREFS = /SaturaSpace\.PrefGuard|^\s*"?(EnterSafeModeDialog|ScriptCompilationDuringPlay)"?\s*=/

function guardPrefs(): Record<string, string> | string {
  if (process.platform !== 'darwin') return 'EditorPrefs are read from the macOS defaults domain; on Windows use unity.exec with EditorPrefs.'
  try {
    const text = execFileSync('defaults', ['read', 'com.unity3d.UnityEditor5.x'], { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024 })
    const out: Record<string, string> = {}
    for (const line of text.split('\n')) {
      if (!GUARDED_PREFS.test(line)) continue
      const m = /^\s*"?([^"=]+?)"?\s*=\s*"?(.*?)"?;\s*$/.exec(line)
      if (m) out[m[1].trim()] = m[2]
    }
    return out
  } catch (e) {
    return `defaults read failed: ${(e as Error).message}`
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

defineHandle({
  name: 'unity.kill',
  side: 'main',
  long: true,
  agentOnly: true,
  description:
    "Kills the test project's primary editor with SIGKILL, the way a crash would: no quit, so nothing the editor does on quit runs (SaturaPrefGuard leaves its saved prefs and holder pid behind, Unity leaves its lockfile and a scene backup). Only runs on the test project and only on an editor this app launched. Waits up to waitMs for the process to die. Returns the pid, whether it is gone, the guarded EditorPrefs (EnterSafeModeDialog, ScriptCompilationDuringPlay and the SaturaSpace.PrefGuard.*.orig / .holders keys from the macOS defaults domain) before and after, and the lifecycle record. kill: false only reads the prefs. After a kill, unity.relaunch starts a new editor (unity.ready refuses a crashed one); its [PrefGuard] lines (saved, set to, restored ... left behind by an editor that didn't quit cleanly) are in unity.logs({ source: 'editor', grep: 'PrefGuard' }). On macOS Unity keeps EditorPrefs in memory until it quits, so the defaults domain shows only what was flushed; unity.exec with EditorPrefs reads the live values.",
  params: { kill: true, waitMs: 15_000 },
  async run(p, ctx) {
    const project = ctx.writableProject()
    if (p.kill === false) return { prefs: guardPrefs(), lifecycle: unityProvider.lifecycle(project) }
    const inst = unityProvider.listInstances().find((i) => i.kind === 'primary' && i.realProjectPath === project)
    if (!inst?.pid) throw new Error(`This app runs no editor for ${project}. Call unity.ready first.`)
    const pid = inst.pid
    const before = guardPrefs()
    ctx.log(`SIGKILL editor pid ${pid} of ${project}`)
    process.kill(pid, 'SIGKILL')
    const deadline = Date.now() + Math.max(1000, Number(p.waitMs) || 15_000)
    while (alive(pid) && Date.now() < deadline) await sleep(200, ctx.signal)
    const gone = !alive(pid)
    await sleep(1000, ctx.signal)
    const life = unityProvider.lifecycle(project)
    return { pid, gone, prefs: { before, after: guardPrefs() }, lifecycle: life, text: lifecycleText(life) }
  }
})

defineHandle({
  name: 'unity.lifecycle',
  side: 'main',
  description: 'Reads the Unity lifecycle record of the project, the one stream the Unity panel, unity.status(), unity.relaunch() and the MCP read: phase (idle, missing, installing, hub, stopped, refused, launching, importing, compiling, ready, failed), the version ProjectVersion.txt asks for, the installed editors, the Unity Hub install progress, pid, error and what to do next. managed says whether the app runs Unity for the project.',
  params: {},
  async run(_p, ctx) {
    const project = primaryOf(ctx.projectRoot)?.project ?? (ctx.projectRoot || TEST_PROJECT)
    const life = unityProvider.lifecycle(project)
    return { managed: unityProvider.managesProject(project), ...life, text: lifecycleText(life) }
  }
})

function stateView(project: string, life: UnityLifecycle): Record<string, unknown> {
  return {
    project,
    managed: unityProvider.managesProject(project),
    state: life.state,
    label: stateLabel(life),
    stage: life.stage,
    code: life.code,
    title: stateTitle(life),
    reason: life.error,
    actions: life.actions,
    exitCode: life.exitCode,
    pid: life.pid,
    phase: life.phase,
    seq: life.seq,
    since: life.stateSince ?? life.since,
    history: unityProvider.lifecycleHistory(project)
  }
}

defineHandle({
  name: 'unity.state',
  side: 'main',
  long: true,
  description:
    "Reads the Unity editor state machine of the project, the one record the desktop panels and the phone draw: state (idle, starting, ready, stopping, stopped, failed, exited), label (like starting(importing), failed(guard), ready(playing)), stage while starting, code and reason when failed, the actions the panels offer (retry, install, start-hub, open-project, close-other), and history, every transition with its time and why. until: '<state or label prefix>' waits up to timeout seconds for it. retry: true first presses Retry the way the panels do. cancel: true first presses Cancel, which while starting or stopping ends the launch or the editor and leaves the project stopped. Returns the state, plus waited and matched when until is set.",
  params: { until: '', timeout: 60, retry: false, cancel: false },
  async run(p, ctx) {
    const project = primaryOf(ctx.projectRoot)?.project ?? (ctx.projectRoot || TEST_PROJECT)
    if (p.cancel) {
      const r = await unityProvider.cancelProject(project, 'the unity.state handle')
      ctx.log(`cancel: ${r.ok ? 'ok' : 'failed'}${r.error ? ` (${r.error})` : ''}${r.note ? ` ${r.note}` : ''}`)
    }
    if (p.retry) {
      const r = await unityProvider.retryProject(project, 'the unity.state handle')
      ctx.log(`retry: ${r.ok ? 'ok' : 'failed'}${r.error ? ` (${r.error})` : ''}${r.note ? ` ${r.note}` : ''}`)
    }
    let life = unityProvider.lifecycle(project)
    const until = String(p.until ?? '').trim()
    if (!until) return stateView(project, life)
    const key = life.project
    const hit = (l: UnityLifecycle): boolean => l.state === until || stateLabel(l).startsWith(until)
    const started = Date.now()
    const deadline = started + Math.max(1, Number(p.timeout) || 60) * 1000
    while (!hit(life) && Date.now() < deadline && !ctx.signal?.aborted) life = await unityLifecycle.next(key, life.seq, Math.min(2000, deadline - Date.now()), ctx.signal)
    life = unityProvider.lifecycle(project)
    return { ...stateView(project, life), matched: hit(life), waitedMs: Date.now() - started }
  }
})

defineHandle({
  name: 'unity.reveal',
  side: 'main',
  description:
    'Reveals the primary editor window (show true) or hides it again (show false), the same as Reveal and Hide in the panel menu. Revealing puts the Unity window on screen and takes focus. Returns whether the editor now counts as revealed.',
  params: { show: true },
  async run(p, ctx) {
    const pr = needPrimary(ctx)
    const r = p.show === false ? await unityProvider.hideEditor(pr.project) : unityProvider.revealEditor(pr.project)
    if (!r.ok) throw new Error(r.error ?? 'The editor did not change.')
    return { revealed: unityProvider.isEditorRevealed(pr.project) }
  }
})

defineHandle({
  name: 'unity.players',
  side: 'main',
  description:
    'Sets how many players run, 1 being the primary alone, like the add and remove player buttons. Edit Mode only. Each added player is a clone editor that boots in the background; unity.players() in satura_exec shows when it is up. Returns the requested count.',
  params: { count: 1 },
  async run(p, ctx) {
    const pr = needPrimary(ctx)
    const count = Math.round(Number(p.count))
    if (!Number.isFinite(count) || count < 1 || count > MAX_PLAYERS) throw new Error(`count must be 1 to ${MAX_PLAYERS}`)
    if (worldStore.playModeActive(pr.project)) throw new Error('Players change only in Edit Mode: stop Play Mode first.')
    worldStore.setDesired(pr.project, { playerCount: count })
    return { count }
  }
})

defineHandle({
  name: 'unity.openScene',
  side: 'main',
  long: true,
  description: "Opens a scene in the primary editor by asset path, like 'Assets/Scenes/Prototype.unity', and waits until it is loaded in Edit Mode. If the open scenes have unsaved changes it fails and names them, unless unsaved is 'save' (save them first) or 'discard' (drop them). Returns the editor state.",
  params: { scene: '', unsaved: '', timeout: 120 },
  async run(p, ctx) {
    const scene = String(p.scene ?? '').trim()
    if (!scene.endsWith('.unity')) throw new Error("Pass scene as an asset path, like 'Assets/Scenes/Prototype.unity'.")
    const unsaved = String(p.unsaved ?? '')
    if (unsaved && unsaved !== 'save' && unsaved !== 'discard') throw new Error("unsaved is 'save' or 'discard'.")
    const pr = needPrimary(ctx)
    await guardDialogs(ctx, pr.project)
    const obs = worldStore.getWorld(pr.project).observed.instances[pr.id]
    if (obs?.sceneDirty && String(obs.scene ?? '') !== scene) {
      const dirty = (obs.dirtyScenes || obs.scene || 'the open scene').split('\n').join(', ')
      if (!unsaved) throw new Error(`${dirty} has unsaved changes, so the scene wasn't switched. Pass unsaved: 'save' to save them first, or unsaved: 'discard' to drop them.`)
      const r = unsaved === 'save' ? await tunerService.saveScene(pr.project) : await tunerService.discardScene(pr.project)
      if (!r.ok) throw new Error(`Could not ${unsaved} the changes in ${dirty}: ${r.error}`)
    }
    const offset = logSize(pr.project)
    const before = worldStore.getWorld(pr.project).desired.instances[pr.id]?.sceneGen ?? 0
    worldStore.setDesired(pr.project, { instances: { [pr.id]: { scene, playing: false, sceneGen: before + 1, sceneForceGen: before + 1 } } })
    return editorWait(ctx, pr.project, `scene ${scene}`, () => {
      if ((worldStore.getWorld(pr.project).observed.instances[pr.id]?.sceneGen ?? 0) <= before) return null
      const state = settled(pr, (l) => l === 'editmode', offset)
      return state && String(state.scene ?? '').replace(/\\/g, '/').endsWith(scene) ? state : null
    }, (Number(p.timeout) || 120) * 1000)
  }
})
