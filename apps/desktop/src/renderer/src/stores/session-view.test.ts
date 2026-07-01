import { beforeEach, describe, expect, it } from 'vitest'

import { useSessionView } from './session-view'

describe('session-view store', () => {
  beforeEach(() => {
    useSessionView.setState({ mode: 'flat', directoryOrder: [], collapsed: {} })
  })

  it('defaults to flat mode with no order and nothing collapsed', () => {
    const s = useSessionView.getState()
    expect(s.mode).toBe('flat')
    expect(s.directoryOrder).toEqual([])
    expect(s.collapsed).toEqual({})
  })

  it('setMode switches the view mode', () => {
    useSessionView.getState().setMode('directory')
    expect(useSessionView.getState().mode).toBe('directory')
  })

  it('setDirectoryOrder replaces the order', () => {
    useSessionView.getState().setDirectoryOrder(['/a', '/b'])
    expect(useSessionView.getState().directoryOrder).toEqual(['/a', '/b'])
  })

  it('toggleCollapsed flips a directory on and off', () => {
    const { toggleCollapsed } = useSessionView.getState()
    toggleCollapsed('/a')
    expect(useSessionView.getState().collapsed).toEqual({ '/a': true })
    toggleCollapsed('/a')
    expect(useSessionView.getState().collapsed).toEqual({})
  })
})
