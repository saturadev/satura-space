import { BrowserWindow } from 'electron'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { ensureProjectSspaceSync } from '../sspace'
import { writePrivateFile } from '../secret-token'
import {
  SCRATCHPAD_HOST_FILE,
  isScratchpadPath,
  scratchpadIdOf,
  scratchpadParentProject,
  scratchpadPlayOf,
  type ScratchpadInfo,
  type ScratchpadStatus
} from '@shared/scratchpads'
import { unityProvider } from './unity-instance-provider'
import { worldStore } from './world-store'
import {
  canonicalProject,
  createScratchpad,
  deleteScratchpadDir,
  findScratchpad,
  isUnityProjectDir,
  listScratchpads,
  readScratchpadName,
  renameScratchpad,
  type ScratchpadMeta
} from './scratchpad-store'
import { ensureStarterScene } from './scratchpad-scene'
import { releaseTunerViewsUnder } from './tuner'
import { killTree, pidsWithCwdUnder } from '../git/kill-cwd-processes'
import { censusTrack } from '@shared/census'
import { isUnityMode, type EditorFaultKind, type UnityMode } from '@shared/unity/world'
import type { UnityStartResult } from '@shared/api'
import { debugLog } from '@shared/debug-log'

const NO_WINDOW = -1
const STARTING_LIFECYCLES = new Set(['init', 'launching', 'restarting'])
const PANEL_GONE_GRACE_MS = 2500
const PROC_DRAIN_MS = 10_000
const PROC_POLL_MS = 500

function faultMessage(path: string, kind: EditorFaultKind, reason: string): string {
  const name = readScratchpadName(path)
  return `Scratchpad ${name ? `“${name}” ` : ''}${kind === 'hung' ? 'is not responding' : 'crashed'}: ${reason}`
}

function holdId(meta: ScratchpadMeta): string {
  return `scratchpad:${meta.id}`
}

class ScratchpadManager {
  private stopping = censusTrack('scratchpads.stopping', new Set<string>())
  private removing = censusTrack('scratchpads.removing', new Set<string>())
  private restarting = censusTrack('scratchpads.restarting', new Set<string>())
  private launchingPads = censusTrack('scratchpads.launching', new Set<string>())
  private errors = censusTrack('scratchpads.errors', new Map<string, string>())
  private attached = censusTrack('scratchpads.attached', new Set<string>())
  private panelsByWc = censusTrack('scratchpads.panelsByWc', new Map<number, Set<string>>())
  private panelGoneTimers = censusTrack('scratchpads.panelGoneTimers', new Map<string, NodeJS.Timeout>())
  private shownState = censusTrack('scratchpads.shownState', new Map<string, string>())
  private offObserved: (() => void) | null = null

  private watchWorlds(): void {
    if (this.offObserved) return
    this.offObserved = worldStore.onObservedChange((pp) => {
      if (isScratchpadPath(pp)) this.stateMaybeChanged(pp)
    })
  }

  private stateMaybeChanged(path: string): void {
    const parent = scratchpadParentProject(path)
    if (!parent) return
    const st = this.status(path)
    const key = `${st.status} ${st.play ?? '-'} ${st.lifecycle ?? '-'} ${st.unityMode} ${st.fault?.kind ?? '-'}`
    if (this.shownState.get(path) === key) return
    this.shownState.set(path, key)
    debugLog(`[scratchpad] ${scratchpadIdOf(path)} is ${key}`)
    this.changed(parent)
  }

  private panelRoots(): Set<string> {
    const out = new Set<string>()
    for (const roots of this.panelsByWc.values()) for (const r of roots) out.add(r)
    return out
  }

  hasPanel(projectPath: string): boolean {
    return this.panelRoots().has(canonicalProject(projectPath))
  }

