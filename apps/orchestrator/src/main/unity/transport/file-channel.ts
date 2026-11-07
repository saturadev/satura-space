
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
  statSync,
  unlinkSync,
  watch as fsWatch,
  type FSWatcher
} from 'node:fs'
import { join } from 'node:path'
import {
  COMMAND_ACK_FILE,
  COMMAND_LOG_FILE,
  FEEDBACK_FILE,
  WORLD_SNAPSHOT_FILE,
  emptyCommandAckFile,
  emptyCommandLog,
  type CommandAckFile,
  type CommandLogFile,
  type FeedbackManifestFile,
  type UnityCommand,
  type WorldSnapshotFile
} from '@shared/unity/protocol'
import { ensureSspaceForSync } from '../../sspace'

export interface FileChannelChange {
  world: boolean
  acks: boolean
  feedback: boolean
}

const WATCH_DEBOUNCE_MS = 50
const POLL_INTERVAL_MS = 250
const WATCHED_POLL_INTERVAL_MS = 1000

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf8')
    if (!raw.trim()) return null
    return JSON.parse(raw) as T
  } catch (e) {
    console.log(`[file-channel] read failed: ${path}: ${(e as Error)?.message}`)
    return null
  }
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_ATTEMPTS = 20
const sleepCell = new Int32Array(new SharedArrayBuffer(4))

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || !RENAME_RETRY_CODES.has(code) || attempt >= RENAME_ATTEMPTS) {
        try {
          unlinkSync(from)
        } catch {
        }
        throw e
      }
      Atomics.wait(sleepCell, 0, 0, Math.min(5 * attempt, 40))
    }
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`
  writeFileSync(tmp, JSON.stringify(value))
  renameWithRetry(tmp, path)
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

export class FileChannel {
  private readonly commandsPath: string
  private readonly acksPath: string
  private readonly worldPath: string
  private readonly feedbackPath: string
  private nextId: number
  private acksCache: { m: number; v: CommandAckFile } | null = null
  private worldCache: { m: number; v: WorldSnapshotFile | null } | null = null
  private feedbackCache: { m: number; v: FeedbackManifestFile | null } | null = null

  constructor(private readonly dir: string) {
    this.commandsPath = join(dir, COMMAND_LOG_FILE)
    this.acksPath = join(dir, COMMAND_ACK_FILE)
    this.worldPath = join(dir, WORLD_SNAPSHOT_FILE)
    this.feedbackPath = join(dir, FEEDBACK_FILE)
    this.nextId = this.reseedNextId()
  }

  private reseedNextId(): number {
    let max = 0
    const log = readJson<CommandLogFile>(this.commandsPath)
    if (log?.commands) for (const c of log.commands) if (c.id > max) max = c.id
    const acks = readJson<CommandAckFile>(this.acksPath)
    if (acks && acks.ackedCursor > max) max = acks.ackedCursor
    return max
  }

  allocateId(): number {
    return ++this.nextId
  }

  appendCommand(cmd: Omit<UnityCommand, 'id' | 'ts'> & { id?: number; ts?: number }): UnityCommand {
    const acks = this.readAcks()
    const log = readJson<CommandLogFile>(this.commandsPath) ?? emptyCommandLog()
    const full: UnityCommand = {
      id: cmd.id ?? this.allocateId(),
      ts: cmd.ts ?? Date.now(),
      target: cmd.target,
      kind: cmd.kind,
      ...(cmd.args !== undefined ? { args: cmd.args } : {})
    }
    const kept = log.commands.filter((c) => c.id > acks.ackedCursor)
    kept.push(full)
    ensureSspaceForSync(this.dir)
    atomicWriteJson(this.commandsPath, { schema: 1, commands: kept } satisfies CommandLogFile)
    return full
  }

  readAcks(): CommandAckFile {
    const m = mtimeMs(this.acksPath)
    if (this.acksCache && this.acksCache.m === m) return this.acksCache.v
    const raw = readJson<CommandAckFile>(this.acksPath)
    const v: CommandAckFile = raw
      ? {
          schema: 1,
          ackedCursor: raw.ackedCursor ?? 0,
          acks: (raw.acks ?? []).map((a) => ({
            ...a,
            error: a.error === '' ? null : (a.error ?? null)
          }))
        }
      : emptyCommandAckFile()
    this.acksCache = { m, v }
    return v
  }

  readWorld(): WorldSnapshotFile | null {
    const m = mtimeMs(this.worldPath)
    if (this.worldCache && this.worldCache.m === m) return this.worldCache.v
    const v = readJson<WorldSnapshotFile>(this.worldPath)
    this.worldCache = { m, v }
    return v
  }

  readFeedback(): FeedbackManifestFile | null {
    const m = mtimeMs(this.feedbackPath)
    if (this.feedbackCache && this.feedbackCache.m === m) return this.feedbackCache.v
    const v = readJson<FeedbackManifestFile>(this.feedbackPath)
    this.feedbackCache = { m, v }
    return v
  }

  watch(cb: (change: FileChannelChange) => void): () => void {
    let pendingWorld = false
    let pendingAcks = false
    let pendingFeedback = false
    let debounce: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    let lastWorldM = mtimeMs(this.worldPath)
    let lastAcksM = mtimeMs(this.acksPath)
    let lastFeedbackM = mtimeMs(this.feedbackPath)

    const flush = (): void => {
      debounce = null
      if (disposed) return
      const change: FileChannelChange = {
        world: pendingWorld,
        acks: pendingAcks,
        feedback: pendingFeedback
      }
      pendingWorld = false
      pendingAcks = false
      pendingFeedback = false
      if (change.world || change.acks || change.feedback) {
        try {
          cb(change)
        } catch (e) {
          console.log(`[file-channel] watch cb threw: ${(e as Error).message}`)
        }
      }
    }

    const mark = (world: boolean, acks: boolean, feedback = false): void => {
      if (world) pendingWorld = true
      if (acks) pendingAcks = true
      if (feedback) pendingFeedback = true
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(flush, WATCH_DEBOUNCE_MS)
    }

    const pollTick = (): void => {
      if (disposed) return
      const wm = mtimeMs(this.worldPath)
      const am = mtimeMs(this.acksPath)
      const fm = mtimeMs(this.feedbackPath)
      const world = wm !== lastWorldM
      const acks = am !== lastAcksM
      const feedback = fm !== lastFeedbackM
      lastWorldM = wm
      lastAcksM = am
      lastFeedbackM = fm
      if (world || acks || feedback) mark(world, acks, feedback)
    }
    let poll: ReturnType<typeof setInterval> | null = null
    let pollMs = 0
    const startPoll = (ms: number): void => {
      if (poll && pollMs === ms) return
      if (poll) clearInterval(poll)
      pollMs = ms
      poll = setInterval(pollTick, ms)
    }

    let watcher: FSWatcher | null = null
    try {
      watcher = fsWatch(this.dir, (_evt, filename) => {
        if (!filename) {
          mark(true, true, true)
          return
        }
        const name = filename.toString()
        if (name === WORLD_SNAPSHOT_FILE) mark(true, false)
        else if (name === COMMAND_ACK_FILE) mark(false, true)
        else if (name === FEEDBACK_FILE) mark(false, false, true)
      })
      watcher.on('error', () => {
        if (!disposed) startPoll(POLL_INTERVAL_MS)
      })
    } catch {
    }

    startPoll(watcher ? WATCHED_POLL_INTERVAL_MS : POLL_INTERVAL_MS)

    return () => {
      disposed = true
      if (debounce) clearTimeout(debounce)
      if (poll) clearInterval(poll)
      try {
        watcher?.close()
      } catch {
      }
    }
  }
}
