import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'

export interface EditorCrash {
  reason: string
  line: number
}

export interface EditorWatchdogOptions {
  pid: () => number | null
  logPath: string
  progress: () => string
  busy: () => boolean
  onCrash: (crash: EditorCrash) => void
  onHung: (reason: string | null) => void
  onStall: (text: string) => void
}

const POLL_MS = 1000
const STATE_POLL_MS = 2000
const STOPPED_POLLS = 2
const STALL_MS = 30_000
const READ_CAP = 512 * 1024
const REASON_MAX = 220

const REASON_RE = [
  /^Got an? \w+ while executing native code/i,
  /Received signal SIG(SEGV|BUS|ILL|ABRT|FPE|TRAP)\b/,
  /Caught fatal signal - signo:\d+/,
  /^Crash!!!/,
  /Unity has crashed/i
]
const MARKER_RE = /Native Crash Reporting/

export const HUNG_REASON = "The editor process is paused and can't answer."

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim().replace(/\.\s.*$/, '.')
  return t.length > REASON_MAX ? `${t.slice(0, REASON_MAX - 1)}…` : t
}

function stallText(quietMs: number, lastLine: string): string {
  const mins = Math.floor(quietMs / 60_000)
  const span = mins < 1 ? '30 seconds' : mins === 1 ? 'a minute' : `${mins} minutes`
  const last = lastLine ? ` Last log line: ${clip(lastLine)}` : ''
  return `Unity hasn't logged anything for ${span}.${last}`
}

function readProcessState(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'stat=', '-p', String(pid)], { timeout: 1500 }, (err, out) => {
      resolve(err ? '' : String(out ?? '').trim())
    })
  })
}

export function watchEditor(opts: EditorWatchdogOptions): () => void {
  let stopped = false
  let offset = 0
  let carry = ''
  let lineNo = 0
  let lastLine = ''
  let markerLine = 0
  let crashed = false
  let lastActivity = Date.now()
  let progressSig = opts.progress()
  let stall = ''
  let stoppedPolls = 0
  let hung = false
  let statePollAt = 0
  let stateBusy = false

  const fireCrash = (reason: string, line: number): void => {
    if (crashed) return
    crashed = true
    opts.onCrash({ reason: clip(reason), line })
  }

  const scanLog = (): boolean => {
    let size: number
    try {
      size = statSync(opts.logPath).size
    } catch {
      return false
    }
    if (size < offset) {
      offset = 0
      carry = ''
      lineNo = 0
    }
    if (size <= offset) return false
    let chunk = ''
    let fd: number | undefined
    try {
      fd = openSync(opts.logPath, 'r')
      const want = Math.min(size - offset, READ_CAP)
      const buf = Buffer.allocUnsafe(want)
      const got = readSync(fd, buf, 0, want, offset)
      offset += got
      chunk = buf.toString('utf8', 0, got)
    } catch {
      return false
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    const lines = (carry + chunk).split(/\r?\n/)
    carry = lines.pop() ?? ''
    for (const raw of lines) {
      lineNo++
      const ln = raw.trim()
      if (!ln) continue
      if (!/^[=\s]+$/.test(ln)) lastLine = ln
      if (crashed) continue
      if (REASON_RE.some((re) => re.test(ln))) fireCrash(ln, lineNo)
      else if (!markerLine && MARKER_RE.test(ln)) markerLine = lineNo
    }
    return true
  }

  const checkState = async (): Promise<void> => {
    const pid = opts.pid()
    if (!pid || process.platform === 'win32') return
    stateBusy = true
    const st = await readProcessState(pid)
    stateBusy = false
    if (stopped || crashed) return
    if (st.startsWith('T')) {
      stoppedPolls++
      if (!hung && stoppedPolls >= STOPPED_POLLS) {
        hung = true
        opts.onHung(HUNG_REASON)
      }
    } else if (st) {
      stoppedPolls = 0
      if (hung) {
        hung = false
        lastActivity = Date.now()
        opts.onHung(null)
      }
    }
  }

  const setStall = (text: string): void => {
    if (text === stall) return
    stall = text
    opts.onStall(text)
  }

  const tick = (): void => {
    if (stopped) return
    const grew = scanLog()
    if (!crashed && markerLine && !grew) fireCrash('Unity logged a native crash.', markerLine)
    const now = Date.now()
    const sig = opts.progress()
    if (grew || sig !== progressSig) {
      progressSig = sig
      lastActivity = now
    }
    if (crashed || hung || !opts.busy()) setStall('')
    else if (now - lastActivity >= STALL_MS) setStall(stallText(now - lastActivity, lastLine))
    else setStall('')
    if (!crashed && !stateBusy && now - statePollAt >= STATE_POLL_MS) {
      statePollAt = now
      void checkState()
    }
  }

  const timer = setInterval(tick, POLL_MS)
  tick()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

export function scanLogForCrash(logPath: string): EditorCrash | null {
  let text: string
  try {
    if (statSync(logPath).size > 64 * 1024 * 1024) return null
    text = readFileSync(logPath, 'utf8')
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/)
  let marker = 0
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim()
    if (REASON_RE.some((re) => re.test(ln))) return { reason: clip(ln), line: i + 1 }
    if (!marker && MARKER_RE.test(ln)) marker = i + 1
  }
  return marker ? { reason: 'Unity logged a native crash.', line: marker } : null
}
