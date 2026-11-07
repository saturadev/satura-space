const tracked = new Map<string, { readonly size: number }>()

export function censusTrack<T extends { readonly size: number }>(name: string, collection: T): T {
  tracked.set(name, collection)
  return collection
}

export function censusSizes(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, c] of tracked) out[name] = c.size
  return out
}

export function censusGauge(name: string, read: () => number): void {
  tracked.set(name, { get size() { return read() } })
}

const liveCounts = new Map<string, number>()
const liveRegistry = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry<string>((name) => liveCounts.set(name, (liveCounts.get(name) ?? 1) - 1)) : null

export function censusLive<T extends object>(name: string, obj: T): T {
  if (!liveRegistry) return obj
  if (!liveCounts.has(name)) censusGauge(`${name}.alive`, () => liveCounts.get(name) ?? 0)
  liveCounts.set(name, (liveCounts.get(name) ?? 0) + 1)
  liveRegistry.register(obj, name)
  return obj
}
