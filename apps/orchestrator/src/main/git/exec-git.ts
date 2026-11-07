import type { ChildProcess } from 'node:child_process'
import { killGitProcess } from './git-queue'
import { getGit } from './scm/git'

const DEFAULT_MAX_BUFFER = 1024 * 1024

export interface ExecGitOptions {
  readonly cwd?: string
  readonly timeout?: number
  readonly maxBuffer?: number
}

export interface ExecGitResult {
  readonly stdout: string
  readonly stderr: string
}

export interface ExecGitError extends Error {
  code?: number | string
  signal?: NodeJS.Signals | null
  cmd?: string
  stdout?: string
  stderr?: string
}

export async function execGit(args: string[], options: ExecGitOptions = {}): Promise<ExecGitResult> {
  const git = await getGit()
  const cmd = [git.path, ...args].join(' ')
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
  return git.spawn(args, { cwd: options.cwd, timeout: options.timeout }, (child) => collect(child, cmd, maxBuffer))
}

function collect(child: ChildProcess, cmd: string, maxBuffer: number): Promise<ExecGitResult> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutLength = 0
    let stderrLength = 0
    let settled = false

    const text = (chunks: Buffer[]): string => Buffer.concat(chunks).toString('utf8')

    const fail = (err: ExecGitError): void => {
      if (settled) return
      settled = true
      reject(Object.assign(err, { cmd, stdout: text(stdout), stderr: text(stderr) }))
    }

    const overflow = (name: string): void => {
      fail(Object.assign(new RangeError(`${name} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }))
      killGitProcess(child)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutLength += chunk.length
      if (stdoutLength > maxBuffer) overflow('stdout')
      else stdout.push(chunk)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrLength += chunk.length
      if (stderrLength > maxBuffer) overflow('stderr')
      else stderr.push(chunk)
    })

    child.on('error', fail)

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      if (code === 0) {
        settled = true
        resolve({ stdout: text(stdout), stderr: text(stderr) })
        return
      }
      fail(Object.assign(new Error(`Command failed: ${cmd}\n${text(stderr)}`), { code: code ?? undefined, signal }))
    })
  })
}
