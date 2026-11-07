import { MAX_PLAYERS, type UnityMode } from '@shared/unity/world'
import { formatSize, parseSize, streamSizeFor, type SavedStreamResolution } from '@shared/unity/stream-size'
import { DEFAULT_PRESET, PRESET_GROUPS } from '../unity/stream-presets'
import { section, compact, type ActionNode } from './action-tree'

export interface UnityControls {
  canStop: boolean
  showPlayToggle: boolean
  playingNow: boolean
  paused: boolean
  inEdit: boolean
  stopped: boolean
  stopping: boolean
  streaming: boolean
  locks: { playStop?: boolean; addPlayer?: boolean; removePlayer?: boolean; scene?: boolean; relaunch?: boolean }
  count: number
  multiplayerAllowed: boolean
  armed: boolean
  canArm: boolean
  focusedMuted: boolean
  focusedVolume: number
  audioCount: number
  focusedIdx: number
  scenes: string[]
  recentScenes: string[]
  selectedScene: string
  sceneDirty: boolean
  unityMode: UnityMode
  modes: { id: UnityMode; label: string }[]
  modeSwitchLocked: boolean
  revealed: boolean
  revealLocked: boolean
  refreshBlockedReason: string | null
  stopBlockedReason: string | null
  fpsCap: number
  fpsOptions: readonly number[]
  streamRes: string
  savedResolutions: SavedStreamResolution[]
  toggleRun: () => void
  togglePause: () => void
  stepFrame: () => void
  addPlayer: () => void
  removePlayer: () => void
  toggleMute: () => void
  onVolume: (v: number) => void
  pickAudio: (i: number) => void
  toggleHotReload: () => void
  onScene: (scene: string) => void
  onNewScene: (path: string) => Promise<string | null>
  newSceneFolder: string
  onDiscardScene: () => void
  onRemoveRecentScene: (scene: string) => void
  onSetUnityMode: (mode: UnityMode) => void
  onToggleReveal: () => void
  onRevealSplit: () => void
  onRefresh: () => void
  onRestart: () => void
  onStop: () => void
  onFpsCap: (cap: number) => void
  onStreamRes: (res: string) => void
}

function sceneName(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.replace(/\.unity$/i, '')
}

