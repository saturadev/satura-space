import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { ChevronLeft, CircleChevronDown, CornerDownLeft, Ellipsis, Folder, History, Keyboard, KeyboardOff, Layers, ListFilter, CircleX } from 'lucide-react'
import { listMacs, pathHostId } from '../macs'
import { DesktopTile } from '../desktop-art'
import type { WireAction } from '../../lib/actions/action-tree'
import { call, checkedOf, goBack, haptic, openFiles, perform, readClipboard, run, selectTab, sendKey, setComposer, showToast, startTyping, stopTyping, useShell, type Chip, type Panel, type Workspace } from './bridge'
import { CHIP_ICON, Sym } from './icons'
import { openMenu } from './menus'
import { StatusDot } from './lists'
import { useView, type View } from './viewport'
import { FilesScreen } from './files'
import { Presence, ProgressBar, useStageProgress } from '../motion'
import type { InputBox } from '../claude-input'
import { StreamBadge } from '../video/StreamBadge'
import { useVideoViewing } from '../video/link'
import { AttachKey, AttachStrip, hasShots, openAttach, pastedImages, sendShots } from './attach'

const CHECKED_BLUE = 'rgb(94 176 255)'

function leaves(nodes: WireAction[]): WireAction[] {
  return nodes.flatMap((n) => (n.children ? leaves(n.children) : [n]))
}

export function primaryActions(panel: Panel | null | undefined): WireAction[] {
  return panel ? leaves(panel.actions).filter((a) => a.primary).slice(0, 4) : []
}

function filterBarOf(panel: Panel | null | undefined): WireAction | null {
  return panel?.actions.find((a) => a.bar && a.inline) ?? null
}

function titleMenu(panel: Panel | null | undefined): WireAction[] {
  if (!panel) return []
  const out: WireAction[] = []
  if (panel.tabActions.length) out.push({ id: 'ws.section.tab', label: 'This tab', enabled: true, inline: true, children: panel.tabActions })
  if (panel.kind !== 'layout' && panel.workspaceActions.length) out.push({ id: 'ws.section.workspace', label: 'Workspace', enabled: true, inline: true, children: panel.workspaceActions })
  return out
}

function noFocus(e: { preventDefault: () => void }): void {
  e.preventDefault()
}

function GlassCircle({ label, size = 30, onClick, pending, disabled, children, data }: { label: string; size?: number; onClick: (el: HTMLButtonElement) => void; pending?: boolean; disabled?: boolean; children: ReactNode; data?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onMouseDown={noFocus}
      onClick={(e) => onClick(e.currentTarget)}
      className={`ws-glass ws-press flex shrink-0 items-center justify-center rounded-full ${pending ? 'remote-pending' : ''}`}
      style={{ width: size, height: size }}
      data-ws-button={data ?? label}
    >
      {children}
    </button>
  )
}

function backLabel(ws: Workspace | null): { parent: string; a11y: string } {
  const stack = ws?.panel?.stack ?? []
  const parent = stack.length >= 2 ? stack[stack.length - 2] : ws?.title || 'Back'
  const a11y = !stack.length ? (ws?.panel?.canBack ? 'Back' : 'Projects') : `Back to ${parent}`
  return { parent, a11y }
}

function BackButton({ ws }: { ws: Workspace | null }) {
  const stack = ws?.panel?.stack ?? []
  const { parent, a11y } = backLabel(ws)
  if (stack.length && parent.length <= 9)
    return (
      <button type="button" aria-label={a11y} onClick={goBack} className="ws-glass ws-press flex h-[30px] shrink-0 items-center gap-0.5 rounded-full pl-2 pr-2.5 text-[12px] font-medium" data-ws-back>
        <ChevronLeft size={15} strokeWidth={2.8} />
        {parent}
      </button>
    )
  return (
    <GlassCircle label={a11y} onClick={goBack} data="back">
      <ChevronLeft size={17} strokeWidth={2.6} />
    </GlassCircle>
  )
}

function NavBar({ ws, view }: { ws: Workspace | null; view: View }) {
  const pending = useShell((s) => s.pending)
  const optimistic = useShell((s) => s.optimistic)
  const fallbackTitle = useShell((s) => s.projects.find((p) => p.id === s.openId)?.title ?? '')
  const panel = ws?.panel
  const title = panel?.stack.length ? panel.stack[panel.stack.length - 1] : ws?.title || ws?.project || fallbackTitle
  const menu = titleMenu(panel)
  const manyMacs = useState(() => listMacs().length > 1)[0]
  const primaries = panel && panel.composer !== 'terminal' ? primaryActions(panel).slice(0, 3) : []
  const viewing = useVideoViewing()
  return (
    <div className="flex h-[42px] items-center gap-1.5" style={{ paddingLeft: view.corner ? 18 : 10, paddingRight: view.corner ? 18 : 10 }} data-ws-navbar>
      <BackButton ws={ws} />
      <div className="flex min-w-0 flex-1 items-center">
        {manyMacs && <DesktopTile hostId={pathHostId() ?? ''} size={20} tone="ok" />}
        {menu.length ? (
          <button type="button" className="flex min-w-0 items-center gap-1 rounded-full px-1.5 py-1 active:bg-white/[0.08]" onClick={(e) => openMenu(menu, title, e.currentTarget)} data-ws-title>
            <span className="truncate text-[13px] font-semibold">{title}</span>
            <CircleChevronDown size={13} strokeWidth={2.4} className="shrink-0 text-[var(--ws-label2)]" />
          </button>
        ) : (
          <span className="truncate px-1.5 text-[13px] font-semibold" data-ws-title>
            {title}
          </span>
        )}
      </div>
      {viewing && <StreamBadge />}
      {primaries.length > 0 && (
        <div className="ws-glass flex h-[30px] shrink-0 items-center rounded-full px-[3px]" data-ws-primaries>
          {primaries.map((a) => (
            <button
              key={a.id}
              type="button"
              aria-label={a.label}
              disabled={!a.enabled}
              onClick={() => perform(a)}
              className={`ws-press flex h-[30px] min-w-[30px] items-center justify-center rounded-full px-1 disabled:opacity-40 ${pending[`panel:${a.id}`] ? 'remote-pending' : ''}`}
              style={{ color: checkedOf(optimistic, a) === true ? CHECKED_BLUE : 'var(--ws-ink)' }}
              data-ws-primary={a.id}
            >
              {a.icon ? <Sym name={a.icon} size={15} stroke={2.4} fallback /> : <span className="px-1.5 text-[13px] font-semibold">{a.label}</span>}
            </button>
          ))}
        </div>
      )}
      {ws?.root && (
        <GlassCircle label="Files" onClick={openFiles} data="files">
          <Folder size={16} strokeWidth={2.4} />
        </GlassCircle>
      )}
      {panel && panel.actions.length > 0 && (
        <GlassCircle label="More actions" onClick={(el) => openMenu(panel.actions, '', el)} data="more">
          <Ellipsis size={17} strokeWidth={2.6} />
        </GlassCircle>
      )}
    </div>
  )
}

