import { Smartphone } from 'lucide-react'
import { useRemoteViewers } from '../../lib/remote/remote-presence'
import { Tooltip } from '../ui/Tooltip'

function viewersText(): string {
  return 'Open in Satura Remote'
}

export function RemotePresenceBadge({ tabId }: { tabId: string }) {
  const devices = useRemoteViewers([tabId])
  if (!devices.length) return null
  return (
    <Tooltip label={viewersText()}>
      <span className="flex shrink-0 items-center text-accent" data-remote-presence={devices.join(',')} aria-label={viewersText()}>
        <Smartphone size={12} strokeWidth={2} />
      </span>
    </Tooltip>
  )
}

export function RemotePresencePill({ tabIds }: { tabIds: readonly string[] }) {
  const devices = useRemoteViewers(tabIds)
  if (!devices.length) return null
  return (
    <Tooltip label={viewersText()}>
      <span
        className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-accent/15 px-2 text-[11px] font-medium text-accent [-webkit-app-region:no-drag]"
        data-remote-presence-group={devices.join(',')}
      >
        <Smartphone size={11} strokeWidth={2} />
        In Remote
      </span>
    </Tooltip>
  )
}
