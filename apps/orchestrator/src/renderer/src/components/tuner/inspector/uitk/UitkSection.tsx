import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  UITK_OWN,
  UITK_PSEUDO,
  uitkMods,
  type UitkCapture,
  type UitkInput,
  type UitkNode,
  type UitkPicture
} from '@shared/tuner-inspector-uitk'
import { ingestUitkTextures, uitkTextureUrl } from './uitk-textures'
import { ROOT_ANCESTRY, childAncestry, uitkLook, type UitkAncestry } from './uitk-theme'
import { pressClick, type ClickMark } from '../../../../lib/tuner/inspector/model'
import { noteRender } from '../../../../lib/tuner/perf'

export interface UitkSectionProps {
  data: UitkCapture
  onInput: (input: UitkInput) => void
  renderImgui?: (index: number, size: { w: number; h: number }) => ReactNode
  changed?: (propertyPath: string) => boolean
  className?: string
}

interface Index {
  byId: Map<number, UitkNode>
  parent: Map<number, number>
  abs: Map<number, { x: number; y: number }>
  inputOwner: Map<number, UitkNode>
}

interface Ctx {
  renderImgui?: UitkSectionProps['renderImgui']
  changed?: UitkSectionProps['changed']
  skin: 'dark' | 'light'
}

const FONT = "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
const WHEEL_LINE = 18
const FORWARDED_KEYS = new Set([
  'Enter',
  ' ',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Delete',
  'Backspace'
])

function buildIndex(root: UitkNode | null): Index {
  const idx: Index = { byId: new Map(), parent: new Map(), abs: new Map(), inputOwner: new Map() }
  const walk = (n: UitkNode, px: number, py: number, parent: number | null): void => {
    const x = px + n.x
    const y = py + n.y
    idx.byId.set(n.i, n)
    idx.abs.set(n.i, { x, y })
    if (parent !== null) idx.parent.set(n.i, parent)
    if (n.inp !== undefined) idx.inputOwner.set(n.inp, n)
    for (const c of n.ch ?? []) walk(c, x, y, n.i)
  }
  if (root) walk(root, 0, 0, null)
  return idx
}

function radius(r: UitkNode['rad']): string | undefined {
  if (r === undefined) return undefined
  if (typeof r === 'number') return `${r}px`
  return `${r[0]}px ${r[1]}px ${r[2]}px ${r[3]}px`
}

const RICH_COLORS: Record<string, string> = {
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  orange: '#ffa500',
  white: '#ffffff',
  black: '#000000',
  grey: '#808080',
  gray: '#808080',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  lime: '#00ff00',
  purple: '#a020f0'
}

