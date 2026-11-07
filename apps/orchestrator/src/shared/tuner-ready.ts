export const EDITOR_REVEALED_ERROR = 'The Unity editor is revealed. Hide it to use the Tuner.'

export function isEditorRevealedError(error: string | null | undefined): boolean {
  return !!error && error === EDITOR_REVEALED_ERROR
}

export const HEADLESS_GRAPHICS_ERROR = "The Tuner doesn't work while Unity runs in Headless (graphics) mode. Switch Unity to Normal to use it."

export function isHeadlessGraphicsError(error: string | null | undefined): boolean {
  return !!error && error === HEADLESS_GRAPHICS_ERROR
}

export type TunerPhase = 'idle' | 'starting' | 'live' | 'waiting'

export interface TunerReadyInput {
  view: string | null
  viewsLoaded: boolean
  viewFound: boolean
  scratchpadDown: boolean
  phase: TunerPhase
  error: string | null
  needsFrame: boolean
  framed: boolean
}

export type TunerReadiness = { ready: true; state: '' } | { ready: false; state: string }

export interface TunerPaneState {
  view: string
  ready: boolean
  state: string
  show?: string
  target?: string
}

function not(state: string): TunerReadiness {
  return { ready: false, state }
}

export function tunerWaitingState(error: string | null): string {
  const e = error ?? ''
  if (isEditorRevealedError(e)) return 'the Unity editor is revealed'
  if (isHeadlessGraphicsError(e)) return 'Unity runs in Headless (graphics) mode, which the Tuner does not support'
  if (/won't switch scenes/.test(e)) return "its scene isn't open in Unity"
  if (/lost the connection|reconnecting/i.test(e)) return "the Unity editor isn't connected"
  if (/play mode stopped|reloading|stopped|ended/i.test(e)) return 'the session ended'
  return "it can't reach the scene"
}

export function tunerReadiness(i: TunerReadyInput): TunerReadiness {
  if (!i.view) return not('no view is picked')
  if (!i.viewsLoaded) return not("it's still loading its view")
  if (!i.viewFound) return not('the view no longer exists')
  if (i.scratchpadDown && i.phase !== 'live') return not("its scratchpad isn't running")
  if (i.phase === 'waiting') return not(tunerWaitingState(i.error))
  if (i.phase !== 'live') return not("it's still connecting to the Unity editor")
  if (i.needsFrame && !i.framed) return not("it's waiting for its first frame")
  return { ready: true, state: '' }
}

export function tunerNotReadyMessage(pane: Pick<TunerPaneState, 'view' | 'state'>): string {
  const name = pane.view ? `Tuner "${pane.view}"` : 'The Tuner'
  return `${name} isn't ready: ${pane.state || "it's still starting"}`
}

export function tunerStillLoadingMessage(pane: Pick<TunerPaneState, 'view' | 'state'>, ms: number): string {
  const name = pane.view ? `Tuner "${pane.view}"` : 'The Tuner'
  return `${name} was still loading after ${Math.round(ms / 1000)} s (${pane.state || 'Unity is busy'}), so nothing was done. Try again once it shows the scene.`
}

export function readyTunerPane(panes: readonly TunerPaneState[], view?: string, target?: string): { ready: TunerPaneState | null; blocked: TunerPaneState | null } {
  const mine = panes.filter((p) => (!view || p.view === view) && (!target || !p.target || p.target === target))
  return { ready: mine.find((p) => p.ready) ?? null, blocked: mine.find((p) => !p.ready) ?? null }
}
