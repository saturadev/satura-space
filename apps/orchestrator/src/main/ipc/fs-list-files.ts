import { ipcMain } from 'electron'
import { homedir } from 'node:os'
import { walkFiles } from './fs-walk'

const MAX_FILES = 200000

export function registerFsListFiles(): void {
  ipcMain.handle('fs:listFiles', async (_e, rootPath: string): Promise<string[]> => {
    const root = typeof rootPath === 'string' && rootPath ? rootPath : homedir()
    const out: string[] = []
    let n = 0
    for await (const { rel } of walkFiles(root)) {
      out.push(rel)
      if (++n >= MAX_FILES) break
      if (n % 2000 === 0) await new Promise((r) => setImmediate(r))
    }
    return out
  })
}
