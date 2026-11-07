import { createContext, isValidElement, memo, useContext, useMemo, type CSSProperties, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  CircleHelp,
  CircleX,
  EllipsisVertical,
  Filter,
  GripHorizontal,
  Info,
  Link2,
  Minus,
  Pipette,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  TriangleAlert,
  Unlink2,
  X,
  type LucideIcon
} from 'lucide-react'
import type { TiCurveDraw, TiDraw, TiRectDraw, TiSection, TiStyle, TiStyleDraw, TiTextureDraw, TiVectorDraw } from '@shared/tuner-inspector'
import { cssColor, isWhite, mulColor, parseHex, parseRichText, pickState, trackKey, type Rgba } from '../../../lib/tuner/inspector/model'
import { isGrey, THEMED_CHECKER, unityFontFamily, type TexEntry, type TextureStore } from '../../../lib/tuner/inspector/textures'
import { chromeIconFor, styleHasBg, widgetFor, type ChromeIcon, type Widget } from '../../../lib/tuner/inspector/widgets'
import { inspectorFields, islandControls, learnShownLabels } from '../../../lib/tuner/inspector/fields'
import { isTmpIcon, tmpIconMask, tmpSectionHeaderBox } from '../../../lib/tuner/inspector/tmp-styles'
import { cssMatrix, isMaskIcon, nineSlice, roleColor, roleOpacity, segmentRadius, shiftMatrix } from '../../../lib/tuner/inspector/rect-chrome'
import { noteRender } from '../../../lib/tuner/perf'
import { TouchMarks } from './TouchMarks'

const HIDPI = typeof window !== 'undefined' && window.devicePixelRatio >= 1.5

const ICONS: Record<ChromeIcon, LucideIcon> = {
  help: CircleHelp,
  preset: SlidersHorizontal,
  menu: EllipsisVertical,
  dropdown: ChevronDown,
  warning: TriangleAlert,
  info: Info,
  error: CircleX,
  plus: Plus,
  minus: Minus,
  link: Link2,
  unlink: Unlink2,
  search: Search,
  close: X,
  refresh: RefreshCw,
  settings: Settings,
  picker: CircleDot
}

const ICON_TONE: Partial<Record<ChromeIcon, string>> = {
  warning: 'text-amber-400',
  info: 'text-sky-400',
  error: 'text-rose-400'
}

interface SectionProps {
  sec: TiSection
  styles: Map<number, TiStyle>
  store: TextureStore
  texVersion: number
  hoverId: number
  changed?: (componentKey: string, propertyPath: string) => boolean
  uitk?: ReactNode
}

function sameShallow(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) if (a[k] !== b[k]) return false
  return true
}

function sameNode(a: ReactNode, b: ReactNode): boolean {
  if (a === b) return true
  if (!isValidElement(a) || !isValidElement(b)) return false
  return a.type === b.type && a.key === b.key && sameShallow(a.props as Record<string, unknown>, b.props as Record<string, unknown>)
}

export interface FilterBadge {
  x: number
  y: number
  w: number
  h: number
  text: string
  tip: string
}

export function filterBadge(sec: TiSection): FilterBadge | null {
  const f = sec.filter
  if (!f || sec.kind !== 'component' || f.total <= 0) return null
  const text = `${f.shown}/${f.total}`
  let right = sec.w - 66
  for (const d of sec.draws ?? []) if (d.k === 's' && d.c === undefined && d.id && d.y < 6 && d.h <= 18 && d.x > sec.w * 0.6 && d.x - 6 < right) right = d.x - 6
  const w = 15 + text.length * 5.6
  const fields = f.total === 1 ? 'field' : 'fields'
  return { x: right - w, y: 4, w, h: 14, text, tip: `The agent picked ${f.shown} of ${f.total} ${fields} to show here.` }
}

function FilterMark({ sec }: { sec: TiSection }) {
  const b = filterBadge(sec)
  if (!b) return null
  return (
    <div
      data-ti-filter={b.text}
      data-ti-filter-tip={b.tip}
      className="pointer-events-none absolute flex items-center justify-end gap-[3px] font-[system-ui] text-[10px] leading-none tabular-nums text-zinc-400/80"
      style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
    >
      <Filter className="h-[9px] w-[9px] shrink-0" strokeWidth={2.25} />
      {b.text}
    </div>
  )
}

function sameSectionProps(a: SectionProps, b: SectionProps): boolean {
  return (
    a.sec === b.sec &&
    a.styles === b.styles &&
    a.store === b.store &&
    a.texVersion === b.texVersion &&
    a.hoverId === b.hoverId &&
    a.changed === b.changed &&
    sameNode(a.uitk, b.uitk)
  )
}

interface Flags {
  on: boolean
  hover: boolean
  active: boolean
  focus: boolean
  off: boolean
}

function tintedImage(store: TextureStore, tex: TexEntry, tint: Rgba | null): { url?: string; filter?: string; opacity: number } {
  if (!tex.url) return { opacity: 1 }
  if (!tint || isWhite(tint)) return { url: tex.url, opacity: 1 }
  if (isGrey(tint)) return { url: tex.url, filter: tint.r < 0.995 ? `brightness(${tint.r.toFixed(3)})` : undefined, opacity: tint.a }
  const url = store.tinted(tex, tint)
  return url ? { url, opacity: tint.a } : { url: tex.url, filter: `brightness(${((tint.r + tint.g + tint.b) / 3).toFixed(3)})`, opacity: tint.a }
}

