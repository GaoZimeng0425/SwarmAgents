// Thread-level analysis: clones analyze.ts's run-engine pattern but keys
// broadcasts by threadId and parses a tail-JSON block (<!--ANALYSIS:{...}-->)
// on completion to deliver structured {summary, todos, suggest}. The streamed
// markdown IS the summary shown to the user; the tail block adds the
// structured fields. Parse failure degrades to empty todos/suggest (summary
// intact) — never blocks the user-facing summary.
import { createLogger } from '@shared/logger'
import type {
  AnalyzeThreadRequest,
  AnalyzeThreadResult,
  BudgetConfig,
  ThreadAnalysisPayload,
  Todo,
} from '@swarm/protocol'
import { applyAgentModel, defaultAgents } from '@swarm/shared'
import { ulid } from 'ulid'

import type { AgentStore } from '../agents/store'
import type { Broadcaster } from '../ipc/broadcaster'
import type { RunEmitPorts } from '../run-engine/emit'
import { type LaunchPorts, launchRun, type RunSpec } from '../run-engine/launch'
import { createPermissionRegistry } from '../session/permission-registry'
import type { ToolRegistry } from '../tools/registry'

const log = createLogger({ process: 'service' }).child({ component: 'gmail-analyze-thread' })

const GMAIL_THREAD_ANALYST_ID = 'gmail-thread-analyst'

// Extract the structured payload from the agent's markdown+tail-JSON output.
// Exported for unit testing. On any failure, returns {summary: fullMarkdown,
// todos: [], suggest: ''} so the streamed summary is still usable.
export function parseThreadPayload(fullMarkdown: string): ThreadAnalysisPayload {
  const matches = [...fullMarkdown.matchAll(/<!--ANALYSIS:(.*?)-->/gs)]
  if (matches.length === 0) {
    return { summary: fullMarkdown, todos: [], suggest: '' }
  }
  const last = matches[matches.length - 1][1]
  try {
    const parsed = JSON.parse(last) as { summary?: string; todos?: Todo[]; suggest?: string }
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : fullMarkdown,
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
      suggest: typeof parsed.suggest === 'string' ? parsed.suggest : '',
    }
  } catch {
    log.warn({ msg: 'thread analysis tail-JSON parse failed; degrading' })
    return { summary: fullMarkdown, todos: [], suggest: '' }
  }
}

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

    // Accumulate the streamed markdown so the run.complete handler can parse
    // the tail block. The broadcast port translates the run.* wire into
    // gmail.threadAnalysis* events keyed by threadId: run.progress llm.message
    // → threadAnalysisDelta, run.complete → threadAnalysisComplete (parsed),
    // run.error → threadAnalysisError. Tool/reasoning events are dropped.
    let accumulated = ''

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
          }
        } else if (evt.kind === 'run.complete') {
          // NOTE: do NOT append evt.summary here. Per translator.ts, the
          // run.complete summary is exactly the trimmed concatenation of the
          // same llm.message deltas already accumulated above via run.progress;
          // appending it again doubles the markdown (and any malformed
          // <!--ANALYSIS:{...}--> block) in the degradation path.
          const payload = parseThreadPayload(accumulated)
          deps.broadcaster.broadcast('gmail.threadAnalysisComplete', {
            threadId,
            summary: payload.summary,
            todos: payload.todos,
            suggest: payload.suggest,
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
      tools: [],
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
