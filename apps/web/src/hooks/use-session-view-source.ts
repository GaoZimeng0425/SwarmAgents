import { useMemo } from 'react'
import { type AgentWireEvent, isAgentWireEvent } from '@swarm/protocol'

import { eventEmitter, useConnection } from '@/stores/connection-store'

/** Subscribes to live wire-v3 events; returns an unsubscribe function. */
export type SessionViewSource = (cb: (e: AgentWireEvent) => void) => () => void

// Adapt the web connection's eventEmitter into a subscribe function that
// yields only wire-v3 AgentWireEvents (entry_appended/agent_start/.../
// permission_request), for folding into a SessionView via applyWireEvent.
// Returns null when not connected.
export function useSessionViewSource(): SessionViewSource | null {
  const { client } = useConnection()
  return useMemo(() => {
    if (!client) return null
    return (cb) =>
      // The connection store's eventEmitter forwards all RPC events as
      // { event, data } envelopes on the '*' channel. Unwrap and filter to
      // agent wire events before forwarding to the subscriber.
      eventEmitter.on('*', (envelope) => {
        const { data } = envelope as { event: string; data: unknown }
        if (isAgentWireEvent(data as { kind: string })) cb(data as AgentWireEvent)
      })
  }, [client])
}
