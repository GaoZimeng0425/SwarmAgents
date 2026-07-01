import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { MemoryStore } from '../memory/store'
import type { ToolSpec } from './registry'

const DEFAULT_NAMESPACE = 'default'
const DEFAULT_CATEGORY = 'note'
const DEFAULT_LIMIT = 5

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const RememberParams = Type.Object({
  key: Type.String({ description: 'Stable identifier for this memory; remembering the same key overwrites it.' }),
  content: Type.String({ description: 'The fact to remember.' }),
  category: Type.Optional(Type.String({ description: 'Optional label, e.g. "fact", "preference" (default "note").' })),
  namespace: Type.Optional(Type.String({ description: 'Optional bucket for isolation (default "default").' })),
})

const RecallParams = Type.Object({
  query: Type.String({ description: 'Search text; entries are ranked by token overlap with their content.' }),
  limit: Type.Optional(Type.Number({ description: 'Max entries to return (default 5).' })),
  category: Type.Optional(Type.String({ description: 'Restrict to a category.' })),
  namespace: Type.Optional(Type.String({ description: 'Restrict to a namespace (default "default").' })),
})

const ForgetParams = Type.Object({
  key: Type.String({ description: 'The key of the memory to remove.' }),
  namespace: Type.Optional(Type.String({ description: 'Namespace the key lives in (default "default").' })),
})

function rememberTool(store: MemoryStore): AgentTool {
  return {
    name: 'remember',
    label: 'Remember',
    description: 'Persist a fact to long-term memory under a key so it can be recalled in later tasks.',
    parameters: RememberParams,
    execute: async (_id: string, params: unknown) => {
      const p = params as { key: string; content: string; category?: string; namespace?: string }
      if (!p.key) return err('key is required')
      if (!p.content) return err('content is required')
      const namespace = p.namespace ?? DEFAULT_NAMESPACE
      store.store(namespace, p.key, p.content, p.category ?? DEFAULT_CATEGORY)
      return ok(`remembered "${p.key}" in ${namespace}`, { key: p.key, namespace })
    },
  }
}

function recallTool(store: MemoryStore): AgentTool {
  return {
    name: 'recall',
    label: 'Recall',
    description: 'Search long-term memory for entries matching a query and return the best matches.',
    parameters: RecallParams,
    execute: async (_id: string, params: unknown) => {
      const p = params as { query: string; limit?: number; category?: string; namespace?: string }
      if (!p.query) return err('query is required')
      const namespace = p.namespace ?? DEFAULT_NAMESPACE
      const entries = store.recall(p.query, p.limit ?? DEFAULT_LIMIT, { namespace, category: p.category })
      if (entries.length === 0) return ok(`no matches for "${p.query}" in ${namespace}`, { count: 0 })
      const text = entries.map((e) => `- [${e.category}] ${e.key}: ${e.content}`).join('\n')
      return ok(text, { count: entries.length, namespace })
    },
  }
}

function forgetTool(store: MemoryStore): AgentTool {
  return {
    name: 'forget',
    label: 'Forget',
    description: 'Remove a remembered entry by key.',
    parameters: ForgetParams,
    execute: async (_id: string, params: unknown) => {
      const p = params as { key: string; namespace?: string }
      if (!p.key) return err('key is required')
      const namespace = p.namespace ?? DEFAULT_NAMESPACE
      const removed = store.forget(namespace, p.key)
      return ok(removed ? `forgot "${p.key}" in ${namespace}` : `no memory "${p.key}" in ${namespace}`, {
        removed,
        key: p.key,
        namespace,
      })
    },
  }
}

// Memory tools close over the service-owned store at registration time (like
// peekaboo), so build() ignores the per-task context. All are low risk:
// internal bookkeeping with no system or external side effects.
export function memorySpecs(store: MemoryStore): ToolSpec[] {
  const tools = [rememberTool(store), recallTool(store), forgetTool(store)]
  return tools.map((tool) => ({
    group: 'memory',
    name: tool.name,
    risk: 'low' as const,
    source: 'builtin' as const,
    build: () => tool,
  }))
}
