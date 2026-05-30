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

type PeekabooSeePayload = {
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

type SeeDetails = {
  screenshotPath?: string
  elementCount: number
  parseError?: string
}

type SeeSummary = {
  text: string
  details: SeeDetails
}

function summariseSeeOutput(stdout: string): SeeSummary {
  let parsed: PeekabooSeePayload
  try {
    parsed = JSON.parse(stdout) as PeekabooSeePayload
  } catch (err) {
    return {
      text: stdout.slice(0, 4000),
      details: { elementCount: 0, parseError: err instanceof Error ? err.message : String(err) },
    }
  }

  if (parsed.success === false) {
    return {
      text: `peekaboo see failed: ${parsed.error?.message ?? 'unknown'}`,
      details: { elementCount: 0 },
    }
  }

  const ui = parsed.data?.ui_elements ?? []
  const path = parsed.data?.screenshot_path
  const pathLabel = path ?? '(no path)'

  if (ui.length === 0) {
    return {
      text: `Screenshot at ${pathLabel}. No UI elements detected.`,
      details: { screenshotPath: path, elementCount: 0 },
    }
  }

  const top = ui.slice(0, 25).map((el) => {
    const title = el.title ?? el.value ?? ''
    return `  ${el.id ?? '?'} ${el.role ?? '?'}${title ? `: ${title}` : ''}`
  })
  return {
    text: `Screenshot at ${pathLabel}. ${ui.length} elements (showing first ${top.length}):\n${top.join('\n')}`,
    details: { screenshotPath: path, elementCount: ui.length },
  }
}

// peekaboo fails with a permission error when macOS Screen Recording /
// Accessibility hasn't been granted. Surface an actionable hint so the agent
// (and the user reading the transcript) knows where to fix it.
const PERMISSION_RE = /screen[\s-]?record|screencapture|not authorized|accessibility|permission|tcc|cgpreflight/i

function withPermissionHint(stderr: string, fallback: string): string {
  const msg = stderr.trim() || fallback
  if (!PERMISSION_RE.test(msg)) return msg
  return `${msg}\n\nThis usually means a macOS permission is missing. Grant Screen Recording and Accessibility to SwarmAgents in System Settings → Privacy & Security (Settings → Permissions has status + shortcuts), then retry. Screen Recording changes may require relaunching the app.`
}

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
        throw new Error(withPermissionHint(result.stderr, 'peekaboo see failed'))
      }
      const { text, details } = summariseSeeOutput(result.stdout)
      return {
        content: [{ type: 'text', text }],
        details,
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
        throw new Error(withPermissionHint(result.stderr, 'peekaboo list failed'))
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
