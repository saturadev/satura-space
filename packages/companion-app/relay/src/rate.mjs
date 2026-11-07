export function createLimiter(max, windowMs) {
  const hits = new Map()
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [k, v] of hits) if (now >= v.reset) hits.delete(k)
  }, Math.max(windowMs, 10_000))
  sweep.unref()
  return {
    take(key) {
      const now = Date.now()
      let v = hits.get(key)
      if (!v || now >= v.reset) {
        v = { n: 0, reset: now + windowMs }
        hits.set(key, v)
      }
      v.n++
      return v.n <= max
    },
    full(key) {
      const v = hits.get(key)
      return !!v && Date.now() < v.reset && v.n >= max
    },
    size: () => hits.size
  }
}
