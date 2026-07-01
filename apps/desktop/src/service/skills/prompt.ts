import type { Skill } from '@swarm/protocol'

/** Append the available-skills section to a base system prompt. */
export function withSkills(base: string, skills: Skill[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation)
  if (visible.length === 0) return base
  const list = visible.map((s) => `- ${s.name}: ${s.description}`).join('\n')
  const section = `# Skills

You have access to these skills. When one applies to the task, call the \`use_skill\` tool with its name to load its full instructions before proceeding.

${list}`
  return base ? `${base}\n\n${section}` : section
}
