import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const PROBE_TIMEOUT_MS = 6000
const TOKEN = /^[\w-]{16,64}$/
const PATH = /^\/[\w/-]{1,40}$/

function probeOver(url: URL, family: 4 | 6): Promise<string> {
  return new Promise((resolve) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { family, timeout: PROBE_TIMEOUT_MS, headers: { accept: 'application/json' } }, (res) => {
      res.resume()
      resolve(res.statusCode === 200 ? 'seen' : `refused (${res.statusCode})`)
    })
    req.on('timeout', () => req.destroy(new Error(`no answer in ${PROBE_TIMEOUT_MS / 1000} s`)))
    req.on('error', (e) => resolve(`not reachable (${e.message})`))
    req.end()
  })
}

export function checkNetworks(origin: string, token: unknown, path: unknown, log: (line: string) => void): void {
  if (typeof token !== 'string' || !TOKEN.test(token)) return
  let url: URL
  try {
    url = new URL(typeof path === 'string' && PATH.test(path) ? path : '/net/probe', origin)
  } catch {
    return
  }
  url.searchParams.set('t', token)
  const t0 = Date.now()
  void Promise.all([probeOver(url, 4), probeOver(url, 6)]).then(([v4, v6]) => log(`network check for phones on this network: IPv4 ${v4}, IPv6 ${v6} (${Date.now() - t0} ms)`))
}
