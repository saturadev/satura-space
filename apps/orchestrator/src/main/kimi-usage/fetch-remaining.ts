import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { net } from 'electron'
import type { KimiUsageRemaining, RateLimitWindow } from '@shared/api'

const KIMI_BASE_URL = process.env.KIMI_CODE_BASE_URL ?? 'https://api.kimi.com/coding/v1'
const TIMEOUT_MS = 10_000
const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10080

function kimiHome(): string {
  return process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code')
}

function credentialsPath(): string {
  return join(kimiHome(), 'credentials', 'kimi-code.json')
}

interface KimiCredentials {
  access_token?: string
  expires_at?: number
}

function readCredentials(): KimiCredentials | null {
  const path = credentialsPath()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as KimiCredentials
    if (typeof parsed?.access_token !== 'string' || !parsed.access_token) return null
    return parsed
  } catch {
    return null
  }
}

function isTokenFresh(creds: KimiCredentials): boolean {
  return (
    typeof creds.expires_at === 'number' &&
    creds.expires_at - Math.floor(Date.now() / 1000) > 5
  )
}

interface KimiUsageDetail {
  limit?: string | number
  remaining?: string | number
  used?: string | number
  resetTime?: string
  resetAt?: string
}
interface KimiUsageWindow {
  duration?: number
  timeUnit?: string
}
interface KimiUsageLimit {
  window?: KimiUsageWindow
  detail?: KimiUsageDetail
}
interface KimiUsageResponse {
  usage?: KimiUsageDetail
  limits?: KimiUsageLimit[]
}

function toInt(value: string | number | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function windowToMinutes(w: KimiUsageWindow | undefined): number | null {
  const duration = toInt(w?.duration)
  if (duration === null) return null
  const unit = (w?.timeUnit ?? '').toUpperCase()
  if (unit.includes('MINUTE')) return duration
  if (unit.includes('HOUR')) return duration * 60
  if (unit.includes('DAY')) return duration * 60 * 24
  if (unit.includes('SECOND')) return Math.round(duration / 60)
  return duration
}

function mapWindow(
  detail: KimiUsageDetail | undefined,
  windowMinutes: number
): RateLimitWindow | null {
  if (!detail) return null
  const limit = toInt(detail.limit)
  let used = toInt(detail.used)
  if (used === null) {
    const remaining = toInt(detail.remaining)
    if (remaining !== null && limit !== null) used = limit - remaining
  }
  if (limit === null || limit <= 0 || used === null) return null
  const reset = detail.resetTime ?? detail.resetAt
  return {
    usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
    windowMinutes,
    resetsAt: reset ? new Date(reset).getTime() || null : null
  }
}

function mapUsageResponse(data: KimiUsageResponse): KimiUsageRemaining {
  const weekly = mapWindow(data.usage, WEEKLY_WINDOW_MINUTES)
  let session: RateLimitWindow | null = null
  for (const limit of data.limits ?? []) {
    const minutes = windowToMinutes(limit.window) ?? SESSION_WINDOW_MINUTES
    const mapped = mapWindow(limit.detail, minutes)
    if (!mapped) continue
    if (
      session === null ||
      Math.abs(minutes - SESSION_WINDOW_MINUTES) <
        Math.abs(session.windowMinutes - SESSION_WINDOW_MINUTES)
    ) {
      session = mapped
    }
  }
  const hasData = !!(session || weekly)
  return {
    provider: 'kimi',
    session,
    weekly,
    weeklyScoped: [],
    updatedAt: Date.now(),
    error: hasData ? null : 'Kimi usage response did not include quota windows',
    status: hasData ? 'ok' : 'error'
  }
}

export async function fetchKimiUsageRemaining(): Promise<KimiUsageRemaining> {
  const base = {
    provider: 'kimi' as const,
    session: null,
    weekly: null,
    weeklyScoped: [],
    updatedAt: Date.now()
  }

  const creds = readCredentials()
  if (!creds) {
    return { ...base, status: 'unavailable', error: 'Not signed in to Kimi Code' }
  }
  if (!isTokenFresh(creds)) {
    return {
      ...base,
      status: 'error',
      error: 'Kimi session expired — run `kimi` on this computer, then retry.'
    }
  }

  try {
    const res = await net.fetch(`${KIMI_BASE_URL.replace(/\/$/, '')}/usages`, {
      headers: {
        Authorization: `Bearer ${creds.access_token}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (res.status === 401 || res.status === 403) {
      return { ...base, status: 'error', error: `Kimi usage unauthorized (HTTP ${res.status})` }
    }
    if (!res.ok) {
      return { ...base, status: 'error', error: `Kimi usage request failed (HTTP ${res.status})` }
    }
    const data: unknown = await res.json()
    return mapUsageResponse(typeof data === 'object' && data !== null ? (data as KimiUsageResponse) : {})
  } catch (err) {
    return {
      ...base,
      status: 'error',
      error: err instanceof Error ? err.message : 'Kimi usage request failed'
    }
  }
}
