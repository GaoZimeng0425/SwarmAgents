import type { Skill } from '@swarm/protocol'

/**
 * Skills shipped with the app: always available, versioned in code, and not
 * user-deletable (unlike on-disk skills). Merged into the skill store's list.
 */
export function builtinSkills(opts: { mcpConfigPath: string }): Skill[] {
  return [operationsManual(opts.mcpConfigPath), designAgentTeam()]
}

function operationsManual(mcpConfigPath: string): Skill {
  return {
    name: 'swarmagent-operations',
    description:
      'How to operate SwarmAgents — especially managing MCP servers (add, edit, remove, enable/disable) by ' +
      'editing the config file. Use when the user asks to connect, configure, or remove an MCP server.',
    body: `# SwarmAgent operations

## Managing MCP servers

MCP servers give you extra tools. They are configured in a plaintext JSON file you can read and edit directly with your file tools:

\`${mcpConfigPath}\`

Edits are picked up automatically (within ~1s) and the server reconnects — no restart needed.

### File format

\`\`\`json
{
  "mcpServers": {
    "<name>": {
      "type": "http",                            // "stdio" | "http" | "sse"
      "url": "https://host/mcp",                 // http/sse only
      "headers": { "Authorization": "Bearer <token>" },
      "command": "npx",                          // stdio only
      "args": ["-y", "some-server"],             // stdio only
      "env": { "KEY": "value" },                 // stdio only
      "enabled": true                            // optional, default true
    }
  }
}
\`\`\`

- The map key is the server name and also the tool namespace (lowercase letters, digits, \`-\`, \`_\`). Its tools appear to you as \`<name>__<tool>\`.
- \`type\` may be omitted: a \`command\` implies stdio, a \`url\` implies http.

### Secrets

Put a token inline, OR reference an environment variable with \`\${VAR}\` / \`\${VAR:-default}\` — expanded at connect time so the secret stays out of the file:

\`\`\`json
"headers": { "Authorization": "Bearer \${WORKPANEL_TOKEN}" }
\`\`\`

If you use \`\${VAR}\`, that variable must be set in the app's environment; inline literals always work.

### How to change it

Use your file tools on the path above:
- **Add / edit a server** — read the file, add or modify the entry under \`mcpServers\`, write it back (keep the JSON valid).
- **Remove a server** — delete its entry.
- **Disable without removing** — set \`"enabled": false\`.

After writing, the server connects automatically. If it fails, the connection status reports why (commonly a bad url/command or a missing env var).

### Caution

This file may hold secrets if you inline them. Do not commit it to git or share it; prefer \`\${VAR}\` references when the config might be shared.`,
  }
}

