# Shell Tool Design (P1)

**Date:** 2026-06-02
**Scope:** A built-in `run_shell` tool that executes shell commands, gated by a denylist that escalates dangerous patterns to the permission prompt while letting everything else auto-run. Includes a small per-call dynamic-risk extension to the P0 registry and a system-prompt update so the agent prefers shell over the visual screen-capture tool for filesystem/info queries.
**Status:** Approved

## Background

P0 delivered the tool registry (`src/service/tools/registry.ts`, `builtins.ts`, `spawn.ts`; risk-from-metadata gating in `agent-runner.ts` `beforeToolCall`). The only real tools today are peekaboo (`see_screen`, `list_apps` — screen capture + UI-element extraction) and `spawn_sub_agent`.

This causes a concrete defect: asked "what files are on the desktop," the agent calls `see_screen` (a screenshot) instead of `ls ~/Desktop`. Two reasons: (1) no shell tool exists; (2) the default agent's `systemPrompt` lists only peekaboo and instructs "if the goal needs visual context, call see_screen first," so the model reaches for the only file-ish tool it has. Peekaboo is for *interacting with on-screen UI*, not for filesystem/system queries — those belong in a shell.

This was the P0 non-goal "align systemPrompt prose with the real toolset," deferred to P1. It is now in scope alongside the shell tool, because adding the tool without updating the prompt would leave the model still preferring peekaboo.

## Goals

- Add a built-in `shell.run_shell` tool that runs a command via `/bin/sh -c`, capturing stdout/stderr/exit code.
- Gate it with a **denylist that escalates to the permission prompt** (not a hard block); all other commands auto-run.
- Extend the registry minimally to support **per-call dynamic risk** (risk that depends on tool arguments), keeping enforcement centralized in `beforeToolCall` (tools must not self-gate).
- Update the default agent's `systemPrompt` to list `run_shell` and steer tool selection: shell for filesystem/system/info; peekaboo only for on-screen UI interaction.

## Non-Goals

