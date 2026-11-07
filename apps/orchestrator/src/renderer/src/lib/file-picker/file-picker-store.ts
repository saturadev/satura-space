import { create } from 'zustand'
import type { PickerFilter, PickerMode } from '@shared/file-picker'

export interface PickOptions {
  mode: PickerMode
  purpose: string
  title?: string
  confirmLabel?: string
  defaultPath?: string
  defaultName?: string
  filters?: PickerFilter[]
  multiple?: boolean
  unity?: boolean
}

interface PickerRequest extends PickOptions {
  id: number
}

interface FilePickerState {
  hosts: number
  request: PickerRequest | null
  resolve: ((paths: string[] | null) => void) | null
  open: (opts: PickOptions) => Promise<string[] | null>
  respond: (paths: string[] | null) => void
  mount: () => () => void
}

let nextId = 1

export const useFilePickerStore = create<FilePickerState>((set, get) => ({
  hosts: 0,
  request: null,
  resolve: null,
  open: (opts) => {
    get().resolve?.(null)
    return new Promise<string[] | null>((resolve) => {
      set({ request: { ...opts, id: nextId++ }, resolve })
    })
  },
  respond: (paths) => {
    const { resolve } = get()
    set({ request: null, resolve: null })
    resolve?.(paths && paths.length ? paths : null)
  },
  mount: () => {
    set((s) => ({ hosts: s.hosts + 1 }))
    return () => {
      set((s) => ({ hosts: Math.max(0, s.hosts - 1) }))
      if (get().hosts === 0) get().respond(null)
    }
  }
}))

const LAST_DIR_KEY = 'satura.filePicker.lastDir.'

export interface PickerMemory {
  dir: string
  name?: string
}

export function pickerMemory(purpose: string): PickerMemory | null {
  try {
    const raw = localStorage.getItem(LAST_DIR_KEY + purpose)
    const v = raw ? (JSON.parse(raw) as PickerMemory) : null
    return v && typeof v.dir === 'string' ? v : null
  } catch {
    return null
  }
}

export function rememberPicker(purpose: string, memory: PickerMemory): void {
  try {
    localStorage.setItem(LAST_DIR_KEY + purpose, JSON.stringify(memory))
  } catch {
    return
  }
}

export async function pickPaths(opts: PickOptions): Promise<string[] | null> {
  const store = useFilePickerStore.getState()
  if (store.hosts > 0) return store.open(opts)
  const base = pickerMemory(opts.purpose)?.dir ?? opts.defaultPath
  const defaultPath = opts.defaultName ? (base ? `${base.replace(/[\\/]+$/, '')}/${opts.defaultName}` : opts.defaultName) : base
  return window.api.dialog.native({
    mode: opts.mode,
    title: opts.title,
    confirmLabel: opts.confirmLabel,
    defaultPath: defaultPath || undefined,
    filters: opts.filters,
    multiple: opts.multiple
  })
}

export async function pickPath(opts: PickOptions): Promise<string | null> {
  const paths = await pickPaths({ ...opts, multiple: false })
  return paths?.[0] ?? null
}
