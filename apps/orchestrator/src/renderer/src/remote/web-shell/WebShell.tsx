import { useEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, CloudOff, Copy, Hourglass, Laptop, Link2Off, Lock, Smartphone, TriangleAlert, UserX, Wifi, WifiOff, CircleCheck } from 'lucide-react'
import { pairTextInUrl } from '../pair-marker'
import { HOME_PATH, fetchPresence, listMacs, pathHostId } from '../macs'
import { DesktopTile } from '../desktop-art'
import { openActivity } from '../push'
import { call, closeWorkspace, dismissToast, pairedName, storedPairing, useShell, type Fit, type Outage, type ShellState } from './bridge'
import { accountUrl, goSignIn, signOutHere } from '../account'
import { endResume, installViewport, useView } from './viewport'
import { Lists, StatusDot, connectionLine, tabBarHeight } from './lists'
import { WorkspaceChrome } from './workspace'
import { ConfirmHost, MenuHost, PickerHost, PromptHost } from './menus'
import { NetDebugPanel } from './netdebug'
import { SaveSheetHost } from '../save-sheet'
import { Crossfade, Presence, ProgressBar, leavePage, useStageProgress } from '../motion'
import './shell.css'

const BANNER_DOT: Record<string, string> = { ask: 'wait', unity: 'err', alert: 'err', tuner: 'work', finished: 'ok', report: 'work' }

function otherMacs(): number {
  return listMacs().filter((m) => m.hostId !== pathHostId()).length
}

function HostLine() {
  const live = useShell((s) => (s.conn === 'unpaired' ? '' : s.hostName))
  const name = live || pairedName()
  if (!name) return null
  const host = pathHostId()
  return (
    <p className="mt-5 flex max-w-[420px] items-center gap-2 rounded-full bg-white/[0.07] py-1.5 pl-1.5 pr-3.5 text-[14px] text-[var(--ws-label2)]" data-ws-host>
      {host && <DesktopTile hostId={host} size={26} tone="off" />}
      <span className="truncate font-semibold text-[var(--ws-ink)]">{name}</span>
    </p>
  )
}

function allDesktops(): void {
  console.info(`[web-shell] All desktops on the ${document.querySelector('[data-ws-screen]')?.getAttribute('data-ws-screen') ?? 'connection'} screen`)
  leavePage(HOME_PATH)
}

function Screen({ icon, title, body, children, data, z = 900, host = true }: { icon: ReactNode; title: string; body?: string; children?: ReactNode; data: string; z?: number; host?: boolean }) {
  const view = useView()
  return (
    <div className="ws-fade-in fixed inset-0 flex flex-col bg-[var(--ws-canvas)]" style={{ zIndex: z, paddingTop: view.safe.t, paddingBottom: Math.max(view.safe.b, 16), paddingLeft: view.safe.l, paddingRight: view.safe.r }} data-ws-screen={data}>
      <button type="button" aria-label="All desktops" onClick={allDesktops} className="ws-press absolute z-[1] flex h-[44px] items-center px-2" style={{ top: view.safe.t + 2, left: view.safe.l + 6 }} data-ws-all-desktops>
        <span className="ws-glass flex h-[32px] items-center gap-0.5 rounded-full pl-2 pr-3 text-[13px] font-medium text-[var(--ws-ink)]">
          <ChevronLeft size={16} strokeWidth={2.8} />
          All desktops
        </span>
      </button>
      <div className="ws-scroll flex flex-1 flex-col items-center justify-center px-8 text-center">
        <span className="mb-4 text-[var(--ws-accent)]">{icon}</span>
        <h1 className="text-[24px] font-bold leading-tight">{title}</h1>
        {body && <p className="mt-2 max-w-[420px] text-[15px] leading-snug text-[var(--ws-label2)]">{body}</p>}
        {host && <HostLine />}
      </div>
      {children && <div className="mx-auto flex w-full max-w-[420px] flex-col gap-2 px-6 pb-2">{children}</div>}
    </div>
  )
}

