import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { BellOff, Check, ChevronRight, House, Plus } from 'lucide-react'
import { DesktopTile } from './desktop-art'
import { Layer, leavePage } from './motion'
import { agoText, fetchPresence, listMacs, macLabel, macPath, onMacsChange, unreadFor, updateMac, type MacPresence, type MacRecord, type MacUnread } from './macs'

export type Tone = 'ok' | 'wait' | 'err' | 'off'

export interface MacView {
  mac: MacRecord
  presence: MacPresence | null
  unread: MacUnread
  muted: boolean
}

export interface MacStatus {
  tone: Tone
  text: string
  live: boolean
  usable: boolean
}

const UNITY_WORDS: Record<string, string> = {
  init: 'starting',
  launching: 'starting',
  editmode: 'open',
  'entering-play': 'entering Play Mode',
  playing: 'in Play Mode',
  paused: 'paused in Play Mode',
  'exiting-play': 'leaving Play Mode',
  restarting: 'restarting',
  error: 'stopped with an error',
  errors: 'has compile errors',
  compiling: 'compiling'
}

export function statusOf(v: Pick<MacView, 'mac' | 'presence'>, now = Date.now()): MacStatus {
  const { mac, presence } = v
  const seen = mac.seenAt ? `Last seen ${agoText(mac.seenAt, now)}` : 'Not seen yet'
  if (mac.removed) return { tone: 'err', text: 'This desktop removed this phone', live: false, usable: false }
  if (presence?.fit === 'update') return { tone: 'wait', text: 'Update Satura on this desktop', live: false, usable: false }
  if (presence?.fit === 'relay') return { tone: 'wait', text: 'Satura Remote is updating', live: false, usable: false }
  if (presence?.state === 'up') return { tone: 'ok', text: 'Online', live: true, usable: true }
  if (presence?.state === 'silent') return { tone: 'wait', text: 'Not responding', live: false, usable: true }
  if (presence?.state === 'gone') return { tone: 'off', text: `Offline${mac.seenAt ? `, seen ${agoText(mac.seenAt, now)}` : ''}`, live: false, usable: true }
  return { tone: 'off', text: seen, live: false, usable: true }
}

export function summaryLines(mac: MacRecord): string[] {
  const s = mac.summary
  if (!s) return []
  const lines: string[] = []
  const asks = s.projects.filter((p) => p.asks > 0)
  const askCount = asks.reduce((n, p) => n + p.asks, 0)
  if (askCount) lines.push(`${askCount === 1 ? 'An agent needs' : `${askCount} agents need`} you in ${asks.map((p) => p.title).slice(0, 2).join(' and ')}`)
  const unity = s.projects.filter((p) => p.unity)
  if (unity.length === 1) lines.push(`Unity ${UNITY_WORDS[unity[0].unity as string] ?? unity[0].unity} in ${unity[0].title}`)
  else if (unity.length > 1) lines.push(`${unity.length} Unity editors open${unity.some((p) => p.unity === 'playing') ? ', one in Play Mode' : ''}`)
  const working = s.projects.reduce((n, p) => n + p.agents, 0)
  if (working) lines.push(`${working === 1 ? 'An agent is' : `${working} agents are`} working`)
  const named = lines.some((l) => s.projects.length === 1 && l.endsWith(` in ${s.projects[0].title}`))
  if (!s.projects.length) lines.push('No projects open')
  else if (lines.length < 3 && !named) lines.unshift(s.projects.length === 1 ? s.projects[0].title : `${s.projects.length} projects open`)
  return lines.slice(0, 3)
}

export function ToneDot({ tone }: { tone: Tone }) {
  return <span className="ws-dot" data-dot={tone === 'ok' ? 'ok' : tone === 'wait' ? 'wait' : tone === 'err' ? 'err' : 'off'} aria-hidden />
}

export function Badge({ n }: { n: number }) {
  if (n <= 0) return null
  return (
    <span className="flex h-[19px] min-w-[19px] items-center justify-center rounded-full bg-[#ff453a] px-[5px] text-[12px] font-bold leading-none text-white" data-mac-badge={n}>
      {n > 99 ? '99+' : n}
    </span>
  )
}

async function pushOff(hostId: string): Promise<boolean> {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false
    const reg = await navigator.serviceWorker?.getRegistration(macPath(hostId))
    if (!reg || !reg.scope.endsWith(macPath(hostId))) return true
    return !(await reg.pushManager.getSubscription())
  } catch {
    return false
  }
}