function richText(s: string): ReactNode {
  const out: ReactNode[] = []
  const stack: { b: boolean; i: boolean; color?: string }[] = [{ b: false, i: false }]
  const re = /<(\/?)(b|i|color)(?:=([^>]+))?>|<\/?[a-zA-Z][^>]*>/g
  let last = 0
  let m: RegExpExecArray | null
  const push = (text: string): void => {
    if (!text) return
    const top = stack[stack.length - 1]
    out.push(
      <span key={out.length} style={{ fontWeight: top.b ? 600 : undefined, fontStyle: top.i ? 'italic' : undefined, color: top.color }}>
        {text}
      </span>
    )
  }
  while ((m = re.exec(s))) {
    push(s.slice(last, m.index))
    last = re.lastIndex
    if (!m[2]) continue
    if (m[1]) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const top = stack[stack.length - 1]
    const arg = (m[3] ?? '').replace(/^["']|["']$/g, '').toLowerCase()
    stack.push({
      b: top.b || m[2] === 'b',
      i: top.i || m[2] === 'i',
      color: m[2] === 'color' ? (RICH_COLORS[arg] ?? (arg.startsWith('#') ? arg : top.color)) : top.color
    })
  }
  push(s.slice(last))
  return out
}

function pictureStyle(p: UitkPicture, url: string): CSSProperties {
  if (p.slice) {
    const s = p.sscale ?? 1
    const [t, r, b, l] = p.slice
    return {
      borderStyle: 'solid',
      borderColor: 'transparent',
      borderWidth: 0,
      borderImageSource: `url(${url})`,
      borderImageSlice: `${t} ${r} ${b} ${l} fill`,
      borderImageWidth: `${t * s}px ${r * s}px ${b * s}px ${l * s}px`,
      borderImageRepeat: 'stretch'
    }
  }
  const base: CSSProperties = {
    backgroundImage: `url(${url})`,
    backgroundSize: p.size,
    backgroundPosition: p.pos,
    backgroundRepeat: p.rep
  }
  if (p.tint && p.tint.toLowerCase() !== '#ffffffff') {
    return {
      ...base,
      backgroundImage: `url(${url}), linear-gradient(${p.tint}, ${p.tint})`,
      backgroundBlendMode: 'multiply',
      backgroundSize: `${p.size}, 100% 100%`,
      backgroundPosition: `${p.pos}, 0 0`,
      backgroundRepeat: `${p.rep}, no-repeat`,
      WebkitMaskImage: `url(${url})`,
      WebkitMaskSize: p.size,
      WebkitMaskPosition: p.pos,
      WebkitMaskRepeat: p.rep
    }
  }
  return base
}

function Picture({ p }: { p: UitkPicture }) {
  const url = uitkTextureUrl(p.id)
  if (!url) return null
  return <div className="pointer-events-none absolute inset-0" style={pictureStyle(p, url)} data-uitk-texture={p.id} />
}

function TextBox({ n, color }: { n: UitkNode; color: string | undefined }) {
  const [bt, br, bb, bl] = n.bw ?? [0, 0, 0, 0]
  const [pt, pr, pb, pl] = n.pad ?? [0, 0, 0, 0]
  const ta = n.ta ?? 0
  const h = ta % 3
  const v = Math.floor(ta / 3)
  const fst = n.fst ?? 0
  const ws = n.ws ?? 0
  const nowrap = ws === 1 || n.ell === 1
  const text = n.tx ?? ''
  return (
    <div
      className="pointer-events-none absolute flex"
      data-uitk-textbox
      style={{
        left: bl + pl,
        top: bt + pt,
        right: br + pr,
        bottom: bb + pb,
        alignItems: v === 0 ? 'flex-start' : v === 1 ? 'center' : 'flex-end',
        justifyContent: h === 0 ? 'flex-start' : h === 1 ? 'center' : 'flex-end',
        color,
        fontSize: n.fs ?? 12,
        lineHeight: 1.2,
        fontWeight: fst === 1 || fst === 3 ? 600 : 400,
        fontStyle: fst === 2 || fst === 3 ? 'italic' : undefined,
        letterSpacing: n.ls,
        overflow: 'hidden'
      }}
    >
      <span
        style={{
          whiteSpace: nowrap ? 'pre' : ws === 2 ? 'pre' : ws === 3 ? 'pre-wrap' : 'normal',
          overflow: 'hidden',
          textOverflow: n.ell ? 'ellipsis' : 'clip',
          textAlign: h === 0 ? 'left' : h === 1 ? 'center' : 'right',
          maxWidth: '100%',
          overflowWrap: 'anywhere'
        }}
      >
        {n.rich ? richText(text) : text}
      </span>
    </div>
  )
}

function Curve({ n }: { n: UitkNode }) {
  const cv = n.cv
  if (!cv) return null
  const [bt, br, bb, bl] = n.bw ?? [0, 0, 0, 0]
  const w = Math.max(1, n.w - bl - br)
  const h = Math.max(1, n.h - bt - bb)
  const pts: string[] = []
  for (let i = 0; i + 1 < cv.p.length; i += 2) pts.push(`${(cv.p[i] * w).toFixed(1)},${(cv.p[i + 1] * (h - 2) + 1).toFixed(1)}`)
  return (
    <svg className="pointer-events-none absolute" style={{ left: bl, top: bt }} width={w} height={h} data-uitk-curve>
      <polyline points={pts.join(' ')} fill="none" stroke={cv.col} strokeWidth={1.5} />
    </svg>
  )
}

function valueAttr(v: UitkNode['v']): string | undefined {
  if (v === undefined) return undefined
  return Array.isArray(v) ? v.join(',') : String(v)
}

function CapturedBorder({ n }: { n: UitkNode }) {
  const bw = n.bw
  if (!bw) return null
  const bc = n.bc
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        boxSizing: 'border-box',
        borderStyle: 'solid',
        borderWidth: `${bw[0]}px ${bw[1]}px ${bw[2]}px ${bw[3]}px`,
        borderColor: typeof bc === 'string' ? bc : bc ? `${bc[0]} ${bc[1]} ${bc[2]} ${bc[3]}` : 'transparent',
        borderRadius: radius(n.rad)
      }}
    />
  )
}

