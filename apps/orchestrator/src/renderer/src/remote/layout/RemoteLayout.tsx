import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ImageOff, Laptop, LoaderCircle } from 'lucide-react'
import type { RvLayout } from '@shared/remote-video'
import type { Tab } from '@shared/types'
import { getAgentLabel } from '@shared/agent-catalog'
import { primaryWorldId } from '@shared/unity/ids'
import { useAppStore } from '../../store'
import { collectGroupIds } from '../../lib/tab-tree'
import { tabDisplayLabel } from '../../lib/tab-label'
import { agentRunStatusFor, detectAgentStatusFromTitle, stripAgentStatusGlyph, type AgentRunStatus } from '../../lib/agent-status'
import { ensureProject, useStatusDot } from '../../lib/unity/world-store'
import { AgentIcon } from '../../lib/agent-icon'
import { panelKind } from '../../components/workbench/PanelIcon'
import { StatusDot } from '../../components/workspace/WorkspaceAgentsBadge'
import { linkOpen, onLayout, onLinkOpen, onTile, restartVideo, sendVideo, videoTrouble } from '../video/link'
import { macShownTab, noteMacLayout, noteMacSeen, useMacOrderVersion } from './mac-order'
import { usePanelDrag, type Drop } from './panel-drag'
import { runMirrored } from '../mirror'
import { flipPlay, flipSnapshot } from '../motion'
import { isHeldTab, useRestorePrompts } from '../restore-prompts'
import './layout.css'

interface Shot {
  url: string
  at: number
}

type Previews = 'waiting' | 'live' | 'off'

const FADE_MS = 400
const THUMB = 72
const TILE_OVERSAMPLE = 4
const PREVIEW_WAIT_MS = 10_000
const TAB_TILE = 'tab:'
const PICTURE_KINDS = new Set<Tab['contentType']>(['unity-instance-player', 'tuner', 'unity-scratchpad'])
const AGENT_WORD: Record<AgentRunStatus, string> = { working: 'working', 'needs-input': 'needs you', idle: 'idle' }
const tabShots = new Map<string, Shot>()
const tabShotListeners = new Set<() => void>()
const scrollByWorkspace = new Map<string, number>()
let lastLayout: RvLayout | null = null

function keepTabShot(tabId: string, shot: Shot): void {
  const prev = tabShots.get(tabId)
  tabShots.set(tabId, shot)
  noteMacSeen(tabId)
  if (prev) setTimeout(() => URL.revokeObjectURL(prev.url), FADE_MS * 3)
  for (const l of tabShotListeners) l()
}

function useTabShots(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const on = (): void => setN((x) => x + 1)
    tabShotListeners.add(on)
    return () => {
      tabShotListeners.delete(on)
    }
  }, [])
  return n
}

function usePreviews(): { previews: Previews; retry: () => void } {
  const start = useRef(Date.now())
  const openAt = useRef<number | null>(null)
  const [previews, setPreviews] = useState<Previews>('waiting')
  const check = useRef((): void => {})
  check.current = (): void => {
    const now = Date.now()
    if (!linkOpen()) {
      if (openAt.current !== null) start.current = now
      openAt.current = null
    } else if (openAt.current === null) openAt.current = now
    const from = Math.max(start.current, openAt.current ?? 0)
    setPreviews(now - from < PREVIEW_WAIT_MS ? 'waiting' : openAt.current !== null ? 'live' : 'off')
  }
  useEffect(() => {
    check.current()
    const t = setInterval(() => check.current(), 1000)
    const off = onLinkOpen(() => {
      openAt.current = Date.now()
      check.current()
    })
    return () => {
      clearInterval(t)
      off()
    }
  }, [])
  useEffect(() => {
    console.log(`[layout] previews ${previews}${previews === 'off' ? `: ${videoTrouble()}` : ''}`)
  }, [previews])
  const retry = (): void => {
    start.current = Date.now()
    openAt.current = null
    setPreviews('waiting')
    restartVideo('the phone asked for panel previews again')
  }
  return { previews, retry }
}

function Shots({ shot, anchor }: { shot: Shot; anchor: string }) {
  const [layers, setLayers] = useState<Shot[]>([shot])
  useEffect(() => {
    setLayers((prev) => (prev[prev.length - 1]?.url === shot.url ? prev : [...prev.slice(-1), shot]))
    const t = setTimeout(() => setLayers((prev) => prev.slice(-1)), FADE_MS + 50)
    return () => clearTimeout(t)
  }, [shot])
  return (
    <>
      {layers.map((l, i) => (
        <img
          key={l.url}
          src={l.url}
          alt=""
          draggable={false}
          className="remote-panels-shot"
          style={{ objectPosition: anchor, animation: i === layers.length - 1 && layers.length > 1 ? `remote-panels-fade ${FADE_MS}ms ease-out` : undefined }}
        />
      ))}
    </>
  )
}

