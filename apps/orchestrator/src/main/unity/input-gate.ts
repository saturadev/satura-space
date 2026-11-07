import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { InputGateProblem } from '@shared/api'

export const INPUT_GATE_HEAD = 'INPUT SYSTEM REQUIRED'
const PACKAGE = 'com.unity.inputsystem'

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function hasPackage(projectPath: string): boolean {
  if (existsSync(join(projectPath, 'Packages', PACKAGE))) return true
  const text = readText(join(projectPath, 'Packages', 'manifest.json'))
  if (!text) return false
  try {
    const deps = (JSON.parse(text) as { dependencies?: Record<string, unknown> }).dependencies
    return !!deps && Object.prototype.hasOwnProperty.call(deps, PACKAGE)
  } catch {
    return text.includes(`"${PACKAGE}"`)
  }
}

export function inputGateProblem(projectPath: string): InputGateProblem | null {
  const settingsFile = join(projectPath, 'ProjectSettings', 'ProjectSettings.asset')
  const manifestFile = join(projectPath, 'Packages', 'manifest.json')
  const text = readText(settingsFile)
  if (text === null || !text.startsWith('%YAML')) return null
  const lines = text.split('\n')
  let handler = 0
  let settingsLine: number | undefined
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*activeInputHandler:\s*(\d+)/.exec(lines[i])
    if (!m) continue
    handler = Number(m[1])
    settingsLine = i + 1
    break
  }
  const packageMissing = !hasPackage(projectPath)
  if (handler === 1 && !packageMissing) return null
  return { handler, packageMissing, settingsFile, settingsLine, manifestFile }
}

export function inputGateMessage(projectPath: string, p: InputGateProblem): string {
  const found: string[] = []
  if (p.handler === 0) found.push('Active Input Handling is set to Input Manager (Old).')
  else if (p.handler === 2) found.push('Active Input Handling is set to Both.')
  else if (p.handler !== 1) found.push(`Active Input Handling has an unknown value (${p.handler}).`)
  if (p.packageMissing) found.push(`The Input System package (${PACKAGE}) isn't installed.`)
  return [
    `${INPUT_GATE_HEAD}: Satura Space didn't start Unity for ${basename(projectPath)}. ${found.join(' ')}`,
    "Satura Space works only with the Input System. The old Input Manager reads input straight from the OS, so keys and clicks in the Satura panel never reach it, and Both has the same problem.",
    'To fix it in Unity: Edit > Project Settings > Player > Other Settings > Active Input Handling > Input System Package (New), then install Input System from Window > Package Manager.',
    `To fix it without Unity: set activeInputHandler: 1 in ProjectSettings/ProjectSettings.asset and add "${PACKAGE}": "<version>" to the dependencies in Packages/manifest.json, with a version Package Manager lists for your Unity.`,
    'Then launch again.'
  ].join('\n')
}

export function inputGateCheck(projectPath: string): { problem: InputGateProblem; message: string } | null {
  const problem = inputGateProblem(projectPath)
  if (!problem) return null
  return { problem, message: inputGateMessage(projectPath, problem) }
}
