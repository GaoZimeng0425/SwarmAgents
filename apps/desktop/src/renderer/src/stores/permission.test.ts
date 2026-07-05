import { beforeEach, describe, expect, it } from 'vitest'

import { type PermissionPrompt, usePermissionStore } from './permission'

const mk = (actionId: string): PermissionPrompt => ({
  actionId,
  sessionId: 'ses-1',
  runId: 't1',
  risk: 'medium',
  summary: 's',
  payload: {},
})

describe('usePermissionStore', () => {
  beforeEach(() => {
    usePermissionStore.setState({ queue: [] })
  })

  it('push adds a prompt', () => {
    usePermissionStore.getState().push(mk('a1'))
    expect(usePermissionStore.getState().queue).toHaveLength(1)
  })

  it('push dedupes by actionId', () => {
    usePermissionStore.getState().push(mk('a1'))
    usePermissionStore.getState().push(mk('a1'))
    expect(usePermissionStore.getState().queue).toHaveLength(1)
  })

  it('remove by actionId', () => {
    usePermissionStore.getState().push(mk('a1'))
    usePermissionStore.getState().push(mk('a2'))
    usePermissionStore.getState().remove('a1')
    expect(usePermissionStore.getState().queue.map((p) => p.actionId)).toEqual(['a2'])
  })
})
