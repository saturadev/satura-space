import { app } from 'electron'
import { rgPath as bundledRgPath } from '@vscode/ripgrep'

export function resolveRgPath(): string {
  return app.isPackaged
    ? bundledRgPath.replace('app.asar', 'app.asar.unpacked')
    : bundledRgPath
}
