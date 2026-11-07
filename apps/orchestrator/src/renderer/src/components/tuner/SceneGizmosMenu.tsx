import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Search, Shapes } from 'lucide-react'
import {
  ANNOTATION_HAS_GIZMO,
  iconSize01ToTexelWorldSize,
  texelWorldSizeTo01,
  type TunerAnnotation,
  type TunerAnnotationGeneralKey,
  type TunerAnnotations,
  type TunerAnnotationsRequest
} from '@shared/tuner-annotations'
import { useFloating } from '../../lib/floating'

const MAX_RECENT = 5
const WINDOW_WIDTH = 270
const WINDOW_MAX_HEIGHT = 900
const ROW_H = 18
const PROBE_MODES = ['Only Probes Used By Selection', 'All Probes No Cells', 'All Probes With Cells', 'None']

const thumbCache = new Map<string, Map<string, string>>()

function thumbsFor(projectPath: string): Map<string, string> {
  let m = thumbCache.get(projectPath)
  if (!m) {
    m = new Map()
    thumbCache.set(projectPath, m)
  }
  return m
}

export interface TunerAnnotationsApi {
  state: TunerAnnotations | null
  thumbs: Map<string, string>
  refresh: () => void
  send: (req: TunerAnnotationsRequest, optimistic?: (s: TunerAnnotations) => TunerAnnotations) => void
}

export function useTunerAnnotations(projectPath: string | null, session: string, live: boolean): TunerAnnotationsApi {
  const [state, setState] = useState<TunerAnnotations | null>(null)
  const [, setThumbRev] = useState(0)
  const seqRef = useRef(0)
  const thumbs = projectPath ? thumbsFor(projectPath) : new Map<string, string>()

  const run = useCallback(
    (req: TunerAnnotationsRequest) => {
      if (!projectPath) return
      const seq = ++seqRef.current
      const cache = thumbsFor(projectPath)
      void window.api.tuner.annotations(projectPath, session, { ...req, have: [...cache.keys()] }).then((r) => {
        if (!r.ok) return
        let added = false
        for (const [k, v] of Object.entries(r.data.thumbs)) {
          cache.set(k, v)
          added = true
        }
        if (added) setThumbRev((n) => n + 1)
        if (seq === seqRef.current) setState(r.data)
      })
    },
    [projectPath, session]
  )

  const refresh = useCallback(() => run({ op: 'get' }), [run])

  useEffect(() => {
    if (live) refresh()
  }, [live, refresh])

  const send = useCallback(
    (req: TunerAnnotationsRequest, optimistic?: (s: TunerAnnotations) => TunerAnnotations) => {
      if (optimistic) setState((s) => (s ? optimistic(s) : s))
      run(req)
    },
    [run]
  )

  return { state, thumbs, refresh, send }
}

function useLatest<T>(fn: (v: T) => void, ms: number): (v: T) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const last = useRef<T | null>(null)
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  return useCallback(
    (v: T) => {
      last.current = v
      if (timer.current) return
      fnRef.current(v)
      timer.current = setTimeout(() => {
        timer.current = null
        if (last.current !== v && last.current !== null) fnRef.current(last.current)
      }, ms)
    },
    [ms]
  )
}

function Check({
  checked,
  mixed,
  disabled,
  onChange,
  tip,
  data
}: {
  checked: boolean
  mixed?: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
  tip?: string
  data?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!mixed
  }, [mixed])
  return (
    <input
      ref={ref}
      type="checkbox"
      data-gizmo-check={data}
      checked={checked}
      disabled={disabled}
      data-ti-tip={tip}
      onChange={(e) => onChange(e.target.checked)}
      className="h-3 w-3 shrink-0 accent-sky-400 disabled:opacity-40"
    />
  )
}

function ToggleRow({
  label,
  checked,
  onChange,
  disabled,
  tip,
  data,
  children
}: {
  label: string
  checked: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  tip?: string
  data: string
  children?: ReactNode
}) {
  return (
    <div className="flex items-center pl-[11px] pr-[11px]" style={{ height: ROW_H }}>
      <label className={`flex w-[150px] shrink-0 items-center gap-1.5 text-[11px] text-zinc-200 ${disabled ? 'opacity-40' : ''}`} data-ti-tip={tip}>
        <Check checked={checked} disabled={disabled} onChange={onChange} data={data} />
        <span className="truncate">{label}</span>
      </label>
      {children}
    </div>
  )
}

