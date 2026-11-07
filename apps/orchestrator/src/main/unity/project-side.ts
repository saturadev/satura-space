import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execGit } from '../git/exec-git'
import { atomicWriteFileSync } from '../safe-fs'
import { stripSaturaPackages } from './manifest-leftovers'

export const SATURA_DEFINE = 'SATURA_SPACE'
const DEFINE_LINE = `-define:${SATURA_DEFINE}`
const RSP_REL = 'Assets/csc.rsp'
const OLD_SDK_REL = 'Packages/com.saturaspace.sdk'

export const SIDE_PATHS = [
  'Packages/com.saturaspace.engine/',
  'Packages/com.saturaspace.engine.staging~/',
  'Packages/com.saturaspace.engine.old~/',
  '.sspace/',
  RSP_REL,
  `${RSP_REL}.meta`,
  '.mcp.json',
  '.claude/settings.local.json',
  '.cursor/mcp.json',
  'ProjectSettings/SaturaRemote/'
]

const IDE_FILES = ['*.csproj', '*.sln', '*.slnx']

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

async function git(projectPath: string, args: string[]): Promise<string | null> {
  try {
    return (await execGit(['-C', projectPath, ...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })).stdout
  } catch {
    return null
  }
}

export function removeSaturaLeftovers(projectPath: string): void {
  const manifestPath = join(projectPath, 'Packages', 'manifest.json')
  try {
    const text = readText(manifestPath)
    const r = text === null ? null : stripSaturaPackages(text)
    if (r && !r.ok) console.error(`[unity] ${manifestPath} is not valid JSON (${r.error}); left it untouched`)
    else if (r && r.removed.length) {
      atomicWriteFileSync(manifestPath, r.text)
      console.log(
        `[unity] removed Satura Space leftovers from ${manifestPath}: ${r.removed.join(', ')}${r.reformatted ? ' (the file was rewritten with the same indentation)' : ''}`
      )
    }
  } catch (e) {
    console.error(`[unity] could not clean ${manifestPath}: ${(e as Error).message}`)
  }
  const oldSdk = join(projectPath, ...OLD_SDK_REL.split('/'))
  if (!existsSync(oldSdk)) return
  try {
    rmSync(oldSdk, { recursive: true, force: true })
    console.log(`[unity] removed the old Satura Space SDK folder ${oldSdk}`)
  } catch (e) {
    console.error(`[unity] could not remove the old Satura Space SDK folder ${oldSdk}: ${(e as Error).message}`)
  }
}

export function definesSatura(rsp: string): boolean {
  return new RegExp(`^\\s*[-/]d(?:efine)?:\\S*\\b${SATURA_DEFINE}\\b`, 'm').test(rsp)
}

export async function ensureSaturaDefine(projectPath: string): Promise<void> {
  const rsp = join(projectPath, ...RSP_REL.split('/'))
  try {
    const text = readText(rsp)
    if (text !== null && definesSatura(text)) return
    if (text === null) {
      atomicWriteFileSync(rsp, `${DEFINE_LINE}\n`)
      console.log(`[unity] wrote ${rsp} with ${DEFINE_LINE}, hidden from git`)
      return
    }
    if ((await git(projectPath, ['ls-files', '--', RSP_REL]))?.trim()) {
      console.error(
        `[unity] ${rsp} is the project's own and tracked by git, so Satura Space leaves it as it is and ${SATURA_DEFINE} is not defined: game code inside #if UNITY_EDITOR && ${SATURA_DEFINE} stays compiled out. Game asmdefs can still get it with a versionDefines entry on com.saturaspace.engine. Moving its options into Player Settings (Allow 'unsafe' Code for -unsafe) and deleting the file lets Satura Space write its own.`
      )
      return
    }
    atomicWriteFileSync(rsp, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${DEFINE_LINE}\n`)
    console.log(`[unity] added ${DEFINE_LINE} to the untracked ${rsp}`)
  } catch (e) {
    console.error(`[unity] could not write ${rsp}: ${(e as Error).message}`)
  }
}

function excludePattern(prefix: string, rel: string): string {
  return `/${prefix}${rel}`.replace(/[*?[\\]/g, (c) => `\\${c}`)
}

export async function hideSaturaFiles(projectPath: string): Promise<void> {
  const out = await git(projectPath, ['rev-parse', '--git-common-dir', '--show-prefix'])
  if (out === null) return
  const [commonDir = '', prefix = ''] = out.split(/\r?\n/).map((l) => l.trim())
  if (!commonDir || prefix.split('/').includes('.sspace')) return
  const exclude = join(resolve(projectPath, commonDir), 'info', 'exclude')
  try {
    const current = readText(exclude) ?? ''
    const have = new Set(current.split(/\r?\n/).map((l) => l.trim()))
    const missing = [...SIDE_PATHS.map((rel) => excludePattern(prefix, rel)), ...IDE_FILES.map((glob) => excludePattern(prefix, '') + glob)].filter((l) => !have.has(l))
    if (missing.length) {
      mkdirSync(dirname(exclude), { recursive: true })
      atomicWriteFileSync(exclude, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`)
      console.log(`[unity] hid Satura Space files from git in ${exclude}: ${missing.join(' ')}`)
    }
  } catch (e) {
    console.error(`[unity] could not update ${exclude}: ${(e as Error).message}`)
  }
  let ownRsp = true
  try {
    ownRsp = !definesSatura(readFileSync(join(projectPath, ...RSP_REL.split('/')), 'utf8'))
  } catch {
    ownRsp = true
  }
  const listed = (await git(projectPath, ['ls-files', '--', ...SIDE_PATHS]))?.split(/\r?\n/).filter(Boolean) ?? []
  const tracked = listed.filter((file) => !(ownRsp && file.startsWith(RSP_REL)))
  if (!tracked.length) return
  const counts = new Map<string, number>()
  for (const file of tracked) {
    const side = SIDE_PATHS.find((rel) => (rel.endsWith('/') ? file.startsWith(rel) : file === rel)) ?? file
    counts.set(side, (counts.get(side) ?? 0) + 1)
  }
  const list = [...counts].map(([rel, n]) => (rel.endsWith('/') ? `${rel} (${n} file${n === 1 ? '' : 's'})` : rel))
  console.error(
    `[unity] git tracks Satura Space files in ${projectPath}: ${list.join(', ')}. info/exclude can't hide tracked files, and Satura Space leaves the repo as it is. To take them out of the repo: git rm -r --cached ${[...counts.keys()].join(' ')}, then commit.`
  )
}
