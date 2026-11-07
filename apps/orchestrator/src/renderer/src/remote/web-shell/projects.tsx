import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Folder, FolderOpen, GitBranch, HardDrive, House, Plus } from 'lucide-react'
import type { NewProjectKind, UnityEditorForCreate } from '@shared/api'
import type { PhoneProjectCreation, PhoneProjectDir, PhoneProjectRow, PhoneProjectWorktree, PhoneProjectsHome } from '@shared/remote-projects'
import { invokeRemote, wsTransport } from '../ws-transport'
import { haptic, openWorkspace, showToast, useShell } from './bridge'
import { useView } from './viewport'

export type ProjectSheet = 'new' | 'open'

const DEFAULT_NAME = 'MyGame'

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function shortPath(path: string, home: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

function untilProject(id: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const has = (): boolean => useShell.getState().projects.some((p) => p.id === id)
    if (has()) return resolve(true)
    const timer = setTimeout(() => {
      off()
      resolve(has())
    }, ms)
    const off = useShell.subscribe(() => {
      if (!has()) return
      clearTimeout(timer)
      off()
      resolve(true)
    })
  })
}

async function showWorkspace(id: string, why: string): Promise<void> {
  const known = await untilProject(id, 6000)
  console.info(`[projects] ${why}: workspace ${id}${known ? '' : ", the Mac hasn't sent it yet"}`)
  haptic('success')
  openWorkspace(id)
}

function Shell({ title, back, onBack, children, action, data }: { title: string; back: string; onBack: () => void; children: ReactNode; action?: ReactNode; data: string }) {
  const view = useView()
  return (
    <div className="ws-screen fixed inset-x-0 z-[60] flex flex-col bg-black" style={{ top: view.top, bottom: view.kb, paddingTop: view.safe.t, paddingLeft: view.safe.l, paddingRight: view.safe.r }} data-ws-page={data}>
      <div className="mx-auto flex min-h-0 w-full max-w-[680px] flex-1 flex-col">
        <div className="flex h-[52px] shrink-0 items-center gap-1 px-2">
          <button type="button" aria-label={`Back to ${back}`} onClick={onBack} className="flex h-11 min-w-0 max-w-[60%] items-center gap-0.5 rounded-full pl-1 pr-3 text-[16px] text-[var(--ws-accent)] active:opacity-60" data-ws-projects-back>
            <ChevronLeft size={24} strokeWidth={2.4} className="shrink-0" />
            <span className="truncate">{back}</span>
          </button>
          <span className="ml-auto flex shrink-0 items-center">{action}</span>
        </div>
        <h1 className="truncate px-5 pb-2 text-[30px] font-bold tracking-tight">{title}</h1>
        <div className="ws-scroll min-h-0 flex-1 px-4" style={{ paddingBottom: view.kb ? 12 : Math.max(view.safe.b, 16) + 8 }}>
          {children}
        </div>
      </div>
    </div>
  )
}

