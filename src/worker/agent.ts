import { createAnthropic } from '@ai-sdk/anthropic'
import { streamText, tool } from 'ai'
import { z } from 'zod'

import type { Outbound } from '@shared/types/ipc'
import type { Task, TaskEvent } from '@shared/types/task'

import type { SendFn } from './handler'
import { runPeekaboo, summariseSeeOutput } from './tools/peekaboo'

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
    see_screen: tool({
      description:
        'Capture the current screen and return a list of detected UI elements with their ' +
        'Peekaboo IDs, roles, and labels. Use this when you need to know what is on screen ' +
        'before interacting with it. Requires macOS Screen Recording permission for the ' +
        'parent Electron app.',
      inputSchema: z.object({
        mode: z
          .enum(['screen', 'frontmost', 'window'])
          .default('frontmost')
          .describe('Capture target. Default `frontmost` captures the focused window only.'),
      }),
      execute: async ({ mode }) => {
        progress({
          kind: 'tool.call',
          server: 'peekaboo',
          tool: 'see',
          args: { mode },
          ts: Date.now(),
        })
        const result = await runPeekaboo(['see', '--mode', mode, '--json'])
        if (!result.ok) {
          progress({
            kind: 'tool.result',
            ok: false,
            payload: { kind: 'text', text: result.error },
            ts: Date.now(),
          })
          return `Error: ${result.error}`
        }
        const summary = summariseSeeOutput(result.parsed)
        progress({
          kind: 'tool.result',
          ok: true,
          payload: { kind: 'text', text: summary },
          ts: Date.now(),
        })
        return summary
      },
    }),
    list_apps: tool({
      description:
        'List the currently running applications and their open windows. Useful when the ' +
        'user mentions an app by name and you want to confirm it is running.',
      inputSchema: z.object({}),
      execute: async () => {
        progress({
          kind: 'tool.call',
          server: 'peekaboo',
          tool: 'list',
          args: {},
          ts: Date.now(),
        })
        const result = await runPeekaboo(['list', 'apps', '--json'])
        if (!result.ok) {
          progress({
            kind: 'tool.result',
            ok: false,
            payload: { kind: 'text', text: result.error },
            ts: Date.now(),
          })
          return `Error: ${result.error}`
        }
        const text = result.stdout.slice(0, 4000)
        progress({
          kind: 'tool.result',
          ok: true,
          payload: { kind: 'text', text },
          ts: Date.now(),
        })
        return text
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

  const systemPrompt = `You are SwarmAgents, an autonomous worker agent operating a user's Mac.

You have these tools:
  - see_screen({mode}): capture the screen and get a list of UI elements with Peekaboo IDs.
  - list_apps(): enumerate running apps and their windows.
  - note_finding({text}): record an observation for the final summary.

Workflow:
  1. Read the user's goal carefully.
  2. If the goal requires looking at the screen, call see_screen first.
  3. If the goal is purely informational (e.g. "what apps are running?"), use the matching tool.
  4. Reason briefly between tool calls so the user can follow your thinking.
  5. When you are done — or when you cannot make further progress — write a one-paragraph summary of what you observed or accomplished and stop. Do not loop indefinitely.

Constraints:
  - Do not invent screen contents. Always call see_screen if you need to know what is visible.
  - If a tool returns an error (e.g. missing permission), explain the situation to the user in your summary rather than retrying blindly.`

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
