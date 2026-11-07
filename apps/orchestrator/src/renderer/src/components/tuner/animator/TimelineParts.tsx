import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Box, ChevronDown, ChevronRight, Plus, Search, Trash2, X } from 'lucide-react'
import { useKeepInView } from '../../../lib/floating'
import { frameOf, parseTunerAnimPropChoices, type TunerAnimator, type TunerAnimEvent, type TunerAnimMethod, type TunerAnimPropChoice } from '@shared/tuner-animator'
import { FloatingMenu, MenuLabel, MenuSeparator, menuItemClass } from '../../ui/FloatingMenu'
import { LiftedLayer } from '../../ui/LiftedLayer'
import { channelColor, fmt, keyAtPlayhead, type DopeRow } from '../../../lib/tuner/animator'
import { curveColor, evalKeys, keysRange } from '../../../lib/tuner/curves'
import { componentIcon } from '../../../lib/tuner/component-icons'
import { PopupSurface, rectBox } from '../inspector/popups/PopupSurface'
import { ObjectPicker } from '../inspector/popups/ObjectPicker'
import { PendingState } from '../../ui/PendingState'

export const iconBtn =
  'flex h-5 w-6 shrink-0 items-center justify-center rounded text-ink-2 transition-colors hover:bg-white/10 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent'
export const textBtn = 'h-5 shrink-0 rounded px-2 text-ink-2 transition-colors hover:bg-white/10 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent'

export function rowFill(r: DopeRow, index: number, selected: boolean): string {
  if (selected) return 'color-mix(in srgb, var(--accent) 14%, transparent)'
  if (r.kind === 'summary') return 'color-mix(in srgb, var(--ink) 6%, transparent)'
  if (r.kind === 'object') return 'var(--anim-row-object)'
  if (r.kind === 'component') return 'var(--anim-row-component)'
  if (r.kind === 'section') return 'color-mix(in srgb, var(--anim-row-component) 55%, transparent)'
  return index % 2 === 1 ? 'color-mix(in srgb, var(--ink) 3%, transparent)' : 'color-mix(in srgb, var(--ink) 1%, transparent)'
}

function rowHeadStyle(r: DopeRow, index: number, selected: boolean): CSSProperties {
  if (selected) return { background: rowFill(r, index, true) }
  if (r.kind === 'object') return { background: 'var(--anim-row-object-head)', boxShadow: 'inset 2px 0 0 var(--anim-row-object-ink)' }
  if (r.kind === 'component') return { background: 'var(--anim-row-component-head)' }
  if (r.kind === 'section') return { background: rowFill(r, index, false), boxShadow: 'inset 2px 0 0 var(--anim-row-component-ink)' }
  return { background: rowFill(r, index, false) }
}

export function Diamond({ state, size = 9 }: { state: 'all' | 'some' | 'none'; size?: number }) {
  const r = size / 2
  return (
    <svg width={size + 2} height={size + 2} viewBox={`-1 -1 ${size + 2} ${size + 2}`} className="shrink-0">
      <path
        d={`M ${r} 0 L ${size} ${r} L ${r} ${size} L 0 ${r} Z`}
        fill={state === 'all' ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={1.2}
      />
      {state === 'some' && <path d={`M ${r} ${r * 0.5} L ${r * 1.5} ${r} L ${r} ${r * 1.5} L ${r * 0.5} ${r} Z`} fill="currentColor" />}
    </svg>
  )
}

export function ValueField({
  id,
  value,
  pending,
  disabled,
  onCommit
}: {
  id: string
  value: number | undefined
  pending: number | undefined
  disabled: boolean
  onCommit: (v: number) => void
}) {
  const shown = pending ?? value
  const [text, setText] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const commit = (): void => {
    if (text == null || done.current) return
    done.current = true
    const v = Number(text.replace(',', '.'))
    setText(null)
    if (Number.isFinite(v) && (shown === undefined || Math.abs(v - shown) > 1e-7)) onCommit(v)
  }
  return (
    <input
      ref={ref}
      data-anim-value={id}
      data-anim-pending={pending !== undefined ? 'yes' : undefined}
      disabled={disabled}
      value={text ?? (shown === undefined ? '' : fmt(shown, 3))}
      placeholder="—"
      onFocus={(e) => {
        done.current = false
        setText(shown === undefined ? '' : String(Number(shown.toFixed(5))))
        requestAnimationFrame(() => e.target.select())
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          commit()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          done.current = true
          setText(null)
          ref.current?.blur()
        }
      }}
      data-ti-tip={
        pending !== undefined
          ? 'Changed but not keyed yet. Press the diamond or Add Key to keep it, or move the playhead to drop it.'
          : 'Value at the playhead. Type a new one to key it at this frame.'
      }
      className={`h-4 w-14 shrink-0 rounded border bg-sunken px-1 text-right text-[10px] tabular-nums outline-none focus:border-accent disabled:opacity-60 ${
        pending !== undefined ? 'border-amber-400/70 text-amber-200' : 'border-hairline text-ink'
      }`}
    />
  )
}

