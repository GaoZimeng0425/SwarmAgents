import { describe, expect, it, vi } from 'vitest'

import type { SessionService } from '../session/session-service'
import { createDispatcher } from './dispatcher'

function mockService(): SessionService {
  return {
    createSession: vi.fn().mockReturnValue({ sessionId: 'ses-1' }),
    submitPrompt: vi.fn().mockReturnValue({ runId: 'run-1' }),
    resolvePermission: vi.fn(),
    cancelRun: vi.fn(),
    listSessions: vi.fn().mockReturnValue([{ id: 'ses-1' }]),
  } as unknown as SessionService
}

const mcpDeps = () => ({
  setMcpServers: vi.fn().mockResolvedValue(undefined),
  getMcpStatus: vi.fn().mockReturnValue([]),
  setWebSearchConfig: vi.fn(),
  setBudgetConfig: vi.fn(),
  analyzeEmail: vi.fn().mockReturnValue({ ok: true }),
  listSkills: vi.fn().mockReturnValue([]),
  listAgents: vi.fn().mockReturnValue([{ id: 'ceo' }]),
  saveAgent: vi.fn().mockReturnValue({ ok: true }),
  deleteAgent: vi.fn().mockReturnValue({ ok: true }),
  restoreDefaultAgents: vi.fn().mockReturnValue({ ok: true }),
  saveSkill: vi.fn().mockReturnValue({ ok: true, skills: [] }),
  deleteSkill: vi.fn().mockReturnValue({ ok: true, skills: [] }),
  importSkill: vi.fn().mockReturnValue({ ok: true, skills: [] }),
  getToolToggles: vi.fn().mockReturnValue({}),
  setSkillEnabled: vi.fn().mockReturnValue({}),
  setToolGroupEnabled: vi.fn().mockReturnValue({}),
  listToolGroups: vi.fn().mockReturnValue([]),
  listMemory: vi.fn().mockReturnValue([]),
  listCronJobsForSession: vi.fn().mockReturnValue([]),
  listAllCronJobs: vi.fn().mockReturnValue([]),
  listAllCronRuns: vi.fn().mockReturnValue([]),
  cancelCronJob: vi.fn(),
})

