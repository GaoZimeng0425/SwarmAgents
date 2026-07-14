# Runner / Task Decoupling — Phase 1 Design

- **Date:** 2026-07-02
- **Status:** Design (pending review)
- **Branch:** `worktree-runner-task-decouple`
- **Scope:** `apps/desktop/src/service/session/agent-runner.ts` + call sites in `manager.ts` + runner tests

## 1. Background

SwarmAgents is being refactored so that **conversation messages and tasks are
separate concerns** (a user message is a first-class message, not a task's
`goal`), and the **`AgentRunner` is a pure agent-execution engine** that does
not depend on the `Task` domain concept. `Task` becomes data that an agent
authors via tools (`create_task`), not a struct the runner is built around.

The redesign is decomposed into four phases. This spec covers **Phase 1 only**:
decouple the runner from `Task`, **behavior-preserving**. No UI change, no
session-model change, no agent-driven verify yet (those land in phases 2–4).

**Why phase 1 first:** every later phase runs an agent through the runner. A
clean, task-agnostic engine is the foundation; doing it first as a pure
refactor (locked by the existing test suite) minimizes risk.

## 2. Goal

Remove `task: Task` from `AgentRunnerDeps`. Replace every field the runner
currently reads off `task` with an explicit parameter. All agent runs behave
identically before and after.

## 3. Non-goals

- Do **not** change the execute→verify→rework loop logic. System-driven verify
  stays in phase 1, just re-plumbed to read from params. Agent-driven verify is
  phase 3.
- Do **not** change the session model, conversation storage, or rendering.
- Do **not** migrate existing sessions.
- Do **not** rename the `taskId` field on the **emitted event wire format**
  (UI grouping depends on it). Only the runner's *input parameter* is renamed.

## 4. New `AgentRunnerDeps`

`task: Task` is removed. Fields the runner read off `task` become explicit:

| Was (`deps.task.*`) | Now (top-level dep) | Notes |
|---|---|---|
| `task.id` | `correlationId: string` | Opaque tag used for emit + `spawnChild` parent + sub-run ids. Runner does NOT interpret it. Callers pass `task.id` (phase-2 CEO turn passes a session-conversation key). |
| `task.cwd` | `cwd?: string` | |
| `task.goal` | `goal: string` | Objective text: seeds the first user turn and the verify/criteria prompts. Folds into `initialMessages` in phase 3. |
| `task.executionMode` | `executionMode?: 'goal' \| 'plan'` | Drives the verify gate + system prompt. |
| `task.budget` | `budget: BudgetConfig` | |
| `task.toolAllowlist` | `toolAllowlist?: string[]` | Per-invocation override; normally derived from `agentDefinition.toolScope`. |
| `task.attachments` | `attachments?: Attachment[]` | |
| `task.permissionMode` | `permissionMode?: PermissionMode` | Fallback when `getPermissionMode` is absent (the runner already prefers the live callback). |
| `task.acceptanceCriteria` | `acceptanceCriteria?: AcceptanceCriterion[]` | Consumed by the verify loop. |

All other deps are unchanged: `agentDefinition`, `provider`, `fallbackProviders`,
`sessionId`, `initialMessages`, `emit`, `toolRegistry`, `permissionRegistry`,
`getPermissionMode`, `signal`, `saveSnapshot`, `spawnChild`, `selfAddress`,
`sendMessage`, `findPeers`, `writeAgent`, `writeSkill`, `retry`,
`maxIterationsOverride`, `onAcceptanceCriteria`, `onDelegationPlan`,
`verifyCompletion`, `maxVerifyRounds`.

### Mapping inside the runner

Every `deps.task.X` / `task.X` reference (73 today) is replaced 1:1:

- `deps.task.id` → `deps.correlationId`
- `task.cwd` → `cwd` (param of `buildAgentSession`)
- `task.goal` → `deps.goal`
- `task.executionMode` → `deps.executionMode`
- `task.budget` → `deps.budget`
- `task.toolAllowlist` → `deps.toolAllowlist`
- `task.attachments` → `deps.attachments`
- `task.permissionMode` → `deps.permissionMode`
- `task.acceptanceCriteria` → `deps.acceptanceCriteria`

`buildAgentSession(deps)` and `createAgentRunner(deps).run()` read these off
`deps` (and `cwd` is threaded as a local where the body currently takes `task`).

**Compiler-enforced migration:** because `task` is removed from the deps type,
TypeScript flags every leftover `deps.task.*` reference as an error. This makes
the migration exhaustive and self-checking — no reference can be missed silently.

## 5. Sub-run construction (no more `...deps.task` spread)

Two internal sub-runs currently build a child `Task` by spreading the parent:
`{ ...deps.task, id, goal, ... }`. These become **explicit dep construction**.

### Vision sub-run (`buildAnalyzeImage`, agent-runner.ts:363)

