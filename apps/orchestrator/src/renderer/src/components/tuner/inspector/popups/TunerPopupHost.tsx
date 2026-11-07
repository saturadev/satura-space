import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  TunerColor,
  TunerCurve,
  TunerGradient,
  TunerMenuExtra,
  TunerObjectRef,
  TunerPopup,
  TunerPopupAction,
  TunerPopupAnswer
} from '@shared/tuner-inspector-popups'
import { PopupSurface, rectBox, type AnchorGetter } from './PopupSurface'
import { PopupMenu } from './PopupMenu'
import { ColorPicker } from './ColorPicker'
import { ObjectPicker, type ObjectQueryFn } from './ObjectPicker'
import { CurveEditor } from './CurveEditor'
import { GradientEditor } from './GradientEditor'
import { DropdownPicker } from './DropdownPicker'
import { encodeCurve } from './curve-math'

const CHANGE_MS = 60

export interface TunerPopupHostProps {
  popup: TunerPopup | null | undefined
  onAnswer: TunerPopupAnswer
  projectPath: string
  query?: ObjectQueryFn
  extras?: (popup: TunerPopup) => TunerMenuExtra[] | undefined
  renderWindow?: (popup: Extract<TunerPopup, { kind: 'window' }>) => React.ReactNode
  menuAttrs?: (popup: TunerPopup) => Record<string, string> | undefined
  anchor?: AnchorGetter
  beside?: boolean
}

export interface PopupViewOptions {
  extras?: TunerPopupHostProps['extras']
  renderWindow?: TunerPopupHostProps['renderWindow']
  menuAttrs?: TunerPopupHostProps['menuAttrs']
  anchor?: AnchorGetter
  beside?: boolean
}

