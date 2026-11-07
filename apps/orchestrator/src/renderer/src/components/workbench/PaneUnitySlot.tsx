import { AnchoredLayer } from '../ui/AnchoredLayer'
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import {
  MAX_PLAYERS,
  MAX_RECENT_SCENES,
  DEFAULT_STREAM_RES,
  TRANSITIONAL_LIFECYCLES,
  type InstanceObserved,
  type Lifecycle,
  type UnityMode
} from '@shared/unity/world'
import type { HubState } from '@shared/api'
import { getUnityCanvas, getUnityHost, parkUnityHost, requestHintResend } from '../../lib/unity/unity-registry'
import { registerUnityPlayToggle, setUnityPlaying } from '../../lib/shortcuts/pane-actions'
import { useAnchoredPosition } from '../../lib/anchored-popover'
import { bumpUnityRetry } from '../../lib/unity/unity-retry'
import { UnityInputGateView } from './UnityInputGateView'
import { VideoRecBadge } from './VideoRecBadge'
import { EditorFaultCard, EditorStallNote } from './EditorFaultCard'
import {
  useWorldStore,
  ensureProject,
  isPendingId,
  useInstanceIds,
  useInstance,
  useDesired,
  useScenes,
  useStreaming,
  useGroupWorking,
  useGroupArmable,
  useGroupTearingDown,
  useGroupPending,
  useLocks,
  useStatusDot,
  useEffectiveLifecycle,
  useEffectivePaused,
  useProjectStopped,
  useEditorsRunning,
  type StatusTone
} from '../../lib/unity/world-store'
import { shouldAutoRelaunch } from '../../lib/unity/auto-recovery'
import { sessionIdFor, gridDims, primaryWorldId } from '../../lib/unity/instance-ids'
import { useAppStore } from '../../store'
import { useSessionStatus, setSessionStatus, getSessionStatus } from '../../lib/unity/session-status'
import { useUnityLifecycle } from '../../lib/unity/lifecycle-store'
import { BUSY_PHASES, GATE_PHASES, stateTitle, type UnityLifecycle, type UnityPhase } from '@shared/unity/lifecycle'
import { useAgentsWorkingForPane } from '../../lib/unity/reveal-pane'
import { useMetrics } from '../../lib/unity/unity-metrics'
import { useHotReloadToast, type HotReloadTone } from '../../lib/unity/hot-reload-toast'
import { useHotReloadPulse } from '../../lib/unity/hot-reload-pulse'
import { useAppQuitting } from '../../lib/app-quitting'
import { AgentFeedbackOverlay } from './AgentFeedbackOverlay'
import { ScenePicker, newSceneFolder } from './ScenePicker'
import { panelActions, runAction, usePanelActions } from '../../lib/actions/action-tree'
import { unityNodes } from '../../lib/actions/unity-actions'
import type { SavedStreamResolution } from '@shared/unity/stream-size'
import { BarXScroll } from './BarXScroll'
import { UnityHubBlockedView, UnityHubCard, UnityVersionView, useHubState } from './UnityHubGate'
import { UnityStateCard, isUnityDown } from './UnityStateCard'
import { UnityDialogCard } from './UnityDialogCard'
import { NoCameraCard } from './NoCameraCard'
import { PerfGraph } from './PerfGraph'
import { StreamResolutionPicker } from './StreamResolutionPicker'
import { discardSceneChanges, editorDirtyScenes, resolveSceneSwitch, tunerUnsavedFor } from '../../lib/tuner/unsaved'
import { anchorFromElement } from '../../lib/confirm/confirm-store'
import { PaneUnityConsoleSlot } from './PaneUnityConsoleSlot'
import { PLAY_LABEL } from '../scratchpad/scratchpad-status'
import { scratchpadPlayOf } from '@shared/scratchpads'
import { debugLog } from '@shared/debug-log'

const BUSY_REASON = 'Busy — wait for the current action to finish'
const MENU_TITLE_WITH_STOP = 'Refresh, relaunch or stop the Unity Player'
const RELAUNCH_DESC =
  'Quits the editor (force-closes it if it hangs) and starts it again. Resets scene & settings.'
const STOP_DESC = 'Quits the editor and every player (force-closes any that hang). Unsaved scene changes are lost.'
const STOPPED_HINT = 'Relaunch from the ↻ menu below to start it again.'
const STOPPED_REASON = 'Unity is stopped. Relaunch it from the ↻ menu.'
const STOP_CLOSING_REASON = 'Unity is closing'
const STOP_ALREADY_REASON = 'Unity is already stopped'
const STOP_NOT_RUNNING_REASON = "Unity isn't running"
const STOP_RELAUNCHING_REASON = 'Wait for the relaunch to finish'

const DEFAULT_SCENE = 'Assets/Scenes/Prototype.unity'
const FPS_CAP_OPTIONS = [5, 15, 30, 60, 120] as const

let quietHostFocus = false

function focusHostQuiet(id: string): void {
  quietHostFocus = true
  try {
    getUnityHost(id).focus()
  } finally {
    quietHostFocus = false
  }
}

function toneClass(tone: StatusTone): string {
  switch (tone) {
    case 'rose':
      return 'bg-rose-400'
    case 'zinc':
      return 'bg-zinc-500'
    case 'emerald':
      return 'bg-emerald-400'
    default:
      return 'bg-amber-400 animate-pulse'
  }
}

const FIRST_FRAME_WAIT_MS = 2000

