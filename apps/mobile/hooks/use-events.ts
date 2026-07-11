import { useEffect, useRef, useState } from 'react'

import { type EventHandler, eventEmitter } from '@/stores/connection-store'

export type ReceivedEvent = { event: string; data: unknown; ts: number }

// Subscribe to RPC events broadcast by the connection store. Pass a filter
// predicate to narrow which events are captured (e.g. only `message.*` events
// for a specific session). Returns the events received since mount, newest
// last; the array is replaced on each emit so React sees a new reference.
//
// Subscriptions use the wildcard handler (`'*'`) which delivers an
// `{ event, data }` envelope (see `eventEmitter.emit`).
export function useEvents(filter?: (event: string) => boolean): ReceivedEvent[] {
  const [events, setEvents] = useState<ReceivedEvent[]>([])
  // Keep the latest filter in a ref so the effect can subscribe once without
  // re-running (and re-attaching) every time a new inline predicate is passed.
  const filterRef = useRef(filter)
  filterRef.current = filter

  useEffect(() => {
    const handler: EventHandler = (data) => {
      const envelope = data as { event: string; data: unknown }
      const eventName = envelope.event
      const eventData = envelope.data
      if (filterRef.current && !filterRef.current(eventName)) return
      setEvents((prev) => {
        const next = [...prev, { event: eventName, data: eventData, ts: Date.now() }]
        // Cap the buffer to the last 100 events so it can't grow unboundedly
        // over a long-lived connection.
        return next.length > 100 ? next.slice(-100) : next
      })
    }

    return eventEmitter.on('*', handler)
  }, [])

  return events
}
