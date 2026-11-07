import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AnchoredLayer } from '../ui/AnchoredLayer'
import {
  Boxes,
  Check,
  ChevronDown,
  Copy,
  FlaskConical,
  LayoutGrid,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCw,
  ScrollText,
  Square,
  Trash2,
  X
} from 'lucide-react'
import type { ScratchpadInfo, ScratchpadResult } from '@shared/scratchpads'
import { SCRATCHPAD_NAME_MAX } from '@shared/scratchpads'
import { useAppStore } from '../../store'
import { useScratchpadView } from './scratchpad-status'
import { consoleTabFor } from '../../lib/unity/console-tabs'
import { sceneTunerTab } from '../../lib/tuner/tuner-target'
import { useDismiss } from '../ui/useDismiss'
import { PaneUnitySlot, UNITY_MODE_MENU } from '../workbench/PaneUnitySlot'
import { EditorFaultCard } from '../workbench/EditorFaultCard'
import { ScratchpadGrid, modeLabel } from './ScratchpadGrid'
import type { UnityMode } from '@shared/unity/world'
import { requestConfirm } from '../../lib/confirm/confirm-store'
import { compact, section, usePanelActions, type ActionNode } from '../../lib/actions/action-tree'
import { ActionMenu } from '../../lib/actions/ActionMenu'
import { useMobileBack } from '../../lib/mobile/mobile-back'
import {
  clearScratchpadError,
  isScratchpadLive,
  refreshScratchpads,
  runScratchpadAction,
  setScratchpadGrid,
  useScratchpadGrid,
  useScratchpadPick,
  type ScratchpadAction
} from '../../lib/unity/scratchpads'

function IconButton({
  title,
  onClick,
  disabled,
  children,
  danger
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
        danger ? 'hover:text-red-300' : 'hover:text-zinc-100'
      }`}
    >
      {children}
    </button>
  )
}

function NameForm({
  initial,
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus
}: {
  initial: string
  placeholder: string
  submitLabel: string
  onSubmit: (name: string) => void
  onCancel?: () => void
  autoFocus?: boolean
}) {
  const [draft, setDraft] = useState(initial)
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    onSubmit(draft.trim())
  }
  return (
    <form onSubmit={submit} className="flex min-w-0 items-center gap-1">
      <input
        value={draft}
        autoFocus={autoFocus}
        maxLength={SCRATCHPAD_NAME_MAX}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel?.()
        }}
        className="h-6 min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-500/60"
      />
      <button
        type="submit"
        title={submitLabel}
        className="flex h-6 shrink-0 items-center gap-1 rounded border border-sky-500/30 bg-sky-500/10 px-2 text-xs text-sky-100 hover:bg-sky-500/20"
      >
        <Check className="h-3 w-3" />
        {submitLabel}
      </button>
      {onCancel && (
        <IconButton title="Cancel" onClick={onCancel}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      )}
    </form>
  )
}

function ScratchpadOption({
  projectPath,
  info,
  current,
  streamed,
  onPick
}: {
  projectPath: string
  info: ScratchpadInfo
  current: boolean
  streamed: boolean
  onPick: () => void
}) {
  const view = useScratchpadView(projectPath, info, streamed)
  const mode = modeLabel(info)
  return (
    <button
      type="button"
      onClick={onPick}
      data-scratchpad-option={info.id}
      title={view.status === 'error' && info.error ? info.error : undefined}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-white/10 ${
        current ? 'text-white' : 'text-zinc-300'
      }`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${view.dot}`} />
      <span className="min-w-0 flex-1 truncate">{info.name}</span>
      {mode && <span className="shrink-0 text-[10px] text-zinc-500">{mode}</span>}
      <span className={`shrink-0 text-[10px] ${view.tone}`} data-scratchpad-state={view.play ?? view.status}>
        {view.label}
      </span>
    </button>
  )
}

function PadChip({
  projectPath,
  info,
  current,
  onPick,
  onMenu
}: {
  projectPath: string
  info: ScratchpadInfo
  current: boolean
  onPick: () => void
  onMenu: (x: number, y: number) => void
}) {
  const view = useScratchpadView(projectPath, info, current)
  return (
    <button
      type="button"
      onClick={onPick}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
      data-ctx-menu
      data-scratchpad-chip={info.id}
      aria-pressed={current}
      className={`flex h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-[15px] ${
        current ? 'border-sky-400/60 bg-sky-500/20 text-white' : 'border-white/10 bg-white/[0.04] text-zinc-300'
      }`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${view.dot}`} />
      <span className="max-w-[10rem] truncate">{info.name}</span>
      <span className={`shrink-0 text-[13px] ${view.tone}`} data-scratchpad-state={view.play ?? view.status}>
        {view.label}
      </span>
    </button>
  )
}

