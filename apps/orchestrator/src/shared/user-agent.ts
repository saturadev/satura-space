function osOf(ua: string): string {
  const ios = /\b(iPhone|iPad|iPod)\b.*? OS (\d+)(?:_(\d+))?/.exec(ua)
  if (ios) return `iOS ${ios[2]}${ios[3] ? `.${ios[3]}` : ''}`
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua)
  if (android) return `Android ${android[1]}`
  if (/Windows NT/.test(ua)) return 'Windows'
  if (/CrOS/.test(ua)) return 'ChromeOS'
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS'
  if (/Linux/.test(ua)) return 'Linux'
  return ''
}

function browserOf(ua: string): string {
  const tests: [RegExp, string][] = [
    [/EdgiOS\/(\d+)|Edg(?:A)?\/(\d+)/, 'Edge'],
    [/CriOS\/(\d+)/, 'Chrome'],
    [/FxiOS\/(\d+)/, 'Firefox'],
    [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
    [/OPR\/(\d+)|OPiOS\/(\d+)/, 'Opera'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/Chrome\/(\d+)/, 'Chrome'],
    [/Version\/(\d+)(?:\.\d+)*.*Safari\//, 'Safari']
  ]
  for (const [re, name] of tests) {
    const m = re.exec(ua)
    if (m) return `${name} ${m.slice(1).find(Boolean) ?? ''}`.trim()
  }
  if (/AppleWebKit/.test(ua) && /\b(iPhone|iPad)\b/.test(ua)) return 'Safari'
  return ''
}

export function shortUserAgent(ua: string | undefined | null): string {
  const text = String(ua ?? '')
  return [osOf(text), browserOf(text)].filter(Boolean).join(' · ')
}

export function deviceKind(ua: string | undefined | null): string {
  const text = String(ua ?? '')
  if (/iPad/.test(text)) return 'iPad'
  if (/iPhone/.test(text)) return 'iPhone'
  if (/Android/.test(text)) return /Mobile/.test(text) ? 'Android phone' : 'Android tablet'
  return 'Phone'
}
