# Method-Table Single-Sourcing (main↔service RPC)

Date: 2026-07-17
Status: approved design, pre-implementation
Scope leg: main↔service only (renderer→main `SwarmBridge`/preload/`swarm-ipc` is explicitly out of scope; see Non-Goals)

## Problem

The main↔service RPC method table currently exists as four hand-synchronized copies:

1. `packages/protocol/src/types/service-ipc.ts` — `ServiceMethod` / `MainMethod` as **bare string unions** (no args/result types).
2. `packages/protocol/src/service-client.ts` — `ServiceClient` type + ~50 hand-written wrappers, each `peer.call('<method>', [args])`.
3. `apps/desktop/src/service/ipc/dispatcher.ts` — a switch over `ServiceMethod` whose arms cast `args as [...]`.
4. Main-side `registerHandler(method, fn)` call sites (gmail/calendar/weather/bilibili) — `fn` typed as `(...args: unknown[]) => unknown`.

Failure modes this enables today:

- Adding/renaming a method requires touching 1–3 in lockstep; the compiler does not
  catch a miss (the `as` casts in the dispatcher swallow signature drift silently).
- The WS boundary (`main/host/bridge.ts` forwards external-peer requests into the
  service transport) performs **no runtime validation**: peer-supplied `args` flow
  straight into the dispatcher's type assertions.

## Goals

- One source of truth in `@swarm/protocol` for every RPC method's name, args tuple,
  and result type — for both directions (`ServiceMethod` and `MainMethod`).
- `ServiceClient` and the dispatcher **derived** from that source, so a missing
  entry, a signature mismatch, or a missing validator is a compile error.
