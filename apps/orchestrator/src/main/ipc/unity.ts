import { BrowserWindow, ipcMain, webContents, shell, type WebContents } from 'electron'
import type { UnityStartArgs, UnityViewHint, DeepPartial, NewProjectArgs } from '@shared/api'
import type { WorldDesired, UnityMode } from '@shared/unity/world'
import type { RemotePrefs } from '@shared/types'
import { MAX_PLAYERS } from '@shared/unity/world'
import { unityProvider } from '../unity/unity-instance-provider'
import { startNativeMouseDeltas } from '../unity/shared-surface'
import { hubAppPath, hubBlockMessage, hubState, isHubInstalled, startHub } from '../unity/unity-hub'
import { worldStore } from '../unity/world-store'
import { cancelCreateProject, checkNewProject, createProject, listEditorsForCreate } from '../unity/project-create'
import { inputGateCheck } from '../unity/input-gate'
import {
  readRecentScenes,
  writeLastScene,
  removeRecentScene
} from '../unity/project-scene-state'
import {
  readConsolePrefs,
  readRemotePrefs,
  writeConsolePrefs,
  writeRemotePrefs,
  type ConsolePrefs
} from '../unity/project-prefs'
import { readStreamResolutions, writeStreamResolutions } from '../unity/stream-resolutions-store'
import { enterRevealSplitLayout, unityRevealBounds } from '../window/reveal-layout'
import { onRendererReset } from '../window/renderer-reset'
import { censusTrack } from '@shared/census'
import { LIFECYCLE_CHANNEL } from '@shared/unity/lifecycle'
import { unityLifecycle } from '../unity/lifecycle'
import { hubInstallLink } from '../unity/editor-install'
import { relaunchProjectAndWait } from '../unity/unity-lifecycle-call'

let wired = false
let nativeMouseDeltas = false
const pointerLockHolders = new Map<number, Set<string>>()
censusTrack('unity.pointerLockHolders', pointerLockHolders)

function setPointerLockHolder(wc: WebContents, id: string, locked: boolean): void {
  let ids = pointerLockHolders.get(wc.id)
  if (locked) {
    const wcId = wc.id
    onRendererReset(wc, 'unity:pointerLocked', () => pointerLockHolders.delete(wcId))
    if (!ids) {
      ids = new Set()
      pointerLockHolders.set(wc.id, ids)
    }
    ids.add(id)
    return
  }
  if (!ids) return
  ids.delete(id)
  if (ids.size === 0) pointerLockHolders.delete(wc.id)
}