function openRestore(ws: Workspace): void {
  const r = ws.restore
  if (!r) return
  console.info(`[web-shell] restore prompt strip tapped in ${ws.title}: ${r.tabId ? `showing tab ${r.tabId}` : 'no held tab to show'}`)
  if (!r.tabId) return showToast("The phone doesn't have the Claude tab this question holds yet. Try again in a moment, or answer it on the desktop.")
  selectTab(r.tabId)
}

function RestoreStrip({ ws, view }: { ws: Workspace; view: View }) {
  const r = ws.restore
  const pending = useShell((s) => !!(r?.tabId && s.pending[`tab:${r.tabId}`]))
  if (!r) return null
  return (
    <div style={{ paddingLeft: view.corner ? 18 : 10, paddingRight: view.corner ? 18 : 10 }}>
      <button
        type="button"
        onClick={() => openRestore(ws)}
        disabled={pending}
        className="ws-press flex h-[38px] w-full items-center gap-2.5 rounded-[12px] bg-[rgb(232_165_77/0.16)] px-3 text-left"
        data-ws-restore={r.tabId ?? ''}
        data-ws-restore-pending={pending ? 'true' : undefined}
        data-own-pending
      >
        <StatusDot dot="wait" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{r.title}</span>
        <span className="shrink-0 text-[13px] font-semibold text-[var(--ws-accent)]">{pending ? 'Opening…' : 'Answer'}</span>
      </button>
    </div>
  )
}

function useEdgeFade(ref: RefObject<HTMLElement | null>, deps: unknown[]): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let shown = ''
    const update = (): void => {
      const max = el.scrollWidth - el.clientWidth
      const left = max > 1 && el.scrollLeft > 1
      const right = max > 1 && el.scrollLeft < max - 1
      el.toggleAttribute('data-fade-l', left)
      el.toggleAttribute('data-fade-r', right)
      const now = `${left ? 'left' : ''}${left && right ? ' and ' : ''}${right ? 'right' : ''}` || 'none'
      if (now !== shown && el.dataset.wsKeyrail !== undefined) console.info(`[web-shell] key rail fades: ${now} (scroll ${Math.round(el.scrollLeft)} of ${Math.max(0, Math.round(max))})`)
      shown = now
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    const mo = new MutationObserver(update)
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
      mo.disconnect()
    }
  }, deps)
}

function ChipView({ c, selected, outlined }: { c: Chip; selected: boolean; outlined: boolean }) {
  const pending = useShell((s) => !!s.pending[`tab:${c.id}`])
  const lit = !!c.attn && !selected
  return (
    <button
      type="button"
      onClick={() => selectTab(c.id)}
      aria-pressed={selected}
      className={`ws-press relative flex h-[26px] shrink-0 items-center gap-[7px] rounded-full pl-2 pr-2.5 text-[12px] font-semibold ${selected ? 'bg-[var(--ws-ink)] text-[#0f0f12]' : 'ws-glass text-[var(--ws-ink)]'} ${pending ? 'remote-pending' : ''}`}
      data-ws-chip={c.id}
      data-ws-attn={lit ? '' : undefined}
    >
      {c.dot ? <StatusDot dot={c.dot} /> : <Sym name={CHIP_ICON[c.kind] ?? 'circle'} size={13} stroke={2.4} />}
      <span className="whitespace-nowrap">{c.label}</span>
      {c.badge && <span className="flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-[#ff9f0a] px-1 text-[11px] font-bold text-black">{c.badge}</span>}
      {outlined && !lit && <span aria-hidden className="pointer-events-none absolute inset-0 rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255/0.32)]" />}
      {lit && <span aria-hidden className="pointer-events-none absolute inset-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--ws-accent),0_0_10px_-2px_var(--ws-accent)]" />}
    </button>
  )
}

