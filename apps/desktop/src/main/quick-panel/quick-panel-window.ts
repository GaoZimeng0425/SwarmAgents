// The floating quick-panel BrowserWindow: frameless, always-on-top, skip
// taskbar, blur-to-hide. Created once at app ready (show:false) and reused —
// toggle()/show()/hide() never destroy it. show() recenters on the cursor's
// display so the panel follows the user across multi-monitor setups.
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { createLogger } from '@shared/logger'
import { BrowserWindow, screen } from 'electron'

const log = createLogger({ process: 'main' }).child({ component: 'quick-panel-window' })

const isMac = process.platform === 'darwin'

let panelRef: BrowserWindow | null = null

const PANEL_WIDTH = 640
const PANEL_HEIGHT_INITIAL = 400
const PANEL_HEIGHT_MAX = 600

export function createQuickPanelWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT_INITIAL,
    frame: false,
    show: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: isMac ? '#00000000' : '#1b1b1f',
    transparent: isMac,
    ...(isMac ? { vibrancy: 'menu' as const, visualEffectState: 'active' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })

  // Blur-to-hide: clicking outside the panel hides it. Running agent tasks
  // continue in the service process — hiding the window doesn't stop them.
  win.on('blur', () => {
    if (!win.isDestroyed()) {
      hideQuickPanel()
      log.debug({ msg: 'panel hidden on blur' })
    }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/quick-panel`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'quick-panel' })
  }

  panelRef = win
  log.info({ msg: 'quick panel window created' })
  return win
}

export function getQuickPanelWindow(): BrowserWindow | null {
  return panelRef && !panelRef.isDestroyed() ? panelRef : null
}

/** Center the panel on the display nearest the mouse cursor. */
function recenter(): void {
  const win = getQuickPanelWindow()
  if (!win) return
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const [w, h] = win.getSize()
  const x = Math.round(display.bounds.x + (display.bounds.width - w) / 2)
  const y = Math.round(display.bounds.y + (display.bounds.height - h) / 2)
  win.setPosition(x, y, false)
}

export function showQuickPanel(): void {
  const win = getQuickPanelWindow()
  if (!win) return
  recenter()
  // Reset to initial height each time it's shown (chat mode may have grown it).
  win.setSize(PANEL_WIDTH, PANEL_HEIGHT_INITIAL)
  win.show()
  win.focus()
  log.info({ msg: 'panel shown' })
}

export function hideQuickPanel(): void {
  const win = getQuickPanelWindow()
  if (!win) return
  win.hide()
  log.info({ msg: 'panel hidden' })
}

export function toggleQuickPanel(): void {
  const win = getQuickPanelWindow()
  if (!win) return
  if (win.isVisible() && win.isFocused()) {
    hideQuickPanel()
  } else {
    showQuickPanel()
  }
}

/** Called by the resize IPC to grow/shrink the panel to fit content. */
export function resizeQuickPanel(height: number): void {
  const win = getQuickPanelWindow()
  if (!win) return
  const clamped = Math.max(PANEL_HEIGHT_INITIAL, Math.min(height, PANEL_HEIGHT_MAX))
  const [w] = win.getSize()
  win.setSize(w, clamped, false)
  log.debug({ msg: 'panel resized', height: clamped })
}
