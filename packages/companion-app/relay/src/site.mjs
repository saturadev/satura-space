import { createReadStream, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, relative, sep } from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8'
}
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MAX_HOPS = 4

function parseRules(text) {
  const rules = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [from, to, code] = line.split(/\s+/)
    const status = code === undefined ? 302 : Number(code)
    if (!from?.startsWith('/') || !to || (status !== 200 && !REDIRECTS.has(status))) continue
    if (status === 200 && !to.startsWith('/')) continue
    const names = []
    const pattern = from
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:(\w+)/g, (_, name) => (names.push(name), '([^/]+)'))
      .replace(/\*/g, () => (names.push('splat'), '(.*)'))
    rules.push({ re: new RegExp(`^${pattern}$`), names, to, status })
  }
  return rules
}

export function siteRoot(dir) {
  if (!dir) return null
  try {
    return statSync(dir).isDirectory() ? dir : null
  } catch {
    return null
  }
}

export function createSite(root, { headersFor = () => ({}), onServe = () => {} } = {}) {
  let rules = []
  let rulesAt = -1

  function currentRules() {
    let at = 0
    try {
      at = statSync(join(root, '_redirects')).mtimeMs
    } catch {
    }
    if (at !== rulesAt) {
      rulesAt = at
      try {
        rules = at ? parseRules(readFileSync(join(root, '_redirects'), 'utf8')) : []
      } catch {
        rules = []
      }
    }
    return rules
  }

  function at(rel) {
    if (rel.includes('\0') || rel.split('/').some((s) => s.startsWith('.'))) return null
    if (/^\/_[^/]*$/.test(rel)) return null
    const file = normalize(join(root, rel))
    if (file !== root && !file.startsWith(root + sep)) return null
    try {
      const st = statSync(file)
      if (st.isFile()) return { file, st, rel: relative(root, file).split(sep).join('/') }
      if (st.isDirectory()) return rel.endsWith('/') ? at(`${rel}index.html`) : { dir: true }
    } catch {
    }
    return null
  }

  function find(pathname) {
    const f = at(pathname)
    if (f?.dir) return { redirect: `${pathname}/`, status: 308 }
    if (f) return f
    if (!pathname.endsWith('/')) {
      const html = at(`${pathname}.html`)
      if (html && !html.dir) return html
    }
    return null
  }

  function rewrite(pathname) {
    for (const r of currentRules()) {
      const m = r.re.exec(pathname)
      if (!m) continue
      const vals = Object.fromEntries(r.names.map((n, i) => [n, m[i + 1]]))
      return { to: r.to.replace(/:(\w+)/g, (all, n) => vals[n] ?? all), status: r.status }
    }
    return null
  }

  function send(req, res, f, status) {
    const etag = `"${f.st.size.toString(36)}-${Math.floor(f.st.mtimeMs).toString(36)}"`
    const headers = {
      etag,
      'cache-control': f.rel.startsWith('assets/') || f.rel.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
      ...headersFor(req, f.rel)
    }
    if (status === 200 && req.headers['if-none-match'] === etag) return res.writeHead(304, headers).end()
    res.writeHead(status, { ...headers, 'content-type': MIME[extname(f.rel)] ?? 'application/octet-stream', 'content-length': f.st.size })
    if (req.method === 'HEAD') return res.end()
    createReadStream(f.file).pipe(res)
    onServe(req, f.st.size)
  }

  function serve(url, req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    let pathname = decodeURIComponent(url.pathname)
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const r = rewrite(pathname)
      if (!r) break
      if (r.status !== 200) return res.writeHead(r.status, { location: r.to, 'cache-control': 'no-cache' }).end(), true
      const next = r.to.split('?')[0]
      if (next === pathname) break
      pathname = next
    }
    const f = find(pathname)
    if (f?.redirect) return res.writeHead(f.status, { location: `${f.redirect}${url.search}`, 'cache-control': 'no-cache' }).end(), true
    if (f) return send(req, res, f, 200), true
    const missing = at('/404.html')
    if (missing && !missing.dir) return send(req, res, missing, 404), true
    const spa = at('/index.html')
    if (spa && !spa.dir) return send(req, res, spa, 200), true
    return false
  }

  function file(rel) {
    const f = at(rel)
    return f && !f.dir ? f : null
  }

  return { root, serve, file }
}