function Chips({ ws }: { ws: Workspace }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const selecting = useShell((s) => s.selecting)
  const selected = selecting ?? ws.selected
  const groups = ws.groups.length ? ws.groups : [{ id: '', name: '', count: ws.tabs.length, focused: true }]
  const many = groups.length > 1
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-ws-chip="${CSS.escape(selected ?? '')}"]`)
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [selected])
  useEdgeFade(ref, [])
  const hidden = useHiddenAttn(ref)
  const reveal = (side: 'l' | 'r'): void => {
    const el = ref.current
    if (!el) return
    const box = el.getBoundingClientRect()
    const lit = [...el.querySelectorAll<HTMLElement>('[data-ws-attn]')].filter((c) => (side === 'l' ? c.getBoundingClientRect().left < box.left : c.getBoundingClientRect().right > box.right))
    const chip = side === 'l' ? lit[lit.length - 1] : lit[0]
    chip?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }
  const glow = (side: 'l' | 'r'): ReactNode => (
    <button
      type="button"
      aria-label={side === 'l' ? 'News in a tab to the left' : 'News in a tab to the right'}
      onClick={() => reveal(side)}
      className={`absolute inset-y-0 z-[1] w-[22px] ${side === 'l' ? 'left-0' : 'right-0'}`}
      style={{ background: `linear-gradient(to ${side === 'l' ? 'right' : 'left'}, color-mix(in srgb, var(--ws-accent) 42%, transparent), transparent)` }}
      data-ws-attn-edge={side}
    />
  )
  return (
    <div className="relative">
      {hidden.l && glow('l')}
      {hidden.r && glow('r')}
      <div ref={ref} className="ws-hscroll flex items-center gap-1.5 px-2.5 py-0.5" data-ws-chips>
        {groups.map((g, gi) => (
          <div key={g.id || gi} className="contents">
            {gi > 0 && <span aria-hidden className="mx-1 h-[22px] w-px shrink-0 bg-white/[0.16]" />}
            {many && (
              <span className={`flex shrink-0 items-center gap-[3px] pr-0.5 ${g.focused ? 'text-[var(--ws-accent)]' : 'text-[var(--ws-label3)]'}`} aria-label={`Group ${gi + 1}`}>
                <Sym name="rectangle.split.2x1" size={11} stroke={2.6} />
                <span className="text-[11px] font-bold" style={{ fontFamily: 'ui-rounded, -apple-system, system-ui, sans-serif' }}>
                  {gi + 1}
                </span>
              </span>
            )}
            {ws.tabs
              .filter((c) => !many || c.group === g.id)
              .map((c) => (
                <ChipView key={c.id} c={c} selected={c.id === selected} outlined={many && c.groupActive && c.id !== selected} />
              ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function useHiddenAttn(ref: RefObject<HTMLElement | null>): { l: boolean; r: boolean } {
  const [hidden, setHidden] = useState({ l: false, r: false })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => {
      const box = el.getBoundingClientRect()
      let l = false
      let r = false
      for (const c of el.querySelectorAll<HTMLElement>('[data-ws-attn]')) {
        const at = c.getBoundingClientRect()
        const mid = (at.left + at.right) / 2
        if (mid < box.left + 12) l = true
        if (mid > box.right - 12) r = true
      }
      setHidden((was) => {
        if (was.l === l && was.r === r) return was
        console.info(`[web-shell] tabs with news off screen: ${l ? 'left' : ''}${l && r ? ' and ' : ''}${r ? 'right' : ''}${l || r ? '' : 'none'}`)
        return { l, r }
      })
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    const mo = new MutationObserver(update)
    mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ws-attn'] })
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
      mo.disconnect()
    }
  }, [])
  return hidden
}

function FilterBar({ section }: { section: WireAction }) {
  const pending = useShell((s) => s.pending)
  const optimistic = useShell((s) => s.optimistic)
  const field = section.children?.find((c) => !!c.input) ?? null
  const toggles = (section.children ?? []).filter((c) => c.checked !== undefined && c.checked !== null && !c.input && !c.children)
  const initial = field?.input?.initial ?? ''
  const [text, setText] = useState(initial)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(initial)
  }, [initial, focused])
  const apply = (value: string): void => {
    if (field && value !== initial) perform(field, value)
  }
  return (
    <div className="flex items-center gap-1.5 px-3" data-ws-filterbar>
      {field && (
        <form
          className={`ws-glass flex h-[34px] min-w-0 flex-1 items-center gap-1.5 rounded-full px-2.5 ${pending[`panel:${field.id}`] ? 'remote-pending' : ''}`}
          onSubmit={(e) => {
            e.preventDefault()
            apply(text)
            ;(document.activeElement as HTMLElement | null)?.blur()
          }}
        >
          <ListFilter size={13} strokeWidth={2.6} className="shrink-0 opacity-60" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={field.input?.placeholder || 'Filter'}
            enterKeyHint="search"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="ws-field min-w-0 flex-1 bg-transparent text-[var(--ws-ink)] outline-none"
            style={{ fontSize: 16 }}
            data-ws-filter-field
          />
          {text && (
            <button
              type="button"
              aria-label="Clear"
              onClick={() => {
                setText('')
                apply('')
              }}
              className="shrink-0 opacity-50"
            >
              <CircleX size={16} strokeWidth={2.4} />
            </button>
          )}
        </form>
      )}
      {toggles.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-label={t.label}
          onClick={() => {
            haptic()
            perform(t)
          }}
          aria-pressed={!!checkedOf(optimistic, t)}
          className={`ws-press flex h-[34px] shrink-0 items-center gap-1 rounded-full px-[9px] font-mono text-[12px] font-semibold ${checkedOf(optimistic, t) ? 'bg-[var(--ws-ink)] text-[#0f0f12]' : 'ws-glass text-[rgb(229_231_235/0.55)]'} ${pending[`panel:${t.id}`] ? 'remote-pending' : ''}`}
          data-ws-toggle={t.id}
        >
          {t.icon && <Sym name={t.icon} size={11} stroke={2.6} />}
          {t.label.split(' ').pop()}
        </button>
      ))}
    </div>
  )
}

interface KeySpec {
  name: string
  label: string
  mono?: boolean
}

const NORMAL_KEYS: KeySpec[] = [
  { name: 'esc', label: 'esc' },
  { name: 'ctrl', label: 'ctrl' },
  { name: 'tab', label: 'tab' },
  { name: 'shift-tab', label: '⇧ tab' },
  { name: 'ctrl-c', label: 'ctrl C' },
  { name: 'slash', label: '/', mono: true },
  { name: 'paste', label: 'paste' },
  { name: 'left', label: '←', mono: true },
  { name: 'up', label: '↑', mono: true },
  { name: 'down', label: '↓', mono: true },
  { name: 'right', label: '→', mono: true }
]

const MENU_KEYS: KeySpec[] = [
  { name: 'esc', label: 'esc' },
  { name: 'up', label: '↑', mono: true },
  { name: 'down', label: '↓', mono: true },
  { name: 'left', label: '←', mono: true },
  { name: 'right', label: '→', mono: true },
  { name: 'enter', label: 'enter' }
]

const GRID_KEY = 'h-11 w-full min-w-0 rounded-[14px]'

function pasteIntoTerminal(): void {
  readClipboard().then(
    (text) => {
      if (!text) return showToast('The clipboard is empty')
      if (!addDraft(text)) return call('paste', text)
      if (!useShell.getState().typing) startTyping()
    },
    () => showToast("The browser didn't share the clipboard. Long-press the text field and choose Paste.")
  )
}

function pressKey(name: string): void {
  if (name === 'paste') return pasteIntoTerminal()
  if (name === 'ctrl') {
    const on = !useShell.getState().ctrl
    if (on && !useShell.getState().typing) startTyping()
    useShell.setState({ ctrl: on })
    return
  }
  sendKey(name)
}

function KeyChip({ spec, wide, cell }: { spec: KeySpec; wide?: boolean; cell?: boolean }) {
  const pending = useShell((s) => !!s.pending[`key:${spec.name}`])
  const on = useShell((s) => spec.name === 'ctrl' && s.ctrl)
  return (
    <button
      type="button"
      onMouseDown={noFocus}
      onClick={() => pressKey(spec.name)}
      className={`ws-press flex items-center justify-center ${cell ? GRID_KEY : `h-7 min-w-9 shrink-0 rounded-full ${wide ? 'px-3.5' : 'px-[9px]'}`} ${spec.mono ? `font-mono ${cell ? 'text-[15px]' : 'text-[12px]'}` : cell ? 'text-[12.5px]' : 'text-[13px]'} font-semibold ${on ? 'bg-[rgb(10_132_255/0.55)]' : 'ws-glass'} ${pending ? 'remote-pending' : ''}`}
      data-ws-key={spec.name}
    >
      {spec.label}
    </button>
  )
}

function SendKey({ size, className }: { size?: number; className?: string }) {
  const pending = useShell((s) => !!s.pending.composer)
  return (
    <button
      type="button"
      aria-label="Send"
      onMouseDown={noFocus}
      onClick={() => sendNow()}
      className={`ws-press flex shrink-0 items-center justify-center bg-[rgb(10_132_255)] text-white ${className ?? 'h-[34px] w-11 rounded-full'} ${pending ? 'remote-pending' : ''}`}
      style={size ? { width: size, height: size, borderRadius: 999 } : undefined}
      data-ws-send
    >
      <CornerDownLeft size={size ? Math.min(17, size * 0.5) : 18} strokeWidth={2.6} />
    </button>
  )
}

function KeyboardToggle({ size, className }: { size?: number; className?: string }) {
  const typing = useShell((s) => s.typing)
  return (
    <button
      type="button"
      aria-label={typing ? 'Hide the keyboard' : 'Show the keyboard'}
      onMouseDown={noFocus}
      onClick={() => (useShell.getState().typing ? stopTyping() : startTyping())}
      className={`ws-glass ws-press flex shrink-0 items-center justify-center ${className ?? 'h-[34px] w-11 rounded-full'}`}
      style={size ? { width: size, height: size, borderRadius: 999 } : undefined}
      data-ws-keyboard={typing ? 'up' : 'down'}
    >
      {typing ? <KeyboardOff size={17} strokeWidth={2.2} /> : <Keyboard size={17} strokeWidth={2.2} />}
    </button>
  )
}

function ctrlChar(ch: string): string | null {
  if (ch === ' ') return '\x00'
  const c = ch.toUpperCase().charCodeAt(0)
  if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c - 0x40)
  return null
}

const HARD_CTRL = new Set(['c', 'd', 'z', 'l', 'r'])
const DETACHED_RULE = 'rgb(136 136 136 / 0.7)'
const MIN_ROWS = 4
const PAD_SHARE = 0.6
const CAP_SETTLE_MS = 700

interface Placement {
  left: number
  top: number
  width: number
  height: number
  rows: number
  pad: number
  cut: number
  detached: boolean
}

function placeOver(box: InputBox, lines: number, fit = 0): Placement {
  const ch = box.ch
  const detached = box.caretY < box.clipTop - 0.5 || box.caretY + ch > box.clipBottom + 0.5
  const all = Math.max(1, Math.floor((box.clipBottom - box.clipTop + 0.5) / ch))
  const below = detached ? 1 : Math.max(1, Math.floor((box.clipBottom - box.caretY + 0.5) / ch))
  const rows = Math.min(Math.max(1, lines), fit > 0 ? fit : Math.max(below, Math.min(MIN_ROWS, all)))
  const height = rows * ch
  const want = !detached ? box.caretY : box.caretY < box.clipTop ? box.clipTop : box.clipBottom - height
  const top = Math.max(box.clipTop, Math.min(want, box.clipBottom - height))
  const attached = !detached && Math.abs(top - box.caretY) < 0.5
  const pad = box.x - box.bx
  return { left: box.bx, top, width: box.bw, height, rows, pad, cut: attached ? pad + Math.max(0, box.caretX - box.x) : 0, detached }
}

function anchored(box: InputBox | null): InputBox | null {
  if (!box || !anchor) return box
  return { ...box, caretX: box.x + anchor.dx, caretY: box.y + anchor.row * box.ch }
}

function padTo(want: number, why: string): void {
  if (want === padded) return
  const pty = useShell.getState().workspace?.panel?.ptyId ?? null
  if (padded && pty !== padPty) {
    console.info(`[web-shell] ${padded} empty lines stay in Claude's input of ${padPty}, the composer now types into ${pty ?? 'no terminal'}`)
    padded = 0
    anchor = null
    return
  }
  const diff = want - padded
  if (call('type', diff > 0 ? '\n'.repeat(diff) : '\x7f'.repeat(-diff)) !== true) return
  console.info(`[web-shell] Claude's input ${diff > 0 ? `gets ${diff} more` : `drops ${-diff}`} empty lines, ${padded + 1} -> ${want + 1} lines, ${why}`)
  padded = want
  padPty = pty
}

