import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Bell, Check, ChevronDown, ChevronRight, CircleUser, FileText, Folder, House, LogOut, Pencil, Settings, SquarePlus, SquareTerminal, Trash2, TriangleAlert, Wifi, X } from 'lucide-react'
import type { RemoteAllowance } from '@shared/remote-protocol'
import { answer, openWorkspace, setNotify, setTab, useShell, type ActivityItem, type Dot, type NotifyKind, type Project, type Tab } from './bridge'
import { standalone, useView } from './viewport'
import { MacScreen, MacStrip } from './mac'
import { UsageScreen, UsageStrip, useAgentUsage, type UsageState } from './usage'
import { useSystemLoad, type SystemLoadState } from '../../components/system-load/SystemLoadCharts'
import { NetDebugRow, netDebugAllowed } from './netdebug'
import { disablePush, enablePush, openActivity, refreshPush, setPushPref, testPush, usePush } from '../push'
import type { PushPrefs } from '@shared/remote-push'
import { NewProjectScreen, OpenProjectScreen, type ProjectSheet } from './projects'
import { fetchPresence, getMac, listMacs, macLabel, onMacsChange, pathHostId, type MacRecord } from '../macs'
import { Badge, MacSwitcher, RemoveSheet, RenameSheet, type Tone } from '../macs-ui'
import { forgetMacOnPhone } from '../mac-forget'
import { DesktopTile } from '../desktop-art'
import { hostKindLabel } from '@shared/remote-host-kind'
import { invokeRemote } from '../ws-transport'
import { Presence } from '../motion'
import { Group, RowIcon } from './group'
import { accountUrl, relayHost, signOutHere } from '../account'
import { StorageGroup } from './storage'

export function useThisMac(): MacRecord | null {
  const [mac, setMac] = useState<MacRecord | null>(() => getMac(pathHostId()))
  useEffect(() => onMacsChange(() => setMac(getMac(pathHostId()))), [])
  return mac
}

function useOtherUnread(): { others: MacRecord[]; unread: number; up: Record<string, boolean> } {
  const [others, setOthers] = useState<MacRecord[]>(() => listMacs().filter((m) => m.hostId !== pathHostId()))
  const [unread, setUnread] = useState(0)
  const [up, setUp] = useState<Record<string, boolean>>({})
  useEffect(() => {
    const read = (): void => {
      const list = listMacs().filter((m) => m.hostId !== pathHostId())
      setOthers(list)
      void fetchPresence(list.filter((m) => !m.removed).map((m) => m.hostId)).then((p) => p && setUp(Object.fromEntries(Object.entries(p).map(([id, v]) => [id, v.state === 'up' && v.fit === 'ok']))))
      void Promise.all(list.map((m) => navigator.serviceWorker?.getRegistration(`/h/${m.hostId}/`).then((r) => (r && r.scope.endsWith(`/h/${m.hostId}/`) ? r.getNotifications().then((n) => n.length) : 0)).catch(() => 0) ?? 0)).then((n) => setUnread(n.reduce((a, b) => a + (b || 0), 0)))
    }
    read()
    const off = onMacsChange(read)
    const t = window.setInterval(() => document.visibilityState === 'visible' && read(), 10_000)
    document.addEventListener('visibilitychange', read)
    return () => {
      off()
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', read)
    }
  }, [])
  return { others, unread, up }
}

export function connTone(conn: string): Tone {
  return conn === 'online' ? 'ok' : conn === 'connecting' ? 'wait' : conn === 'unpaired' ? 'err' : 'off'
}

