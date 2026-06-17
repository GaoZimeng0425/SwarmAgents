import type { AgentDefinition } from '@shared/types/agent'

import { DEFAULT_SYSTEM_PROMPT } from './default-prompt'

// Agent types shipped with the app: always available, versioned in code, and
// merged into the on-disk agent store (a user definition of the same id wins).
// Lives in shared/ so the service — which actually runs agents and cannot import
// from main — can use it, mirroring default-prompt.ts.

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
  - click({id|coords|query, double?, right?}): click a UI element (prefer the id from see_screen) or coordinates.
  - type({text, clear?, pressReturn?}): type text into the focused element.
  - scroll({direction, amount?, id?}): scroll the view.
  - hotkey({keys}): press a shortcut, e.g. "cmd,c".

Workflow:
  1. Understand the action to perform.
  2. Call see_screen to find the target UI elements and their IDs.
  3. Act with click / type / scroll / hotkey, referencing element IDs from see_screen.
  4. Re-check with see_screen when the screen should have changed, and report the result.
  5. If an action fails, explain why and do not retry blindly.`

// Descriptions are trigger-first ("Use when …") so the parent agent matches on
// WHEN to delegate, mirroring how skill descriptions drive use_skill.
export const builtinAgents: AgentDefinition[] = [
  {
    id: 'default',
    name: 'Default Agent',
    description:
      'Use as the catch-all fallback for any sub-task that needs full tool access (shell, files, web, UI) and does not fit a more specialized type.',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    toolScope: 'all',
    maxIterations: 25,
  },
  {
    id: 'researcher',
    name: 'Research Agent',
    description:
      'Use when the task needs read-only investigation of on-screen state across one or more apps and must not change anything; runs in its own focused context.',
    systemPrompt: RESEARCHER_SYSTEM_PROMPT,
    toolScope: 'peekaboo',
    maxIterations: 15,
  },
  {
    id: 'executor',
    name: 'Executor Agent',
    description:
      'Use when the task is to drive on-screen UI actions (click, type, scroll, hotkey) to accomplish a concrete change in a GUI app.',
    systemPrompt: EXECUTOR_SYSTEM_PROMPT,
    toolScope: 'all',
    maxIterations: 20,
  },
]

/** The default agent type — single source of truth for the fallback definition. */
export const DEFAULT_AGENT_DEF: AgentDefinition = builtinAgents[0]
