import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const USAGE = `usage: node verify-phone-app.mjs [origin] [--dist <dir>] [--repo <owner/name>]

Checks that a live Satura Remote origin serves exactly the files its /phone-app.json lists.
  origin        the phone app origin, default https://remote.saturaspace.com
  --dist <dir>  also check that a local build (packages/companion-app/phone-site/dist) equals the live one,
                including the security headers its _headers file sets
  --repo <o/n>  also check that GitHub holds a build attestation (SLSA provenance v1) of the live /phone-app.json
                from .github/workflows/phone-site.yml on refs/heads/main of that repo, and that every live file's
                hash is among its subjects; gh attestation verify phone-app.json --repo <o/n> checks its signature`

const MANIFEST = 'phone-app.json'
const UNSERVED = new Set(['_headers', '_redirects', MANIFEST])
const SECURITY = ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'cross-origin-opener-policy', 'referrer-policy', 'permissions-policy', 'cache-control']
const PROBE_HOST = 'verify0phone0app'
const ROUTES = [
  ['/m/', 'm/index.html'],
  ['/h/all/', 'app/home.html'],
  [`/h/${PROBE_HOST}/`, 'app/index.html'],
  [`/h/${PROBE_HOST}/media-sw.js`, 'app/media-sw.js'],
  [`/h/${PROBE_HOST}/report-frame/boot.html`, 'app/report-frame/boot.html'],
  ['/phone-config.json', 'phone-config.json']
]
const PARALLEL = 8
const TIMEOUT_MS = 30_000
const WORKFLOW = '.github/workflows/phone-site.yml'
const MAIN = 'refs/heads/main'
const PROVENANCE = 'https://slsa.dev/provenance/v1'

function args(argv) {
  const out = { origin: 'https://remote.saturaspace.com', dist: null, repo: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dist') out.dist = argv[++i]
    else if (a === '--repo') out.repo = argv[++i]
    else if (a === '-h' || a === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else if (!a.startsWith('-')) out.origin = a
    else throw new Error(`unknown option ${a}`)
  }
  const u = new URL(out.origin)
  if (!/^https?:$/.test(u.protocol) || u.pathname !== '/' || u.search || u.hash) throw new Error(`the origin must look like https://host, not ${out.origin}`)
  out.origin = u.origin
  if (out.dist === undefined || out.repo === undefined) throw new Error('--dist and --repo need a value')
  if (out.repo && !/^[\w.-]+\/[\w.-]+$/.test(out.repo)) throw new Error(`--repo must be owner/name, not ${out.repo}`)
  return out
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function cleanManifest(raw) {
  const m = JSON.parse(raw)
  if (!m || typeof m !== 'object' || typeof m.commit !== 'string' || !/^[0-9a-f]{40}$/.test(m.commit)) throw new Error('it has no 40-character commit')
  if (!m.files || typeof m.files !== 'object' || Array.isArray(m.files)) throw new Error('it has no files map')
  for (const [path, hash] of Object.entries(m.files)) {
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some((s) => !s || s === '.' || s === '..')) throw new Error(`it lists a bad path ${JSON.stringify(path)}`)
    if (UNSERVED.has(path)) throw new Error(`it lists ${path}, which is never served`)
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`it has a bad hash for ${path}`)
  }
  return m
}

async function get(origin, path) {
  const url = new URL(path, `${origin}/`)
  const res = await fetch(url, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) })
  const body = Buffer.from(await res.arrayBuffer())
  if (new URL(res.url).origin !== origin) throw new Error(`${path} redirected to another origin, ${new URL(res.url).origin}`)
  return { status: res.status, body, headers: res.headers, url: res.url }
}

function field(o, ...keys) {
  let at = o
  for (const k of keys) at = at && typeof at === 'object' ? at[k] : undefined
  return at
}