function fontCss(style: TiStyle, forceBold = false): CSSProperties {
  const fst = style.fst ?? 0
  const name = style.f ?? ''
  const bold = forceBold || (fst & 1) === 1 || /Bold/i.test(name)
  const italic = (fst & 2) === 2 || /Italic/i.test(name)
  return {
    fontFamily: unityFontFamily(name),
    fontSize: `${style.fs}px`,
    fontWeight: bold ? 600 : 400,
    fontStyle: italic ? 'italic' : 'normal',
    lineHeight: style.lh ? `${style.lh}px` : 'normal'
  }
}

function multiplyColor(tint: Rgba | null): string | undefined {
  if (!tint || isWhite(tint)) return undefined
  const k = (v: number): string => Math.max(0, Math.min(1, v)).toFixed(3)
  return `rgb(from currentColor calc(r * ${k(tint.r)}) calc(g * ${k(tint.g)}) calc(b * ${k(tint.b)}) / calc(alpha * ${k(tint.a)}))`
}

const DisabledDraw = createContext(false)

function TintOverlay({ tint, radius }: { tint: Rgba | null; radius?: string }) {
  const disabled = useContext(DisabledDraw)
  if (!tint || isWhite(tint)) return null
  if (disabled) {
    if (isGrey(tint)) return null
    return (
      <div
        className="pointer-events-none absolute inset-0"
        style={{ backgroundColor: cssColor({ ...tint, a: 1 }), opacity: tint.a * 0.3, borderRadius: radius }}
      />
    )
  }
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{ backgroundColor: cssColor({ ...tint, a: 1 }), mixBlendMode: 'multiply', opacity: tint.a, borderRadius: radius }}
    />
  )
}

function RichText({ text, rich }: { text: string; rich: boolean }) {
  if (!rich || !text.includes('<')) return <>{text}</>
  return (
    <>
      {parseRichText(text).map((r, i) => (
        <span
          key={i}
          style={{
            fontWeight: r.bold ? 600 : undefined,
            fontStyle: r.italic ? 'italic' : undefined,
            color: r.color,
            fontSize: r.size ? `${r.size}px` : undefined
          }}
        >
          {r.text}
        </span>
      ))}
    </>
  )
}

function ChromeGlyph({ icon, size, className }: { icon: ChromeIcon; size: number; className?: string }) {
  const Icon = ICONS[icon]
  return <Icon style={{ width: size, height: size }} strokeWidth={2} className={`shrink-0 ${className ?? ICON_TONE[icon] ?? ''}`} />
}

function ContentImage({
  store,
  tex,
  fg,
  cw,
  ch,
  alpha
}: {
  store: TextureStore
  tex: TexEntry
  fg: Rgba | null
  cw: number
  ch: number
  alpha: number
}) {
  const w0 = tex.w / tex.sc
  const h0 = tex.h / tex.sc
  const k = Math.min(1, cw > 0 ? cw / w0 : 1, ch > 0 ? ch / h0 : 1)
  const chrome = chromeIconFor(tex.name)
  if (chrome) return <ChromeGlyph icon={chrome} size={Math.max(8, Math.min(14, Math.round(Math.min(w0, h0) * k)))} className={ICON_TONE[chrome] ?? 'text-zinc-400'} />
  if (isTmpIcon(tex.name)) return tex.url ? <div data-ti-tmp-icon={tex.name} style={tmpIconMask(tex.url, w0 * k, h0 * k)} /> : null
  if (isMaskIcon(tex.name)) return tex.url ? <div data-ti-mask-icon={tex.name} className="text-zinc-300" style={tmpIconMask(tex.url, w0 * k, h0 * k)} /> : null
  if (tex.solid !== undefined)
    return <div style={{ width: w0 * k, height: h0 * k, flexShrink: 0, backgroundColor: cssColor(mulColor(tex.solid ?? null, fg), alpha) }} />
  const img = tintedImage(store, tex, fg)
  if (!img.url) return null
  return (
    <img
      src={img.url}
      draggable={false}
      alt=""
      style={{ width: w0 * k, height: h0 * k, flexShrink: 0, opacity: img.opacity * alpha, filter: img.filter }}
    />
  )
}

function Content({
  d,
  style,
  store,
  textClass,
  textColor,
  bold,
  pad,
  imageOverride
}: {
  d: TiStyleDraw
  style: TiStyle
  store: TextureStore
  textClass?: string
  textColor?: string
  bold?: boolean
  pad?: [number, number, number, number]
  imageOverride?: ReactNode
}) {
  const ip = style.ip ?? 0
  const text = ip !== 2 ? d.t : undefined
  const tex = ip !== 3 ? store.get(d.img) : undefined
  if (!text && !tex && !imageOverride) return null
  const p = pad ?? style.p ?? [0, 0, 0, 0]
  const co = style.co ?? [0, 0]
  const al = style.al ?? 0
  const h = al % 3
  const v = Math.floor(al / 3)
  const cw = Math.max(0, d.w - p[0] - p[1])
  const ch = Math.max(0, d.h - p[2] - p[3])
  const column = ip === 1
  const flex = ['flex-start', 'center', 'flex-end']
  const fg = parseHex(d.fg)
  const box: CSSProperties = {
    position: 'absolute',
    left: p[0] + co[0],
    top: p[2] + co[1],
    width: cw,
    height: ch,
    display: 'flex',
    gap: tex && text ? 2 : undefined,
    flexDirection: column ? 'column' : 'row',
    alignItems: flex[column ? h : v],
    justifyContent: flex[column ? v : h],
    overflow: style.cl === 1 || style.cl === 2 ? 'hidden' : 'visible',
    color: textColor,
    ...fontCss(style, bold)
  }
  return (
    <div className={textClass} style={box}>
      {imageOverride ?? (tex ? <ContentImage store={store} tex={tex} fg={fg} cw={cw} ch={ch} alpha={1} /> : null)}
      {text ? (
        <span
          style={{
            color: multiplyColor(fg),
            whiteSpace: style.ww ? 'pre-wrap' : 'pre',
            textAlign: ['left', 'center', 'right'][h] as CSSProperties['textAlign'],
            minWidth: 0,
            overflow: style.cl === 2 ? 'hidden' : undefined,
            textOverflow: style.cl === 2 ? 'ellipsis' : undefined,
            overflowWrap: style.ww ? 'anywhere' : undefined
          }}
        >
          <RichText text={text} rich={style.rt === true} />
        </span>
      ) : null}
    </div>
  )
}

