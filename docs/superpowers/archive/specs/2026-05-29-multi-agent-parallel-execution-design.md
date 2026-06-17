# Multi-Agent Parallel Execution Design

**Date:** 2026-05-29  
**Scope:** Single-machine parallel sub-agent execution with runtime-selectable LLM providers  
**Status:** Approved

## Background

The project is an Electron-based agent orchestration framework that supports any LLM provider via custom BaseURL (OpenAI-compatible or Anthropic API style). Users configure providers through the UI; the service layer runs agents and manages sessions.

Currently, the framework has a `spawn_sub_agent` tool that allows a parent agent to delegate sub-tasks, and a `spawnChild` function in the session manager that wires this up. However, three issues prevent multi-agent parallel execution from working correctly:

1. **Child result bug:** `spawnChild` resolves with `{ summary: '', artifacts: [] }` — the child agent's actual output is never passed back to the parent.
2. **Unused concurrency control:** `maxConcurrent` is declared in `SessionManagerConfig` but never enforced, allowing unbounded parallel runners.
3. **No provider selection:** Child agents always use the parent session's provider; there is no way to specify a different provider at spawn time.

Parallelism itself is theoretically sound — Node.js async I/O naturally overlaps multiple concurrent `runner.run()` calls, and Claude supports parallel tool calls within a single response turn.

## Goals

- Fix child result propagation so the parent agent receives meaningful output
- Allow `spawn_sub_agent` to specify a named provider, enabling each child to use a different LLM (e.g., a cheaper model for research sub-tasks)
- Enforce `maxConcurrent` to prevent unbounded API concurrency
- Require no new tools — rely on Claude's native parallel tool calling for fan-out

## Non-Goals

- Distributed multi-machine execution
- Explicit `spawn_parallel_agents` fan-out tool (deferred; LLM-driven parallel calls are sufficient)
- Enforcing `budget.wallMs` timeout on runners (independent future task)
- UI changes beyond exposing provider keys for reference

## Architecture

```
Parent AgentRunner
  └── spawn_sub_agent(goal, providerKey?)   [tool call]
        │
        ▼
  SessionManager.spawnChild(sessionId, parentTaskId, goal, suggestedTools?, providerKey?)
        │
        ├── lookup: cfg.getProvider(providerKey) ?? session.provider
        │
        ├── acquire slot (semaphore, maxConcurrent)
        │
        └── createAgentRunner({ provider: resolvedProvider, ... })
                └── runner.run() → { status, summary }   [fixed return type]
                      │
                      └── release slot
```

Multiple parallel `spawn_sub_agent` tool calls from the parent LLM execute concurrently because each `execute()` call returns an independent Promise, and Node.js runs them concurrently on the event loop.

## Changes

### 1. Fix `AgentRunner.run()` return type  
**File:** `src/service/agent-runner.ts`

Change the return type from `Promise<'completed' | 'failed'>` to `Promise<{ status: 'completed' | 'failed'; summary: string }>`.

Inside `run()`, after `agent.prompt()` resolves, return `{ status: 'completed', summary: translator.getFinalSummary() }`. On error paths, return `{ status: 'failed', summary: '' }`.

Update `AgentRunner` type alias accordingly.

### 2. Fix `spawnChild` result propagation  
**File:** `src/service/session-manager.ts`

Change `spawnChild` to await the runner result and use the actual summary:

```typescript
void runner.run().then(({ summary }) => {
  resolve({ childTaskId, result: { summary, artifacts: [] } })
})
```

Also update `submitGoal`'s `runner.run().then(...)` to destructure `{ status }` from the new return shape.

### 3. Add `getProvider` to `SessionManagerConfig`  
**File:** `src/service/session-manager.ts`

```typescript
type SessionManagerConfig = {
  store: ConversationStore
  broadcaster: SseBroadcaster
  maxConcurrent: number
  getProvider(key: string): ProviderInjection | undefined
}
```

This function is supplied by the caller (main process), which has access to the provider store. Unknown keys log a warning and fall back to the session provider — no thrown errors.

### 4. Add `providerKey` to `spawnChild`  
**File:** `src/service/session-manager.ts`

```typescript
const spawnChild = async (
  sessionId: string,
  parentTaskId: string,
  newGoal: string,
  suggestedTools?: string[],
  providerKey?: string,
): Promise<{ childTaskId: string; result: TaskResult }> => {
  const session = sessions.get(sessionId)!
  const provider = (providerKey && cfg.getProvider(providerKey)) ?? session.provider
  if (providerKey && !cfg.getProvider(providerKey)) {
    log.warn({ msg: 'providerKey not found, falling back to session provider', providerKey })
  }
  // ... rest of spawnChild using resolved `provider`
}
```

### 5. Add `providerKey` to `spawn_sub_agent` tool  
**File:** `src/service/agent-runner.ts`

```typescript
const SpawnParams = Type.Object({
  goal: Type.String({ description: 'The goal for the sub-agent to accomplish.' }),
  suggestedTools: Type.Optional(
    Type.Array(Type.String(), { description: 'Tool scopes to make available.' })
  ),
  providerKey: Type.Optional(
    Type.String({ description: 'Key of a configured provider to use for this sub-agent. Defaults to current session provider.' })
  ),
})
```

The `execute` function passes `p.providerKey` through to `spawnChild`.

The `spawnChild` type in `AgentRunnerDeps` is updated to match:

```typescript
spawnChild(
  parentTaskId: string,
  newGoal: string,
  suggestedTools?: string[],
  providerKey?: string,
): Promise<{ childTaskId: string; result: TaskResult }>
```

### 6. Implement `maxConcurrent` semaphore  
**File:** `src/service/session-manager.ts`

Add at the top of `createSessionManager`:

```typescript
let activeRunners = 0
const waitQueue: Array<() => void> = []

async function acquireSlot(): Promise<void> {
  if (activeRunners < cfg.maxConcurrent) { activeRunners++; return }
  await new Promise<void>(resolve => waitQueue.push(resolve))
  activeRunners++
}

function releaseSlot(): void {
  activeRunners--
  waitQueue.shift()?.()
}
```

Both `spawnChild` and `submitGoal` call `await acquireSlot()` before creating a runner, and `releaseSlot()` in a `finally` block after `runner.run()` settles.

Default `maxConcurrent` is `4` (caller sets this when constructing the session manager).

## Error Handling

| Scenario | Behavior |
|---|---|
| `providerKey` not found | Warn + fallback to session provider |
| Child task fails | `runner.run()` returns `{ status: 'failed', summary: '' }`; `spawnChild` resolves (not rejects) so the parent agent can decide how to proceed |
| Semaphore queue grows unbounded | Acceptable for single-machine use; add queue cap in a future iteration if needed |

## Testing

- **Unit:** `session-manager` tests — add a case where `runner.run()` returns a non-empty summary and assert it propagates through `spawnChild`
- **Unit:** `session-manager` tests — add a case for `providerKey` lookup (found, not found / fallback)
- **Unit:** `session-manager` tests — verify `maxConcurrent` blocks the 5th concurrent call until one releases
- **Integration:** `agent-runner` tests — verify the new return shape `{ status, summary }` on both success and error paths

## Open Questions

None — all design decisions are resolved above.
