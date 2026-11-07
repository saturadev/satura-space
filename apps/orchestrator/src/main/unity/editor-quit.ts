export type EditorQuitPath = 'graceful' | 'killed' | 'exited'

export type EditorKillReason = 'timeout' | 'unreachable'

export interface EditorQuitTarget {
  exited(): boolean
  requestQuit(): void
  signal(sig: NodeJS.Signals): void
}

export interface EditorQuitTimings {
  graceMs: number
  termMs: number
  killMs: number
  pollMs: number
}

export const EDITOR_QUIT_TIMINGS: EditorQuitTimings = {
  graceMs: 12_000,
  termMs: 2_000,
  killMs: 5_000,
  pollMs: 100
}

export interface EditorQuitOutcome {
  path: EditorQuitPath
  ms: number
  signal: NodeJS.Signals | null
  reason: EditorKillReason | null
  exited: boolean
}

export interface EditorQuitOptions {
  reachable: boolean
  timings?: EditorQuitTimings
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function quitEditor(target: EditorQuitTarget, opts: EditorQuitOptions): Promise<EditorQuitOutcome> {
  const t = opts.timings ?? EDITOR_QUIT_TIMINGS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? realSleep
  const started = now()
  const elapsed = (): number => now() - started

  const waitExit = async (ms: number): Promise<boolean> => {
    const deadline = now() + ms
    while (!target.exited()) {
      if (now() >= deadline) return false
      await sleep(Math.min(t.pollMs, Math.max(1, deadline - now())))
    }
    return true
  }

  if (target.exited()) return { path: 'exited', ms: 0, signal: null, reason: null, exited: true }

  if (opts.reachable) {
    try {
      target.requestQuit()
    } catch {
    }
    if (await waitExit(t.graceMs)) {
      return { path: 'graceful', ms: elapsed(), signal: null, reason: null, exited: true }
    }
  }

  const reason: EditorKillReason = opts.reachable ? 'timeout' : 'unreachable'
  let signal: NodeJS.Signals = 'SIGTERM'
  try {
    target.signal('SIGTERM')
  } catch {
  }
  if (!(await waitExit(t.termMs))) {
    signal = 'SIGKILL'
    try {
      target.signal('SIGKILL')
    } catch {
    }
    await waitExit(t.killMs)
  }
  return { path: 'killed', ms: elapsed(), signal, reason, exited: target.exited() }
}

export function describeQuit(outcome: EditorQuitOutcome, graceMs: number, unreachableWhy?: string): string {
  if (outcome.path === 'exited') return 'already exited'
  if (outcome.path === 'graceful') return `graceful in ${outcome.ms}ms`
  const why =
    outcome.reason === 'unreachable'
      ? `unreachable (${unreachableWhy ?? 'no response'}), graceful quit skipped`
      : `no exit within the ${graceMs}ms grace window`
  return `killed (${outcome.signal}) after ${outcome.ms}ms, ${why}${outcome.exited ? '' : ', still running'}`
}
