import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Box, Boxes, ChevronDown, CornerDownLeft, FileBox, Pencil, Play, X } from 'lucide-react'
import type { AgentId } from '@shared/types'
import { AnchoredLayer } from '../ui/AnchoredLayer'
import { useDismiss } from '../ui/useDismiss'
import { AgentIcon } from '../../lib/agent-icon'
import { DriftGlyph, type DriftMood } from './DriftGlyph'
import { AskDriftPicker, type AskDriftTo } from './AskDriftPicker'
import { isMobileLayout, useMobileBack } from '../../lib/mobile/mobile-back'

export type { AskDriftTo } from './AskDriftPicker'

export type AskDriftChipKind = 'view' | 'object' | 'asset' | 'play' | 'edit'

export interface AskDriftChip {
  id: string
  kind: AskDriftChipKind
  label: string
  title?: string
  fixed?: boolean
}

export interface AskDriftTarget {
  ptyId: string
  label: string
  agentId?: AgentId | null
}

export type AskDriftResult = { sent: true; note: string } | { sent: false; error: string }

const CHIP_ICON: Record<AskDriftChipKind, ReactNode> = {
  view: <Boxes className="h-3 w-3 text-accent" />,
  object: <Box className="h-3 w-3" />,
  asset: <FileBox className="h-3 w-3" />,
  play: <Play className="h-3 w-3" />,
  edit: <Pencil className="h-3 w-3" />
}

type Phase = 'ask' | 'sending' | 'sent'

export interface AskDriftSuggestion {
  id: string
  label: string
  icon?: ReactNode
  run: () => void
}

let suggestions: AskDriftSuggestion[] = []
const suggestionListeners = new Set<() => void>()

export function setAskDriftSuggestions(list: AskDriftSuggestion[]): () => void {
  suggestions = list
  suggestionListeners.forEach((f) => f())
  return () => {
    if (suggestions !== list) return
    suggestions = []
    suggestionListeners.forEach((f) => f())
  }
}

function useSuggestions(): AskDriftSuggestion[] {
  return useSyncExternalStore(
    (f) => {
      suggestionListeners.add(f)
      return () => suggestionListeners.delete(f)
    },
    () => suggestions
  )
}

