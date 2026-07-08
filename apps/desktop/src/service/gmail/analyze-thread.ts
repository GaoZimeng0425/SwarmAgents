// Thread-level analysis: clones analyze.ts's run-engine pattern but keys
// broadcasts by threadId. The agent streams a natural-language markdown summary
// (shown to the user) and emits its structured fields via a
// render_ui({type:'analysis', props:{todos, suggest}}) tool call, which the
// broadcast adapter captures with readAnalysisCard. The streamed markdown IS
// the summary; the card adds todos/suggest. No card → empty todos/suggest
// (summary intact) — never blocks the user-facing summary.
import { createLogger } from '@shared/logger'
import type { AnalyzeThreadRequest, AnalyzeThreadResult, BudgetConfig, Todo } from '@swarm/protocol'
import { applyAgentModel, defaultAgents } from '@swarm/shared'
import { ulid } from 'ulid'

import type { AgentStore } from '../agents/store'
import type { Broadcaster } from '../ipc/broadcaster'
import type { RunEmitPorts } from '../run-engine/emit'
import { type LaunchPorts, launchRun, type RunSpec } from '../run-engine/launch'
import { createPermissionRegistry } from '../session/permission-registry'
import type { ToolRegistry } from '../tools/registry'
import { readAnalysisCard } from '../tools/render-ui'

const log = createLogger({ process: 'service' }).child({ component: 'gmail-analyze-thread' })

const GMAIL_THREAD_ANALYST_ID = 'gmail-thread-analyst'

export type AnalyzeThreadDeps = {
  broadcaster: Broadcaster
  agentStore: Pick<AgentStore, 'get'>
  toolRegistry: ToolRegistry
  getBudgetConfig(): BudgetConfig
  /** Injectable so tests can drive the emit adapter without a real provider/engine. */
  launch?: typeof launchRun
}

export function createAnalyzeThread(deps: AnalyzeThreadDeps): (req: AnalyzeThreadRequest) => AnalyzeThreadResult {
  const run = deps.launch ?? launchRun
  return (req) => {
    if (!req.provider) {
      return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    }
    const def =
      deps.agentStore.get(GMAIL_THREAD_ANALYST_ID) ?? defaultAgents.find((a) => a.id === GMAIL_THREAD_ANALYST_ID)
    if (!def) {
      return { ok: false, code: 'no_agent', message: 'gmail-thread-analyst agent 不可用。' }
    }
    const threadId = req.threadId
    log.info({
      msg: 'thread analyze started',
      threadId,
      subjectLen: req.subject.length,
      messageCount: req.messages.length,
    })

    // Accumulate the streamed markdown as the summary and capture the structured
    // fields from the render_ui analysis card. The broadcast port translates the
    // run.* wire into gmail.threadAnalysis* events keyed by threadId:
    // run.progress llm.message → threadAnalysisDelta (+ accumulate),
    // run.progress tool.call (analysis card) → capture todos/suggest,
    // run.complete → threadAnalysisComplete, run.error → threadAnalysisError.
    let accumulated = ''
    let card: { todos: Todo[]; suggest: string } | null = null

    let seq = 0
    const emitPorts: RunEmitPorts = {
      nextSeq: () => seq++,
      appendEvent: () => undefined,
      markTerminal: () => undefined,
      broadcast: (evt) => {
        if (evt.kind === 'run.progress') {
          const ev = evt.event
          if (ev?.kind === 'llm.message' && typeof ev.content === 'string') {
            accumulated += ev.content
            deps.broadcaster.broadcast('gmail.threadAnalysisDelta', { threadId, text: ev.content, ts: Date.now() })
            return
          }
          const props = readAnalysisCard(evt)
          if (props) {
            card = {
              todos: Array.isArray(props.todos) ? (props.todos as Todo[]) : [],
              suggest: typeof props.suggest === 'string' ? props.suggest : '',
            }
          }
        } else if (evt.kind === 'run.complete') {
          // summary = the streamed markdown; todos/suggest = the captured card
          // (empty when the agent emitted no card).
          deps.broadcaster.broadcast('gmail.threadAnalysisComplete', {
            threadId,
            summary: accumulated,
            todos: card?.todos ?? [],
            suggest: card?.suggest ?? '',
            ts: Date.now(),
          })
        } else if (evt.kind === 'run.error') {
          deps.broadcaster.broadcast('gmail.threadAnalysisError', {
            threadId,
            error: evt.error?.message ?? 'thread analysis failed',
            ts: Date.now(),
          })
        }
      },
    }

    // No-op slot/abort ports and a no-op permission gate: a self-contained run
    // (only the low-risk render_ui structured-output tool) that competes for
    // nothing and prompts for nothing.
    const ports: LaunchPorts = {
      emit: emitPorts,
      toolRegistry: deps.toolRegistry,
      permissionRegistry: createPermissionRegistry(() => undefined),
      acquireSlot: async () => () => undefined,
      registerAbort: () => undefined,
      unregisterAbort: () => undefined,
    }

    // Concatenate the thread's messages into the prompt.
    const threadText = req.messages
      .map((m) => `---\nFrom: ${m.from}\nDate: ${new Date(m.dateMs).toLocaleString()}\n\n${m.bodyText}`)
      .join('\n\n')
    const prompt = `分析下面这个邮件线程。\n\nSubject: ${req.subject}\n\n${threadText}`

    const spec: RunSpec = {
      kind: 'work',
      sessionId: `analyze-thread:${ulid()}`,
      agent: def,
      provider: applyAgentModel(req.provider, def),
      prompt,
      budget: deps.getBudgetConfig().sub,
      tools: ['render_ui'],
      maxIterationsOverride: def.maxIterations,
    }

    const t0 = Date.now()
    // launchRun never rejects: every failure path emits run.error, which the
    // broadcast port already forwards as threadAnalysisError. The catch is
    // purely defensive (log-only, no double broadcast).
    void run(spec, ports)
      .then((r) =>
        log.info({ msg: 'thread analyze complete', threadId, status: r.status, durationMs: Date.now() - t0 })
      )
      .catch((err) => {
        log.error({
          msg: 'thread analyze run failed',
          threadId,
          err: err instanceof Error ? err.message : String(err),
        })
      })

    return { ok: true }
  }
}
