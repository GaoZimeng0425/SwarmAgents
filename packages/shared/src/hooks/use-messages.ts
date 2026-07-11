import { useEffect } from 'react'
import { applyEvent, type MessageRecord } from '../messages/apply-event'
import type { UIEvent } from '@swarm/protocol'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'

export const MESSAGES_KEY = ['messages'] as const

// The transport-agnostic surface a consumer provides. Desktop implements this
// via window.swarm (preload bridge); mobile implements it via ServiceClient +
// the connection store's eventEmitter.
export type MessageEventSource = {
  getMessageEvents(sessionId: string): Promise<{ event: UIEvent; seq: number; ts: number; messageId: string; parentMessageId: string | null }[]>
  subscribeEvents(cb: (e: UIEvent) => void): () => void
}

/**
 * Read the global MessageRecord[] cache. Same pattern as desktop's useMessages:
 * a no-op queryFn with staleTime: Infinity — the cache is only mutated by
 * events via useMessageEventSubscription.
 */
export function useMessages(): MessageRecord[] {
  const { data } = useQuery<MessageRecord[]>({
    queryKey: MESSAGES_KEY,
    queryFn: () => [],
    staleTime: Number.POSITIVE_INFINITY,
  })
  return data ?? []
}

/**
 * Replay a session's message_events into MessageRecords by reducing UIEvents
 * through applyEvent, then merge into the global cache.
 */
export async function hydrateSession(
  qc: QueryClient,
  source: MessageEventSource,
  sessionId: string
): Promise<void> {
  const rows = await source.getMessageEvents(sessionId)
  const records = [...rows]
    .sort((a, b) => a.seq - b.seq)
    .reduce<MessageRecord[]>((acc, r) => applyEvent(acc, r.event), [])
  qc.setQueryData<MessageRecord[]>(MESSAGES_KEY, (prev = []) => {
    const known = new Set(prev.map((t) => t.id))
    const fresh = records.filter((r) => !known.has(r.id))
    return [...fresh, ...prev]
  })
}

/**
 * Subscribe to live events and fold each into the global MessageRecord[] cache
 * via applyEvent. Returns void; mount once at the app root. The caller passes
 * a MessageEventSource — the transport adapter that provides subscribeEvents.
 */
export function useMessageEventSubscription(source: MessageEventSource | null): void {
  const qc = useQueryClient()

  useEffect(() => {
    if (!source) return
    return source.subscribeEvents((e: UIEvent) => {
      qc.setQueryData<MessageRecord[]>(MESSAGES_KEY, (prev = []) => applyEvent(prev, e))
    })
  }, [qc, source])
}
