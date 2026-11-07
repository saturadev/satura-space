export type AppCacheId = 'phone-versions' | 'phone-1080' | 'phone-720' | 'phone-480' | 'phone-stills' | 'web' | 'code' | 'gpu'

export const APP_CACHE_IDS: AppCacheId[] = ['phone-versions', 'phone-1080', 'phone-720', 'phone-480', 'phone-stills', 'web', 'code', 'gpu']

export interface AppCache {
  id: AppCacheId
  bytes: number
  files: number
  clearable: boolean
}

export interface AppCaches {
  caches: AppCache[]
  total: number
  phoneDir: string
  dataDir: string
}

export interface AppCachesCleared extends AppCaches {
  cleared: AppCacheId[]
  freed: number
}