function attestedDigests(attestation, digest, repo) {
  const payload = field(attestation, 'bundle', 'dsseEnvelope', 'payload')
  if (typeof payload !== 'string') return null
  let statement
  try {
    statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (field(statement, 'predicateType') !== PROVENANCE) return null
  const subjects = field(statement, 'subject')
  if (!Array.isArray(subjects)) return null
  const digests = subjects.map((s) => field(s, 'digest', 'sha256')).filter((d) => typeof d === 'string' && /^[0-9a-f]{64}$/.test(d))
  if (!digests.includes(digest)) return null
  const workflow = field(statement, 'predicate', 'buildDefinition', 'externalParameters', 'workflow')
  const url = `https://github.com/${repo}`
  if (field(workflow, 'repository') !== url || field(workflow, 'path') !== WORKFLOW || field(workflow, 'ref') !== MAIN) return null
  if (field(statement, 'predicate', 'runDetails', 'builder', 'id') !== `${url}/${WORKFLOW}@${MAIN}`) return null
  return digests
}

async function attestedFiles(repo, digest) {
  const url = `https://api.github.com/repos/${repo}/attestations/sha256:${digest}?predicate_type=provenance`
  const token = process.env.GITHUB_TOKEN?.trim()
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'satura-verify-phone-app', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const body = await res.text()
  if (res.status === 404) return { files: null, count: 0 }
  if (res.status !== 200) throw new Error(`${url} answered ${res.status}${res.headers.get('x-ratelimit-remaining') === '0' ? ' (rate limit used up)' : ''}`)
  const list = JSON.parse(body).attestations
  if (!Array.isArray(list)) throw new Error(`${url} sent no attestation list`)
  const files = new Set()
  for (const a of list) for (const d of attestedDigests(a, digest, repo) ?? []) files.add(d)
  return { files: files.size ? files : null, count: list.length }
}

async function pool(items, fn) {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift())
  })
  await Promise.all(workers)
}

function walk(dir, prefix = '') {
  const list = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) list.push(...walk(full, `${prefix}${name}/`))
    else list.push(`${prefix}${name}`)
  }
  return list
}

function parseHeaderRules(text) {
  const rules = []
  let rule = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (!/^\s/.test(raw)) {
      rule = { path: line, unset: [], set: [] }
      rules.push(rule)
      continue
    }
    if (!rule) throw new Error(`_headers has a header before any path: ${line}`)
    if (line.startsWith('! ')) rule.unset.push(line.slice(2).trim().toLowerCase())
    else {
      const i = line.indexOf(':')
      if (i < 1) throw new Error(`_headers has a line without a colon: ${line}`)
      rule.set.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()])
    }
  }
  return rules
}

function matches(pattern, path) {
  const re = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:\w+/g, '[^/]+')
    .replace(/\*/g, '.*')
  return new RegExp(`^${re}$`).test(path)
}

function expectedHeaders(rules, path) {
  const out = new Map()
  for (const r of rules) {
    if (!matches(r.path, path)) continue
    for (const k of r.unset) out.delete(k)
    for (const [k, v] of r.set) out.set(k, out.has(k) ? `${out.get(k)}, ${v}` : v)
  }
  return out
}

function scriptSrcOk(csp) {
  const script = (csp ?? '').split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src '))
  return !!script && script.split(/\s+/).slice(1).every((s) => s === "'self'" || s === "'wasm-unsafe-eval'")
}

