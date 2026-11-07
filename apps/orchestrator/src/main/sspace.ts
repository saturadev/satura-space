import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export const SSPACE_DIR = '.sspace'
export const SSPACE_GITIGNORE = '*\n'

export function sspaceIgnoresEverything(content: string): boolean {
  const rules = content
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line && !line.startsWith('#'))
  return rules.includes('*') && !rules.some((line) => line.startsWith('!'))
}

function missing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

export function ensureSspaceDirSync(sspaceDir: string): string {
  mkdirSync(sspaceDir, { recursive: true })
  const gitignore = join(sspaceDir, '.gitignore')
  let current: string | undefined
  try {
    current = readFileSync(gitignore, 'utf8')
  } catch (err) {
    if (!missing(err)) return sspaceDir
  }
  if (current === undefined || !sspaceIgnoresEverything(current)) {
    try {
      writeFileSync(gitignore, SSPACE_GITIGNORE)
    } catch {
    }
  }
  return sspaceDir
}

export async function ensureSspaceDir(sspaceDir: string): Promise<string> {
  await mkdir(sspaceDir, { recursive: true })
  const gitignore = join(sspaceDir, '.gitignore')
  let current: string | undefined
  try {
    current = await readFile(gitignore, 'utf8')
  } catch (err) {
    if (!missing(err)) return sspaceDir
  }
  if (current === undefined || !sspaceIgnoresEverything(current)) {
    await writeFile(gitignore, SSPACE_GITIGNORE).catch(() => undefined)
  }
  return sspaceDir
}

export function ensureProjectSspaceSync(projectPath: string): string {
  return ensureSspaceDirSync(join(projectPath, SSPACE_DIR))
}

export function ensureSspaceForSync(path: string): void {
  let dir = resolve(path)
  while (true) {
    if (basename(dir) === SSPACE_DIR) {
      ensureSspaceDirSync(dir)
      return
    }
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}
