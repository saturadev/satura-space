import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type TouchEvent as ReactTouchEvent } from 'react'
import { Check, ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import type { WireAction } from '../../lib/actions/action-tree'
import { menuRows } from '../phone-menu-policy'
import { call, checkedOf, haptic, perform, run, setPickerQuery, useShell, type Confirm, type MenuRequest, type Picker, type Prompt } from './bridge'
import { Presence, ProgressBar, useStageProgress } from '../motion'
import { Sym } from './icons'
import { useView } from './viewport'

export function openMenu(tree: WireAction[], title: string, anchor: HTMLElement | { x: number; y: number }, forceSheet = false, onPick?: (item: WireAction) => void): void {
  if (!tree.length) return
  const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : null
  const at = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : (anchor as { x: number; y: number })
  useShell.setState({ menu: { key: Date.now(), tree, title, at, seq: null, sheet: forceSheet || menuRows(tree) > 10, ...(onPick ? { onPick } : {}) } })
}

function closeMenu(m: MenuRequest, picked: boolean): void {
  if (useShell.getState().menu?.key === m.key) useShell.setState({ menu: null })
  if (m.seq !== null && !picked) {
    const seq = m.seq
    setTimeout(() => call('contextDismiss', seq), 350)
  }
}

function pickItem(m: MenuRequest, n: WireAction): void {
  closeMenu(m, true)
  if (m.onPick) {
    m.onPick(n)
    return
  }
  if (m.seq === null) {
    if (n.input && m.sheet) window.setTimeout(() => perform(n, null, 'menu'), 200)
    else perform(n, null, 'menu')
    return
  }
  const seq = m.seq
  if (n.input) {
    useShell.setState({ prompt: { item: n, seq } })
    return
  }
  run(`ctx:${n.id}`, n.label, 15, (req) => call('contextPick', seq, n.id, null, req), { pill: `${n.label}…` })
}

function controlOf(m: MenuRequest, n: WireAction): string {
  return m.seq === null ? `panel:${n.id}` : `ctx:${n.id}`
}

function Row({ n, checks, pending, onPick, onDrill, big, armed }: { n: WireAction; checks: boolean; pending: boolean; onPick: () => void; onDrill: () => void; big: boolean; armed: () => boolean }) {
  const sub = !!n.children
  const checked = useShell((s) => checkedOf(s.optimistic, n))
  return (
    <button
      type="button"
      disabled={!n.enabled}
      onClick={() => {
        if (!armed()) return
        if (sub) onDrill()
        else onPick()
      }}
      className={`flex w-full items-center gap-2.5 px-3.5 text-left disabled:opacity-40 ${big ? 'min-h-[48px] py-2' : 'min-h-[44px] py-1.5'} ${pending ? 'remote-pending' : ''} active:bg-white/[0.08]`}
      style={{ color: n.destructive ? 'var(--ws-err)' : 'var(--ws-ink)' }}
      data-ws-menu-item={n.id}
    >
      {checks && <span className="flex w-4 shrink-0 justify-center">{checked === true && <Check size={15} strokeWidth={2.6} />}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`${big ? 'text-[16px]' : 'text-[15px]'} leading-tight`}>{n.label}</span>
        {n.hint && <span className="mt-0.5 truncate text-[12.5px] leading-tight text-[var(--ws-label2)]">{n.hint}</span>}
      </span>
      {sub ? <ChevronRight size={16} strokeWidth={2.4} className="shrink-0 text-[var(--ws-label3)]" /> : <span className="shrink-0 opacity-90"><Sym name={n.icon} size={17} /></span>}
    </button>
  )
}

function sections(nodes: WireAction[], label: string): { label: string; items: WireAction[] }[] {
  const out = [{ label, items: [] as WireAction[] }]
  for (const n of nodes) {
    const cur = out[out.length - 1]
    if (n.inline && n.children) {
      const inherit = !cur.items.length && cur.label ? cur.label : ''
      if (inherit) cur.label = ''
      out.push(...sections(n.children, n.label || inherit), { label: '', items: [] })
    } else cur.items.push(n)
  }
  return out.filter((g) => g.items.length)
}

function Level({ nodes, m, onDrill, big, armed = () => true }: { nodes: WireAction[]; m: MenuRequest; onDrill: (n: WireAction) => void; big: boolean; armed?: () => boolean }) {
  const pending = useShell((s) => s.pending)
  const groups = sections(nodes, '')
  const checks = groups.some((g) => g.items.some((n) => n.checked !== undefined && n.checked !== null && !n.children))
  return (
    <>
      {groups.map((g, gi) => (
        <div key={gi} className={big ? 'mx-4 mb-5 overflow-hidden rounded-[12px] bg-[#2c2c2e]' : gi > 0 ? 'border-t-[6px] border-black/30' : ''}>
          {g.label && <div className={`px-3.5 pb-1 pt-2 text-[12px] font-medium text-[var(--ws-label2)] ${big ? 'uppercase tracking-wide' : ''}`}>{g.label}</div>}
          {g.items.map((n, i) => (
            <div key={n.id} className={i > 0 ? 'border-t border-white/[0.08]' : ''}>
              <Row n={n} checks={checks} big={big} armed={armed} pending={!!pending[controlOf(m, n)]} onPick={() => pickItem(m, n)} onDrill={() => onDrill(n)} />
            </div>
          ))}
        </div>
      ))}
    </>
  )
}

function Popover({ m }: { m: MenuRequest }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [stack, setStack] = useState<WireAction[]>([])
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const pressed = useRef(m.seq === null)
  const view = useView()
  const level = stack.length ? stack[stack.length - 1].children ?? [] : m.tree
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const mw = el.offsetWidth
    const mh = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight - view.kb
    const { x, y, w = 0, h = 0 } = m.at
    let top = y + h + 6
    if (top + mh > vh - 8) top = y - mh - 6 >= 8 + view.top ? y - mh - 6 : Math.max(8 + view.top, vh - 8 - mh)
    let left = w ? x : x + 2
    if (left + mw > vw - 8) left = w ? x + w - mw : x - mw
    left = Math.max(8, Math.min(left, vw - 8 - mw))
    setPos({ left, top })
  }, [m.key, stack.length, view.kb, view.w, view.h])
  return (
    <div className="fixed inset-0 z-[1100]" data-ws-menu>
      <div className="absolute inset-0" onPointerDown={() => closeMenu(m, false)} />
      <div
        ref={ref}
        onPointerDown={() => (pressed.current = true)}
        className="ws-glass-dark ws-pop ws-scroll absolute overflow-hidden rounded-[14px]"
        style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, width: Math.min(290, window.innerWidth - 16), maxHeight: `calc(${window.innerHeight - view.kb - 16 - view.top}px)`, transformOrigin: 'top left' }}
      >
        {(stack.length > 0 || m.title) && (
          <div className="flex items-center gap-1 border-b border-white/[0.08] px-2 py-2 text-[13px] font-semibold text-[var(--ws-label2)]">
            {stack.length > 0 && (
              <button type="button" className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[var(--ws-accent)]" onClick={() => setStack(stack.slice(0, -1))}>
                <ChevronLeft size={16} strokeWidth={2.6} />
              </button>
            )}
            <span className="truncate px-1.5">{stack.length ? stack[stack.length - 1].label : m.title}</span>
          </div>
        )}
        <Level nodes={level} m={m} big={false} armed={() => pressed.current} onDrill={(n) => setStack([...stack, n])} />
      </div>
    </div>
  )
}

