# design-agent-team — builtin skill design

**Date:** 2026-06-27
**Status:** Approved (brainstorm)
**Author:** SwarmAgents

## Problem

The training team (`training-head` + `training-author`, the only agents holding
`write_agent` / `write_skill`) is functionally a runtime "agent + skill factory" —
the same role the external [harness](https://github.com/revfactory/harness) plugin
plays for Claude Code. But our training agents carry only ~10-line system prompts
("decide what agents/skills are needed → call write_agent"). They have the factory
*skeleton* but none of the factory *craft*.

Concretely, the training team has four gaps versus harness's authoring methodology:

1. **No dedup before create** — nothing makes it `find_agents` first, so repeated
   team-building accumulates overlapping agents under different names.
2. **No deliberate architecture choice** — every team defaults to head→IC; the six
   team-architecture patterns are never considered.
3. **No post-create validation** — `training-author` only "reports what it created";
   dead teammate links and mistriggering descriptions ship unnoticed.
4. **No evolution discipline** — re-authoring is fire-and-forget, with no
   read-before-overwrite and no change history.

We already converge with harness on two points (so they are out of scope):
trigger-first `"Use when …"` descriptions (`agents.ts` convention) and skill
progressive disclosure (`use_skill` + name/description catalog).

## Goal

Ship a builtin skill, `design-agent-team`, that distills harness's authoring craft
into **SwarmAgents' own primitives** (`find_agents` / `send_and_wait` / `spawn` /
`write_agent` / `write_skill` / `toolScope`), and point the training team at it.
Target only the four gaps above.

## Non-goals (YAGNI)

- **Behavioral A/B validation** (spawning a throwaway agent to live-test a new
  team) — too costly per-create. Static validation only.
- **`references/` split** — the body stays under ~200 lines, single `SKILL.md`.
- **CLAUDE.md pointer machinery** (harness Phase 5-4) — our teams are discovered
  via `find_agents`, not a per-project CLAUDE.md.
- **`model: "opus"` mandate** (harness Phase 3) — we have a ModelRole abstraction;
  model choice stays per-agent.
- **Generating Claude-Code-format agent files** — harness emits `.claude/agents/*.md`
  for the Claude Code runtime; our agents are `AgentDefinition` records under
  `~/.swarm-agents/agents`. This skill teaches the *method*, not a file translator.

## Delivery

- New builtin skill `design-agent-team` added to `builtinSkills()` in
  `src/service/skills/builtins.ts`, alongside `swarmagent-operations`. Always
  available, versioned in code, not user-deletable.
- Trigger-first `description` so the training agents auto-load it via `use_skill`.
- One pointer line added to each of `TRAINING_HEAD_SYSTEM_PROMPT` and
  `TRAINING_AUTHOR_SYSTEM_PROMPT` in `src/shared/constants/agents.ts`:
  *"Before designing / authoring, `use_skill('design-agent-team')` and follow it."*

## Skill body structure (single `SKILL.md`, ~150–200 lines)

1. **When to use + role split.** Head designs the team and the specs; author
   materializes them with `write_agent` / `write_skill`. ("who does it" =
   agents, "how it is built" = this skill.)

2. **Step 1 — Dedup before create.** Always `find_agents` first (by
   `team` / `role` / `capability` / `query`). Classify any overlap: reuse the
   existing agent / extend its description / genuinely new. Never create a
   near-duplicate under a new name.

3. **Step 2 — Pick a team architecture pattern.** The six harness patterns,
   compressed to a table and mapped to our primitives:

   | Pattern | SwarmAgents shape |
   |---|---|
   | Pipeline | sequential `send_and_wait` chain |
   | Fan-out/Fan-in | parallel `spawn`, head integrates |
   | Expert Pool | head selects an IC by `capability` via `find_agents` |
   | Producer-Reviewer | IC produces, reviewer reviews, head loops (= dev team) |
   | Supervisor | head holds state, dynamically delegates |
   | Hierarchical Delegation | head → sub-head → IC (= CEO → heads → ICs) |

   Plus the agent-split criteria (specialty / parallelism / context / reuse) for
   deciding where one agent ends and the next begins.

4. **Step 3 — Authoring conventions.** Trigger-first `"Use when …"` description;
   head MUST set `teamRole: 'head'`; ICs get `role` + `capabilities` for
   discovery; **`toolScope` by least privilege** (`authoring` is privileged — grant
   it only to training-type agents); the head's `systemPrompt` MUST discover
   teammates with `find_agents` at runtime (never hardcode instance names) and
   state its workflow plus a bounded fix/review loop (≤10 rounds).

5. **Step 4 — Static dry-run validation.** After writing, with NO agent spawning:
   - (a) `find_agents` confirms the head and every IC are discoverable with the
     correct `team` / `role` / `teamRole` tags.
   - (b) **Dead-link check:** every teammate `role` referenced in a head's
     `systemPrompt` resolves via `find_agents`.
   - (c) **Trigger self-check:** write 3 should-trigger and 2 near-miss phrasings;
     confirm the description matches the formers and not the latters.
   - (d) If `write_agent` / `write_skill` returned an error, report it verbatim
     and fix — never claim a success that was rejected.

6. **Step 5 — Evolution.** Re-authoring is an overwrite: read the existing
   definition first, preserve what works, change only what the feedback targets.
   Append a one-line entry to `~/.swarm-agents/agents/CHANGELOG.md`
   (`date — what changed — why`) so the company's agent roster has a traceable
   history and regressions are visible.

## Testing

The skill is instructional (no runtime code logic), so verification is:

- **`src/service/skills/builtins.test.ts`** — assert `design-agent-team` is present
  in `builtinSkills()`, passes `SkillSchema` (valid name/description length and
  shape), and its body contains the section anchors (the five Step headings).
- **`src/shared/constants/agents.test.ts`** (and `agents.company.test.ts` if it
  asserts the training prompts) — assert both training system prompts reference
  `design-agent-team`.

## Open questions

None. Changelog mechanism resolved to option A (file at
`~/.swarm-agents/agents/CHANGELOG.md`).
