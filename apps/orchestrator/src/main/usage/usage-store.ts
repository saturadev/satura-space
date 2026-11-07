import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { UsageProvider, UsageRemaining } from '@shared/api'
import { censusTrack } from '@shared/census'

const WRITE_THROTTLE_MS = 60_000
const lastWriteAt = new Map<UsageProvider, number>()
censusTrack('usage-store.lastWriteAt', lastWriteAt)

function snapshotPath(provider: UsageProvider): string {
  return join(app.getPath('userData'), 'usage', `${provider}.json`)
}

export function readUsageSnapshot(provider: UsageProvider): UsageRemaining | null {
  try {
    const path = snapshotPath(provider)
    if (!existsSync(path)) return null
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return null
    const snapshot = parsed as UsageRemaining
    return snapshot.provider === provider && snapshot.status === 'ok' ? snapshot : null
  } catch {
    return null
  }
}

export function writeUsageSnapshot(provider: UsageProvider, usage: UsageRemaining): void {
  const now = Date.now()
  if (now - (lastWriteAt.get(provider) ?? 0) < WRITE_THROTTLE_MS) return
  lastWriteAt.set(provider, now)
  try {
    const path = snapshotPath(provider)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(usage), 'utf-8')
  } catch {
  }
}