function ThemedBorder({ n }: { n: UitkNode }) {
  const bw = n.bw
  if (!bw) return null
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        boxSizing: 'border-box',
        borderStyle: 'solid',
        borderWidth: `${bw[0]}px ${bw[1]}px ${bw[2]}px ${bw[3]}px`,
        borderColor: 'var(--hairline)',
        borderRadius: radius(n.rad)
      }}
    />
  )
}

const NodeView = memo(function NodeView({
  n,
  ctx,
  anc,
  ax,
  ay,
  parentPath
}: {
  n: UitkNode
  ctx: Ctx
  anc: UitkAncestry
  ax: number
  ay: number
  parentPath?: string
}) {
  const look = uitkLook(n, anc, ctx.skin)
  if (look.hide) return null
  const own = n.own ?? 0
  const x = ax + n.x
  const y = ay + n.y
  const keepFill = (own & UITK_OWN.bg) !== 0 || look.captured
  const keepBorder = (own & UITK_OWN.border) !== 0 || look.captured
  const style: CSSProperties = {
    position: 'absolute',
    left: n.x,
    top: n.y,
    width: n.w,
    height: n.h,
    borderRadius: radius(n.rad),
    overflow: n.clip ? 'hidden' : undefined,
    opacity: n.op,
    visibility: n.hid ? 'hidden' : 'visible',
    ...look.style,
    ...(keepFill && n.bg ? { backgroundColor: n.bg } : {})
  }
  const next = childAncestry(n, anc)
  const marked = n.bp !== undefined && n.bp !== parentPath && ctx.changed?.(n.bp) === true
  const plain = !look.cls && !look.icon && !look.captured
  return (
    <div
      style={style}
      className={look.cls || undefined}
      data-ti-tip={n.tip || undefined}
      data-uitk-id={n.i}
      data-uitk-type={n.t}
      data-uitk-class={n.c}
      data-uitk-name={n.n}
      data-uitk-label={n.lb}
      data-uitk-path={n.bp}
      data-uitk-text={n.tx}
      data-uitk-value={valueAttr(n.v)}
      data-uitk-own={own || undefined}
      data-uitk-disabled={n.d ? '' : undefined}
      data-uitk-checked={n.ps !== undefined && (n.ps & UITK_PSEUDO.checked) !== 0 ? '' : undefined}
      data-uitk-focused={n.foc ? '' : undefined}
      data-uitk-imgui={n.im !== undefined ? n.im : undefined}
    >
      {n.img && <Picture p={n.img} />}
      {n.pic && !look.hidePicture && <Picture p={n.pic} />}
      {keepBorder ? <CapturedBorder n={n} /> : plain && <ThemedBorder n={n} />}
      {look.icon}
      {n.tx !== undefined && <TextBox n={n} color={look.text} />}
      {n.cv && <Curve n={n} />}
      {n.im !== undefined &&
        (ctx.renderImgui ? (
          ctx.renderImgui(n.im, { w: n.w, h: n.h })
        ) : (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center border border-dashed border-white/15 text-[10px] text-ink-4">
            IMGUI {n.im}
          </div>
        ))}
      {n.ch?.map((c) => <NodeView key={c.i} n={c} ctx={ctx} anc={next} ax={x} ay={y} parentPath={n.bp ?? parentPath} />)}
      {marked && (
        <div className="pointer-events-none absolute bg-accent" style={{ left: 1 - x, top: 0, width: 2, height: n.h }} data-uitk-changed={n.bp} />
      )}
    </div>
  )
})

function unityButton(domButton: number): number {
  return domButton === 2 ? 1 : domButton === 1 ? 2 : 0
}

