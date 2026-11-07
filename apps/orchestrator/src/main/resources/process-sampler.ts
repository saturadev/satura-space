import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

interface ProcRow {
  pid: number
  ppid: number
  cpu: number
  memory: number
}

export interface ProcIndex {
  byPid: Map<number, ProcRow>
  childrenOf: Map<number, number[]>
}

const EXEC_OPTS = { maxBuffer: 16 * 1024 * 1024, timeout: 4000, env: { ...process.env, LC_ALL: 'C' } }

async function enumerateUnix(): Promise<ProcRow[]> {
  const { stdout } = await exec('ps', ['-eo', 'pid=,ppid=,pcpu=,rss='], EXEC_OPTS)
  const rows: ProcRow[] = []
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const parts = t.split(/\s+/)
    if (parts.length < 4) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    const cpu = Number(parts[2])
    const rssKb = Number(parts[3])
    if (!Number.isFinite(pid)) continue
    rows.push({ pid, ppid, cpu: Number.isFinite(cpu) ? cpu : 0, memory: (rssKb || 0) * 1024 })
  }
  return rows
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') {
      fields.push(field)
      field = ''
    } else field += ch
  }
  fields.push(field)
  return fields
}

const winCpuPrev = new Map<number, { cpuTime100ns: number; at: number }>()

async function enumerateWindows(): Promise<ProcRow[]> {
  const { stdout } = await exec(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Csv -NoTypeInformation'
    ],
    EXEC_OPTS
  )
  const now = Date.now()
  const rows: ProcRow[] = []
  const live = new Set<number>()
  let header: string[] | null = null
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line) continue
    const fields = parseCsvLine(line)
    if (!header) {
      header = fields.map((f) => f.trim())
      continue
    }
    const rec: Record<string, string> = {}
    for (let i = 0; i < header.length; i++) rec[header[i]] = fields[i] ?? ''
    const pid = Number(rec.ProcessId)
    if (!Number.isFinite(pid)) continue
    const ppid = Number(rec.ParentProcessId)
    const memory = Number(rec.WorkingSetSize)
    const kernel = Number(rec.KernelModeTime)
    const user = Number(rec.UserModeTime)
    const cpuTime100ns =
      (Number.isFinite(kernel) ? kernel : 0) + (Number.isFinite(user) ? user : 0)
    live.add(pid)
    const prev = winCpuPrev.get(pid)
    winCpuPrev.set(pid, { cpuTime100ns, at: now })
    let cpu = 0
    if (prev) {
      const elapsedMs = now - prev.at
      const busyMs = (cpuTime100ns - prev.cpuTime100ns) / 10000
      if (elapsedMs > 0 && busyMs >= 0) {
        cpu = (busyMs / elapsedMs) * 100
      }
    }
    rows.push({
      pid,
      ppid: Number.isFinite(ppid) ? ppid : 0,
      cpu,
      memory: Number.isFinite(memory) ? memory : 0
    })
  }
  for (const pid of winCpuPrev.keys()) {
    if (!live.has(pid)) winCpuPrev.delete(pid)
  }
  return rows
}

export async function enumerateProcesses(): Promise<ProcIndex | null> {
  let rows: ProcRow[]
  try {
    rows = process.platform === 'win32' ? await enumerateWindows() : await enumerateUnix()
  } catch {
    return null
  }
  const byPid = new Map<number, ProcRow>()
  const childrenOf = new Map<number, number[]>()
  for (const r of rows) {
    byPid.set(r.pid, r)
    const kids = childrenOf.get(r.ppid)
    if (kids) kids.push(r.pid)
    else childrenOf.set(r.ppid, [r.pid])
  }
  return { byPid, childrenOf }
}

export function pidMetrics(index: ProcIndex, pid: number): { cpu: number; memory: number } | null {
  const row = index.byPid.get(pid)
  return row ? { cpu: row.cpu, memory: row.memory } : null
}

export function sumSubtree(
  index: ProcIndex,
  root: number,
  claimed?: Set<number>
): { cpu: number; memory: number } | null {
  if (!index.byPid.has(root)) return null
  let cpu = 0
  let memory = 0
  let counted = false
  const stack = [root]
  const seen = new Set<number>()
  while (stack.length) {
    const pid = stack.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    if (!claimed || !claimed.has(pid)) {
      const row = index.byPid.get(pid)
      if (row) {
        cpu += row.cpu
        memory += row.memory
        counted = true
        claimed?.add(pid)
      }
    }
    const kids = index.childrenOf.get(pid)
    if (kids) stack.push(...kids)
  }
  return counted ? { cpu, memory } : null
}
