
# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 0. Language

**Reply in Chinese. Japanese is forbidden.** All conversational responses and explanations
default to Chinese. Never use Japanese under any circumstances.

**Code comments and commit messages must always be in English.** No exceptions — this applies
to every comment written in source files and every Git commit message, regardless of the
conversation language.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Log Every Business Path

**Every business implementation gets logs, so failures are locatable from the log file alone.**

This project uses structured logging via `pino` (`src/shared/logger.ts`). Logs tee to
`userData/swarm-dev.log` (`SWARM_LOG_FILE`). When you add or change business logic, the
log file — not a debugger — must be enough to answer "what happened and where did it fail."

Setup per module:
- `const log = createLogger({ process }).child({ component: '<module>' })` — one child per module.
- Derive per-request/task children for correlation: `const taskLog = log.child({ taskId })`.

What to log (the required paths):
- **Entry points** of a business action at `info` — request dispatched, task started, tool invoked — with the IDs needed to correlate (`sessionId`, `taskId`, `method`).
- **Outcomes** at `info` — completion with `durationMs`; include the key result shape, not full payloads.
- **Every `catch`** at `error` — never swallow. Log `{ msg, err: err instanceof Error ? err.message : String(err), ...context }` before rethrowing/returning. A silent `catch` is a bug.
- **Branch surprises** at `warn` — fallbacks, empty results, budget/limit hits, "not found" recoveries.
- **Verbose detail** at `debug` — payload-level tracing kept out of `info`.

Rules:
- Structured first arg: `log.info({ msg: 'task started', sessionId })`, not string interpolation.
- Never log secrets — rely on the logger's `redact` config; don't dump raw provider/api objects.
- Match existing call sites (`agent-runner.ts`, `swarm-ipc.ts`) for shape and level.
- Don't over-log hot loops at `info` — use `debug` for per-iteration noise.

The test: pick any business path you touched; reading only the log lines, you can tell it ran, with what inputs, and exactly where it broke.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
