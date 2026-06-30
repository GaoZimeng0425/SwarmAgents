// src/main/gmail/ipc.test.ts
import { describe, expect, it, vi } from 'vitest'

import { wireGmailIpc } from './ipc'

// Minimal electron ipcMain stub capturing handlers.
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  BrowserWindow: { getAllWindows: () => [] },
}))

describe('gmail ipc', () => {
  it('getStatus delegates to service.getView', async () => {
    const view = {
      hasClientCreds: true,
      loggedIn: false,
      accountEmail: null,
      lastSyncAt: null,
      messageCount: null,
      syncError: null,
    }
    const service = { getView: () => view, onStateChanged: () => () => {} } as unknown as Parameters<
      typeof wireGmailIpc
    >[0]['service']
    const { dispose } = wireGmailIpc({ service })
    const r = await handlers.get('gmail:getStatus')!()
    expect(r).toEqual(view)
    dispose()
  })

  it('setClientCreds delegates and returns SetResult', async () => {
    const service = {
      setClientCreds: vi.fn(async () => ({ ok: true as const })),
      getView: () => null,
      onStateChanged: () => () => {},
    } as unknown as Parameters<typeof wireGmailIpc>[0]['service']
    const { dispose } = wireGmailIpc({ service })
    const r = await handlers.get('gmail:setClientCreds')!({}, { clientId: 'c', clientSecret: 's' })
    expect(r).toEqual({ ok: true })
    expect(service.setClientCreds).toHaveBeenCalledWith({ clientId: 'c', clientSecret: 's' })
    dispose()
  })

  it('main-rpc handlers map gmail.search → service.search', async () => {
    const service = {
      search: vi.fn(() => [{ id: 't1' }]),
      getView: () => null,
      onStateChanged: () => () => {},
    } as unknown as Parameters<typeof wireGmailIpc>[0]['service']
    const { dispose, mainRpcHandlers } = wireGmailIpc({ service })
    const r = await mainRpcHandlers['gmail.search']('inv', 10)
    expect(r).toEqual([{ id: 't1' }])
    expect(service.search).toHaveBeenCalledWith('inv', 10)
    dispose()
  })
})
