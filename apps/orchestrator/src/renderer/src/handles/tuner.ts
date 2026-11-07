import { defineHandle } from './registry'
import { iconTraceReport, iconTraceStart } from '../lib/tuner/icon-trace'
import { handleTraceStart, handleTraceStop } from '../lib/tuner/handle-trace'

const MAX_ROWS = 80

function attr(root: Element, selector: string, name: string): string | null {
  return root.querySelector(selector)?.getAttribute(name) ?? null
}

function rowPaths(root: Element): string[] {
  const stack: string[] = []
  const out: string[] = []
  for (const el of root.querySelectorAll('[data-scene-hierarchy] [data-row-key]')) {
    const depth = Number(el.getAttribute('data-row-depth') ?? 0)
    stack.length = depth
    stack[depth] = el.getAttribute('data-row-name') ?? ''
    out.push(stack.join('/'))
  }
  return out
}

function canvasViewOf(root: Element): { showing: string; options: string[] } | null {
  const bar = root.querySelector('[data-tuner-canvas-selector]')
  if (!bar) return null
  const sel = bar.getAttribute('data-tuner-canvas-selector') ?? 'scene'
  return { showing: sel === 'scene' ? 'Scene' : sel, options: parse(bar.getAttribute('data-canvas-view-options')) }
}

function pierceOf(): { open: boolean; items: string[] } {
  const menu = document.querySelector('[data-pierce-menu]')
  return { open: !!menu, items: menu ? [...menu.querySelectorAll('[data-pierce-item]')].map((b) => b.getAttribute('data-pierce-item') ?? '') : [] }
}

function parse(json: string | null): string[] {
  try {
    return json ? (JSON.parse(json) as string[]) : []
  } catch {
    return []
  }
}

defineHandle({
  name: 'tuner.state',
  side: 'renderer',
  description:
    'Reads every Tuner panel that is mounted in the window: its tab and view name, whether it is ready (or the state it waits in), edit or play mode, the active selected hierarchy path and every selected path, the inspector target, the hierarchy rows as paths (the first 80 that are drawn, so folded children are missing), the unsaved scenes, prefabs and assets, whether Save is enabled, and the hint line at the bottom, with error: true when that line shows an error. Returns { tuners: [...] }.',
  params: {},
  async run() {
    const tuners = [...document.querySelectorAll('[data-tuner-tab]')].map((root) => {
      const rows = rowPaths(root)
      const save = root.querySelector('[data-tuner-save]') as HTMLButtonElement | null
      const hint = root.querySelector('[data-tuner-hint]')
      const r = root.getBoundingClientRect()
      return {
        tab: root.getAttribute('data-tuner-tab'),
        view: root.getAttribute('data-tuner-view'),
        ready: root.getAttribute('data-tuner-ready') === 'true',
        state: root.getAttribute('data-tuner-state'),
        stateName: root.getAttribute('data-tuner-state-name'),
        stateReason: root.getAttribute('data-tuner-state-reason'),
        content: {
          hierarchy: !!root.querySelector('[data-scene-hierarchy]'),
          inspector: root.querySelectorAll('[data-tuner-inspector-column] *').length,
          inspectorImages: root.querySelectorAll('[data-tuner-inspector-column] img, [data-tuner-inspector-column] canvas').length,
          viewport: !!root.querySelector('[data-tuner-viewport-area]'),
          toolbar: !!root.querySelector('[data-tuner-toolbar]'),
          stateCard: !!root.querySelector('[data-tuner-state-card]')
        },
        canvasView: canvasViewOf(root),
        filteredRows: root.querySelectorAll('[data-canvas-filtered]').length,
        pierce: pierceOf(),
        mode: root.getAttribute('data-tuner-mode'),
        shown: r.width > 0 && r.height > 0,
        selected: attr(root, '[data-scene-hierarchy]', 'data-selected-path'),
        selection: parse(attr(root, '[data-scene-hierarchy]', 'data-selected-paths')),
        inspector: attr(root, '[data-tuner-inspector]', 'data-ti-target'),
        rowCount: Number(attr(root, '[data-scene-hierarchy]', 'data-total-rows') ?? rows.length),
        rows: rows.slice(0, MAX_ROWS),
        unsaved: parse(attr(root, '[data-tuner-unsaved-items]', 'data-tuner-unsaved-items')),
        save: save ? (save.disabled ? 'disabled' : 'enabled') : 'absent',
        hint: hint ? { text: (hint.textContent ?? '').trim(), error: hint.getAttribute('data-tuner-notice') === 'error' } : null
      }
    })
    return { tuners }
  }
})

