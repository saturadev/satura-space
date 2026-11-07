import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, CircleX, Ellipsis, Plus, Search } from 'lucide-react'
import type { DirEntry, SearchDone, SearchFileResult, SearchMatch } from '@shared/api'
import type { WireAction } from '../../lib/actions/action-tree'
import { ExplorerIcon } from '../../components/workbench/explorer-icons'
import { HIDDEN_DIRS, isAlwaysDim, isMetaFile, isTreeIgnored, opensAsUnityAsset, opensInSaturaWithMeta, projectRel, sortByDim } from '../../lib/file-explorer/explorer-rules'
import { copyAbsolutePath, copyRelativePath, joinPath, parentDir, relativePath } from '../../lib/file-explorer/copy-paths'
import { rankQuickOpenFiles } from '../../lib/quick-open/quick-open-search'
import { renameRefusal } from '../../lib/file-explorer/rename-refusal'
import { call, closeFiles, filesBack, filesInto, haptic, run, showToast, useShell } from './bridge'
import { openMenu } from './menus'
import { useView } from './viewport'
import { getMac, pathHostId } from '../macs'

const LONG_PRESS_MS = 500
const CONTENT_LIMIT = 2000
const CONTENT_FILES_SHOWN = 200
const MATCHES_SHOWN = 5
const SEARCH_DEADLINE_MS = 30000
let searchSeq = 1_000_000 + Math.floor(Math.random() * 1_000_000)
const listings = new Map<string, DirEntry[]>()
const ignoredByRoot = new Map<string, Set<string>>()
const namesByRoot = new Map<string, string[]>()

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

async function readListing(dir: string): Promise<DirEntry[]> {
  const entries = await window.api.fs.readDir(dir)
  if (entries.length) return entries
  const info = await window.api.fs.statPath(dir)
  if (!info.isDirectory) throw new Error(info.exists ? "It's a file now." : 'It was moved or deleted on the desktop.')
  return entries
}

function useListing(dir: string, tick: number): { entries: DirEntry[] | null; error: string | null; refresh: () => Promise<void> } {
  const [state, setState] = useState<{ dir: string; entries: DirEntry[] | null; error: string | null }>({ dir, entries: listings.get(dir) ?? null, error: null })
  const refresh = async (): Promise<void> => {
    const entries = await readListing(dir)
    listings.set(dir, entries)
    setState({ dir, entries, error: null })
  }
  useEffect(() => {
    let alive = true
    setState({ dir, entries: listings.get(dir) ?? null, error: null })
    const t0 = performance.now()
    readListing(dir).then(
      (entries) => {
        if (!alive) return
        listings.set(dir, entries)
        console.info(`[files] ${dir}: ${entries.length} entries in ${Math.round(performance.now() - t0)} ms`)
        setState({ dir, entries, error: null })
      },
      (e: unknown) => {
        if (!alive) return
        listings.delete(dir)
        console.info(`[files] ${dir} failed: ${message(e)}`)
        setState({ dir, entries: null, error: message(e) })
      }
    )
    return () => {
      alive = false
    }
  }, [dir, tick])
  return state.dir === dir ? { ...state, refresh } : { entries: listings.get(dir) ?? null, error: null, refresh }
}

function useIgnored(root: string): Set<string> {
  const [ignored, setIgnored] = useState<Set<string>>(() => ignoredByRoot.get(root) ?? new Set())
  useEffect(() => {
    let alive = true
    window.api.git.listIgnored(root).then(
      (paths) => {
        const set = new Set(paths)
        ignoredByRoot.set(root, set)
        if (alive) setIgnored(set)
      },
      () => {}
    )
    return () => {
      alive = false
    }
  }, [root])
  return ignored
}

interface Names {
  names: string[]
  metas: Set<string>
}

function namesOf(all: string[]): Names {
  return { names: all.filter((p) => !isMetaFile(p)), metas: new Set(all.filter((p) => isMetaFile(p))) }
}

