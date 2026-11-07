import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderGit2, LoaderCircle } from 'lucide-react'
import type { ScmStashOptions, Stash } from '@shared/git-scm'
import { useScmRepository } from '../../components/git/use-scm-repository'
import { useScmSettings } from '../../components/git/use-scm-settings'
import { moreActionNodes, useScmChanges, useScmCommitMessage, type StashPick } from '../../components/git/use-scm-changes'
import { ActionMenu } from '../../lib/actions/ActionMenu'
import { usePanelActions, type ActionNode } from '../../lib/actions/action-tree'
import { useMobileBack } from '../../lib/mobile/mobile-back'
import { useGitCommitRequests, useGitHistoryRequests } from '../../lib/git/history-request'
import { noteViewMounted, noteViewUnmounted } from '../../lib/view-host-registry'
import { joinPath } from '../../lib/git/scm-resource'
import type { ISCMHistoryItem, ISCMHistoryItemViewModel } from '../../lib/git/scm-history'
import { postToShell } from '../shell-bus'
import { BranchBar, ChangesTab, Tabs } from './changes'
import { HistoryTab, isSynthetic, useHistory } from './history'
import { CommitScreen, CompareScreen, DiffScreen, StashScreen } from './screens'
import { Banner, GitContext, PillButton, StateView, baseName, useLandscape, type GitCtx, type Screen } from './ui'
import './git.css'

type Tab = 'changes' | 'history'

function ScreenHost({ screen, top, depth, onBack }: { screen: Screen; top: boolean; depth: number; onBack: () => void }) {
  useMobileBack(onBack, screen.title)
  return (
    <div className="absolute inset-0 bg-canvas" style={{ display: top ? undefined : 'none', zIndex: 10 + depth }} data-pg-layer={screen.kind}>
      {screen.kind === 'diff' ? (
        <DiffScreen screen={screen} top={top} />
      ) : screen.kind === 'commit' ? (
        <CommitScreen screen={screen} top={top} />
      ) : screen.kind === 'compare' ? (
        <CompareScreen screen={screen} />
      ) : (
        <StashScreen screen={screen} top={top} />
      )}
    </div>
  )
}

function HistoryBack({ onBack }: { onBack: () => void }) {
  useMobileBack(onBack, 'History')
  return null
}

function useCopy(): (text: string, x: number, y: number) => void {
  return useCallback((text: string) => {
    console.info(`[git] copy ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`)
    void navigator.clipboard.writeText(text).catch(() => {})
  }, [])
}

