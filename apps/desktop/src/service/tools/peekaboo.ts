import { spawn } from 'node:child_process'

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { Outbound } from '@swarm/protocol'
import type { PermissionDecision } from '@swarm/protocol'

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

// --- Interaction verbs -----------------------------------------------------
// Pure argv builders: param → peekaboo CLI args. Kept separate from the tool
// wiring so the mapping/validation is unit-testable without spawning the binary.

export function clickArgs(p: { id?: string; coords?: string; query?: string; double?: boolean; right?: boolean }): string[] {
  const args = ['click']
  if (p.id) args.push('--on', p.id)
  else if (p.coords) args.push('--coords', p.coords)
  else if (p.query) args.push(p.query)
  else throw new Error('click requires one of: id, coords, or query')
  if (p.double) args.push('--double')
  if (p.right) args.push('--right')
  return args
}

export function typeArgs(p: { text: string; clear?: boolean; pressReturn?: boolean }): string[] {
  if (!p.text) throw new Error('type requires non-empty text')
  const args = ['type', p.text]
  if (p.clear) args.push('--clear')
  if (p.pressReturn) args.push('--return')
  return args
}

const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const
export function scrollArgs(p: { direction: (typeof SCROLL_DIRECTIONS)[number]; amount?: number; id?: string }): string[] {
  if (!SCROLL_DIRECTIONS.includes(p.direction)) throw new Error(`invalid scroll direction: ${p.direction}`)
  const args = ['scroll', '--direction', p.direction, '--amount', String(p.amount ?? 3)]
  if (p.id) args.push('--on', p.id)
  return args
}

export function hotkeyArgs(p: { keys: string }): string[] {
  if (!p.keys) throw new Error('hotkey requires keys, e.g. "cmd,c"')
  return ['hotkey', '--keys', p.keys]
}

type ActionDetails = { verb: string; args: string[] }

async function runAction(args: string[]): Promise<AgentToolResult<ActionDetails>> {
  const result = await runCli(args)
  if (!result.ok) throw new Error(withPermissionHint(result.stderr, `peekaboo ${args[0]} failed`))
  const text = result.stdout.trim() || `${args[0]} ok`
  return { content: [{ type: 'text', text }], details: { verb: args[0], args } }
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

  const click: AgentTool<ReturnType<typeof Type.Object>, ActionDetails> = {
    name: 'click',
    label: 'Click',
    description:
      'Click a UI element or coordinates. Prefer `id` (a Peekaboo element ID from see_screen, e.g. "B1"); ' +
      'or pass `coords` ("x,y") or a text `query`. Call see_screen first to obtain element IDs.',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: 'Element ID from see_screen, e.g. "B1".' })),
      coords: Type.Optional(Type.String({ description: 'Click at "x,y".' })),
      query: Type.Optional(Type.String({ description: 'Element text to match.' })),
      double: Type.Optional(Type.Boolean({ description: 'Double-click instead of single.' })),
      right: Type.Optional(Type.Boolean({ description: 'Right-click (secondary click).' })),
    }),
    execute: async (_id, params) => runAction(clickArgs(params as Parameters<typeof clickArgs>[0])),
  }

  const type: AgentTool<ReturnType<typeof Type.Object>, ActionDetails> = {
    name: 'type',
    label: 'Type Text',
    description: 'Type text into the focused element. Optionally clear the field first or press return afterwards.',
    parameters: Type.Object({
      text: Type.String({ description: 'The text to type.' }),
      clear: Type.Optional(Type.Boolean({ description: 'Clear the field (Cmd+A, Delete) before typing.' })),
      pressReturn: Type.Optional(Type.Boolean({ description: 'Press return/enter after typing.' })),
    }),
    execute: async (_id, params) => runAction(typeArgs(params as Parameters<typeof typeArgs>[0])),
  }

  const scroll: AgentTool<ReturnType<typeof Type.Object>, ActionDetails> = {
    name: 'scroll',
    label: 'Scroll',
    description: 'Scroll the mouse wheel in a direction by a number of ticks, optionally over a specific element.',
    parameters: Type.Object({
      direction: Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')], {
        description: 'Scroll direction.',
      }),
      amount: Type.Optional(Type.Number({ description: 'Number of scroll ticks (default 3).' })),
      id: Type.Optional(Type.String({ description: 'Element ID to scroll over (from see_screen).' })),
    }),
    execute: async (_id, params) => runAction(scrollArgs(params as Parameters<typeof scrollArgs>[0])),
  }

  const hotkey: AgentTool<ReturnType<typeof Type.Object>, ActionDetails> = {
    name: 'hotkey',
    label: 'Press Hotkey',
    description: 'Press a keyboard shortcut, e.g. "cmd,c" to copy or "cmd,shift,t". Modifiers: cmd, shift, alt, ctrl, fn.',
    parameters: Type.Object({
      keys: Type.String({ description: 'Comma/plus/space-separated keys, e.g. "cmd,c".' }),
    }),
    execute: async (_id, params) => runAction(hotkeyArgs(params as Parameters<typeof hotkeyArgs>[0])),
  }

  return [seeScreen, listApps, click, type, scroll, hotkey]
}
