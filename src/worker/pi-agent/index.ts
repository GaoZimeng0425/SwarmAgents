import { Agent } from '@earendil-works/pi-agent-core'
import { getModel } from '@earendil-works/pi-ai'
import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai'
import type { Outbound } from '@shared/types/ipc'
import type { ProviderInjection } from '@shared/types/provider'
import type { Task } from '@shared/types/task'

// `getModel`'s generics demand a literal model-id key per provider. Our
// `ProviderInjection.model` is a runtime-validated string (Zod-checked at the
// IPC boundary), so we erase the literal constraint via a looser local
// alias. This avoids `as any` and keeps callers strict.
const getModelLoose = getModel as unknown as (
  provider: KnownProvider,
  modelId: string,
) => Model<Api>

import type { PermissionClient } from '../permission-client'
import { createEventTranslator } from './events'
import { buildPeekabooTools } from './tools/peekaboo'

type Deps = {
  send: (m: Outbound) => void
  permissionClient: PermissionClient
  provider: ProviderInjection
}

const SYSTEM_PROMPT = `You are SwarmAgents, an autonomous worker agent operating a user's Mac.

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

export async function runPiAgent(task: Task, deps: Deps): Promise<void> {
  const tools = buildPeekabooTools({
    send: deps.send,
    requestPermission: (args) =>
      deps.permissionClient.request({
        taskId: task.id,
        toolName: args.toolName,
        risk: args.risk,
        summary: args.summary,
        payload: args.payload,
      }),
  })

  // Spike (Task 1) verified: pi-ai's `getModel` is strictly 2-arity and silently
  // ignores a 3rd arg. The `Agent` constructor takes `AgentOptions` (not
  // `AgentLoopConfig`), which exposes a `getApiKey(provider)` callback for
  // explicit key injection — this is the supported path that keeps the lib
  // from falling back to env vars. Returning the injected key for every
  // provider is fine here because each worker is dispatched with exactly one.
  const agent = new Agent({
    getApiKey: () => deps.provider.apiKey,
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: getModelLoose(deps.provider.id, deps.provider.model),
      tools,
      messages: [],
    },
    beforeToolCall: async ({ toolCall, args }) => {
      // Phase D1 has only low-risk read-only tools; the deny path stays open
      // for future high-risk tools wired via this hook in Plan E.
      const risk: 'low' | 'medium' | 'high' =
        toolCall.name === 'see_screen' || toolCall.name === 'list_apps' ? 'low' : 'medium'

      if (risk === 'low') return undefined

      const decision = await deps.permissionClient.request({
        taskId: task.id,
        toolName: toolCall.name,
        risk,
        summary: `Run tool: ${toolCall.name}`,
        payload: args,
      })

      if (decision === 'grant') return undefined
      return { block: true, reason: `User ${decision} the action.` }
    },
  })

  const translator = createEventTranslator(task.id, deps.send)
  agent.subscribe((e) => translator.handle(e))

  try {
    await agent.prompt(task.goal)
  } catch (err) {
    deps.send({
      type: 'task.error',
      taskId: task.id,
      error: {
        code: 'agent_exception',
        message: err instanceof Error ? err.message : String(err),
        tier: 'fatal',
      },
    })
  }
}