  setPanels(wcId: number, projectPaths: string[]): void {
    const before = this.panelRoots()
    const roots = new Set(projectPaths.map((p) => canonicalProject(p)).filter((r) => !!r))
    if (roots.size > 0) this.panelsByWc.set(wcId, roots)
    else this.panelsByWc.delete(wcId)
    const after = this.panelRoots()
    for (const root of after) {
      const t = this.panelGoneTimers.get(root)
      if (t) {
        clearTimeout(t)
        this.panelGoneTimers.delete(root)
      }
    }
    for (const root of before) {
      if (after.has(root) || this.panelGoneTimers.has(root)) continue
      this.panelGoneTimers.set(
        root,
        setTimeout(() => {
          this.panelGoneTimers.delete(root)
          if (this.panelRoots().has(root)) return
          void this.stopAll(root).then((n) => {
            if (n > 0) console.log(`[scratchpad] Scratchpads panel closed, stopped ${n} in ${root}`)
          })
        }, PANEL_GONE_GRACE_MS)
      )
    }
  }

  async stopAll(projectPath: string): Promise<number> {
    const root = canonicalProject(projectPath)
    if (!root) return 0
    let n = 0
    for (const meta of await listScratchpads(root)) {
      const st = this.status(meta.path).status
      if (st === 'stopped' || st === 'stopping') continue
      await this.stop(root, meta.id)
      n++
    }
    return n
  }

