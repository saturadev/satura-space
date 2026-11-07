import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Database, Film, Image as Picture, Laptop, Trash2, Type } from 'lucide-react'
import { onHeldChange } from '../../lib/media-loader'
import { clearMedia, mediaUsage, type MediaShelf, type MediaUsage } from '../media-cache'
import { clearTunerFontCache, tunerFontCache } from '../tuner/platform'
import { ProgressBar } from '../motion'
import { Group, RowIcon } from './group'

type Busy = { key: string; done: number; total: number }

interface Usage extends MediaUsage {
  fonts: { bytes: number; files: number }
  app: { bytes: number; stores: number }
}

const VIDEO_ROWS: [MediaShelf, string][] = [
  ['best', 'Best quality'],
  ['1080', '1080p'],
  ['720', '720p'],
  ['480', '480p'],
  ['phone', 'Phone versions'],
  ['videos', 'Other videos']
]
const VIDEOS = VIDEO_ROWS.map(([k]) => k)
const PICTURES: MediaShelf[] = ['images', 'other']
const ELSEWHERE: MediaShelf[] = ['elsewhere', 'extra']
const ALL: MediaShelf[] = [...VIDEOS, ...PICTURES, ...ELSEWHERE]

const sizeText = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e7 ? `${Math.round(n / 1e6)} MB` : n >= 1e5 ? `${(n / 1e6).toFixed(1)} MB` : n > 0 ? `${Math.max(1, Math.round(n / 1024))} KB` : 'None')
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).trim() || 'It stopped.'
const FONT_DB = 'satura-tuner-fonts'

function sizeOf(v: unknown, depth = 0): number {
  if (v == null || depth > 8) return 0
  if (typeof v === 'string') return v.length * 2
  if (typeof v === 'number' || typeof v === 'boolean') return 8
  if (v instanceof ArrayBuffer) return v.byteLength
  if (ArrayBuffer.isView(v)) return v.byteLength
  if (v instanceof Blob) return v.size
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + sizeOf(x, depth + 1), 0)
  if (typeof v === 'object') return Object.entries(v).reduce((n, [k, x]) => n + k.length * 2 + sizeOf(x, depth + 1), 0) || 64
  return 0
}

function dbBytes(name: string): Promise<number> {
  return new Promise((resolve) => {
    const req = indexedDB.open(name)
    req.onerror = () => resolve(0)
    req.onsuccess = () => {
      const db = req.result
      const stores = [...db.objectStoreNames]
      if (!stores.length) {
        db.close()
        return resolve(0)
      }
      let bytes = 0
      const tx = db.transaction(stores, 'readonly')
      for (const name of stores) {
        const cur = tx.objectStore(name).openCursor()
        cur.onsuccess = () => {
          const c = cur.result
          if (!c) return
          bytes += sizeOf(c.key) + sizeOf(c.value)
          c.continue()
        }
      }
      tx.oncomplete = tx.onerror = tx.onabort = () => {
        db.close()
        resolve(bytes)
      }
    }
  })
}

async function appData(): Promise<{ bytes: number; stores: number }> {
  let bytes = 0
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? ''
      bytes += (k.length + (localStorage.getItem(k)?.length ?? 0)) * 2
    }
  } catch {
  }
  const list = await (indexedDB as IDBFactory & { databases?: () => Promise<IDBDatabaseInfo[]> }).databases?.().catch(() => null)
  const names = (list ?? []).map((d) => d.name ?? '').filter((n) => n && n !== FONT_DB)
  for (const n of names) bytes += await dbBytes(n)
  return { bytes, stores: names.length + 1 }
}

async function measureAll(): Promise<Usage> {
  const [media, fonts, app] = await Promise.all([mediaUsage(), tunerFontCache().catch(() => ({ bytes: 0, files: 0 })), appData()])
  console.info(`[storage] this phone: report media ${sizeText(media.media)}, Tuner fonts ${sizeText(fonts.bytes)} (${fonts.files}), keys and settings ${sizeText(app.bytes)} in localStorage and ${app.stores - 1} IndexedDB database${app.stores === 2 ? '' : 's'}; the browser counts ${media.usage == null ? 'nothing' : sizeText(media.usage)}`)
  return { ...media, fonts, app }
}

function sum(u: Usage | null, shelves: MediaShelf[]): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  for (const k of shelves) {
    bytes += u?.shelves[k].bytes ?? 0
    files += u?.shelves[k].files ?? 0
  }
  return { bytes, files }
}