- Runtime zod validation of args at the dispatcher entry — one choke point covering
  both callers (main's own IPC and WS-bridged external peers).
- Wire format unchanged: `{ kind: 'request', id, method, args: unknown[] }` exactly
  as today. Extension/RN clients are unaffected.

## Non-Goals

- The renderer→main leg (`SwarmBridge`, preload, `swarm-ipc.ts` handlers) — follow-up.
- WS per-transport method allowlist (audit item ⑦) — separate change.
- Result-value runtime validation — results come from our own service code; types only.
- Runtime validation of `MainMethod` calls — see MainMethod section for why.

## Design

### 1. Signature table — new file `packages/protocol/src/service-methods.ts`

Two parallel artifacts, kept in lockstep by a mapped type:

```ts
export type ServiceMethodSignatures = {
  submitPrompt: { args: [string, string, Attachment[]?, SubmitOptions?]; result: { runId: string } }
  listSessions: { args: []; result: SessionSummary[] }
  // ... all 45 methods
}
export type ServiceMethod = keyof ServiceMethodSignatures

export const serviceMethodArgSchemas: {
  [M in ServiceMethod]: z.ZodType<ServiceMethodSignatures[M]['args']>
} = {
  submitPrompt: z.tuple([z.string(), z.string(), AttachmentsSchema.nullish(), SubmitOptionsSchema.nullish()]),
  listSessions: z.tuple([]),
  // ...
}
```

- **Completeness is compiler-enforced**: the mapped type over `serviceMethodArgSchemas`
  requires an entry per method, and each schema's output type must be assignable to
  the signature's `args` tuple.
- `types/service-ipc.ts` drops its bare unions and re-exports `ServiceMethod` /
  `MainMethod` / `RpcMethod` from the new table file, so all existing imports keep
  working unchanged. `RpcRequest`/`RpcResponse`/`RpcEvent`/`RpcReady` stay where they are.
- Import direction: `service-methods.ts` imports from `types/*`; no `types/*` file
  imports the table (prevents cycles).

**Schema precision is graded** (per-method, all entries present):

- Primitive args (`sessionId: string`, `rangeDays: number`, enums like
  `PermissionDecision`) — trivially precise. This covers the majority of methods.
- Mutating complex objects (`Skill`, `AgentDefinition`, `McpServerConfig[]`,
  `SessionSettings`, `WebSearchInjection`, article/bilibili/trending request objects) —
  real schemas. Reuse existing ones where present (`BudgetConfigSchema`,
  `SessionEntrySchema` precedent).
- Provider-shaped open payloads (`ProviderInjection`, attachment internals) —
  `z.looseObject` with the key fields pinned, rest passed through (mirrors the
  existing `MessagePayload` precedent in `session-entry.ts`).

**Optional-arg rule (correctness-critical)**: every optional trailing arg schema uses
`.nullish()`, never bare `.optional()`. The parentPort leg preserves `undefined`
(structured clone), but the WS leg goes through `JSON.stringify`, which converts
`undefined` array elements to `null`. `.optional()`-only schemas would reject every
legal WS call that omits a trailing arg. Handlers already treat `null`/`undefined`
optionals equivalently.

### 2. `MainMethodSignatures` (same file)

Same shape for the 11 `gmail.*`/`calendar.*`/`weather.*`/`bilibili.*` methods:
signatures only, **no runtime schema table**. Rationale: WS peers cannot reach
MainMethod handlers — the bridge forwards peer messages into the service process
only, and main's peer never sees them (verified against `bridge.ts` routing). The
only caller is our own service code, so compile-time typing is sufficient.

Consumers tightened:

- `ServiceClient.registerHandler` becomes
  `registerHandler<M extends MainMethod>(method: M, fn: (...args: MainMethodSignatures[M]['args']) => R | Promise<R>)`.
- Service-side `callMain` (`rpcPeer.call` wrappers in `service/index.ts`, tool deps)
  typed the same way.

### 3. Generated `ServiceClient` — rewrite `packages/protocol/src/service-client.ts`

- Type: `{ [M in ServiceMethod]: (...args: Sig[M]['args']) => Promise<Sig[M]['result']> }`
  intersected with the hand-written non-RPC members (`connect`, `disconnect`,
  `registerHandler`). Current member names match method names 1:1 (verified), so the
  13 existing caller files compile unchanged.
- Implementation: iterate `Object.keys(serviceMethodArgSchemas)` and generate
  `(...args) => peer.call(method, args)` per method; delete the ~80 lines of
  hand-written wrappers. One documented cast to the mapped type at the end.
- The client does **not** validate args (trusted side; validation lives at the
  dispatcher so it also covers WS peers). No behavior change to
  `connect`/`disconnect`/`onEvent`/`defaultHandler`.

### 4. Dispatcher: switch → handler map — rewrite `apps/desktop/src/service/ipc/dispatcher.ts`

```ts
type ServiceHandlers = {
  [M in ServiceMethod]: (...args: ServiceMethodSignatures[M]['args']) =>
    ServiceMethodSignatures[M]['result'] | Promise<ServiceMethodSignatures[M]['result']>
}

export function createDispatcher(cfg: DispatcherConfig): Dispatcher {
  const handlers: ServiceHandlers = {
    createSession: (provider) => { cfg.registerProvider(provider); return cfg.service.createSession(provider) },
    // ... one entry per method, bodies moved from the switch arms
  }
  return (method, args) => {
    const schema = serviceMethodArgSchemas[method]
    if (!schema) throw new Error(`unknown method: ${String(method)}`)
    const parsed = schema.safeParse(args)
    if (!parsed.success) throw new Error(`invalid args for ${method}: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
    // Correlated-union call: TS cannot prove handlers[method] accepts parsed.data
    // for the same M; this is the single documented cast at the choke point.
    return (handlers[method] as (...a: unknown[]) => unknown)(...parsed.data)
  }
}
```

- All per-arm `args as [...]` assertions disappear; each handler body is
  compile-checked against the table.
- The public `Dispatcher` type and `DispatcherConfig` are unchanged →
  `service/index.ts` wiring is untouched.
- Dispatcher stays transport-free and logger-free (pure, throws). Validation
  failures surface through the existing `defaultHandler` error log in
  `service/index.ts` (`request failed` at error level with method + id), so the
  log file still answers "what failed and why" without new logging code.

### 5. Error handling

Validation failure → dispatcher throws → `rpc-peer` `respond()` catches →
`{ kind: 'response', ok: false, error }` → caller's Promise rejects with
`Error(message)`. Same path as today's business errors; renderer behavior unchanged.
Error message always contains the method name and the first zod issue.

## Testing

- `dispatcher.test.ts` (extend existing): wrong arity rejected; wrong primitive type
  rejected; malformed complex object rejected (e.g. `saveAgent` with a non-object);
  legal calls pass — including trailing `null` for optional args (the WS
  JSON-ification case); unknown method still throws; error messages contain the
  method name.
- Protocol type test (extend `service-ipc.test.ts` assignability style): pin that
  representative schema output tuples are assignable to their signature `args`.
  Full-table completeness needs no test — it is a compile error by construction.
- Regression net: existing full-assembly permission-gate integration test, full
  `npm test` (via Electron node per project convention), `turbo typecheck` (delete
  stale `.tsbuildinfo` first).

## Compatibility & Risks

- **Wire**: unchanged; extension/RN clients unaffected.
- **API**: `ServiceMethod`/`MainMethod`/`RpcMethod` names and the `ServiceClient`
  surface are preserved; only their definitions move.
- **Behavior delta**: calls that previously succeeded with malformed args (silently
  mis-cast) will now be rejected with a typed error. This is the point of the change;
  the dispatcher tests enumerate the legal shapes.
- **zod v4 tuples**: the repo is on zod 4 (`z.looseObject` already in use), which
  supports optional/nullish tuple elements. Verify the inferred tuple type matches
  the signature `args` during implementation. If inference fights back on a
  specific method, the fallback is a fixed-prefix tuple plus a permissive rest
  (`z.tuple([...]).rest(z.unknown())`) for that method only — the signature type
  stays authoritative either way.
- **Import cycles** in protocol: guarded by the one-way rule (table imports types,
  never the reverse).
