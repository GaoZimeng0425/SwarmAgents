import { useMessageEventSubscription } from '@swarm/shared'

import { useMessageEventSource } from '@/hooks/use-message-event-source'

// Mount once at the app root (inside ConnectionProvider + QueryClientProvider).
// Folds every live RPC event into the global MessageRecord[] TanStack Query
// cache via @swarm/shared's applyEvent, so useMessages() sees updates.
export function EventsBridge(): React.JSX.Element {
  const source = useMessageEventSource()
  useMessageEventSubscription(source)
  return <></>
}
