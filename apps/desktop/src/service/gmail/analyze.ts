// One-shot, tool-less analysis of a single email's bodyText. Rebuilt on
// launchRun (the ONE way a run starts) with a PRIVATE LaunchPorts binding: a
// silent seq, no store append, no-op slot/abort ports (the vision-run precedent
// in run-engine/launch.ts buildAnalyzeImage), and a broadcast adapter that
// translates the run.* stream into gmail.analysis* events keyed by messageId so
// the renderer's MessageAnalysis panel can stream. The gmail-analyst agent (a
// visible builtin) supplies the Chinese structured-Markdown prompt.
import { createLogger } from '@shared/logger'
import type { AnalyzeEmailRequest, AnalyzeEmailResult, BudgetConfig } from '@swarm/protocol'
import { applyAgentModel, defaultAgents } from '@swarm/shared'
import { ulid } from 'ulid'

import type { AgentStore } from '../agents/store'
import type { Broadcaster } from '../ipc/broadcaster'
import type { RunEmitPorts } from '../run-engine/emit'
import { type LaunchPorts, launchRun, type RunSpec } from '../run-engine/launch'
import { createPermissionRegistry } from '../session/permission-registry'
import type { ToolRegistry } from '../tools/registry'

const log = createLogger({ process: 'service' }).child({ component: 'gmail-analyze' })

const GMAIL_ANALYST_ID = 'gmail-analyst'

export type AnalyzeDeps = {
  broadcaster: Broadcaster
  agentStore: Pick<AgentStore, 'get'>
  toolRegistry: ToolRegistry
  getBudgetConfig(): BudgetConfig
  /** Injectable so tests can drive the emit adapter without a real provider/engine. */
  launch?: typeof launchRun
}

export function createAnalyzeEmail(deps: AnalyzeDeps): (req: AnalyzeEmailRequest) => AnalyzeEmailResult {
  const run = deps.launch ?? launchRun
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

    // PRIVATE emit ports: a silent seq (no session/store), no persistence, no
    // terminal registry — the analysis lives entirely in the broadcast stream.
    // The broadcast port translates the run.* wire into gmail.analysis* events:
    // run.progress llm.message → analysisDelta, run.complete → analysisComplete,
    // run.error → analysisError. Tool/reasoning events are dropped (tool-less).
    let seq = 0
    const emitPorts: RunEmitPorts = {
      nextSeq: () => seq++,
      appendEvent: () => undefined,
      markTerminal: () => undefined,
      broadcast: (evt) => {
        if (evt.kind === 'run.progress') {
          const ev = evt.event
          if (ev?.kind === 'llm.message' && typeof ev.content === 'string') {
            deps.broadcaster.broadcast('gmail.analysisDelta', { messageId, text: ev.content, ts: Date.now() })
          }
        } else if (evt.kind === 'run.complete') {
          deps.broadcaster.broadcast('gmail.analysisComplete', { messageId, markdown: evt.summary, ts: Date.now() })
        } else if (evt.kind === 'run.error') {
          deps.broadcaster.broadcast('gmail.analysisError', {
            messageId,
            error: evt.error?.message ?? 'analysis failed',
            ts: Date.now(),
          })
        }
      },
    }

    // No-op slot/abort ports and a no-op permission gate: a self-contained,
    // tool-less run that competes for nothing and prompts for nothing.
    const ports: LaunchPorts = {
      emit: emitPorts,
      toolRegistry: deps.toolRegistry,
      permissionRegistry: createPermissionRegistry(() => undefined),
      acquireSlot: async () => () => undefined,
      registerAbort: () => undefined,
      unregisterAbort: () => undefined,
    }

    const analyzePrompt = `分析下面这封邮件。\n\nSubject: ${req.subject}\nFrom: ${req.from}\n\n${req.content}`
    const spec: RunSpec = {
      kind: 'work',
      sessionId: `analyze:${ulid()}`,
      agent: def,
      provider: applyAgentModel(req.provider, def),
      prompt: analyzePrompt,
      budget: deps.getBudgetConfig().sub,
      tools: [],
      maxIterationsOverride: def.maxIterations,
    }

    const t0 = Date.now()
    // launchRun never rejects: every failure path emits run.error, which the
    // broadcast port already forwards as analysisError. The catch is purely
    // defensive (log-only, no double broadcast).
    void run(spec, ports)
      .then((r) => log.info({ msg: 'analyze complete', messageId, status: r.status, durationMs: Date.now() - t0 }))
      .catch((err) => {
        log.error({ msg: 'analyze run failed', messageId, err: err instanceof Error ? err.message : String(err) })
      })

    return { ok: true }
  }
}
