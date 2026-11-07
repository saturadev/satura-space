import { app } from 'electron'

export const inBackground = !app.isPackaged && process.env.SATURA_BACKGROUND === '1'

if (inBackground && process.platform === 'darwin') app.setActivationPolicy('accessory')
