# Goal-Verified Task Loop — Design Spec

- **Date:** 2026-06-28
- **Status:** Approved (design); pending implementation plan
- **Related:** `CLAUDE.md` §4 (Goal-Driven Execution), memory `project_agent_env_blueprint`

## 1. Problem

A task today runs the pi `Agent` turn loop in `AgentRunner.run()` until the model
self-declares "done", returning `status: 'completed'` plus a free-text `summary`.
Two gaps:

1. **No machine-checkable success criteria.** `Task.goal` is free text; nothing
   states what "done" concretely means.
2. **No verification gate.** Completion is whatever the model asserts — there is no
   independent pass that checks the goal was actually met before the task goes
   terminal, and no loop-back when it wasn't.

This is exactly the loop described in `CLAUDE.md` §4 — "Define success criteria.
Loop until verified." The loop exists; the goal definition and the verify step do not.

## 2. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Scope of the gap | Both: define criteria at entry **and** verify gate at exit — a closed `define → execute → verify → loop-back` loop |
| 2 | Verification method | **Hybrid** — executable checks first (deterministic), LLM judge as fallback for non-checkable criteria |
| 3 | Source of criteria | Execution agent **self-derives** at task start; caller may override |
| 4 | Loop-back on fail | **Bounded retries + reuse existing budget**; on exhaustion mark `failed` with the unmet-criteria gap |
| 5 | Architecture | In-runner three-phase state machine inside `AgentRunner.run()` (not an external orchestrator) |
| 6 | Applies to | Only `executionMode: 'goal'` (autonomous) tasks; `'plan'` mode is unaffected |

## 3. Data Model (`src/shared/types/task.ts`)

Add the following zod schemas and extend `TaskSchema`.

```ts
// A single "done" condition for a task.
//   check present  ⇒ hard, machine-verified
//   check absent   ⇒ soft, LLM-judged
export const ExecutableCheckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    command: z.string(),
    cwd: z.string().optional(),
    expectExitCode: z.number().int().optional(), // default 0
    expectStdout: z.string().optional(),         // substring match when present
  }),
  z.object({
    kind: z.literal('file_exists'),
    path: z.string(),
  }),
])

export const AcceptanceCriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  check: ExecutableCheckSchema.optional(),
})

export const VerificationRoundSchema = z.object({
  round: z.number().int().nonnegative(),
  results: z.array(z.object({
    criterionId: z.string(),
    pass: z.boolean(),
    detail: z.string(),       // exit code / stdout tail / judge rationale
  })),
  verdict: z.enum(['pass', 'fail']),
  gaps: z.array(z.string()),  // unmet items, fed back as the next-round goal
  ts: z.number().int(),
})

// Task additions:
//   acceptanceCriteria — Phase A derives them, or the caller supplies them
//   verifications      — per-round audit trail (UI + logs)
acceptanceCriteria: z.array(AcceptanceCriterionSchema).optional(),
verifications: z.array(VerificationRoundSchema).optional(),
```

Distinct from `plan` (`PlanTodo[]`): plan = the *steps*; criteria = the *done
conditions*. They are complementary.

## 4. Three-Phase Loop in `AgentRunner.run()`

`run()` is restructured from a single turn loop into a three-phase state machine.
It still returns the existing `{ status, summary, messages, used }` contract.

### Phase A — Derive criteria (once)
- If `deps.task.acceptanceCriteria` is already set (caller-supplied), skip.
- Otherwise force one structured tool call `set_acceptance_criteria(criteria[])`
  before normal execution. The agent decomposes the goal into criteria; each
  criterion optionally carries an `ExecutableCheck`. Persist onto the task.
- Forced **structured tool call** (not free-text parsing) so the output is schema-valid.

### Phase B — Execute
- The existing pi `Agent` turn loop, unchanged, run until the model self-declares done.

### Phase C — Verify gate (new)
1. **Hard checks:** run every criterion that has a `check`, in-process and
   deterministically (a dedicated runner that reuses the command-execution
   infra — **not** model-driven). Record exit code / stdout.
