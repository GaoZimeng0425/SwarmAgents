import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'
import type { AgentDefinition } from '@swarm/protocol'
import type { Skill } from '@swarm/protocol'

import type { ToolRunContext, ToolSpec } from './registry'

const log = createLogger({ process: 'service' }).child({ component: 'tools' })

const WriteAgentParams = Type.Object({
  id: Type.String({ description: 'Folder-name id: lowercase a-z/0-9 with single hyphens, ≤64 chars.' }),
  name: Type.String({ description: 'Human-readable display name.' }),
  description: Type.String({ description: 'Trigger-first one-liner ("Use when …") shown in the sub-agent catalog.' }),
  systemPrompt: Type.String({ description: "The agent's full system prompt (its job, teammates, conventions)." }),
  toolScope: Type.String({ description: "Capability scope: 'all' | 'fs' | 'web' | 'memory' | 'peekaboo' | 'authoring'." }),
  team: Type.Optional(Type.String({ description: 'Team tag, e.g. "dev" or "ui".' })),
  teamRole: Type.Optional(Type.String({ description: "Set to 'head' to make this the team's entry-point agent." })),
  role: Type.Optional(Type.String({ description: 'Discoverable role handle; defaults to the id when unset.' })),
  capabilities: Type.Optional(Type.Array(Type.String(), { description: 'Capability tags for discovery.' })),
  maxIterations: Type.Optional(Type.Number({ description: 'Max agent loop iterations (default 25).' })),
})

export function writeAgentSpec(): ToolSpec {
  return {
    group: 'authoring',
    name: 'write_agent',
    risk: 'medium',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'write_agent',
      label: 'Author an agent',
      description:
        'Create or overwrite an agent definition on disk (in ~/.swarm-agents/agents). The new agent becomes immediately discoverable via find_agents. Use to grow the company with new roles or teams.',
      parameters: WriteAgentParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as Partial<AgentDefinition>
        if (!ctx.writeAgent) {
          return { content: [{ type: 'text', text: 'Authoring is not available to this agent.' }], details: {} }
        }
        log.info({ msg: 'write_agent', id: p.id, team: p.team })
        const res = ctx.writeAgent(p as AgentDefinition)
        if (!res.ok) {
          log.warn({ msg: 'write_agent rejected', id: p.id, code: res.code })
          return { content: [{ type: 'text', text: `Could not create agent: ${res.message}` }], details: {} }
        }
        return { content: [{ type: 'text', text: `Agent "${p.id}" created. It is now discoverable via find_agents.` }], details: {} }
      },
    }),
  }
}

const WriteSkillParams = Type.Object({
  name: Type.String({ description: 'Skill folder name (becomes ~/.swarm-agents/skills/<name>/SKILL.md).' }),
  description: Type.String({ description: 'Trigger-first one-liner describing when to use the skill.' }),
  body: Type.String({ description: 'The skill body (markdown instructions).' }),
})

export function writeSkillSpec(): ToolSpec {
  return {
    group: 'authoring',
    name: 'write_skill',
    risk: 'medium',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'write_skill',
      label: 'Author a skill',
      description:
        'Create or overwrite a skill on disk (in ~/.swarm-agents/skills). The skills directory hot-reloads, so the skill becomes usable shortly after. Use to teach the company a reusable procedure.',
      parameters: WriteSkillParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as Skill
        if (!ctx.writeSkill) {
          return { content: [{ type: 'text', text: 'Authoring is not available to this agent.' }], details: {} }
        }
        log.info({ msg: 'write_skill', name: p.name })
        const res = ctx.writeSkill(p)
        if (!res.ok) {
          log.warn({ msg: 'write_skill rejected', name: p.name, code: res.code })
          return { content: [{ type: 'text', text: `Could not create skill: ${res.message}` }], details: {} }
        }
        return { content: [{ type: 'text', text: `Skill "${p.name}" created.` }], details: {} }
      },
    }),
  }
}
