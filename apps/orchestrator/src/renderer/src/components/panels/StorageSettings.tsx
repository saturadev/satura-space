import { useCallback, useEffect, useState } from 'react'
import type { AppCache, AppCacheId, AppCaches } from '@shared/app-caches'
import { ProgressBar } from '../../remote/motion'
import '../../remote/progress-bar.css'

const LABELS: Record<AppCacheId, { title: string; hint: string }> = {
  'phone-versions': { title: 'Phone versions', hint: 'Copies of report videos made for Satura Remote when the phone can’t play the original well (4K, ProRes, index at the end).' },
  'phone-1080': { title: '1080p for the phone', hint: 'Smaller copies for the phone’s 1080p quality.' },
  'phone-720': { title: '720p for the phone', hint: 'Smaller copies for the phone’s 720p quality.' },
  'phone-480': { title: '480p for the phone', hint: 'Smaller copies for the phone’s 480p quality and slow connections.' },
  'phone-stills': { title: 'First frames for the phone', hint: 'Pictures the phone shows before a video plays.' },
  web: { title: 'Web cache', hint: 'Pages, scripts and pictures the app’s web views downloaded.' },
  code: { title: 'Script cache', hint: 'Compiled scripts that make the app start faster.' },
  gpu: { title: 'Graphics cache', hint: 'Compiled shaders. The app uses it while it runs, so it can’t be deleted here.' }
}
const PHONE: AppCacheId[] = ['phone-versions', 'phone-1080', 'phone-720', 'phone-480', 'phone-stills']
const APP: AppCacheId[] = ['web', 'code', 'gpu']

const sizeText = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e7 ? `${Math.round(n / 1e6)} MB` : n >= 1e5 ? `${(n / 1e6).toFixed(1)} MB` : n > 0 ? `${Math.max(1, Math.round(n / 1024))} KB` : 'None')
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').trim() || 'It stopped.'

function CacheRow({ c, busy, error, onDelete }: { c: AppCache; busy: boolean; error?: string; onDelete: (() => void) | null }) {
  const l = LABELS[c.id]
  return (
    <div className="flex items-center gap-3 rounded border border-white/10 bg-sunken px-2.5 py-2" data-app-cache={c.id} data-bytes={c.bytes} data-files={c.files}>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-zinc-100">
          {l.title}
          {c.files > 0 && <span className="text-zinc-500"> · {c.files} {c.files === 1 ? 'file' : 'files'}</span>}
        </p>
        <p className="text-xs text-zinc-500">{l.hint}</p>
        {busy && <ProgressBar value={null} className="mt-1.5 h-[3px] w-full" />}
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      </div>
      <span className="shrink-0 text-xs tabular-nums text-zinc-300" data-app-cache-size>
        {sizeText(c.bytes)}
      </span>
      {onDelete && (
        <button
          onClick={onDelete}
          disabled={busy || c.bytes === 0}
          className="shrink-0 rounded-md border border-white/10 px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/10 hover:text-white active:scale-95 disabled:opacity-40"
          data-app-cache-delete={c.id}
        >
          {busy ? 'Deleting…' : error ? 'Try again' : 'Delete'}
        </button>
      )}
    </div>
  )
}

export function StorageSection() {
  const [caches, setCaches] = useState<AppCaches | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState<AppCacheId[] | null>(null)
  const [failed, setFailed] = useState<{ ids: AppCacheId[]; text: string } | null>(null)
  const measure = useCallback(() => {
    setLoadError('')
    window.api.app.caches().then(setCaches, (e: unknown) => setLoadError(`Couldn’t measure the caches. ${message(e)}`))
  }, [])
  useEffect(() => measure(), [measure])
  const del = (ids: AppCacheId[]): void => {
    if (busy) return
    setFailed(null)
    setBusy(ids)
    window.api.app
      .clearCaches(ids)
      .then(setCaches, (e: unknown) => setFailed({ ids, text: `Couldn’t delete it. ${message(e)}` }))
      .finally(() => setBusy(null))
  }
  const row = (id: AppCacheId) => {
    const c = caches?.caches.find((x) => x.id === id)
    if (!c) return null
    const mine = !!busy?.includes(id)
    return <CacheRow key={id} c={c} busy={mine} error={failed?.ids.includes(id) ? failed.text : undefined} onDelete={c.clearable ? () => del([id]) : null} />
  }
  const total = (ids: AppCacheId[]): number => ids.reduce((n, id) => n + (caches?.caches.find((c) => c.id === id)?.bytes ?? 0), 0)
  const clearable = (caches?.caches ?? []).filter((c) => c.clearable && c.bytes > 0).map((c) => c.id)
  return (
    <>
      <section className="space-y-2" data-app-caches={caches ? 'ready' : loadError ? 'error' : 'loading'}>
        <div className="flex items-center justify-between">
          <label className="text-sm font-semibold text-zinc-200">Videos for Satura Remote</label>
          <span className="text-xs tabular-nums text-zinc-400">{caches ? sizeText(total(PHONE)) : ''}</span>
        </div>
        <p className="text-xs text-zinc-500">
          When a phone plays a report video, this computer can make a copy the phone plays better. They’re made again when a phone needs them.
          {caches && (
            <>
              {' '}
              <button className="text-sky-400 hover:text-sky-300" onClick={() => void window.api.shell.showItemInFolder(caches.phoneDir)}>
                Show in Finder
              </button>
            </>
          )}
        </p>
        {!caches ? (
          <div className="rounded border border-white/10 bg-sunken px-2.5 py-2">
            <p className={`text-xs ${loadError ? 'text-red-400' : 'text-zinc-500'}`}>{loadError || 'Measuring the caches…'}</p>
            {loadError ? (
              <button onClick={measure} className="mt-1 text-xs text-sky-400 hover:text-sky-300">
                Try again
              </button>
            ) : (
              <ProgressBar value={null} className="mt-1.5 h-[3px] w-full" />
            )}
          </div>
        ) : (
          <div className="space-y-1.5">{PHONE.map(row)}</div>
        )}
      </section>
      {caches && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-semibold text-zinc-200">App caches</label>
            <span className="text-xs tabular-nums text-zinc-400">{sizeText(total(APP))}</span>
          </div>
          <p className="text-xs text-zinc-500">What the app’s web views keep to load faster. Deleting it is safe.</p>
          <div className="space-y-1.5">{APP.map(row)}</div>
        </section>
      )}
      {caches && (
        <section className="space-y-2">
          <div className="flex items-center gap-3">
            <button
              onClick={() => del(clearable)}
              disabled={!!busy || !clearable.length}
              className="rounded-md border border-red-500/30 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10 active:scale-95 disabled:opacity-40"
              data-app-cache-delete="all"
            >
              {busy && busy.length > 1 ? 'Deleting all caches…' : 'Delete all caches'}
            </button>
            <span className="text-xs tabular-nums text-zinc-500" data-app-caches-total={caches.total}>
              {sizeText(caches.total)} in all
            </span>
          </div>
          {busy && busy.length > 1 && <ProgressBar value={null} className="h-[3px] w-full" />}
          {failed && failed.ids.length > 1 && <p className="text-xs text-red-400">{failed.text}</p>}
        </section>
      )}
    </>
  )
}