describe('dispatcher', () => {
  it('createSession registers the provider then creates a session', () => {
    const service = mockService()
    const registerProvider = vi.fn()
    const dispatch = createDispatcher({ service, registerProvider, ...mcpDeps() })
    const provider = {
      id: 'anthropic',
      registry: 'anthropic',
      apiStyle: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
    }
    const result = dispatch('createSession', [provider])
    expect(registerProvider).toHaveBeenCalledWith(provider)
    expect(result).toEqual({ sessionId: 'ses-1' })
  })

  it('listAgents returns the agent roster from the store wiring', () => {
    const service = mockService()
    const deps = mcpDeps()
    const dispatch = createDispatcher({ service, registerProvider: vi.fn(), ...deps })
    const result = dispatch('listAgents', [])
    expect(deps.listAgents).toHaveBeenCalled()
    expect(result).toEqual([{ id: 'ceo' }])
  })

  it('submitGoal maps to submitPrompt and returns { runId }', () => {
    const service = mockService()
    const dispatch = createDispatcher({ service, registerProvider: vi.fn(), ...mcpDeps() })
    const result = dispatch('submitGoal', ['ses-1', 'do it'])
    expect(service.submitPrompt).toHaveBeenCalledWith('ses-1', 'do it', undefined, undefined, undefined)
    expect(result).toEqual({ runId: 'run-1' })
  })

  it('submitGoal forwards composer options to submitPrompt', () => {
    const service = mockService()
    const dispatch = createDispatcher({ service, registerProvider: vi.fn(), ...mcpDeps() })
    const options = { cwd: '/w', permissionMode: 'full' as const, executionMode: 'plan' as const }
    dispatch('submitGoal', ['ses-1', 'do it', undefined, options])
    expect(service.submitPrompt).toHaveBeenCalledWith('ses-1', 'do it', undefined, undefined, options)
  })

  it('decidePermission routes to resolvePermission and returns ok', () => {
    const service = mockService()
    const dispatch = createDispatcher({ service, registerProvider: vi.fn(), ...mcpDeps() })
    const result = dispatch('decidePermission', ['ses-1', 'act-1', 'grant'])
    expect(service.resolvePermission).toHaveBeenCalledWith('ses-1', 'act-1', 'grant')
    expect(result).toEqual({ ok: true })
  })

  it('listSessions reads through to the service', () => {
    const service = mockService()
    const dispatch = createDispatcher({ service, registerProvider: vi.fn(), ...mcpDeps() })
    expect(dispatch('listSessions', [])).toEqual([{ id: 'ses-1' }])
  })

  it('cancelRun routes to service.cancelRun and returns ok', () => {
    const service = mockService()
    const dispatch = createDispatcher({ service, registerProvider: vi.fn(), ...mcpDeps() })
    const result = dispatch('cancelRun', ['ses-1', 'run-1'])
    expect(service.cancelRun).toHaveBeenCalledWith('ses-1', 'run-1')
    expect(result).toEqual({ ok: true })
  })

  it('setMcpServers forwards configs and resolves ok', async () => {
    const mcp = mcpDeps()
    const dispatch = createDispatcher({ service: mockService(), registerProvider: vi.fn(), ...mcp })
    const configs = [{ id: 's1', name: 'fs', transport: 'stdio', enabled: true }]
    const result = await dispatch('setMcpServers', [configs])
    expect(mcp.setMcpServers).toHaveBeenCalledWith(configs)
    expect(result).toEqual({ ok: true })
  })

  it('getMcpStatus reads through to the service', () => {
    const mcp = mcpDeps()
    mcp.getMcpStatus.mockReturnValue([{ id: 's1', state: 'connected', tools: [] }])
    const dispatch = createDispatcher({ service: mockService(), registerProvider: vi.fn(), ...mcp })
    expect(dispatch('getMcpStatus', [])).toEqual([{ id: 's1', state: 'connected', tools: [] }])
  })

  it('throws on an unknown method', () => {
    const dispatch = createDispatcher({ service: mockService(), registerProvider: vi.fn(), ...mcpDeps() })
    expect(() => dispatch('nope' as never, [])).toThrow(/unknown method/)
  })

  it('listMemory reads through with the namespace arg', () => {
    const deps = mcpDeps()
    deps.listMemory.mockReturnValue([
      { id: 'ns:k', namespace: 'ns', key: 'k', content: 'c', category: 'note', timestamp: 1 },
    ])
    const dispatch = createDispatcher({ service: mockService(), registerProvider: vi.fn(), ...deps })
    const result = dispatch('listMemory', ['ns'])
    expect(deps.listMemory).toHaveBeenCalledWith('ns')
    expect(result).toEqual([{ id: 'ns:k', namespace: 'ns', key: 'k', content: 'c', category: 'note', timestamp: 1 }])
  })

  it('routes getUsageStats to the service', () => {
    const service = mockService()
    const getUsageStats = vi.fn().mockReturnValue({ rangeDays: 7 })
    const dispatch = createDispatcher({
      service: { ...service, getUsageStats } as unknown as SessionService,
      registerProvider: vi.fn(),
      ...mcpDeps(),
    })
    const result = dispatch('getUsageStats', [7])
    expect(getUsageStats).toHaveBeenCalledWith(7)
    expect(result).toEqual({ rangeDays: 7 })
  })

  it('importSkill forwards sourceDir and overwrite to the store', () => {
    const deps = mcpDeps()
    const dispatch = createDispatcher({ service: mockService(), registerProvider: vi.fn(), ...deps })
    const result = dispatch('importSkill', ['/tmp/my-skill', true])
    expect(deps.importSkill).toHaveBeenCalledWith('/tmp/my-skill', true)
    expect(result).toEqual({ ok: true, skills: [] })
  })
})
