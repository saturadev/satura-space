export const RC_DIR = 'ProjectSettings/SaturaRemote'
export const RC_GENERATED_FILE = 'controls.generated.json'
export const RC_OVERRIDES_FILE = 'controls.overrides.json'
export const RC_GENERATED_FORMAT = 'satura-remote-controls'
export const RC_OVERRIDES_FORMAT = 'satura-remote-overrides'

export type RcKind = 'stick' | 'axis' | 'button' | 'pointer'
export type RcBehavior = 'press' | 'hold' | 'tap' | 'multiTap' | 'toggle'
export type RcDrive = 'keyboard' | 'gamepad'
export type RcStickSide = 'left' | 'right' | 'dpad'
export type RcPadButton =
  | 'buttonSouth'
  | 'buttonEast'
  | 'buttonWest'
  | 'buttonNorth'
  | 'leftShoulder'
  | 'rightShoulder'
  | 'start'
  | 'select'
  | 'leftStickPress'
  | 'rightStickPress'
  | 'dpadUp'
  | 'dpadDown'
  | 'dpadLeft'
  | 'dpadRight'

export type RcOutput =
  | { type: 'keys'; up?: string; down?: string; left?: string; right?: string }
  | { type: 'keys'; negative?: string; positive?: string }
  | { type: 'key'; key: string }
  | { type: 'chord'; keys: string[] }
  | { type: 'mouse'; button: number }
  | { type: 'wheel'; dir: 1 | -1 }
  | { type: 'mouseDelta' }
  | { type: 'mousePosition' }
  | { type: 'scroll' }
  | { type: 'gamepad'; stick: RcStickSide }
  | { type: 'gamepad'; button: RcPadButton }
  | { type: 'gamepad'; trigger: 'left' | 'right' }

export interface RcAlternative {
  binding: string
  bindingText: string
  output: RcOutput
}

export interface RcGenControl {
  id: string
  action: string
  path: string
  actionType: string
  controlType: string
  kind: RcKind
  visible: boolean
  binding: string
  bindingText: string
  output: RcOutput | null
  behavior: RcBehavior
  holdMs?: number
  taps?: number
  tapMs?: number
  interactions?: string
  alternatives: RcAlternative[]
  gamepad: RcOutput | null
  gamepadBinding: string
  unavailable?: string
  label?: string
  hidden?: string
  joined?: string
}

export interface RcGenMap {
  id: string
  name: string
  asset: string
  ui: boolean
  controls: RcGenControl[]
}

export interface RcGenAsset {
  path: string
  name: string
  projectWide: boolean
  scheme: string
  players: string[]
}

export interface RcGenerated {
  format: typeof RC_GENERATED_FORMAT
  version: 1
  note?: string
  inputSystem: boolean
  defaultMap: string
  defaultMapReason: string
  assets: RcGenAsset[]
  maps: RcGenMap[]
}

export interface RcPlace {
  x?: number
  y?: number
  size?: number
}

export interface RcControlOverride {
  action?: string
  visible?: boolean
  label?: string
  behavior?: RcBehavior
  holdMs?: number
  taps?: number
  binding?: string
  output?: RcOutput
  drive?: RcDrive
  landscape?: RcPlace
  portrait?: RcPlace
}

export interface RcExtraControl {
  id: string
  map?: string
  label: string
  kind?: RcKind
  output: RcOutput
  behavior?: RcBehavior
  visible?: boolean
  landscape?: RcPlace
  portrait?: RcPlace
}

export interface RcTrackpad {
  speed?: number
  lookSpeed?: number
  acceleration?: number
  invertY?: boolean
  naturalScroll?: boolean
}

export interface RcOverrides {
  format?: typeof RC_OVERRIDES_FORMAT
  version?: 1
  defaultMap?: string
  drive?: RcDrive
  trackpad?: RcTrackpad
  controls?: Record<string, RcControlOverride>
  extra?: RcExtraControl[]
}

export type RcIssueLevel = 'stale' | 'error' | 'warn'

export interface RcIssue {
  level: RcIssueLevel
  where: string
  id?: string
  message: string
}

export interface RcControl {
  id: string
  map: string
  action: string
  path: string
  kind: RcKind
  label: string
  hint: string
  visible: boolean
  output: RcOutput | null
  drive: RcDrive
  behavior: RcBehavior
  holdMs: number
  taps: number
  tapMs: number
  landscape: RcPlace | null
  portrait: RcPlace | null
  gamepad: RcOutput | null
  alternatives: RcAlternative[]
  extra: boolean
  note: string
  joined: string
  overridden: string[]
}

export interface RcMap {
  id: string
  name: string
  asset: string
  ui: boolean
  controls: RcControl[]
}

export interface RcTrackpadEff {
  speed: number
  lookSpeed: number
  acceleration: number
  invertY: boolean
  naturalScroll: boolean
}

