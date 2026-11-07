import type { CSSProperties, ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, CircleDot, CircleX, Info, Minus, Pipette, Plus, TriangleAlert } from 'lucide-react'
import { UITK_OWN, UITK_PSEUDO, type UitkNode } from '@shared/tuner-inspector-uitk'
import { THEMED_CHECKER } from '../../../../lib/tuner/inspector/textures'

export interface UitkAncestry {
  checked: boolean
  focus: boolean
  disabled: boolean
  inColor: boolean
  inIconButton: boolean
  inInput: boolean
  inButton: boolean
  inScroller: boolean
  inCollection: boolean
}

export const ROOT_ANCESTRY: UitkAncestry = {
  checked: false,
  focus: false,
  disabled: false,
  inColor: false,
  inIconButton: false,
  inInput: false,
  inButton: false,
  inScroller: false,
  inCollection: false
}

export interface UitkLook {
  cls: string
  style?: CSSProperties
  text?: string
  icon?: ReactNode
  captured: boolean
  hide?: boolean
  hidePicture?: boolean
}

const classCache = new WeakMap<UitkNode, Set<string>>()

export function uitkClasses(n: UitkNode): Set<string> {
  let set = classCache.get(n)
  if (!set) {
    set = new Set(n.c ? n.c.split(' ') : [])
    classCache.set(n, set)
  }
  return set
}

const INPUT_BOX = new Set(['unity-base-text-field__input', 'unity-object-field__input', 'unity-curve-field__input'])
const POPUP_BOX = new Set(['unity-base-popup-field__input', 'unity-enum-field__input'])
const ARROWS = new Set(['unity-base-popup-field__arrow', 'unity-enum-field__arrow'])

const iconFill = 'pointer-events-none absolute inset-0 m-auto'

function sized(n: UitkNode, ratio = 0.8, max = 14): number {
  return Math.max(6, Math.min(max, Math.floor(Math.min(n.w, n.h) * ratio)))
}

export function childAncestry(n: UitkNode, anc: UitkAncestry): UitkAncestry {
  const c = uitkClasses(n)
  const ps = n.ps ?? 0
  const isToggle = c.has('unity-toggle') || n.t === 'Toggle'
  return {
    checked: isToggle ? (ps & UITK_PSEUDO.checked) !== 0 : anc.checked,
    focus: c.has('unity-base-field') ? (ps & UITK_PSEUDO.focus) !== 0 || n.foc === 1 : anc.focus,
    disabled: anc.disabled || n.d === 1,
    inColor: anc.inColor || c.has('unity-color-field'),
    inIconButton: anc.inIconButton || c.has('unity-list-view__add-button') || c.has('unity-list-view__remove-button'),
    inInput: anc.inInput || [...c].some((k) => INPUT_BOX.has(k) || POPUP_BOX.has(k)),
    inButton: anc.inButton || c.has('unity-button'),
    inScroller: anc.inScroller || c.has('unity-scroller'),
    inCollection: anc.inCollection || c.has('unity-collection-view')
  }
}

function parseHex(hex: string): [number, number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return null
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255, parseInt(m[4], 16) / 255]
}

function themedFill(hex: string | undefined, skin: 'dark' | 'light'): string | undefined {
  if (!hex) return undefined
  const rgba = parseHex(hex)
  if (!rgba || rgba[3] < 0.05) return undefined
  const [r, g, b] = rgba
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max > 0 && (max - min) / max > 0.35) return 'color-mix(in srgb, var(--accent) 30%, transparent)'
  const l = (r + g + b) / 3
  if (skin === 'light') {
    if (l > 0.82) return 'var(--sunken)'
    if (l < 0.72) return 'var(--elevated)'
    return undefined
  }
  if (l < 0.19) return 'var(--sunken)'
  if (l > 0.25) return 'var(--elevated)'
  return undefined
}

function defaultText(n: UitkNode, c: Set<string>, anc: UitkAncestry): string {
  if (anc.disabled || n.d === 1) return 'var(--ink-4)'
  if (c.has('unity-base-field__label')) return anc.focus ? 'var(--accent)' : 'var(--ink-2)'
  if (c.has('unity-foldout__text')) return 'var(--ink)'
  if (anc.inInput || anc.inButton || c.has('unity-button')) return 'var(--ink)'
  return 'var(--ink-2)'
}

