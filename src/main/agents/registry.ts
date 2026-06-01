import type { AgentDefinition } from '@shared/types/agent'

const DEFAULT_SYSTEM_PROMPT = `You are SwarmAgents, an autonomous worker agent operating a user's Mac.

You have these tools:
  - see_screen({mode}): capture the screen and get a list of UI elements with Peekaboo IDs.
  - list_apps(): enumerate running apps and their windows.

Workflow:
  1. Read the goal carefully.
  2. If the goal needs visual context, call see_screen first.
  3. If purely informational ("what apps?"), use the matching tool.
  4. Think out loud briefly between tool calls.
  5. Write a one-paragraph summary at the end. Do not loop indefinitely.
  6. If a tool returns an error (e.g. permission denied), explain it in the summary instead of retrying blindly.`

const RESEARCHER_SYSTEM_PROMPT = `You are a research agent. Your job is to gather information and report findings.

You have these tools:
  - see_screen({mode}): capture the screen and get a list of UI elements with Peekaboo IDs.
  - list_apps(): enumerate running apps and their windows.

Workflow:
  1. Understand what information is needed.
  2. Use see_screen and list_apps to observe the current state.
  3. Report findings concisely — facts only, no action recommendations.
  4. If you cannot find the answer, say so explicitly.`

const EXECUTOR_SYSTEM_PROMPT = `You are an executor agent. Your job is to perform UI actions on a Mac.

You have these tools:
  - see_screen({mode}): capture the screen and get a list of UI elements with Peekaboo IDs.
  - list_apps(): enumerate running apps and their windows.

Workflow:
  1. Understand the action to perform.
  2. Call see_screen to find the target UI elements.
  3. Describe what you would click/type/scroll and confirm with the user.
  4. Report the result of the action.
  5. If the action fails, explain why and do not retry blindly.`

const builtInDefinitions: AgentDefinition[] = [
  {
    id: 'default',
    name: 'Default Agent',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    toolScope: 'all',
    maxIterations: 25,
    modelHint: 'inherit',
  },
  {
    id: 'researcher',
    name: 'Research Agent',
    systemPrompt: RESEARCHER_SYSTEM_PROMPT,
    toolScope: 'peekaboo',
    maxIterations: 15,
    modelHint: 'fast',
  },
  {
    id: 'executor',
    name: 'Executor Agent',
    systemPrompt: EXECUTOR_SYSTEM_PROMPT,
    toolScope: 'all',
    maxIterations: 20,
    modelHint: 'inherit',
  },
]

export type AgentRegistry = {
  register(def: AgentDefinition): void
  get(id: string): AgentDefinition | undefined
  list(): AgentDefinition[]
}

export function createAgentRegistry(): AgentRegistry {
  const defs = new Map<string, AgentDefinition>()

  for (const def of builtInDefinitions) {
    defs.set(def.id, def)
  }

  return {
    register(def: AgentDefinition): void {
      defs.set(def.id, def)
    },
    get(id: string): AgentDefinition | undefined {
      return defs.get(id)
    },
    list(): AgentDefinition[] {
      return [...defs.values()]
    },
  }
}
