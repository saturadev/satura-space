import type { RateLimitWindow, UsageProvider, UsageRemaining } from '@shared/api'
import { USAGE_PROVIDERS, visibleUsageProviders } from '@shared/types'
import { useAppStore } from '../store'
import { defineHandle } from './registry'

function brief(u: UsageRemaining | null | undefined): Record<string, unknown> | null {
  if (!u) return null
  const windows = [u.session, u.weekly, ...(u.weeklyScoped ?? [])].filter((w): w is RateLimitWindow => !!w)
  return {
    status: u.status,
    stale: !!u.stale,
    error: u.error,
    updatedAt: u.updatedAt,
    windows: windows.map((w) => ({ used: w.usedPercent, left: Math.max(0, Math.round(100 - w.usedPercent)), resetsAt: w.resetsAt, model: w.model ?? null }))
  }
}

defineHandle({
  name: 'usage.state',
  side: 'renderer',
  description:
    "Reads agent usage limits as the desktop shows them and as the phone gets them. bar is the text of each usage button in the bottom bar; desktop is what the bottom bar holds for Claude, Codex and Kimi; snapshot is the main-process usage snapshot that Satura Remote pushes to the phone (visible providers, their numbers, providers being checked). refresh: true first checks every visible provider again, like the refresh button in the usage popover, and waits for the answers. hide: 'kimi' or 'codex,kimi' hides those providers like the switches in Settings → Usage limits, hide: 'none' shows them all.",
  params: { refresh: false, hide: '' },
  async run(p) {
    const hide = String(p.hide ?? '').trim()
    if (hide) {
      const hidden = hide === 'none' ? [] : USAGE_PROVIDERS.filter((provider: UsageProvider) => hide.split(',').map((x) => x.trim()).includes(provider))
      await useAppStore.getState().updateSettings({ hiddenUsageProviders: hidden })
    }
    const s = useAppStore.getState()
    const providers = s.settings ? visibleUsageProviders(s.settings.hiddenUsageProviders) : []
    if (p.refresh) {
      const fetchers = { claude: s.fetchClaudeUsageRemaining, codex: s.fetchCodexUsageRemaining, kimi: s.fetchKimiUsageRemaining }
      await Promise.all(providers.map((provider) => fetchers[provider](true)))
    }
    const now = useAppStore.getState()
    const bar = [...document.querySelectorAll<HTMLButtonElement>('[data-status-bar] button[title$="usage left"]')].map((b) => `${b.title}: ${b.textContent ?? ''}`)
    const snapshot = await window.api.usage.snapshot()
    return {
      bar,
      desktop: { claude: brief(now.claudeUsageRemaining), codex: brief(now.codexUsageRemaining), kimi: brief(now.kimiUsageRemaining) },
      snapshot: { providers: snapshot.providers, checking: snapshot.checking, usage: Object.fromEntries(snapshot.providers.map((provider) => [provider, brief(snapshot.usage[provider])])) }
    }
  }
})
