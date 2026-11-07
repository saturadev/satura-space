export const STARTED_SUPPRESS_MS = 1200

export interface HotReloadLineHit {
  phase: 'patched' | 'failed'
  methods: string
}

const patchedRe = /\[HotReload\].*→ patched (\d+) changed method/
const noChangeRe = /\[HotReload\].*no method-body changes to patch/
const skippedRe = /\[HotReload\].*skipped — not part of any patchable assembly/
const failedRe = /\[HotReload\] (compile errors in |error patching |detour failed)/

export function classifyHotReloadLine(message: string): HotReloadLineHit | null {
  if (!message.includes('[HotReload]')) return null
  const m = patchedRe.exec(message)
  if (m) return { phase: 'patched', methods: m[1] }
  if (noChangeRe.test(message)) return { phase: 'patched', methods: '0' }
  if (skippedRe.test(message)) return { phase: 'patched', methods: '0' }
  if (failedRe.test(message)) return { phase: 'failed', methods: '0' }
  return null
}
