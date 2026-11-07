import type { FsRenameResult } from '@shared/api'

export function renameRefusal(res: FsRenameResult, from: string, to: string): string | null {
  if (res.ok) return null
  if (res.code === 'exists') return `Can't rename “${from}”: “${to}” already exists in this folder.`
  if (res.code === 'locked') return `Can't rename “${from}”: another app is using it.`
  return res.message ?? `Couldn't rename “${from}”.`
}
