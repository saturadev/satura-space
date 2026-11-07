import { useAppStore } from '../store'
import { useWorldStore } from '../lib/unity/world-store'
import { primaryWorldId } from '../lib/unity/instance-ids'
import { getSessionStatus } from '../lib/unity/session-status'
import { getUnityLifecycle } from '../lib/unity/lifecycle-store'
import { defineHandle, type RendererCtx } from './registry'

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

defineHandle({
  name: 'unity.pane',
  side: 'renderer',
  description:
    'Reads what the Unity Player panel of the project shows right now: whether it is mounted and shown, its text, the state the panel draws (data-unity-* markers), the session status the start call left, the Unity lifecycle record the window last got (phase, seq, error) and the editor lifecycle from the world stream. click presses the panel button whose label starts with it first, like Retry or Install in Unity Hub. Returns one entry per Unity Player tab of the project.',
  params: { click: '' },
  async run(p, ctx: RendererCtx) {
    const s = useAppStore.getState()
    const ws = ctx.workspaceId
    const root = ctx.projectRoot
    const worktrees = s.worktreesByWorkspace[ws] ?? []
    const tabs = (s.tabsByWorkspace[ws] ?? []).filter((t) => t.contentType === 'unity-instance-player')
    const world = useWorldStore.getState().worlds
    return tabs.map((tab) => {
      const path = worktrees.find((w) => w.id === tab.worktreeId)?.path ?? root
      const key = Object.keys(world).find((k) => norm(k) === norm(path)) ?? path
      const inst = world[key]?.observed.instances[primaryWorldId(key)]
      const group = (s.groupsByWorkspace[ws] ?? []).find((g) => g.id === tab.groupId)
      const pane = group && group.activeTabId === tab.id ? document.querySelector(`[data-group-id="${CSS.escape(group.id)}"]`) : null
      const want = String(p.click ?? '').trim().toLowerCase()
      let clicked: string | null = null
      if (want && pane) {
        const button = [...pane.querySelectorAll('button')].find((b) => text(b).toLowerCase().startsWith(want)) as HTMLButtonElement | undefined
        if (!button) throw new Error(`The Unity panel has no button "${String(p.click)}". Its buttons: ${[...pane.querySelectorAll('button')].map((b) => text(b)).filter((t) => t).join(', ')}`)
        button.click()
        clicked = text(button)
      }
      const life = getUnityLifecycle(path)
      const markers: Record<string, string> = {}
      for (const el of pane?.querySelectorAll('[data-unity-hub], [data-unity-note], [data-unity-editor], [data-unity-state-card]') ?? []) {
        for (const a of ['data-unity-hub', 'data-unity-note', 'data-unity-editor', 'data-unity-state-card']) {
          const v = el.getAttribute(a)
          if (v !== null && !(a in markers)) markers[a] = v
        }
      }
      return {
        tab: tab.id,
        ptyId: tab.ptyId,
        project: path,
        shown: !!group && group.activeTabId === tab.id && !group.hidden,
        mounted: !!pane,
        text: text(pane),
        markers,
        clicked,
        session: getSessionStatus(tab.ptyId),
        life: life ? { state: life.state, stage: life.stage, code: life.code, actions: life.actions, phase: life.phase, seq: life.seq, version: life.version, install: life.install, hub: life.hub, pid: life.pid, gen: life.gen, error: life.error } : null,
        lifecycle: inst?.lifecycle ?? null,
        compile: inst?.compile ?? null,
        error: inst?.error ?? null
      }
    })
  }
})