function Primary({ label, onClick, href, target, data, busy }: { label: string; onClick?: () => void; href?: string; target?: string; data?: string; busy?: string }) {
  const cls = 'ws-press flex h-[52px] w-full items-center justify-center gap-2.5 rounded-full bg-[var(--ws-blue)] text-[17px] font-semibold text-white disabled:opacity-70'
  return href ? (
    <a href={href} target={target} className={cls} data-ws-action={data ?? label}>
      {label}
    </a>
  ) : (
    <button type="button" onClick={onClick} disabled={!!busy} aria-busy={!!busy} className={cls} data-ws-action={data ?? label}>
      {busy && <span className="ws-spin !h-[18px] !w-[18px] !border-2 !border-white/30 !border-t-white" />}
      {busy || label}
    </button>
  )
}

function Secondary({ label, onClick, data }: { label: string; onClick: () => void; data?: string }) {
  return (
    <button type="button" onClick={onClick} className="h-[46px] w-full text-[16px] font-semibold text-[var(--ws-accent)]" data-ws-action={data ?? label}>
      {label}
    </button>
  )
}

function tryAgain(): void {
  call('connectAgain', `Try again on the ${useShell.getState().conn} screen`)
}


function Actions({ retry = true, pair = true, busy }: { retry?: boolean; pair?: boolean; busy?: string }) {
  const account = useShell((s) => s.account)
  return (
    <>
      {retry && <Primary label="Try again" onClick={tryAgain} data="retry" busy={busy} />}
      {pair && <Secondary label={otherMacs() ? 'Your other desktops' : 'Pair another desktop'} onClick={() => leavePage(otherMacs() ? '/h/all/' : '/m/?add=1')} data="pair-another" />}
      {typeof account === 'string' && <Secondary label="Sign out" onClick={() => void signOutHere()} data="signout" />}
    </>
  )
}

function ConnectBar({ step, halted }: { step: string; halted: boolean }) {
  const value = useStageProgress(step, step === 'online' ? 0.6 : 0.05, 0.95, -1, 2500)
  return <ProgressBar value={halted ? 0 : value} className={`h-[3px] w-[180px] transition-opacity ${halted ? 'opacity-40' : ''}`} />
}

function ConnectSlot({ s }: { s: ShellState }) {
  const again = !!s.halted
  const idle = !again && s.conn === 'online'
  const label = again ? 'Try again' : 'Cancel'
  const press = (): void => {
    console.info(`[web-shell] ${label} on the connection screen (${s.conn}${s.halted ? `, ${s.halted}` : ''})`)
    if (again) call('connectAgain', 'Try again on the connection screen')
    else call('stopConnecting', 'Cancel on the connection screen')
  }
  return (
    <button
      type="button"
      onClick={press}
      disabled={idle}
      className="ws-press ws-glass flex h-[50px] w-full items-center justify-center rounded-full text-[17px] font-semibold text-[var(--ws-ink)] transition-opacity disabled:opacity-40"
      data-ws-connect-slot={again ? 'try-again' : idle ? 'cancel-disabled' : 'cancel'}
    >
      <Crossfade k={label}>{label}</Crossfade>
    </button>
  )
}

function connectStep(s: ShellState): string {
  if (s.halted === 'cancelled') return 'Stopped connecting'
  if (s.halted) return s.detail || "Couldn't reach your desktop"
  if (s.conn === 'online') return 'Getting your projects'
  if (s.detail) return s.detail
  return s.paired === false ? 'Pairing with your desktop' : 'Reaching your desktop'
}

function ConnectScreen({ s, data, title, z, host = true }: { s: ShellState; data: string; title: string; z?: number; host?: boolean }) {
  const step = connectStep(s)
  return (
    <Screen data={data} z={z} icon={<ConnectBar step={s.conn} halted={!!s.halted} />} title={title} host={host}>
      <p className="mb-2 flex justify-center text-center text-[14px] text-[var(--ws-label2)]" data-ws-step>
        <Crossfade k={step}>{s.halted ? `${step}.` : `${step}…`}</Crossfade>
      </p>
      <ConnectSlot s={s} />
    </Screen>
  )
}

function outageCopy(outage: Outage): { icon: ReactNode; title: string; body: string } {
  const icon = (I: typeof Laptop): ReactNode => <I size={46} strokeWidth={1.8} />
  const mac = pairedName() || 'Your desktop'
  if (outage === 'stuck') return { icon: icon(Hourglass), title: `${mac} isn't responding`, body: 'Satura on that desktop stopped answering. It may be busy or stuck, or the desktop went to sleep. Check it, then tap Try again.' }
  if (outage === 'offline') return { icon: icon(Laptop), title: `${mac} is offline`, body: `Open Satura on it and keep it awake, then tap Try again.${otherMacs() ? ' Your other desktops still work.' : ''}` }
  if (navigator.onLine === false) return { icon: icon(WifiOff), title: 'This phone is offline', body: 'Connect to Wi-Fi or mobile data, then tap Try again.' }
  return { icon: icon(CloudOff), title: "Can't connect to Satura Remote", body: "Satura Remote is unavailable right now, or this phone's connection dropped. Tap Try again in a moment." }
}