export function unityNodes(c: UnityControls): ActionNode[] {
  const playLabel = c.showPlayToggle ? 'Play' : 'Stop'
  const relaunchEnabled = c.stopped ? !c.stopping : !c.locks.relaunch
  const current = formatSize(streamSizeFor(c.streamRes))
  const sizeNode = (key: string, label: string, w: number, h: number): ActionNode => {
    const size = formatSize({ width: w, height: h })
    return { id: `unity.res.${key}:${size}`, label, hint: size, checked: size === current, run: () => c.onStreamRes(size) }
  }
  const volumePct = Math.round((c.focusedMuted ? 0 : c.focusedVolume) * 100)
  const scenePick = (key: string, path: string): ActionNode => ({
    id: `unity.scene.${key}:${path}`,
    label: sceneName(path),
    hint: path.slice(0, path.lastIndexOf('/')),
    checked: path === c.selectedScene,
    enabled: !c.locks.scene,
    run: () => c.onScene(path)
  })
  const recent = c.recentScenes.filter((p) => c.scenes.includes(p))
  return compact([
    section('playback', [
      { id: 'unity.play', label: playLabel, icon: c.showPlayToggle ? 'play.fill' : 'stop.fill', primary: true, shortcut: 'mod+p', enabled: !c.locks.playStop, checked: !c.showPlayToggle, run: c.toggleRun },
      { id: 'unity.pause', label: 'Pause', icon: 'pause.fill', primary: true, enabled: c.playingNow, checked: c.playingNow && c.paused, run: c.togglePause },
      { id: 'unity.step', label: 'Step', icon: 'forward.frame.fill', primary: true, enabled: c.playingNow, run: c.stepFrame },
      !c.inEdit && c.streaming && { id: 'unity.hotReload', label: 'Hot Reload', icon: 'bolt.fill', enabled: c.armed || c.canArm, checked: c.armed, run: c.toggleHotReload }
    ]),
    section('players', [
      {
        id: 'unity.players',
        label: `Players: ${c.count}`,
        icon: 'person.2',
        children: [
          { id: 'unity.players.add', label: 'Add a player viewport', icon: 'plus', enabled: c.count < MAX_PLAYERS && !c.locks.addPlayer && c.multiplayerAllowed, run: c.addPlayer },
          { id: 'unity.players.remove', label: 'Remove a player viewport', icon: 'minus', enabled: c.count > 1 && !c.locks.removePlayer, run: c.removePlayer }
        ]
      },
      {
        id: 'unity.audio',
        label: c.focusedMuted ? 'Unmute' : 'Volume',
        icon: c.focusedMuted ? 'speaker.slash' : 'speaker.wave.2',
        children: compact([
          section('mute', [{ id: 'unity.mute', label: c.focusedMuted ? 'Unmute' : 'Mute', icon: c.focusedMuted ? 'speaker.wave.2' : 'speaker.slash', checked: c.focusedMuted, run: c.toggleMute }]),
          section('volume', [0, 25, 50, 75, 100].map((v) => ({ id: `unity.volume:${v}`, label: `Volume ${v}%`, checked: volumePct === v, run: () => c.onVolume(v) })), 'Volume'),
          c.audioCount > 1 &&
            section(
              'listen',
              Array.from({ length: c.audioCount }, (_, i) => ({ id: `unity.listen:${i}`, label: `Listen to Player ${i + 1}`, checked: c.focusedIdx === i, run: () => c.pickAudio(i) }))
            )
        ])
      }
    ]),
    section('scene', [
      {
        id: 'unity.scene',
        label: c.selectedScene ? sceneName(c.selectedScene) : 'Scene',
        icon: 'film.stack',
        enabled: c.scenes.length > 0 || c.inEdit,
        children: compact([
          recent.length > 0 && section('recent', recent.map((p) => scenePick('recent', p)), 'Recent'),
          section('all', c.scenes.filter((p) => !recent.includes(p)).map((p) => scenePick('all', p)), 'Scenes'),
          section('manage', [
            c.inEdit && !c.stopped && !c.locks.scene && {
              id: 'unity.scene.new',
              label: 'New Scene…',
              icon: 'plus',
              input: { title: 'New Scene', message: `Saved in ${c.newSceneFolder}`, placeholder: 'Scene name', submit: 'Create' },
              run: async (value) => {
                const name = String(value ?? '').trim().replace(/\.unity$/i, '')
                if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('Type a name without / \\ : * ? " < > |')
                const err = await c.onNewScene(`${c.newSceneFolder}/${name}.unity`)
                if (err) throw new Error(err)
              }
            },
            c.sceneDirty && c.inEdit && !c.stopped && !c.locks.scene && { id: 'unity.scene.discard', label: 'Discard the unsaved scene changes', icon: 'arrow.uturn.backward', destructive: true, run: c.onDiscardScene },
            recent.length > 0 && {
              id: 'unity.scene.removeRecent',
              label: 'Remove from recent',
              icon: 'clock.badge.xmark',
              children: recent.map((p) => ({ id: `unity.scene.removeRecent:${p}`, label: sceneName(p), run: () => c.onRemoveRecentScene(p) }))
            }
          ])
        ])
      }
    ]),
    section('editor', [
      {
        id: 'unity.mode',
        label: 'Unity mode & live editor options',
        icon: 'macwindow',
        children: compact([
          section(
            'modes',
            c.modes.map((m) => ({ id: `unity.mode:${m.id}`, label: m.label, checked: m.id === c.unityMode, enabled: m.id === c.unityMode || !c.modeSwitchLocked, run: () => c.onSetUnityMode(m.id) }))
          ),
          c.unityMode === 'normal' &&
            (c.inEdit || c.playingNow) &&
            section('reveal', [
              { id: 'unity.reveal', label: c.revealed ? 'Hide Editor' : 'Reveal Editor', icon: c.revealed ? 'eye.slash' : 'eye', checked: c.revealed, enabled: !c.revealLocked, run: c.onToggleReveal },
              !c.revealed && { id: 'unity.revealSplit', label: 'Reveal Split 50/50', icon: 'rectangle.split.2x1', enabled: !c.revealLocked, run: c.onRevealSplit }
            ])
        ])
      },
      {
        id: 'unity.lifecycle',
        label: c.canStop ? 'Refresh, relaunch or stop the Unity Player' : 'Refresh or relaunch the Unity Player',
        icon: 'arrow.clockwise',
        children: [
          { id: 'unity.refresh', label: 'Refresh', icon: 'arrow.clockwise', enabled: relaunchEnabled && !c.refreshBlockedReason, run: c.onRefresh },
          { id: 'unity.relaunch', label: 'Relaunch', icon: 'arrow.triangle.2.circlepath', enabled: relaunchEnabled, run: c.onRestart },
          ...(c.canStop ? [{ id: 'unity.stop', label: 'Stop', icon: 'power', destructive: true, enabled: relaunchEnabled && !c.stopBlockedReason, run: c.onStop }] : [])
        ]
      }
    ]),
    section('stream', [
      {
        id: 'unity.stream',
        label: 'Stream status & settings',
        icon: 'dot.radiowaves.left.and.right',
        children: [
          {
            id: 'unity.fps',
            label: 'Frame rate',
            icon: 'speedometer',
            children: [
              { id: 'unity.fps:0', label: 'Managed by game', checked: c.fpsCap <= 0, run: () => c.onFpsCap(0) },
              ...c.fpsOptions.map((o) => ({ id: `unity.fps:${o}`, label: `${o} fps`, checked: c.fpsCap === o, run: () => c.onFpsCap(o) }))
            ]
          },
          {
            id: 'unity.res',
            label: 'Resolution',
            icon: 'aspectratio',
            hint: current,
            children: compact([
              section('default', [sizeNode('default', `Default (${DEFAULT_PRESET.name})`, DEFAULT_PRESET.width, DEFAULT_PRESET.height)]),
              c.savedResolutions.length > 0 && section('saved', c.savedResolutions.map((r) => sizeNode('saved', r.name || formatSize(r), r.width, r.height)), 'Saved in this project'),
              ...PRESET_GROUPS.map((g, gi) => section(`group${gi}`, g.presets.map((q) => sizeNode(`g${gi}`, q.name, q.width, q.height)), g.title)),
              section('custom', [
                {
                  id: 'unity.res.custom',
                  label: 'Custom…',
                  icon: 'pencil',
                  input: { title: 'Stream resolution', placeholder: '1280x720', initial: current, submit: 'Apply' },
                  run: (value) => {
                    const size = parseSize(String(value ?? ''))
                    if (!size) throw new Error('Type a size like 1280x720')
                    c.onStreamRes(formatSize(size))
                  }
                }
              ])
            ])
          }
        ]
      }
    ])
  ])
}
