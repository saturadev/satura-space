import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, Copy } from 'lucide-react'
import { Status, matchNeverCommit, type Change, type ScmDiffStat, type ScmGitError } from '@shared/git-scm'
import { ScmDiffEditor } from '../../components/git/ScmDiffEditor'
import { usePanelActions, type ActionNode } from '../../lib/actions/action-tree'
import { getHistoryChangeDiffSides, getStrikeThrough, joinPath, resourcePath } from '../../lib/git/scm-resource'
import { ResourceTree, flattenResourceTree } from '../../lib/git/resource-tree'
import { historyItemHoverAdditionsForeground, historyItemHoverDeletionsForeground, type ISCMHistoryItem } from '../../lib/git/scm-history'
import { toHistoryItem } from '../../lib/git/history-provider'
import { openFileInWorkbench } from '../../lib/editor/open-file'
import { CommitType } from '../../lib/editor/merge-conflict/accept-all'
import { relativeTimeLong } from '../../lib/relative-time'
import { plural, stashItemNodes } from '../../components/git/use-scm-changes'
import { diffScreenFor } from './changes'
import { RefChip, isSynthetic, messageEntry } from './history'
import { FileGlyph, PillButton, Spinner, StateView, StatusBadge, baseName, dirName, useGit, type Screen } from './ui'

const SMALL_COMMIT = 100
const FOLDER_PAGE = 50

function sideLabel(screen: Extract<Screen, { kind: 'diff' }>): string {
  const g = screen.group
  if (g === 'index') return 'Staged'
  if (g === 'workingTree') return screen.sides.title.endsWith('(New Changes Only)') ? 'New lines, env edits left out' : 'Unstaged'
  if (g === 'merge') return screen.sides.original?.ref === ':2' ? 'Conflict, against the current side' : 'Conflict'
  if (g === 'never') return 'Env change'
  const m = /\(([^)]*)\)$/.exec(screen.sides.title)
  return m ? m[1] : ''
}

