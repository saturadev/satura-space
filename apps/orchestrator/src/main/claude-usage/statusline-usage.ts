import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { RateLimitWindow, UsageRemaining } from '@shared/api'

interface RawWindow {
  used_percentage?: unknown
  utilization?: unknown
  resets_at?: unknown
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function resetsAtMs(value: unknown): number | null {
  const seconds = finite(value)
  if (seconds !== null) return seconds > 1e11 ? seconds : seconds * 1000
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function mapWindow(raw: unknown, windowMinutes: number): RateLimitWindow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as RawWindow
  const used = finite(value.used_percentage) ?? finite(value.utilization)
  if (used === null) return null
  return {
    usedPercent: Math.max(0, Math.min(100, used)),
    windowMinutes,
    resetsAt: resetsAtMs(value.resets_at)
  }
}

export function isDefaultClaudeAccount(configDir: string): boolean {
  const trimmed = configDir.trim()
  if (!trimmed) return true
  return resolve(trimmed) === resolve(homedir(), '.claude')
}

export function parseStatusLineUsage(payload: string): UsageRemaining | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const rateLimits = (parsed as { rate_limits?: unknown }).rate_limits
  if (typeof rateLimits !== 'object' || rateLimits === null) return null
  const session = mapWindow((rateLimits as { five_hour?: unknown }).five_hour, 300)
  const weekly = mapWindow((rateLimits as { seven_day?: unknown }).seven_day, 10080)
  if (!session && !weekly) return null
  return {
    provider: 'claude',
    session,
    weekly,
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}
