import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { useFloating } from '../../lib/floating'
import {
  MAX_RESOLUTION_NAME,
  MAX_STREAM_DIM,
  MIN_STREAM_DIM,
  formatSize,
  isStreamDim,
  sameSize,
  streamSizeFor,
  type PixelSize,
  type SavedStreamResolution
} from '@shared/unity/stream-size'
import {
  DEFAULT_PRESET,
  PRESET_GROUPS,
  findPreset,
  findSaved,
  ratioLabel,
  removeSaved,
  upsertSaved
} from '../../lib/unity/stream-presets'
import { censusTrack } from '@shared/census'

const savedByProject = new Map<string, SavedStreamResolution[]>()
censusTrack('StreamResolutionPicker.savedByProject', savedByProject)

const MENU_GAP = 4
const MENU_MAX_H = 340

const fieldClass = (bad: boolean): string =>
  `h-7 w-0 min-w-0 flex-1 rounded bg-white/5 px-2 text-center text-xs tabular-nums text-zinc-200 outline-none focus:bg-white/10 ${
    bad ? 'ring-1 ring-inset ring-rose-400' : ''
  }`

function AspectGlyph({ size, filled = false }: { size: PixelSize; filled?: boolean }) {
  const m = 14
  const r = size.width / size.height
  const gw = r >= 1 ? m : Math.max(5, m * r)
  const gh = r >= 1 ? Math.max(5, m / r) : m
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 overflow-visible">
      <rect
        x={(16 - gw) / 2 + 0.5}
        y={(16 - gh) / 2 + 0.5}
        width={gw - 1}
        height={gh - 1}
        rx={1.5}
        fill={filled ? 'currentColor' : 'none'}
        fillOpacity={filled ? 0.25 : 0}
        stroke="currentColor"
        strokeWidth={1.3}
      />
    </svg>
  )
}

function DiskIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round">
      <path d="M2.5 2.5h9l2 2v9h-11z" />
      <path d="M5 2.5v3.5h5V2.5" />
      <rect x="5" y="9" width="6" height="4.5" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-sky-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
    </svg>
  )
}

interface MenuRow {
  size: PixelSize
  name: string
  saved: boolean
}

interface MenuSection {
  title: string
  count: number | null
  rows: MenuRow[]
}