function Card({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-[12px] bg-[var(--ws-card)] [&>*+*]:border-t [&>*+*]:border-white/[0.08]">{children}</div>
}

function Label({ children }: { children: ReactNode }) {
  return <h2 className="px-4 pb-1.5 pt-5 text-[13px] uppercase tracking-wide text-[var(--ws-label2)]">{children}</h2>
}

function Note({ children, tone }: { children: ReactNode; tone?: 'err' }) {
  return <p className={`px-4 pt-1.5 text-[13px] leading-snug ${tone === 'err' ? 'text-[var(--ws-err)]' : 'text-[var(--ws-label2)]'}`}>{children}</p>
}

function UnityBadge() {
  return <span className="shrink-0 rounded-full bg-white/[0.09] px-2 py-0.5 font-mono text-[11px] font-semibold text-[var(--ws-ink)]">Unity</span>
}

function Row({ row, home, onTap, onOpen, pending, trail }: { row: PhoneProjectRow; home: string; onTap: () => void; onOpen?: () => void; pending?: boolean; trail?: 'chevron' }) {
  return (
    <div className={`flex min-h-[56px] items-center gap-3 pl-4 pr-2 ${pending ? 'remote-pending' : ''} ${row.exists ? '' : 'opacity-50'}`} data-ws-project-row={row.path} data-ws-project-hidden={row.hidden ? '' : undefined}>
      <button type="button" onClick={onTap} disabled={!row.exists} className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left active:opacity-60">
        {row.unity ? <FolderOpen size={22} strokeWidth={2} className="shrink-0 text-[var(--ws-accent)]" /> : <Folder size={22} strokeWidth={2} className="shrink-0 text-[var(--ws-label2)]" />}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className={`truncate text-[16px] ${row.hidden ? 'text-[var(--ws-label2)]' : ''}`}>{row.name}</span>
            {row.unity && <UnityBadge />}
          </span>
          <span className="truncate text-[12.5px] text-[var(--ws-label2)]">{row.exists ? `${row.open ? 'Open on your desktop · ' : ''}${shortPath(row.path, home)}` : `Missing · ${shortPath(row.path, home)}`}</span>
        </span>
        {trail === 'chevron' && !onOpen && <ChevronRight size={17} strokeWidth={2.4} className="shrink-0 text-[var(--ws-label3)]" />}
      </button>
      {onOpen && (
        <button type="button" onClick={onOpen} className="ws-press h-8 shrink-0 rounded-full bg-[var(--ws-blue)] px-3.5 text-[13.5px] font-semibold text-white" data-ws-project-open={row.path}>
          Open
        </button>
      )}
    </div>
  )
}

function WorktreeRow({ wt, onOpen, pending, nested }: { wt: PhoneProjectWorktree; onOpen: () => void; pending?: boolean; nested?: boolean }) {
  return (
    <div className={`flex min-h-[52px] items-center gap-3 pr-2 ${nested ? 'pl-11' : 'pl-4'} ${pending ? 'remote-pending' : ''}`} data-ws-worktree-row={wt.path}>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left active:opacity-60" data-ws-worktree-tap={wt.path}>
        <GitBranch size={nested ? 18 : 22} strokeWidth={2} className="shrink-0 text-[var(--ws-accent)]" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[15.5px]">{wt.name}</span>
            {wt.unity && <UnityBadge />}
          </span>
          <span className="truncate text-[12.5px] text-[var(--ws-label2)]">{`${wt.open ? 'Open on your desktop · ' : ''}${wt.branch ? `Branch ${wt.branch}` : 'No branch'}`}</span>
        </span>
      </button>
      {!nested && (
        <button type="button" onClick={onOpen} className="ws-press h-8 shrink-0 rounded-full bg-[var(--ws-blue)] px-3.5 text-[13.5px] font-semibold text-white" data-ws-worktree-open={wt.path}>
          Open
        </button>
      )}
    </div>
  )
}

function useHome(): { home: PhoneProjectsHome | null; error: string | null; reload: () => void } {
  const [state, setState] = useState<{ home: PhoneProjectsHome | null; error: string | null }>({ home: null, error: null })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    invokeRemote<PhoneProjectsHome>('remote:projects:home').then(
      (home) => {
        if (!alive) return
        console.info(`[projects] recents: ${home.recents.map((r) => `${r.name}${r.worktrees?.length ? ` (worktrees ${r.worktrees.map((w) => w.name).join(', ')})` : ''}`).join(', ') || 'none'}`)
        setState({ home, error: null })
      },
      (e) => alive && setState({ home: null, error: message(e) })
    )
    return () => {
      alive = false
    }
  }, [tick])
  return { ...state, reload: () => setTick((n) => n + 1) }
}

