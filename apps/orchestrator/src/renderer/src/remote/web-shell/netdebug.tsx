import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { Activity, X } from 'lucide-react'
import { fmtMs, fmtRate, type MacLinkDiag, type PhoneLinkDiag, type VerdictKind } from '@shared/remote-link-diag'
import { useLinkDiag } from '../link-diag'
import { useView } from './viewport'

const KEY = 'satura-remote-netdebug'
const DOT: Record<VerdictKind, string> = { ok: 'ok', network: 'err', app: 'wait', waiting: 'work' }
const subs = new Set<() => void>()
let shown = read()

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function netDebugAllowed(): boolean {
  if (import.meta.env.DEV || shown) return true
  try {
    return new URLSearchParams(location.search).get('netdebug') === '1'
  } catch {
    return false
  }
}

export function setNetDebug(on: boolean): void {
  shown = on
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
  }
  console.info(`[web-shell] network details ${on ? 'shown' : 'hidden'}`)
  for (const s of subs) s()
}

export function useNetDebug(): boolean {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => shown
  )
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`
}

function sourceName(source: string | null | undefined): string {
  if (!source) return 'none'
  return source.startsWith('tuner|') ? 'Tuner scene view' : 'Unity Player'
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 leading-[17px]">
      <span className="w-[86px] shrink-0 text-[var(--ws-label2)]">{k}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-[3px] border-t border-white/[0.08] pt-2">
      <h3 className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--ws-label3)]">{title}</h3>
      {children}
    </section>
  )
}

function Calls({ phone, mac }: { phone: PhoneLinkDiag | null; mac: MacLinkDiag | null }) {
  const c = phone?.calls
  const last = c?.last ?? mac?.calls?.last ?? null
  return (
    <Section title="Calls">
      <Row k="Path">{c ? (c.direct ? 'WebRTC data channel' : 'relay fallback') : '–'}</Row>
      <Row k="Last switch">{last ? `to the ${last.direct ? 'data channel' : 'relay'} ${ago(last.at)}: ${last.why}` : 'none'}</Row>
      <Row k="Switches">{`${c?.switches ?? 0} on the phone, ${mac?.calls?.switches ?? 0} on the desktop, last minute`}</Row>
      <Row k="Round trip">{c ? `${fmtMs(c.callMs)}, p95 ${fmtMs(c.callP95)}` : '–'}</Row>
      <Row k="Unanswered">{c ? `${c.unacked} (oldest ${fmtMs(c.oldestMs)}), resent ${c.resent}` : '–'}</Row>
      <Row k="Relay">{phone ? `${phone.relay.open ? 'open' : 'closed'}, RTT ${fmtMs(phone.relay.rttMs)}` : '–'}</Row>
    </Section>
  )
}

function Rtc({ phone, mac }: { phone: PhoneLinkDiag | null; mac: MacLinkDiag | null }) {
  const r = phone?.rtc
  const p = r?.pair
  return (
    <Section title="WebRTC">
      <Row k="State">{r ? `${r.state}, ICE ${r.ice}` : '–'}</Row>
      <Row k="Pair">{p ? `${p.local} → ${p.remote}, ${p.protocol}${p.relay ? `, TURN over ${p.relay}` : ''}${p.lan ? ', same network' : ''}` : 'none yet'}</Row>
      {p?.server && <Row k="TURN">{p.server}</Row>}
      <Row k="RTT">{`ICE ${fmtMs(r?.rttMs)}, SCTP ${fmtMs(mac?.rtc.rttMs)}, video RTCP ${fmtMs(mac?.video.rttMs)}`}</Row>
      <Row k="Loss">{`${phone?.video.lossPct ?? '–'}% to the phone, ${mac?.video.lossPct ?? '–'}% the desktop hears of`}</Row>
      <Row k="Bitrate">{`in ${fmtRate(r?.inKbps)}${r?.outKbps != null ? `, out up to ${fmtRate(r.outKbps)}` : ''}`}</Row>
    </Section>
  )
}

function Video({ phone, mac }: { phone: PhoneLinkDiag | null; mac: MacLinkDiag | null }) {
  const v = phone?.video
  const m = mac?.video
  return (
    <Section title="Video">
      <Row k="Source">{sourceName(v?.source ?? m?.source)}</Row>
      <Row k="Video track">{`${v?.state ?? '–'} on the phone, ${m?.state ?? '–'} on the desktop, ${m?.pair ?? '–'}`}</Row>
      <Row k="Desktop encoder">{m ? `${m.encoder}, ${m.codec ?? '–'}${m.hardware === null ? '' : m.hardware ? ' hw' : ' sw'}, ${m.width}×${m.height} of ${m.maxSide || 'full'} px, up to ${m.fpsCap} fps${m.limit && m.limit !== 'none' ? `, limited by ${m.limit}` : ''}` : '–'}</Row>
      <Row k="Bitrate">{m ? `target ${fmtRate(m.targetKbps)} of ${fmtRate(m.maxKbps)}, sent ${fmtRate(m.kbps)} (resent ${fmtRate(m.resentKbps)}), estimate ${fmtRate(m.availableKbps)}` : '–'}</Row>
      <Row k="FPS">{`Unity ${m?.sourceFps ?? '–'} → fed ${m?.fedFps ?? '–'} → encoded ${m?.encodedFps ?? '–'} → sent ${m?.fps ?? '–'} → got ${v?.recvFps ?? '–'} → decoded ${v?.decodedFps ?? '–'} → shown ${v?.shownFps ?? '–'}`}</Row>
      <Row k="First frame">{v?.waitMs != null ? `waiting ${fmtMs(v.waitMs)}` : fmtMs(v?.firstFrameMs)}</Row>
      <Row k="Frame age">{`last frame ${fmtMs(v?.frameAgeMs)}, delay to screen ${fmtMs(v?.latencyMs)}, jitter buffer ${fmtMs(v?.jitterMs)}`}</Row>
      <Row k="Recovery">{`${v?.nack ?? 0} NACKs and ${v?.pli ?? 0} keyframe requests from the phone, ${m?.keys ?? 0} keyframes sent`}</Row>
      <Row k="Dropped">{`${v?.dropped ?? 0} frames dropped and ${v?.freezes ?? 0} freezes on the phone, ${v?.failed ?? 0} failed to decrypt`}</Row>
    </Section>
  )
}

function Channels({ mac }: { mac: MacLinkDiag | null }) {
  const rows = (mac?.channels ?? []).filter((c) => c.outKbps || c.inKbps || c.bufferedKb)
  return (
    <Section title="Channels, desktop side">
      {rows.length === 0 ? (
        <Row k="Traffic">idle</Row>
      ) : (
        rows.map((c) => (
          <Row key={c.ch} k={c.ch}>
            {`out ${fmtRate(c.outKbps)}, in ${fmtRate(c.inKbps)}${c.bufferedKb ? `, ${c.bufferedKb} KB queued` : ''}`}
          </Row>
        ))
      )}
    </Section>
  )
}

export function NetDebugPanel() {
  const on = useNetDebug()
  const view = useView()
  const [open, setOpen] = useState(false)
  const diag = useLinkDiag(on)
  if (!on || !diag) return null
  const { verdict, phone, mac } = diag
  return (
    <div className="pointer-events-none fixed z-[1300]" style={{ top: view.safe.t + 6, left: view.safe.l + 8, right: view.safe.r + 8 }} data-ws-netdebug={open ? 'open' : 'closed'}>
      <div className={`ws-glass-dark pointer-events-auto flex max-w-[360px] flex-col rounded-[14px] text-[11.5px] text-[var(--ws-ink)] ${open ? 'max-h-[70vh] w-full' : 'w-fit max-w-full'}`}>
        <div className="flex min-h-[30px] items-center gap-2 pl-3 pr-1">
          <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-h-[30px] min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open} data-ws-netdebug-verdict={verdict.kind}>
            <span className="ws-dot" data-dot={DOT[verdict.kind]} aria-hidden />
            <span className={`min-w-0 font-medium ${open ? '' : 'truncate'}`}>{verdict.text}</span>
          </button>
          {open && (
            <button type="button" aria-label="Hide network details" onClick={() => setNetDebug(false)} className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-[var(--ws-label2)] active:bg-white/[0.08]" data-ws-netdebug-close>
              <X size={15} strokeWidth={2.4} />
            </button>
          )}
        </div>
        {open && (
          <div className="ws-scroll flex flex-col gap-2 overflow-y-auto px-3 pb-3">
            <Calls phone={phone} mac={mac} />
            <Rtc phone={phone} mac={mac} />
            <Video phone={phone} mac={mac} />
            <Channels mac={mac} />
          </div>
        )}
      </div>
    </div>
  )
}

export function NetDebugRow({ icon }: { icon: (children: ReactNode) => ReactNode }) {
  const on = useNetDebug()
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => setNetDebug(!on)} className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left" data-ws-netdebug-switch>
      {icon(<Activity size={16} strokeWidth={2.4} />)}
      <span className="flex-1 text-[16px]">Network details</span>
      <span className="ws-switch" aria-checked={on} />
    </button>
  )
}
