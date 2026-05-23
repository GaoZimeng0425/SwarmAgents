import { spawn } from 'node:child_process'

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { Outbound } from '@shared/types/ipc'
import type { PermissionDecision } from '@shared/types/ui'

const PEEKABOO_BIN = process.env.PEEKABOO_BIN ?? 'peekaboo'

type Deps = {
  send: (msg: Outbound) => void
  requestPermission: (args: {
    toolName: string
    risk: 'low' | 'medium' | 'high'
    summary: string
    payload: unknown
  }) => Promise<PermissionDecision>
}

type CliResult = { ok: boolean; stdout: string; stderr: string; code: number | null }

function runCli(args: string[], timeoutMs = 20_000): Promise<CliResult> {
  return new Promise((resolve) => {
    const proc = spawn(PEEKABOO_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve({ ok: false, stdout, stderr: `${stderr}\n[timed out after ${timeoutMs}ms]`, code: null })
    }, timeoutMs)
    proc.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8')
    })
    proc.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: `${stderr}\nspawn error: ${err.message}`, code: null })
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr, code })
    })
  })
}

function summariseSeeOutput(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as {
      success?: boolean
      error?: { message?: string }
      data?: {
        screenshot_path?: string
        ui_elements?: Array<{
          id?: string
          role?: string
          title?: string
          value?: string
        }>
      }
    }
    if (parsed.success === false) return `peekaboo see failed: ${parsed.error?.message ?? 'unknown'}`
    const ui = parsed.data?.ui_elements ?? []
    const path = parsed.data?.screenshot_path ?? '(no path)'
    if (ui.length === 0) return `Screenshot at ${path}. No UI elements detected.`
    const top = ui.slice(0, 25).map((el) => {
      const title = el.title ?? el.value ?? ''
      return `  ${el.id ?? '?'} ${el.role ?? '?'}${title ? `: ${title}` : ''}`
    })
    return `Screenshot at ${path}. ${ui.length} elements (showing first ${top.length}):\n${top.join('\n')}`
  } catch {
    return stdout.slice(0, 4000)
  }
}

type SeeDetails = { screenshotPath?: string; elementCount: number }
type ListAppsDetails = { length: number }

// `deps.requestPermission` is unused for these read-only tools but kept so
// future click/type/scroll tools can call it without changing the signature.
export function buildPeekabooTools(_deps: Deps): AgentTool[] {
  const seeScreen: AgentTool<ReturnType<typeof Type.Object<{}>>, SeeDetails> = {
    name: 'see_screen',
    label: 'See Screen',
    description:
      'Capture the current screen and return a textual list of UI elements with their Peekaboo IDs. ' +
      'Use this before any interaction that depends on what is on screen.',
    parameters: Type.Object({
      mode: Type.Optional(
        Type.Union(
          [Type.Literal('screen'), Type.Literal('frontmost'), Type.Literal('window')],
          { description: 'Capture target. Default frontmost.' },
        ),
      ),
    }),
    execute: async (_toolCallId, params): Promise<AgentToolResult<SeeDetails>> => {
      const mode = (params as { mode?: 'screen' | 'frontmost' | 'window' }).mode ?? 'frontmost'
      const result = await runCli(['see', '--mode', mode, '--json'])
      if (!result.ok) {
        throw new Error(result.stderr.trim() || 'peekaboo see failed')
      }
      const text = summariseSeeOutput(result.stdout)
      const match = result.stdout.match(/"screenshot_path"\s*:\s*"([^"]+)"/)
      return {
        content: [{ type: 'text', text }],
        details: { screenshotPath: match?.[1], elementCount: (text.match(/ elements/) ? 1 : 0) },
      }
    },
  }

  const listApps: AgentTool<ReturnType<typeof Type.Object<{}>>, ListAppsDetails> = {
    name: 'list_apps',
    label: 'List Running Apps',
    description: 'Enumerate currently running applications and their windows.',
    parameters: Type.Object({}),
    execute: async (): Promise<AgentToolResult<ListAppsDetails>> => {
      const result = await runCli(['list', 'apps', '--json'])
      if (!result.ok) {
        throw new Error(result.stderr.trim() || 'peekaboo list failed')
      }
      const text = result.stdout.slice(0, 4000)
      return {
        content: [{ type: 'text', text }],
        details: { length: text.length },
      }
    },
  }

  return [seeScreen, listApps]
}
