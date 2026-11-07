import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  STREAM_RESOLUTIONS_FILE,
  normalizeSavedResolutions,
  parseStreamResolutionsFile,
  toStreamResolutionsFile,
  type SavedStreamResolution
} from '@shared/unity/stream-size'
import { SSPACE_DIR } from '../sspace'
import { writeSspaceFile } from '../git/scm/never-commit-store'

export async function readStreamResolutions(projectPath: string): Promise<SavedStreamResolution[]> {
  if (!projectPath) return []
  let raw: string
  try {
    raw = await readFile(join(projectPath, SSPACE_DIR, STREAM_RESOLUTIONS_FILE), 'utf8')
  } catch {
    return []
  }
  return parseStreamResolutionsFile(raw)
}

export async function writeStreamResolutions(
  projectPath: string,
  resolutions: unknown
): Promise<SavedStreamResolution[]> {
  const next = normalizeSavedResolutions(resolutions)
  if (!projectPath) return next
  await writeSspaceFile(
    join(projectPath, SSPACE_DIR),
    STREAM_RESOLUTIONS_FILE,
    `${JSON.stringify(toStreamResolutionsFile(next), null, 2)}\n`
  )
  return next
}
