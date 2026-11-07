import { useEffect, useRef } from 'react'
import { getTerminalHost, parkTerminalHost, requestRefit } from '../../lib/terminal/terminal-registry'

export function PaneTerminalSlot({ ptyId }: { ptyId: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const slot = ref.current
    if (!slot) return
    const host = getTerminalHost(ptyId)
    slot.appendChild(host)
    const raf = requestAnimationFrame(() => requestRefit(ptyId))
    return () => {
      cancelAnimationFrame(raf)
      if (host.parentElement === slot) parkTerminalHost(ptyId)
    }
  }, [ptyId])

  return <div ref={ref} className="absolute inset-0 bg-editor-surface" />
}
