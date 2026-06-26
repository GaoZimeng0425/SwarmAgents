// Manual real-LLM smoke for the emergent company prototype. NOT a CI test.
// Run with: SMOKE_API_KEY=<key> [SMOKE_MODEL=...] [SMOKE_API_STYLE=...] [SMOKE_BASE_URL=...] npx tsx scripts/smoke-company.ts
// It seeds the company and gives the CEO a small, self-contained task using a REAL provider,
// then prints the CEO's final reply. Watch the structured logs (components actor-runtime /
// mailbox / actor-state) to observe the CEO->PM->engineer/reviewer collaboration.

import { createConversationStore } from '../src/service/conversation-store'
import { createSessionManager } from '../src/service/session-manager'
import { defaultAgents } from '../src/shared/constants/agents'
import type { ProviderInjection } from '../src/shared/types/provider'

async function main(): Promise<void> {
  const apiKey = process.env.SMOKE_API_KEY
  if (!apiKey) {
    throw new Error(
      'Set SMOKE_API_KEY (and optionally SMOKE_MODEL, SMOKE_API_STYLE, SMOKE_BASE_URL) to run the company smoke.'
    )
  }

  const provider: ProviderInjection = {
    id: 'smoke',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiStyle: (process.env.SMOKE_API_STYLE ?? 'anthropic') as any,
    model: process.env.SMOKE_MODEL ?? 'claude-sonnet-4-6',
    apiKey,
    ...(process.env.SMOKE_BASE_URL ? { baseUrl: process.env.SMOKE_BASE_URL } : {}),
  }

  const store = createConversationStore(':memory:')
  const mgr = createSessionManager({
    store,
    broadcaster: { broadcast: () => {} },
    maxConcurrent: 4,
    getProvider: () => provider,
    agentStore: {
      get: (id: string) => defaultAgents.find((a) => a.id === id),
      list: () => defaultAgents,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  })

  const { sessionId } = mgr.createSession(provider)
  const goal =
    'In a fresh temp directory, implement a TypeScript function `slugify(s: string): string` ' +
    'plus a vitest test, and make the test pass.'

  // eslint-disable-next-line no-console
  console.log('GOAL:', goal)
  const result = await mgr.startCompany(sessionId, goal)
  // eslint-disable-next-line no-console
  console.log('CEO FINAL REPLY:', result)
}

void main()
