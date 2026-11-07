export interface UnityProc {
  pid: number
  command: string
}

const MAC_UNITY_BINARY = 'Unity.app/Contents/MacOS/Unity'
const BEFORE_PATH = /[\s"'=]/
const AFTER_PATH = /[\s"'/]/

export function normalizeCommandPath(s: string): string {
  return s.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()
}

function trimSlash(p: string): string {
  return p.replace(/\/+$/, '')
}

export function commandMentionsPath(command: string, path: string): boolean {
  const needle = trimSlash(normalizeCommandPath(path))
  if (!needle) return false
  const hay = normalizeCommandPath(command)
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const before = i === 0 ? '' : hay[i - 1]
    const after = hay[i + needle.length] ?? ''
    if (before !== '' && !BEFORE_PATH.test(before)) continue
    if (before === '"' || before === "'" ? after === before || after === '/' : after === '' || AFTER_PATH.test(after)) return true
  }
  return false
}

export function cloneDirsInCommand(command: string, vpDir: string): string[] {
  const vp = trimSlash(normalizeCommandPath(vpDir))
  if (!vp) return []
  const hay = normalizeCommandPath(command)
  const found = new Set<string>()
  for (let i = hay.indexOf(vp); i !== -1; i = hay.indexOf(vp, i + 1)) {
    const before = i === 0 ? '' : hay[i - 1]
    if (before !== '' && !BEFORE_PATH.test(before)) continue
    const m = /^\/(mppm[0-9a-f]{8})(?=$|[\s"'/])/.exec(hay.slice(i + vp.length))
    if (m) found.add(m[1])
  }
  return [...found]
}

export function clonePidsUnder(procs: UnityProc[], vpDir: string, selfPid = process.pid): number[] {
  return procs
    .filter((p) => Number.isInteger(p.pid) && p.pid > 0 && p.pid !== selfPid)
    .filter((p) => cloneDirsInCommand(p.command, vpDir).length > 0)
    .map((p) => p.pid)
}

export function pidRunsPath(procs: UnityProc[], pid: number, path: string): boolean {
  const p = procs.find((x) => x.pid === pid)
  return !!p && commandMentionsPath(p.command, path)
}

export function parsePsUnity(out: string): UnityProc[] {
  const procs: UnityProc[] = []
  for (const line of out.split('\n')) {
    if (!line.includes(MAC_UNITY_BINARY)) continue
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    procs.push({ pid: parseInt(m[1], 10), command: m[2] })
  }
  return procs
}

export function parseWinProcLines(out: string): UnityProc[] {
  const procs: UnityProc[] = []
  for (const line of out.split(/\r?\n/)) {
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    const pid = parseInt(line.slice(0, tab).trim(), 10)
    if (!Number.isInteger(pid) || pid <= 0) continue
    procs.push({ pid, command: line.slice(tab + 1) })
  }
  return procs
}

export function parseWinProcInfo(out: string): { image: string; command: string } | null {
  const line = out.split(/\r?\n/).find((l) => l.includes('\t'))
  if (!line) return null
  const tab = line.indexOf('\t')
  return { image: line.slice(0, tab).trim(), command: line.slice(tab + 1) }
}

export function parsePsInfo(out: string): { image: string; command: string } | null {
  const command = out.trim()
  if (!command) return null
  return { image: command.includes(MAC_UNITY_BINARY) ? 'Unity' : command.split(/\s+/)[0], command }
}

export function isCreateProjectCommand(info: { image: string; command: string } | null, target: string): boolean {
  if (!info) return false
  const image = info.image.toLowerCase()
  const unity = image === 'unity.exe' || image === 'unity' || info.command.includes(MAC_UNITY_BINARY)
  if (!unity) return false
  return /(^|\s)-createproject(\s|$)/i.test(info.command) && commandMentionsPath(info.command, target)
}