export interface RcEffective {
  ok: boolean
  inputSystem: boolean
  defaultMap: string
  defaultMapReason: string
  gamepadModule: boolean
  trackpad: RcTrackpadEff
  maps: RcMap[]
  issues: RcIssue[]
}

export interface RcEnv {
  gamepadModule: boolean
}

export const RC_KEYS: readonly string[] = (
  'Space Enter Tab Backquote Quote Semicolon Comma Period Slash Backslash LeftBracket RightBracket Minus Equals A B C D E F G H I J K L M N O P Q R S T U V W X Y Z ' +
  'Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0 LeftShift RightShift LeftAlt RightAlt AltGr LeftCtrl RightCtrl LeftMeta RightMeta LeftWindows RightWindows ' +
  'LeftApple RightApple LeftCommand RightCommand ContextMenu Escape LeftArrow RightArrow UpArrow DownArrow Backspace PageDown PageUp Home End Insert Delete CapsLock NumLock PrintScreen ' +
  'ScrollLock Pause NumpadEnter NumpadDivide NumpadMultiply NumpadPlus NumpadMinus NumpadPeriod NumpadEquals Numpad0 Numpad1 Numpad2 Numpad3 Numpad4 Numpad5 Numpad6 Numpad7 Numpad8 ' +
  'Numpad9 F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12 OEM1 OEM2 OEM3 OEM4 OEM5 F13 F14 F15 F16 F17 F18 F19 F20 F21 F22 F23 F24 MediaPlayPause MediaRewind MediaForward'
).split(' ')