export function AskDriftButton({
  target,
  workspaceId,
  chips,
  open,
  onOpenChange,
  onSend
}: {
  target: AskDriftTarget | null
  workspaceId: string
  chips: AskDriftChip[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSend: (text: string, chips: AskDriftChip[], to: AskDriftTo) => Promise<AskDriftResult>
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null)
  const [hover, setHover] = useState(false)
  useDismiss(wrapRef, () => onOpenChange(false), open)
  const mood: DriftMood = open || hover ? 'curious' : 'idle'
  return (
    <div ref={wrapRef} className="flex shrink-0 items-center pl-1 pr-2">
      <button
        ref={setBtn}
        type="button"
        data-tuner-ask
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => onOpenChange(!open)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        data-ti-tip="Ask Drift about this Tuner (/)"
        className={`group flex h-6 items-center gap-1.5 whitespace-nowrap rounded pl-1.5 pr-2 text-xs transition-colors active:scale-[0.98] ${
          open ? 'bg-white/[0.08] text-ink' : 'text-ink-2 hover:bg-white/[0.06] hover:text-ink'
        }`}
      >
        <DriftGlyph mood={mood} cell={2} crop outline={false} still />
        Ask Drift
      </button>
      {open && <AskDriftWindow anchor={btn} target={target} workspaceId={workspaceId} chips={chips} onClose={() => onOpenChange(false)} onSend={onSend} />}
    </div>
  )
}

function AskDriftWindow({
  anchor,
  target,
  workspaceId,
  chips,
  onClose,
  onSend
}: {
  anchor: HTMLElement | null
  target: AskDriftTarget | null
  workspaceId: string
  chips: AskDriftChip[]
  onClose: () => void
  onSend: (text: string, chips: AskDriftChip[], to: AskDriftTo) => Promise<AskDriftResult>
}) {
  const [text, setText] = useState('')
  const picks = useSuggestions()
  const [dropped, setDropped] = useState<string[]>([])
  const [phase, setPhase] = useState<Phase>('ask')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [picker, setPicker] = useState<HTMLElement | null>(null)
  const askRef = useRef<HTMLButtonElement>(null)
  const toRef = useRef<HTMLButtonElement>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const kept = chips.filter((c) => c.fixed || !dropped.includes(c.id))
  const ready = text.trim().length > 0 && phase === 'ask'

  const docked = isMobileLayout()
  const dockRef = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(() => window.innerWidth > window.innerHeight)
  useEffect(() => {
    if (!docked) return
    const onResize = (): void => setWide(window.innerWidth > window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [docked])
  useEffect(() => {
    if (docked) return
    const t = window.setTimeout(() => fieldRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [docked])

  useLayoutEffect(() => {
    const el = dockRef.current
    if (!docked || !el) return
    const root = document.documentElement.style
    const vv = window.visualViewport
    const note = (): void => {
      const card = el.getBoundingClientRect()
      const frame = document.querySelector('.remote-tuner [data-tuner-ask][aria-expanded="true"]')?.closest('.remote-tuner')?.querySelector('[data-tuner-phone-stack], [data-tuner-phone-columns]')
      const box = frame?.getBoundingClientRect()
      const side = window.innerWidth > window.innerHeight
      const pan = vv ? Math.max(0, Math.round(vv.offsetTop)) : 0
      const shown = vv ? vv.offsetTop + vv.height : window.innerHeight
      const room = Math.round(shown - pan - 16)
      root.setProperty('--remote-ask-pan', `${pan}px`)
      root.setProperty('--remote-ask-room', el.scrollHeight > room ? `${room}px` : 'none')
      root.setProperty('--remote-ask-dock', side || !box ? '0px' : `${Math.max(0, Math.round(card.bottom - pan - box.top + 8))}px`)
      root.setProperty('--remote-ask-dock-x', side && box ? `${Math.max(0, Math.round(card.right - box.left + 8))}px` : '0px')
      root.setProperty('--remote-ask-cover', `${box ? Math.max(0, Math.round(box.bottom - shown)) : 0}px`)
    }
    let settle = 0
    const later = (): void => {
      note()
      window.clearTimeout(settle)
      settle = window.setTimeout(note, 300)
    }
    note()
    const ro = new ResizeObserver(later)
    ro.observe(el)
    vv?.addEventListener('resize', later)
    vv?.addEventListener('scroll', later)
    window.addEventListener('resize', later)
    window.addEventListener('scroll', later, true)
    return () => {
      window.clearTimeout(settle)
      ro.disconnect()
      vv?.removeEventListener('resize', later)
      vv?.removeEventListener('scroll', later)
      window.removeEventListener('resize', later)
      window.removeEventListener('scroll', later, true)
      const active = document.activeElement
      if (active instanceof HTMLElement && el.contains(active)) active.blur()
      root.removeProperty('--remote-ask-dock')
      root.removeProperty('--remote-ask-dock-x')
      root.removeProperty('--remote-ask-cover')
      root.removeProperty('--remote-ask-pan')
      root.removeProperty('--remote-ask-room')
    }
  }, [docked, wide])

  useEffect(() => {
    if (docked && phase !== 'ask') fieldRef.current?.blur()
  }, [docked, phase])

  useEffect(() => {
    const el = fieldRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text, phase])

  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useMobileBack(() => closeRef.current(), 'Ask Drift')
  useEffect(() => {
    if (phase !== 'sent') return
    const t = window.setTimeout(() => closeRef.current(), 1800)
    return () => window.clearTimeout(t)
  }, [phase])

  const deliver = (to: AskDriftTo): void => {
    const ask = text.trim()
    setPicker(null)
    if (!ask || phase !== 'ask') {
      if (!ask) setError('Write your question first, then pick who gets it.')
      fieldRef.current?.focus()
      return
    }
    setPhase('sending')
    setError('')
    void onSend(ask, kept, to).then(
      (r) => {
        if (r.sent) {
          setNote(r.note)
          setText('')
          setPhase('sent')
          return
        }
        setError(r.error)
        setPhase('ask')
        fieldRef.current?.focus()
      },
      () => {
        setError('That did not go through. Try again.')
        setPhase('ask')
      }
    )
  }

  const ask = (): void => {
    if (!text.trim() || phase !== 'ask') return
    if (target) deliver({ kind: 'agent', ptyId: target.ptyId })
    else setPicker(askRef.current)
  }
  const closePicker = useCallback(() => {
    setPicker(null)
    fieldRef.current?.focus()
  }, [])

  const mood: DriftMood = phase === 'sent' ? 'wave' : text ? 'listening' : 'idle'

  const body = (
    <>
      <div role="dialog" aria-label="Ask Drift" data-tuner-ask-window={phase}>
        {phase === 'sent' ? (
          <div className="flex flex-col items-center px-6 pb-5 pt-6 text-center">
            <DriftGlyph mood={mood} cell={4} />
            <div className="mt-3 text-sm font-medium text-ink" data-tuner-ask-done>
              Drift is on the way
            </div>
            <div className="mt-1 max-w-[280px] text-xs leading-5 text-ink-2">{note}</div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              ask()
            }}
          >
            <div className={`flex items-center gap-3 px-4 ${docked ? 'pb-2 pt-3' : 'pb-3 pt-4'}`}>
              <div className={`flex shrink-0 items-center justify-center rounded-lg bg-[#8aa4ff]/[0.08] ${docked ? 'h-11 w-11' : 'h-16 w-16'}`}>
                <DriftGlyph mood={mood} cell={docked ? 4 : 6} crop follow pettable />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink">Ask Drift</div>
                <div className="mt-0.5 text-xs leading-4 text-ink-2">{picks.length > 0 ? "Pick one and Drift will show you." : "Ask anything and Drift will show you."}</div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center self-start rounded text-ink-3 hover:bg-white/[0.06] hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {picks.length > 0 && (
              <div className="flex flex-col gap-1.5 px-3 pb-3" data-tuner-ask-picks>
                {picks.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    data-tuner-ask-pick={s.id}
                    onClick={() => {
                      onClose()
                      s.run()
                    }}
                    className="flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-md bg-white/[0.06] px-3 py-2 text-sm font-medium text-ink shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] transition-[background,transform] hover:bg-white/[0.1] active:scale-[0.98]"
                  >
                    {s.icon}
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            {picks.length === 0 && (
              <>
              <div className="px-3">
                <div className="rounded-md bg-sunken shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_rgb(129_150_255/0.55)]">
                  <textarea
                    ref={fieldRef}
                    data-tuner-ask-input
                    data-popup-focus
                    rows={2}
                    value={text}
                    disabled={phase !== 'ask'}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        ask()
                      }
                    }}
                    placeholder="Why does it float? Make the light warmer…"
                    className="block max-h-40 min-h-[52px] w-full resize-none bg-transparent px-3 pt-2.5 text-sm leading-5 text-ink outline-none placeholder:text-ink-4"
                  />
                  {kept.length > 0 && (
                    <div className="flex flex-wrap gap-1 px-2 pb-2 pt-1" data-tuner-ask-chips>
                      {kept.map((c) => (
                        <span
                          key={c.id}
                          data-tuner-ask-chip={c.kind}
                          title={c.title ?? c.label}
                          className="inline-flex h-6 max-w-full items-center gap-1 rounded bg-white/[0.06] pl-1.5 pr-1 text-xs text-ink-2"
                        >
                          <span className="shrink-0 text-ink-3">{CHIP_ICON[c.kind]}</span>
                          <span className="truncate">{c.label}</span>
                          {c.fixed ? (
                            <span className="w-0.5" />
                          ) : (
                            <button
                              type="button"
                              aria-label={`Leave out ${c.label}`}
                              onClick={() => {
                                setDropped((d) => [...d, c.id])
                                fieldRef.current?.focus()
                              }}
                              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-white/10 hover:text-ink"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {error && (
                <div className="px-4 pt-2 text-xs leading-4 text-warn" data-tuner-ask-error>
                  {error}
                </div>
              )}
              <div className="flex items-center gap-2 px-3 pb-3 pt-3">
                <div className="min-w-0 flex-1">
                  {target && (
                    <button
                      ref={toRef}
                      type="button"
                      data-tuner-ask-to
                      aria-haspopup="menu"
                      aria-expanded={!!picker && picker === toRef.current}
                      onClick={() => setPicker((p) => (p ? null : toRef.current))}
                      title="Send it to another agent"
                      className="flex h-7 max-w-full items-center gap-1.5 rounded px-1.5 text-xs text-ink-3 hover:bg-white/[0.06] hover:text-ink-2"
                    >
                      To
                      {target.agentId && <AgentIcon id={target.agentId} className="h-3.5 w-3.5" />}
                      <span className="truncate text-ink-2">{target.label}</span>
                      <ChevronDown className="h-3 w-3 shrink-0" />
                    </button>
                  )}
                </div>
                <button
                  ref={askRef}
                  type="submit"
                  data-tuner-ask-send
                  disabled={!ready}
                  title={target ? 'Enter asks, Shift+Enter adds a line' : 'Pick which agent gets it'}
                  className="flex h-7 shrink-0 items-center gap-1.5 rounded bg-accent pl-3 pr-2 text-xs font-medium text-accent-fg transition-[filter] enabled:hover:brightness-110 disabled:bg-white/[0.06] disabled:text-ink-4"
                >
                  {phase === 'sending' ? 'Asking' : 'Ask'}
                  {target ? <CornerDownLeft className="h-3.5 w-3.5 opacity-70" /> : <ChevronDown className="h-3.5 w-3.5 opacity-70" />}
                </button>
              </div>
              </>
            )}
          </form>
        )}
      </div>
      {picker && <AskDriftPicker anchor={picker} workspaceId={workspaceId} current={target?.ptyId ?? ''} onPick={deliver} onClose={closePicker} />}
    </>
  )

  if (docked)
    return createPortal(
      <div
        ref={dockRef}
        data-menu-layer
        data-tuner-ask-dock
        className={`animate-menu-pop-in surface-overlay fixed z-[70] max-w-[440px] rounded-xl text-ink ${wide ? 'origin-top-left' : 'mx-auto origin-top'}`}
        style={
          wide
            ? { top: 'calc(var(--remote-top, 0px) + var(--remote-ask-pan, 0px) + 8px)', left: 'calc(var(--remote-left, 0px) + 8px)', width: 'min(440px, 46vw)', maxHeight: 'var(--remote-ask-room, none)', overflowY: 'auto' }
            : { top: 'calc(var(--remote-top, 0px) + var(--remote-ask-pan, 0px) + 8px)', left: 'calc(var(--remote-left, 0px) + 8px)', right: 'calc(var(--remote-right, 0px) + 8px)', maxHeight: 'var(--remote-ask-room, none)', overflowY: 'auto' }
        }
      >
        {body}
      </div>,
      document.body
    )

  return (
    <AnchoredLayer
      anchor={anchor}
      side="bottom"
      align="end"
      gap={6}
      className="animate-menu-pop-in surface-overlay w-[360px] max-w-[calc(100vw-16px)] origin-top-right rounded-xl text-ink"
    >
      {body}
    </AnchoredLayer>
  )
}