2. **Soft judge:** for criteria without a `check`, plus an overall-goal judgment,
   make one **independent LLM verifier** call. Fresh context fed only
   `{ goal, criteria, summary, key artifacts / transcript tail }` so it is not
   biased by the executor's self-narrative. Returns structured
   `{ pass, perCriterion: {id, pass, detail}[], gaps[] }`.
3. **Merge verdict** into a `VerificationRound`, append to `task.verifications`:
   - All pass → `status: 'completed'`.
   - Any fail **and** `round < maxVerifyRounds` **and** budget remains →
     inject `gaps` as a new goal message into the **same** conversation/agent and
     loop back to Phase B.
   - Any fail **and** (`round == maxVerifyRounds` **or** budget exhausted) →
     `status: 'failed'`, `summary` lists the unmet criteria.

## 5. Verifier Components

- **Hard-check runner:** small in-process module. `command` checks compare exit
  code (default 0) and optional stdout substring; `file_exists` checks the path.
  Deterministic, no model cost. Errors during a check are logged at `error` and
  counted as a failed criterion (not a crash).
- **LLM judge:** a short structured agent call. v1 **reuses the task's own
  provider**; a hook is left to swap in a dedicated verifier `ModelRole` once the
  model-role wiring lands (see memory `project_model_role_fallback`).

## 6. Criteria Source / Override

- Add optional `acceptanceCriteria` to `TaskOptions` (composer can supply) and to
  `spawnChild(...)` (parent agent can supply for a child).
- Default path: the agent self-derives in Phase A.

## 7. Bounds & Budget

- `maxVerifyRounds`: default **3**. Configurable in `BudgetConfig`, overridable
  per task.
- Loop-back reuses the existing `ResourceBudget`; the verifier's tokens count
  against `used`. Budget exhausted mid-loop ⇒ stop and mark `failed`.

## 8. Logging (`CLAUDE.md` §5)

One child logger per the runner module (existing). Required lines:

- `info`: criteria derived (count); each verify round start (`round`); verdict
  (`pass`/`fail` + gap count); final outcome with `durationMs`.
- `warn`: verify failed → looping back; budget hit; empty-criteria fallback.
- `error`: hard-check execution threw; judge call failed.

Emit task events for these so the UI can render the criteria checklist and each
round's verdict.

## 9. UI (v1, minimal)

Render acceptance criteria as a `PlanTodo`-style checklist bar, plus a per-round
verdict marker. May ship as a follow-up increment; does not block the core loop.

## 10. Out of Scope

- A standalone verifier `ModelRole` / dedicated verifier provider (hook only).
- Applying verification to `'plan'` mode, cron jobs, or actor message handling.
- Rich UI beyond the checklist + verdict marker.

## 11. Affected Files (anchors)

- `src/shared/types/task.ts` — new schemas + `Task` fields + `TaskOptions` field.
- `src/service/session/agent-runner.ts` — three-phase `run()`, verify gate, loop-back.
- `src/service/session/manager.ts` — `spawnChild` criteria pass-through; wire `maxVerifyRounds`.
- `src/service/conversation/store.ts` — persist `acceptanceCriteria` / `verifications`.
- `src/service/tools/builtins.ts` (or equivalent) — `set_acceptance_criteria` tool.
- New: hard-check runner module + LLM-judge module under `src/service/session/` or `src/service/loop/`.
- `src/shared/types/ui.ts` — task events for criteria + verdicts.
- Renderer: criteria checklist / verdict rendering (follow-up increment).

## 12. Success Criteria (for the implementation itself)

- A `'goal'` task with a satisfiable command check (e.g. `npm test` exit 0)
  reaches `completed` only after the check passes; a deliberately failing check
  loops back and, after `maxVerifyRounds`, ends `failed` with the gap in `summary`.
- A non-checkable task (e.g. "summarize X") completes via the LLM judge path.
- Caller-supplied `acceptanceCriteria` skips Phase A.
- Budget exhaustion mid-loop ends the task `failed`, not hung.
- Reading only `swarm-dev.log`, one can tell criteria were derived, each verify
  round's verdict, and the final outcome.