const BACK_POLL_MS = 3000

function useDesktopBack(outage: Outage, halted: boolean): void {
  useEffect(() => {
    const host = pathHostId()
    if (!host || outage === 'relay' || !halted) return
    let stop = false
    const poll = async (): Promise<void> => {
      if (stop) return
      if (document.visibilityState === 'visible') {
        const p = (await fetchPresence([host]))?.[host]
        if (stop) return
        if (p?.state === 'up' && p.fit === 'ok') {
          console.info(`[web-shell] ${pairedName() || 'the desktop'} is back online, connecting again`)
          call('connectAgain', 'the desktop is back online')
          return
        }
      }
      window.setTimeout(() => void poll(), BACK_POLL_MS)
    }
    const t = window.setTimeout(() => void poll(), BACK_POLL_MS)
    return () => {
      stop = true
      window.clearTimeout(t)
    }
  }, [outage, halted])
}

function OutageScreen({ s }: { s: ShellState & { outage: Outage } }) {
  useDesktopBack(s.outage, !!s.halted)
  const copy = outageCopy(s.outage)
  return (
    <Screen data={`outage-${s.outage}`} icon={copy.icon} title={copy.title} body={copy.body}>
      <ConnectSlot s={s} />
    </Screen>
  )
}

const SUBSCRIBE_PATH = '/api/dodo/checkout?plan=monthly&from=remote'

function FitScreen({ fit }: { fit: Fit }) {
  const mac = pairedName()
  const copy =
    fit === 'update'
      ? { title: mac ? `Update Satura on ${mac}` : 'Update Satura on your desktop', body: `The Satura app on this desktop is too old for Satura Remote.${otherMacs() ? ' Your other desktops keep working.' : ''}` }
      : { title: 'Satura Remote is updating', body: 'Satura on your desktop is newer than Satura Remote on this phone. An update is on its way. Tap Try again in a few minutes.' }
  return (
    <Screen data={`fit-${fit}`} icon={<Hourglass size={46} strokeWidth={1.8} />} title={copy.title} body={copy.body}>
      <Primary label="Try again" onClick={() => location.reload()} data="retry" />
    </Screen>
  )
}
const AWAY_FAST_MS = 5000
const AWAY_SLOW_MS = 15_000
const AWAY_FAST_FOR_MS = 60_000
const AWAY_PRESS_MS = 700

function checkNetwork(why: string): void {
  call('checkNetwork', why)
}

function useAwayChecks(): void {
  useEffect(() => {
    const shownAt = Date.now()
    let timer = 0
    const next = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(
        () => {
          if (document.visibilityState === 'visible') checkNetwork('automatic check while the away screen shows')
          next()
        },
        Date.now() - shownAt < AWAY_FAST_FOR_MS ? AWAY_FAST_MS : AWAY_SLOW_MS
      )
    }
    const now = (why: string) => (): void => {
      if (document.visibilityState !== 'visible') return
      checkNetwork(why)
      next()
    }
    const onShown = now('the page is visible again')
    const onOnline = now('the phone came back online')
    document.addEventListener('visibilitychange', onShown)
    window.addEventListener('online', onOnline)
    next()
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onShown)
      window.removeEventListener('online', onOnline)
    }
  }, [])
}

function useSecondsSince(at: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return at ? Math.max(0, Math.round((now - at) / 1000)) : -1
}

function AwayCheckLine({ s, checking }: { s: ShellState; checking: boolean }) {
  const ago = useSecondsSince(s.awayCheckedAt)
  const text = checking ? 'Checking your network' : s.awayCheck === 'error' ? "Couldn't reach Satura Remote to check. Check this phone's connection." : ago >= 0 ? `Still on another network, checked ${ago < 2 ? 'just now' : `${ago} s ago`}` : 'Satura Remote comes back on its own on that Wi-Fi'
  return (
    <div className="flex flex-col items-center gap-2 pb-1" data-ws-away-check={s.awayCheck}>
      <ProgressBar value={checking ? null : 0} className={`h-[3px] w-[180px] transition-opacity ${checking ? '' : 'opacity-0'}`} />
      <p className={`text-center text-[13.5px] ${s.awayCheck === 'error' ? 'text-[var(--ws-err)]' : 'text-[var(--ws-label2)]'}`} data-ws-away-line>
        <Crossfade k={checking ? 'checking' : s.awayCheck === 'error' ? 'error' : 'idle'}>{text}</Crossfade>
      </p>
    </div>
  )
}

