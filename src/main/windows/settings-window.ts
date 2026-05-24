// src/main/windows/settings-window.ts
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { BrowserWindow } from 'electron'

import { suppressContextMenu } from '../system/context-menu'

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

let settingsWin: BrowserWindow | null = null

export function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus()
    return
  }

  const win = new BrowserWindow({
    width: 720,
    height: 520,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    backgroundColor: isMac ? '#00000000' : '#1b1b1f',
    transparent: isMac,
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          vibrancy: 'sidebar' as const,
          visualEffectState: 'active' as const,
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })

  if (isWin) {
    try {
      win.setBackgroundMaterial('mica')
    } catch {
      /* fallback solid */
    }
  }

  suppressContextMenu(win)
  win.on('ready-to-show', () => {
    win.show()
  })
  win.on('closed', () => {
    settingsWin = null
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/settings.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/settings.html'))
  }

  settingsWin = win
}
