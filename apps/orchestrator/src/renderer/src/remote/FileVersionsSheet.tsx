import { useEffect } from 'react'
import { useFileVersions, decideLater, keepMine, showCompare, takeOther } from '../lib/editor/file-versions-store'
import { versionNames } from '../lib/editor/file-versions'
import { pathBasename } from '../lib/path'
import { versionIcon, versionsMessage } from '../components/ui/FileVersionsDialog'
import { Presence } from './motion'

function Choice({ label, onClick, bold, muted, data }: { label: string; onClick: () => void; bold?: boolean; muted?: boolean; data: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-versions-choice={data}
      className={`block min-h-[50px] w-full border-t border-white/[0.12] px-4 text-[17px] active:bg-white/[0.08] ${bold ? 'font-semibold' : ''}`}
      style={{ color: muted ? 'rgb(235 235 245 / 0.62)' : 'var(--ws-blue, #0a84ff)' }}
    >
      {label}
    </button>
  )
}

export function FileVersionsSheet() {
  const shown = useFileVersions((s) => (s.open ? (s.push[s.open] ?? s.disk[s.open] ?? null) : null))
  return <Presence when={shown}>{(c) => <VersionsDialog c={c} />}</Presence>
}

function VersionsDialog({ c }: { c: NonNullable<ReturnType<typeof useFileVersions.getState>['disk'][string]> }) {

  useEffect(() => {
    const el = document.activeElement
    if (el instanceof HTMLElement) el.blur()
    console.info(`[versions] phone shows the two versions of ${pathBasename(c.file)}`)
  }, [c.file, c.key])

  const names = versionNames('phone', c.kind, c.from, c.by)
  const rows = [
    { side: 'mine' as const, ...names.mine },
    { side: 'theirs' as const, ...names.theirs }
  ]

  return (
    <div
      data-versions-dialog
      className="fixed inset-0 z-[1360] flex items-center justify-center"
      style={{
        paddingTop: 'max(16px, env(safe-area-inset-top))',
        paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
        paddingLeft: 'max(24px, env(safe-area-inset-left))',
        paddingRight: 'max(24px, env(safe-area-inset-right))'
      }}
    >
      <div className="ws-fade-in absolute inset-0 bg-black/50" onClick={() => decideLater(c.file)} />
      <div
        role="alertdialog"
        aria-label="Two different versions"
        className="ws-pop relative flex max-h-full w-full max-w-[340px] flex-col overflow-hidden rounded-[16px] bg-[#2c2c2e]/95 text-center text-[#e5e7eb] shadow-2xl backdrop-blur-xl"
      >
        <div className="min-h-0 overflow-y-auto px-4 pb-3 pt-[18px]">
          <div className="text-[17px] font-semibold leading-snug">There are two different versions</div>
          <div className="mt-0.5 truncate text-[13px] text-[rgb(235_235_245/0.62)]">{pathBasename(c.file)}</div>
          <div data-versions-rows className="mt-3 overflow-hidden rounded-[12px] bg-white/[0.06] text-left">
            {rows.map((r, i) => (
              <div key={r.side} data-versions-row={r.side} className={`flex items-center gap-3 px-3 py-2.5 ${i > 0 ? 'border-t border-white/[0.08]' : ''}`}>
                <span className={`grid size-8 shrink-0 place-items-center rounded-[8px] ${r.side === 'mine' ? 'bg-sky-500/20 text-sky-300' : 'bg-amber-500/20 text-amber-300'}`}>
                  {versionIcon(r.side, c, 'phone', 17)}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-[15px] font-medium leading-snug">{r.label}</span>
                  <span className="text-[12.5px] leading-snug text-[rgb(235_235_245/0.62)]">{r.note}</span>
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2.5 text-[13px] leading-snug text-[rgb(235_235_245/0.62)]">{versionsMessage(c, 'phone')}</div>
        </div>
        <div className="shrink-0">
          <Choice label={names.keep} bold data="keep" onClick={() => void keepMine(c.file)} />
          <Choice label={names.take} data="take" onClick={() => void takeOther(c.file)} />
          <Choice label="Compare" data="compare" onClick={() => showCompare(c.file)} />
          <Choice label="Decide later" muted data="later" onClick={() => decideLater(c.file)} />
        </div>
      </div>
    </div>
  )
}
