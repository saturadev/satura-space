const { spawnSync } = require('node:child_process')
const { notarize } = require('@electron/notarize')

async function stapleWithRetry(appPath) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const res = spawnSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' })
    if (res.status === 0) return
    console.log(`[notarize] staple attempt ${attempt} failed, the ticket may not have propagated yet`)
    await new Promise((r) => setTimeout(r, 20_000))
  }
  throw new Error('[notarize] stapling kept failing after notarization was accepted')
}

function credentials() {
  const env = process.env
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return { label: 'App Store Connect API key', options: { appleApiKey: env.APPLE_API_KEY, appleApiKeyId: env.APPLE_API_KEY_ID, appleApiIssuer: env.APPLE_API_ISSUER } }
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return { label: 'Apple ID', options: { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID } }
  }
  return { label: 'keychain profile satura-notary', options: { keychainProfile: 'satura-notary' } }
}

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return
  if (process.env.SKIP_NOTARIZE === '1') {
    console.log('[notarize] SKIP_NOTARIZE=1 — skipping notarization')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const { label, options } = credentials()
  console.log(`[notarize] submitting ${appName}.app via notarytool (${label})…`)
  const appPath = `${appOutDir}/${appName}.app`
  try {
    await notarize({ tool: 'notarytool', appPath, ...options })
  } catch (e) {
    if (!/staple/i.test(String(e?.message))) throw e
    console.log(`[notarize] ${e.message}`)
    await stapleWithRetry(appPath)
  }
  console.log('[notarize] accepted + stapled.')
}
