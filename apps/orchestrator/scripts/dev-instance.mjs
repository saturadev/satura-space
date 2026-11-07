import { createServer } from 'electron-vite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const name = (process.argv[2] ?? 'alt').trim().toLowerCase()

if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
  console.error(`✗ Bad instance name "${name}": use lowercase letters, digits and dashes.`)
  process.exit(1)
}
if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`✗ Node >= 20 required (found ${process.version}).`)
  process.exit(1)
}

const FIXED_SLOTS = { alt: 0, t2d: 1, t3d: 2, anim: 3 }
function slotOf(n) {
  if (n in FIXED_SLOTS) return FIXED_SLOTS[n]
  let h = 2166136261
  for (let i = 0; i < n.length; i++) h = Math.imul(h ^ n.charCodeAt(i), 16777619) >>> 0
  return 4 + (h % 28)
}
const slot = slotOf(name)

process.env.SATURA_DEV_INSTANCE = name
process.env.SATURA_BACKGROUND ??= '1'
if (process.env.SATURA_BACKGROUND === '1') process.env.SATURA_WINHOOK_NO_ACTIVATE ??= '1'
process.env.SATURA_DEV_RENDERER_PORT ||= String(5373 + slot)
process.chdir(appDir)

console.log(
  `▶  Satura Space dev instance "${name}": userData satura-space-dev-${name}, renderer :${process.env.SATURA_DEV_RENDERER_PORT}, Unity ports ${12210 + 1000 * slot}+`
)
await createServer({ root: appDir }, { rendererOnly: false })