function useOverlayBox(): InputBox | null {
  return useShell((s) => {
    const panel = s.workspace?.panel
    const ib = s.inputBox
    if (!s.typing || !ib || !panel || panel.composer !== 'terminal' || panel.ptyId !== ib.ptyId || panel.menu.length) return null
    return ib.box
  })
}

let draft = ''
let padded = 0
let padPty: string | null = null
let anchor: { row: number; dx: number; h: number } | null = null
let sendNow = (): void => {}
let addDraft = (_value: string): boolean => false

function Composer({ landscape }: { landscape: boolean }) {
  const typing = useShell((s) => s.typing)
  const sending = useShell((s) => !!s.pending.composer)
  const raw = useOverlayBox()
  const box = anchored(raw)
  const [text, setTextState] = useState(draft)
  const [lines, setLines] = useState(1)
  const [cap, setCap] = useState(Infinity)
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const rawRef = useRef(raw)
  rawRef.current = raw
  const all = raw ? Math.max(1, Math.floor((raw.clipBottom - raw.clipTop + 0.5) / raw.ch)) : 0
  const room = box ? Math.floor((box.clipBottom - box.caretY + 0.5) / box.ch) - 2 : 0
  const padWant = raw ? Math.max(0, Math.min(lines - 1, Math.floor(all * PAD_SHARE), cap - 1, room)) : 0
  const fit = anchor ? padWant + 1 : 0
  const place = box ? placeOver(box, lines, fit) : null
  const setText = (value: string): void => {
    draft = value
    setTextState(value)
  }
  useLayoutEffect(() => {
    const el = ref.current
    setComposer(el)
    if (el && useShell.getState().typing) {
      el.focus({ preventScroll: true })
      const kept = document.activeElement === el
      console.info(`[web-shell] composer moved to the ${landscape ? 'landscape' : 'portrait'} layout${draft ? ` with ${draft.length} chars` : ''}, ${kept ? 'still typing' : 'keyboard closed'}`)
      if (!kept) useShell.setState({ typing: false, ctrl: false })
    }
    return () => {
      setComposer(null)
      addDraft = () => false
    }
  }, [])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const kept = el.scrollTop
    const atEnd = document.activeElement === el && el.selectionEnd === el.value.length
    el.style.height = '0px'
    if (box && place) {
      const n = Math.max(1, Math.round(el.scrollHeight / box.ch))
      el.style.height = `${placeOver(box, n, fit).height}px`
      if (n !== lines) setLines(n)
    } else el.style.height = `${Math.min(120, Math.max(22, el.scrollHeight))}px`
    el.scrollTop = atEnd ? el.scrollHeight : kept
  }, [text, typing, box, fit, place?.cut, place?.pad, place?.width])
  useEffect(() => {
    if (!raw) {
      if (!typing) padTo(0, 'the keyboard closed')
      return
    }
    if (!padded && anchor && raw.h <= anchor.h + 0.5) {
      anchor = null
      if (cap !== Infinity) setCap(Infinity)
    }
    if (padWant > 0 && !anchor) anchor = { row: Math.max(0, Math.round((raw.caretY - raw.y) / raw.ch)), dx: Math.max(0, raw.caretX - raw.x), h: raw.h }
    padTo(padWant, `the composer has ${lines} lines`)
    if (!padded || !anchor) return
    const t = window.setTimeout(() => {
      const b = rawRef.current
      if (!b || !anchor) return
      const shown = Math.max(1, Math.round(b.h / b.ch) - anchor.row)
      if (shown >= padded + 1) return
      console.info(`[web-shell] Claude's input stops growing at ${shown} lines with ${padded + 1} in it, the composer scrolls past that`)
      padTo(shown - 1, "Claude's input is at its full height")
      setCap(shown)
    }, CAP_SETTLE_MS)
    return () => window.clearTimeout(t)
  }, [padWant, typing, !!raw, raw?.h])
  const where = place ? (place.detached ? 'detached' : 'over') : 'docked'
  useEffect(() => {
    if (!typing) return
    if (!box || !place) return console.info('[web-shell] composer docked above the key rail')
    console.info(`[web-shell] composer ${where === 'over' ? "over Claude's input line" : "detached from Claude's input line, which is scrolled out of view"} at ${Math.round(place.left)},${Math.round(place.top)} ${Math.round(place.width)}x${Math.round(place.height)}, Claude's caret ${Math.round(box.caretX)},${Math.round(box.caretY)}`)
  }, [typing, where])
  const send = (): void => {
    const value = text
    if (value || hasShots()) padTo(0, 'the composer sends')
    if (hasShots()) {
      setText('')
      void sendShots(value, setText)
      return
    }
    if (!value) {
      sendKey('enter', 'composer')
      return
    }
    setText('')
    console.info(`[web-shell] composer sends ${value.length} chars then Enter`)
    run('composer', 'The terminal', 5, (req) => call('send', value, req), {
      onFail: () => {
        if (!draft) setText(value)
      }
    })
  }
  const typeRaw = (seq: string): void => {
    call('type', seq)
  }
  sendNow = send
  addDraft = (value: string): boolean => {
    const el = ref.current
    if (!el) return false
    const own = document.activeElement === el
    const from = own ? el.selectionStart : draft.length
    const to = own ? el.selectionEnd : draft.length
    setText(draft.slice(0, from) + value + draft.slice(to))
    console.info(`[web-shell] paste puts ${value.length} chars into the composer`)
    return true
  }
  return (
    <div
      className={place ? 'fixed z-[31]' : `overflow-hidden ${typing ? 'max-h-[140px]' : 'pointer-events-none max-h-0 opacity-0'}`}
      style={place ? { left: place.left, top: place.top, width: place.width, height: place.height } : undefined}
      data-ws-composer-row={where}
    >
      <div className={place ? 'h-full' : `flex items-end gap-2 ${landscape ? 'px-2 py-1.5' : 'px-3 pb-1 pt-1.5'}`}>
        <div
          className={place ? `h-full ${sending ? 'remote-pending' : ''}` : `ws-glass flex min-w-0 flex-1 items-center rounded-[18px] px-3 py-[7px] ${sending ? 'remote-pending' : ''}`}
          style={
            box && place
              ? {
                  background: box.bg,
                  clipPath: place.cut ? `polygon(${place.cut}px 0, 100% 0, 100% 100%, 0 100%, 0 ${box.ch}px, ${place.cut}px ${box.ch}px)` : undefined,
                  boxShadow: place.detached ? `0 -1px 0 ${DETACHED_RULE}` : undefined
                }
              : undefined
          }
        >
          <textarea
            ref={ref}
            value={text}
            rows={1}
            placeholder={place ? '' : 'Type for the terminal'}
            enterKeyHint="enter"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => useShell.setState({ typing: true })}
            onBlur={() => useShell.setState({ typing: false, ctrl: false })}
            onBeforeInput={(e) => {
              const data = (e.nativeEvent as InputEvent).data
              if (!useShell.getState().ctrl || !data || data.length !== 1) return
              const seq = ctrlChar(data)
              e.preventDefault()
              useShell.setState({ ctrl: false })
              if (seq) typeRaw(seq)
            }}
            onKeyDown={(e) => {
              const k = e.key
              if (e.nativeEvent.isComposing) return
              if (k === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                send()
                return
              }
              if (e.ctrlKey && !e.metaKey && HARD_CTRL.has(k.toLowerCase())) {
                e.preventDefault()
                typeRaw(ctrlChar(k) ?? '')
                return
              }
              if (k === 'Escape' || k === 'Tab') {
                e.preventDefault()
                sendKey(k === 'Escape' ? 'esc' : e.shiftKey ? 'shift-tab' : 'tab')
                return
              }
              if (text) return
              if (k === 'Backspace') {
                e.preventDefault()
                typeRaw('\x7f')
                return
              }
              const arrow = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as Record<string, string>)[k]
              if (arrow) {
                e.preventDefault()
                sendKey(arrow)
              }
            }}
            className={place ? `ws-field block w-full resize-none overscroll-contain bg-transparent outline-none ${lines > place.rows ? 'overflow-y-auto' : 'overflow-hidden'}` : 'ws-field max-h-[120px] min-w-0 flex-1 resize-none overflow-y-auto overscroll-contain bg-transparent leading-[22px] text-[var(--ws-ink)] outline-none'}
            style={
              box && place
                ? { fontFamily: box.font, fontSize: box.size, fontWeight: box.weight as CSSProperties['fontWeight'], letterSpacing: box.spacing, lineHeight: `${box.ch}px`, color: box.fg, caretColor: box.caret, textIndent: place.cut ? place.cut - place.pad : 0, padding: `0 0 0 ${place.pad}px`, border: 0, borderRadius: 0 }
                : undefined
            }
            onPaste={(e) => {
              if (pastedImages(e.clipboardData)) e.preventDefault()
            }}
            data-web-shell-composer
          />
        </div>
      </div>
    </div>
  )
}

