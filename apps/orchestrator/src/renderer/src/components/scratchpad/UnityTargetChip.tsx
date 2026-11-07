import { useCallback, useRef, useState } from 'react'
import { Box, Check, ChevronDown, FlaskConical } from 'lucide-react'
import type { ScratchpadInfo } from '@shared/scratchpads'
import { useAppStore } from '../../store'
import { useDismiss } from '../ui/useDismiss'
import { useAnchoredPosition } from '../../lib/anchored-popover'
import { isPhoneView } from '../../lib/tuner/view-mirror'
import { debugLog } from '@shared/debug-log'
import { useEditorView, useScratchpadView, type ScratchpadView } from './scratchpad-status'

function rowClass(active: boolean): string {
  return `flex w-full items-center gap-2 whitespace-nowrap px-3 text-left outline-none transition-colors hover:bg-white/10 ${
    isPhoneView() ? 'min-h-11 py-2 text-sm' : 'py-1.5 text-xs'
  } ${active ? 'text-white' : 'text-zinc-300'}`
}

function StateTail({ view, active }: { view: ScratchpadView; active: boolean }) {
  return (
    <>
      <span className={`shrink-0 text-[10px] ${view.tone}`} data-unity-target-state={view.play ?? view.status}>
        {view.label}
      </span>
      {active && <Check className="h-3 w-3 shrink-0 text-sky-400" />}
    </>
  )
}

function ProjectOption({ projectPath, active, onPick }: { projectPath: string; active: boolean; onPick: () => void }) {
  const view = useEditorView(projectPath)
  return (
    <button type="button" onClick={onPick} data-unity-target-option="project" className={rowClass(active)}>
      <Box className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${view.dot}`} />
      <span className="min-w-0 flex-1 truncate">Project</span>
      <StateTail view={view} active={active} />
    </button>
  )
}

function TargetOption({
  projectPath,
  info,
  active,
  onPick
}: {
  projectPath: string
  info: ScratchpadInfo
  active: boolean
  onPick: () => void
}) {
  const view = useScratchpadView(projectPath, info)
  return (
    <button
      type="button"
      onClick={onPick}
      data-unity-target-option={info.id}
      title={view.status === 'error' && info.error ? info.error : undefined}
      className={rowClass(active)}
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0 text-violet-400" />
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${view.dot}`} />
      <span className="min-w-0 flex-1 truncate">{info.name}</span>
      <StateTail view={view} active={active} />
    </button>
  )
}

function ChipDot({ projectPath, info }: { projectPath: string; info: ScratchpadInfo }) {
  const view = useScratchpadView(projectPath, info)
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${view.dot}`} title={view.label} />
}

function ProjectDot({ projectPath }: { projectPath: string }) {
  const view = useEditorView(projectPath)
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${view.dot}`} title={view.label} />
}

export function UnityTargetChip({
  tabId,
  projectPath,
  list,
  scratchpad
}: {
  tabId: string
  projectPath: string
  list: ScratchpadInfo[]
  scratchpad: ScratchpadInfo | null
}) {
  const setTabScratchpad = useAppStore((s) => s.setTabScratchpad)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, close, open)
  const pop = useAnchoredPosition(open, btnRef, 'bottom-left')

  const pick = (id: string | null): void => {
    setOpen(false)
    if (id === (scratchpad?.id ?? null)) return
    debugLog(`[tuner] target picked from the switcher: ${id ?? 'project'} tab=${tabId}`)
    setTabScratchpad(tabId, id)
  }
  const phone = isPhoneView()

  return (
    <div ref={ref} className="relative flex shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-unity-target={scratchpad?.id ?? 'project'}
        title={
          scratchpad
            ? `Using scratchpad “${scratchpad.name}” (${scratchpad.path}). Click to switch.`
            : 'Using the main project. Click to pick a scratchpad.'
        }
        className={`flex max-w-44 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 outline-none transition-colors ${phone ? 'min-h-8 text-sm' : 'py-0.5 text-xs'} ${
          open
            ? 'bg-white/10 text-white'
            : scratchpad
              ? 'bg-violet-500/10 text-violet-100 hover:bg-violet-500/20'
              : 'text-zinc-300 hover:bg-white/10 hover:text-white'
        }`}
      >
        {scratchpad ? (
          <>
            <FlaskConical className="h-3.5 w-3.5 shrink-0 text-violet-400" />
            <ChipDot projectPath={projectPath} info={scratchpad} />
            <span className="truncate">{scratchpad.name}</span>
          </>
        ) : (
          <>
            <Box className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <ProjectDot projectPath={projectPath} />
            <span>Project</span>
          </>
        )}
        <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" />
      </button>

      {open && (
        <div
          ref={pop.ref}
          style={pop.style}
          data-unity-target-menu
          className={`animate-menu-pop-in surface-overlay z-50 flex max-h-[60vh] flex-col overflow-hidden rounded-lg py-1 ${phone ? 'w-72' : 'w-64'}`}
        >
          <ProjectOption projectPath={projectPath} active={!scratchpad} onPick={() => pick(null)} />
          {list.length > 0 && <div className="my-1 border-t border-white/5" />}
          <div className="min-h-0 overflow-y-auto">
            {list.map((info) => (
              <TargetOption
                key={info.id}
                projectPath={projectPath}
                info={info}
                active={info.id === scratchpad?.id}
                onPick={() => pick(info.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