export function DiffScreen({ screen, top }: { screen: Extract<Screen, { kind: 'diff' }>; top: boolean }) {
  const { root, repo, m, settings, onSettings, version, scope, openFile, replace, close, act, showHistory } = useGit()
  const state = repo.state
  const path = screen.path
  const group = screen.group

  useEffect(() => {
    if (!group || group === 'never' || !state) return
    const lists: Record<'merge' | 'index' | 'workingTree', Change[]> = { merge: m.groups.merge, index: m.groups.index, workingTree: m.groups.workingTree }
    if (lists[group as 'merge' | 'index' | 'workingTree']?.some((c) => resourcePath(c) === path)) return
    const order: ('merge' | 'index' | 'workingTree')[] = group === 'workingTree' ? ['index', 'merge'] : group === 'index' ? ['workingTree', 'merge'] : ['index', 'workingTree']
    for (const g of order) {
      const change = lists[g].find((c) => resourcePath(c) === path)
      if (!change) continue
      const residual = g === 'workingTree' ? state.envResidual.find((r) => r.path === path) : undefined
      const next = diffScreenFor(g, { change, residual, entry: matchNeverCommit(path, state.neverCommit) }, state.indexChanges)
      if (next) {
        console.info(`[git] ${path} moved from ${group} to ${g}, the diff follows it`)
        replace(screen.id, next)
        return
      }
    }
    console.info(`[git] ${path} has no changes left, closing its diff`)
    close(screen.id)
  }, [state])

  const both = group === 'merge' && !!screen.status && (screen.status === Status.BOTH_MODIFIED || screen.status === Status.BOTH_ADDED)
  const sides = state?.conflictSides
  const untracked = screen.status === Status.UNTRACKED
  const fileNodes: ActionNode[] = [
    group === 'workingTree' && { id: 'git.diff.stage', label: 'Stage File', icon: 'plus', run: () => act('Stage', () => m.stage([path])) },
    group === 'workingTree' && { id: 'git.diff.discard', label: untracked ? 'Move to Trash' : 'Discard File', icon: untracked ? 'trash' : 'arrow.uturn.backward', destructive: true, run: () => act('Discard', () => m.discard([path])) },
    group === 'index' && { id: 'git.diff.unstage', label: 'Unstage File', icon: 'minus', run: () => act('Unstage', () => m.unstage([path])) },
    !!group && { id: 'git.diff.history', label: 'Show File History', icon: 'clock.arrow.circlepath', run: () => showHistory([path]) }
  ].filter(Boolean) as ActionNode[]
  usePanelActions(top ? scope : null, fileNodes.length ? [{ id: 'git.diff.file', label: '', inline: true, children: fileNodes }] : [])

  let footer: ReactNode = null
  if (group === 'workingTree')
    footer = (
      <>
        <PillButton label={untracked ? 'Move to Trash' : screen.sides.title.endsWith('(New Changes Only)') ? 'Discard New Lines' : 'Discard'} tone="danger" onClick={() => void act('Discard', () => m.discard([path]))} />
        <PillButton label="Stage File" tone="accent" onClick={() => void act('Stage', () => m.stage([path]))} busy={m.pendingPaths.has(path)} />
      </>
    )
  else if (group === 'index') footer = <PillButton label="Unstage File" onClick={() => void act('Unstage', () => m.unstage([path]))} busy={m.pendingPaths.has(path)} />
  else if (group === 'never') {
    const entry = state ? matchNeverCommit(path, state.neverCommit) : undefined
    footer = (
      <>
        {m.discardable.has(path) && <PillButton label="Discard" tone="danger" onClick={() => void act('Discard', () => m.discard([], [path]))} />}
        {entry && <PillButton label="Remove from Env Changes" onClick={() => void act('Env Changes', () => m.removeNever([entry]))} />}
      </>
    )
  } else if (group === 'merge')
    footer = both ? (
      <>
        <PillButton label="Keep Current" onClick={() => void act('Merge', () => m.acceptAll([path], CommitType.Current))} data="Accept current" />
        <PillButton label="Keep Incoming" onClick={() => void act('Merge', () => m.acceptAll([path], CommitType.Incoming))} data="Accept incoming" />
        <span className="-my-1 basis-full" />
        <PillButton label="Mark Resolved" tone="accent" onClick={() => void act('Stage', () => m.stage([path]))} busy={m.pendingPaths.has(path)} data="Mark resolved" />
      </>
    ) : (
      <PillButton label="Mark Resolved" tone="accent" onClick={() => void act('Stage', () => m.stage([path]))} busy={m.pendingPaths.has(path)} />
    )

  return (
    <div className="flex h-full min-h-0 flex-col" data-pg-screen="diff" data-pg-diff={path} data-pg-diff-group={group ?? 'history'}>
      <div className="flex shrink-0 items-center gap-2.5 border-b border-hairline px-3 py-2">
        <FileGlyph name={baseName(path)} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-ink">{baseName(path)}</div>
          <div className="truncate text-[12.5px] text-ink-3">{[dirName(path) || 'Project root', sideLabel(screen)].filter(Boolean).join(' · ')}</div>
        </div>
        {screen.status !== undefined && <StatusBadge status={screen.status} />}
      </div>
      {group === 'merge' && both && sides && (
        <div className="shrink-0 border-b border-hairline px-3 py-1.5 text-[12.5px] leading-snug text-ink-3" data-pg-conflict-help>
          Current is {sides.current}, incoming is {sides.incoming}. Keep one side for all conflicts here, or open the file to choose conflict by conflict.
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <ScmDiffEditor
          root={root}
          repo={repo}
          request={{ key: screen.id, sides: screen.sides }}
          version={version}
          settings={settings}
          onSettings={onSettings}
          onOpenFile={openFile}
          actionScope={top ? scope : undefined}
          phone
        />
      </div>
      {footer && (
        <div className="flex shrink-0 flex-wrap gap-2 border-t border-hairline px-3 py-2 [&>button]:flex-1" data-pg-diff-actions>
          {footer}
        </div>
      )}
    </div>
  )
}

interface FileSet {
  readonly loading: boolean
  readonly changes: Change[]
  readonly error?: ScmGitError
  readonly stats: ReadonlyMap<string, ScmDiffStat>
}

const EMPTY: FileSet = { loading: true, changes: [], stats: new Map() }

function useFileSet(load: (() => Promise<{ ok: true; value: Change[] } | { ok: false; error: ScmGitError }>) | null, stats: ((paths: string[]) => Promise<{ ok: true; value: ScmDiffStat[] } | { ok: false; error: ScmGitError }>) | null, key: string): [FileSet, () => void] {
  const [set, setSet] = useState<FileSet>(EMPTY)
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!load) return
    let alive = true
    setSet(EMPTY)
    void load().then((r) => {
      if (!alive) return
      if (!r.ok) {
        setSet({ loading: false, changes: [], error: r.error, stats: new Map() })
        return
      }
      setSet({ loading: false, changes: r.value, stats: new Map() })
      if (stats && r.value.length <= SMALL_COMMIT) setCount((c) => c + 1)
    })
    return () => {
      alive = false
    }
  }, [key])
  useEffect(() => {
    if (!count || !stats || set.loading || !set.changes.length) return
    let alive = true
    void stats(set.changes.map((c) => c.path)).then((r) => {
      if (!alive || !r.ok) return
      setSet((prev) => ({ ...prev, stats: new Map(r.value.map((s) => [s.path, s])) }))
    })
    return () => {
      alive = false
    }
  }, [count])
  return [set, () => setCount((c) => c + 1)]
}

