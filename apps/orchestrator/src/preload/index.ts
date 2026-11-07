import { contextBridge, ipcRenderer, webFrame, webUtils, type IpcRendererEvent } from 'electron'
import { createApi, type IpcTransport } from '@shared/create-api'
import { installSharedTextureView, dropSharedTexture, onSharedFrame, sharedTextureStats } from './shared-texture-view'
import { dropTunerSurface, onTunerFrame, tunerSurfaceRequest } from './tuner-frames'
import { SATURA_DEBUG } from '@shared/debug-log'
import { APP_PAGE_ARG, isAppPage } from '@shared/app-page'

const transport: IpcTransport = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),
  on: (channel, listener) => {
    const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => listener(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

const api = createApi(transport, {
  getZoomFactor: () => webFrame.getZoomFactor(),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  dropSharedTexture,
  sharedStats: () => sharedTextureStats(),
  onSharedFrame: (cb) => onSharedFrame(cb),
  onTunerFrame: (cb) => onTunerFrame(cb),
  tunerSurface: (projectPath, session) => tunerSurfaceRequest(projectPath, session),
  dropTunerSurface: (projectPath, session) => dropTunerSurface(projectPath, session)
})

const page = process.argv.find((a) => a.startsWith(APP_PAGE_ARG))?.slice(APP_PAGE_ARG.length)

if (page && isAppPage(location.href, page)) {
  contextBridge.exposeInMainWorld('api', api)
  contextBridge.exposeInMainWorld('saturaDebug', SATURA_DEBUG)
  installSharedTextureView()
} else console.warn(`[preload] ${location.href.slice(0, 200)} is not the Satura page, window.api stays off`)
