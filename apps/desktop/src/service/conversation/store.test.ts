// @vitest-environment node

import type { ProviderInjection, SessionEntry } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { createConversationStore } from './store'

const provider = { id: 'p', model: 'm', apiKey: 'k' } as unknown as ProviderInjection

let seq = 0
function usageEntry(runId: string, data: Record<string, unknown>): SessionEntry {
  seq += 1
  return {
    type: 'custom',
    customType: 'usage',
    id: `u-${seq}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    data: { runId, ...data },
  }
}

describe('conversation store — listSessions usage aggregation', () => {
  it('surfaces tokensUsed/usdCents + contextTokens/contextWindow from usage custom entries', () => {
    const store = createConversationStore(':memory:')
    try {
      store.createSession('s1', provider)
      // Two turns of the same run: latest snapshot wins (tokens/usdCents are
      // latest-per-run; contextTokens/contextWindow are the session's newest entry).
      store.entries.append(
        's1',
        usageEntry('r1', { model: 'm', used: { tokens: 100, usdCents: 5 }, contextTokens: 100, contextWindow: 200_000 })
      )
      store.entries.append(
        's1',
        usageEntry('r1', { model: 'm', used: { tokens: 150, usdCents: 8 }, contextTokens: 150, contextWindow: 200_000 })
      )

      const row = store.listSessions().find((s) => s.id === 's1')
      if (!row) throw new Error('s1 not listed')
      expect(row.tokensUsed).toBe(150)
      expect(row.usdCents).toBe(8)
      expect(row.contextTokens).toBe(150) // newest usage entry, not summed
      expect(row.contextWindow).toBe(200_000)
    } finally {
      store.close()
    }
  })

  it('leaves context fields undefined for a session with no usage entries', () => {
    const store = createConversationStore(':memory:')
    try {
      store.createSession('s2', provider)
      const row = store.listSessions().find((s) => s.id === 's2')
      if (!row) throw new Error('s2 not listed')
      expect(row.contextTokens).toBeUndefined()
      expect(row.contextWindow).toBeUndefined()
      expect(row.tokensUsed).toBe(0)
      expect(row.taskCount).toBe(0)
    } finally {
      store.close()
    }
  })
})