function stateTextColor(style: TiStyle, f: Flags): string | undefined {
  if (style.dtc) return undefined
  const st = pickState(style, f)
  return cssColor(parseHex(st.tc))
}

function Frame({
  className,
  radius,
  tint,
  children,
  style
}: {
  className: string
  radius?: string
  tint: Rgba | null
  children?: ReactNode
  style?: CSSProperties
}) {
  return (
    <div className={`absolute inset-0 ${className}`} style={{ borderRadius: radius, ...style }}>
      <TintOverlay tint={tint} radius={radius} />
      {children}
    </div>
  )
}

function ThemedDraw({ d, style, store, f, widget }: { d: TiStyleDraw; style: TiStyle; store: TextureStore; f: Flags; widget: Widget }) {
  const tint = parseHex(d.bg)
  const ownText = stateTextColor(style, f)
  const content = (textClass: string, extra?: { bold?: boolean; pad?: [number, number, number, number]; image?: ReactNode }) => (
    <Content
      d={d}
      style={style}
      store={store}
      textClass={ownText ? undefined : textClass}
      textColor={ownText}
      bold={extra?.bold}
      pad={extra?.pad}
      imageOverride={extra?.image}
    />
  )
  const fieldFrame = `rounded-[3px] border bg-sunken ${f.focus ? 'border-sky-500/70' : f.hover ? 'border-white/20' : 'border-white/10'}`
  switch (widget) {
    case 'none':
      return content('text-zinc-300')
    case 'label':
      return content(f.focus ? 'text-sky-300' : 'text-zinc-300')
    case 'boldLabel':
      return content(f.focus ? 'text-sky-300' : 'text-zinc-200', { bold: true })
    case 'miniLabel':
      return content('text-zinc-500')
    case 'title':
      return content('text-zinc-200', { bold: true })
    case 'field':
    case 'boldField':
      return (
        <>
          <Frame className={fieldFrame} tint={tint} />
          {content('text-zinc-100', { bold: widget === 'boldField' })}
        </>
      )
    case 'objectThumbMini':
      return (
        <>
          <Frame className={fieldFrame} tint={tint} style={{ right: 'auto', width: Math.max(0, d.w - 14) }} />
          <div data-ti-picker className="absolute" style={{ left: d.w - 10, top: Math.round((d.h - 7) / 2), width: 7, height: 7 }}>
            <CircleDot className="block h-full w-full text-zinc-400" strokeWidth={3} />
          </div>
        </>
      )
    case 'objectThumb':
      return <Frame className={fieldFrame} tint={tint} />
    case 'objectThumbSelect':
      return (
        <div
          data-ti-picker
          className="absolute bottom-0 right-0 flex items-center justify-center rounded-br-[3px] rounded-tl-[3px] border-l border-t border-white/10 bg-white/[0.08] text-[9px] text-zinc-300"
          style={{ width: Math.min(36, d.w), height: Math.min(14, d.h) }}
        >
          {d.t}
        </div>
      )
    case 'searchField':
      return (
        <>
          <Frame className={`${fieldFrame} rounded-full`} tint={tint} />
          <div className="absolute left-1 top-0 flex h-full items-center">
            <Search className="h-3 w-3 text-zinc-500" />
          </div>
          {content('text-zinc-100')}
        </>
      )
    case 'popup': {
      const p = style.p ?? [0, 0, 0, 0]
      return (
        <>
          <Frame
            className={`rounded-[3px] border ${f.focus ? 'border-sky-500/70' : f.hover || f.active ? 'border-white/20' : 'border-white/10'} ${f.active ? 'bg-white/10' : 'bg-white/[0.05]'}`}
            tint={tint}
          />
          {content('text-zinc-100', { pad: [Math.max(p[0], 5), Math.max(p[1], 16), p[2], p[3]] })}
          <div className="pointer-events-none absolute right-1 top-0 flex h-full items-center">
            <ChevronDown className="h-3 w-3 text-zinc-400" />
          </div>
        </>
      )
    }
    case 'button':
    case 'miniButton':
      return (
        <>
          <Frame
            radius={segmentRadius(style.n)}
            className={`rounded-[3px] border ${
              f.on ? 'border-sky-500/50 bg-sky-500/25' : f.active ? 'border-white/20 bg-white/15' : f.hover ? 'border-white/20 bg-white/10' : 'border-white/15 bg-white/[0.06]'
            } ${f.focus ? 'ring-1 ring-sky-500/60' : ''}`}
            tint={tint}
          />
          {content('text-zinc-100')}
        </>
      )
    case 'toggle': {
      const box = Math.min(14, d.h - 2)
      const top = Math.round((d.h - box) / 2)
      const mixed = d.t === undefined && /mixed/i.test(style.n)
      return (
        <>
          <div
            className={`absolute flex items-center justify-center rounded-[3px] border ${
              f.focus ? 'border-sky-400' : f.hover ? 'border-white/50' : 'border-white/30'
            } ${f.active ? 'bg-white/15' : 'bg-white/5'}`}
            style={{ left: 1, top, width: box, height: box }}
          >
            <TintOverlay tint={tint} radius="3px" />
            {f.on && !mixed && <Check className="text-sky-400" style={{ width: box - 3, height: box - 3 }} strokeWidth={3.5} />}
            {mixed && <Minus className="text-sky-400" style={{ width: box - 4, height: box - 4 }} strokeWidth={3.5} />}
          </div>
          {content(f.focus ? 'text-sky-300' : 'text-zinc-300')}
        </>
      )
    }
    case 'foldout':
    case 'titlebarFoldout': {
      const top = Math.round((Math.min(d.h, 18) - 12) / 2)
      return (
        <>
          <div className="absolute left-0 flex items-center justify-center" style={{ top, width: 13, height: 12 }}>
            <ChevronRight
              className={`h-3 w-3 transition-transform ${f.on ? 'rotate-90' : ''} ${f.focus || f.active ? 'text-sky-400' : 'text-zinc-500'}`}
              strokeWidth={2.5}
            />
          </div>
          {content(f.focus ? 'text-sky-300' : 'text-zinc-200')}
        </>
      )
    }
    case 'tmpSectionHeader':
      return (
        <>
          <div className="absolute rounded-[3px] border-y border-white/[0.06] bg-white/[0.06]" style={tmpSectionHeaderBox(style.o, d.w, d.h)} />
          {content('text-zinc-200')}
        </>
      )
    case 'titlebar':
      return (
        <>
          <Frame className={`border-t border-white/5 ${f.hover ? 'bg-white/[0.06]' : 'bg-white/[0.035]'}`} tint={tint} />
          {content('text-zinc-200', { bold: true })}
        </>
      )
    case 'bigTitle':
      return (
        <>
          <Frame className="border-b border-white/5 bg-white/[0.02]" tint={tint} />
          {content('text-zinc-200')}
        </>
      )
    case 'toolbar':
      return (
        <>
          <Frame className="border-b border-t border-white/5 bg-white/[0.03]" tint={tint} />
          {content('text-zinc-300')}
        </>
      )
    case 'tab':
      return (
        <>
          <Frame
            className={`border border-white/10 ${f.on ? 'bg-white/10' : f.hover ? 'bg-white/[0.06]' : 'bg-white/[0.03]'} ${/first/i.test(style.n) ? 'rounded-l-[3px]' : /last/i.test(style.n) ? 'rounded-r-[3px]' : ''}`}
            tint={tint}
          />
          {content(f.on ? 'text-zinc-100' : 'text-zinc-400')}
        </>
      )
    case 'command':
      return (
        <>
          <Frame
            className={`border ${f.on ? 'border-sky-500/50 bg-sky-500/25' : f.hover ? 'border-white/20 bg-white/10' : 'border-white/15 bg-white/[0.06]'} ${
              /left/i.test(style.n) ? 'rounded-l-[3px]' : /right/i.test(style.n) ? 'rounded-r-[3px]' : /mid/i.test(style.n) ? '' : 'rounded-[3px]'
            }`}
            tint={tint}
          />
          {content('text-zinc-200')}
        </>
      )
    case 'iconButton':
    case 'paneOptions':
    case 'plusButton': {
      const imgTex = store.get(d.img)
      const chrome: ChromeIcon | null =
        widget === 'paneOptions' ? 'menu' : widget === 'plusButton' ? (/minus/i.test(style.n) ? 'minus' : 'plus') : chromeIconFor(imgTex?.name)
      const size = Math.max(10, Math.min(14, Math.min(d.w, d.h) - 2))
      return (
        <div className={`absolute inset-0 flex items-center justify-center rounded ${f.hover || f.active ? 'bg-white/10' : ''}`}>
          {chrome ? (
            <ChromeGlyph icon={chrome} size={size} className={f.hover ? 'text-zinc-100' : 'text-zinc-400'} />
          ) : (
            content('text-zinc-300')
          )}
        </div>
      )
    }
    case 'helpBox': {
      const imgTex = store.get(d.img)
      const icon = chromeIconFor(imgTex?.name)
      return (
        <>
          <Frame className="rounded-[3px] border border-white/10 bg-white/[0.03]" tint={tint} />
          {content('text-zinc-300', { image: icon ? <ChromeGlyph icon={icon} size={Math.min(20, d.h - 8)} /> : undefined })}
        </>
      )
    }
    case 'sliderTrack':
      return (
        <div className="absolute left-0 right-0 flex items-center" style={{ top: 0, height: d.h }}>
          <div className="h-[3px] w-full rounded-full bg-white/15" />
        </div>
      )
    case 'sliderThumb': {
      const s = Math.min(12, d.h, d.w + 2)
      return (
        <div className="absolute flex items-center justify-center" style={{ left: 0, top: 0, width: d.w, height: d.h }}>
          <div
            className={`rounded-full border ${f.active || f.hover ? 'border-sky-300 bg-sky-400' : 'border-zinc-400 bg-zinc-300'}`}
            style={{ width: s, height: s, flexShrink: 0 }}
          />
        </div>
      )
    }
    case 'box':
    case 'listBackground':
      return (
        <>
          <Frame className={`border border-white/10 bg-sunken/60 ${widget === 'listBackground' ? '' : 'rounded-[3px]'}`} tint={tint} />
          {content('text-zinc-300')}
        </>
      )
    case 'listHeader':
      return (
        <>
          <Frame className="rounded-t-[3px] border border-white/10 bg-white/[0.04]" tint={tint} />
          {content('text-zinc-200')}
        </>
      )
    case 'listFooter':
      return <Frame className="rounded-b-[3px] border border-t-0 border-white/10 bg-white/[0.04]" tint={tint} />
    case 'listFooterButton': {
      const imgTex = store.get(d.img)
      const chrome = chromeIconFor(imgTex?.name) ?? (d.t === '-' ? 'minus' : d.t === '+' ? 'plus' : null)
      return (
        <div className={`absolute inset-0 flex items-center justify-center rounded ${f.hover || f.active ? 'bg-white/10' : ''}`}>
          {chrome ? <ChromeGlyph icon={chrome} size={12} className={f.hover ? 'text-zinc-100' : 'text-zinc-400'} /> : content('text-zinc-300')}
        </div>
      )
    }
    case 'listElement':
      return (
        <>
          {f.on && <Frame className={f.focus ? 'bg-sky-500/30' : 'bg-white/10'} tint={tint} />}
          {content('text-zinc-300')}
        </>
      )
    case 'dragHandle':
      return (
        <div className="absolute inset-0 flex items-center justify-center">
          <GripHorizontal className="h-3 w-3 text-zinc-500" />
        </div>
      )
    case 'progressBack':
      return <Frame className="rounded-[3px] border border-white/10 bg-sunken" tint={tint} />
    case 'progressBar':
      return <Frame className="rounded-[3px] bg-sky-500/60" tint={tint} />
    case 'moduleTitle':
      return (
        <>
          <Frame
            className={`rounded-[3px] border border-white/10 ${f.on ? 'bg-white/[0.07]' : 'bg-white/[0.04]'} ${f.hover ? 'border-white/20' : ''}`}
            tint={tint}
          />
          {content('text-zinc-200')}
        </>
      )
    case 'objectPicker':
      return (
        <div className={`absolute inset-0 flex items-center justify-center rounded ${f.hover ? 'bg-white/10' : ''}`}>
          <CircleDot className={`h-3 w-3 ${f.hover ? 'text-zinc-100' : 'text-zinc-400'}`} />
        </div>
      )
    case 'dropdownArrow':
      return (
        <div className={`absolute inset-0 flex items-center justify-center rounded ${f.hover ? 'bg-white/10' : ''}`}>
          <ChevronDown className="h-3 w-3 text-zinc-400" />
        </div>
      )
    case 'linkButton':
      return (
        <div className={`absolute inset-0 flex items-center justify-center rounded ${f.hover ? 'bg-white/10' : ''}`}>
          {f.on ? <Link2 className="h-3.5 w-3.5 text-sky-400" /> : <Unlink2 className="h-3.5 w-3.5 text-zinc-500" />}
        </div>
      )
    case 'colorField': {
      const p = style.p ?? [0, 0, 0, 0]
      return (
        <>
          <Frame className={`rounded-[3px] border ${f.focus ? 'border-sky-500/70' : f.hover ? 'border-white/20' : 'border-white/10'}`} tint={tint} />
          {p[1] >= 12 && (
            <div className="absolute top-0 flex h-full items-center justify-center" style={{ right: 0, width: p[1] }}>
              <Pipette className="h-3 w-3 text-zinc-400" />
            </div>
          )}
        </>
      )
    }
    case 'generic':
    default:
      return (
        <>
          <Frame className="rounded-[3px] bg-white/[0.04]" tint={tint} />
          {content('text-zinc-300')}
        </>
      )
  }
}

