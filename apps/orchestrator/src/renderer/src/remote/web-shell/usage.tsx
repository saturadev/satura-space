import { useEffect, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { ChevronLeft, ChevronRight, ExternalLink, TriangleAlert } from 'lucide-react'
import type { RateLimitWindow, UsageProvider, UsageRemaining, UsageSnapshot } from '@shared/api'
import { ClaudeIcon } from '../../components/workspace/ClaudeUsageButton'
import { CodexIcon } from '../../components/workspace/CodexUsageButton'
import { KimiIcon } from '../../components/workspace/KimiUsageButton'
import { formatDateTime, formatDurationShort } from '../../lib/date-time'
import { useShell } from './bridge'
import { useView } from './viewport'

interface Look {
  label: string
  color: string
  icon: (size: number) => ReactNode
  hint: string
  url?: string
  urlLabel?: string
}

const LOOK: Record<UsageProvider, Look> = {
  claude: {
    label: 'Claude',
    color: '#D97757',
    icon: (size) => <ClaudeIcon size={size} />,
    hint: 'Sign in to Claude Code on your desktop to see usage.',
    url: 'https://claude.ai/settings/usage',
    urlLabel: 'Open usage on claude.ai'
  },
  codex: { label: 'Codex', color: '#10A37F', icon: (size) => <CodexIcon size={size} />, hint: 'Run codex on your desktop and sign in to see usage.' },
  kimi: { label: 'Kimi', color: '#8B8FF7', icon: (size) => <KimiIcon size={size} />, hint: 'Run kimi on your desktop and sign in to see usage.' }
}

export interface UsageState {
  snapshot: UsageSnapshot | null
  error: string | null
}

const useUsage = create<UsageState>(() => ({ snapshot: null, error: null }))
let listening = false

function summary(s: UsageSnapshot): string {
  return (
    s.providers
      .map((p) => {
        const u = s.usage[p]
        const left = u ? windowsOf(u).map((w) => `${leftPercent(w)}% left`).join(', ') : ''
        return `${p} ${s.checking.includes(p) ? 'checking' : (u?.status ?? 'none')}${left ? ` ${left}` : ''}`
      })
      .join('; ') || 'every agent hidden'
  )
}

function listen(): void {
  if (listening) return
  listening = true
  window.api.usage.onChanged((snapshot) => {
    console.info(`[web-shell] usage update: ${summary(snapshot)}`)
    useUsage.setState({ snapshot, error: null })
  })
}

function ask(force?: boolean, provider?: UsageProvider): void {
  window.api.usage.snapshot(force, provider).then(
    (snapshot) => useUsage.setState({ snapshot, error: null }),
    (e: Error) => {
      console.info(`[web-shell] usage: ${e?.message ?? e}`)
      useUsage.setState({ error: e?.message || "The desktop didn't answer" })
    }
  )
}

export function useAgentUsage(online: boolean): UsageState {
  const fresh = useShell((s) => s.fresh)
  useEffect(listen, [])
  useEffect(() => {
    if (!online) return
    const t = setTimeout(() => ask(), 0)
    return () => clearTimeout(t)
  }, [online, fresh])
  return useUsage()
}

function windowsOf(u: UsageRemaining): RateLimitWindow[] {
  return [u.session, u.weekly, ...(u.weeklyScoped ?? [])].filter((w): w is RateLimitWindow => !!w)
}

function leftPercent(w: RateLimitWindow): number {
  return Math.max(0, Math.round(100 - w.usedPercent))
}

function usedPercent(w: RateLimitWindow): number {
  return Math.min(100, Math.max(0, Math.round(w.usedPercent)))
}

function barColor(left: number): string {
  if (left > 40) return 'var(--ws-accent)'
  if (left > 20) return 'var(--ws-warn)'
  return 'var(--ws-err)'
}

function windowLabel(u: UsageRemaining, w: RateLimitWindow): string {
  if (w === u.session) return 'Session · 5h'
  if (w === u.weekly) return 'Weekly · 7d'
  return `Weekly · ${w.model ?? 'model'}`
}

function macText(text: string): string {
  return text.replace(/\bthis computer\b/g, 'your desktop')
}

function unavailableShort(u: UsageRemaining): string {
  if (/not found/i.test(u.error ?? '')) return 'Not installed'
  if (/no plan limits/i.test(u.error ?? '')) return 'No plan limits'
  return 'Not signed in'
}

function unavailableText(u: UsageRemaining, look: Look): string {
  if (!u.error) return look.hint
  const text = macText(u.error).replace(/\.$/, '')
  return unavailableShort(u) === 'Not signed in' ? `${text}. ${look.hint}` : `${text}.`
}

function ago(ts: number, now: number): string {
  if (!ts) return ''
  const mins = Math.floor((now - ts) / 60_000)
  if (mins < 1) return 'Updated just now'
  if (mins < 60) return `Updated ${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `Updated ${hours}h ago`
  return `Updated ${Math.floor(hours / 24)}d ago`
}

function problem(usage: UsageState, online: boolean): string | null {
  if (!online) return usage.snapshot ? 'Your desktop is offline. These are the last numbers it sent.' : null
  if (!usage.error) return null
  return `Can't read agent usage right now. ${usage.error}`
}

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

function Bar({ left, height }: { left: number; height: number }) {
  return (
    <div className="w-full overflow-hidden rounded-full bg-white/[0.08]" style={{ height }} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-label={`${left}% left`}>
      <div className="h-full rounded-full" style={{ width: `${left}%`, background: barColor(left) }} />
    </div>
  )
}

function Warn({ size = 13 }: { size?: number }) {
  return <TriangleAlert size={size} strokeWidth={2.4} className="shrink-0 text-[var(--ws-warn)]" />
}

function stateOf(u: UsageRemaining | undefined, checking: boolean): string {
  if (!u) return checking ? 'checking' : 'none'
  if (windowsOf(u).length > 0) return u.stale ? 'stale' : 'ok'
  return u.status
}

function StripCell({ provider, u, checking }: { provider: UsageProvider; u: UsageRemaining | undefined; checking: boolean }) {
  const look = LOOK[provider]
  const windows = u ? windowsOf(u) : []
  const tightest = u?.session ? leftPercent(u.session) : windows.length ? Math.min(...windows.map(leftPercent)) : null
  let value: ReactNode
  if (tightest !== null) {
    value = (
      <span className="flex items-center gap-1">
        {u?.stale && <Warn />}
        {tightest}% left
      </span>
    )
  } else if (!u) value = <span className="font-medium text-[var(--ws-label3)]">{checking ? 'Checking' : '—'}</span>
  else if (u.status === 'unavailable') value = <span className="font-medium text-[var(--ws-label2)]">{unavailableShort(u)}</span>
  else
    value = (
      <span className="flex items-center gap-1 font-medium text-[var(--ws-label2)]">
        <Warn />
        Can't check
      </span>
    )
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1" data-ws-usage-cell={provider} data-state={stateOf(u, checking)}>
      <span className="flex items-center gap-1.5 text-[12px] text-[var(--ws-label2)]">
        <span className="flex shrink-0" style={{ color: look.color }}>
          {look.icon(12)}
        </span>
        {look.label}
      </span>
      <span className="truncate text-[15px] font-semibold tabular-nums">{value}</span>
      <div className="flex h-[22px] items-center pr-1">{tightest !== null && <Bar left={tightest} height={6} />}</div>
    </div>
  )
}

