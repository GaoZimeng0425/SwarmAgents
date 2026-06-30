//
// gmail.* built-in tools. Each tool is a thin client over the local cache via
// the service→main rpc: search/get_thread/list_recent. Read-only ⇒ risk 'low'.
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { MainMethod } from '@shared/types/service-ipc'

import type { ToolSpec } from '../tools/registry'

type MainRpcFn = (method: MainMethod, args: unknown[]) => Promise<unknown>

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const SearchParams = Type.Object({
  query: Type.String({ description: 'Substring to search for in subject/snippet/from/body (case-insensitive).' }),
  limit: Type.Optional(Type.Number({ description: 'Max threads to return (default 20).' })),
})
const GetThreadParams = Type.Object({
  id: Type.String({ description: 'Gmail thread id.' }),
})
const ListRecentParams = Type.Object({
  limit: Type.Optional(Type.Number({ description: 'Max threads (default 20).' })),
  label: Type.Optional(Type.String({ description: 'Gmail label to filter by (default INBOX).' })),
})

function searchSpec(mainRpc: MainRpcFn): ToolSpec {
  return {
    group: 'gmail',
    name: 'search',
    risk: 'low',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'search',
      label: 'Search Gmail',
      description:
        'Search the locally-cached Gmail mailbox by substring (subject/snippet/from/body) and return matching threads. Cache is kept fresh by a background sync; for very recent mail call gmail.list_recent.',
      parameters: SearchParams,
      execute: async (_id, params) => {
        const p = params as { query?: string; limit?: number }
        const query = (p.query ?? '').trim()
        if (!query) return err('empty query')
        const limit = p.limit ?? 20
        try {
          const rows = (await mainRpc('gmail.search', [query, limit])) as unknown[]
          if (rows.length === 0) return ok('(no matching threads)', { count: 0, query })
          const text = rows
            .map((r, i) => {
              const t = r as { subject?: string; fromAddr?: string; snippet?: string; id?: string }
              return `${i + 1}. ${t.subject ?? '(no subject)'} — ${t.fromAddr ?? ''}\n   [${t.id ?? ''}] ${t.snippet ?? ''}`
            })
            .join('\n\n')
          return ok(text, { count: rows.length, query })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }
}

function getThreadSpec(mainRpc: MainRpcFn): ToolSpec {
  return {
    group: 'gmail',
    name: 'get_thread',
    risk: 'low',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'get_thread',
      label: 'Get Gmail thread',
      description: 'Return a single Gmail thread with its full message bodies (plain text) from the local cache.',
      parameters: GetThreadParams,
      execute: async (_id, params) => {
        const p = params as { id?: string }
        const id = (p.id ?? '').trim()
        if (!id) return err('missing id')
        try {
          const r = (await mainRpc('gmail.get_thread', [id])) as {
            thread: { subject?: string }
            messages: { bodyText?: string; fromAddr?: string }[]
          } | null
          if (!r) return ok('(thread not in cache)', { id })
          const text = r.messages
            .map((m, i) => `${i + 1}. ${m.fromAddr ?? ''}\n${m.bodyText ?? ''}`)
            .join('\n\n---\n\n')
          return ok(text || '(empty thread)', { id, subject: r.thread.subject, messages: r.messages.length })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }
}

function listRecentSpec(mainRpc: MainRpcFn): ToolSpec {
  return {
    group: 'gmail',
    name: 'list_recent',
    risk: 'low',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'list_recent',
      label: 'List recent Gmail',
      description:
        'List the most recent threads in the local cache (optionally filtered by Gmail label). Use this to see what just arrived.',
      parameters: ListRecentParams,
      execute: async (_id, params) => {
        const p = (params as { limit?: number; label?: string }) ?? {}
        const input = { limit: p.limit ?? 20, label: p.label }
        try {
          const rows = (await mainRpc('gmail.list_recent', [input])) as unknown[]
          if (rows.length === 0) return ok('(mailbox cache is empty — is Gmail linked?)', { count: 0 })
          const text = rows
            .map((r, i) => {
              const t = r as { subject?: string; fromAddr?: string; id?: string }
              return `${i + 1}. ${t.subject ?? '(no subject)'} — ${t.fromAddr ?? ''} [${t.id ?? ''}]`
            })
            .join('\n')
          return ok(text, { count: rows.length })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }
}

export function gmailSpecs(mainRpc: MainRpcFn): ToolSpec[] {
  return [searchSpec(mainRpc), getThreadSpec(mainRpc), listRecentSpec(mainRpc)]
}
