# Restructure `src/service` into Feature Slices

**Date:** 2026-06-23
**Scope:** `src/service` only. No behavior change — pure structural move.

## Problem

`src/service` holds the agent-runtime process. Today its 14 core source files (plus
~30 colocated tests) sit flat in the directory root; only `tools/ skills/ agents/ mcp/`
have been pulled into folders. A single subsystem's source, its private dependencies,
and its many tests are all intermixed at the top level, so the boundaries between
subsystems are invisible.

The `src/main` process already demonstrates the target pattern: `budgets/`, `providers/`,
`mcp-servers/`, `web-search/` are each a vertical slice. This spec applies the same
discipline to `src/service`.

## Constraints / Blast Radius

- **Fully contained in `src/service`.** Verified: no file outside `src/service`
  deep-imports a service internal. The `@service` alias points at the directory but
  nothing imports through it; the build entry is only `src/service/index.ts`. All
  inter-file references inside the service are relative paths.
- Therefore the only edits are: (a) `git mv` files, (b) rewrite relative import
  specifiers within `src/service`, (c) delete one dead file.
- **No behavior change.** Success = `npm test` and typecheck pass identically before
  and after.

## Target Structure

Convention (already used by existing `mcp/manager.ts`, `skills/store.ts`,
`tools/registry.ts`): inside a feature folder, drop the redundant prefix — the folder
is the namespace. Tests stay colocated with their source. Use `git mv` to preserve
history across renames.

```
src/service/
  index.ts                     # process entry + dependency wiring (stays at root)

  ipc/                         # process-boundary message plumbing
    dispatcher.ts              # ← dispatcher.ts          (inbound request routing)
    dispatcher.test.ts
    broadcaster.ts             # ← broadcaster.ts         (outbound event broadcast)
    broadcaster.test.ts

  actor/                       # actor-model runtime primitives
    mailbox.ts                 # ← actor-mailbox.ts
    mailbox.test.ts
    state.ts                   # ← actor-state.ts
    state.test.ts

  session/                     # core execution engine
    manager.ts                 # ← session-manager.ts
    manager.test.ts            # ← session-manager.test.ts
    manager.actors.test.ts     # ← session-manager.actors.test.ts
    manager.cross-dormancy.test.ts
    manager.deadlock.test.ts
    manager.messaging.test.ts
    manager.redrain.test.ts
    manager.resident.test.ts
    manager.turnslot.test.ts
    agent-runner.ts            # ← agent-runner.ts
    agent-runner.test.ts
    agent-runner.context.test.ts
    agent-runner.prompt-error.test.ts
    agent-runner.resident.test.ts
    agent-runner.session.test.ts
    permission-registry.ts     # ← permission-registry.ts (used only by session/agent-runner)
    permission-registry.test.ts
    reply-registry.ts          # ← reply-registry.ts      (same)
    reply-registry.test.ts

  conversation/                # session/message persistence + usage aggregation
    store.ts                   # ← conversation-store.ts
    store.test.ts
    store.actor-state.test.ts  # ← conversation-store.actor-state.test.ts
    store.actors.test.ts       # ← conversation-store.actors.test.ts
    usage-stats.ts             # ← usage-stats.ts         (depended on by store)
    usage-stats.test.ts

  memory/
    store.ts                   # ← memory-store.ts
    store.test.ts

  cron/
    scheduler.ts               # ← cron-scheduler.ts
    scheduler.test.ts

  e2e/                         # cross-subsystem integration tests (span session + conversation)
    agent-cluster.e2e.test.ts
    agent-cluster-runloop.e2e.test.ts
    company.e2e.test.ts
    company.startup.test.ts

  agents/  skills/  tools/  mcp/   # unchanged (already feature slices)
```

### Grouping rationale (from measured dependencies)

| Slice | Members | Why |
|---|---|---|
| `session/` | manager, agent-runner, permission-registry, reply-registry | `agent-runner`/`permission-registry`/`reply-registry` are imported only by the session manager (or each other) — one cohesive execution engine. |
| `actor/` | mailbox, state | Shared by `session` and `agent-runner`, and are self-contained primitives. |
| `conversation/` | store, usage-stats | `usage-stats` is imported only by `conversation-store`. |
| `ipc/` | dispatcher, broadcaster | The process boundary: dispatcher = inbound requests, broadcaster = outbound events. |
| `memory/`, `cron/` | store / scheduler | Distinct domains; own folders for consistency with `main/` even though single-file (user-confirmed). |
| `e2e/` | the 4 `*.e2e`/`company.*` tests | They exercise `session-manager` + `conversation-store` together — not unit tests of one slice. |

## Dead Code Removal

`tool-state-manager.ts` (17-line Playwright stub, commit `b774eed` 2026-05-28, zero
references, `throw 'Playwright not yet wired'`) is deleted. It was a forward-looking
per-session browser-context/cookie holder for browser-automation tools that were never
built; the interface will be redesigned against a real Playwright integration if/when
that work happens. History preserves it. (User-confirmed delete.)

## Import Rewrites

After moving, fix only the relative specifiers that actually cross a new folder
boundary. (Same-folder edges — e.g. `session/manager.ts` importing `./agent-runner`,
`./permission-registry`, `./reply-registry`, or `conversation/store.ts` importing
`./usage-stats` — stay as `./` and need no change.)

Real cross-slice edges to update:

- `index.ts`: `./broadcaster`→`./ipc/broadcaster`, `./dispatcher`→`./ipc/dispatcher`,
  `./conversation-store`→`./conversation/store`, `./cron-scheduler`→`./cron/scheduler`,
  `./memory-store`→`./memory/store`, `./session-manager`→`./session/manager`.
- `session/manager.ts`: `./actor-mailbox`→`../actor/mailbox`, `./actor-state`→`../actor/state`,
  `./broadcaster`→`../ipc/broadcaster`, `./conversation-store`→`../conversation/store`,
  plus existing `./agents/* ./skills/* ./tools/*` become `../agents/* ../skills/* ../tools/*`.
- `session/agent-runner.ts`: `./actor-mailbox`→`../actor/mailbox`, `./actor-state`→`../actor/state`,
  `./tools/registry`→`../tools/registry`.
- `ipc/dispatcher.ts`: `./session-manager`→`../session/manager`.
- `cron/scheduler.ts`: `./conversation-store`→`../conversation/store`.
- `tools/*` and `skills/*` that import `../cron-scheduler`→`../cron/scheduler`,
  `../memory-store`→`../memory/store`.
- `e2e/*`: `./session-manager`→`../session/manager`, `./conversation-store`→`../conversation/store`.
- Every moved test updates its own `./<old>` import to the new sibling/parent path.

## Verification

1. `npx tsc -p tsconfig.node.json --noEmit` (or project typecheck) — zero errors.
2. `npm test` — same pass/fail set as the pre-refactor baseline (capture baseline first).
3. `git status` shows only renames (R) + the single deletion + import-line edits — no
   stray content changes.
```
