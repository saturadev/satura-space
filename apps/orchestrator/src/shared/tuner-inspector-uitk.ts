import type {
  TunerPopup,
  TunerPopupAction
} from './tuner-inspector-popups'

export interface UitkPicture {
  id: string
  w: number
  h: number
  tint?: string
  slice?: [number, number, number, number]
  sscale?: number
  size: string
  pos: string
  rep: string
}

export type UitkValue = boolean | number | string | number[]

export interface UitkNode {
  i: number
  t: string
  x: number
  y: number
  w: number
  h: number
  n?: string
  c?: string
  ps?: number
  d?: 1
  hid?: 1
  op?: number
  clip?: 1
  foc?: 1
  tip?: string
  own?: number
  bg?: string
  bw?: [number, number, number, number]
  bc?: string | [string, string, string, string]
  rad?: number | [number, number, number, number]
  img?: UitkPicture
  pic?: UitkPicture
  vec?: 1
  tx?: string
  col?: string
  fs?: number
  fst?: number
  ta?: number
  ws?: number
  ell?: 1
  ls?: number
  pad?: [number, number, number, number]
  rich?: 1
  bp?: string
  lb?: string
  v?: UitkValue
  inp?: number
  ml?: 1
  ro?: 1
  pw?: 1
  txt?: string
  sc?: [number, number, number, number]
  items?: number
  cv?: { col: string; p: number[] }
  im?: number
  ch?: UitkNode[]
}

export const UITK_PSEUDO = { active: 1, hover: 2, checked: 8, disabled: 32, focus: 64 } as const

export const UITK_OWN = { bg: 1, color: 2, border: 4, image: 8, tint: 16, picture: 32 } as const
export type UitkPopup = TunerPopup

export type UitkOpenTarget =
  | { kind: 'object'; path: string; scene?: string; components?: { type: string; index?: number }[] }
  | { kind: 'asset'; path: string }
  | { kind: 'prefab'; path: string }

export interface UitkTexture {
  w: number
  h: number
  png: string
}

export interface UitkCapture {
  w: number
  h: number
  skin?: 'dark' | 'light'
  root: UitkNode | null
  popup?: UitkPopup
  imgui?: number
  open?: UitkOpenTarget
  tex?: Record<string, UitkTexture>
}

export type UitkPopupAction = TunerPopupAction

export type UitkInput =
  | { op: 'pointer'; type: 'down' | 'up' | 'move'; x: number; y: number; button: number; clicks: number; buttons: number; mods: number }
  | { op: 'wheel'; x: number; y: number; dx: number; dy: number; mods: number }
  | { op: 'key'; type: 'down' | 'up'; key: string; code?: string; mods: number }
  | { op: 'set'; node: number; value: string }
  | { op: 'focus'; node: number }
  | { op: 'blur' }
  | { op: 'popup'; id: string; action: UitkPopupAction; value?: unknown }

export const UITK_MODS = { shift: 1, control: 2, alt: 4, command: 8 } as const

export function uitkMods(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): number {
  return (
    (e.shiftKey ? UITK_MODS.shift : 0) |
    (e.ctrlKey ? UITK_MODS.control : 0) |
    (e.altKey ? UITK_MODS.alt : 0) |
    (e.metaKey ? UITK_MODS.command : 0)
  )
}
