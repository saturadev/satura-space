import { useEffect, useRef } from 'react'
import { HardDrive, Laptop, Pencil, Smartphone } from 'lucide-react'
import { useFileVersions, decideLater, keepMine, showCompare, takeOther, type VersionsConflict } from '../../lib/editor/file-versions-store'
import { versionNames, type VersionSource } from '../../lib/editor/file-versions'
import { pathBasename } from '../../lib/path'

export function versionIcon(side: 'mine' | 'theirs', c: VersionsConflict, device: 'mac' | 'phone', size: number) {
  if (side === 'mine') {
    if (device === 'phone') return <Smartphone size={size} />
    return c.by === 'phone' ? <Smartphone size={size} /> : <Pencil size={size} />
  }
  return (c.from as VersionSource) === 'mac' ? <Laptop size={size} /> : <HardDrive size={size} />
}

export function versionsMessage(c: VersionsConflict, device: 'mac' | 'phone'): string {
  if (c.kind === 'push') return 'Your edits on this phone didn’t reach the desktop, because its copy changed in the meantime. Nothing is saved until you save.'
  const where = device === 'mac' ? (c.by === 'phone' ? 'the edits from the phone' : 'your edits') : c.by === 'mac' ? 'the edits made on the desktop' : 'your edits'
  return `The file changed on disk after ${where} began. Keeping the edits leaves them unsaved; using the version on disk drops them.`
}

export function FileVersionsDialog() {
  const c = useFileVersions((s) => (s.open ? (s.push[s.open] ?? s.disk[s.open] ?? null) : null))
  const keepRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!c) return
    keepRef.current?.focus()
    const file = c.file
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        decideLater(file)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        void keepMine(file)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [c?.file, c?.key])

  if (!c) return null
  const names = versionNames('mac', c.kind, c.from, c.by)
  const rows = [
    { side: 'mine' as const, ...names.mine },
    { side: 'theirs' as const, ...names.theirs }
  ]

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 [-webkit-app-region:no-drag]"
      onMouseDown={() => decideLater(c.file)}
    >
      <div
        role="alertdialog"
        aria-label={`${pathBasename(c.file)} has two different versions`}
        data-versions-dialog
        className="animate-menu-pop-in surface-overlay w-[500px] max-w-[92vw] overflow-hidden rounded-xl [-webkit-app-region:no-drag]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-3">
          <h2 className="text-sm font-semibold text-zinc-100">{pathBasename(c.file)} has two different versions</h2>
          <div data-versions-rows className="mt-3 overflow-hidden rounded-lg border border-white/10 bg-black/20">
            {rows.map((r, i) => (
              <div key={r.side} data-versions-row={r.side} className={`flex items-center gap-2.5 px-3 py-2.5 ${i > 0 ? 'border-t border-white/5' : ''}`}>
                <div className={`grid size-8 shrink-0 place-items-center rounded-md ${r.side === 'mine' ? 'bg-sky-500/15 text-sky-300' : 'bg-amber-500/15 text-amber-300'}`}>
                  {versionIcon(r.side, c, 'mac', 16)}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-zinc-100">{r.label}</div>
                  <div className="truncate text-xs text-zinc-500">{r.note}</div>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm leading-relaxed text-zinc-400">{versionsMessage(c, 'mac')}</p>
        </div>
        <div className="flex items-center gap-2 px-4 pb-4 pt-1">
          <button
            onClick={() => showCompare(c.file)}
            data-versions-choice="compare"
            className="rounded px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-white/10 hover:text-white"
          >
            Compare
          </button>
          <div className="flex-1" />
          <button
            onClick={() => decideLater(c.file)}
            data-versions-choice="later"
            className="rounded px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-white/10 hover:text-white"
          >
            Later
          </button>
          <button
            onClick={() => void takeOther(c.file)}
            data-versions-choice="take"
            className="rounded px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-white/10 hover:text-white"
          >
            {names.take}
          </button>
          <button
            ref={keepRef}
            onClick={() => void keepMine(c.file)}
            data-versions-choice="keep"
            className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 focus:outline-none"
          >
            {names.keep}
          </button>
        </div>
      </div>
    </div>
  )
}
