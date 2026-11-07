import { useLayoutEffect, useRef } from 'react'
import { attachViewHost, parkViewHost } from '../../lib/view-host-registry'

export function PaneGitScmSlot({ ptyId }: { ptyId: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const slot = ref.current
    if (!slot) return
    attachViewHost(ptyId, slot)
    return () => parkViewHost(ptyId, slot)
  }, [ptyId])

  return <div ref={ref} className="absolute inset-0 overflow-hidden" />
}