export function UsageStrip({ usage, onOpen }: { usage: UsageState; onOpen: () => void }) {
  const online = useShell((s) => s.conn === 'online')
  const snap = usage.snapshot
  if (!snap) {
    const note = problem(usage, online)
    if (note) return <p className="px-1 text-[13px] leading-snug text-[var(--ws-label2)]" data-ws-usage-strip="error">{note}</p>
    if (!online) return null
    return (
      <div className="rounded-[18px] bg-[var(--ws-card)] px-4 py-3 text-[13px] text-[var(--ws-label2)]" data-ws-usage-strip="loading">
        Checking agent usage
      </div>
    )
  }
  if (snap.providers.length === 0) return null
  return (
    <button type="button" onClick={onOpen} className={`ws-press flex w-full items-center gap-3 rounded-[18px] bg-[var(--ws-card)] py-3 pl-4 pr-3 text-left ${online ? '' : 'opacity-60'}`} aria-label="Agent usage" data-ws-usage-strip={online ? 'live' : 'offline'}>
      {snap.providers.map((p) => (
        <StripCell key={p} provider={p} u={snap.usage[p]} checking={snap.checking.includes(p)} />
      ))}
      <ChevronRight size={16} strokeWidth={2.4} className="shrink-0 text-[var(--ws-label3)]" />
    </button>
  )
}