function RowTypeIcon({ type }: { type: string }) {
  const Icon = componentIcon(type)
  return <Icon className="h-3 w-3 shrink-0" style={{ color: 'var(--anim-row-component-ink)' }} />
}

function RowThumb({ r, length, time }: { r: DopeRow; length: number; time: number }) {
  const W = 40
  const H = 12
  const len = Math.max(1e-3, length)
  const lines = r.channels.slice(0, 4).map((c) => {
    const [lo, hi] = keysRange(c.keys)
    const span = hi - lo
    let d = ''
    for (let i = 0; i <= 26; i++) {
      const v = evalKeys(c.keys, (len * i) / 26)
      const y = span < 1e-9 ? H / 2 : H - 1.5 - ((v - lo) / span) * (H - 3)
      d += `${i ? ' L' : 'M'} ${((i / 26) * W).toFixed(1)} ${y.toFixed(1)}`
    }
    return { id: c.id, d, color: r.prop ? curveColor(c, r.prop) : 'var(--ink-3)' }
  })
  const px = Math.max(0, Math.min(W - 1, (time / len) * (W - 1)))
  return (
    <svg data-anim-thumb={r.key} width={W} height={H} className="shrink-0 rounded-sm bg-sunken" style={{ minWidth: 16, flex: `0 1 ${W}px` }} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" data-ti-tip="The whole clip for this row">
      {lines.map((l) => (
        <path key={l.id} d={l.d} fill="none" stroke={l.color} strokeWidth={1.1} vectorEffect="non-scaling-stroke" />
      ))}
      <rect x={px} y={0} width={1} height={H} fill="var(--accent)" />
    </svg>
  )
}