export function uitkLook(n: UitkNode, anc: UitkAncestry, skin: 'dark' | 'light'): UitkLook {
  const c = uitkClasses(n)
  const own = n.own ?? 0
  const look: UitkLook = { cls: '', captured: false }
  if (n.tx !== undefined) look.text = (own & UITK_OWN.color) !== 0 && n.col ? n.col : defaultText(n, c, anc)

  if (anc.inColor && (c.has('unity-progress-bar__background') || c.has('unity-progress-bar__progress'))) {
    look.captured = true
    return look
  }
  if (anc.inIconButton && c.has('unity-button__image')) {
    look.hidePicture = true
    return look
  }
  if ([...c].some((k) => INPUT_BOX.has(k))) {
    look.cls = `rounded-[3px] bg-sunken ring-1 ring-inset ${anc.focus || (n.ps ?? 0) & UITK_PSEUDO.focus ? 'ring-accent' : 'ring-white/10'}`
    return look
  }
  if ([...c].some((k) => POPUP_BOX.has(k))) {
    look.cls = 'rounded-[3px] bg-elevated ring-1 ring-inset ring-white/10 hover:ring-white/25'
    return look
  }
  if ([...c].some((k) => ARROWS.has(k))) {
    look.icon = <ChevronDown className={`${iconFill} text-ink-3`} style={{ width: sized(n, 1), height: sized(n, 1) }} />
    return look
  }
  if (c.has('unity-list-view__add-button') || c.has('unity-list-view__remove-button')) {
    const Icon = c.has('unity-list-view__add-button') ? Plus : Minus
    look.cls = 'rounded text-ink-3 hover:bg-white/10 hover:text-ink'
    look.icon = <Icon className={iconFill} style={{ width: sized(n, 0.6, 12), height: sized(n, 0.6, 12) }} />
    return look
  }
  if (c.has('unity-button')) {
    look.cls = 'rounded-[3px] bg-elevated ring-1 ring-inset ring-white/10 hover:bg-white/10 active:bg-white/15'
    return look
  }
  if (c.has('unity-toggle__checkmark') && !c.has('unity-foldout__checkmark')) {
    if (anc.checked) {
      look.cls = 'rounded-[3px] bg-accent text-accent-fg'
      look.icon = <Check className={iconFill} strokeWidth={3} style={{ width: sized(n, 0.75), height: sized(n, 0.75) }} />
    } else look.cls = 'rounded-[3px] bg-sunken ring-1 ring-inset ring-white/25'
    return look
  }
  if (c.has('unity-foldout__checkmark')) {
    look.icon = (
      <ChevronRight
        className={`${iconFill} text-ink-3 transition-transform`}
        style={{ width: sized(n, 1), height: sized(n, 1), transform: anc.checked ? 'rotate(90deg)' : undefined }}
      />
    )
    return look
  }
  if (c.has('unity-base-slider__tracker')) {
    look.cls = anc.inScroller ? '' : 'rounded-full bg-white/15'
    return look
  }
  if (c.has('unity-base-slider__dragger')) {
    look.cls = anc.inScroller ? 'rounded bg-white/15 hover:bg-white/25' : 'rounded-full bg-zinc-300 hover:bg-zinc-100'
    return look
  }
  if (c.has('unity-base-slider__dragger-border')) return look
  if (c.has('unity-base-slider__fill')) {
    look.cls = 'bg-accent/60'
    return look
  }
  if (c.has('unity-scroller__low-button') || c.has('unity-scroller__high-button')) {
    look.hide = true
    return look
  }
  if (c.has('unity-help-box')) {
    look.cls = 'rounded ring-1 ring-inset ring-white/10 bg-elevated'
    return look
  }
  if (c.has('unity-help-box__icon')) {
    const size = { width: sized(n, 1, 16), height: sized(n, 1, 16) }
    if (c.has('unity-help-box__icon--warning')) look.icon = <TriangleAlert className={`${iconFill} text-amber-400`} style={size} />
    else if (c.has('unity-help-box__icon--error')) look.icon = <CircleX className={`${iconFill} text-red-400`} style={size} />
    else if (c.has('unity-help-box__icon--info')) look.icon = <Info className={`${iconFill} text-sky-400`} style={size} />
    return look
  }
  if (c.has('unity-object-field__selector')) {
    look.cls = 'rounded-r-[3px] text-ink-3 hover:bg-white/10 hover:text-ink'
    look.icon = <CircleDot className={iconFill} style={{ width: sized(n, 0.7, 12), height: sized(n, 0.7, 12) }} />
    return look
  }
  if (c.has('unity-color-field__eyedropper')) {
    look.cls = 'rounded-r-[3px] text-ink-3 hover:bg-white/10 hover:text-ink'
    look.icon = <Pipette className={iconFill} style={{ width: sized(n, 0.7, 12), height: sized(n, 0.7, 12) }} />
    return look
  }
  if (c.has('unity-color-field__input') || c.has('unity-gradient-field__input')) {
    look.cls = 'rounded-[3px] ring-1 ring-inset ring-white/10'
    return look
  }
  if (c.has('unity-gradient-field__background')) {
    look.style = {
      backgroundImage: THEMED_CHECKER,
      backgroundSize: '8px 8px'
    }
    return look
  }
  if (c.has('unity-list-view__footer')) {
    look.cls = 'rounded-b-[3px] bg-sunken ring-1 ring-inset ring-white/10'
    return look
  }
  if (c.has('unity-collection-view__item--selected')) {
    look.cls = 'bg-accent/25'
    return look
  }
  if (n.t === 'ScrollView' && anc.inCollection) {
    look.cls = 'bg-sunken'
    return look
  }
  if (c.has('unity-list-view__reorderable-handle-bar')) {
    look.cls = 'bg-ink-4'
    return look
  }
  if (c.has('unity-progress-bar__background')) {
    look.cls = 'rounded-[3px] bg-sunken ring-1 ring-inset ring-white/10'
    return look
  }
  if (c.has('unity-progress-bar__progress')) {
    look.cls = 'bg-accent'
    return look
  }
  if (c.has('unity-toolbar')) {
    look.cls = 'bg-panel shadow-[inset_0_-1px_0_var(--hairline)]'
    return look
  }
  if (c.has('unity-box')) {
    look.cls = 'rounded bg-white/[0.03] ring-1 ring-inset ring-white/10'
    return look
  }
  look.style = {}
  if ((own & UITK_OWN.bg) === 0) {
    const fill = themedFill(n.bg, skin)
    if (fill) look.style.backgroundColor = fill
  }
  return look
}
