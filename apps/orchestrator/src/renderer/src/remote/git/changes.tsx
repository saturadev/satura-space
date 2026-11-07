import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Archive, ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronRight, CircleCheck, CloudDownload, CloudUpload, Ellipsis, GitBranch, X } from 'lucide-react'
import { WORKTREE_REF, type Stash } from '@shared/git-scm'
import { conflictGroupLabel, conflictSideNames } from '../../lib/git/conflict-sides'
import { getResourceDiffSides, getEnvDiffSides, getStatusText, getStrikeThrough, resourcePath, type DiffSides } from '../../lib/git/scm-resource'
import { flattenResourceTree, type IResourceNode } from '../../lib/git/resource-tree'
import { relativeTimeShort } from '../../lib/relative-time'
import { requestConfirm } from '../../lib/confirm/confirm-store'
import type { ActionNode } from '../../lib/actions/action-tree'
import { ScmProgressBar } from '../../components/git/ScmProgress'
import { EnvFileIcon, EnvWarningIcon } from '../../components/git/env-icons'
import {
  changeMenuNodes,
  collectPaths,
  isBothAddedOrModified,
  plural,
  stashCreateNodes,
  stashItemNodes,
  type GroupId,
  type Item,
  type MenuRow,
  type Row
} from '../../components/git/use-scm-changes'
import { Banner, FileGlyph, PillButton, Spinner, StateView, StatusBadge, baseName, useGit, type Screen } from './ui'

const FOLDER_PAGE = 50
const HEIGHT: Record<Row['type'], number> = { group: 46, folder: 46, file: 50, more: 46, neverAdd: 0, empty: 46, stash: 60 }
const INDENT = 14

export function diffScreenFor(group: GroupId, item: Item, indexChanges: Parameters<typeof getResourceDiffSides>[1]): Screen | null {
  const change = item.change
  if (!change) return null
  const path = resourcePath(change)
  let sides: DiffSides
  if (group === 'merge' && isBothAddedOrModified(change)) sides = { original: { path, ref: ':2' }, modified: { path, ref: WORKTREE_REF }, title: baseName(path) }
  else if (group === 'workingTree' && item.residual) sides = getEnvDiffSides(path)
  else sides = getResourceDiffSides(change, indexChanges)
  return { kind: 'diff', id: `diff:${group}:${path}`, title: baseName(path), path, sides, group, status: change.status }
}

