import { existsSync } from 'node:fs'
import { extname } from 'node:path'

export type Recipe = 'remux' | 'encode' | 'web' | 'r1080' | 'r720' | 'r480'
export type Way = 'avconvert' | 'webcodecs-then-avconvert' | 'webcodecs-in-memory'
export type StillWay = 'webcodecs' | 'avconvert-head-then-webcodecs'

export interface VideoTools {
  avconvert: boolean
}

export const AVCONVERT = '/usr/bin/avconvert'
const IN_MEMORY_MAX = 300e6
const WEBCODECS_DECODES = /^(avc[13]|hvc1|hev1|vp0?8|vp0?9|av01)/

export function videoTools(platform: string = process.platform, exists: (path: string) => boolean = existsSync, env: Record<string, string | undefined> = process.env): VideoTools {
  return { avconvert: platform === 'darwin' && !env.SATURA_PHONE_VIDEO_NO_AVCONVERT && exists(AVCONVERT) }
}

export function containerOf(path: string): string {
  const ext = extname(path).toLowerCase()
  return ext === '.webm' ? 'WebM' : ext === '.mkv' ? 'Matroska' : ext === '.ogv' ? 'Ogg' : ''
}

export function webCodecsDecodes(codec: string): boolean {
  return !codec || WEBCODECS_DECODES.test(codec)
}

function allWays(recipe: Recipe, tools: VideoTools, estimate: number, container: string): Way[] {
  if (tools.avconvert) {
    if (recipe === 'remux' || recipe === 'encode') return ['avconvert']
    if (recipe === 'web' || container) return ['webcodecs-then-avconvert']
    return ['webcodecs-then-avconvert', 'avconvert']
  }
  return recipe === 'remux' || estimate > IN_MEMORY_MAX ? [] : ['webcodecs-in-memory']
}

export function waysFor(recipe: Recipe, tools: VideoTools, estimate: number, container: string, decodable = true): Way[] {
  const ways = allWays(recipe, tools, estimate, container)
  return decodable ? ways : ways.filter((w) => w === 'avconvert')
}

export function noWayNote(recipe: Recipe, tools: VideoTools, decodable = true): string {
  if (!tools.avconvert && recipe === 'remux') return 'Only a Mac can set this video up for streaming.'
  if (!decodable) return tools.avconvert ? "Your Mac can't convert this video." : 'Only a Mac can convert this video.'
  return 'The video is too long for a phone version on this computer.'
}

export function stillWays(tools: VideoTools, container: string): StillWay[] {
  return tools.avconvert && !container ? ['webcodecs', 'avconvert-head-then-webcodecs'] : ['webcodecs']
}
