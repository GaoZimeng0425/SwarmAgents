import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock factories hoist above imports and top-level lets — shared mutable
// state must come from vi.hoisted to avoid the TDZ.
const state = vi.hoisted(() => ({
  handles: new Map<string, unknown>(),
  windows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }>,
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((c: string, fn: unknown) => state.handles.set(c, fn)),
    removeHandler: vi.fn((c: string) => state.handles.delete(c)),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => state.windows),
  },
}))

import { createIpcRegistrar, sendToAllWindows } from './wire'

describe('createIpcRegistrar', () => {
  beforeEach(() => {
    state.handles.clear()
    state.windows = []
  })

  it('registers handlers and dispose removes exactly the registered set', () => {
    const reg = createIpcRegistrar()
    reg.handle('swarm:listSessions', async () => [])
    reg.handle('system:getAccent', () => null)
    expect(state.handles.has('swarm:listSessions')).toBe(true)
    expect(state.handles.has('system:getAccent')).toBe(true)
    reg.dispose()
    expect(state.handles.size).toBe(0)
  })

  it('dispose is idempotent', () => {
    const reg = createIpcRegistrar()
    reg.handle('system:getAccent', () => null)
    reg.dispose()
    expect(() => reg.dispose()).not.toThrow()
  })
})

describe('sendToAllWindows', () => {
  it('sends to live windows and skips destroyed ones', () => {
    const live = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    const dead = { isDestroyed: () => true, webContents: { send: vi.fn() } }
    state.windows = [live, dead]
    sendToAllWindows('system:accentChange', { hex: 'FF0000FF' })
    expect(live.webContents.send).toHaveBeenCalledWith('system:accentChange', { hex: 'FF0000FF' })
    expect(dead.webContents.send).not.toHaveBeenCalled()
  })
})