const KEY_SET = new Set(RC_KEYS)
export const RC_PAD_BUTTONS: readonly RcPadButton[] = ['buttonSouth', 'buttonEast', 'buttonWest', 'buttonNorth', 'leftShoulder', 'rightShoulder', 'start', 'select', 'leftStickPress', 'rightStickPress', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight']
export const RC_PAD_WIRE: Record<RcPadButton, string> = {
  buttonSouth: 'South',
  buttonEast: 'East',
  buttonWest: 'West',
  buttonNorth: 'North',
  leftShoulder: 'LeftShoulder',
  rightShoulder: 'RightShoulder',
  start: 'Start',
  select: 'Select',
  leftStickPress: 'LeftStickPress',
  rightStickPress: 'RightStickPress',
  dpadUp: 'DpadUp',
  dpadDown: 'DpadDown',
  dpadLeft: 'DpadLeft',
  dpadRight: 'DpadRight'
}
const BEHAVIORS: readonly RcBehavior[] = ['press', 'hold', 'tap', 'multiTap', 'toggle']
const KINDS: readonly RcKind[] = ['stick', 'axis', 'button', 'pointer']
const DEFAULT_TRACKPAD: RcTrackpadEff = { speed: 1, lookSpeed: 1, acceleration: 1, invertY: false, naturalScroll: true }

const KEY_SHORT: Record<string, string> = {
  LeftShift: 'Shift',
  RightShift: 'R Shift',
  LeftCtrl: 'Ctrl',
  RightCtrl: 'R Ctrl',
  LeftAlt: 'Alt',
  RightAlt: 'R Alt',
  LeftMeta: 'Cmd',
  RightMeta: 'R Cmd',
  LeftCommand: 'Cmd',
  RightCommand: 'R Cmd',
  Escape: 'Esc',
  Enter: 'Enter',
  Backspace: 'Bksp',
  UpArrow: '↑',
  DownArrow: '↓',
  LeftArrow: '←',
  RightArrow: '→',
  Space: 'Space',
  Tab: 'Tab',
  Backquote: '`',
  Quote: "'",
  Semicolon: ';',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  LeftBracket: '[',
  RightBracket: ']',
  Minus: '-',
  Equals: '='
}
const MOUSE_SHORT = ['LMB', 'RMB', 'MMB', 'Back', 'Fwd']
const PAD_SHORT: Record<string, string> = {
  buttonSouth: 'A',
  buttonEast: 'B',
  buttonWest: 'X',
  buttonNorth: 'Y',
  leftShoulder: 'LB',
  rightShoulder: 'RB',
  start: 'Start',
  select: 'Select',
  leftStickPress: 'L3',
  rightStickPress: 'R3',
  dpadUp: 'D↑',
  dpadDown: 'D↓',
  dpadLeft: 'D←',
  dpadRight: 'D→'
}

export function keyLabel(key: string): string {
  if (KEY_SHORT[key]) return KEY_SHORT[key]
  if (/^Digit\d$/.test(key)) return key.slice(5)
  if (/^Numpad\d$/.test(key)) return `Num ${key.slice(6)}`
  return key
}

export function outputHint(o: RcOutput | null): string {
  if (!o) return ''
  switch (o.type) {
    case 'keys': {
      if ('up' in o || 'down' in o || 'left' in o || 'right' in o) {
        const k = o as { up?: string; down?: string; left?: string; right?: string }
        const s = [k.up, k.left, k.down, k.right].join(',')
        if (s === 'W,A,S,D') return 'WASD'
        if (s === 'UpArrow,LeftArrow,DownArrow,RightArrow') return 'Arrows'
        return [k.up, k.left, k.down, k.right].map((x) => (x ? keyLabel(x) : '·')).join(' ')
      }
      const a = o as { negative?: string; positive?: string }
      return `${a.negative ? keyLabel(a.negative) : '·'} / ${a.positive ? keyLabel(a.positive) : '·'}`
    }
    case 'key':
      return keyLabel(o.key)
    case 'chord':
      return o.keys.map(keyLabel).join('+')
    case 'mouse':
      return MOUSE_SHORT[o.button] ?? `Mouse ${o.button}`
    case 'wheel':
      return o.dir > 0 ? 'Wheel ↑' : 'Wheel ↓'
    case 'mouseDelta':
      return 'Trackpad'
    case 'mousePosition':
      return 'Cursor'
    case 'scroll':
      return 'Two-finger scroll'
    case 'gamepad':
      if ('stick' in o) return o.stick === 'left' ? 'Left stick' : o.stick === 'right' ? 'Right stick' : 'D-pad'
      if ('trigger' in o) return o.trigger === 'left' ? 'LT' : 'RT'
      return PAD_SHORT[o.button] ?? o.button
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function badKey(k: unknown): boolean {
  return typeof k !== 'string' || !KEY_SET.has(k)
}

export function checkOutput(raw: unknown): { output: RcOutput | null; error: string | null } {
  if (!isObj(raw)) return { output: null, error: 'output must be an object with a type' }
  const t = raw.type
  if (t === 'key') return badKey(raw.key) ? { output: null, error: `unknown key "${String(raw.key)}" (Input System Key names, like Space, W, LeftShift, Digit1)` } : { output: { type: 'key', key: raw.key as string }, error: null }
  if (t === 'chord') {
    const keys = Array.isArray(raw.keys) ? raw.keys : []
    if (keys.length < 2 || keys.length > 3) return { output: null, error: 'chord takes 2 or 3 keys' }
    const bad = keys.find(badKey)
    if (bad !== undefined) return { output: null, error: `unknown key "${String(bad)}"` }
    return { output: { type: 'chord', keys: keys as string[] }, error: null }
  }
  if (t === 'keys') {
    const dirs = ['up', 'down', 'left', 'right'].filter((d) => d in raw)
    const axis = ['negative', 'positive'].filter((d) => d in raw)
    if (dirs.length && axis.length) return { output: null, error: 'keys takes up/down/left/right for a stick or negative/positive for an axis, not both' }
    const names = dirs.length ? dirs : axis
    if (!names.length) return { output: null, error: 'keys needs up/down/left/right or negative/positive' }
    const out: Record<string, string> = {}
    for (const n of names) {
      if (badKey(raw[n])) return { output: null, error: `unknown key "${String(raw[n])}" for ${n}` }
      out[n] = raw[n] as string
    }
    return { output: { type: 'keys', ...out } as RcOutput, error: null }
  }
  if (t === 'mouse') {
    const b = raw.button
    return typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 4 ? { output: { type: 'mouse', button: b }, error: null } : { output: null, error: 'mouse button is 0 (left), 1 (right), 2 (middle), 3 (back) or 4 (forward)' }
  }
  if (t === 'wheel') return raw.dir === 1 || raw.dir === -1 ? { output: { type: 'wheel', dir: raw.dir }, error: null } : { output: null, error: 'wheel dir is 1 or -1' }
  if (t === 'mouseDelta' || t === 'mousePosition' || t === 'scroll') return { output: { type: t }, error: null }
  if (t === 'gamepad') {
    if ('stick' in raw) return raw.stick === 'left' || raw.stick === 'right' || raw.stick === 'dpad' ? { output: { type: 'gamepad', stick: raw.stick }, error: null } : { output: null, error: 'gamepad stick is left, right or dpad' }
    if ('trigger' in raw) return raw.trigger === 'left' || raw.trigger === 'right' ? { output: { type: 'gamepad', trigger: raw.trigger }, error: null } : { output: null, error: 'gamepad trigger is left or right' }
    if ('button' in raw) return (RC_PAD_BUTTONS as readonly unknown[]).includes(raw.button) ? { output: { type: 'gamepad', button: raw.button as RcPadButton }, error: null } : { output: null, error: `gamepad button is one of ${RC_PAD_BUTTONS.join(', ')}` }
    return { output: null, error: 'gamepad output needs stick, trigger or button' }
  }
  return { output: null, error: `unknown output type "${String(t)}"` }
}

export function kindOfOutput(o: RcOutput): RcKind {
  if (o.type === 'keys') return 'left' in o || 'right' in o || 'up' in o || 'down' in o ? 'stick' : 'axis'
  if (o.type === 'mouseDelta' || o.type === 'mousePosition' || o.type === 'scroll') return 'pointer'
  if (o.type === 'gamepad' && 'stick' in o) return 'stick'
  return 'button'
}

function placeOf(raw: unknown, where: string, issues: RcIssue[]): RcPlace | null {
  if (raw === undefined) return null
  if (!isObj(raw)) {
    issues.push({ level: 'error', where, message: 'a placement is { x, y, size } with x and y from 0 to 1' })
    return null
  }
  const out: RcPlace = {}
  for (const k of ['x', 'y'] as const) {
    const v = raw[k]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) issues.push({ level: 'error', where: `${where}.${k}`, message: `${k} is a number from 0 to 1` })
    else out[k] = v
  }
  if (raw.size !== undefined) {
    const v = raw.size
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.4 || v > 3) issues.push({ level: 'error', where: `${where}.size`, message: 'size is a number from 0.4 to 3' })
    else out.size = v
  }
  for (const k of Object.keys(raw)) if (k !== 'x' && k !== 'y' && k !== 'size') issues.push({ level: 'warn', where: `${where}.${k}`, message: `unknown field "${k}"` })
  return out
}

function mergePlace(a: RcPlace | null, b: RcPlace | null): RcPlace | null {
  if (!a) return b
  if (!b) return a
  return { ...a, ...b }
}

function num(v: unknown, lo: number, hi: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined
}

const CONTROL_FIELDS = new Set(['action', 'visible', 'label', 'behavior', 'holdMs', 'taps', 'binding', 'output', 'drive', 'landscape', 'portrait'])
const TOP_FIELDS = new Set(['format', 'version', 'note', 'defaultMap', 'drive', 'trackpad', 'controls', 'extra'])

function genControl(c: RcGenControl, map: RcGenMap, gamepadModule: boolean, drive: RcDrive): RcControl {
  let output = c.output
  let used: RcDrive = 'keyboard'
  let note = c.unavailable ?? c.hidden ?? ''
  if (drive === 'gamepad' && c.gamepad) {
    if (gamepadModule) {
      output = c.gamepad
      used = 'gamepad'
    } else if (!output) note = 'Needs the Satura Remote gamepad module in the project for its gamepad binding'
  }
  return {
    id: c.id,
    map: map.id,
    action: c.action,
    path: c.path,
    kind: output ? kindOfOutput(output) : c.kind,
    label: c.label ?? c.action,
    hint: outputHint(output),
    visible: c.visible && !!output,
    output,
    drive: used,
    behavior: c.behavior,
    holdMs: c.holdMs ?? 0,
    taps: c.taps ?? 2,
    tapMs: c.tapMs ?? 60,
    landscape: null,
    portrait: null,
    gamepad: c.gamepad,
    alternatives: c.alternatives ?? [],
    extra: false,
    note,
    joined: c.joined ?? '',
    overridden: []
  }
}

export function resolveControls(generated: RcGenerated | null, overridesRaw: unknown, env: RcEnv): RcEffective {
  const issues: RcIssue[] = []
  const eff: RcEffective = {
    ok: !!generated,
    inputSystem: generated?.inputSystem ?? false,
    defaultMap: generated?.defaultMap ?? '',
    defaultMapReason: generated?.defaultMapReason ?? '',
    gamepadModule: env.gamepadModule,
    trackpad: { ...DEFAULT_TRACKPAD },
    maps: [],
    issues
  }
  if (!generated) {
    issues.push({ level: 'error', where: RC_GENERATED_FILE, message: 'There is no generated controls file yet. The editor writes it when it imports the Input System assets; remote.controls.regenerate writes it now.' })
    return eff
  }
  const ov: RcOverrides = isObj(overridesRaw) ? (overridesRaw as RcOverrides) : {}
  if (overridesRaw !== null && overridesRaw !== undefined && !isObj(overridesRaw)) issues.push({ level: 'error', where: RC_OVERRIDES_FILE, message: 'The overrides file must hold one JSON object.' })
  for (const k of Object.keys(ov)) if (!TOP_FIELDS.has(k)) issues.push({ level: 'warn', where: k, message: `unknown field "${k}"` })
  if (ov.format !== undefined && ov.format !== RC_OVERRIDES_FORMAT) issues.push({ level: 'warn', where: 'format', message: `format is "${RC_OVERRIDES_FORMAT}"` })

  let drive: RcDrive = 'keyboard'
  if (ov.drive !== undefined) {
    if (ov.drive !== 'keyboard' && ov.drive !== 'gamepad') issues.push({ level: 'error', where: 'drive', message: 'drive is "keyboard" or "gamepad"' })
    else drive = ov.drive
  }
  if (drive === 'gamepad' && !env.gamepadModule) issues.push({ level: 'warn', where: 'drive', message: 'drive is "gamepad" but the Satura Remote gamepad module is not in the project, so controls stay on keyboard and mouse. remote.controls.gamepadModule turns it on.' })

  if (ov.trackpad !== undefined) {
    if (!isObj(ov.trackpad)) issues.push({ level: 'error', where: 'trackpad', message: 'trackpad is an object' })
    else {
      const t = ov.trackpad as Record<string, unknown>
      const set = (k: 'speed' | 'lookSpeed' | 'acceleration', lo: number, hi: number): void => {
        if (t[k] === undefined) return
        const v = num(t[k], lo, hi)
        if (v === undefined) issues.push({ level: 'error', where: `trackpad.${k}`, message: `${k} is a number from ${lo} to ${hi}` })
        else eff.trackpad[k] = v
      }
      set('speed', 0.1, 8)
      set('lookSpeed', 0.1, 8)
      set('acceleration', 0, 3)
      for (const k of ['invertY', 'naturalScroll'] as const) {
        if (t[k] === undefined) continue
        if (typeof t[k] !== 'boolean') issues.push({ level: 'error', where: `trackpad.${k}`, message: `${k} is true or false` })
        else eff.trackpad[k] = t[k] as boolean
      }
      for (const k of Object.keys(t)) if (!['speed', 'lookSpeed', 'acceleration', 'invertY', 'naturalScroll'].includes(k)) issues.push({ level: 'warn', where: `trackpad.${k}`, message: `unknown field "${k}"` })
    }
  }

  const byId = new Map<string, { c: RcGenControl; map: RcGenMap }>()
  const byPath = new Map<string, string>()
  for (const m of generated.maps)
    for (const c of m.controls) {
      byId.set(c.id, { c, map: m })
      byPath.set(c.path, c.id)
    }

  const maps: RcMap[] = generated.maps.map((m) => ({ id: m.id, name: m.name, asset: m.asset, ui: m.ui, controls: m.controls.map((c) => genControl(c, m, env.gamepadModule, drive)) }))
  const effById = new Map<string, RcControl>()
  for (const m of maps) for (const c of m.controls) effById.set(c.id, c)

  if (ov.defaultMap !== undefined) {
    const want = String(ov.defaultMap)
    const hit = generated.maps.find((m) => m.id === want) ?? generated.maps.find((m) => m.name === want) ?? generated.maps.find((m) => `${m.asset}#${m.name}` === want)
    if (!hit) issues.push({ level: 'stale', where: 'defaultMap', message: `defaultMap "${want}" is not an action map in the generated layout (maps: ${generated.maps.map((m) => m.name).join(', ') || 'none'}); the generated default stays` })
    else {
      eff.defaultMap = hit.id
      eff.defaultMapReason = 'overrides defaultMap'
    }
  }

  const controls = ov.controls
  if (controls !== undefined && !isObj(controls)) issues.push({ level: 'error', where: 'controls', message: 'controls is an object keyed by action id' })
  if (isObj(controls)) {
    for (const [id, rawO] of Object.entries(controls)) {
      const where = `controls.${id}`
      const hit = byId.get(id)
      const o = isObj(rawO) ? (rawO as RcControlOverride) : null
      if (!hit) {
        const was = o && typeof o.action === 'string' ? o.action : ''
        const now = was ? byPath.get(was) : undefined
        issues.push({
          level: 'stale',
          where,
          id,
          message: `No action with id ${id} in the Input System assets${was ? ` (it was ${was})` : ''}; this override does nothing.${now ? ` An action with that path now has id ${now}: move the override to that key if it is the same action.` : ''}`
        })
        continue
      }
      if (!o) {
        issues.push({ level: 'error', where, id, message: 'an override is an object' })
        continue
      }
      const c = effById.get(id)!
      const gen = hit.c
      for (const k of Object.keys(o)) if (!CONTROL_FIELDS.has(k)) issues.push({ level: 'warn', where: `${where}.${k}`, id, message: `unknown field "${k}"` })
      if (typeof o.action === 'string' && o.action !== gen.path) issues.push({ level: 'warn', where: `${where}.action`, id, message: `written for ${o.action}, the action is now ${gen.path}; the override still applies because the id matches` })
      const touched: string[] = []
      if (o.binding !== undefined) {
        const alt = gen.alternatives.find((a) => a.binding === o.binding)
        if (o.binding === gen.binding && gen.output) {
          touched.push('binding')
        } else if (!alt) {
          issues.push({ level: 'stale', where: `${where}.binding`, id, message: `binding ${String(o.binding)} is not a keyboard or mouse binding of ${gen.path} any more (bindings: ${[gen.binding, ...gen.alternatives.map((a) => a.binding)].filter(Boolean).join(', ') || 'none'})` })
        } else {
          c.output = alt.output
          c.kind = kindOfOutput(alt.output)
          c.hint = outputHint(alt.output)
          c.visible = gen.visible || c.visible
          c.note = ''
          touched.push('binding')
        }
      }
      if (o.output !== undefined) {
        const r = checkOutput(o.output)
        if (r.error) issues.push({ level: 'error', where: `${where}.output`, id, message: r.error })
        else if (r.output) {
          if (r.output.type === 'gamepad' && !env.gamepadModule) {
            issues.push({ level: 'warn', where: `${where}.output`, id, message: 'a gamepad output needs the Satura Remote gamepad module in the project; the control keeps its keyboard and mouse output' })
            c.note = 'Needs the Satura Remote gamepad module in the project'
          } else {
            c.output = r.output
            c.kind = kindOfOutput(r.output)
            c.hint = outputHint(r.output)
            c.drive = r.output.type === 'gamepad' ? 'gamepad' : 'keyboard'
            c.visible = gen.visible || c.visible
            c.note = ''
            touched.push('output')
          }
        }
      }
      if (o.drive !== undefined && o.output === undefined) {
        if (o.drive !== 'keyboard' && o.drive !== 'gamepad') issues.push({ level: 'error', where: `${where}.drive`, id, message: 'drive is "keyboard" or "gamepad"' })
        else if (o.drive === 'gamepad') {
          if (!gen.gamepad) issues.push({ level: 'stale', where: `${where}.drive`, id, message: `${gen.path} has no gamepad binding to drive` })
          else if (!env.gamepadModule) {
            issues.push({ level: 'warn', where: `${where}.drive`, id, message: 'drive "gamepad" needs the Satura Remote gamepad module in the project; the control stays on keyboard and mouse' })
            c.note = 'Needs the Satura Remote gamepad module in the project'
          } else {
            c.output = gen.gamepad
            c.kind = kindOfOutput(gen.gamepad)
            c.hint = outputHint(gen.gamepad)
            c.drive = 'gamepad'
            c.visible = gen.visible
            c.note = ''
            touched.push('drive')
          }
        } else if (c.drive === 'gamepad') {
          c.output = gen.output
          c.kind = gen.output ? kindOfOutput(gen.output) : gen.kind
          c.hint = outputHint(gen.output)
          c.drive = 'keyboard'
          c.note = gen.unavailable ?? ''
          touched.push('drive')
        }
      }
      if (o.label !== undefined) {
        if (typeof o.label !== 'string' || !o.label.trim() || o.label.length > 40) issues.push({ level: 'error', where: `${where}.label`, id, message: 'label is a string of 1 to 40 characters' })
        else {
          c.label = o.label.trim()
          touched.push('label')
        }
      }
      if (o.behavior !== undefined) {
        if (!BEHAVIORS.includes(o.behavior)) issues.push({ level: 'error', where: `${where}.behavior`, id, message: `behavior is one of ${BEHAVIORS.join(', ')}` })
        else if (c.kind !== 'button') issues.push({ level: 'warn', where: `${where}.behavior`, id, message: `behavior only applies to buttons; this is a ${c.kind}` })
        else {
          c.behavior = o.behavior
          touched.push('behavior')
        }
      }
      if (o.holdMs !== undefined) {
        const v = num(o.holdMs, 0, 10000)
        if (v === undefined) issues.push({ level: 'error', where: `${where}.holdMs`, id, message: 'holdMs is a number from 0 to 10000' })
        else {
          c.holdMs = v
          touched.push('holdMs')
        }
      }
      if (o.taps !== undefined) {
        const v = num(o.taps, 1, 6)
        if (v === undefined || !Number.isInteger(v)) issues.push({ level: 'error', where: `${where}.taps`, id, message: 'taps is a whole number from 1 to 6' })
        else {
          c.taps = v
          touched.push('taps')
        }
      }
      if (o.visible !== undefined) {
        if (typeof o.visible !== 'boolean') issues.push({ level: 'error', where: `${where}.visible`, id, message: 'visible is true or false' })
        else {
          if (o.visible && !c.output) issues.push({ level: 'warn', where: `${where}.visible`, id, message: `${gen.path} has nothing to press on keyboard or mouse${c.note ? ` (${c.note})` : ''}, so it stays hidden` })
          c.visible = o.visible && !!c.output
          if (c.visible) c.note = ''
          touched.push('visible')
        }
      }
      const l = placeOf(o.landscape, `${where}.landscape`, issues)
      const p = placeOf(o.portrait, `${where}.portrait`, issues)
      if (l) {
        c.landscape = l
        touched.push('landscape')
      }
      if (p) {
        c.portrait = p
        touched.push('portrait')
      }
      c.overridden = touched
    }
  }

  const extra = ov.extra
  if (extra !== undefined && !Array.isArray(extra)) issues.push({ level: 'error', where: 'extra', message: 'extra is a list of controls' })
  if (Array.isArray(extra)) {
    const seen = new Set<string>()
    extra.forEach((raw, i) => {
      const where = `extra[${i}]`
      if (!isObj(raw)) {
        issues.push({ level: 'error', where, message: 'an extra control is an object' })
        return
      }
      const x = raw as unknown as RcExtraControl
      if (typeof x.id !== 'string' || !x.id || seen.has(x.id) || byId.has(x.id)) {
        issues.push({ level: 'error', where: `${where}.id`, message: 'id is a unique string that is not an action id' })
        return
      }
      seen.add(x.id)
      const r = checkOutput(x.output)
      if (r.error || !r.output) {
        issues.push({ level: 'error', where: `${where}.output`, id: x.id, message: r.error ?? 'output is missing' })
        return
      }
      if (r.output.type === 'gamepad' && !env.gamepadModule) {
        issues.push({ level: 'warn', where: `${where}.output`, id: x.id, message: 'a gamepad output needs the Satura Remote gamepad module in the project; this control stays hidden' })
        return
      }
      const mapId = x.map === undefined || x.map === '*' ? '*' : String(x.map)
      const targets = mapId === '*' ? maps : maps.filter((m) => m.id === mapId || m.name === mapId)
      if (!targets.length) {
        issues.push({ level: 'stale', where: `${where}.map`, id: x.id, message: `map "${mapId}" is not an action map in the generated layout` })
        return
      }
      const kind = x.kind && KINDS.includes(x.kind) ? x.kind : kindOfOutput(r.output)
      const behavior = x.behavior && BEHAVIORS.includes(x.behavior) ? x.behavior : 'press'
      const l = placeOf(x.landscape, `${where}.landscape`, issues)
      const p = placeOf(x.portrait, `${where}.portrait`, issues)
      const label = typeof x.label === 'string' && x.label.trim() ? x.label.trim().slice(0, 40) : outputHint(r.output)
      for (const m of targets)
        m.controls.push({
          id: x.id,
          map: m.id,
          action: '',
          path: '',
          kind,
          label,
          hint: outputHint(r.output),
          visible: x.visible !== false,
          output: r.output,
          drive: r.output.type === 'gamepad' ? 'gamepad' : 'keyboard',
          behavior,
          holdMs: 0,
          taps: 2,
          tapMs: 60,
          landscape: l,
          portrait: p,
          gamepad: null,
          alternatives: [],
          extra: true,
          note: '',
          joined: '',
          overridden: ['extra']
        })
    })
  }

  eff.maps = maps
  return eff
}

export function visibleMaps(eff: RcEffective, enabled: string[] | null): RcMap[] {
  const on = enabled ? eff.maps.filter((m) => enabled.includes(m.id)) : []
  const play = on.filter((m) => !m.ui)
  if (play.length) return play
  const def = eff.maps.find((m) => m.id === eff.defaultMap)
  return def ? [def] : eff.maps.slice(0, 1)
}

export type RcPatch =
  | { kind: 'control'; id: string; set: Partial<Record<keyof RcControlOverride, unknown>>; action?: string }
  | { kind: 'trackpad'; set: Partial<Record<keyof RcTrackpad, unknown>> }
  | { kind: 'resetLayout' }
  | { kind: 'resetControl'; id: string }

const PHONE_CONTROL_FIELDS = new Set(['visible', 'behavior', 'drive', 'landscape', 'portrait'])

export function applyPatch(base: unknown, patch: RcPatch): { next: RcOverrides; changed: boolean; error?: string } {
  const cur: RcOverrides = isObj(base) ? (JSON.parse(JSON.stringify(base)) as RcOverrides) : {}
  if (base !== null && base !== undefined && !isObj(base)) return { next: cur, changed: false, error: 'the overrides file is not a JSON object' }
  const out: RcOverrides = { format: RC_OVERRIDES_FORMAT, version: 1, ...cur }
  const before = JSON.stringify(out)
  if (patch.kind === 'trackpad') {
    const t: Record<string, unknown> = isObj(out.trackpad) ? { ...(out.trackpad as Record<string, unknown>) } : {}
    for (const [k, v] of Object.entries(patch.set)) {
      if (!['speed', 'lookSpeed', 'acceleration', 'invertY', 'naturalScroll'].includes(k)) continue
      if (v === null) delete t[k]
      else t[k] = v
    }
    if (Object.keys(t).length) out.trackpad = t as RcTrackpad
    else delete out.trackpad
  } else if (patch.kind === 'resetLayout') {
    const cs = isObj(out.controls) ? { ...out.controls } : {}
    for (const [id, o] of Object.entries(cs)) {
      if (!isObj(o)) continue
      const rest = { ...o }
      delete rest.landscape
      delete rest.portrait
      delete rest.visible
      const keys = Object.keys(rest).filter((k) => k !== 'action')
      if (keys.length) cs[id] = rest
      else delete cs[id]
    }
    if (Object.keys(cs).length) out.controls = cs
    else delete out.controls
    if (Array.isArray(out.extra))
      out.extra = out.extra.map((x) => {
        if (!isObj(x)) return x
        const y = { ...x }
        delete y.landscape
        delete y.portrait
        return y
      })
  } else if (patch.kind === 'resetControl') {
    const cs = isObj(out.controls) ? { ...out.controls } : {}
    delete cs[patch.id]
    if (Object.keys(cs).length) out.controls = cs
    else delete out.controls
  } else {
    if (Array.isArray(out.extra)) {
      const i = out.extra.findIndex((x) => isObj(x) && x.id === patch.id)
      if (i >= 0) {
        const x = { ...out.extra[i] } as Record<string, unknown>
        for (const [k, v] of Object.entries(patch.set)) {
          if (!['visible', 'landscape', 'portrait', 'behavior'].includes(k)) continue
          if (v === null) delete x[k]
          else x[k] = v
        }
        out.extra = out.extra.map((y, j) => (j === i ? (x as unknown as RcExtraControl) : y))
        return { next: out, changed: JSON.stringify(out) !== before }
      }
    }
    const cs: Record<string, RcControlOverride> = isObj(out.controls) ? { ...out.controls } : {}
    const o: Record<string, unknown> = isObj(cs[patch.id]) ? { ...(cs[patch.id] as Record<string, unknown>) } : {}
    if (patch.action && typeof o.action !== 'string') o.action = patch.action
    for (const [k, v] of Object.entries(patch.set)) {
      if (!PHONE_CONTROL_FIELDS.has(k)) continue
      if (v === null) delete o[k]
      else if (k === 'landscape' || k === 'portrait') o[k] = { ...(isObj(o[k]) ? (o[k] as object) : {}), ...(v as object) }
      else o[k] = v
    }
    const keys = Object.keys(o).filter((k) => k !== 'action')
    if (keys.length) cs[patch.id] = o as RcControlOverride
    else delete cs[patch.id]
    if (Object.keys(cs).length) out.controls = cs
    else delete out.controls
  }
  return { next: out, changed: JSON.stringify(out) !== before }
}

export function checkPatch(raw: unknown): RcPatch | null {
  if (!isObj(raw)) return null
  if (raw.kind === 'resetLayout') return { kind: 'resetLayout' }
  if (raw.kind === 'resetControl' && typeof raw.id === 'string' && raw.id.length <= 200) return { kind: 'resetControl', id: raw.id }
  if (raw.kind === 'trackpad' && isObj(raw.set)) {
    const set: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw.set)) {
      if (k === 'invertY' || k === 'naturalScroll') {
        if (typeof v === 'boolean' || v === null) set[k] = v
      } else if (k === 'speed' || k === 'lookSpeed') {
        if (v === null || num(v, 0.1, 8) !== undefined) set[k] = v === null ? null : Math.round((v as number) * 100) / 100
      } else if (k === 'acceleration') {
        if (v === null || num(v, 0, 3) !== undefined) set[k] = v === null ? null : Math.round((v as number) * 100) / 100
      }
    }
    return { kind: 'trackpad', set }
  }
  if (raw.kind === 'control' && typeof raw.id === 'string' && raw.id.length <= 200 && isObj(raw.set)) {
    const set: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw.set)) {
      if (k === 'visible' && (typeof v === 'boolean' || v === null)) set[k] = v
      else if (k === 'behavior' && (v === null || BEHAVIORS.includes(v as RcBehavior))) set[k] = v
      else if (k === 'drive' && (v === null || v === 'keyboard' || v === 'gamepad')) set[k] = v
      else if ((k === 'landscape' || k === 'portrait') && (v === null || isObj(v))) {
        if (v === null) {
          set[k] = null
          continue
        }
        const p: RcPlace = {}
        const pv = v as Record<string, unknown>
        const x = num(pv.x, 0, 1)
        const y = num(pv.y, 0, 1)
        const s = num(pv.size, 0.4, 3)
        if (x !== undefined) p.x = Math.round(x * 1000) / 1000
        if (y !== undefined) p.y = Math.round(y * 1000) / 1000
        if (s !== undefined) p.size = Math.round(s * 100) / 100
        set[k] = p
      }
    }
    const action = typeof raw.action === 'string' ? raw.action.slice(0, 300) : undefined
    return { kind: 'control', id: raw.id, set, ...(action ? { action } : {}) }
  }
  return null
}

export function asGenerated(raw: unknown): RcGenerated | null {
  if (!isObj(raw) || raw.format !== RC_GENERATED_FORMAT || !Array.isArray(raw.maps)) return null
  return raw as unknown as RcGenerated
}

export function describeControl(c: RcControl): string {
  const bits = [c.visible ? 'shown' : 'hidden', c.kind, c.hint ? `-> ${c.hint}` : '-> nothing', c.kind === 'button' ? c.behavior + (c.behavior === 'hold' && c.holdMs ? ` ${c.holdMs}ms` : c.behavior === 'multiTap' ? ` x${c.taps}` : '') : '', c.drive === 'gamepad' ? 'gamepad' : '', c.note ? `(${c.note})` : '', c.overridden.length ? `[overrides: ${c.overridden.join(', ')}]` : '']
  return `${c.extra ? `+${c.id}` : c.path || c.action}: ${bits.filter(Boolean).join(' ')}`
}
