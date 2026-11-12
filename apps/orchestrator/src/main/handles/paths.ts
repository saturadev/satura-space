import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { DEFAULT_SETTINGS } from '@shared/types'
import { isInside } from '../safe-fs'
import { insideRoot, scopeAllows, type OpenScope } from '../open-roots'
import { assertAbsolute, normalizeInputPath } from '../ipc/fs'
import { revealTarget } from '../ipc/git-scm'
import { scmIgnoreTargets, scmReadable, scmTrashable, scmWritableTarget } from '../git/scm/repository'
import { projectFile } from '../dashboard/sources'
import { reportStat } from '../report/report-frame-protocol'
import { reportMediaRefusal } from '../remote/media-read'
import { reportServable } from '../report/report-protocol'
import { mediaServable } from '../media-protocol'
import { planOpenPath } from '../ipc/open-path-plan'
import { projectRootOf } from '../report/code-refs'
import { vetPhoneCall, type PathUse } from '../remote/phone-policy'
import { defineHandle } from './registry'
import { applyLayout, jailed, jailRoot, scratchFor } from './scratch'

type Verdict = { allow: boolean; detail?: unknown }

const DEMO = {
  dirs: ['project/src', 'project/new'],
  files: {
    'project/src/a.txt': 'inside\n',
    'project/.git/HEAD': 'ref: refs/heads/main\n',
    'project/.sspace/dashboard/secrets.json': '{"token":"x"}\n',
    'project/.sspace/report.tsx': 'export default () => null\n',
    'outside/secret.txt': 'outside\n'
  },
  links: {
    'project/link-in': 'src',
    'project/link-out': '../outside',
    'project/link-file': '../outside/secret.txt',
    'project/dangling': '../outside/missing.txt',
    'project/src/loop': '../link-out'
  }
}

const DEMO_PATHS = ['src/a.txt', 'link-in/a.txt', 'link-out/secret.txt', 'link-file', 'dangling', 'src/loop/secret.txt', '../outside/secret.txt', 'src/../../outside/secret.txt', '.git/HEAD', '.GIT/config', '.sspace/dashboard/secrets.json', 'new/deep/file.txt', '', '.', '~/notes.txt', 'C:\\Windows\\win.ini']

const PHONE_PROBES: { ch: string; use: PathUse; args: (abs: string, rel: string, root: string) => unknown[] }[] = [
  { ch: 'fs:readFile', use: 'read', args: (abs) => [abs] },
  { ch: 'fs:writeFile', use: 'write', args: (abs) => [{ filePath: abs, content: '' }] },
  { ch: 'fs:rename', use: 'write', args: (abs, _rel, root) => [{ oldPath: join(root, 'src', 'a.txt'), newPath: abs }] },
  { ch: 'remote:readMedia', use: 'media', args: (abs) => [{ path: abs }] },
  { ch: 'remote:attach', use: 'write', args: (abs) => [{ root: abs, id: 'abcdef12', ext: 'png' }] },
  { ch: 'gitScm:writeFile', use: 'write', args: (_abs, rel, root) => [root, rel] },
  { ch: 'app:reportAction', use: 'read', args: (abs, _rel, root) => [abs, '', root] },
  { ch: 'plugin:call', use: 'write', args: (abs) => ['assets', 'import', abs, {}] },
  { ch: 'plugin:project', use: 'read', args: (abs) => [abs] }
]

function kindOf(abs: string): Record<string, unknown> {
  try {
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) {
      let real: string | null = null
      try {
        real = realpathSync(abs)
      } catch {
        real = null
      }
      return { kind: 'link', link: readlinkSync(abs), real }
    }
    return { kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', real: realpathSync(abs) }
  } catch {
    return { kind: 'missing' }
  }
}

async function verdict(run: () => unknown): Promise<Verdict> {
  try {
    const v = await run()
    if (typeof v === 'boolean') return { allow: v }
    if (v === null || v === undefined || v === '') return { allow: false, detail: v ?? null }
    return { allow: true, detail: v }
  } catch (e) {
    return { allow: false, detail: (e as Error).message }
  }
}