export function UitkSection({ data, onInput, renderImgui, changed, className }: UitkSectionProps) {
  noteRender('UitkSection')
  useMemo(() => ingestUitkTextures(data), [data])
  const index = useMemo(() => buildIndex(data.root), [data.root])
  const rootRef = useRef<HTMLDivElement>(null)
  const pressRef = useRef<{ button: number; pointerId: number; clicks: number } | null>(null)
  const lastClickRef = useRef<ClickMark | null>(null)
  const moveRef = useRef<{ x: number; y: number; buttons: number; mods: number } | null>(null)
  const rafRef = useRef(0)
  const [editing, setEditing] = useState<{ field: number; input: number; value: string } | null>(null)
  const onInputRef = useRef(onInput)
  onInputRef.current = onInput
  const indexRef = useRef(index)
  indexRef.current = index
  const skin = data.skin ?? 'dark'
  const ctx = useMemo<Ctx>(() => ({ renderImgui, changed, skin }), [renderImgui, changed, skin])

  const local = useCallback((clientX: number, clientY: number) => {
    const el = rootRef.current
    const r = el?.getBoundingClientRect()
    const w = el?.offsetWidth ?? 0
    const k = r && w > 0 && Math.abs(r.width / w - 1) > 0.02 ? r.width / w : 1
    return { x: (clientX - (r?.left ?? 0)) / k, y: (clientY - (r?.top ?? 0)) / k }
  }, [])

  const nodeAt = (target: EventTarget | null): number | null => {
    const el = (target as HTMLElement | null)?.closest?.('[data-uitk-id]') as HTMLElement | null
    if (!el || !rootRef.current?.contains(el)) return null
    return Number(el.dataset.uitkId)
  }

  const textFieldFor = (id: number | null): { field: UitkNode; input: number } | null => {
    for (let cur = id; cur !== null && cur !== undefined; cur = index.parent.get(cur) ?? null) {
      const field = index.inputOwner.get(cur)
      if (field) return { field, input: cur }
    }
    return null
  }

  const inImgui = (target: EventTarget | null): boolean => {
    const el = (target as HTMLElement | null)?.closest?.('[data-uitk-imgui]') as HTMLElement | null
    return !!el && !!rootRef.current?.contains(el)
  }

  const flushMove = useCallback(() => {
    rafRef.current = 0
    const m = moveRef.current
    const press = pressRef.current
    moveRef.current = null
    if (!m || !press) return
    onInputRef.current({ op: 'pointer', type: 'move', x: m.x, y: m.y, button: press.button, clicks: 0, buttons: m.buttons, mods: m.mods })
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (inImgui(e.target)) return
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    const id = nodeAt(e.target)
    const text = e.button === 0 ? textFieldFor(id) : null
    if (text && !text.field.d && !text.field.ro) {
      e.preventDefault()
      setEditing({ field: text.field.i, input: text.input, value: text.field.txt ?? '' })
      return
    }
    rootRef.current?.focus({ preventScroll: true })
    e.preventDefault()
    const p = local(e.clientX, e.clientY)
    const button = unityButton(e.button)
    lastClickRef.current = pressClick(lastClickRef.current, e.timeStamp, p.x, p.y, button, e.detail)
    const clicks = lastClickRef.current.n
    pressRef.current = { button, pointerId: e.pointerId, clicks }
    try {
      rootRef.current?.setPointerCapture(e.pointerId)
    } catch {
    }
    onInput({ op: 'pointer', type: 'down', x: p.x, y: p.y, button, clicks, buttons: e.buttons, mods: uitkMods(e) })
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!pressRef.current || pressRef.current.pointerId !== e.pointerId) return
    const p = local(e.clientX, e.clientY)
    moveRef.current = { x: p.x, y: p.y, buttons: e.buttons, mods: uitkMods(e) }
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushMove)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const press = pressRef.current
    if (!press || press.pointerId !== e.pointerId) return
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      flushMove()
    }
    pressRef.current = null
    try {
      rootRef.current?.releasePointerCapture(e.pointerId)
    } catch {
    }
    const p = local(e.clientX, e.clientY)
    onInput({ op: 'pointer', type: 'up', x: p.x, y: p.y, button: press.button, clicks: press.clicks, buttons: e.buttons, mods: uitkMods(e) })
  }

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (inImgui(e.target)) return
      const idx = indexRef.current
      for (let cur = nodeAt(e.target); cur !== null && cur !== undefined; cur = idx.parent.get(cur) ?? null) {
        const n = idx.byId.get(cur)
        const sc = n?.sc
        if (!sc) continue
        const canY = sc[3] > 0 && ((e.deltaY > 0 && sc[1] < sc[3] - 0.5) || (e.deltaY < 0 && sc[1] > 0.5))
        const canX = sc[2] > 0 && ((e.deltaX > 0 && sc[0] < sc[2] - 0.5) || (e.deltaX < 0 && sc[0] > 0.5))
        if (!canY && !canX) continue
        e.preventDefault()
        const p = local(e.clientX, e.clientY)
        const scale = e.deltaMode === 1 ? 1 : 1 / WHEEL_LINE
        onInputRef.current({ op: 'wheel', x: p.x, y: p.y, dx: e.deltaX * scale, dy: e.deltaY * scale, mods: uitkMods(e) })
        return
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.setAttribute('data-drift-wheel', '')
    return () => el.removeEventListener('wheel', onWheel)
  }, [local])

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>, type: 'down' | 'up'): void => {
    if (e.target !== rootRef.current || !FORWARDED_KEYS.has(e.key)) return
    e.preventDefault()
    onInput({ op: 'key', type, key: e.key, code: e.code, mods: uitkMods(e) })
  }

  const commit = (value: string): void => {
    const ed = editing
    setEditing(null)
    if (!ed) return
    const field = index.byId.get(ed.field)
    if (field && value !== (field.txt ?? '')) onInput({ op: 'set', node: ed.field, value })
    rootRef.current?.focus({ preventScroll: true })
  }

  const editBox = editing ? index.byId.get(editing.input) : undefined
  const editAt = editing ? index.abs.get(editing.input) : undefined
  const editField = editing ? index.byId.get(editing.field) : undefined
  useEffect(() => {
    if (editing && (!editBox || !editField || editField.d)) setEditing(null)
  }, [editing, editBox, editField])

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      className={`relative select-none text-ink-2 outline-none ${className ?? ''}`}
      style={{ width: data.w, height: data.h, fontFamily: FONT }}
      data-uitk-section
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => onKey(e, 'down')}
      onKeyUp={(e) => onKey(e, 'up')}
    >
      {data.root && <NodeView n={data.root} ctx={ctx} anc={ROOT_ANCESTRY} ax={0} ay={0} />}
      {editing && editBox && editAt && editField && (
        <EditBox
          key={`${editing.field}`}
          node={editBox}
          at={editAt}
          multiline={editField.ml === 1}
          password={editField.pw === 1}
          initial={editing.value}
          onCommit={commit}
          onCancel={() => {
            setEditing(null)
            rootRef.current?.focus({ preventScroll: true })
          }}
        />
      )}
    </div>
  )
}

