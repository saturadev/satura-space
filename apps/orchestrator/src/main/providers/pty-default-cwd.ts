import { homedir } from 'node:os'

import { isRootLikePath } from './pty-path-safety'

function homeDrivePath(env: NodeJS.ProcessEnv): string | null {
  if (!env.HOMEDRIVE || !env.HOMEPATH) {
    return null
  }
  return `${env.HOMEDRIVE}${env.HOMEPATH}`
}

export function isSafeImplicitPtyCwd(path: string | null | undefined): path is string {
  return !isRootLikePath(path)
}

export function resolveSafePtyDefaultCwd(env: NodeJS.ProcessEnv = process.env): string {
  const candidates =
    process.platform === 'win32'
      ? [env.USERPROFILE, homeDrivePath(env), homedir()]
      : [env.HOME, homedir()]
  const selected = candidates.find(isSafeImplicitPtyCwd)
  if (!selected) {
    console.error(
      '[pty-default-cwd] No safe default working directory for terminal launch; every home candidate resolved to a root-like path.',
      { platform: process.platform, candidates }
    )
    throw new Error('No safe default working directory is available for terminal launch.')
  }
  return selected
}
