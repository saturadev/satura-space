import { BlockList, isIP } from 'node:net'
import { readFileSync, statSync } from 'node:fs'

export const CLOUDFLARE_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32'
]

export const PRIVATE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '100.64.0.0/10', '::1/128', 'fc00::/7', 'fe80::/10']

const RECHECK_MS = 60_000

export function plainIp(addr) {
  const a = String(addr ?? '').trim()
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a)
  return m ? m[1] : a
}

export function ipKey(addr) {
  const a = plainIp(addr)
  if (isIP(a) !== 6) return a
  const parts = a.split('::')
  const head = parts[0] ? parts[0].split(':') : []
  const tail = parts.length > 1 && parts[1] ? parts[1].split(':') : []
  const groups = parts.length > 1 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`
}

export function rangeList(ranges) {
  const list = new BlockList()
  let n = 0
  for (const raw of ranges) {
    const [addr, bits] = String(raw).trim().split('/')
    const family = isIP(addr)
    const len = Number(bits ?? (family === 6 ? 128 : 32))
    if (!family || !Number.isInteger(len) || len < 0 || len > (family === 6 ? 128 : 32)) continue
    list.addSubnet(addr, len, family === 6 ? 'ipv6' : 'ipv4')
    n++
  }
  return { list, n }
}

export function inRanges(ranges, addr) {
  const a = plainIp(addr)
  const family = isIP(a)
  if (!family) return false
  try {
    return ranges.list.check(a, family === 6 ? 'ipv6' : 'ipv4')
  } catch {
    return false
  }
}

function parseList(text) {
  return String(text ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
}

export function createProxyTrust({ enabled = false, file = '', peers = '', log = () => {} } = {}) {
  const peerRanges = rangeList(peers ? parseList(peers) : PRIVATE_RANGES)
  let cf = rangeList(CLOUDFLARE_RANGES)
  let source = 'built-in'
  let fileMtime = 0
  let checkedAt = 0
  let refused = 0

  function reload() {
    if (!file) return
    const at = Date.now()
    if (at - checkedAt < RECHECK_MS && checkedAt) return
    checkedAt = at
    try {
      const st = statSync(file)
      if (st.mtimeMs === fileMtime) return
      const next = rangeList(parseList(readFileSync(file, 'utf8')))
      fileMtime = st.mtimeMs
      if (next.n < 5) {
        log('cloudflare ranges file looks wrong, keeping the old list', { file, ranges: next.n })
        return
      }
      cf = next
      source = file
      log('cloudflare ranges loaded', { file, ranges: next.n })
    } catch (e) {
      if (fileMtime !== -1) log('cloudflare ranges file unreadable, keeping the old list', { file, error: String(e?.message ?? e) })
      fileMtime = -1
    }
  }

  function viaCloudflare(req) {
    const peer = plainIp(req.socket?.remoteAddress)
    if (!enabled) return { ip: peer, trusted: false, hop: peer }
    reload()
    if (!inRanges(peerRanges, peer) && !inRanges(cf, peer)) return { ip: peer, trusted: false, hop: peer }
    const xff = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((s) => plainIp(s))
      .filter(Boolean)
    const hop = inRanges(cf, peer) ? peer : (xff[xff.length - 1] ?? peer)
    const cfIp = plainIp(req.headers['cf-connecting-ip'])
    if (inRanges(cf, hop) && isIP(cfIp)) return { ip: cfIp, trusted: true, hop }
    if (req.headers['cf-connecting-ip'] !== undefined) refused++
    return { ip: isIP(hop) ? hop : peer, trusted: false, hop }
  }

  function clientIp(req) {
    return viaCloudflare(req).ip
  }

  reload()
  return { enabled, clientIp, viaCloudflare, status: () => ({ enabled, source, ranges: cf.n, peers: peerRanges.n, refused }) }
}
