import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { ToolRunContext, ToolSpec } from './registry'

const MAX_OUTPUT = 16_000
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000

// Catastrophic-destruction patterns. NOT a security boundary — trivially
// bypassable; it exists to catch obvious disasters and escalate them to the
// permission prompt (the prompt is the real protection).
function isDangerousRm(cmd: string): boolean {
  if (!/\brm\b/i.test(cmd)) return false
  const recursive = /-\w*r/i.test(cmd)
  const force = /-\w*f/i.test(cmd)
  // a whitespace-preceded token that begins with '/', '~', or is '*'
  const dangerTarget = /\s(\/\S*|~\S*|\*)(\s|$)/.test(cmd)
  return recursive && force && dangerTarget
}

const DANGEROUS_PATTERNS: RegExp[] = [
  /--no-preserve-root/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&?\s*\}\s*;\s*:/,
  /\bmkfs\b/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  />\s*\/dev\/(sd|disk|nvme|hd)\w*/i,
  /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|dash)\b/i,
  /\bsudo\b/i,
  /\bchmod\b\s+(-R\s+)?0?777\s+\//i,
]

export function isDangerousCommand(command: string): boolean {
  return isDangerousRm(command) || DANGEROUS_PATTERNS.some((re) => re.test(command))
}

type ShellResult = { stdout: string; stderr: string; code: number | null; timedOut: boolean; spawnError?: string }

function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    const proc = spawn('/bin/sh', ['-c', command], { cwd, env: process.env })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)
    proc.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8')
    })
    proc.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
    })
    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code: null, timedOut, spawnError: err.message })
    })
    // 'close' (not 'exit') ensures all buffered stdout/stderr has arrived; a
    // spawn error fires both 'error' and 'close', so the settled guard avoids a double-resolve.
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code, timedOut })
    })
  })
}

const ShellParams = Type.Object({
  command: Type.String({ description: 'The shell command to run via /bin/sh -c.' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory. Defaults to the task working directory.' })),
  timeoutMs: Type.Optional(Type.Number({ description: 'Timeout in milliseconds (default 30000, max 120000).' })),
})

export function shellSpec(): ToolSpec {
  return {
    group: 'shell',
    name: 'run_shell',
    risk: 'low',
    riskFor: (args) => (isDangerousCommand((args as { command?: string }).command ?? '') ? 'high' : 'low'),
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'run_shell',
      label: 'Run shell command',
      description:
        'Run a shell command via /bin/sh -c and return its combined stdout/stderr and exit code. Use for filesystem, system, and information queries (e.g. `ls ~/Desktop`, `cat file`, `git status`).',
      parameters: ShellParams,
      execute: async (_toolCallId: string, params: unknown) => {
        const p = params as { command: string; cwd?: string; timeoutMs?: number }
        const cwd = p.cwd ?? ctx.cwd ?? homedir()
        const timeoutMs = Math.min(p.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
        const r = await runShell(p.command, cwd, timeoutMs)

        const combined = r.stdout + (r.stderr ? `${r.stdout ? '\n' : ''}${r.stderr}` : '')
        const truncated = combined.length > MAX_OUTPUT
        const body = truncated ? `${combined.slice(0, MAX_OUTPUT)}\n…[output truncated]` : combined
        const statusLine = r.spawnError
          ? `[spawn error: ${r.spawnError}]`
          : r.timedOut
            ? `[timed out after ${timeoutMs}ms]`
            : `[exit ${r.code}]`
        const text = `$ ${p.command}   (cwd: ${cwd})\n${statusLine}\n${body}`.trimEnd()
        return {
          content: [{ type: 'text', text }],
          details: { exitCode: r.code, timedOut: r.timedOut, cwd, truncated },
        }
      },
    }),
  }
}
