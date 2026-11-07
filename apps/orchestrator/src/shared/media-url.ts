export const MEDIA_SCHEME = 'satura-media'

export const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'audio/ogg',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
}

const PLAYABLE_VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv'])

const PLAYABLE_AUDIO_EXTS = new Set(['wav', 'mp3', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'aif', 'aiff'])

function extOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
}

export function isPlayableVideo(path: string): boolean {
  return PLAYABLE_VIDEO_EXTS.has(extOf(path))
}

export function isPlayableAudio(path: string): boolean {
  return PLAYABLE_AUDIO_EXTS.has(extOf(path))
}

export function mediaUrlForPath(path: string, version?: number): string {
  const posix = path.replace(/\\/g, '/')
  const encoded = posix.split('/').map(encodeURIComponent).join('/')
  const query = version ? `?v=${version}` : ''
  return `${MEDIA_SCHEME}://file/${encoded.replace(/^\/+/, '')}${query}`
}

export function mediaPathFromUrl(url: string): string | null {
  const prefix = `${MEDIA_SCHEME}://file/`
  if (!url.startsWith(prefix)) return null
  const rest = url.slice(prefix.length).split(/[?#]/)[0]
  let decoded: string
  try {
    decoded = rest.split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
  if (/^[A-Za-z]:\//.test(decoded)) return decoded
  return `/${decoded}`
}
