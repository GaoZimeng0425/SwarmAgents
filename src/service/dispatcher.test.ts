import { describe, it, expect, vi } from 'vitest'
import { createDispatcher } from './dispatcher'
import type { SessionManager } from './session-manager'

function mockManager(): SessionManager {
  return {
    createSession: vi.fn().mockReturnValue({ sessionId: 'ses-1' }),
    submitGoal: vi.fn().mockReturnValue({ taskId: 'task-1' }),
    resolvePermission: vi.fn(),
    endSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([{ id: 'ses-1' }]),
    getSessionTasks: vi.fn().mockReturnValue([]),
  } as unknown as SessionManager
}

describe('dispatcher', () => {
  it('createSession registers the provider then creates a session', () => {
    const manager = mockManager()
    const registerProvider = vi.fn()
    const dispatch = createDispatcher({ manager, registerProvider })
    const provider = { id: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' }
    const result = dispatch('createSession', [provider])
    expect(registerProvider).toHaveBeenCalledWith(provider)
    expect(result).toEqual({ sessionId: 'ses-1' })
  })

  it('submitGoal forwards to the manager', () => {
    const manager = mockManager()
    const dispatch = createDispatcher({ manager, registerProvider: vi.fn() })
    const result = dispatch('submitGoal', ['ses-1', 'do it'])
    expect(manager.submitGoal).toHaveBeenCalledWith('ses-1', 'do it')
    expect(result).toEqual({ taskId: 'task-1' })
  })

  it('decidePermission routes to resolvePermission and returns ok', () => {
    const manager = mockManager()
    const dispatch = createDispatcher({ manager, registerProvider: vi.fn() })
    const result = dispatch('decidePermission', ['ses-1', 'act-1', 'grant'])
    expect(manager.resolvePermission).toHaveBeenCalledWith('ses-1', 'act-1', 'grant')
    expect(result).toEqual({ ok: true })
  })

  it('listSessions / getSessionTasks read through to the manager', () => {
    const manager = mockManager()
    const dispatch = createDispatcher({ manager, registerProvider: vi.fn() })
    expect(dispatch('listSessions', [])).toEqual([{ id: 'ses-1' }])
    expect(dispatch('getSessionTasks', ['ses-1'])).toEqual([])
  })

  it('cancelTask is a no-op returning ok', () => {
    const dispatch = createDispatcher({ manager: mockManager(), registerProvider: vi.fn() })
    expect(dispatch('cancelTask', ['ses-1', 'task-1'])).toEqual({ ok: true })
  })

  it('throws on an unknown method', () => {
    const dispatch = createDispatcher({ manager: mockManager(), registerProvider: vi.fn() })
    expect(() => dispatch('nope' as never, [])).toThrow(/unknown method/)
  })
})
