import { useMemo, useState } from 'react'
import { RotateCcw, AppWindow, GitBranch } from 'lucide-react'
import type { ResourceSession, ResourceSnapshot, ResourceWorkspaceInfo } from '@shared/api'
import { describeWorkspace, unityOwnerCandidates, workspacePathSets } from '@shared/workspace-topology'
import { Popover } from '../ui/Popover'
import { useResourceSnapshot } from './useResourceSnapshot'
import { revealSession } from '../../lib/resource-manager/reveal-session'
import { groupRunningSessions, mergeWindowInfos } from '../../lib/resource-manager/group-sessions'
import { useRestartDaemon } from '../../lib/terminal/use-restart-daemon'
import { useAppStore } from '../../store'
import { DiskSummary, LoadChart, cpuTicks, formatMem, formatPct, memTicks, stats, useSystemLoad } from '../system-load/SystemLoadCharts'

function formatMemory(bytes: number | null): string {
  if (bytes == null) return '—'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function formatCpu(cpu: number | null): string {
  return cpu == null ? '—' : `${cpu.toFixed(0)}%`
}

function formatShare(used: number, total: number): string {
  if (!total) return '—'
  const pct = (used / total) * 100
  return `${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%`
}

function MemoryIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.1a2 2 0 0 0 0 3.8V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5.1a2 2 0 0 0 0-3.8Z" />
      <path d="M2 14h20" />
      <path d="M7 19v-2M12 19v-2M17 19v-2" />
    </svg>
  )
}

function dotColor(kind: ResourceSession['kind']): string {
  if (kind === 'app') return 'bg-violet-400'
  if (kind === 'unity') return 'bg-emerald-400'
  return 'bg-sky-400'
}

function MacLoadSection() {
  const load = useSystemLoad(true)
  const last = load.samples[load.samples.length - 1]
  const cpu = stats(load.samples.map((s) => s.cpu))
  const mem = stats(load.samples.map((s) => s.mem))
  const heading = 'text-[10px] font-semibold uppercase tracking-wide text-zinc-500'
  return (
    <div className="space-y-3 border-b border-white/10 px-3 pb-3 pt-2.5" data-mac-load>
      {load.error && !load.loaded && <div className="text-xs text-zinc-500">Can't read this computer's load: {load.error}</div>}
      <div>
        <div className="flex items-baseline justify-between">
          <span className={heading}>CPU</span>
          <span className="text-[13px] font-semibold text-zinc-100">{last ? formatPct(last.cpu) : '—'}</span>
        </div>
        <LoadChart samples={load.samples} pick={(s) => s.cpu} max={100} windowMs={load.windowMs} height={76} ticks={cpuTicks()} format={formatPct} surface="var(--overlay)" label="CPU" />
        {load.samples.length > 1 && (
          <div className="text-[10px] tabular-nums text-zinc-500">
            Peak {formatPct(cpu.peak)} · average {formatPct(cpu.avg)}
            {load.cores ? ` · ${load.cores} cores` : ''}
          </div>
        )}
      </div>
      <div>
        <div className="flex items-baseline justify-between">
          <span className={heading}>Memory</span>
          <span className="text-[13px] font-semibold text-zinc-100">
            {last ? formatMem(last.mem) : '—'}
            {load.memTotal ? <span className="font-normal text-zinc-500"> of {formatMem(load.memTotal)}</span> : null}
          </span>
        </div>
        <LoadChart samples={load.samples} pick={(s) => s.mem} max={load.memTotal} windowMs={load.windowMs} height={76} ticks={memTicks(load.memTotal)} format={formatMem} surface="var(--overlay)" label="Memory used" />
        {load.samples.length > 1 && <div className="text-[10px] tabular-nums text-zinc-500">Peak {formatMem(mem.peak)} · average {formatMem(mem.avg)}</div>}
      </div>
      {load.disk && (
        <div className="space-y-1">
          <span className={heading}>Disk</span>
          <DiskSummary disk={load.disk} compact />
        </div>
      )}
    </div>
  )
}