function WindowBlock({ u, w, now }: { u: UsageRemaining; w: RateLimitWindow; now: number }) {
  const left = leftPercent(w)
  const label = windowLabel(u, w)
  const ms = w.resetsAt ? w.resetsAt - now : null
  return (
    <div className="flex flex-col gap-1.5" data-ws-usage-window={label} data-left={left} data-resets={w.resetsAt ?? ''}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[14px] text-[var(--ws-label2)]">{label}</span>
        <span className="text-[20px] font-semibold leading-none tabular-nums">{left}% left</span>
      </div>
      <Bar left={left} height={8} />
      <p className="text-[12.5px] leading-snug text-[var(--ws-label2)]">
        <span className="tabular-nums">{usedPercent(w)}% used</span>
        {ms !== null && (
          <>
            {' · '}
            {ms > 0 ? (
              <>
                Resets {formatDateTime(w.resetsAt)} <span className="text-[var(--ws-label3)]">(in {formatDurationShort(ms)})</span>
              </>
            ) : (
              'Resets now'
            )}
          </>
        )}
      </p>
    </div>
  )
}

function Again({ label, provider, data }: { label: string; provider: UsageProvider; data: string }) {
  return (
    <button type="button" onClick={() => ask(true, provider)} className="ws-press h-8 self-start rounded-full bg-white/[0.09] px-3.5 text-[13.5px] font-semibold" data-ws-usage-again={data}>
      {label}
    </button>
  )
}

function ProviderCard({ provider, u, checking, online, now }: { provider: UsageProvider; u: UsageRemaining | undefined; checking: boolean; online: boolean; now: number }) {
  const look = LOOK[provider]
  const windows = u ? windowsOf(u) : []
  let body: ReactNode
  if (windows.length > 0 && u) {
    body = (
      <>
        {windows.map((w, i) => (
          <WindowBlock key={i} u={u} w={w} now={now} />
        ))}
        {u.error && (
          <p className="flex items-start gap-2 text-[13px] leading-snug text-[var(--ws-warn)]">
            <span className="mt-0.5">
              <Warn />
            </span>
            {macText(u.error)}
          </p>
        )}
      </>
    )
  } else if (!u) {
    body = checking ? (
      <p className="flex items-center gap-2 text-[14px] text-[var(--ws-label2)]">
        <span className="ws-spin !h-4 !w-4 !border-2" />
        Checking
      </p>
    ) : (
      <p className="text-[14px] text-[var(--ws-label2)]">Waiting for your desktop</p>
    )
  } else if (u.status === 'unavailable') {
    body = (
      <>
        <p className="text-[14px] leading-snug text-[var(--ws-label2)]">{unavailableText(u, look)}</p>
        {online && <Again label="Check again" provider={provider} data="check" />}
      </>
    )
  } else {
    body = (
      <>
        <p className="flex items-start gap-2 text-[14px] leading-snug text-[var(--ws-warn)]">
          <span className="mt-0.5">
            <Warn size={14} />
          </span>
          {u.error ? macText(u.error) : "Couldn't load usage."}
        </p>
        {online && <Again label="Try again" provider={provider} data="retry" />}
      </>
    )
  }
  const status = checking && u ? 'Checking' : windows.length > 0 && u ? ago(u.updatedAt, now) : ''
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-[20px] bg-[var(--ws-card)] px-4 pb-4 pt-3.5" data-ws-usage-card={provider} data-state={stateOf(u, checking)}>
      <div className="flex items-center gap-2">
        <span className="flex shrink-0" style={{ color: look.color }}>
          {look.icon(18)}
        </span>
        <h2 className="text-[17px] font-semibold">{look.label}</h2>
        {status && (
          <span className="ml-auto flex items-center gap-1.5 text-[12.5px] text-[var(--ws-label2)]">
            {checking && <span className="ws-spin !h-3 !w-3 !border-[1.5px]" />}
            {status}
          </span>
        )}
      </div>
      {body}
      {look.url && windows.length > 0 && (
        <a href={look.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 self-start text-[13.5px] font-medium text-[var(--ws-accent)] active:opacity-60" data-ws-usage-link={provider}>
          {look.urlLabel}
          <ExternalLink size={13} strokeWidth={2.4} />
        </a>
      )}
    </section>
  )
}

