import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useFloating } from '../../lib/floating'
import { BarXScroll } from '../workbench/BarXScroll'
import {
  AlertTriangle,
  FileCode,
  Unplug,
  X,
  Filter,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  Focus,
  Globe,
  Lightbulb,
  LightbulbOff,
  Loader2,
  MonitorOff,
  Move3d,
  Rotate3d,
  Scale3d,
  RotateCcw,
  Grid3x3,
  Film,
  SquareDashed,
  Box,
  LocateFixed,
  SquareDot,
  EyeOff,
  PanelsTopLeft,
  FlaskConical
} from 'lucide-react'
import type {
  TunerBounds,
  TunerOverlayCanvas,
  TunerEntryTarget,
  TunerHierarchyRequest,
  TunerMember,
  TunerTreeRequest,
  TunerMode,
  TunerObject,
  TunerOverride,
  TunerEdit,
  TunerParticles,
  TunerReset,
  TunerState,
  TunerStateInfo,
  TunerUnsaved,
  TunerView,
  Vec3,
  Quat
} from '@shared/tuner'
import { NO_UNSAVED, TUNER_EDIT_STATE, TUNER_SCENE_PARENT, TUNER_SCENE_VIEW, openedTargets, unsavedCount, unsavedKey } from '@shared/tuner'
import { isSceneTuner, tunerTargetView } from '@shared/tuner-scope'
import type { TunerPiercePick } from '@shared/tuner-sceneview'
import type { Tab, TunerTarget } from '@shared/types'
import { scratchpadParentProject, scratchpadPromptScope, type ScratchpadInfo } from '@shared/scratchpads'
import { useAppStore } from '../../store'
import { useDismiss } from '../ui/useDismiss'
import { installTunerTips } from '../../lib/tuner/inspector/tooltip'
import { CanvasViewPicker } from './CanvasViewPicker'
import { SceneViewport, type PoseChange, type TunerFocus } from './SceneViewport'
import { ParticleEffectPanel } from './ParticleEffectPanel'
import { AnimatorTimeline, animatorKey, sendAnimator } from './animator/AnimatorTimeline'
import { mergeTunerAnimator, type TunerAnimator } from '@shared/tuner-animator'
import { parseTunerStagingReport, type TunerStaging } from '@shared/tuner-staging'
import type { StagingTrail } from '../../lib/tuner/staging-report'
import { StagingPanel } from './StagingPanel'
import { UnsavedMarker } from './UnsavedMarker'
import { setTunerUnsaved } from '../../lib/tuner/unsaved'
import { markTunerReload, markTunerSaving, useTunerReload, useUnityBusyLabel, useUnityPresence, useUnitySaving, type TunerShow } from '../../lib/tuner/tuner-loading'
import { PendingState } from '../ui/PendingState'
import { useEditorProgress } from '../scratchpad/scratchpad-status'
import { ensureProject, useWorldStore } from '../../lib/unity/world-store'
import { setTunerTabTitle, tunerScenesOf, tunerStagingScenes, tunerTitleFor, tunerVariantScenes } from '../../lib/tuner/tab-titles'
import { anchorFromElement, requestConfirm } from '../../lib/confirm/confirm-store'
import { SceneEffectsMenu } from './SceneEffectsMenu'
import { SceneCameraMenu } from './SceneCameraMenu'
import { SceneGizmosMenu, useTunerAnnotations } from './SceneGizmosMenu'
import { SceneHierarchy, type HierarchyPing } from './SceneHierarchy'
import { TunerInspector } from './inspector/TunerInspector'
import { SceneStatePicker } from './SceneStatePicker'
import { SceneSplitter } from './SceneSplitter'
import { TunerSteps, buttonModeOk } from './TunerSteps'
import { switchEditorScene, tunerLabel, tunerTargetLabel } from '../../lib/tuner/open-tuner'
import { PopupSurface } from './inspector/popups/PopupSurface'
import { ObjectPicker } from './inspector/popups/ObjectPicker'
import { createThrottle, handlePrefs, tunerMemory, type TunerObjectPath } from '../../lib/tuner/session-memory'
import { isPhoneView, onTunerMirror, sendTunerMirror } from '../../lib/tuner/view-mirror'
import { orbitFromLookAt, orbitPosition, orbitRotation, type Orbit } from '../../lib/tuner/orbit'
import { nextTransformSeq } from '../../lib/tuner/latency'
import { AskDriftButton, type AskDriftChip, type AskDriftResult, type AskDriftTo } from './AskDrift'
import { buildAgentLaunchCommand, getAgentEntry } from '@shared/agent-catalog'
import { setPendingCommand } from '../../lib/terminal/pending-commands'
import { askDriftPhone } from '../../lib/remote/phone-panel'

import { agentGuidePath, buildAskDriftMessage, buildChangeIndex, buildChangesMessage, countChanges, findPropertyChange, hasTransform, mergeUnsaved } from '../../lib/tuner/prompt'
import {
  DEFAULT_TUNER_LAYOUT,
  HIERARCHY_MIN,
  INSPECTOR_MIN,
  SIDEBAR_MIN,
  SIDEBAR_MIN_H,
  VIEWPORT_MIN_H,
  VIEWPORT_MIN_W,
  clampPx,
  clampRatio,
  loadTunerLayout,
  loadTunerViewPrefs,
  saveTunerLayout,
  saveTunerViewPrefs,
  sceneEffectsOf,
  type TunerLayout,
  type TunerViewPrefs
} from '../../lib/tuner/layout'
import { movedBounds } from '../../lib/tuner/space'
import {
  createLiveStore,
  mergeLiveObject,
  posesChangeStructure,
  shareObject
} from '../../lib/tuner/live'
import { NO_MEMBERS, indexMembers, isMemberId, memberObject } from '../../lib/tuner/members'
import type { HandleMode, HandlePivot, HandleSpace } from '../../lib/tuner/handles'
import { NO_SELECTION, hierarchySelection, sameSelection, selectionOf, withActive, type TunerSelection } from '../../lib/tuner/selection'
import { remapAddedObject } from '../../lib/tuner/ghosts'
import type { TunerInspectOpen, TunerInspectTarget } from '@shared/tuner-inspector'
import { blockTab } from '../../lib/tuner/no-tab'
import { assetFileName, assetTunerView, assetTunerViewName, unityAssetLayout, unityAssetViewKind } from '@shared/unity-assets'
import { ExplorerIcon, isUnityYamlAsset } from '../workbench/explorer-icons'
import { openFileInApp, openFileInWorkbench } from '../../lib/editor/open-file'
import { EDITOR_REVEALED_ERROR, isEditorRevealedError, isHeadlessGraphicsError, tunerReadiness, type TunerPhase } from '@shared/tuner-ready'
import { useEditorRevealed } from '../../lib/unity/editor-revealed'
import { UnityHubCard, useHubState } from '../workbench/UnityHubGate'
import { noteRender } from '../../lib/tuner/perf'
import { BoundedMap } from '@shared/bounded-map'
import { censusTrack } from '@shared/census'
import { debugLog } from '@shared/debug-log'
import { UnityStateCard, isUnityDown } from '../workbench/UnityStateCard'
import { useUnityLifecycle } from '../../lib/unity/lifecycle-store'
import { stateTitle } from '@shared/unity/lifecycle'

const askOpeners = new Map<string, string>()
function unsavedPaths(u: TunerUnsaved): string[] {
  return [...u.scenes, ...u.prefabs, ...u.assets.map((a) => a.path)]
}

const COPIED_CHANGES = 'Copied. Paste it to the agent.'
const clearedFilters = new Map<string, { tuner: TunerTarget; label: string; by: string }>()

type Phase = TunerPhase

interface PoseOverride {
  position?: Vec3
  rotation?: Quat
  releasedAt: number | null
}

const WIDE_MIN = 760
const PHONE_COLS = { left: 210, right: 280 }
const PHONE_ROWS = { top: 170, bottom: 250 }
const PHONE_ANIM_MIN = 380
const PHONE_SNAP = { hierShut: 56, hierOpen: 104, hierMin: 80, inspShut: 64, inspOpen: 120, inspMin: 100 }
const AWAIT_FRAME_MS = 4000

type PhonePane = 'hierarchy' | 'inspector'

export interface PhoneTunerControl {
  fold: (pane: PhonePane, open: boolean, why: string) => void
  pick: (name: string, within?: string) => boolean
}

export const phoneTunerControls = new Map<string, PhoneTunerControl>()

