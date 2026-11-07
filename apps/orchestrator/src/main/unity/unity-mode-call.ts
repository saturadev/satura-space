import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isScratchpadPath, scratchpadParentProject } from '@shared/scratchpads'
import { primaryWorldId } from '@shared/unity/ids'
import { isUnityMode, type UnityMode } from '@shared/unity/world'
import type { UnityStartResult } from '@shared/api'
import { unityProvider } from './unity-instance-provider'
import { worldStore } from './world-store'
import { scratchpads } from './scratchpads'
import { canonicalProject, findScratchpad, listScratchpads, readScratchpadName } from './scratchpad-store'
import { inputGateMessage } from './input-gate'
import { debugLog } from '@shared/debug-log'

const CLONE_DIR = /[\\/]Library[\\/]VP[\\/]mppm[0-9a-f]{8}[\\/]?$/
const MODES = 'normal, headless-graphics or headless-nographics'
const SETTLED = new Set(['editmode', 'playing'])
const DEFAULT_WAIT_S = 300
const POLL_MS = 250

type Target = { kind: 'project' | 'scratchpad' | 'clone'; path: string; root: string; scratchpad: string | null; padName?: string; name: string }

export interface UnityModeState {
  mode: UnityMode
  kind: Target['kind']
  path: string
  running: boolean
  lifecycle: string | null
  pid: number | null
  scratchpad?: string
  scratchpadName?: string
  note?: string
}

function named(message: string, name: string): Error {
  const e = new Error(message)
  e.name = name
  return e
}

function trimPath(p: string): string {
  return p.trim().replace(/[\\/]+$/, '')
}

async function target(params: Record<string, unknown>, projectRoot: string): Promise<Target> {
  const ref = typeof params.scratchpad === 'string' ? params.scratchpad.trim() : ''
  const raw = trimPath(typeof params.path === 'string' && params.path.trim() ? params.path : projectRoot)
  if (ref) {
    const root = canonicalProject(raw || projectRoot)
    const meta = findScratchpad(await listScratchpads(root), ref)
    if (!meta) throw named(`No scratchpad “${ref}” in ${root}. scratchpad.list() shows them.`, 'TypeError')
    return { kind: 'scratchpad', path: meta.path, root, scratchpad: meta.id, padName: meta.name, name: `scratchpad “${meta.name}”` }
  }
  if (!raw) throw named('This call has no project: run it from a terminal of the project, or use unity.at(folder).', 'TypeError')
  if (CLONE_DIR.test(raw)) {
    const root = raw.replace(CLONE_DIR, '')
    return { kind: 'clone', path: raw, root, scratchpad: null, name: `clone ${basename(raw)}` }
  }
  if (isScratchpadPath(raw)) {
    const root = canonicalProject(scratchpadParentProject(raw) ?? raw)
    const id = basename(raw)
    const meta = findScratchpad(await listScratchpads(root), id)
    if (!meta) throw named(`${raw} is not a scratchpad of ${root}. scratchpad.list() shows them.`, 'TypeError')
    return { kind: 'scratchpad', path: meta.path, root, scratchpad: meta.id, padName: meta.name, name: `scratchpad “${meta.name}”` }
  }
  if (!existsSync(join(raw, 'Assets'))) throw named(`${raw} is not a Unity project folder.`, 'TypeError')
  return { kind: 'project', path: raw, root: raw, scratchpad: null, name: basename(raw) }
}

function state(t: Target, note?: string): UnityModeState {
  const st = unityProvider.primaryStatus(t.path)
  const mode = t.kind === 'clone' ? 'normal' : unityProvider.activeUnityMode(t.path)
  return {
    mode,
    kind: t.kind,
    path: t.path,
    running: st.running,
    lifecycle: st.lifecycle,
    pid: st.pid,
    ...(t.scratchpad ? { scratchpad: t.scratchpad, scratchpadName: t.padName } : {}),
    ...(note ? { note } : {})
  }
}

function failure(t: Target, r: UnityStartResult): Error {
  if (r.inputGate) return named(inputGateMessage(t.path, r.inputGate), 'InputSystemRequired')
  if (r.hub) return named(r.error ?? `Unity Hub is ${r.hub}: start it, then retry.`, 'UnityHubError')
  if (r.standalone) return named(r.error ?? `Another Unity is open on ${t.name}. Close it, then retry.`, 'UnityError')
  return named(r.error ?? `Unity didn't relaunch ${t.name}.`, 'UnityError')
}

