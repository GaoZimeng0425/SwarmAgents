// src/main/system/context-menu.ts
//
// v1: suppress WebKit's "Reload / Inspect Element" menu entirely (ship C.23).
// v1.1 (deferred): populate a native Menu when params.isEditable === true
// with copy/paste/select-all. Tracked in spec §10 deferrals.
import type { BrowserWindow } from 'electron'

export function suppressContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (e) => {
    e.preventDefault()
  })
}