function snapHeight(el: Element | null | undefined, from: number | undefined): void {
  if (!(el instanceof HTMLElement) || from == null || typeof el.animate !== 'function') return
  const to = parseFloat(getComputedStyle(el).height)
  if (!(Math.abs(to - from) > 1)) return
  el.animate([{ height: `${from}px`, overflow: 'hidden' }, { height: `${to}px`, overflow: 'hidden' }], { duration: 220, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' })
}
const STUCK_NOTE_MS = 15000

const NO_OBJECTS: TunerObject[] = []

const lastPlanar = new BoundedMap<string, boolean>(32)
censusTrack('PaneTunerSlot.lastPlanar', lastPlanar)

function keyLetter(e: { key: string; code: string }): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase()
  if (e.code.startsWith('Key')) return e.code.slice(3).toLowerCase()
  if (e.code === 'BracketLeft') return '['
  if (e.code === 'BracketRight') return ']'
  return e.key.toLowerCase()
}

function withPose(o: TunerObject, ov: PoseOverride | undefined): TunerObject {
  if (!ov) return o
  const position = ov.position ?? o.position
  const rotation = ov.rotation ?? o.rotation
  return {
    ...o,
    position,
    rotation,
    bounds: o.bounds ? movedBounds(o.bounds, o.position, o.rotation, position, rotation) : null
  }
}

function sameBounds(a: TunerBounds | null | undefined, b: TunerBounds | null | undefined): boolean {
  if (!a || !b) return a === b
  return a.center.every((v, i) => v === b.center[i]) && a.size.every((v, i) => v === b.size[i])
}

function prefabRootMember(members: readonly TunerMember[]): TunerMember | undefined {
  const env = new Set(members.filter((m) => m.env).map((m) => m.id))
  return members
    .filter((m) => !m.env && (m.parent.startsWith(TUNER_SCENE_PARENT) || env.has(m.parent)))
    .sort((a, b) => a.index - b.index)[0]
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

function memberPath(m: TunerMember, byId: Map<string, TunerMember>): TunerObjectPath | null {
  const names: string[] = [m.name]
  let parent = m.parent
  for (let guard = 0; guard < 256; guard++) {
    if (parent.startsWith(TUNER_SCENE_PARENT)) return { scene: parent.slice(TUNER_SCENE_PARENT.length), path: names.join('/') }
    const p = byId.get(parent)
    if (!p) return null
    names.unshift(p.name)
    parent = p.parent
  }
  return null
}

function selectionPathOf(id: string, objects: TunerObject[], members: TunerMember[]): TunerObjectPath | null {
  const o = objects.find((x) => x.id === id)
  if (o) return o.path ? { scene: o.scene, path: o.path } : null
  const m = members.find((x) => x.id === id)
  return m ? memberPath(m, new Map(members.map((x) => [x.id, x]))) : null
}

function idAtPath(want: TunerObjectPath, objects: TunerObject[], members: TunerMember[]): string | null {
  const o = objects.find((x) => !x.error && x.path === want.path && x.scene === want.scene)
  if (o) return o.id
  const byId = new Map(members.map((x) => [x.id, x]))
  for (const m of members) {
    if (m.name !== want.path.slice(want.path.lastIndexOf('/') + 1)) continue
    const p = memberPath(m, byId)
    if (p && p.path === want.path && p.scene === want.scene) return m.id
  }
  return null
}

function memorySelection(m: { selected: string | null; selection: string[] }): TunerSelection {
  if (!m.selected) return NO_SELECTION
  return m.selection.length > 1 && m.selection.includes(m.selected) ? { ids: [...m.selection], active: m.selected } : selectionOf(m.selected)
}

function subscribePageVisibility(cb: () => void): () => void {
  document.addEventListener('visibilitychange', cb)
  return () => document.removeEventListener('visibilitychange', cb)
}

function pageVisible(): boolean {
  return document.visibilityState === 'visible'
}

function endedText(reason: string): string {
  if (reason === 'revealed') return EDITOR_REVEALED_ERROR
  if (/play/i.test(reason)) return 'Play Mode stopped'
  if (/reload|domain|compil/i.test(reason)) return 'Unity is reloading scripts'
  if (/stop/i.test(reason)) return 'The session was stopped'
  return reason || 'The session ended'
}

const LOST_UNITY = 'Lost the connection to the Unity editor. Reconnecting…'

function tunerPendingLabel(reason: string, unity: string): string {
  if (unity) return unity
  if (reason === 'the scene is saving') return 'Saving the scene…'
  if (reason === 'the scene is reloading') return 'Reloading the scene…'
  if (reason === 'waiting for the reloaded frame' || /first frame/.test(reason)) return 'Waiting for the first frame…'
  if (/compil|reload/i.test(reason)) return 'Unity is reloading scripts…'
  return 'Connecting to the scene…'
}

type TunerPanelState = 'connecting' | 'busy' | 'refreshing' | 'live' | 'revealed' | 'headless-graphics' | 'no-unity' | 'unity-down' | 'hub' | 'scratchpad' | 'missing-view' | 'scene-not-open' | 'no-frames'

export function PaneTunerSlot({
  tabId,
  ptyId,
  projectPath,
  scratchpad = null,
  targetChip = null,
  targetChoices = null,
  staging: stagingAllowed = true
}: {
  tabId: string
  ptyId: string
  projectPath: string
  scratchpad?: ScratchpadInfo | null
  targetChip?: ReactNode
  targetChoices?: ReactNode
  staging?: boolean
}) {
  noteRender('PaneTunerSlot')
  const tab = useAppStore((s) => {
    for (const tabs of Object.values(s.tabsByWorkspace)) {
      const t = tabs.find((x) => x.id === tabId)
      if (t) return t
    }
    return null
  })
  const workspaceVisible = useAppStore((s) => {
    const ws = s.activeWorkspaceId
    const mine = ws != null ? (s.tabsByWorkspace[ws] ?? []).find((t) => t.id === tabId) : undefined
    const full = ws != null ? s.fullscreenGroupIdByWorkspace[ws] : null
    return !!mine && (!full || full === mine.groupId)
  })
  const shown = useSyncExternalStore(subscribePageVisibility, pageVisible) && workspaceVisible
  const setTabTuner = useAppStore((s) => s.setTabTuner)
  const filter = tab?.tuner?.filter ?? ''
  const baseAsset = tab?.tuner?.kind === 'file' ? tab.tuner.id : null
  const assetPath = filter ? null : baseAsset
  const assetKind = assetPath ? unityAssetViewKind(assetPath) : null
  const assetLayout = assetKind ? unityAssetLayout(assetKind) : null
  const viewName = tunerTargetView(tab?.tuner) || null
  const assetView = useMemo(() => (assetPath ? assetTunerView(assetTunerViewName(assetPath)) : null), [assetPath])
  const assetPreview = !!tab?.preview
  const promoteTab = useAppStore((s) => s.promoteTab)
  const session = ptyId
  const editorRevealed = useEditorRevealed(projectPath)

  const [views, setViews] = useState<TunerView[]>([])
  const [viewsLoaded, setViewsLoaded] = useState(false)

  const loadViews = useCallback(() => {
    void window.api.tuner.listViews(projectPath).then((v) => {
      setViews(v)
      setViewsLoaded(true)
    })
  }, [projectPath])

  useEffect(() => {
    if (!projectPath) return
    loadViews()
    void window.api.tuner.watchViews(projectPath)
    const off = window.api.tuner.onViewsChanged((e) => {
      if (e.projectPath === projectPath) loadViews()
    })
    return () => {
      off()
      void window.api.tuner.unwatchViews(projectPath)
    }
  }, [projectPath, loadViews])

  const view =
    assetView ??
    (viewName ? (views.find((v) => v.name === viewName) ?? views.find((v) => v.name.toLowerCase() === viewName.toLowerCase()) ?? null) : null)
  const missRef = useRef<string | null>(null)
  useEffect(() => {
    if (!viewsLoaded || !viewName || view || missRef.current === viewName) return
    missRef.current = viewName
    loadViews()
  }, [viewsLoaded, viewName, view, loadViews])
  const prefabViewRef = useRef(false)
  prefabViewRef.current = view?.kind === 'prefabs'
  const sceneViewRef = useRef(false)
  sceneViewRef.current = view?.kind === 'scene' && !filter
  const memory = useMemo(() => tunerMemory(tabId, viewName ?? '', projectPath, !filter), [tabId, viewName, projectPath])

  const [restartKey, setRestartKey] = useState(0)
  const stampRef = useRef<{ name: string; stamp: number; sig: string } | null>(null)
  useEffect(() => {
    if (!view) return
    const stamp = Math.floor(view.updatedAt)
    const sig = JSON.stringify({ ...view, updatedAt: 0, animator: null })
    const prev = stampRef.current
    stampRef.current = { name: view.name, stamp, sig }
    if (!prev || prev.name !== view.name || prev.stamp === stamp) return
    if (prev.sig !== sig) {
      if (memory.restore) memory.restore = { ...memory.restore, opened: [] }
      memory.selected = null
      memory.selection = []
    }
    setRestartKey((k) => k + 1)
  }, [view, memory])

  const [objects, setObjects] = useState<TunerObject[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [framed, setFramed] = useState(false)
  const [frameTrouble, setFrameTrouble] = useState<string | null>(null)
  const [awaitFrame, setAwaitFrame] = useState(false)
  const everLiveRef = useRef(false)
  const presence = useUnityPresence(projectPath)
  const unityBusy = useUnityBusyLabel(projectPath)
  const targetProgress = useEditorProgress(projectPath)
  const reload = useTunerReload(projectPath)
  const unitySaving = useUnitySaving(projectPath)
  useEffect(() => {
    if (projectPath) ensureProject(projectPath)
  }, [projectPath])
  const [startSeq, setStartSeq] = useState(0)
  const framedRef = useRef(false)
  const acceptFramesRef = useRef(false)
  const [playing, setPlaying] = useState(true)
  const [graphics, setGraphics] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelectionState] = useState<TunerSelection>(() => memorySelection(memory))
  const selected = selection.active
  const [mode, setModeState] = useState<HandleMode>(handlePrefs.mode)
  const [space, setSpaceState] = useState<HandleSpace>(handlePrefs.space)
  const [pivot, setPivotState] = useState<HandlePivot>(handlePrefs.pivot)
  const [watchedMany, setWatchedMany] = useState<TunerObject[]>(NO_OBJECTS)
  const [ping, setPing] = useState<HierarchyPing | null>(null)
  const pingSeqRef = useRef(0)
  const remapRef = useRef<{ ghost: string; index: number } | null>(null)
  const filterRef = useRef(filter)
  filterRef.current = filter
  const filterSeenRef = useRef(false)
  const clearFilterRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    filterSeenRef.current = false
  }, [viewName])
  const [overrides, setOverrides] = useState<Record<string, PoseOverride>>({})
  const [states, setStates] = useState<TunerStateInfo[]>([])
  const [activeState, setActiveState] = useState('')
  const activeRef = useRef('')
  const [changesList, setChangesList] = useState<TunerOverride[]>([])
  const [editsList, setEditsList] = useState<TunerEdit[]>([])
  const [unsaved, setUnsaved] = useState<TunerUnsaved>(NO_UNSAVED)
  const [entries, setEntries] = useState<TunerObject[]>([])
  const [members, setMembers] = useState<TunerMember[]>(NO_MEMBERS)
  const membersRef = useRef<TunerMember[]>(NO_MEMBERS)
  const [watched, setWatched] = useState<TunerObject | null>(null)
  const [particles, setParticles] = useState<TunerParticles | null>(null)
  const [animator, setAnimator] = useState<TunerAnimator | null>(null)
  const animRef = useRef<TunerAnimator | null>(null)
  const resyncAtRef = useRef(0)
  const [animOpen, setAnimOpenState] = useState<boolean | null>(memory.animOpen ?? null)
  const [staging, setStaging] = useState<TunerStaging | null>(null)
  const [stagingTrails, setStagingTrails] = useState<StagingTrail[] | null>(null)
  const [stagingOpen, setStagingOpenState] = useState<boolean>(memory.stagingOpen ?? false)
  const [sceneBounds, setSceneBounds] = useState<TunerBounds | null | undefined>(undefined)
  const [sceneNoRenderers, setSceneNoRenderers] = useState(false)
  const [membersCapped, setMembersCapped] = useState(0)
  const [filterCount, setFilterCount] = useState<[number, number] | null>(null)
  const [membersLazy, setMembersLazy] = useState(false)
  const [revealMissing, setRevealMissing] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [runningButton, setRunningButton] = useState<number | null>(null)
  const [stepsDone, setStepsDone] = useState(0)
  useEffect(() => setStepsDone(0), [playing, viewName])
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [paused, setPaused] = useState(false)
  const [autoPlanar, setAutoPlanar] = useState(() => lastPlanar.get(projectPath) ?? false)
  const [modePick, setModePick] = useState<TunerMode | null>(memory.mode)
  const [pendingState, setPendingState] = useState<string | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)
  const resetRef = useRef<HTMLDivElement>(null)
  const resetMenuRef = useRef<HTMLDivElement>(null)
  useFloating(resetRef.current, resetMenuRef, { placement: 'top-end', gap: 4 }, resetOpen)
  const closeReset = useCallback(() => {
    setResetOpen(false)
    setConfirmAll(false)
  }, [])
  useDismiss(resetRef, closeReset, resetOpen)
  const [askOpen, setAskOpen] = useState(false)
  const [layout, setLayoutState] = useState<TunerLayout>(() => loadTunerLayout(tabId))
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const setLayout = useCallback((patch: Partial<TunerLayout>) => {
    setLayoutState((l) => ({ ...l, ...patch }))
  }, [])
  const persistLayout = useCallback(() => saveTunerLayout(tabId, layoutRef.current), [tabId])
  const [sideH, setSideH] = useState(0)
  const [treeFit, setTreeFit] = useState(0)
  const [searchIds, setSearchIds] = useState<string[] | null>(null)
  const [treeManual, setTreeManual] = useState<string | null>(null)
  const [stackH, setStackH] = useState(0)
  const sideRo = useRef<ResizeObserver | null>(null)
  const stackRo = useRef<ResizeObserver | null>(null)
  const sideRef = useCallback((el: HTMLDivElement | null) => {
    sideRo.current?.disconnect()
    sideRo.current = null
    if (!el) return
    const ro = new ResizeObserver(() => setSideH(el.clientHeight))
    ro.observe(el)
    sideRo.current = ro
    setSideH(el.clientHeight)
  }, [])
  const stackRef = useCallback((el: HTMLDivElement | null) => {
    stackRo.current?.disconnect()
    stackRo.current = null
    if (!el) return
    const ro = new ResizeObserver(() => setStackH(el.clientHeight))
    ro.observe(el)
    stackRo.current = ro
    setStackH(el.clientHeight)
  }, [])
  const [viewPrefs, setViewPrefsState] = useState<TunerViewPrefs>(() => loadTunerViewPrefs(tabId))
  const annotations = useTunerAnnotations(projectPath, session, phase === 'live')
  const iconStyle = useMemo(
    () => (annotations.state ? { use3d: annotations.state.use3dIcons, texelWorldSize: annotations.state.iconSize } : undefined),
    [annotations.state?.use3dIcons, annotations.state?.iconSize]
  )
  const setViewPrefs = useCallback(
    (patch: Partial<TunerViewPrefs>) => {
      setViewPrefsState((p) => {
        const next = { ...p, ...patch }
        saveTunerViewPrefs(tabId, next)
        return next
      })
    },
    [tabId]
  )
  const [frameSignal, setFrameSignal] = useState(0)
  const [overlays, setOverlays] = useState<TunerOverlayCanvas[]>([])
  const [frameBox, setFrameBox] = useState<{ bounds: TunerBounds; seq: number } | null>(null)
  const liveStore = useMemo(() => createLiveStore(), [])
  const objectsRef = useRef<TunerObject[]>([])
  const [busy, setBusy] = useState(0)
  const [copied, setCopiedState] = useState<string | null>(null)
  const copiedRef = useRef<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setCopied = useCallback((v: string | null) => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = v ? setTimeout(() => setCopied(null), 8000) : null
    if (copiedRef.current === v) return
    copiedRef.current = v
    setCopiedState(v)
  }, [])
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
  }, [])
  useEffect(() => setCopied(null), [playing, setCopied])
  const [noteOpen, setNoteOpen] = useState(false)
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  const specRef = useRef<() => void>(() => undefined)
  const specPendingRef = useRef(false)
  const specStaleRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const wide = width >= WIDE_MIN
  const phone = isPhoneView()
  const [phoneHier, setPhoneHier] = useState(true)
  const [phoneInsp, setPhoneInsp] = useState(true)
  const phoneOpen = useRef({ hierarchy: true, inspector: true })
  const snapFrom = useRef<{ hierarchy?: number; inspector?: number }>({})
  const foldPhone = useCallback((pane: PhonePane, open: boolean, why: string) => {
    if (phoneOpen.current[pane] === open) return
    const root = rootRef.current
    const sel = pane === 'inspector' ? '[data-tuner-phone-bottom]' : open ? '[data-tuner-hierarchy-crumb]' : '[data-tuner-hierarchy-pane]'
    const el = root?.querySelector(sel)
    snapFrom.current[pane] = el ? parseFloat(getComputedStyle(el).height) : undefined
    phoneOpen.current[pane] = open
    if (pane === 'hierarchy') setPhoneHier(open)
    else setPhoneInsp(open)
    console.info(`[tuner] phone ${pane} snaps ${open ? 'open' : 'folded'}: ${why}`)
  }, [])
  useLayoutEffect(() => {
    snapHeight(rootRef.current?.querySelector(phoneHier ? '[data-tuner-hierarchy-pane]' : '[data-tuner-hierarchy-crumb]'), snapFrom.current.hierarchy)
    snapFrom.current.hierarchy = undefined
  }, [phoneHier])
  useLayoutEffect(() => {
    snapHeight(rootRef.current?.querySelector('[data-tuner-phone-bottom]'), snapFrom.current.inspector)
    snapFrom.current.inspector = undefined
  }, [phoneInsp])
  const [phoneCols, setPhoneCols] = useState(PHONE_COLS)
  const [phoneRows, setPhoneRows] = useState(PHONE_ROWS)

  const setSelection = useCallback(
    (sel: TunerSelection) => {
      if (sel.active !== memory.selected) memory.selectedPath = sel.active ? selectionPathOf(sel.active, objectsRef.current, membersRef.current) : null
      memory.selected = sel.active
      memory.selection = sel.ids
      setSelectionState((prev) => (sameSelection(prev, sel) ? prev : sel))
    },
    [memory]
  )
  const madeRef = useRef<{ ids: string[]; prev: TunerSelection } | null>(null)
  const setSelected = useCallback((id: string | null) => setSelection(selectionOf(id)), [setSelection])
  useEffect(() => {
    if (!phone) return
    const pick = (name: string, within?: string): boolean => {
      const objects = objectsRef.current
      const members = membersRef.current
      for (const id of [...objects.map((o) => o.id), ...members.map((m) => m.id)]) {
        const p = selectionPathOf(id, objects, members)
        if (!p) continue
        const full = `${p.scene}/${p.path}`
        if ((p.path === name || p.path.endsWith(`/${name}`)) && (!within || full.includes(within))) {
          setSelected(id)
          console.info(`[tuner] phone pick ${full} without the hierarchy`)
          return true
        }
      }
      return false
    }
    const control: PhoneTunerControl = { fold: foldPhone, pick }
    phoneTunerControls.set(tabId, control)
    return () => {
      if (phoneTunerControls.get(tabId) === control) phoneTunerControls.delete(tabId)
    }
  }, [phone, tabId, foldPhone, setSelected])
  const entriesRef = useRef<TunerObject[]>([])
  entriesRef.current = entries
  const setMode = (m: HandleMode): void => {
    handlePrefs.mode = m
    setModeState(m)
  }
  const setSpace = (s: HandleSpace): void => {
    handlePrefs.space = s
    setSpaceState(s)
  }
  const setPivot = (p: HandlePivot): void => {
    handlePrefs.pivot = p
    setPivotState(p)
  }

  useEffect(() => {
    setSelectionState(memorySelection(memory))
    setModePick(memory.mode)
    objectsRef.current = []
    liveStore.clear()
    setObjects([])
    setOverrides({})
    setStates([])
    setActiveState('')
    activeRef.current = ''
    setChangesList([])
    setEditsList([])
    setUnsaved(NO_UNSAVED)
    setEntries([])
    membersRef.current = NO_MEMBERS
    setMembers(NO_MEMBERS)
    setMembersLazy(false)
    setFilterCount(null)
    setWatched(null)
    setWatchedMany(NO_OBJECTS)
    setPing(null)
    setParticles(null)
    animRef.current = null
    setAnimator(null)
    setSceneBounds(undefined)
    setSceneNoRenderers(false)
    setOverlays([])
    setCopied(null)
  }, [memory])

  useEffect(() => installTunerTips(), [])

  useEffect(() => {
    setLayoutState(loadTunerLayout(tabId))
    setViewPrefsState(loadTunerViewPrefs(tabId))
  }, [tabId])

  const applyState = useCallback(
    (st: TunerState) => {
      setPlaying(st.playing)
      setGraphics(st.graphics)
      if (st.offline) {
        setPhase('waiting')
        setError(LOST_UNITY)
      } else {
        setPhase('live')
        setError((e) => (e === LOST_UNITY ? null : e))
      }
      if (Array.isArray(st.entries)) setEntries(st.entries)
      const prevMembers = membersRef.current
      if (Array.isArray(st.members)) {
        membersRef.current = st.members
        setMembers(st.members)
        setMembersLazy(!!st.membersLazy)
        setRevealMissing(typeof st.revealMissing === 'string' ? st.revealMissing : undefined)
      }
      if (typeof st.membersCapped === 'number') setMembersCapped(st.membersCapped)
      if (Array.isArray(st.filterCount)) {
        const fc = st.filterCount
        setFilterCount((prev) => (prev && prev[0] === fc[0] && prev[1] === fc[1] ? prev : fc))
        if (filterRef.current && !st.offline && fc[1] > 0) {
          if (fc[0] > 0) filterSeenRef.current = true
          else if (filterSeenRef.current) {
            filterSeenRef.current = false
            clearFilterRef.current()
          }
        }
      }
      liveStore.clear()
      objectsRef.current = st.objects
      setObjects(st.objects)
      if (filterRef.current && !st.offline && st.objects.length > 0) {
        if (st.objects.some((o) => !o.error)) filterSeenRef.current = true
        else if (filterSeenRef.current) {
          filterSeenRef.current = false
          clearFilterRef.current()
        }
      }
      setPaused(st.paused === true)
      if (typeof st.planar === 'boolean') {
        lastPlanar.set(projectPath, st.planar)
        setAutoPlanar(st.planar)
      }
      if (Array.isArray(st.overlays)) {
        const next = st.overlays
        setOverlays((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      }
      if (st.sceneBounds !== undefined) {
        setSceneBounds((prev) => (sameBounds(prev, st.sceneBounds) ? prev : st.sceneBounds))
        setSceneNoRenderers(!!st.sceneNoRenderers)
      }
      if (Array.isArray(st.states)) setStates(st.states)
      if (typeof st.activeState === 'string') {
        if (activeRef.current !== st.activeState) {
          activeRef.current = st.activeState
          setOverrides({})
        }
        setActiveState(st.activeState)
      }
      if (st.unsaved) {
        const next = st.unsaved
        setUnsaved((prev) => (unsavedKey(prev) === unsavedKey(next) ? prev : next))
      }
      if (Array.isArray(st.edits)) setEditsList(st.edits)
      if (Array.isArray(st.overrides)) {
        setChangesList(st.overrides)
        const restore = { activeState: st.activeState, overrides: st.overrides, opened: openedTargets(st) }
        const pend = remapRef.current
        memory.restore = pend ? remapAddedObject(restore, [], null, pend.ghost, pend.index).restore : restore
      }
      const now = Date.now()
      setOverrides((prev) => {
        let changed = false
        const next: Record<string, PoseOverride> = {}
        for (const [id, o] of Object.entries(prev)) {
          if (o.releasedAt != null && now - o.releasedAt > 150) changed = true
          else next[id] = o
        }
        return changed ? next : prev
      })
      const lazyKnown = !!st.watchGone
      const known = (id: string): boolean =>
        st.objects.some((o) => o.id === id) ||
        !!st.entries?.some((o) => o.id === id) ||
        membersRef.current.some((m) => m.id === id) ||
        (lazyKnown && isMemberId(id) && !st.watchGone!.includes(id))
      const moved = (id: string): string | null => {
        const uid = prevMembers.find((m) => m.id === id)?.uid
        const next = uid ? membersRef.current.find((m) => m.uid === uid)?.id : undefined
        return next && next !== id && known(next) ? next : null
      }
      if (memory.selection.length > 1 && !memory.selection.every(known)) {
        const keep = memory.selection.map((id) => (known(id) ? id : moved(id))).filter((id): id is string => !!id)
        if (keep.length > 0) setSelection(withActive(keep, memory.selected && !known(memory.selected) ? moved(memory.selected) : memory.selected))
      }
      const undone = madeRef.current
      const carried =
        memory.selected && !known(memory.selected)
          ? moved(memory.selected) ?? (memory.selectedPath ? idAtPath(memory.selectedPath, st.objects, membersRef.current) : null)
          : null
      if (undone && memory.selected && !known(memory.selected) && undone.ids.includes(memory.selected) && undone.prev.ids.every(known)) {
        madeRef.current = null
        setSelection(undone.prev)
      } else if (carried) setSelected(carried)
      else if (!memory.selected || !known(memory.selected)) {
        const first = st.objects.find((o) => !o.error && hasTransform(o)) ?? st.objects.find((o) => !o.error)
        const root = prefabViewRef.current
          ? prefabRootMember(membersRef.current)
          : undefined
        if (root) setSelected(root.id)
        else if (sceneViewRef.current) {
          if (memory.selected) setSelected(null)
        } else if (first && !prefabViewRef.current) setSelected(first.id)
        else if (!prefabViewRef.current && (memory.selected || !memory.specShown)) {
          specStaleRef.current = true
          specRef.current()
        }
      }
    },
    [memory, setSelected, setSelection, liveStore]
  )

  useEffect(() => {
    if (!projectPath || !viewName) {
      setPhase('idle')
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const unframe = (): void => {
      acceptFramesRef.current = false
      framedRef.current = false
      setFramed(false)
    }
    unframe()
    if (editorRevealed !== false) {
      if (editorRevealed) {
        setError(EDITOR_REVEALED_ERROR)
        setPhase('waiting')
      } else setPhase('idle')
      return
    }
    const schedule = (ms: number): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void start(), ms)
    }
    const start = async (): Promise<void> => {
      if (!alive) return
      remapRef.current = null
      setPhase((p) => (p === 'live' ? p : 'starting'))
      setFrameTrouble(null)
      const r = await window.api.tuner.start(projectPath, session, viewName, memory.restore ?? undefined)
      if (!alive) return
      if (r.ok) {
        setError(null)
        applyState(r.data)
        setPhase('live')
        setStartSeq((n) => n + 1)
        acceptFramesRef.current = true
        return
      }
      if (r.data) applyState(r.data)
      setError(r.error)
      setPhase('waiting')
      schedule(2500)
    }
    void start()
    const offFrame = window.api.tuner.onFrame((e) => {
      if (!acceptFramesRef.current || framedRef.current || e.projectPath !== projectPath || e.meta.session !== session) return
      framedRef.current = true
      setFramed(true)
    })
    const offState = window.api.tuner.onState((e) => {
      if (e.projectPath !== projectPath || e.state.session !== session || !acceptFramesRef.current) return
      applyState(e.state)
    })
    const offLive = window.api.tuner.onLive((e) => {
      if (e.projectPath !== projectPath || e.session !== session) return
      if (e.poses) {
        const poses = e.poses
        if (posesChangeStructure(objectsRef.current, poses)) {
          setObjects((prev) => {
            const next = prev.map((o) => {
              const p = poses.find((x) => x.id === o.id)
              return p && !o.error ? { ...o, active: p.active, bounds: p.bounds, position: p.position, rotation: p.rotation } : o
            })
            objectsRef.current = next
            return next
          })
        }
        liveStore.setPoses(poses)
      }
      if (e.object) {
        const obj = e.object
        if (objectsRef.current.some((o) => o.id === obj.id))
          setObjects((prev) => {
            const next = mergeLiveObject(prev, obj)
            objectsRef.current = next
            return next
          })
        else setWatched((prev) => shareObject(prev ?? undefined, obj))
      }
      if (e.objects) {
        const list = e.objects
        setWatchedMany((prev) => {
          const next = list.map((o) => shareObject(prev.find((p) => p.id === o.id), o))
          return next.length === prev.length && next.every((o, i) => o === prev[i]) ? prev : next
        })
      }
      if (e.shadow !== undefined) liveStore.setShadow(e.shadow)
      if (e.particles !== undefined) setParticles(e.particles)
      if (e.staging !== undefined) setStaging(e.staging)
      if (e.frameTrouble !== undefined) {
        debugLog(`[tuner] frames ${e.frameTrouble ? `can't be shown: ${e.frameTrouble}` : 'show again'} tab=${tabId}`)
        setFrameTrouble(e.frameTrouble)
      }
      if (e.animator !== undefined) {
        const next = e.animator
        if (!next) {
          animRef.current = null
          setAnimator(null)
        } else {
          const merged = mergeTunerAnimator(animRef.current, next)
          animRef.current = merged.anim
          setAnimator(merged.anim)
          const now = performance.now()
          if (merged.resync && now - resyncAtRef.current > 500) {
            resyncAtRef.current = now
            void window.api.tuner.animator(projectPath, session, { op: 'model' })
          }
        }
      }
    })
    const offEnded = window.api.tuner.onEnded((e) => {
      if (e.projectPath !== projectPath || e.session !== session) return
      unframe()
      setError(endedText(e.reason))
      setPhase('waiting')
      schedule(1500)
    })
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      offState()
      offLive()
      offFrame()
      offEnded()
    }
  }, [projectPath, session, viewName, restartKey, applyState, memory, liveStore, editorRevealed])

  useEffect(() => {
    if (!projectPath || !viewName) return
    return () => void window.api.tuner.stop(projectPath, session)
  }, [projectPath, session, !viewName])

  const selectionKey = selection.ids.join('\n')
  const mirrorSyncedRef = useRef(!phone)
  useEffect(() => {
    if (phase !== 'live' || !projectPath || !mirrorSyncedRef.current) return
    window.api.tuner.watch(projectPath, session, selected, selection.ids.length > 1 ? selection.ids : [])
  }, [phase, projectPath, session, selected, selectionKey])

  const mirroredSelRef = useRef<string | null>(null)
  const selectionNow = useRef(selection)
  selectionNow.current = selection
  useEffect(() => {
    if (phase !== 'live' || !projectPath) return
    const key = `${selected ?? ''}|${selectionKey}`
    if (mirroredSelRef.current === key) return
    mirroredSelRef.current = null
    if (!mirrorSyncedRef.current) {
      debugLog(`[tuner] selection ${selected ?? 'none'} kept local until the desktop selection arrives`)
      return
    }
    debugLog(`[tuner] selection ${selected ?? 'none'} sent to mirrors at ${Date.now()}`)
    sendTunerMirror({ projectPath, session, selection: { ids: selectionNow.current.ids, active: selected } })
  }, [phase, projectPath, session, selected, selectionKey])
  useEffect(() => {
    if (!projectPath) return
    return onTunerMirror(projectPath, session, (m) => {
      if (m.ask) {
        const cur = selectionNow.current
        sendTunerMirror({ projectPath, session, selection: { ids: cur.ids, active: cur.active } })
      }
      const sel = m.selection
      if (!sel || !Array.isArray(sel.ids)) return
      mirrorSyncedRef.current = true
      mirroredSelRef.current = `${sel.active ?? ''}|${sel.ids.join('\n')}`
      debugLog(`[tuner] mirrored selection ${sel.active ?? 'none'} (${sel.ids.length}) from ${m.from} at ${Date.now()}`)
      setSelection({ ids: sel.ids, active: sel.active ?? null })
    })
  }, [projectPath, session, setSelection])

  useEffect(() => {
    if (phase !== 'live' || !projectPath) return
    window.api.tuner.visibility(projectPath, session, shown)
  }, [phase, projectPath, session, shown])

  useEffect(() => {
    if (phase !== 'live' || !projectPath) return
    window.api.tuner.sceneSettings(projectPath, session, { gizmos: viewPrefs.gizmos, grid: viewPrefs.grid, effects: sceneEffectsOf(viewPrefs.effects), lighting: viewPrefs.lighting })
  }, [phase, projectPath, session, viewPrefs.gizmos, viewPrefs.grid, viewPrefs.effects, viewPrefs.lighting])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const merged = useMemo(() => objects.map((o) => withPose(o, overrides[o.id])), [objects, overrides])
  const liveEntry = watched && watched.id === selected && !watched.error ? watched : null
  const liveMerged = useMemo(() => (liveEntry ? withPose(liveEntry, overrides[liveEntry.id]) : null), [liveEntry, overrides])
  const extraSel = useMemo(() => {
    if (selection.ids.length < 2) return NO_OBJECTS
    const ids = new Set(selection.ids)
    const out = watchedMany.filter((o) => ids.has(o.id) && o.id !== selected && !o.error && !objects.some((t) => t.id === o.id))
    return out.length ? out.map((o) => withPose(o, overrides[o.id])) : NO_OBJECTS
  }, [watchedMany, selectionKey, selected, objects, overrides])
  const viewObjects = useMemo(() => {
    const base = liveMerged ? [...merged, liveMerged] : merged
    return extraSel.length ? [...base, ...extraSel] : base
  }, [merged, liveMerged, extraSel])
  const memberIndex = useMemo(() => indexMembers(members), [members])
  const titleScenes = useMemo(() => tunerScenesOf(objects, members).join('\n'), [objects, members])
  const titleVariants = useMemo(() => [...tunerVariantScenes(members)].join('\n'), [members])
  const titleStaging = useMemo(() => [...tunerStagingScenes(members)].join('\n'), [members])
  const tabTuner = tab?.tuner
  useEffect(() => {
    const t = tunerTitleFor(
      tabTuner,
      titleScenes ? titleScenes.split('\n') : [],
      new Set(titleVariants ? titleVariants.split('\n') : []),
      new Set(titleStaging ? titleStaging.split('\n') : [])
    )
    if (t || tabTuner?.kind === 'file') setTunerTabTitle(tabId, t)
  }, [tabId, tabTuner, titleScenes, titleVariants, titleStaging])
  const anchors = useMemo(() => new Map(objects.map((o) => [o.id, o])), [objects])

  const pinned = useMemo(() => new Set(Object.keys(overrides)), [overrides])
  const viewportObjects = viewObjects

  const overrideQueue = useRef<((prev: Record<string, PoseOverride>) => Record<string, PoseOverride>)[]>([])
  const overrideRaf = useRef(0)
  const flushOverrides = useCallback(() => {
    if (overrideRaf.current) cancelAnimationFrame(overrideRaf.current)
    overrideRaf.current = 0
    const fns = overrideQueue.current
    if (fns.length === 0) return
    overrideQueue.current = []
    setOverrides((prev) => fns.reduce((acc, fn) => fn(acc), prev))
  }, [])
  const queueOverrides = useCallback(
    (fn: (prev: Record<string, PoseOverride>) => Record<string, PoseOverride>, now: boolean) => {
      overrideQueue.current.push(fn)
      if (now) flushOverrides()
      else if (!overrideRaf.current) overrideRaf.current = requestAnimationFrame(flushOverrides)
    },
    [flushOverrides]
  )
  useEffect(
    () => () => {
      if (overrideRaf.current) cancelAnimationFrame(overrideRaf.current)
      overrideRaf.current = 0
      overrideQueue.current = []
    },
    []
  )

  const transformSend = useRef(
    createThrottle((pp: string, s: string, id: string, pose: PoseChange & { final?: boolean; seq?: number }) => {
      window.api.tuner.transform(pp, s, { id, ...pose })
    }, 0)
  ).current

  const onTransform = useCallback(
    (id: string, pose: PoseChange, final: boolean) => {
      setCopied(null)
      const releasedAt = final ? Date.now() : null
      queueOverrides(
        (prev) => ({
          ...prev,
          [id]: { ...prev[id], ...pose, releasedAt }
        }),
        final
      )
      const seq = nextTransformSeq(session, performance.now())
      if (!final) {
        transformSend.call(projectPath, session, id, { ...pose, seq })
        return
      }
      transformSend.flush(projectPath, session, id, { ...pose, seq, final: true })
      setTimeout(() => {
        setOverrides((prev) => {
          const o = prev[id]
          if (!o || o.releasedAt == null || Date.now() - o.releasedAt < 1400) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
      }, 1500)
    },
    [projectPath, session, queueOverrides]
  )

  const transformManySend = useRef(
    createThrottle((pp: string, s: string, items: ({ id: string } & PoseChange)[], final: boolean, seq: number) => {
      window.api.tuner.transform(pp, s, { id: items[0].id, items, seq, ...(final ? { final: true } : {}) })
    }, 0)
  ).current

  const onTransformMany = useCallback(
    (items: { id: string; pose: PoseChange }[], final: boolean) => {
      if (items.length === 0) return
      setCopied(null)
      const now = Date.now()
      queueOverrides((prev) => {
        const next = { ...prev }
        for (const it of items) next[it.id] = { ...prev[it.id], ...it.pose, releasedAt: final ? now : null }
        return next
      }, final)
      const wire = items.map((it) => ({ id: it.id, ...it.pose }))
      const seq = nextTransformSeq(session, performance.now())
      if (!final) {
        transformManySend.call(projectPath, session, wire, false, seq)
        return
      }
      transformManySend.flush(projectPath, session, wire, true, seq)
      const ids = items.map((it) => it.id)
      setTimeout(() => {
        setOverrides((prev) => {
          let changed = false
          const next = { ...prev }
          for (const id of ids) {
            const o = prev[id]
            if (!o || o.releasedAt == null || Date.now() - o.releasedAt < 1400) continue
            delete next[id]
            changed = true
          }
          return changed ? next : prev
        })
      }, 1500)
    },
    [projectPath, session, queueOverrides]
  )

  const runStateCommand = useCallback(
    (fn: () => Promise<{ ok: true; data: TunerState } | { ok: false; error: string }>, after?: () => void) => {
      setBusy((b) => b + 1)
      setCopied(null)
      chainRef.current = chainRef.current.then(async () => {
        const r = await fn()
        setBusy((b) => b - 1)
        after?.()
        if (r.ok) {
          setError(null)
          applyState(r.data)
        } else setError(r.error)
      })
    },
    [applyState]
  )

  const showNotice = useCallback((text: string, error = false) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setNotice({ text, error })
    noticeTimer.current = setTimeout(() => setNotice(null), error ? 8000 : 5000)
  }, [])
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
  }, [])

  const onViewportTransform = onTransform

  const onViewportSelect = setSelected
  const onViewportSelection = setSelection
  const onHierarchySelection = setSelection
  const onTree = useCallback((req: TunerTreeRequest) => window.api.tuner.tree(projectPath, session, req), [projectPath, session])

  const animError = useCallback((text: string) => showNotice(text, true), [showNotice])

  const openEntry = useCallback(
    (target: TunerEntryTarget) => {
      if (phase !== 'live' || !projectPath) return
      setBusy((b) => b + 1)
      chainRef.current = chainRef.current.then(async () => {
        const r = await window.api.tuner.open(projectPath, session, target)
        setBusy((b) => b - 1)
        if (r.ok) {
          applyState(r.data.state)
          setSelected(r.data.id)
        } else showNotice(r.error, true)
      })
    },
    [phase, projectPath, session, applyState, setSelected, showNotice]
  )

  specRef.current = () => {
    const spec = view?.animator
    if (!spec || specPendingRef.current || phase !== 'live' || !projectPath) return
    specPendingRef.current = true
    chainRef.current = chainRef.current.then(async () => {
      const r = await window.api.tuner.open(projectPath, session, { kind: 'object', path: spec.path })
      specPendingRef.current = false
      if (!r.ok) return
      memory.specShown = true
      specStaleRef.current = false
      applyState(r.data.state)
      setSelected(r.data.id)
    })
  }

  useEffect(() => {
    if (phase === 'live' && (specStaleRef.current || (!memory.selected && !memory.specShown))) specRef.current()
  }, [phase, memory, view])

  const contextOnly = useCallback(
    (path: string) => showNotice(`${path.split('/').pop() || path} is outside the filter, so it's only shown for context. Clear the filter to edit it.`),
    [showNotice]
  )

  const onPiercePick = useCallback(
    (pick: TunerPiercePick) => {
      if (pick.targetId) setSelected(pick.targetId)
      else if (filter) contextOnly(pick.path)
      else openEntry({ kind: 'object', path: pick.path, scene: pick.scene || undefined })
    },
    [openEntry, setSelected, filter, contextOnly]
  )

  const onOpenPath = useCallback(
    (path: string, scene: string) => (filter ? contextOnly(path) : openEntry({ kind: 'object', path, scene: scene || undefined })),
    [openEntry, filter, contextOnly]
  )

  const ghostTried = useRef(new Map<string, number>())

  const onAnimSelectObject = useCallback(
    (path: string) => {
      openEntry({ kind: 'object', path })
      pingSeqRef.current += 1
      setPing({ path, scene: '', seq: pingSeqRef.current })
    },
    [openEntry]
  )

  const noteViewerFocus = useAppStore((s) => s.noteViewerFocus)
  const requestExplorerReveal = useAppStore((s) => s.requestExplorerReveal)
  const tabWorktreeId = tab?.worktreeId ?? null
  const assetAbsPath = useCallback(
    (rel: string): string | null => (projectPath ? `${projectPath.replace(/\\/g, '/').replace(/\/+$/, '')}/${rel}` : null),
    [projectPath]
  )
  const revealAsset = useCallback(
    (rel: string): void => {
      const abs = assetAbsPath(rel)
      if (!abs || !tabWorktreeId) return
      noteViewerFocus(abs)
      requestExplorerReveal(tabWorktreeId, abs)
    },
    [assetAbsPath, tabWorktreeId, noteViewerFocus, requestExplorerReveal]
  )

  const openPrefab = useCallback(
    (rel: string): void => {
      const st = useAppStore.getState()
      const ws = Object.keys(st.tabsByWorkspace).find((w) => st.tabsByWorkspace[w]?.some((t) => t.id === tabId))
      const me = ws ? st.tabsByWorkspace[ws]?.find((t) => t.id === tabId) : undefined
      if (!ws || !me) return
      const pad = me.scratchpadId ?? null
      const same = (t: Tab): boolean => t.contentType === 'tuner' && t.tuner?.kind === 'file' && t.tuner.id === rel && t.worktreeId === me.worktreeId
      const open = st.tabsByWorkspace[ws]?.find((t) => same(t) && (t.scratchpadId ?? null) === pad) ?? st.tabsByWorkspace[ws]?.find(same)
      if (open && (open.scratchpadId ?? null) !== pad) {
        console.info(`[tuner] open prefab ${rel} on ${pad ?? 'project'} retargets ${open.label} (${open.id}) from ${open.scratchpadId ?? 'project'}`)
        st.setTabScratchpad(open.id, pad)
      }
      const target = open ?? st.createTab(ws, me.worktreeId, { groupId: me.groupId, contentType: 'tuner', label: assetFileName(rel), tuner: { kind: 'file', id: rel }, scratchpadId: pad })
      debugLog(`[tuner] open prefab ${rel}${pad ? ` in scratchpad ${pad}` : ''} ${open ? 'in its open tab' : 'in a new tab'}`)
      useAppStore.getState().activateTab(target.id)
      if (open) return
      const stop = useAppStore.subscribe((now, prev) => {
        const was = prev.tabsByWorkspace[ws]?.find((t) => t.id === target.id)
        if (!was || now.tabsByWorkspace[ws]?.some((t) => t.id === target.id)) return
        stop()
        const front = prev.groupsByWorkspace[ws]?.find((g) => g.id === was.groupId)?.activeTabId === target.id
        const back = now.tabsByWorkspace[ws]?.find((t) => t.id === me.id)
        if (!front || !back || back.groupId !== was.groupId) return
        debugLog(`[tuner] closed prefab ${rel}, back to ${back.label}`)
        useAppStore.getState().activateTab(back.id)
      })
    },
    [tabId]
  )
  const openScript = useCallback(
    (rel: string, file: string): void => {
      const abs = file || assetAbsPath(rel)
      if (!abs) return
      const st = useAppStore.getState()
      const ws = Object.keys(st.tabsByWorkspace).find((w) => st.tabsByWorkspace[w]?.some((t) => t.id === tabId))
      const opened = openFileInWorkbench({ file: abs, ...(ws && tabWorktreeId ? { workspaceId: ws, worktreeId: tabWorktreeId } : {}), text: true, line: 1, preview: false })
      debugLog(`[tuner] open script ${rel} as text ${abs}${opened ? '' : ' failed'}`)
    },
    [assetAbsPath, tabId, tabWorktreeId]
  )
  const onInspectorOpen = useCallback(
    (t: TunerInspectOpen): void => (t.kind === 'prefab' ? openPrefab(t.path) : t.kind === 'script' ? openScript(t.path, t.file) : openEntry(t)),
    [openPrefab, openScript, openEntry]
  )

  const onPing = useCallback((t: TunerInspectTarget) => {
    if (t.kind === 'asset') {
      revealAsset(t.path)
      return
    }
    pingSeqRef.current += 1
    setPing({ path: t.path, scene: t.scene ?? '', seq: pingSeqRef.current })
  }, [revealAsset])

  const openGhost = useCallback(
    (path: string, scene: string) => {
      if (phase !== 'live' || !projectPath) return
      const key = `${scene}\n${path}`
      const now = Date.now()
      if (now - (ghostTried.current.get(key) ?? 0) < 3000) return
      ghostTried.current.set(key, now)
      setBusy((b) => b + 1)
      chainRef.current = chainRef.current.then(async () => {
        const r = await window.api.tuner.open(projectPath, session, { kind: 'object', path, scene: scene || undefined }, true)
        setBusy((b) => b - 1)
        if (!r.ok) {
          showNotice(r.error, true)
          return
        }
        applyState(r.data.state)
        if (!r.data.created) return
        pingSeqRef.current += 1
        setPing({ path, scene, seq: pingSeqRef.current })
      })
    },
    [phase, projectPath, session, applyState, showNotice]
  )

  const dismissGhost = useCallback(
    (id: string) => {
      if (phase !== 'live' || !projectPath) return
      runStateCommand(() => window.api.tuner.close(projectPath, session, id))
    },
    [phase, projectPath, session, runStateCommand]
  )

  const ghostAddBlocked = assetPath
    ? "An asset Tuner shows one file, so it can't take scene objects"
    : view?.kind === 'ui'
      ? "A UI Tuner shows one canvas subtree and can't take other objects"
      : view?.kind === 'scene'
        ? 'A scene Tuner already shows every object in its scene'
        : view?.kind === 'prefabs'
          ? "A prefab Tuner edits prefab assets, so it can't take scene objects"
          : null

  const addGhost = useCallback(
    (id: string) => {
      const g = entries.find((e) => e.id === id && e.ghost)
      if (!g || !viewName || !view || ghostAddBlocked || !projectPath) return
      setBusy((b) => b + 1)
      chainRef.current = chainRef.current.then(async () => {
        const r = await window.api.tuner.addObject(projectPath, viewName, g.scene ? { path: g.path, scene: g.scene } : { path: g.path })
        setBusy((b) => b - 1)
        if (!r.ok) {
          showNotice(r.error, true)
          return
        }
        const index = r.data
        const moved = remapAddedObject(memory.restore, memory.selection.length ? memory.selection : memory.selected ? [memory.selected] : [], memory.selected, id, index)
        memory.restore = moved.restore
        memory.selected = moved.active
        memory.selection = moved.ids
        setSelectionState(memorySelection(memory))
        remapRef.current = { ghost: id, index }
        showNotice(`Added ${g.path} to this Tuner`)
      })
    },
    [entries, viewName, view, ghostAddBlocked, projectPath, memory, showNotice]
  )

  const [assetPick, setAssetPick] = useState<{ parent: string; scene: string; x: number; y: number } | null>(null)
  const hierarchyOp = useCallback(
    (req: TunerHierarchyRequest) => {
      if (phase !== 'live' || !projectPath) return
      setBusy((b) => b + 1)
      setCopied(null)
      chainRef.current = chainRef.current.then(async () => {
        const r = await window.api.tuner.hierarchy(projectPath, session, req)
        setBusy((b) => b - 1)
        const data = r.data
        if (req.op === 'delete') setSelection(NO_SELECTION)
        if (data?.state) applyState(data.state)
        if (data && data.ids.length > 0 && req.op !== 'delete') {
          madeRef.current = req.op === 'duplicate' || req.op === 'create' ? { ids: data.ids, prev: memorySelection(memory) } : null
          setSelection(hierarchySelection(data.ids))
        }
        if (!r.ok) showNotice(r.error, true)
        if (!data?.add.length || !viewName || !view || ghostAddBlocked) return
        for (const a of data.add) {
          const added = await window.api.tuner.addObject(projectPath, viewName, a.scene ? { path: a.path, scene: a.scene } : { path: a.path })
          if (!added.ok) {
            showNotice(added.error, true)
            return
          }
          const moved = remapAddedObject(memory.restore, memory.selection.length ? memory.selection : memory.selected ? [memory.selected] : [], memory.selected, a.id, added.data)
          memory.restore = moved.restore
          memory.selected = moved.active
          memory.selection = moved.ids
          setSelectionState(memorySelection(memory))
          remapRef.current = { ghost: a.id, index: added.data }
        }
      })
    },
    [phase, projectPath, session, applyState, setSelection, showNotice, viewName, view, ghostAddBlocked, memory]
  )
  const viewportEdit = useCallback(
    (op: 'duplicate' | 'delete') => {
      const ids = (memory.selection.length ? memory.selection : memory.selected ? [memory.selected] : []).filter((id) => id.startsWith('m') || id.startsWith('o'))
      if (ids.length) hierarchyOp({ op, ids })
    },
    [memory, hierarchyOp]
  )

  const hierarchyUndo = useCallback(
    (redo: boolean) => {
      if (phase !== 'live' || !projectPath) return
      void window.api.tuner.rect(projectPath, session, { op: redo ? 'redo' : 'undo' })
    },
    [phase, projectPath, session]
  )

  const runButton = (index: number): void => {
    const b = view?.buttons[index]
    if (!b || runningButton != null) return
    setRunningButton(index)
    setCopied(null)
    void window.api.tuner.button(projectPath, session, index).then((r) => {
      setRunningButton(null)
      if (r.ok && b.step) {
        const k = (view?.buttons ?? []).filter((x) => x.step).indexOf(b)
        setStepsDone((d) => Math.max(d, k + 1))
      }
      if (r.ok) showNotice(r.data.output ? `${b.label}: ${r.data.output}` : `${b.label}: done`)
      else showNotice(`${b.label} failed: ${r.error}${r.data?.output ? ` (${r.data.output})` : ''}`, true)
    })
  }

  const selectState = useCallback(
    (name: string) => {
      if (phase !== 'live' || !playing || name === activeState || pendingState) return
      setPendingState(name)
      runStateCommand(
        () => window.api.tuner.select(projectPath, session, name),
        () => setPendingState(null)
      )
    },
    [phase, playing, activeState, pendingState, runStateCommand, projectPath, session]
  )

  const resetChanges = useCallback(
    (r: TunerReset) => runStateCommand(() => window.api.tuner.reset(projectPath, session, r)),
    [runStateCommand, projectPath, session]
  )

  useEffect(() => {
    if (phase !== 'live' || !projectPath) return
    setTunerUnsaved(tabId, { projectPath, session, unsaved, playing, asset: assetPath })
  }, [tabId, phase, projectPath, session, unsaved, playing, assetPath])
  useEffect(() => () => setTunerUnsaved(tabId, null), [tabId])
  const assetDirty =
    !!assetPath &&
    (unsaved.prefabs.includes(assetPath) || unsaved.scenes.includes(assetPath) || unsaved.assets.some((a) => a.path === assetPath))
  useEffect(() => {
    if (assetDirty && assetPreview) promoteTab(tabId)
  }, [assetDirty, assetPreview, promoteTab, tabId])

  const savingRef = useRef(false)
  const saveAll = useCallback(() => {
    if (phase !== 'live' || !projectPath || playing || savingRef.current) return
    savingRef.current = true
    setBusy((b) => b + 1)
    setCopied(null)
    void markTunerSaving(projectPath, window.api.tuner.save(projectPath, session)).then((r) => {
      savingRef.current = false
      setBusy((b) => b - 1)
      if (r.ok) {
        for (const p of unsavedPaths(unsaved)) touchedRef.current.saved.add(p)
        setUnsaved(r.data.unsaved)
        const n = r.data.summary && r.data.summary !== 'nothing to save' ? r.data.summary.split(', ').length : 0
        showNotice(n === 0 ? 'Nothing to save' : `Saved ${n} ${n === 1 ? 'file' : 'files'}`)
      } else {
        if (r.data) setUnsaved(r.data.unsaved)
        showNotice(`Save failed: ${r.error}`, true)
      }
    })
  }, [phase, projectPath, playing, session, unsaved, showNotice])

  const discardAll = useCallback(
    async (el: HTMLElement) => {
      if (phase !== 'live' || !projectPath || playing || savingRef.current) return
      const n = unsavedCount(unsaved)
      if (n === 0) return
      const ok = await requestConfirm({
        title: n === 1 ? 'Discard the unsaved change?' : `Discard ${n} unsaved changes?`,
        message: 'Everything goes back to the last save. You can’t undo this.',
        confirmLabel: 'Discard',
        danger: true,
        anchor: anchorFromElement(el)
      })
      if (!ok || savingRef.current) return
      savingRef.current = true
      setBusy((b) => b + 1)
      setCopied(null)
      const r = await markTunerReload(projectPath, window.api.tuner.discard(projectPath, session))
      savingRef.current = false
      setBusy((b) => b - 1)
      if (r.ok) {
        const t = touchedRef.current
        const keep = (p: string): boolean => t.saved.has(p) || !unsavedPaths(unsaved).includes(p)
        t.files = { scenes: t.files.scenes.filter(keep), prefabs: t.files.prefabs.filter(keep), assets: t.files.assets.filter((a) => keep(a.path)) }
        setUnsaved(r.data.unsaved)
        const k = r.data.summary && r.data.summary !== 'nothing to discard' ? r.data.summary.split(', ').length : 0
        showNotice(k === 0 ? 'Nothing to discard' : `Discarded ${k} ${k === 1 ? 'change' : 'changes'}`)
      } else {
        if (r.data) setUnsaved(r.data.unsaved)
        showNotice(`Discard failed: ${r.error}`, true)
      }
    },
    [phase, projectPath, playing, session, unsaved, showNotice]
  )

  const focusObject = useCallback(
    (id: string) => {
      setSelected(id)
      setFrameSignal((n) => n + 1)
    },
    [setSelected]
  )

  const opened = useMemo(() => entries.filter((e) => e.kind !== 'asset' && !e.ghost), [entries])
  const assets = useMemo(() => entries.filter((e) => e.kind === 'asset'), [entries])
  const ghostList = useMemo(() => entries.filter((e) => e.kind !== 'asset' && e.ghost), [entries])
  const ghostKey = ghostList.map((g) => `${g.id}\t${g.path}\t${g.scene}\t${g.active}\t${g.error ?? ''}`).join('\n')
  const ghosts = useMemo(() => ghostList, [ghostKey])
  const ghostIds = useMemo(() => ghosts.map((g) => g.id), [ghosts])
  const hierarchyKey = [...merged, ...opened]
    .map((o) => `${o.id}\t${o.kind ?? ''}\t${o.path}\t${o.scene}\t${o.label}\t${o.active}\t${o.error ?? ''}\t${o.ancestors.join('/')}`)
    .join('\n')
  const hierarchyObjects = useMemo(() => [...merged, ...opened], [hierarchyKey])
  const selectedPathsKey = selection.ids
    .map((id) => {
      const o = objects.find((x) => x.id === id) ?? opened.find((x) => x.id === id) ?? (watched?.id === id ? watched : undefined) ?? watchedMany.find((x) => x.id === id)
      if (o && !o.error && o.path) return o.path
      return memberObject(id, memberIndex, anchors)?.path ?? ''
    })
    .join('\n')
  const selectedPaths = useMemo(() => selectedPathsKey.split('\n').filter(Boolean), [selectedPathsKey])
  const assetKey = assets.map((a) => `${a.id}\t${a.path}\t${a.label}\t${a.type ?? ''}\t${a.opened ?? ''}\t${a.error ?? ''}`).join('\n')
  const hierarchyAssets = useMemo(() => assets, [assetKey])

  const multiState = states.length > 1
  const activeInfo = states.find((s) => s.name === activeState) ?? null
  const activeCount = countChanges(changesList, activeState)
  const totalCount = changesList.length
  const playLeft = playing ? 0 : changesList.filter((o) => o.state !== TUNER_EDIT_STATE).length
  const changeShape = changesList.map((o) => `${o.state}\u0001${o.id}\u0001${o.component}\u0001${o.field}`).join('\n')
  const changeIndex = useMemo(() => buildChangeIndex(changesList, playing ? [activeState] : []), [changeShape, activeState, playing])
  const statesWithChanges = states.filter((s) => s.changes > 0).length

  const cycleState = (d: number): void => {
    if (!multiState) return
    const i = Math.max(0, states.findIndex((s) => s.name === activeState))
    selectState(states[(i + d + states.length) % states.length].name)
  }

  const [askOpener, setAskOpenerState] = useState(() => askOpeners.get(tabId) ?? '')
  const setAskOpener = (ptyId: string): void => {
    askOpeners.set(tabId, ptyId)
    setAskOpenerState(ptyId)
  }
  const askWorkspaceId = useAppStore((s) => Object.keys(s.tabsByWorkspace).find((ws) => s.tabsByWorkspace[ws].some((t) => t.id === tabId)) ?? null)
  const filterPane = filter ? (view?.paneKey ?? '') : ''
  const opener = askOpener || filterPane
  const filterLabel = useAppStore((s) => {
    if (!filterPane) return ''
    for (const tabs of Object.values(s.tabsByWorkspace)) {
      const t = tabs.find((x) => x.ptyId === filterPane)
      if (t) return t.customLabel ?? t.label
    }
    return ''
  })
  const openerTab = useAppStore((s) => {
    if (!opener) return null
    for (const tabs of Object.values(s.tabsByWorkspace)) {
      const t = tabs.find((x) => x.ptyId === opener)
      if (t) return t
    }
    return null
  })
  const tunerTitle = view?.title || viewName || ''
  const touchedRef = useRef<{ key: string; files: TunerUnsaved; saved: Set<string> }>({ key: '', files: NO_UNSAVED, saved: new Set() })
  const touchedKey = session
  if (touchedRef.current.key !== touchedKey) touchedRef.current = { key: touchedKey, files: NO_UNSAVED, saved: new Set() }
  {
    const t = touchedRef.current
    const open = new Set(unsavedPaths(unsaved))
    const keep = (p: string): boolean => open.has(p) || t.saved.has(p)
    t.files = mergeUnsaved({ scenes: t.files.scenes.filter(keep), prefabs: t.files.prefabs.filter(keep), assets: t.files.assets.filter((a) => keep(a.path)) }, unsaved)
  }

  const changesText = (): string =>
    buildChangesMessage(restorable ? tunerTargetView(restorable.tuner) || tunerTitle : tunerTitle, states, changesList, { playing, unsaved, touched: touchedRef.current.files, where: scratchpadPromptScope(scratchpad), edits: editsList })
  const changesTextRef = useRef(changesText)
  changesTextRef.current = changesText
  useEffect(() => {
    const el = rootRef.current as (HTMLDivElement & { __tunerChanges?: () => string }) | null
    if (!el) return
    el.__tunerChanges = () => changesTextRef.current()
    return () => {
      delete el.__tunerChanges
    }
  }, [])

  const copyChanges = (): void => {
    if (!viewName) return
    const text = changesText()
    setNotice(null)
    void navigator.clipboard.writeText(text).then(
      () => setCopied(COPIED_CHANGES),
      () => setCopied('Could not reach the clipboard')
    )
  }

  const [cleared, setCleared] = useState(() => clearedFilters.get(tabId) ?? null)
  const clearFilter = (): void => {
    const t = tab?.tuner
    if (!t) return
    const saved = { tuner: t, label: tab.label, by: filterLabel || 'An agent' }
    clearedFilters.set(tabId, saved)
    setCleared(saved)
    setTabTuner(tabId, { kind: t.kind, id: t.id }, tunerTargetLabel({ kind: t.kind, id: t.id }))
  }
  clearFilterRef.current = clearFilter
  const forgetCleared = (): void => {
    clearedFilters.delete(tabId)
    setCleared(null)
  }
  const restorable = !filter && cleared && tab?.tuner?.kind === cleared.tuner.kind && tab.tuner.id === cleared.tuner.id && (!cleared.tuner.filter || views.some((v) => v.name === cleared.tuner.filter)) ? cleared : null
  useEffect(() => {
    if (!filter || !clearedFilters.has(tabId)) return
    clearedFilters.delete(tabId)
    setCleared(null)
  }, [filter, tabId])
  const restoreFilter = (): void => {
    if (!restorable) return
    forgetCleared()
    setTabTuner(tabId, restorable.tuner, restorable.label)
  }
  const filterViewSeenRef = useRef('')
  if (filter && view) filterViewSeenRef.current = filter
  const filterMissing = viewsLoaded && !!filter && !view
  const filterGone = filterMissing && filterViewSeenRef.current === filter
  useEffect(() => {
    const t = tab?.tuner
    if (!filterMissing || !t) return
    const drop = (): void => {
      clearedFilters.delete(tabId)
      setCleared(null)
      setTabTuner(tabId, { kind: t.kind, id: t.id }, tunerTargetLabel({ kind: t.kind, id: t.id }))
    }
    if (filterGone) {
      drop()
      return
    }
    const name = filter.toLowerCase()
    let alive = true
    const timer = setTimeout(() => {
      void window.api.tuner.listViews(projectPath).then((v) => {
        if (alive && !v.some((x) => x.name.toLowerCase() === name)) drop()
      })
    }, 3000)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [filterMissing, filterGone, filter, projectPath, tab?.tuner, tabId, setTabTuner])
  const restoreRef = useRef(restoreFilter)
  restoreRef.current = restoreFilter
  const restoreFilterCb = useCallback(() => restoreRef.current(), [])
  const filtersNothing = !!filterCount && filterCount[1] > 0 && filterCount[0] >= filterCount[1]
  const agentWaiting = useAppStore((s) => {
    if (!filterPane || !filterLabel) return false
    for (const tabs of Object.values(s.tabsByWorkspace)) {
      const t = tabs.find((x) => x.ptyId === filterPane)
      if (t) return !!t.agentId && s.agentHookStatusByPty[filterPane] !== 'working'
    }
    return false
  })

  const [sceneError, setSceneError] = useState<string | null>(null)
  const emptyTab = !!tab && !tab.tuner
  const sceneBase = !!tab?.tuner && tab.tuner.kind === 'view' && tab.tuner.id === TUNER_SCENE_VIEW
  const sceneMissing = viewsLoaded && !views.some((v) => v.name === TUNER_SCENE_VIEW)
  const sceneViewPending = sceneBase && sceneMissing && !sceneError
  useEffect(() => {
    if (!projectPath || !(emptyTab || (sceneBase && sceneMissing))) return
    if (emptyTab) {
      const st = useAppStore.getState()
      const ws = Object.keys(st.tabsByWorkspace).find((w) => st.tabsByWorkspace[w]?.some((t) => t.id === tabId))
      const me = ws ? st.tabsByWorkspace[ws]?.find((t) => t.id === tabId) : undefined
      const other = ws && me
        ? (st.tabsByWorkspace[ws] ?? []).find((t) => t.id !== tabId && t.contentType === 'tuner' && t.tuner && t.worktreeId === me.worktreeId && isSceneTuner(t.tuner))
        : undefined
      if (other && me) {
        debugLog(`[tuner] one scene Tuner: ${other.label} is already open, so this new one closes`)
        if ((other.scratchpadId ?? null) !== (me.scratchpadId ?? null)) {
          console.info(`[tuner] open on ${me.scratchpadId ?? 'project'} retargets ${other.label} (${other.id}) from ${other.scratchpadId ?? 'project'}`)
          st.setTabScratchpad(other.id, me.scratchpadId ?? null)
        }
        st.activateTab(other.id)
        st.closeTab(tabId)
        return
      }
    }
    let alive = true
    void window.api.tuner.writeQuickView(projectPath, { kind: 'scene' }).then(async (r) => {
      if (!alive) return
      if (!r.ok) {
        setSceneError(r.error)
        return
      }
      setSceneError(null)
      setViews(await window.api.tuner.listViews(projectPath))
      setViewsLoaded(true)
      if (emptyTab) setTabTuner(tabId, { kind: 'view', id: r.data }, tunerLabel(r.data))
    })
    return () => {
      alive = false
    }
  }, [projectPath, tabId, emptyTab, sceneBase, sceneMissing, setTabTuner])

  const frameView = useCallback(() => setFrameSignal((n) => n + 1), [])

  const [viewTo, setViewTo] = useState<{ orbit: Orbit; seq: number } | null>(null)
  const alignRef = useRef<{ withView: () => void; viewTo: () => void }>({ withView: () => undefined, viewTo: () => undefined })
  alignRef.current = {
    withView: () => {
      const o = memory.orbit
      if (!o || !selected || phase !== 'live') return
      onTransform(selected, { position: orbitPosition(o), rotation: orbitRotation(o), ...(o.orthographic ? {} : { fov: o.fov }) }, true)
      showNotice(`${selectedObj?.label || 'The object'} now matches the scene view`)
    },
    viewTo: () => {
      const obj = selectedObj
      if (!obj || phase !== 'live') return
      const [x, y, z, w] = obj.rotation
      const f: Vec3 = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)]
      const d = 5
      const o = orbitFromLookAt(obj.position, [obj.position[0] + f[0] * d, obj.position[1] + f[1] * d, obj.position[2] + f[2] * d], memory.orbit?.fov)
      setViewTo((v) => ({ orbit: o, seq: (v?.seq ?? 0) + 1 }))
      rootRef.current?.querySelector<HTMLElement>('[data-anim-btn="fold"][aria-pressed="false"]')?.click()
    }
  }

  const downInRef = useRef(false)
  const togglePlanarRef = useRef<() => void>(() => {})
  useEffect(() => {
    const down = (e: PointerEvent): void => {
      downInRef.current = !!rootRef.current?.contains(e.target as Node)
    }
    const key = (e: KeyboardEvent): void => {
      const two = e.code === 'Digit2'
      if (e.defaultPrevented || (keyLetter(e) !== 'f' && !two) || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const root = rootRef.current
      if (!root || !downInRef.current || root.offsetParent === null) return
      const a = document.activeElement
      if (a && a !== document.body && a !== document.documentElement) return
      e.preventDefault()
      if (two) togglePlanarRef.current()
      else frameView()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [frameView])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const t = e.target as HTMLElement
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      e.stopPropagation()
      if (!playing) saveAll()
      else showNotice('Unity only saves in Edit Mode. Leave Play Mode to save.', true)
      return
    }
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && keyLetter(e) === 'f') {
      e.preventDefault()
      if (e.altKey) alignRef.current.viewTo()
      else alignRef.current.withView()
      return
    }
    if (animator && animShown && animator.clip && !t.closest('button, a') && (e.code !== 'Space' || t.closest('[data-scene-viewport], [data-tuner-timeline]'))) {
      if (animatorKey(e, animator, projectPath, session)) {
        e.preventDefault()
        return
      }
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === '/') {
      e.preventDefault()
      setAskOpen(true)
      return
    }
    const k = keyLetter(e)
    if (k === 'w') setMode('move')
    else if (k === 'e') setMode('rotate')
    else if (k === 'r') setMode('scale')
    else if (k === 't') setMode('rect')
    else if (k === 'x') setSpace(space === 'local' ? 'global' : 'local')
    else if (k === 'z') setPivot(pivot === 'pivot' ? 'center' : 'pivot')
    else if (k === 'f') {
      if (e.shiftKey) return
      frameView()
    }
    else if (e.code === 'Digit2' && !e.shiftKey) togglePlanar()
    else if (k === '[') cycleState(-1)
    else if (k === ']') cycleState(1)
    else return
    e.preventDefault()
  }

  const planar = (modePick ?? view?.mode ?? (autoPlanar ? '2d' : '3d')) === '2d'
  const togglePlanar = (): void => {
    const next: TunerMode = planar ? '3d' : '2d'
    memory.mode = next
    setModePick(next)
  }
  togglePlanarRef.current = togglePlanar

  const live = phase === 'live'
  const memberSel = useMemo(
    () => (isMemberId(selected) ? memberObject(selected, memberIndex, anchors) : null),
    [selected, memberIndex, anchors]
  )
  const targetSel = merged.find((o) => o.id === selected) ?? null
  const baseSel = targetSel ?? entries.find((o) => o.id === selected) ?? memberSel
  const selectedObj = !targetSel && baseSel && liveMerged ? { ...liveMerged, kind: baseSel.kind, inspect: baseSel.inspect } : baseSel
  const selectedId = selectedObj?.id ?? null
  const selectedAsset = selectedObj?.kind === 'asset'
  const selectedPathKey = selectedObj?.kind === 'opened' && !selectedObj.error ? `${selectedObj.path}\n${selectedObj.scene}` : ''
  const selectedPath = useMemo(() => {
    if (!selectedPathKey) return null
    const [path, scene] = selectedPathKey.split('\n')
    return { path, scene }
  }, [selectedPathKey])
  const sceneWide = view?.kind === 'scene'
  const noWorld = live && sceneWide && (sceneBounds === null || sceneNoRenderers) && !!projectPath
  const canvasPick = sceneWide && viewPrefs.canvasView
    ? overlays.find((o) => o.path === viewPrefs.canvasView && (!viewPrefs.canvasViewScene || o.scene === viewPrefs.canvasViewScene)) ?? null
    : null
  const overlayOf = (path: string, scene: string): TunerOverlayCanvas | null =>
    overlays.find((o) => (path === o.path || path.startsWith(`${o.path}/`)) && (!scene || !o.scene || o.scene === scene)) ?? null
  const camSavedRef = useRef<{ orbit: Orbit | null; mode: TunerMode | null } | null>(null)
  const showCanvas = (o: TunerOverlayCanvas | null, why: string): void => {
    const was = viewPrefs.canvasView
    const next = o?.path ?? ''
    if (o) {
      if (!was) camSavedRef.current = { orbit: memory.orbit, mode: memory.mode }
      memory.mode = '2d'
      setModePick('2d')
      setFrameBox({ bounds: { center: o.center, size: o.size }, seq: Date.now() })
    } else if (was) {
      const saved = camSavedRef.current
      camSavedRef.current = null
      memory.mode = saved?.mode ?? null
      setModePick(saved?.mode ?? null)
      const orbit = saved?.orbit
      if (orbit) setTimeout(() => setViewTo({ orbit, seq: Date.now() }), 0)
      else setTimeout(frameView, 0)
    }
    if (next === was && (o?.scene ?? '') === viewPrefs.canvasViewScene) return
    debugLog(`[tuner] scene view shows ${next || 'Scene'} (was ${was || 'Scene'}) because of the ${why}`)
    setViewPrefs({ canvasView: next, canvasViewScene: o?.scene ?? '' })
  }
  const dimRow = useCallback(
    (path: string, scene: string): string | null => {
      const o = overlays.find((c) => (path === c.path || path.startsWith(`${c.path}/`)) && (!scene || !c.scene || c.scene === scene)) ?? null
      if (canvasPick) return o === canvasPick ? null : `Hidden while the view shows only the canvas ${canvasPick.name}. Pick Scene above the view to see it.`
      return o ? `${o.name} is a UI overlay canvas, so the scene view doesn't draw it. Select it, or pick ${o.name} above the view, to see it on its own.` : null
    },
    [overlays, canvasPick]
  )
  const showCanvasRef = useRef(showCanvas)
  showCanvasRef.current = showCanvas
  const framedCanvasRef = useRef('')
  useEffect(() => {
    if (!canvasPick || !live) return
    const key = `${session}\n${canvasPick.path}`
    if (framedCanvasRef.current === key) return
    framedCanvasRef.current = key
    if (!planar) {
      memory.mode = '2d'
      setModePick('2d')
    }
    setFrameBox({ bounds: { center: canvasPick.center, size: canvasPick.size }, seq: Date.now() })
  }, [canvasPick, live, session])
  const selPathKey = selectedObj && !selectedObj.error && selectedObj.path ? `${selectedObj.path}\n${selectedObj.scene ?? ''}` : ''
  const selSeenRef = useRef<string | null>(null)
  useEffect(() => {
    if (!live || !sceneWide) return
    if (selSeenRef.current === null) {
      selSeenRef.current = selPathKey
      return
    }
    if (selSeenRef.current === selPathKey) return
    selSeenRef.current = selPathKey
    if (!selPathKey) return
    const [p, sc] = selPathKey.split('\n')
    const o = overlayOf(p, sc)
    if (o && o.path !== viewPrefs.canvasView) showCanvasRef.current(o, 'selection')
    else if (!o && viewPrefs.canvasView) showCanvasRef.current(null, 'selection')
  }, [selPathKey, live, sceneWide, overlays])
  useEffect(() => {
    if (phase !== 'live' || !projectPath || !sceneWide) return
    const want = viewPrefs.canvasView
    void window.api.tuner.canvasView(projectPath, session, want, viewPrefs.canvasViewScene).then((r) => {
      if (r.ok || !want) return
      showNotice(r.error, true)
      showCanvasRef.current(null, 'canvas going away')
    })
  }, [phase, projectPath, session, sceneWide, viewPrefs.canvasView, viewPrefs.canvasViewScene])
  const inspectJson = selectedObj && !selectedObj.error && selectedObj.inspect
      ? JSON.stringify(selectedObj.inspect)
      : ''
  const inspectTarget = useMemo(() => (inspectJson ? (JSON.parse(inspectJson) as TunerEntryTarget) : null), [inspectJson])
  const extraTargetsJson = (() => {
    if (selection.ids.length < 2 || !inspectTarget || inspectTarget.kind !== 'object') return ''
    const out: { path: string; scene?: string; at?: number[] }[] = []
    for (const id of selection.ids) {
      if (id === selectedId) continue
      const o =
        merged.find((x) => x.id === id) ?? entries.find((x) => x.id === id) ?? (isMemberId(id) ? memberObject(id, memberIndex, anchors) : null)
      const t = o && !o.error && o.inspect?.kind === 'object' ? o.inspect : null
      if (!t) continue
      out.push({ path: t.path, ...(t.scene ? { scene: t.scene } : {}), ...(t.at?.length ? { at: t.at } : {}) })
    }
    return out.length ? JSON.stringify(out) : ''
  })()
  const focusedAsset = inspectTarget?.kind === 'asset' ? inspectTarget.path : assetPath

  const askChips = useMemo((): AskDriftChip[] => {
    const out: AskDriftChip[] = []
    if (assetPath) out.push({ id: 'view', kind: 'asset', label: assetFileName(assetPath), title: assetPath, fixed: true })
    else if (viewName) out.push({ id: 'view', kind: 'view', label: tunerTitle || viewName, title: `Tuner "${tunerTitle || viewName}"`, fixed: true })
    for (const p of selectedPaths.slice(0, 3)) out.push({ id: `object:${p}`, kind: 'object', label: p.split('/').pop() || p, title: p })
    if (focusedAsset && focusedAsset !== assetPath) out.push({ id: `asset:${focusedAsset}`, kind: 'asset', label: assetFileName(focusedAsset), title: focusedAsset })
    if (viewName && phase === 'live') {
      const state = playing && multiState ? activeInfo?.label || activeState : ''
      out.push(playing ? { id: 'mode', kind: 'play', label: state ? `Play Mode · ${state}` : 'Play Mode' } : { id: 'mode', kind: 'edit', label: 'Edit Mode' })
    }
    return out
  }, [assetPath, viewName, tunerTitle, selectedPaths, focusedAsset, phase, playing, multiState, activeInfo?.label, activeState])

  const askTarget = openerTab ? { ptyId: opener, label: openerTab.customLabel ?? openerTab.label, agentId: openerTab.agentId ?? null } : null

  const showAgentTab = (t: { id: string; groupId: string }): void => {
    const st = useAppStore.getState()
    if (askWorkspaceId) {
      const full = st.fullscreenGroupIdByWorkspace[askWorkspaceId]
      if (full && full !== t.groupId) st.exitFullscreen(askWorkspaceId)
    }
    useAppStore.getState().activateTab(t.id)
  }

  const askDrift = async (ask: string, chips: AskDriftChip[], to: AskDriftTo): Promise<AskDriftResult> => {
    const has = (kind: AskDriftChip['kind']): boolean => chips.some((c) => c.kind === kind)
    const phone = await askDriftPhone()
    const text = buildAskDriftMessage(tunerTitle || viewName || 'Tuner', ask, {
      phone,
      where: scratchpadPromptScope(scratchpad),
      guide: agentGuidePath(scratchpad?.path || projectPath),
      selected: chips.filter((c) => c.kind === 'object').map((c) => c.title ?? c.label),
      asset: chips.find((c) => c.kind === 'asset' && !c.fixed)?.title,
      mode: has('play') ? 'play' : has('edit') ? 'edit' : undefined,
      state: has('play') && multiState ? activeInfo?.label || activeState : undefined
    })
    setNotice(null)
    if (to.kind === 'agent') {
      const st = useAppStore.getState()
      const t = Object.values(st.tabsByWorkspace).flat().find((x) => x.ptyId === to.ptyId)
      const label = t ? t.customLabel ?? t.label : 'That terminal'
      const r = await window.api.agentExec.tell(to.ptyId, text).catch(() => 'gone' as const)
      if (r !== 'sent') return { sent: false, error: r === 'shell' ? `${label} has no agent running now. Pick another one.` : `${label} is closed. Pick another agent.` }
      setAskOpener(to.ptyId)
      if (t && !phone?.fromPhone) showAgentTab(t)
      setCopied(`Sent to ${label}. Drift will show you the answer.`)
      return { sent: true, note: `${label} has your question. Drift will show you the answer here.` }
    }
    const entry = getAgentEntry(to.agentId)
    const st = useAppStore.getState()
    if (!entry || !tab || !askWorkspaceId) return { sent: false, error: 'Satura Space could not start that agent here.' }
    const opts = { label: entry.label, agentId: to.agentId }
    const fresh = to.target === 'panel' ? st.createTab(askWorkspaceId, tab.worktreeId, { ...opts, groupId: tab.groupId }) : st.openTabBeside(askWorkspaceId, tab.groupId, tab.worktreeId, opts)
    setPendingCommand(fresh.ptyId, buildAgentLaunchCommand(entry, st.settings?.agents[to.agentId]))
    setAskOpener(fresh.ptyId)
    const r = await window.api.agentExec.tell(fresh.ptyId, text, true).catch(() => 'gone' as const)
    if (r !== 'sent') return { sent: false, error: `${entry.label} did not start in time. Pick it from the list once it is ready.` }
    if (!phone?.fromPhone) showAgentTab(fresh)
    setCopied(`Sent to ${entry.label}. Drift will show you the answer.`)
    return { sent: true, note: `${entry.label} is starting with your question. Drift will show you the answer here.` }
  }

  const prevFocusedAsset = useRef(focusedAsset)
  useEffect(() => {
    const prev = prevFocusedAsset.current
    prevFocusedAsset.current = focusedAsset
    if (!focusedAsset) return
    if (prev !== focusedAsset) {
      revealAsset(focusedAsset)
      return
    }
    const abs = assetAbsPath(focusedAsset)
    if (abs) noteViewerFocus(abs)
  }, [focusedAsset, revealAsset, assetAbsPath, noteViewerFocus])

  const assetTarget = useMemo(
    (): TunerInspectTarget | null => (assetPath && assetLayout !== 'hierarchy' ? { kind: 'asset', path: assetPath } : null),
    [assetPath, assetLayout]
  )
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(() => new Set())
  const scopeKey = inspectTarget?.kind === 'object' && (inspectTarget.components || inspectTarget.exclude?.length) ? `${inspectTarget.scene ?? ''}|${inspectTarget.path}` : null
  const allShown = !!scopeKey && showAll.has(scopeKey)
  const inspectorTarget = useMemo((): TunerInspectTarget | null => {
    if (!inspectTarget) return null
    if (inspectTarget.kind !== 'object') return inspectTarget as TunerInspectTarget
    const base = inspectTarget as TunerInspectTarget & { kind: 'object' }
    const t: TunerInspectTarget & { kind: 'object' } = allShown ? { kind: 'object', path: base.path, ...(base.scene ? { scene: base.scene } : {}), ...(base.at?.length ? { at: base.at } : {}) } : base
    return extraTargetsJson ? { ...t, targets: JSON.parse(extraTargetsJson) } : t
  }, [inspectTarget, extraTargetsJson, allShown])
  const inspectorScope = useMemo(
    () =>
      scopeKey
        ? {
            mode: allShown ? ('all' as const) : ('filtered' as const),
            onToggle: () =>
              setShowAll((prev) => {
                const next = new Set(prev)
                if (next.has(scopeKey)) next.delete(scopeKey)
                else next.add(scopeKey)
                return next
              })
          }
        : undefined,
    [scopeKey, allShown]
  )
  const changeIds = useMemo(
    () => (selection.ids.length > 1 ? selection.ids : selectedId ? [selectedId] : []),
    [selectionKey, selectedId]
  )
  const inspectorChanged = useMemo(
    () =>
      changeIds.length
        ? (componentKey: string, path: string): boolean =>
            changeIds.some((id) => findPropertyChange(changeIndex, id, selectedAsset ? null : componentKey, path) != null)
        : undefined,
    [changeIndex, changeIds, selectedAsset]
  )
  const onResetProperty = useCallback(
    (componentKey: string, path: string) => {
      for (const id of changeIds) {
        const o = findPropertyChange(changeIndex, id, selectedAsset ? null : componentKey, path)
        if (!o) continue
        resetChanges({ id, component: o.component, field: path.startsWith(`${o.field}.`) ? o.field : path })
      }
    },
    [changeIndex, changeIds, selectedAsset, resetChanges]
  )

  const status = (() => {
    if (phase !== 'live') return null
    if (!graphics) return { dot: 'bg-zinc-500', text: 'No GPU' }
    if (!playing) return null
    if (paused) return { dot: 'bg-sky-300', text: 'Paused' }
    return null
  })()

  const readiness = tunerReadiness({
    view: viewName,
    viewsLoaded: viewsLoaded || !!assetView,
    viewFound: !!view,
    scratchpadDown: !!scratchpad && scratchpad.status !== 'running',
    phase,
    error,
    needsFrame: graphics && shown && assetLayout !== 'inspector',
    framed
  })
  const ready = readiness.ready
  const busyWasRef = useRef(false)
  const worldKnown = useWorldStore((s) => (s.worlds[projectPath]?.observed.version ?? 0) > 0)
  const noUnity = phase !== 'live' && (presence === 'none' || ((presence !== 'busy' || !worldKnown) && (phase === 'waiting' || phase === 'starting') && !!error && /No Unity editor is running/.test(error)))
  const editorUp = useWorldStore((s) => Object.keys(s.worlds[projectPath]?.observed.instances ?? {}).length > 0)
  const tunerHub = useHubState(projectPath, phase !== 'live' && !editorUp)
  const unityLife = useUnityLifecycle(scratchpad ? null : projectPath)
  const unityDown = phase !== 'live' && !scratchpad && isUnityDown(unityLife) ? unityLife : null
  const hubBlocked = phase !== 'live' && !editorUp && !!tunerHub && tunerHub !== 'ready' ? tunerHub : null
  const neutralNote = !viewName
    ? null
    : viewsLoaded && !view && !sceneViewPending
      ? scratchpad
        ? `Scratchpad “${scratchpad.name}” has no view "${viewName}"`
        : `The view "${viewName}" no longer exists`
      : scratchpad && scratchpad.status !== 'running' && phase !== 'live'
        ? scratchpad.status === 'starting'
          ? `Scratchpad “${scratchpad.name}” is starting`
          : scratchpad.status === 'error'
            ? `Scratchpad “${scratchpad.name}” didn’t start${scratchpad.error ? `: ${scratchpad.error}` : ''}`
            : `Scratchpad “${scratchpad.name}” isn’t running`
        : phase === 'waiting' && isEditorRevealedError(error)
          ? 'Hide the Unity editor to use the Tuner'
          : phase === 'waiting' && isHeadlessGraphicsError(error)
            ? "The Tuner doesn't work with Unity in Headless (graphics) mode"
          : phase === 'live' && !framed && !!frameTrouble
            ? `Can't show the scene view: ${frameTrouble}`
          : phase === 'waiting' && assetKind === 'scene' && !!error && /won't switch scenes/.test(error)
            ? "This scene isn't open in Unity"
            : null
  const busyReason = noUnity || neutralNote
    ? ''
    : !ready
      ? readiness.state
      : reload.saving > 0 || unitySaving
        ? 'the scene is saving'
        : presence === 'busy'
        ? 'Unity is busy'
        : reload.pending > 0
          ? 'the scene is reloading'
          : awaitFrame || busyWasRef.current
            ? 'waiting for the reloaded frame'
            : ''
  const tunerView: TunerShow = noUnity || neutralNote ? 'neutral' : busyReason ? 'loading' : 'scene'
  const pendingLabel = tunerPendingLabel(busyReason, presence === 'busy' || busyReason === 'Unity is busy' ? unityBusy : '')
  if (tunerView === 'scene') everLiveRef.current = true
  const panel: { name: TunerPanelState; reason: string } = hubBlocked
    ? { name: 'hub', reason: `Unity Hub is ${hubBlocked}` }
    : unityDown
      ? { name: 'unity-down', reason: `${stateTitle(unityDown)}: ${unityDown.error}` }
    : noUnity
      ? { name: 'no-unity', reason: "Unity isn't open" }
      : neutralNote
        ? {
            name: viewsLoaded && !view && !sceneViewPending ? 'missing-view' : scratchpad && scratchpad.status !== 'running' && phase !== 'live' ? 'scratchpad' : phase === 'waiting' && isEditorRevealedError(error) ? 'revealed' : phase === 'waiting' && isHeadlessGraphicsError(error) ? 'headless-graphics' : phase === 'live' && !framed && !!frameTrouble ? 'no-frames' : 'scene-not-open',
            reason: neutralNote
          }
        : busyReason
          ? { name: presence === 'busy' ? 'busy' : everLiveRef.current && ready ? 'refreshing' : 'connecting', reason: busyReason }
          : { name: 'live', reason: '' }
  const bodyShown = panel.name === 'live' || panel.name === 'refreshing'
  const bodyMounted = bodyShown || panel.name === 'connecting' || panel.name === 'busy'
  const panelWasRef = useRef<TunerPanelState | null>(null)
  useEffect(() => {
    const was = panelWasRef.current
    if (was === panel.name) return
    panelWasRef.current = panel.name
    debugLog(`[tuner] state ${was ?? 'none'} -> ${panel.name} because ${panel.reason || 'the view is live'} tab=${tabId}`)
  }, [panel.name, panel.reason, tabId])
  const busyNow = presence === 'busy' || reload.pending > 0
  useEffect(() => {
    if (busyNow) {
      busyWasRef.current = true
      setAwaitFrame(false)
      return
    }
    if (!busyWasRef.current) return
    busyWasRef.current = false
    setAwaitFrame(true)
    const t = setTimeout(() => setAwaitFrame(false), AWAIT_FRAME_MS)
    return () => clearTimeout(t)
  }, [busyNow, reload.gen])
  useEffect(() => {
    if (!awaitFrame) return
    return window.api.tuner.onFrame((e) => {
      if (e.projectPath === projectPath && e.meta.session === session) setAwaitFrame(false)
    })
  }, [awaitFrame, projectPath, session])
  const [stuckKey, setStuckKey] = useState('')
  const loadingKey = tunerView === 'loading' ? `${panel.name}|${busyReason}` : ''
  useEffect(() => {
    if (!loadingKey) return
    const t = setTimeout(() => {
      console.warn(`[tuner] still loading after ${STUCK_NOTE_MS / 1000} s: ${loadingKey}${phase === 'waiting' && error ? ` (${error})` : ''} tab=${tabId}`)
      setStuckKey(loadingKey)
    }, STUCK_NOTE_MS)
    return () => clearTimeout(t)
  }, [loadingKey, tabId])
  const stuckNote = loadingKey && stuckKey === loadingKey ? `Taking longer than usual: ${busyReason}${phase === 'waiting' && error ? ` (${error})` : ''}.` : null
  useEffect(() => {
    debugLog(`[tuner] view ${tunerView}${busyReason ? ` (${busyReason})` : neutralNote ? ` (${neutralNote})` : noUnity ? ' (no Unity)' : ''} unity=${presence} at=${Math.round(performance.now())} tab=${tabId}`)
  }, [tunerView, busyReason, neutralNote, noUnity, presence, tabId])
  const padStarting = !!scratchpad && scratchpad.status === 'starting' && panel.name === 'scratchpad'
  const overlayCard =
    hubBlocked ? (
      <UnityHubCard state={hubBlocked} compact />
    ) : unityDown ? (
      <div data-tuner-unity-down={unityDown.code} className="flex w-full justify-center">
        <UnityStateCard life={unityDown} compact />
      </div>
    ) : tunerView === 'neutral' ? (
      <div data-tuner-neutral className="flex w-full max-w-[280px] flex-col items-center gap-2 text-center">
        {padStarting ? (
          <>
            <PendingState key="starting" tag="tuner scratchpad" label={`Starting “${scratchpad?.name ?? ''}”…`} size="lg" className="rounded-full bg-black/40 px-3 py-1.5" />
            {targetProgress && <div data-tuner-target-progress className="text-[11px] leading-relaxed text-zinc-500">{targetProgress}</div>}
          </>
        ) : (
          <>
            <Unplug className="h-4 w-4 text-zinc-600" />
            <div className="text-[11px] leading-relaxed text-zinc-500">{neutralNote ?? "Unity isn't open"}</div>
          </>
        )}
        {scratchpad && (scratchpad.status === 'stopped' || scratchpad.status === 'error') && phase !== 'live' && (
          <button
            type="button"
            data-tuner-start-scratchpad={scratchpad.id}
            onClick={() => {
              const parent = scratchpadParentProject(scratchpad.path)
              if (parent) void window.api.scratchpads.start(parent, scratchpad.id).then((r) => { if (!r.ok) console.warn(`[tuner] scratchpad start failed: ${r.error}`) })
            }}
            className="rounded border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-zinc-200 transition-colors hover:bg-white/10 hover:text-white"
          >
            Start scratchpad
          </button>
        )}
        {panel.name === 'headless-graphics' && (
          <button
            type="button"
            data-tuner-normal-mode
            onClick={() => {
              debugLog(`[tuner] switching ${projectPath} to Normal mode for the Tuner`)
              void window.api.unity.setMode(projectPath, 'normal').then((r) => { if (!r.ok) console.warn(`[tuner] switch to Normal failed: ${r.error}`) })
            }}
            className="rounded border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-zinc-200 transition-colors hover:bg-white/10 hover:text-white"
          >
            Switch Unity to Normal
          </button>
        )}
        {panel.name === 'no-frames' && (
          <button
            type="button"
            data-tuner-retry-frames
            onClick={() => {
              debugLog(`[tuner] try again after frames could not be shown tab=${tabId}`)
              setRestartKey((k) => k + 1)
            }}
            className="rounded border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-zinc-200 transition-colors hover:bg-white/10 hover:text-white"
          >
            Try again
          </button>
        )}
        {(panel.name === 'no-unity' || panel.name === 'scratchpad' || panel.name === 'no-frames' || (panel.name === 'missing-view' && !!scratchpad)) && targetChoices}
      </div>
    ) : tunerView === 'loading' ? (
      <div data-tuner-loading={busyReason} className="flex w-full max-w-[280px] flex-col items-center gap-2 text-center">
        {scratchpad && <div data-tuner-target-name className="text-[11px] text-zinc-400">Scratchpad “{scratchpad.name}”</div>}
        <PendingState key={pendingLabel} tag={`tuner ${panel.name}`} label={pendingLabel} size="lg" className="rounded-full bg-black/40 px-3 py-1.5" />
        {targetProgress && <div data-tuner-target-progress className="text-[11px] leading-relaxed text-zinc-500">{targetProgress}</div>}
        {stuckNote && <div data-tuner-stuck className="text-[11px] leading-relaxed text-zinc-500">{stuckNote}</div>}
        {(scratchpad || stuckNote) && targetChoices}
      </div>
    ) : null
  const noGpu = tunerView === 'scene' && phase === 'live' && !graphics
  const animShown = !stagingOpen && !!animator && (animOpen ?? (!!animator.owner || !!view?.animator))
  const setAnimOpen = useCallback(
    (open: boolean) => {
      memory.animOpen = open
      setAnimOpenState(open)
      if (!open && animator) void sendAnimator(projectPath, session, { op: 'close' })
    },
    [memory, animator, projectPath, session]
  )
  const setStagingOpen = useCallback(
    (open: boolean) => {
      memory.stagingOpen = open
      setStagingOpenState(open)
      if (!open) void window.api.tuner.staging(projectPath, session, { op: 'close' })
    },
    [memory, projectPath, session]
  )
  useEffect(() => {
    if (view?.animator && memory.stagingOpen) setStagingOpen(false)
  }, [view, memory, setStagingOpen])
  useEffect(() => {
    if (!stagingOpen || phase !== 'live') return
    void window.api.tuner.staging(projectPath, session, { op: 'open' }).then((r) => {
      if (!r.ok) animError(r.error)
    })
  }, [stagingOpen, phase, projectPath, session, animError])
  const runStaging = useCallback(
    (path: string, item: string) => {
      onAnimSelectObject(item)
      void window.api.tuner.staging(projectPath, session, { op: 'run', path }).then((r) => {
        if (!r.ok) animError(r.error)
      })
    },
    [projectPath, session, onAnimSelectObject, animError]
  )
  const stopStaging = useCallback(
    (path: string) => {
      void window.api.tuner.staging(projectPath, session, { op: 'stop', path }).then((r) => {
        if (!r.ok) animError(r.error)
      })
    },
    [projectPath, session, animError]
  )
  const fetchStagingReport = useCallback(
    async (path: string) => {
      const r = await window.api.tuner.staging(projectPath, session, { op: 'report', path })
      return r.ok ? parseTunerStagingReport(r.data) : null
    },
    [projectPath, session]
  )
  const openStagingScene = useCallback(
    (scene: string) => {
      void switchEditorScene(projectPath, scene).then((ok) => {
        if (ok) window.api.unity.setLastScene(projectPath, scene)
      })
    },
    [projectPath]
  )
  const attachHint = useMemo(() => {
    if (!animator || !animShown || !selectedObj || noGpu || !animator.clip) return null
    const pending = Object.keys(animator.pending).length
    if (pending > 0) return `${pending} animated value${pending === 1 ? '' : 's'} changed but not keyed. Press ◆+ in the timeline to keep ${pending === 1 ? 'it' : 'them'}.`
    const frame = Math.round(animator.time * animator.clip.frameRate)
    if (animator.record) return `Recording ${animator.clip.name}: changes to ${animator.owner?.name ?? 'the object'} become keys at frame ${frame}.`
    return null
  }, [animator, animShown, selectedObj, noGpu])
  const animOwnerSeen = !!animator?.owner
  useEffect(() => {
    if (animOpen !== null || !animOwnerSeen) return
    memory.animOpen = true
    setAnimOpenState(true)
  }, [animOpen, animOwnerSeen, memory])
  const editTools = !assetKind || assetKind === 'prefab' || assetKind === 'scene'
  const toolbarBtn = (on: boolean): string =>
    `flex h-6 items-center justify-center gap-1 rounded px-1.5 text-[11px] transition-colors ${
      on ? 'bg-sky-500/20 text-sky-200' : 'text-zinc-400 hover:bg-white/10 hover:text-zinc-100'
    }`

  const showRest = viewPrefs.rest
  const filterIds = filter && view && view.kind !== 'scene' && view.kind !== 'prefabs' ? objects.filter((o) => !o.error).map((o) => o.id).join('\n') : ''
  const focus = useMemo<TunerFocus | null>(
    () => (searchIds ? { ids: searchIds, tree: false, context: showRest } : filterIds ? { ids: filterIds.split('\n'), tree: true, context: showRest } : null),
    [searchIds, filterIds, showRest]
  )
  const restToggle = (className: string): ReactNode => (
    <button
      type="button"
      data-tuner-show-rest={showRest ? 'on' : 'off'}
      aria-pressed={showRest}
      onClick={() => setViewPrefs({ rest: !showRest })}
      data-ti-tip={showRest ? (filterIds ? 'Hide objects far from the filter' : 'Hide objects far from the search results') : 'Show the whole scene'}
      className={className}
    >
      {showRest ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
    </button>
  )
  const viewport = (
    <SceneViewport
      projectPath={projectPath}
      session={session}
      live={phase === 'live' && shown}
      onEditKey={live ? viewportEdit : undefined}
      startSeq={startSeq}
      planar={planar}
      orthographic={viewPrefs.orthographic}
      onOrthographicChange={(on) => setViewPrefs({ orthographic: on })}
      camera={viewPrefs.camera}
      iconStyle={iconStyle}
      onCameraChange={(patch) => setViewPrefsState((p) => {
        const next = { ...p, camera: { ...p.camera, ...patch } }
        saveTunerViewPrefs(tabId, next)
        return next
      })}
      objects={view ? viewportObjects : NO_OBJECTS}
      wholeScene={view?.kind === 'scene' || view?.kind === 'prefabs'}
      focus={focus}
      viewTo={viewTo}
      frameBox={frameBox}
      sceneBounds={sceneBounds}
      liveStore={liveStore}
      pinned={pinned}
      selected={selected}
      selection={selection}
      ghosts={ghostIds}
      pivot={pivot}
      mode={mode}
      space={space}
      cameraSpec={view?.states?.find((s) => s.name === activeState)?.camera ?? view?.camera}
      cameraKey={activeState}
      orbitMemory={memory}
      frameSignal={frameSignal}
      onSelect={onViewportSelect}
      onSelectionChange={onViewportSelection}
      onTransform={onViewportTransform}
      onTransformMany={onTransformMany}
      onPiercePick={onPiercePick}
      selectedPath={selectedPath}
      trails={stagingOpen ? stagingTrails : null}
    >
      {noGpu && (
        <div
          className="pointer-events-none absolute left-2 top-2 flex max-w-[70%] items-center gap-1.5 rounded bg-black/55 px-2 py-1 text-[10px] text-zinc-300"
          title="This editor runs without a GPU, so there is nothing to render. The handles and the inspector still work."
        >
          <MonitorOff className="h-3 w-3 shrink-0 text-zinc-400" />
          <span className="truncate">No picture: the editor has no GPU. Handles still work.</span>
        </div>
      )}
      {!overlayCard && !attachHint && noWorld && !canvasPick && overlays.length > 0 && phase === 'live' && (
        <div
          data-viewport-ui
          data-ui-only-scene
          className="absolute left-1/2 top-1/2 flex max-w-[80%] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5 rounded border border-hairline bg-panel/90 px-3 py-2 text-[11px] text-ink-2"
        >
          <span className="text-center">
            {overlays.length === 1
              ? 'This scene only has a UI overlay canvas. Overlay canvases show on their own.'
              : 'This scene only has UI overlay canvases. Each one shows on its own.'}
          </span>
          <div className="flex max-w-full flex-wrap justify-center gap-1">
            {overlays.slice(0, 8).map((c) => (
              <button
                key={`${c.scene}\n${c.path}`}
                type="button"
                data-open-canvas={c.path}
                className="max-w-[16rem] truncate rounded border border-hairline px-2 py-0.5 text-sky-300 hover:bg-white/10"
                title={`${c.path} (${c.scene})`}
                onClick={() => showCanvas(c, 'banner')}
              >
                Show {c.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {!overlayCard && attachHint && phase === 'live' && (
        <div
          data-attach-hint
          className="pointer-events-none absolute left-1/2 top-2 max-w-[60%] -translate-x-1/2 truncate rounded border border-hairline bg-panel/85 px-2 py-1 text-[11px] text-ink-2"
        >
          {attachHint}
        </div>
      )}
      {!overlayCard && particles && phase === 'live' && (
        <ParticleEffectPanel projectPath={projectPath} session={session} particles={particles} />
      )}
      {!overlayCard && !animator && (
        <div className="pointer-events-none absolute bottom-1.5 left-2 right-20 hidden truncate text-[10px] text-zinc-500/80 min-[520px]:block">
          {planar
            ? 'Drag to select · right-drag or two fingers to pan · wheel or pinch to zoom · Shift snaps'
            : 'Drag to select · Alt-drag or two fingers to orbit · middle-drag or Shift + two fingers to pan · right-drag to look · wheel or pinch to zoom · press F again to get closer'}
        </div>
      )}
    </SceneViewport>
  )

  const stagingEl =
    !overlayCard && stagingOpen && phase === 'live' ? (
      <StagingPanel
        staging={staging}
        onRun={runStaging}
        onStop={stopStaging}
        onOpen={(file) => openFileInApp({ file, projectPath, preview: false, source: 'unity' })}
        onSource={(file, line) => openFileInWorkbench({ file: `${projectPath}/${file}`, worktreeId: tabWorktreeId ?? undefined, line, preview: false })}
        onScene={openStagingScene}
        onTrails={setStagingTrails}
        fetchReport={fetchStagingReport}
        onClose={() => setStagingOpen(false)}
      />
    ) : null

  const timeline = stagingEl ?? (
    !overlayCard && animator && animShown && phase === 'live' ? (
      <AnimatorTimeline
        projectPath={projectPath}
        session={session}
        anim={animator}
        onError={animError}
        bodyHeight={layout.timeline}
        onSelectObject={onAnimSelectObject}
        onClose={() => setAnimOpen(false)}
        onBodyHeight={(h, final) => {
          setLayout({ timeline: h })
          if (final) setTimeout(persistLayout, 0)
        }}
      />
    ) : null
  )

  const viewportArea = (
    <div className="relative isolate h-full min-h-0" data-tuner-viewport-area>
      {viewport}
      {canvasPick && live && (
        <>
          <div aria-hidden className="pointer-events-none absolute inset-0 z-10 ring-2 ring-inset ring-sky-400/60" />
          <div
            data-viewport-ui
            data-tuner-canvas-badge={canvasPick.path}
            className="absolute bottom-2 left-1/2 z-10 flex max-w-[80%] -translate-x-1/2 items-center gap-2 rounded-md border border-sky-400/40 bg-panel/90 py-1 pl-2 pr-1 text-[11px] text-sky-100"
          >
            <PanelsTopLeft className="h-3.5 w-3.5 shrink-0 text-sky-300" />
            <span className="truncate">
              UI canvas <span className="font-medium text-white">{canvasPick.name}</span> on its own. The scene is hidden.
            </span>
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 text-sky-300 hover:bg-white/10 hover:text-sky-100"
              onClick={() => showCanvas(null, 'badge')}
            >
              Back to Scene
            </button>
          </div>
        </>
      )}
      {live && !playing && selectedObj?.components.some((c) => /(^|\.)Camera$/.test(c.type)) && (
        <div className="surface-overlay absolute left-2 top-11 z-10 flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px]" data-tuner-camera-tools>
          <span className="px-1 text-ink-3">Camera</span>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-ink-2 hover:bg-white/10 hover:text-ink"
            onClick={() => alignRef.current.viewTo()}
            data-ti-tip={`See what this camera sees. Moves the scene view to the camera, like Align View to Selected in Unity (${isMac ? '⌥⇧⌘F' : 'Ctrl+Shift+Alt+F'}), and folds the timeline so you see the whole shot`}
          >
            Look through
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-ink-2 hover:bg-white/10 hover:text-ink"
            onClick={() => alignRef.current.withView()}
            data-ti-tip={`Put this camera where the scene view is, with the same field of view, like Align With View in Unity (${isMac ? '⇧⌘F' : 'Ctrl+Shift+F'}). The shot covers the whole view, including the part under the timeline.`}
          >
            Move to view
          </button>
        </div>
      )}
      {timeline && !phone && (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col justify-end" data-tuner-timeline-overlay>
          {timeline}
        </div>
      )}
    </div>
  )

  const assetInspector = assetTarget ? (
    <div className="flex min-h-0 flex-1 flex-col bg-panel" data-tuner-inspector-column>
      <div className="min-h-0 flex-1">
        {phase === 'live' && bodyShown ? (
          <TunerInspector
            projectPath={projectPath}
            target={assetTarget}
            changed={inspectorChanged}
            onResetProperty={onResetProperty}
            onOpen={onInspectorOpen}
            onPing={onPing}
          />
        ) : null}
      </div>
    </div>
  ) : null

  const treeKey = viewName ?? ''
  const treeNeed = !!view && view.kind !== 'scene' && view.kind !== 'prefabs' && treeManual !== treeKey && treeFit > 0 ? treeFit + 2 : 0
  const inspectorKeep = (h: number): number => Math.max(INSPECTOR_MIN, Math.min(160, Math.round(h * 0.35)))
  const treeAuto = treeNeed && sideH > 0 ? Math.min(treeNeed, sideH - inspectorKeep(sideH) - 6) : 0
  const stackWant = treeNeed ? treeNeed + inspectorKeep(stackH) + 12 : 0
  const viewportBasis =
    stackWant && stackH > 0 && stackWant > stackH * (1 - layout.viewport) ? `${Math.round(Math.max(stackH * 0.3, stackH - stackWant))}px` : `${layout.viewport * 100}%`
  const treeBasis = treeAuto > layout.hierarchy * sideH ? `${treeAuto}px` : `${layout.hierarchy * 100}%`

  const hierarchyBody = (
    <>
        <SceneHierarchy
          key={viewName ?? ''}
          objects={hierarchyObjects}
          assets={hierarchyAssets}
          members={members}
          capped={membersCapped}
          lazy={membersLazy}
          revealMissing={revealMissing}
          onRestoreFilter={restorable ? restoreFilterCb : undefined}
          restoreFilterTip={restorable ? `Back to the filter ${restorable.by === 'An agent' ? 'the agent' : restorable.by} set` : undefined}
          onTree={onTree}
          ghosts={ghosts}
          selection={selection}
          onSelectionChange={onHierarchySelection}
          onFocusObject={focusObject}
          ping={ping}
          onPingMissing={live ? openGhost : undefined}
          onGhostAdd={addGhost}
          onGhostDismiss={dismissGhost}
          ghostAddBlocked={ghostAddBlocked}
          onOpenPath={live ? onOpenPath : undefined}
          onOpenPrefab={live ? openPrefab : undefined}
          contextOnly={!!filter}
          onHierarchyOp={live ? hierarchyOp : undefined}
          dimRow={live && sceneWide && overlays.length > 0 ? dimRow : undefined}
          onAddFromProject={live && projectPath ? setAssetPick : undefined}
          onUndo={live ? hierarchyUndo : undefined}
          storageKey={!viewName ? tabId : view?.kind === 'scene' || view?.kind === 'prefabs' ? `${projectPath}:${viewName}` : `${tabId}:${viewName}`}
          waiting={phase !== 'live'}
          wholeScene={view?.kind === 'scene' || view?.kind === 'prefabs'}
          changed={changeIndex.objects}
          collapseBulky={!!view?.animator}
          onSearch={setSearchIds}
          headerExtra={searchIds && !filterIds ? restToggle('ml-1 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-white/10 hover:text-ink') : undefined}
          onFitHeight={setTreeFit}
        />
        {assetPick && projectPath && (
          <PopupSurface getAnchor={() => ({ left: assetPick.x, top: assetPick.y, width: 1, height: 1 })} onOutside={() => setAssetPick(null)} kind="object" role="dialog" minWidth={440}>
            <div data-hierarchy-asset-picker>
              <ObjectPicker
                data={{ type: 'UnityEngine.GameObject', typeName: 'Prefab or model', allowSceneObjects: false, current: null }}
                noNone
                query={(q) => window.api.tunerPopup.objects(projectPath, q)}
                onChange={() => undefined}
                onCancel={() => setAssetPick(null)}
                onCommit={(ref) => {
                  const at = assetPick
                  setAssetPick(null)
                  if (ref?.path) hierarchyOp({ op: 'create', parent: at.parent, scene: at.scene, asset: ref.path })
                }}
              />
            </div>
          </PopupSurface>
        )}
    </>
  )
  const crumbPath = phone && selected ? selectionPathOf(selected, objects, members) : null
  const hierarchyCrumb = phone ? (
    <button
      type="button"
      data-tuner-hierarchy-crumb
      onClick={() => foldPhone('hierarchy', true, 'crumb tap')}
      className="flex h-9 shrink-0 items-center gap-1.5 border-b border-white/5 bg-sunken/60 px-3 text-left text-[12px] text-ink-2"
    >
      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate">
        {crumbPath ? [crumbPath.scene.replace(/\.unity$/, ''), ...crumbPath.path.split('/')].filter(Boolean).join(' › ') : selectedObj?.label ?? 'Hierarchy'}
      </span>
    </button>
  ) : null
  const inspectorColumn = (
      <div className="flex min-h-0 flex-1 flex-col bg-panel" data-tuner-inspector-column>
        <div className="min-h-0 flex-1">
        {inspectorTarget && bodyShown ? (
          <TunerInspector
            projectPath={projectPath}
            target={inspectorTarget}
            scope={inspectorScope}
            changed={inspectorChanged}
            onResetProperty={onResetProperty}
            onOpen={onInspectorOpen}
            onPing={onPing}
          />
        ) : (
          <div
            className="px-3 py-3 text-[11px] text-zinc-500"
            data-tuner-inspector-empty={selectedObj?.error ?? (selectedObj ? 'it has nothing to inspect' : 'nothing is selected')}
          >
            {selectedObj?.error ?? 'Select an object in the view or the hierarchy.'}
          </div>
        )}
        </div>
      </div>
  )

  const sidebar = assetInspector ?? (
    <div ref={sideRef} className="flex min-h-0 flex-1 flex-col">
      {phone && !phoneHier ? hierarchyCrumb : (
      <>
      <div className="relative min-h-0 overflow-hidden bg-sunken/60" style={{ flex: `0 0 ${treeBasis}` }} data-tuner-hierarchy-pane>
        {hierarchyBody}
      </div>
      <SceneSplitter
        direction="vertical"
        title="Drag to resize, double-click to reset"
        label="Resize hierarchy"
        onDrag={(y, rect) => {
          setTreeManual(treeKey)
          setLayout({ hierarchy: clampRatio(y - rect.top, rect.height, HIERARCHY_MIN, INSPECTOR_MIN) })
        }}
        onEnd={persistLayout}
        onReset={() => {
          setLayout({ hierarchy: DEFAULT_TUNER_LAYOUT.hierarchy })
          setTimeout(persistLayout, 0)
        }}
      />
      </>
      )}
      {inspectorColumn}
    </div>
  )
  const sidebarWidth = clampPx(layout.sidebar, width, SIDEBAR_MIN, VIEWPORT_MIN_W)
  const noteParts = [view?.note, activeInfo?.note].filter((n): n is string => !!n)

  const phoneStack = phone && !wide && !assetInspector && assetLayout !== 'inspector'
  const timelineOpen = phone && !!timeline
  const foldBeforeTimeline = useRef<boolean | null>(null)
  useEffect(() => {
    if (timelineOpen) {
      if (foldBeforeTimeline.current === null) foldBeforeTimeline.current = phoneOpen.current.inspector
      foldPhone('inspector', false, 'timeline open')
    } else if (foldBeforeTimeline.current !== null) {
      const was = foldBeforeTimeline.current
      foldBeforeTimeline.current = null
      foldPhone('inspector', was, 'timeline closed')
    }
  }, [timelineOpen, foldPhone])
  const phoneTimeline = phone && timeline ? (
    <div className={`flex min-h-0 flex-col overflow-auto border-b border-white/10 [&_*]:pointer-events-auto ${phoneInsp ? 'max-h-[60%] shrink-0' : 'shrink-0'}`} data-tuner-phone-timeline>
      {timeline}
    </div>
  ) : null
  const toolbarEl = bodyShown ? (
      <div className="relative flex shrink-0 items-center border-b border-white/[0.06]" data-tuner-toolbar>
      <BarXScroll className="bar-x-scroll flex h-8 items-center gap-1 px-2" wrapperClassName="relative min-w-0 flex-1">
        {targetChip}
        {assetPath ? (
          <div className="flex min-w-24 flex-1 items-center gap-1.5 px-1.5 py-0.5 text-xs text-zinc-200" data-tuner-asset={assetPath} title={assetPath}>
            <ExplorerIcon name={assetFileName(assetPath)} rel={assetPath} isDir={false} open={false} dim={false} unity />
            <span className="truncate">{assetFileName(assetPath)}</span>
            {assetKind === 'model' && <span className="shrink-0 rounded bg-white/5 px-1.5 text-[10px] text-zinc-400">Read-only</span>}
            {isUnityYamlAsset(assetFileName(assetPath)) && (
              <button
                type="button"
                className="ml-0.5 flex shrink-0 items-center rounded p-0.5 text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
                onClick={() => {
                  const abs = assetAbsPath(assetPath)
                  if (abs) openFileInWorkbench({ file: abs, worktreeId: tabWorktreeId ?? undefined, text: true, preview: false })
                }}
                data-tuner-open-text
                aria-label="Open as text"
                data-ti-tip="Open the file as text"
              >
                <FileCode className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ) : null}
        {viewName && (
          <>
            {editTools && (
              <>
                <div className="flex items-center rounded-md bg-white/5 p-px" data-tool-group="tools">
                  <button
                    type="button"
                    data-tuner-tool="move"
                    className={toolbarBtn(mode === 'move')}
                    onClick={() => setMode('move')}
                    aria-label="Move"
                    data-ti-tip="Move (W)"
                  >
                    <Move3d className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    data-tuner-tool="rotate"
                    className={toolbarBtn(mode === 'rotate')}
                    onClick={() => setMode('rotate')}
                    aria-label="Rotate"
                    data-ti-tip="Rotate (E)"
                  >
                    <Rotate3d className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    data-tuner-tool="scale"
                    className={toolbarBtn(mode === 'scale')}
                    onClick={() => setMode('scale')}
                    aria-label="Scale"
                    data-ti-tip="Scale (R)"
                  >
                    <Scale3d className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    data-tuner-tool="rect"
                    aria-pressed={mode === 'rect'}
                    className={toolbarBtn(mode === 'rect')}
                    onClick={() => setMode('rect')}
                    data-ti-tip="Rect Tool (T): move, resize or rotate a sprite or UI element. On UI you can also drag the pivot and anchors."
                  >
                    <SquareDashed className="h-3.5 w-3.5" />
                  </button>
                </div>
                <span aria-hidden data-tool-sep="handles" className="mx-1 h-4 w-px shrink-0 bg-white/10" />
                <button
                  type="button"
                  data-tuner-pivot={pivot}
                  className={toolbarBtn(false)}
                  onClick={() => setPivot(pivot === 'pivot' ? 'center' : 'pivot')}
                  data-ti-tip={
                    pivot === 'pivot'
                      ? "Handle at the active object's pivot (Z to toggle)"
                      : 'Handle at the center of the selection (Z to toggle)'
                  }
                >
                  {pivot === 'pivot' ? <LocateFixed className="h-3.5 w-3.5" /> : <SquareDot className="h-3.5 w-3.5" />}
                  <span className="w-9 text-left">{pivot === 'pivot' ? 'Pivot' : 'Center'}</span>
                </button>
                <button
                  type="button"
                  data-tuner-space={space}
                  className={toolbarBtn(false)}
                  onClick={() => setSpace(space === 'local' ? 'global' : 'local')}
                  data-ti-tip={`Handle space: ${space} (X to toggle)`}
                >
                  {space === 'global' ? <Globe className="h-3.5 w-3.5" /> : <Box className="h-3.5 w-3.5" />}
                  <span className="w-9 text-left">{space === 'global' ? 'Global' : 'Local'}</span>
                </button>
              </>
            )}
            {sceneWide && live && overlays.length > 0 && <CanvasViewPicker overlays={overlays} current={canvasPick} onPick={(o) => showCanvas(o, 'selector')} />}
            {assetLayout !== 'inspector' && (
              <>
                <span aria-hidden data-tool-sep="view" className="min-w-2 flex-1" />
                <button
                  type="button"
                  className={toolbarBtn(false)}
                  onClick={() => setFrameSignal((n) => n + 1)}
                  aria-label="Frame selected"
                  data-ti-tip="Frame selected (F). Press F again for a closer view."
                >
                  <Focus className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  data-scene-2d
                  aria-pressed={planar}
                  className={`${toolbarBtn(planar)} font-medium`}
                  onClick={togglePlanar}
                  data-ti-tip={planar ? '2D view is on (2). Click to go back to the 3D orbit camera.' : 'Switch to a flat 2D view for sprites and UI (2)'}
                >
                  2D
                </button>
                {view?.kind !== 'ui' && (
                  <button
                    type="button"
                    data-scene-lighting={viewPrefs.lighting ? 'on' : 'off'}
                    aria-pressed={viewPrefs.lighting}
                    className={toolbarBtn(viewPrefs.lighting)}
                    onClick={() => setViewPrefs({ lighting: !viewPrefs.lighting })}
                    aria-label="Lighting"
                    data-ti-tip={viewPrefs.lighting ? 'Scene lighting is on, so the view is lit like the game. Click to light everything evenly.' : 'Scene lighting is off: everything is lit evenly. Click to see the scene lights.'}
                  >
                    {viewPrefs.lighting ? <Lightbulb className="h-3.5 w-3.5" /> : <LightbulbOff className="h-3.5 w-3.5" />}
                  </button>
                )}
                <span aria-hidden data-tool-sep="grid" className="mx-1 h-4 w-px shrink-0 bg-white/10" />
                <button
                  type="button"
                  data-scene-grid={viewPrefs.grid ? 'on' : 'off'}
                  aria-pressed={viewPrefs.grid}
                  aria-label="Grid"
                  className={toolbarBtn(viewPrefs.grid)}
                  onClick={() => setViewPrefs({ grid: !viewPrefs.grid })}
                  data-ti-tip="Toggle the visibility of the grid"
                >
                  <Grid3x3 className="h-3.5 w-3.5" />
                </button>
                {view?.kind !== 'ui' && (
                  <SceneCameraMenu camera={viewPrefs.camera} onChange={(camera) => setViewPrefs({ camera })} buttonClass={toolbarBtn} />
                )}
                <SceneGizmosMenu gizmos={viewPrefs.gizmos} onGizmosChange={(on) => setViewPrefs({ gizmos: on })} api={annotations} buttonClass={toolbarBtn} />
                {view?.kind !== 'ui' && (
                  <SceneEffectsMenu effects={viewPrefs.effects} onChange={(effects) => setViewPrefs({ effects })} buttonClass={toolbarBtn} />
                )}
                <span aria-hidden data-tool-sep="panels" className="mx-1 h-4 w-px shrink-0 bg-white/10" />
                <button
                  type="button"
                  data-tuner-animation-toggle={animShown ? 'on' : 'off'}
                  aria-pressed={animShown}
                  disabled={!animator}
                  className={`${toolbarBtn(animShown)} disabled:opacity-40`}
                  onClick={() => {
                    if (!animShown && stagingOpen) setStagingOpen(false)
                    setAnimOpen(!animShown)
                  }}
                  data-ti-tip={animShown ? 'Hide the animation timeline' : 'Show the animation timeline with the selected object\'s clips, keys and events'}
                >
                  <Film className="h-3.5 w-3.5" />
                  <span>Animation</span>
                </button>
                {stagingAllowed && (
                  <button
                    type="button"
                    data-tuner-staging-toggle={stagingOpen ? 'on' : 'off'}
                    aria-pressed={stagingOpen}
                    className={toolbarBtn(stagingOpen)}
                    onClick={() => setStagingOpen(!stagingOpen)}
                    data-ti-tip={stagingOpen ? 'Hide the staging panel' : 'Show the staging prefabs of this scene and run their scenarios'}
                  >
                    <FlaskConical className="h-3.5 w-3.5" />
                    <span>Staging</span>
                  </button>
                )}
              </>
            )}
            {status && (
              <span className="ml-0.5 flex shrink-0 items-center gap-1.5 rounded-full bg-white/5 px-2 py-0.5 text-[10px] tabular-nums text-zinc-400">
                <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                {status.text}
              </span>
            )}
          </>
        )}
      </BarXScroll>
        <AskDriftButton
          target={askTarget}
          workspaceId={askWorkspaceId ?? ''}
          chips={askChips}
          open={askOpen}
          onOpenChange={setAskOpen}
          onSend={askDrift}
        />
      </div>
  ) : null

  return (
    <div
      ref={rootRef}
      data-tuner-pane
      data-tuner-target={scratchpad?.id ?? 'project'}
      data-tuner-tab={tabId}
      data-tuner-view={viewName ?? ''}
      data-tuner-ready={tunerView === 'scene' ? 'true' : 'false'}
      data-tuner-show={tunerView}
      data-tuner-state={tunerView === 'scene' ? undefined : busyReason || neutralNote || "Unity isn't open"}
      data-tuner-mode={phase === 'live' ? (playing ? 'play' : 'edit') : undefined}
      data-tuner-state-name={panel.name}
      data-tuner-state-reason={panel.reason || undefined}
      tabIndex={-1}
      className="relative flex h-full min-h-0 flex-col bg-canvas text-zinc-200 outline-none [&_:focus-visible]:outline-none"
      onKeyDownCapture={(e) => blockTab(e, rootRef.current)}
      onKeyDown={onKeyDown}
      onMouseDownCapture={() => {
        const abs = focusedAsset ? assetAbsPath(focusedAsset) : null
        if (abs) noteViewerFocus(abs)
      }}
    >
      {!phoneStack && !(phone && wide) && toolbarEl}
      {!bodyShown && targetChip && (
        <div data-tuner-target-bar className="relative z-40 flex h-8 shrink-0 items-center border-b border-white/[0.06] px-2">
          {targetChip}
        </div>
      )}

      {!viewName ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <p className={`px-3 pt-3 text-xs leading-relaxed ${sceneError ? 'text-amber-300/90' : 'text-zinc-400'}`}>
            {sceneError ?? 'Opening the scene…'}
          </p>
        </div>
      ) : !bodyMounted ? null : (
        <div
          data-tuner-body
          aria-hidden={!bodyShown || undefined}
          className={`relative flex min-h-0 flex-1 flex-col${bodyShown ? '' : ' invisible'}`}
        >
          {multiState && (
            <SceneStatePicker
              states={states}
              active={activeState}
              pending={pendingState}
              width={width}
              disabled={!live || !playing || busy > 0}
              note={live && !playing ? 'States work in Play Mode' : undefined}
              onSelect={selectState}
            />
          )}
          {filter && !filtersNothing && (
            <div
              data-tuner-filter={filter}
              className="flex shrink-0 items-center gap-2 border-b border-violet-500/25 bg-violet-500/10 px-3 py-1 text-[11px] text-violet-200"
            >
              <Filter className="h-3 w-3 shrink-0" />
              <span className="min-w-0 truncate" data-tuner-filter-text>
                {filterPane && filterPane === tab?.ptyId
                  ? `Filtered to ${view?.title || filter}`
                  : agentWaiting
                    ? `${filterLabel} is waiting for you`
                    : `Filtered by ${filterLabel || 'an agent'}`}
              </span>
              {filterCount && (
                <span className="shrink-0 tabular-nums text-violet-300/70" data-tuner-filter-count={`${filterCount[0]}/${filterCount[1]}`}>
                  {filterCount[0].toLocaleString('en-US')} of {filterCount[1].toLocaleString('en-US')} objects
                </span>
              )}
              <span className="min-w-0 flex-1" />
              {filterIds && restToggle('flex shrink-0 items-center rounded px-1 py-0.5 text-violet-100 hover:bg-white/10')}
              <button
                type="button"
                data-tuner-clear-filter
                disabled={busy > 0}
                onClick={clearFilter}
                data-ti-tip={baseAsset ? `Show all of ${assetFileName(baseAsset)}` : 'Show the whole scene'}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-violet-100 enabled:hover:bg-white/10 disabled:opacity-50"
              >
                <X className="h-3 w-3" />
                Clear filter
              </button>
            </div>
          )}
          {noteParts.length > 0 && (
            <button
              type="button"
              data-tuner-note
              onClick={() => setNoteOpen((o) => !o)}
              className={`shrink-0 border-b border-sky-500/15 bg-sky-500/5 px-3 py-1 text-left text-[11px] text-zinc-300 ${
                noteOpen ? 'whitespace-pre-wrap' : 'truncate'
              }`}
              title={noteOpen ? undefined : noteParts.join('\n')}
            >
              {view?.note}
              {view?.note && activeInfo?.note && (noteOpen ? '\n' : ' · ')}
              {activeInfo?.note && <span className="text-sky-200/80">{activeInfo.note}</span>}
            </button>
          )}
          {activeInfo?.error && phase === 'live' && (
            <div
              className="flex shrink-0 items-center gap-1.5 border-b border-amber-500/15 bg-amber-500/5 px-3 py-0.5 text-[10px] text-amber-200/80"
              title={activeInfo.error}
            >
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span className="truncate">Setup: {activeInfo.error}</span>
            </div>
          )}
          {assetLayout === 'inspector' ? (
            assetInspector
          ) : phoneStack ? (
            <div className="flex min-h-0 flex-1 flex-col" data-tuner-phone-stack>
              {phoneHier ? (
                <div className="relative shrink-0 overflow-hidden bg-sunken/60" style={{ height: phoneRows.top }} data-tuner-hierarchy-pane>
                  {hierarchyBody}
                </div>
              ) : (
                hierarchyCrumb
              )}
              <SceneSplitter
                direction="vertical"
                title="Drag to resize, double-click to reset"
                label="Resize hierarchy"
                onDrag={(y, rect) => {
                  const raw = y - rect.top
                  const open = phoneOpen.current.hierarchy
                  if (open && raw < PHONE_SNAP.hierShut) return foldPhone('hierarchy', false, `dragged to ${Math.round(raw)}px`)
                  if (!open && raw < PHONE_SNAP.hierOpen) return
                  if (!open) foldPhone('hierarchy', true, `dragged to ${Math.round(raw)}px`)
                  setPhoneRows((r) => ({ ...r, top: Math.round(Math.max(PHONE_SNAP.hierMin, Math.min(rect.height - (phoneOpen.current.inspector ? r.bottom : 40) - 160, raw))) }))
                }}
                onReset={() => {
                  foldPhone('hierarchy', true, 'reset')
                  setPhoneRows(PHONE_ROWS)
                }}
              />
              <div className="relative flex min-h-[160px] min-w-0 flex-1 flex-col" data-tuner-phone-scene>
                {toolbarEl}
                <div className="min-h-0 flex-1">{viewportArea}</div>
              </div>
              <SceneSplitter
                direction="vertical"
                title="Drag to resize, double-click to reset"
                label="Resize inspector"
                onDrag={(y, rect) => {
                  const raw = rect.bottom - y
                  const open = phoneOpen.current.inspector
                  if (open && raw < PHONE_SNAP.inspShut) return foldPhone('inspector', false, `dragged to ${Math.round(raw)}px`)
                  if (!open && raw < PHONE_SNAP.inspOpen) return
                  if (!open) foldPhone('inspector', true, `dragged to ${Math.round(raw)}px`)
                  setPhoneRows((r) => ({ ...r, bottom: Math.round(Math.max(PHONE_SNAP.inspMin, Math.min(rect.height - (phoneOpen.current.hierarchy ? r.top : 36) - 160, raw))) }))
                }}
                onReset={() => {
                  foldPhone('inspector', true, 'reset')
                  setPhoneRows(PHONE_ROWS)
                }}
              />
              <div
                className="flex min-h-0 flex-col"
                data-tuner-phone-bottom
                data-tuner-inspector-folded={!phoneInsp ? '' : undefined}
                style={{ height: timeline && phoneInsp ? Math.max(phoneRows.bottom, PHONE_ANIM_MIN) : !timeline && inspectorTarget && bodyShown && phoneInsp ? phoneRows.bottom : 'auto' }}
              >
                {phoneTimeline}
                {inspectorColumn}
              </div>
            </div>
          ) : phone && wide && !assetInspector ? (
            <div className="flex min-h-0 flex-1" data-tuner-phone-columns>
              <div className="flex shrink-0 flex-col overflow-hidden bg-sunken/60" style={{ width: phoneCols.left }} data-tuner-hierarchy-pane>
                {hierarchyBody}
              </div>
              <SceneSplitter
                direction="horizontal"
                title="Drag to resize, double-click to reset"
                label="Resize hierarchy"
                onDrag={(x, rect) => setPhoneCols((c) => ({ ...c, left: Math.round(Math.max(140, Math.min(rect.width * 0.4, x - rect.left))) }))}
                onReset={() => setPhoneCols(PHONE_COLS)}
              />
              <div className="flex min-w-0 flex-1 flex-col" data-tuner-phone-scene>
                {toolbarEl}
                <div className="min-h-[120px] flex-1">{viewportArea}</div>
                {phoneTimeline}
              </div>
              <SceneSplitter
                direction="horizontal"
                title="Drag to resize, double-click to reset"
                label="Resize inspector"
                onDrag={(x, rect) => setPhoneCols((c) => ({ ...c, right: Math.round(Math.max(180, Math.min(rect.width * 0.45, rect.right - x))) }))}
                onReset={() => setPhoneCols(PHONE_COLS)}
              />
              <div className="flex shrink-0 flex-col" style={{ width: phoneCols.right }}>
                {inspectorColumn}
              </div>
            </div>
          ) : wide ? (
            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1">{viewportArea}</div>
              <SceneSplitter
                direction="horizontal"
                title="Drag to resize, double-click to reset"
                label="Resize Tuner sidebar"
                onDrag={(x, rect) => setLayout({ sidebar: clampPx(rect.right - x, rect.width, SIDEBAR_MIN, VIEWPORT_MIN_W) })}
                onEnd={persistLayout}
                onReset={() => {
                  setLayout({ sidebar: DEFAULT_TUNER_LAYOUT.sidebar })
                  setTimeout(persistLayout, 0)
                }}
              />
              <div className="flex shrink-0 flex-col" style={{ width: sidebarWidth }}>
                {sidebar}
              </div>
            </div>
          ) : (
            <div ref={stackRef} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-[120px]" style={{ flex: `0 0 ${viewportBasis}` }}>
                {viewportArea}
              </div>
              <SceneSplitter
                direction="vertical"
                title="Drag to resize, double-click to reset"
                label="Resize Tuner sidebar"
                onDrag={(y, rect) => {
                  setTreeManual(treeKey)
                  setLayout({ viewport: clampRatio(y - rect.top, rect.height, VIEWPORT_MIN_H, SIDEBAR_MIN_H) })
                }}
                onEnd={persistLayout}
                onReset={() => {
                  setLayout({ viewport: DEFAULT_TUNER_LAYOUT.viewport })
                  setTimeout(persistLayout, 0)
                }}
              />
              {sidebar}
            </div>
          )}
          {error && phase === 'live' && (
            <div className="flex shrink-0 items-center gap-2 border-t border-amber-500/20 bg-amber-500/5 px-3 py-1 text-[11px] text-amber-200/90">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate" title={error}>
                {error}
              </span>
              <button type="button" className="shrink-0 text-amber-200/60 hover:text-amber-100" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          )}
          {view && view.buttons.some((b) => b.step) && (
            <TunerSteps buttons={view.buttons} playing={playing} live={live} running={runningButton} done={stepsDone} onRun={runButton} />
          )}
          <div className="flex shrink-0 items-center gap-2 border-t border-white/5 px-3 py-1.5" data-tuner-footer>
            {busy > 0 && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-zinc-500" />}
            <span
              className={`min-w-0 flex-1 truncate text-[11px] ${phone && !notice && !copied && unsavedCount(unsaved) > 0 ? 'hidden' : ''} ${notice?.error ? 'text-amber-300/90' : notice ? 'text-zinc-300' : 'text-zinc-500'}`}
              title={notice?.text ?? copied ?? undefined}
              data-tuner-hint
              data-tuner-notice={notice ? (notice.error ? 'error' : 'ok') : undefined}
            >
              {notice?.text ??
                copied ??
                (!playing
                  ? unsavedCount(unsaved) === 0 && playLeft > 0
                    ? `${playLeft} Play Mode ${playLeft === 1 ? 'change' : 'changes'} went back on Stop.${filter && viewName ? ` Copy Changes still lists ${playLeft === 1 ? 'it' : 'them'}.` : ''}`
                    : unsavedCount(unsaved) === 0
                    ? `Your edits change the ${view?.kind === 'prefabs' ? 'prefab' : 'scene'} right away, and Undo works. Save writes them to disk.`
                    : 'Your edits are in memory until you save. Undo still works.'
                  : totalCount === 0
                    ? 'Scene values go back when Play Mode ends. Asset edits are saved right away.'
                    : multiState
                      ? `${activeCount} ${activeCount === 1 ? 'change' : 'changes'} here · ${totalCount} in all states`
                      : `${totalCount} Play Mode ${totalCount === 1 ? 'change' : 'changes'} to scene objects`)}
            </span>
            {view && view.buttons.some((b) => !b.step) && (
              <div className="flex min-w-0 shrink items-center gap-1 overflow-x-auto" data-tuner-buttons>
                {view.buttons.map((b, i) => b.step ? null : (
                  <button
                    key={b.label}
                    type="button"
                    disabled={!live || runningButton != null || !buttonModeOk(b, playing)}
                    onClick={() => runButton(i)}
                    title={b.tip ?? `${b.type ?? b.asset ?? `${b.path} ${b.component}`}.${b.method}()`}
                    className="flex shrink-0 items-center gap-1 rounded border border-white/10 px-2 py-1 text-xs text-zinc-300 hover:bg-white/10 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
                  >
                    {runningButton === i && <Loader2 className="h-3 w-3 animate-spin" />}
                    {b.label}
                  </button>
                ))}
              </div>
            )}
            <UnsavedMarker unsaved={unsaved} playing={playing} busy={!live || busy > 0} compact={phone} onSave={saveAll} onDiscard={(el) => void discardAll(el)} />
            {playing && (
              <>
              <div className="relative shrink-0" ref={resetRef}>
                <button
                  type="button"
                  disabled={!live || busy > 0 || (multiState ? totalCount === 0 : activeCount === 0)}
                  onClick={() => {
                    if (multiState) {
                      setConfirmAll(false)
                      setResetOpen((o) => !o)
                    } else resetChanges({})
                  }}
                  data-ti-tip={multiState ? 'Put the scene objects back the way they were' : 'Put every changed scene object back'}
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
                >
                  <RotateCcw className="h-3 w-3" />
                  Reset
                  {multiState && <ChevronUp className="h-3 w-3 text-zinc-500" />}
                </button>
                {resetOpen && (
                  <div ref={resetMenuRef} className="surface-overlay fixed left-0 top-0 z-30 w-60 rounded-lg py-1">
                    <button
                      type="button"
                      disabled={activeCount === 0}
                      onClick={() => {
                        closeReset()
                        resetChanges({})
                      }}
                      className="flex w-full flex-col items-start px-2.5 py-1 text-left hover:bg-white/5 disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      <span className="text-xs text-zinc-200">Reset this state</span>
                      <span className="truncate text-[10px] text-zinc-500">
                        {activeCount} {activeCount === 1 ? 'change' : 'changes'} in {activeInfo?.label || activeState}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!confirmAll) {
                          setConfirmAll(true)
                          return
                        }
                        closeReset()
                        resetChanges({ state: '*' })
                      }}
                      className={`flex w-full flex-col items-start px-2.5 py-1 text-left ${
                        confirmAll ? 'bg-amber-500/10 hover:bg-amber-500/15' : 'hover:bg-white/5'
                      }`}
                    >
                      <span className={`text-xs ${confirmAll ? 'text-amber-200' : 'text-zinc-200'}`}>
                        {confirmAll ? 'Click again to reset everything' : 'Reset all states'}
                      </span>
                      <span className="text-[10px] text-zinc-500">
                        {totalCount} {totalCount === 1 ? 'change' : 'changes'} in {statesWithChanges}{' '}
                        {statesWithChanges === 1 ? 'state' : 'states'}
                      </span>
                    </button>
                  </div>
                )}
              </div>
              </>
            )}
            {(filter || restorable) && viewName && (
              <button
                type="button"
                data-tuner-copy-changes
                disabled={busy > 0}
                onClick={copyChanges}
                data-ti-tip="Copy what you changed here, to paste to the agent"
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded bg-accent px-3 py-1 text-xs font-medium text-accent-fg enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-zinc-500"
              >
                {copied === COPIED_CHANGES ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                Copy Changes
              </button>
            )}
          </div>
        </div>
      )}
      {overlayCard && viewName && (
        <div
          data-tuner-state-card={panel.name}
          className={`absolute inset-0 z-30 flex items-center justify-center p-4${panel.name === 'refreshing' ? ' bg-black/45' : ' bg-canvas'}`}
        >
          {overlayCard}
        </div>
      )}
    </div>
  )
}
