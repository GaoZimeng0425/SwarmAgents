import type { WebSearchInjection } from '@shared/types/web-search'

import type { ClaudeCodeManager } from '../claude-code/manager'
import type { CronScheduler } from '../cron/scheduler'
import type { TaskWaiterService } from '../loop/task-waiters'
import type { MemoryStore } from '../memory/store'
import type { SkillStore } from '../skills/store'
import { acceptanceCriteriaSpec } from './acceptance-criteria'
import { delegationPlanSpec } from './delegation-plan'
import { writeAgentSpec, writeSkillSpec } from './authoring'
import { claudeCodeSpecs } from './claude-code'
import { cronSpecs } from './cron'
import { fsSpecs } from './fs'
import { memorySpecs } from './memory'
import { findAgentsSpec, sendAndWaitSpec, sendMessageSpec, whoamiSpec } from './messaging'
import { buildPeekabooTools } from './peekaboo'
import { updatePlanSpec } from './plan'
import type { ToolRegistry, ToolRisk, ToolSpec } from './registry'
import { renderUiSpec } from './render-ui'
import { shellSpec } from './shell'
import { useSkillSpec } from './skill'
import { spawnAgentSpec } from './spawn'
import { currentTimeSpec } from './time'
import { analyzeImageSpec, ocrImageSpec } from './vision'
import { waitForTaskSpecs } from './wait-for-task'
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
    taskWaiters?: TaskWaiterService
    getWebSearchConfig?: () => WebSearchInjection
    /** Live predicate from the tool-toggles store; undefined → all skills enabled. */
    isSkillEnabled?: (name: string) => boolean
  }
): void {
  for (const spec of peekabooSpecs()) registry.register(spec)
  registry.register(spawnAgentSpec())
  registry.register(sendMessageSpec())
  registry.register(sendAndWaitSpec())
  registry.register(whoamiSpec())
  registry.register(findAgentsSpec())
  registry.register(writeAgentSpec())
  registry.register(writeSkillSpec())
  registry.register(updatePlanSpec())
  registry.register(acceptanceCriteriaSpec())
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
  if (deps?.skillStore) registry.register(useSkillSpec(deps.skillStore, deps.isSkillEnabled))
  // Cron tools need the scheduler; registered only when one is injected.
  if (deps?.scheduler) for (const spec of cronSpecs(deps.scheduler)) registry.register(spec)
  // wait_for_task needs the waiter service; registered only when one is injected.
  if (deps?.taskWaiters) for (const spec of waitForTaskSpecs(deps.taskWaiters)) registry.register(spec)
  // cc_* tools need the Claude Code manager; registered only when one is injected.
  if (deps?.claudeCode) for (const spec of claudeCodeSpecs(deps.claudeCode)) registry.register(spec)
}
