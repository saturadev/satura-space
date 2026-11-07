import { MEDIA_SCHEME, mediaPathFromUrl, mediaUrlForPath } from './media-url'

export const REPORT_SCHEME = 'satura-report'

export function isHtmlPage(path: string): boolean {
  return /\.html?$/i.test(path)
}

export function reportUrlForPath(path: string): string {
  return REPORT_SCHEME + mediaUrlForPath(path).slice(MEDIA_SCHEME.length)
}

export function reportPathFromUrl(url: string): string | null {
  if (!url.startsWith(`${REPORT_SCHEME}://file/`)) return null
  return mediaPathFromUrl(MEDIA_SCHEME + url.slice(REPORT_SCHEME.length))
}
