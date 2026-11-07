
import { MAX_PLAYERS } from '@shared/unity/world'
export { primaryWorldId } from '@shared/unity/ids'

export const CLONE_SEP = '::'
export const GRID_SEP = '@@'

export function gridSessionId(ptyId: string, key: string): string {
  return `${ptyId}${GRID_SEP}${key}`
}

export function sessionOwnerPtyId(sessionId: string): string {
  const cuts = [sessionId.indexOf(CLONE_SEP), sessionId.indexOf(GRID_SEP)].filter((i) => i >= 0)
  return cuts.length ? sessionId.slice(0, Math.min(...cuts)) : sessionId
}

export function sessionIdFor(primaryPtyId: string, playerIndex: number): string {
  return playerIndex === 0 ? primaryPtyId : `${primaryPtyId}${CLONE_SEP}${playerIndex}`
}

export function sessionIdsForGroup(primaryPtyId: string): string[] {
  const out = [primaryPtyId]
  for (let k = 1; k < MAX_PLAYERS; k++) out.push(`${primaryPtyId}${CLONE_SEP}${k}`)
  return out
}

export function gridDims(n: number): { cols: number; rows: number } {
  const rows = Math.max(1, Math.ceil(Math.sqrt(n)))
  const cols = Math.max(1, Math.ceil(n / rows))
  return { cols, rows }
}
