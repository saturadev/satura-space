import { useRef, useState, type ReactNode } from 'react'
import { useFloating } from '../../lib/floating'
import { Box, FileBox, Save, Undo2 } from 'lucide-react'
import { UnitySceneIcon } from './unity-icons'
import { unsavedCount, type TunerUnsaved } from '@shared/tuner'
import { useDismiss } from '../ui/useDismiss'
import { fileName, sceneName, unsavedShort } from '../../lib/tuner/unsaved'

const MOD = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+'

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-2.5 pt-1.5">
      <div className="pb-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">{title}</div>
      {children}
    </div>
  )
}

function Row({ icon, name, path, note }: { icon: ReactNode; name: string; path: string; note?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 py-0.5" data-unsaved-item={path} title={path}>
      <span className="shrink-0 text-zinc-500">{icon}</span>
      <span className="truncate text-xs text-zinc-200">{name}</span>
      {note && <span className="shrink-0 rounded bg-white/5 px-1 text-[10px] text-zinc-400">{note}</span>}
    </div>
  )
}

export function UnsavedMarker({
  unsaved,
  playing,
  busy,
  compact = false,
  onSave,
  onDiscard
}: {
  unsaved: TunerUnsaved
  playing: boolean
  busy: boolean
  compact?: boolean
  onSave: () => void
  onDiscard: (el: HTMLElement) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useDismiss(ref, () => setOpen(false), open)
  const n = unsavedCount(unsaved)
  useFloating(ref.current, listRef, { placement: 'top-end', gap: 4 }, open && n > 0)
  const items = [...unsaved.scenes, ...unsaved.prefabs, ...unsaved.assets.map((a) => a.path)]
  const saveTip =
    n === 0
      ? `Nothing to save yet. Edits stay in memory until you save (${MOD}S).`
      : `Write ${n === 1 ? 'the change' : `${n} changes`} to disk (${MOD}S)`
  return (
    <div
      className={`relative flex items-center gap-1 ${compact && n > 0 ? 'min-w-0 flex-1' : 'shrink-0'}`}
      ref={ref}
      data-tuner-unsaved-items={JSON.stringify(items)}
      data-tuner-playing={playing ? 'true' : undefined}
    >
      {n > 0 && (
        <button
          type="button"
          data-tuner-unsaved={n}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={
            compact
              ? 'flex shrink-0 items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-300'
              : 'flex min-w-0 max-w-[240px] items-center gap-1.5 rounded px-2 py-1 text-xs text-amber-300 hover:bg-white/10'
          }
          data-ti-tip={playing ? 'You have unsaved Edit Mode changes. Leave Play Mode to save them.' : 'Not saved yet. Click to see what changed.'}
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
          {compact ? <span>Unsaved {n}</span> : <span className="truncate">Unsaved: {unsavedShort(unsaved)}</span>}
        </button>
      )}
      {open && n > 0 && (
        <div
          ref={listRef}
          data-tuner-unsaved-list
          className="surface-overlay fixed left-0 top-0 z-30 w-72 rounded-lg pb-2"
        >
          {unsaved.scenes.length > 0 && (
            <Group title={unsaved.scenes.length === 1 ? 'Scene' : 'Scenes'}>
              {unsaved.scenes.map((s) => (
                <Row key={s} icon={<UnitySceneIcon className="h-3 w-3" />} name={sceneName(s)} path={s} />
              ))}
            </Group>
          )}
          {unsaved.prefabs.length > 0 && (
            <Group title={unsaved.prefabs.length === 1 ? 'Prefab' : 'Prefabs'}>
              {unsaved.prefabs.map((p) => (
                <Row key={p} icon={<Box className="h-3 w-3" />} name={fileName(p).replace(/\.prefab$/, '')} path={p} />
              ))}
            </Group>
          )}
          {unsaved.assets.length > 0 && (
            <Group title={unsaved.assets.length === 1 ? 'Asset' : 'Assets'}>
              {unsaved.assets.map((a) => (
                <Row key={a.path} icon={<FileBox className="h-3 w-3" />} name={fileName(a.path)} path={a.path} note={a.created ? 'new' : undefined} />
              ))}
            </Group>
          )}
          <div className="mx-2.5 mt-2 border-t border-white/5 pt-1.5 text-[11px] leading-snug text-zinc-400">
            {playing
              ? 'You made these changes in Edit Mode. Leave Play Mode to save them.'
              : `Save writes all of them (${MOD}S). Undo still works after you save.`}
          </div>
        </div>
      )}
      {!playing && n > 0 && (
        <button
          type="button"
          data-tuner-discard
          disabled={busy}
          onClick={(e) => onDiscard(e.currentTarget)}
          data-ti-tip="Go back to the last save"
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-300 enabled:hover:bg-white/10 enabled:hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600"
        >
          <Undo2 className="h-3.5 w-3.5" />
          Discard
        </button>
      )}
      {!playing && (
        <button
          type="button"
          data-tuner-save
          disabled={busy || n === 0}
          onClick={onSave}
          data-ti-tip={saveTip}
          className="flex shrink-0 items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-accent-fg enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-zinc-500"
        >
          <Save className="h-3.5 w-3.5" />
          Save
        </button>
      )}
    </div>
  )
}
