import type { WebSearchInjection } from '@swarm/protocol'

import { calendarSpecs } from '../calendar/tools'
import type { ClaudeCodeManager } from '../claude-code/manager'
import type { CronScheduler } from '../cron/scheduler'
import { gmailSpecs } from '../gmail/tools'
import type { MemoryStore } from '../memory/store'
import type { SkillStore } from '../skills/store'
import { writeAgentSpec, writeSkillSpec } from './authoring'
import { claudeCodeSpecs } from './claude-code'
import { createTaskSpec } from './create-task'
import { cronSpecs } from './cron'
import { delegationPlanSpec } from './delegation-plan'
import { fsSpecs } from './fs'
import { memorySpecs } from './memory'
import { findAgentsSpec } from './messaging'
import { buildPeekabooTools } from './peekaboo'
import { updatePlanSpec } from './plan'
import type { ToolRegistry, ToolRisk, ToolSpec } from './registry'
import { renderUiSpec } from './render-ui'
import { shellSpec } from './shell'
import { useSkillSpec } from './skill'
import { currentTimeSpec } from './time'
import { analyzeImageSpec, ocrImageSpec } from './vision'
import { getWeatherSpec } from './weather'
import { webFetchSpec, webSearchSpec } from './web'

const PEEKABOO_RISK: Record<string, ToolRisk> = {
  // Read-only observation and the reversible scroll auto-run; consequential
  // interactions (click/type/hotkey) escalate to the permission prompt.
  see_screen: 'low',
  list_apps: 'low',
  scroll: 'low',
  click: 'high',
  type: 'high',
  hotkey: 'high',
}

export function peekabooSpecs(): ToolSpec[] {
  // Peekaboo executors ignore deps (permission is enforced centrally in
  // beforeToolCall), so building once at registration is safe — the tool
  // objects are reused across runs.
  const tools = buildPeekabooTools({
    send: () => undefined,
    requestPermission: () => Promise.resolve('grant' as const),
  })
  return tools.map((tool) => ({
    group: 'peekaboo',
    name: tool.name,
    risk: PEEKABOO_RISK[tool.name] ?? 'medium',
    source: 'builtin' as const,
    build: () => tool,
  }))
}

export function registerBuiltinTools(
  registry: ToolRegistry,
  deps?: {
    memoryStore?: MemoryStore
    skillStore?: SkillStore
    scheduler?: CronScheduler
    claudeCode?: ClaudeCodeManager
    getWebSearchConfig?: () => WebSearchInjection
    /** Live predicate from the tool-toggles store; undefined → all skills enabled. */
    isSkillEnabled?: (name: string) => boolean
    /** Service-side client for gmail.* mainRequest/mainResponse calls. */
    gmailMainRpc?: (method: import('@swarm/protocol').MainMethod, args: unknown[]) => Promise<unknown>
    /** Service-side client for calendar.* mainRequest/mainResponse calls. */
    calendarMainRpc?: (method: import('@swarm/protocol').MainMethod, args: unknown[]) => Promise<unknown>
  }
): void {
  for (const spec of peekabooSpecs()) registry.register(spec)
  registry.register(createTaskSpec())
  registry.register(findAgentsSpec())
  registry.register(writeAgentSpec())
  registry.register(writeSkillSpec())
  registry.register(updatePlanSpec())
  registry.register(delegationPlanSpec())
  registry.register(renderUiSpec())
  registry.register(shellSpec())
  registry.register(currentTimeSpec())
  registry.register(getWeatherSpec())
  registry.register(webFetchSpec())
  // Vision: analyze_image resolves an image-capable model from the task's
  // provider chain at call time (via ctx.analyzeImage); ocr_image runs local
  // macOS Vision OCR (offline, no model). Neither needs a registration-time dep.
  registry.register(analyzeImageSpec())
  registry.register(ocrImageSpec())
  // No config getter (e.g. tests) → 'auto' with env-var fallback inside web.ts.
  registry.register(webSearchSpec(deps?.getWebSearchConfig ?? (() => ({ provider: 'auto' }))))
  for (const spec of fsSpecs()) registry.register(spec)
  // Memory tools need a backing store; registered only when one is injected.
  if (deps?.memoryStore) for (const spec of memorySpecs(deps.memoryStore)) registry.register(spec)
  // use_skill needs the skill store; registered only when one is injected.
  // biome-ignore lint/correctness/useHookAtTopLevel: not a React hook; factory that registers the use_skill tool spec, called conditionally is fine.
  if (deps?.skillStore) registry.register(useSkillSpec(deps.skillStore, deps.isSkillEnabled))
  // Cron tools need the scheduler; registered only when one is injected.
  if (deps?.scheduler) for (const spec of cronSpecs(deps.scheduler)) registry.register(spec)
  // cc_* tools need the Claude Code manager; registered only when one is injected.
  if (deps?.claudeCode) for (const spec of claudeCodeSpecs(deps.claudeCode)) registry.register(spec)
  // gmail.* tools need the service→main rpc to query the cache; registered only when one is injected.
  if (deps?.gmailMainRpc) for (const spec of gmailSpecs(deps.gmailMainRpc)) registry.register(spec)
  // calendar.* tools need the service→main rpc to query/mutate the cache.
  if (deps?.calendarMainRpc) for (const spec of calendarSpecs(deps.calendarMainRpc)) registry.register(spec)
}