function observedError(path: string): string | null {
  return worldStore.getWorld(path).observed.instances[primaryWorldId(path)]?.error ?? null
}

async function settle(t: Target, mode: UnityMode, waitS: number): Promise<UnityModeState> {
  const until = Date.now() + waitS * 1000
  let seenRunning = false
  for (;;) {
    const st = unityProvider.primaryStatus(t.path)
    if (st.running) seenRunning = true
    if (st.running && !st.launching && st.lifecycle && SETTLED.has(st.lifecycle) && unityProvider.activeUnityMode(t.path) === mode)
      return state(t)
    if (st.lifecycle === 'error') throw named(`${t.name} failed to start in ${mode} mode: ${observedError(t.path) ?? 'see unity.logs()'}`, 'UnityError')
    if (seenRunning && !st.running && !st.launching)
      throw named(`${t.name} exited while starting in ${mode} mode: ${observedError(t.path) ?? 'see unity.logs()'}`, 'UnityError')
    if (Date.now() > until)
      throw named(`${t.name} is still starting in ${mode} mode after ${waitS}s (lifecycle ${st.lifecycle ?? 'none'}). Check unity.logs(), or pass a longer { timeout }.`, 'TimeoutError')
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

function prepareRelaunch(t: Target, mode: UnityMode): void {
  const world = worldStore.getWorld(t.path)
  const instances: Record<string, { playing: boolean; hotReload: boolean }> = {}
  for (const id of Object.keys(world.desired.instances)) instances[id] = { playing: false, hotReload: false }
  worldStore.setDesired(t.path, {
    instances,
    ...(mode === 'headless-nographics' && world.desired.playerCount > 1 ? { playerCount: 1 } : {})
  })
}

export async function unityModeCall(params: Record<string, unknown>, projectRoot: string): Promise<UnityModeState> {
  const t = await target(params, projectRoot)
  if (params.op !== 'set') {
    return state(t, t.kind === 'clone' ? 'Clones always run as hidden windowed editors, whatever the main project uses.' : undefined)
  }
  const mode = params.mode
  if (!isUnityMode(mode)) throw named(`unity.setMode() takes ${MODES}, got ${JSON.stringify(mode) ?? String(mode)}.`, 'TypeError')
  if (t.kind === 'clone')
    throw named(`${t.name} follows the main project: clones always run as hidden windowed editors. Set the mode on the main project with unity.setMode(), and note that headless-nographics runs one player only.`, 'TypeError')
  const before = unityProvider.primaryStatus(t.path)
  const was = unityProvider.activeUnityMode(t.path)
  debugLog(`[mode] satura_exec setMode ${t.kind} ${t.path} ${was} -> ${mode} running=${before.running}`)
  if (before.running && was !== mode) prepareRelaunch(t, mode)
  const result =
    t.kind === 'scratchpad'
      ? (await scratchpads.setMode(t.root, t.scratchpad, mode)).result
      : await unityProvider.setUnityMode(t.path, mode)
  if (!result.ok) throw failure(t, result)
  if (!before.running) return state(t, `${t.name} isn't running: the mode applies the next time it starts.`)
  const wait = params.wait === false ? 0 : typeof params.timeout === 'number' && params.timeout > 0 ? params.timeout : DEFAULT_WAIT_S
  if (wait <= 0) return state(t)
  return settle(t, mode, wait)
}

export function requireGraphics(call: string, path: string): void {
  const p = trimPath(path)
  if (!p || CLONE_DIR.test(p)) return
  if (unityProvider.activeUnityMode(p) !== 'headless-nographics') return
  const who = isScratchpadPath(p) ? `scratchpad “${readScratchpadName(p) ?? basename(p)}”` : basename(p)
  throw named(
    `${call} needs rendering, but ${who} runs in headless-nographics mode: there is no GPU, so nothing is drawn. Switch with unity.setMode('headless-graphics') (still no window) or unity.setMode('normal'), then call it again.`,
    'NoGraphicsError'
  )
}
