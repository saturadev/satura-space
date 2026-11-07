import { primaryWorldId } from '@shared/unity/ids'
import { useWorldStore } from '../lib/unity/world-store'
import { getUnityLifecycle, onUnityLifecycle, watchUnityLifecycle } from '../lib/unity/lifecycle-store'
import { useShell } from './web-shell/bridge'
import { currentHostId } from './ws-transport'
import { updateMac, type MacSummary } from './macs'

const WRITE_MS = 1200
const SEEN_MS = 60_000

const watched = new Map<string, () => void>()

function watch(paths: string[]): void {
  const want = new Set(paths.filter(Boolean))
  for (const [p, off] of [...watched]) {
    if (want.has(p)) continue
    off()
    watched.delete(p)
  }
  for (const p of want) if (!watched.has(p)) watched.set(p, watchUnityLifecycle(p))
}

function fromLife(path: string): string | null {
  const life = getUnityLifecycle(path)
  if (!life) return null
  if (life.lifecycle && life.lifecycle !== 'exited') return life.compileError ? 'errors' : life.lifecycle
  if (life.state === 'starting') return 'launching'
  if (life.state === 'failed') return 'error'
  return null
}

function unityOf(path: string): string | null {
  const w = useWorldStore.getState().worlds[path]
  const inst = w?.observed.instances[primaryWorldId(path)]
  if (!inst || inst.lifecycle === 'exited') return fromLife(path)
  if (inst.compile === 'error') return 'errors'
  if (inst.compile === 'compiling') return 'compiling'
  return inst.paused && inst.lifecycle === 'playing' ? 'paused' : inst.lifecycle
}

export function summaryNow(): MacSummary {
  const s = useShell.getState()
  return {
    at: Date.now(),
    version: s.version,
    projects: s.projects.map((p) => ({
      title: p.title,
      unity: unityOf(p.path),
      agents: p.agents.filter((a) => a.status === 'working').length,
      asks: p.agents.filter((a) => a.status === 'needs-input').length
    }))
  }
}

export function installMacSummary(): void {
  let timer = 0
  let last = ''
  let wroteAt = 0
  const write = (): void => {
    timer = 0
    const host = currentHostId()
    const s = useShell.getState()
    if (!host || s.conn !== 'online' || s.fresh === 0) return
    const summary = summaryNow()
    const key = JSON.stringify({ ...summary, at: 0 })
    if (key === last && Date.now() - wroteAt < SEEN_MS) return
    if (key !== last) console.info(`[macs] summary of ${host}: ${summary.projects.length} project(s), ${summary.projects.reduce((n, p) => n + p.asks, 0)} need you, Unity ${summary.projects.map((p) => p.unity).filter(Boolean).join(', ') || 'none'}`)
    last = key
    wroteAt = Date.now()
    updateMac(host, { summary, seenAt: wroteAt })
  }
  const soon = (): void => {
    if (!timer) timer = window.setTimeout(write, WRITE_MS)
  }
  onUnityLifecycle(soon)
  useShell.subscribe((now, before) => {
    if (now.conn === 'online' && (now.projects !== before.projects || now.fresh !== before.fresh)) watch(now.projects.map((p) => p.path))
    if (now.projects !== before.projects || now.conn !== before.conn || now.fresh !== before.fresh || now.version !== before.version) soon()
  })
  useWorldStore.subscribe(soon)
  window.setInterval(soon, SEEN_MS)
  window.addEventListener('pagehide', write)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') write()
  })
}
