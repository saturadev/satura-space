import type { HubState } from '../api'
import type { CompileState, Lifecycle } from './world'

export const LIFECYCLE_CHANNEL = 'unity:lifecycle'

export type UnityPhase =
  | 'idle'
  | 'missing'
  | 'installing'
  | 'hub'
  | 'stopped'
  | 'refused'
  | 'launching'
  | 'importing'
  | 'compiling'
  | 'ready'
  | 'failed'

export type UnityState = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed' | 'exited'

export type UnityStage = '' | 'preparing' | 'hub' | 'installing' | 'launching' | 'importing' | 'compiling' | 'restarting'

export type UnityFailCode =
  | ''
  | 'guard'
  | 'locked'
  | 'input-system'
  | 'project'
  | 'version-missing'
  | 'hub'
  | 'license'
  | 'env'
  | 'engine'
  | 'compile'
  | 'safe-mode'
  | 'exited-early'
  | 'crashed'
  | 'hung'
  | 'timeout'
  | 'error'

export type UnityStateAction = 'retry' | 'install' | 'start-hub' | 'open-project' | 'close-other'

export const START_PREPARE_DEADLINE_MS = 180_000

export const GATE_PHASES: ReadonlySet<UnityPhase> = new Set<UnityPhase>(['missing', 'installing', 'hub'])
export const BUSY_PHASES: ReadonlySet<UnityPhase> = new Set<UnityPhase>(['launching', 'importing', 'compiling'])

export interface UnityDialog {
  id: string
  title: string
  message: string
  buttons: string[]
}

export function dialogButtonLabel(raw: string): string {
  return raw.replace(/&&/g, '\u0000').replace(/&/g, '').replace(/\u0000/g, '&')
}

export interface UnityInstall {
  state: 'queued' | 'downloading' | 'installing'
  pct: number
}

export interface EditorVersionFacts {
  version: string
  revision: string
  installed: boolean
  editors: string[]
  install: UnityInstall | null
}

export interface EditorInstanceFacts {
  pid: number | null
  version: string
  exited: boolean
  exitCode: number | null
  exitSignal: string | null
  restarting: boolean
  booted: boolean
  lifecycle: Lifecycle | null
  compile: CompileState | null
  compileError: string | null
  error: string | null
  stuck: boolean
  fault: string
  faultKind: 'crashed' | 'hung' | ''
  bootFailure: string
  bootCode: UnityFailCode
  progressLabel: string
  progressPct: number
  stall: string
  dialog: UnityDialog | null
}

export interface LifecycleFacts {
  version: EditorVersionFacts
  hub: HubState
  hubError: string
  stopped: boolean
  closing: boolean
  wanted: boolean
  relaunch: boolean
  launching: boolean
  launches: number
  refusal: string
  refusalCode: UnityFailCode
  failure: string
  failureCode: UnityFailCode
  instance: EditorInstanceFacts | null
}

interface UnityLifecycleView {
  phase: UnityPhase
  gen: number
  version: string
  revision: string
  editors: string[]
  install: UnityInstall | null
  hub: HubState
  pid: number | null
  running: string
  booted: boolean
  lifecycle: Lifecycle | null
  compileError: string | null
  progress: string
  stall: string
  dialog: UnityDialog | null
  waiting: boolean
  error: string
  next: string
  state: UnityState
  stage: UnityStage
  code: UnityFailCode
  actions: UnityStateAction[]
  exitCode: number | null
}

export interface UnityLifecycle extends UnityLifecycleView {
  project: string
  boot: string
  seq: number
  since: number
  stateSince?: number
}

export interface UnityStateTransition {
  at: number
  seq: number
  from: string
  to: string
  why: string
}

export const STOPPED_ERROR = 'Unity is stopped for this project.'
export const STOPPED_NEXT = 'unity.relaunch() starts it again. If you did not stop it yourself, the user did: ask before starting it.'
const RELAUNCH_NEXT = 'Fix what the log shows, then unity.relaunch().'

function have(editors: string[]): string {
  return editors.length ? `You have ${editors.join(', ')} installed.` : 'No Unity editors are installed.'
}

export function missingError(version: string, editors: string[]): string {
  return `This project needs Unity ${version}, which isn't installed. ${have(editors)}`
}

export function missingNext(version: string): string {
  return `Ask the user to install Unity ${version} in Unity Hub (the Unity panel's Install button opens it there). unity.relaunch({ timeout: 1800 }) waits for the install and then starts the editor.`
}

function installLabel(install: UnityInstall): string {
  const pct = install.pct >= 0 ? ` ${Math.round(install.pct)}%` : ''
  return install.state === 'installing' ? `installing${pct}` : install.state === 'queued' ? 'queued' : `downloading${pct}`
}

