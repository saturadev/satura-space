import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { winBuildEnv } from './win-build-env.mjs'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const addonDir = join(root, 'native', 'shared-surface')
const electronVersion = require(join(root, 'node_modules', 'electron', 'package.json')).version

const env = winBuildEnv({
  ...process.env,
  npm_config_target: electronVersion,
  npm_config_runtime: 'electron',
  npm_config_disturl: 'https://electronjs.org/headers',
  npm_config_dist_url: 'https://electronjs.org/headers',
  npm_config_build_from_source: 'true'
})

console.log(`[build-native] shared-surface for Electron ${electronVersion}`)
execFileSync('node', [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild'], {
  cwd: addonDir,
  env,
  stdio: 'inherit'
})
console.log('[build-native] done')