function SubscribeButton({ href }: { href: string }) {
  const [opening, setOpening] = useState(false)
  useEffect(() => {
    if (!opening) return
    const t = window.setTimeout(() => setOpening(false), 15_000)
    const back = (e: PageTransitionEvent): void => {
      if (e.persisted) setOpening(false)
    }
    window.addEventListener('pageshow', back)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('pageshow', back)
    }
  }, [opening])
  return (
    <a
      href={href}
      target="_top"
      onClick={() => {
        console.info('[web-shell] Subscribe on the away screen, opening monthly checkout')
        setOpening(true)
      }}
      aria-busy={opening}
      className={`ws-press relative flex h-[52px] w-full items-center justify-center overflow-hidden rounded-full bg-[var(--ws-blue)] text-[17px] font-semibold text-white ${opening ? 'pointer-events-none opacity-80' : ''}`}
      data-ws-action="subscribe"
    >
      {opening ? 'Opening checkout' : 'Subscribe for $19 a month'}
      {opening && <ProgressBar value={null} className="absolute inset-x-6 bottom-[7px] h-[2px]" />}
    </a>
  )
}

function AwayScreen({ s }: { s: ShellState }) {
  useAwayChecks()
  const mac = s.hostName || pairedName() || 'your desktop'
  const [pressed, setPressed] = useState(0)
  useEffect(() => {
    if (!pressed) return
    const t = window.setTimeout(() => setPressed(0), AWAY_PRESS_MS)
    return () => window.clearTimeout(t)
  }, [pressed])
  const checking = s.awayCheck === 'checking' || pressed > 0
  const subscribe = accountUrl(SUBSCRIBE_PATH)
  return (
    <Screen
      data="away"
      icon={<Wifi size={46} strokeWidth={1.8} />}
      title={s.wasOnline ? `You're no longer on ${mac}'s network` : `You're away from ${mac}'s network`}
      body={`${s.wasOnline ? "Satura Remote paused because this phone and your desktop aren't on the same network anymore. " : ''}Satura Remote is free on the same Wi-Fi as your desktop. Over the internet it's $19 a month.`}
    >
      {subscribe && <SubscribeButton href={subscribe} />}
      <p className="pt-1 text-center text-[15px] text-[var(--ws-label2)]">or join the same Wi-Fi as your desktop</p>
      <AwayCheckLine s={s} checking={checking} />
      <button
        type="button"
        disabled={checking}
        onClick={() => {
          setPressed(Date.now())
          checkNetwork('Check now on the away screen')
        }}
        className="ws-press h-[44px] w-full text-[16px] font-semibold text-[var(--ws-accent)] transition-opacity disabled:opacity-40"
        data-ws-action="check-again"
      >
        Check now
      </button>
      <p className="px-2 pb-1 text-center text-[12.5px] leading-snug text-[var(--ws-label3)]" data-ws-away-hint>
        Already on it? A VPN or iCloud Private Relay on this phone, or a VPN on the desktop, hides that you share a network. Turn it off for this Wi-Fi.
      </p>
      {otherMacs() > 0 && <Secondary label="Your other desktops" onClick={() => leavePage('/h/all/')} data="all-macs" />}
    </Screen>
  )
}

function StatusLayer() {
  const screen = StatusScreen()
  return <Presence when={screen}>{(node) => node}</Presence>
}

