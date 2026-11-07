import type { TunerRestore } from '@shared/tuner'

const TARGET_RE = /^o(\d+)$/

export function remapAddedId(id: string, ghostId: string, index: number): string {
  if (id === ghostId) return `o${index}`
  const m = TARGET_RE.exec(id)
  if (!m) return id
  const k = Number(m[1])
  return k >= index ? `o${k + 1}` : id
}

export function remapAddedObject(
  restore: TunerRestore | null,
  ids: string[],
  active: string | null,
  ghostId: string,
  index: number
): { restore: TunerRestore | null; ids: string[]; active: string | null } {
  const map = (id: string): string => remapAddedId(id, ghostId, index)
  const next: TunerRestore | null = restore
    ? {
        ...restore,
        overrides: restore.overrides.map((o) => ({ ...o, id: map(o.id) })),
        opened: restore.opened?.filter((t) => t.kind !== 'object' || t.id !== ghostId)
      }
    : null
  return { restore: next, ids: ids.map(map), active: active ? map(active) : null }
}