function CustomDraw({ d, style, store, f }: { d: TiStyleDraw; style: TiStyle; store: TextureStore; f: Flags }) {
  const st = pickState(style, f)
  const bgTint = parseHex(d.bg)
  const texId = HIDPI ? st.bg2 ?? st.bg : st.bg ?? st.bg2
  const tex = store.get(texId)
  let bg: ReactNode = null
  if (tex) {
    const scale = texId === st.bg2 && st.bg2 !== undefined ? 2 : 1
    const o = style.o ?? [0, 0, 0, 0]
    const box: CSSProperties = {
      position: 'absolute',
      left: -o[0],
      top: -o[2],
      width: d.w + o[0] + o[1],
      height: d.h + o[2] + o[3],
      boxSizing: 'border-box'
    }
    if (tex.checker) {
      box.backgroundImage = THEMED_CHECKER
      box.backgroundSize = '8px 8px'
    } else if (tex.solid !== undefined) box.backgroundColor = cssColor(mulColor(tex.solid ?? null, bgTint))
    else {
      const img = tintedImage(store, tex, bgTint)
      if (img.url) {
        const b = style.b ?? [0, 0, 0, 0]
        if (b[0] || b[1] || b[2] || b[3]) {
          const nine = nineSlice(b, scale, tex.w, tex.h)
          box.borderStyle = 'solid'
          box.borderWidth = nine.width.map((v) => `${v}px`).join(' ')
          box.borderImageSource = `url(${img.url})`
          box.borderImageSlice = `${nine.slice.join(' ')} fill`
          box.borderImageRepeat = 'stretch'
        } else {
          box.backgroundImage = `url(${img.url})`
          box.backgroundSize = '100% 100%'
        }
        box.opacity = img.opacity
        if (img.filter) box.filter = img.filter
      }
    }
    bg = <div data-ti-checker={tex.checker ? 'theme' : undefined} style={box} />
  }
  return (
    <>
      {bg}
      <Content d={d} style={style} store={store} textColor={cssColor(parseHex(st.tc))} />
    </>
  )
}