function StatusScreen(): ReactNode {
  const s = useShell()
  const loading = s.fresh === 0 && !['busy', 'replaced', 'signin', 'denied', 'unpaired', 'away'].includes(s.conn)
  const dropped = s.fresh > 0 && (s.conn === 'offline' || s.conn === 'connecting')
  const reconnecting = s.resuming || dropped
  useEffect(() => {
    if (s.resuming && ['busy', 'replaced', 'signin', 'denied', 'unpaired', 'away'].includes(s.conn)) endResume(s.conn)
  }, [s.resuming, s.conn])
  useEffect(() => {
    if (s.fresh === 0 || !useShell.getState().resuming || document.visibilityState !== 'visible') return
    const probe = call('probe') as Promise<boolean> | null
    if (!probe || typeof probe.then !== 'function') return endResume('the desktop sent fresh state')
    void probe.then((ok) => ok && endResume('the desktop sent fresh state and answers'))
  }, [s.fresh])
  if (s.conn === 'busy' || s.conn === 'replaced') {
    const replaced = s.conn === 'replaced'
    return (
      <Screen
        data={s.conn}
        icon={replaced ? <Copy size={46} strokeWidth={1.8} /> : <Smartphone size={46} strokeWidth={1.8} />}
        title={replaced ? 'Satura Remote reconnected' : 'Satura Remote is open on another device'}
        body={replaced ? 'This phone opened a newer connection, so this one closed.' : `${s.detail || 'Satura Remote is already open on another device'}. Only one device can use it at a time. Close Satura Remote there, or wait about 10 seconds if it went offline.`}
      >
        <Actions />
      </Screen>
    )
  }
  if (s.conn === 'signin')
    return (
      <Screen data="signin" icon={<Lock size={46} strokeWidth={1.8} />} title="Sign in to continue" body={s.detail || 'Sign in to use Satura Remote.'}>
        <Primary label="Sign in" onClick={() => goSignIn('Sign in on the sign-in screen', true)} data="signin" />
      </Screen>
    )
  if (s.conn === 'denied')
    return (
      <Screen data="denied" icon={<UserX size={46} strokeWidth={1.8} />} title="Not available on this account" body={`${s.detail || "This account doesn't have Satura Remote yet."}${typeof s.account === 'string' ? ` You're signed in as ${s.account}.` : ''}`}>
        <Primary label="Sign out" onClick={() => void signOutHere()} data="signout" />
        <Secondary label="Try again" onClick={tryAgain} data="retry" />
      </Screen>
    )
  if (s.conn === 'away') return <AwayScreen s={s} />
  if (s.conn === 'unpaired' && (s.verify || s.explain || (!storedPairing() && !pairTextInUrl())))
    return s.detail ? (
      <Screen data={s.verify ? 'verify' : 'unpaired'} icon={<Link2Off size={46} strokeWidth={1.8} />} title={s.verify ? `Couldn't verify ${pairedName() || 'your desktop'}` : s.explain ? "This phone didn't pair" : pairedName() ? `${pairedName()} removed this phone` : "This phone isn't paired"} body={s.detail}>
        <Primary label="Pair again" href="/m/?add=1" data="pair" />
        {otherMacs() > 0 && <Secondary label="Your other desktops" onClick={() => leavePage('/h/all/')} data="all-macs" />}
        <Actions retry={false} pair={false} />
      </Screen>
    ) : (
      <ConnectScreen s={s} data="loading" title={`Connecting to ${pairedName() || 'your desktop'}`} host={false} />
    )
  if (s.conn === 'connecting' && s.allow)
    return (
      <Screen
        data="allow"
        host={false}
        icon={<Smartphone size={46} strokeWidth={1.8} />}
        title="Waiting for you to allow this phone on your desktop"
        body={`Satura on ${s.hostName || 'your desktop'} asks "Allow this phone?" for ${s.allow.device || 'this phone'}. Click Allow there to finish pairing.`}
      >
        <Secondary label="Cancel" onClick={() => location.replace('/m/')} data="allow-cancel" />
      </Screen>
    )
  if (s.fit) return <FitScreen fit={s.fit} />
  if (s.outage) return <OutageScreen s={s as ShellState & { outage: Outage }} />
  if (loading) return <ConnectScreen s={s} data="loading" title={`${s.halted ? 'Not connected to' : 'Connecting to'} ${pairedName() || 'your desktop'}`} host={false} />
  if (reconnecting || s.halted) return <ConnectScreen s={s} data="reconnecting" z={880} title={s.halted ? `Not connected to ${pairedName() || 'your desktop'}` : s.resuming && s.conn === 'online' ? 'Checking connection' : 'Reconnecting'} />
  return null
}

function ToastView() {
  const toast = useShell((s) => s.toast)
  const working = useShell((s) => (s.toast ? null : s.working[s.working.length - 1] ?? null))
  return (
    <>
      <Presence when={toast}>{(t) => <ToastBody t={t} />}</Presence>
      <Presence when={working}>{(w) => <WorkingPill text={w.text} />}</Presence>
    </>
  )
}

function useToastBottom(): number | string {
  const openId = useShell((s) => s.openId)
  const terminal = useShell((s) => s.workspace?.panel?.composer === 'terminal')
  const view = useView()
  return !openId ? view.safe.b + tabBarHeight(view) + 12 : view.landscape ? 16 + view.kb : terminal ? `calc(var(--remote-bottom, 0px) + 12px)` : Math.max(view.safe.b, 16) + 8
}

function WorkingPill({ text }: { text: string }) {
  const bottom = useToastBottom()
  return (
    <div className="pointer-events-none fixed inset-x-0 z-[1390] flex justify-center px-4" style={{ bottom }} data-ws-working={text}>
      <div className="ws-glass-dark ws-rise flex max-w-[520px] items-center gap-2.5 rounded-full py-2.5 pl-3.5 pr-4" role="status" aria-live="polite">
        <span className="ws-spin !h-4 !w-4 shrink-0 !border-2" />
        <span className="truncate text-[13px] leading-snug">{text}</span>
      </div>
    </div>
  )
}

function ToastBody({ t }: { t: NonNullable<ShellState['toast']> }) {
  const bottom = useToastBottom()
  return (
    <div className="pointer-events-none fixed inset-x-0 z-[1400] flex justify-center px-4" style={{ bottom }} data-ws-toast>
      <div key={t.id} className="ws-glass-dark ws-rise pointer-events-auto flex max-w-[520px] items-center gap-2.5 rounded-full py-2.5 pl-4 pr-3">
        {t.icon === 'ok' ? <CircleCheck size={16} strokeWidth={2.4} className="shrink-0 text-[var(--ws-ok)]" /> : <TriangleAlert size={16} strokeWidth={2.4} className="shrink-0 text-[rgb(255_69_60)]" />}
        <span className="line-clamp-2 text-[13px] leading-snug">{t.text}</span>
        {t.retry && (
          <button
            type="button"
            className="shrink-0 rounded-full px-2 py-1 text-[13px] font-semibold text-[var(--ws-accent)]"
            onClick={() => {
              const again = t.retry
              dismissToast()
              again?.()
            }}
            data-ws-toast-retry
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
}

function BannerView() {
  const banner = useShell((s) => s.banner)
  return <Presence when={banner}>{(b) => <BannerBody b={b} />}</Presence>
}

function BannerBody({ b }: { b: NonNullable<ShellState['banner']> }) {
  const view = useView()
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[1350] flex justify-center px-3" style={{ paddingTop: view.safe.t + 8 }} data-ws-banner={b.id}>
      <button type="button" onClick={() => openActivity(b)} className="ws-glass-dark ws-drop pointer-events-auto flex w-full max-w-[520px] items-center gap-3 rounded-[22px] px-4 py-2.5 text-left">
        <StatusDot dot={BANNER_DOT[b.kind] ?? 'work'} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[14px] font-semibold">{b.title}</span>
          {b.body && <span className="truncate text-[12.5px] text-[var(--ws-label2)]">{b.body}</span>}
        </span>
      </button>
    </div>
  )
}

function useStaleWorkspace(): void {
  const openId = useShell((s) => s.openId)
  const fresh = useShell((s) => s.fresh)
  const known = useShell((s) => !s.openId || s.projects.some((p) => p.id === s.openId))
  useEffect(() => {
    if (!openId || !fresh || known) return
    const t = setTimeout(() => {
      const s = useShell.getState()
      if (s.openId && !s.projects.some((p) => p.id === s.openId)) {
        console.info(`[web-shell] workspace ${s.openId} is gone on the Mac, back to projects`)
        closeWorkspace()
      }
    }, 1500)
    return () => clearTimeout(t)
  }, [openId, fresh, known])
}

export function WebShell() {
  const openId = useShell((s) => s.openId)
  useEffect(() => installViewport(), [])
  useStaleWorkspace()
  return (
    <div data-web-shell style={{ display: 'contents' }}>
      {openId ? <WorkspaceChrome /> : <Lists />}
      <BannerView />
      <ToastView />
      <MenuHost />
      <PickerHost />
      <ConfirmHost />
      <PromptHost />
      <SaveSheetHost />
      <StatusLayer />
      <NetDebugPanel />
    </div>
  )
}
