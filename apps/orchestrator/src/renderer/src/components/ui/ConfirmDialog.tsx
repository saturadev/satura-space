import { useEffect, useMemo, useRef, useState } from 'react'
import { useFloating } from '../../lib/floating'
import { useConfirmStore } from '../../lib/confirm/confirm-store'
import { Checkbox } from './Checkbox'
import { File, FolderOpen } from 'lucide-react'
import { UnityPrefabIcon, UnitySceneIcon } from '../tuner/unity-icons'

const GAP = 6

export function ConfirmDialog() {
  const request = useConfirmStore((s) => (s.request?.remote ? null : s.request))
  const respond = useConfirmStore((s) => s.respond)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [checked, setChecked] = useState(false)

  const anchor = request?.anchor ?? null

  useEffect(() => {
    setChecked(request?.checkbox?.defaultChecked ?? false)
  }, [request?.id])

  const reference = useMemo(() => {
    if (!anchor) return null
    const left = anchor.x
    const top = anchor.top ?? anchor.y
    const right = anchor.right ?? anchor.x
    const bottom = anchor.y
    return { getBoundingClientRect: () => ({ x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top }) }
  }, [anchor?.x, anchor?.y, anchor?.top, anchor?.right])
  useFloating(reference, cardRef, { placement: 'bottom-start', gap: GAP }, !!request && !!anchor)

  useEffect(() => {
    if (!request) return
    if (!request.clickOnly) confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        respond(false)
      } else if (e.key === 'Enter' && !request.clickOnly) {
        e.preventDefault()
        respond(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [request, respond])

  if (!request) return null

  const danger = request.danger ?? true

  const card = (
    <div
      ref={cardRef}
      role="alertdialog"
      aria-label={request.title}
      data-confirm-dialog
      style={anchor ? { position: 'fixed', left: 0, top: 0 } : undefined}
      className={`animate-menu-pop-in surface-overlay w-[420px] max-w-[90vw] overflow-hidden rounded-xl [-webkit-app-region:no-drag] ${
        anchor ? 'z-[101]' : ''
      }`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-4 pt-4 pb-3">
        <h2 className="text-sm font-semibold text-zinc-100">{request.title}</h2>
        {(request.project || request.files) && (
          <div data-confirm-project className="mt-3 overflow-hidden rounded-lg border border-white/10 bg-black/20">
            {request.project && (
              <div className="flex items-center gap-2.5 px-3 py-2.5">
                <div className="grid size-8 shrink-0 place-items-center rounded-md bg-sky-500/15 text-sky-300">
                  <FolderOpen size={16} />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-zinc-100">{request.project.name}</div>
                  {request.project.detail && (
                    <div title={request.project.detail} className="truncate font-mono text-[11px] leading-4 text-zinc-500">
                      {request.project.detail}
                    </div>
                  )}
                </div>
              </div>
            )}
            {request.files && request.files.length > 0 && (
              <div className={`max-h-40 overflow-y-auto px-3 py-1.5 ${request.project ? 'border-t border-white/5' : ''}`}>
                {request.files.map((f, i) => (
                  <div key={`${f.kind}:${f.name}:${i}`} className="flex items-center gap-2 py-1 text-sm text-zinc-300">
                    {f.kind === 'scene' ? (
                      <UnitySceneIcon size={14} className="shrink-0 text-zinc-400" />
                    ) : f.kind === 'prefab' ? (
                      <UnityPrefabIcon size={14} className="shrink-0 text-sky-300" />
                    ) : (
                      <File size={14} className="shrink-0 text-zinc-400" />
                    )}
                    <span title={f.name} className="truncate">{f.name}</span>
                    {f.note && <span className="shrink-0 text-xs text-zinc-500">{f.note}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {request.message && (
          <p className={`whitespace-pre-line text-sm leading-relaxed text-zinc-400 ${request.project || request.files ? 'mt-3' : 'mt-1.5'}`}>
            {request.message}
          </p>
        )}
        {request.items && request.items.length > 0 && (
          <div
            data-confirm-items
            className="mt-2.5 max-h-32 overflow-y-auto rounded border border-white/10 bg-black/20 px-2.5 py-1.5"
          >
            {request.items.map((item) => (
              <div key={item} title={item} className="truncate font-mono text-xs leading-5 text-zinc-300">
                {item}
              </div>
            ))}
          </div>
        )}
        {request.checkbox && (
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-zinc-300 select-none">
            <Checkbox
              checked={checked}
              onChange={(value) => {
                setChecked(value)
                request.checkbox?.onChange?.(value)
              }}
            />
            {request.checkbox.label}
          </label>
        )}
      </div>
      <div className="flex justify-end gap-2 px-4 pb-4 pt-1">
        {!request.hideCancel && (
          <button
            onClick={() => respond(false)}
            className="rounded px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-white/10 hover:text-white"
          >
            {request.cancelLabel ?? 'Cancel'}
          </button>
        )}
        {request.secondaryLabel && (
          <button
            onClick={() => respond('secondary')}
            className="rounded px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-white/10 hover:text-white"
          >
            {request.secondaryLabel}
          </button>
        )}
        <button
          ref={confirmRef}
          onClick={() => respond(true)}
          className={`rounded px-3 py-1.5 text-sm font-medium text-white focus:outline-none ${
            danger
              ? 'bg-red-600 hover:bg-red-500'
              : 'bg-sky-600 hover:bg-sky-500'
          }`}
        >
          {request.confirmLabel ?? 'Confirm'}
        </button>
      </div>
    </div>
  )

  if (anchor) {
    return (
      <div className="fixed inset-0 z-[100] [-webkit-app-region:no-drag]" onMouseDown={() => respond(false)}>
        {card}
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 [-webkit-app-region:no-drag]"
      onMouseDown={() => respond(false)}
    >
      {card}
    </div>
  )
}