function KeyBar({ panel }: { panel: Panel }) {
  const start = useRef<{ x: number; y: number } | null>(null)
  const rail = useRef<HTMLDivElement | null>(null)
  const menu = panel.menu
  useEdgeFade(rail, [!menu.length])
  return (
    <div
      className="flex items-center gap-2 pt-1"
      onTouchStart={(e) => (start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
      onTouchMove={(e) => {
        const s = start.current
        if (!s) return
        const dy = e.touches[0].clientY - s.y
        if (dy > 24 && Math.abs(dy) > Math.abs(e.touches[0].clientX - s.x) && useShell.getState().typing) {
          start.current = null
          stopTyping()
        }
      }}
      data-ws-keybar
    >
      {menu.length ? (
        <>
          <div ref={rail} className="ws-hscroll flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pl-3 pr-3" data-ws-keyrail>
            {MENU_KEYS.map((k) => <KeyChip key={k.name} spec={k} />)}
          </div>
          <div className="-ml-2 pr-3">
            <KeyboardToggle />
          </div>
        </>
      ) : (
        <div className="grid min-w-0 flex-1 grid-cols-7 gap-1.5 px-3" data-ws-keygrid>
          {NORMAL_KEYS.slice(0, 6).map((k) => <KeyChip key={k.name} spec={k} cell />)}
          <AttachKey className={GRID_KEY} />
          {NORMAL_KEYS.slice(6).map((k) => <KeyChip key={k.name} spec={k} cell />)}
          <KeyboardToggle className={GRID_KEY} />
          <SendKey className={GRID_KEY} />
        </div>
      )}
    </div>
  )
}

let lastInsets = ''
let lastKeyboard = -1

export function resetInsetCache(): void {
  lastInsets = ''
  lastKeyboard = -1
}

function pushInsets(t: number, b: number, l: number, r: number, corner: number, safe: View['safe']): void {
  const key = `${useShell.getState().webReady}|${[t, b, l, r, corner, safe.t, safe.r, safe.b, safe.l].map((n) => Math.round(n)).join(',')}`
  if (key === lastInsets) return
  if (call('setInsets', Math.round(t), Math.round(b), Math.round(l), Math.round(r), corner, safe) === true) lastInsets = key
}

function pushKeyboard(over: number): void {
  const px = Math.max(0, Math.round(over))
  const key = useShell.getState().webReady * 100000 + px
  if (key === lastKeyboard) return
  if (call('setKeyboard', px) === true) lastKeyboard = key
}

function useMeasure(ref: RefObject<HTMLElement | null>, deps: unknown[]): number {
  const [n, setN] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setN((x) => x + 1))
    ro.observe(el)
    return () => ro.disconnect()
  }, deps)
  return n
}