export function useMacs(pollMs: number, skipPresenceFor: string | null = null): { views: MacView[]; refresh: () => void } {
  const [macs, setMacs] = useState<MacRecord[]>(() => listMacs())
  const [presence, setPresence] = useState<Record<string, MacPresence> | null>(null)
  const [unread, setUnread] = useState<Record<string, MacUnread>>({})
  const [muted, setMuted] = useState<Record<string, boolean>>({})
  const busy = useRef(false)
  const refresh = useCallback(() => {
    const list = listMacs()
    setMacs(list)
    if (busy.current) return
    busy.current = true
    const ids = list.map((m) => m.hostId)
    const ask = ids.filter((id) => id !== skipPresenceFor && !list.find((m) => m.hostId === id)?.removed)
    void Promise.all([
      fetchPresence(ask).then(setPresence),
      Promise.all(ids.map(async (id) => [id, await unreadFor(id), await pushOff(id)] as const)).then((rows) => {
        setUnread(Object.fromEntries(rows.map(([id, u]) => [id, u])))
        setMuted(Object.fromEntries(rows.map(([id, , m]) => [id, m])))
      })
    ]).finally(() => {
      busy.current = false
    })
  }, [skipPresenceFor])
  useEffect(() => {
    refresh()
    const off = onMacsChange(() => setMacs(listMacs()))
    const t = window.setInterval(() => document.visibilityState === 'visible' && refresh(), pollMs)
    const onVis = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      off()
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [refresh, pollMs])
  const views = macs.map((mac) => ({ mac, presence: presence?.[mac.hostId] ?? null, unread: unread[mac.hostId] ?? { count: 0, latest: null }, muted: !!muted[mac.hostId] }))
  return { views, refresh }
}

export function Sheet({ title, onClose, children, data, z }: { title?: string; onClose: () => void; children: ReactNode; data: string; z?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <Layer className="z-[1200] flex flex-col justify-end" style={z ? { zIndex: z } : undefined} data-mac-sheet={data}>
      <button type="button" aria-label="Close" className="ws-fade-in absolute inset-0 bg-black/55" onClick={onClose} />
      <div className="ws-kb-bottom relative mx-auto flex w-full max-w-[560px] flex-col">
        <div className="ws-sheet flex w-full flex-col rounded-t-[22px] bg-[#1c1c1e]" style={{ maxHeight: 'min(86dvh, calc(var(--ws-vv-h) - env(safe-area-inset-top) - 12px))', paddingBottom: 'max(14px, env(safe-area-inset-bottom))' }} data-mac-sheet-panel>
          <div className="flex justify-center pb-1 pt-2">
            <span className="h-[5px] w-9 rounded-full bg-white/[0.22]" />
          </div>
          {title && <h2 className="px-5 pb-2 pt-1 text-[20px] font-bold tracking-tight">{title}</h2>}
          <div className="ws-scroll min-h-0 flex-1">{children}</div>
        </div>
      </div>
    </Layer>
  )
}

export function SheetButton({ label, onClick, tone = 'plain', icon, data }: { label: string; onClick: () => void; tone?: 'plain' | 'blue' | 'danger'; icon?: ReactNode; data: string }) {
  const color = tone === 'danger' ? 'var(--ws-err)' : tone === 'blue' ? 'var(--ws-blue)' : 'var(--ws-ink)'
  return (
    <button type="button" onClick={onClick} className="flex min-h-[50px] w-full items-center gap-3 px-5 text-left text-[17px] active:bg-white/[0.06]" style={{ color }} data-mac-action={data}>
      {icon && <span className="flex w-6 justify-center">{icon}</span>}
      {label}
    </button>
  )
}

export function MacSwitchRow({ v, current, onPick, now }: { v: MacView; current: boolean; onPick: () => void; now: number }) {
  const st = current ? { tone: 'ok' as Tone, text: 'This desktop, connected', live: true, usable: true } : statusOf(v, now)
  return (
    <button type="button" onClick={onPick} className="flex min-h-[64px] w-full items-center gap-3.5 px-5 py-2 text-left active:bg-white/[0.06]" data-mac-switch={v.mac.hostId} data-mac-current={current ? '1' : '0'}>
      <DesktopTile hostId={v.mac.hostId} kind={v.mac.kind} size={40} tone={st.tone} removed={!!v.mac.removed} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[17px] font-semibold">{macLabel(v.mac)}</span>
        <span className="flex items-center gap-1.5 text-[13.5px] text-[var(--ws-label2)]">
          <ToneDot tone={st.tone} />
          <span className="truncate">{st.text}</span>
        </span>
      </span>
      {!current && <Badge n={v.unread.count} />}
      {current ? <Check size={20} strokeWidth={2.6} className="shrink-0 text-[var(--ws-accent)]" /> : <ChevronRight size={18} strokeWidth={2.4} className="shrink-0 text-[var(--ws-label3)]" />}
    </button>
  )
}

export function MacSwitcher({ currentId, onClose }: { currentId: string; onClose: () => void }) {
  const { views } = useMacs(5000, currentId)
  const [now] = useState(Date.now())
  const go = (id: string): void => {
    if (id === currentId) return onClose()
    console.info(`[macs] switching from ${currentId} to ${id}`)
    leavePage(macPath(id))
  }
  return (
    <Sheet title="Your desktops" onClose={onClose} data="switcher">
      <div className="mx-4 overflow-hidden rounded-[14px] bg-white/[0.06] [&>*+*]:border-t [&>*+*]:border-white/[0.07]">
        {views.map((v) => (
          <MacSwitchRow key={v.mac.hostId} v={v} current={v.mac.hostId === currentId} now={now} onPick={() => go(v.mac.hostId)} />
        ))}
      </div>
      <div className="mx-4 mt-3 overflow-hidden rounded-[14px] bg-white/[0.06] [&>*+*]:border-t [&>*+*]:border-white/[0.07]">
        <SheetButton label="Pair another desktop" tone="blue" icon={<Plus size={20} strokeWidth={2.4} />} onClick={() => leavePage('/m/?add=1')} data="pair" />
        <SheetButton label="All desktops" tone="blue" icon={<House size={19} strokeWidth={2.2} />} onClick={() => leavePage('/h/all/')} data="home" />
      </div>
    </Sheet>
  )
}

export function RenameSheet({ mac, onClose }: { mac: MacRecord; onClose: () => void }) {
  const [value, setValue] = useState(mac.alias || mac.name)
  const field = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])
  const save = (): void => {
    const alias = value.trim().slice(0, 60)
    updateMac(mac.hostId, { alias: alias === mac.name ? '' : alias })
    console.info(`[macs] ${mac.hostId} is called ${alias || mac.name} on this phone`)
    onClose()
  }
  return (
    <Sheet title="Name on this phone" onClose={onClose} data="rename">
      <form
        className="px-4 pb-2"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <input ref={field} value={value} onChange={(e) => setValue(e.target.value)} maxLength={60} placeholder={mac.name || 'Desktop'} className="ws-field h-[48px] w-full rounded-[12px] bg-white/[0.08] px-4 text-[17px] text-[var(--ws-ink)] outline-none" data-mac-rename-field enterKeyHint="done" />
        <p className="px-1 pt-2 text-[13px] leading-snug text-[var(--ws-label2)]">{mac.name ? `The desktop calls itself ${mac.name}. This name only changes on this phone. Leave it empty to use the desktop's name.` : 'This name only changes on this phone.'}</p>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onClose} className="ws-press h-[48px] flex-1 rounded-full bg-white/[0.09] text-[16px] font-semibold">
            Cancel
          </button>
          <button type="submit" className="ws-press h-[48px] flex-1 rounded-full bg-[var(--ws-blue)] text-[16px] font-semibold text-white" data-mac-rename-save>
            Save
          </button>
        </div>
      </form>
    </Sheet>
  )
}