function KindIcon({ tab, file }: { tab: Tab; file?: string }) {
  if (tab.agentId) return <AgentIcon id={tab.agentId} className="h-7 w-7" />
  const Icon = panelKind(tab, file).icon
  return <Icon size={26} strokeWidth={1.75} aria-hidden />
}

function Thumb({ tab, file, shot, loading }: { tab: Tab; file?: string; shot: Shot | undefined; loading: boolean }) {
  return (
    <span className="remote-panels-thumb relative flex shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-elevated text-ink-3" style={{ width: THUMB, height: THUMB }}>
      {shot ? <Shots shot={shot} anchor={PICTURE_KINDS.has(tab.contentType) ? 'center' : 'left top'} /> : loading ? <LoaderCircle size={20} className="animate-spin" aria-label="Loading the preview" /> : <KindIcon tab={tab} file={file} />}
    </span>
  )
}

function Line({ text, state, warn, status }: { text: string; state?: string; warn?: boolean; status?: AgentRunStatus | null }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-tight text-ink-3" data-remote-panels-line>
      {status && status !== 'idle' && <StatusDot status={status} />}
      <span className="truncate">
        {text}
        {state && <span className={warn ? 'text-warn' : undefined}> · {state}</span>}
      </span>
    </span>
  )
}

function UnityLine({ tab, root, kind }: { tab: Tab; root: string; kind: string }) {
  useEffect(() => {
    if (root) ensureProject(root)
  }, [root])
  const dot = useStatusDot(root, primaryWorldId(root), tab.ptyId)
  return <Line text={kind} state={dot.tone === 'emerald' ? 'playing' : dot.label.toLowerCase()} />
}

function PanelLine({ tab, title, file, root }: { tab: Tab; title: string; file?: string; root: string }) {
  const s = useAppStore(
    useShallow((st) => ({ exited: st.exitedPtyIds.includes(tab.ptyId), hook: st.agentHookStatusByPty[tab.ptyId], dirty: !!file && file in st.draftsByPath }))
  )
  const held = useRestorePrompts((st) => Object.values(st.prompts).some((p) => isHeldTab(p, tab)))
  const kind = panelKind(tab, file).name
  if (tab.contentType === 'unity-instance-player') return <UnityLine tab={tab} root={root} kind={kind} />
  if (tab.contentType === 'terminal') {
    const agent = !!tab.agentId || !!detectAgentStatusFromTitle(tab.generatedLabel)
    if (held) return <Line text={tab.agentId ? getAgentLabel(tab.agentId) : kind} state={AGENT_WORD['needs-input']} status="needs-input" />
    if (s.exited) return <Line text={tab.agentId ? getAgentLabel(tab.agentId) : kind} state="exited" />
    if (!agent) return title === kind ? null : <Line text={kind} />
    const status = agentRunStatusFor(tab, false, s.hook)
    return <Line text={tab.agentId ? getAgentLabel(tab.agentId) : kind} state={AGENT_WORD[status]} status={status} />
  }
  if (s.dirty) return <Line text={kind} state="unsaved changes" warn />
  return title.toLowerCase() === kind.toLowerCase() ? null : <Line text={kind} />
}

function PaneGlyph({ layout, id }: { layout: RvLayout; id: string }) {
  const W = 24
  const H = 16
  const pad = 2.5
  const iw = W - pad * 2
  const ih = H - pad * 2
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" aria-hidden data-remote-panels-glyph>
      <rect x={0.75} y={0.75} width={W - 1.5} height={H - 1.5} rx={3} fill="none" stroke="currentColor" strokeWidth={1.5} opacity={0.55} />
      {layout.groups.map((g) => (
        <rect
          key={g.id}
          x={pad + g.x * iw + 0.5}
          y={pad + g.y * ih + 0.5}
          width={Math.max(1, g.w * iw - 1)}
          height={Math.max(1, g.h * ih - 1)}
          rx={1}
          fill={g.id === id ? 'var(--accent)' : 'currentColor'}
          opacity={g.id === id ? 1 : 0.25}
        />
      ))}
    </svg>
  )
}

function EmptyWorkspace() {
  return (
    <div className="flex h-full items-center justify-center px-8 text-center text-[15px] text-ink-3" data-remote-panels-empty>
      No panels are open in this workspace
    </div>
  )
}