function Portrait({ ws, view }: { ws: Workspace | null; view: View }) {
  const panel = ws?.panel ?? null
  const terminal = panel?.composer === 'terminal'
  const filter = filterBarOf(panel)
  const editing = useShell((s) => s.editing)
  const webReady = useShell((s) => s.webReady)
  const top = useRef<HTMLDivElement | null>(null)
  const bottom = useRef<HTMLDivElement | null>(null)
  const a = useMeasure(top, [])
  const b = useMeasure(bottom, [terminal])
  const bottomInset = useRef(0)
  useLayoutEffect(() => {
    const t = top.current?.getBoundingClientRect().bottom ?? 0
    const bt = terminal && bottom.current ? bottom.current.getBoundingClientRect().top : view.h
    const bi = terminal ? Math.max(0, view.h - bt) : 0
    if (editing && !terminal && view.keyboard) {
      pushKeyboard(Math.max(0, view.kb - bottomInset.current))
      pushInsets(t, bottomInset.current, 0, 0, view.corner, view.safe)
      return
    }
    pushKeyboard(0)
    bottomInset.current = bi
    pushInsets(t, bi, 0, 0, view.corner, view.safe)
  }, [a, b, view, terminal, editing, webReady, !!filter, !!ws?.tabs.length, !!ws?.restore])
  return (
    <>
      <div
        ref={top}
        className="fixed inset-x-0 top-0 z-[30] flex flex-col gap-1 bg-[var(--ws-canvas)] pb-1.5"
        style={{ paddingTop: Math.max(view.safe.t, view.corner ? 6 : 4), transform: view.top ? `translateY(${view.top}px)` : undefined }}
        onPointerDown={(e) => {
          if (useShell.getState().typing && !(e.target instanceof Element && e.target.closest('[data-ws-menu]'))) stopTyping()
        }}
        data-ws-top
      >
        <NavBar ws={ws} view={view} />
        {ws && ws.tabs.length > 0 && panel?.kind !== 'layout' && <Chips ws={ws} />}
        {ws?.restore && <RestoreStrip ws={ws} view={view} />}
        {filter && <FilterBar key={filter.id} section={filter} />}
      </div>
      {terminal && panel && (
        <div ref={bottom} className="fixed inset-x-0 z-[30] bg-[var(--ws-canvas)]" style={{ bottom: view.kb, paddingBottom: view.kb ? 6 : Math.max(view.safe.b, 6) }} data-ws-bottom>
          <AttachStrip onSend={() => sendNow()} />
          <Composer landscape={false} />
          <KeyBar panel={panel} />
        </div>
      )}
    </>
  )
}

