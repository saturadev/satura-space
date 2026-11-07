import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RemoteAccountUsage, RemoteAllowance, RemotePairInfo, RemotePairedPhone, RemotePlace, RemoteStatus, RemoteUsageRow } from '@shared/remote-protocol'
import { formatSize } from '@shared/file-picker'
import { qrMatrix, qrSvgPath } from '../../lib/qr'
import { relativeTimeLong } from '../../lib/relative-time'
import { requestConfirm } from '../../lib/confirm/confirm-store'

function useRemoteStatus(): RemoteStatus | null {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.remote.status().then((s) => alive && setStatus(s))
    const off = window.api.remote.onPhones((s) => setStatus(s))
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}

async function waitForRelay(ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const s = await window.api.remote.status()
    if (s.connected) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

function usePairedPhones(): [RemotePairedPhone[] | null, (list: RemotePairedPhone[]) => void] {
  const [list, setList] = useState<RemotePairedPhone[] | null>(null)
  useEffect(() => {
    let alive = true
    window.api.remote.pairedPhones().then(
      (l) => alive && setList(l),
      (e) => console.warn(`[remote] paired phones: ${(e as Error).message}`)
    )
    const off = window.api.remote.onPairedPhones((l) => setList(l))
    return () => {
      alive = false
      off()
    }
  }, [])
  return [list, setList]
}

function useTick(ms: number, active: boolean): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setTick((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [ms, active])
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' })
  } catch {
    return null
  }
})()

function countryName(code: string | undefined): string {
  if (!code) return ''
  try {
    return regionNames?.of(code) ?? code
  } catch {
    return code
  }
}

function placeLine(p: RemotePlace | null): string {
  if (!p) return ''
  const where = [p.city || p.region, countryName(p.country)].filter(Boolean).join(', ')
  return [where, p.ip].filter(Boolean).join(' · ')
}

function pairedDay(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function PhoneRow({ phone, onRemove, busy }: { phone: RemotePairedPhone; onRemove: () => void; busy: boolean }) {
  const last = placeLine(phone.lastFrom)
  const from = placeLine(phone.pairedFrom)
  const warnings = [
    phone.newCountry ? `Connected from ${countryName(phone.lastFrom?.country)}, but paired from ${countryName(phone.pairedFrom?.country)}` : '',
    phone.accountChanged ? `Paired as ${phone.pairedEmail}, now signs in as ${phone.email}` : '',
    phone.otherAccount ? 'Signed in with a different account than other phones on this computer' : ''
  ].filter(Boolean)
  return (
    <li className="flex items-start gap-3 px-2.5 py-2" data-paired-phone={phone.phoneId} data-paired-phone-online={phone.online > 0 ? 'yes' : 'no'}>
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${phone.online > 0 ? 'bg-ok' : 'bg-ink-4'}`} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-baseline gap-2">
          <p className="truncate text-sm text-ink" data-paired-phone-device>
            {phone.device}
          </p>
          {phone.uaShort && (
            <span className="truncate text-xs text-ink-3" title={phone.ua} data-paired-phone-ua>
              {phone.uaShort}
            </span>
          )}
          <span className={`ml-auto shrink-0 text-xs ${phone.online > 0 ? 'text-ok' : 'text-ink-3'}`} data-paired-phone-seen>
            {phone.online > 0 ? 'Online now' : phone.lastSeenAt ? `Last seen ${relativeTimeLong(phone.lastSeenAt)}` : 'Not seen since pairing'}
          </span>
        </div>
        <p className={`truncate text-xs ${phone.otherAccount || phone.accountChanged ? 'text-warn' : 'text-ink-2'}`} data-paired-phone-email>
          {phone.email ?? 'No account email'}
        </p>
        {last && (
          <p className={`truncate text-xs ${phone.newCountry ? 'text-warn' : 'text-ink-3'}`} data-paired-phone-last>
            {last}
          </p>
        )}
        <p className="truncate text-xs text-ink-3" data-paired-phone-paired>
          Paired {pairedDay(phone.pairedAt)}
          {from ? ` from ${from}` : ''}
        </p>
        {warnings.map((w) => (
          <p key={w} className="text-xs text-warn" data-paired-phone-warning>
            {w}
          </p>
        ))}
      </div>
      <button
        onClick={onRemove}
        disabled={busy}
        data-paired-phone-remove
        aria-label={`Remove ${phone.device}`}
        className="shrink-0 rounded-md px-2.5 py-1 text-xs text-ink-3 hover:bg-white/10 hover:text-err disabled:opacity-40"
      >
        Remove
      </button>
    </li>
  )
}

function PairedPhones() {
  const [list, setList] = usePairedPhones()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useTick(30_000, !!list?.length)
  if (!list || list.length === 0) return null

  const run = async (ask: Parameters<typeof requestConfirm>[0], act: () => ReturnType<typeof window.api.remote.forgetAllPhones>): Promise<void> => {
    if (busy || !(await requestConfirm({ ...ask, desktopOnly: true }))) return
    setBusy(true)
    setError(null)
    try {
      setList((await act()).phones)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = (p: RemotePairedPhone): Promise<void> =>
    run(
      {
        title: `Remove ${p.device}?`,
        message: `${p.device}${p.email ? ` (${p.email})` : ''} disconnects now and can't connect to this computer again until it pairs with a new code.`,
        confirmLabel: 'Remove phone'
      },
      () => window.api.remote.forgetPhone(p.phoneId)
    )

  const removeAll = (): Promise<void> =>
    run(
      {
        title: 'Remove all phones?',
        message:
          list.length === 1
            ? `${list[0].device} disconnects now and can't connect to this computer again until it pairs with a new code.`
            : `All ${list.length} paired phones disconnect now and can't connect to this computer again until each pairs with a new code.`,
        confirmLabel: 'Remove all'
      },
      () => window.api.remote.forgetAllPhones()
    )

  return (
    <div className="space-y-2" data-paired-phones={list.length}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-ink">Paired phones</p>
        <button
          onClick={() => void removeAll()}
          disabled={busy}
          data-paired-phones-remove-all
          className="shrink-0 rounded-md px-2.5 py-1 text-xs text-ink-3 hover:bg-white/10 hover:text-err disabled:opacity-40"
        >
          Remove all phones
        </button>
      </div>
      <p className="text-xs text-ink-3">These phones can connect to this computer. Remove any you don't recognize: it disconnects at once and has to pair again with a new code.</p>
      <ul className="divide-y divide-white/10 rounded border border-white/10 bg-sunken">
        {list.map((p) => (
          <PhoneRow key={p.phoneId} phone={p} busy={busy} onRemove={() => void remove(p)} />
        ))}
      </ul>
      {error && <p className="text-xs text-err">{error}</p>}
    </div>
  )
}

