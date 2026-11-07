import { parsePairCode, type E2ePairCode } from '@shared/remote-e2e'
import { getMac, pathHostId, updateMac } from './macs'

export interface HostMark {
  hostId: string
  hostName: string
  phoneId: string
}

export function readMark(): HostMark | null {
  const m = getMac(pathHostId())
  return m && !m.removed && m.phoneId ? { hostId: m.hostId, phoneId: m.phoneId, hostName: m.name } : null
}

export function writeMark(m: HostMark): void {
  updateMac(m.hostId, { name: m.hostName, phoneId: m.phoneId, removed: null })
}

export function pairTextInUrl(): string | null {
  const hash = new URLSearchParams(location.hash.replace(/^#/, '')).get('pair')
  return hash && hash.includes(':') ? hash : null
}

export function pairCodeInUrl(): E2ePairCode | null {
  const text = pairTextInUrl()
  return text ? parsePairCode(text) : null
}

export function clearPairFromUrl(): void {
  if (location.hash || /[?&]pair=/.test(location.search)) history.replaceState(null, '', location.pathname)
}