function useNames(root: string, wanted: boolean, tick: number): { names: Names | null; error: string | null } {
  const cached = (): Names | null => {
    const all = namesByRoot.get(root)
    return all ? namesOf(all) : null
  }
  const [state, setState] = useState<{ names: Names | null; error: string | null }>(() => ({ names: cached(), error: null }))
  useEffect(() => {
    if (!wanted) return
    let alive = true
    const t0 = performance.now()
    window.api.fs.listFiles(root).then(
      (all) => {
        namesByRoot.set(root, all)
        const names = namesOf(all)
        console.info(`[files] ${names.names.length} file names for search in ${Math.round(performance.now() - t0)} ms`)
        if (alive) setState({ names, error: null })
      },
      (e: unknown) => {
        console.info(`[files] file names failed: ${message(e)}`)
        if (alive) setState({ names: cached(), error: message(e) })
      }
    )
    return () => {
      alive = false
    }
  }, [root, wanted, tick])
  return state
}

interface ContentSearch {
  files: SearchFileResult[]
  done: SearchDone | null
  error: string | null
  running: boolean
}

function useContentSearch(root: string, query: string, scope: string | null, enabled: boolean, tick: number): ContentSearch {
  const q = query.trim()
  const key = `${root}|${scope ?? ''}|${q}|${tick}|${enabled}`
  const [state, setState] = useState<{ key: string; files: SearchFileResult[]; done: SearchDone | null; error: string | null }>({ key: '', files: [], done: null, error: null })
  const req = useRef(0)
  useEffect(() => {
    const offResult = window.api.fs.onSearchResult((e) => {
      if (e.requestId === req.current) setState((s) => ({ ...s, files: [...s.files, ...e.files] }))
    })
    const offDone = window.api.fs.onSearchDone((e) => {
      if (e.requestId !== req.current) return
      console.info(`[files] contents search done: ${e.matchCount} matches in ${e.fileCount} files${e.limitHit ? ', limit hit' : ''}${e.error ? `, error ${e.error}` : ''}`)
      setState((s) => ({ ...s, done: e, error: e.error ?? null }))
    })
    return () => {
      offResult()
      offDone()
      window.api.fs.searchCancel(req.current)
    }
  }, [])
  useEffect(() => {
    window.api.fs.searchCancel(req.current)
    req.current = 0
    setState({ key, files: [], done: null, error: null })
    if (!enabled || !q) return
    const id = ++searchSeq
    req.current = id
    const rel = scope ? relativePath(root, scope).replace(/\/+$/, '') : ''
    const start = setTimeout(() => {
      console.info(`[files] contents search "${q}"${rel ? ` in ${rel}` : ''}`)
      window.api.fs.searchStart(id, { rootPath: root, query: q, includeGlobs: rel ? `${rel}/**` : '', useGitignore: true, contextLines: 0, maxResults: CONTENT_LIMIT })
    }, 300)
    const deadline = setTimeout(() => {
      if (req.current !== id) return
      window.api.fs.searchCancel(id)
      console.info(`[files] contents search "${q}" didn't finish`)
      setState((s) => (s.done ? s : { ...s, error: "The search didn't finish in 30 s." }))
    }, SEARCH_DEADLINE_MS)
    return () => {
      clearTimeout(start)
      clearTimeout(deadline)
    }
  }, [key])
  const mine = state.key === key
  return { files: mine ? state.files : [], done: mine ? state.done : null, error: mine ? state.error : null, running: enabled && !!q && (!mine || (!state.done && !state.error)) }
}

function useLongPress(onLong: (el: HTMLElement) => void): { fired: () => boolean; handlers: Record<string, unknown> } {
  const timer = useRef(0)
  const start = useRef<{ x: number; y: number } | null>(null)
  const long = useRef(false)
  const clear = (): void => {
    window.clearTimeout(timer.current)
    start.current = null
  }
  return {
    fired: () => {
      const was = long.current
      long.current = false
      return was
    },
    handlers: {
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        long.current = false
        start.current = { x: e.clientX, y: e.clientY }
        const el = e.currentTarget
        timer.current = window.setTimeout(() => {
          long.current = true
          start.current = null
          haptic()
          onLong(el)
        }, LONG_PRESS_MS)
      },
      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
        const s = start.current
        if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8) clear()
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onPointerLeave: clear,
      onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
        e.preventDefault()
        if (long.current) return
        clear()
        long.current = true
        onLong(e.currentTarget)
      }
    }
  }
}

