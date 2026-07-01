import { beforeEach, describe, expect, it } from 'vitest'

import { useUiStore } from './ui'

describe('useUiStore', () => {
  beforeEach(() => {
    useUiStore.setState({ selectedTaskId: null })
  })

  it('setSelected updates selectedTaskId', () => {
    useUiStore.getState().setSelected('t1')
    expect(useUiStore.getState().selectedTaskId).toBe('t1')
  })

  it('setSelected(null) clears', () => {
    useUiStore.getState().setSelected('t1')
    useUiStore.getState().setSelected(null)
    expect(useUiStore.getState().selectedTaskId).toBeNull()
  })
})