defineHandle({
  name: 'paths.guard',
  side: 'main',
  agentOnly: true,
  description:
    "Feeds paths to every path guard in the app and reports what each one allows, without reading or writing through them: safeFs.isInside, openRoots.insideRoot (the phone, report and media checks build on it), fsIpc.assertAbsolute and fsIpc.normalizeInputPath (the fs: IPC handlers), gitScm.write / read / trash / ignore / reveal (the Git view's writeFile, working-tree reads, discard to Trash, add to .gitignore and reveal in Finder), dashboard.projectFile (useFile in dashboard widgets), reportFrame.stat and reportProtocol.servable (reports and their frames), phone.reportMedia (what a report on the phone may stream: inside its project, or a phone version or still made from such a file), mediaProtocol.servable (satura-media:// in the window: open folders and files open in viewers), shell.openPath (the terminal's folder links: allow means it opens, a refusal says whether it is revealed instead), and phone.<channel> (src/main/remote/phone-policy.ts vetPhoneCall for fs:readFile, fs:writeFile, fs:rename, remote:readMedia, gitScm:writeFile, app:reportAction, plugin:call (the path as the project root of a plugin handle, which may write) and plugin:project, plus remote:attach, which takes the path as the project root and writes a phone image to .sspace/attachments under it, with root and roots as the folders open on the Mac and files as the files open in viewers). root is the project or repo the guards protect and must be in a scratch dir; root: '' builds a demo layout (project/ with src, .git, .sspace/dashboard/secrets.json and links to ../outside, a dangling link and a link loop, next to outside/secret.txt) and checks a default list of tricky paths. paths are relative to root or absolute; make your own symlinks with scratch.dir links first. guards filters by name prefix. Returns per path its resolved form, what is on disk (kind, link target, real path) and per guard allow plus detail (the resolved target or the refusal).",
  params: { root: '', paths: [] as string[], roots: [] as string[], files: [] as string[], guards: [] as string[], keep: false },
  async run(p, ctx) {
    let root: string
    let paths = Array.isArray(p.paths) ? p.paths.map(String) : []
    let scratch: string | null = null
    if (!String(p.root ?? '').trim()) {
      const s = scratchFor({ root: '', keep: p.keep }, ctx, 'paths.guard demo')
      applyLayout(s.root, DEMO)
      scratch = s.root
      root = join(s.root, 'project')
      if (!paths.length) paths = DEMO_PATHS
    } else root = jailed(p.root, 'root')
    if (!paths.length) throw new Error('Pass paths: relative to root or absolute.')
    const roots = [root, ...(Array.isArray(p.roots) ? p.roots.map((r) => jailed(r, 'roots')) : [])]
    const files = Array.isArray(p.files) ? p.files.map((f) => jailed(f, 'files')) : []
    const scope: OpenScope = { roots, files }
    const mediaDir = join(jailRoot(), 'no-media')
    const phoneCtx = { inside: (x: string, use: PathUse) => scopeAllows(scope, x, use, mediaDir), ptyExists: () => false, settings: () => DEFAULT_SETTINGS }
    const want = Array.isArray(p.guards) ? p.guards.map(String).filter(Boolean) : []
    const on = (name: string): boolean => !want.length || want.some((w) => name.startsWith(w))
    const reportFile = join(root, '.sspace', 'report.tsx')
    const rows: Record<string, unknown>[] = []
    for (const raw of paths) {
      const abs = raw.startsWith('~') || raw === '' ? raw : isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
      const rel = isAbsolute(raw) ? relative(root, resolve(raw)) : raw
      const absOk = isAbsolute(abs)
      const g: Record<string, Verdict> = {}
      const add = async (name: string, run: () => unknown): Promise<void> => {
        if (on(name)) g[name] = await verdict(run)
      }
      await add('safeFs.isInside', () => absOk && isInside(root, abs))
      await add('openRoots.insideRoot', () => absOk && insideRoot(root, abs))
      await add('fsIpc.assertAbsolute', () => assertAbsolute(raw))
      await add('fsIpc.normalizeInputPath', () => normalizeInputPath(raw))
      await add('gitScm.write', () => scmWritableTarget(root, rel))
      await add('gitScm.read', () => scmReadable(root, rel))
      await add('gitScm.trash', () => scmTrashable(root, rel))
      await add('gitScm.ignore', () => scmIgnoreTargets(root, [rel]))
      await add('gitScm.reveal', () => {
        const r = revealTarget(root, rel)
        if (!r.ok) throw new Error(r.message)
        return r.target
      })
      await add('dashboard.projectFile', () => projectFile(root, raw))
      await add('reportFrame.stat', async () => {
        if (!absOk) throw new Error('not absolute')
        const project = projectRootOf(reportFile, root)
        const allowed = insideRoot(project, abs)
        const stat = await reportStat(reportFile, root, abs)
        if (!allowed) throw new Error(`refused: outside ${project}`)
        return stat
      })
      await add('phone.reportMedia', () => {
        const why = reportMediaRefusal({ file: reportFile, root }, abs, (x) => scopeAllows(scope, x, 'media', mediaDir))
        if (why) throw new Error(why)
        return true
      })
      await add('reportProtocol.servable', () => absOk && reportServable(abs, scope))
      await add('mediaProtocol.servable', () => absOk && mediaServable(abs, scope))
      await add('shell.openPath', async () => {
        const plan = await planOpenPath(abs)
        if (plan.action !== 'open') throw new Error(`${plan.action}: ${plan.reason}`)
        return plan.resolved
      })
      for (const probe of PHONE_PROBES) {
        await add(`phone.${probe.ch}`, () => {
          const v = vetPhoneCall(probe.ch, probe.args(abs, rel, root), phoneCtx)
          if (!v.ok) throw new Error(v.reason)
          return true
        })
      }
      const allowed = Object.entries(g).filter(([, v]) => v.allow).map(([k]) => k)
      rows.push({ path: raw, resolved: abs, ...(absOk ? kindOf(abs) : {}), allowedBy: allowed.length, guards: g })
      ctx.log(`${raw || '(empty)'}: allowed by ${allowed.length ? allowed.join(', ') : 'none'}`)
    }
    return { root, ...(scratch ? { scratch } : {}), roots, files, paths: rows }
  }
})
