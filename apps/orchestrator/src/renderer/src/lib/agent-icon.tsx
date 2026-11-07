import { useState } from 'react'
import type { AgentId } from '@shared/types'
import { getAgentEntry } from '@shared/agent-catalog'

const BUNDLED = import.meta.glob<string>('../assets/agent-icons/*.png', { eager: true, import: 'default', query: '?inline' })

const ICON_BY_DOMAIN: Record<string, string> = Object.fromEntries(
  Object.entries(BUNDLED).map(([path, url]) => [path.split('/').pop()?.replace(/\.png$/, '') ?? '', url])
)

export function AgentIcon({ id, className = 'h-3.5 w-3.5' }: { id: AgentId; className?: string }) {
  const entry = getAgentEntry(id)
  const [failed, setFailed] = useState(false)
  const domain = entry?.faviconDomain

  const bundled = domain ? ICON_BY_DOMAIN[domain] : undefined
  if (bundled && !failed) {
    return (
      <img
        src={bundled}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
        className={`${className} shrink-0 rounded-sm object-contain`}
      />
    )
  }

  const letter = (entry?.label ?? id).charAt(0).toUpperCase()
  return (
    <span
      className={`${className} flex shrink-0 items-center justify-center rounded-sm bg-white/10 text-[9px] font-bold text-zinc-300`}
    >
      {letter}
    </span>
  )
}
