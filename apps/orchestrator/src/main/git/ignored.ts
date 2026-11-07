import { execGit } from './exec-git'

export async function listIgnoredPaths(rootPath: string): Promise<string[]> {
  if (!rootPath) return []
  try {
    const { stdout } = await execGit(
      [
        '-C',
        rootPath,
        'ls-files',
        '-o',
        '-i',
        '--exclude-standard',
        '--directory',
        '--no-empty-directory',
        '-z'
      ],
      { maxBuffer: 64 * 1024 * 1024 }
    )
    return stdout
      .split('\0')
      .map((s) => s.replace(/\/+$/, ''))
      .filter(Boolean)
  } catch {
    return []
  }
}