export function progressText(label: string, pct: number): string {
  if (!label) return ''
  return pct >= 0 ? `${label} ${Math.round(pct)}%` : label
}

interface StateBits {
  state: UnityState
  stage: UnityStage
  code: UnityFailCode
  actions: UnityStateAction[]
  exitCode: number | null
}

const idleBits: StateBits = { state: 'idle', stage: '', code: '', actions: [], exitCode: null }

function starting(stage: UnityStage): StateBits {
  return { state: 'starting', stage, code: '', actions: [], exitCode: null }
}

export function failActions(code: UnityFailCode): UnityStateAction[] {
  switch (code) {
    case 'guard':
      return ['retry', 'open-project']
    case 'locked':
      return ['close-other', 'retry', 'open-project']
    case 'project':
      return ['open-project']
    case 'version-missing':
      return ['install', 'retry', 'open-project']
    case 'hub':
    case 'license':
      return ['start-hub', 'retry']
    case 'input-system':
      return ['retry', 'open-project']
    default:
      return ['retry']
  }
}

function failing(code: UnityFailCode, exitCode: number | null = null): StateBits {
  return { state: 'failed', stage: '', code, actions: failActions(code), exitCode }
}

function textCode(text: string, fallback: UnityFailCode): UnityFailCode {
  return /no valid .*licen[cs]e|licen[cs]e .*(fail|invalid|expired)/i.test(text) ? 'license' : fallback
}

export function composeLifecycle(f: LifecycleFacts): UnityLifecycleView {
  const v = f.version
  const inst = f.instance
  const alive = !!inst && !inst.exited
  const gate: UnityPhase | null = v.version && !v.installed ? (v.install ? 'installing' : 'missing') : null
  const base = {
    gen: f.launches,
    version: v.version,
    revision: v.revision,
    editors: v.editors,
    install: v.install,
    hub: f.hub,
    pid: alive ? inst.pid : null,
    running: alive ? inst.version : '',
    booted: alive && inst.booted,
    lifecycle: inst ? inst.lifecycle : null,
    compileError: alive ? inst.compileError : null,
    progress: alive ? progressText(inst.progressLabel, inst.progressPct) : '',
    stall: alive ? inst.stall : '',
    dialog: alive ? inst.dialog : null,
    waiting: f.wanted || f.relaunch
  }
  const out = (phase: UnityPhase, bits: StateBits, error = '', next = ''): UnityLifecycleView => ({ ...base, phase, error, next, ...bits })
  const gated = (phase: UnityPhase): UnityLifecycleView =>
    phase === 'installing' && v.install
      ? out(phase, starting('installing'), `Unity Hub is installing Unity ${v.version} (${installLabel(v.install)}).`, 'The editor starts when the install finishes. unity.relaunch() waits for it.')
      : out('missing', failing('version-missing'), missingError(v.version, v.editors), missingNext(v.version))
  const view = ((): UnityLifecycleView => {
    if (f.stopped && !alive && !f.launching) return out('stopped', { ...idleBits, state: 'stopped', actions: ['retry'] }, STOPPED_ERROR, STOPPED_NEXT)
    if (f.relaunch && gate) return gated(gate)
    if (alive) {
      const ready = inst.booted && !!inst.lifecycle && inst.lifecycle !== 'init' && inst.lifecycle !== 'launching' && inst.lifecycle !== 'restarting'
      const busy = (stage: UnityStage): StateBits => (ready ? { ...idleBits, state: 'ready' } : starting(stage))
      if (inst.restarting) return out('launching', starting('restarting'))
      if (inst.fault) return out('failed', failing(inst.faultKind || 'crashed'), inst.fault, RELAUNCH_NEXT)
      if (inst.bootFailure) return out('failed', failing(inst.bootCode || 'error'), inst.bootFailure, RELAUNCH_NEXT)
      if (inst.error && !inst.stuck) return out('failed', failing(textCode(inst.error, 'error')), inst.error, RELAUNCH_NEXT)
      if (inst.lifecycle === 'error') return out('failed', failing('error'), 'Unity reported an error. See the Console.', RELAUNCH_NEXT)
      if (inst.stuck && !ready) return out('failed', failing('timeout'), inst.error ?? 'Unity stopped making progress while starting.', RELAUNCH_NEXT)
      if (inst.compile === 'compiling') return out('compiling', busy('compiling'))
      if (/import/i.test(inst.progressLabel)) return out('importing', busy('importing'))
      if (/compil/i.test(inst.progressLabel)) return out('compiling', busy('compiling'))
      if (!ready) return out('launching', starting('launching'))
      if (inst.lifecycle === 'exited') return out('failed', failing('exited-early'), 'Unity exited.', RELAUNCH_NEXT)
      const up: StateBits = { ...idleBits, state: 'ready' }
      if (inst.compileError) return out('ready', up, `The project has compile errors: ${inst.compileError}`, 'Fix them (unity.logs({ severity: "error" })), then unity.refresh().')
      if (inst.version && v.version && inst.version !== v.version)
        return out(
          'ready',
          up,
          `This editor runs Unity ${inst.version}, but ProjectVersion.txt now asks for Unity ${v.version}${gate === 'installing' && v.install ? `, which Unity Hub is installing (${installLabel(v.install)})` : gate ? ", which isn't installed" : ''}.`,
          gate === 'installing' ? `unity.relaunch() waits for the install and restarts it on Unity ${v.version}.` : gate ? missingNext(v.version) : `unity.relaunch() restarts it on Unity ${v.version}.`
        )
      return out('ready', up)
    }
    if (gate) return gated(gate)
    if (f.launching) return out('launching', starting('preparing'))
    if (inst && inst.exited) {
      const signal = inst.exitSignal ? `Unity was killed by ${inst.exitSignal}.` : ''
      const coded = inst.exitCode ? `Unity exited with code ${inst.exitCode}${inst.booted ? '' : ' before it finished starting'}.` : ''
      const why = inst.fault || inst.bootFailure || inst.error || signal || coded
      const code: UnityFailCode = inst.fault
        ? inst.faultKind || 'crashed'
        : inst.bootFailure
          ? inst.bootCode || 'exited-early'
          : inst.error
            ? textCode(inst.error, inst.booted ? 'crashed' : 'exited-early')
            : signal || inst.booted
              ? 'crashed'
              : 'exited-early'
      if (why) return out('failed', failing(code, inst.exitCode), why, RELAUNCH_NEXT)
      if (!inst.booted) return out('failed', failing('exited-early', inst.exitCode), 'Unity quit before it finished starting.', RELAUNCH_NEXT)
      return out('idle', { ...idleBits, state: 'exited', actions: ['retry'], exitCode: inst.exitCode }, 'Unity exited.', 'Relaunch it from the Unity panel, or call unity.relaunch().')
    }
    if (f.wanted && f.hub !== 'ready') return out('hub', f.hub === 'starting' ? starting('hub') : failing(f.hub === 'signed-out' ? 'license' : 'hub'), f.hubError)
    if (f.refusal) return out('refused', failing(f.refusalCode || 'error'), f.refusal)
    if (f.failure) return out('failed', failing(f.failureCode || textCode(f.failure, 'error')), f.failure, RELAUNCH_NEXT)
    if (f.wanted || f.relaunch) return out('launching', starting('preparing'))
    return out('idle', idleBits, '', 'Open the Unity panel, or call unity.relaunch().')
  })()
  if ((f.stopped || f.closing) && alive) return { ...view, state: 'stopping', stage: '', code: '', actions: [], exitCode: null }
  return view
}