function FileRow({ entry, detail, dim, pending, focused, onTap, onMenu, busy }: { entry: DirEntry; detail?: string; dim: boolean; pending: boolean; focused?: boolean; onTap: () => void; onMenu: (el: HTMLElement) => void; busy?: string }) {
  const press = useLongPress(onMenu)
  return (
    <button
      type="button"
      onClick={() => {
        if (!press.fired()) onTap()
      }}
      {...press.handlers}
      className={`flex min-h-[48px] w-full select-none items-center gap-3 px-3.5 py-2 text-left active:bg-white/[0.08] ${focused ? 'bg-white/[0.10]' : ''} ${pending ? 'remote-pending' : ''}`}
      style={{ WebkitTouchCallout: 'none' }}
      data-ws-file={entry.path}
      data-ws-file-kind={entry.isDirectory ? 'dir' : 'file'}
    >
      <span className={`flex h-6 w-6 shrink-0 items-center justify-center [&>svg]:h-[20px] [&>svg]:w-[20px] ${dim ? 'opacity-50' : ''}`}>
        <ExplorerIcon name={entry.name} rel={entry.name} isDir={entry.isDirectory} open={false} dim={dim} unity={false} />
      </span>
      <span className={`flex min-w-0 flex-1 flex-col ${dim ? 'text-[var(--ws-label2)]' : ''}`}>
        <span className="truncate text-[16px] leading-tight">{entry.name}</span>
        {(busy || detail) && <span className="mt-0.5 truncate text-[12.5px] leading-tight text-[var(--ws-label2)]">{busy || detail}</span>}
      </span>
      {entry.isDirectory && <ChevronRight size={17} strokeWidth={2.4} className="shrink-0 text-[var(--ws-label3)]" />}
    </button>
  )
}

function MatchText({ ms }: { ms: SearchMatch[] }) {
  const text = ms[0].lineText.replace(/\t/g, '  ')
  const lead = ms[0].matchStart > 36 ? ms[0].matchStart - 24 : 0
  const parts: ReactNode[] = []
  let at = lead
  for (const m of ms) {
    if (m.matchStart < at) continue
    parts.push(text.slice(at, m.matchStart))
    parts.push(
      <mark key={m.matchStart} className="rounded-[3px] bg-[rgb(255_214_10/0.28)] px-[1px] text-[var(--ws-ink)]">
        {text.slice(m.matchStart, m.matchEnd)}
      </mark>
    )
    at = m.matchEnd
  }
  parts.push(text.slice(at, at + 160))
  return (
    <span className="min-w-0 flex-1 truncate font-mono text-[13px] leading-snug text-[var(--ws-label2)]">
      {lead > 0 && '…'}
      {parts}
    </span>
  )
}

function byLine(matches: SearchMatch[]): SearchMatch[][] {
  const lines = new Map<number, SearchMatch[]>()
  for (const m of matches) lines.set(m.line, [...(lines.get(m.line) ?? []), m])
  return [...lines.values()].map((ms) => ms.sort((a, b) => a.matchStart - b.matchStart))
}