export function RemoveSheet({ mac, onClose, onRemove }: { mac: MacRecord; onClose: () => void; onRemove: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  return (
    <Sheet title={`Remove ${macLabel(mac)}?`} onClose={onClose} data="remove">
      <p className="px-5 text-[15px] leading-snug text-[var(--ws-label2)]">
        {mac.removed ? 'This phone forgets this desktop.' : "This phone forgets its key for this desktop and stops getting its notifications. To take the phone off the desktop's list too, open Satura on the desktop: Settings, Mobile."}
      </p>
      <div className="mt-4 flex gap-2 px-4 pb-2">
        <button type="button" onClick={onClose} className="ws-press h-[48px] flex-1 rounded-full bg-white/[0.09] text-[16px] font-semibold">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void onRemove().finally(onClose)
          }}
          className="ws-press h-[48px] flex-1 rounded-full bg-[rgb(239_110_107/0.16)] text-[16px] font-semibold text-[var(--ws-err)]"
          data-mac-remove-confirm
        >
          {busy ? 'Removing' : 'Remove'}
        </button>
      </div>
    </Sheet>
  )
}

export function MutedMark({ on }: { on: boolean }) {
  if (!on) return null
  return <BellOff size={15} strokeWidth={2.2} className="shrink-0 text-[var(--ws-label3)]" aria-label="Notifications off" />
}