function DesktopKeys({ onNewKeys }: { onNewKeys: () => void }) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const renew = async (): Promise<void> => {
    if (busy) return
    const ok = await requestConfirm({
      title: 'Make new keys for this computer?',
      message:
        "Phones trust this computer by its Satura Remote keys. New keys give it a new id, every paired phone disconnects at once and has to pair again with a new code. Do this if you think the keys got out, for example with a lost backup or a phone you no longer have.",
      confirmLabel: 'Make new keys',
      danger: true,
      desktopOnly: true,
      clickOnly: true
    })
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await window.api.remote.newKeys()
      onNewKeys()
      setDone(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-3 border-t border-white/10 pt-3" data-remote-keys={done ? 'new' : 'kept'}>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">Keys of this computer</p>
        <p className="text-xs text-ink-3">{done ? 'New keys are in place. Pair your phones again.' : 'Phones trust this computer by these keys. New keys unpair every phone.'}</p>
        {error && <p className="text-xs text-err">{error}</p>}
      </div>
      <button
        onClick={() => void renew()}
        disabled={busy}
        data-remote-new-keys
        className="shrink-0 rounded-md px-2.5 py-1 text-xs text-ink-3 hover:bg-white/10 hover:text-err disabled:opacity-40"
      >
        Make new keys
      </button>
    </div>
  )
}

function PairQr({ link }: { link: string }) {
  const { path, size } = useMemo(() => qrSvgPath(qrMatrix(link), 3), [link])
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="h-[208px] w-[208px] shrink-0 rounded-lg bg-white"
      data-pair-qr={link}
      role="img"
      aria-label="Pairing QR code"
    >
      <path d={path} fill="#0c0d0f" />
    </svg>
  )
}

const HIDDEN_USAGE = new Set(['no-auth', 'off', 'no-accounts'])

function resetDay(a: RemoteAllowance): string {
  return new Date(a.resetAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(a.anchor === 'utc-month' ? { timeZone: 'UTC' } : {}) })
}

