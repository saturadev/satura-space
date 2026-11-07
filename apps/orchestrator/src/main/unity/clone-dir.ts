import { lstatSync, rmSync, rmdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const CLONE_LINKS = ['Assets', 'ProjectSettings'] as const

function isCloneDirPath(cloneDir: string): boolean {
  return !!cloneDir && /^mppm[0-9a-f]{8}$/.test(basename(cloneDir)) && basename(dirname(cloneDir)) === 'VP'
}

function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

function detach(link: string): void {
  try {
    unlinkSync(link)
    return
  } catch {
  }
  try {
    rmdirSync(link)
  } catch (e) {
    console.log(`[unity] could not detach clone link ${link}: ${(e as Error).message}`)
  }
}

export function removeCloneDirSafely(cloneDir: string): boolean {
  if (!isCloneDirPath(cloneDir)) {
    console.log(`[unity] refusing to remove non-clone dir: ${cloneDir}`)
    return false
  }
  for (const name of CLONE_LINKS) {
    const link = join(cloneDir, name)
    if (present(link)) detach(link)
  }
  const left = CLONE_LINKS.filter((name) => present(join(cloneDir, name)))
  if (left.length) {
    console.log(`[unity] refusing to remove clone dir ${cloneDir}: ${left.join(' and ')} could not be detached and may point into the project`)
    return false
  }
  try {
    rmSync(cloneDir, { recursive: true, force: true })
    return true
  } catch (e) {
    console.log(`[unity] removeCloneDir ${cloneDir} failed: ${(e as Error).message}`)
    return false
  }
}
