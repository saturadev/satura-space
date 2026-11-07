import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defineHandle } from './registry'

const SEED_ROOT = join(tmpdir(), 'satura-handles')

const GIT_ENV = ((): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0'
  }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete env[key]
  return env
})()

let lastSeed = ''
let clock = Date.parse('2026-01-01T12:00:00Z')

function git(repo: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...GIT_ENV, ...env }, maxBuffer: 64 * 1024 * 1024 }).replace(/\s+$/, '').replace(/^\n+/, '')
}

function tryGit(repo: string, args: string[]): string {
  try {
    return git(repo, args)
  } catch {
    return ''
  }
}

function write(root: string, rel: string, body: string): void {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
}

function configure(repo: string, name: string, email: string): void {
  git(repo, ['config', 'user.name', name])
  git(repo, ['config', 'user.email', email])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['config', 'core.fsmonitor', 'false'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  git(repo, ['config', 'core.hooksPath', '/dev/null'])
}

function commitAll(repo: string, subject: string): string {
  clock += 60_000
  const date = new Date(clock).toISOString()
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', subject], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
  return git(repo, ['rev-parse', '--short', 'HEAD'])
}

function lines(text: string): string[] {
  return text ? text.split('\n') : []
}

export function gitState(repo: string): Record<string, unknown> {
  if (!existsSync(join(repo, '.git'))) throw new Error(`${repo} is not a git repository.`)
  const branch = tryGit(repo, ['branch', '--show-current'])
  const upstream = tryGit(repo, ['rev-parse', '--abbrev-ref', '@{upstream}'])
  const status = lines(tryGit(repo, ['status', '--porcelain=v1', '--untracked-files=all']))
  const counts = upstream ? tryGit(repo, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]).split(/\s+/).map(Number) : []
  return {
    repo,
    branch,
    head: tryGit(repo, ['rev-parse', '--short', 'HEAD']),
    upstream: upstream || null,
    ahead: counts[0] ?? 0,
    behind: counts[1] ?? 0,
    commits: lines(tryGit(repo, ['log', '--format=%h %s', '-n', '10'])),
    status,
    conflicts: status.filter((l) => /^(DD|AU|UD|UA|DU|AA|UU) /.test(l)).map((l) => l.slice(3)),
    stashes: lines(tryGit(repo, ['stash', 'list', '--format=%gd %gs'])),
    remotes: lines(tryGit(repo, ['remote', '-v'])).filter((l) => l.endsWith('(fetch)')).map((l) => l.replace(/\s+\(fetch\)$/, '')),
    merging: existsSync(join(repo, '.git', 'MERGE_HEAD')),
    rebasing: existsSync(join(repo, '.git', 'rebase-merge')) || existsSync(join(repo, '.git', 'rebase-apply'))
  }
}

defineHandle({
  name: 'git.seed',
  side: 'main',
  description:
    'Builds a throwaway git repo in the temp folder (never the project repo) and opens it as a workspace with the Git view. commits is how many commits main gets; origin adds a bare remote and pushes main to it; ahead adds local commits that are not pushed; behind pushes that many commits to origin from another clone and fetches them; stash adds stash entries, each holding a new file src/stash-N.txt, so they pop cleanly; dirty leaves a modified, a staged and an untracked file. With open, workspaces of earlier seeded repos are closed first and the new one comes to the front. Returns the repo path, its git state and the Git panel. To drive that Git view with page, make the repo the project of later calls (--project in the CLI), and use git.view to read what the view shows.',
  params: { commits: 3, origin: true, ahead: 0, behind: 0, stash: 0, dirty: true, open: true },
  async run(p, ctx) {
    mkdirSync(SEED_ROOT, { recursive: true })
    const base = realpathSync(mkdtempSync(join(SEED_ROOT, 'git-')))
    const repo = join(base, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    configure(repo, 'Satura Handles', 'handles@saturaspace.test')
    write(repo, 'README.md', '# Seeded repo\n')
    write(repo, 'src/app.txt', 'line 1\n')
    commitAll(repo, 'chore: initial commit')
    const n = Math.max(1, Math.floor(Number(p.commits) || 1))
    for (let i = 2; i <= n; i++) {
      write(repo, `src/file-${i}.txt`, `file ${i}\n`)
      commitAll(repo, `feat: add file ${i}`)
    }
    if (p.origin) {
      const origin = join(base, 'origin.git')
      mkdirSync(origin)
      git(origin, ['init', '-q', '--bare', '-b', 'main'])
      git(repo, ['remote', 'add', 'origin', origin])
      git(repo, ['push', '-q', '-u', 'origin', 'main'])
      const behind = Math.max(0, Math.floor(Number(p.behind) || 0))
      if (behind) {
        git(base, ['clone', '-q', origin, 'upstream'])
        const up = join(base, 'upstream')
        configure(up, 'Satura Upstream', 'upstream@saturaspace.test')
        for (let i = 1; i <= behind; i++) {
          write(up, `upstream/change-${i}.txt`, `upstream ${i}\n`)
          commitAll(up, `feat: upstream change ${i}`)
        }
        git(up, ['push', '-q', 'origin', 'main'])
        git(repo, ['fetch', '-q', 'origin'])
      }
    }
    for (let i = 1; i <= Math.max(0, Math.floor(Number(p.ahead) || 0)); i++) {
      write(repo, `src/local-${i}.txt`, `local ${i}\n`)
      commitAll(repo, `feat: local change ${i}`)
    }
    for (let i = 1; i <= Math.max(0, Math.floor(Number(p.stash) || 0)); i++) {
      write(repo, `src/stash-${i}.txt`, `stashed ${i}\n`)
      git(repo, ['stash', 'push', '-q', '-u', '-m', `stash ${i}`])
    }
    if (p.dirty) {
      write(repo, 'src/app.txt', 'line 1\nline 2 (modified)\n')
      write(repo, 'src/staged.txt', 'staged\n')
      git(repo, ['add', 'src/staged.txt'])
      write(repo, 'notes/untracked.txt', 'untracked\n')
    }
    lastSeed = repo
    const closed = p.open ? await ctx.renderer('workspace.close', { under: realpathSync(SEED_ROOT), keep: repo }).catch(() => null) : null
    const opened = p.open ? ((await ctx.renderer('layout.open', { kind: 'git', folder: repo })) as { tab: unknown; workspace: string }) : null
    const panel = opened ? { tab: opened.tab, workspace: opened.workspace } : null
    return { ...gitState(repo), ...(panel ? { panel } : {}), ...(closed ? { closedWorkspaces: (closed as { closed: string[] }).closed } : {}) }
  }
})

defineHandle({
  name: 'git.state',
  side: 'main',
  description:
    'Reads a repo with the git CLI. repo defaults to the last git.seed repo, then the project. Returns branch, head, upstream with ahead and behind counts, the last 10 commits, porcelain status lines, conflicts (paths git marks unmerged, also after a stash pop that conflicts), stashes, remotes and whether a merge or rebase is in progress.',
  params: { repo: '' },
  async run(p, ctx) {
    const repo = String(p.repo ?? '').trim() || lastSeed || ctx.projectRoot
    if (!repo) throw new Error('Pass repo: no git.seed repo yet and no project for this call.')
    return gitState(repo)
  }
})
