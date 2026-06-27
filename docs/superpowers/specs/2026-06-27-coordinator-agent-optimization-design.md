# Coordinator agent optimization — borrowing harness orchestrator craft

**Date:** 2026-06-27
**Status:** Approved (brainstorm)
**Author:** SwarmAgents

## Problem

Our builtin coordinating agents (the CEO and the nine team heads in
`src/shared/constants/agents.ts`) carry a workflow ("discover teammates →
delegate → summarize") but lack the *orchestrator craft* the external
[harness](https://github.com/revfactory/harness) plugin encodes in its
orchestrator template and agent-design references. Specifically they are
missing:

1. **Error handling when a delegatee fails or returns nothing.** Every head and
   the CEO assume delegation succeeds. There is no retry, no "proceed with the
   gap noted," no escalation when a critical/majority part fails. harness treats
   this as a required section ("don't assume everything succeeds").
2. **Honest partial-result reporting by the coordinator.** ICs are already told
   "do not claim success you did not verify," but the CEO's and heads' final
   summaries have no instruction to state what failed or was skipped. This
   directly violates our own CLAUDE.md §4 (goal-driven) and §5 (honest logging).
3. **Conflict reconciliation (CEO).** For multi-team goals the CEO has no rule
   for contradictory deliverables; harness's rule is "keep both, note the source,
   never silently drop."
4. **Ambiguity handling (CEO).** The CEO delegates a possibly under-specified
   goal without stating the assumptions it is delegating under.

## Goal

Add harness's coordinator craft — error handling, honest partial reporting, and
(for the CEO) conflict reconciliation and ambiguity handling — to the CEO and all
nine team heads, expressed in SwarmAgents' own primitives (`find_agents`,
`send_and_wait`), via a single shared prompt fragment plus a CEO-specific
addendum.

## Non-goals (YAGNI)

- **No `_workspace/` artifact-archive convention** (harness Phase 1/5) — heads
  already pass artifact *locations* via `send_and_wait`; a parallel swarm
  workspace is heavier than the value here.
- **No `model: "opus"` mandate** — we have a ModelRole abstraction.
- **No TeamCreate/SendMessage translation** — we use `find_agents` /
  `send_and_wait`; only the *intent* of harness's protocol is borrowed.
- **No changes to IC prompts** (engineer, reviewer, analysts, etc.) — they
  already carry honest-reporting instructions and do not delegate.
- **No changes to the training team's authoring flow or the default agent.**

## Design

### Shared fragment: `COORDINATION_PROTOCOL`

A single exported-internal string constant in `src/shared/constants/agents.ts`,
appended to the `systemPrompt` of the CEO and every agent with
`teamRole: 'head'`. Worded generically so it reads correctly for both the
CEO→head layer and the head→IC layer:

```
Coordination protocol (applies whenever you delegate):
- If a delegatee fails or returns nothing, retry once. If it still fails, proceed
  without that piece and record the gap explicitly in your final report.
- If a critical part — or the majority of delegatees — fails, stop and report that
  you could not meet the goal, with what is missing and why.
- When results conflict, keep both and note their source; never silently drop one.
- Your final summary must honestly state what succeeded, what failed, and what was
  skipped. Never claim a deliverable you did not actually receive.
```

### CEO-specific addendum: `CEO_COORDINATION_ADDENDUM`

Appended to the CEO's prompt only, after the shared fragment:

```
- The goal may be under-specified. Do not stall: state the assumptions you are
  delegating under in your message to each head, so their work is anchored.
- For goals spanning multiple teams, integrate the heads' deliverables into one
  coherent result — reconcile overlaps and contradictions explicitly rather than
  concatenating.
```

### Composition

Rather than editing each of the ten prompt string constants by hand (which would
duplicate the protocol ten times and drift), compose at definition time. The
cleanest seam: when building `defaultAgents`, append the protocol to the
`systemPrompt` of the CEO and each head. Concretely — keep each role's base
prompt constant as-is, and apply the fragment where the `AgentDefinition`
objects are constructed, so the single source of truth lives in the two new
constants.

The exact mechanism (a small helper that appends the fragment, applied to the
CEO and to entries where `teamRole === 'head'`) is an implementation detail for
the plan; the requirement is: **the protocol text exists once** and reaches
exactly the CEO + the nine heads, and the CEO additionally gets the addendum.

## Testing

In `src/shared/constants/agents.test.ts`:

- Assert the CEO's `systemPrompt` contains a sentinel from the shared fragment
  (e.g. `'retry once'`) AND a sentinel from the CEO addendum (e.g.
  `'assumptions you are delegating under'`).
- Assert **every** agent with `teamRole === 'head'` contains the shared-fragment
  sentinel.
- Assert a non-coordinating IC (e.g. `engineer`) does NOT contain the
  shared-fragment sentinel (guards against over-application).
- Existing roster tests must still pass (only prompt text grows; ids, teams,
  scopes, head-count unchanged).

## Open questions

None. Scope (CEO + all heads), composition (shared fragment, DRY), and the
fragment wording are settled.
