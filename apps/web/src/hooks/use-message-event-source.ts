import { useMemo } from 'react'
import type { UIEvent } from '@swarm/protocol'
import type { MessageEventSource } from '@swarm/shared'

import { eventEmitter, useConnection } from '@/stores/connection-store'

// Adapt the web connection (ServiceClient + the connection store's eventEmitter)
// into the MessageEventSource interface expected by @swarm/shared's useMessages /
// useMessageEventSubscription. Returns null when not connected.
export function useMessageEventSource(): MessageEventSource | null {
  const { client } = useConnection()
  return useMemo(() => {
    if (!client) return null
    return {
      getMessageEvents: (sessionId) => client.getMessageEvents(sessionId),
      subscribeEvents: (cb) => {
        // The connection store's eventEmitter forwards all RPC events as
        // { event, data } envelopes on the '*' channel. Unwrap and forward the
        // data payload to the subscriber.
        return eventEmitter.on('*', (envelope) => {
          const { data } = envelope as { event: string; data: unknown }
          cb(data as UIEvent)
        })
      },
    }
  }, [client])
}