function ResourceSessionsPanel({
  snapshot,
  running,
  restarting,
  onRestart,
  onClose
}: {
  snapshot: ResourceSnapshot | null
  running: ResourceSession[]
  restarting: boolean
  onRestart: () => void
  onClose: () => void
}) {
  const tabsByWorkspace = useAppStore((s) => s.tabsByWorkspace)
  const worktreesByWorkspace = useAppStore((s) => s.worktreesByWorkspace)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const allTabs = useMemo(() => Object.values(tabsByWorkspace).flat(), [tabsByWorkspace])

  const currentWindowId = useMemo(
    () => new URLSearchParams(window.location.search).get('wid'),
    []
  )

  const labelFor = (s: ResourceSession): string => {
    if (s.kind === 'terminal') {
      const tab = allTabs.find((t) => t.ptyId === s.id)
      return tab?.customLabel || tab?.generatedLabel || tab?.label || s.label || 'Terminal'
    }
    if (s.kind === 'unity') {
      if (s.scratchpadName) return `Scratchpad: ${s.scratchpadName}`
      return s.unityKind === 'clone' ? 'Unity (clone)' : 'Unity Instance'
    }
    return s.label
  }

  const localWorkspaceOf = (s: ResourceSession): string | null => {
    if (s.kind === 'terminal') {
      for (const [wsId, tabs] of Object.entries(tabsByWorkspace)) {
        if (tabs.some((t) => t.ptyId === s.id)) return wsId
      }
      return null
    }
    if (s.kind === 'unity') {
      const sets = workspaces.map((ws) => ({
        id: ws.id,
        ...workspacePathSets(ws, (worktreesByWorkspace[ws.id] ?? []).map((wt) => wt.path))
      }))
      for (const p of unityOwnerCandidates(s.projectPath)) {
        const hit = sets.find((ws) => ws.primary.has(p))?.id ?? sets.find((ws) => ws.fallback.has(p))?.id
        if (hit) return hit
      }
      return null
    }
    return null
  }

  const localWorkspaceInfos: ResourceWorkspaceInfo[] = workspaces.map(describeWorkspace)

  const appRows = (snapshot?.sessions ?? []).filter((s) => s.kind === 'app')

  const windowInfos = mergeWindowInfos(
    snapshot?.windows ?? [],
    currentWindowId,
    localWorkspaceInfos,
    workspaces.find((w) => w.id === activeWorkspaceId)?.name || workspaces[0]?.name || 'This window'
  )
  const windowGroups = groupRunningSessions(
    running,
    windowInfos,
    currentWindowId,
    localWorkspaceOf
  )

  const windowNumber = new Map(windowInfos.map((w, i) => [w.id, i + 1]))

  const showWindowHeaders = windowGroups.length > 1
  const totalWorkspaceGroups = windowGroups.reduce((n, g) => n + g.workspaces.length, 0)
  const showWorkspaceHeader = (ws: ResourceWorkspaceInfo | null): boolean =>
    !!ws && (showWindowHeaders || totalWorkspaceGroups > 1 || ws.isWorktree)

  const renderRow = (s: ResourceSession, padLeft: string) => {
    const interactive = s.kind !== 'app'
    return (
      <div
        key={`${s.kind}:${s.id}`}
        onClick={
          interactive
            ? () => {
                revealSession(s)
                onClose()
              }
            : undefined
        }
        className={`flex items-center gap-2 py-1.5 pr-3 ${padLeft} cursor-default ${interactive ? 'hover:bg-white/5' : ''}`}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${dotColor(s.kind)}`} title={s.kind} />
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{labelFor(s)}</span>
        <span className="w-12 text-right text-xs tabular-nums text-zinc-400">{formatCpu(s.cpu)}</span>
        <span className="w-16 text-right text-xs tabular-nums text-zinc-400">
          {formatMemory(s.memory)}
        </span>
      </div>
    )
  }

  return (
    <>
      <MacLoadSection />
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        <span>Running sessions</span>
        <div className="flex items-center gap-1.5">
          <span className="tabular-nums">{running.length}</span>
          <button
            onClick={onRestart}
            disabled={restarting}
            title="Restart the terminal daemon"
            className="rounded p-0.5 text-zinc-500 transition-colors hover:bg-red-500/15 hover:text-red-300 disabled:opacity-50"
          >
            <RotateCcw size={12} className={restarting ? 'animate-spin' : undefined} />
          </button>
        </div>
      </div>

      {snapshot && (
        <div className="space-y-1 border-b border-white/10 px-3 py-2">
          <div className="flex items-baseline gap-2.5 text-xs tabular-nums">
            <span className="font-semibold text-zinc-100">{formatMemory(snapshot.totalMemory)}</span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-300">{formatCpu(snapshot.totalCpu)} CPU</span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-500">
              {formatShare(snapshot.totalMemory, snapshot.hostMemory)} of system RAM
            </span>
          </div>
          <div className="flex items-baseline gap-1.5 text-[11px] tabular-nums text-zinc-500">
            <span className="font-medium text-zinc-300">{formatMemory(snapshot.freeMemory)}</span>
            <span>RAM left of {formatMemory(snapshot.hostMemory)}</span>
          </div>
          <p className="text-[10px] leading-snug text-zinc-600">
            Combined CPU load. Values above 100% mean more than one core is working at once.
          </p>
        </div>
      )}

      <div className="max-h-72 overflow-y-auto">
        {appRows.map((s) => renderRow(s, 'pl-3'))}
        {windowGroups.map((wg) => (
          <div key={wg.info?.id ?? 'unattributed'}>
            {showWindowHeaders && (
              <div className="flex items-center gap-1.5 border-y border-white/5 bg-white/[0.035] px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                <AppWindow size={12} className="shrink-0 text-zinc-500" />
                <span className="min-w-0 flex-1 truncate">
                  {wg.info ? `Window ${windowNumber.get(wg.info.id) ?? '?'}` : 'Other'}
                </span>
                {wg.info?.focused && (
                  <span className="shrink-0 rounded bg-emerald-400/15 px-1 text-[9px] font-medium normal-case tracking-normal text-emerald-300">
                    current
                  </span>
                )}
                <span className="shrink-0 tabular-nums text-zinc-600">
                  {formatMemory(wg.memory)}
                </span>
              </div>
            )}
            {wg.workspaces.map((ws) => {
              const headed = showWorkspaceHeader(ws.info)
              const rowPad = showWindowHeaders ? 'pl-7' : headed ? 'pl-5' : 'pl-3'
              return (
                <div key={ws.info?.id ?? 'unattributed'}>
                  {ws.info && headed && (
                    <div
                      className={`flex items-center gap-1.5 border-y border-white/5 bg-white/[0.02] py-1 pr-3 ${showWindowHeaders ? 'pl-5' : 'pl-3'} text-[10px] font-medium uppercase tracking-wide text-zinc-500`}
                    >
                      <span className="min-w-0 truncate">{ws.info.name}</span>
                      {ws.info.isWorktree && ws.info.worktreeLabel && (
                        <span
                          title={`Worktree: ${ws.info.worktreeLabel}`}
                          className="inline-flex min-w-0 shrink items-center gap-0.5 rounded bg-sky-400/10 px-1 py-px text-[9px] font-medium normal-case tracking-normal text-sky-300"
                        >
                          <GitBranch size={9} className="shrink-0" />
                          <span className="truncate">{ws.info.worktreeLabel}</span>
                        </span>
                      )}
                      <span className="ml-auto shrink-0 tabular-nums text-zinc-600">
                        {formatMemory(ws.memory)}
                      </span>
                    </div>
                  )}
                  {ws.rows.map((s) => renderRow(s, rowPad))}
                </div>
              )
            })}
          </div>
        ))}
        {snapshot && running.length === 0 && (
          <div className="px-3 py-3 text-center text-xs text-zinc-600">
            No terminals or Unity instances running
          </div>
        )}
      </div>
    </>
  )
}

export function ResourceManagerButton() {
  const [open, setOpen] = useState(false)
  const { snapshot } = useResourceSnapshot(open)
  const { restarting, restartDaemon } = useRestartDaemon()
  const running = useMemo(
    () => (snapshot?.sessions ?? []).filter((s) => s.kind !== 'app'),
    [snapshot]
  )

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      width="w-[360px]"
      align="right"
      placement="top"
      trigger={({ toggle }) => (
        <button
          onClick={toggle}
          title="Memory & running sessions"
          className="flex h-6 items-center gap-2 rounded px-2 text-ink-2 transition-colors hover:bg-white/[0.06] hover:text-ink"
        >
          <MemoryIcon />
          <span className="text-[11px] font-medium tabular-nums">
            {formatMemory(snapshot?.totalMemory ?? null)}
          </span>
          {running.length > 0 && (
            <>
              <span className="text-zinc-600">·</span>
              <span className="text-[11px] tabular-nums text-zinc-500">{running.length}</span>
            </>
          )}
        </button>
      )}
    >
      {open && (
        <ResourceSessionsPanel
          snapshot={snapshot}
          running={running}
          restarting={restarting}
          onRestart={() => void restartDaemon()}
          onClose={() => setOpen(false)}
        />
      )}
    </Popover>
  )
}