function EditBox({
  node,
  at,
  multiline,
  password,
  initial,
  onCommit,
  onCancel
}: {
  node: UitkNode
  at: { x: number; y: number }
  multiline: boolean
  password: boolean
  initial: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const done = useRef(false)
  const finish = (value: string | null): void => {
    if (done.current) return
    done.current = true
    if (value === null) onCancel()
    else onCommit(value)
  }
  const style: CSSProperties = {
    position: 'absolute',
    left: at.x,
    top: at.y,
    width: node.w,
    height: node.h,
    boxSizing: 'border-box',
    borderRadius: radius(node.rad) ?? '3px',
    fontSize: 12,
    fontFamily: FONT,
    padding: multiline ? '1px 3px' : '0 3px',
    resize: 'none',
    userSelect: 'text',
    zIndex: 5
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      finish(null)
    } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      finish(e.currentTarget.value)
    }
  }
  const common = {
    autoFocus: true,
    defaultValue: initial,
    spellCheck: false,
    style,
    className: 'border border-accent bg-sunken text-ink outline-none',
    onKeyDown,
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => finish(e.currentTarget.value),
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => e.currentTarget.select(),
    'data-uitk-edit': node.i
  }
  return multiline ? <textarea {...common} /> : <input {...common} type={password ? 'password' : 'text'} />
}
