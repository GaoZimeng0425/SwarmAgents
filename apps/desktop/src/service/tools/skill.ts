import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { Skill } from '@swarm/protocol'

import type { SkillStore } from '../skills/store'
import type { ToolSpec } from './registry'

// Mirrors pi-agent-core's formatSkillInvocation: wrap the body in a <skill> tag
// carrying name + on-disk location so relative references in the body resolve.
function formatSkill(skill: Skill): string {
  if (!skill.filePath) return skill.body
  const slash = skill.filePath.lastIndexOf('/')
  const dir = slash <= 0 ? '/' : skill.filePath.slice(0, slash)
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dir}.\n\n${skill.body}\n</skill>`
}

// Progressive disclosure: the agent sees skill name+description in its prompt
// and calls use_skill to pull the full instructions only when one applies.
// `isEnabled` lets the global tool-toggles hide a skill: a disabled skill is
// absent from the available list and refused by name (defaults to all-enabled).
export function useSkillSpec(store: SkillStore, isEnabled: (name: string) => boolean = () => true): ToolSpec {
  return {
    group: 'skill',
    name: 'use_skill',
    risk: 'low',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'use_skill',
      label: 'Use skill',
      description:
        'Load the full instructions for a named skill from the available-skills list. Call this when a skill ' +
        'applies to the current task, then follow the returned instructions.',
      parameters: Type.Object({ name: Type.String({ description: 'The skill name to load.' }) }),
      execute: async (_id: string, params: unknown) => {
        const name = (params as { name?: string }).name
        const skill = name && isEnabled(name) ? store.get(name) : undefined
        if (!skill) {
          const avail =
            store
              .list()
              .filter((s) => isEnabled(s.name))
              .map((s) => s.name)
              .join(', ') || '(none)'
          return {
            content: [{ type: 'text', text: `No skill named "${String(name)}". Available skills: ${avail}` }],
            details: {},
          }
        }
        return { content: [{ type: 'text', text: formatSkill(skill) }], details: { name: skill.name } }
      },
    }),
  }
}
