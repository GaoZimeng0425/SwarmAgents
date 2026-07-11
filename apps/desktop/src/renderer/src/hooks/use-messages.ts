import { applyEvent, type MessageRecord } from '@shared/lib/apply-event'
import type { PermissionDecision } from '@swarm/protocol'
import { useMutation, useQuery, type useQueryClient } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'
import { usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

export const MESSAGES_KEY = ['messages'] as const

export function useMessages(): MessageRecord[] {
  const { data } = useQuery<MessageRecord[]>({
    queryKey: MESSAGES_KEY,
    queryFn: () => [],
    staleTime: Number.POSITIVE_INFINITY,
  })
  return data ?? []
}

/**
 * Submit a prompt to the currently-selected session, creating one if needed.
 * Returns the resolved sessionId so callers landing on `/` (no selection yet)
 * can navigate to the freshly-created session.
 */
export function useSubmitPrompt() {
  return useMutation({
    mutationFn: async ({
      prompt,
      attachments,
      options,
      forceNew,
    }: {
      prompt: string
      attachments?: import('@swarm/protocol').Attachment[]
      options?: import('@swarm/protocol').RunOptions
      forceNew?: boolean
    }): Promise<{ sessionId: string }> => {
      let sessionId = forceNew ? null : useSessionsStore.getState().selectedSessionId
      if (!sessionId) {
        const created = await swarmApi.createSession()
        sessionId = created.sessionId
        useSessionsStore.getState().select(sessionId)
      }
      await swarmApi.submitPrompt(sessionId, prompt, attachments, options)
      // Persist the turn's composer controls onto the session so it reopens with
      // them — covers the home-composer first turn, where the session was just
      // created with no settings yet.
      if (options) {
        const settings = {
          cwd: options.cwd,
          permissionMode: options.permissionMode,
          executionMode: options.executionMode,
        }
        void swarmApi.updateSessionSettings(sessionId, settings)
        useSessionsStore.getState().setSettings(sessionId, settings)
      }
      return { sessionId }
    },
  })
}

/** Load the session list. The active session is driven by the route, not here. */
export function useLoadSessions() {
  return useMutation({
    mutationFn: async () => {
      const sessions = await swarmApi.listSessions()
      useSessionsStore.getState().setSessions(sessions)
      return sessions
    },
  })
}

/** Replay a session's message_events into MessageRecords by reducing UIEvents through applyEvent. */
export async function hydrateSession(qc: ReturnType<typeof useQueryClient>, sessionId: string): Promise<void> {
  const rows = await swarmApi.getMessageEvents(sessionId)
  const records = [...rows]
    .sort((a, b) => a.seq - b.seq)
    .reduce<MessageRecord[]>((acc, r) => applyEvent(acc, r.event), [])
  qc.setQueryData<MessageRecord[]>(MESSAGES_KEY, (prev = []) => {
    const known = new Set(prev.map((t) => t.id))
    const fresh = records.filter((r) => !known.has(r.id))
    return [...fresh, ...prev]
  })
}

export function useDecidePermission() {
  const remove = usePermissionStore((s) => s.remove)
  return useMutation({
    mutationFn: ({
      sessionId,
      actionId,
      decision,
    }: {
      sessionId: string
      actionId: string
      decision: PermissionDecision
    }) => swarmApi.decidePermission(sessionId, actionId, decision),
    onSuccess: (_, { actionId }) => remove(actionId),
  })
}

/** Cancel an in-flight message (aborts the agent run server-side). */
export function useCancelMessage() {
  return useMutation({
    mutationFn: ({ sessionId, messageId }: { sessionId: string; messageId: string }) =>
      swarmApi.cancelMessage(sessionId, messageId),
  })
}

/** Interrupt the running message and run a queued message next (promotes it to front). */
export function usePromoteQueuedMessage() {
  return useMutation({
    mutationFn: ({ sessionId, messageId }: { sessionId: string; messageId: string }) =>
      swarmApi.promoteQueuedMessage(sessionId, messageId),
  })
}