function FileTree({ set, onOpen, onCountAll }: { set: FileSet; onOpen: (change: Change) => void; onCountAll?: () => void }) {
  const { openMenu, copy, root, showHistory } = useGit()
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(() => new Map())
  const tree = useMemo(() => {
    const t = new ResourceTree<Change>()
    for (const c of set.changes) t.add(c.renamePath ?? c.path, c)
    return t
  }, [set.changes])
  const big = set.changes.length > 300
  const rows = flattenResourceTree(tree.root, (p) => (big ? !collapsed.has(p) : collapsed.has(p)), { pageSize: FOLDER_PAGE, shown: (p) => shown.get(p) ?? 0 })
  let insertions = 0
  let deletions = 0
  for (const s of set.stats.values()) {
    insertions += s.insertions
    deletions += s.deletions
  }
  const partial = set.stats.size > 0 && set.stats.size < set.changes.length
  const fileMenu = (change: Change, x: number, y: number): void => {
    const p = change.renamePath ?? change.path
    openMenu(
      [
        change.status !== Status.DELETED && change.status !== Status.INDEX_DELETED && { id: 'git.file.open', label: 'Open File', icon: 'doc.text', run: () => openFileInWorkbench({ file: joinPath(root, p), preview: false }) },
        { id: 'git.file.history', label: 'Show File History', icon: 'clock.arrow.circlepath', run: () => showHistory([p]) },
        { id: 'git.file.copyPath', label: 'Copy Path', icon: 'doc.on.doc', run: (_v?: string, at?: { x: number; y: number }) => copy(joinPath(root, p), at?.x ?? x, at?.y ?? y) },
        { id: 'git.file.copyRelPath', label: 'Copy Relative Path', icon: 'doc.on.clipboard', run: (_v?: string, at?: { x: number; y: number }) => copy(p, at?.x ?? x, at?.y ?? y) }
      ].filter(Boolean) as ActionNode[],
      x,
      y
    )
  }
  if (set.loading)
    return (
      <div className="flex items-center gap-2 px-4 py-4 text-[14px] text-ink-3">
        <Spinner /> Loading files
      </div>
    )
  if (set.error) return <div className="px-4 py-4 text-[14px] text-err">{set.error.message}</div>
  if (!set.changes.length) return <div className="px-4 py-4 text-[14px] text-ink-3">No file changes</div>
  return (
    <div data-pg-files={set.changes.length}>
      <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-[13px] font-semibold text-ink-2">
        <span>{plural(set.changes.length, 'file')}</span>
        {set.stats.size > 0 && (
          <span className="tabular-nums">
            <span style={{ color: historyItemHoverAdditionsForeground }}>+{insertions}{partial ? '+' : ''}</span> <span style={{ color: historyItemHoverDeletionsForeground }}>−{deletions}{partial ? '+' : ''}</span>
          </span>
        )}
        {set.stats.size === 0 && onCountAll && (
          <button type="button" onClick={onCountAll} className="-my-2 ml-auto h-11 px-2 text-[13px] font-semibold text-accent">
            Count lines
          </button>
        )}
      </div>
      {rows.map((r) => {
        if (r.kind === 'more')
          return (
            <button key={`more:${r.path}`} type="button" className="flex h-11 items-center px-4 text-[14px] font-semibold text-accent" style={{ paddingLeft: 16 + r.depth * 14 }} onClick={() => setShown((prev) => new Map(prev).set(r.path, Math.max(FOLDER_PAGE, prev.get(r.path) ?? 0) + FOLDER_PAGE))}>
              Show {Math.min(FOLDER_PAGE, r.remaining ?? 0)} more
            </button>
          )
        if (r.kind === 'folder')
          return (
            <div
              key={`d:${r.path}`}
              role="button"
              className="pg-press flex h-[46px] select-none items-center gap-2 pr-3"
              style={{ paddingLeft: 8 + r.depth * 14 }}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(r.path)) next.delete(r.path)
                  else next.add(r.path)
                  return next
                })
              }
              data-pg-row="folder"
              data-pg-path={r.path}
            >
              <ChevronDown size={15} className={`shrink-0 text-ink-3 transition-transform ${r.collapsed ? '-rotate-90' : ''}`} />
              <FileGlyph name={baseName(r.path)} dir />
              <span className="min-w-0 flex-1 truncate text-[15px] text-ink-2">{r.label}</span>
            </div>
          )
        const change = r.node.element
        if (!change) return null
        const stat = set.stats.get(change.path)
        const name = baseName(change.renamePath ?? change.path)
        return (
          <div
            key={`f:${r.path}`}
            role="button"
            className="pg-press flex h-[50px] select-none items-center gap-2.5 pr-3"
            style={{ paddingLeft: 12 + r.depth * 14 }}
            onClick={() => onOpen(change)}
            onContextMenu={(e) => {
              e.preventDefault()
              fileMenu(change, e.clientX, e.clientY)
            }}
            data-ctx-menu
            data-pg-row="file"
            data-pg-path={change.renamePath ?? change.path}
          >
            <FileGlyph name={name} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={`truncate text-[16px] leading-tight text-ink ${getStrikeThrough(change.status) ? 'line-through decoration-ink-3' : ''}`}>{name}</span>
              {change.renamePath && change.renamePath !== change.path && <span className="mt-0.5 truncate text-[12.5px] text-ink-3">from {change.path}</span>}
            </span>
            {stat && (
              <span className="shrink-0 text-[12.5px] tabular-nums">
                {stat.binary ? (
                  <span className="text-ink-3">binary</span>
                ) : (
                  <>
                    <span style={{ color: historyItemHoverAdditionsForeground }}>+{stat.insertions}</span> <span style={{ color: historyItemHoverDeletionsForeground }}>−{stat.deletions}</span>
                  </>
                )}
              </span>
            )}
            <StatusBadge status={change.status} />
          </div>
        )
      })}
    </div>
  )
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[40px] items-center gap-3 border-t border-hairline px-4 py-1.5 first:border-t-0">
      <span className="w-[64px] shrink-0 text-[13px] text-ink-3">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-[14px] text-ink">{children}</div>
    </div>
  )
}