export function useUnityPlayerController({
  id,
  projectPath,
  canStop = true,
  remote = false
}: {
  id: string
  projectPath: string
  canStop?: boolean
  remote?: boolean
}) {
  const primaryPtyId = id
  const primaryWid = primaryWorldId(projectPath)

  useEffect(() => {
    ensureProject(projectPath)
  }, [projectPath])

  const [isUnityProject, setIsUnityProject] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.unity.isProject(projectPath).then((ok) => {
      if (alive) setIsUnityProject(ok)
    })
    return () => {
      alive = false
    }
  }, [projectPath])

  const [recentScenes, setRecentScenes] = useState<string[]>([])
  const persistedScene = recentScenes[0] ?? null
  const refreshRecent = useCallback(() => {
    void window.api.unity.getRecentScenes(projectPath).then(setRecentScenes)
  }, [projectPath])
  useEffect(() => {
    setRecentScenes([])
    refreshRecent()
  }, [projectPath, refreshRecent])

  const gridIds = useInstanceIds(projectPath)
  const count = gridIds.length
  const realIds = gridIds.filter((gid) => !isPendingId(gid))
  const realKey = realIds.join(' ')
  const { cols, rows } = gridDims(count)

  const scenes = useScenes(projectPath)
  const groupWorking = useGroupWorking(projectPath)
  const tearingDown = useGroupTearingDown(projectPath)
  const groupPending = useGroupPending(projectPath)
  const armable = useGroupArmable(projectPath)

  const primaryInst = useInstance(projectPath, primaryWid)
  const primaryDesired = useDesired(projectPath, primaryWid)
  const observedScene = primaryInst?.lifecycle === 'editmode' ? primaryInst.scene : ''
  useEffect(() => {
    if (observedScene) refreshRecent()
  }, [observedScene, refreshRecent])
  const locks = useLocks(projectPath, primaryWid)
  const statusDot = useStatusDot(projectPath, primaryWid, primaryPtyId)
  const streaming = useStreaming(projectPath, primaryWid, primaryPtyId)
  const sessionStatus = useSessionStatus(primaryPtyId)
  const life = useUnityLifecycle(projectPath)
  const lifePhase = life?.phase ?? null
  const lastPhaseRef = useRef<UnityPhase | null>(null)
  useEffect(() => {
    const prev = lastPhaseRef.current
    lastPhaseRef.current = lifePhase
    if (!lifePhase || prev === lifePhase) return
    const cleared = (!!prev && GATE_PHASES.has(prev) && !GATE_PHASES.has(lifePhase)) || BUSY_PHASES.has(lifePhase) || lifePhase === 'ready'
    if (!cleared) return
    const st = getSessionStatus(primaryPtyId)
    if (!st.error && !st.hub && !st.inputGate && !st.standalone) return
    console.log(`[unity] Unity is ${lifePhase} now${prev ? ` (was ${prev})` : ''}, starting the panel again`)
    setSessionStatus(primaryPtyId, { error: null, hub: null, inputGate: null, standalone: false })
    bumpUnityRetry(primaryPtyId)
  }, [lifePhase, primaryPtyId])

  const settingsLoaded = useAppStore((s) => s.settings != null)
  const savedVolume = useAppStore((s) => s.settings?.unityPlayerVolume ?? 1)
  const savedMuted = useAppStore((s) => s.settings?.unityPlayerMuted ?? false)

  const [audioFocus, setAudioFocus] = useState(0)
  const userMuted = useRef(new Set<string>())
  const seededMute = useRef(false)
  useEffect(() => {
    if (!settingsLoaded || seededMute.current) return
    seededMute.current = true
    if (savedMuted) userMuted.current.add(primaryWid)
  }, [settingsLoaded, savedMuted, primaryWid])
  const focusedIdx = Math.min(audioFocus, Math.max(0, realIds.length - 1))
  const focusedWid = realIds[focusedIdx] ?? primaryWid
  const focusedSessionId = sessionIdFor(primaryPtyId, focusedIdx)
  const focusedDesired = useDesired(projectPath, focusedWid)
  const focusedMuted =
    focusedDesired?.muted ?? (focusedWid === primaryWid ? savedMuted : true)
  const focusedVolume = focusedDesired?.volume ?? savedVolume

  const primaryLifecycle = useEffectiveLifecycle(projectPath, primaryWid)
  const inEdit = primaryLifecycle === 'editmode'
  const playingNow = primaryLifecycle === 'playing' || primaryLifecycle === 'entering-play'
  const compileError = primaryInst?.compile === 'error'
  const recompilePending = (primaryDesired?.refreshGen ?? 0) > (primaryInst?.refreshGen ?? 0)
  const showPlayToggle = inEdit || !primaryInst
  const armed = primaryDesired?.hotReload ?? primaryInst?.hotReloadActive ?? false
  const canArm = armable && !recompilePending
  const stopped = useProjectStopped(projectPath)
  const editorsRunning = useEditorsRunning(projectPath)
  const stopping = stopped && realIds.length > 0
  const [stopRequested, setStopRequested] = useState(false)
  const refreshBlockedReason = stopped
    ? STOPPED_REASON
    : !inEdit && !playingNow
      ? 'Stop to Edit Mode to refresh'
      : recompilePending
        ? 'A refresh is already queued'
        : groupWorking || groupPending
          ? 'Busy — wait for the current action to finish'
          : null
  const stopBlockedReason = stopped
    ? stopping
      ? STOP_CLOSING_REASON
      : STOP_ALREADY_REASON
    : stopRequested
      ? STOP_CLOSING_REASON
      : !editorsRunning
        ? STOP_NOT_RUNNING_REASON
        : locks.relaunch
          ? STOP_RELAUNCHING_REASON
          : null

  const preferredScene =
    persistedScene && scenes.includes(persistedScene)
      ? persistedScene
      : scenes.includes(DEFAULT_SCENE)
        ? DEFAULT_SCENE
        : (scenes[0] ?? '')
  const selectedScene = primaryDesired?.scene || primaryInst?.scene || preferredScene
  const streamRes = primaryDesired?.streamRes ?? DEFAULT_STREAM_RES
  const fpsCap = primaryDesired?.fpsCap ?? 0

  useEffect(() => {
    debugLog(
      `[ui-state] effLc=${primaryLifecycle} obsLc=${primaryInst?.lifecycle} compile=${primaryInst?.compile}` +
        ` desGen=${primaryDesired?.refreshGen ?? '-'} obsGen=${primaryInst?.refreshGen ?? '-'}` +
        ` pending=${recompilePending} groupWorking=${groupWorking} inEdit=${inEdit}` +
        ` desPlaying=${primaryDesired?.playing} dot="${statusDot.label}"`
    )
  }, [
    primaryLifecycle,
    primaryInst?.lifecycle,
    primaryInst?.compile,
    primaryInst?.refreshGen,
    primaryDesired?.refreshGen,
    primaryDesired?.playing,
    recompilePending,
    groupWorking,
    inEdit,
    statusDot.label
  ])

  useEffect(() => {
    const ids = realKey ? realKey.split(' ') : []
    if (remote || ids.length === 0) return
    const fid = ids[Math.min(audioFocus, ids.length - 1)]
    const st = useWorldStore.getState()
    const curMuted = (wid: string): boolean =>
      st.worlds[projectPath]?.desired.instances[wid]?.muted ??
      (wid === primaryWid ? savedMuted : true)
    for (const wid of ids) {
      if (wid === fid) {
        const shouldMute = userMuted.current.has(fid)
        if (curMuted(wid) !== shouldMute) st.setMuted(projectPath, wid, shouldMute)
      } else if (!curMuted(wid)) {
        st.setMuted(projectPath, wid, true)
      }
    }
  }, [realKey, audioFocus, projectPath, primaryWid, savedMuted])

  const setPanelFullscreen = (on: boolean): void => {
    const s = useAppStore.getState()
    for (const [wsId, tabs] of Object.entries(s.tabsByWorkspace)) {
      const tab = tabs.find((t) => t.ptyId === primaryPtyId)
      if (!tab) continue
      if ((s.fullscreenGroupIdByWorkspace[wsId] === tab.groupId) !== on) {
        s.toggleGroupFullscreen(wsId, tab.groupId)
      }
      return
    }
  }

  const toggleRun = (fullscreen = false): void => {
    if (locks.playStop) return
    if (fullscreen) setPanelFullscreen(showPlayToggle)
    const st = useWorldStore.getState()
    if (inEdit) {
      for (const wid of realIds) st.setPlaying(projectPath, wid, true)
      focusHostQuiet(primaryPtyId)
    } else {
      for (const wid of realIds) {
        st.setPlaying(projectPath, wid, false)
        st.setHotReload(projectPath, wid, false)
      }
    }
  }

  const paused = useEffectivePaused(projectPath, primaryWid)
  const togglePause = (): void => {
    if (!playingNow) return
    const st = useWorldStore.getState()
    for (const wid of realIds) st.setPaused(projectPath, wid, !paused)
  }

  const stepFrame = (): void => {
    if (!playingNow) return
    void window.api.unity.stepFrame(projectPath).then((r) => {
      if (!r.ok) console.log(`[unity] step frame failed: ${r.error}`)
    })
  }

  const toggleRunRef = useRef(toggleRun)
  toggleRunRef.current = toggleRun
  useEffect(
    () => registerUnityPlayToggle(primaryPtyId, (fs) => toggleRunRef.current(fs)),
    [primaryPtyId]
  )
  useEffect(() => setUnityPlaying(primaryPtyId, playingNow), [primaryPtyId, playingNow])

  const toggleMute = (): void => {
    const st = useWorldStore.getState()
    if (focusedMuted) {
      userMuted.current.delete(focusedWid)
      st.setMuted(projectPath, focusedWid, false)
      const vol = focusedVolume === 0 ? 1 : focusedVolume
      if (focusedVolume === 0) st.setVolume(projectPath, focusedWid, 1)
      useAppStore.getState().updateSettings({ unityPlayerMuted: false, unityPlayerVolume: vol })
    } else {
      userMuted.current.add(focusedWid)
      st.setMuted(projectPath, focusedWid, true)
      useAppStore.getState().updateSettings({ unityPlayerMuted: true })
    }
  }

  const toggleHotReload = (): void => {
    if (armed || !canArm) return
    const st = useWorldStore.getState()
    for (const wid of realIds) st.setHotReload(projectPath, wid, true)
    getUnityHost(primaryPtyId).focus()
  }
  const hotReloadPulse = useHotReloadPulse(projectPath, primaryWid)
  const hotReloadToast = useHotReloadToast(armed, primaryInst?.compileError ?? null, hotReloadPulse)

  const onVolume = (v: number): void => {
    const st = useWorldStore.getState()
    st.setVolume(projectPath, focusedWid, v / 100)
    st.setMuted(projectPath, focusedWid, v === 0)
    if (v > 0) userMuted.current.delete(focusedWid)
    useAppStore
      .getState()
      .updateSettings({ unityPlayerVolume: v / 100, unityPlayerMuted: v === 0 })
  }
  const pickAudio = (idx: number): void => {
    const ids = realIds
    const newFid = ids[Math.min(idx, ids.length - 1)] ?? primaryWid
    const st = useWorldStore.getState()
    for (const wid of ids) {
      if (wid === newFid) st.setMuted(projectPath, wid, userMuted.current.has(newFid))
      else st.setMuted(projectPath, wid, true)
    }
    setAudioFocus(idx)
  }
  const onScene = (scene: string): void => {
    if (locks.scene) return
    if (scene !== selectedScene && (tunerUnsavedFor(projectPath) || editorDirtyScenes(projectPath).length)) {
      void resolveSceneSwitch(projectPath).then((ok) => {
        if (ok) switchScene(scene)
      })
      return
    }
    switchScene(scene)
  }
  const onNewScene = async (path: string): Promise<string | null> => {
    if (!(await resolveSceneSwitch(projectPath))) return 'Not created: the open scene has unsaved changes'
    const r = await window.api.tuner.newScene(projectPath, path)
    if (!r.ok) return r.error
    switchScene(path)
    return null
  }
  const switchScene = (scene: string): void => {
    window.api.unity.setLastScene(projectPath, scene)
    setRecentScenes((prev) => [scene, ...prev.filter((s) => s !== scene)].slice(0, MAX_RECENT_SCENES))
    if (scene === selectedScene) return
    const st = useWorldStore.getState()
    for (const wid of realIds) st.setScene(projectPath, wid, scene)
    getUnityHost(primaryPtyId).focus()
  }
  const onRemoveRecentScene = (scene: string): void => {
    window.api.unity.removeRecentScene(projectPath, scene)
    setRecentScenes((prev) => prev.filter((s) => s !== scene))
  }
  const onFpsCap = (cap: number): void => {
    const st = useWorldStore.getState()
    for (const wid of realIds) st.setFpsCap(projectPath, wid, cap)
  }
  const onStreamRes = (res: string): void => {
    const st = useWorldStore.getState()
    for (const wid of realIds) st.setStreamRes(projectPath, wid, res)
  }
  const onRestart = (): void => {
    if (stopped) {
      if (stopping) return
      userMuted.current.clear()
      setAudioFocus(0)
      setSessionStatus(primaryPtyId, { revealed: false })
      useWorldStore.getState().setStopped(projectPath, false)
      getUnityHost(primaryPtyId).focus()
      return
    }
    if (locks.relaunch) return
    const st = useWorldStore.getState()
    for (const wid of realIds) {
      st.setPlaying(projectPath, wid, false)
      st.setScene(projectPath, wid, '')
      st.setHotReload(projectPath, wid, false)
    }
    userMuted.current.clear()
    setAudioFocus(0)
    setSessionStatus(primaryPtyId, { revealed: false })
    void window.api.unity.restart(primaryPtyId).then((r) => {
      if (!r.ok && r.inputGate) setSessionStatus(primaryPtyId, { inputGate: r.inputGate })
      else if (!r.ok && r.hub) setSessionStatus(primaryPtyId, { hub: r.hub })
      else if (!r.ok && r.standalone) setSessionStatus(primaryPtyId, { standalone: true })
    })
    getUnityHost(primaryPtyId).focus()
  }
  const onStop = (): void => {
    if (stopBlockedReason) return
    setStopRequested(true)
    setSessionStatus(primaryPtyId, { revealed: false })
    console.log(`[unity] stop requested from the Player menu for ${projectPath}`)
    void window.api.unity
      .stopProject(projectPath)
      .then((r) => {
        if (!r.ok) console.log(`[unity] stop failed: ${r.error}`)
      })
      .finally(() => setStopRequested(false))
  }
  const onRefresh = (): void => {
    if (locks.relaunch || refreshBlockedReason) return
    useWorldStore.getState().bumpRefresh(projectPath, primaryWid)
    getUnityHost(primaryPtyId).focus()
  }
  const onRestartRef = useRef(onRestart)
  onRestartRef.current = onRestart
  const unreachable = primaryInst?.reachable === false && !primaryInst.fault
  const autoResetAttempts = useRef(0)
  useEffect(() => {
    if (remote) return
    if (!unreachable) {
      if (inEdit || playingNow) autoResetAttempts.current = 0
      return
    }
    if (
      !shouldAutoRelaunch({
        unreachable,
        stopped,
        relaunching: locks.relaunch,
        attempts: autoResetAttempts.current
      })
    )
      return
    autoResetAttempts.current += 1
    console.log(`[unity] editor unreachable — auto-reset attempt ${autoResetAttempts.current}`)
    onRestartRef.current()
  }, [unreachable, inEdit, playingNow, locks.relaunch, stopped])
  const unityMode: UnityMode = primaryInst?.unityMode ?? 'normal'
  const modeSwitchLocked =
    locks.relaunch ||
    groupWorking ||
    groupPending ||
    tearingDown ||
    !inEdit ||
    (!!primaryLifecycle && TRANSITIONAL_LIFECYCLES.has(primaryLifecycle))
  const onSetUnityMode = (mode: UnityMode): void => {
    debugLog(
      `[mode] click mode=${mode} cur=${unityMode} locked=${modeSwitchLocked} lc=${primaryLifecycle} gw=${groupWorking} gp=${groupPending} td=${tearingDown} relaunch=${locks.relaunch}`
    )
    if (modeSwitchLocked || mode === unityMode) return
    const st = useWorldStore.getState()
    for (const wid of realIds) {
      st.setPlaying(projectPath, wid, false)
      st.setHotReload(projectPath, wid, false)
    }
    if (mode === 'headless-nographics' && count > 1) st.setPlayerCount(projectPath, 1)
    userMuted.current.clear()
    setAudioFocus(0)
    setSessionStatus(primaryPtyId, { revealed: false })
    void window.api.unity.setMode(projectPath, mode).then((r) => {
      if (!r.ok && r.inputGate) setSessionStatus(primaryPtyId, { inputGate: r.inputGate })
      else if (!r.ok && r.hub) setSessionStatus(primaryPtyId, { hub: r.hub })
      else if (!r.ok && r.standalone) setSessionStatus(primaryPtyId, { standalone: true })
    })
    getUnityHost(primaryPtyId).focus()
  }
  const multiplayerAllowed = unityMode !== 'headless-nographics'
  const addPlayer = (): void => {
    if (locks.addPlayer || count >= MAX_PLAYERS || !multiplayerAllowed) return
    useWorldStore.getState().setPlayerCount(projectPath, count + 1)
  }
  const removePlayer = (): void => {
    if (locks.removePlayer || count <= 1) return
    useWorldStore.getState().setPlayerCount(projectPath, count - 1)
  }
  const revealed = sessionStatus.revealed
  const agentsWorking = useAgentsWorkingForPane(primaryPtyId)
  const revealLocked =
    groupWorking ||
    groupPending ||
    tearingDown ||
    (!!primaryLifecycle && TRANSITIONAL_LIFECYCLES.has(primaryLifecycle))
  const revealLockedReason = BUSY_REASON
  const revealBusy = useRef(false)
  const onToggleReveal = (): void => {
    if (revealLocked) return
    if (revealBusy.current) return
    revealBusy.current = true
    const show = !revealed
    const run = async (): Promise<void> => {
      if (show) {
        const r = await window.api.unity.revealEditor(projectPath)
        if (r.ok) setSessionStatus(primaryPtyId, { revealed: true })
        else console.log(`[unity] reveal editor failed: ${r.error}`)
        return
      }
      const r = await window.api.unity.hideEditor(projectPath)
      if (r.ok) {
        setSessionStatus(primaryPtyId, { revealed: false })
        await window.api.window.exitRevealLayout()
      } else console.log(`[unity] hide editor failed: ${r.error}`)
    }
    void run().finally(() => {
      revealBusy.current = false
    })
  }
  const onRevealSplit = (): void => {
    if (revealLocked || revealed) return
    if (revealBusy.current) return
    revealBusy.current = true
    void window.api.unity
      .revealEditor(projectPath, { split: true })
      .then((r) => {
        if (r.ok) setSessionStatus(primaryPtyId, { revealed: true })
        else console.log(`[unity] reveal editor (split) failed: ${r.error}`)
      })
      .finally(() => {
        revealBusy.current = false
      })
  }


  const [savedResolutions, setSavedResolutions] = useState<SavedStreamResolution[]>([])
  useEffect(() => {
    let alive = true
    void window.api.unity.getStreamResolutions(projectPath).then((list) => {
      if (alive) setSavedResolutions(list)
    })
    return () => {
      alive = false
    }
  }, [projectPath])
  const actionNodes = unityNodes({
    canStop,
    showPlayToggle,
    playingNow,
    paused,
    inEdit,
    stopped,
    stopping,
    streaming,
    locks,
    count,
    multiplayerAllowed,
    armed,
    canArm,
    focusedMuted,
    focusedVolume,
    audioCount: realIds.length,
    focusedIdx,
    scenes,
    recentScenes,
    selectedScene,
    sceneDirty: !!primaryInst?.sceneDirty && primaryInst.scene === selectedScene,
    unityMode,
    modes: UNITY_MODE_MENU,
    modeSwitchLocked,
    revealed,
    revealLocked,
    refreshBlockedReason,
    stopBlockedReason,
    fpsCap,
    fpsOptions: FPS_CAP_OPTIONS,
    streamRes,
    savedResolutions,
    toggleRun: () => toggleRun(),
    togglePause,
    stepFrame,
    addPlayer,
    removePlayer,
    toggleMute,
    onVolume,
    pickAudio,
    toggleHotReload,
    onScene,
    onNewScene,
    newSceneFolder: newSceneFolder(selectedScene),
    onDiscardScene: () => void discardSceneChanges(projectPath, null),
    onRemoveRecentScene,
    onSetUnityMode,
    onToggleReveal,
    onRevealSplit,
    onRefresh,
    onRestart,
    onStop,
    onFpsCap,
    onStreamRes
  })
  usePanelActions(primaryPtyId, actionNodes)

  return {
    focusedMuted,
    preferredScene,
    modeSwitchLocked,
    revealLocked,
    primaryPtyId,
    primaryWid,
    isUnityProject,
    setIsUnityProject,
    recentScenes,
    setRecentScenes,
    persistedScene,
    refreshRecent,
    gridIds,
    count,
    realIds,
    realKey,
    cols,
    rows,
    scenes,
    groupWorking,
    tearingDown,
    groupPending,
    armable,
    primaryInst,
    primaryDesired,
    observedScene,
    locks,
    statusDot,
    streaming,
    sessionStatus,
    life,
    settingsLoaded,
    savedVolume,
    savedMuted,
    audioFocus,
    setAudioFocus,
    userMuted,
    seededMute,
    focusedIdx,
    focusedWid,
    focusedSessionId,
    focusedDesired,
    focusedVolume,
    primaryLifecycle,
    inEdit,
    playingNow,
    compileError,
    recompilePending,
    showPlayToggle,
    armed,
    canArm,
    stopped,
    editorsRunning,
    stopping,
    stopRequested,
    setStopRequested,
    refreshBlockedReason,
    stopBlockedReason,
    selectedScene,
    streamRes,
    fpsCap,
    setPanelFullscreen,
    toggleRun,
    paused,
    togglePause,
    stepFrame,
    toggleRunRef,
    toggleMute,
    toggleHotReload,
    hotReloadPulse,
    hotReloadToast,
    onVolume,
    pickAudio,
    onScene,
    onNewScene,
    switchScene,
    onRemoveRecentScene,
    onFpsCap,
    onStreamRes,
    onRestart,
    onStop,
    onRefresh,
    onRestartRef,
    unreachable,
    autoResetAttempts,
    unityMode,
    onSetUnityMode,
    multiplayerAllowed,
    addPlayer,
    removePlayer,
    revealed,
    agentsWorking,
    revealLockedReason,
    revealBusy,
    onToggleReveal,
    onRevealSplit
  }
}