function switcherPick(id: string): void {
  const ws = useShell.getState().workspace
  if (!ws) return
  if (id.startsWith('ws.tab.')) return selectTab(id.slice(7))
  if (id === 'ws.files') return openFiles()
  if (id !== 'ws.actions') return
  const panel = ws.panel
  const tree = panel?.kind === 'layout' ? [{ id: 'ws.section.workspace', label: 'Workspace', enabled: true, inline: true, children: panel.workspaceActions }] : titleMenu(panel)
  setTimeout(() => useShell.setState({ menu: { key: Date.now(), tree, title: ws.title, at: { x: 0, y: 0 }, seq: null, sheet: true } }), 200)
}

function PanelSwitcher({ ws, size }: { ws: Workspace; size: number }) {
  const many = ws.groups.length > 1
  const tree: WireAction[] = []
  const groups = ws.groups.length ? ws.groups : [{ id: '', name: '', count: ws.tabs.length, focused: true }]
  groups.forEach((g, gi) => {
    const tabs = ws.tabs.filter((t) => !many || t.group === g.id)
    if (!tabs.length) return
    tree.push({
      id: `ws.group.${g.id || gi}`,
      label: many ? `${gi + 1} · ${g.name}` : '',
      enabled: true,
      inline: true,
      children: tabs.map((t) => ({ id: `ws.tab.${t.id}`, label: t.label, icon: CHIP_ICON[t.kind], enabled: true, checked: t.id === ws.selected }))
    })
  })
  const actions = [...(ws.panel?.kind === 'layout' ? [] : ws.panel?.tabActions ?? []), ...(ws.panel?.workspaceActions ?? [])]
  const more: WireAction[] = [
    ...(ws.root ? [{ id: 'ws.files', label: 'Files', icon: 'folder', enabled: true }] : []),
    ...(actions.length ? [{ id: 'ws.actions', label: 'Tab and workspace actions', icon: 'ellipsis.circle', enabled: true }] : [])
  ]
  if (more.length) tree.push({ id: 'ws.more', label: '', enabled: true, inline: true, children: more })
  return (
    <GlassCircle
      label="Panels"
      size={size}
      data="switcher"
      onClick={(el) => {
        const r = el.getBoundingClientRect()
        const x = r.left > window.innerWidth / 2 ? r.left - 8 : r.right + 8
        useShell.setState({ menu: { key: Date.now(), tree, title: '', at: { x, y: r.top }, seq: null, sheet: false, onPick: (n) => switcherPick(n.id) } })
      }}
    >
      <Layers size={Math.min(17, size * 0.5)} strokeWidth={2.4} />
    </GlassCircle>
  )
}

