// One-shot, tool-less analysis of a single email's bodyText. Mirrors the
// buildAnalyzeImage precedent (agent-runner.ts): a runner with an empty tool
// allowlist, but its `emit` is wired to broadcast progress so the renderer's
// MessageAnalysis panel can stream. The gmail-analyst agent (a visible builtin)
// supplies the Chinese structured-Markdown prompt.
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createLogger } from '@shared/logger'
import type { AnalyzeEmailRequest, AnalyzeEmailResult, BudgetConfig } from '@swarm/protocol'
import { applyAgentModel, defaultAgents } from '@swarm/shared'
import { ulid } from 'ulid'

import type { AgentStore } from '../agents/store'
import type { Broadcaster } from '../ipc/broadcaster'
import { type AgentRunnerDeps, createAgentRunner } from '../session/agent-runner'
import { createPermissionRegistry } from '../session/permission-registry'
import type { ToolRegistry } from '../tools/registry'

const log = createLogger({ process: 'service' }).child({ component: 'gmail-analyze' })

const GMAIL_ANALYST_ID = 'gmail-analyst'

export type AnalyzeDeps = {
  broadcaster: Broadcaster
  agentStore: Pick<AgentStore, 'get'>
  toolRegistry: ToolRegistry
  getBudgetConfig(): BudgetConfig
  /** Injectable so tests can stub the runner without a real provider. */
  createRunner?: typeof createAgentRunner
}

export function createAnalyzeEmail(deps: AnalyzeDeps): (req: AnalyzeEmailRequest) => AnalyzeEmailResult {
  const createRunner = deps.createRunner ?? createAgentRunner
  return (req) => {
    if (!req.provider) {
      return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    }
    const def = deps.agentStore.get(GMAIL_ANALYST_ID) ?? defaultAgents.find((a) => a.id === GMAIL_ANALYST_ID)
    if (!def) {
      return { ok: false, code: 'no_agent', message: 'gmail-analyst agent 不可用。' }
    }
    const messageId = req.messageId
    log.info({
      msg: 'analyze started',
      messageId,
      subjectLen: req.subject.length,
      contentLen: req.content.length,
    })

    // Translate the runner's task.* events into gmail.analysis* broadcasts keyed
    // by messageId. Only llm.message deltas, complete, and error are forwarded;
    // reasoning/tool events are dropped (the run is tool-less).
    const emit = (event: string, data: unknown): void => {
      const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
      if (event === 'task.progress') {
        const ev = obj.event as { kind?: string; content?: string } | undefined
        if (ev?.kind === 'llm.message' && typeof ev.content === 'string') {
          deps.broadcaster.broadcast('gmail.analysisDelta', { messageId, text: ev.content, ts: Date.now() })
        }
      } else if (event === 'task.complete') {
        const markdown = (obj.result as { summary?: string } | undefined)?.summary ?? ''
        deps.broadcaster.broadcast('gmail.analysisComplete', { messageId, markdown, ts: Date.now() })
      } else if (event === 'task.error') {
        const error = (obj.error as { message?: string } | undefined)?.message ?? 'analysis failed'
        deps.broadcaster.broadcast('gmail.analysisError', { messageId, error, ts: Date.now() })
      }
    }

    const analyzePrompt = `分析下面这封邮件。\n\nSubject: ${req.subject}\nFrom: ${req.from}\n\n${req.content}`
    const runnerDeps: AgentRunnerDeps = {
      correlationId: messageId,
      executionMode: 'goal',
      budget: deps.getBudgetConfig().sub,
      toolAllowlist: [],
      provider: applyAgentModel(req.provider, def),
      agentDefinition: def,
      sessionId: `analyze:${ulid()}`,
      emit,
      permissionRegistry: createPermissionRegistry(() => undefined),
      toolRegistry: deps.toolRegistry,
      initialMessages: [{ role: 'user', content: analyzePrompt }] as AgentMessage[],
      spawnChild: () => Promise.reject(new Error('spawnChild unavailable in analyze')),
      maxIterationsOverride: def.maxIterations,
    }

    const t0 = Date.now()
    void createRunner(runnerDeps)
      .run()
      .then((r) => log.info({ msg: 'analyze complete', messageId, status: r.status, durationMs: Date.now() - t0 }))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        log.error({ msg: 'analyze run failed', messageId, err: msg })
        deps.broadcaster.broadcast('gmail.analysisError', { messageId, error: msg, ts: Date.now() })
      })

    return { ok: true }
  }
}