function FolderBrowser({ start, home, pick, onBack, onPick, onOpen, busy }: { start: string; home: string; pick: string; onBack: () => void; onPick?: (dir: string) => void; onOpen?: (dir: string) => void; busy?: string | null }) {
  const [stack, setStack] = useState<string[]>([start])
  const dir = stack[stack.length - 1]
  const [listing, setListing] = useState<{ dir: string; data: PhoneProjectDir | null; error: string | null }>({ dir: '', data: null, error: null })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    const t0 = performance.now()
    invokeRemote<PhoneProjectDir>('remote:projects:browse', { dir }).then(
      (data) => {
        if (!alive) return
        console.info(`[projects] ${data.dir}: ${data.entries.length} folders (${data.entries.filter((r) => r.hidden).length} hidden), ${data.worktrees.length} worktrees in ${Math.round(performance.now() - t0)} ms`)
        setListing({ dir, data, error: null })
      },
      (e) => alive && setListing({ dir, data: null, error: message(e) })
    )
    return () => {
      alive = false
    }
  }, [dir, tick])
  const data = listing.dir === dir ? listing.data : null
  const error = listing.dir === dir ? listing.error : null
  const back = (): void => (stack.length > 1 ? setStack(stack.slice(0, -1)) : onBack())
  const up = data?.parent && stack.length === 1 ? data.parent : null
  const title = data?.name ?? dir.split('/').pop() ?? dir
  const shown = data?.entries.filter((r) => !r.hidden) ?? []
  const dots = data?.entries.filter((r) => r.hidden) ?? []
  const worktrees = onOpen ? data?.worktrees ?? [] : []
  const folder = (r: PhoneProjectRow): ReactNode => (
    <Row key={r.path} row={r} home={home} trail="chevron" pending={busy === r.path} onTap={() => setStack([...stack, r.path])} onOpen={onOpen && r.unity ? () => onOpen(r.path) : undefined} />
  )
  const action = onPick ? (
    <button type="button" disabled={!data} onClick={() => data && onPick(data.dir)} className="ws-press h-9 rounded-full bg-[var(--ws-blue)] px-4 text-[15px] font-semibold text-white" data-ws-folder-pick>
      {pick}
    </button>
  ) : data ? (
    <button type="button" onClick={() => onOpen?.(data.dir)} className={`ws-press h-9 rounded-full bg-[var(--ws-blue)] px-4 text-[15px] font-semibold text-white ${busy === data.dir ? 'remote-pending' : ''}`} data-ws-folder-open>
      {pick}
    </button>
  ) : null
  return (
    <Shell title={title} back={stack.length > 1 ? stack[stack.length - 2].split('/').pop() || 'Back' : 'Back'} onBack={back} action={action} data="Folders">
      <p className="truncate px-1 pb-3 text-[13px] text-[var(--ws-label2)]">{shortPath(dir, home)}</p>
      {error ? (
        <Note tone="err">
          {error}{' '}
          <button type="button" className="text-[var(--ws-accent)]" onClick={() => setTick((n) => n + 1)}>
            Try again
          </button>
        </Note>
      ) : !data ? (
        <Note>Loading…</Note>
      ) : (
        <>
          {worktrees.length > 0 && (
            <>
              <Label>Worktrees</Label>
              <Card>
                {worktrees.map((w) => (
                  <WorktreeRow key={w.path} wt={w} pending={busy === w.path} onOpen={() => onOpen?.(w.path)} />
                ))}
              </Card>
              <Label>Folders</Label>
            </>
          )}
          {(up || shown.length > 0 || dots.length === 0) && (
            <Card>
              {up && (
                <button type="button" onClick={() => setStack([up])} className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-[16px] text-[var(--ws-accent)] active:bg-white/[0.06]" data-ws-folder-up>
                  <ChevronLeft size={18} strokeWidth={2.4} />
                  {up.split('/').pop() || up}
                </button>
              )}
              {data.entries.length === 0 && <p className="px-4 py-3 text-[15px] text-[var(--ws-label2)]">No folders here</p>}
              {shown.map(folder)}
            </Card>
          )}
          {dots.length > 0 && (
            <>
              <Label>Hidden folders</Label>
              <Card>{dots.map(folder)}</Card>
            </>
          )}
          {data.more > 0 && <Note>{data.more} more folders not shown</Note>}
        </>
      )}
    </Shell>
  )
}