export function PaneUnitySlot({
  id,
  projectPath,
  canStop = true
}: {
  id: string
  projectPath: string
  canStop?: boolean
}) {
  const {
    focusedMuted,
    preferredScene,
    modeSwitchLocked,
    revealLocked,
    primaryPtyId,
    primaryWid,
    isUnityProject,
    setIsUnityProject,
    recentScenes,
    setRecentScenes,
    persistedScene,
    refreshRecent,
    gridIds,
    count,
    realIds,
    realKey,
    cols,
    rows,
    scenes,
    groupWorking,
    tearingDown,
    groupPending,
    armable,
    primaryInst,
    primaryDesired,
    observedScene,
    locks,
    statusDot,
    streaming,
    sessionStatus,
    life,
    settingsLoaded,
    savedVolume,
    savedMuted,
    audioFocus,
    setAudioFocus,
    userMuted,
    seededMute,
    focusedIdx,
    focusedWid,
    focusedSessionId,
    focusedDesired,
    focusedVolume,
    primaryLifecycle,
    inEdit,
    playingNow,
    compileError,
    recompilePending,
    showPlayToggle,
    armed,
    canArm,
    stopped,
    editorsRunning,
    stopping,
    stopRequested,
    setStopRequested,
    refreshBlockedReason,
    stopBlockedReason,
    selectedScene,
    streamRes,
    fpsCap,
    setPanelFullscreen,
    toggleRun,
    paused,
    togglePause,
    stepFrame,
    toggleRunRef,
    toggleMute,
    toggleHotReload,
    hotReloadPulse,
    hotReloadToast,
    onVolume,
    pickAudio,
    onScene,
    onNewScene,
    switchScene,
    onRemoveRecentScene,
    onFpsCap,
    onStreamRes,
    onRestart,
    onStop,
    onRefresh,
    onRestartRef,
    unreachable,
    autoResetAttempts,
    unityMode,
    onSetUnityMode,
    multiplayerAllowed,
    addPlayer,
    removePlayer,
    revealed,
    agentsWorking,
    revealLockedReason,
    revealBusy,
    onToggleReveal,
    onRevealSplit
  } = useUnityPlayerController({ id, projectPath, canStop })

  const dotClass = toneClass(statusDot.tone)

  if (isUnityProject === false) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas text-center">
        <p className="text-sm text-zinc-400">Not a Unity project</p>
        <p className="max-w-xs px-6 text-xs text-zinc-600">
          This folder has no <span className="text-zinc-500">Assets/</span> +{' '}
          <span className="text-zinc-500">ProjectSettings/</span>. Open a Unity project folder to use
          the player.
        </p>
      </div>
    )
  }

  if (life && (life.phase === 'missing' || life.phase === 'installing')) return <UnityVersionView life={life} />

  const otherFailure = isUnityDown(life) && life.code !== 'input-system' && life.code !== 'locked'
  if (sessionStatus.inputGate && !otherFailure) {
    return (
      <UnityInputGateView
        problem={sessionStatus.inputGate}
        projectPath={projectPath}
        onRetry={() => {
          setSessionStatus(primaryPtyId, { inputGate: null })
          bumpUnityRetry(primaryPtyId)
        }}
      />
    )
  }

  const hubGate: Exclude<HubState, 'ready'> | null = life ? (life.phase === 'hub' && life.hub !== 'ready' ? life.hub : null) : (sessionStatus.hub ?? null)
  if (hubGate) {
    return (
      <UnityHubBlockedView
        projectPath={projectPath}
        initial={hubGate}
        onReady={() => {
          setSessionStatus(primaryPtyId, { hub: null })
          bumpUnityRetry(primaryPtyId)
        }}
      />
    )
  }

  if (sessionStatus.standalone && !otherFailure) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-canvas text-center">
        <p className="text-sm text-zinc-300">Another Unity is open</p>
        <p className="max-w-xs px-6 text-xs text-zinc-600">
          This project is open in another Unity. Close it, then press Retry to use the in-app
          player.
        </p>
        <div className="mt-1 flex items-center gap-2">
          <CloseExternalUnityButton
            projectPath={projectPath}
            onClosed={() => {
              setSessionStatus(primaryPtyId, { standalone: false })
              setTimeout(() => bumpUnityRetry(primaryPtyId), 1500)
            }}
          />
          <button
            onClick={() => bumpUnityRetry(primaryPtyId)}
            className="flex items-center gap-1.5 rounded border border-white/10 px-3 py-1.5 text-xs text-zinc-300 outline-none transition-colors hover:bg-white/10 hover:text-white"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6" />
              <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
            </svg>
            Retry
          </button>
        </div>
      </div>
    )
  }

  const lifeDown = isUnityDown(life) && realIds.length === 0
  if (lifeDown || sessionStatus.error) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-canvas text-center" data-unity-start-failed>
        {lifeDown ? (
          <UnityStateCard
            life={life}
            onAction={(a) => {
              if (a === 'retry' || a === 'close-other') setSessionStatus(primaryPtyId, { error: null, standalone: false })
            }}
          />
        ) : (
          <>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-rose-400" />
            <p className="text-sm text-rose-300">Unity couldn’t start</p>
            <p className="max-w-sm px-6 text-xs text-zinc-400">{sessionStatus.error}</p>
            <button
              onClick={() => {
                setSessionStatus(primaryPtyId, { error: null })
                bumpUnityRetry(primaryPtyId)
              }}
              className="mt-1 flex items-center gap-1.5 rounded border border-white/10 px-3 py-1.5 text-xs text-zinc-300 outline-none transition-colors hover:bg-white/10 hover:text-white"
            >
              Retry
            </button>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-canvas" data-unity-player>
      <BarXScroll
        className="bar-x-scroll flex h-9 items-center gap-1 border-b border-white/[0.06] bg-canvas px-1.5"
      >
        <div className="flex shrink-0 items-center gap-px" data-unity-playback>
        <TbButton
          onClick={(e) => toggleRun(e.shiftKey)}
          disabled={locks.playStop}
          title={
            stopped
              ? STOPPED_REASON
              : compileError
                ? 'Fix the compile error and save to recompile before playing'
                : groupPending
                  ? 'Waiting for all players to launch…'
                  : primaryLifecycle === 'entering-play'
                    ? 'Players are loading — wait until every player is up'
                    : groupWorking
                      ? 'Busy — wait for the current action to finish'
                      : showPlayToggle
                        ? 'Play (enter Play Mode) — Shift-click to fullscreen this panel'
                        : 'Stop (enter Edit Mode) — Shift-click to also leave fullscreen'
          }
        >
          {showPlayToggle ? (
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
              <path d="M7 4l13 8-13 8V4z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
          )}
        </TbButton>

        <TbButton
          onClick={togglePause}
          active={playingNow && paused}
          disabled={!playingNow}
          title={
            !playingNow
              ? 'Enter Play Mode to pause'
              : paused
                ? 'Resume the paused players'
                : 'Pause every player'
          }
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
            <rect x="7" y="5" width="3.5" height="14" rx="1" />
            <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
          </svg>
        </TbButton>

        <TbButton
          onClick={stepFrame}
          disabled={!playingNow}
          title={
            !playingNow
              ? 'Enter Play Mode to step frames'
              : 'Advance one frame on every player (pauses if running)'
          }
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
            <path d="M6 5l9 7-9 7V5z" />
            <rect x="16.5" y="5" width="2.5" height="14" rx="1" />
          </svg>
        </TbButton>
        </div>

        <div className="flex-1" />

        <PlayersControl
          count={count}
          canAdd={!locks.addPlayer}
          canRemove={!locks.removePlayer}
          tearingDown={tearingDown}
          multiplayerDisabled={!multiplayerAllowed}
          onAdd={addPlayer}
          onRemove={removePlayer}
        />

        <Divider />

        <VolumeControl
          id={focusedSessionId}
          muted={focusedMuted}
          volume={focusedVolume}
          onToggleMute={toggleMute}
          onVolume={onVolume}
          audioCount={realIds.length}
          audioFocus={focusedIdx}
          onPickAudio={pickAudio}
        />
      </BarXScroll>

      <div className="relative min-h-0 flex-1">
        {life?.dialog && !stopped && (
          <div className="absolute inset-0 z-[40] flex items-center justify-center bg-canvas">
            <UnityDialogCard project={projectPath} dialog={life.dialog} />
          </div>
        )}
        {stopped ? (
          <StoppedView closing={stopping} />
        ) : (
          <div
            className="absolute inset-0 grid gap-px bg-white/10"
            style={{
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
              gridAutoFlow: 'column'
            }}
          >
            {gridIds.map((gid) => (
              <UnityViewportCell
                key={gid}
                projectPath={projectPath}
                worldId={gid}
                primaryPtyId={primaryPtyId}
                pending={isPendingId(gid)}
                revealLocked={revealLocked}
                revealLockedReason={revealLockedReason}
                refreshBlocked={!!refreshBlockedReason || agentsWorking}
                compactConsole={count > 1}
              />
            ))}
          </div>
        )}

        {hotReloadPulse.active && (
          <div className="hot-reload-active pointer-events-none absolute inset-0 z-10" />
        )}

        {!hotReloadPulse.active && hotReloadPulse.outcome === 'patched' && (
          <div
            key={hotReloadPulse.seq}
            className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
          >
            <div className="hot-reload-flash absolute inset-0" />
            <div className="hot-reload-ripple absolute left-1/2 top-1/2 h-1/2 w-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full" />
          </div>
        )}

        {hotReloadToast && (
          <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-2 rounded-lg border border-white/10 bg-black/75 px-3 py-1.5 text-xs text-zinc-100 shadow-lg backdrop-blur-sm">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${toneDot(hotReloadToast.tone)} ${
                hotReloadToast.tone === 'pending' ? 'animate-pulse' : ''
              }`}
            />
            {hotReloadToast.text}
          </div>
        )}

        {inEdit && !revealed && !stopped && <AgentFeedbackOverlay projectPath={projectPath} />}
      </div>

      <BarXScroll
        className="bar-x-scroll flex h-9 items-center gap-1 border-t border-white/[0.06] bg-canvas px-1.5"
      >
        <ScenePicker
          id={primaryPtyId}
          scenes={scenes}
          recentScenes={recentScenes}
          value={selectedScene}
          dirty={!!primaryInst?.sceneDirty && primaryInst.scene === selectedScene}
          disabled={locks.scene}
          onRemoveRecent={onRemoveRecentScene}
          onDiscard={
            inEdit && !stopped && !locks.scene ? (el) => void discardSceneChanges(projectPath, anchorFromElement(el)) : undefined
          }
          openUp
          alignLeft
          title={
            stopped
              ? STOPPED_REASON
              : scenes.length === 0
                ? 'No scenes found'
                : groupWorking
                  ? 'Busy — wait for the current action to finish'
                  : inEdit
                    ? 'Load scene + enter Play Mode'
                    : 'Stop to Edit Mode to change scenes'
          }
          onSelect={onScene}
          onCreate={inEdit && !stopped && !locks.scene ? onNewScene : undefined}
        />

        <div className="flex-1" />

        {!inEdit && streaming ? (
          <>
            <Divider />
            <TbButton
              onClick={toggleHotReload}
              active={armed}
              disabled={!armed && !canArm}
              title={
                armed
                  ? 'Hot reload armed (locked) — press Stop to disarm it and recompile every instance'
                  : !canArm
                    ? 'Arm hot reload once every player is running with no pending recompile'
                    : 'Arm live C# hot-reload for every instance (Stop disarms it and recompiles)'
              }
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13z" />
              </svg>
              Hot Reload
            </TbButton>
          </>
        ) : null}
        {inEdit || playingNow ? (
          <>
            <Divider />
            <RevealEditorMenu
              unityMode={unityMode}
              onSetUnityMode={onSetUnityMode}
              modeSwitchLocked={modeSwitchLocked}
              revealed={revealed}
              locked={revealLocked}
              lockedReason={revealLockedReason}
              onToggle={onToggleReveal}
              onRevealSplit={onRevealSplit}
            />
          </>
        ) : null}

        <Divider />

        <RefreshRelaunchMenu
          onRefresh={onRefresh}
          onRelaunch={onRestart}
          onStop={canStop ? onStop : undefined}
          disabled={stopped ? stopping : locks.relaunch}
          refreshDisabled={!!refreshBlockedReason}
          refreshDisabledReason={refreshBlockedReason}
          stopDisabledReason={stopBlockedReason}
          title={canStop ? MENU_TITLE_WITH_STOP : 'Refresh or relaunch the Unity Player'}
        />

        <Divider />

        <div>
          <StatusControl
            sessionId={primaryPtyId}
            projectPath={projectPath}
            dot={dotClass}
            statusLabel={statusDot.label}
            streaming={streaming}
            fpsCap={fpsCap}
            onFpsCap={onFpsCap}
            streamRes={streamRes}
            onStreamRes={onStreamRes}
          />
        </div>
      </BarXScroll>
    </div>
  )
}

function LoadingStrip({ label, pct }: { label: string; pct: number }) {
  const determinate = pct >= 0
  return (
    <div className="relative mt-1 w-72 max-w-[80%]">
      <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
        {determinate ? (
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        ) : (
          <div className="worktree-copy-indeterminate h-full rounded-full bg-accent" />
        )}
      </div>
      {label && (
        <p className="mt-1.5 line-clamp-2 break-words text-center text-[11px] leading-snug text-zinc-400">
          {label}
        </p>
      )}
    </div>
  )
}

export function editorBusyLabel(inst: InstanceObserved | undefined, lifecycle: Lifecycle | undefined): string {
  if (inst?.compile === 'compiling') return 'Compiling…'
  if (inst?.saving) return 'Saving…'
  if (lifecycle === 'restarting') return 'Restarting…'
  if (lifecycle === 'entering-play') return 'Entering Play Mode…'
  if (lifecycle === 'exiting-play') return 'Stopping…'
  return ''
}

export function UnityStreamOverlay({
  inst,
  lifecycle
}: {
  inst: InstanceObserved | undefined
  lifecycle: Lifecycle | undefined
}): React.JSX.Element | null {
  if (!inst) return null
  const busy = editorBusyLabel(inst, lifecycle)
  const label = inst.progressLabel
  const pct = inst.progressPct
  const badges: { text: string; tone: string }[] = []
  if (inst.reachable === false) badges.push({ text: 'Not responding', tone: 'bg-rose-400' })
  if (inst.compile === 'error') badges.push({ text: 'Compile error — see the Console', tone: 'bg-rose-400' })
  if (inst.paused && lifecycle === 'playing') badges.push({ text: 'Paused', tone: 'bg-amber-400' })
  if (!busy && !label && badges.length === 0) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-10" data-unity-stream-state={busy || label || badges.map((b) => b.text).join(', ')}>
      {badges.length > 0 && (
        <div className="absolute left-2 top-2 flex flex-col items-start gap-1">
          {badges.map((b) => (
            <span key={b.text} className="flex items-center gap-1.5 rounded border border-white/10 bg-black/75 px-2 py-1 text-[11px] text-zinc-100 backdrop-blur-sm">
              <span className={`h-2 w-2 shrink-0 rounded-full ${b.tone}`} />
              {b.text}
            </span>
          ))}
        </div>
      )}
      {!busy && label && (
        <div className="absolute right-2 top-2 flex max-w-[60%] items-center gap-1.5 rounded border border-white/10 bg-black/75 px-2 py-1 text-[11px] text-zinc-100 backdrop-blur-sm">
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
          <span className="truncate">{label}</span>
          {pct >= 0 && <span className="shrink-0 tabular-nums text-zinc-400">{pct}%</span>}
        </div>
      )}
      {busy && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex max-w-[80%] flex-col items-center rounded border border-white/10 bg-black/75 px-4 py-2 text-sm text-zinc-100 shadow-lg backdrop-blur-sm">
            <div className="flex items-center gap-2.5">
              <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
              {busy}
            </div>
            {label && <LoadingStrip label={label} pct={pct} />}
          </div>
        </div>
      )}
    </div>
  )
}

function relaunchFrom(scope: string): void {
  void runAction(panelActions(scope), 'unity.relaunch').catch((e: Error) => console.log(`[unity] relaunch failed: ${e.message}`))
}

export function UnityStateNote({
  quitting,
  pending,
  pendingHub,
  inst,
  lifecycle,
  scope,
  life = null,
  remote = false,
  onOpenProject
}: {
  quitting: boolean
  pending: boolean
  pendingHub: HubState | null
  inst: InstanceObserved | undefined
  lifecycle: Lifecycle | undefined
  scope: string
  life?: UnityLifecycle | null
  remote?: boolean
  onOpenProject?: () => void
}): React.JSX.Element {
  const primaryDown = isUnityDown(life) && (!inst || inst.role === 'primary')
  const compileErr = inst?.compileError ?? null
  const progressLabel = inst?.progressLabel ?? ''
  const progressPct = inst?.progressPct ?? -1
  const booting = lifecycle === 'launching' || lifecycle === 'restarting'
  const showStrip = progressLabel !== '' || (booting && progressPct >= 0)
  const stripLabel = showStrip ? progressLabel : ''
  const busy = editorBusyLabel(inst, lifecycle)
  const stall = inst?.stall ?? ''
  const relaunch = (): void => relaunchFrom(scope)
  const strip = stall ? (
    <EditorStallNote label={stripLabel} pct={progressPct} stall={stall} log={inst?.logPath ?? ''} onRestart={relaunch} />
  ) : showStrip ? (
    <LoadingStrip label={stripLabel} pct={progressPct} />
  ) : null
  return (
  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas text-center" data-unity-note={inst?.fault || (primaryDown && life ? `state:${life.state}` : stall ? 'stall' : lifecycle ?? '')}>
    {lifecycle !== 'restarting' && (
      <svg viewBox="0 0 16 9" preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full">
        <rect width="16" height="9" fill="#000" />
      </svg>
    )}
    {quitting ? (
      <>
        <div className="relative h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
        <p className="relative text-sm text-zinc-400">Closing Unity…</p>
      </>
    ) : pending && pendingHub && pendingHub !== 'ready' ? (
      <UnityHubCard state={pendingHub} compact />
    ) : pending ? (
      <>
        <div className="relative h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
        <p className="relative text-sm text-zinc-400">Starting Player…</p>
      </>
    ) : inst?.fault ? (
      <EditorFaultCard
        kind={inst.fault}
        subject={inst.role === 'clone' ? `Player ${inst.playerIndex + 1}` : 'Unity'}
        reason={inst.faultReason}
        log={inst.logPath}
        line={inst.faultLine}
        onRestart={relaunch}
      />
    ) : primaryDown && life ? (
      <div className="pointer-events-auto relative">
        <UnityStateCard life={life} compact remote={remote} onOpenProject={onOpenProject} />
      </div>
    ) : inst?.compile === 'compiling' ? (
      <>
        {!stall && <div className="relative h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />}
        <p className="relative text-sm text-zinc-400">Compiling…</p>
        {strip}
      </>
    ) : inst?.compile === 'error' ? (
      <div className="relative flex max-w-md flex-col items-center gap-1.5 px-6">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-rose-400" />
        <p className="text-sm text-rose-300">Compile error</p>
        <p className="text-xs leading-snug text-zinc-500">
          {booting
            ? "Unity couldn't finish starting — fix the errors, then Relaunch."
            : 'See the Console for all errors.'}
        </p>
      </div>
    ) : lifecycle === 'error' || (lifecycle === 'exited' && inst?.error) ? (
      <>
        <span className="relative h-2.5 w-2.5 shrink-0 rounded-full bg-rose-400" />
        <p className="relative max-w-xs text-sm text-rose-300">
          {inst?.error ?? 'Unity error — see the Console.'}
        </p>
      </>
    ) : lifecycle === 'exited' ? (
      <>
        <span className="relative h-2.5 w-2.5 shrink-0 rounded-full bg-zinc-500" />
        <p className="relative text-sm text-zinc-400">Unity stopped</p>
      </>
    ) : inst?.reachable === false ? (
      <>
        <span className="relative h-2.5 w-2.5 shrink-0 rounded-full bg-rose-400" />
        <p className="relative max-w-xs text-sm text-rose-300">
          Can't reach this Unity instance — automatic relaunch didn't recover it. Use Relaunch
          to retry. For diagnostic logs, open the Unity Console from the New Session menu (+)
          to see Unity's errors and warnings.
        </p>
      </>
    ) : inst?.unityMode === 'headless-nographics' ? (
      <div className="relative flex max-w-xs flex-col items-center gap-1.5 px-6">
        <svg viewBox="0 0 24 24" className="h-6 w-6 text-zinc-500" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
          <path d="M3 3l18 18" />
        </svg>
        <p className="text-sm text-zinc-300">Running headless</p>
        <p className="text-xs leading-snug text-zinc-500">
          No live view. Nothing is rendered here, which makes the editor faster. To watch it, pick
          Normal or Headless Graphics in the Editor menu.
        </p>
      </div>
    ) : lifecycle === 'editmode' && !busy && !showStrip ? (
      <div className="relative flex max-w-xs flex-col items-center gap-2 px-6 text-center" data-unity-editmode-note>
        <span className="rounded bg-white/5 px-3 py-1.5 text-xs text-zinc-400">
          {compileErr ? '⏸ Edit Mode — fix compile errors in the Console' : '⏸ Edit Mode — press Play to run'}
        </span>
      </div>
    ) : (
      <>
        {!stall && <div className="relative h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />}
        {!stripLabel && !stall && (
          <p className="relative text-sm text-zinc-400">
            {busy ||
              (lifecycle === 'playing'
                ? 'Entering Play Mode…'
                : lifecycle === 'editmode'
                  ? 'Unity is busy…'
                  : life && life.state === 'starting'
                    ? stateTitle(life)
                    : 'Starting Unity…')}
          </p>
        )}
        {strip}
      </>
    )}
  </div>
  )
}

export const UnityViewportCell = memo(UnityViewportCellImpl)

function UnityViewportCellImpl({
  projectPath,
  worldId,
  primaryPtyId,
  pending,
  revealLocked,
  revealLockedReason,
  refreshBlocked,
  compactConsole = false
}: {
  projectPath: string
  worldId: string
  primaryPtyId: string
  pending: boolean
  revealLocked: boolean
  revealLockedReason: string
  refreshBlocked: boolean
  compactConsole?: boolean
}) {
  const quitting = useAppQuitting()
  const mountRef = useRef<HTMLDivElement>(null)
  const inst = useInstance(projectPath, pending ? '' : worldId)
  const playerIndex = inst?.playerIndex ?? 0
  const sessionId = sessionIdFor(primaryPtyId, playerIndex)
  const streamingNow = useStreaming(
    pending ? '' : projectPath,
    pending ? '' : worldId,
    pending ? '' : sessionId
  )

  const lifecycle = useEffectiveLifecycle(projectPath, pending ? '' : worldId)
  const cellLife = useUnityLifecycle(projectPath)
  const framesLive = useWorldStore((s) => {
    const loc = pending ? undefined : s.framesLive[sessionId]
    return !!loc && loc.projectPath === projectPath && loc.worldId === worldId
  })
  const [noFrames, setNoFrames] = useState(false)
  const holdLabel = inst?.progressLabel ?? ''
  useEffect(() => {
    setNoFrames(false)
    if (framesLive || lifecycle !== 'playing' || holdLabel) return
    const t = setTimeout(() => setNoFrames(true), FIRST_FRAME_WAIT_MS)
    return () => clearTimeout(t)
  }, [framesLive, lifecycle, holdLabel])
  const streaming = inst?.unityMode !== 'headless-nographics' && streamingNow && (framesLive || noFrames)
  const isPrimary = inst?.role === 'primary'
  const primaryStatus = useSessionStatus(primaryPtyId)
  const pendingHub = useHubState(projectPath, pending)
  const primaryRevealedHere = !pending && isPrimary && primaryStatus.revealed
  const hidePrimary = (): void => {
    if (revealLocked) return
    void window.api.unity.hideEditor(projectPath).then(async (r) => {
      if (r.ok) {
        setSessionStatus(primaryPtyId, { revealed: false })
        await window.api.window.exitRevealLayout()
      } else console.log(`[unity] hide editor failed: ${r.error}`)
    })
  }
  const focusRefreshRef = useRef<() => void>(() => {})
  focusRefreshRef.current = () => {
    if (quietHostFocus || refreshBlocked) return
    if (isPrimary && lifecycle === 'editmode') useWorldStore.getState().bumpRefresh(projectPath, worldId)
  }

  useEffect(() => {
    if (pending) return
    const slot = mountRef.current
    if (!slot) return
    const host = getUnityHost(sessionId)
    slot.appendChild(host)
    const onFocus = (): void => focusRefreshRef.current()
    host.addEventListener('focus', onFocus)
    const raf = requestAnimationFrame(() => requestHintResend(sessionId))
    return () => {
      cancelAnimationFrame(raf)
      host.removeEventListener('focus', onFocus)
      if (host.parentElement === slot) parkUnityHost(sessionId)
    }
  }, [sessionId, pending])

  const headlessLogs = !pending && !quitting && inst?.unityMode === 'headless-nographics' && lifecycle !== 'exited' && !inst?.fault
  const playLabel = scratchpadPlayOf(lifecycle, !!inst?.paused)

  return (
    <div className="relative min-h-0 min-w-0 overflow-hidden bg-canvas">
      {!pending && (
        <div ref={mountRef} className="absolute inset-0" onPointerDown={() => getUnityHost(sessionId).focus()} />
      )}
      {!pending && !headlessLogs && lifecycle === 'playing' && inst?.noCamera && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-canvas" data-unity-no-camera={worldId}>
          <NoCameraCard />
        </div>
      )}
      {headlessLogs && (
        <div className="absolute inset-0 z-10 flex flex-col bg-canvas" data-headless-console={worldId}>
          {!compactConsole && (
            <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-white/[0.06] px-2 text-[11px] text-zinc-400">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-zinc-500" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                <circle cx="12" cy="12" r="3" />
                <path d="M3 3l18 18" />
              </svg>
              <span className="text-zinc-200">Player {playerIndex + 1}</span>
              <span>{playLabel ? PLAY_LABEL[playLabel] : 'Starting'}</span>
              <span className="ml-auto truncate text-zinc-500">Headless NoGraphics: no video, so the editor log shows here</span>
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            <PaneUnityConsoleSlot
              id={`${sessionId}|logs`}
              projectPath={projectPath}
              worldId={worldId}
              compact={compactConsole}
              maxLines={compactConsole ? 300 : 2000}
            />
          </div>
        </div>
      )}
      {(!streaming || !!inst?.fault) && !headlessLogs && <UnityStateNote quitting={quitting} pending={pending} pendingHub={pendingHub} inst={inst} lifecycle={lifecycle} scope={primaryPtyId} life={pending ? null : cellLife} />}
      {streaming && !inst?.fault && !headlessLogs && <UnityStreamOverlay inst={inst} lifecycle={lifecycle} />}
      {!pending && streaming && <VideoRecBadge sessionId={sessionId} />}
      {primaryRevealedHere && (
        <EditorOpenedOverlay
          onHide={hidePrimary}
          locked={revealLocked}
          lockedReason={revealLockedReason}
        />
      )}
    </div>
  )
}

function CloseExternalUnityButton({
  projectPath,
  onClosed
}: {
  projectPath: string
  onClosed: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if ((e.target as Element | null)?.closest?.('[data-menu-layer]')) return
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const close = (force: boolean): void => {
    setOpen(false)
    void window.api.unity.closeExternalEditor(projectPath, force).then((r) => {
      if (r.ok) onClosed()
    })
  }

  return (
    <div ref={ref} className="relative flex items-stretch">
      <button
        onClick={() => close(false)}
        title="Ask the other Unity editor to quit gracefully, then reopen the project here"
        className="flex items-center gap-1.5 rounded-l bg-accent px-3 py-1.5 text-xs font-semibold text-white outline-none transition-colors hover:bg-accent/90"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
        Close the other Unity
      </button>
      <button
        onClick={() => setOpen((o) => !o)}
        title="More close options"
        aria-label="More close options"
        className="flex items-center rounded-r border-l border-white/25 bg-accent px-1.5 text-white outline-none transition-colors hover:bg-accent/90"
      >
        <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <AnchoredLayer side="bottom" align="end" className="surface-overlay w-52 rounded-lg p-1">
          <button
            onClick={() => close(true)}
            className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left outline-none transition-colors hover:bg-rose-500/15"
          >
            <span className="flex items-center gap-1.5 text-xs text-rose-200">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
              Force kill
            </span>
            <span className="pl-5 text-[10px] leading-snug text-zinc-500">
              Immediately terminate it — may lose unsaved work.
            </span>
          </button>
        </AnchoredLayer>
      )}
    </div>
  )
}

function PlayersControl({
  count,
  canAdd,
  canRemove,
  tearingDown = false,
  multiplayerDisabled = false,
  onAdd,
  onRemove
}: {
  count: number
  canAdd: boolean
  canRemove: boolean
  tearingDown?: boolean
  multiplayerDisabled?: boolean
  onAdd: () => void
  onRemove: () => void
}) {
  const atMax = count >= MAX_PLAYERS
  const addBlocked = atMax || !canAdd || multiplayerDisabled
  const removeBlocked = count <= 1 || !canRemove
  return (
    <div className="flex shrink-0 items-center overflow-hidden rounded text-ink-2">
      <button
        tabIndex={-1}
        disabled={removeBlocked}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRemove}
        title={
          count <= 1
            ? 'Remove a player viewport'
            : !canRemove
              ? 'Wait for players to finish loading'
              : 'Remove a player viewport'
        }
        className={`flex items-center px-1.5 py-1 outline-none transition-colors ${
          removeBlocked ? 'cursor-not-allowed text-zinc-600' : 'hover:bg-white/10 hover:text-white'
        }`}
      >
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
          <path d="M5 12h14" />
        </svg>
      </button>
      <span className="min-w-[2.75rem] px-1 text-center text-xs tabular-nums text-ink">
        {count}P
      </span>
      <button
        tabIndex={-1}
        disabled={addBlocked}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onAdd}
        title={
          multiplayerDisabled
            ? 'Multiplayer is unavailable in Headless NoGraphics — switch mode to add players'
            : atMax
              ? `Maximum ${MAX_PLAYERS} players`
              : tearingDown
                ? 'A player is shutting down — wait for teardown to finish'
                : !canAdd
                  ? 'Stop to Edit Mode to add a player'
                  : 'Add a player viewport (headless clone)'
        }
        className={`flex items-center px-1.5 py-1 outline-none transition-colors ${
          addBlocked ? 'cursor-not-allowed text-zinc-600' : 'hover:bg-white/10 hover:text-white'
        }`}
      >
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  )
}

export function GridCellIcon({
  count,
  index,
  className = 'h-3.5 w-3.5'
}: {
  count: number
  index: number
  className?: string
}) {
  const { cols, rows } = gridDims(count)
  const CELL = 4
  const GAP = 1.2
  const w = cols * CELL + (cols - 1) * GAP
  const h = rows * CELL + (rows - 1) * GAP
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className} fill="none" preserveAspectRatio="xMidYMid meet">
      {Array.from({ length: count }, (_, k) => {
        const col = Math.floor(k / rows)
        const row = k % rows
        const sel = k === index
        return (
          <rect
            key={k}
            x={col * (CELL + GAP) + 0.4}
            y={row * (CELL + GAP) + 0.4}
            width={CELL - 0.8}
            height={CELL - 0.8}
            rx={0.8}
            fill={sel ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth={0.7}
            opacity={sel ? 1 : 0.45}
          />
        )
      })}
    </svg>
  )
}

export function EditorOpenedOverlay({
  onHide,
  locked = false,
  lockedReason = BUSY_REASON
}: {
  onHide: () => void
  locked?: boolean
  lockedReason?: string
}) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-canvas/95 text-center backdrop-blur-sm">
      <svg viewBox="0 0 24 24" className="h-7 w-7 text-emerald-400/80" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
        <path d="M15 3h6v6M10 14L21 3" />
      </svg>
      <p className="text-sm text-zinc-200">Editor is opened</p>
      <p className="max-w-xs px-6 text-xs text-zinc-500">
        The live Unity editor window is open for direct tweaking. Don&apos;t close that window — use
        the button below to hide it and return to the in-app view.
      </p>
      <button
        tabIndex={-1}
        disabled={locked}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onHide}
        title={locked ? lockedReason : undefined}
        className={`mt-1 flex items-center gap-1.5 rounded border border-white/10 px-3 py-1.5 text-xs outline-none transition-colors ${
          locked
            ? 'cursor-not-allowed text-zinc-600'
            : 'text-zinc-200 hover:bg-white/10 hover:text-white'
        }`}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
          <path d="M1 1l22 22" />
        </svg>
        Hide Editor
      </button>
    </div>
  )
}

function TbButton({
  onClick,
  title,
  active = false,
  disabled = false,
  children
}: {
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void
  title: string
  active?: boolean
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      tabIndex={-1}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      className={`flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 text-xs outline-none transition-colors ${
        disabled
          ? 'cursor-not-allowed text-ink-4'
          : active
            ? 'text-emerald-300 hover:bg-white/[0.07]'
            : 'text-ink-2 hover:bg-white/[0.07] hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

function RevealEditorMenu({
  unityMode,
  onSetUnityMode,
  modeSwitchLocked,
  revealed,
  locked,
  lockedReason = BUSY_REASON,
  onToggle,
  onRevealSplit
}: {
  unityMode: UnityMode
  onSetUnityMode: (mode: UnityMode) => void
  modeSwitchLocked: boolean
  revealed: boolean
  locked: boolean
  lockedReason?: string
  onToggle: () => void
  onRevealSplit: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const pop = useAnchoredPosition(open, btnRef, 'top-right')

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative flex shrink-0">
      <div
        className={`flex shrink-0 items-stretch overflow-hidden rounded transition-colors ${
          revealed ? 'bg-emerald-400/15' : open ? 'bg-white/10' : ''
        }`}
      >
        <button
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (unityMode !== 'normal') {
              setOpen((o) => !o)
              return
            }
            if (locked) return
            setOpen(false)
            onToggle()
          }}
          title={
            unityMode !== 'normal'
              ? 'Unity mode & live editor window'
              : locked
                ? lockedReason
                : revealed
                  ? 'Hide the Unity editor window'
                  : 'Reveal the real Unity editor window'
          }
          className={`flex items-center gap-1.5 whitespace-nowrap px-2 py-1 text-xs outline-none transition-colors ${
            revealed
              ? 'text-emerald-300 hover:bg-emerald-400/25'
              : locked && unityMode === 'normal'
                ? 'cursor-not-allowed text-zinc-600'
                : open
                  ? 'text-white hover:bg-white/10'
                  : 'text-zinc-300 hover:bg-white/10 hover:text-white'
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
            <path d="M15 3h6v6M10 14L21 3" />
          </svg>
          Editor
        </button>
        <button
          ref={btnRef}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
          title="Unity mode & live editor options"
          className={`flex items-center px-1 outline-none transition-colors ${
            revealed
              ? 'text-emerald-300 hover:bg-emerald-400/25'
              : open
                ? 'text-white hover:bg-white/10'
                : 'text-zinc-400 hover:bg-white/10 hover:text-white'
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 15l-6-6-6 6" />
          </svg>
        </button>
      </div>

      {open && (
        <div
          ref={pop.ref}
          style={pop.style}
          className="animate-menu-pop-in surface-overlay z-30 flex w-72 flex-col gap-2.5 rounded-lg p-3"
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">Unity mode</span>
            <div className="flex flex-col gap-1">
              {UNITY_MODE_MENU.map((m) => {
                const sel = m.id === unityMode
                const disabled = !sel && modeSwitchLocked
                return (
                  <button
                    key={m.id}
                    tabIndex={-1}
                    disabled={disabled}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (sel || disabled) return
                      setOpen(false)
                      onSetUnityMode(m.id)
                    }}
                    className={`flex flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left outline-none transition-colors ${
                      sel
                        ? 'bg-sky-500/15'
                        : disabled
                          ? 'cursor-not-allowed opacity-40'
                          : 'hover:bg-white/10'
                    }`}
                  >
                    <span className="flex w-full items-center gap-1.5 text-xs text-zinc-100">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${sel ? 'bg-sky-400' : 'bg-zinc-600'}`} />
                      {m.label}
                      {sel && <span className="ml-auto text-[10px] font-medium text-sky-300">Active</span>}
                    </span>
                    <span className="pl-3 text-[10px] leading-snug text-zinc-500">{m.desc}</span>
                  </button>
                )
              })}
            </div>
            {modeSwitchLocked && (
              <p className="text-[10px] leading-snug text-zinc-500">
                Mode switching is available in Edit Mode once the editor is idle.
              </p>
            )}
          </div>

          {unityMode === 'normal' && (
            <>
              <div className="border-t border-white/10" />
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500">Live Editor</span>
                  <span
                    className={`flex items-center gap-1 text-[10px] ${
                      revealed ? 'text-emerald-300' : 'text-zinc-500'
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${revealed ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                    {revealed ? 'Visible' : 'Hidden'}
                  </span>
                </div>
                <p className="text-[11px] leading-snug text-zinc-500">
                  Pop out the real Unity editor window to tweak the scene directly. The in-app player
                  keeps streaming while it&apos;s open.
                </p>
              </div>

              <button
                tabIndex={-1}
                disabled={locked}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (locked) return
                  setOpen(false)
                  onToggle()
                }}
                title={locked ? lockedReason : undefined}
                className={`flex items-center gap-2 rounded px-2 py-1.5 text-left outline-none transition-colors ${
                  locked
                    ? 'cursor-not-allowed bg-white/5 text-zinc-600'
                    : revealed
                      ? 'bg-white/5 text-zinc-200 hover:bg-white/10'
                      : 'bg-emerald-400/15 text-emerald-200 hover:bg-emerald-400/25'
                }`}
              >
                {revealed ? (
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
                    <path d="M1 1l22 22" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
                <span className="text-xs font-medium">{revealed ? 'Hide Editor' : 'Reveal Editor'}</span>
              </button>

              {!revealed && (
                <button
                  tabIndex={-1}
                  disabled={locked}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (locked) return
                    setOpen(false)
                    onRevealSplit()
                  }}
                  title={
                    locked
                      ? lockedReason
                      : 'Editor on the left half, the app on the right half — no locking'
                  }
                  className={`flex items-center gap-2 rounded px-2 py-1.5 text-left outline-none transition-colors ${
                    locked
                      ? 'cursor-not-allowed bg-white/5 text-zinc-600'
                      : 'bg-white/5 text-zinc-200 hover:bg-white/10'
                  }`}
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M12 4v16" />
                  </svg>
                  <span className="text-xs font-medium">Reveal Split 50/50</span>
                </button>
              )}

              {revealed && (
                <div className="flex items-start gap-1.5 rounded border border-amber-400/25 bg-amber-400/10 px-2 py-1.5">
                  <svg viewBox="0 0 24 24" className="mt-px h-3.5 w-3.5 shrink-0 text-amber-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    <path d="M12 9v4M12 17h.01" />
                  </svg>
                  <p className="text-[11px] leading-snug text-amber-200/90">
                    Don&apos;t close that editor window — it will stop the player. Use this button to hide
                    it instead.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export const UNITY_MODE_MENU: { id: UnityMode; label: string; desc: string }[] = [
  {
    id: 'normal',
    label: 'Normal',
    desc: 'Hidden windowed editor, streamed live — can be revealed. Best fidelity.'
  },
  {
    id: 'headless-graphics',
    label: 'Headless Graphics',
    desc: 'Batch mode with a GPU — no window, live view still streams.'
  },
  {
    id: 'headless-nographics',
    label: 'Headless NoGraphics',
    desc: 'Batch mode, no rendering or live view. Fastest.'
  }
]

export function StoppedView({ closing }: { closing: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas text-center">
      {closing ? (
        <>
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
          <p className="text-sm text-zinc-400">Closing Unity…</p>
        </>
      ) : (
        <>
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-zinc-500" />
          <p className="text-sm text-zinc-400">Unity stopped</p>
          <p className="max-w-xs px-6 text-xs text-zinc-600">{STOPPED_HINT}</p>
        </>
      )}
    </div>
  )
}

function RefreshRelaunchMenu({
  onRefresh,
  onRelaunch,
  onStop,
  disabled,
  refreshDisabled,
  refreshDisabledReason,
  stopDisabledReason,
  title
}: {
  onRefresh: () => void
  onRelaunch: () => void
  onStop?: () => void
  disabled: boolean
  refreshDisabled: boolean
  refreshDisabledReason?: string | null
  stopDisabledReason?: string | null
  title: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const pop = useAnchoredPosition(open, btnRef, 'top-right')

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (fn: () => void): void => {
    setOpen(false)
    fn()
  }

  return (
    <div ref={ref} className="relative flex shrink-0">
      <button
        ref={btnRef}
        tabIndex={-1}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => !disabled && setOpen((o) => !o)}
        title={title}
        className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 text-xs outline-none transition-colors ${
          disabled
            ? 'cursor-not-allowed text-zinc-600'
            : open
              ? 'bg-white/10 text-white'
              : 'text-zinc-300 hover:bg-white/10 hover:text-white'
        }`}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 4v6h-6" />
          <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
        </svg>
      </button>

      {open && (
        <div
          ref={pop.ref}
          style={pop.style}
          className="animate-menu-pop-in surface-overlay z-30 flex w-64 flex-col gap-1 rounded-lg p-1.5"
        >
          <button
            tabIndex={-1}
            disabled={refreshDisabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => !refreshDisabled && pick(onRefresh)}
            title={
              refreshDisabled
                ? (refreshDisabledReason ?? 'Stop to Edit Mode to refresh')
                : undefined
            }
            className={`flex flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left outline-none transition-colors ${
              refreshDisabled ? 'cursor-not-allowed' : 'hover:bg-white/10'
            }`}
          >
            <span className={`flex items-center gap-1.5 text-xs ${refreshDisabled ? 'text-zinc-600' : 'text-zinc-100'}`}>
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
              </svg>
              Refresh
            </span>
            <span className={`pl-5 text-[10px] leading-snug ${refreshDisabled ? 'text-zinc-700' : 'text-zinc-500'}`}>
              Recompile scripts &amp; reimport assets in the running editor.
            </span>
          </button>
          <button
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(onRelaunch)}
            className="flex flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left outline-none transition-colors hover:bg-rose-500/15"
          >
            <span className="flex items-center gap-1.5 text-xs text-rose-200">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M18.36 6.64a9 9 0 11-12.73 0M12 2v10" />
              </svg>
              Relaunch
            </span>
            <span className="pl-5 text-[10px] leading-snug text-zinc-500">{RELAUNCH_DESC}</span>
          </button>
          {onStop && (
            <button
              tabIndex={-1}
              disabled={!!stopDisabledReason}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => !stopDisabledReason && pick(onStop)}
              title={stopDisabledReason ?? undefined}
              className={`flex flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left outline-none transition-colors ${
                stopDisabledReason ? 'cursor-not-allowed' : 'hover:bg-rose-500/15'
              }`}
            >
              <span className={`flex items-center gap-1.5 text-xs ${stopDisabledReason ? 'text-zinc-600' : 'text-rose-200'}`}>
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
                Stop
              </span>
              <span className={`pl-5 text-[10px] leading-snug ${stopDisabledReason ? 'text-zinc-700' : 'text-zinc-500'}`}>
                {STOP_DESC}
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function VolumeControl({
  id,
  muted,
  volume,
  onToggleMute,
  onVolume,
  audioCount = 1,
  audioFocus = 0,
  onPickAudio
}: {
  id: string
  muted: boolean
  volume: number
  onToggleMute: () => void
  onVolume: (v: number) => void
  audioCount?: number
  audioFocus?: number
  onPickAudio?: (idx: number) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const pct = muted ? 0 : Math.round(volume * 100)
  const pop = useAnchoredPosition(open, boxRef, 'bottom-right')

  const close = (): void => {
    setOpen(false)
    getUnityHost(id).focus()
  }
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative flex shrink-0">
      <div ref={boxRef} className="flex items-stretch overflow-hidden rounded text-ink-2">
        <button
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleMute}
          title={muted ? 'Unmute' : 'Mute'}
          className="flex items-center px-1.5 py-1 outline-none transition-colors hover:bg-white/10 hover:text-white"
        >
          <VolumeIcon pct={pct} />
        </button>
        <button
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
          title="Volume"
          className={`flex w-4 items-center justify-center outline-none transition-colors hover:bg-white/10 hover:text-white ${
            open ? 'bg-white/10 text-white' : ''
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>

      {open && (
        <div
          ref={pop.ref}
          style={pop.style}
          className="animate-menu-pop-in surface-overlay z-30 flex w-44 flex-col gap-2 rounded-lg px-3 py-2"
        >
          {audioCount > 1 && onPickAudio && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-zinc-500">Listen to</span>
                <div className="flex items-center gap-1">
                  {Array.from({ length: audioCount }, (_, i) => (
                    <button
                      key={i}
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onPickAudio(i)}
                      title={`Listen to Player ${i + 1}`}
                      className={`flex flex-1 items-center justify-center rounded px-1 py-1 outline-none transition-colors ${
                        i === audioFocus
                          ? 'bg-sky-500/30 text-sky-100'
                          : 'text-zinc-400 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      <GridCellIcon count={audioCount} index={i} />
                    </button>
                  ))}
                </div>
              </div>
              <div className="h-px bg-white/10" />
            </>
          )}
          <input
            type="range"
            min={0}
            max={100}
            value={pct}
            tabIndex={-1}
            onChange={(e) => onVolume(Number(e.target.value))}
            title={`Volume ${pct}%`}
            className="h-1 w-full cursor-pointer accent-sky-400 outline-none focus:outline-none"
          />
        </div>
      )}
    </div>
  )
}

function VolumeIcon({ pct }: { pct: number }) {
  const muted = pct <= 0
  const waves = muted ? 0 : pct <= 33 ? 1 : pct <= 66 ? 2 : 3
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
      {muted && (
        <>
          <path d="M22 9l-6 6" />
          <path d="M16 9l6 6" />
        </>
      )}
      {waves >= 1 && <path d="M15.5 8.5a5 5 0 010 7" />}
      {waves >= 2 && <path d="M18 6a9 9 0 010 12" />}
      {waves >= 3 && <path d="M20 4a12 12 0 010 16" />}
    </svg>
  )
}

function StatusControl({
  sessionId,
  projectPath,
  dot,
  statusLabel,
  streaming,
  fpsCap,
  onFpsCap,
  streamRes,
  onStreamRes
}: {
  sessionId: string
  projectPath: string
  dot: string
  statusLabel: string
  streaming: boolean
  fpsCap: number
  onFpsCap: (cap: number) => void
  streamRes: string
  onStreamRes: (res: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const pop = useAnchoredPosition(open, btnRef, 'top-right')
  const { fps, ping } = useMetrics(sessionId)
  const info = streaming ? `${fps} fps${fpsCap > 0 ? ` (cap ${fpsCap})` : ''}${ping >= 0 ? ` · ${ping} ms` : ''}` : statusLabel
  const canvas = open && streaming ? getUnityCanvas(sessionId) : null
  const current = canvas && canvas.width > 0 && canvas.height > 0 ? `${canvas.width}×${canvas.height}` : null

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Element | null
      if (t?.closest?.('[data-stream-menu]')) return
      if (ref.current && !ref.current.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative flex shrink-0">
      <button
        ref={btnRef}
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        title="Stream status & settings"
        className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 py-1 text-xs tabular-nums outline-none transition-colors ${
          open ? 'text-ink hover:bg-white/[0.07]' : 'text-ink-3 hover:bg-white/[0.07] hover:text-ink-2'
        }`}
      >
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        {info}
      </button>

      {open && (
        <div
          data-stream-settings
          ref={pop.ref}
          style={pop.style}
          className="animate-menu-pop-in surface-overlay z-30 flex w-80 flex-col gap-2.5 rounded-lg p-3"
        >
          <PerfGraph sessionId={sessionId} targetFps={fpsCap} currentFps={fps} active={open} />

          <div className="h-px bg-white/10" />

          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">Unity Player</span>
            <span className="flex items-center gap-1.5 text-xs text-zinc-300">
              <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
              {info}
            </span>
          </div>

          <div className="h-px bg-white/10" />

          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">Target FPS</span>
              {streaming && (
                <span className="text-[10px] tabular-nums text-zinc-500">
                  {fps} now · {fpsCap > 0 ? `capped at ${fpsCap}` : 'set by the game'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onFpsCap(0)}
                title="Run at the frame rate the game sets (Application.targetFrameRate or QualitySettings.vSyncCount)"
                className={`shrink-0 whitespace-nowrap rounded px-1.5 py-1 text-xs outline-none transition-colors ${
                  fpsCap <= 0 ? 'bg-sky-500/30 text-sky-100' : 'text-zinc-400 hover:bg-white/10 hover:text-white'
                }`}
              >
                Managed by game
              </button>
              {FPS_CAP_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onFpsCap(opt)}
                  title={`Hold the game at ${opt} fps, whatever it asks for`}
                  className={`flex-1 rounded px-1 py-1 text-xs tabular-nums outline-none transition-colors ${
                    opt === fpsCap
                      ? 'bg-sky-500/30 text-sky-100'
                      : 'text-zinc-400 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>

          <StreamResolutionPicker
            projectPath={projectPath}
            streamRes={streamRes}
            onStreamRes={onStreamRes}
            current={current}
          />

          {!streaming && (
            <span className="text-[10px] leading-relaxed text-zinc-500">
              Resolution applies once the stream is running.
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function toneDot(tone: HotReloadTone): string {
  switch (tone) {
    case 'success':
      return 'bg-emerald-400'
    case 'error':
      return 'bg-rose-400'
    case 'warn':
      return 'bg-amber-400'
    case 'pending':
      return 'bg-amber-400'
    default:
      return 'bg-sky-400'
  }
}

function Divider() {
  return <div className="mx-1.5 h-4 w-px shrink-0 bg-white/[0.08]" />
}
