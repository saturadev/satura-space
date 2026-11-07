import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useKeepInView } from '../../../lib/floating'
import type { TiMenuData, TiPopup } from '@shared/tuner-inspector'
import { asTunerPopup, type TunerMenuExtra, type TunerPopup } from '@shared/tuner-inspector-popups'
import { TunerPopupHost } from './popups/TunerPopupHost'
import type { AnchorGetter } from './popups/PopupSurface'

export type MenuExtra = TunerMenuExtra

export interface PopupAnswer {
  (popup: TiPopup, action: 'change' | 'commit' | 'cancel', value?: unknown): void
}

function describe(p: TiPopup): string {
  const data = (p.data ?? {}) as { type?: string; content?: string }
  const type = data.content || data.type || p.kind
  return type.includes('.') ? type.slice(type.lastIndexOf('.') + 1) : type
}

function PendingPopupCard({ popup, onAnswer }: { popup: TiPopup; onAnswer: PopupAnswer }) {
  const ref = useRef<HTMLDivElement>(null)
  useKeepInView(ref)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onAnswer(popup, 'cancel')
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onAnswer(popup, 'cancel')
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [popup, onAnswer])
  const a = popup.anchor
  return (
    <div
      ref={ref}
      data-ti-popup={popup.kind}
      data-ti-popup-id={popup.id}
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute z-[60] flex max-w-[280px] items-start gap-2 rounded-lg border border-white/10 bg-panel px-3 py-2 text-xs text-ink-2 shadow-2xl"
      style={{ left: a.x, top: a.y + a.h + 2 }}
    >
      <span className="min-w-0 flex-1">{describe(popup)} can't open here yet.</span>
      <button type="button" onClick={() => onAnswer(popup, 'cancel')} className="shrink-0 rounded p-0.5 text-ink-4 hover:bg-white/10 hover:text-ink">
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

export function PopupHost({
  popups,
  onAnswer,
  menuExtras,
  projectPath,
  renderWindow
}: {
  popups: TiPopup[]
  onAnswer: PopupAnswer
  menuExtras?: (popup: TiPopup) => MenuExtra[] | undefined
  projectPath: string
  renderWindow?: (sectionKey: string) => ReactNode | null
}) {
  const last = popups[popups.length - 1]
  if (!last) return null
  const stack = popups.filter((p, i) => i === popups.length - 1 || asTunerPopup(p)?.kind === 'window')
  const windowAnchor = (p: TiPopup, own: TunerPopup | null): AnchorGetter | undefined => {
    if (own?.kind === 'window' && own.data.parent) {
      const parentKey = own.data.parent
      const row = own.data.row
      return () => {
        const el = document.querySelector(`[data-tuner-window="${CSS.escape(parentKey)}"]`)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { left: r.left, top: r.top + (row?.y ?? 0), width: r.width, height: row?.h ?? 18 }
      }
    }
    const key = p.section
    if (!key) return undefined
    const a = p.anchor
    return () => {
      const el = document.querySelector(`[data-tuner-window="${CSS.escape(key)}"]`) as HTMLElement | null
      if (!el) return null
      const r = el.getBoundingClientRect()
      const sx = Number(el.dataset.secX ?? 0)
      const sy = Number(el.dataset.secY ?? 0)
      return { left: r.left + a.x - sx, top: r.top + a.y - sy, width: a.w, height: a.h }
    }
  }
  const render = (i: number): ReactNode => {
    const raw = stack[i]
    if (!raw) return null
    const popup = asTunerPopup(raw)
    const windowBody = popup?.kind === 'window' && popup.data.section ? (renderWindow?.(popup.data.section) ?? null) : null
    if (!popup || (popup.kind === 'window' && !windowBody)) return <PendingPopupCard key={raw.id} popup={raw} onAnswer={onAnswer} />
    const nested = i > 0
    const inner = popup.kind === 'window' ? render(i + 1) : null
    return (
      <TunerPopupHost
        key={raw.id}
        popup={popup}
        projectPath={projectPath}
        onAnswer={(_p: TunerPopup, action, value) => onAnswer(raw, action, value)}
        extras={() => menuExtras?.(raw)}
        renderWindow={() => (
          <>
            {windowBody}
            {inner}
          </>
        )}
        anchor={nested ? windowAnchor(raw, popup) : undefined}
        beside={nested && popup.kind === 'window' && !!popup.data.parent}
        menuAttrs={(p) => (p.kind === 'menu' ? { 'data-ti-menu': (raw.data as TiMenuData).context ?? 'custom' } : undefined)}
      />
    )
  }
  return <>{render(0)}</>
}