function windowTitle(data: { content?: string; title?: string }): string {
  if (data.title) return data.title
  const name = (data.content ?? '').split(/[.+]/).pop() ?? ''
  const words = name.replace(/(PopupWindow|Window|Popup|Content|Dropdown)$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim()
  return words || 'Popup'
}

export function TunerPopupHost({ popup, onAnswer, projectPath, query, extras, renderWindow, menuAttrs, anchor, beside }: TunerPopupHostProps) {
  const [, force] = useState(0)
  const closed = useRef(new Set<string | number>())
  const fallback = useCallback<ObjectQueryFn>((q) => window.api.tunerPopup.objects(projectPath, q), [projectPath])
  const onClosed = useCallback((id: string | number) => {
    closed.current.add(id)
    force((n) => n + 1)
  }, [])
  useEffect(() => {
    if (!popup) closed.current.clear()
  }, [popup])
  if (!popup || closed.current.has(popup.id)) return null
  return (
    <PopupView
      key={popup.id}
      popup={popup}
      onAnswer={onAnswer}
      query={query ?? fallback}
      onClosed={onClosed}
      options={{ extras, renderWindow, menuAttrs, anchor, beside }}
    />
  )
}

function useAnswer(popup: TunerPopup, onAnswer: TunerPopupAnswer, onClosed: (id: string | number) => void) {
  const pending = useRef<{ value: unknown; has: boolean; timer: number; last: number }>({ value: undefined, has: false, timer: 0, last: 0 })
  const done = useRef(false)
  const answerRef = useRef(onAnswer)
  answerRef.current = onAnswer

  useEffect(() => () => window.clearTimeout(pending.current.timer), [])

  const change = useCallback(
    (value: unknown): void => {
      if (done.current) return
      const p = pending.current
      p.value = value
      p.has = true
      if (p.timer) return
      const flush = (): void => {
        p.timer = 0
        if (!p.has || done.current) return
        p.has = false
        p.last = performance.now()
        answerRef.current(popup, 'change', p.value)
      }
      const wait = CHANGE_MS - (performance.now() - p.last)
      if (wait <= 0) flush()
      else p.timer = window.setTimeout(flush, wait)
    },
    [popup]
  )

  const finish = useCallback(
    (action: Exclude<TunerPopupAction, 'change'>, value?: unknown): void => {
      if (done.current) return
      done.current = true
      window.clearTimeout(pending.current.timer)
      pending.current.has = false
      answerRef.current(popup, action, value)
      onClosed(popup.id)
    },
    [popup, onClosed]
  )

  return { change, finish }
}

function PopupView({
  popup,
  onAnswer,
  query,
  onClosed,
  options
}: {
  popup: TunerPopup
  onAnswer: TunerPopupAnswer
  query: ObjectQueryFn
  onClosed: (id: string | number) => void
  options: PopupViewOptions
}) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const custom = options.anchor
  const getAnchor: AnchorGetter = useCallback(() => (custom ? custom() : rectBox(anchorRef.current)), [custom])
  const { change, finish } = useAnswer(popup, onAnswer, onClosed)
  const latest = useRef<unknown>(undefined)
  const touched = useRef(false)
  const a = popup.anchor
  const fieldWidth = a.w > 1 ? a.w : undefined

  const onChange = (v: unknown): void => {
    latest.current = v
    touched.current = true
    change(v)
  }

  const commitLatest = (): void => {
    if (touched.current) finish('commit', latest.current)
    else finish('cancel')
  }

  let body: React.ReactNode = null
  switch (popup.kind) {
    case 'menu':
      body = (
        <PopupMenu
          data={popup.data}
          getAnchor={getAnchor}
          minWidth={fieldWidth}
          onPick={(i) => finish('commit', i)}
          onCancel={() => finish('cancel')}
          extras={options.extras?.(popup)?.map((x) => ({ label: x.label, onPick: () => (onClosed(popup.id), x.onPick()) }))}
          attrs={options.menuAttrs?.(popup)}
        />
      )
      break
    case 'color':
      body = (
        <PopupSurface getAnchor={getAnchor} onOutside={commitLatest} kind="color" role="dialog">
          <ColorPicker
            value={popup.data.value}
            hdr={popup.data.hdr}
            showAlpha={popup.data.showAlpha}
            onChange={(c: TunerColor) => onChange(c)}
            onCommit={commitLatest}
            onCancel={() => finish('cancel')}
          />
        </PopupSurface>
      )
      break
    case 'object':
      body = (
        <PopupSurface getAnchor={getAnchor} onOutside={commitLatest} kind="object" role="dialog" minWidth={fieldWidth}>
          <ObjectPicker
            data={popup.data}
            query={query}
            onChange={(r: TunerObjectRef | null) => onChange(r)}
            onCommit={(r) => finish('commit', r)}
            onCancel={() => finish('cancel')}
          />
        </PopupSurface>
      )
      break
    case 'curve':
      body = (
        <PopupSurface getAnchor={getAnchor} onOutside={commitLatest} kind="curve" role="dialog">
          <CurveEditor
            value={popup.data.value}
            ranges={popup.data.ranges}
            color={popup.data.color}
            onChange={(c: TunerCurve) => onChange(encodeCurve(c))}
            onCommit={commitLatest}
            onCancel={() => finish('cancel')}
          />
        </PopupSurface>
      )
      break
    case 'gradient':
      body = (
        <PopupSurface getAnchor={getAnchor} onOutside={commitLatest} kind="gradient" role="dialog">
          <GradientEditor
            value={popup.data.value}
            hdr={popup.data.hdr}
            onChange={(g: TunerGradient) => onChange(g)}
            onCommit={commitLatest}
            onCancel={() => finish('cancel')}
          />
        </PopupSurface>
      )
      break
    case 'window':
      body = options.renderWindow ? (
        <PopupSurface
          getAnchor={getAnchor}
          placement={options.beside ? 'beside' : 'anchor'}
          onOutside={() => finish('cancel')}
          kind="window"
          title={windowTitle(popup.data)}
          role="dialog"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              finish('cancel')
            }
          }}
        >
          {options.renderWindow(popup)}
        </PopupSurface>
      ) : null
      break
    case 'dropdown':
      body = (
        <PopupSurface getAnchor={getAnchor} onOutside={() => finish('cancel')} kind="dropdown" role="dialog">
          <DropdownPicker data={popup.data} minWidth={fieldWidth} onPick={(id) => finish('commit', id)} onCancel={() => finish('cancel')} />
        </PopupSurface>
      )
      break
  }

  return (
    <>
      {!custom && (
        <div
          ref={anchorRef}
          aria-hidden
          data-tuner-popup-anchor={popup.id}
          className="pointer-events-none absolute"
          style={{ left: a.x, top: a.y, width: Math.max(0, a.w), height: Math.max(0, a.h) }}
        />
      )}
      {body}
    </>
  )
}