export function Sheet({ title, onClose, left, right, children, top, grow }: { title: string; onClose: () => void; left?: ReactNode; right?: ReactNode; children: ReactNode; top?: ReactNode; grow?: boolean }) {
  const view = useView()
  const [large, setLarge] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const drag = useRef<{ y: number; dy: number } | null>(null)
  const [dy, setDy] = useState(0)
  const avail = window.innerHeight - view.kb - view.top
  const height = large || grow || view.kb ? Math.min(avail - Math.max(12, view.safe.t), avail * 0.94) : Math.min(avail * 0.58, Math.max(360, avail * 0.5))
  const onStart = (e: ReactTouchEvent): void => {
    drag.current = { y: e.touches[0].clientY, dy: 0 }
  }
  const onMove = (e: ReactTouchEvent): void => {
    if (!drag.current) return
    drag.current.dy = e.touches[0].clientY - drag.current.y
    setDy(Math.max(-40, drag.current.dy))
  }
  const onEnd = (): void => {
    const d = drag.current?.dy ?? 0
    drag.current = null
    setDy(0)
    if (d < -50) setLarge(true)
    else if (d > 90) {
      if (large) setLarge(false)
      else onClose()
    }
  }
  return (
    <div className="fixed inset-0 z-[1200]" data-ws-sheet>
      <div className="ws-fade-in absolute inset-0 bg-black/45" onClick={onClose} />
      <div
        className="ws-sheet absolute inset-x-0 mx-auto flex max-w-[680px] flex-col overflow-hidden rounded-t-[14px] bg-[#1c1c1e]"
        style={{ bottom: view.kb, height, transform: dy ? `translateY(${Math.max(0, dy)}px)` : undefined, paddingBottom: view.kb ? 0 : view.safe.b }}
      >
        <div className="shrink-0 touch-none" onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} onTouchCancel={onEnd}>
          <div className="mx-auto mt-[6px] h-[5px] w-9 rounded-full bg-white/25" />
          <div className="relative flex h-11 items-center justify-center px-3">
            <div className="absolute left-3 flex items-center">{left}</div>
            <span className="max-w-[60%] truncate text-[16px] font-semibold">{title}</span>
            <div className="absolute right-3 flex items-center">{right}</div>
          </div>
          {top}
        </div>
        <div className="ws-scroll min-h-0 flex-1 pb-3">{children}</div>
      </div>
    </div>
  )
}