export function stateLabel(l: Pick<UnityLifecycleView, 'state' | 'stage' | 'code' | 'lifecycle'>): string {
  if (l.state === 'starting') return `starting(${l.stage || 'preparing'})`
  if (l.state === 'failed') return `failed(${l.code || 'error'})`
  if (l.state === 'ready') return `ready(${l.lifecycle ?? 'up'})`
  return l.state
}

const FAIL_TITLES: Record<Exclude<UnityFailCode, ''>, string> = {
  guard: 'Another app is using this project',
  locked: 'Another Unity has this project open',
  'input-system': 'This project needs the Input System',
  project: "This folder can't be opened as a Unity project",
  'version-missing': "This project's Unity version isn't installed",
  hub: "Unity Hub isn't ready",
  license: 'Unity has no license to start',
  env: "Satura Space couldn't prepare the project",
  engine: "Satura Space couldn't update its engine package",
  compile: 'C# compile errors stop Unity from starting',
  'safe-mode': 'Unity started in Safe Mode',
  'exited-early': 'Unity quit while starting',
  crashed: 'Unity crashed',
  hung: 'Unity stopped responding',
  timeout: 'Unity is taking too long to start',
  error: "Unity couldn't start"
}

const STAGE_TEXT: Record<Exclude<UnityStage, ''>, string> = {
  preparing: 'Preparing the project',
  hub: 'Waiting for Unity Hub',
  installing: 'Unity Hub is installing Unity',
  launching: 'Starting Unity',
  importing: 'Importing assets',
  compiling: 'Compiling scripts',
  restarting: 'Restarting Unity'
}

export function stateTitle(l: Pick<UnityLifecycleView, 'state' | 'stage' | 'code' | 'exitCode'>): string {
  if (l.state === 'failed') return FAIL_TITLES[l.code || 'error']
  if (l.state === 'starting') return `${STAGE_TEXT[l.stage || 'preparing']}…`
  if (l.state === 'stopping') return 'Closing Unity…'
  if (l.state === 'stopped') return 'Unity stopped'
  if (l.state === 'exited') return `Unity exited${l.exitCode !== null ? ` (code ${l.exitCode})` : ''}`
  if (l.state === 'ready') return 'Unity is ready'
  return 'Unity is not running'
}