function designAgentTeam(): Skill {
  return {
    name: 'design-agent-team',
    description:
      'How to design, author, validate and evolve agents, skills and whole teams for this company. ' +
      'Use when asked to create a new agent, add a team, author or improve a skill, or grow the ' +
      "company's capabilities — i.e. before calling write_agent or write_skill.",
    body: `# Designing agents, skills and teams

You are building the company's own workforce. An **agent** is *who* does the work
(a role with a system prompt and a tool scope); a **skill** is *how* a procedure
is done (reusable instructions any agent can load). The training head designs the
team and writes the specs; the author materializes them with \`write_agent\` /
\`write_skill\`. Follow the steps below in order.

## Step 1 — Dedup before you create

Repeatedly building teams accumulates near-duplicate agents under different names.
Before authoring anything, discover what already exists:

- \`find_agents({ team })\`, \`find_agents({ role })\`, \`find_agents({ capability })\`,
  or \`find_agents({ query })\` to search the live roster.

Classify any overlap and act accordingly:

- **Reuse** — an existing agent already covers the need → delegate to it, author nothing.
- **Extend** — close but its description misses the new trigger → rewrite the
  description (overwrite via \`write_agent\`), don't fork a twin.
- **New** — genuinely uncovered → proceed to Step 2.

Never create a second agent that does what an existing one already does.

## Step 2 — Pick a team architecture pattern

Choose the coordination shape deliberately instead of defaulting to head→IC. Map
each pattern to our primitives (\`create_task\`, \`find_agents\`):

| Pattern | When | SwarmAgents shape |
|---|---|---|
| Pipeline | sequential, each step depends on the last | head chains \`create_task\` IC→IC, one after another (each call returns when the child finishes — that IS the handoff) |
| Fan-out / Fan-in | independent parallel sub-tasks | head \`create_task\`s in parallel (default spawn path), then integrates |
| Expert Pool | one of several specialists fits per request | head selects an IC by \`capability\` via \`find_agents\` |
| Producer-Reviewer | output needs a quality gate | IC produces, reviewer reviews, head loops (= the dev team) |
| Supervisor | dynamic, stateful task distribution | head holds state and dispatches as work emerges |
| Hierarchical Delegation | large scope, recursive breakdown | head → sub-head → IC (= CEO → heads → ICs) |

**Where to draw agent boundaries** — split a new agent out only when one of these
holds, otherwise fold the work into an existing role:

- **Specialty** — distinct expertise needing its own system prompt.
- **Parallelism** — runs concurrently with other work.
- **Context** — needs an isolated context window to avoid bleed.
- **Reuse** — other teams will call it too.

## Step 3 — Authoring conventions

When you call \`write_agent\`, follow these conventions:

- **Description is trigger-first** — \`"Use when …"\`, describing *when to delegate*,
  not a feature list. It is the only signal a parent uses to route work.
- **A team head sets \`teamRole: 'head'\`** — otherwise it is invisible to the CEO's
  \`find_agents({ teamRole: 'head' })\` discovery and to the team selector. Each team
  has exactly one head.
- **ICs carry \`role\` and \`capabilities\`** so heads can discover them by tag.
- **\`toolScope\` is least privilege.** Pick the narrowest of
  \`all | fs | web | memory | peekaboo | authoring\`. \`authoring\` is privileged
  (it grants \`write_agent\` / \`write_skill\`) — grant it ONLY to training-type agents.
- **The head discovers teammates at runtime** — its system prompt must use
  \`find_agents({ team, role })\` and message the returned address. NEVER hardcode a
  teammate's instance name; names are per-run.
- **State the workflow and bound the loops** — a head's prompt spells out its
  numbered workflow and caps any fix/review loop (≤10 rounds) so it cannot spin.

For \`write_skill\`: trigger-first description, imperative body, explain *why* not just
*what*, and keep it lean (move long detail into the body's own sections, not a wall
of rules).

## Step 4 — Static dry-run validation

After writing, verify WITHOUT spawning any agent:

1. **Discoverability** — \`find_agents\` returns the head and every IC with the
   correct \`team\` / \`role\` / \`teamRole\` tags. If one is missing, the write was
   wrong — fix and re-author.
2. **Dead-link check** — every teammate \`role\` referenced in a head's system prompt
   resolves via \`find_agents\`. A head that messages a role nobody fills will hang.
3. **Trigger self-check** — write 3 phrasings that SHOULD route to the new agent and
   2 near-miss phrasings that should NOT. Read the description and confirm it matches
   the 3 and rejects the 2. Tighten the description if a near-miss would match.
4. **Honest errors** — if \`write_agent\` / \`write_skill\` returned an error, report it
   verbatim and fix it. Never claim a creation that was rejected.

## Step 5 — Evolution

Authoring is an overwrite, not an append — so evolve deliberately:

- **Read before you overwrite** — fetch the existing definition first, preserve what
  works, and change only what the feedback targets.
- **Log the change** — append one line to \`~/.swarm-agents/agents/CHANGELOG.md\`:
  \`YYYY-MM-DD — what changed (agent/skill id) — why\`. This gives the roster a
  traceable history and makes regressions visible.`,
  }
}
