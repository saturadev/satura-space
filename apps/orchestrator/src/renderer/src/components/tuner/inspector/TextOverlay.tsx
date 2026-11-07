import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties } from 'react'
import type { TiStyle, TiTextCommit, TiTextFocus } from '@shared/tuner-inspector'
import { unityFontFamily } from '../../../lib/tuner/inspector/textures'

export interface TextOverlayHandle {
  commit: (how: TiTextCommit) => void
}

export const TextOverlay = forwardRef<
  TextOverlayHandle,
  {
    focus: TiTextFocus
    left: number
    top: number
    style: TiStyle | undefined
    onCommit: (value: string, how: TiTextCommit, changed: boolean) => void
    onCancel: () => void
    onLive?: (value: string) => void
  }
>(function TextOverlay({ focus, left, top, style, onCommit, onCancel, onLive }, ref) {
  const [value, setValue] = useState(focus.text)
  const initial = useRef(focus.text)
  const done = useRef(false)
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value

  const commit = (how: TiTextCommit): void => {
    if (done.current) return
    done.current = true
    onCommit(valueRef.current, how, valueRef.current !== initial.current)
  }

  useImperativeHandle(ref, () => ({ commit }))

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.select()
  }, [])

  const p = style?.p ?? [3, 3, 2, 1]
  const bold = (style?.fst ?? 0) & 1 || /Bold/i.test(style?.n ?? '')
  const css: CSSProperties = {
    position: 'absolute',
    left: left + focus.x,
    top: top + focus.y,
    width: focus.w,
    height: focus.h,
    paddingLeft: p[0],
    paddingRight: p[1],
    paddingTop: focus.multiline ? p[2] : 0,
    paddingBottom: focus.multiline ? p[3] : 0,
    fontFamily: unityFontFamily(style?.f),
    fontSize: `${style?.fs ?? 12}px`,
    fontWeight: bold ? 600 : 400,
    lineHeight: focus.multiline && style?.lh ? `${style.lh}px` : undefined,
    boxSizing: 'border-box',
    resize: 'none',
    zIndex: 20
  }
  const cls = 'rounded-[3px] border border-sky-500/70 bg-sunken text-zinc-100 outline-none selection:bg-sky-500/40'
  const onKeyDown = (e: React.KeyboardEvent): void => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      done.current = true
      onCancel()
    } else if (e.key === 'Enter' && (!focus.multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      commit('enter')
    } else if (e.key === 'Tab') {
      e.preventDefault()
      commit('enter')
    }
  }
  const common = {
    'data-ti-text-overlay': focus.control,
    'data-ti-numeric': focus.numeric ? 'true' : undefined,
    value,
    spellCheck: false,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setValue(e.target.value)
      onLive?.(e.target.value)
    },
    onKeyDown,
    onBlur: () => commit('blur'),
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    className: cls,
    style: css
  }
  return focus.multiline ? (
    <textarea ref={inputRef} {...common} />
  ) : (
    <input ref={inputRef} type={focus.password ? 'password' : 'text'} {...common} />
  )
})
