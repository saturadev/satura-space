import { createContext, useContext, useEffect, useState, type ReactNode, type RefObject } from 'react'
import { LoaderCircle, TriangleAlert, X } from 'lucide-react'
import type { Status } from '@shared/git-scm'
import type { ActionNode } from '../../lib/actions/action-tree'
import { ExplorerIcon } from '../../components/workbench/explorer-icons'
import { getStatusColor, getStatusLetter, type DiffSides } from '../../lib/git/scm-resource'
import type { ISCMHistoryItem, ISCMHistoryItemViewModel } from '../../lib/git/scm-history'
import type { ScmRepository } from '../../components/git/use-scm-repository'
import type { GroupId, ScmChanges } from '../../components/git/use-scm-changes'
import type { ScmViewSettings, Stash } from '@shared/git-scm'
import type { HistoryModel } from './history'

export type Screen =
  | { kind: 'diff'; id: string; title: string; path: string; sides: DiffSides; group?: GroupId; status?: Status }
  | { kind: 'commit'; id: string; title: string; hash: string; vm?: ISCMHistoryItemViewModel }
  | { kind: 'compare'; id: string; title: string; base: ISCMHistoryItem; target: ISCMHistoryItem }
  | { kind: 'stash'; id: string; title: string; stash: Stash }

export interface GitCtx {
  root: string
  scope: string
  repo: ScmRepository
  m: ScmChanges
  settings: ScmViewSettings
  onSettings: (patch: Partial<ScmViewSettings>) => void
  history: HistoryModel
  version: number
  landscape: boolean
  push: (screen: Screen) => void
  replace: (id: string, screen: Screen) => void
  close: (id: string) => void
  openMenu: (nodes: ActionNode[], x: number, y: number) => void
  act: (label: string, fn: () => Promise<unknown>) => Promise<boolean>
  copy: (text: string, x: number, y: number) => void
  openFile?: (rel: string) => void
  showHistory: (paths: string[]) => void
  showTab: (tab: 'changes' | 'history') => void
}

export const GitContext = createContext<GitCtx | null>(null)

export function useGit(): GitCtx {
  const ctx = useContext(GitContext)
  if (!ctx) throw new Error('No Git view')
  return ctx
}

export function Spinner({ size = 16, className = '' }: { size?: number; className?: string }) {
  return <LoaderCircle size={size} className={`shrink-0 animate-spin text-ink-3 ${className}`} />
}

export function FileGlyph({ name, dir = false, dim = false }: { name: string; dir?: boolean; dim?: boolean }) {
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center [&>svg]:h-[19px] [&>svg]:w-[19px]">
      <ExplorerIcon name={name} rel={name} isDir={dir} open={false} dim={dim} unity={false} />
    </span>
  )
}

export function StatusBadge({ status }: { status: Status }) {
  const color = getStatusColor(status)
  return (
    <span className="flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-[6px] px-1 font-mono text-[12px] font-bold" style={{ color, background: `${color}24` }} data-pg-status={getStatusLetter(status)}>
      {getStatusLetter(status)}
    </span>
  )
}

export function StateView({ icon, title, body, children, data }: { icon?: ReactNode; title: string; body?: string; children?: ReactNode; data?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 pb-10 text-center" data-pg-state={data ?? title}>
      {icon && <div className="mb-1 text-ink-3">{icon}</div>}
      <div className="text-[17px] font-semibold text-ink">{title}</div>
      {body && <div className="max-w-[340px] whitespace-pre-line text-[14px] leading-snug text-ink-3">{body}</div>}
      {children && <div className="mt-3 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  )
}

export function PillButton({ label, onClick, tone = 'plain', disabled, busy, data, icon }: { label: string; onClick: () => void; tone?: 'accent' | 'plain' | 'danger'; disabled?: boolean; busy?: boolean; data?: string; icon?: ReactNode }) {
  const look =
    tone === 'accent' ? 'bg-accent text-accent-fg' : tone === 'danger' ? 'bg-err/15 text-err' : 'bg-elevated text-ink'
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
      className={`flex h-11 min-w-0 items-center justify-center gap-2 rounded-[12px] px-4 text-[15px] font-semibold active:opacity-70 disabled:opacity-40 ${look}`}
      data-pg-button={data ?? label}
    >
      {busy ? <Spinner size={15} className={tone === 'accent' ? 'text-accent-fg' : ''} /> : icon}
      <span className="truncate">{label}</span>
    </button>
  )
}

export function Banner({ tone, children, onDismiss, action, data }: { tone: 'err' | 'warn'; children: ReactNode; onDismiss?: () => void; action?: { label: string; run: () => void }; data?: string }) {
  const color = tone === 'err' ? 'text-err' : 'text-warn'
  return (
    <div className={`mx-3 mb-2 rounded-[12px] border px-3 py-2 ${tone === 'err' ? 'border-err/30 bg-err/10' : 'border-warn/30 bg-warn/10'}`} data-pg-banner={data ?? tone}>
      <div className="flex items-start gap-2">
        <TriangleAlert size={16} className={`mt-[3px] shrink-0 ${color}`} />
        <div className="min-w-0 flex-1 break-words text-[14px] leading-snug text-ink">{children}</div>
        {onDismiss && (
          <button type="button" aria-label="Dismiss" onClick={onDismiss} className="-mr-3 -mt-2.5 flex h-11 w-11 shrink-0 items-center justify-center text-ink-3 active:opacity-60">
            <X size={17} />
          </button>
        )}
      </div>
      {action && (
        <button type="button" onClick={action.run} className={`mt-1 h-11 rounded-[10px] bg-white/10 px-4 text-[14px] font-semibold text-ink active:opacity-70`} data-pg-banner-action={action.label}>
          {action.label}
        </button>
      )}
    </div>
  )
}

export function useLandscape(ref: RefObject<HTMLElement | null>): boolean {
  const [landscape, setLandscape] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => {
      const r = el.getBoundingClientRect()
      setLandscape(r.width > r.height && r.height < 560)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return landscape
}

export function baseName(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1)
}

export function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i > 0 ? path.substring(0, i) : ''
}
