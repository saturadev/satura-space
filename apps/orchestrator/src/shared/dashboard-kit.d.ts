export * from '@satura/report'

export interface FetchState<T = any> {
  data: T | undefined
  error: string | undefined
  loading: boolean
  status: number
  at: number | undefined
  refresh: () => void
}

export function useFetch<T = any>(
  url: string,
  options?: {
    every?: number
    method?: string
    headers?: Record<string, string>
    body?: string | object
    as?: 'json' | 'text'
    enabled?: boolean
  }
): FetchState<T>

export function useSeries(key: string, value: number | null | undefined, options?: { keep?: number }): number[]

export function useStore<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void]

export interface HandleState<T = any> {
  value: T | undefined
  logs: string[]
  error: string | undefined
  loading: boolean
  at: number | undefined
  refresh: () => void
}

export function useHandle<T = any>(name: string, args?: unknown[], options?: { every?: number; player?: string }): HandleState<T>

export interface GitState {
  branch: string | null
  ahead: number
  behind: number
  changes: { path: string; status: string; staged: boolean }[]
  log: { hash: string; message: string; author: string; date: number }[]
  error: string | undefined
  loading: boolean
  at: number | undefined
  refresh: () => void
}

export function useGit(options?: { log?: number; status?: boolean; every?: number }): GitState

export interface LogsState {
  lines: string[]
  error: string | undefined
  loading: boolean
  at: number | undefined
  refresh: () => void
}

export function useLogs(options?: { source?: 'unity' | 'app'; grep?: string; tail?: number; every?: number }): LogsState

export interface FileState<T = any> {
  data: T | undefined
  error: string | undefined
  loading: boolean
  at: number | undefined
}

export function useFile<T = any>(path: string, options?: { as?: 'json' | 'text' }): FileState<T>
