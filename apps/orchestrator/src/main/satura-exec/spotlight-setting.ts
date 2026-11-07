import type { Settings } from '@shared/types'

export function driftSpotlightOf(settings: Partial<Settings> | undefined): boolean {
  return settings?.driftSpotlight !== false
}
