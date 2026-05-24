// src/main/windows/main-window.ts
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { BrowserWindow, shell } from 'electron'

import icon from '../../../resources/icon.png?asset'

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

export function createMainWindow(): BrowserWindow {
  // SKILL.md T3 (adopt the platform): material differs per OS.
  //   macOS:   NSVisualEffectView via electron `vibrancy` + transparent BG.
  //   Win 11:  setBackgroundMaterial('mica') after construction.
  //   Linux:   solid background; transparency unreliable on most WMs.
  const win = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: isMac ? '#00000000' : '#1b1b1f',
    transparent: isMac,
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',
          vibrancy: 'sidebar',
          visualEffectState: 'active',
        }
      : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,   // ship F.49 / F.51
      spellcheck: false,             // ship C.25
    },
  })

  if (isWin) {
    try { win.setBackgroundMaterial('mica') } catch { /* Win 10 fallback: keep solid bg */ }
  }

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