export function HeaderCell({
  r,
  index,
  anim,
  frame,
  fps,
  readOnly,
  selectedRow,
  curves,
  thumb,
  length,
  time,
  onToggle,
  onKeyToggle,
  onSetValue,
  onSelectObject,
  onContext,
  onRowClick
}: {
  r: DopeRow
  index: number
  anim: TunerAnimator
  frame: number
  fps: number
  readOnly: boolean
  selectedRow: boolean
  curves: boolean
  thumb: boolean
  length: number
  time: number
  onToggle: (key: string) => void
  onKeyToggle: (r: DopeRow, state: 'all' | 'some' | 'none') => void
  onSetValue: (channelId: string, v: number) => void
  onSelectObject: (path: string) => void
  onContext: (e: React.MouseEvent, r: DopeRow) => void
  onRowClick: (e: React.MouseEvent, r: DopeRow) => void
}) {
  const keyed = keyAtPlayhead(r, frame, fps)
  const pendingRow = r.channels.some((c) => anim.pending[c.id] !== undefined)
  const caret = r.expandable ? (
    <button
      type="button"
      aria-label={r.open ? 'Collapse' : 'Expand'}
      data-anim-caret={r.key}
      onClick={(e) => {
        e.stopPropagation()
        onToggle(r.key)
      }}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-white/10 hover:text-ink"
    >
      {r.open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
    </button>
  ) : (
    <span className="h-4 w-4 shrink-0" />
  )
  const indent = r.depth * 12
  const color = r.channel ? channelColor(r.channel.label) : null
  const missing = r.prop?.missing
  const single = r.channel && !r.prop?.pptr
  const label =
    r.kind === 'channel' ? (
      <span className="min-w-0 truncate text-ink-2">
        <span className="text-ink-3">{r.prop?.label}.</span>
        <span style={color ? { color } : undefined}>{r.label}</span>
      </span>
    ) : r.kind === 'group' ? (
      <span
        className={`min-w-0 truncate ${missing ? 'text-amber-300/80 line-through' : 'text-ink'}`}
        data-ti-tip={r.prop?.section ? `${r.prop.section}: ${r.label} (the clip's ${r.prop.group} curve${r.prop.channels.length > 1 ? 's' : ''})` : undefined}
      >
        {r.label}
        {r.channel && r.channel.label && (
          <>
            <span className="text-ink-3">.</span>
            <span style={color ? { color } : undefined}>{r.channel.label}</span>
          </>
        )}
      </span>
    ) : r.kind === 'object' ? (
      <button
        type="button"
        className="min-w-0 truncate text-left font-medium text-ink hover:underline"
        onClick={(e) => {
          e.stopPropagation()
          if (anim.owner) onSelectObject(r.path ? `${anim.owner.path}/${r.path}` : anim.owner.path)
        }}
        data-ti-tip={`Select ${r.label} in the Tuner`}
      >
        {r.label}
      </button>
    ) : r.kind === 'component' ? (
      <span className="min-w-0 truncate text-ink-2">{r.label}</span>
    ) : r.kind === 'section' ? (
      <span className="min-w-0 truncate font-medium text-ink-2" data-ti-tip={`${r.label}: ${r.count ?? 0} ${r.count === 1 ? 'property' : 'properties'}, grouped by body part as in Unity's Avatar muscle settings`}>
        {r.label}
        <span className="ml-1.5 text-[10px] font-normal text-ink-3">{r.count}</span>
      </span>
    ) : (
      <span className="min-w-0 truncate font-medium text-ink-2">Summary</span>
    )
  const groupValues = r.kind === 'group' && !single && !r.open ? r.channels.map((c) => anim.pending[c.id] ?? anim.values[c.id]) : null
  const rgba = r.kind === 'group' && r.channels.length >= 3 && r.channels.slice(0, 3).map((c) => c.label).join('') === 'rgb' ? r.channels.map((c) => anim.pending[c.id] ?? anim.values[c.id] ?? 0) : null
  const swatch = rgba
    ? `rgb(${rgba.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(' ')} / ${rgba.length > 3 ? Math.max(0, Math.min(1, rgba[3])) : 1})`
    : null
  return (
    <div
      data-anim-row={r.key}
      data-anim-row-kind={r.kind}
      data-anim-row-selected={selectedRow ? 'yes' : undefined}
      onContextMenu={(e) => {
        e.preventDefault()
        onContext(e, r)
      }}
      onClick={(e) => onRowClick(e, r)}
      className="absolute left-0 flex w-full items-center gap-1 pr-1"
      style={{ top: r.y, height: r.h, paddingLeft: 4 + indent, ...rowHeadStyle(r, index, selectedRow) }}
      title={missing ? `${r.label}: the object or component this property animates is missing` : undefined}
    >
      {caret}
      {r.kind === 'object' && <Box className="h-3 w-3 shrink-0" style={{ color: 'var(--anim-row-object-ink)' }} />}
      {r.kind === 'component' && r.type && <RowTypeIcon type={r.type} />}
      {label}
      {missing && <span className="shrink-0 text-[10px] text-amber-300/80">(missing)</span>}
      {curves && r.channel && r.prop && !r.prop.pptr && (
        <span data-anim-curve-dot={r.key} className="h-[3px] w-2.5 shrink-0 rounded-sm" style={{ background: curveColor(r.channel, r.prop) }} data-ti-tip="The colour of this curve in the Curves view" />
      )}
      {thumb && (r.kind === 'group' || r.kind === 'channel') && !r.prop?.pptr && <RowThumb r={r} length={length} time={time} />}
      <span className="min-w-0 flex-1" />
      {swatch && <span data-anim-swatch={r.key} className="h-3 w-3 shrink-0 rounded-sm border border-hairline" style={{ background: swatch }} />}
      {groupValues && (
        <span className="min-w-0 truncate text-[10px] tabular-nums text-ink-3" data-anim-group-values={r.key}>
          {groupValues.map((v) => (v === undefined ? '—' : fmt(v, 2))).join(', ')}
        </span>
      )}
      {single && r.channel && (
        <ValueField
          id={r.channel.id}
          value={anim.values[r.channel.id]}
          pending={anim.pending[r.channel.id]}
          disabled={readOnly}
          onCommit={(v) => onSetValue(r.channel!.id, v)}
        />
      )}
      {r.kind !== 'summary' && r.kind !== 'object' && r.kind !== 'component' && (
        <button
          type="button"
          data-anim-keybtn={r.key}
          data-anim-keyed={keyed}
          disabled={readOnly}
          onClick={(e) => {
            e.stopPropagation()
            onKeyToggle(r, keyed)
          }}
          data-ti-tip={
            keyed === 'all'
              ? `Remove the key${r.channels.length > 1 ? 's' : ''} at frame ${frame}`
              : pendingRow
                ? `Key the changed value at frame ${frame}`
                : `Add a key at frame ${frame} with the current value`
          }
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-white/10 disabled:opacity-40 ${
            pendingRow ? 'text-amber-300' : keyed !== 'none' ? 'text-accent' : 'text-ink-3 hover:text-ink'
          }`}
        >
          <Diamond state={keyed} size={8} />
        </button>
      )}
    </div>
  )
}

export interface MenuItem {
  action: string
  label: string
  tip?: string
  checked?: boolean
  disabled?: boolean
  danger?: boolean
  inline?: { action: string; label: string; checked?: boolean; tip?: string }[]
}

export type MenuEntry = MenuItem | { section: string } | 'sep'

export function TimelineMenu({ x, y, entries, onPick, onDismiss }: { x: number; y: number; entries: MenuEntry[]; onPick: (action: string) => void; onDismiss: () => void }) {
  return createPortal(
    <div data-viewport-ui data-anim-menu>
      <FloatingMenu x={x} y={y} onDismiss={onDismiss} className="min-w-[19rem] max-w-[24rem]">
        {entries.map((e, i) => {
          if (e === 'sep') return <MenuSeparator key={`s${i}`} />
          if ('section' in e) return <MenuLabel key={`l${i}`}>{e.section}</MenuLabel>
          if (e.inline)
            return (
              <div key={e.action} className="flex items-center gap-0.5 px-3 py-0.5 text-[12px] text-zinc-300">
                <span className="w-[5.5rem] shrink-0 text-zinc-400">{e.label}</span>
                {e.inline.map((b) => (
                  <button
                    key={b.action}
                    type="button"
                    data-anim-menu-item={b.action}
                    data-ti-tip={b.tip}
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => {
                      onPick(b.action)
                      onDismiss()
                    }}
                    className={`rounded px-1.5 py-0.5 text-[11px] hover:bg-white/10 hover:text-white ${b.checked ? 'bg-white/10 text-white' : ''}`}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            )
          return (
            <button
              key={e.action}
              type="button"
              data-anim-menu-item={e.action}
              disabled={e.disabled}
              data-ti-tip={e.tip}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => {
                onPick(e.action)
                onDismiss()
              }}
              className={`${menuItemClass} !py-[3px] text-[12px] ${e.danger ? 'text-red-300' : ''}`}
            >
              <span className="w-3 shrink-0 text-center">{e.checked ? '✓' : ''}</span>
              <span className="min-w-0 truncate">{e.label}</span>
            </button>
          )
        })}
      </FloatingMenu>
    </div>,
    document.body
  )
}

export function segMenuEntries(readOnly: boolean, label: string, fa: number, fb: number): MenuEntry[] {
  return [
    { section: `${label} · frames ${fa} to ${fb}` },
    { action: 'editEasing', label: 'Edit Easing…', disabled: readOnly, tip: 'Shape how this move speeds up and slows down with two bezier handles' },
    {
      action: 'segPreset',
      label: 'Preset',
      inline: [
        { action: 'seg:linear', label: 'Linear', tip: 'A straight line at constant speed' },
        { action: 'seg:ease', label: 'Ease', tip: 'CSS ease, written as weighted tangents' },
        { action: 'seg:easeIn', label: 'In', tip: 'Starts slow' },
        { action: 'seg:easeOut', label: 'Out', tip: 'Ends slow' },
        { action: 'seg:easeInOut', label: 'In Out', tip: 'Slow at both ends' }
      ]
    },
    {
      action: 'segMore',
      label: 'More',
      inline: [
        { action: 'seg:backIn', label: 'Back In', tip: 'Pulls back a little before it moves' },
        { action: 'seg:backOut', label: 'Back Out', tip: 'Overshoots the end, then settles back' },
        { action: 'seg:step', label: 'Step', tip: 'Holds the value, then jumps' },
        { action: 'seg:auto', label: 'Auto', tip: "Clamped Auto on both keys, Unity's default" }
      ]
    }
  ]
}

export function keyMenuEntries(hasSel: boolean, canPaste: boolean, readOnly: boolean, modes: { lm: number; rm: number; broken: boolean; wm: number } | null, easing = false): MenuEntry[] {
  const m = modes
  const both = (mode: number) => !!m && !m.broken && m.lm === mode && m.rm === mode
  return [
    { action: 'delete', label: 'Delete Keys', disabled: !hasSel || readOnly, tip: 'Delete the selected keys (Delete)' },
    { action: 'copy', label: 'Copy', disabled: !hasSel, tip: 'Copy the selected keys (Ctrl+C)' },
    { action: 'paste', label: 'Paste', disabled: !canPaste || readOnly, tip: 'Paste copied keys at the playhead (Ctrl+V)' },
    'sep',
    { section: 'Tangents' },
    { action: 'clampedAuto', label: 'Clamped Auto', checked: both(4), disabled: readOnly, tip: 'Smooth, never overshoots the neighbouring keys' },
    { action: 'auto', label: 'Auto', checked: both(1), disabled: readOnly, tip: 'Smooth, may overshoot' },
    { action: 'freeSmooth', label: 'Free Smooth', checked: both(0), disabled: readOnly, tip: 'Smooth, with handles you can drag' },
    { action: 'flat', label: 'Flat', disabled: readOnly, tip: 'Flat handles, the curve stops at this key' },
    { action: 'broken', label: 'Broken', checked: !!m?.broken, disabled: readOnly, tip: 'Left and right handles move on their own' },
    {
      action: 'left',
      label: 'Left Tangent',
      inline: [
        { action: 'leftFree', label: 'Free', checked: m?.lm === 0 && !!m?.broken },
        { action: 'leftLinear', label: 'Linear', checked: m?.lm === 2 },
        { action: 'leftConstant', label: 'Constant', checked: m?.lm === 3 },
        { action: 'leftWeighted', label: 'Weighted', checked: !!m && (m.wm & 1) === 1 }
      ]
    },
    {
      action: 'right',
      label: 'Right Tangent',
      inline: [
        { action: 'rightFree', label: 'Free', checked: m?.rm === 0 && !!m?.broken },
        { action: 'rightLinear', label: 'Linear', checked: m?.rm === 2 },
        { action: 'rightConstant', label: 'Constant', checked: m?.rm === 3 },
        { action: 'rightWeighted', label: 'Weighted', checked: !!m && (m.wm & 2) === 2 }
      ]
    },
    {
      action: 'both',
      label: 'Both Tangents',
      inline: [
        { action: 'bothFree', label: 'Free' },
        { action: 'bothLinear', label: 'Linear', checked: both(2) },
        { action: 'bothConstant', label: 'Constant', checked: both(3) },
        { action: 'weighted', label: 'Weighted', checked: !!m && m.wm === 3 }
      ]
    },
    'sep',
    { section: 'Ease to the next key' },
    ...(easing ? [{ action: 'editEasing', label: 'Edit Easing…', disabled: readOnly, tip: 'Shape the move to the next key with two bezier handles' }] : []),
    {
      action: 'ease',
      label: 'Preset',
      inline: [
        { action: 'linear', label: 'Linear', tip: 'Straight line to the next key' },
        { action: 'ease', label: 'Ease', tip: 'CSS ease, written as weighted tangents' },
        { action: 'easeIn', label: 'In', tip: 'Ease in: starts slow' },
        { action: 'easeOut', label: 'Out', tip: 'Ease out: ends slow' },
        { action: 'easeInOut', label: 'In Out', tip: 'Ease in and out' }
      ]
    }
  ]
}

export function EventEditor({
  ev,
  index,
  methods,
  frame,
  left,
  top,
  readOnly,
  projectPath,
  onChange,
  onDelete,
  onClose
}: {
  ev: TunerAnimEvent
  index: number
  methods: TunerAnimMethod[]
  frame: number
  left: number
  top: number
  readOnly: boolean
  projectPath: string
  onChange: (patch: Partial<TunerAnimEvent>) => void
  onDelete: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useKeepInView(ref)
  const objBtn = useRef<HTMLButtonElement>(null)
  const [picking, setPicking] = useState(false)
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Element
      if (ref.current && !ref.current.contains(t as Node) && !t.closest?.('[data-anim-event]') && !t.closest?.('[data-tuner-popup-depth]')) onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [onClose])
  const method = methods.find((m) => m.name === ev.fn)
  const kind = method?.param ?? (ev.fn ? 'unknown' : 'none')
  const known = !ev.fn || !!method
  const field = (label: string, node: ReactNode, tip: string) => (
    <label className="flex items-center gap-2" data-ti-tip={tip}>
      <span className="w-16 shrink-0 text-ink-3">{label}</span>
      {node}
    </label>
  )
  const input = 'h-5 min-w-0 flex-1 rounded border border-hairline bg-sunken px-1.5 text-[11px] text-ink outline-none focus:border-accent'
  const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') e.currentTarget.blur()
  }
  return (
    <LiftedLayer>
      <div
        ref={ref}
        data-viewport-ui
        data-anim-event-editor={index}
        className="surface-overlay absolute z-40 w-72 rounded-lg p-2 text-[11px] text-ink-2"
        style={{ left, top }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="mb-1.5 flex items-center gap-1">
          <span className="font-medium text-ink">Animation event</span>
          <span className="text-ink-3">at frame {frame}</span>
          <span className="flex-1" />
          <button type="button" className={iconBtn} aria-label="Delete event" data-anim-event-delete onClick={onDelete} disabled={readOnly} data-ti-tip="Delete this event">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={iconBtn} aria-label="Close" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {field(
            'Function',
            <select
              data-anim-event-fn-select
              disabled={readOnly}
              value={ev.fn}
              onChange={(e) => onChange({ fn: e.target.value })}
              className={input}
            >
              <option value="">(no function)</option>
              {!known && <option value={ev.fn}>{ev.fn} (not found on the object)</option>}
              {methods.map((m) => (
                <option key={`${m.component}.${m.name}`} value={m.name}>
                  {m.component}.{m.name}({m.param === 'none' ? '' : m.param})
                </option>
              ))}
            </select>,
            'Unity calls this method on the animated object when the clip passes this frame. The list shows the methods Unity accepts on its components.'
          )}
          {methods.length === 0 && <div className="text-[10px] text-ink-3">None of the scripts on the animated object has a method Unity can call. Add one, or leave the event without a function for now.</div>}
          {(kind === 'float' || kind === 'event' || kind === 'unknown') &&
            field('Float', <input data-anim-event-param="f" disabled={readOnly} className={input} onKeyDown={blurOnEnter} defaultValue={String(ev.f)} onBlur={(e) => onChange({ f: Number(e.target.value) || 0 })} />, 'Float parameter')}
          {(kind === 'int' || kind === 'event' || kind === 'unknown') &&
            field('Int', <input data-anim-event-param="i" disabled={readOnly} className={input} onKeyDown={blurOnEnter} defaultValue={String(ev.i)} onBlur={(e) => onChange({ i: Math.round(Number(e.target.value) || 0) })} />, 'Int parameter')}
          {(kind === 'string' || kind === 'event' || kind === 'unknown') &&
            field('String', <input data-anim-event-param="s" disabled={readOnly} className={input} onKeyDown={blurOnEnter} defaultValue={ev.s} onBlur={(e) => onChange({ s: e.target.value })} />, 'String parameter')}
          {(kind === 'object' || kind === 'event' || kind === 'unknown') &&
            field(
              'Object',
              <button
                ref={objBtn}
                type="button"
                data-anim-event-param="o"
                data-anim-event-object={ev.o}
                disabled={readOnly}
                className={`${input} flex items-center gap-1 text-left`}
                onClick={() => setPicking((v) => !v)}
              >
                <Box className="h-3 w-3 shrink-0 text-ink-3" />
                <span className={`min-w-0 flex-1 truncate ${ev.o ? '' : 'text-ink-3'}`}>{ev.o ? ev.oName || ev.o.split('/').pop() : `None (${(method?.otype ?? 'Object').split('.').pop()})`}</span>
              </button>,
              ev.o ? `${ev.o}. Click to pick another asset.` : 'Click to pick the asset Unity passes to the function'
            )}
          {picking && (
            <PopupSurface getAnchor={() => rectBox(objBtn.current)} onOutside={() => setPicking(false)} kind="object" role="dialog" minWidth={260}>
              <ObjectPicker
                data={{
                  type: method?.otype ?? 'UnityEngine.Object',
                  typeName: (method?.otype ?? 'Object').split('.').pop() ?? 'Object',
                  allowSceneObjects: false,
                  current: ev.o ? { path: ev.o.split('#')[0], ...(ev.o.includes('#') ? { localId: ev.o.split('#')[1] } : {}) } : null,
                  currentName: ev.oName
                }}
                query={(q) => window.api.tunerPopup.objects(projectPath, q)}
                onChange={() => undefined}
                onCancel={() => setPicking(false)}
                onCommit={(r) => {
                  setPicking(false)
                  const o = r?.path ? (r.localId !== undefined && r.localId !== '0' && r.localId !== 0 ? `${r.path}#${r.localId}` : r.path) : ''
                  if (o !== ev.o) onChange({ o })
                }}
              />
            </PopupSurface>
          )}
        </div>
      </div>
    </LiftedLayer>
  )
}

