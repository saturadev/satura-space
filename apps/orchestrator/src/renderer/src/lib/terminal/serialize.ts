import type { Terminal } from '@xterm/xterm'
import type { SerializeAddon } from '@xterm/addon-serialize'
import { censusTrack } from '@shared/census'

const SNAPSHOT_KEY = 'satura.terminalSnapshots'
const SNAPSHOT_SCROLLBACK_ROWS = 1000

const registry = new Map<
  string,
  { term: Terminal; serialize: SerializeAddon; flushOutput?: () => void }
>()
censusTrack('serialize.registry', registry)

const seeded = new Map<string, string>()
censusTrack('serialize.seeded', seeded)

let stored: Record<string, { data?: string }> | null = null

function readStoredSnapshots(): Record<string, { data?: string }> {
  if (stored) return stored
  try {
    const raw = sessionStorage.getItem(SNAPSHOT_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    stored =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, { data?: string }>)
        : {}
  } catch {
    stored = {}
  }
  return stored
}

function writeStoredSnapshots(next: Record<string, { data?: string }>): void {
  stored = next
  try {
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(next))
  } catch {
  }
}

export function registerTerminalSnapshot(
  ptyId: string,
  term: Terminal,
  serialize: SerializeAddon,
  flushOutput?: () => void
): () => void {
  const entry = { term, serialize, flushOutput }
  registry.set(ptyId, entry)
  return () => {
    if (registry.get(ptyId) === entry) registry.delete(ptyId)
  }
}

// Drain renderer-side virtualization queues, then wait for xterm's parser to
// consume every queued write before SerializeAddon reads the cell grid. This is
// the update-restart equivalent of Orca's flushTerminalOutput-before-capture path.
export async function settleTerminalSnapshotsForRestart(): Promise<void> {
  const entries = [...registry.values()]
  for (const entry of entries) {
    try {
      entry.flushOutput?.()
    } catch {
    }
  }
  await Promise.all(
    entries.map(
      ({ term }) =>
        new Promise<void>((resolve) => {
          let settled = false
          const finish = (): void => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolve()
          }
          const timeout = setTimeout(finish, 250)
          try {
            term.write('', finish)
          } catch {
            finish()
          }
        })
    )
  )
}

export function captureAllTerminalSnapshots(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, { serialize }] of registry) {
    try {
      out[id] = serialize.serialize({ scrollback: SNAPSHOT_SCROLLBACK_ROWS })
    } catch {
    }
  }
  return out
}

// Persist both currently mounted terminals and snapshots retained for tabs that are
// not mounted in the active layout. The main process checkpoints this map to disk
// synchronously before a real updater restart.
export function captureTerminalSnapshotsForPersistence(
  livePtyIds: ReadonlySet<string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, entry] of Object.entries(readStoredSnapshots())) {
    if (livePtyIds.has(id) && typeof entry.data === 'string') out[id] = entry.data
  }
  for (const [id, data] of Object.entries(captureAllTerminalSnapshots())) {
    if (livePtyIds.has(id)) out[id] = data
  }
  return out
}

export function storeTerminalSnapshotsForReload(snapshots: Record<string, string>): void {
  const next: Record<string, { data: string }> = {}
  for (const [id, data] of Object.entries(snapshots)) next[id] = { data }
  writeStoredSnapshots(next)
}

export function consumeTerminalSnapshot(ptyId: string): string | null {
  const moved = seeded.get(ptyId)
  if (moved != null) {
    seeded.delete(ptyId)
    return moved
  }
  return readStoredSnapshots()[ptyId]?.data ?? null
}

export function captureTerminalSnapshot(ptyId: string): string | null {
  const entry = registry.get(ptyId)
  if (!entry) return null
  try {
    return entry.serialize.serialize({ scrollback: SNAPSHOT_SCROLLBACK_ROWS })
  } catch {
    return null
  }
}

export function seedTerminalSnapshot(ptyId: string, data: string): void {
  seeded.set(ptyId, data)
}

export function seedTerminalSnapshots(snapshots: Record<string, string> | undefined): void {
  if (!snapshots) return
  const next = { ...readStoredSnapshots() }
  for (const [id, data] of Object.entries(snapshots)) {
    if (!id || typeof data !== 'string') continue
    seeded.set(id, data)
    next[id] = { data }
  }
  writeStoredSnapshots(next)
}

export function pruneSeededTerminalSnapshots(livePtyIds: ReadonlySet<string>): void {
  for (const id of seeded.keys()) if (!livePtyIds.has(id)) seeded.delete(id)
}