export function CommitScreen({ screen, top }: { screen: Extract<Screen, { kind: 'commit' }>; top: boolean }) {
  const { root, repo, history, push, copy, scope } = useGit()
  const api = repo.api
  const [item, setItem] = useState<ISCMHistoryItem | null>(screen.vm?.historyItem ?? null)
  const [failed, setFailed] = useState<string | null>(null)
  const [range, setRange] = useState<{ ref: string; parentRef?: string } | undefined>(() => (screen.vm ? history.resolveRange(screen.vm) : undefined))
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (screen.vm) return
    let alive = true
    setFailed(null)
    void api.getCommit(root, screen.hash).then((r) => {
      if (!alive) return
      if (!r.ok) {
        setFailed(r.error.message)
        return
      }
      setItem(toHistoryItem(r.value))
      setRange({ ref: r.value.hash, parentRef: r.value.parents[0] })
    })
    return () => {
      alive = false
    }
  }, [screen.hash, tick])
  const [set, countAll] = useFileSet(
    range ? () => api.diffBetween(root, range.parentRef, range.ref) : null,
    range ? (paths) => api.diffStats(root, range.parentRef, range.ref, paths) : null,
    range ? `${range.parentRef}..${range.ref}` : ''
  )
  usePanelActions(top && item && !isSynthetic(item) ? scope : null, item && !isSynthetic(item) ? [
    { id: 'git.commit.section', label: '', inline: true, children: [
      { id: 'git.commit.copyHash', label: 'Copy Hash', icon: 'doc.on.doc', run: (_v?: string, at?: { x: number; y: number }) => copy(item.id, at?.x ?? 0, at?.y ?? 0) },
      { id: 'git.commit.copyMessage', label: 'Copy Message', icon: 'doc.on.clipboard', run: (_v?: string, at?: { x: number; y: number }) => copy(messageEntry(item), at?.x ?? 0, at?.y ?? 0) }
    ] }
  ] : [])
  if (failed)
    return (
      <StateView title="Couldn't load this commit" body={failed} data="commit-error">
        <PillButton label="Try again" onClick={() => setTick((t) => t + 1)} />
      </StateView>
    )
  if (!item) return <StateView icon={<Spinner size={22} />} title="Loading commit" data="commit-loading" />
  const synthetic = isSynthetic(item)
  const body = item.message.trim().split('\n').slice(1).join('\n').trim()
  const parents = item.parentIds.filter((id) => /^[0-9a-f]{7,}$/i.test(id))
  const open = (change: Change): void => {
    if (!range) return
    const sides = getHistoryChangeDiffSides(change, range.parentRef, range.ref)
    const p = change.renamePath ?? change.path
    push({ kind: 'diff', id: `diff:${range.ref}:${p}`, title: baseName(p), path: p, sides, status: change.status })
  }
  return (
    <div className="pg-scroll h-full overflow-auto pb-6" data-pg-screen="commit" data-pg-commit-hash={item.id}>
      <div className="px-4 pb-3 pt-3">
        <div className="whitespace-pre-wrap break-words text-[18px] font-semibold leading-snug text-ink" data-pg-subject>
          {item.subject}
        </div>
        {body && <div className="mt-2 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink-2">{body}</div>}
        {!!item.references?.length && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {item.references.map((r) => (
              <RefChip key={r.id} r={r} />
            ))}
          </div>
        )}
      </div>
      {!synthetic && (
        <div className="mx-3 overflow-hidden rounded-[12px] bg-panel">
          {item.author && (
            <MetaRow label="Author">
              <span className="truncate">{item.author}</span>
              {item.authorEmail && <span className="truncate text-ink-3">{item.authorEmail}</span>}
            </MetaRow>
          )}
          {item.timestamp && (
            <MetaRow label="Date">
              <span>{new Date(item.timestamp).toLocaleString()}</span>
              <span className="text-ink-3">{relativeTimeLong(item.timestamp)}</span>
            </MetaRow>
          )}
          <MetaRow label="Commit">
            <button type="button" onClick={(e) => copy(item.id, e.clientX, e.clientY)} className="flex h-11 items-center gap-1.5 rounded-[8px] bg-white/[0.06] px-3 font-mono text-[13px] text-ink active:opacity-60" data-pg-copy-hash>
              {item.displayId}
              <Copy size={13} className="text-ink-3" />
            </button>
          </MetaRow>
          {parents.length > 0 && (
            <MetaRow label={parents.length === 1 ? 'Parent' : 'Parents'}>
              {parents.map((id) => (
                <button key={id} type="button" onClick={() => push({ kind: 'commit', id: `commit:${id}`, title: id.substring(0, 7), hash: id })} className="flex h-11 items-center rounded-[8px] bg-white/[0.06] px-3 font-mono text-[13px] text-accent active:opacity-60" data-pg-parent={id.substring(0, 7)}>
                  {id.substring(0, 7)}
                </button>
              ))}
            </MetaRow>
          )}
        </div>
      )}
      {range ? <FileTree set={set} onOpen={open} onCountAll={countAll} /> : synthetic ? <div className="px-4 py-4 text-[14px] text-ink-3">Fetch to see what changed</div> : null}
    </div>
  )
}