```
// Before
const visionTask: Task = { ...deps.task, id: `${deps.task.id}:vision`,
  goal: prompt, attachments: [...], toolAllowlist: [], executionMode: 'goal' }
createAgentRunner({ task: visionTask, ...vision agentDefinition, provider: vision,
  emit: () => undefined, initialMessages: [], ... })

// After
createAgentRunner({ correlationId: `${deps.correlationId}:vision`, cwd: deps.cwd,
  goal: prompt, attachments: [...], toolAllowlist: [], executionMode: 'goal',
  budget: deps.budget, ...vision agentDefinition, provider: vision,
  emit: () => undefined, initialMessages: [], ... })
```

### Verify sub-run (`defaultVerifyCompletion`, agent-runner.ts:1214)

```
// Before
createAgentRunner({ task: { ...deps.task, id: `${deps.task.id}:verify`,
  goal: buildJudgePrompt(deps.task.goal, soft, sum), acceptanceCriteria: undefined,
  executionMode: 'goal', toolAllowlist: [...] }, ...verify deps, maxVerifyRounds: 0 })

// After
createAgentRunner({ correlationId: `${deps.correlationId}:verify`, cwd: deps.cwd,
  goal: buildJudgePrompt(deps.goal, soft, sum), acceptanceCriteria: undefined,
  executionMode: 'goal', budget: deps.budget, toolAllowlist: [...],
  ...verify deps, maxVerifyRounds: 0 })
```

## 6. Call-site migration (`manager.ts`)

Three sites construct `AgentRunnerDeps` and must map `task.*` → the new params:

1. **Top-level goal run** (manager.ts:~878) — `correlationId: task.id`,
   `cwd: task.cwd`, `goal: task.goal`, `executionMode: task.executionMode`,
   `budget: task.budget`, `toolAllowlist: task.toolAllowlist`,
   `attachments`, `acceptanceCriteria: task.acceptanceCriteria`,
   `permissionMode: task.permissionMode`.
2. **`spawnChild` child run** (manager.ts:~598) — same mapping against the
   child task.
3. **Resident actor deps** (manager.ts:~422) — same mapping. The resident path
   is frozen for *new features*, but this is a signature update only (no new
   actor capability), so it is in scope.

Each call site removes its `task: ...` line and adds the explicit fields above.
The emitted event wire format (`{ taskId, ... }`) is unchanged — at each emit
call site the runner passes `deps.correlationId` as the `taskId` value (a direct
1:1 substitution for the old `task.id`, no wrapper).

## 7. Behavior preservation

`createAgentRunner(deps).run()` still runs execute → verify → rework. The only
change is the source of each value: `deps.task.X` → the new param. Concretely
unchanged:

- The verify gate (`executionMode === 'plan' || maxRounds === 0` → skip).
- `defaultVerifyCompletion` (hard checks + LLM judge, `maxVerifyRounds: 0` to
  avoid recursion).
- Phase A criteria derivation (`acceptanceCriteria` empty → derive then run).
- Budget accounting, fallback chain, permission gating, snapshot persistence.

## 8. Test strategy

- **Update existing runner tests** to the new deps shape:
  `agent-runner.test.ts`, `agent-runner.prompt-error.test.ts`,
  `agent-runner.retry.test.ts`, `agent-runner.fallback.test.ts`,
  `agent-runner.resident.test.ts`. Each currently constructs `task: {...}`;
  replace with the explicit params. The behavior they assert is unchanged, so
  they lock the refactor as pure.
- **Manager test** (`manager.test.ts`) constructs runners indirectly via goal
  submission; verify it still passes (it should — external behavior unchanged).
- **No new behavioral tests required.** The compiler is the exhaustiveness
  guard; the existing suite is the behavior guard.

## 9. Verification

- `npm test` green (full suite — per project convention, run via the Electron
  node runner, not bare `npx vitest`).
- `npm run typecheck` (or the repo's equivalent) clean — confirms no leftover
  `deps.task` reference and that all 5 call sites + 2 sub-runs were updated.
- Manual smoke: submit a goal that triggers a tool call + verify round; confirm
  the transcript, verification, and usage display are identical to pre-refactor.

## 10. Rollback

Phase 1 lands as a single commit on `worktree-runner-task-decouple`, integrated
to `develop` via `git rebase develop` + `git merge --ff-only` (linear history).
If a regression surfaces, revert the single commit — no schema or data changes,
so rollback is clean.

## 11. Phase 1 does NOT do (forward pointers)

- **Phase 2:** session-level conversation carrier; CEO turn runs the runner
  without a persisted task; user message becomes a real event (this is where
  the "first message renders last" bug is fixed structurally).
- **Phase 3:** `create_task` tool; work tasks executed as executor runs;
  **system-driven verify removed**, replaced by agent-driven verify (the
  `goal` param then folds into `initialMessages`).
- **Phase 4:** rendering split — conversation thread + task panel.