defineHandle({
  name: 'tuner.canvasView',
  side: 'renderer',
  description:
    "Reads or switches what the scene Tuner's view shows: the scene, or one UI overlay canvas on its own. canvas: null only reads; 'Scene' or '' goes back to the scene; a canvas path or name clicks that option in the selector above the view. Returns showing (the path, or Scene) and the options.",
  params: { canvas: null },
  async run(params) {
    const root = [...document.querySelectorAll('[data-tuner-tab]')].find((r) => r.querySelector('[data-tuner-canvas-selector]') && r.getBoundingClientRect().width > 0)
    if (!root) throw new Error('No shown Tuner has a canvas selector: the scene has no UI overlay canvases, or no scene Tuner is open and live.')
    const want = params.canvas
    if (want == null) return canvasViewOf(root)
    const name = String(want).trim()
    const now = canvasViewOf(root)!
    const target = name === '' || name.toLowerCase() === 'scene' ? '' : now.options.find((p) => p === name) ?? now.options.find((p) => p !== 'Scene' && (p.split('/').pop() ?? '').toLowerCase() === name.toLowerCase())
    if (target === undefined) throw new Error(`No overlay canvas ${name}. Options: ${now.options.join(', ')}`)
    const opener = root.querySelector('[data-canvas-view-button]') as HTMLButtonElement | null
    if (!root.querySelector('[data-canvas-view-menu]')) opener?.click()
    await new Promise((r) => setTimeout(r, 50))
    const btn = root.querySelector(`[data-canvas-view-menu] [data-canvas-view-option="${CSS.escape(target)}"]`) as HTMLButtonElement | null
    btn?.click()
    await new Promise((r) => setTimeout(r, 50))
    return canvasViewOf(root)
  }
})

defineHandle({
  name: 'tuner.handleTrace',
  side: 'renderer',
  description:
    "Traces which transform handle the scene view draws on every frame it paints. start begins a trace; stop ends it and returns the frames in order: seq, the selected path, whether it is a RectTransform, and kind (rect for the rect tool, move, rotate or scale for the 3D handle, none when no handle is drawn).",
  params: { op: 'start' },
  run(params) {
    if (params.op !== 'stop') {
      handleTraceStart()
      return { tracing: true }
    }
    return { frames: handleTraceStop() }
  }
})

defineHandle({
  name: 'tuner.viewProbe',
  side: 'renderer',
  description:
    "Reads the shown scene Tuner's view as drawn right now: the Unity frame seq, the gesture in progress, the selection, the move handle point, the rect tool frame and, for every selected object, its RectTransform or renderer rect values from Unity (anchoredPosition, sizeDelta, Z rotation, scale), its screen box from those values, the box of the selection outline pixels Unity drew around it in the frame (accent coloured) and off, the outline box minus the object box (left, top, right, bottom; a few px outward when the outline sits on the object). spot also resolves a press point in viewport px: 'gizmo:<axis|plane|ring|scale>:<n>', 'rect:move', 'rect:pivot', 'rect:resize:x,y' or 'rect:rotate:x,y' with x, y in 0..2, or 'x,y'. seq: true only returns the frame seq and the viewport origin.",
  params: { spot: '', seq: false },
  async run(params) {
    const el = [...document.querySelectorAll('[data-scene-viewport]')].find((v) => v.getBoundingClientRect().width > 0 && v.checkVisibility({ visibilityProperty: true })) as
      | (HTMLElement & { __motion?: { probe?: (o: { spot?: string; seq?: boolean }) => Promise<unknown> } })
      | undefined
    if (!el?.__motion?.probe) throw new Error('No scene Tuner view is shown.')
    return el.__motion.probe({ spot: params.spot ? String(params.spot) : undefined, seq: params.seq === true })
  }
})

defineHandle({
  name: 'tuner.iconLock',
  side: 'renderer',
  description:
    "Measures how well the scene view icons stay on their objects. start begins a trace; stop ends it and compares, for every Unity frame painted, the icon drawn over the scene with a magenta marker that Unity rendered at the object (pure magenta, unlit, in the scene). Returns frame count, how many frames carried icon positions and object poses, the icon-to-marker screen error in px (p50, p95, max), the same error for the move gizmo of the selected object (select the marker's object first), and with probe (an object path, or its end) the error of that object's pose as the overlay knows it, how many frames old the icon positions were (p50, p95), and the last samples.",
  params: { op: 'start', probe: '' },
  run(params) {
    if (params.op !== 'stop') {
      iconTraceStart(String(params.probe ?? ''))
      return { tracing: true }
    }
    return iconTraceReport()
  }
})