const StyleDraw = memo(function StyleDraw({
  d,
  style,
  store,
  hovered,
  texVersion
}: {
  d: TiStyleDraw
  style: TiStyle
  store: TextureStore
  hovered: boolean
  texVersion: number
}) {
  void texVersion
  const f: Flags = { on: d.on === 1, hover: d.hv === 1 || hovered, active: d.ac === 1, focus: d.fc === 1, off: d.off === 1 }
  const skin = style.sk === 1
  const widget = skin ? widgetFor(style.n, styleHasBg(style), !!d.t || d.img !== undefined) : null
  if (widget === 'none' && !d.t && d.img === undefined) return null
  if (!skin && !d.t && d.img === undefined && !styleHasBg(style) && !d.role) return null
  return (
    <div
      data-ti-style={style.n}
      data-ti-widget={widget ?? 'custom'}
      data-ti-text={d.t}
      data-ti-id={d.id}
      data-ti-has-tip={d.tip ? '' : undefined}
      data-ti-on={f.on ? 'true' : 'false'}
      data-ti-off={f.off ? '' : undefined}
      data-ti-focus={f.focus ? 'true' : undefined}
      style={{
        position: 'absolute',
        left: d.x,
        top: d.y,
        width: d.w,
        height: d.h,
        pointerEvents: 'none',
        opacity: f.off ? 0.5 : undefined
      }}
    >
      {skin ? (
        <DisabledDraw.Provider value={f.off}>
          <ThemedDraw d={d} style={style} store={store} f={f} widget={widget as Widget} />
        </DisabledDraw.Provider>
      ) : d.role ? (
        <div
          data-ti-role={d.role}
          className="absolute inset-0"
          style={{ border: `1px solid ${roleColor(d.role)}`, opacity: roleOpacity(d.role, parseHex(d.bg)?.a ?? 1) }}
        />
      ) : (
        <CustomDraw d={d} style={style} store={store} f={f} />
      )}
    </div>
  )
})

