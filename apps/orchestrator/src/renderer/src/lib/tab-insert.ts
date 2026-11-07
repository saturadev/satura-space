import { create } from 'zustand'

export type TabInsert =
  | { kind: 'unit'; groupId: string; before: string | null }
  | { kind: 'seg'; owner: string; parent: string; before: string | null }

export const useTabInsert = create<{ target: TabInsert | null }>(() => ({ target: null }))