function MacBar({ onSwitch }: { onSwitch: () => void }) {
  const conn = useShell((s) => s.conn)
  const live = useShell((s) => s.hostName)
  const mac = useThisMac()
  const { others, unread, up } = useOtherUnread()
  const host = pathHostId() ?? ''
  const name = mac ? macLabel(mac) : live || 'Your desktop'
  return (
    <div className="flex h-[46px] items-center gap-2 px-3 pt-1" data-ws-macbar={host}>
      <button type="button" onClick={onSwitch} className="ws-press flex h-[36px] min-w-0 items-center gap-2 rounded-full bg-white/[0.08] pl-1.5 pr-3" aria-label={`${name}. Switch desktop`} data-ws-mac-pill>
        <DesktopTile hostId={host} kind={mac?.kind ?? null} size={28} tone={connTone(conn)} />
        <span className="truncate text-[15px] font-semibold" data-ws-mac-name>
          {name}
        </span>
        <ChevronDown size={16} strokeWidth={2.6} className="shrink-0 text-[var(--ws-label2)]" />
      </button>
      <span className="flex-1" />
      {others.length > 0 && (
        <button type="button" onClick={onSwitch} className="ws-press relative flex h-[36px] items-center pl-1 pr-1" aria-label={unread ? `${unread} ${unread === 1 ? 'notification' : 'notifications'} on your other desktops` : 'Your other desktops'} data-ws-other-macs={others.length}>
          <span className="flex -space-x-2.5">
            {others.slice(0, 3).map((m) => (
              <span key={m.hostId} className="rounded-[7px] bg-black p-[2px]">
                <DesktopTile hostId={m.hostId} kind={m.kind} size={24} tone={m.removed ? 'err' : up[m.hostId] ? 'ok' : 'off'} removed={!!m.removed} />
              </span>
            ))}
          </span>
          {unread > 0 && (
            <span className="absolute -right-1 -top-0.5">
              <Badge n={unread} />
            </span>
          )}
        </button>
      )}
    </div>
  )
}


export function StatusDot({ dot }: { dot: Dot | string }) {
  return <span className="ws-dot" data-dot={dot} aria-hidden />
}

export function relayDisplay(): string {
  return relayHost() || location.host
}

function hsl(h: number, s: number, v: number): string {
  const l = v * (1 - s / 2)
  const sl = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l)
  return `hsl(${Math.round((((h % 1) + 1) % 1) * 360)} ${Math.round(sl * 100)}% ${Math.round(l * 100)}%)`
}

function hue(title: string): number {
  let h = 0
  for (const ch of title) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 2147483647
  return (Math.abs(h) % 360) / 360
}

export function connectionLine(s: { conn: string; hostName: string; detail: string }): { dot: Dot; text: string } {
  if (s.conn === 'online') return { dot: 'ok', text: s.hostName || 'Connected' }
  if (s.conn === 'connecting') return { dot: 'wait', text: 'Connecting to your desktop' }
  if (s.conn === 'unpaired') return { dot: 'err', text: 'Not paired' }
  return { dot: 'err', text: s.detail || 'Offline' }
}

function Page({ title, children, max }: { title: string; children: ReactNode; max: number }) {
  const view = useView()
  const onSwitch = useCallback(() => useShell.setState({ switcher: true }), [])
  return (
    <div className="ws-scroll fixed inset-0 z-[5] bg-black" style={{ paddingTop: view.safe.t, paddingLeft: view.safe.l, paddingRight: view.safe.r }} data-ws-page={title}>
      <div className="mx-auto w-full" style={{ maxWidth: max, paddingBottom: tabBarHeight(view) + view.safe.b + 16 }}>
        <MacBar onSwitch={onSwitch} />
        <h1 className="px-5 pb-2 pt-1 text-[34px] font-bold tracking-tight">{title}</h1>
        {children}
      </div>
    </div>
  )
}