export function OpenProjectScreen({ onClose }: { onClose: () => void }) {
  const { home, error, reload } = useHome()
  const [browse, setBrowse] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const open = (path: string): void => {
    if (busy) return
    setBusy(path)
    console.info(`[projects] open ${path} on the Mac`)
    invokeRemote<{ workspaceId: string; created: boolean }>('remote:projects:open', { path }).then(
      async (r) => {
        await showWorkspace(r.workspaceId, r.created ? `opened ${path}` : `${path} was open`)
        onClose()
      },
      (e) => {
        haptic('error')
        console.info(`[projects] open ${path} failed: ${message(e)}`)
        showToast(message(e))
        setBusy(null)
        reload()
      }
    )
  }
  if (browse !== null && home)
    return <FolderBrowser start={browse} home={home.home} pick="Open" onBack={() => setBrowse(null)} onOpen={open} busy={busy} />
  return (
    <Shell title="Open a Project" back="Projects" onBack={onClose} data="OpenProject">
      {error && <Note tone="err">{error}</Note>}
      {!home && !error && <Note>Loading…</Note>}
      {home && (
        <>
          <Label>Recent</Label>
          {home.recents.length === 0 ? (
            <Note>Projects you open on the desktop show up here.</Note>
          ) : (
            <Card>
              {home.recents.map((r) => (
                <Fragment key={r.path}>
                  <Row row={r} home={home.home} pending={busy === r.path} onTap={() => open(r.path)} />
                  {r.worktrees?.map((w) => <WorktreeRow key={w.path} wt={w} nested pending={busy === w.path} onOpen={() => open(w.path)} />)}
                </Fragment>
              ))}
            </Card>
          )}
          <Label>Browse the desktop</Label>
          <Card>
            {home.places.map((p) => (
              <button key={p.path} type="button" onClick={() => setBrowse(p.path)} className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left active:bg-white/[0.06]" data-ws-place={p.label}>
                {p.label === 'Home' ? <House size={20} strokeWidth={2} className="text-[var(--ws-label2)]" /> : p.label === 'Drives' ? <HardDrive size={20} strokeWidth={2} className="text-[var(--ws-label2)]" /> : <Folder size={20} strokeWidth={2} className="text-[var(--ws-label2)]" />}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[16px]">{p.label}</span>
                  <span className="truncate text-[12.5px] text-[var(--ws-label2)]">{shortPath(p.path, home.home)}</span>
                </span>
                <ChevronRight size={17} strokeWidth={2.4} className="text-[var(--ws-label3)]" />
              </button>
            ))}
          </Card>
          <Note>Tap a folder to look inside, then Open. Unity projects and worktrees have their own Open button.</Note>
        </>
      )}
    </Shell>
  )
}

function useCreation(): PhoneProjectCreation | null {
  const [c, setC] = useState<PhoneProjectCreation | null>(null)
  useEffect(() => {
    let alive = true
    void invokeRemote<PhoneProjectCreation>('remote:projects:creation').then((v) => alive && setC(v), () => {})
    const off = wsTransport.on('remote:projects:creation', (v: PhoneProjectCreation) => setC(v))
    return () => {
      alive = false
      off()
    }
  }, [])
  return c
}

