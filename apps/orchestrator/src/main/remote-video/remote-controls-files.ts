import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RC_DIR, RC_GENERATED_FILE, RC_OVERRIDES_FILE, applyPatch, asGenerated, resolveControls, type RcEffective, type RcGenerated, type RcPatch } from '@shared/remote-controls'
import { unityProvider } from '../unity/unity-instance-provider'
import { UnityControlClient } from '../unity/unity-control-client'

const COMMAND_MS = 20_000

export function controlsDir(project: string): string {
  return join(project, ...RC_DIR.split('/'))
}

export function generatedPath(project: string): string {
  return join(controlsDir(project), RC_GENERATED_FILE)
}

export function overridesPath(project: string): string {
  return join(controlsDir(project), RC_OVERRIDES_FILE)
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export interface ControlsRead {
  generated: RcGenerated | null
  generatedError: string | null
  overrides: unknown
  overridesError: string | null
  overridesText: string | null
}

export function readControlFiles(project: string): ControlsRead {
  const out: ControlsRead = { generated: null, generatedError: null, overrides: null, overridesError: null, overridesText: null }
  const g = readText(generatedPath(project))
  if (g != null) {
    try {
      out.generated = asGenerated(JSON.parse(g))
      if (!out.generated) out.generatedError = `${RC_GENERATED_FILE} is not a Satura Remote controls file`
    } catch (e) {
      out.generatedError = `${RC_GENERATED_FILE} is not valid JSON: ${(e as Error).message}`
    }
  }
  const o = readText(overridesPath(project))
  out.overridesText = o
  if (o != null && o.trim()) {
    try {
      out.overrides = JSON.parse(o)
    } catch (e) {
      out.overridesError = `${RC_OVERRIDES_FILE} is not valid JSON: ${(e as Error).message}`
    }
  }
  return out
}

export function effectiveFor(project: string, gamepadModule: boolean, overrides?: unknown): RcEffective {
  const r = readControlFiles(project)
  const eff = resolveControls(r.generated, overrides === undefined ? (r.overridesError ? null : r.overrides) : overrides, { gamepadModule })
  if (r.generatedError) eff.issues.unshift({ level: 'error', where: RC_GENERATED_FILE, message: r.generatedError })
  if (overrides === undefined && r.overridesError) eff.issues.unshift({ level: 'error', where: RC_OVERRIDES_FILE, message: `${r.overridesError}. The phone and the effective layout ignore it until it parses.` })
  return eff
}

export function filesStamp(project: string): string {
  const one = (f: string): string => {
    try {
      const s = statSync(f)
      return `${s.mtimeMs}:${s.size}`
    } catch {
      return '-'
    }
  }
  return `${one(generatedPath(project))}|${one(overridesPath(project))}`
}

export function writeOverrides(project: string, value: unknown): void {
  mkdirSync(controlsDir(project), { recursive: true })
  const file = overridesPath(project)
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n')
  renameSync(file + '.tmp', file)
}

export function patchOverrides(project: string, patch: RcPatch): { ok: boolean; changed: boolean; error?: string } {
  const r = readControlFiles(project)
  if (r.overridesError) return { ok: false, changed: false, error: `${r.overridesError}; fix it before editing from the phone` }
  const res = applyPatch(r.overrides, patch)
  if (res.error) return { ok: false, changed: false, error: res.error }
  if (!res.changed) return { ok: true, changed: false }
  try {
    writeOverrides(project, res.next)
    return { ok: true, changed: true }
  } catch (e) {
    return { ok: false, changed: false, error: (e as Error).message }
  }
}

export async function editorCommand(worldId: string, cmd: string, args: Record<string, unknown>, timeoutMs = COMMAND_MS): Promise<Record<string, unknown>> {
  const ctl = unityProvider.worldControl(worldId)
  if (!ctl || !ctl.alive) throw new Error(`No running editor for ${worldId}`)
  const client = new UnityControlClient(ctl.port)
  try {
    const deadline = Date.now() + timeoutMs
    while (!client.isConnected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    if (!client.isConnected) throw new Error('The editor control socket is not reachable')
    const r = (await client.command(cmd, args, Math.max(1000, deadline - Date.now()))) as Record<string, unknown> | null
    if (!r) throw new Error(`No answer from the editor to ${cmd}`)
    if (r.status !== 'completed') throw new Error(String(r.error ?? `${cmd} failed`))
    return r
  } finally {
    client.close()
  }
}
