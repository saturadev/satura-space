
import type { ControlEvent } from '../control-protocol'
import type { InstanceDesired, InstanceObserved, WorldDesired, WorldObserved } from './world'

export const WORLD_EVENT = {
  snapshot: 'world/snapshot',
  patch: 'world/patch',
  desired: 'world/desired',
  progress: 'world/progress'
} as const

export interface WorldSnapshotEvent extends ControlEvent {
  event: typeof WORLD_EVENT.snapshot
  world: WorldObserved
  desired: WorldDesired
}

export interface WorldPatchEvent extends ControlEvent {
  event: typeof WORLD_EVENT.patch
  baseVersion: number
  version: number
  patch: WorldPatch
}

export type InstancePatch = Partial<InstanceObserved> | null

export interface WorldPatch {
  scenes?: string[]
  project?: Partial<WorldObserved['project']>
  instances?: Record<string, InstancePatch>
}

export type InstanceDesiredPatch = Partial<InstanceDesired> | null

export interface WorldDesiredPatch {
  playerCount?: number
  stopped?: boolean
  instances?: Record<string, InstanceDesiredPatch>
}

export interface WorldDesiredPatchEvent extends ControlEvent {
  event: typeof WORLD_EVENT.desired
  baseVersion: number
  version: number
  patch: WorldDesiredPatch
}

export type ProgressOp = 'launch' | 'compile' | 'import' | 'play' | 'reload'

export interface WorldProgressEvent extends ControlEvent {
  event: typeof WORLD_EVENT.progress
  instanceId: string
  op: ProgressOp
  phase: string
  pct?: number
  message?: string
}

export type WorldEvent =
  | WorldSnapshotEvent
  | WorldPatchEvent
  | WorldDesiredPatchEvent
  | WorldProgressEvent

export function isWorldEvent(e: ControlEvent): e is WorldEvent {
  return (
    e.event === WORLD_EVENT.snapshot ||
    e.event === WORLD_EVENT.patch ||
    e.event === WORLD_EVENT.desired ||
    e.event === WORLD_EVENT.progress
  )
}

export type CommandKind =
  | 'loadScene'
  | 'play'
  | 'stop'
  | 'pause'
  | 'step'
  | 'recompile'
  | 'reload'
  | 'setHotReload'
  | 'hotReloadPatch'
  | 'exec'
  | 'flushLogs'
  | 'screenshot'
  | 'quit'

export const TRANSIENT_COMMAND_KINDS: ReadonlySet<CommandKind> = new Set<CommandKind>([
  'exec',
  'flushLogs',
  'screenshot',
  'step'
])

export interface UnityCommand {
  id: number
  ts: number
  target: string
  kind: CommandKind
  args?: Record<string, unknown>
}

export type AckStatus = 'applied' | 'error' | 'skipped'

interface CommandAck {
  id: number
  target: string
  status: AckStatus
  error?: string | null
  resultVersion?: number
}

export interface WorldSnapshotFile {
  schema: 1
  world: WorldObserved
}

export interface CommandLogFile {
  schema: 1
  commands: UnityCommand[]
}

export interface CommandAckFile {
  schema: 1
  ackedCursor: number
  acks: CommandAck[]
}

export const WORLD_SNAPSHOT_FILE = 'world.json'
export const COMMAND_LOG_FILE = 'commands.json'
export const COMMAND_ACK_FILE = 'command_acks.json'
export const FEEDBACK_FILE = 'feedback.json'

export interface FeedbackManifestFile {
  schema: 1
  seq: number
  file: string
  timestamp: number
}

export function emptyCommandLog(): CommandLogFile {
  return { schema: 1, commands: [] }
}

export function emptyCommandAckFile(): CommandAckFile {
  return { schema: 1, ackedCursor: 0, acks: [] }
}
