import { join } from 'node:path'
import type { AgentId } from '@shared/types'
import { AGENT_CATALOG, detectNamesFor } from '@shared/agent-catalog'
import { cliCandidateDirs, execNames, isExecutable } from './cli-command-resolver'

function isInstalled(names: string[], dirs: string[]): boolean {
  for (const dir of dirs) {
    for (const name of names) {
      for (const exe of execNames(name)) {
        if (isExecutable(join(dir, exe))) return true
      }
    }
  }
  return false
}

export function detectInstalledAgents(): AgentId[] {
  const dirs = cliCandidateDirs()
  return AGENT_CATALOG.filter((e) => isInstalled(detectNamesFor(e), dirs)).map((e) => e.id)
}
