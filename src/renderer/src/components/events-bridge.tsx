import { useEventsSubscription } from '@/hooks/use-events-subscription'

export function EventsBridge(): null {
  useEventsSubscription()
  return null
}
