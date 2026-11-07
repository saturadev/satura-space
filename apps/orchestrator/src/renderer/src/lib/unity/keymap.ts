
const SPECIAL: Record<string, string> = {
  ShiftLeft: 'LeftShift',
  ShiftRight: 'RightShift',
  ControlLeft: 'LeftCtrl',
  ControlRight: 'RightCtrl',
  AltLeft: 'LeftAlt',
  AltRight: 'RightAlt',
  MetaLeft: 'LeftCommand',
  MetaRight: 'RightCommand',
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'NumpadEnter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  CapsLock: 'CapsLock',
  Minus: 'Minus',
  Equal: 'Equals',
  BracketLeft: 'LeftBracket',
  BracketRight: 'RightBracket',
  Backslash: 'Backslash',
  Semicolon: 'Semicolon',
  Quote: 'Quote',
  Backquote: 'Backquote',
  Comma: 'Comma',
  Period: 'Period',
  Slash: 'Slash',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  NumpadAdd: 'NumpadPlus',
  NumpadSubtract: 'NumpadMinus',
  NumpadMultiply: 'NumpadMultiply',
  NumpadDivide: 'NumpadDivide',
  NumpadDecimal: 'NumpadPeriod',
  NumpadEqual: 'NumpadEquals',
  NumLock: 'NumLock',
  ScrollLock: 'ScrollLock',
  PrintScreen: 'PrintScreen',
  Pause: 'Pause',
  ContextMenu: 'ContextMenu'
}

export const MODIFIER_KEYS = new Set([
  'LeftShift',
  'RightShift',
  'LeftCtrl',
  'RightCtrl',
  'LeftAlt',
  'RightAlt',
  'LeftCommand',
  'RightCommand',
  'CapsLock'
])

export function codeToUnityKey(code: string): string | null {
  const special = SPECIAL[code]
  if (special) return special

  let m = /^Key([A-Z])$/.exec(code)
  if (m) return m[1]

  m = /^Digit(\d)$/.exec(code)
  if (m) return `Digit${m[1]}`

  m = /^Numpad(\d)$/.exec(code)
  if (m) return `Numpad${m[1]}`

  m = /^Arrow(Up|Down|Left|Right)$/.exec(code)
  if (m) return `${m[1]}Arrow`

  m = /^F(\d{1,2})$/.exec(code)
  if (m) return code

  return null
}