function SheetMenu({ m }: { m: MenuRequest }) {
  const [stack, setStack] = useState<WireAction[]>([])
  const level = stack.length ? stack[stack.length - 1].children ?? [] : m.tree
  const title = stack.length ? stack[stack.length - 1].label : m.title || 'Actions'
  return (
    <Sheet
      title={title}
      onClose={() => closeMenu(m, false)}
      left={
        stack.length > 0 ? (
          <button type="button" className="flex items-center text-[16px] text-[var(--ws-accent)]" onClick={() => setStack(stack.slice(0, -1))}>
            <ChevronLeft size={20} strokeWidth={2.4} />
            <span className="max-w-[90px] truncate">{stack.length > 1 ? stack[stack.length - 2].label : m.title || 'Back'}</span>
          </button>
        ) : undefined
      }
      right={
        <button type="button" className="text-[16px] font-semibold text-[var(--ws-accent)]" onClick={() => closeMenu(m, false)}>
          Done
        </button>
      }
    >
      <div className="pt-2">
        <Level nodes={level} m={m} big onDrill={(n) => setStack([...stack, n])} />
      </div>
    </Sheet>
  )
}

export function MenuHost() {
  const m = useShell((s) => s.menu)
  useEffect(() => {
    if (!m) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeMenu(m, false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [m])
  return <Presence when={m}>{(m) => (m.sheet ? <SheetMenu key={m.key} m={m} /> : <Popover key={m.key} m={m} />)}</Presence>
}

export function PickerHost() {
  const picker = useShell((s) => s.picker)
  return <Presence when={picker}>{(p) => <PickerSheet p={p} />}</Presence>
}

function PickerLoading({ title }: { title: string }) {
  const value = useStageProgress('list', 0.1, 0.95, -1, 1500)
  return (
    <div className="flex flex-col items-center gap-3 px-8 pt-10 text-center" data-ws-picker-loading>
      <ProgressBar value={value} className="h-[3px] w-[160px]" />
      <span className="text-[14px] text-[var(--ws-label2)]">{title ? `Loading ${title.toLowerCase()}…` : 'Loading the list…'}</span>
    </div>
  )
}

function PickerSheet({ p }: { p: Picker }) {
  const pending = useShell((s) => s.pending)
  const [text, setText] = useState('')
  const seqRef = useRef<number | null>(null)
  const timer = useRef(0)
  useEffect(() => {
    if (seqRef.current !== p.seq) {
      seqRef.current = p.seq
      setText('')
    }
  }, [p.seq])
  const close = (): void => {
    window.clearTimeout(timer.current)
    useShell.setState({ picker: null })
    call('pickerDismiss', p.seq)
  }
  const onText = (v: string): void => {
    setText(v)
    setPickerQuery(v)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => call('pickerQuery', p.seq, v), 180)
  }
  const count = p.sections.reduce((n, s) => n + s.items.length, 0)
  return (
    <Sheet
      title={p.title}
      onClose={close}
      left={
        <button type="button" className="text-[16px] text-[var(--ws-accent)]" onClick={close}>
          Close
        </button>
      }
      top={
        <div className="px-4 pb-2">
          <label className="flex h-9 items-center gap-2 rounded-[10px] bg-[rgb(118_118_128/0.24)] px-2.5">
            <Search size={16} strokeWidth={2.4} className="shrink-0 text-[var(--ws-label2)]" />
            <input
              value={text}
              onChange={(e) => onText(e.target.value)}
              placeholder={p.placeholder || 'Search'}
              enterKeyHint="search"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="ws-field min-w-0 flex-1 bg-transparent text-[var(--ws-ink)] outline-none"
              data-ws-picker-search
            />
            {text && (
              <button type="button" aria-label="Clear" onClick={() => onText('')} className="text-[var(--ws-label2)]">
                <X size={15} strokeWidth={2.6} />
              </button>
            )}
          </label>
        </div>
      }
    >
      {p.loading && !count ? (
        <PickerLoading title={p.title} />
      ) : !count ? (
        <div className="flex flex-col items-center gap-2 px-8 pt-10 text-center text-[15px] text-[var(--ws-label2)]">
          <Search size={22} strokeWidth={2} />
          {p.empty || 'Nothing found'}
        </div>
      ) : (
        p.sections.map((s, si) => (
          <div key={si} className="pt-1">
            {s.title && <div className="px-5 pb-1.5 pt-3 text-[13px] font-semibold text-[var(--ws-label2)]">{s.title}</div>}
            <div className="mx-4 overflow-hidden rounded-[12px] bg-white/[0.06]">
              {s.items.map((it, i) => (
                <button
                  key={it.id}
                  type="button"
                  className={`flex min-h-[52px] w-full items-center gap-3 px-3.5 py-2 text-left active:bg-white/[0.08] ${i > 0 ? 'border-t border-white/[0.08]' : ''} ${pending[`picker:${it.id}`] ? 'remote-pending' : ''}`}
                  onClick={() =>
                    run(`picker:${it.id}`, it.label, 15, (req) => call('pickerPick', p.seq, it.id, req), {
                      onOk: () => {
                        if (useShell.getState().picker?.seq === p.seq) useShell.setState({ picker: null })
                        haptic('success')
                      }
                    })
                  }
                  data-ws-picker-item={it.id}
                >
                  {it.icon && (
                    <span className="flex w-[22px] shrink-0 justify-center text-[var(--ws-label2)]">
                      <Sym name={it.icon} size={19} />
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[15.5px]">{it.label}</span>
                    {it.detail && <span className="line-clamp-2 text-[12.5px] text-[var(--ws-label2)]">{it.detail}</span>}
                  </span>
                  {it.badge && <span className="shrink-0 text-[11px] font-semibold text-[var(--ws-label2)]">{it.badge}</span>}
                </button>
              ))}
            </div>
          </div>
        ))
      )}
    </Sheet>
  )
}

function Dialog({ title, message, children, onCancel }: { title: string; message?: string; children: ReactNode; onCancel: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  const view = useView()
  return (
    <div className="fixed inset-x-0 z-[1300] flex items-center justify-center px-8" style={{ top: view.top, height: window.innerHeight - view.kb - view.top }} data-ws-dialog>
      <div className="ws-fade-in absolute inset-0 bg-black/45" />
      <div className="ws-pop ws-glass-dark relative w-full max-w-[300px] overflow-hidden rounded-[16px] text-center">
        <div className="px-4 pb-3 pt-[18px]">
          <div className="text-[17px] font-semibold leading-snug">{title}</div>
          {message && <div className="mt-1 whitespace-pre-line text-[13px] leading-snug text-[var(--ws-label2)]">{message}</div>}
        </div>
        {children}
      </div>
    </div>
  )
}

function DialogButton({ label, onClick, bold, danger }: { label: string; onClick: () => void; bold?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block h-11 w-full border-t border-white/[0.12] text-[17px] active:bg-white/[0.08] ${bold ? 'font-semibold' : ''}`}
      style={{ color: danger ? 'var(--ws-err)' : 'var(--ws-blue)' }}
    >
      {label}
    </button>
  )
}

export function ConfirmHost() {
  const confirm = useShell((s) => s.confirm)
  return <Presence when={confirm}>{(c) => <ConfirmDialog c={c} />}</Presence>
}

function ConfirmDialog({ c }: { c: Confirm }) {
  const answer = (choice: 'confirm' | 'secondary' | 'cancel'): void => {
    useShell.setState({ confirm: null })
    if (c.onAnswer) return c.onAnswer(choice)
    run(`confirm:${c.origin}:${c.id}`, c.title, 10, (req) => call('confirm', c.origin, c.id, choice, req), { pill: choice === 'cancel' ? undefined : `${choice === 'secondary' ? c.secondaryLabel : c.confirmLabel || 'OK'}…` })
  }
  return (
    <Dialog title={c.title} message={c.message} onCancel={() => answer('cancel')}>
      <div data-ws-confirm={c.id}>
        <DialogButton label={c.confirmLabel || 'OK'} bold danger={c.danger} onClick={() => answer('confirm')} />
        {c.secondaryLabel && <DialogButton label={c.secondaryLabel} onClick={() => answer('secondary')} />}
        <DialogButton label={c.cancelLabel || 'Cancel'} onClick={() => answer('cancel')} />
      </div>
    </Dialog>
  )
}

export function PromptHost() {
  const prompt = useShell((s) => s.prompt)
  return <Presence when={prompt}>{(p) => <PromptDialog p={p} />}</Presence>
}

function PromptDialog({ p }: { p: Prompt }) {
  const [value, setValue] = useState('')
  const field = useRef<HTMLInputElement | null>(null)
  useLayoutEffect(() => {
    setValue(p.item.input?.initial ?? '')
    field.current?.focus()
    field.current?.select()
  }, [p])
  const input = p.item.input
  const cancel = (): void => {
    useShell.setState({ prompt: null })
    if (p.seq !== null) call('contextDismiss', p.seq)
  }
  const submit = (): void => {
    useShell.setState({ prompt: null })
    const item = p.item
    if (p.onSubmit) p.onSubmit(value)
    else if (p.seq === null) perform(item, value, 'menu')
    else {
      const seq = p.seq
      run(`ctx:${item.id}`, item.label, 15, (req) => call('contextPick', seq, item.id, value, req), { pill: `${item.label}…` })
    }
  }
  return (
    <Dialog title={input?.title || p.item.label} message={input?.message} onCancel={cancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="px-4 pb-4">
          <input
            ref={field}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={input?.placeholder ?? ''}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            className="ws-field h-9 w-full rounded-[8px] border border-white/[0.12] bg-black/30 px-2.5 text-left text-[var(--ws-ink)] outline-none"
            data-ws-prompt-field
          />
        </div>
        <div className="flex">
          <button type="button" onClick={cancel} className="h-11 flex-1 border-t border-white/[0.12] text-[17px] text-[var(--ws-blue)] active:bg-white/[0.08]">
            Cancel
          </button>
          <button type="submit" className="h-11 flex-1 border-l border-t border-white/[0.12] text-[17px] font-semibold text-[var(--ws-blue)] active:bg-white/[0.08]">
            {input?.submit || 'OK'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
