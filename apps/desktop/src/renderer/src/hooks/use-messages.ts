import type { PermissionDecision } from '@swarm/protocol'
import { useMutation } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'
import { usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

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
      options?: import('@swarm/protocol').SubmitOptions
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

/** Cancel the session's in-flight run (aborts the agent run server-side). */
export function useCancelRun() {
  return useMutation({
    mutationFn: (sessionId: string) => swarmApi.cancelRun(sessionId),
  })
}