function ProjectCard({ p, active, i }: { p: Project; active: boolean; i: number }) {
  const pending = useShell((s) => !!s.pending[`project:${p.id}`])
  const h = hue(p.title)
  const letter = (p.title.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()
  return (
    <button
      type="button"
      onClick={() => openWorkspace(p.id)}
      className={`ws-press ws-item relative flex w-full flex-col overflow-hidden rounded-[24px] bg-[var(--ws-card)] text-left ${pending ? 'remote-pending' : ''}`}
      style={{ '--i': i } as CSSProperties}
      data-ws-project={p.id}
    >
      <div className="relative flex h-[118px] w-full items-center justify-center" style={{ background: `linear-gradient(135deg, ${hsl(h, 0.45, 0.42)}, ${hsl(h + 0.08, 0.55, 0.18)})` }}>
        <span className="text-[54px] font-bold text-white/[0.14]" style={{ fontFamily: 'ui-rounded, -apple-system, system-ui, sans-serif' }}>
          {letter}
        </span>
        {p.unity && (
          <span className="absolute left-2.5 top-2.5 flex h-6 items-center gap-1.5 rounded-full bg-black/45 px-[9px] font-mono text-[11px] font-semibold text-white">
            <StatusDot dot="ok" />
            Unity
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2 px-4 pb-3.5 pt-3">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[17px] font-semibold">{p.title}</span>
          {active && <span className="shrink-0 text-[12.5px] font-medium text-[var(--ws-label3)]">In front on the desktop</span>}
        </div>
        {p.agents.length === 0 ? (
          <span className="text-[13px] text-[var(--ws-label3)]">No agents running</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {p.agents.map((a) => (
              <span key={a.tabId} className="flex h-[26px] items-center gap-2 rounded-full bg-white/[0.07] pl-2 pr-2.5 text-[12.5px] font-medium">
                <StatusDot dot={a.dot} />
                {a.status === 'needs-input' ? `${a.label} needs you` : a.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  )
}

function gbText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB`
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  return `${Math.round(n / 1e3)} KB`
}

function resetText(a: RemoteAllowance): string {
  return new Date(a.resetAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(a.anchor === 'utc-month' ? { timeZone: 'UTC' } : {}) })
}

function allowanceColor(a: RemoteAllowance): string {
  if (a.overQuota) return 'var(--ws-err)'
  if (a.usedPercent >= 80) return 'var(--ws-warn)'
  return 'var(--ws-accent)'
}

function AllowanceRows({ a }: { a: RemoteAllowance }) {
  const used = Math.min(100, Math.max(0, a.usedPercent))
  return (
    <div className="flex flex-col gap-2 px-4 py-3" data-ws-allowance={a.overQuota ? 'over' : 'ok'}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[16px]">{a.overQuota ? 'Monthly limit reached' : `${gbText(a.remainingBytes)} left`}</span>
        <span className="text-[13px] text-[var(--ws-label2)]" data-ws-allowance-used>
          {gbText(a.usedBytes)} of {gbText(a.allowanceBytes)} used
        </span>
      </div>
      <div className="w-full overflow-hidden rounded-full bg-white/[0.08]" style={{ height: 6 }} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-label={`${used}% used`}>
        <div className="h-full rounded-full" style={{ width: `${used}%`, background: allowanceColor(a) }} />
      </div>
      <span className="text-[13px] text-[var(--ws-label2)]" data-ws-allowance-reset>
        Resets on {resetText(a)}
        {a.overQuota ? (a.blocked ? '. Video is paused until then.' : '. Satura Remote keeps working for now.') : ''}
      </span>
    </div>
  )
}

function AllowanceNotice({ a }: { a: RemoteAllowance | null }) {
  const toSettings = useCallback(() => setTab('settings'), [])
  if (!a || (!a.overQuota && a.usedPercent < 90)) return null
  return (
    <button type="button" onClick={toSettings} className="mx-4 mb-3 flex items-center gap-2.5 rounded-[12px] bg-[var(--ws-card)] px-4 py-3 text-left" data-ws-allowance-notice={a.overQuota ? 'over' : 'near'}>
      <TriangleAlert size={16} strokeWidth={2.4} className="shrink-0" style={{ color: allowanceColor(a) }} />
      <span className="text-[14px] leading-snug">
        {a.overQuota ? `You've reached this month's Satura Remote limit${a.blocked ? ', so video is paused' : ''}. It resets on ${resetText(a)}.` : `${gbText(a.remainingBytes)} of this month's Satura Remote limit left. It resets on ${resetText(a)}.`}
      </span>
    </button>
  )
}

function ProjectsTab({ load, onMac, usage, onUsage, onSheet }: { load: SystemLoadState; onMac: () => void; usage: UsageState; onUsage: () => void; onSheet: (s: ProjectSheet) => void }) {
  const s = useShell()
  const line = connectionLine(s)
  const online = s.conn === 'online'
  return (
    <Page title="Projects" max={980}>
      <div className="flex items-center gap-2 px-5 pb-3 text-[13.5px] text-[var(--ws-label2)]" data-ws-connection={s.conn}>
        <StatusDot dot={line.dot} />
        <span className="truncate">{online ? (s.projects.length === 1 ? '1 project open on this desktop' : `${s.projects.length} projects open on this desktop`) : line.text}</span>
        {online && s.access === 'local' && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[12.5px] text-[var(--ws-label3)]" data-ws-free-here>
            <Wifi size={13} strokeWidth={2.4} />
            Free on this Wi-Fi
          </span>
        )}
      </div>
      <div className="flex gap-2 px-4 pb-3">
        <button type="button" disabled={!online} onClick={() => onSheet('new')} className="ws-press flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-[var(--ws-blue)] text-[15px] font-semibold text-white disabled:opacity-50" data-ws-projects-new>
          <SquarePlus size={17} strokeWidth={2.4} />
          New Project
        </button>
        <button type="button" disabled={!online} onClick={() => onSheet('open')} className="ws-press ws-glass flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full text-[15px] font-semibold text-[var(--ws-ink)] disabled:opacity-50" data-ws-projects-open>
          <Folder size={17} strokeWidth={2.4} />
          Open Project
        </button>
      </div>
      <AllowanceNotice a={s.allowance} />
      <div className="mb-3 grid gap-3 px-4 empty:hidden" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(360px, 100%), 1fr))' }}>
        <MacStrip load={load} onOpen={onMac} />
        <UsageStrip usage={usage} onOpen={onUsage} />
      </div>
      {s.projects.length === 0 ? (
        <p className="px-5 pt-5 text-[15px] text-[var(--ws-label2)]">{s.conn === 'online' ? 'No projects are open on your desktop. Open one or make a new one above.' : 'Your projects show up here once the desktop answers.'}</p>
      ) : (
        <div className="grid gap-3 px-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(340px, 100%), 1fr))' }}>
          {s.projects.map((p, i) => (
            <ProjectCard key={p.id} p={p} active={p.id === s.activeProjectId} i={i} />
          ))}
        </div>
      )}
    </Page>
  )
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function dayLabel(at: number, now: number): string {
  const d = new Date(at)
  const today = new Date(now)
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (at >= start) return 'Today'
  if (at >= start - 86400000) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

const ACTIVITY_LOOK: Record<ActivityItem['kind'], { color: string; icon: ReactNode }> = {
  ask: { color: 'var(--ws-warn)', icon: <SquareTerminal size={17} strokeWidth={2.4} /> },
  unity: { color: 'var(--ws-err)', icon: <X size={17} strokeWidth={2.6} /> },
  alert: { color: 'var(--ws-err)', icon: <TriangleAlert size={17} strokeWidth={2.4} /> },
  tuner: { color: 'var(--ws-accent)', icon: <SquarePlus size={17} strokeWidth={2.4} /> },
  finished: { color: 'var(--ws-ok)', icon: <Check size={17} strokeWidth={2.6} /> },
  report: { color: 'var(--ws-accent)', icon: <FileText size={17} strokeWidth={2.4} /> }
}

function SmallButton({ label, prominent, onClick, pending }: { label: string; prominent?: boolean; onClick: () => void; pending?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`ws-press h-8 shrink-0 rounded-full px-3.5 text-[13.5px] font-semibold ${prominent ? 'bg-[var(--ws-blue)] text-white' : 'bg-white/[0.09] text-[var(--ws-ink)]'} ${pending ? 'remote-pending' : ''}`}
    >
      {label}
    </button>
  )
}

function ActivityCard({ item, now, i }: { item: ActivityItem; now: number; i: number }) {
  const pending = useShell((s) => s.pending)
  const look = ACTIVITY_LOOK[item.kind] ?? ACTIVITY_LOOK.report
  return (
    <div className="ws-item flex gap-3 rounded-[22px] bg-[var(--ws-card)] px-4 py-3.5" style={{ '--i': i } as CSSProperties} data-ws-activity={item.id} data-ws-open={item.open || undefined}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]" style={{ background: `color-mix(in srgb, ${look.color} 17%, transparent)`, color: look.color }}>
        {look.icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{item.title}</span>
          <span className="shrink-0 text-[12.5px] text-[var(--ws-label3)]">{item.count > 1 ? `${item.count}× · ` : ''}{ago(item.at, now)}</span>
        </div>
        {item.body && <p className="mt-0.5 line-clamp-3 text-[13.5px] leading-snug text-[var(--ws-label2)]">{item.body}</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          {item.options.map((o, i) => <SmallButton key={o.key} label={o.label} prominent={i === 0} pending={!!pending[`answer:${item.id}:${o.key}`]} onClick={() => answer(item, o)} />)}
          <SmallButton label="Open" pending={!!pending[`push:${item.id}`]} onClick={() => openActivity(item)} />
        </div>
      </div>
    </div>
  )
}

function ActivityTab() {
  const items = useShell((s) => s.activity)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const asks = items.filter((i) => i.open)
  const rest = items.filter((i) => !i.open)
  const days: { label: string; items: ActivityItem[] }[] = []
  for (const i of rest) {
    const label = dayLabel(i.at, now)
    const d = days.find((x) => x.label === label)
    if (d) d.items.push(i)
    else days.push({ label, items: [i] })
  }
  const sections = [...(asks.length ? [{ label: 'Needs you', items: asks }] : []), ...days]
  return (
    <Page title="Activity" max={680}>
      {sections.length === 0 ? (
        <p className="px-5 pt-3 text-[15px] leading-snug text-[var(--ws-label2)]">Agent questions, finished runs, Tuner hand-offs, compile errors, dashboard alerts and new reports from this desktop show up here.</p>
      ) : (
        sections.map((sec) => (
          <section key={sec.label}>
            <h2 className="sticky top-0 z-10 bg-black px-5 pb-1.5 pt-5 text-[13px] font-semibold text-[var(--ws-label2)]">{sec.label}</h2>
            <div className="flex flex-col gap-2.5 px-4">
              {sec.items.map((item, i) => (
                <ActivityCard key={item.id} item={item} now={now} i={i} />
              ))}
            </div>
          </section>
        ))
      )}
    </Page>
  )
}


const NOTIFY_ROWS: [NotifyKind, string][] = [
  ['ask', 'An agent asks something'],
  ['finished', 'An agent finishes'],
  ['unity', 'Unity has compile errors'],
  ['tuner', 'An agent hands you a Tuner'],
  ['alert', 'A dashboard alert fires'],
  ['report', 'A report is ready']
]

const PUSH_ROWS: [Exclude<keyof PushPrefs, 'on'>, string][] = [
  ['ask', 'An agent needs you'],
  ['finished', 'An agent finishes'],
  ['tuner', 'An agent hands you a Tuner'],
  ['unity', 'Unity compile errors or Play Mode fails'],
  ['alert', 'Dashboard alerts']
]

function Switch({ on, label, onClick, data, disabled }: { on: boolean; label: string; onClick: () => void; data: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={onClick} className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left disabled:opacity-50" data-ws-push={data}>
      <span className="flex-1 text-[16px]">{label}</span>
      <span className="ws-switch" aria-checked={on} />
    </button>
  )
}

function PushGroup() {
  const p = usePush()
  const online = useShell((s) => s.conn === 'online')
  useEffect(() => {
    if (online) void refreshPush()
  }, [online])
  const on = p.registered
  const macName = useShell((s) => s.hostName)
  const mine = useThisMac()
  const label = mine ? macLabel(mine) : macName || 'this desktop'
  const footer = p.error ?? (p.support || (p.permission === 'denied' ? (p.ios ? 'Notifications are off for Satura Remote. Turn them on in Settings > Notifications > Satura Remote.' : 'This browser blocks notifications from Satura Remote. Allow them in the site settings.') : `These are the notifications from ${label}. Each desktop has its own. ${label} encrypts each one for this phone, and the relay can't read it.`))
  return (
    <Group title="Notifications" footer={footer}>
      <Switch
        on={on}
        label={p.busy ?? `Notifications from ${label}`}
        disabled={!!p.busy || !!p.support || !online}
        onClick={() => (on ? void disablePush() : enablePush())}
        data="on"
      />
      {on && (
        <>
          <Switch on={!p.prefs.on} label="Pause all" onClick={() => void setPushPref('on', !p.prefs.on)} data="pause" />
          {PUSH_ROWS.map(([k, label]) => (
            <Switch key={k} on={p.prefs.on && p.prefs[k]} disabled={!p.prefs.on} label={label} onClick={() => void setPushPref(k, !p.prefs[k])} data={k} />
          ))}
          <button type="button" disabled={!!p.busy || !online} onClick={() => void testPush()} className="flex min-h-[48px] w-full items-center px-4 text-left text-[16px] text-[var(--ws-blue)] active:bg-white/[0.06] disabled:opacity-50" data-ws-push="test">
            Send a test notification
          </button>
        </>
      )}
    </Group>
  )
}

function AccountGroup() {
  const account = useShell((s) => s.account)
  const manage = accountUrl('/remote')
  const [leaving, setLeaving] = useState(false)
  if (typeof account !== 'string' || !manage) return null
  return (
    <Group title="Account" footer={`Sign out here forgets this phone's sign-in. To sign out every phone, use ${new URL(manage).host}.`}>
      <div className="flex min-h-[48px] items-center gap-3 px-4" data-ws-account={account}>
        <RowIcon color="rgb(99 99 102)">
          <CircleUser size={16} strokeWidth={2.4} />
        </RowIcon>
        <span className="min-w-0 truncate text-[16px]">{account}</span>
      </div>
      <button
        type="button"
        disabled={leaving}
        aria-busy={leaving}
        onClick={() => {
          setLeaving(true)
          void signOutHere()
        }}
        className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-[16px] text-[var(--ws-err)] active:bg-white/[0.06] disabled:opacity-50"
        data-ws-signout
      >
        <RowIcon color="rgb(239 110 107)">
          <LogOut size={15} strokeWidth={2.4} />
        </RowIcon>
        {leaving ? 'Signing out' : 'Sign out on this phone'}
      </button>
      <a href={manage} target="_top" className="flex min-h-[48px] items-center gap-3 px-4 text-[16px] text-[var(--ws-blue)] active:bg-white/[0.06]" data-ws-signout-all>
        Sign out all phones
        <ChevronRight size={16} strokeWidth={2.4} className="ml-auto text-[var(--ws-label3)]" />
      </a>
    </Group>
  )
}

function SettingsTab() {
  const s = useShell()
  const mac = useThisMac()
  const [ask, setAsk] = useState<'rename' | 'remove' | null>(null)
  const state = s.conn === 'online' ? 'Online' : s.conn === 'connecting' ? 'Connecting' : 'Offline'
  const host = pathHostId() ?? ''
  const name = mac ? macLabel(mac) : s.hostName || 'Your desktop'
  const others = listMacs().filter((m) => m.hostId !== host).length
  const remove = async (): Promise<void> => {
    if (s.conn === 'online') await invokeRemote('remote:push:unregister').catch(() => {})
    await forgetMacOnPhone(host, 'removed in Settings')
    location.replace(others ? '/h/all/' : '/m/')
  }
  return (
    <Page title="Settings" max={680}>
      <Group title="This desktop" footer={mac?.alias && mac.name ? `The desktop calls itself ${mac.name}.` : undefined}>
        <div className="flex min-h-[64px] items-center gap-3 px-4 py-2" data-ws-this-mac={host}>
          <DesktopTile hostId={host} kind={mac?.kind ?? null} size={40} tone={connTone(s.conn)} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[16px] font-semibold">{name}</span>
            <span className="truncate text-[13px] text-[var(--ws-label2)]">
              {mac?.kind ? `${hostKindLabel(mac.kind)} · ` : ''}
              {state}
              {s.version ? ` · Satura ${s.version}` : ''}
            </span>
          </div>
        </div>
        <div className="flex min-h-[48px] items-center gap-3 px-4">
          <RowIcon color="rgb(89 87 214)">
            <Wifi size={16} strokeWidth={2.4} />
          </RowIcon>
          <span className="text-[16px]">Satura Remote</span>
          <span className="ml-auto min-w-0 truncate text-[15px] text-[var(--ws-label2)]">{relayDisplay()}</span>
        </div>
        {netDebugAllowed() && <NetDebugRow icon={(c) => <RowIcon color="rgb(48 176 199)">{c}</RowIcon>} />}
        {mac && (
          <button type="button" onClick={() => setAsk('rename')} className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-[16px] active:bg-white/[0.06]" data-ws-mac-rename>
            <RowIcon color="rgb(99 99 102)">
              <Pencil size={15} strokeWidth={2.4} />
            </RowIcon>
            Name on this phone
            <span className="ml-auto min-w-0 truncate text-[15px] text-[var(--ws-label2)]">{name}</span>
          </button>
        )}
        <button type="button" onClick={() => setAsk('remove')} className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-[16px] text-[var(--ws-err)] active:bg-white/[0.06]" data-ws-mac-remove>
          <RowIcon color="rgb(239 110 107)">
            <Trash2 size={15} strokeWidth={2.4} />
          </RowIcon>
          Remove from this phone
        </button>
      </Group>
      <Group>
        <a href="/h/all/" className="flex min-h-[48px] items-center gap-3 px-4 text-[16px] active:bg-white/[0.06]" data-ws-all-macs>
          <RowIcon color="rgb(10 132 255)">
            <House size={16} strokeWidth={2.4} />
          </RowIcon>
          All desktops
          <span className="ml-auto text-[15px] text-[var(--ws-label2)]">{others + 1}</span>
          <ChevronRight size={16} strokeWidth={2.4} className="text-[var(--ws-label3)]" />
        </a>
      </Group>
      {s.access === 'local' && (
        <Group title="Satura Remote" footer="Satura Remote is free while this phone is on the same Wi-Fi as your desktop. Away from it, Satura Remote needs a subscription, $19 a month.">
          <div className="flex min-h-[48px] items-center gap-3 px-4 text-[16px]" data-ws-free-row>
            <RowIcon color="rgb(48 209 88)">
              <Wifi size={16} strokeWidth={2.4} />
            </RowIcon>
            Free on this Wi-Fi
          </div>
        </Group>
      )}
      {s.allowance && s.access !== 'local' && (
        <Group title="Used this month" footer="When your phone and desktop are on the same network, video goes straight between them and doesn't count toward your monthly limit.">
          <AllowanceRows a={s.allowance} />
        </Group>
      )}
      <AccountGroup />
      <StorageGroup />
      {!standalone() && (
        <Group>
          <a href="/m/?install=1" className="flex min-h-[48px] items-center gap-3 px-4 text-[16px] active:bg-white/[0.06]" data-ws-install>
            <RowIcon color="rgb(10 132 255)">
              <SquarePlus size={16} strokeWidth={2.4} />
            </RowIcon>
            Add to Home Screen
            <ChevronRight size={16} strokeWidth={2.4} className="ml-auto text-[var(--ws-label3)]" />
          </a>
        </Group>
      )}
      <PushGroup />
      <Group title="Banners in the app" footer="You see these as banners while Satura Remote shows this desktop.">
        {NOTIFY_ROWS.map(([kind, label]) => (
          <button key={kind} type="button" role="switch" aria-checked={s.notify[kind]} onClick={() => setNotify(kind, !s.notify[kind])} className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left" data-ws-notify={kind}>
            <span className="flex-1 text-[16px]">{label}</span>
            <span className="ws-switch" aria-checked={s.notify[kind]} />
          </button>
        ))}
      </Group>
      <Presence when={ask === 'rename' && mac}>{(m) => <RenameSheet mac={m} onClose={() => setAsk(null)} />}</Presence>
      <Presence when={ask === 'remove'}>{() => <RemoveSheet mac={mac ?? { hostId: host, name, alias: '', phoneId: '', pairedAt: 0, seenAt: 0, hue: -1, removed: null, summary: null, kind: null }} onClose={() => setAsk(null)} onRemove={remove} />}</Presence>
    </Page>
  )
}

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'projects', label: 'Projects', icon: <Folder size={22} strokeWidth={2} /> },
  { id: 'activity', label: 'Activity', icon: <Bell size={22} strokeWidth={2} /> },
  { id: 'settings', label: 'Settings', icon: <Settings size={22} strokeWidth={2} /> }
]

export function tabBarHeight(view: { landscape: boolean }): number {
  return view.landscape ? 38 : 50
}

function TabBar() {
  const tab = useShell((s) => s.tab)
  const asks = useShell((s) => s.activity.filter((i) => i.open).length)
  const view = useView()
  return (
    <nav className="fixed inset-x-0 bottom-0 z-[40] border-t border-white/[0.08] bg-[var(--ws-canvas)]" style={{ paddingBottom: view.safe.b, paddingLeft: view.safe.l, paddingRight: view.safe.r }} data-ws-tabbar>
      <div className="mx-auto flex max-w-[560px] items-stretch" style={{ height: tabBarHeight(view) }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex flex-1 items-center justify-center ${view.landscape ? 'flex-row gap-1.5 text-[12px]' : 'flex-col gap-[3px] text-[10.5px]'} font-semibold ${tab === t.id ? 'text-[var(--ws-accent)]' : 'text-[var(--ws-label2)] active:text-[var(--ws-ink)]'}`}
            aria-current={tab === t.id ? 'page' : undefined}
            data-ws-tab={t.id}
          >
            <span className="relative">
              {t.icon}
              {t.id === 'activity' && asks > 0 && <span className="absolute -right-2.5 -top-1.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-[#ff453a] px-1 text-[11px] font-bold text-white">{asks}</span>}
            </span>
            {t.label}
          </button>
        ))}
      </div>
    </nav>
  )
}

export function Lists() {
  const tab = useShell((s) => s.tab)
  const online = useShell((s) => s.conn === 'online')
  const [mac, setMac] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [sheet, setSheet] = useState<ProjectSheet | null>(null)
  const closeSheet = useCallback(() => setSheet(null), [])
  const switcher = useShell((s) => s.switcher)
  const closeSwitcher = useCallback(() => useShell.setState({ switcher: false }), [])
  const load = useSystemLoad(online && (mac || tab === 'projects'))
  const usage = useAgentUsage(online)
  const openMac = useCallback(() => setMac(true), [])
  const closeMac = useCallback(() => setMac(false), [])
  const openUsage = useCallback(() => setUsageOpen(true), [])
  const closeUsage = useCallback(() => setUsageOpen(false), [])
  return (
    <>
      {tab === 'projects' ? <ProjectsTab load={load} onMac={openMac} usage={usage} onUsage={openUsage} onSheet={setSheet} /> : tab === 'activity' ? <ActivityTab /> : <SettingsTab />}
      <TabBar />
      <Presence when={mac}>{() => <MacScreen load={load} onClose={closeMac} />}</Presence>
      <Presence when={switcher}>{() => <MacSwitcher currentId={pathHostId() ?? ''} onClose={closeSwitcher} />}</Presence>
      <Presence when={usageOpen}>{() => <UsageScreen usage={usage} onClose={closeUsage} />}</Presence>
      <Presence when={sheet}>{(k) => (k === 'new' ? <NewProjectScreen onClose={closeSheet} /> : <OpenProjectScreen onClose={closeSheet} />)}</Presence>
    </>
  )
}