export function BranchBar({ compact, tabs }: { compact: boolean; tabs: ReactNode }) {
  const { repo, m, openMenu, copy, act } = useGit()
  const HEAD = m.HEAD
  const upstream = HEAD?.upstream ? `${HEAD.upstream.remote}/${HEAD.upstream.name}` : ''
  const remoteOp = repo.busy === 'Fetch' || repo.busy === 'Pull' || repo.busy === 'Push' ? repo.busy : null
  const live = repo.remote && repo.remote.operation === remoteOp ? repo.remote : null
  const ahead = m.ahead
  const behind = m.behind
  const status = !HEAD
    ? ''
    : !upstream
      ? 'Not published yet'
      : behind && ahead
        ? `${upstream} · ${behind} to pull, ${ahead} to push`
        : behind
          ? `${upstream} · ${behind} to pull`
          : ahead
            ? `${upstream} · ${ahead} to push`
            : `${upstream} · up to date`
  const sync: { label: string; icon: ReactNode; run: () => Promise<unknown>; id: string } = !upstream
    ? { id: 'publish', label: 'Publish', icon: <CloudUpload size={17} />, run: () => act('Publish', () => m.push()) }
    : behind && ahead
      ? { id: 'sync', label: 'Sync', icon: <ArrowUpDown size={17} />, run: () => act('Sync', async () => (await m.pullDefault()) && m.push()) }
      : behind
        ? { id: 'pull', label: `Pull ${behind}`, icon: <ArrowDown size={17} />, run: () => act('Pull', () => m.pullDefault()) }
        : ahead
          ? { id: 'push', label: `Push ${ahead}`, icon: <ArrowUp size={17} />, run: () => act('Push', () => m.push()) }
          : { id: 'fetch', label: 'Fetch', icon: <CloudDownload size={17} />, run: () => act('Fetch', () => m.fetch()) }
  const verb = remoteOp === 'Fetch' ? 'Fetching' : remoteOp === 'Pull' ? 'Pulling' : 'Pushing'
  const branchMenu = (x: number, y: number): void =>
    openMenu([...m.branchNodes(copy), { id: 'git.branch.options', label: '', inline: true, children: [m.pullOptionsNode(), m.pushOptionsNode()] }], x, y)
  return (
    <div className="relative shrink-0">
      <div className={`flex items-center gap-2 px-3 ${compact ? 'py-1' : 'pb-1 pt-2'}`}>
        <button
          type="button"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            branchMenu(r.left, r.bottom)
          }}
          className="flex min-h-[46px] min-w-0 flex-1 items-center gap-2.5 rounded-[12px] text-left active:opacity-70"
          data-pg-branch={m.branchLabel}
        >
          <GitBranch size={19} className="shrink-0 text-ink-2" />
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-[16px] font-semibold text-ink">{m.headLabel || 'Git'}</span>
              <ChevronDown size={15} className="shrink-0 text-ink-3" />
            </span>
            {status && (
              <span className="truncate text-[12.5px] text-ink-3" data-pg-upstream>
                {status}
              </span>
            )}
          </span>
        </button>
        {compact && tabs}
        {remoteOp ? (
          <div className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-elevated pl-3.5 pr-1" data-pg-sync-running={remoteOp}>
            <Spinner size={16} className="text-accent" />
            <span className="text-[15px] font-semibold tabular-nums text-ink">
              {live?.cancelling ? 'Stopping' : verb}
              {live?.percent !== undefined && !live.cancelling ? ` ${live.percent}%` : '…'}
            </span>
            {repo.remote && !repo.remote.cancelling ? (
              <button type="button" aria-label={`Cancel ${remoteOp}`} onClick={repo.cancelRemote} className="-my-0.5 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-ink active:opacity-60" data-pg-cancel>
                <X size={17} />
              </button>
            ) : (
              <span className="w-2" />
            )}
          </div>
        ) : HEAD ? (
          <button
            type="button"
            disabled={!m.idle}
            onClick={() => void sync.run()}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 text-[15px] font-semibold text-accent-fg active:opacity-70 disabled:opacity-40"
            data-pg-sync={sync.id}
          >
            {sync.icon}
            {sync.label}
          </button>
        ) : null}
      </div>
      <ScmProgressBar progress={repo.progress} remote={repo.remote} className="bottom-0" />
    </div>
  )
}

export function Tabs({ tab, onTab, changes, compact }: { tab: 'changes' | 'history'; onTab: (t: 'changes' | 'history') => void; changes: number; compact: boolean }) {
  return (
    <div className={`flex shrink-0 rounded-[11px] bg-sunken p-[3px] ${compact ? 'w-[230px]' : 'mx-3 mb-2'}`} role="tablist">
      {(['changes', 'history'] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          onClick={() => onTab(t)}
          className={`flex h-11 flex-1 items-center justify-center gap-1.5 rounded-[9px] text-[14px] font-semibold ${tab === t ? 'bg-elevated text-ink shadow-sm' : 'text-ink-3'}`}
          data-pg-tabbtn={t}
        >
          {t === 'changes' ? 'Changes' : 'History'}
          {t === 'changes' && changes > 0 && <span className={`rounded-full px-1.5 text-[12px] leading-[18px] ${tab === t ? 'bg-accent/25 text-ink' : 'bg-white/10'}`}>{changes}</span>}
        </button>
      ))}
    </div>
  )
}

function folderKey(group: GroupId, path: string): string {
  return `${group}:${path}`
}

