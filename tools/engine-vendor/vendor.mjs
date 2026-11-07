import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const UPSTREAM = join(HERE, 'upstream')
const LIBS = resolve(HERE, '../../packages/saturaspace-engine/HotReload/Editor/Libs')
const ILFIXUP = resolve(HERE, '../ilfixup/ilfixup.csproj')
const PREFIX = 'SaturaSpace.Vendor.'

export const VENDOR = [
  ['0Harmony', `${PREFIX}Harmony`],
  ['Microsoft.CodeAnalysis', `${PREFIX}Microsoft.CodeAnalysis`],
  ['Microsoft.CodeAnalysis.CSharp', `${PREFIX}Microsoft.CodeAnalysis.CSharp`],
  ['System.Collections.Immutable', `${PREFIX}System.Collections.Immutable`],
  ['System.Reflection.Metadata', `${PREFIX}System.Reflection.Metadata`],
  ['System.Runtime.CompilerServices.Unsafe', `${PREFIX}System.Runtime.CompilerServices.Unsafe`],
]

function die(msg) {
  console.error(`[engine-vendor] ${msg}`)
  process.exit(1)
}

function unityMono() {
  const roots =
    process.platform === 'darwin'
      ? ['/Applications/Unity/Hub/Editor'].flatMap((r) =>
          existsSync(r) ? readdirSync(r).map((v) => join(r, v, 'Unity.app/Contents/Resources/Scripting')) : []
        )
      : ['C:\\Program Files\\Unity\\Hub\\Editor'].flatMap((r) =>
          existsSync(r) ? readdirSync(r).map((v) => join(r, v, 'Editor', 'Data')) : []
        )
  const dirs = [process.env.SATURA_UNITY_DATA, ...roots].filter(Boolean)
  for (const d of dirs) {
    const mono = join(d, 'MonoBleedingEdge', 'lib', 'mono', '4.5')
    if (existsSync(join(mono, 'mscorlib.dll'))) return [mono, join(mono, 'Facades')]
  }
  return []
}

for (const [from] of VENDOR) {
  if (!existsSync(join(UPSTREAM, `${from}.dll`))) die(`missing upstream ${from}.dll in ${UPSTREAM}`)
}
const lib = unityMono()
if (!lib.length) die('no Unity install found for the Mono corlib; set SATURA_UNITY_DATA')

for (const [, to] of VENDOR) rmSync(join(LIBS, `${to}.dll`), { force: true })

const args = ['run', '--project', ILFIXUP, '-c', 'Release', '--', 'vendor', LIBS, '--prefix', PREFIX]
for (const [from, to] of VENDOR) args.push('--asm', `${join(UPSTREAM, `${from}.dll`)}=${to}`)
args.push('--ivt', `${PREFIX}Harmony=SaturaSpace.HotReload.Editor`)
args.push('--ldstr', `HarmonyLib.Harmony=${PREFIX}HarmonyLib.Harmony`)

try {
  execFileSync(process.env.DOTNET_BIN || 'dotnet', args, {
    stdio: 'inherit',
    env: { ...process.env, ILFIXUP_LIB: lib.join(process.platform === 'win32' ? ';' : ':') },
  })
} catch (e) {
  die(`ilfixup vendor failed (${e.message})`)
}

for (const [, to] of VENDOR) {
  if (!existsSync(join(LIBS, `${to}.dll`))) die(`ilfixup produced no ${to}.dll`)
  if (!existsSync(join(LIBS, `${to}.dll.meta`))) die(`${to}.dll.meta is missing; copy an existing Libs meta with a new guid`)
}
console.log(`[engine-vendor] wrote ${VENDOR.length} renamed assemblies to ${LIBS}`)
