import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { gitStatusLabel, type GitPathInfo, type PathHoverInfo, type ReportHoverInfo } from '@shared/hover-info'
import { buildReportTree, nestedCount } from '@shared/report-tree'
import { execGit } from './git/exec-git'
import { listReports } from './report/list'
import { reportOwner } from './satura-exec'

const GIT_TIMEOUT = 2000

async function gitInfo(path: string, isDirectory: boolean): Promise<GitPathInfo | null> {
  const cwd = isDirectory ? path : dirname(path)
  try {
    const { stdout } = await execGit(['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout: GIT_TIMEOUT
    })
    const [root, gitDir, commonDir, head] = stdout.split('\n').map((l) => l.trim())
    if (!root) return null
    const abs = (p: string): string => (isAbsolute(p) ? p : resolve(cwd, p))
    const info: GitPathInfo = {
      root,
      branch: head && head !== 'HEAD' ? head : null,
      worktree: !!gitDir && !!commonDir && abs(gitDir) !== abs(commonDir)
    }
    if (!isDirectory) {
      const status = await execGit(['status', '--porcelain=v1', '--ignored=matching', '--', path], { cwd: root, timeout: GIT_TIMEOUT }).catch(() => null)
      info.status = status ? gitStatusLabel(status.stdout) : null
    }
    return info
  } catch {
    return null
  }
}

export async function pathHoverInfo(path: string, withGit: boolean): Promise<PathHoverInfo> {
  const home = homedir()
  if (!path || !isAbsolute(path)) return { exists: false, isDirectory: false, home, git: null }
  const s = await stat(path).catch(() => null)
  if (!s) return { exists: false, isDirectory: false, home, git: null }
  return {
    exists: true,
    isDirectory: s.isDirectory(),
    size: s.isFile() ? s.size : undefined,
    mtimeMs: s.mtimeMs,
    home,
    git: withGit ? await gitInfo(path, s.isDirectory()) : null
  }
}

export async function reportHoverInfo(file: string, root: string): Promise<ReportHoverInfo> {
  const s = await stat(file).catch(() => null)
  const list = root ? await listReports(root).catch(() => []) : []
  const norm = (p: string): string => p.replace(/\\/g, '/')
  const self = list.find((r) => norm(r.file) === norm(file))
  return {
    bytes: s ? s.size : null,
    mtimeMs: s ? s.mtimeMs : null,
    owner: reportOwner(file),
    links: self?.links.length ?? 0,
    nested: self ? nestedCount(buildReportTree(list), self.file) : 0,
    home: homedir()
  }
}
