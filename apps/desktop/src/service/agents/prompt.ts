import type { AgentDefinition } from '@swarm/protocol'

/** Append the available sub-agent-types section to a base system prompt. */
export function withAgentTypes(base: string, defs: AgentDefinition[]): string {
  if (defs.length === 0) return base
  const list = defs.map((d) => `- ${d.id}: ${d.description}`).join('\n')
  const section = `# Sub-agent types

You can delegate a focused sub-task by calling \`create_task\` (without \`asTopLevel\`) with an \`agentType\`. Delegate when a sub-task is independent, benefits from its own focused context, or should run under a narrower capability boundary (e.g. read-only investigation). Do the work yourself for trivial single-step actions — don't delegate by reflex. Use \`create_task\` with \`asTopLevel: true\` only when the user's request is substantial work you will own and do yourself.

Available types:
${list}`
  return base ? `${base}\n\n${section}` : section
}
