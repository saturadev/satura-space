import {
  TUNER_INSPECTOR_MAX_WIDTH,
  TUNER_INSPECTOR_MIN_WIDTH,
  type TunerInspectTarget,
  type TunerInspectorInput
} from '@shared/tuner-inspector'

const MAX_TEXT = 16_384
const MAX_PSC = 262_144

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function clampTunerInspectorWidth(w: unknown): number {
  const n = Math.round(num(w, 360))
  return Math.max(TUNER_INSPECTOR_MIN_WIDTH, Math.min(TUNER_INSPECTOR_MAX_WIDTH, n))
}

export function tunerInspectorTargetArgs(t: TunerInspectTarget): Record<string, unknown> {
  if (t.kind === 'asset')
    return {
      kind: 'asset',
      path: t.path,
      restrict: false,
      hasFields: Array.isArray(t.fields),
      fields: t.fields ?? [],
      exclude: t.exclude ?? []
    }
  const out: Record<string, unknown> = { kind: 'object', path: t.path, scene: t.scene ?? '', restrict: !!t.components }
  if (t.components)
    out.components = t.components.map((c) => ({
      type: c.type,
      index: c.index ?? 0,
      hasFields: Array.isArray(c.fields),
      fields: c.fields ?? [],
      exclude: c.exclude ?? []
    }))
  else out.exclude = t.exclude ?? []
  if (t.at?.length) out.at = t.at
  if (t.targets?.length) out.targets = t.targets.map((x) => ({ path: x.path, scene: x.scene ?? '', at: x.at ?? [] }))
  return out
}

export function tunerInspectorInputArgs(input: TunerInspectorInput): Record<string, unknown> | string {
  if (!input || typeof input !== 'object') return 'Invalid input'
  const mods = (m: unknown): Record<string, boolean> => {
    const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
    return { shift: o.shift === true, ctrl: o.ctrl === true, alt: o.alt === true, cmd: o.cmd === true }
  }
  switch (input.op) {
    case 'mouse':
      if (!['down', 'up', 'drag', 'move'].includes(input.type)) return 'Invalid mouse event'
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) return 'Invalid mouse position'
      return {
        op: 'mouse',
        type: input.type,
        x: input.x,
        y: input.y,
        button: Math.max(0, Math.min(2, Math.round(num(input.button)))),
        clicks: Math.max(1, Math.min(3, Math.round(num(input.clicks, 1)))),
        dx: num(input.dx),
        dy: num(input.dy),
        ...mods(input.mods)
      }
    case 'wheel':
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) return 'Invalid wheel position'
      return { op: 'wheel', x: input.x, y: input.y, dx: num(input.dx), dy: num(input.dy), ...mods(input.mods) }
    case 'key':
      if (input.type !== 'down' && input.type !== 'up') return 'Invalid key event'
      if (typeof input.key !== 'string' || input.key.length > 32) return 'Invalid key'
      return {
        op: 'key',
        type: input.type,
        key: input.key,
        character: typeof input.char === 'string' ? input.char.slice(0, 2) : '',
        ...mods(input.mods)
      }
    case 'text':
      if (!Number.isInteger(input.control) || typeof input.value !== 'string') return 'Invalid text input'
      if (!['enter', 'tab', 'shiftTab', 'blur', 'live'].includes(input.commit)) return 'Invalid text commit'
      return { op: 'text', control: input.control, value: input.value.slice(0, MAX_TEXT), commit: input.commit }
    case 'textCancel':
    case 'undo':
    case 'redo':
    case 'leave':
      return { op: input.op }
    case 'hover':
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) return 'Invalid hover position'
      return { op: 'hover', x: input.x, y: input.y, ...mods(input.mods) }
    case 'uitk':
      if (typeof input.section !== 'string' || input.section.length > 256) return 'Invalid section'
      return { op: 'uitk', section: input.section, value: JSON.stringify(input.data ?? null).slice(0, MAX_TEXT) }
    case 'psCurves':
      if (typeof input.section !== 'string' || input.section.length > 256) return 'Invalid section'
      if (!input.data || typeof input.data !== 'object' || !['select', 'set', 'scalar'].includes(input.data.cmd)) return 'Invalid particle curves command'
      {
        const value = JSON.stringify(input.data)
        if (value.length > MAX_PSC) return 'Particle curves command is too large'
        return { op: 'psCurves', section: input.section, value }
      }
    case 'popupFit':
      if (typeof input.section !== 'string' || input.section.length > 256) return 'Invalid section'
      if (!Number.isFinite(input.h) || input.h < 0) return 'Invalid popup height'
      return { op: 'popupFit', section: input.section, y: Math.min(4000, input.h) }
    case 'popup':
      if (!Number.isInteger(input.id)) return 'Invalid popup id'
      if (!['change', 'commit', 'cancel'].includes(input.action)) return 'Invalid popup action'
      return {
        op: 'popup',
        id: input.id,
        action: input.action,
        value: input.value === undefined ? '' : JSON.stringify(input.value).slice(0, MAX_TEXT)
      }
    default:
      return 'Unknown input'
  }
}
