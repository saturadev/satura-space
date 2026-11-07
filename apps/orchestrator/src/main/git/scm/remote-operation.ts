import type { ChildProcess } from 'node:child_process'
import type { ScmRemoteOperation, ScmRemoteProgress } from '@shared/git-scm'
import { censusTrack } from '@shared/census'
import { stopGitProcess } from '../git-queue'
import { GitError, GitErrorCodes, type SpawnOptions } from './git'

const QUIET_LIMIT_MS = 3 * 60 * 1000
const REMOTE_LIMIT_MS = 6 * 60 * 60 * 1000
const EMIT_MS = 150
const MAX_TEXT = 160
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

type RemoteProgressListener = (root: string, progress: ScmRemoteProgress | null) => void

const listeners = new Set<RemoteProgressListener>()
censusTrack('remote-operation.listeners', listeners)

export function onRemoteProgress(listener: RemoteProgressListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(root: string, progress: ScmRemoteProgress | null): void {
  for (const listener of listeners) {
    try {
      listener(root, progress)
    } catch {
    }
  }
}

function tidyLine(line: string): string {
  return line.replace(ANSI, '').replace(/^remote:\s*/, '').replace(/,?\s*done\.?$/, '').replace(/\s+/g, ' ').trim()
}

export function tidyProgressOutput(output: string): string {
  return output
    .split('\n')
    .map((line) => line.split('\r').map((part) => part.replace(ANSI, '').trimEnd()).filter(Boolean).pop() ?? '')
    .filter(Boolean)
    .join('\n')
}

export class RemoteOperation {
  private readonly children = new Set<ChildProcess>()
  private stopped: 'cancelled' | 'quiet' | undefined
  private partial = ''
  private text: string | undefined
  private emitTimer: NodeJS.Timeout | undefined
  private quietTimer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(readonly root: string, readonly operation: ScmRemoteOperation) {
    emit(root, { operation })
  }

  get spawnOptions(): SpawnOptions {
    return {
      progress: true,
      timeout: REMOTE_LIMIT_MS,
      env: { GIT_LFS_FORCE_PROGRESS: '1' },
      onSpawn: (child) => this.attach(child)
    }
  }

  cancel(): boolean {
    if (this.disposed) return false
    this.stop('cancelled')
    return true
  }

  check(): void {
    if (this.stopped === 'cancelled') {
      throw new GitError({ message: `${this.operation} cancelled.`, gitErrorCode: GitErrorCodes.Cancelled })
    }
    if (this.stopped === 'quiet') {
      throw new GitError({
        message: `${this.operation} stopped: the remote sent nothing for ${QUIET_LIMIT_MS / 60000} minutes.`,
        gitErrorCode: GitErrorCodes.TimedOut
      })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.emitTimer)
    clearTimeout(this.quietTimer)
    emit(this.root, null)
  }

  private attach(child: ChildProcess): void {
    if (this.stopped) {
      this.children.add(child)
      child.once('close', () => this.children.delete(child))
      this.kill(child)
      return
    }
    this.children.add(child)
    child.once('close', () => {
      this.children.delete(child)
      if (this.children.size === 0) clearTimeout(this.quietTimer)
    })
    child.stderr?.on('data', (chunk: Buffer) => this.read(chunk))
    this.touch()
  }

  private read(chunk: Buffer): void {
    const parts = (this.partial + chunk.toString('utf8')).split(/[\r\n]/)
    this.partial = (parts.pop() ?? '').slice(-4096)
    for (let i = parts.length - 1; i >= 0; i--) {
      const line = tidyLine(parts[i])
      if (line) {
        this.show(line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT - 1)}…` : line)
        break
      }
    }
    this.touch()
  }

  private touch(): void {
    if (this.stopped || this.disposed) return
    clearTimeout(this.quietTimer)
    this.quietTimer = setTimeout(() => {
      console.warn(`[git] ${this.operation.toLowerCase()} in ${this.root} sent nothing for ${QUIET_LIMIT_MS} ms, stopping it`)
      this.stop('quiet')
    }, QUIET_LIMIT_MS)
  }

  private show(text: string): void {
    this.text = text
    if (this.emitTimer || this.stopped) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined
      if (this.disposed || this.stopped) return
      const percent = /(\d{1,3})%/.exec(this.text ?? '')
      emit(this.root, { operation: this.operation, text: this.text, percent: percent ? Math.min(100, Number(percent[1])) : undefined })
    }, EMIT_MS)
  }

  private stop(reason: 'cancelled' | 'quiet'): void {
    if (this.stopped) return
    this.stopped = reason
    clearTimeout(this.quietTimer)
    clearTimeout(this.emitTimer)
    this.emitTimer = undefined
    if (reason === 'cancelled') console.log(`[git] cancelling ${this.operation.toLowerCase()} in ${this.root} (${this.children.size} running)`)
    if (!this.disposed) emit(this.root, { operation: this.operation, text: this.text, cancelling: true })
    for (const child of this.children) this.kill(child)
  }

  private kill(child: ChildProcess): void {
    stopGitProcess(child)
  }
}
