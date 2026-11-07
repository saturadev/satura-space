import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import type { Tab } from '@shared/types'
import { formatSize } from '@shared/file-picker'
import { isReactReport } from '@shared/report-compile'
import { relativeTo, shortenPath, tildePath, type GitPathInfo, type PathHoverInfo, type PtyHoverInfo } from '@shared/hover-info'
import { useAppStore } from '../../store'
import { AgentIcon } from '../../lib/agent-icon'
import { agentRunStatusFor, formatElapsed, statusSinceFor, type AgentRunStatus } from '../../lib/agent-status'
import { pathBasename } from '../../lib/path'
import { formatWhen } from '../../lib/when'
import { relativeTimeLong } from '../../lib/relative-time'
import { primaryWorldId } from '../../lib/unity/instance-ids'
import { useStatusDot, useWorldStore } from '../../lib/unity/world-store'
import { StatusDot } from '../workspace/WorkspaceAgentsBadge'
import { useScratchpadPick } from '../../lib/unity/scratchpads'
import { useScratchpadView } from '../scratchpad/scratchpad-status'
import type { ScratchpadInfo } from '@shared/scratchpads'
import { CardFooter, CardHeader, CardRow, CardRows, CopyAction } from '../ui/HoverCard'
import { usePtyAgent } from './agent-line'
import { PanelIcon } from './PanelIcon'

export const AGENT_STATUS_TEXT: Record<AgentRunStatus, string> = {
  working: 'Working',
  'needs-input': 'Waiting for you',
  idle: 'Idle'
}

const TONE_TEXT: Record<AgentRunStatus, string> = {
  working: 'text-work',
  'needs-input': 'text-amber-300',
  idle: 'text-ink-2'
}

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [ms])
  return now
}