function ContentFile({ f, root, pending, dim, onOpen, onMenu }: { f: SearchFileResult; root: string; pending: Record<string, true>; dim: boolean; onOpen: (path: string, m?: SearchMatch) => void; onMenu: (el: HTMLElement) => void }) {
  const [all, setAll] = useState(false)
  const rel = f.relativePath || relativePath(root, f.filePath)
  const slash = rel.lastIndexOf('/')
  const entry: DirEntry = { name: rel.slice(slash + 1), path: f.filePath, isDirectory: false }
  const lines = byLine(f.matches)
  const shownLines = all ? lines : lines.slice(0, MATCHES_SHOWN)
  return (
    <div className="overflow-hidden rounded-[12px] bg-[var(--ws-card)] [&>*+*]:border-t [&>*+*]:border-white/[0.08]" data-ws-content-file={f.filePath}>
      <FileRow entry={entry} detail={`${slash > 0 ? rel.slice(0, slash) + ' · ' : ''}${f.matches.length} ${f.matches.length === 1 ? 'match' : 'matches'}`} dim={dim} pending={!!pending[`files:${f.filePath}`]} onTap={() => onOpen(f.filePath)} onMenu={onMenu} />
      {shownLines.map((ms) => (
        <button
          key={ms[0].line}
          type="button"
          onClick={() => onOpen(f.filePath, ms[0])}
          className={`flex min-h-[40px] w-full items-center gap-2.5 py-1.5 pl-3.5 pr-3 text-left active:bg-white/[0.08] ${pending[`files:${f.filePath}:${ms[0].line}`] ? 'remote-pending' : ''}`}
          data-ws-content-match={`${f.filePath}:${ms[0].line}`}
        >
          <span className="w-9 shrink-0 text-right font-mono text-[12px] text-[var(--ws-label3)]">{ms[0].line}</span>
          <MatchText ms={ms} />
        </button>
      ))}
      {lines.length > shownLines.length && (
        <button type="button" onClick={() => setAll(true)} className="flex min-h-[40px] w-full items-center pl-[58px] text-left text-[14px] text-[var(--ws-accent)] active:bg-white/[0.08]" data-ws-content-more={f.filePath}>
          {lines.length - shownLines.length} more {lines.length - shownLines.length === 1 ? 'line' : 'lines'} in this file
        </button>
      )}
    </div>
  )
}