function uvStyle(d: TiTextureDraw): CSSProperties {
  if (!d.uv) return { backgroundSize: '100% 100%' }
  const [ux, uy, uw, uh] = d.uv
  if (uw === 0 || uh === 0) return { backgroundSize: '100% 100%' }
  const bw = d.w / Math.abs(uw)
  const bh = d.h / Math.abs(uh)
  return { backgroundSize: `${bw}px ${bh}px`, backgroundPosition: `${-ux * bw}px ${-(1 - uy - uh) * bh}px` }
}

const TextureDraw = memo(function TextureDraw({ d, store, texVersion }: { d: TiTextureDraw; store: TextureStore; texVersion: number }) {
  void texVersion
  const tex = store.get(d.tex)
  if (!tex) return null
  const tint = parseHex(d.col)
  const disabled = d.off === 1 ? 0.5 : 1
  const box: CSSProperties = { position: 'absolute', left: d.x, top: d.y, width: d.w, height: d.h, pointerEvents: 'none', boxSizing: 'border-box' }
  if (d.br) box.borderRadius = `${d.br[0]}px ${d.br[1]}px ${d.br[2]}px ${d.br[3]}px`
  const chrome = chromeIconFor(tex.name)
  if (chrome)
    return (
      <div data-ti-tex={tex.name} style={{ ...box, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: disabled }}>
        <ChromeGlyph icon={chrome} size={Math.max(8, Math.min(16, Math.min(d.w, d.h)))} className={ICON_TONE[chrome] ?? 'text-zinc-400'} />
      </div>
    )
  if (tex.checker) {
    box.backgroundImage = THEMED_CHECKER
    box.backgroundSize = '8px 8px'
    box.opacity = disabled
    return <div data-ti-checker="theme" style={box} />
  }
  if (tex.solid !== undefined) {
    box.backgroundColor = cssColor(mulColor(tex.solid ?? null, tint), disabled)
  } else {
    const img = tintedImage(store, tex, tint)
    if (!img.url) return null
    if (d.sl) {
      const [l, r, t, b] = d.sl
      box.borderStyle = 'solid'
      box.borderWidth = `${t}px ${r}px ${b}px ${l}px`
      box.borderImageSource = `url(${img.url})`
      box.borderImageSlice = `${t} ${r} ${b} ${l} fill`
    } else {
      box.backgroundImage = `url(${img.url})`
      box.backgroundRepeat = 'no-repeat'
      if (d.sm === 1) {
        box.backgroundSize = 'cover'
        box.backgroundPosition = 'center'
      } else if (d.sm === 2) {
        box.backgroundSize = 'contain'
        box.backgroundPosition = 'center'
      } else Object.assign(box, uvStyle(d))
    }
    box.opacity = img.opacity * disabled
    if (img.filter) box.filter = img.filter
  }
  return <div data-ti-tex={tex.name ?? d.tex} style={box} />
})

const RectDraw = memo(function RectDraw({ d }: { d: TiRectDraw }) {
  const col = d.role ? roleColor(d.role) : cssColor(parseHex(d.col), d.off === 1 ? 0.5 : 1)
  const box: CSSProperties = { position: 'absolute', left: d.x, top: d.y, width: d.w, height: d.h, pointerEvents: 'none', boxSizing: 'border-box' }
  if (d.br) box.borderRadius = `${d.br[0]}px ${d.br[1]}px ${d.br[2]}px ${d.br[3]}px`
  if (d.bw) {
    box.borderStyle = 'solid'
    box.borderColor = col
    box.borderWidth = `${d.bw[1]}px ${d.bw[2]}px ${d.bw[3]}px ${d.bw[0]}px`
  } else box.backgroundColor = col
  if (d.role) box.opacity = roleOpacity(d.role, parseHex(d.col)?.a ?? 1) * (d.off === 1 ? 0.5 : 1)
  return <div data-ti-rect data-ti-role={d.role} style={box} />
})

function pairs(pts: number[] | undefined, sx: number, sy: number, inset = 0): string {
  if (!pts) return ''
  const out: string[] = []
  const ky = Math.max(0, sy - inset * 2)
  for (let i = 0; i + 1 < pts.length; i += 2) out.push(`${(pts[i] * sx).toFixed(2)},${(inset + pts[i + 1] * ky).toFixed(2)}`)
  return out.join(' ')
}

const CURVE_STROKE = 1.25

