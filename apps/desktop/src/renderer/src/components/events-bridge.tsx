import { useEventsSubscription } from '@/hooks/use-events-subscription'

export function EventsBridge({ isQuickPanel = false }: { isQuickPanel?: boolean }): null {
  useEventsSubscription({ isQuickPanel })
  return null
}
