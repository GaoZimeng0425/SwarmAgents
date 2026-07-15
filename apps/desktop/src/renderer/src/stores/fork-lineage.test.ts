import { beforeEach, describe, expect, it } from 'vitest'

import { useForkLineage } from './fork-lineage'

describe('fork-lineage store', () => {
  beforeEach(() => {
    useForkLineage.setState({ forkedFrom: {} })
  })

  it('markForked records the fork lineage keyed by the forked session', () => {
    useForkLineage.getState().markForked('fork', 'source')
    expect(useForkLineage.getState().forkedFrom).toEqual({ fork: 'source' })
  })

  it('markForked is idempotent for the same lineage', () => {
    const { markForked } = useForkLineage.getState()
    markForked('fork', 'source')
    const before = useForkLineage.getState().forkedFrom
    markForked('fork', 'source')
    // Same ref — no new object allocated when nothing changes.
    expect(useForkLineage.getState().forkedFrom).toBe(before)
  })

  it('forget drops the fork when its own session is removed', () => {
    useForkLineage.getState().markForked('fork', 'source')
    useForkLineage.getState().forget('fork')
    expect(useForkLineage.getState().forkedFrom).toEqual({})
  })

  it('forget drops forks that pointed at the removed source', () => {
    useForkLineage.getState().markForked('fork', 'source')
    useForkLineage.getState().forget('source')
    expect(useForkLineage.getState().forkedFrom).toEqual({})
  })
})