function usePromise<T>(make: () => Promise<T> | null, deps: unknown[]): T | null {
  const [value, setValue] = useState<T | null>(null)
  useEffect(() => {
    let alive = true
    setValue(null)
    const p = make()
    p?.then(
      (v) => alive && setValue(v),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, deps)
  return value
}

function shownPath(path: string, root: string, home: string): string {
  return relativeTo(path, root) ?? tildePath(path, home)
}

function PathRow({ label, path, root, home }: { label: string; path: string; root: string; home: string }): ReactElement {
  return (
    <CardRow label={label} mono nowrap full={path}>
      {shortenPath(shownPath(path, root, home), 40)}
    </CardRow>
  )
}

function BranchRow({ git }: { git: GitPathInfo | null | undefined }): ReactElement | null {
  if (!git) return null
  return (
    <CardRow label="Branch" mono>
      {git.branch ?? 'detached HEAD'}
      {git.worktree && <span className="ml-1.5 font-sans text-ink-3">worktree</span>}
    </CardRow>
  )
}

function WhenRow({ label, ms }: { label: string; ms: number | undefined }): ReactElement | null {
  if (ms == null || !Number.isFinite(ms)) return null
  return (
    <CardRow label={label}>
      {formatWhen(ms)}
      <span className="ml-1.5 text-ink-3">{relativeTimeLong(ms)}</span>
    </CardRow>
  )
}

function Card({ icon, title, aside, children, copy }: { icon: ReactNode; title: string; aside?: ReactNode; children?: ReactNode; copy?: string }) {
  return (
    <div className="w-[320px] max-w-full" data-tab-hover-card>
      <CardHeader icon={icon} title={title} aside={aside} />
      <CardRows>{children}</CardRows>
      {copy && (
        <CardFooter>
          <CopyAction text={copy} />
        </CardFooter>
      )}
    </div>
  )
}

function TerminalCard({ tab, label, root }: { tab: Tab; label: string; root: string }) {
  const exited = useAppStore((s) => s.exitedPtyIds.includes(tab.ptyId))
  const hook = useAppStore((s) => s.agentHookStatusByPty[tab.ptyId])
  const agent = usePtyAgent(tab.agentId ? tab.ptyId : null)
  const now = useNow(15_000)
  const pty = usePromise<PtyHoverInfo>(() => (exited ? null : window.api.pty.info(tab.ptyId)), [tab.ptyId, exited])
  const cwd = pty?.cwd || root
  const where = usePromise<PathHoverInfo>(() => (cwd ? window.api.app.pathInfo(cwd, true) : null), [cwd])
  const home = pty?.home ?? where?.home ?? ''
  const status = tab.agentId ? agentRunStatusFor(tab, exited, hook) : null
  const elapsed = status ? formatElapsed(now - statusSinceFor(tab.ptyId, status, now)) : ''
  const shell = pty?.shell ? pathBasename(pty.shell) : ''
  const proc = pty?.process ?? ''
  return (
    <Card
      icon={tab.agentId ? <AgentIcon id={tab.agentId} className="h-3.5 w-3.5" /> : <PanelIcon tab={tab} />}
      title={label}
      copy={cwd || undefined}
      aside={
        status && (
          <span className={`flex items-center gap-1 text-[11px] ${TONE_TEXT[status]}`} data-hover-status={status}>
            {status !== 'idle' && <StatusDot status={status} />}
            {AGENT_STATUS_TEXT[status]}
            {elapsed && <span className="text-ink-3">· {elapsed}</span>}
          </span>
        )
      }
    >
      {agent && <CardRow label="Agent">{agent.name}</CardRow>}
      {exited && <CardRow label="State" tone="ink-2">Exited</CardRow>}
      {!agent && shell && (
        <CardRow label="Shell" mono>
          {shell}
        </CardRow>
      )}
      {!agent && proc && proc !== shell && (
        <CardRow label="Running" mono>
          {proc}
        </CardRow>
      )}
      {cwd && <PathRow label="Folder" path={cwd} root="" home={home} />}
      <BranchRow git={where?.git} />
    </Card>
  )
}

function FileCard({ tab, label, file, root, trail }: { tab: Tab; label: string; file: string; root: string; trail?: string[] }) {
  const dirty = useAppStore((s) => file in s.draftsByPath)
  const report = isReactReport(file)
  const info = usePromise<PathHoverInfo>(() => window.api.app.pathInfo(file, !report), [file, report])
  const home = info?.home ?? ''
  return (
    <Card icon={<PanelIcon tab={tab} file={file} />} title={label} copy={file}>
      {trail && trail.length > 1 && (
        <CardRow label="Path" full={trail.join(' › ')}>
          <span data-hover-trail>{trail.join(' › ')}</span>
        </CardRow>
      )}
      <PathRow label={report ? 'File' : 'Path'} path={file} root={root} home={home} />
      {info && !info.exists && <CardRow label="State" tone="ink-2">Not on disk</CardRow>}
      <WhenRow label={report ? 'Saved' : 'Modified'} ms={info?.mtimeMs} />
      {info?.size != null && <CardRow label="Size">{formatSize(info.size)}</CardRow>}
      {info?.git?.status && <CardRow label="Git">{info.git.status}</CardRow>}
      {dirty && (
        <CardRow label="Editor">
          <span className="text-amber-300">Unsaved changes</span>
        </CardRow>
      )}
    </Card>
  )
}

function UnityCard({ tab, label, root }: { tab: Tab; label: string; root: string }) {
  const wid = primaryWorldId(root)
  const dot = useStatusDot(root, wid, tab.ptyId)
  const editor = useWorldStore((s) => s.worlds[root]?.observed.project.editorVersion)
  const scene = useWorldStore((s) => s.worlds[root]?.observed.instances[wid]?.scene)
  const players = useWorldStore((s) => Object.keys(s.worlds[root]?.observed.instances ?? {}).length)
  const where = usePromise<PathHoverInfo>(() => (root ? window.api.app.pathInfo(root, false) : null), [root])
  return (
    <Card icon={<PanelIcon tab={tab} />} title={label} copy={root || undefined}>
      <CardRow label="Project">{pathBasename(root)}</CardRow>
      {root && <PathRow label="Folder" path={root} root="" home={where?.home ?? ''} />}
      {editor && (
        <CardRow label="Editor" mono>
          {editor}
        </CardRow>
      )}
      <CardRow label="State">{dot.label}</CardRow>
      {scene && <CardRow label="Scene">{scene}</CardRow>}
      {players > 1 && <CardRow label="Players">{players}</CardRow>}
    </Card>
  )
}

function ScratchpadState({ root, info }: { root: string; info: ScratchpadInfo }) {
  const view = useScratchpadView(root, info)
  return <CardRow label="State">{view.label}</CardRow>
}

function ScratchpadCard({ tab, label, root }: { tab: Tab; label: string; root: string }) {
  const { selected } = useScratchpadPick(root, tab.scratchpadId)
  const where = usePromise<PathHoverInfo>(() => (selected ? window.api.app.pathInfo(selected.path, false) : null), [selected?.path])
  return (
    <Card icon={<PanelIcon tab={tab} />} title={label} copy={selected?.path || root || undefined}>
      <CardRow label="Project">{pathBasename(root)}</CardRow>
      {selected ? (
        <>
          <CardRow label="Scratchpad">{selected.name}</CardRow>
          <ScratchpadState root={root} info={selected} />
          <PathRow label="Folder" path={selected.path} root="" home={where?.home ?? ''} />
        </>
      ) : (
        <CardRow label="Scratchpad">None yet</CardRow>
      )}
    </Card>
  )
}

function ProjectCard({ tab, label, root, git }: { tab: Tab; label: string; root: string; git?: boolean }) {
  const where = usePromise<PathHoverInfo>(() => (root ? window.api.app.pathInfo(root, !!git) : null), [root, git])
  return (
    <Card icon={<PanelIcon tab={tab} />} title={label} copy={root || undefined}>
      <CardRow label="Project">{pathBasename(root)}</CardRow>
      {root && <PathRow label="Folder" path={root} root="" home={where?.home ?? ''} />}
      <BranchRow git={where?.git} />
    </Card>
  )
}

export function TabHoverContent({ tab, label, file, root, trail }: { tab: Tab; label: string; file?: string; root: string; trail?: string[] }): ReactElement {
  if (tab.contentType === 'terminal') return <TerminalCard tab={tab} label={label} root={root} />
  if (tab.contentType === 'file-viewer' && file) return <FileCard tab={tab} label={label} file={file} root={root} trail={trail} />
  if (tab.contentType === 'unity-instance-player') return <UnityCard tab={tab} label={label} root={root} />
  if (tab.contentType === 'unity-scratchpad' && root) return <ScratchpadCard tab={tab} label={label} root={root} />
  return <ProjectCard tab={tab} label={label} root={root} git={tab.contentType === 'git-scm'} />
}
