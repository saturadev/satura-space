import type { IceServer } from 'node-datachannel'
import type { RvIceServer } from '@shared/remote-video'

export function libIceServers(list: RvIceServer[] | undefined): IceServer[] {
  const stun: IceServer[] = []
  const turn: IceServer[] = []
  const seen = new Set<string>()
  for (const s of list ?? []) {
    for (const url of Array.isArray(s.urls) ? s.urls : [s.urls]) {
      const m = /^(stun|turns?):([^:?/]+):(\d+)(?:\?transport=(udp|tcp))?$/.exec(String(url))
      if (!m) continue
      const [, scheme, hostname, portText, transport] = m
      const port = Number(portText)
      if (scheme === 'stun') {
        if (!seen.has(`stun ${hostname}:${port}`)) stun.push({ hostname, port })
        seen.add(`stun ${hostname}:${port}`)
        continue
      }
      if (scheme !== 'turn' || transport === 'tcp' || !s.username || !s.credential) continue
      if (seen.has(`turn ${hostname}:${port}`)) continue
      seen.add(`turn ${hostname}:${port}`)
      turn.push({ hostname, port, username: s.username, password: s.credential, relayType: 'TurnUdp' })
    }
  }
  return [...stun.slice(0, 1), ...turn.slice(0, 2)]
}