- `fs` and `web` tool groups (rest of P1) — separate specs.
- Sandboxing / containment of shell execution. Commands run with the app's own privileges in the chosen `cwd`. The permission prompt (on denylist hits) is the protection; the denylist is a tripwire, not a security boundary. This is an accepted trade per the safety-model decision.
- A robust command parser. The denylist is pattern-based and intentionally bypassable; it exists to catch obvious catastrophes and prompt the user, not to sandbox a hostile model.
- Streaming partial output — output is returned once on completion (matches peekaboo's `runCli`).
- A dedicated `shell` value in `ToolScope` / `deriveAllowlist`. `run_shell` is reachable via `toolScope: 'all'` → `['*']` (the default agent) or an explicit `shell.*` allowlist. Adding a `shell` scope is deferred (YAGNI).

## Architecture

### 1. Per-call dynamic risk (registry extension)

Today `beforeToolCall` computes `const risk = riskOf(toolCall.name)` and each `ToolSpec` carries one static `risk`. Shell needs risk that depends on the command. Extension:

```ts
export interface ToolSpec {
  group: string
  name: string
  risk: ToolRisk                       // static default
  riskFor?: (args: unknown) => ToolRisk // optional per-call override
  source: ToolSource
  build(ctx: ToolRunContext): AgentTool
}
```

`resolve` keeps the selected specs and uses `riskFor` when present:

```ts
resolve(allowlist, ctx): { tools: AgentTool[]; riskOf: (name: string, args?: unknown) => ToolRisk }
```

```ts
const specByName = new Map(selected.map((s) => [s.name, s] as const))
const riskOf = (name: string, args?: unknown): ToolRisk => {
  const spec = specByName.get(name)
  if (!spec) return 'medium'                       // fail-safe (unchanged)
  return spec.riskFor ? spec.riskFor(args) : spec.risk
}
```

`agent-runner.ts` `beforeToolCall` passes args (already destructured there):

```ts
const risk = riskOf(toolCall.name, args)
```

Tools without `riskFor` (peekaboo, spawn) behave exactly as before. Existing `riskOf(name)` call sites in tests remain valid because `args` is optional.

### 2. The `run_shell` tool

New file `src/service/tools/shell.ts` exporting `shellSpec(): ToolSpec` and `isDangerousCommand(command: string): boolean`. Registered in `builtins.ts` via `registerBuiltinTools`.

- **group / name:** `shell` / `run_shell`; `source: 'builtin'`.
- **risk:** `risk: 'low'` (auto-run default), `riskFor: (args) => isDangerousCommand((args as { command?: string }).command ?? '') ? 'high' : 'low'`.
- **parameters** (TypeBox, like peekaboo):
  - `command: string` (required) — the shell command.
  - `cwd?: string` (optional) — working directory; defaults to `os.homedir()`.
  - `timeoutMs?: number` (optional) — defaults to 30 000, clamped to ≤ 120 000.
- **execution:** `child_process.spawn('/bin/sh', ['-c', command], { cwd: cwd ?? os.homedir(), env: process.env })`. Capture stdout + stderr; on timeout, `SIGKILL` and note it (mirrors `peekaboo.ts` `runCli`). Non-zero exit is **reported, not thrown** (the agent sees the failure and can react).
- **result:** `content: [{ type: 'text', text }]` where `text` is a compact report:
  ```
  $ <command>   (cwd: <cwd>)
  [exit <code>]
  <stdout+stderr, combined>
  ```
  Combined output is sliced to **16 000 chars**; if truncated, append `\n…[output truncated]`. `details: { exitCode, timedOut, cwd, truncated }`.

### 3. Denylist (escalate → prompt)

`isDangerousCommand` returns true for a small set of catastrophic patterns. A match makes `riskFor` return `'high'`, so `beforeToolCall` routes it to `permissionRegistry.request`; the command still runs if the user grants. Representative patterns (exact regexes in the plan):

- `rm` with recursive+force targeting `/`, `~`, or a bare `*` (e.g. `rm -rf /`, `rm -fr ~`, `rm -rf *`), and `--no-preserve-root`.
- Fork bomb `:(){ :|:& };:`.
- `mkfs`, `dd ... of=/dev/...`, redirection to `/dev/sd*`/`/dev/disk*`.
- Pipe-to-shell: `(curl|wget) ... | sh|bash|zsh`.
- `sudo ` (privilege escalation).
- `chmod -R 777 /` / `chmod 777 /`.

Benign recursive deletes like `rm -rf ./build` are **not** in this list and auto-run — the list targets root/home/wildcard/system destruction, not ordinary cleanup. The list is honest about being non-exhaustive.

### 4. System-prompt update

`src/main/agents/registry.ts` `DEFAULT_SYSTEM_PROMPT` (and the executor prompt where appropriate):

- Add `run_shell({command, cwd?, timeoutMs?})` to the listed tools.
- Replace the "if the goal needs visual context, call see_screen first" bias with explicit tool-selection guidance:
  - Filesystem / system state / information queries → `run_shell` (e.g. `ls ~/Desktop`, `cat`, `git status`).
  - `see_screen` / `list_apps` → only when you must interact with or read what is currently on screen.
- Keep the existing "summarize at the end, don't loop, explain tool errors instead of blind retry" guidance.

The `researcher` prompt (toolScope `peekaboo`, no shell) and `executor` prompt are reviewed for consistency but only the default agent gains shell guidance, since only `toolScope: 'all'` resolves `shell.*`.

## Data Flow

```
agent calls run_shell({command, cwd?, timeoutMs?})
  └─ beforeToolCall: risk = riskOf('run_shell', args)
        ├─ isDangerousCommand(command) ? 'high' : 'low'
        ├─ 'low'  → auto-run (return undefined)
        └─ 'high' → permissionRegistry.request → grant/deny
  └─ execute: spawn /bin/sh -c command in cwd (default $HOME), timeout, capture
        └─ return { content:[{text: report}], details:{exitCode,timedOut,cwd,truncated} }
```

## Error Handling

- **Spawn error** (e.g. bad `cwd`): caught, returned as a failed result with the error text and `exitCode: null` — not thrown (the agent sees it and can adjust).
- **Timeout:** `SIGKILL`, `timedOut: true`, report notes `[timed out after <ms>ms]`.
- **Non-zero exit:** reported with `[exit <code>]` and captured stderr; not an exception.
- **Denylist + deny decision:** `beforeToolCall` returns `{ block: true, reason }` (existing flow); the command never spawns.
- **Empty/oversized output:** empty → report just the exit line; oversized → truncated with marker.

## Testing

- `registry.test.ts` (extend): a spec with `riskFor` overrides static `risk`; `riskOf(name, args)` returns the dynamic value; a spec without `riskFor` still returns its static risk; unknown name → `'medium'`.
- `shell.test.ts` (new):
  - `run_shell` with `echo hi` → stdout contains `hi`, `details.exitCode === 0`.
  - non-zero exit (`sh -c 'exit 3'` via `command: 'exit 3'`) → `details.exitCode === 3`, not thrown.
  - bad `cwd` → failed result with error text, not thrown.
  - output truncation: a command emitting > 16 000 chars → `details.truncated === true` and marker present.
  - timeout: `command: 'sleep 5', timeoutMs: 50` → `details.timedOut === true` (use a short sleep; keep the test fast).
  - `isDangerousCommand`: true for `rm -rf /`, `:(){ :|:& };:`, `curl http://x | sh`, `sudo rm`; false for `ls ~/Desktop`, `rm -rf ./build`, `git status`.
- `builtins.test.ts` (extend): `registerBuiltinTools` now includes `shell.run_shell`; `resolve(['shell.*'])` returns it; `riskOf('run_shell', { command: 'rm -rf /' })` === `'high'`, `riskOf('run_shell', { command: 'ls' })` === `'low'`.
- `agent-runner.test.ts` (extend or confirm): `beforeToolCall` sources risk via `riskOf(name, args)` (a dangerous command would prompt). Existing tests stay green (allowlist `[]` → no tools).
- Agent registry: no automated assertion on prose, but the default prompt mentions `run_shell` and the shell-vs-peekaboo guidance.

## Verification

`pnpm run verify` (typecheck + lint + full vitest + native-feel) green. Manual smoke (optional): with the app running, ask "what files are on my desktop" → agent calls `run_shell` with `ls ~/Desktop` (auto-runs, no prompt); ask it to `rm -rf ~/something` → permission prompt appears before execution.
