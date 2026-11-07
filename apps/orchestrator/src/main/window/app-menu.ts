import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { simulateUpdateRestart } from '../session-restore'

export function buildAppMenu(): Menu {
  const isMac = process.platform === 'darwin'

  const editMenu: MenuItemConstructorOptions = {
    role: 'editMenu',
    submenu: [
      { role: 'undo', registerAccelerator: false },
      { role: 'redo', registerAccelerator: false },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      {
        label: 'Paste',
        accelerator: 'CmdOrCtrl+V',
        click: () => {
          BrowserWindow.getFocusedWindow()?.webContents.send('ui:appMenuPaste')
        }
      },
      { role: 'selectAll', registerAccelerator: false }
    ]
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    editMenu,
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    ...(app.isPackaged
      ? []
      : [
          {
            label: 'Dev',
            submenu: [
              {
                label: 'Simulate Update Restart',
                accelerator: 'CmdOrCtrl+Alt+U',
                click: () => {
                  void simulateUpdateRestart().catch((err) =>
                    console.error('[dev] simulate update restart failed:', err)
                  )
                }
              }
            ]
          } as MenuItemConstructorOptions
        ])
  ]

  return Menu.buildFromTemplate(template)
}

export function installAppMenu(): void {
  Menu.setApplicationMenu(buildAppMenu())
}
