import { create } from 'zustand'

export interface ConfirmAnchor {
  x: number
  y: number
  top?: number
  right?: number
}

export interface ConfirmCheckbox {
  label: string
  defaultChecked?: boolean
  onChange?: (checked: boolean) => void
}

export interface ConfirmProject {
  name: string
  detail?: string
}

export interface ConfirmFile {
  kind: 'scene' | 'prefab' | 'asset'
  name: string
  note?: string
}

export type ConfirmChoice = 'confirm' | 'secondary' | 'cancel'

export interface ConfirmRequest {
  title: string
  message: string
  items?: string[]
  project?: ConfirmProject
  files?: ConfirmFile[]
  confirmLabel?: string
  secondaryLabel?: string
  cancelLabel?: string
  hideCancel?: boolean
  danger?: boolean
  checkbox?: ConfirmCheckbox
  anchor?: ConfirmAnchor | null
  remote?: boolean
  desktopOnly?: boolean
  clickOnly?: boolean
}

interface ConfirmState {
  request: (ConfirmRequest & { id: number }) | null
  resolve: ((choice: ConfirmChoice) => void) | null
  open: (req: ConfirmRequest) => Promise<ConfirmChoice>
  respond: (choice: boolean | ConfirmChoice) => void
}

let nextId = 1

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  resolve: null,
  open: (req) => {
    get().resolve?.('cancel')
    return new Promise<ConfirmChoice>((resolve) => {
      set({ request: { ...req, id: nextId++ }, resolve })
    })
  },
  respond: (choice) => {
    const { resolve } = get()
    set({ request: null, resolve: null })
    resolve?.(choice === true ? 'confirm' : choice === false ? 'cancel' : choice)
  }
}))

export function requestConfirm(req: ConfirmRequest): Promise<boolean> {
  return useConfirmStore.getState().open(req).then((choice) => choice === 'confirm')
}

export function requestChoice(req: ConfirmRequest): Promise<ConfirmChoice> {
  return useConfirmStore.getState().open(req)
}

export function anchorFromEvent(e: {
  clientX: number
  clientY: number
}): ConfirmAnchor {
  return { x: e.clientX, y: e.clientY }
}

export function anchorFromRect(rect: DOMRect): ConfirmAnchor {
  return { x: rect.left, y: rect.bottom, top: rect.top, right: rect.right }
}

export function anchorFromElement(el: HTMLElement | null): ConfirmAnchor | null {
  if (!el) return null
  return anchorFromRect(el.getBoundingClientRect())
}
