export const STUN_ONLY = [{ urls: ['stun:stun.cloudflare.com:3478'] }]

export function cleanServers(list) {
  const out = []
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s !== 'object') continue
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === 'string' && /^(stun|stuns|turn|turns):/.test(u) && !/:53(\?|$)/.test(u))
    if (!urls.length) continue
    out.push({ urls, ...(typeof s.username === 'string' ? { username: s.username } : {}), ...(typeof s.credential === 'string' ? { credential: s.credential } : {}) })
  }
  return out
}

export function staticIce(raw, log = () => {}) {
  const text = String(raw ?? '').trim()
  if (!text) return { servers: STUN_ONLY, source: 'stun' }
  try {
    const servers = cleanServers(JSON.parse(text))
    if (servers.length) return { servers, source: servers.some((s) => s.username) ? 'static-turn' : 'static-stun' }
    log('SATURA_RELAY_ICE_SERVERS has no usable servers, using STUN only')
  } catch (e) {
    log('SATURA_RELAY_ICE_SERVERS is not JSON, using STUN only', { error: String(e?.message ?? e) })
  }
  return { servers: STUN_ONLY, source: 'stun' }
}
