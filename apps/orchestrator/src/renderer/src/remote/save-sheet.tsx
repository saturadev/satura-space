import { Download, Share } from 'lucide-react'
import { Sheet } from './macs-ui'
import { Presence, ProgressBar } from './motion'
import { closeSave, downloadSaved, retrySave, shareSaved, useSaveJob, type SaveJob } from './media-save'

const SHEET_Z = 2147483600
const mb = (n: number): string => (n >= 1e8 ? `${Math.round(n / 1e6)} MB` : `${(n / 1e6).toFixed(1)} MB`)
const ios = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent)

function Body({ j }: { j: SaveJob }) {
  const what = j.ask.kind === 'video' ? 'video' : 'picture'
  const best = j.ask.tag?.q === 'best'
  const line =
    j.state === 'loading'
      ? j.total
        ? `${best ? 'Downloading Best' : 'Downloading'} · ${mb(j.got)} of ${mb(j.total)}`
        : `Asking your desktop for the ${what}`
      : j.state === 'error'
        ? j.error
        : `${mb(j.file?.size ?? j.total)}${best ? ' · Best quality' : ''} · on this phone`
  const primary = j.share ? (ios() ? 'Save to Photos' : 'Share') : 'Download'
  const btn = 'ws-press flex h-[50px] w-full items-center justify-center gap-2 rounded-full text-[17px] font-semibold disabled:opacity-60'
  return (
    <div className="flex flex-col gap-3 px-5 pb-2" data-save-sheet={j.state} data-save-name={j.ask.name} data-save-got={j.got} data-save-total={j.total}>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[16px] font-semibold">{j.ask.name}</span>
        <span className={`text-[14px] leading-snug ${j.state === 'error' ? 'text-[var(--ws-err)]' : 'text-[var(--ws-label2)]'}`} data-save-line>
          {line}
        </span>
      </div>
      {j.state === 'loading' && <ProgressBar value={j.total ? j.got / j.total : null} className="h-[4px] w-full" />}
      {j.state === 'error' ? (
        <button type="button" onClick={retrySave} className={`${btn} bg-[var(--ws-blue)] text-white`} data-save-action="retry">
          Try again
        </button>
      ) : (
        <button type="button" disabled={j.state !== 'ready'} onClick={shareSaved} className={`${btn} bg-[var(--ws-blue)] text-white`} data-save-action={j.share ? 'share' : 'download'}>
          {j.share ? <Share size={18} strokeWidth={2.4} /> : <Download size={18} strokeWidth={2.4} />}
          {j.state === 'sharing' ? 'Opening the share sheet' : j.state === 'loading' ? `${primary} when it's here` : primary}
        </button>
      )}
      {j.share && j.state !== 'loading' && (
        <button type="button" disabled={j.state === 'sharing'} onClick={downloadSaved} className={`${btn} bg-white/[0.09]`} data-save-action="download">
          <Download size={18} strokeWidth={2.4} />
          Download as a file
        </button>
      )}
      <button type="button" onClick={() => closeSave('Cancel tapped')} className="h-[44px] w-full text-[16px] font-semibold text-[var(--ws-accent)]" data-save-action="cancel">
        {j.state === 'loading' ? 'Cancel' : 'Close'}
      </button>
    </div>
  )
}

function SaveSheet({ seen }: { seen: SaveJob }) {
  const live = useSaveJob()
  const j = live ?? seen
  return (
    <Sheet title={j.ask.kind === 'video' ? 'Save video' : 'Save picture'} onClose={() => closeSave('the sheet was dismissed')} data="save" z={SHEET_Z}>
      <Body j={j} />
    </Sheet>
  )
}

export function SaveSheetHost() {
  const job = useSaveJob()
  return <Presence when={job}>{(j) => <SaveSheet seen={j} />}</Presence>
}
