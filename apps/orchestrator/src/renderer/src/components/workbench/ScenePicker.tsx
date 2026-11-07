import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { getUnityHost } from '../../lib/unity/unity-registry'
import { useAnchoredPosition, type PopoverPlacement } from '../../lib/anchored-popover'
import { PickerContextMenu } from './PickerContextMenu'

interface SceneItem {
  path: string
  folder: string
  name: string
}

function parseScene(p: string): SceneItem {
  const slash = p.lastIndexOf('/')
  const folder = slash >= 0 ? p.slice(0, slash) : ''
  const file = slash >= 0 ? p.slice(slash + 1) : p
  return { path: p, folder, name: file.replace(/\.unity$/, '') }
}

function lastFolder(folder: string): string {
  const i = folder.lastIndexOf('/')
  return i >= 0 ? folder.slice(i + 1) : folder
}

export function sceneToolbarLabel(path: string, multipleFolders: boolean): string {
  const s = parseScene(path)
  return multipleFolders && s.folder ? `${lastFolder(s.folder)}/${s.name}` : s.name
}

export function newSceneFolder(current: string): string {
  const slash = current.lastIndexOf('/')
  return current.startsWith('Assets/') && slash > 0 ? current.slice(0, slash) : 'Assets'
}

export function ScenePicker({
  id,
  scenes,
  recentScenes = [],
  value,
  dirty = false,
  disabled,
  title,
  openUp = false,
  alignLeft = false,
  onSelect,
  onRemoveRecent,
  onDiscard,
  onCreate
}: {
  id: string
  scenes: string[]
  recentScenes?: string[]
  value: string
  dirty?: boolean
  disabled: boolean
  title?: string
  openUp?: boolean
  alignLeft?: boolean
  onSelect: (scene: string) => void
  onRemoveRecent?: (scene: string) => void
  onDiscard?: (el: HTMLElement) => void
  onCreate?: (path: string) => Promise<string | null>
}) {
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [menu, setMenu] = useState<{ x: number; y: number; item: SceneItem } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const rowRefs = useRef(new Map<number, HTMLElement>())
  const placement: PopoverPlacement = openUp
    ? alignLeft
      ? 'top-left'
      : 'top-right'
    : alignLeft
      ? 'bottom-left'
      : 'bottom-right'
  const pop = useAnchoredPosition(open, btnRef, placement)

  const items = useMemo(() => scenes.map(parseScene), [scenes])
  const multipleFolders = useMemo(() => new Set(items.map((i) => i.folder)).size > 1, [items])

  const recent = useMemo(() => {
    const q = query.trim().toLowerCase()
    const known = new Set(scenes)
    const seen = new Set<string>()
    const out: SceneItem[] = []
    for (const p of recentScenes) {
      if (!known.has(p) || seen.has(p)) continue
      seen.add(p)
      if (q && !p.toLowerCase().includes(q)) continue
      out.push(parseScene(p))
    }
    return out
  }, [recentScenes, scenes, query])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q ? items.filter((i) => i.path.toLowerCase().includes(q)) : items
    const out: { folder: string; items: SceneItem[] }[] = []
    for (const it of filtered) {
      const last = out[out.length - 1]
      if (last && last.folder === it.folder) last.items.push(it)
      else out.push({ folder: it.folder, items: [it] })
    }
    return out
  }, [items, query])

  const navItems = useMemo(
    () => [...recent, ...groups.flatMap((g) => g.items)],
    [recent, groups]
  )

  useEffect(() => {
    setHighlight(0)
  }, [query, open])

  useEffect(() => {
    if (!open) return
    rowRefs.current.get(highlight)?.scrollIntoView({ block: 'nearest' })
  }, [highlight, navItems, open])

  const close = (): void => {
    setOpen(false)
    setQuery('')
    setMenu(null)
    setNaming(null)
    getUnityHost(id).focus()
  }

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !menu) close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, menu])

  const label = scenes.length === 0 ? 'No scenes' : sceneToolbarLabel(value, multipleFolders)

  const choose = (path: string): void => {
    onSelect(path)
    close()
  }

  const renderRow = (
    it: SceneItem,
    text: string,
    navIndex: number,
    key: string,
    removable = false
  ): ReactElement => {
    const sel = it.path === value
    const active = navIndex === highlight
    return (
      <div
        key={key}
        ref={(el) => {
          if (el) rowRefs.current.set(navIndex, el)
          else rowRefs.current.delete(navIndex)
        }}
        onMouseMove={() => setHighlight(navIndex)}
        onContextMenu={(e) => {
          e.preventDefault()
          setHighlight(navIndex)
          setMenu({ x: e.clientX, y: e.clientY, item: it })
        }}
        className={`group flex w-full items-center gap-1 px-3 py-1.5 text-xs ${
          sel
            ? 'bg-sky-500/15 text-white'
            : active
              ? 'bg-white/10 text-white'
              : 'text-zinc-300 hover:bg-white/10 hover:text-white'
        }`}
      >
        <button
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => choose(it.path)}
          title={it.path}
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
        >
          <span className="truncate">{text}</span>
          {sel && (
            <svg viewBox="0 0 24 24" className="ml-auto h-3.5 w-3.5 shrink-0 text-sky-400" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          )}
        </button>
        {removable && onRemoveRecent && (
          <button
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation()
              onRemoveRecent(it.path)
            }}
            title="Remove from recent"
            className="flex shrink-0 items-center rounded p-0.5 text-zinc-500 opacity-0 outline-none transition-opacity hover:bg-white/10 hover:text-zinc-200 focus:opacity-100 group-hover:opacity-100"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    )
  }

  return (
    <div ref={ref} className="relative flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-zinc-500">
      <div
        className="flex items-center gap-1.5"
        title={value || undefined}
        onContextMenu={(e) => {
          if (!value) return
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, item: parseScene(value) })
        }}
      >
        <span className="hidden sm:inline">Scene</span>
        <button
          ref={btnRef}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (disabled ? undefined : setOpen((o) => !o))}
          disabled={disabled}
          title={title ?? 'Load scene + enter Play Mode'}
          className={`flex max-w-44 items-center gap-1 rounded px-1.5 py-1 text-xs text-ink outline-none hover:bg-white/10 disabled:opacity-50 ${
            disabled ? 'pointer-events-none' : ''
          }`}
        >
          <span className="truncate">{label}</span>
          {dirty && (
            <span data-scene-dirty title="Unsaved changes" className="-ml-1 shrink-0 text-amber-300">
              *
            </span>
          )}
          <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 text-zinc-500" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {dirty && onDiscard && (
          <button
            tabIndex={-1}
            data-scene-discard
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => onDiscard(e.currentTarget)}
            title="Discard the unsaved scene changes"
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-zinc-300 outline-none hover:bg-white/10 hover:text-white"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
            </svg>
            <span className="hidden sm:inline">Discard</span>
          </button>
        )}
      </div>

      {open && (
        <div
          ref={pop.ref}
          style={pop.style}
          className="animate-menu-pop-in surface-overlay z-30 flex max-h-80 w-64 flex-col overflow-hidden rounded-lg"
        >
          {}
          <div className="shrink-0 border-b border-white/10 p-1.5">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setHighlight((h) => (navItems.length ? (h + 1) % navItems.length : 0))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setHighlight((h) =>
                    navItems.length ? (h - 1 + navItems.length) % navItems.length : 0
                  )
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  const it = navItems[highlight]
                  if (it) choose(it.path)
                }
              }}
              placeholder="Search scenes…"
              spellCheck={false}
              className="w-full rounded bg-white/5 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:bg-white/10"
            />
          </div>

          {}
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {groups.length === 0 && (
              <p className="px-3 py-2 text-xs text-zinc-600">No matching scenes</p>
            )}
            {recent.length > 0 && (
              <div className="border-b border-white/5 pb-1">
                <p className="truncate px-3 py-1 text-[10px] font-semibold tracking-wide text-zinc-500">
                  Recent
                </p>
                {recent.map((it, ri) =>
                  renderRow(
                    it,
                    sceneToolbarLabel(it.path, multipleFolders),
                    ri,
                    `recent:${it.path}`,
                    true
                  )
                )}
              </div>
            )}
            {groups.map((g, gi) => {
              const base = recent.length + groups.slice(0, gi).reduce((n, x) => n + x.items.length, 0)
              return (
                <div key={g.folder || `__root__${gi}`}>
                  {gi > 0 && <div className="my-1 border-t border-white/5" />}
                  {}
                  <p
                    className="truncate px-3 py-1 text-[10px] font-semibold tracking-wide text-zinc-500"
                    title={g.folder}
                  >
                    {g.folder || 'Assets'}
                  </p>
                  {g.items.map((it, ii) => renderRow(it, it.name, base + ii, `group:${it.path}`))}
                </div>
              )
            })}
          </div>
          {onCreate && (
            <div className="shrink-0 border-t border-white/10 p-1.5" data-scene-new>
              {naming === null ? (
                <button
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-zinc-300 outline-none hover:bg-white/10 hover:text-white"
                  title="Create an empty scene with a camera and a light, like File > New Scene in Unity, and open it"
                  onClick={() => {
                    setCreateError(null)
                    setNaming('')
                  }}
                >
                  <span className="text-zinc-500">+</span> New Scene…
                </button>
              ) : (
                <>
                  <input
                    autoFocus
                    value={naming}
                    disabled={creating}
                    onChange={(e) => {
                      setNaming(e.target.value)
                      setCreateError(null)
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setNaming(null)
                      } else if (e.key === 'Enter') {
                        e.preventDefault()
                        const name = naming.trim().replace(/\.unity$/i, '')
                        if (!name || /[\\/:*?"<>|]/.test(name)) {
                          setCreateError('Type a name without / \\ : * ? " < > |')
                          return
                        }
                        setCreating(true)
                        void onCreate(`${newSceneFolder(value)}/${name}.unity`).then((err) => {
                          setCreating(false)
                          if (err) setCreateError(err)
                          else {
                            setNaming(null)
                            close()
                          }
                        })
                      }
                    }}
                    placeholder="Scene name, then Enter"
                    spellCheck={false}
                    className="w-full rounded bg-white/5 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:bg-white/10"
                  />
                  <p className={`truncate px-1 pt-1 text-[10px] ${createError ? 'text-red-400' : 'text-zinc-500'}`} title={createError ?? undefined}>
                    {createError ?? (creating ? 'Creating…' : `Saved in ${newSceneFolder(value)}`)}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {menu && (
        <PickerContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            {
              label: 'Copy scene name',
              onClick: () => void window.api.ui.writeClipboardText(menu.item.name)
            },
            {
              label: 'Copy scene path',
              onClick: () => void window.api.ui.writeClipboardText(menu.item.path)
            }
          ]}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  )
}
