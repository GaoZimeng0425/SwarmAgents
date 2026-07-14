// src/main/system/menu.ts
//
// Native app menu. Provides:
//   - File / App menu with Settings (⌘, on Mac, Ctrl-, on Win)
//   - Edit menu with standard cut/copy/paste/select-all (free VoiceOver
//     navigation, ship H.66 partial)
//   - Window menu
import { app, Menu } from 'electron'

export function setupMenu(args: { onOpenSettings: () => void }): void {
  const isMac = process.platform === 'darwin'

  const appMenu: Electron.MenuItemConstructorOptions = isMac
    ? {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: args.onOpenSettings },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }
    : {
        label: 'File',
        submenu: [
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: args.onOpenSettings },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }

  const viewMenu: Electron.MenuItemConstructorOptions = {
    label: 'View',
    submenu: [{ role: 'toggleDevTools' }],
  }

  // Explicit Window submenu. The `{ role: 'windowMenu' }` shorthand omits a
  // Close entry on macOS, so Cmd+W has no binding and the focused window can't
  // be closed via keyboard. Declare Close (Cmd+W) + Minimize + Zoom explicitly
  // so the standard shortcuts are wired up.
  const windowMenu: Electron.MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, { type: 'separator' }, { role: 'front' }],
  }

  const template: Electron.MenuItemConstructorOptions[] = [appMenu, { role: 'editMenu' }, viewMenu, windowMenu]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