function Row({ id, icon, label, sub, bytes, files, busy, failed, onDelete, locked, inner }: { id: string; icon?: ReactNode; label: string; sub?: string; bytes: number; files?: number; busy?: Busy | null; failed?: string; onDelete?: () => void; locked: boolean; inner?: boolean }) {
  const mine = busy?.key === id
  return (
    <div className={`flex min-h-[48px] items-center gap-3 py-2 pr-3 ${inner ? 'pl-[58px]' : 'pl-4'}`} data-ws-storage={id} data-bytes={bytes} data-files={files ?? 0} data-busy={mine ? '' : undefined}>
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={inner ? 'text-[15px]' : 'text-[16px]'}>{label}</span>
        {sub && <span className="truncate text-[13px] text-[var(--ws-label2)]">{sub}</span>}
        {mine && <ProgressBar value={busy && busy.total ? busy.done / busy.total : null} className="mt-1.5 h-[3px] w-full" />}
        {failed && (
          <span className="text-[13px] leading-snug text-[var(--ws-err)]" data-ws-storage-error>
            {failed}
          </span>
        )}
      </span>
      <span className="shrink-0 text-[15px] tabular-nums text-[var(--ws-label2)]" data-ws-storage-size>
        {sizeText(bytes)}
      </span>
      {onDelete && bytes > 0 && (
        <button type="button" disabled={locked} onClick={onDelete} className="ws-press shrink-0 rounded-full bg-white/[0.09] px-3 py-1.5 text-[14px] font-semibold text-[var(--ws-err)] disabled:opacity-50" data-ws-storage-delete={id}>
          {mine ? 'Deleting' : failed ? 'Try again' : 'Delete'}
        </button>
      )}
    </div>
  )
}

