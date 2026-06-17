import type { Skill } from '@shared/types/skill'

/**
 * Skills shipped with the app: always available, versioned in code, and not
 * user-deletable (unlike on-disk skills). Merged into the skill store's list.
 */
export function builtinSkills(opts: { mcpConfigPath: string }): Skill[] {
  return [operationsManual(opts.mcpConfigPath)]
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