export function NewProjectScreen({ onClose }: { onClose: () => void }) {
  const { home, error: homeError } = useHome()
  const [editors, setEditors] = useState<UnityEditorForCreate[] | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [name, setName] = useState(DEFAULT_NAME)
  const [parent, setParent] = useState('')
  const [version, setVersion] = useState('')
  const [kind, setKind] = useState<NewProjectKind>('3d')
  const [problem, setProblem] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [starting, setStarting] = useState(false)
  const creation = useCreation()
  const named = useRef(false)
  const handled = useRef<number>(0)
  const openedAt = useRef(Date.now())

  useEffect(() => {
    let alive = true
    invokeRemote<{ editors: UnityEditorForCreate[] }>('remote:projects:editors').then(
      (r) => {
        if (!alive) return
        setEditors(r.editors)
        const first = r.editors.find((e) => e.kinds.includes('3d')) ?? r.editors[0]
        if (first) {
          setVersion(first.version)
          setKind(first.kinds.includes('3d') ? '3d' : first.kinds[0] ?? '3d')
        }
      },
      (e) => alive && setEditorError(message(e))
    )
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (home && !parent) setParent(home.defaultFolder)
  }, [home, parent])

  useEffect(() => {
    if (!parent || named.current) return
    let alive = true
    void (async () => {
      let n = DEFAULT_NAME
      for (let i = 2; i < 30; i++) {
        const r = await invokeRemote<{ problem: string | null }>('remote:projects:check', { parent, name: n }).catch(() => null)
        if (!r?.problem?.includes('already exists')) break
        n = `${DEFAULT_NAME}${i}`
      }
      if (alive && !named.current) setName(n)
    })()
    return () => {
      alive = false
    }
  }, [parent])

  useEffect(() => {
    if (!parent) return
    let alive = true
    const t = setTimeout(() => {
      void invokeRemote<{ problem: string | null }>('remote:projects:check', { parent, name }).then(
        (r) => alive && setProblem(r.problem),
        (e) => alive && setProblem(message(e))
      )
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [parent, name])

  const last = creation?.last ?? null
  useEffect(() => {
    if (!last || last.at === handled.current || last.at < openedAt.current) return
    handled.current = last.at
    setStarting(false)
    if (last.ok && last.workspaceId) {
      void showWorkspace(last.workspaceId, `created ${last.path}`).then(onClose)
      return
    }
    haptic('error')
  }, [last])

  const editor = editors?.find((e) => e.version === version)
  const kinds = useMemo(() => editor?.kinds ?? [], [editor])
  useEffect(() => {
    if (editor && !editor.kinds.includes(kind) && editor.kinds[0]) setKind(editor.kinds[0])
  }, [editor, kind])

  const active = creation?.active ?? null
  const canCreate = !!editor && editor.kinds.includes(kind) && !problem && !!name.trim() && !active && !starting

  const create = (): void => {
    if (!canCreate) return
    setStarting(true)
    console.info(`[projects] create ${kind} ${name} in ${parent} with ${version}`)
    invokeRemote<PhoneProjectCreation>('remote:projects:create', { name: name.trim(), parent, version, kind }).then(
      () => {},
      (e) => {
        setStarting(false)
        haptic('error')
        showToast(message(e))
      }
    )
  }

  if (picking && home)
    return (
      <FolderBrowser
        start={parent || home.defaultFolder}
        home={home.home}
        pick="Choose"
        onBack={() => setPicking(false)}
        onPick={(dir) => {
          setParent(dir)
          setPicking(false)
        }}
      />
    )

  const failed = !active && last && !last.ok && !last.cancelled && last.at >= openedAt.current ? last.error : null
  const error = homeError ?? editorError
  return (
    <Shell title="New Unity Project" back="Projects" onBack={onClose} data="NewProject">
      {error && <Note tone="err">{error}</Note>}
      {active ? (
        <div className="flex flex-col gap-3 px-1 pt-4" data-ws-creating={active.name}>
          <span className="text-[17px] font-semibold">Creating {active.name}</span>
          <span className="text-[14px] text-[var(--ws-label2)]">
            Unity {active.version} · {active.kind.toUpperCase()} · {home ? shortPath(active.parent, home.home) : active.parent}
          </span>
          <div className="h-[6px] w-full overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-valuenow={active.progress?.pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-[var(--ws-accent)] transition-[width]" style={{ width: `${Math.max(3, active.progress?.pct ?? 3)}%` }} />
          </div>
          <span className="text-[14px] text-[var(--ws-label2)]" data-ws-creating-phase>
            {active.progress?.phase || 'Starting Unity…'}
          </span>
          <button type="button" onClick={() => void invokeRemote('remote:projects:cancel')} className="ws-glass ws-press mt-2 h-11 self-start rounded-full px-5 text-[16px] font-medium text-[var(--ws-accent)]" data-ws-create-cancel>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <Label>Name</Label>
          <Card>
            <input
              value={name}
              onChange={(e) => {
                named.current = true
                setName(e.target.value)
              }}
              placeholder="Project name"
              autoCapitalize="words"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              data-web-shell-composer
              className="ws-field h-[48px] w-full bg-transparent px-4 text-[var(--ws-ink)] outline-none"
              style={{ fontSize: 16 }}
              data-ws-new-name
            />
          </Card>
          <Label>Location</Label>
          <Card>
            <button type="button" onClick={() => setPicking(true)} disabled={!home} className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left active:bg-white/[0.06]" data-ws-new-parent={parent}>
              <Folder size={20} strokeWidth={2} className="shrink-0 text-[var(--ws-label2)]" />
              <span className="min-w-0 flex-1 truncate text-[16px]">{parent ? (home ? shortPath(parent, home.home) : parent) : 'Choose a folder'}</span>
              <ChevronRight size={17} strokeWidth={2.4} className="text-[var(--ws-label3)]" />
            </button>
          </Card>
          <Label>Template</Label>
          <div className="flex gap-2 px-1" data-ws-new-kinds>
            {(['3d', '2d'] as const).map((k) => (
              <button
                key={k}
                type="button"
                disabled={!kinds.includes(k)}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={`h-10 flex-1 rounded-full text-[15px] font-semibold disabled:opacity-40 ${kind === k ? 'bg-[var(--ws-ink)] text-[#0f0f12]' : 'ws-glass text-[var(--ws-ink)]'}`}
                data-ws-new-kind={k}
              >
                {k === '3d' ? '3D (URP)' : '2D (URP)'}
              </button>
            ))}
          </div>
          <Label>Unity version</Label>
          <Card>
            {editors === null ? (
              <p className="px-4 py-3 text-[15px] text-[var(--ws-label2)]">Looking for Unity editors…</p>
            ) : editors.length === 0 ? (
              <p className="px-4 py-3 text-[15px] text-[var(--ws-label2)]">No Unity editor is installed on the desktop. Install one with Unity Hub.</p>
            ) : (
              <select value={version} onChange={(e) => setVersion(e.target.value)} className="h-[48px] w-full bg-transparent px-4 text-[16px] text-[var(--ws-ink)] outline-none" data-ws-new-version>
                {editors.map((e) => (
                  <option key={e.version} value={e.version}>
                    Unity {e.version}
                  </option>
                ))}
              </select>
            )}
          </Card>
          {problem && <Note tone="err">{problem}</Note>}
          {failed && (
            <p className="whitespace-pre-wrap px-4 pt-3 text-[13px] leading-snug text-[var(--ws-err)]" data-ws-create-error>
              {failed}
            </p>
          )}
          <div className="px-1 pt-6">
            <button type="button" disabled={!canCreate} onClick={create} className="ws-press flex h-[52px] w-full items-center justify-center gap-2 rounded-full bg-[var(--ws-blue)] text-[17px] font-semibold text-white disabled:opacity-50" data-ws-create>
              {starting ? <span className="ws-spin !h-[18px] !w-[18px] !border-2 !border-white/30 !border-t-white" /> : <Plus size={18} strokeWidth={2.6} />}
              {starting ? 'Starting' : 'Create and Open'}
            </button>
          </div>
          <Note>Unity makes the project on your desktop, then Satura opens it there and here.</Note>
        </>
      )}
    </Shell>
  )
}
