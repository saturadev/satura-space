import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

interface GitQueueLimits {
  readonly defaultMs: number
  readonly longMs: number
  readonly killGraceMs: number
}

const limits: GitQueueLimits = {
  defaultMs: 5 * 60 * 1000,
  longMs: 10 * 60 * 1000,
  killGraceMs: 5000
}

const LONG_RUNNING_COMMANDS = new Set(['clone', 'commit', 'fetch', 'lfs', 'ls-remote', 'pull', 'push', 'submodule', 'worktree'])
const PRIORITY_COMMANDS = new Set(['add', 'apply', 'checkout', 'clean', 'commit', 'hash-object', 'merge', 'reset', 'restore', 'rm', 'stash', 'update-index'])
const SLOW_LOG_MS = 750
const OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace'])

let running = 0
const waiting: (() => void)[] = []
const urgent: (() => void)[] = []

export class GitProcessTimeoutError extends Error {
  readonly code = 'GIT_TIMEOUT'

  constructor(readonly command: string | undefined, readonly args: readonly string[], readonly limitMs: number) {
    super(`${command ? `Git ${command}` : 'Git'} took longer than ${describeDuration(limitMs)} and was stopped.`)
    this.name = 'GitProcessTimeoutError'
  }
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`
}

function describeDuration(ms: number): string {
  if (ms >= 60000 && ms % 60000 === 0) return plural(ms / 60000, 'minute')
  if (ms >= 1000 && ms % 1000 === 0) return plural(ms / 1000, 'second')
  return `${ms} ms`
}

export function gitSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (OPTIONS_WITH_VALUE.has(arg)) {
      i++
      continue
    }
    if (arg.startsWith('-')) continue
    return arg
  }
  return undefined
}

function gitProcessLimit(args: readonly string[], timeout?: number): number {
  if (typeof timeout === 'number' && timeout > 0) return timeout
  return LONG_RUNNING_COMMANDS.has(gitSubcommand(args) ?? '') ? limits.longMs : limits.defaultMs
}

export function gitQueueStats(): { running: number; urgent: number; waiting: number; limits: GitQueueLimits; longCommands: string[]; priorityCommands: string[] } {
  return { running, urgent: urgent.length, waiting: waiting.length, limits: { ...limits }, longCommands: [...LONG_RUNNING_COMMANDS], priorityCommands: [...PRIORITY_COMMANDS] }
}

function acquire(priority: boolean): Promise<void> {
  if (running === 0) {
    running = 1
    return Promise.resolve()
  }
  return new Promise((resolve) => (priority ? urgent : waiting).push(resolve))
}

function release(): void {
  const next = urgent.shift() ?? waiting.shift()
  if (next) next()
  else running = 0
}

export function killGitProcess(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
    return
  }
  try {
    process.kill(-pid, signal)
    return
  } catch {
  }
  try {
    child.kill(signal)
  } catch {
  }
}

const stoppers = new WeakMap<ChildProcess, () => void>()

function supervise(child: ChildProcess, args: readonly string[], limitMs: number): void {
  const graceMs = limits.killGraceMs
  const command = gitSubcommand(args)
  let settled = false
  let stopping = false
  let timer: NodeJS.Timeout | undefined

  const finish = (): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    stoppers.delete(child)
    release()
  }

  const stop = (): void => {
    if (settled || stopping) return
    stopping = true
    clearTimeout(timer)
    killGitProcess(child, 'SIGTERM')
    timer = setTimeout(() => {
      killGitProcess(child, 'SIGKILL')
      timer = setTimeout(() => {
        console.warn(`[git] ${command ?? 'git'} (pid ${child.pid}) still holds its output open, releasing the queue`)
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish()
      }, graceMs)
    }, graceMs)
  }

  stoppers.set(child, stop)
  child.once('close', finish)
  child.on('error', () => {
    if (child.pid === undefined) finish()
  })

  timer = setTimeout(() => {
    console.warn(`[git] ${command ?? 'git'} (pid ${child.pid}) ran past ${limitMs} ms, stopping it`)
    child.emit('error', new GitProcessTimeoutError(command, args, limitMs))
    stop()
  }, limitMs)
}

export function stopGitProcess(child: ChildProcess): void {
  const stop = stoppers.get(child)
  if (stop) stop()
  else killGitProcess(child, 'SIGTERM')
}

export async function runGitProcess<T>(
  file: string,
  args: readonly string[],
  options: SpawnOptions,
  consume: (child: ChildProcess) => T | Promise<T>
): Promise<T> {
  const queued = Date.now()
  const queuedBehind = running + urgent.length + waiting.length
  await acquire(PRIORITY_COMMANDS.has(gitSubcommand(args) ?? ''))
  const started = Date.now()
  const { timeout, ...spawnOptions } = options
  const limitMs = gitProcessLimit(args, timeout)

  let child: ChildProcess
  try {
    child = spawn(file, args, {
      ...spawnOptions,
      env: { ...(spawnOptions.env ?? process.env), GIT_TERMINAL_PROMPT: '0' },
      detached: process.platform !== 'win32'
    })
  } catch (err) {
    release()
    throw err
  }

  supervise(child, args, limitMs)
  child.once('close', () => {
    const waited = started - queued
    const ran = Date.now() - started
    if (waited + ran >= SLOW_LOG_MS) {
      console.log(`[git] slow ${gitSubcommand(args) ?? 'git'}: waited ${waited}ms behind ${queuedBehind}, ran ${ran}ms (${args.slice(0, 8).join(' ').slice(0, 160)})`)
    }
  })

  let result: T | Promise<T>
  try {
    result = consume(child)
  } catch (err) {
    killGitProcess(child)
    throw err
  }
  return await result
}
