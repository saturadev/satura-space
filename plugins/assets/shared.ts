export type AssetKind = 'model' | 'material' | 'hdri'
export type AssetSource = 'polyhaven' | 'ambientcg'

export interface AssetRow {
  id: string
  name: string
  kind: AssetKind
  tags: string[]
  thumbnail: string
  source: AssetSource
  license: 'CC0'
  credit: string
  url: string
  imported?: boolean
}

export interface SearchOptions {
  kind?: AssetKind | ''
  source?: AssetSource | ''
  limit?: number
  offset?: number
}

export interface SearchResult {
  rows: AssetRow[]
  total: number
}

export interface ImportOptions {
  res?: string
  skybox?: boolean
}

export interface ImportResult {
  id: string
  kind: AssetKind
  path: string
  prefab?: string
  material?: string
  skybox?: string
  scene?: string
  tris?: number
  size?: [number, number, number]
  materials?: string[]
  pipeline: string
  files: number
  bytes: number
  warnings?: string[]
}

export interface ImportedAsset {
  id: string
  name: string
  kind: AssetKind
  path: string
  source: AssetSource
}

export interface ImportProgress {
  id: string
  project: string
  stage: 'download' | 'unity' | 'done' | 'error'
  done: number
  total: number
  file?: string
  error?: string
  result?: ImportResult
}

export const SOURCE_LABEL: Record<AssetSource, string> = { polyhaven: 'Poly Haven', ambientcg: 'ambientCG' }
export const RESOLUTIONS = ['1k', '2k', '4k', '8k']
