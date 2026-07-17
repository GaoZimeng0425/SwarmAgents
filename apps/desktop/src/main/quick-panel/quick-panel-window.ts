// The floating quick-panel BrowserWindow: frameless, always-on-top, skip
// taskbar, blur-to-hide. Created once at app ready (show:false) and reused —
// toggle()/show()/hide() never destroy it. show() recenters on the cursor's
// display so the panel follows the user across multi-monitor setups.
//
// Fixed height: the panel never resizes (skill native-feel A.3/A.4 — a
// count-based resize caused visible height jitter as the user typed and the
// result list changed). Freezing the height removes the jitter entirely and
// lets the results list scroll internally instead. Raycast/Alfred-class
// launchers use the same fixed-height model.
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { createLogger } from '@shared/logger'
import { BrowserWindow, screen } from 'electron'

const log = createLogger({ process: 'main' }).child({ component: 'quick-panel-window' })

const isMac = process.platform === 'darwin'

let panelRef: BrowserWindow | null = null

const PANEL_WIDTH = 640
const PANEL_HEIGHT = 600

export function createQuickPanelWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
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