export function StorageGroup() {
  const [u, setU] = useState<Usage | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<Busy | null>(null)
  const [failed, setFailed] = useState<{ key: string; text: string } | null>(null)
  const measuring = useRef(false)
  const measure = useCallback(() => {
    if (measuring.current) return
    measuring.current = true
    measureAll()
      .then(
        (x) => {
          setU(x)
          setError('')
        },
        (e: unknown) => setError(`Couldn't measure what Satura Remote keeps here. ${message(e)}`)
      )
      .finally(() => {
        measuring.current = false
      })
  }, [])
  useEffect(() => {
    measure()
    let t = 0
    const off = onHeldChange(() => {
      window.clearTimeout(t)
      t = window.setTimeout(measure, 800)
    })
    return () => {
      off()
      window.clearTimeout(t)
    }
  }, [measure])
  const del = (key: string, shelves: MediaShelf[], what: string, fonts = false): void => {
    if (busy) return
    const had = sum(u, shelves)
    console.info(`[storage] Delete ${what} tapped (${sizeText(had.bytes + (fonts ? (u?.fonts.bytes ?? 0) : 0))} in ${had.files + (fonts ? (u?.fonts.files ?? 0) : 0)} files)`)
    setFailed(null)
    setBusy({ key, done: 0, total: 0 })
    Promise.all([shelves.length ? clearMedia(shelves, (done, total) => setBusy({ key, done, total })) : Promise.resolve({ files: 0, bytes: 0 }), fonts ? clearTunerFontCache() : Promise.resolve()])
      .then(async ([r]) => {
        const next = await measureAll()
        setU(next)
        console.info(`[storage] deleted ${what}: ${r.files} media files, ${sizeText(r.bytes)}${fonts ? ', Tuner fonts' : ''}; report media on this phone ${sizeText(sum(u, ALL).bytes)} -> ${sizeText(sum(next, ALL).bytes)}, Tuner fonts ${sizeText(u?.fonts.bytes ?? 0)} -> ${sizeText(next.fonts.bytes)}`)
      })
      .catch((e: unknown) => {
        console.warn(`[storage] couldn't delete ${what}: ${message(e)}`)
        setFailed({ key, text: `Couldn't delete ${what}. ${message(e)}` })
      })
      .finally(() => setBusy(null))
  }
  const videos = sum(u, VIDEOS)
  const pictures = sum(u, PICTURES)
  const elsewhere = sum(u, ELSEWHERE)
  const all = sum(u, ALL)
  const fonts = u?.fonts ?? { bytes: 0, files: 0 }
  const locked = !!busy
  const err = (key: string): string | undefined => (failed?.key === key ? failed.text : undefined)
  const footer = u
    ? `${u.usage != null ? `The browser counts ${sizeText(u.usage)} for Satura Remote on this phone${u.quota ? ` of the ${sizeText(u.quota)} it allows` : ''} and updates that count on its own schedule. ` : ''}Videos and pictures from reports stay here after you open them, so they play without waiting. Deleting them is safe: they download again when you open them.${u.keeps === false ? ` This browser doesn't keep them between visits; ${sizeText(u.memory)} is in memory now.` : ''}`
    : undefined
  return (
    <Group title="Storage on this phone" footer={footer}>
      {!u ? (
        <div className="flex min-h-[48px] flex-col justify-center gap-1.5 px-4 py-2" data-ws-storage="measuring">
          <span className={`text-[15px] ${error ? 'text-[var(--ws-err)]' : 'text-[var(--ws-label2)]'}`}>{error || 'Measuring what Satura Remote keeps here'}</span>
          {error ? (
            <button type="button" onClick={measure} className="self-start text-[15px] font-semibold text-[var(--ws-accent)]">
              Try again
            </button>
          ) : (
            <ProgressBar value={null} className="h-[3px] w-full" />
          )}
        </div>
      ) : (
        <>
          <Row id="videos" icon={<RowIcon color="rgb(191 90 242)"><Film size={15} strokeWidth={2.4} /></RowIcon>} label="Report videos" sub={videos.files ? count(videos.files, 'video', 'videos') : undefined} bytes={videos.bytes} files={videos.files} busy={busy} failed={err('videos')} locked={locked} onDelete={() => del('videos', VIDEOS, 'every report video')} />
          {VIDEO_ROWS.filter(([k]) => u.shelves[k].bytes > 0).map(([k, label]) => (
            <Row key={k} id={k} inner label={label} sub={count(u.shelves[k].files, 'video', 'videos')} bytes={u.shelves[k].bytes} files={u.shelves[k].files} busy={busy} failed={err(k)} locked={locked} onDelete={() => del(k, [k], `${label} videos`)} />
          ))}
          <Row id="pictures" icon={<RowIcon color="rgb(48 176 199)"><Picture size={15} strokeWidth={2.4} /></RowIcon>} label="Pictures and other files" sub={pictures.files ? count(pictures.files, 'file', 'files') : undefined} bytes={pictures.bytes} files={pictures.files} busy={busy} failed={err('pictures')} locked={locked} onDelete={() => del('pictures', PICTURES, 'pictures and other files')} />
          {elsewhere.bytes > 0 && (
            <Row id="elsewhere" icon={<RowIcon color="rgb(99 99 102)"><Laptop size={15} strokeWidth={2.4} /></RowIcon>} label="From your other desktops" sub={count(elsewhere.files, 'file', 'files')} bytes={elsewhere.bytes} files={elsewhere.files} busy={busy} failed={err('elsewhere')} locked={locked} onDelete={() => del('elsewhere', ELSEWHERE, 'media from your other desktops')} />
          )}
          {fonts.bytes > 0 && (
            <Row id="fonts" icon={<RowIcon color="rgb(255 159 10)"><Type size={15} strokeWidth={2.4} /></RowIcon>} label="Tuner fonts" sub={count(fonts.files, 'font', 'fonts')} bytes={fonts.bytes} files={fonts.files} busy={busy} failed={err('fonts')} locked={locked} onDelete={() => del('fonts', [], 'Tuner fonts', true)} />
          )}
          <Row id="app" icon={<RowIcon color="rgb(10 132 255)"><Database size={15} strokeWidth={2.4} /></RowIcon>} label="Keys and settings" sub="Remove a desktop in Settings to delete its keys" bytes={u.app.bytes} locked={locked} />
          <button type="button" disabled={locked || !(all.bytes + fonts.bytes)} onClick={() => del('all', ALL, 'all downloaded files', true)} className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-[16px] text-[var(--ws-err)] active:bg-white/[0.06] disabled:opacity-50" data-ws-storage-delete="all">
            <RowIcon color="rgb(239 110 107)">
              <Trash2 size={15} strokeWidth={2.4} />
            </RowIcon>
            <span className="flex min-w-0 flex-1 flex-col">
              <span>{busy?.key === 'all' ? 'Deleting all downloaded files' : 'Delete all downloaded files'}</span>
              {busy?.key === 'all' && <ProgressBar value={busy.total ? busy.done / busy.total : null} className="mt-1.5 h-[3px] w-full" />}
              {err('all') && <span className="text-[13px] leading-snug">{err('all')}</span>}
            </span>
            <span className="shrink-0 text-[15px] tabular-nums text-[var(--ws-label2)]">{sizeText(all.bytes + fonts.bytes)}</span>
          </button>
        </>
      )}
    </Group>
  )
}