export function UsageScreen({ usage, onClose }: { usage: UsageState; onClose: () => void }) {
  const view = useView()
  const hostName = useShell((s) => s.hostName)
  const online = useShell((s) => s.conn === 'online')
  const now = useNow(30_000)
  const snap = usage.snapshot
  const note = problem(usage, online)
  const refreshing = !!snap && snap.checking.length > 0
  return (
    <div className="ws-scroll ws-screen fixed inset-0 z-[45] bg-black" style={{ paddingTop: view.safe.t, paddingLeft: view.safe.l, paddingRight: view.safe.r, paddingBottom: Math.max(view.safe.b, 16) }} data-ws-page="Usage">
      <div className="mx-auto w-full max-w-[980px]">
        <div className="flex h-[52px] items-center gap-1 px-2">
          <button type="button" aria-label="Back to projects" onClick={onClose} className="flex h-11 items-center gap-0.5 rounded-full pl-1 pr-3 text-[16px] text-[var(--ws-accent)] active:opacity-60" data-ws-usage-back>
            <ChevronLeft size={24} strokeWidth={2.4} />
            Projects
          </button>
          {online && snap && snap.providers.length > 0 && (
            <button type="button" onClick={() => ask(true)} disabled={refreshing} className="ml-auto flex h-11 items-center gap-2 rounded-full px-3 text-[16px] text-[var(--ws-accent)] active:opacity-60 disabled:opacity-60" data-ws-usage-refresh>
              {refreshing && <span className="ws-spin !h-4 !w-4 !border-2" />}
              Refresh
            </button>
          )}
        </div>
        <h1 className="truncate px-5 pb-1 text-[30px] font-bold tracking-tight">Agent usage</h1>
        <p className="px-5 pb-4 text-[13.5px] leading-snug text-[var(--ws-label2)]" data-ws-usage-note={note ? 'problem' : 'host'}>
          {note ?? `Plan limits for the agents signed in on ${hostName || 'your desktop'}`}
        </p>
        {!snap ? (
          online && !note && (
            <div className="flex items-center gap-2 px-5 text-[14px] text-[var(--ws-label2)]" data-ws-usage-loading>
              <span className="ws-spin !h-4 !w-4 !border-2" />
              Checking agent usage
            </div>
          )
        ) : snap.providers.length === 0 ? (
          <p className="px-5 text-[15px] leading-snug text-[var(--ws-label2)]" data-ws-usage-empty>
            All agents are hidden under Usage limits in Satura's settings on your desktop.
          </p>
        ) : (
          <div className={`grid items-start gap-3 px-4 ${online ? '' : 'opacity-60'}`} style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(380px, 100%), 1fr))' }}>
            {snap.providers.map((p) => (
              <ProviderCard key={p} provider={p} u={snap.usage[p]} checking={snap.checking.includes(p)} online={online} now={now} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