const CurveDraw = memo(function CurveDraw({ d }: { d: TiCurveDraw }) {
  const line = pairs(d.pts, d.w, d.h, CURVE_STROKE / 2 + 1)
  const line2 = pairs(d.pts2, d.w, d.h, CURVE_STROKE / 2 + 1)
  const col = cssColor(parseHex(d.col))
  return (
    <svg
      data-ti-curve={d.bg ? 'custom' : 'theme'}
      width={d.w}
      height={d.h}
      viewBox={`0 0 ${d.w} ${d.h}`}
      style={{ position: 'absolute', left: d.x, top: d.y, pointerEvents: 'none', opacity: d.off === 1 ? 0.5 : undefined }}
    >
      <rect width={d.w} height={d.h} style={{ fill: d.bg ? cssColor(parseHex(d.bg)) : 'var(--sunken)' }} />
      {d.top && line && <polygon points={`0,0 ${line} ${d.w},0`} fill={cssColor(parseHex(d.top))} />}
      {d.bot && line && <polygon points={`0,${d.h} ${line} ${d.w},${d.h}`} fill={cssColor(parseHex(d.bot))} />}
      {line && line2 && <polygon points={`${line} ${line2.split(' ').reverse().join(' ')}`} fill={col} fillOpacity={0.35} />}
      {line && <polyline points={line} fill="none" stroke={col} strokeWidth={CURVE_STROKE} strokeLinejoin="round" />}
      {line2 && <polyline points={line2} fill="none" stroke={col} strokeWidth={CURVE_STROKE} strokeLinejoin="round" />}
    </svg>
  )
})

const VectorDraw = memo(function VectorDraw({ d }: { d: TiVectorDraw }) {
  const col = cssColor(parseHex(d.col))
  const fill = cssColor(parseHex(d.fill))
  const w = d.lw ?? 1
  const pad = Math.ceil(w)
  const shifted: number[] = []
  for (let i = 0; i + 1 < d.pts.length; i += 2) shifted.push(d.pts[i] + pad, d.pts[i + 1] + pad)
  let shape: ReactNode
  if (d.m === 'l') {
    let path = ''
    for (let i = 0; i + 3 < shifted.length; i += 4) path += `M${shifted[i]} ${shifted[i + 1]}L${shifted[i + 2]} ${shifted[i + 3]}`
    shape = <path d={path} fill="none" stroke={col} strokeWidth={w} strokeDasharray={d.dot ? '2 2' : undefined} />
  } else if (d.m === 'f') {
    shape = <polygon points={pairs(shifted, 1, 1)} fill={fill ?? 'none'} stroke={parseHex(d.col)?.a ? col : 'none'} strokeWidth={w} />
  } else {
    shape = <polyline points={pairs(shifted, 1, 1)} fill="none" stroke={col} strokeWidth={w} strokeLinejoin="round" strokeLinecap="round" />
  }
  return (
    <svg
      data-ti-vector={d.m}
      width={d.w + pad * 2}
      height={d.h + pad * 2}
      style={{ position: 'absolute', left: d.x - pad, top: d.y - pad, pointerEvents: 'none', overflow: 'visible', opacity: d.off === 1 ? 0.5 : undefined }}
    >
      {shape}
    </svg>
  )
})

function drawNode(
  d: TiDraw,
  i: number,
  styles: Map<number, TiStyle>,
  store: TextureStore,
  texVersion: number,
  hoverId: number,
  dx: number,
  dy: number
): ReactNode {
  if (d.mx) {
    const m = shiftMatrix(d.mx, dx, dy)
    return (
      <div key={i} data-ti-mx style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, transform: cssMatrix(m), transformOrigin: '0 0', pointerEvents: 'none' }}>
        {drawNode({ ...d, mx: undefined } as TiDraw, i, styles, store, texVersion, hoverId, dx, dy)}
      </div>
    )
  }
  const shifted = dx || dy ? { ...d, x: d.x - dx, y: d.y - dy } : d
  if (d.k === 's') {
    const style = styles.get(d.st)
    if (!style) return null
    return (
      <StyleDraw key={i} d={shifted as TiStyleDraw} style={style} store={store} hovered={hoverId > 0 && d.id === hoverId} texVersion={texVersion} />
    )
  }
  if (d.k === 't') return <TextureDraw key={i} d={shifted as TiTextureDraw} store={store} texVersion={texVersion} />
  if (d.k === 'c') return <CurveDraw key={i} d={shifted as TiCurveDraw} />
  if (d.k === 'v') return <VectorDraw key={i} d={shifted as TiVectorDraw} />
  return <RectDraw key={i} d={shifted as TiRectDraw} />
}

function drawGroups(
  draws: TiDraw[],
  sec: TiSection,
  styles: Map<number, TiStyle>,
  store: TextureStore,
  texVersion: number,
  hoverId: number
): ReactNode[] {
  const groups: ReactNode[] = []
  let i = 0
  while (i < draws.length) {
    const clip = draws[i].clip ?? -1
    const start = i
    while (i < draws.length && (draws[i].clip ?? -1) === clip) i++
    const rect = clip >= 0 ? sec.clips?.[clip] : undefined
    if (rect) {
      groups.push(
        <div
          key={`g${start}`}
          data-ti-clip={clip}
          style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h, overflow: 'clip', pointerEvents: 'none' }}
        >
          {draws.slice(start, i).map((d, k) => drawNode(d, start + k, styles, store, texVersion, hoverId, rect.x, rect.y))}
        </div>
      )
    } else {
      for (let k = start; k < i; k++) groups.push(drawNode(draws[k], k, styles, store, texVersion, hoverId, 0, 0))
    }
  }
  return groups
}

function islandName(path: string, name: string): string {
  const cut = path.indexOf('/')
  if (cut <= 0) return name
  const own = name.startsWith(path.slice(0, cut + 1)) ? name.slice(cut + 1) : name
  return `${path.slice(0, cut)} ${own}`
}

