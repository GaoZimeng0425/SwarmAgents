// @swarm/shared — platform-neutral pure logic. No Node/electron deps.
// React hooks require react + @tanstack/react-query as peer deps.

export * from './agents/default-prompt'
export * from './agents/delegation'
export * from './agents/model-override'
export * from './agents/org-tree'
export * from './constants/agents'
export * from './constants/models'
// Named (not `export *`) re-export: packages/shared/src/messages/task-segments.ts
// (deleted in Task 9) also exports `Segment`/`buildSegments`; an explicit
// re-export here resolves the star-export ambiguity in favor of the
// entry-based version without touching the legacy module.
export { buildSegments, type Segment } from './entries/segments'
export * from './entries/session-view'
export * from './hooks'
export * from './messages'
export * from './system-session'
export * from './tokens'
