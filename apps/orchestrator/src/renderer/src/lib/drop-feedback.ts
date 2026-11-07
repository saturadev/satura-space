import { useEffect, useState } from 'react'
import { censusTrack } from '@shared/census'

type Listener = (message: string | null) => void

let current: string | null = null
let clearTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<Listener>()
censusTrack('drop-feedback.listeners', listeners)

function emit(message: string | null): void {
  current = message
  for (const l of listeners) l(message)
}

export function showDropFeedback(message: string, ms = 2800): void {
  if (clearTimer) clearTimeout(clearTimer)
  emit(message)
  clearTimer = setTimeout(() => emit(null), ms)
}

export function useDropFeedback(): string | null {
  const [message, setMessage] = useState<string | null>(current)
  useEffect(() => {
    listeners.add(setMessage)
    setMessage(current)
    return () => {
      listeners.delete(setMessage)
    }
  }, [])
  return message
}
