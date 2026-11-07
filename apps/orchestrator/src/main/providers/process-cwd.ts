import { execFile as execFileCb } from 'node:child_process'
import { readlink } from 'node:fs/promises'
import { censusTrack } from '@shared/census'

const CACHE_TTL_MS = 1500
const CACHE_MAX_ENTRIES = 256
const LSOF_TIMEOUT_MS = 1500

type CacheEntry = { value: string; at: number }
const resultCache = new Map<number, CacheEntry>()
censusTrack('process-cwd.resultCache', resultCache)
const inflight = new Map<number, Promise<string>>()
censusTrack('process-cwd.inflight', inflight)

export async function resolveProcessCwd(pid: number): Promise<string> {
  const now = Date.now()
  sweepExpiredResultCache(now)
  const cached = resultCache.get(pid)
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.value
  }
  const existing = inflight.get(pid)
  if (existing) {
    return existing
  }
  const promise = doResolve(pid).then((value) => {
    rememberResult(pid, value, Date.now())
    inflight.delete(pid)
    return value
  })
  inflight.set(pid, promise)
  return promise
}

function sweepExpiredResultCache(now: number): void {
  for (const [cachedPid, entry] of resultCache) {
    if (now - entry.at >= CACHE_TTL_MS) {
      resultCache.delete(cachedPid)
    }
  }
}

function rememberResult(pid: number, value: string, now: number): void {
  resultCache.set(pid, { value, at: now })
  while (resultCache.size > CACHE_MAX_ENTRIES) {
    const oldest = resultCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    resultCache.delete(oldest)
  }
}

async function doResolve(pid: number): Promise<string> {
  try {
    return await readlink(`/proc/${pid}/cwd`)
  } catch {
  }

  try {
    const stdout = await readCwdWithLsof(pid)
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n') && line.includes('/')) {
        return line.slice(1)
      }
    }
  } catch {
  }

  return ''
}

function readCwdWithLsof(pid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let child: ReturnType<typeof execFileCb> | undefined
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child?.kill()
      reject(new Error(`lsof timed out after ${LSOF_TIMEOUT_MS}ms`))
    }, LSOF_TIMEOUT_MS)

    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      callback()
    }

    try {
      child = execFileCb(
        'lsof',
        ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
        {
          encoding: 'utf-8',
          timeout: LSOF_TIMEOUT_MS
        },
        (error, stdout) => {
          if (error) {
            settle(() => reject(error))
            return
          }
          settle(() => resolve(String(stdout)))
        }
      )
    } catch (error) {
      settle(() => reject(error))
    }
  })
}