export function CompareScreen({ screen }: { screen: Extract<Screen, { kind: 'compare' }> }) {
  const { root, repo, push } = useGit()
  const api = repo.api
  const { base, target } = screen
  const [set, countAll] = useFileSet(
    () => api.compareCommits(root, base.id, target.id),
    (paths) => api.compareCommitsStats(root, base.id, target.id, paths),
    `${base.id}..${target.id}`
  )
  return (
    <div className="pg-scroll h-full overflow-auto pb-6" data-pg-screen="compare">
      {[base, target].map((c, i) => (
        <div key={c.id} className={`mx-3 mb-1.5 rounded-[12px] bg-panel px-3 py-2 ${i === 0 ? 'mt-3' : ''}`}>
          <div className="flex items-center gap-2">
            <span className="w-9 shrink-0 text-[12.5px] font-semibold uppercase text-ink-3">{i === 0 ? 'From' : 'To'}</span>
            <span className="font-mono text-[13px] text-accent">{c.displayId}</span>
            <span className="truncate text-[12.5px] text-ink-3">{[c.author, c.timestamp ? relativeTimeLong(c.timestamp) : ''].filter(Boolean).join(' · ')}</span>
          </div>
          <div className="mt-0.5 truncate pl-11 text-[15px] text-ink">{c.subject}</div>
        </div>
      ))}
      <FileTree
        set={set}
        onCountAll={countAll}
        onOpen={(change) => {
          const p = change.renamePath ?? change.path
          push({ kind: 'diff', id: `diff:${base.id}..${target.id}:${p}`, title: baseName(p), path: p, sides: getHistoryChangeDiffSides(change, base.id, target.id), status: change.status })
        }}
      />
    </div>
  )
}

