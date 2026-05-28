// src/main/system/confirm.test.ts
import { describe, expect, it, vi } from 'vitest'

const { showMessageBoxMock } = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn(),
}))

vi.mock('electron', () => ({
  dialog: { showMessageBox: showMessageBoxMock },
  BrowserWindow: class {},
}))

import { showNativeConfirm } from './confirm'

describe('showNativeConfirm', () => {
  it('routes the chosen button index back to its role', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1, checkboxChecked: false })
    const parent = {} as unknown as Parameters<typeof showNativeConfirm>[0]
    const role = await showNativeConfirm(parent, {
      title: 'Allow file access?',
      message: 'Worker wants to read /tmp.',
      risk: 'high',
      buttons: [
        { label: 'Deny', role: 'deny' },
        { label: 'Allow', role: 'grant' },
      ],
    })
    expect(role).toBe('grant')
  })

  it('uses type:warning for risk=high', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0, checkboxChecked: false })
    await showNativeConfirm({} as never, {
      title: 't',
      message: 'm',
      risk: 'high',
      buttons: [{ label: 'No', role: 'deny' }],
    })
    expect(showMessageBoxMock).toHaveBeenLastCalledWith({}, expect.objectContaining({ type: 'warning', noLink: true }))
  })
})