const NO_PAD: ScratchpadInfo = {
  id: '',
  name: '',
  path: '',
  createdAt: 0,
  status: 'stopped',
  lifecycle: null,
  play: null,
  pid: null,
  error: null,
  fault: null,
  unityMode: 'normal'
}

export function PaneScratchpadSlot({
  tabId,
  ptyId,
  projectPath,
  phoneLive
}: {
  tabId: string
  ptyId: string
  projectPath: string
  phoneLive?: (pad: ScratchpadInfo) => ReactNode
}) {
  const phone = !!phoneLive
  const scratchpadId = useAppStore((s) => {
    for (const tabs of Object.values(s.tabsByWorkspace)) {
      const t = tabs.find((x) => x.id === tabId)
      if (t) return t.scratchpadId ?? null
    }
    return null
  })
  const setTabScratchpad = useAppStore((s) => s.setTabScratchpad)
  const { list, error: listError, loaded, selected, missing } = useScratchpadPick(projectPath, scratchpadId)
  const grid = useScratchpadGrid(ptyId) && !phone
  const liveCount = list.filter(isScratchpadLive).length
  const [modeError, setModeError] = useState<string | null>(null)
  const fallbackId = list[0]?.id ?? null
  useEffect(() => {
    if (!loaded || (scratchpadId && !missing)) return
    if (fallbackId !== (scratchpadId ?? null)) setTabScratchpad(tabId, fallbackId)
  }, [loaded, missing, fallbackId, scratchpadId, tabId, setTabScratchpad])

  const [menuOpen, setMenuOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [chipMenu, setChipMenu] = useState<{ x: number; y: number; info: ScratchpadInfo } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useDismiss(
    menuRef,
    () => {
      setMenuOpen(false)
      setCreating(false)
    },
    menuOpen
  )

  const act = <T,>(id: string, action: ScratchpadAction, fn: () => Promise<ScratchpadResult<T>>): Promise<T | null> =>
    runScratchpadAction(projectPath, id, action, fn)

  const tabShows = (id: string): boolean => {
    for (const tabs of Object.values(useAppStore.getState().tabsByWorkspace)) {
      const t = tabs.find((x) => x.id === tabId)
      if (t) return t.scratchpadId === id
    }
    return false
  }

  const select = (info: ScratchpadInfo): void => {
    setTabScratchpad(tabId, info.id)
    setMenuOpen(false)
    setRenaming(false)
  }

  const create = async (name: string): Promise<void> => {
    setCreating(false)
    setMenuOpen(false)
    setCreateError(null)
    const r = await window.api.scratchpads.create(projectPath, name || undefined)
    if (!r.ok) {
      setCreateError(r.error)
      await refreshScratchpads(projectPath)
      return
    }
    setTabScratchpad(tabId, r.data.id)
    await act(r.data.id, 'start', () => window.api.scratchpads.start(projectPath, r.data.id))
  }

  const rename = async (name: string, pad: ScratchpadInfo | null = selected): Promise<void> => {
    if (!pad) return
    setRenaming(false)
    if (!name || name === pad.name) return
    await act(pad.id, 'rename', () => window.api.scratchpads.rename(projectPath, pad.id, name))
  }

  const startPad = (pad: ScratchpadInfo): void => void act(pad.id, 'start', () => window.api.scratchpads.start(projectPath, pad.id))
  const stopPad = (pad: ScratchpadInfo): void => void act(pad.id, 'stop', () => window.api.scratchpads.stop(projectPath, pad.id))
  const restartPad = (pad: ScratchpadInfo): void => void act(pad.id, 'restart', () => window.api.scratchpads.restart(projectPath, pad.id))
  const start = (): void => {
    if (selected) startPad(selected)
  }
  const stop = (): void => {
    if (selected) stopPad(selected)
  }
  const restart = (): void => {
    if (selected) restartPad(selected)
  }
  const remove = async (pad: ScratchpadInfo | null = selected): Promise<void> => {
    if (!pad) return
    const { id, name } = pad
    const ok = await requestConfirm({
      title: `Delete “${name}”?`,
      message: 'This stops its Unity editor and deletes the scratchpad folder with everything in it.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    await act(id, 'remove', () => window.api.scratchpads.remove(projectPath, id))
    if (tabShows(id)) setTabScratchpad(tabId, null)
  }

  const openTool = (contentType: 'unity-console' | 'tuner'): void => {
    if (!selected) return
    const st = useAppStore.getState()
    for (const [workspaceId, tabs] of Object.entries(st.tabsByWorkspace)) {
      const mine = tabs.find((t) => t.id === tabId)
      if (!mine) continue
      const existing = contentType === 'unity-console' ? consoleTabFor(tabs, mine.worktreeId) : sceneTunerTab(tabs, mine.worktreeId, undefined, st.groupsByWorkspace[workspaceId] ?? [])
      if (existing) {
        if (existing.scratchpadId !== selected.id) st.setTabScratchpad(existing.id, selected.id)
        const fullscreen = st.fullscreenGroupIdByWorkspace[workspaceId]
        if (fullscreen && fullscreen !== existing.groupId) st.exitFullscreen(workspaceId)
        st.activateTab(existing.id)
        return
      }
      const label = contentType === 'unity-console' ? 'Unity Console' : 'Tuner'
      st.openTabBeside(workspaceId, mine.groupId, mine.worktreeId, { label, contentType, scratchpadId: selected.id })
      return
    }
  }

  const openSingle = (info: ScratchpadInfo): void => {
    setTabScratchpad(tabId, info.id)
    setScratchpadGrid(ptyId, false)
  }

  const pickMode = (mode: UnityMode): void => {
    if (!selected || selected.unityMode === mode) return
    setModeError(null)
    const path = selected.path
    void window.api.unity.setMode(path, mode).then((r) => {
      if (!r.ok) setModeError(r.error ?? 'Could not change the Unity mode.')
      void refreshScratchpads(projectPath)
    })
  }

  const live = isScratchpadLive(selected)
  const view = useScratchpadView(projectPath, selected ?? NO_PAD, live)
  const status = view.status
  const busy = !!selected && view.action != null
  const actionError = selected ? view.actionError : null
  const dismissable = actionError ?? createError ?? modeError
  const fault = status === 'error' ? (selected?.fault ?? null) : null
  const shownError = dismissable ?? (status === 'error' && !fault ? selected?.error : null) ?? listError
  const dismissError = (): void => {
    setCreateError(null)
    setModeError(null)
    if (selected) clearScratchpadError(projectPath, selected.id)
  }

  const running = status === 'running' || status === 'starting' || status === 'stopping'
  const padNodes = (pad: ScratchpadInfo): ActionNode[] => {
    const on = pad.status === 'running' || pad.status === 'starting' || pad.status === 'stopping'
    return compact([
      section('show', [{ id: 'scratchpad.chip.show', label: `Show “${pad.name}”`, icon: 'eye', checked: pad.id === selected?.id, run: () => select(pad) }]),
      section('run', [
        on
          ? { id: 'scratchpad.chip.stop', label: 'Stop', icon: 'stop.fill', enabled: pad.status !== 'stopping', run: () => stopPad(pad) }
          : { id: 'scratchpad.chip.start', label: 'Start', icon: 'play.fill', run: () => startPad(pad) },
        { id: 'scratchpad.chip.restart', label: 'Restart', icon: 'arrow.clockwise', enabled: pad.status !== 'stopping' && pad.status !== 'stopped', run: () => restartPad(pad) }
      ]),
      section('manage', [
        {
          id: 'scratchpad.chip.rename',
          label: 'Rename',
          icon: 'pencil',
          input: { title: 'Rename scratchpad', placeholder: 'Scratchpad name', initial: pad.name, submit: 'Rename' },
          run: (value) => (value === undefined ? undefined : rename(String(value).trim(), pad))
        },
        { id: 'scratchpad.chip.delete', label: 'Delete', icon: 'trash', destructive: true, run: () => remove(pad) }
      ])
    ])
  }
  useMobileBack(grid && selected ? () => setScratchpadGrid(ptyId, false) : null, 'All')
  usePanelActions(
    ptyId,
    compact([
      section('pick', [
        {
          id: 'scratchpad.pick',
          label: selected ? selected.name : 'Scratchpads',
          icon: 'flask',
          children: compact([
            section(
              'list',
              list.map((info) => ({ id: `scratchpad.pick:${info.id}`, label: info.name, checked: info.id === selected?.id, run: () => select(info) }))
            ),
            section('new', [
              {
                id: 'scratchpad.new',
                label: 'New scratchpad',
                icon: 'plus',
                input: { title: 'New scratchpad', placeholder: 'Name (optional)', submit: 'Create' },
                run: (value) => create(String(value ?? '').trim())
              }
            ])
          ])
        },
        !!selected && !phone && (grid || liveCount > 0) && { id: 'scratchpad.grid', label: 'All', icon: 'square.grid.2x2', checked: grid, run: () => setScratchpadGrid(ptyId, !grid) }
      ]),
      !!selected &&
        section('run', [
          running
            ? { id: 'scratchpad.stop', label: 'Stop scratchpad', icon: 'stop.fill', primary: !phone, enabled: status !== 'stopping', run: stop }
            : { id: 'scratchpad.start', label: 'Start scratchpad', icon: 'play.fill', primary: true, run: start },
          { id: 'scratchpad.restart', label: 'Restart scratchpad', icon: 'arrow.clockwise', enabled: status !== 'stopping' && status !== 'stopped', run: restart }
        ]),
      !!selected &&
        section('tools', [
          { id: 'scratchpad.console', label: `Show “${selected.name}” in the console`, icon: 'list.bullet.rectangle', run: () => openTool('unity-console') },
          { id: 'scratchpad.tuner', label: `Open a tuner for “${selected.name}”`, icon: 'slider.horizontal.3', run: () => openTool('tuner') },
          !live && {
            id: 'scratchpad.mode',
            label: 'Unity mode',
            icon: 'macwindow',
            children: UNITY_MODE_MENU.map((m) => ({ id: `scratchpad.mode:${m.id}`, label: m.label, checked: selected.unityMode === m.id, run: () => pickMode(m.id) }))
          }
        ]),
      !!selected &&
        section('manage', [
          {
            id: 'scratchpad.rename',
            label: 'Rename scratchpad',
            icon: 'pencil',
            input: { title: 'Rename scratchpad', placeholder: 'Scratchpad name', initial: selected.name, submit: 'Rename' },
            run: (value) => (value === undefined ? setRenaming(true) : rename(String(value).trim()))
          },
          { id: 'scratchpad.copyPath', label: 'Copy path', icon: 'doc.on.doc', run: () => void navigator.clipboard.writeText(selected.path) },
          { id: 'scratchpad.delete', label: 'Delete scratchpad', icon: 'trash', destructive: true, run: () => remove() }
        ])
    ])
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas text-zinc-200" data-scratchpad-panel={ptyId}>
      {phone && (
        <div className="shrink-0 border-b border-white/[0.06]" data-scratchpad-phone-head>
          <div className="flex items-center gap-2 overflow-x-auto px-3 py-2 [scrollbar-width:none]">
            {list.map((info) => (
              <PadChip
                key={info.id}
                projectPath={projectPath}
                info={info}
                current={info.id === selected?.id}
                onPick={() => select(info)}
                onMenu={(x, y) => setChipMenu({ x, y, info })}
              />
            ))}
            {selected && (
              <button
                type="button"
                onClick={() => setCreating((c) => !c)}
                aria-pressed={creating}
                data-scratchpad-new
                className="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-white/10 px-4 text-[15px] text-zinc-300"
              >
                <Plus className="h-4 w-4" />
                New
              </button>
            )}
          </div>
          {creating && selected && (
            <div className="px-3 pb-2" data-scratchpad-create>
              <NameForm initial="" placeholder="Name (optional)" submitLabel="Create" autoFocus onSubmit={(n) => void create(n)} onCancel={() => setCreating(false)} />
            </div>
          )}
          {chipMenu && <ActionMenu x={chipMenu.x} y={chipMenu.y} nodes={padNodes(chipMenu.info)} onDismiss={() => setChipMenu(null)} />}
        </div>
      )}
      <div className={`relative flex h-8 shrink-0 items-center gap-2 border-b border-white/[0.06] px-2 ${phone ? 'hidden' : ''}`} ref={menuRef}>
        {renaming && selected ? (
          <div className="min-w-0 flex-1">
            <NameForm
              initial={selected.name}
              placeholder="Scratchpad name"
              submitLabel="Rename"
              autoFocus
              onSubmit={(n) => void rename(n)}
              onCancel={() => setRenaming(false)}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-zinc-200 hover:bg-white/10"
            title="Pick a scratchpad"
            data-scratchpad-selector
          >
            <FlaskConical className="h-3.5 w-3.5 shrink-0 text-violet-400" />
            {selected ? (
              <>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${view.dot}`} />
                <span className="truncate">{selected.name}</span>
                <span className={`shrink-0 text-[10px] ${view.tone}`} data-scratchpad-state={view.play ?? status}>
                  {view.label}
                </span>
              </>
            ) : (
              <span className="truncate">Scratchpads</span>
            )}
            <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" />
          </button>
        )}

        {!renaming && selected && (
          <div className="ml-auto flex items-center gap-0.5">
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin text-zinc-500" />}
            {(grid || liveCount > 0) && (
              <>
                <button
                  type="button"
                  onClick={() => setScratchpadGrid(ptyId, !grid)}
                  title={grid ? `Show only “${selected.name}”` : 'Show every running scratchpad in a grid'}
                  aria-pressed={grid}
                  data-scratchpad-grid-toggle
                  className={`flex h-6 items-center gap-1 rounded px-1.5 text-xs transition-colors ${
                    grid ? 'bg-sky-500/15 text-sky-200 hover:bg-sky-500/25' : 'text-zinc-400 hover:bg-white/10 hover:text-zinc-100'
                  }`}
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                  All
                  {liveCount > 0 && <span className="text-[10px] text-zinc-500">{liveCount}</span>}
                </button>
                <div className="mx-1 h-4 w-px shrink-0 bg-white/10" />
              </>
            )}
            <IconButton title={`Show “${selected.name}” in the console`} onClick={() => openTool('unity-console')}>
              <ScrollText className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton title={`Open a tuner for “${selected.name}”`} onClick={() => openTool('tuner')}>
              <Boxes className="h-3.5 w-3.5" />
            </IconButton>
            <div className="mx-1 h-4 w-px shrink-0 bg-white/10" />
            {status === 'running' || status === 'starting' || status === 'stopping' ? (
              <IconButton title="Stop scratchpad" onClick={stop} disabled={status === 'stopping'}>
                <Square className="h-3.5 w-3.5" />
              </IconButton>
            ) : (
              <IconButton title="Start scratchpad" onClick={start}>
                <Play className="h-3.5 w-3.5" />
              </IconButton>
            )}
            <IconButton title="Restart scratchpad" onClick={restart} disabled={status === 'stopping' || status === 'stopped'}>
              <RotateCw className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton title="Rename scratchpad" onClick={() => setRenaming(true)}>
              <Pencil className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton title={`Copy path: ${selected.path}`} onClick={() => void navigator.clipboard.writeText(selected.path)}>
              <Copy className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton title="Delete scratchpad" onClick={() => void remove()} danger>
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        )}

        {menuOpen && (
          <AnchoredLayer side="bottom" align="start" className="surface-overlay flex max-h-[60vh] w-72 flex-col overflow-hidden rounded-lg py-1">
            <div className="min-h-0 overflow-y-auto">
              {list.length === 0 && <div className="px-3 py-1.5 text-xs text-zinc-500">No scratchpads yet</div>}
              {list.map((info) => (
                <ScratchpadOption
                  key={info.id}
                  projectPath={projectPath}
                  info={info}
                  current={info.id === selected?.id}
                  streamed={live && info.id === selected?.id}
                  onPick={() => select(info)}
                />
              ))}
            </div>
            <div className="my-1 border-t border-white/5" />
            {creating ? (
              <div className="px-2 py-1">
                <NameForm
                  initial=""
                  placeholder="Name (optional)"
                  submitLabel="Create"
                  autoFocus
                  onSubmit={(n) => void create(n)}
                  onCancel={() => setCreating(false)}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-white/10"
              >
                <Plus className="h-3.5 w-3.5" />
                New scratchpad
              </button>
            )}
          </AnchoredLayer>
        )}
      </div>

      {shownError && (
        <div
          className="flex shrink-0 items-start gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-200"
          data-scratchpad-error
        >
          <span className="min-w-0 flex-1">{shownError}</span>
          {dismissable && (
            <button
              type="button"
              title="Dismiss"
              onClick={dismissError}
              className="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-red-300 hover:bg-red-500/20 hover:text-red-100"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {!loaded ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
          </div>
        ) : !selected ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <FlaskConical className="h-6 w-6 text-violet-400" />
            <p className="max-w-sm text-sm text-zinc-400">
              A scratchpad is an empty Unity project that uses this project&apos;s Unity version, packages and
              settings. Use it to try things out without touching the main project.
            </p>
            <div className="w-72">
              <NameForm
                initial=""
                placeholder="Name (optional)"
                submitLabel="Create"
                onSubmit={(n) => void create(n)}
              />
            </div>
          </div>
        ) : grid ? (
          <ScratchpadGrid projectPath={projectPath} ptyId={ptyId} list={list} selectedId={selected.id} onOpen={openSingle} />
        ) : live ? (
          phoneLive ? phoneLive(selected) : <PaneUnitySlot key={selected.path} id={ptyId} projectPath={selected.path} canStop={false} />
        ) : fault ? (
          <div className="flex h-full items-center justify-center bg-canvas" data-scratchpad-fault={fault.kind}>
            <EditorFaultCard
              kind={fault.kind}
              subject={`Scratchpad “${selected.name}”`}
              reason={fault.reason}
              log={fault.log}
              line={fault.line}
              onRestart={restart}
              restartDisabled={busy}
            />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-zinc-400">
              {status === 'stopping'
                ? `Stopping “${selected.name}”…`
                : status === 'starting'
                  ? `Starting “${selected.name}”…`
                  : `“${selected.name}” is stopped.`}
            </p>
            {status !== 'stopping' && status !== 'starting' && (
              <>
                <div className="flex w-80 max-w-full flex-col gap-1" data-scratchpad-mode-picker>
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500">Unity mode</span>
                  {UNITY_MODE_MENU.map((m) => {
                    const sel = m.id === selected.unityMode
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => pickMode(m.id)}
                        aria-pressed={sel}
                        className={`flex flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left transition-colors ${
                          sel ? 'bg-sky-500/15' : 'hover:bg-white/10'
                        }`}
                      >
                        <span className="flex w-full items-center gap-1.5 text-xs text-zinc-100">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${sel ? 'bg-sky-400' : 'bg-zinc-600'}`} />
                          {m.label}
                        </span>
                        <span className="pl-3 text-[10px] leading-snug text-zinc-500">{m.desc}</span>
                      </button>
                    )
                  })}
                </div>
                <button
                  type="button"
                  onClick={start}
                  data-scratchpad-start
                  className="flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-200 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <Play className="h-3.5 w-3.5" />
                  Start
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