function AllowanceBar({ a }: { a: RemoteAllowance }) {
  const used = Math.min(100, Math.max(0, a.usedPercent))
  const color = a.overQuota ? 'bg-err' : used >= 80 ? 'bg-warn' : 'bg-ok'
  return (
    <div className="space-y-1" data-mobile-allowance={a.overQuota ? 'over' : 'ok'}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-ink-2">
          {formatSize(a.usedBytes)} of {formatSize(a.allowanceBytes)} used
        </span>
        <span className={a.overQuota ? 'text-err' : 'text-ink-3'} data-mobile-allowance-left>
          {a.overQuota ? (a.blocked ? 'Monthly limit reached, video is paused' : 'Monthly limit reached') : `${formatSize(a.remainingBytes)} left`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-label={`${used}% of this month's limit used`}>
        <div className={`h-full rounded-full ${color}`} style={{ width: `${used}%` }} />
      </div>
      <p className="text-xs text-ink-3" data-mobile-allowance-reset>
        Resets on {resetDay(a)}.
      </p>
    </div>
  )
}

function metered(r: RemoteUsageRow): number {
  return Math.max(r.cfEgress, r.turnEgress) + r.wsIn + r.wsOut + r.web
}

const SAME_NETWORK_NOTE = "When your phone and this computer are on the same network, video goes straight between them and doesn't count toward your monthly limit."
const FREE_NOTE = 'Free while your phone is on the same Wi-Fi as this computer. Away from it, Satura Remote needs a subscription, $19 a month.'

function TrafficUsage({ enabled }: { enabled: boolean }) {
  const [usage, setUsage] = useState<RemoteAccountUsage | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      setUsage(await window.api.remote.usage())
    } catch (e) {
      setUsage(null)
      console.warn(`[remote] traffic: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [])
  useEffect(() => {
    if (enabled) void load()
  }, [enabled, load])
  useEffect(() => window.api.auth.onSignedIn(() => void load()), [load])
  if (!enabled || !usage || HIDDEN_USAGE.has(usage.state)) return null
  const used = usage.thisMonth ? metered(usage.thisMonth) : null
  return (
    <div className="space-y-2 rounded border border-white/10 bg-sunken px-2.5 py-2" data-mobile-usage={usage.state}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink">Used this month</p>
          <p className="truncate text-xs text-ink-3" data-mobile-usage-account>
            {usage.state === 'ok' ? (usage.account ?? '') : usage.detail}
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={busy}
          data-mobile-usage-refresh
          className="shrink-0 rounded-md px-2.5 py-1 text-xs text-ink-3 hover:bg-white/10 hover:text-ink disabled:opacity-40"
        >
          {busy ? 'Checking' : 'Refresh'}
        </button>
      </div>
      {usage.state === 'ok' &&
        (usage.allowance ? (
          <AllowanceBar a={usage.allowance} />
        ) : (
          <p className="text-xs text-ink-2" data-mobile-usage-total>
            {used === null ? 'Nothing used yet.' : `${formatSize(used)} used`}
          </p>
        ))}
      {usage.state === 'ok' && (
        <p className="text-xs text-ink-3" data-mobile-usage-note={usage.access ?? 'any'}>
          {usage.access === 'local' ? FREE_NOTE : SAME_NETWORK_NOTE}
        </p>
      )}
    </div>
  )
}

export function MobileSection() {
  const status = useRemoteStatus()
  const [pair, setPair] = useState<RemotePairInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pairedAtStart, setPairedAtStart] = useState<number | null>(null)
  const now = useNow(!!pair)
  const left = pair ? Math.max(0, Math.round((pair.expiresAt - now) / 1000)) : 0
  const expired = !!pair && left === 0
  const [pairedNow, setPairedNow] = useState(false)
  const newlyPaired = !!pair && pairedAtStart !== null && (status?.paired ?? 0) > pairedAtStart

  useEffect(() => {
    if (!newlyPaired) return
    setPair(null)
    setPairedNow(true)
  }, [newlyPaired])

  const start = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    setPairedNow(false)
    try {
      if (!status?.enabled) {
        await window.api.remote.setEnabled(true)
        await waitForRelay(10_000)
      }
      const info = await window.api.remote.pairInfo()
      if (!info) setError("Satura Remote is unavailable right now, so Satura can't make a code. Try again in a moment.")
      setPairedAtStart(status?.paired ?? 0)
      setPair(info)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const turnOff = async (): Promise<void> => {
    setPair(null)
    setPairedNow(false)
    setError(null)
    await window.api.remote.setEnabled(false)
  }

  const enabled = !!status?.enabled
  const online = !!status?.connected
  const phones = status?.phones ?? 0
  const paired = status?.paired ?? 0
  const webHost = status?.phoneRelay?.replace(/^https?:\/\//, '') ?? ''

  return (
    <section className="space-y-4" data-settings-mobile>
      <div className="space-y-1">
        <label className="text-sm font-semibold text-ink">Satura Remote</label>
        <p className="text-xs text-ink-3" data-mobile-intro>
          Watch and drive your agents from your phone. Satura Remote runs in your phone's browser
          {webHost ? ` at ${webHost}` : ''}. Add it to the Home Screen and it opens like an app. It's free when the phone is on the
          same Wi-Fi as this computer; over the internet it needs a subscription.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded border border-white/10 bg-sunken px-2.5 py-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${online ? 'bg-ok' : 'bg-ink-4'}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink">{!status ? 'Checking the connection' : !enabled ? 'Satura Remote is off' : online ? 'Connected' : status.url ? 'Connecting' : 'Satura Remote is off'}</p>
          <p className="truncate text-xs text-ink-3" data-mobile-relay>
            {!status ? '' : !enabled ? 'This computer connects to Satura Remote after you pair a phone.' : webHost || ''}
          </p>
        </div>
        <p className="shrink-0 text-xs text-ink-3" data-mobile-phones={phones}>
          {phones > 0 ? `${phones} phone${phones === 1 ? '' : 's'} online` : paired > 0 ? `${paired} paired` : 'No phones yet'}
        </p>
      </div>

      {enabled && status?.phoneApp?.status === 'mismatch' && (
        <p className="text-xs text-err" data-mobile-phone-app="mismatch" title={[status.phoneApp.detail, ...status.phoneApp.problems].join('\n')}>
          The phone app at {status.phoneApp.web.replace(/^https?:\/\//, '')} doesn't match its public build on GitHub. Don't open Satura Remote on your phone until this clears.
        </p>
      )}

      <PairedPhones />

      <TrafficUsage enabled={enabled} />

      {pairedNow && <p className="text-xs text-ok">Your phone is paired.</p>}

      {pair && !expired ? (
        <div className="flex gap-5 rounded border border-white/10 bg-sunken p-4">
          <PairQr link={pair.link} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p className="text-sm font-medium text-ink">Scan with your phone</p>
            <ol className="list-decimal space-y-1 pl-4 text-xs text-ink-2">
              <li>Open {webHost || 'Satura Remote'} on your phone and sign in.</li>
              <li>Tap Scan code and point the camera here.</li>
              <li>Allow the phone here when Satura asks.</li>
            </ol>
            <p className="text-xs text-ink-3">The Camera app can scan it too and opens Satura Remote with the code filled in.</p>
            <p className="mt-1 text-xs text-ink-3">Or type this code on the phone:</p>
            <code className="select-text rounded bg-black/30 px-2 py-1 font-mono text-[13px] text-ink" data-pair-code>
              {pair.code}
            </code>
            <p className="text-xs text-ink-3">
              Works once, for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} more.
            </p>
            <div className="mt-auto flex gap-2">
              <button
                onClick={() => setPair(null)}
                className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-ink-2 hover:bg-white/10 hover:text-ink"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <button
            onClick={() => void start()}
            disabled={busy || (enabled && !online)}
            data-pair-phone
            className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-ink-2 hover:bg-white/10 hover:text-ink disabled:opacity-40"
          >
            {expired ? 'Make a new code' : 'Pair a phone'}
          </button>
          {expired && <span className="text-xs text-ink-3">That code expired.</span>}
          {enabled && (
            <button
              onClick={() => void turnOff()}
              data-remote-off
              className="rounded-md px-2.5 py-1 text-xs text-ink-3 hover:bg-white/10 hover:text-ink"
            >
              Turn off
            </button>
          )}
        </div>
      )}
      {error && <p className="text-xs text-err">{error}</p>}
      <DesktopKeys
        onNewKeys={() => {
          setPair(null)
          setPairedNow(false)
        }}
      />
    </section>
  )
}
