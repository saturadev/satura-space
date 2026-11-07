export interface PhoneAction {
  id: string
  label: string
  icon: string
  group: string
  enabled: boolean
  checked?: boolean
  hint?: string
  primary?: boolean
  run: () => void
}

interface KeySpec {
  id: string
  label: string
  icon: string
  group: string
  hint: string
  key: string
  code: string
  meta?: boolean
  shift?: boolean
  target: 'viewport' | 'hierarchy' | 'tuner'
  primary?: boolean
  selection?: boolean
}

const KEYS: KeySpec[] = [
  { id: 'undo', label: 'Undo', icon: 'arrow.uturn.backward', group: 'Edit', hint: '⌘Z', key: 'z', code: 'KeyZ', meta: true, target: 'viewport', primary: true },
  { id: 'redo', label: 'Redo', icon: 'arrow.uturn.forward', group: 'Edit', hint: '⇧⌘Z', key: 'z', code: 'KeyZ', meta: true, shift: true, target: 'viewport', primary: true },
  { id: 'duplicate', label: 'Duplicate', icon: 'plus.square.on.square', group: 'Edit', hint: '⌘D', key: 'd', code: 'KeyD', meta: true, target: 'hierarchy', selection: true },
  { id: 'delete', label: 'Delete', icon: 'trash', group: 'Edit', hint: '⌫', key: 'Delete', code: 'Delete', target: 'hierarchy', selection: true },
  { id: 'rename', label: 'Rename', icon: 'pencil', group: 'Edit', hint: 'F2', key: 'F2', code: 'F2', target: 'hierarchy', selection: true },
  { id: 'new-object', label: 'New empty object', icon: 'plus', group: 'Edit', hint: '⇧⌘N', key: 'N', code: 'KeyN', meta: true, shift: true, target: 'hierarchy' },
  { id: 'search', label: 'Search hierarchy', icon: 'magnifyingglass', group: 'Edit', hint: '⌘F', key: 'f', code: 'KeyF', meta: true, target: 'hierarchy' },
  { id: 'tool-move', label: 'Move tool', icon: 'arrow.up.and.down.and.arrow.left.and.right', group: 'Tools', hint: 'W', key: 'w', code: 'KeyW', target: 'tuner' },
  { id: 'tool-rotate', label: 'Rotate tool', icon: 'arrow.triangle.2.circlepath', group: 'Tools', hint: 'E', key: 'e', code: 'KeyE', target: 'tuner' },
  { id: 'tool-scale', label: 'Scale tool', icon: 'arrow.up.left.and.arrow.down.right', group: 'Tools', hint: 'R', key: 'r', code: 'KeyR', target: 'tuner' },
  { id: 'tool-rect', label: 'Rect tool', icon: 'rectangle.dashed', group: 'Tools', hint: 'T', key: 't', code: 'KeyT', target: 'tuner' },
  { id: 'space', label: 'Toggle global / local', icon: 'globe', group: 'Tools', hint: 'X', key: 'x', code: 'KeyX', target: 'tuner' },
  { id: 'pivot', label: 'Toggle pivot / center', icon: 'scope', group: 'Tools', hint: 'Z', key: 'z', code: 'KeyZ', target: 'tuner' },
  { id: 'frame', label: 'Frame selected', icon: 'viewfinder', group: 'View', hint: 'F', key: 'f', code: 'KeyF', target: 'tuner', selection: true },
  { id: 'align-view', label: 'Move to view', icon: 'camera.viewfinder', group: 'View', hint: '⇧⌘F', key: 'F', code: 'KeyF', meta: true, shift: true, target: 'tuner', selection: true },
  { id: 'planar', label: 'Toggle 2D view', icon: 'square', group: 'View', hint: '2', key: '2', code: 'Digit2', target: 'tuner' },
  { id: 'state-prev', label: 'Previous state', icon: 'chevron.left', group: 'View', hint: '[', key: '[', code: 'BracketLeft', target: 'tuner' },
  { id: 'state-next', label: 'Next state', icon: 'chevron.right', group: 'View', hint: ']', key: ']', code: 'BracketRight', target: 'tuner' },
  { id: 'ask', label: 'Ask Drift', icon: 'bubble.left', group: 'Agent', hint: '/', key: '/', code: 'Slash', target: 'tuner' },
  { id: 'save', label: 'Save', icon: 'checkmark', group: 'Changes', hint: '⌘S', key: 's', code: 'KeyS', meta: true, target: 'tuner', primary: true }
]

const TOOLBAR_GROUPS: [RegExp, string, string][] = [
  [/lighting/i, 'View', 'lightbulb'],
  [/grid/i, 'View', 'grid'],
  [/camera settings/i, 'View', 'video'],
  [/gizmos menu/i, 'Gizmos', 'list.bullet'],
  [/gizmo/i, 'Gizmos', 'cube.transparent'],
  [/choose which effects/i, 'Effects', 'list.bullet'],
  [/effects/i, 'Effects', 'sparkles'],
  [/animation timeline|animation/i, 'Panels', 'timeline.selection'],
  [/discard|revert|put .* back|reset/i, 'Changes', 'arrow.uturn.backward.circle'],
  [/copy changes/i, 'Changes', 'doc.on.doc'],
  [/unity target|main project|scratchpad/i, 'Target', 'shippingbox']
]