export function StreamResolutionPicker({
  projectPath,
  streamRes,
  onStreamRes,
  current
}: {
  projectPath: string
  streamRes: string
  onStreamRes: (res: string) => void
  current: string | null
}) {
  const size = streamSizeFor(streamRes)
  const key = formatSize(size)
  const [saved, setSaved] = useState<SavedStreamResolution[]>(() => savedByProject.get(projectPath) ?? [])
  const [w, setW] = useState(String(size.width))
  const [h, setH] = useState(String(size.height))
  const [bad, setBad] = useState({ w: false, h: false })
  const [name, setName] = useState('')
  const [open, setOpen] = useState(false)
  const [hl, setHl] = useState(-1)
  const boxRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLButtonElement>(null)

  const preset = findPreset(size)
  const savedHit = findSaved(saved, size)

  useEffect(() => {
    let alive = true
    void window.api.unity.getStreamResolutions(projectPath).then((list) => {
      if (!alive) return
      savedByProject.set(projectPath, list)
      setSaved(list)
    })
    return () => {
      alive = false
    }
  }, [projectPath])

  useEffect(() => {
    setW(String(size.width))
    setH(String(size.height))
    setBad({ w: false, h: false })
  }, [key])

  useEffect(() => {
    setName(savedHit?.name ?? '')
  }, [key, savedHit?.name])

  const persist = (next: SavedStreamResolution[]): void => {
    savedByProject.set(projectPath, next)
    setSaved(next)
    void window.api.unity.setStreamResolutions(projectPath, next).then((list) => {
      savedByProject.set(projectPath, list)
      setSaved(list)
    })
  }

  const pick = (next: PixelSize): void => {
    setOpen(false)
    if (!sameSize(next, size)) onStreamRes(formatSize(next))
  }

  const commitFields = (): void => {
    const nw = Number(w.trim())
    const nh = Number(h.trim())
    const okW = isStreamDim(nw)
    const okH = isStreamDim(nh)
    setBad({ w: !okW, h: !okH })
    if (okW && okH) pick({ width: nw, height: nh })
  }

  const saveCurrent = (): void => {
    persist(upsertSaved(saved, { width: size.width, height: size.height, name: name.trim().slice(0, MAX_RESOLUTION_NAME) }))
  }

  const renameOnBlur = (): void => {
    if (savedHit && savedHit.name !== name.trim()) saveCurrent()
  }

  const sections: MenuSection[] = [
    { title: 'Default', count: null, rows: [{ size: DEFAULT_PRESET, name: DEFAULT_PRESET.name, saved: false }] },
    ...(saved.length
      ? [
          {
            title: 'Saved in this project',
            count: saved.length,
            rows: saved.map((c) => ({ size: { width: c.width, height: c.height }, name: c.name, saved: true }))
          }
        ]
      : []),
    ...PRESET_GROUPS.map((g) => ({
      title: g.title,
      count: g.presets.length,
      rows: g.presets.map((q) => ({ size: { width: q.width, height: q.height }, name: q.name, saved: false }))
    }))
  ]
  const flat = sections.flatMap((s) => s.rows)

  const toggleMenu = (next = !open): void => {
    if (next) {
      setHl(flat.findIndex((r) => sameSize(r.size, size)))
      mainRef.current?.focus()
    }
    setOpen(next)
  }

  useFloating(boxRef.current, menuRef, { placement: 'bottom-start', gap: MENU_GAP, matchWidth: true }, open)

  useLayoutEffect(() => {
    if (!open) return
    menuRef.current?.querySelector('[data-resolution-row][aria-selected="true"]')?.scrollIntoView({ block: 'center' })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (boxRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [open])

  const navKey = (e: ReactKeyboardEvent<HTMLElement>): boolean => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        toggleMenu(true)
        return true
      }
      const n = flat.length
      const i = hl < 0 ? 0 : (hl + (e.key === 'ArrowDown' ? 1 : -1) + n) % n
      setHl(i)
      menuRef.current?.querySelector(`[data-resolution-index="${i}"]`)?.scrollIntoView({ block: 'nearest' })
      return true
    }
    if (!open) return false
    if (e.key === 'Enter' && flat[hl]) {
      e.preventDefault()
      pick(flat[hl].size)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      return true
    }
    return false
  }

  const onNameKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (navKey(e)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      saveCurrent()
      e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setName(savedHit?.name ?? '')
      e.currentTarget.blur()
    }
  }

  const onFieldKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    commitFields()
  }

  const orientationTitle =
    size.width > size.height
      ? 'Landscape. Click to switch to portrait'
      : size.height > size.width
        ? 'Portrait. Click to switch to landscape'
        : 'Square'

  let index = -1
  const menu: ReactNode =
    open &&
    createPortal(
      <div
        ref={menuRef}
        data-stream-menu="resolution"
        role="listbox"
        style={{ left: 0, top: 0, maxHeight: MENU_MAX_H }}
        className="animate-menu-pop-in surface-overlay fixed z-50 overflow-y-auto rounded-lg p-1 [-webkit-app-region:no-drag]"
      >
        {sections.map((sec, si) => (
          <div key={sec.title}>
            <div
              className={`sticky -top-1 z-10 -mx-1 flex h-[26px] items-center justify-between bg-panel pl-[7px] pr-[9px] text-[10px] uppercase tracking-wide text-zinc-500 ${
                si > 0 ? 'mt-1 border-t border-white/10' : ''
              }`}
            >
              <span>{sec.title}</span>
              {sec.count != null && <span className="tracking-normal text-zinc-600">{sec.count}</span>}
            </div>
            {sec.rows.map((row) => {
              index++
              const i = index
              const on = sameSize(row.size, size)
              const lit = i === hl
              return (
                <div
                  key={`${sec.title}:${formatSize(row.size)}`}
                  data-resolution-row={formatSize(row.size)}
                  data-resolution-index={i}
                  role="option"
                  aria-selected={on}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setHl(i)}
                  onClick={() => pick(row.size)}
                  className={`group flex h-7 cursor-pointer items-center gap-2 rounded pl-[3px] pr-1 text-xs ${
                    on
                      ? lit
                        ? 'bg-sky-500/25 text-white'
                        : 'bg-sky-500/15 text-white'
                      : lit
                        ? 'bg-white/[0.08] text-white'
                        : 'text-zinc-300'
                  }`}
                >
                  <span className={on ? 'text-sky-400' : lit ? 'text-zinc-400' : 'text-zinc-600'}>
                    <AspectGlyph size={row.size} filled={on} />
                  </span>
                  <span className={`min-w-0 flex-1 truncate ${row.name ? '' : 'text-zinc-500'}`}>
                    {row.name || 'Untitled'}
                  </span>
                  <span className="w-[34px] text-right text-[10px] tabular-nums text-zinc-600">{ratioLabel(row.size)}</span>
                  <span className={`w-[74px] text-right text-[11px] tabular-nums ${on ? 'text-sky-100' : 'text-zinc-400'}`}>
                    {row.size.width} × {row.size.height}
                  </span>
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                    {row.saved && lit ? (
                      <button
                        data-remove-resolution={formatSize(row.size)}
                        tabIndex={-1}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation()
                          persist(removeSaved(saved, row.size))
                        }}
                        title="Remove from this project"
                        className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 outline-none hover:bg-rose-400/10 hover:text-rose-300"
                      >
                        <TrashIcon />
                      </button>
                    ) : (
                      on && <CheckIcon />
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        ))}
      </div>,
      document.body
    )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">Resolution</span>
        {current && <span className="text-[10px] tabular-nums text-zinc-500">{current} now</span>}
      </div>

      <div className="flex items-center gap-1">
        <input
          data-stream-width
          value={w}
          inputMode="numeric"
          spellCheck={false}
          aria-label="Width"
          title={`Width in pixels, ${MIN_STREAM_DIM}–${MAX_STREAM_DIM}`}
          onChange={(e) => {
            setW(e.target.value)
            setBad((b) => ({ ...b, w: false }))
          }}
          onKeyDown={onFieldKey}
          onBlur={commitFields}
          className={fieldClass(bad.w)}
        />
        <span className="text-xs text-zinc-600">×</span>
        <input
          data-stream-height
          value={h}
          inputMode="numeric"
          spellCheck={false}
          aria-label="Height"
          title={`Height in pixels, ${MIN_STREAM_DIM}–${MAX_STREAM_DIM}`}
          onChange={(e) => {
            setH(e.target.value)
            setBad((b) => ({ ...b, h: false }))
          }}
          onKeyDown={onFieldKey}
          onBlur={commitFields}
          className={fieldClass(bad.h)}
        />
        <button
          data-stream-orientation
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick({ width: size.height, height: size.width })}
          title={orientationTitle}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-zinc-400 outline-none hover:bg-white/10 hover:text-white"
        >
          <AspectGlyph size={size} />
        </button>
      </div>

      <div
        ref={boxRef}
        data-stream-presets
        className={`flex h-7 items-center gap-2 rounded pl-2 pr-0.5 transition-colors ${
          open ? 'bg-white/[0.07] ring-1 ring-inset ring-sky-400/45' : 'bg-white/5 hover:bg-white/[0.07]'
        }`}
      >
        <span className="text-zinc-400">
          <AspectGlyph size={size} />
        </span>
        {preset ? (
          <button
            ref={mainRef}
            data-stream-presets-button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleMenu()}
            onKeyDown={navKey}
            className="flex h-full min-w-0 flex-1 items-center text-left text-xs text-zinc-100 outline-none"
          >
            <span className="truncate">{preset.name}</span>
          </button>
        ) : (
          <>
            <input
              data-stream-resolution-name
              value={name}
              maxLength={MAX_RESOLUTION_NAME}
              spellCheck={false}
              aria-label="Name"
              placeholder={savedHit ? 'Name this size' : 'Name it (optional)'}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={onNameKey}
              onBlur={renameOnBlur}
              className="h-full w-0 min-w-0 flex-1 bg-transparent text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
            />
            {!savedHit && (
              <button
                data-stream-save-resolution
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={saveCurrent}
                title="Save this size to the project"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-sky-300 outline-none hover:bg-sky-500/30 hover:text-sky-100"
              >
                <DiskIcon />
              </button>
            )}
          </>
        )}
        <button
          data-stream-presets-toggle
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggleMenu()}
          title="Presets"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 outline-none hover:bg-white/10 hover:text-white"
        >
          <svg
            viewBox="0 0 16 16"
            className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </div>

      {menu}
    </div>
  )
}
