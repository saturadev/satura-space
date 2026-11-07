
import { useEffect, useRef, useState } from 'react'
import { SAFETY_MS, type HotReloadPulse } from './hot-reload-pulse'

export type HotReloadTone = 'info' | 'pending' | 'success' | 'warn' | 'error'

export interface HotReloadToast {
  tone: HotReloadTone
  text: string
}

const HIDE_MS = 3200
const SUCCESS_HIDE_MS = 1600
const PENDING_MAX_MS = SAFETY_MS + 2000

export function patchedToastText(methods: number): string {
  const noun = methods === 1 ? 'method' : 'methods'
  return methods > 0 ? `Hot reloaded ✓ (${methods} ${noun})` : 'Hot reloaded ✓'
}

export function useHotReloadToast(
  armed: boolean,
  compileError: string | null,
  pulse?: HotReloadPulse
): HotReloadToast | null {
  const [toast, setToast] = useState<HotReloadToast | null>(null)
  const hideRef = useRef<number | undefined>(undefined)
  const armedRef = useRef(armed)
  const pulseRef = useRef(pulse?.seq ?? 0)

  useEffect(() => {
    const was = armedRef.current
    armedRef.current = armed
    if (armed === was) return
    if (hideRef.current) clearTimeout(hideRef.current)
    if (armed) {
      setToast({ tone: 'info', text: 'Hot reload on — save a C# file' })
      hideRef.current = window.setTimeout(() => setToast(null), HIDE_MS)
    } else {
      setToast(null)
    }
  }, [armed])

  useEffect(() => {
    if (!armed || !compileError) return
    if (hideRef.current) clearTimeout(hideRef.current)
    setToast({ tone: 'error', text: 'Hot reload blocked — fix compile errors' })
  }, [armed, compileError])

  useEffect(() => {
    const seq = pulse?.seq ?? 0
    const was = pulseRef.current
    pulseRef.current = seq
    if (seq === 0 || seq === was) return
    if (hideRef.current) clearTimeout(hideRef.current)
    if (pulse?.active) {
      setToast({ tone: 'pending', text: 'Hot reloading…' })
      hideRef.current = window.setTimeout(() => setToast(null), PENDING_MAX_MS)
      return
    }
    if (pulse?.outcome === 'timeout') {
      setToast(null)
      return
    }
    if (pulse?.outcome === 'failed') {
      setToast({ tone: 'error', text: 'Hot reload failed — see console' })
      hideRef.current = window.setTimeout(() => setToast(null), HIDE_MS)
      return
    }
    setToast({ tone: 'success', text: patchedToastText(pulse?.methods ?? 0) })
    hideRef.current = window.setTimeout(() => setToast(null), SUCCESS_HIDE_MS)
  }, [pulse?.seq])

  useEffect(
    () => () => {
      if (hideRef.current) clearTimeout(hideRef.current)
    },
    []
  )

  return toast
}
