import { useAppStore } from '../store'
import { defineHandle, type RendererCtx } from './registry'
import { reportsOfTab } from '../lib/terminal/terminal-reports'
import { useTabInsert } from '../lib/tab-insert'
import { getTerminalInstance } from '../lib/terminal/terminal-registry'
import { dumpCells } from '@shared/remote-term'

defineHandle({
  name: 'terminal.cells',
  side: 'renderer',
  description:
    "Reads a terminal's xterm buffer cell by cell, the way it is drawn: per row the cells as [chars, width, sgr, underline style, underline color, link uri], continuation cells of wide chars included. ptyId picks the terminal (default the first one in the workspace); from and count pick buffer rows (from -2 means the visible screen, -1 the whole buffer). Returns { cols, rows, baseY, length, cursor, lines: [{ y, cells }] }; diff it against the phone's buffer to count cell mismatches.",
  params: { ptyId: '', from: -2, count: 0 },
  run(p, ctx: RendererCtx) {
    const s = useAppStore.getState()
    const tabs = (s.tabsByWorkspace[ctx.workspaceId] ?? []).filter((t) => t.contentType === 'terminal')
    const ptyId = String(p.ptyId || tabs[0]?.ptyId || '')
    const term = getTerminalInstance(ptyId)
    if (!term) throw new Error(`No terminal ${ptyId || 'in this workspace'}`)
    return { ptyId, ...dumpCells(term as never, Number(p.from), Number(p.count)) }
  }
})

defineHandle({
  name: 'terminal.reports',
  side: 'renderer',
  description:
    "Lists the terminals of the project workspace with the reports their agent session created, newest first. Each terminal has ptyId, tabId, label, agent, sessionId and reports (file, title, savedAt), plus segments: how many report segments its merged tab shows in the tab bar right now (null when the terminal's tab bar is hidden).",
  params: {},
  async run(_p, ctx: RendererCtx) {
    const s = useAppStore.getState()
    const worktrees = s.worktreesByWorkspace[ctx.workspaceId] ?? []
    const terminals = (s.tabsByWorkspace[ctx.workspaceId] ?? []).filter((t) => t.contentType === 'terminal')
    const roots = [...new Set(terminals.map((t) => worktrees.find((w) => w.id === t.worktreeId)?.path ?? '').filter(Boolean))]
    const lists = new Map(await Promise.all(roots.map(async (r) => [r, await window.api.app.listReports(r).catch(() => [])] as const)))
    return terminals.map((t) => {
      const root = worktrees.find((w) => w.id === t.worktreeId)?.path ?? ''
      const unit = document.querySelector(`[data-tabbar-group="${t.groupId}"] [data-tab-unit="${t.id}"]`)
      return {
        ptyId: t.ptyId,
        tabId: t.id,
        label: t.customLabel ?? t.generatedLabel ?? t.label,
        agent: t.agentId ?? null,
        sessionId: t.claudeSessionId ?? null,
        reports: reportsOfTab(lists.get(root) ?? [], t).map((r) => ({ file: r.file, title: r.title, savedAt: new Date(r.mtimeMs).toISOString() })),
        segments: unit ? unit.querySelectorAll('[data-seg-kind="report"]').length : null
      }
    })
  }
})

function box(el: Element): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
}

defineHandle({
  name: 'tabbar.structure',
  side: 'renderer',
  description:
    'Reads every tab bar of the workspace as it is drawn: per bar its groupId, active tab and units in order. A unit is a plain tab or a merged terminal tab; a merged unit lists its segments in order (the terminal first, then its reports depth-first) with tabId, kind, label, file, depth, parent (file of the parent report or null), parentTabId, active and the on-screen center and size (x, y, w, h) for mouse drags. overflow is the +N chip of a merged unit that does not fit (hidden tab ids and its position) or null. drag is the insertion point a drag shows right now, or null.',
  params: {},
  run(_p, ctx: RendererCtx) {
    const s = useAppStore.getState()
    const tabs = s.tabsByWorkspace[ctx.workspaceId] ?? []
    const groups = s.groupsByWorkspace[ctx.workspaceId] ?? []
    const root = document.querySelector(`[data-workspace="${ctx.workspaceId}"]`) ?? document
    const bars = Array.from(root.querySelectorAll('[data-tabbar][data-tabbar-group]'))
    const tabInfo = (el: Element) => {
      const id = el.getAttribute('data-tab-id') ?? ''
      const t = tabs.find((x) => x.id === id)
      const parent = el.getAttribute('data-seg-parent') || null
      const parentTab = parent ? Array.from(el.parentElement?.parentElement?.querySelectorAll('[data-seg-file]') ?? []).find((x) => x.getAttribute('data-seg-file') === parent)?.getAttribute('data-seg-tab') ?? null : null
      return {
        tabId: id,
        kind: el.getAttribute('data-seg-kind') ?? t?.contentType ?? 'tab',
        label: el.getAttribute('aria-label') ?? '',
        file: s.viewerFileByTab[id] ?? null,
        depth: Number(el.getAttribute('data-seg-depth') ?? 0),
        parent,
        parentTabId: parentTab,
        active: el.getAttribute('aria-selected') === 'true',
        ...box(el)
      }
    }
    return {
      bars: bars.map((bar) => {
        const groupId = bar.getAttribute('data-tabbar-group') ?? ''
        const g = groups.find((x) => x.id === groupId)
        return {
          groupId,
          activeTabId: g?.activeTabId ?? null,
          order: g?.tabOrder ?? [],
          units: Array.from(bar.querySelectorAll('[data-tab-unit]')).map((u) => {
            const segs = Array.from(u.querySelectorAll('[data-tabbar-tab]')).map(tabInfo)
            const merged = u.hasAttribute('data-tab-merged')
            const chip = u.querySelector('[data-seg-overflow]')
            return merged
              ? { kind: 'merged', headId: u.getAttribute('data-tab-unit'), ...box(u), segments: segs, overflow: chip ? { hidden: (chip.getAttribute('data-seg-overflow') ?? '').split(' ').filter(Boolean), ...box(chip) } : null }
              : { ...segs[0], kind: 'tab', headId: u.getAttribute('data-tab-unit') }
          })
        }
      }),
      drag: useTabInsert.getState().target,
      insertLines: Array.from(document.querySelectorAll('[data-tab-insert]')).map((el) => ({ edge: el.getAttribute('data-tab-insert'), ...box(el) }))
    }
  }
})