export function RemoteLayout({ workspaceId, onOpenTab }: { workspaceId: string; onOpenTab: (tabId: string) => void }) {
  const listRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<RvLayout | null>(lastLayout)
  const { previews, retry } = usePreviews()
  useTabShots()
  useMacOrderVersion()
  const { tabs, groups, tree, viewerFileByTab, worktrees, ws } = useAppStore(
    useShallow((s) => ({
      tabs: s.tabsByWorkspace[workspaceId] ?? [],
      groups: s.groupsByWorkspace[workspaceId] ?? [],
      tree: s.layoutByWorkspace[workspaceId],
      viewerFileByTab: s.viewerFileByTab,
      worktrees: s.worktreesByWorkspace[workspaceId],
      ws: s.workspaces.find((w) => w.id === workspaceId)
    }))
  )
  const groupsRef = useRef(groups)
  groupsRef.current = groups

  const order = useMemo(() => {
    const ids = collectGroupIds(tree)
    const all = [...ids, ...groups.map((g) => g.id).filter((id) => !ids.includes(id))]
    return all.filter((id) => groups.some((g) => g.id === id && g.tabOrder.length > 0))
  }, [tree, groups])

  const tabsOf = (gid: string): Tab[] => {
    const g = groups.find((x) => x.id === gid)
    return g ? g.tabOrder.map((id) => tabs.find((t) => t.id === id)).filter((t): t is Tab => !!t) : []
  }
  const label = (t: Tab): string => {
    const l = tabDisplayLabel(t, viewerFileByTab)
    return t.agentId ? stripAgentStatusGlyph(l) : l
  }
  const rootOf = (t: Tab): string => (worktrees ?? []).find((w) => w.id === t.worktreeId)?.path ?? ws?.worktreePath ?? ws?.folderPath ?? ''

  const sections = order.map((gid) => {
    const active = groups.find((x) => x.id === gid)?.activeTabId ?? null
    const onScreen = !!layout?.groups.some((g) => g.id === gid)
    const shown = macShownTab(gid, active)
    return { gid, shown, onScreen, tabs: tabsOf(gid) }
  })
  const names = order.map((_, i) => `Group ${i + 1}`)
  const settle = useRef<Map<string, DOMRect> | null>(null)
  const drag = usePanelDrag(
    listRef,
    sections.map((s) => ({ gid: s.gid, ids: s.tabs.map((t) => t.id) })),
    (d: Drop) => {
      const name = (gid: string): string => names[order.indexOf(gid)] ?? gid
      const t = tabs.find((x) => x.id === d.tabId)
      settle.current = flipSnapshot(listRef.current)
      console.log(`[layout] drop ${t ? label(t) : d.tabId} from ${name(d.from)} into ${name(d.gid)} at ${d.index}${d.before ? ` before ${d.before.slice(0, 8)}` : ' at the end'}`)
      return runMirrored('moveTab', [d.tabId, d.gid, d.before ?? undefined]).then(
        () => console.log(`[layout] the desktop moved ${d.tabId.slice(0, 8)} into ${name(d.gid)}`),
        (e: Error) => console.log(`[layout] the desktop didn't move ${d.tabId.slice(0, 8)}: ${e.message}`)
      )
    }
  )

  useLayoutEffect(() => {
    if (drag.dragging || !settle.current) return
    const moved = flipPlay(listRef.current, settle.current)
    settle.current = null
    if (moved) console.log(`[layout] ${moved} rows and headers glide to the new layout`)
  })

  useEffect(() => {
    const dpr = window.devicePixelRatio || 1
    const side = Math.round(THUMB * dpr * TILE_OVERSAMPLE)
    const announce = (): void => {
      if (linkOpen()) sendVideo({ t: 'layout', on: true, tile: { w: side, h: side } })
    }
    const offOpen = onLinkOpen(announce)
    const offLayout = onLayout((l) => {
      lastLayout = l
      noteMacLayout(l)
      setLayout(l)
    })
    const offTile = onTile((id, jpeg) => {
      const url = URL.createObjectURL(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }))
      const shot = { url, at: Date.now() }
      if (id.startsWith(TAB_TILE)) {
        const tabId = id.slice(TAB_TILE.length)
        keepTabShot(tabId, shot)
        console.log(`[layout] last seen frame for tab ${tabId.slice(0, 8)} ${Math.round(jpeg.byteLength / 1024)} KB`)
        return
      }
      const g = groupsRef.current.find((x) => x.id === id)
      const shownId = macShownTab(id, g?.activeTabId ?? null)
      if (shownId) keepTabShot(shownId, shot)
      else URL.revokeObjectURL(url)
      console.log(`[layout] tile ${id.slice(0, 8)} ${Math.round(jpeg.byteLength / 1024)} KB tab=${shownId?.slice(0, 8) ?? '-'}`)
    })
    announce()
    return () => {
      offOpen()
      offLayout()
      offTile()
      if (linkOpen()) sendVideo({ t: 'layout', on: false })
    }
  }, [])

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = scrollByWorkspace.get(workspaceId) ?? 0
    const onScroll = (): void => {
      scrollByWorkspace.set(workspaceId, el.scrollTop)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [workspaceId, order.length > 0])

  const thumbOf = (t: Tab, shown: string | null): { shot: Shot | undefined; loading: boolean } => {
    const shot = tabShots.get(t.id)
    return { shot, loading: !shot && t.id === shown && previews === 'waiting' }
  }

  const lastReport = useRef('')
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const rows = sections.flatMap((s) => s.tabs.map((t) => thumbOf(t, s.shown)))
    const count = (f: (r: { shot: Shot | undefined; loading: boolean }) => boolean): number => rows.filter(f).length
    const row = el.querySelector<HTMLElement>('[data-remote-panels-row]')?.getBoundingClientRect()
    const line = `${el.clientWidth > el.clientHeight ? 'landscape' : 'portrait'} ${el.clientWidth}x${el.clientHeight}: ${sections.length} panes (${names.join(', ')}), ${rows.length} panels; ${count((r) => !!r.shot)} previews, ${count((r) => !r.shot && !r.loading)} icons, ${count((r) => r.loading)} loading; row ${row ? `${Math.round(row.width)}x${Math.round(row.height)}` : '-'}`
    if (line === lastReport.current) return
    lastReport.current = line
    console.log(`[layout] list ${line}`)
  })

  if (!order.length) return <EmptyWorkspace />

  const open = (t: Tab, pane: string): void => {
    console.log(`[layout] open ${label(t)} from ${pane}`)
    onOpenTab(t.id)
  }

  return (
    <div ref={listRef} className="remote-panels h-full overflow-y-auto" data-remote-panels>
      {previews === 'off' && (
        <div className="mx-4 mt-3 flex items-center gap-3 rounded-[12px] border border-warn/30 bg-warn/10 py-1.5 pl-3 pr-1.5" data-remote-panels-previews="off">
          <ImageOff size={17} className="shrink-0 text-warn" />
          <span className="min-w-0 flex-1 text-[13px] leading-snug text-ink">No previews: {videoTrouble()}</span>
          <button type="button" onClick={retry} className="h-11 shrink-0 rounded-[10px] bg-white/10 px-3.5 text-[14px] font-semibold text-ink active:opacity-70" data-remote-panels-retry>
            Try again
          </button>
        </div>
      )}
      {sections.map((s, i) => (
        <section key={s.gid} data-remote-panels-pane={s.gid} data-drop-target={drag.dragging && drag.target === s.gid ? '' : undefined}>
          {sections.length > 1 && (
            <h2 className="sticky top-0 z-[1] flex items-center gap-2 bg-canvas px-4 pb-1.5 pt-3 text-[13px] font-semibold text-ink-2" data-remote-panels-pane-name={names[i]} data-flip={`group:${s.gid}`} style={drag.headerStyle(s.gid)}>
              {layout && s.onScreen && <PaneGlyph layout={layout} id={s.gid} />}
              <span className="truncate">{names[i]}</span>
            </h2>
          )}
          <div className="remote-panels-rows">
            {s.tabs.map((t) => {
              const title = label(t)
              const file = viewerFileByTab[t.id]
              const { shot, loading } = thumbOf(t, s.shown)
              const onMac = s.onScreen && t.id === s.shown
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => open(t, names[i])}
                  style={drag.rowStyle(t.id)}
                  data-dragging={drag.dragging === t.id ? '' : undefined}
                  data-flip={t.id}
                  className="remote-panels-row flex w-full min-w-0 items-center gap-3 px-4 py-1.5 text-left"
                  data-remote-panels-row={t.id}
                  data-thumb={shot ? 'preview' : loading ? 'loading' : 'icon'}
                  data-on-mac={onMac ? '' : undefined}
                >
                  <Thumb tab={t} file={file} shot={shot} loading={loading} />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-[16px] leading-tight text-ink">{title}</span>
                    <PanelLine tab={t} title={title} file={file} root={rootOf(t)} />
                  </span>
                  {onMac && <Laptop size={15} className="shrink-0 text-ink-3" aria-label="On the desktop screen now" />}
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
