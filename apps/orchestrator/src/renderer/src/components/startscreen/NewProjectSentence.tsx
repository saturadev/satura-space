import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { NewProjectKind, UnityEditorForCreate } from '@shared/api'
import { useAnchoredPosition } from '../../lib/anchored-popover'

export interface NewProjectDraft {
  kind: NewProjectKind
  version: string
  parent: string
  name: string
}

const KIND_OPTIONS: { id: NewProjectKind; label: string; hint: string }[] = [
  { id: '2d', label: '2D', hint: 'URP 2D Renderer · sprites, tilemaps, 2D lights' },
  { id: '3d', label: '3D', hint: 'URP · lit scene, Forward+' }
]

export function NewProjectSentence({
  draft,
  onChange,
  editors,
  home,
  problem,
  error,
  onBrowse
}: {
  draft: NewProjectDraft
  onChange: (patch: Partial<NewProjectDraft>) => void
  editors: UnityEditorForCreate[] | null
  home: string
  problem: string | null
  error: string | null
  onBrowse: () => void
}) {
  if (editors === null)
    return (
      <div className="flex h-[148px] items-center justify-center gap-2 text-xs text-ink-3">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        Looking for Unity editors…
      </div>
    )

  if (editors.length === 0)
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
        <div className="text-sm font-semibold text-ink">No Unity editors found</div>
        <p className="max-w-sm text-xs leading-snug text-ink-3">
          Install a Unity 6 editor in Unity Hub, then come back here to create the project.
        </p>
        <button
          onClick={() => void window.api.unity.openHub()}
          className="rounded-md bg-panel px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-elevated hover:text-ink"
        >
          Open Unity Hub
        </button>
      </div>
    )

  const editor = editors.find((e) => e.version === draft.version)
  const kindMissing = editor ? !editor.kinds.includes(draft.kind) : true
  const target = `${shortPath(draft.parent, home).replace(/[\\/]+$/, '')}/${draft.name.trim() || '…'}`
  const message =
    error ??
    (kindMissing
      ? `Unity ${draft.version} has no ${draft.kind.toUpperCase()} URP template. Pick another version.`
      : problem)

  return (
    <div className="flex flex-col items-center px-2 pb-1 pt-3">
      <div className="flex flex-col items-center gap-2.5 text-[21px] font-semibold tracking-[-0.01em] text-ink-3">
        <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-2">
          <span>Make a</span>
          <Token
            label={draft.kind.toUpperCase()}
            icon={<KindArt kind={draft.kind} className="h-5 w-7" />}
            title="Template"
          >
            {(close) =>
              KIND_OPTIONS.map((o) => {
                const has = editor?.kinds.includes(o.id) ?? false
                return (
                  <MenuItem
                    key={o.id}
                    selected={o.id === draft.kind}
                    disabled={!has}
                    onClick={() => {
                      onChange({ kind: o.id })
                      close()
                    }}
                  >
                    <KindArt kind={o.id} className="h-6 w-8 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-semibold text-ink">{o.label}</span>
                      <span className="block text-[11px] text-ink-3">
                        {has ? o.hint : `Not in Unity ${draft.version}`}
                      </span>
                    </span>
                  </MenuItem>
                )
              })
            }
          </Token>
          <span>URP game called</span>
          <NameInput value={draft.name} onChange={(name) => onChange({ name })} invalid={!!problem && !error} />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-2">
          <span>on Unity</span>
          <Token label={draft.version} mono title="Unity version">
            {(close) => (
              <>
                {editors.map((e) => {
                  const has = e.kinds.includes(draft.kind)
                  return (
                    <MenuItem
                      key={e.version}
                      selected={e.version === draft.version}
                      disabled={!has}
                      onClick={() => {
                        onChange({ version: e.version })
                        close()
                      }}
                    >
                      <span className="font-mono text-[13px] text-ink">{e.version}</span>
                      {!has && (
                        <span className="ml-auto pl-4 text-[11px] text-ink-4">
                          No {draft.kind.toUpperCase()} template
                        </span>
                      )}
                    </MenuItem>
                  )
                })}
                <div className="mx-1 my-1 h-px bg-white/[0.06]" />
                <MenuItem
                  onClick={() => {
                    close()
                    void window.api.unity.openHub()
                  }}
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-ink-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
                  </svg>
                  <span className="text-xs text-ink-2">Install another version in Unity Hub</span>
                </MenuItem>
              </>
            )}
          </Token>
          <span>in</span>
          <button
            onClick={onBrowse}
            title={draft.parent}
            className="flex h-[38px] max-w-[16rem] items-center gap-2 rounded-lg border border-transparent bg-canvas px-2.5 font-mono text-[15px] font-medium text-ink transition-colors hover:border-accent/50"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-ink-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span className="truncate">{shortPath(draft.parent, home)}</span>
          </button>
        </div>
      </div>

      <div className="mt-4 flex min-h-[18px] max-w-full items-center justify-center gap-1.5 text-[11px]">
        {message ? (
          <span className="whitespace-pre-wrap text-center leading-snug text-rose-300">{message}</span>
        ) : (
          <>
            <span className="shrink-0 text-ink-3">Creates</span>
            <span className="truncate font-mono text-ink-2" title={target}>
              {target}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

function Token({
  label,
  icon,
  mono,
  title,
  children
}: {
  label: string
  icon?: ReactNode
  mono?: boolean
  title: string
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const pop = useAnchoredPosition(open, btnRef, 'bottom-left', 6)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span ref={ref} className="relative flex">
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-expanded={open}
        className={`flex h-[38px] items-center gap-1.5 rounded-lg border bg-canvas px-2.5 text-ink transition-colors ${
          mono ? 'font-mono text-[15px] font-medium' : 'text-[19px]'
        } ${open ? 'border-accent/70' : 'border-transparent hover:border-accent/50'}`}
      >
        {icon}
        {label}
        <svg
          viewBox="0 0 24 24"
          className={`h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          ref={pop.ref}
          style={pop.style}
          className="animate-menu-pop-in surface-overlay z-30 flex min-w-[13rem] flex-col gap-0.5 rounded-lg p-1 text-left leading-normal tracking-normal"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  )
}

function MenuItem({
  selected,
  disabled,
  onClick,
  children
}: {
  selected?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2.5 whitespace-nowrap rounded-md px-2 py-1.5 text-left outline-none transition-colors disabled:cursor-default disabled:opacity-45 ${
        selected ? 'bg-white/[0.07]' : 'enabled:hover:bg-white/[0.05]'
      }`}
    >
      {selected !== undefined && (
        <svg
          viewBox="0 0 24 24"
          className={`h-3.5 w-3.5 shrink-0 text-accent ${selected ? '' : 'invisible'}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12l5 5 9-10" />
        </svg>
      )}
      {children}
    </button>
  )
}

function NameInput({
  value,
  onChange,
  invalid
}: {
  value: string
  onChange: (v: string) => void
  invalid: boolean
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      placeholder="MyGame"
      title="Project name"
      style={{ width: `${Math.max(6, Math.min(24, value.length || 6)) + 2.5}ch` }}
      className={`h-[38px] rounded-lg border bg-canvas px-2.5 text-center font-mono text-[15px] font-medium text-ink outline-none transition-colors placeholder:text-ink-4 ${
        invalid ? 'border-rose-400/60' : 'border-transparent hover:border-accent/50 focus:border-accent/70'
      }`}
    />
  )
}

function KindArt({ kind, className }: { kind: NewProjectKind; className?: string }) {
  if (kind === '2d')
    return (
      <svg viewBox="0 0 120 72" className={`text-accent ${className ?? ''}`}>
        <circle cx="96" cy="16" r="9" fill="currentColor" opacity=".4" />
        <path d="M0 50C20 34 34 34 52 46c16 10 30-10 48-8 10 1 16 6 20 8v26H0z" fill="currentColor" opacity=".22" />
        <rect y="54" width="120" height="18" fill="currentColor" opacity=".45" />
        <rect x="64" y="34" width="28" height="7" rx="1.5" fill="currentColor" opacity=".7" />
        <rect x="28" y="34" width="13" height="20" rx="2.5" fill="currentColor" />
      </svg>
    )
  return (
    <svg viewBox="0 0 120 72" className={`text-accent ${className ?? ''}`}>
      <ellipse cx="60" cy="64" rx="38" ry="7" fill="currentColor" opacity=".16" />
      <path d="M60 4l28 14-28 14-28-14z" fill="currentColor" />
      <path d="M32 18l28 14v32L32 50z" fill="currentColor" opacity=".6" />
      <path d="M60 32l28-14v32L60 64z" fill="currentColor" opacity=".35" />
    </svg>
  )
}

export function shortPath(p: string, home: string): string {
  const norm = p.replace(/\\/g, '/')
  const h = home.replace(/\\/g, '/').replace(/\/+$/, '')
  if (h && (norm === h || norm.startsWith(`${h}/`))) return `~${norm.slice(h.length)}`
  return norm
}
