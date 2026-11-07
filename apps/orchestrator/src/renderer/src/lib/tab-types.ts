import type { TabContentType } from '@shared/types'

const KNOWN_TAB_TYPES: Record<TabContentType, true> = {
  terminal: true,
  'unity-instance-player': true,
  'unity-console': true,
  'file-viewer': true,
  tuner: true,
  'unity-scratchpad': true,
  'git-scm': true,
  dashboard: true
}

export function isKnownTabType(type: string): type is TabContentType {
  return Object.prototype.hasOwnProperty.call(KNOWN_TAB_TYPES, type)
}