export const STATE_ACTION_LABELS: Record<UnityStateAction, string> = {
  retry: 'Retry',
  install: 'Install in Unity Hub',
  'start-hub': 'Start Unity Hub',
  'open-project': 'Open another project',
  'close-other': 'Close the other Unity'
}

export function dialogText(d: UnityDialog): string {
  return `'${d.title || 'untitled'}' (${d.buttons.map(dialogButtonLabel).join(', ') || 'no buttons'})`
}

function sameDialog(a: UnityDialog | null, b: UnityDialog | null): boolean {
  if (!a || !b) return a === b
  return a.id === b.id && a.title === b.title && a.message === b.message && a.buttons.join('\n') === b.buttons.join('\n')
}

export function stateWhy(l: UnityLifecycleView): string {
  const pid = l.pid ? `pid ${l.pid}` : ''
  if (l.state === 'failed' || l.state === 'exited') return (l.error || stateTitle(l)).split('\n')[0].slice(0, 240)
  if (l.state === 'starting') return [l.progress, l.stall, pid].filter(Boolean).join(', ') || STAGE_TEXT[l.stage || 'preparing'].toLowerCase()
  if (l.state === 'ready') return [pid, l.running || l.version ? `Unity ${l.running || l.version}` : ''].filter(Boolean).join(', ') || 'editor up'
  if (l.state === 'stopping') return `closing the editor${pid ? ` ${pid}` : ''}`
  if (l.state === 'stopped') return 'Unity is stopped for this project'
  return 'no editor runs and none was asked for'
}

export function sameLifecycle(a: UnityLifecycleView, b: UnityLifecycleView): boolean {
  return (
    a.phase === b.phase &&
    a.gen === b.gen &&
    a.version === b.version &&
    a.revision === b.revision &&
    a.editors.join('\n') === b.editors.join('\n') &&
    a.install?.state === b.install?.state &&
    Math.round(a.install?.pct ?? -1) === Math.round(b.install?.pct ?? -1) &&
    a.hub === b.hub &&
    a.pid === b.pid &&
    a.running === b.running &&
    a.booted === b.booted &&
    a.lifecycle === b.lifecycle &&
    a.compileError === b.compileError &&
    a.progress === b.progress &&
    a.stall === b.stall &&
    sameDialog(a.dialog, b.dialog) &&
    a.waiting === b.waiting &&
    a.error === b.error &&
    a.next === b.next &&
    a.state === b.state &&
    a.stage === b.stage &&
    a.code === b.code &&
    a.exitCode === b.exitCode &&
    a.actions.join(' ') === b.actions.join(' ')
  )
}

export function lifecycleText(l: UnityLifecycleView): string {
  const pid = l.pid ? `, pid ${l.pid}` : ''
  const head =
    l.phase === 'ready'
      ? `Unity: ready (${l.lifecycle === 'playing' ? 'Play Mode' : l.lifecycle === 'editmode' ? 'Edit Mode' : (l.lifecycle ?? 'up')}${pid}, Unity ${l.running || l.version})`
      : l.phase === 'launching' || l.phase === 'importing' || l.phase === 'compiling'
        ? `Unity: ${l.phase}${l.progress ? ` (${l.progress}${pid})` : pid ? ` (${pid.slice(2)})` : ''}`
        : `Unity: ${l.phase}`
  const parts = [head, `State: ${stateLabel(l)}`]
  if (l.dialog) parts.push(`A Unity dialog waits for an answer: ${dialogText(l.dialog)}. unity.answer(button) answers it.`)
  if (l.error) parts.push(l.error)
  if (l.stall) parts.push(l.stall)
  if (l.next) parts.push(`Next: ${l.next}`)
  return parts.join('\n  ')
}

export type RelaunchStep = 'wait' | 'done' | 'fail'

export function relaunchStep(l: UnityLifecycleView, before: Pick<UnityLifecycleView, 'gen' | 'phase' | 'error' | 'pid'>): RelaunchStep {
  if (l.phase === 'ready') return l.gen > before.gen && (before.pid === null || l.pid !== before.pid) ? 'done' : 'wait'
  if (l.phase === 'missing' || l.phase === 'installing' || l.phase === 'idle' || BUSY_PHASES.has(l.phase)) return 'wait'
  if (l.phase === 'hub') return l.hub === 'starting' ? 'wait' : 'fail'
  return l.gen > before.gen || l.phase !== before.phase || l.error !== before.error ? 'fail' : 'wait'
}