  private requestPanel(root: string, meta: ScratchpadMeta): void {
    if (this.hasPanel(root)) return
    console.log(`[scratchpad] no Scratchpads panel for ${root}, asking the window to open one`)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('scratchpads:openPanel', { projectPath: root, id: meta.id })
    }
  }

  private status(path: string): Pick<ScratchpadInfo, 'status' | 'lifecycle' | 'play' | 'pid' | 'error' | 'fault' | 'unityMode'> {
    const st = unityProvider.primaryStatus(path)
    const settling = this.stopping.has(path) || this.removing.has(path) || this.restarting.has(path) || this.launchingPads.has(path)
    const failure = settling ? null : unityProvider.bootFailure(path)
    const fault = settling ? null : unityProvider.editorFault(path)
    const error = this.errors.get(path) ?? failure ?? (fault ? faultMessage(path, fault.kind, fault.reason) : null)
    let status: ScratchpadStatus
    if (this.stopping.has(path) || this.removing.has(path)) status = 'stopping'
    else if (failure || fault) status = 'error'
    else if (this.restarting.has(path) || this.launchingPads.has(path) || st.launching) status = 'starting'
    else if (st.running) {
      if (st.lifecycle === 'error') status = 'error'
      else if (st.lifecycle == null || STARTING_LIFECYCLES.has(st.lifecycle)) status = 'starting'
      else status = 'running'
    } else status = error ? 'error' : 'stopped'
    const play = status === 'running' ? scratchpadPlayOf(st.lifecycle, st.paused) : null
    return { status, lifecycle: st.lifecycle, play, pid: st.running ? st.pid : null, error, fault, unityMode: unityProvider.activeUnityMode(path) }
  }

  private info(meta: ScratchpadMeta): ScratchpadInfo {
    return { id: meta.id, name: meta.name, path: meta.path, createdAt: meta.createdAt, ...this.status(meta.path) }
  }

  private changed(projectPath: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('scratchpads:changed', { projectPath })
    }
  }

  private async resolve(projectPath: string, ref: unknown): Promise<{ root: string; meta: ScratchpadMeta }> {
    const root = canonicalProject(projectPath)
    const meta = findScratchpad(await listScratchpads(root), ref)
    if (!meta) throw new Error(`No scratchpad “${String(ref ?? '')}” in ${root}.`)
    return { root, meta }
  }

  async list(projectPath: string): Promise<ScratchpadInfo[]> {
    const root = canonicalProject(projectPath)
    if (!root) return []
    this.watchWorlds()
    return (await listScratchpads(root)).map((m) => this.info(m))
  }

  async create(projectPath: string, name?: unknown): Promise<ScratchpadInfo> {
    const root = canonicalProject(projectPath)
    const meta = await createScratchpad(root, name)
    this.changed(root)
    return this.info(meta)
  }

  async rename(projectPath: string, ref: unknown, name: unknown): Promise<ScratchpadInfo> {
    const root = canonicalProject(projectPath)
    const meta = await renameScratchpad(root, ref, name)
    this.changed(root)
    return this.info(meta)
  }

  private launch(root: string, meta: ScratchpadMeta): void {
    if (this.removing.has(meta.path)) return
    this.errors.delete(meta.path)
    this.requestPanel(root, meta)
    try {
      ensureStarterScene(meta.path)
    } catch (e) {
      console.log(`[scratchpad] starter scene for ${meta.id} failed: ${(e as Error).message}`)
    }
    this.launchingPads.add(meta.path)
    unityProvider.resumeStopped(meta.path, `starting scratchpad ${meta.id}`)
    void unityProvider
      .start(holdId(meta), meta.path, NO_WINDOW)
      .then((r) => {
        if (!r.ok) this.errors.set(meta.path, r.error ?? 'Unity failed to start')
      })
      .catch((e: unknown) => this.errors.set(meta.path, (e as Error)?.message ?? String(e)))
      .finally(() => {
        this.launchingPads.delete(meta.path)
        this.changed(root)
      })
  }

  async setMode(projectPath: string, ref: unknown, mode: unknown): Promise<{ result: UnityStartResult; info: ScratchpadInfo }> {
    const { root, meta } = await this.resolve(projectPath, ref)
    if (!isUnityMode(mode)) throw new TypeError(`Unknown Unity mode ${JSON.stringify(mode)}: use normal, headless-graphics or headless-nographics.`)
    const cur = this.status(meta.path).status
    if (cur === 'stopping') throw new Error(`Scratchpad “${meta.name}” is still stopping — retry in a moment.`)
    debugLog(`[scratchpad] ${meta.id} mode -> ${mode} (was ${unityProvider.activeUnityMode(meta.path)}, ${cur})`)
    const result = await unityProvider.setUnityMode(meta.path, mode as UnityMode)
    if (!result.ok && result.error) this.errors.set(meta.path, result.error)
    this.changed(root)
    return { result, info: this.info(meta) }
  }

  async start(projectPath: string, ref: unknown, mode?: unknown): Promise<ScratchpadInfo> {
    if (mode !== undefined && mode !== null) {
      const { result } = await this.setMode(projectPath, ref, mode)
      if (!result.ok) throw new Error(result.error ?? 'Unity failed to start')
    }
    const { root, meta } = await this.resolve(projectPath, ref)
    const cur = this.status(meta.path).status
    if (cur === 'stopping') throw new Error(`Scratchpad “${meta.name}” is still stopping — retry in a moment.`)
    if (cur !== 'running' && cur !== 'starting') this.launch(root, meta)
    this.changed(root)
    return this.info(meta)
  }

  private async shutdown(meta: ScratchpadMeta): Promise<void> {
    this.stopping.add(meta.path)
    try {
      await unityProvider.stop(holdId(meta))
      await unityProvider.killInstance(meta.path)
      while (unityProvider.primaryStatus(meta.path).launching) {
        await new Promise((r) => setTimeout(r, 250))
        await unityProvider.killInstance(meta.path)
      }
      await unityProvider.killInstance(meta.path)
    } finally {
      this.stopping.delete(meta.path)
      this.errors.delete(meta.path)
    }
  }

  async stop(projectPath: string, ref: unknown): Promise<ScratchpadInfo> {
    const { root, meta } = await this.resolve(projectPath, ref)
    if (!this.stopping.has(meta.path)) {
      void this.shutdown(meta)
        .catch((e: unknown) => console.log(`[scratchpad] stop ${meta.id} failed: ${(e as Error)?.message}`))
        .finally(() => this.changed(root))
    }
    this.changed(root)
    return this.info(meta)
  }

  async restart(projectPath: string, ref: unknown): Promise<ScratchpadInfo> {
    const { root, meta } = await this.resolve(projectPath, ref)
    const cur = this.status(meta.path).status
    if (cur === 'stopping') throw new Error(`Scratchpad “${meta.name}” is still stopping — retry in a moment.`)
    if (!unityProvider.primaryStatus(meta.path).running) {
      if (cur !== 'starting') this.launch(root, meta)
    } else if (!this.restarting.has(meta.path)) {
      this.restarting.add(meta.path)
      this.errors.delete(meta.path)
      void (async () => {
        const r = await unityProvider.restart(holdId(meta))
        if (!r.ok) {
          await this.shutdown(meta)
          this.restarting.delete(meta.path)
          this.launch(root, meta)
        }
      })()
        .catch((e: unknown) => this.errors.set(meta.path, (e as Error)?.message ?? String(e)))
        .finally(() => {
          this.restarting.delete(meta.path)
          this.changed(root)
        })
    }
    this.changed(root)
    return this.info(meta)
  }

  private async drainProcesses(meta: ScratchpadMeta): Promise<void> {
    if (process.platform !== 'win32') return
    const deadline = Date.now() + PROC_DRAIN_MS
    let pids = await pidsWithCwdUnder(meta.path)
    while (pids.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, PROC_POLL_MS))
      pids = await pidsWithCwdUnder(meta.path)
    }
    if (pids.length === 0) return
    console.log(`[scratchpad] ${meta.id}: killing ${pids.length} process(es) still inside it: ${pids.join(', ')}`)
    for (const pid of pids) await killTree(pid)
    await new Promise((r) => setTimeout(r, 700))
  }

  async remove(projectPath: string, ref: unknown): Promise<void> {
    const { root, meta } = await this.resolve(projectPath, ref)
    if (this.removing.has(meta.path)) throw new Error(`Scratchpad “${meta.name}” is already being deleted.`)
    this.removing.add(meta.path)
    this.changed(root)
    try {
      await this.shutdown(meta)
      await unityProvider.releaseForProjectPath(meta.path)
      releaseTunerViewsUnder(meta.path)
      await this.drainProcesses(meta)
      await deleteScratchpadDir(root, meta)
      worldStore.forgetProject(meta.path)
      this.shownState.delete(meta.path)
    } finally {
      this.removing.delete(meta.path)
      this.errors.delete(meta.path)
      this.changed(root)
    }
  }

  async attach(projectPath: string): Promise<boolean> {
    const root = canonicalProject(projectPath)
    if (!root || !isUnityProjectDir(root)) return false
    const port = await unityProvider.controlServerPort()
    if (!port) return false
    try {
      ensureProjectSspaceSync(root)
      writePrivateFile(
        join(root, '.sspace', SCRATCHPAD_HOST_FILE),
        JSON.stringify({ pid: process.pid, controlPort: port, controlToken: unityProvider.controlServerToken() })
      )
      this.attached.add(root)
      return true
    } catch (e) {
      console.log(`[scratchpad] attach ${root} failed: ${(e as Error).message}`)
      return false
    }
  }

  detachAll(): void {
    for (const root of this.attached) {
      try {
        rmSync(join(root, '.sspace', SCRATCHPAD_HOST_FILE), { force: true })
      } catch {
      }
    }
    this.attached.clear()
  }

  async handleCommand(args: Record<string, unknown>): Promise<{ ok: boolean; error?: string } & Record<string, unknown>> {
    const projectRoot = typeof args.projectRoot === 'string' ? args.projectRoot : ''
    const ref = args.scratchpad
    try {
      switch (args.action) {
        case 'list':
          return { ok: true, scratchpads: await this.list(projectRoot) }
        case 'create':
          return { ok: true, scratchpad: await this.create(projectRoot, args.name) }
        case 'start':
          return { ok: true, scratchpad: await this.start(projectRoot, ref, args.mode) }
        case 'stop':
          return { ok: true, scratchpad: await this.stop(projectRoot, ref) }
        case 'restart':
          return { ok: true, scratchpad: await this.restart(projectRoot, ref) }
        case 'rename':
          return { ok: true, scratchpad: await this.rename(projectRoot, ref, args.name) }
        case 'remove':
          await this.remove(projectRoot, ref)
          return { ok: true }
        default:
          return { ok: false, error: `Unknown scratchpad action: ${String(args.action)}` }
      }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) }
    }
  }
}

export const scratchpads = new ScratchpadManager()
