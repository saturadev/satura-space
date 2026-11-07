import { app } from 'electron'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

export interface DaemonLaunchTarget {
  execPath: string
  entryPath: string
}

const SUPPORT_FILES = ['icudtl.dat', 'v8_context_snapshot.bin', 'snapshot_blob.bin']
const DAEMON_EXE = 'satura-daemon.exe'
const READY_MARKER = 'runtime-ready.json'

function usesIsolatedRuntime(): boolean {
  return app.isPackaged && process.platform === 'win32'
}

function runtimeRoot(): string {
  return join(app.getPath('userData'), 'daemon-runtime')
}

function currentVersionDir(): string {
  return join(runtimeRoot(), app.getVersion())
}

function unpackedBase(): string {
  return app.getAppPath().replace('app.asar', 'app.asar.unpacked')
}

function runtimeEntryPath(bundledEntryPath: string): string {
  return join(currentVersionDir(), 'app', relative(unpackedBase(), bundledEntryPath))
}

export function expectedDaemonEntryPath(bundledEntryPath: string): string {
  return usesIsolatedRuntime() ? runtimeEntryPath(bundledEntryPath) : bundledEntryPath
}

function isRuntimeReady(dir: string, entryPath: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(dir, READY_MARKER), 'utf8')) as {
      exeSize?: number
      exeMtimeMs?: number
    }
    const installedExe = statSync(process.execPath)
    return (
      marker.exeSize === installedExe.size &&
      marker.exeMtimeMs === installedExe.mtimeMs &&
      existsSync(join(dir, DAEMON_EXE)) &&
      existsSync(entryPath)
    )
  } catch {
    return false
  }
}

export async function prepareDaemonLaunchTarget(
  bundledEntryPath: string
): Promise<DaemonLaunchTarget> {
  if (!usesIsolatedRuntime()) {
    return { execPath: process.execPath, entryPath: bundledEntryPath }
  }
  const dir = currentVersionDir()
  const target = {
    execPath: join(dir, DAEMON_EXE),
    entryPath: runtimeEntryPath(bundledEntryPath)
  }
  if (isRuntimeReady(dir, target.entryPath)) {
    return target
  }
  try {
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const exeDir = dirname(process.execPath)
    await cp(process.execPath, target.execPath)
    for (const file of SUPPORT_FILES) {
      const src = join(exeDir, file)
      if (existsSync(src)) await cp(src, join(dir, file))
    }
    await cp(unpackedBase(), join(dir, 'app'), { recursive: true })
    const installedExe = statSync(process.execPath)
    writeFileSync(
      join(dir, READY_MARKER),
      JSON.stringify({ exeSize: installedExe.size, exeMtimeMs: installedExe.mtimeMs, at: Date.now() })
    )
    console.log(`[daemon] materialized isolated runtime at ${dir}`)
    return target
  } catch (e) {
    console.error(
      `[daemon] failed to materialize isolated runtime, falling back to bundled exe: ${(e as Error).message}`
    )
    return { execPath: process.execPath, entryPath: bundledEntryPath }
  }
}

export function pruneStaleDaemonRuntimes(): void {
  if (!usesIsolatedRuntime()) return
  let entries: string[]
  try {
    entries = readdirSync(runtimeRoot())
  } catch {
    return
  }
  const current = app.getVersion()
  for (const entry of entries) {
    if (entry === current) continue
    const dir = join(runtimeRoot(), entry)
    try {
      unlinkSync(join(dir, DAEMON_EXE))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') continue
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
    }
  }
}