export function AddPropertyPopover({
  projectPath,
  session,
  readOnly,
  left,
  bottom,
  onAdd,
  onClose
}: {
  projectPath: string
  session: string
  readOnly: boolean
  left: number
  bottom: number
  onAdd: (ids: string[], label: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useKeepInView(ref)
  const [choices, setChoices] = useState<TunerAnimPropChoice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    let alive = true
    void window.api.tuner.animator(projectPath, session, { op: 'props' }).then((r) => {
      if (!alive) return
      if (!r.ok) setError(r.error)
      else setChoices(parseTunerAnimPropChoices(r.data?.data))
    })
    return () => {
      alive = false
    }
  }, [projectPath, session])
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.('[data-anim-addprop-btn]')) onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [onClose])
  const q = query.trim().toLowerCase()
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: TunerAnimPropChoice[] }[] = []
    for (const c of choices ?? []) {
      if (q && !`${c.object} ${c.component} ${c.label}`.toLowerCase().includes(q)) continue
      const key = `${c.path}|${c.component}`
      let g = out.find((x) => x.key === key)
      if (!g) {
        g = { key, label: `${c.object} : ${c.component}`, items: [] }
        out.push(g)
      }
      g.items.push(c)
    }
    return out
  }, [choices, q])
  return (
    <LiftedLayer>
      <div
        ref={ref}
        data-viewport-ui
        data-anim-addprop
        className="surface-overlay absolute z-40 flex max-h-80 w-80 flex-col rounded-lg text-[11px] text-ink-2"
        style={{ left, bottom }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="flex items-center gap-1.5 border-b border-hairline px-2 py-1.5">
          <Search className="h-3.5 w-3.5 text-ink-3" />
          <input
            autoFocus
            data-anim-addprop-search
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a property (position, color, intensity…)"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-4"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {error && <div className="px-2 py-1 text-amber-300">{error}</div>}
          {!choices && !error && <PendingState tag="animator properties" label="Reading the object's properties…" className="justify-start px-2 py-1" />}
          {choices && groups.length === 0 && <div className="px-2 py-1 text-ink-3">Nothing matches.</div>}
          {groups.map((g) => {
            const shown = q !== '' || open.has(g.key)
            return (
              <div key={g.key}>
                <button
                  type="button"
                  data-anim-addprop-group={g.key}
                  className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-ink hover:bg-white/5"
                  onClick={() =>
                    setOpen((prev) => {
                      const next = new Set(prev)
                      if (next.has(g.key)) next.delete(g.key)
                      else next.add(g.key)
                      return next
                    })
                  }
                >
                  {shown ? <ChevronDown className="h-3 w-3 text-ink-3" /> : <ChevronRight className="h-3 w-3 text-ink-3" />}
                  <span className="truncate">{g.label}</span>
                </button>
                {shown &&
                  g.items.map((c) => (
                    <div key={c.id} className="flex items-center gap-1 py-0.5 pl-6 pr-2 hover:bg-white/5">
                      <span className={`min-w-0 flex-1 truncate ${c.animated ? 'text-ink-4' : ''}`}>{c.label}</span>
                      <button
                        type="button"
                        data-anim-prop-choice={c.id}
                        disabled={c.animated || readOnly}
                        onClick={() => {
                          onAdd(c.ids, `${c.object} ${c.label}`)
                          onClose()
                        }}
                        data-ti-tip={c.animated ? 'Already in the clip' : `Add ${c.label} to the clip with its current value`}
                        className="flex h-4 w-4 items-center justify-center rounded text-ink-2 hover:bg-white/10 hover:text-ink disabled:opacity-30"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
              </div>
            )
          })}
        </div>
      </div>
    </LiftedLayer>
  )
}

export function ClipSettings({
  anim,
  left,
  top,
  onSet,
  onClose
}: {
  anim: TunerAnimator
  left: number
  top: number
  onSet: (patch: { length?: number; frameRate?: number; loop?: number }) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useKeepInView(ref)
  const clip = anim.clip
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.('[data-anim-btn="settings"],[data-anim-length]')) onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [onClose])
  if (!clip) return null
  const input = 'h-5 w-20 rounded border border-hairline bg-sunken px-1.5 text-right text-[11px] tabular-nums text-ink outline-none focus:border-accent disabled:opacity-50'
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>, apply: (v: number) => void): void => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      const v = Number((e.target as HTMLInputElement).value)
      if (Number.isFinite(v)) apply(v)
    }
  }
  return (
    <LiftedLayer>
      <div
        ref={ref}
        data-viewport-ui
        data-anim-settings
        className="surface-overlay absolute z-40 w-64 rounded-lg p-2 text-[11px] text-ink-2"
        style={{ left, top }}
      >
        <div className="mb-1.5 font-medium text-ink">Clip settings</div>
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2" data-ti-tip="Frames per second. Keys snap to these frames.">
            <span className="flex-1">Sample rate</span>
            <input
              data-anim-setting="frameRate"
              disabled={clip.readOnly}
              className={input}
              defaultValue={String(clip.frameRate)}
              onKeyDown={(e) => onKey(e, (v) => v > 0 && onSet({ frameRate: v }))}
              onBlur={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v) && v > 0 && v !== clip.frameRate) onSet({ frameRate: v })
              }}
            />
            <span className="w-6 text-ink-3">fps</span>
          </label>
          <label className="flex items-center gap-2" data-ti-tip="Unity takes the clip length from its last key. A longer length adds a key at the new end that holds every value. It can't be shorter than the last key.">
            <span className="flex-1">Length</span>
            <input
              data-anim-setting="length"
              disabled={clip.readOnly}
              className={input}
              defaultValue={clip.length.toFixed(3)}
              onKeyDown={(e) => onKey(e, (v) => v >= 0 && onSet({ length: v }))}
              onBlur={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v) && v >= 0 && Math.abs(v - clip.length) > 1e-4) onSet({ length: v })
              }}
            />
            <span className="w-6 text-ink-3">s</span>
          </label>
          <div className="text-[10px] text-ink-3">
            {frameOf(clip.length, clip.frameRate)} frames · {clip.path || 'not saved'}
            {clip.legacy ? ' · legacy' : ''}
          </div>
        </div>
      </div>
    </LiftedLayer>
  )
}
