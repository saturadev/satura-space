const { closeSync, existsSync, openSync, readSync, readdirSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const TIMESTAMP_URL = 'http://time.certum.pl/'

function findSigntool() {
  if (process.env.SATURA_SIGNTOOL) return process.env.SATURA_SIGNTOOL
  const roots = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin'
  ].filter((r) => existsSync(r))
  const found = []
  for (const root of roots) {
    for (const entry of readdirSync(root)) {
      const exe = path.join(root, entry, 'x64', 'signtool.exe')
      if (existsSync(exe)) found.push(exe)
    }
  }
  return found.sort().pop()
}

function hasSignature(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(4096)
    const n = readSync(fd, head, 0, head.length, 0)
    if (n < 64 || head.readUInt16LE(0) !== 0x5a4d) return false
    const pe = head.readUInt32LE(0x3c)
    if (pe + 26 > n || head.readUInt32LE(pe) !== 0x4550) return false
    const opt = pe + 24
    const security = opt + (head.readUInt16LE(opt) === 0x20b ? 112 : 96) + 4 * 8
    if (security + 8 > n) return false
    return head.readUInt32LE(security + 4) > 0
  } finally {
    closeSync(fd)
  }
}

function signWithSsign(file) {
  const ssign = process.env.SATURA_SSIGN || 'ssign'
  console.log(`[sign-win] ${path.basename(file)} (ssign)`)
  const res = spawnSync(ssign, [file], { stdio: 'inherit' })
  if (res.error) throw res.error
  if (res.status !== 0) {
    throw new Error(`[sign-win] ssign exited ${res.status} for ${file}`)
  }
}

exports.default = async function signWindows(configuration) {
  if (process.env.SATURA_WIN_SIGN !== '1') return
  if (hasSignature(configuration.path)) {
    console.log(`[sign-win] ${path.basename(configuration.path)} already signed, kept as is`)
    return
  }
  if (process.env.CERTUM_OTP) {
    signWithSsign(configuration.path)
    return
  }

  const subject = process.env.SATURA_WIN_PUBLISHER
  if (!subject) {
    throw new Error('[sign-win] SATURA_WIN_SIGN=1 but SATURA_WIN_PUBLISHER is unset')
  }

  const signtool = findSigntool()
  if (!signtool) {
    throw new Error('[sign-win] signtool.exe not found — install the Windows SDK or set SATURA_SIGNTOOL')
  }

  const file = configuration.path
  console.log(`[sign-win] ${path.basename(file)}`)
  const res = spawnSync(
    signtool,
    ['sign', '/n', subject, '/fd', 'sha256', '/tr', TIMESTAMP_URL, '/td', 'sha256', '/v', file],
    { stdio: 'inherit' }
  )
  if (res.error) throw res.error
  if (res.status !== 0) {
    throw new Error(`[sign-win] signtool exited ${res.status} for ${file}`)
  }
}