async function main() {
  const opt = args(process.argv.slice(2))
  const problems = []
  const note = (text) => {
    problems.push(text)
    console.log(`FAIL ${text}`)
  }

  const live = await get(opt.origin, `/${MANIFEST}`)
  if (live.status !== 200) throw new Error(`${opt.origin}/${MANIFEST} answered ${live.status}`)
  let manifest
  try {
    manifest = cleanManifest(live.body.toString('utf8'))
  } catch (e) {
    throw new Error(`${opt.origin}/${MANIFEST} is not a phone app manifest: ${e.message}`)
  }
  const paths = Object.keys(manifest.files).sort()
  const digest = sha256(live.body)
  console.log(`${opt.origin} serves commit ${manifest.commit}, ${paths.length} files, ${MANIFEST} sha256 ${digest}`)

  let attested = null
  if (opt.repo) {
    const from = `https://github.com/${opt.repo}/${WORKFLOW}@${MAIN}`
    try {
      const { files, count } = await attestedFiles(opt.repo, digest)
      if (files) {
        attested = files
        console.log(`GitHub holds a build attestation of the live ${MANIFEST} from ${from}, ${files.size} subjects`)
      } else note(count ? `none of the ${count} attestation(s) of the live ${MANIFEST} on GitHub comes from ${from}` : `GitHub has no build attestation of the live ${MANIFEST} (sha256 ${digest}) in ${opt.repo}`)
    } catch (e) {
      note(`the attestations of the live ${MANIFEST}: ${e.message}`)
    }
  }

  let checked = 0
  await pool(paths, async (path) => {
    try {
      const r = await get(opt.origin, path)
      if (r.status !== 200) return note(`${path}: status ${r.status}`)
      const got = sha256(r.body)
      if (got !== manifest.files[path]) return note(`${path}: sha256 ${got}, the manifest says ${manifest.files[path]}`)
      if (attested && !attested.has(got)) return note(`${path}: sha256 ${got} isn't among the attested files`)
      checked++
    } catch (e) {
      note(`${path}: ${e.message}`)
    }
  })
  console.log(`${checked} of ${paths.length} files match their hashes${attested ? ' and the attestation' : ''}`)

  const rules = opt.dist ? parseHeaderRules(readFileSync(join(resolve(opt.dist), '_headers'), 'utf8')) : null
  for (const [path, file] of ROUTES) {
    try {
      const r = await get(opt.origin, path)
      const want = manifest.files[file]
      if (r.status !== 200) note(`route ${path}: status ${r.status}`)
      else if (!want) note(`route ${path}: the manifest has no ${file}`)
      else if (sha256(r.body) !== want) note(`route ${path}: not the bytes of ${file}`)
      if (!rules) {
        const csp = r.headers.get('content-security-policy')
        if (file !== 'app/report-frame/boot.html' && !scriptSrcOk(csp)) note(`route ${path}: script-src allows more than 'self': ${csp ?? 'no CSP'}`)
        continue
      }
      const expect = expectedHeaders(rules, path)
      for (const name of SECURITY) {
        const have = r.headers.get(name)
        const wantValue = expect.get(name) ?? null
        if (have !== wantValue) note(`route ${path}: ${name} is ${JSON.stringify(have)}, _headers says ${JSON.stringify(wantValue)}`)
      }
    } catch (e) {
      note(`route ${path}: ${e.message}`)
    }
  }
  console.log(`${ROUTES.length} routes checked${rules ? ' with the headers from the local _headers' : ''}`)

  if (opt.dist) {
    const dir = resolve(opt.dist)
    const local = walk(dir).filter((p) => !UNSERVED.has(p)).sort()
    const liveSet = new Set(paths)
    const localSet = new Set(local)
    for (const p of local) if (!liveSet.has(p)) note(`${p} is in ${dir} but not live`)
    for (const p of paths) if (!localSet.has(p)) note(`${p} is live but not in ${dir}`)
    let same = 0
    for (const p of local) {
      if (!liveSet.has(p)) continue
      const got = sha256(readFileSync(join(dir, p)))
      if (got !== manifest.files[p]) note(`${p}: the local build has sha256 ${got}, live has ${manifest.files[p]}`)
      else same++
    }
    try {
      const own = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'))
      if (own.commit !== manifest.commit) console.log(`note: the local build is from commit ${own.commit}, live is from ${manifest.commit}`)
    } catch {
    }
    console.log(`${same} of ${local.length} local files equal the live ones`)
  }

  if (problems.length) {
    console.log(`${problems.length} problem(s): ${opt.origin} does NOT serve what its manifest${opt.repo ? ' and its attestation say' : ' says'}`)
    process.exit(1)
  }
  console.log(`OK: ${opt.origin} serves exactly the files of commit ${manifest.commit}${attested ? `, attested by ${opt.repo}'s ${WORKFLOW} on ${MAIN}` : ''}`)
}

main().catch((e) => {
  console.error(`verify-phone-app: ${e.message}`)
  console.error(USAGE)
  process.exit(2)
})
