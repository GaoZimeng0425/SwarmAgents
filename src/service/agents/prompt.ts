import type { AgentDefinition } from '@shared/types/agent'

/** Append the available sub-agent-types section to a base system prompt. */
export function withAgentTypes(base: string, defs: AgentDefinition[]): string {
  if (defs.length === 0) return base
  const list = defs.map((d) => `- ${d.id}: ${d.description}`).join('\n')
  const section = `# Sub-agent types

You can delegate a focused sub-task by calling \`spawn_sub_agent\` with an \`agentType\`. Delegate when a sub-task is independent, benefits from its own focused context, or should run under a narrower capability boundary (e.g. read-only investigation). Do the work yourself for trivial single-step actions — don't delegate by reflex.

Available types:
${list}`
  return base ? `${base}\n\n${section}` : section
}