export function ChangesTab({ message, setMessage, onCommit }: { message: string; setMessage: (v: string) => void; onCommit: () => void }) {
  const g = useGit()
  const { repo, m, push, openMenu, act, copy, root, openFile, showHistory, showTab } = g
  const state = repo.state
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(() => new Map())
  const scrollRef = useRef<HTMLDivElement>(null)
  const { groups, stashes, neverCommit } = m

  const rows = useMemo(() => {
    const out: Row[] = []
    const pushNodes = (group: GroupId, node: IResourceNode<Item>, counts: Map<string, number>): void => {
      const flat = flattenResourceTree(node, (p) => collapsed.has(folderKey(group, p)), {
        depth: 1,
        pageSize: FOLDER_PAGE,
        shown: (p) => shown.get(folderKey(group, p)) ?? 0
      })
      for (const r of flat) {
        if (r.kind === 'more') out.push({ type: 'more', group, path: r.path, depth: r.depth, remaining: r.remaining ?? 0 })
        else if (r.kind === 'folder') out.push({ type: 'folder', group, path: r.path, label: r.label, depth: r.depth, collapsed: r.collapsed, node: r.node, count: counts.get(r.path) })
        else if (r.node.element) out.push({ type: 'file', group, path: r.path, depth: r.depth, item: r.node.element })
      }
    }
    const section = (id: Exclude<GroupId, 'stashes'>, label: string, count: number, show: boolean): void => {
      if (!show) return
      out.push({ type: 'group', id, label, count })
      if (!collapsed.has(id)) pushNodes(id, groups.trees[id].root, groups.counts[id])
    }
    section('merge', conflictGroupLabel(state?.conflictSides), groups.merge.length, groups.merge.length > 0)
    section('index', 'Staged', groups.index.length, groups.index.length > 0)
    section('workingTree', 'Unstaged', groups.workingTree.length, groups.workingTree.length > 0)
    section('never', 'Env Changes', groups.neverCount, neverCommit.length > 0)
    if (stashes.length > 0) {
      out.push({ type: 'group', id: 'stashes', label: 'Stashes', count: stashes.length })
      if (!collapsed.has('stashes')) for (const stash of stashes) out.push({ type: 'stash', stash, expanded: false })
    }
    return out
  }, [groups, collapsed, shown, stashes, neverCommit, state?.conflictSides])

  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: (i) => HEIGHT[rows[i]?.type ?? 'file'] || 1, overscan: 16 })

  const toggle = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const onStash = (options: { includeUntracked?: boolean; staged?: boolean }, text?: string): void => {
    void act('Stash', () => m.createStash({ ...options, message: text || undefined }))
  }

  const menuFor = (row: MenuRow, x: number, y: number): ActionNode[] =>
    changeMenuNodes({
      targets: [row],
      at: { x, y },
      root,
      onOpenFile: openFile,
      conflictSides: state?.conflictSides,
      onAcceptAll: (paths, type) => void act('Merge', () => m.acceptAll(paths, type)),
      onIgnore: (entries) => void act('Ignore', () => m.ignore(entries)),
      onStage: (paths) => void act('Stage', () => m.stage(paths)),
      onUnstage: (paths) => void act('Unstage', () => m.unstage(paths)),
      onDiscard: (paths, wholeEnv) => void act('Discard', () => m.discard(paths, wholeEnv)),
      isDiscardable: (path) => m.discardable.has(path),
      onNever: (paths) => void act('Env Changes', () => m.addNever(paths)),
      onKeepEnv: (paths) => void act('Env Changes', () => m.keepEnv(paths)),
      onRemoveNever: (paths) => void act('Env Changes', () => m.removeNever(paths)),
      changedUnder: m.changedUnder,
      isStaged: m.isStaged,
      isEnvUnsafe: m.isEnvUnsafe,
      onReveal: () => {},
      onCopy: copy,
      onShowHistory: showHistory
    })

  const stashMenu = (stash: Stash, x: number, y: number): ActionNode[] =>
    stashItemNodes({
      stash,
      onView: () => push({ kind: 'stash', id: `stash:${stash.hash}`, title: stash.description, stash }),
      onApply: () => void act('Stash', () => m.applyStash(stash)),
      onPop: () => void act('Stash', () => m.popStash(stash)),
      onDrop: () => void act('Stash', () => m.dropStash(stash)),
      onCopy: (text) => copy(text, x, y)
    })

  const groupActions = (id: GroupId): { primary?: { label: string; run: () => void }; menu: ActionNode[] } => {
    const paths = (list: Parameters<typeof resourcePath>[0][]): string[] => list.map(resourcePath)
    if (id === 'merge') return { primary: { label: 'Stage All', run: () => void act('Stage', () => m.stage(paths(groups.merge), true)) }, menu: [] }
    if (id === 'index') return { primary: { label: 'Unstage All', run: () => void act('Unstage', () => m.unstage(paths(groups.index))) }, menu: [] }
    if (id === 'workingTree')
      return {
        primary: { label: 'Stage All', run: () => void act('Stage', () => m.stage(paths(groups.workingTree))) },
        menu: [
          { id: 'git.group.discardAll', label: 'Discard All Changes', icon: 'arrow.uturn.backward.circle', destructive: true, run: () => void act('Discard', () => m.discard(paths(groups.workingTree))) },
          { id: 'git.group.stash', label: '', inline: true, children: stashCreateNodes(onStash, 'scm') }
        ]
      }
    if (id === 'never')
      return {
        menu: [{ id: 'git.group.addEnv', label: 'Add a file', icon: 'leaf', input: { title: 'Env Changes', message: 'Commits made here leave these files out.', placeholder: 'path/to/file', submit: 'Add' }, run: (v) => void (v ? act('Env Changes', () => m.addNever([v])) : undefined) }]
      }
    return { menu: stashCreateNodes(onStash, 'repositories') }
  }

  const openRow = (row: Extract<Row, { type: 'file' }>): void => {
    const screen = diffScreenFor(row.group, row.item, state?.indexChanges ?? [])
    if (screen) push(screen)
  }

  const conflictKind = state?.conflictSides?.kind
  const sideNames = state?.conflictSides ?? conflictSideNames('unknown')

  const renderRow = (row: Row): ReactNode => {
    if (row.type === 'group') {
      const a = groupActions(row.id)
      const isCollapsed = collapsed.has(row.id)
      return (
        <div className="flex h-full items-center gap-1 pl-3 pr-1" data-pg-row="group" data-pg-group={row.id}>
          <button type="button" onClick={() => toggle(row.id)} className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={!isCollapsed}>
            <ChevronDown size={16} className={`shrink-0 text-ink-3 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
            <span className="truncate text-[14px] font-semibold text-ink-2">{row.label}</span>
            <span className="shrink-0 rounded-full bg-white/10 px-2 text-[12px] font-semibold leading-[20px] text-ink-2">{row.count}</span>
          </button>
          {a.primary && repo.progress.length === 0 && (
            <button type="button" onClick={a.primary.run} className="h-full shrink-0 px-3 text-[14px] font-semibold text-accent active:opacity-60" data-pg-group-action={a.primary.label}>
              {a.primary.label}
            </button>
          )}
          {a.menu.length > 0 && (
            <button
              type="button"
              aria-label={`${row.label} actions`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                openMenu(a.menu, r.left, r.bottom)
              }}
              className="flex h-11 w-11 shrink-0 items-center justify-center text-ink-2 active:opacity-60"
              data-pg-group-menu={row.id}
            >
              <Ellipsis size={19} />
            </button>
          )}
        </div>
      )
    }
    if (row.type === 'stash') {
      const s = row.stash
      return (
        <div
          role="button"
          className="scm-row pg-press flex h-full select-none items-center gap-3 pl-4 pr-3"
          onClick={() => push({ kind: 'stash', id: `stash:${s.hash}`, title: s.description, stash: s })}
          onContextMenu={(e) => {
            e.preventDefault()
            openMenu(stashMenu(s, e.clientX, e.clientY), e.clientX, e.clientY)
          }}
          data-scm-stash={s.index}
          data-pg-row="stash"
        >
          <Archive size={19} className="shrink-0 text-ink-2" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[15.5px] text-ink">{s.description}</span>
            <span className="truncate text-[12.5px] text-ink-3">
              {[`#${s.index}`, s.branchName, s.commitDate ? relativeTimeShort(s.commitDate) : ''].filter(Boolean).join(' · ')}
            </span>
          </span>
          <ChevronRight size={17} className="shrink-0 text-ink-4" />
        </div>
      )
    }
    if (row.type === 'more') {
      const key = folderKey(row.group, row.path)
      const more = (all: boolean): void =>
        setShown((prev) => new Map(prev).set(key, all ? Number.MAX_SAFE_INTEGER : Math.max(FOLDER_PAGE, prev.get(key) ?? 0) + FOLDER_PAGE))
      return (
        <div className="flex h-full items-center gap-1 text-[14px]" style={{ paddingLeft: 12 + row.depth * INDENT }}>
          <button type="button" onClick={() => more(false)} className="h-full px-3 font-semibold text-accent">
            Show {Math.min(FOLDER_PAGE, row.remaining)} more
          </button>
          <button type="button" onClick={() => more(true)} className="h-full px-3 font-semibold text-accent">
            Show all {row.remaining}
          </button>
        </div>
      )
    }
    if (row.type === 'folder') {
      const pending = m.pendingPaths.size > 0 && collectPaths(row.node).some((p) => m.pendingPaths.has(p))
      return (
        <div
          role="button"
          className={`scm-row pg-press flex h-full select-none items-center gap-2 pr-3 ${pending ? 'opacity-60' : ''}`}
          style={{ paddingLeft: 8 + (row.depth - 1) * INDENT }}
          onClick={() => toggle(folderKey(row.group, row.path))}
          onContextMenu={(e) => {
            e.preventDefault()
            openMenu(menuFor(row, e.clientX, e.clientY), e.clientX, e.clientY)
          }}
          data-pg-row="folder"
          data-pg-group={row.group}
          data-pg-path={row.path}
        >
          <ChevronDown size={15} className={`shrink-0 text-ink-3 transition-transform ${row.collapsed ? '-rotate-90' : ''}`} />
          <FileGlyph name={baseName(row.path)} dir />
          <span className="min-w-0 flex-1 truncate text-[15px] text-ink-2">{row.label}</span>
          {pending ? <Spinner /> : row.count !== undefined && <span className="shrink-0 text-[13px] text-ink-4">{row.count}</span>}
        </div>
      )
    }
    if (row.type === 'file') {
      const { change, entry, residual } = row.item
      const name = baseName(row.path)
      const pending = m.pendingPaths.has(row.path)
      const env = row.group === 'never'
      const note =
        row.group === 'workingTree' && residual
          ? residual.conflict
            ? 'Env file, overlaps your env edits'
            : 'Env file, new lines only'
          : row.group === 'index' && entry
            ? m.envUnsafe.has(row.path)
              ? 'Staged with env edits, unstage it first'
              : 'Env file, staged without env edits'
            : row.group === 'merge' && change
              ? getStatusText(change.status).replace(/^Conflict: /, 'Conflict, ').toLowerCase().replace(/^conflict/, 'Conflict')
              : env && !change
                ? 'No changes right now'
                : ''
      const warn = (row.group === 'workingTree' && residual?.conflict) || (row.group === 'index' && !!entry && m.envUnsafe.has(row.path)) || row.group === 'merge'
      return (
        <div
          role="button"
          className={`scm-row pg-press flex h-full select-none items-center gap-2.5 pr-3 ${pending ? 'opacity-60' : ''}`}
          style={{ paddingLeft: 12 + (row.depth - 1) * INDENT }}
          onClick={() => (change ? openRow(row) : undefined)}
          onContextMenu={(e) => {
            e.preventDefault()
            openMenu(menuFor(row, e.clientX, e.clientY), e.clientX, e.clientY)
          }}
          data-pg-row="file"
          data-pg-group={row.group}
          data-pg-path={row.path}
        >
          <FileGlyph name={name} dim={env} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={`truncate text-[16px] leading-tight ${env ? 'text-ink-2' : 'text-ink'} ${change && getStrikeThrough(change.status) ? 'line-through decoration-ink-3' : ''}`}>{name}</span>
            {note && (
              <span className={`mt-0.5 flex items-center gap-1 truncate text-[12.5px] leading-tight ${warn ? 'text-warn' : 'text-ink-3'}`}>
                {(residual || entry) && (warn ? <EnvWarningIcon size={12} /> : <EnvFileIcon size={12} />)}
                {note}
              </span>
            )}
          </span>
          {pending ? <Spinner /> : change ? <StatusBadge status={change.status} /> : null}
        </div>
      )
    }
    return null
  }

  const merging = m.continuing
  const nothing = rows.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col" data-pg-tab="changes" data-scm-changes>
      {repo.loadError && state && (
        <Banner tone="err" action={{ label: 'Try again', run: () => void repo.refresh() }} data="load-error">
          {repo.loadError.message}
        </Banner>
      )}
      {state?.isRepositoryHuge && <Banner tone="warn" data="huge">{`This repository has too many changes. Only the first ${state.isRepositoryHuge.limit} are shown.`}</Banner>}
      {merging && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-[12px] border border-warn/30 bg-warn/10 py-1.5 pl-3 pr-1.5" data-pg-merging={m.rebasing ? 'rebase' : conflictKind ?? 'merge'}>
          <span className="min-w-0 flex-1 text-[14px] leading-snug text-ink">
            {m.rebasing ? `Rebasing ${m.branchLabel}` : state?.conflictSides ? `Merging ${sideNames.incoming} into ${sideNames.current}` : `Finishing a merge into ${m.branchLabel}`}
            <span className="block text-[12.5px] text-ink-3">{groups.merge.length ? `${plural(groups.merge.length, 'conflict')} left to resolve` : 'No conflicts left. Commit to finish.'}</span>
          </span>
          <button
            type="button"
            onClick={() =>
              void requestConfirm({
                title: m.rebasing ? 'Abort Rebase' : 'Abort Merge',
                message: m.rebasing ? 'Stop the rebase and put the branch back the way it was?' : 'Stop the merge and undo what it changed so far?',
                confirmLabel: 'Abort'
              }).then((ok) => (ok ? act('Abort', () => (m.rebasing ? m.abortRebase() : m.abortMerge())) : false))
            }
            className="h-11 shrink-0 rounded-[10px] bg-white/10 px-3 text-[14px] font-semibold text-err active:opacity-60"
            data-pg-button="Abort"
          >
            Abort
          </button>
        </div>
      )}
      <div ref={scrollRef} className="pg-scroll overflow-auto min-h-0 flex-1" data-pg-changes-list>
        {nothing ? (
          <StateView icon={<CircleCheck size={30} strokeWidth={1.75} />} title="No changes" body={m.branchLabel ? `Everything on ${m.branchLabel} is committed.` : 'Everything is committed.'} data="clean">
            <PillButton label="See History" onClick={() => showTab('history')} />
          </StateView>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index]
              return (
                <div key={v.key} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: HEIGHT[row.type], transform: `translateY(${v.start}px)` }} className={row.type === 'group' && v.index > 0 ? 'border-t border-hairline' : ''}>
                  {renderRow(row)}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {(m.stagedCount > 0 || m.continuing) && <CommitBar message={message} setMessage={setMessage} onCommit={onCommit} />}
    </div>
  )
}

