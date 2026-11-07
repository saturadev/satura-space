import { censusTrack } from '@shared/census'


const pending = new Map<string, string>()
censusTrack('pending-commands.pending', pending)
const pendingEnv = new Map<string, Record<string, string>>()
censusTrack('pending-commands.pendingEnv', pendingEnv)

export function setPendingCommand(ptyId: string, command: string): void {
  pending.set(ptyId, command)
}

export function takePendingCommand(ptyId: string): string | null {
  const cmd = pending.get(ptyId) ?? null
  pending.delete(ptyId)
  return cmd
}

export function setPendingEnv(ptyId: string, env: Record<string, string>): void {
  if (Object.keys(env).length > 0) pendingEnv.set(ptyId, env)
}

export function takePendingEnv(ptyId: string): Record<string, string> | null {
  const env = pendingEnv.get(ptyId) ?? null
  pendingEnv.delete(ptyId)
  return env
}
