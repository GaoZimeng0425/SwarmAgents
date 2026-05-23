import { createAnthropic } from '@ai-sdk/anthropic'
import { streamText, tool } from 'ai'
import { z } from 'zod'

import type { Outbound } from '@shared/types/ipc'
import type { Task, TaskEvent } from '@shared/types/task'

import type { SendFn } from './handler'

/**
 * Real agent loop. Runs Vercel AI SDK `streamText` against Anthropic with a
 * small set of demo tools. Streams text chunks as llm.message progress
 * events, tool calls as tool.call events, tool results as tool.result events,
 * and finishes with task.complete.
 *
 * The Phase B demo tools (`read_screen`, `note_finding`) return stub data;
 * Phase C will replace them with real MCP tool calls (Peekaboo, Playwright,
 * filesystem).
 */
export async function runAgent(task: Task, send: SendFn): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    send({
      type: 'task.error',
      taskId: task.id,
      error: {
        code: 'missing_api_key',
        message:
          'ANTHROPIC_API_KEY env var not set. Set it in your shell and restart the app, ' +
          'or switch to the simulator by exporting SWARM_USE_SIMULATOR=1.',
        tier: 'fatal',
      },
    })
    return
  }

  const anthropic = createAnthropic({ apiKey })
  const model = anthropic('claude-sonnet-4-5')

  const progress = (event: TaskEvent): void => {
    const msg: Outbound = { type: 'progress', event }
    send(msg)
  }

  const tools = {
    read_screen: tool({
      description:
        'Take a screenshot of the current screen and return a short textual description. ' +
        'In this demo build the description is stubbed; in production it routes through ' +
        'Peekaboo MCP.',
      inputSchema: z.object({}),
      execute: async () => {
        progress({
          kind: 'tool.call',
          server: 'peekaboo',
          tool: 'see',
          args: {},
          ts: Date.now(),
        })
        // Stub — Phase C wires real Peekaboo.
        const result = '(stub) A macOS desktop with several windows open and dock visible.'
        progress({
          kind: 'tool.result',
          ok: true,
          payload: { kind: 'text', text: result },
          ts: Date.now(),
        })
        return result
      },
    }),
    note_finding: tool({
      description:
        'Record a finding or intermediate observation that will be included in the final ' +
        'summary. Use this when you discover something worth remembering.',
      inputSchema: z.object({
        text: z.string().describe('The finding to record. Keep it under one paragraph.'),
      }),
      execute: async ({ text }) => {
        progress({
          kind: 'tool.call',
          server: 'agent',
          tool: 'note',
          args: { text },
          ts: Date.now(),
        })
        progress({
          kind: 'tool.result',
          ok: true,
          payload: { kind: 'text', text: `Noted: ${text}` },
          ts: Date.now(),
        })
        return 'recorded'
      },
    }),
  }

  const systemPrompt = `You are SwarmAgents, an autonomous worker agent. Your job is to take \
a single user goal and accomplish it as far as the available tools allow. Think out loud \
briefly between tool calls so the user can follow your reasoning. When you are done, write \
a one-paragraph summary of what you accomplished or what blocked you, then stop.`

  let summary = ''
  let textBuffer = ''
  const flushBuffer = (): void => {
    if (textBuffer.length === 0) return
    summary += textBuffer
    progress({
      kind: 'llm.message',
      role: 'assistant',
      content: textBuffer,
      ts: Date.now(),
    })
    textBuffer = ''
  }

  try {
    const result = streamText({
      model,
      system: systemPrompt,
      prompt: task.goal,
      tools,
      stopWhen: ({ steps }) => steps.length >= 6,
    })

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        textBuffer += part.text ?? ''
        // Flush when we hit a sentence-end or every ~200 chars.
        if (/[.!?\n]\s*$/.test(textBuffer) || textBuffer.length > 200) {
          flushBuffer()
        }
      } else if (part.type === 'tool-call' || part.type === 'tool-result') {
        // tool.call / tool.result already emitted from inside the tool's execute()
        flushBuffer()
      } else if (part.type === 'error') {
        flushBuffer()
        send({
          type: 'task.error',
          taskId: task.id,
          error: {
            code: 'llm_error',
            message: part.error instanceof Error ? part.error.message : String(part.error),
            tier: 'recoverable',
          },
        })
        return
      }
    }
    flushBuffer()

    const finalSummary = summary.trim() || `Completed: ${task.goal}`
    send({
      type: 'task.complete',
      taskId: task.id,
      result: { summary: finalSummary, artifacts: [] },
    })
  } catch (err) {
    flushBuffer()
    send({
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