function CommitBar({ message, setMessage, onCommit }: { message: string; setMessage: (v: string) => void; onCommit: () => void }) {
  const { repo, m } = useGit()
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '44px'
    if (message) el.style.height = `${Math.min(140, Math.max(44, el.scrollHeight))}px`
  }, [message])
  const label = m.continuing ? 'Continue' : 'Commit'
  const placeholder = m.continuing && m.unresolvedConflicts ? 'Resolve the conflicts first' : 'Commit message'
  return (
    <div className="shrink-0 border-t border-hairline bg-canvas px-3 py-2" data-pg-commit>
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={placeholder}
          rows={1}
          className="min-h-[44px] min-w-0 flex-1 resize-none rounded-[12px] border border-hairline bg-sunken px-3 py-[10px] leading-[22px] text-ink outline-none placeholder:text-ink-4 focus:border-accent/60"
          style={{ fontSize: 16 }}
          data-pg-commit-message
        />
        <button
          type="button"
          disabled={!m.canCommit(message)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCommit}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-[12px] bg-accent px-4 text-[15px] font-semibold text-accent-fg active:opacity-70 disabled:opacity-40"
          data-pg-commit-button
        >
          {repo.busy === 'Commit' ? <Spinner size={16} className="text-accent-fg" /> : <Check size={17} strokeWidth={2.6} />}
          {label}
        </button>
      </div>
    </div>
  )
}

