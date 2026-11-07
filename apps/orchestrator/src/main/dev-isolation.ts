import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEV_INSTANCE_ENV, devInstanceName } from './dev-instance'

if (app.isPackaged) delete process.env[DEV_INSTANCE_ENV]
const devInstance = devInstanceName()
delete process.env.SATURA_AGENT_HOOKS_ENDPOINT
if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) app.commandLine.appendSwitch('disable-http-cache')

if (devInstance) {
  app.setName(`Satura Space Dev (${process.env.SATURA_DEV_KEYCHAIN || devInstance})`)
  app.setPath('userData', join(app.getPath('appData'), `satura-space-dev-${devInstance}`))
  process.env.SATURA_AGENT_HOOKS_ENDPOINT = join(app.getPath('userData'), 'agent-hooks', 'endpoint')
  console.log(`[dev-instance] "${devInstance}" userData=${app.getPath('userData')}`)
} else if (!app.isPackaged) {
  app.setName('Satura Space Dev')
  const appData = app.getPath('appData')
  const devUserData = join(appData, 'satura-space-dev')
  try {
    const shared = join(appData, 'satura-space', 'satura-space-data.json')
    const devData = join(devUserData, 'satura-space-data.json')
    if (existsSync(shared) && !existsSync(devData)) {
      mkdirSync(devUserData, { recursive: true })
      copyFileSync(shared, devData)
    }
  } catch {
  }
  app.setPath('userData', devUserData)
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}