export function registerUnityHandlers(): void {
  if (!wired) {
    unityProvider.setSink((wcId, channel, payload) => {
      const wc = webContents.fromId(wcId)
      if (wc && !wc.isDestroyed()) wc.send(channel, payload)
    })
    nativeMouseDeltas = startNativeMouseDeltas((dx, dy) => {
      for (const wcId of pointerLockHolders.keys()) {
        const wc = webContents.fromId(wcId)
        if (wc && !wc.isDestroyed()) wc.send('unity:mouseDelta', { dx, dy })
      }
    })
    unityLifecycle.onChange((life) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(LIFECYCLE_CHANNEL, life)
    })
    unityProvider.setRelaunchWaiter(async (projectPath, timeoutMs) => {
      const out = await relaunchProjectAndWait(projectPath, timeoutMs)
      return out.ok ? { ok: true, note: out.message } : { ok: false, error: out.message }
    })
    wired = true
  }
  ipcMain.handle('unity:lifecycle', (_event, { projectPath }: { projectPath: string }) =>
    unityProvider.lifecycle(String(projectPath ?? ''))
  )
  ipcMain.handle('unity:retry', async (event, { projectPath }: { projectPath: string }) => {
    const pp = String(projectPath ?? '')
    const from = event.processId === -1 ? 'the phone' : 'the desktop'
    const r = await unityProvider.retryProject(pp, from)
    return { ...r, life: unityProvider.lifecycle(pp), history: unityProvider.lifecycleHistory(pp) }
  })
  ipcMain.handle('unity:cancel', async (event, { projectPath }: { projectPath: string }) => {
    const pp = String(projectPath ?? '')
    const r = await unityProvider.cancelProject(pp, event.processId === -1 ? 'the phone' : 'the desktop')
    return { ...r, life: unityProvider.lifecycle(pp), history: unityProvider.lifecycleHistory(pp) }
  })
  ipcMain.handle('unity:answerDialog', async (event, { projectPath, id, button }: { projectPath: string; id: string; button: string }) => {
    const pp = String(projectPath ?? '')
    const r = await unityProvider.answerDialog(pp, String(id ?? ''), String(button ?? ''), event.processId === -1 ? 'the phone' : 'the desktop')
    return { ...r, life: unityProvider.lifecycle(pp) }
  })
  ipcMain.handle('unity:watchLifecycle', (event, { projectPath }: { projectPath: string }) => {
    const wcId = event.sender.id
    onRendererReset(event.sender, 'unity:lifecycle', () => unityLifecycle.unwatchAll(wcId))
    return unityProvider.watchLifecycle(String(projectPath ?? ''), wcId)
  })
  ipcMain.on('unity:unwatchLifecycle', (event, { projectPath }: { projectPath: string }) =>
    unityProvider.unwatchLifecycle(String(projectPath ?? ''), event.sender.id)
  )
  ipcMain.handle('unity:installEditor', async (_event, { projectPath }: { projectPath: string }) => {
    const life = unityProvider.lifecycle(String(projectPath ?? ''))
    const link = hubInstallLink(life.version, life.revision)
    if (!link) return { ok: false, error: `This project's Unity version (${life.version || 'unknown'}) can't be installed from here. Install it in Unity Hub.` }
    if (!(await isHubInstalled())) return { ok: false, error: "Unity Hub isn't installed. Get it from unity.com/download first." }
    try {
      await shell.openExternal(link)
      console.log(`[unity] opened Unity Hub to install ${life.version}: ${link}`)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle('unity:mouseDeltaAvailable', () => nativeMouseDeltas)
  ipcMain.on('unity:pointerLocked', (event, { id, locked }: { id: string; locked: boolean }) =>
    setPointerLockHolder(event.sender, id, locked)
  )

  ipcMain.handle('unity:start', (event, args: UnityStartArgs) =>
    unityProvider.start(args.id, args.projectPath, event.sender.id)
  )
  ipcMain.handle('unity:stop', (_event, { id }: { id: string }) => unityProvider.stop(id))
  ipcMain.handle('unity:release', (_event, { projectPath }: { projectPath: string }) =>
    unityProvider.releaseForProjectPath(projectPath ?? '')
  )
  ipcMain.handle('unity:restart', (_event, { id }: { id: string }) => unityProvider.restart(id))
  ipcMain.handle('unity:stopProject', (_event, { projectPath }: { projectPath: string }) =>
    unityProvider.stopProject(projectPath ?? '')
  )
  ipcMain.on('unity:refresh', (_event, { id }: { id: string }) => unityProvider.refresh(id))
  ipcMain.handle(
    'unity:revealEditor',
    (event, { projectPath, split }: { projectPath: string; split?: boolean }) => {
      const bounds = split ? (unityRevealBounds(event.sender.id) ?? undefined) : undefined
      const r = unityProvider.revealEditor(projectPath, bounds)
      if (r.ok && split) enterRevealSplitLayout(event.sender.id)
      return r
    }
  )
  ipcMain.handle(
    'unity:hideEditor',
    (_event, { projectPath, force }: { projectPath: string; force?: boolean }) =>
      unityProvider.hideEditor(projectPath, { force: force === true })
  )
  ipcMain.handle('unity:isEditorRevealed', (_event, { projectPath }: { projectPath: string }) =>
    unityProvider.isEditorRevealed(projectPath)
  )
  ipcMain.handle('unity:stepFrame', (_event, { projectPath }: { projectPath: string }) =>
    unityProvider.stepFrame(projectPath)
  )
  ipcMain.handle('unity:getMode', (_event, { projectPath }: { projectPath: string }) =>
    unityProvider.getUnityMode(projectPath)
  )
  ipcMain.handle(
    'unity:setMode',
    (_event, { projectPath, mode }: { projectPath: string; mode: UnityMode }) =>
      unityProvider.setUnityMode(projectPath, mode)
  )
  ipcMain.handle(
    'unity:closeExternalEditor',
    (_event, { projectPath, force }: { projectPath: string; force?: boolean }) =>
      unityProvider.closeExternalEditor(projectPath, force === true)
  )
  ipcMain.handle('unity:isHubInstalled', () => isHubInstalled())
  ipcMain.handle('unity:openHub', async () => {
    const path = await hubAppPath()
    if (!path) return { ok: false, error: "Unity Hub isn't installed." }
    const err = await shell.openPath(path)
    return { ok: !err, error: err || undefined }
  })
  ipcMain.handle('unity:hubState', () => hubState())
  ipcMain.handle('unity:listEditorsForCreate', () => listEditorsForCreate())
  ipcMain.handle(
    'unity:checkNewProject',
    (_event, { parent, name }: { parent: string; name: string }) => checkNewProject(parent ?? '', name ?? '')
  )
  ipcMain.handle('unity:createProject', (event, args: NewProjectArgs) =>
    createProject(args, (p) => {
      if (!event.sender.isDestroyed()) event.sender.send('unity:createProgress', p)
    })
  )
  ipcMain.on('unity:cancelCreateProject', () => cancelCreateProject())
  ipcMain.handle('unity:startHub', async () => {
    const r = await startHub()
    return { ok: r.ok, error: r.error }
  })
  ipcMain.on('unity:setHotReload', (_event, { id, enabled }: { id: string; enabled: boolean }) => {
    unityProvider.setHotReload(id, enabled)
  })
  ipcMain.handle('unity:isProject', (_event, { projectPath }: { projectPath: string }) =>
    unityProvider.isProject(projectPath)
  )
  ipcMain.handle('unity:ensureProjectEnv', (_event, { projectPath }: { projectPath: string }) =>
    unityProvider.ensureProjectEnv(projectPath).catch(() => {})
  )
  ipcMain.handle('unity:getRecentScenes', (_event, { projectPath }: { projectPath: string }) =>
    readRecentScenes(projectPath)
  )
  ipcMain.on(
    'unity:setLastScene',
    (_event, { projectPath, scene }: { projectPath: string; scene: string }) => {
      writeLastScene(projectPath, scene)
    }
  )
  ipcMain.on(
    'unity:removeRecentScene',
    (_event, { projectPath, scene }: { projectPath: string; scene: string }) => {
      removeRecentScene(projectPath, scene)
    }
  )
  ipcMain.handle('unity:getConsolePrefs', (_event, { projectPath }: { projectPath: string }) =>
    readConsolePrefs(projectPath)
  )
  ipcMain.on(
    'unity:setConsolePrefs',
    (_event, { projectPath, prefs }: { projectPath: string; prefs: ConsolePrefs }) => {
      writeConsolePrefs(projectPath, prefs)
    }
  )
  ipcMain.handle('unity:getRemotePrefs', (_event, { projectPath }: { projectPath: string }) =>
    readRemotePrefs(String(projectPath ?? ''))
  )
  ipcMain.handle(
    'unity:setRemotePrefs',
    (_event, { projectPath, prefs }: { projectPath: string; prefs: RemotePrefs }) =>
      writeRemotePrefs(String(projectPath ?? ''), prefs && typeof prefs === 'object' ? prefs : {})
  )
  ipcMain.handle('unity:getStreamResolutions', (_event, { projectPath }: { projectPath: string }) =>
    readStreamResolutions(projectPath)
  )
  ipcMain.handle(
    'unity:setStreamResolutions',
    (_event, { projectPath, resolutions }: { projectPath: string; resolutions: unknown }) =>
      writeStreamResolutions(projectPath, resolutions)
  )
  ipcMain.handle(
    'unity:instanceDir',
    (_event, { projectPath, worldId }: { projectPath: string; worldId: string }) =>
      unityProvider.instanceDir(projectPath, worldId)
  )
  ipcMain.handle('unity:addPlayer', async (_event, { projectPath: requested }: { projectPath: string }) => {
    const projectPath = worldStore.resolveProject(requested)
    const world = worldStore.getWorld(projectPath)
    if (!Object.keys(world.observed.instances).length)
      return { ok: false, error: `No Unity Player is open for ${projectPath}.` }
    const gate = inputGateCheck(projectPath)
    if (gate) {
      console.log(`[unity] input gate refused add player for ${projectPath}: activeInputHandler=${gate.problem.handler}`)
      return { ok: false, error: gate.message }
    }
    const hub = await hubState()
    if (hub !== 'ready') return { ok: false, error: hubBlockMessage(hub) }
    if (worldStore.playModeActive(projectPath))
      return {
        ok: false,
        error: 'Players can only be added in Edit Mode — stop Play Mode first, then add the player.'
      }
    if (unityProvider.getUnityMode(projectPath) === 'headless-nographics')
      return {
        ok: false,
        error:
          'Adding players is disabled in Headless (No Graphics) mode, which renders no view to stream. Switch Unity Mode to Normal or Headless (Graphics) first.'
      }
    if (world.desired.playerCount >= MAX_PLAYERS)
      return { ok: false, error: `Player limit (${MAX_PLAYERS}) reached.` }
    worldStore.setDesired(projectPath, { playerCount: world.desired.playerCount + 1 })
    return { ok: true }
  })
  ipcMain.handle(
    'unity:removePlayer',
    (_event, { projectPath: requested }: { projectPath: string; cloneId: string }) => {
      const projectPath = worldStore.resolveProject(requested)
      const world = worldStore.getWorld(projectPath)
      if (!Object.keys(world.observed.instances).length)
        return { ok: false, error: `No Unity Player is open for ${projectPath}.` }
      if (world.desired.playerCount <= 1) return { ok: false, error: 'There are no added players to remove.' }
      worldStore.setDesired(projectPath, { playerCount: world.desired.playerCount - 1 })
      return { ok: true }
    }
  )
  ipcMain.handle('unity:getWorld', (event, { projectPath }: { projectPath: string }) => {
    const resolved = worldStore.resolveProject(projectPath)
    const wc = event.sender
    if (!(wc as unknown as { remote?: boolean }).remote) {
      const wcId = wc.id
      worldStore.watch(resolved, wcId)
      onRendererReset(wc, 'unity:worldWatch', () => worldStore.unwatchAll(wcId))
    }
    return worldStore.getWorld(resolved)
  })
  ipcMain.on(
    'unity:setDesired',
    (_event, { projectPath, patch }: { projectPath: string; patch: DeepPartial<WorldDesired> }) => {
      worldStore.setDesired(projectPath, patch)
    }
  )
  ipcMain.handle('unity:players', (_event, { projectPath }: { projectPath: string }) =>
    unityProvider.playersForProject(projectPath)
  )
  ipcMain.on('unity:input', (_event, { id, json }: { id: string; json: string }) => {
    unityProvider.sendInput(id, json)
  })
  ipcMain.on('unity:ping', (_event, { id, pingId }: { id: string; pingId: number }) => {
    unityProvider.sendPing(id, pingId)
  })
  ipcMain.on('unity:sharedHold', (event, m: { id: string; gen: number; upTo: number; held: number[] }) => {
    if (!m || typeof m.id !== 'string' || !Array.isArray(m.held)) return
    unityProvider.sharedHold(m.id, event.sender.id, Number(m.gen), Number(m.upTo) || 0, m.held.map(Number))
  })
  ipcMain.on('unity:resendShared', (event, { id }: { id: string }) => {
    unityProvider.resendShared(id, event.sender.id)
  })
  ipcMain.on('unity:markLive', (_event, { id }: { id: string }) => {
    unityProvider.markLive(id)
  })
  ipcMain.on('unity:viewHint', (_event, { id, hint }: { id: string; hint: UnityViewHint }) => {
    unityProvider.setViewHint(id, hint)
  })
}
