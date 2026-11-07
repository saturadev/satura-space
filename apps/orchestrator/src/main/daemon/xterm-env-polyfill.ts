if (typeof globalThis.window === 'undefined') {
  ;(globalThis as Record<string, unknown>).window = globalThis
}
