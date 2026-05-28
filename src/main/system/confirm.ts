// src/main/system/confirm.ts
//
// Replaces DOM modal overlays (ship B.19 anti-pattern) with a native
// dialog.showMessageBox. Used by the renderer's high-risk permission flow.

import type { ConfirmRequest, ConfirmResponse } from '@shared/types/ipc'
import { type BrowserWindow, dialog } from 'electron'

export async function showNativeConfirm(parent: BrowserWindow, req: ConfirmRequest): Promise<ConfirmResponse> {
  const grantIdx = req.buttons.findIndex((b) => b.role === 'grant')
  const denyIdx = req.buttons.findIndex((b) => b.role === 'deny')
  const { response } = await dialog.showMessageBox(parent, {
    type: req.risk === 'high' ? 'warning' : 'question',
    title: req.title,
    message: req.message,
    detail: req.detail,
    buttons: req.buttons.map((b) => b.label),
    defaultId: grantIdx >= 0 ? grantIdx : 0,
    cancelId: denyIdx >= 0 ? denyIdx : req.buttons.length - 1,
    noLink: true,
  })
  return req.buttons[response]?.role ?? 'deny'
}
