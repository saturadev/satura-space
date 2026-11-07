import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { Ellipsis, Plus } from 'lucide-react'
import './home.css'
import { agoText, listMacs, macLabel, macPath, pairedMacs, setLastPlace, validHostId, type MacRecord } from './macs'
import { Badge, MutedMark, RemoveSheet, RenameSheet, Sheet, SheetButton, ToneDot, statusOf, summaryLines, useMacs, type MacView } from './macs-ui'
import { forgetMacOnPhone } from './mac-forget'
import { DesktopTile } from './desktop-art'
import { Presence, installMotion, leavePage } from './motion'
import { accountReady, goSignIn } from './account'

const POLL_MS = 5000
const FRESH_MS = 2 * 60_000
const HOLD_MS = 480

type Ask = { kind: 'menu' | 'rename' | 'remove'; mac: MacRecord } | null

function enter(v: MacView, why: string): void {
  console.info(`[macs] home: opening ${v.mac.hostId} (${why}, ${statusOf(v).text})`)
  leavePage(macPath(v.mac.hostId), 'desktop card')
}

function MacCard({ v, now, onAsk, i }: { v: MacView; now: number; onAsk: (a: Ask) => void; i: number }) {
  const st = statusOf(v, now)
  const lines = summaryLines(v.mac)
  const stale = v.mac.summary && now - v.mac.summary.at > FRESH_MS
  const hold = useRef(0)
  const held = useRef(false)
  const start = (): void => {
    held.current = false
    window.clearTimeout(hold.current)
    hold.current = window.setTimeout(() => {
      held.current = true
      navigator.vibrate?.(8)
      onAsk({ kind: 'menu', mac: v.mac })
    }, HOLD_MS)
  }
  const stop = (): void => window.clearTimeout(hold.current)
  const latest = v.unread.latest
  return (
    <article
      className={`ws-press ws-item relative overflow-hidden rounded-[24px] bg-[var(--ws-card)] ${v.mac.removed ? '' : 'cursor-pointer'}`}
      style={{ '--i': i } as CSSProperties}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => {
        e.preventDefault()
        onAsk({ kind: 'menu', mac: v.mac })
      }}
      onClick={() => {
        if (held.current || v.mac.removed) return
        enter(v, 'tap')
      }}
      data-tap
      data-mac-card={v.mac.hostId}
      data-mac-state={st.text}
    >
      <div className="flex items-start gap-3.5 px-4 pb-3.5 pt-4">
        <div className="relative">
          <DesktopTile hostId={v.mac.hostId} kind={v.mac.kind} size={58} tone={st.tone} removed={!!v.mac.removed} />
          <span className="absolute -right-1.5 -top-1.5">
            <Badge n={v.unread.count} />
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col pt-0.5">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[19px] font-semibold tracking-[-0.01em]">{macLabel(v.mac)}</span>
            <MutedMark on={v.muted && !v.mac.removed} />
            <button
              type="button"
              aria-label={`More for ${macLabel(v.mac)}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onAsk({ kind: 'menu', mac: v.mac })
              }}
              className="-mr-1.5 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--ws-label2)] active:bg-white/[0.08]"
              data-mac-more={v.mac.hostId}
            >
              <Ellipsis size={20} strokeWidth={2.4} />
            </button>
          </div>
          <span className="flex items-center gap-1.5 text-[14px]" style={{ color: st.tone === 'ok' ? 'var(--ws-ok)' : st.tone === 'wait' ? 'var(--ws-warn)' : st.tone === 'err' ? 'var(--ws-err)' : 'var(--ws-label2)' }} data-mac-status={v.mac.hostId}>
            <ToneDot tone={st.tone} />
            {st.text}
          </span>
        </div>
      </div>
      {v.mac.removed ? (
        <div className="px-4 pb-4">
          <p className="text-[14px] leading-snug text-[var(--ws-label2)]">{v.mac.removed.why || 'Pair this phone again with a new code from that desktop.'}</p>
          <div className="mt-3 flex gap-2">
            <a
              href="/m/?add=1"
              onClick={(e) => {
                e.stopPropagation()
                e.preventDefault()
                leavePage('/m/?add=1', 'pair again')
              }}
              className="ws-press flex h-9 items-center rounded-full bg-[var(--ws-blue)] px-4 text-[14.5px] font-semibold text-white"
              data-mac-repair={v.mac.hostId}
            >
              Pair again
            </a>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onAsk({ kind: 'remove', mac: v.mac })
              }}
              className="ws-press h-9 rounded-full bg-white/[0.09] px-4 text-[14.5px] font-semibold"
              data-mac-forget={v.mac.hostId}
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        (lines.length > 0 || latest) && (
          <div className="flex flex-col gap-1 border-t border-white/[0.07] px-4 pb-3.5 pt-3">
            {latest && (
              <div className="mb-1 flex items-baseline gap-2 rounded-[14px] bg-white/[0.06] px-3 py-2" data-mac-latest={v.mac.hostId}>
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{latest.title}</span>
                <span className="shrink-0 text-[12.5px] text-[var(--ws-label3)]">{agoText(latest.at, now)}</span>
              </div>
            )}
            {lines.map((l) => (
              <span key={l} className="truncate text-[14px] text-[var(--ws-label2)]">
                {l}
              </span>
            ))}
            {stale && lines.length > 0 && <span className="pt-0.5 text-[12.5px] text-[var(--ws-label3)]">From your last visit, {agoText(v.mac.summary!.at, now)}</span>}
          </div>
        )
      )}
    </article>
  )
}

function AddCard({ only }: { only: boolean }) {
  return (
    <a href="/m/?add=1" className="ws-press flex min-h-[64px] items-center gap-3.5 rounded-[24px] border border-dashed border-white/[0.16] px-4 py-3 text-left" data-mac-add>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[rgb(10_132_255/0.16)] text-[var(--ws-blue)]">
        <Plus size={22} strokeWidth={2.4} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[16.5px] font-semibold text-[var(--ws-blue)]">Pair another desktop</span>
        <span className="text-[13.5px] text-[var(--ws-label2)]">{only ? 'Keep every desktop you work on in one place.' : 'Scan the code in Satura on that desktop.'}</span>
      </span>
    </a>
  )
}

function MenuSheet({ mac, onClose, onAsk }: { mac: MacRecord; onClose: () => void; onAsk: (a: Ask) => void }) {
  return (
    <Sheet title={macLabel(mac)} onClose={onClose} data="menu">
      <div className="mx-4 overflow-hidden rounded-[14px] bg-white/[0.06] [&>*+*]:border-t [&>*+*]:border-white/[0.07]">
        {!mac.removed && <SheetButton label="Open" onClick={() => leavePage(macPath(mac.hostId))} data="open" />}
        {!mac.removed && <SheetButton label="Notifications" onClick={() => leavePage(`${macPath(mac.hostId)}?tab=settings`)} data="notifications" />}
        <SheetButton label="Name on this phone" onClick={() => onAsk({ kind: 'rename', mac })} data="rename" />
        <SheetButton label="Remove from this phone" tone="danger" onClick={() => onAsk({ kind: 'remove', mac })} data="remove" />
      </div>
    </Sheet>
  )
}

function Home() {
  const { views, refresh } = useMacs(POLL_MS)
  const [now, setNow] = useState(Date.now())
  const [ask, setAsk] = useState<Ask>(null)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  useEffect(() => {
    if (!views.length) {
      console.info('[macs] home: no Macs on this phone, opening pairing')
      location.replace('/m/')
    }
  }, [views.length])
  useEffect(() => {
    console.info(`[macs] home: ${views.map((v) => `${v.mac.hostId}=${statusOf(v).text}${v.unread.count ? ` (${v.unread.count} unread)` : ''}`).join(', ')}`)
  }, [views.map((v) => `${v.mac.hostId}${statusOf(v).text}${v.unread.count}`).join()])
  const paired = views.filter((v) => !v.mac.removed).length
  const close = (): void => {
    setAsk(null)
    refresh()
  }
  return (
    <div data-web-shell className="ws-scroll fixed inset-0 bg-black" style={{ paddingTop: 'env(safe-area-inset-top)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }} data-mac-home>
      <div className="mx-auto w-full max-w-[640px]" style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}>
        <div className="flex h-[48px] items-center justify-end px-3">
          <a href="/m/?add=1" aria-label="Pair another desktop" className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--ws-blue)] active:bg-white/[0.08]" data-mac-add-top>
            <Plus size={26} strokeWidth={2.2} />
          </a>
        </div>
        <h1 className="px-5 text-[34px] font-bold tracking-tight">Your desktops</h1>
        <p className="px-5 pb-4 pt-0.5 text-[15px] text-[var(--ws-label2)]" data-mac-count={paired}>
          {paired === 0 ? 'No desktop uses this phone right now.' : paired === 1 ? 'This phone is paired with one desktop.' : `This phone is paired with ${paired} desktops.`}
        </p>
        <div className="flex flex-col gap-3 px-4">
          {views.map((v, i) => (
            <MacCard key={v.mac.hostId} v={v} now={now} onAsk={setAsk} i={i} />
          ))}
          <AddCard only={paired <= 1} />
        </div>
        <p className="px-5 pt-5 text-[13px] leading-snug text-[var(--ws-label3)]">
          Each desktop has its own key on this phone, and nothing from one desktop reaches another. What runs on a desktop is from your last visit to it.
        </p>
      </div>
      <Presence when={ask}>
        {(a) =>
          a.kind === 'menu' ? (
            <MenuSheet key="menu" mac={a.mac} onClose={close} onAsk={setAsk} />
          ) : a.kind === 'rename' ? (
            <RenameSheet key="rename" mac={a.mac} onClose={close} />
          ) : (
            <RemoveSheet key="remove" mac={a.mac} onClose={close} onRemove={() => forgetMacOnPhone(a.mac.hostId, 'removed on the home')} />
          )
        }
      </Presence>
    </div>
  )
}

setLastPlace('all')
void accountReady('the desktops home opened').then(({ config, ticket }) => {
  if (config?.account && !ticket) goSignIn('this phone has no ticket for the relay')
})
navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
  const m = (e.data ?? {}) as { t?: string; host?: unknown }
  if ((m.t === 'push-go' || m.t === 'push-open') && validHostId(m.host)) {
    console.info(`[macs] home: a notification from ${m.host} was tapped, opening that Mac`)
    location.replace(macPath(m.host))
  }
})
;(window as unknown as { __saturaMacs?: unknown }).__saturaMacs = { list: listMacs, paired: pairedMacs }
console.info(`[macs] home loaded with ${listMacs().length} Mac(s): ${listMacs().map((m) => `${m.hostId}${m.removed ? ' (removed)' : ''}`).join(', ') || 'none'}`)
installMotion()
createRoot(document.getElementById('root')!).render(<Home />)
