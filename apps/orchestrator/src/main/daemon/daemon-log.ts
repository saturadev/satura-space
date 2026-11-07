import { appendFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { format } from 'node:util'

export const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024
export const DAEMON_LOG_KEEP = 2

export function rotateLogIfNeeded(path: string, maxBytes = DAEMON_LOG_MAX_BYTES, keep = DAEMON_LOG_KEEP): boolean {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return false
  }
  if (size < maxBytes) return false
  try {
    rmSync(`${path}.${keep}`, { force: true })
    for (let i = keep - 1; i >= 1; i--) {
      try {
        renameSync(`${path}.${i}`, `${path}.${i + 1}`)
      } catch {
      }
    }
    renameSync(path, `${path}.1`)
    return true
  } catch {
    return false
  }
}

function createRotatingLogWriter(
  path: string,
  maxBytes = DAEMON_LOG_MAX_BYTES,
  keep = DAEMON_LOG_KEEP
): (line: string) => void {
  return (line) => {
    try {
      rotateLogIfNeeded(path, maxBytes, keep)
      appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`)
    } catch {
    }
  }
}

export function installDaemonConsoleLog(path: string): void {
  const write = createRotatingLogWriter(path)
  const emit = (level: string) => (...args: unknown[]): void => {
    write(`${new Date().toISOString()} [${process.pid}] ${level} ${format(...args)}`)
  }
  console.log = emit('info')
  console.info = emit('info')
  console.warn = emit('warn')
  console.error = emit('error')
}