function EnumPopup({ value, options, onChange }: { value: number; options: string[]; onChange: (v: number) => void }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useFloating(btnRef.current, listRef, { placement: 'bottom-start', gap: 2, matchWidth: true }, open)
  return (
    <div className="relative w-full">
      <button
        ref={btnRef}
        type="button"
        data-gizmo-probe-mode={value}
        onClick={() => setOpen((o) => !o)}
        className="flex h-[18px] w-full items-center justify-between rounded border border-white/10 bg-black/30 pl-1.5 pr-1 text-left text-[11px] text-zinc-200 hover:border-white/20"
      >
        <span className="truncate">{options[value] ?? ''}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-zinc-400" />
      </button>
      {open && (
        <div ref={listRef} className="surface-overlay fixed left-0 top-0 z-50 rounded py-0.5" data-gizmo-probe-options>
          {options.map((label, i) => (
            <button
              key={label}
              type="button"
              data-gizmo-probe-option={i}
              onClick={() => {
                setOpen(false)
                if (i !== value) onChange(i)
              }}
              className={`flex w-full items-center px-2 py-0.5 text-left text-[11px] hover:bg-sky-500/30 ${i === value ? 'text-sky-200' : 'text-zinc-200'}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function itemMatches(it: TunerAnnotation, filter: string): boolean {
  return filter.length === 0 || it.name.toLowerCase().includes(filter.toLowerCase())
}

export function SceneGizmosMenu({
  gizmos,
  onGizmosChange,
  api,
  buttonClass
}: {
  gizmos: boolean
  onGizmosChange: (on: boolean) => void
  api: TunerAnnotationsApi
  buttonClass: (on: boolean) => string
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const closedAt = useRef(0)
  useFloating(rootRef.current, menuRef, { placement: rootRef.current?.closest('[data-tuner-phone-scene] > [data-tuner-toolbar]') ? 'left-start' : 'bottom-end', gap: 2 }, open)
  const { state, thumbs, send, refresh } = api

  const toggleOpen = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    if (performance.now() - closedAt.current < 400) return
    setFilter('')
    refresh()
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) {
        closedAt.current = performance.now()
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const setGeneral = (key: TunerAnnotationGeneralKey, field: keyof TunerAnnotations, on: boolean): void =>
    send({ op: 'general', key, on }, (s) => ({ ...s, [field]: on }))

  const setIconSize = useLatest<number>((texel) => send({ op: 'general', key: 'iconSize', value: texel }), 60)
  const setFadeSize = useLatest<number>((size) => send({ op: 'general', key: 'fadeGizmoSize', value: size }), 60)
  const [iconSize01, setIconSize01] = useState<number | null>(null)
  const [fadeSize, setFadeSizeLocal] = useState<number | null>(null)
  useEffect(() => {
    setIconSize01(null)
    setFadeSizeLocal(null)
  }, [state?.iconSize, state?.fadeGizmoSize])

  const lists = useMemo(() => {
    if (!state) return null
    const builtin: TunerAnnotation[] = []
    const scripts: TunerAnnotation[] = []
    for (const it of state.items) (it.script ? scripts : builtin).push(it)
    const byName = (a: TunerAnnotation, b: TunerAnnotation): number => a.name.localeCompare(b.name)
    builtin.sort(byName)
    scripts.sort(byName)
    const byKey = new Map(state.items.map((it) => [it.key, it]))
    const recent: TunerAnnotation[] = []
    for (const k of state.recent) {
      if (recent.length >= MAX_RECENT) break
      const it = byKey.get(k)
      if (it) recent.push(it)
    }
    return { recent, scripts, builtin }
  }, [state])

  const setItems = (items: TunerAnnotation[], kind: 'icon' | 'gizmo', on: boolean, recent: boolean): void => {
    const keys = new Set(items.map((it) => it.key))
    send({ op: kind, on, recent, items: items.map((it) => ({ classID: it.classID, script: it.script })) }, (s) => ({
      ...s,
      items: s.items.map((it) => (keys.has(it.key) ? { ...it, [kind]: on } : it))
    }))
  }

  let even = true
  const flip = (): boolean => {
    even = !even
    return even
  }
  const rowBg = (e: boolean): string => (e ? 'bg-white/[0.035]' : 'bg-transparent')

  const renderSection = (title: string, items: TunerAnnotation[], first: boolean, separator: boolean): ReactNode => {
    if (items.length === 0) return null
    const shown = items.filter((it) => itemMatches(it, filter))
    let state3: 'none' | 'all' | 'mixed' | null = null
    for (const it of shown) {
      if (!(it.flags & ANNOTATION_HAS_GIZMO)) continue
      if (state3 === null) state3 = it.gizmo ? 'all' : 'none'
      else if ((state3 === 'all') !== it.gizmo) {
        state3 = 'mixed'
        break
      }
    }
    const headerEven = flip()
    const rows = shown.map((it) => {
      const e = flip()
      const hasGizmo = !!(it.flags & ANNOTATION_HAS_GIZMO)
      const thumb = it.thumb ? thumbs.get(it.key) : undefined
      return (
        <div
          key={`${title}:${it.key}`}
          data-gizmo-row={it.key}
          data-gizmo-name={it.name}
          className={`flex items-center pl-[10px] pr-1 text-[11px] text-zinc-200 ${rowBg(e)}`}
          style={{ height: ROW_H }}
        >
          <span className="min-w-0 flex-1 truncate">{it.name}</span>
          <span className="flex w-[30px] shrink-0 items-center justify-center">
            {it.thumb && (
              <button
                type="button"
                data-gizmo-icon={it.key}
                aria-pressed={it.icon}
                data-ti-tip="Show/Hide Icon"
                onClick={() => setItems([it], 'icon', !it.icon, true)}
                className="flex h-4 w-4 items-center justify-center"
                style={{ opacity: it.icon ? 1 : 0.3 }}
              >
                {thumb ? <img src={thumb} alt="" draggable={false} className="h-4 w-4" /> : <span className="h-3 w-3 rounded-sm bg-zinc-500" />}
              </button>
            )}
          </span>
          <span className="flex w-[34px] shrink-0 items-center justify-center">
            {hasGizmo && <Check checked={it.gizmo} tip="Show/Hide Gizmo" data={`gizmo:${it.key}`} onChange={(on) => setItems([it], 'gizmo', on, true)} />}
          </span>
        </div>
      )
    })
    return (
      <div key={title} data-gizmo-section={title}>
        <div className={rowBg(headerEven)}>
          {first && (
            <div className="flex items-center px-[10px] pt-[3px]" style={{ height: 19 }}>
              <label className="flex h-4 w-full items-center gap-1 rounded border border-white/10 bg-black/30 px-1.5">
                <Search className="h-3 w-3 shrink-0 text-zinc-500" />
                <input
                  data-gizmo-search
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Escape') e.stopPropagation()
                  }}
                  className="min-w-0 flex-1 bg-transparent text-[10px] text-zinc-200 outline-none"
                />
              </label>
            </div>
          )}
          <div className="flex items-end pr-1 text-[9px] text-zinc-400/65" style={{ height: 15 }}>
            {first && (
              <>
                <span className="flex-1" />
                <span className="w-[30px] text-center">icon</span>
                <span className="w-[34px] text-center">gizmo</span>
              </>
            )}
          </div>
          <div className="flex items-center pl-[8px] pr-1" style={{ height: 20 }}>
            <span className="flex-1 text-[11px] font-semibold text-zinc-100">{title}</span>
            <span className="w-[30px]" />
            <span className="flex w-[34px] items-center justify-center">
              {state3 !== null && (
                <Check
                  checked={state3 === 'all'}
                  mixed={state3 === 'mixed'}
                  data={`all:${title}`}
                  onChange={() => {
                    const on = state3 !== 'all'
                    setItems(shown.filter((it) => !!(it.flags & ANNOTATION_HAS_GIZMO) && it.gizmo !== on), 'gizmo', on, false)
                  }}
                />
              )}
            </span>
          </div>
        </div>
        {rows}
        {separator && (
          <div className={`relative ${rowBg(even)}`} style={{ height: 6 }}>
            <div className="absolute left-[10px] right-[5px] top-[3px] h-px bg-white/15" />
          </div>
        )}
      </div>
    )
  }

  const icon01 = iconSize01 ?? (state ? texelWorldSizeTo01(state.iconSize) : 0.5)
  const fade = fadeSize ?? state?.fadeGizmoSize ?? 5
  const lp = state?.lightProbes

  return (
    <div ref={rootRef} className="relative flex items-center" data-scene-gizmos-root>
      <button
        type="button"
        data-scene-gizmos={gizmos ? 'on' : 'off'}
        aria-pressed={gizmos}
        aria-label="Gizmos"
        className={`${buttonClass(gizmos)} rounded-r-none pr-1`}
        onClick={() => onGizmosChange(!gizmos)}
        data-ti-tip="Toggle visibility of all Gizmos in the Scene view"
      >
        <Shapes className="h-3.5 w-3.5" />
        <span>Gizmos</span>
      </button>
      <button
        type="button"
        data-scene-gizmos-menu-button
        aria-label="Gizmos menu"
        aria-expanded={open}
        className={`${buttonClass(open || gizmos)} rounded-l-none px-0.5`}
        onClick={toggleOpen}
      >
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div
          ref={menuRef}
          data-scene-gizmos-menu
          style={{ left: 0, top: 0, maxHeight: WINDOW_MAX_HEIGHT, width: WINDOW_WIDTH }}
          className="surface-overlay fixed z-40 flex flex-col overflow-hidden rounded-lg"
        >
          {!state || !lists ? (
            <div className="px-3 py-3 text-[11px] text-zinc-400">Reading Unity's gizmo settings…</div>
          ) : (
            <>
              <div className="shrink-0 pb-1.5 pt-[7px]" data-gizmo-general>
                <div className="flex items-center pl-[11px] text-[11px] font-semibold text-zinc-100" style={{ height: ROW_H }}>
                  General
                </div>
                <ToggleRow label="3D Icons" data="use3dIcons" checked={state.use3dIcons} onChange={(on) => setGeneral('use3dIcons', 'use3dIcons', on)}>
                  <input
                    type="range"
                    data-gizmo-slider="iconSize"
                    min={0}
                    max={1}
                    step={0.001}
                    disabled={!state.use3dIcons}
                    value={icon01}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setIconSize01(v)
                      setIconSize(iconSize01ToTexelWorldSize(v))
                    }}
                    className="h-1 min-w-0 flex-1 accent-sky-400 disabled:opacity-40"
                  />
                </ToggleRow>
                <ToggleRow
                  label="Fade Gizmos"
                  data="fadeGizmos"
                  tip="Fade out and stop rendering gizmos that are small on screen"
                  checked={state.fadeGizmos}
                  onChange={(on) => setGeneral('fadeGizmos', 'fadeGizmos', on)}
                >
                  <input
                    type="range"
                    data-gizmo-slider="fadeGizmoSize"
                    min={2}
                    max={10}
                    step={0.01}
                    disabled={!state.fadeGizmos}
                    value={fade}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setFadeSizeLocal(v)
                      setFadeSize(v)
                    }}
                    className="h-1 min-w-0 flex-1 accent-sky-400 disabled:opacity-40"
                  />
                </ToggleRow>
                <ToggleRow label="Selection Outline" data="selectionOutline" checked={state.selectionOutline} onChange={(on) => setGeneral('selectionOutline', 'selectionOutline', on)} />
                <ToggleRow label="Selection Wire" data="selectionWire" checked={state.selectionWire} onChange={(on) => setGeneral('selectionWire', 'selectionWire', on)} />
                <ToggleRow
                  label="LOD Labels"
                  data="lodLabels"
                  tip="Show or Hide LOD Labels for Mesh LOD and LODGroup. Disabled if MeshRenderer, SkinnedMeshRenderer or LODGroup Gizmos are are hidden"
                  disabled={!state.canHideLodLabels}
                  checked={state.lodLabels}
                  onChange={(on) => setGeneral('lodLabels', 'lodLabels', on)}
                />
                <ToggleRow label="Terrain Debug Warnings" data="terrainWarnings" checked={state.terrainWarnings} onChange={(on) => setGeneral('terrainWarnings', 'terrainWarnings', on)} />
                {lp?.supported && (
                  <>
                    <div style={{ height: ROW_H }} />
                    <div className="flex items-center pl-[11px] text-[11px] font-semibold text-zinc-100" style={{ height: ROW_H }}>
                      Light Probe Visualization
                    </div>
                    <div className="flex items-center px-[11px]" style={{ height: ROW_H + 2 }}>
                      <EnumPopup
                        value={lp.mode}
                        options={PROBE_MODES}
                        onChange={(mode) => send({ op: 'general', key: 'probeMode', value: mode }, (st) => ({ ...st, lightProbes: { ...st.lightProbes, mode } }))}
                      />
                    </div>
                    {lp.mode !== 3 && (
                      <>
                        <ToggleRow
                          label="Display Weights"
                          data="probeWeights"
                          checked={lp.weights}
                          onChange={(on) => send({ op: 'general', key: 'probeWeights', on }, (s) => ({ ...s, lightProbes: { ...s.lightProbes, weights: on } }))}
                        />
                        <ToggleRow
                          label="Display Occlusion"
                          data="probeOcclusion"
                          checked={lp.occlusion}
                          onChange={(on) => send({ op: 'general', key: 'probeOcclusion', on }, (s) => ({ ...s, lightProbes: { ...s.lightProbes, occlusion: on } }))}
                        />
                        <ToggleRow
                          label="Highlight Invalid Cells"
                          data="probeInvalid"
                          tip="Highlight the invalid cells that cannot be used for probe interpolation."
                          checked={lp.invalidCells}
                          onChange={(on) => send({ op: 'general', key: 'probeInvalid', on }, (s) => ({ ...s, lightProbes: { ...s.lightProbes, invalidCells: on } }))}
                        />
                      </>
                    )}
                  </>
                )}
              </div>
              <div className="h-px shrink-0 bg-white/10" />
              <div className="min-h-0 flex-1 overflow-y-auto pb-1" data-gizmo-list>
                {renderSection('Recently Changed', lists.recent, true, true)}
                {renderSection('Scripts', lists.scripts, lists.recent.length === 0, false)}
                {renderSection('Built-in Components', lists.builtin, lists.recent.length === 0 && lists.scripts.length === 0, false)}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
