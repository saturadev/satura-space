export const APP_PAGE_ARG = '--satura-app-page='

function parse(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

export function isAppPage(raw: string, page: string): boolean {
  const u = parse(raw)
  const want = parse(page)
  if (!u || !want) return false
  if (want.protocol === 'file:') return u.protocol === 'file:' && u.host === want.host && decodeURIComponent(u.pathname) === decodeURIComponent(want.pathname)
  return u.origin === want.origin
}
