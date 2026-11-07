import type { AskDriftPhone } from '../tuner/prompt'
import { isMobileLayout } from '../mobile/mobile-back'

let device = ''

export function setPhoneDevice(name: string): void {
  device = name
}

export async function askDriftPhone(): Promise<AskDriftPhone | null> {
  if (isMobileLayout()) return { fromPhone: true, device: device || 'phone' }
  const p = await window.api.remote?.phonePanel?.().catch(() => null)
  if (!p?.connected || !p.visible) return null
  const shows = p.screen === 'panel' ? (p.tab ? `shows ${p.tab.label || p.tab.kind}` : 'shows an empty workspace') : p.screen === 'layout' ? 'shows its panel list' : p.screen === 'files' ? 'shows its file browser' : p.screen === 'projects' ? 'shows its project list' : ''
  return shows ? { fromPhone: false, device: p.device ?? 'phone', shows } : null
}
