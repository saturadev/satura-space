import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { GitProcessTimeoutError, gitQueueStats, gitSubcommand, runGitProcess } from '../git/git-queue'
import { defineHandle, sleep } from './registry'
import { scratchFor } from './scratch'

const FAKE_GIT = `#!/bin/sh
[ "$FAKE_GIT_IGNORE_TERM" = 1 ] && trap '' TERM
[ -n "$FAKE_GIT_LOG" ] && printf '%s %s\\n' "$$" "$*" >> "$FAKE_GIT_LOG"
if [ "$FAKE_GIT_HOLD" = 1 ]; then
  perl -e 'setpgrp(0, 0); $SIG{TERM} = "IGNORE"; open(my $f, ">>", $ENV{FAKE_GIT_HELD}); print $f "$$\\n"; close($f); sleep 120' &
fi
[ -n "$FAKE_GIT_STDOUT" ] && printf '%s' "$FAKE_GIT_STDOUT"
[ -n "$FAKE_GIT_STDERR" ] && printf '%s' "$FAKE_GIT_STDERR" >&2
[ -n "$FAKE_GIT_SLEEP" ] && sleep "$FAKE_GIT_SLEEP"
exit "\${FAKE_GIT_EXIT:-0}"
`

interface Job {
  args: string[]
  sleepMs: number
  ignoreTerm: boolean
  hold: boolean
  exit: number
  stdout: string
  stderr: string
  timeoutMs: number
  delayMs: number
}

function jobOf(raw: unknown): Job {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    args: Array.isArray(o.args) ? o.args.map(String) : ['status'],
    sleepMs: Math.max(0, Number(o.sleepMs) || 0),
    ignoreTerm: o.ignoreTerm === true,
    hold: o.holdOutput === true,
    exit: Math.max(0, Math.min(255, Number(o.exit) || 0)),
    stdout: typeof o.stdout === 'string' ? o.stdout : '',
    stderr: typeof o.stderr === 'string' ? o.stderr : '',
    timeoutMs: Math.max(0, Number(o.timeoutMs) || 0),
    delayMs: Math.max(0, Number(o.delayMs) || 0)
  }
}

function collect(child: ChildProcess, mark: (what: 'start' | 'error', e?: Error) => void): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; error?: string; errorName?: string }> {
  mark('start')
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let error: Error | undefined
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => (stdout += c))
    child.stderr?.on('data', (c: string) => (stderr += c))
    child.on('error', (e) => {
      error ??= e
      mark('error', e)
    })
    child.once('close', (code, signal) => resolve({ code, signal, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000), ...(error ? { error: error.message, errorName: error.name } : {}) }))
  })
}

defineHandle({
  name: 'gitQueue.run',
  side: 'main',
  long: true,
  agentOnly: true,
  description:
    "Runs jobs through the app's real git queue (git/git-queue.ts runGitProcess: one git at a time, priority commands first, a time limit per command, SIGTERM then SIGKILL after the grace period, and a release when a killed process still holds its output open) with a fake git script in a scratch dir instead of git. Each job: args (the subcommand decides priority and the default limit: add/commit/stash/checkout/... jump the queue, fetch/pull/push/clone get the long limit), sleepMs, timeoutMs (the per-call limit; 0 = the default for the subcommand), ignoreTerm (the script ignores SIGTERM, so the queue has to SIGKILL it), holdOutput (leaves a grandchild in its own process group holding stdout open, so the queue must give up waiting and release; the handle kills it afterwards), exit, stdout, stderr, delayMs (when the job is queued, after the call starts). The jobs run concurrently on the shared queue, so the app's own git calls wait behind them while they run. Returns per job when it was queued, started and ended (ms from the call start), waited and ran ms, exit code, signal, output and the error (GitProcessTimeoutError for a timeout), the start order, the queue stats before, at its busiest and after (running, urgent, waiting, limits), and the [git] log lines in logs.",
  params: { jobs: [{ args: ['status'], sleepMs: 200 }] as unknown[], keep: false },
  async run(p, ctx) {
    const jobs = (Array.isArray(p.jobs) && p.jobs.length ? p.jobs : [{}]).slice(0, 20).map(jobOf)
    const s = scratchFor({ root: '', keep: p.keep }, ctx, 'fake git')
    const git = join(s.root, 'git')
    const held = join(s.root, 'held.pids')
    const calls = join(s.root, 'calls.log')
    writeFileSync(git, FAKE_GIT)
    chmodSync(git, 0o755)
    writeFileSync(held, '')
    const t0 = Date.now()
    const at = (): number => Date.now() - t0
    const before = gitQueueStats()
    const order: number[] = []
    let during: ReturnType<typeof gitQueueStats> | null = null
    const runs = jobs.map(async (job, index) => {
      if (job.delayMs) await sleep(job.delayMs, ctx.signal)
      const queuedAt = at()
      let startedAt = -1
      let errorAt = -1
      const env = {
        ...process.env,
        FAKE_GIT_LOG: calls,
        FAKE_GIT_HELD: held,
        ...(job.sleepMs ? { FAKE_GIT_SLEEP: String(job.sleepMs / 1000) } : {}),
        ...(job.ignoreTerm ? { FAKE_GIT_IGNORE_TERM: '1' } : {}),
        ...(job.hold ? { FAKE_GIT_HOLD: '1' } : {}),
        FAKE_GIT_EXIT: String(job.exit),
        FAKE_GIT_STDOUT: job.stdout,
        FAKE_GIT_STDERR: job.stderr
      }
      try {
        const out = await runGitProcess(git, job.args, { cwd: s.root, env, stdio: ['ignore', 'pipe', 'pipe'], ...(job.timeoutMs ? { timeout: job.timeoutMs } : {}) }, (child) =>
          collect(child, (what, e) => {
            if (what === 'start') {
              startedAt = at()
              order.push(index)
              const now = gitQueueStats()
              if (!during || now.urgent + now.waiting > during.urgent + during.waiting) during = now
            } else if (errorAt < 0) {
              errorAt = at()
              ctx.log(`job ${index} error at ${errorAt} ms: ${e?.message}`)
            }
          })
        )
        const endedAt = at()
        return { index, args: job.args, subcommand: gitSubcommand(job.args) ?? null, queuedAt, startedAt, endedAt, waitedMs: startedAt - queuedAt, ranMs: endedAt - startedAt, ...(errorAt >= 0 ? { errorAt } : {}), ...out, timedOut: out.errorName === 'GitProcessTimeoutError' }
      } catch (e) {
        return { index, args: job.args, queuedAt, startedAt, endedAt: at(), thrown: (e as Error).message, timedOut: e instanceof GitProcessTimeoutError }
      }
    })
    const results = await Promise.all(runs)
    const after = gitQueueStats()
    const leftovers = readFileSync(held, 'utf8').split('\n').map(Number).filter((n) => n > 0)
    for (const pid of leftovers) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
      }
    }
    const scriptCalls = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean)
    return { ms: at(), startOrder: order, jobs: results, stats: { before, during, after }, scriptCalls, killedHolders: leftovers }
  }
})
