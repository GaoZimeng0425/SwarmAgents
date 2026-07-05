import { describe, expect, it } from 'vitest'

import { createPermissionGate } from './gate'

describe('PermissionGate (skeleton — no UI yet)', () => {
  it('low-risk requests are auto-granted', async () => {
    const gate = createPermissionGate({ defaultPolicy: 'prompt-on-medium-and-high' })
    const decision = await gate.evaluate({
      runId: 't1',
      actionId: 'a1',
      risk: 'low',
      summary: 'reading screen',
      payload: {},
    })
    expect(decision).toBe('grant')
  })

  it('medium-risk requests await an external decision callback', async () => {
    const gate = createPermissionGate({ defaultPolicy: 'prompt-on-medium-and-high' })
    gate.setPromptHandler(async () => 'grant')
    const decision = await gate.evaluate({
      runId: 't1',
      actionId: 'a2',
      risk: 'medium',
      summary: 'click button',
      payload: {},
    })
    expect(decision).toBe('grant')
  })

  it('high-risk denial is honored', async () => {
    const gate = createPermissionGate({ defaultPolicy: 'prompt-on-medium-and-high' })
    gate.setPromptHandler(async () => 'deny')
    const decision = await gate.evaluate({
      runId: 't1',
      actionId: 'a3',
      risk: 'high',
      summary: 'quit app',
      payload: {},
    })
    expect(decision).toBe('deny')
  })

  it('throws if prompt handler is required but unset', async () => {
    const gate = createPermissionGate({ defaultPolicy: 'prompt-on-medium-and-high' })
    await expect(
      gate.evaluate({ runId: 't1', actionId: 'a4', risk: 'medium', summary: 's', payload: {} })
    ).rejects.toThrow(/no prompt handler/i)
  })
})
