import { app } from 'electron'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { UnityMode } from '@shared/unity/world'
import { writePrivateFile } from './secret-token'

const MAX_HANDOFF_AGE_MS = 15 * 60_000

export interface HandoffInstance {
  projectPath: string
  realProjectPath: string
  kind: 'primary' | 'clone'
  worldId: string
  cloneId?: string
  mediaPort: number
  inputPort: number
  controlPort: number
  controlToken?: string
  logPath: string
  pid: number
  unityMode: UnityMode
}

interface UpdateHandoff {
  at: number
  fromVersion: string
  instances: HandoffInstance[]
}

function handoffPath(): string {
  return join(app.getPath('userData'), 'update-handoff.json')
}

export function writeUpdateHandoff(instances: HandoffInstance[]): void {
  try {
    writePrivateFile(
      handoffPath(),
      JSON.stringify({ at: Date.now(), fromVersion: app.getVersion(), instances })
    )
    console.log(`[update] wrote handoff with ${instances.length} unity instance(s)`)
  } catch (e) {
    console.error(`[update] failed to write handoff: ${(e as Error).message}`)
  }
}

let consumed: UpdateHandoff | null | undefined

export function consumeUpdateHandoff(): UpdateHandoff | null {
  if (consumed !== undefined) return consumed
  consumed = null
  let raw: UpdateHandoff
  try {
    raw = JSON.parse(readFileSync(handoffPath(), 'utf8')) as UpdateHandoff
  } catch {
    return consumed
  }
  try {
    rmSync(handoffPath(), { force: true })
  } catch {
  }
  if (
    typeof raw?.at === 'number' &&
    Date.now() - raw.at < MAX_HANDOFF_AGE_MS &&
    Array.isArray(raw.instances)
  ) {
    consumed = raw
    console.log(
      `[update] relaunch after update from ${raw.fromVersion}: ${raw.instances.length} unity instance(s) offered for adoption`
    )
  }
  return consumed
}

export function isUpdateRelaunch(): boolean {
  return consumeUpdateHandoff() !== null
}
