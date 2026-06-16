// Renderer-facing view of a persisted memory entry. Mirrors the MemoryEntry
// shape the service's MemoryStore holds, but lives in shared/types so both the
// IPC layers and the renderer can agree on the contract without importing the
// service's internal store type.
export type MemoryView = {
  id: string
  namespace: string
  key: string
  content: string
  category: string
  timestamp: number
}