export function PhoneGit({ rootPath, projectPath, scope, onOpenFile }: { rootPath: string; projectPath: string; scope: string; onOpenFile: (file: string) => void }) {
  const viewId = `phone:${scope}`
  useEffect(() => {
    noteViewMounted(viewId)
    return () => noteViewUnmounted(viewId)
  }, [viewId])
  const repo = useScmRepository(rootPath, true)
  const [settings, onSettings] = useScmSettings(rootPath)
  const m = useScmChanges(repo, settings, onSettings)
  const [message, setMessage] = useScmCommitMessage(repo.state)
  const [tab, setTab] = useState<Tab>('changes')
  const [seenHistory, setSeenHistory] = useState(false)
  const [paths, setPaths] = useState<string[] | null>(null)
  const [stack, setStack] = useState<Screen[]>([])
  const [version, setVersion] = useState(0)
  const [menu, setMenu] = useState<{ seq: number; x: number; y: number; nodes: ActionNode[] } | null>(null)
  const [comparing, setComparing] = useState<ISCMHistoryItem | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const landscape = useLandscape(rootRef)
  const retry = useRef<{ label: string; run: () => void } | null>(null)
  const copy = useCopy()
  const history = useHistory(repo, seenHistory, settings.graphFilter, paths)

  useEffect(() => setVersion((v) => v + 1), [repo.state])
  useEffect(() => {
    if (tab === 'history') setSeenHistory(true)
  }, [tab])
  useEffect(() => {
    console.info(`[git] phone view on ${rootPath}`)
  }, [rootPath])

  const push = useCallback((screen: Screen) => {
    console.info(`[git] open ${screen.kind} ${screen.title}`)
    setStack((prev) => [...prev.filter((s) => s.id !== screen.id), screen])
  }, [])
  const replace = useCallback((id: string, screen: Screen) => setStack((prev) => prev.map((s) => (s.id === id ? screen : s))), [])
  const close = useCallback((id: string) => setStack((prev) => prev.filter((s) => s.id !== id)), [])
  const openMenu = useCallback((nodes: ActionNode[], x: number, y: number) => {
    if (!nodes.length) return
    setMenu((prev) => ({ seq: (prev?.seq ?? 0) + 1, x, y, nodes }))
  }, [])
  const act = useCallback(async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
    console.info(`[git] ${label}`)
    retry.current = { label, run: () => void act(label, fn) }
    let ok = false
    try {
      ok = (await fn()) !== false
    } catch (e) {
      console.warn(`[git] ${label} threw: ${(e as Error)?.message ?? e}`)
    }
    if (ok) console.info(`[git] ${label} done`)
    else console.warn(`[git] ${label} did not finish`)
    if (ok) postToShell({ type: 'haptic', kind: 'success' })
    return ok
  }, [])
  const showHistory = useCallback((p: string[]) => {
    setStack([])
    setComparing(null)
    setPaths(p.length ? p : null)
    setTab('history')
    if (p.length) console.info(`[git] history of ${p.join(', ')}`)
  }, [])
  const openFile = useCallback((rel: string) => onOpenFile(joinPath(rootPath, rel)), [onOpenFile, rootPath])

  useGitHistoryRequests(projectPath, rootPath, showHistory)
  useGitCommitRequests(projectPath, (hash) => {
    setTab('history')
    setStack([{ kind: 'commit', id: `commit:${hash}`, title: hash.substring(0, 7), hash }])
  })

  const commit = async (value?: string): Promise<boolean> => {
    const text = value ?? message
    console.info(`[git] commit ${m.stagedCount} staged with ${text.trim().split('\n')[0].length} chars`)
    const done = await m.commitText(text, () => {
      if (value !== undefined) setMessage(value)
    })
    if (done) {
      setMessage('')
      postToShell({ type: 'haptic', kind: 'success' })
      ;(document.activeElement as HTMLElement | null)?.blur?.()
    }
    console.info(`[git] commit ${done ? 'done' : 'did not finish'}`)
    return done
  }

  const onStash = (options: Omit<ScmStashOptions, 'message'>, text?: string): void => {
    void act('Stash', () => m.createStash({ ...options, message: text || undefined }))
  }
  const pickStash = (kind: StashPick, st?: Stash): void => {
    if (!st) return
    if (kind === 'view') push({ kind: 'stash', id: `stash:${st.hash}`, title: st.description, stash: st })
    else if (kind === 'apply') void act('Stash', () => m.applyStash(st))
    else if (kind === 'pop') void act('Stash', () => m.popStash(st))
    else void act('Stash', () => m.dropStash(st))
  }
  const more = moreActionNodes({
    rebasing: m.rebasing,
    mergeInProgress: m.mergeInProgress,
    onPull: () => void act('Pull', () => m.pull({ rebase: false, autoStash: settings.pullAutoStash })),
    onPullRebase: () => void act('Pull', () => m.pull({ rebase: true, autoStash: settings.pullAutoStash })),
    onPush: () => void act('Push', () => m.push()),
    onForcePush: () => void act('Force Push', () => m.forcePush()),
    onFetch: () => void act('Fetch', () => m.fetch()),
    onAbortRebase: () => void act('Abort', () => m.abortRebase()),
    onAbortMerge: () => void act('Abort', () => m.abortMerge()),
    onStash,
    onApplyLatest: () => void act('Stash', () => m.applyStash()),
    onPopLatest: () => void act('Stash', () => m.popStash()),
    onDropAll: () => void act('Stash', () => m.dropAllStashes()),
    onPick: pickStash,
    stashes: m.stashes
  })
  const refresh = (n: ActionNode): ActionNode =>
    n.id === 'scm.toolbar.refresh'
      ? {
          ...n,
          run: async () => {
            history.reload()
            await repo.refresh()
          }
        }
      : n.children
        ? { ...n, children: n.children.map(refresh) }
        : n
  const home = m.panelNodes({ detailOpen: true, message, commit, onAddEnvInline: () => {}, more }).map(refresh)
  usePanelActions(stack.length === 0 ? scope : null, home)

  const ctx: GitCtx = {
    root: rootPath,
    scope,
    repo,
    m,
    settings,
    onSettings,
    history,
    version,
    landscape,
    push,
    replace,
    close,
    openMenu,
    act,
    copy,
    openFile,
    showHistory,
    showTab: setTab
  }

  const pickCommit = (vm: ISCMHistoryItemViewModel): void => {
    const item = vm.historyItem
    if (comparing) {
      if (isSynthetic(item) || item.id === comparing.id) return
      const base = comparing
      setComparing(null)
      push({ kind: 'compare', id: `compare:${base.id}:${item.id}`, title: `${base.displayId} ↔ ${item.displayId}`, base, target: item })
      return
    }
    push({ kind: 'commit', id: `commit:${item.id}`, title: isSynthetic(item) ? item.subject : item.displayId ?? item.id.substring(0, 7), hash: item.id, vm })
  }

  const op = repo.operationError
  const stuck = !repo.state && !repo.loadError
  const tabs = <Tabs tab={tab} onTab={setTab} changes={m.groups.merge.length + m.groups.index.length + m.groups.workingTree.length} compact={landscape} />

  let content
  if (!repo.state && repo.loadError) {
    const notRepo = repo.loadError.gitErrorCode === 'NotAGitRepository'
    content = (
      <StateView icon={<FolderGit2 size={30} strokeWidth={1.75} />} title={notRepo ? 'No Git repository here' : "Couldn't read Git"} body={notRepo ? `The folder ${baseName(rootPath.replace(/\/+$/, '')) || rootPath} isn't inside a Git repository.` : repo.loadError.message} data={notRepo ? 'no-repo' : 'load-error'}>
        <PillButton label="Try again" onClick={() => void repo.refresh()} />
      </StateView>
    )
  } else if (stuck) {
    content = <StateView icon={<LoaderCircle size={24} className="animate-spin" />} title="Reading the repository" data="loading" />
  } else {
    content = (
      <>
        <BranchBar compact={landscape} tabs={tabs} />
        {!landscape && tabs}
        {m.conflictWarning ? (
          <Banner tone="warn" onDismiss={repo.dismissError} data="conflict">
            {m.conflictWarning}
          </Banner>
        ) : op ? (
          <Banner tone="err" onDismiss={repo.dismissError} action={retry.current ? { label: 'Try again', run: () => retry.current?.run() } : undefined} data="op-error">
            <span className="font-semibold">{op.operation} failed.</span> {op.error.message}
            {op.error.stderr && op.error.stderr.trim() !== op.error.message.trim() && <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] text-ink-3">{op.error.stderr.trim()}</pre>}
          </Banner>
        ) : null}
        <div className="relative min-h-0 flex-1">
          <div className="absolute inset-0" style={{ display: tab === 'changes' ? undefined : 'none' }}>
            <ChangesTab message={message} setMessage={setMessage} onCommit={() => void commit()} />
          </div>
          {seenHistory && (
            <div className="absolute inset-0" style={{ display: tab === 'history' ? undefined : 'none' }}>
              <HistoryTab comparing={comparing} onPick={pickCommit} onCompare={setComparing} onCancelCompare={() => setComparing(null)} />
            </div>
          )}
        </div>
      </>
    )
  }

  return (
    <GitContext.Provider value={ctx}>
      <div ref={rootRef} className="phone-git relative flex h-full w-full flex-col overflow-hidden bg-canvas text-ink" data-phone-git data-pg-root={tab}>
        {content}
        {tab === 'history' && paths && <HistoryBack onBack={() => setPaths(null)} />}
        {stack.map((s, i) => (
          <ScreenHost key={s.id} screen={s} top={i === stack.length - 1} depth={i} onBack={() => setStack((prev) => prev.slice(0, Math.max(0, prev.findIndex((x) => x.id === s.id))))} />
        ))}
        {menu && <ActionMenu key={menu.seq} x={menu.x} y={menu.y} nodes={menu.nodes} onDismiss={() => setMenu(null)} />}
      </div>
    </GitContext.Provider>
  )
}