function Landscape({ ws, view }: { ws: Workspace | null; view: View }) {
  const panel = ws?.panel ?? null
  const terminal = panel?.composer === 'terminal'
  const typing = useShell((s) => s.typing)
  const editing = useShell((s) => s.editing)
  const pending = useShell((s) => s.pending)
  const optimistic = useShell((s) => s.optimistic)
  const webReady = useShell((s) => s.webReady)
  const side = Math.max(view.safe.l, view.safe.r)
  const band = side >= 55 ? 150 : side >= 40 ? 234 : 0
  const navLeft = band === 0 || view.islandLeft
  const gl = Math.max(view.safe.l, 52)
  const gr = Math.max(view.safe.r, 52)
  const kb = terminal && typing ? view.kb : 0
  const composer = useRef<HTMLDivElement | null>(null)
  const c = useMeasure(composer, [terminal])
  useLayoutEffect(() => {
    const ch = terminal && composer.current ? composer.current.getBoundingClientRect().height : 0
    pushKeyboard(editing && !terminal ? view.kb : 0)
    pushInsets(view.safe.t + view.top, kb + ch, gl, gr, view.corner, view.safe)
  }, [view, kb, gl, gr, terminal, c, webReady, editing])
  const avail = view.h - kb - 32
  const navCount = 2 + (terminal ? (panel?.menu.length ? 1 : 2) : 0) + (ws?.restore ? 1 : 0)
  const keys: { id: string; icon: string; label: string; run: (el: HTMLElement) => void; control: string }[] = []
  if (terminal && panel) {
    if (panel.menu.length) {
      panel.menu.slice(0, 9).forEach((o, i) => keys.push({ id: `opt:${o.key}`, icon: `${Math.min(50, i + 1)}.circle`, label: o.label, run: () => sendKey(o.key), control: `key:${o.key}` }))
      keys.push({ id: 'esc', icon: 'escape', label: 'Escape', run: () => sendKey('esc'), control: 'key:esc' })
    } else
      for (const [name, icon, label] of [
        ['esc', 'escape', 'Escape'],
        ['shift-tab', 'arrow.left.to.line', 'Shift Tab'],
        ['up', 'arrow.up', 'Up'],
        ['down', 'arrow.down', 'Down'],
        ['ctrl-c', 'stop.circle', 'Control C'],
        ['slash', 'slash.circle', 'Slash']
      ])
        keys.push({ id: name, icon, label, run: () => sendKey(name), control: `key:${name}` })
    if (!panel.menu.length) keys.push({ id: 'attach', icon: 'paperclip', label: 'Attach images', run: openAttach, control: 'attach' })
  }
  const prim = terminal ? [] : primaryActions(panel)
  const viewing = useVideoViewing()
  const actionCount = keys.length + prim.length + (panel?.actions.length ? 1 : 0) + (viewing ? 1 : 0)
  const fit = (n: number): number => (n ? (avail - (n - 1) * 8) / n : 40)
  const gutter = Math.min(gl, gr)
  const d = Math.max(24, Math.min(40, gutter - 12, fit(Math.max(navCount, actionCount))))
  const nav = (
    <>
      <GlassCircle label={backLabel(ws).a11y} size={d} onClick={goBack} data="back">
        <ChevronLeft size={Math.min(18, d * 0.5)} strokeWidth={2.6} />
      </GlassCircle>
      {ws && <PanelSwitcher ws={ws} size={d} />}
      {ws?.restore && (
        <button
          type="button"
          aria-label={ws.restore.title}
          disabled={!!(ws.restore.tabId && pending[`tab:${ws.restore.tabId}`])}
          onMouseDown={noFocus}
          onClick={() => openRestore(ws)}
          className="ws-glass ws-press flex shrink-0 items-center justify-center rounded-full"
          style={{ width: d, height: d }}
          data-ws-button="restore"
          data-own-pending
        >
          <span className="relative flex">
            <History size={Math.min(17, d * 0.5)} strokeWidth={2.4} />
            <span className="absolute -right-1.5 -top-1"><StatusDot dot="wait" /></span>
          </span>
        </button>
      )}
    </>
  )
  const kbButton = terminal ? (
    <>
      <KeyboardToggle size={d} />
      {!panel?.menu.length && <SendKey size={d} />}
    </>
  ) : null
  const actions = (
    <>
      {viewing && <StreamBadge size={d} />}
      {keys.map((k) => (
        <button key={k.id} type="button" aria-label={k.label} onMouseDown={noFocus} onClick={(e) => k.run(e.currentTarget)} className={`ws-glass ws-press flex shrink-0 items-center justify-center rounded-full ${pending[k.control] ? 'remote-pending' : ''}`} style={{ width: d, height: d }} data-ws-rail-key={k.id}>
          {k.icon === 'escape' ? <span className="text-[11px] font-bold">esc</span> : <Sym name={k.icon} size={Math.min(17, d * 0.5)} stroke={2.4} fallback />}
        </button>
      ))}
      {prim.map((a) => (
        <button key={a.id} type="button" aria-label={a.label} disabled={!a.enabled} onClick={() => perform(a)} className={`ws-glass ws-press flex shrink-0 items-center justify-center rounded-full disabled:opacity-40 ${pending[`panel:${a.id}`] ? 'remote-pending' : ''}`} style={{ width: d, height: d, color: checkedOf(optimistic, a) === true ? CHECKED_BLUE : undefined }} data-ws-primary={a.id}>
          <Sym name={a.icon || 'circle'} size={Math.min(17, d * 0.5)} stroke={2.4} fallback />
        </button>
      ))}
      {panel && panel.actions.length > 0 && (
        <GlassCircle label="More actions" size={d} onClick={(el) => openMenu(panel.actions, '', el)} data="more">
          <Ellipsis size={Math.min(18, d * 0.5)} strokeWidth={2.6} />
        </GlassCircle>
      )}
    </>
  )
  const split = band > 0 && !kb
  const navRail = (
    <div className="flex h-full flex-col items-center" style={{ paddingTop: kb ? 16 : 0 }}>
      {split ? (
        <>
          <div className="flex flex-1 flex-col items-center justify-center gap-2">{nav}</div>
          <div style={{ height: band }} />
          <div className="flex flex-1 flex-col items-center justify-center gap-2">{kbButton}</div>
        </>
      ) : (
        <div className={`flex flex-col items-center gap-2 ${kb ? '' : 'flex-1 justify-center'}`}>
          {nav}
          {kbButton}
        </div>
      )}
    </div>
  )
  const actionRail = <div className={`flex h-full flex-col items-center gap-2 ${kb ? 'pt-4' : 'justify-center'}`}>{actions}</div>
  return (
    <>
      <div className="fixed left-0 top-0 z-[30] bg-[var(--ws-canvas)]" style={{ width: gl, bottom: kb, paddingTop: view.safe.t }} data-ws-rail={navLeft ? 'nav' : 'actions'}>
        {navLeft ? navRail : actionRail}
      </div>
      <div className="fixed right-0 top-0 z-[30] bg-[var(--ws-canvas)]" style={{ width: gr, bottom: kb, paddingTop: view.safe.t }} data-ws-rail={navLeft ? 'actions' : 'nav'}>
        {navLeft ? actionRail : navRail}
      </div>
      {terminal && (
        <div ref={composer} className="fixed z-[30] bg-[var(--ws-canvas)]" style={{ left: gl, right: gr, bottom: view.kb }} data-ws-bottom>
          <AttachStrip onSend={() => sendNow()} />
          <Composer landscape />
        </div>
      )}
    </>
  )
}

function Opening({ id }: { id: string }) {
  const title = useShell((s) => s.projects.find((p) => p.id === id)?.title ?? '')
  const value = useStageProgress('opening', 0.1, 0.95, -1, 1500)
  return (
    <div className="ws-fade-in fixed inset-0 z-[20] flex flex-col items-center justify-center gap-3 bg-[var(--ws-canvas)]" style={{ top: 'var(--remote-top, 0px)' }} data-ws-opening>
      <ProgressBar value={value} className="h-[3px] w-[180px]" />
      <p className="max-w-[280px] truncate text-[14px] text-[var(--ws-label2)]">{title ? `Opening ${title}…` : 'Opening the project…'}</p>
    </div>
  )
}

export function WorkspaceChrome() {
  const ws = useShell((s) => s.workspace)
  const openId = useShell((s) => s.openId)
  const files = useShell((s) => s.files)
  const view = useView()
  useEffect(() => resetInsetCache, [])
  if (!openId) return null
  return (
    <>
      {view.landscape ? <Landscape ws={ws} view={view} /> : <Portrait ws={ws} view={view} />}
      {files && <FilesScreen stack={files} />}
      <Presence when={!ws}>{() => <Opening id={openId} />}</Presence>
    </>
  )
}