export function ImguiIsland({
  sec,
  index,
  size,
  styles,
  store,
  texVersion,
  pointer
}: {
  sec: TiSection
  index: number
  size: { w: number; h: number }
  styles: Map<number, TiStyle>
  store: TextureStore
  texVersion: number
  pointer?: {
    down: (e: React.PointerEvent<HTMLDivElement>) => void
    move: (e: React.PointerEvent<HTMLDivElement>) => void
    up: (e: React.PointerEvent<HTMLDivElement>) => void
  }
}) {
  const draws = (sec.draws ?? []).filter((d) => d.c === index)
  const fields = useMemo(() => ((sec.props ?? []).some((p) => p.c === index) ? inspectorFields(sec, styles) : []), [sec, styles, index])
  const extras = useMemo(() => islandControls(sec, styles, index), [sec, styles, index])
  return (
    <div
      data-ti-imgui-island={index}
      className={`relative ${pointer ? 'pointer-events-auto' : 'pointer-events-none'}`}
      style={{ width: size.w, height: size.h }}
      onPointerDown={pointer?.down}
      onPointerMove={pointer?.move}
      onPointerUp={pointer?.up}
      onPointerCancel={pointer?.up}
    >
      {drawGroups(draws, sec, styles, store, texVersion, 0)}
      <TouchMarks cursors={sec.cursors} island={index} />
      {(sec.props ?? []).map((p, k) =>
        p.c !== index || !fields[k] ? null : (
          <div
            key={`p${k}`}
            data-ti-prop={p.p}
            data-ti-prop-kind={p.k}
            data-ti-label={p.l}
            data-ti-name={islandName(p.p, fields[k].name)}
            data-ti-parent={fields[k].parent}
            data-ti-value={fields[k].value === undefined ? undefined : JSON.stringify(fields[k].value)}
            data-ti-v={p.v}
            data-ti-value-widget={fields[k].widget}
            data-ti-value-at={fields[k].at?.join(' ')}
            data-ti-off={fields[k].off ? '' : undefined}
            data-ti-aux={fields[k].aux ? '' : undefined}
            data-ti-override={extras.overrides.get(k)?.on}
            data-ti-override-at={extras.overrides.get(k)?.at}
            data-ti-island-prop={index}
            style={{ position: 'absolute', left: p.x, top: p.y, width: p.w, height: p.h, pointerEvents: 'none' }}
          />
        )
      )}
      {extras.headers.map((h) => (
        <div
          key={`h${h.label}`}
          data-ti-prop={`${h.label}/active`}
          data-ti-prop-kind="Boolean"
          data-ti-label={h.label}
          data-ti-name={h.label}
          data-ti-value={JSON.stringify(h.on)}
          data-ti-value-widget="toggle"
          data-ti-value-at={h.at}
          data-ti-off={h.off ? '' : undefined}
          data-ti-island-prop={index}
          style={{ position: 'absolute', left: h.x, top: h.y, width: h.w, height: h.h, pointerEvents: 'none' }}
        />
      ))}
    </div>
  )
}

export const InspectorSection = memo(function InspectorSection({ sec, styles, store, texVersion, hoverId, changed, uitk }: SectionProps) {
  noteRender('InspectorSection')
  const groups: ReactNode[] = []
  const draws = (sec.draws ?? []).filter((d) => d.c === undefined)
  groups.push(...drawGroups(draws, sec, styles, store, texVersion, hoverId))
  const fields = useMemo(() => {
    const out = inspectorFields(sec, styles)
    learnShownLabels(sec, out)
    return out
  }, [sec, styles])
  const markers: ReactNode[] = []
  const tracked = trackKey(sec)
  if (changed && tracked)
    for (const p of sec.props ?? []) {
      if (p.c !== undefined || !changed(tracked, p.p)) continue
      markers.push(
        <div
          key={`m${p.p}`}
          data-ti-changed={p.p}
          className="pointer-events-none absolute left-0 w-[2px] bg-sky-400"
          style={{ top: p.y, height: p.h }}
        />
      )
    }
  return (
    <div
      data-ti-section={sec.key}
      data-ti-kind={sec.kind}
      data-ti-ui={sec.ui}
      data-ti-editor={sec.editor}
      data-ti-expanded={sec.expanded === undefined ? undefined : sec.expanded ? 'true' : 'false'}
      data-ti-vals={sec.vals?.length ? JSON.stringify(sec.vals) : undefined}
      data-ti-filter={sec.filter && sec.filter.total > 0 ? `${sec.filter.shown}/${sec.filter.total}` : undefined}
      className={sec.kind === 'addComponent' ? 'border-t border-white/5' : undefined}
      style={{ position: 'absolute', left: sec.x, top: sec.y, width: sec.w, height: sec.h, pointerEvents: 'none' }}
    >
      {groups}
      {uitk}
      {markers}
      <FilterMark sec={sec} />
      {(sec.props ?? []).map((p, k) =>
        p.c !== undefined ? null : (
          <div
            key={`p${k}`}
            data-ti-prop={p.p}
            data-ti-prop-kind={p.k}
            data-ti-label={p.l}
            data-ti-name={fields[k].name}
            data-ti-parent={fields[k].parent}
            data-ti-value={fields[k].value === undefined ? undefined : JSON.stringify(fields[k].value)}
            data-ti-v={p.v}
            data-ti-value-widget={fields[k].widget}
            data-ti-value-at={fields[k].at?.join(' ')}
            data-ti-off={fields[k].off ? '' : undefined}
            data-ti-aux={fields[k].aux ? '' : undefined}
            style={{ position: 'absolute', left: p.x, top: p.y, width: p.w, height: p.h, pointerEvents: 'none' }}
          />
        )
      )}
    </div>
  )
}, sameSectionProps)