export function StashScreen({ screen, top }: { screen: Extract<Screen, { kind: 'stash' }>; top: boolean }) {
  const { root, repo, m, push, close, act, copy, scope } = useGit()
  const api = repo.api
  const stash = m.stashes.find((s) => s.hash === screen.stash.hash)
  const [details, setDetails] = useState<{ changes: Change[]; untracked: Set<string> } | { error: string } | null>(null)
  useEffect(() => {
    if (repo.state && !stash) {
      console.info(`[git] stash ${screen.stash.description} is gone, closing it`)
      close(screen.id)
    }
  }, [repo.state, stash])
  useEffect(() => {
    if (!stash) return
    let alive = true
    void api.stashShow(root, stash.index).then((r) => {
      if (!alive) return
      setDetails(r.ok ? { changes: r.value.changes, untracked: new Set(r.value.untracked) } : { error: r.error.message })
    })
    return () => {
      alive = false
    }
  }, [stash?.hash, stash?.index])
  const s = stash ?? screen.stash
  const nodes = stashItemNodes({
    stash: s,
    onView: () => {},
    onApply: () => void act('Stash', () => m.applyStash(s)),
    onPop: () => void act('Stash', () => m.popStash(s)),
    onDrop: () => void act('Stash', () => m.dropStash(s)),
    onCopy: copy
  }).filter((n) => n.id !== 'show')
  usePanelActions(top ? scope : null, nodes)
  const set: FileSet = !details
    ? EMPTY
    : 'error' in details
      ? { loading: false, changes: [], error: { message: details.error }, stats: new Map() }
      : { loading: false, changes: details.changes, stats: new Map() }
  const open = (change: Change): void => {
    const path = resourcePath(change)
    const untracked = !!details && !('error' in details) && details.untracked.has(path)
    const parent = s.parents.length > 0 ? s.parents[0] : `${s.hash}^`
    const ref = untracked ? (s.parents.length === 3 ? s.parents[2] : s.hash) : s.hash
    push({ kind: 'diff', id: `diff:stash:${s.hash}:${path}`, title: baseName(path), path, sides: getHistoryChangeDiffSides(change, parent, ref), status: change.status })
  }
  return (
    <div className="pg-scroll h-full overflow-auto pb-6" data-pg-screen="stash">
      <div className="px-4 pb-3 pt-3">
        <div className="break-words text-[18px] font-semibold leading-snug text-ink">{s.description}</div>
        <div className="mt-1 text-[13px] text-ink-3">{[`Stash #${s.index}`, s.branchName ? `on ${s.branchName}` : '', s.commitDate ? relativeTimeLong(s.commitDate) : ''].filter(Boolean).join(' · ')}</div>
      </div>
      <div className="flex gap-2 px-3 pb-2 [&>*]:flex-1" data-pg-stash-actions>
        <PillButton label="Restore and Remove" tone="accent" busy={repo.busy === 'Stash'} onClick={() => void act('Stash', () => m.popStash(s))} />
        <PillButton label="Keep a Copy" disabled={repo.busy !== null} onClick={() => void act('Stash', () => m.applyStash(s))} data="Restore, keep a copy" />
      </div>
      <div className="px-3 pb-1">
        <button type="button" disabled={repo.busy !== null} onClick={() => void act('Stash', () => m.dropStash(s))} className="h-11 w-full rounded-[12px] text-[15px] font-semibold text-err active:bg-white/[0.06] disabled:opacity-40" data-pg-button="Delete stash">
          Delete Stash
        </button>
      </div>
      <FileTree set={set} onOpen={open} />
    </div>
  )
}
