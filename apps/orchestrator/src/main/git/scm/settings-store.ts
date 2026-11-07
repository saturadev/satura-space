import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_SCM_VIEW_SETTINGS,
  GIT_SETTINGS_FILE,
  normalizeScmViewSettings,
  parseScmSettingsFile,
  toScmSettingsFile,
  type ScmViewSettings
} from '@shared/git-scm'
import { resolveNeverCommitDir, writeSspaceFile } from './never-commit-store'

export async function readScmSettings(root: string): Promise<ScmViewSettings> {
  const dir = await resolveNeverCommitDir(root)
  let raw: string
  try {
    raw = await readFile(join(dir, GIT_SETTINGS_FILE), 'utf8')
  } catch {
    return DEFAULT_SCM_VIEW_SETTINGS
  }
  return parseScmSettingsFile(raw)
}

export async function writeScmSettings(root: string, settings: unknown): Promise<ScmViewSettings> {
  const next = normalizeScmViewSettings(settings)
  const dir = await resolveNeverCommitDir(root)
  await writeSspaceFile(dir, GIT_SETTINGS_FILE, `${JSON.stringify(toScmSettingsFile(next), null, 2)}\n`)
  return next
}
