import { useEffect, useRef, useState } from 'react'
import type { UnityWorldEvent } from '@shared/api'
import { WORLD_EVENT } from '@shared/unity/protocol'

export type HotReloadPhase = 'started' | 'patched' | 'failed'

export type HotReloadOutcome = 'patched' | 'failed' | 'timeout' | null

export interface HotReloadPulse {
  active: boolean
  seq: number
  methods: number
  outcome: HotReloadOutcome
}

export const SAFETY_MS = 6000
export const STALE_STARTED_MS = 1200

export function hotReloadPhaseFromEvent(
  ev: UnityWorldEvent,
  projectPath: string,
  instanceId: string
): { phase: HotReloadPhase; methods: number } | null {
  if (ev.event !== WORLD_EVENT.progress) return null
  if (ev.projectPath !== projectPath || ev.instanceId !== instanceId) return null
  if (ev.op !== 'reload') return null
  if (ev.phase === 'started' || ev.phase === 'patched' || ev.phase === 'failed') {
    const n = Number(ev.message)
    return { phase: ev.phase, methods: Number.isFinite(n) && n >= 0 ? n : 0 }
  }
  return null
}

export function useHotReloadPulse(projectPath: string, instanceId: string): HotReloadPulse {
  const [pulse, setPulse] = useState<HotReloadPulse>({
    active: false,
    seq: 0,
    methods: 0,
    outcome: null
  })
  const timerRef = useRef<number | undefined>(undefined)
  const lastTerminalRef = useRef(0)

  useEffect(() => {
    const clear = (): void => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = undefined
      }
    }
    const off = window.api.unity.onWorld((ev) => {
      const hit = hotReloadPhaseFromEvent(ev, projectPath, instanceId)
      if (!hit) return
      if (hit.phase === 'started') {
        if (Date.now() - lastTerminalRef.current < STALE_STARTED_MS) return
        clear()
        timerRef.current = window.setTimeout(() => {
          setPulse((p) =>
            p.active ? { active: false, seq: p.seq + 1, methods: 0, outcome: 'timeout' } : p
          )
        }, SAFETY_MS)
        setPulse((p) => ({ active: true, seq: p.seq + 1, methods: 0, outcome: null }))
        return
      }
      clear()
      lastTerminalRef.current = Date.now()
      const outcome: 'patched' | 'failed' = hit.phase === 'failed' ? 'failed' : 'patched'
      setPulse((p) => ({ active: false, seq: p.seq + 1, methods: hit.methods, outcome }))
    })
    return () => {
      clear()
      off()
    }
  }, [projectPath, instanceId])

  return pulse
}
