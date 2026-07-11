// Re-export from @swarm/shared so all three apps (desktop, mobile, extension)
// share a single event-reduction implementation.
export { applyEvent, type MessageRecord, type MessageStatus } from '@swarm/shared'