const SKIP = /^(move|rotate|scale|rect tool|frame selected|handle at|handle space|switch to a flat 2d|ask drift)/i

function keyTarget(root: HTMLElement, t: KeySpec['target']): HTMLElement | null {
  if (t === 'hierarchy') return root.querySelector<HTMLElement>('[data-tuner-hierarchy-pane] .overflow-y-auto[tabindex="0"]') ?? root.querySelector<HTMLElement>('[data-tuner-hierarchy-pane] [tabindex="0"]')
  const canvas = root.querySelector<HTMLElement>('canvas[data-unity-session]')
  const vp = canvas?.parentElement ?? null
  if (t === 'viewport') return vp
  return vp ?? root.querySelector<HTMLElement>('[data-tuner-mode]')
}

function press(root: HTMLElement, k: KeySpec): void {
  const el = keyTarget(root, k.target)
  if (!el) {
    console.warn(`[tuner] action ${k.id}: no ${k.target} to send ${k.hint} to`)
    return
  }
  el.focus({ preventScroll: true })
  const init: KeyboardEventInit = { key: k.key, code: k.code, metaKey: !!k.meta, ctrlKey: !!k.meta, shiftKey: !!k.shift, bubbles: true, cancelable: true }
  el.dispatchEvent(new KeyboardEvent('keydown', init))
  el.dispatchEvent(new KeyboardEvent('keyup', init))
  console.log(`[tuner] action ${k.id} -> ${k.hint} on ${k.target}`)
}

function tipOf(el: HTMLElement): string {
  return (el.getAttribute('data-ti-tip') || el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim()
}

const NAMES: [RegExp, string][] = [
  [/scene lighting/i, 'Scene lighting'],
  [/visibility of the grid/i, 'Grid'],
  [/visibility of all gizmos/i, 'Gizmos'],
  [/^gizmos menu/i, 'Gizmo options…'],
  [/choose which effects/i, 'Scene effects…'],
  [/scene effects are/i, 'Scene effects'],
  [/scene camera settings/i, 'Camera settings…'],
  [/show the animation timeline/i, 'Show animation timeline'],
  [/hide the animation timeline/i, 'Hide animation timeline'],
  [/put (every changed|the) scene object/i, 'Revert all changes'],
  [/^reset settings/i, 'Reset view settings']
]

function shortLabel(tip: string): string {
  const named = NAMES.find(([re]) => re.test(tip))
  if (named) return named[1]
  const cut = tip.split(/[.(:]/)[0].trim()
  return cut.length > 32 ? `${cut.slice(0, 31)}…` : cut
}

function isOn(el: HTMLElement): boolean | undefined {
  const p = el.getAttribute('aria-pressed')
  if (p === 'true') return true
  if (p === 'false') return false
  return /\bbg-sky-500\/20\b|\btext-sky-200\b/.test(el.className) ? true : undefined
}

export function tunerActions(root: HTMLElement | null): PhoneAction[] {
  if (!root) return []
  const live = !!root.querySelector('[data-tuner-mode]')
  const selected = Number(root.querySelector('[data-selected-count]')?.getAttribute('data-selected-count') ?? 0) > 0
  const out: PhoneAction[] = KEYS.map((k) => ({
    id: k.id,
    label: k.label,
    icon: k.icon,
    group: k.group,
    hint: k.hint,
    primary: k.primary,
    enabled: live && !!keyTarget(root, k.target) && (!k.selection || selected),
    run: () => press(root, k)
  }))
  const seen = new Set<string>()
  for (const el of root.querySelectorAll<HTMLElement>('[data-tuner-toolbar] button, [data-tuner-footer] button')) {
    const tip = tipOf(el)
    if (!tip || SKIP.test(tip)) continue
    if (el.hasAttribute('data-tuner-save')) continue
    const label = el.hasAttribute('data-tuner-discard') ? 'Revert' : shortLabel(tip)
    const id = `ui:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    if (seen.has(id)) continue
    seen.add(id)
    const g = TOOLBAR_GROUPS.find(([re]) => re.test(tip))
    const revert = el.hasAttribute('data-tuner-discard')
    out.push({
      id,
      label,
      icon: revert ? 'arrow.uturn.backward.circle' : g?.[2] ?? 'circle',
      group: revert ? 'Changes' : g?.[1] ?? 'More',
      enabled: !(el as HTMLButtonElement).disabled,
      checked: isOn(el),
      primary: revert,
      run: () => {
        console.log(`[tuner] action ${id} -> click`)
        el.click()
      }
    })
  }
  return out
}