function Card({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-[12px] bg-[var(--ws-card)] [&>*+*]:border-t [&>*+*]:border-white/[0.08]">{children}</div>
}

function Note({ children, data }: { children: ReactNode; data: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-8 pt-12 text-center text-[15px] leading-snug text-[var(--ws-label2)]" data-ws-files-state={data}>
      {children}
    </div>
  )
}

function Failed({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) {
  return (
    <Note data="error">
      <span className="text-[var(--ws-ink)]">{what}</span>
      <span className="text-[13px]">{error}</span>
      <button type="button" onClick={onRetry} className="ws-glass ws-press h-11 rounded-full px-5 text-[16px] font-medium text-[var(--ws-accent)]" data-ws-files-retry>
        Try again
      </button>
    </Note>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <Note data="loading">
      <span className="flex items-center gap-2">
        <span className="ws-spin !h-4 !w-4 !border-2" />
        {label}
      </span>
    </Note>
  )
}

export function FilesScreen({ stack }: { stack: string[] }) {
  const view = useView()
  const ws = useShell((s) => s.workspace)
  const pending = useShell((s) => s.pending)
  const hostName = useShell((s) => s.hostName)
  const unity = useShell((s) => !!s.projects.find((p) => p.id === s.openId)?.unity)
  const focus = useShell((s) => s.filesFocus)
  const root = stack[0]
  const dir = stack[stack.length - 1]
  const [tick, setTick] = useState(0)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'names' | 'contents'>('names')
  const [scope, setScope] = useState<string | null>(null)
  const [repo, setRepo] = useState(false)
  const [ops, setOps] = useState<Record<string, { busy: string; name?: string; entry?: DirEntry }>>({})
  const searching = query.trim().length > 0
  const listing = useListing(dir, tick)
  const ignored = useIgnored(root)
  const names = useNames(root, searching && mode === 'names', tick)
  const contents = useContentSearch(root, query, scope, mode === 'contents', tick)
  const scroller = useRef<HTMLDivElement | null>(null)
  const field = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    let alive = true
    window.api.git.isRepo(root).then(
      (ok) => {
        if (alive) setRepo(ok)
      },
      () => {}
    )
    return () => {
      alive = false
    }
  }, [root])
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [dir])
  const reload = (): void => {
    namesByRoot.delete(root)
    setTick((n) => n + 1)
  }
  const op = (path: string, label: string, busy: string, work: () => Promise<unknown>, show: { name?: string; entry?: DirEntry } = {}): void => {
    const drop = (): void =>
      setOps((cur) => {
        const next = { ...cur }
        delete next[path]
        return next
      })
    const done = async (): Promise<void> => {
      await work()
      namesByRoot.delete(root)
      await listing.refresh()
    }
    setOps((cur) => ({ ...cur, [path]: { busy, ...show } }))
    run(`files:${path}`, label, 15, done, { onOk: drop, onFail: drop, pill: show.entry && parentDir(path) !== dir ? busy : undefined })
  }

  const isDim = (e: DirEntry): boolean => isAlwaysDim(e.name) || isTreeIgnored(ignored, relativePath(root, e.path), e.isDirectory)
  const shown = useMemo(() => {
    if (!listing.entries) return null
    const visible = listing.entries.filter((e) => !(!e.isDirectory && isMetaFile(e.name)) && !HIDDEN_DIRS.has(relativePath(root, e.path)))
    const made = Object.values(ops).flatMap((o) => (o.entry && parentDir(o.entry.path) === dir && !visible.some((e) => e.path === o.entry?.path) ? [o.entry] : []))
    return sortByDim([...made, ...visible], isDim)
  }, [listing.entries, ignored, root, ops, dir])
  useEffect(() => {
    if (!focus || !shown?.some((e) => e.path === focus)) return
    const el = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-ws-file]') ?? [])].find((x) => x.dataset.wsFile === focus)
    el?.scrollIntoView({ block: 'center' })
  }, [focus, shown])
  const hits = useMemo(() => (searching && names.names ? rankQuickOpenFiles(query, names.names.names) : []), [searching, query, names.names])

  const opened = {
    onOk: () => {
      haptic('success')
      closeFiles()
    }
  }

  const open = (path: string, how: 'text' | 'asset' | null = null): void => {
    run(`files:${path}`, baseName(path), 20, (req) => call('openFile', path, { mode: how }, req), opened)
  }

  const openAt = (path: string, m?: SearchMatch): void => {
    if (!m) return open(path)
    run(`files:${path}:${m.line}`, `${baseName(path)}:${m.line}`, 20, (req) => call('openFile', path, { line: m.line, column: m.column }, req), opened)
  }

  const findIn = (folder: string): void => {
    setMode('contents')
    setScope(folder === root ? null : folder)
    console.info(`[files] find in ${folder === root ? 'the whole project' : relativePath(root, folder)}`)
    setTimeout(() => field.current?.focus(), 300)
  }

  const history = (entry: DirEntry): void => {
    run(`files:history:${entry.path}`, 'History', 20, (req) => call('showHistory', entry.path, req), { ...opened, pill: 'Opening the history…' })
  }

  const ask = (title: string, initial: string, submit: string, done: (name: string) => void): void => {
    useShell.setState({
      prompt: {
        item: { id: 'files.prompt', label: title, enabled: true, input: { title, initial, submit, placeholder: 'Name' } },
        seq: null,
        onSubmit: (raw) => {
          const name = raw.trim()
          if (!name || name === initial) return
          if (/[\\/]/.test(name)) {
            haptic('error')
            showToast("A name can't contain a slash")
            return
          }
          done(name)
        }
      }
    })
  }

  const create = (folder: string, kind: 'file' | 'folder'): void =>
    ask(kind === 'file' ? 'New File' : 'New Folder', '', 'Create', (name) => {
      const dest = joinPath(folder, name)
      op(dest, kind === 'file' ? 'New file' : 'New folder', 'Creating…', async () => {
        await (kind === 'file' ? window.api.fs.createFile(dest) : window.api.fs.createDir(dest))
        console.info(`[files] created ${kind} ${dest}`)
        if (folder !== dir) filesInto(folder)
      }, { entry: { name, path: dest, isDirectory: kind === 'folder' } })
    })

  const rename = (entry: DirEntry): void =>
    ask('Rename', entry.name, 'Rename', (name) => {
      const dest = joinPath(parentDir(entry.path), name)
      op(entry.path, 'Rename', 'Renaming…', async () => {
        const res = await window.api.fs.rename(entry.path, dest)
        const refused = res ? renameRefusal(res, entry.name, name) : null
        if (refused) throw new Error(refused)
        console.info(`[files] renamed ${entry.path} to ${dest}`)
      }, { name })
    })

  const remove = (entry: DirEntry): void =>
    useShell.setState({
      confirm: {
        origin: 'files',
        id: Date.now(),
        title: `Delete “${entry.name}”?`,
        message: `It goes to the ${getMac(pathHostId())?.kind?.os === 'windows' ? 'Recycle Bin' : 'Trash'} on ${hostName || 'your desktop'}.`,
        confirmLabel: 'Delete',
        danger: true,
        onAnswer: (choice) => {
          if (choice !== 'confirm') return
          op(entry.path, 'Delete', 'Moving to the Trash…', async () => {
            const r = await window.api.fs.trash(entry.path)
            if (r && r.ok === false) throw new Error(r.code === 'locked' ? `Couldn't delete “${entry.name}”: another app is using it.` : `Couldn't delete “${entry.name}”.`)
            console.info(`[files] moved ${entry.path} to the Trash`)
          })
        }
      }
    })

  const menuFor = (entry: DirEntry, siblings: DirEntry[], current: boolean): WireAction[] => {
    const kids = { [parentDir(entry.path)]: siblings }
    const item = (id: string, label: string, icon: string, extra: Partial<WireAction> = {}): WireAction => ({ id, label, icon, enabled: true, ...extra })
    const open: WireAction[] = []
    if (!entry.isDirectory && unity && opensInSaturaWithMeta(entry, root, kids)) open.push(item('tuner', 'Open in Tuner', 'slider.horizontal.3'))
    if (!entry.isDirectory && unity && opensAsUnityAsset(entry, root, kids)) open.push(item('text', 'Open as Text', 'doc.plaintext'))
    const make = entry.isDirectory ? [item('newFile', 'New File', 'doc'), item('newFolder', 'New Folder', 'folder.badge.plus')] : []
    const look = [
      ...(entry.isDirectory ? [item('find', 'Find in Folder', 'doc.text.magnifyingglass')] : []),
      ...(repo && entry.path !== root ? [item('history', entry.isDirectory ? 'Show Folder History' : 'Show File History', 'clock.arrow.circlepath')] : [])
    ]
    const copy = [item('copyPath', 'Copy Path', 'doc.on.doc'), item('copyRel', 'Copy Relative Path', 'doc.on.clipboard')]
    const edit = current ? [] : [...(entry.isDirectory ? [] : [item('duplicate', 'Duplicate', 'plus.square.on.square')]), item('rename', 'Rename', 'pencil'), item('delete', 'Delete', 'trash', { destructive: true })]
    const section = (id: string, children: WireAction[]): WireAction[] => (children.length ? [{ id, label: '', enabled: true, inline: true, children }] : [])
    return [...section('open', open), ...section('make', make), ...section('look', look), ...section('copy', copy), ...section('edit', edit)]
  }

  const showMenu = (entry: DirEntry, siblings: DirEntry[], el: HTMLElement | { x: number; y: number }, current = false): void => {
    const tree = menuFor(entry, siblings, current)
    console.info(`[files] menu for ${entry.path}: ${tree.flatMap((s) => s.children ?? []).map((n) => n.id).join(', ')}`)
    openMenu(tree, entry.name, el, true, (n) => {
      console.info(`[files] ${n.id} ${entry.path}`)
      if (n.id === 'tuner') open(entry.path, 'asset')
      else if (n.id === 'text') open(entry.path, 'text')
      else if (n.id === 'newFile') create(entry.path, 'file')
      else if (n.id === 'newFolder') create(entry.path, 'folder')
      else if (n.id === 'find') setTimeout(() => findIn(entry.path), 250)
      else if (n.id === 'history') history(entry)
      else if (n.id === 'copyPath') copyAbsolutePath(entry.path)
      else if (n.id === 'copyRel') copyRelativePath(root, entry.path)
      else if (n.id === 'duplicate') op(entry.path, 'Duplicate', 'Duplicating…', () => window.api.fs.duplicate(entry.path))
      else if (n.id === 'rename') setTimeout(() => rename(entry), 250)
      else if (n.id === 'delete') setTimeout(() => remove(entry), 250)
    })
  }

  const tap = (entry: DirEntry): void => {
    if (entry.isDirectory) {
      setQuery('')
      filesInto(entry.path)
    } else open(entry.path)
  }

  const title = stack.length > 1 ? baseName(dir) : ws?.project || baseName(root)
  const back = stack.length > 1 ? (stack.length > 2 ? baseName(stack[stack.length - 2]) : ws?.project || baseName(root)) : ws?.title || 'Back'
  const rel = stack.length > 1 ? projectRel(root, dir) : ''
  const here: DirEntry = { name: title, path: dir, isDirectory: true }

  const scopeRel = scope ? projectRel(root, scope) : ''
  let body: ReactNode
  if (searching && mode === 'contents') {
    const seen = contents.files.slice(0, CONTENT_FILES_SHOWN)
    const matches = contents.files.reduce((n, f) => n + f.matches.length, 0)
    const summary = contents.done
      ? `${contents.done.limitHit ? 'First ' : ''}${contents.done.matchCount} ${contents.done.matchCount === 1 ? 'result' : 'results'} in ${contents.done.fileCount} ${contents.done.fileCount === 1 ? 'file' : 'files'}${contents.files.length > seen.length ? ` · ${seen.length} files shown` : ''}`
      : `${matches} ${matches === 1 ? 'result' : 'results'} so far`
    if (contents.error) body = <Failed what="Couldn't search the contents" error={contents.error} onRetry={reload} />
    else if (contents.running && !contents.files.length) body = <Loading label="Searching" />
    else if (!contents.files.length) body = <Note data="empty">No results for “{query.trim()}”{scopeRel ? ` in ${scopeRel}` : ''}</Note>
    else
      body = (
        <div className="flex flex-col gap-3" data-ws-files-contents>
          <div className="flex items-center gap-2 px-1 text-[13px] text-[var(--ws-label2)]" data-ws-files-summary>
            {contents.running && <span className="ws-spin !h-3.5 !w-3.5 !border-2" />}
            {summary}
          </div>
          {seen.map((f) => (
            <ContentFile
              key={f.filePath}
              f={f}
              root={root}
              pending={pending}
              dim={isTreeIgnored(ignored, relativePath(root, f.filePath), false)}
              onOpen={openAt}
              onMenu={(el) => showMenu({ name: baseName(f.filePath), path: f.filePath, isDirectory: false }, [], el)}
            />
          ))}
        </div>
      )
  } else if (searching) {
    if (names.error && !names.names) body = <Failed what="Couldn't load the file list" error={names.error} onRetry={reload} />
    else if (!names.names) body = <Loading label="Searching" />
    else if (!hits.length) body = <Note data="empty">No files match “{query.trim()}”</Note>
    else
      body = (
        <Card>
          {hits.map((r) => {
            const path = joinPath(root, r)
            const slash = r.lastIndexOf('/')
            const entry: DirEntry = { name: r.slice(slash + 1), path, isDirectory: false }
            const siblings = names.names?.metas.has(`${r}.meta`) ? [entry, { name: `${entry.name}.meta`, path: `${path}.meta`, isDirectory: false }] : [entry]
            return (
              <FileRow
                key={r}
                entry={entry}
                detail={slash > 0 ? r.slice(0, slash) : undefined}
                dim={isDim(entry)}
                pending={!!pending[`files:${path}`]}
                onTap={() => tap(entry)}
                onMenu={(el) => showMenu(entry, siblings, el)}
              />
            )
          })}
        </Card>
      )
  } else if (listing.error) body = <Failed what="Couldn't open this folder" error={listing.error} onRetry={reload} />
  else if (!shown) body = <Loading label="Loading" />
  else if (!shown.length) body = <Note data="empty">This folder is empty</Note>
  else
    body = (
      <Card>
        {shown.map((e) => (
          <FileRow key={e.path} entry={ops[e.path]?.name ? { ...e, name: ops[e.path].name as string } : e} busy={ops[e.path]?.busy} dim={isDim(e)} focused={e.path === focus} pending={!!pending[`files:${e.path}`]} onTap={() => tap(e)} onMenu={(el) => showMenu(e, listing.entries ?? [], el)} />
        ))}
      </Card>
    )

  return (
    <div
      className="fixed inset-x-0 z-[45] flex flex-col bg-black"
      style={{ top: view.top, bottom: view.kb, paddingTop: view.safe.t, paddingLeft: view.safe.l, paddingRight: view.safe.r }}
      data-ws-page="Files"
      data-ws-files-dir={dir}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-[980px] flex-1 flex-col">
        <div className="flex h-[52px] shrink-0 items-center gap-1 px-2">
          <button type="button" aria-label={`Back to ${back}`} onClick={filesBack} className="flex h-11 min-w-0 max-w-[60%] items-center gap-0.5 rounded-full pl-1 pr-3 text-[16px] text-[var(--ws-accent)] active:opacity-60" data-ws-files-back>
            <ChevronLeft size={24} strokeWidth={2.4} className="shrink-0" />
            <span className="truncate">{back}</span>
          </button>
          <button
            type="button"
            aria-label="New file or folder"
            onClick={(e) =>
              openMenu([{ id: 'make', label: '', enabled: true, inline: true, children: [{ id: 'newFolder', label: 'New Folder', icon: 'folder.badge.plus', enabled: true }, { id: 'newFile', label: 'New File', icon: 'doc', enabled: true }] }], title, e.currentTarget, true, (n) => {
                console.info(`[files] ${n.id} in ${dir}`)
                create(dir, n.id === 'newFile' ? 'file' : 'folder')
              })
            }
            className="ws-glass ws-press ml-auto flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full"
            data-ws-files-new
          >
            <Plus size={19} strokeWidth={2.6} />
          </button>
          <button
            type="button"
            aria-label="Folder actions"
            onClick={(e) => showMenu(here, [], e.currentTarget, true)}
            className="ws-glass ws-press ml-1.5 flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full"
            data-ws-files-more
          >
            <Ellipsis size={18} strokeWidth={2.6} />
          </button>
        </div>
        <h1 className="truncate px-5 text-[30px] font-bold tracking-tight" data-ws-files-title>
          {title}
        </h1>
        {rel && rel !== title && <p className="truncate px-5 text-[13px] text-[var(--ws-label2)]">{rel}</p>}
        <div className="shrink-0 px-4 pb-2 pt-2.5">
          <label className="flex h-9 items-center gap-2 rounded-[10px] bg-[rgb(118_118_128/0.24)] px-2.5">
            <Search size={16} strokeWidth={2.4} className="shrink-0 text-[var(--ws-label2)]" />
            <input
              ref={field}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={mode === 'names' ? 'Search files by name' : scopeRel ? `Search in ${scopeRel}` : 'Search in file contents'}
              enterKeyHint="search"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="ws-field min-w-0 flex-1 bg-transparent text-[var(--ws-ink)] outline-none"
              style={{ fontSize: 16 }}
              data-ws-files-search
            />
            {query && (
              <button type="button" aria-label="Clear" onClick={() => setQuery('')} className="text-[var(--ws-label2)]">
                <CircleX size={16} strokeWidth={2.4} />
              </button>
            )}
          </label>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 overflow-hidden px-4 pb-3" data-ws-files-modes>
          {(['names', 'contents'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => {
                haptic()
                setMode(m)
              }}
              className={`flex h-[30px] shrink-0 items-center rounded-full px-3 text-[13px] font-semibold ${mode === m ? 'bg-[var(--ws-ink)] text-[#0f0f12]' : 'ws-glass text-[var(--ws-ink)]'}`}
              data-ws-files-mode={m}
            >
              {m === 'names' ? 'Names' : 'Contents'}
            </button>
          ))}
          {mode === 'contents' && scope && (
            <button type="button" onClick={() => setScope(null)} aria-label={`Search the whole project instead of ${scopeRel}`} className="ws-glass flex h-[30px] min-w-0 items-center gap-1 rounded-full pl-3 pr-2 text-[13px] text-[var(--ws-ink)]" data-ws-files-scope={scopeRel}>
              <span className="truncate">In {scopeRel}</span>
              <CircleX size={15} strokeWidth={2.4} className="shrink-0 opacity-60" />
            </button>
          )}
        </div>
        <div ref={scroller} className="ws-scroll min-h-0 flex-1 px-4" style={{ paddingBottom: view.kb ? 12 : Math.max(view.safe.b, 16) }}>
          {body}
        </div>
      </div>
    </div>
  )
}
