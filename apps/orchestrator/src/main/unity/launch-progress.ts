import { openSync, readSync, closeSync, statSync } from 'node:fs'

export const LAUNCH_PHASES = [
  'Resolving packages…',
  'Compiling scripts…',
  'Importing assets…',
  'Loading scene…'
] as const

export const LAUNCH_PHASE_PCT = [15, 45, 70, 90] as const

const PHASE_RE: RegExp[] = [
  /\[Package Manager\]/,
  /\[ScriptCompilation\]|script compilation time|Starting compile|Compiling/i,
  /Start importing |Initial Refresh End|Hashing assets/i,
  /Opening scene |Loaded scene |Loading scene |\[RawFrameStream\]/i
]

const EDIT_READY_RE = /\[RawFrameStream\].*staying in Edit Mode|\[MCPTestBridge\] Play Mode stopped\./i
const PLAY_ENTER_RE = /Reloading assemblies for play mode\.|\[MCPTestBridge\] Scene opened and entered Play Mode/i

const CS_ERROR_RE = /: error CS\d+/
const COMPILE_FAIL_RE = /^## Script Compilation Error for:|Tundra build failed|Aborting batchmode due to failure/i
const SAFE_MODE_RE = /Safe Mode: Only loading a subset of assemblies|executeMethod class 'MCPTestBridge' could not be found/i
const MAX_ERR_LINES = 40

export type EditorStatusEvent =
  | { kind: 'loading'; phase: string; pct: number }
  | { kind: 'editReady' }
  | { kind: 'playEntering' }
  | { kind: 'compileFailed'; errors: string[] }
  | { kind: 'safeMode' }

function classifyPhase(line: string): number {
  for (let i = PHASE_RE.length - 1; i >= 0; i--) if (PHASE_RE[i].test(line)) return i + 1
  return 0
}

const POLL_MS = 250
const READ_CAP = 256 * 1024
const STUCK_MS = 180_000
const QUIET_MS = 900_000

export function trackEditorStatus(
  logPath: string,
  onEvent: (e: EditorStatusEvent) => void,
  onStuck?: () => void,
  onUnstuck?: () => void,
  stuckMs: number = STUCK_MS,
  quietMs: number = QUIET_MS
): () => void {
  let offset = 0
  let phase = 0
  let carry = ''
  let stopped = false
  let booted = false
  let inPlay = false
  let idleTicks = 0
  let stuckFired = false
  let spoke = false
  let compileFailed = false
  let compileFailAnnounced = false
  let safeModeAnnounced = false
  const reportedErrors = new Set<string>()
  let pendingErrors: string[] = []
  const stuckTicks = Math.max(1, Math.round(stuckMs / POLL_MS))
  const quietTicks = Math.max(1, Math.round(quietMs / POLL_MS))

  const bumpIdle = (): void => {
    if (booted || stuckFired || !onStuck) return
    if (++idleTicks >= (spoke ? quietTicks : stuckTicks)) {
      stuckFired = true
      onStuck()
    }
  }

  const tick = (): void => {
    if (stopped) return
    let size: number
    try {
      size = statSync(logPath).size
    } catch {
      bumpIdle()
      return
    }
    if (size < offset) {
      offset = 0
      carry = ''
      phase = 0
      booted = false
      inPlay = false
      compileFailed = false
      compileFailAnnounced = false
      safeModeAnnounced = false
      reportedErrors.clear()
      pendingErrors = []
    }
    if (size <= offset) {
      bumpIdle()
      return
    }
    idleTicks = 0
    spoke = true
    if (stuckFired) {
      stuckFired = false
      onUnstuck?.()
    }

    let chunk = ''
    let fd: number | undefined
    try {
      fd = openSync(logPath, 'r')
      const want = Math.min(size - offset, READ_CAP)
      const buf = Buffer.allocUnsafe(want)
      const got = readSync(fd, buf, 0, want, offset)
      offset += got
      chunk = buf.toString('utf8', 0, got)
    } catch {
      return
    } finally {
      if (fd !== undefined) closeSync(fd)
    }

    const lines = (carry + chunk).split(/\r?\n/)
    carry = lines.pop() ?? ''
    for (const ln of lines) {
      if (stopped) return
      if (PLAY_ENTER_RE.test(ln)) {
        booted = true
        if (!inPlay) {
          inPlay = true
          onEvent({ kind: 'playEntering' })
        }
        continue
      }
      if (EDIT_READY_RE.test(ln)) {
        booted = true
        inPlay = false
        onEvent({ kind: 'editReady' })
        continue
      }
      if (!booted) {
        if (CS_ERROR_RE.test(ln) && reportedErrors.size < MAX_ERR_LINES) {
          const t = ln.trim()
          if (t && !reportedErrors.has(t)) {
            reportedErrors.add(t)
            pendingErrors.push(t)
          }
        }
        if (COMPILE_FAIL_RE.test(ln)) compileFailed = true
        if (!safeModeAnnounced && SAFE_MODE_RE.test(ln)) {
          safeModeAnnounced = true
          onEvent({ kind: 'safeMode' })
        }
        const p = classifyPhase(ln)
        if (p > phase) {
          phase = p
          onEvent({ kind: 'loading', phase: LAUNCH_PHASES[p - 1], pct: LAUNCH_PHASE_PCT[p - 1] })
        }
      }
    }

    if (!booted && compileFailed && (pendingErrors.length > 0 || !compileFailAnnounced)) {
      compileFailAnnounced = true
      const errors = pendingErrors
      pendingErrors = []
      onEvent({ kind: 'compileFailed', errors })
    }
  }

  const timer = setInterval(tick, POLL_MS)
  tick()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
