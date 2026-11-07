import { ipcMain, type IpcMainInvokeEvent } from 'electron'

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown

const handlers = new Map<string, InvokeHandler>()
const handle = ipcMain.handle.bind(ipcMain)
const handleOnce = ipcMain.handleOnce.bind(ipcMain)
const removeHandler = ipcMain.removeHandler.bind(ipcMain)

ipcMain.handle = (channel: string, listener: InvokeHandler): void => {
  handle(channel, listener)
  handlers.set(channel, listener)
}

ipcMain.handleOnce = (channel: string, listener: InvokeHandler): void => {
  handleOnce(channel, (event, ...args) => {
    handlers.delete(channel)
    return listener(event, ...args)
  })
  handlers.set(channel, (event, ...args) => {
    removeHandler(channel)
    handlers.delete(channel)
    return listener(event, ...args)
  })
}

ipcMain.removeHandler = (channel: string): void => {
  removeHandler(channel)
  handlers.delete(channel)
}

export function tappedInvokeHandler(channel: string): InvokeHandler | undefined {
  return handlers.get(channel)
}

export function tappedListeners(channel: string): ((...args: any[]) => void)[] {
  return ipcMain.listeners(channel) as ((...args: any[]) => void)[]
}
