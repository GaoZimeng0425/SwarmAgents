import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { ulid } from 'ulid'

import type { CCEvent, CCObservation, ClaudeCodeManager } from '../claude-code/manager'
import type { ToolRunContext, ToolSpec } from './registry'

const GROUP = 'claude-code'

function renderEvent(e: CCEvent): string {
  switch (e.kind) {
    case 'system':
      return `[system] ${e.text}`
    case 'thinking':
      return `[thinking] ${e.text}`
    case 'text':
      return e.text
    case 'tool_use':
      return `[tool] ${e.tool}`
    case 'approval':
      return `[approval-requested] ${e.tool} (requestId: ${e.requestId})`
    case 'result':
      return e.isError ? `[result:error] ${e.text}` : `[result] ${e.text}`
    case 'error':
      return `[error] ${e.text}`
  }
}

// Turn an observation into the text the operating agent reads. Status first so
// the agent knows whether to send more, wait (observe), approve, or stop.
function render(obs: CCObservation): string {
  const lines = [`session ${obs.ccSessionId} · status: ${obs.status}`]
  if (obs.error) lines.push(`error: ${obs.error}`)
  if (obs.events.length === 0) lines.push('(no new events)')
  else for (const e of obs.events) lines.push(renderEvent(e))
  if (obs.pendingApproval) {
    const pa = obs.pendingApproval
    lines.push(
      `awaiting approval — tool "${pa.toolName}" (requestId: ${pa.requestId}). Call cc_approve with this requestId to allow or deny.`
    )
  }
  if (obs.usage) lines.push(`usage: in=${obs.usage.inputTokens} out=${obs.usage.outputTokens}`)
  return lines.join('\n')
}

// Charge a turn-advancing call's incremental Claude Code cost to the task budget.
function chargeUsage(ctx: ToolRunContext, obs: CCObservation): void {
  if (obs.costDeltaUsd && obs.costDeltaUsd > 0) {
    ctx.reportExternalUsage?.({
      costUsd: obs.costDeltaUsd,
      inputTokens: obs.usage?.inputTokens,
      outputTokens: obs.usage?.outputTokens,
    })
  }
}

const StartParams = Type.Object({
  prompt: Type.String({ description: 'The initial instruction for the Claude Code session.' }),
  cwd: Type.Optional(
    Type.String({ description: 'Working directory for the session. Defaults to the task working directory.' })
  ),
  model: Type.Optional(Type.String({ description: 'Model alias for Claude Code, e.g. "sonnet" | "opus" | "haiku".' })),
  mode: Type.Optional(
    Type.Union([Type.Literal('default'), Type.Literal('acceptEdits'), Type.Literal('bypassPermissions')], {
      description:
        'Permission mode. "default" surfaces each consequential tool call as an approval you resolve with cc_approve; "acceptEdits"/"bypassPermissions" run autonomously. Defaults to "default".',
    })
  ),
  resume: Type.Optional(
    Type.String({ description: 'Resume a prior Claude Code session by its sdkSessionId (from a previous run).' })
  ),
})

function startSpec(manager: ClaudeCodeManager): ToolSpec {
  return {
    group: GROUP,
    name: 'cc_start',
    risk: 'high',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'cc_start',
      label: 'Start Claude Code session',
      description:
        'Launch a Claude Code session you can steer. Returns a session handle and the first events. Use cc_send to give follow-up instructions, cc_observe to check progress, cc_approve to allow/deny a tool it requests, cc_interrupt to stop the current turn, and cc_stop to end the session.',
      parameters: StartParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as {
          prompt: string
          cwd?: string
          model?: string
          mode?: 'default' | 'acceptEdits' | 'bypassPermissions'
          resume?: string
        }
        const ccSessionId = ulid()
        const obs = await manager.start({
          ccSessionId,
          cwd: p.cwd ?? ctx.cwd,
          model: p.model,
          prompt: p.prompt,
          mode: p.mode,
          resume: p.resume,
        })
        chargeUsage(ctx, obs)
        return { content: [{ type: 'text', text: render(obs) }], details: { handle: ccSessionId, status: obs.status } }
      },
    }),
  }
}

const HandleParams = Type.Object({
  handle: Type.String({ description: 'The session handle returned by cc_start.' }),
})

const SendParams = Type.Object({
  handle: Type.String({ description: 'The session handle returned by cc_start.' }),
  message: Type.String({ description: 'A follow-up instruction or correction to steer the session.' }),
})

function sendSpec(manager: ClaudeCodeManager): ToolSpec {
  return {
    group: GROUP,
    name: 'cc_send',
    risk: 'medium',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'cc_send',
      label: 'Send to Claude Code',
      description:
        'Send a follow-up instruction into a running Claude Code session to steer or correct it. Returns the events produced up to the next pause.',
      parameters: SendParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { handle: string; message: string }
        const obs = await manager.send(p.handle, p.message)
        chargeUsage(ctx, obs)
        return { content: [{ type: 'text', text: render(obs) }], details: { status: obs.status } }
      },
    }),
  }
}

const ApproveParams = Type.Object({
  handle: Type.String({ description: 'The session handle returned by cc_start.' }),
  requestId: Type.String({ description: 'The requestId from the pending approval (see status needs_approval).' }),
  decision: Type.Union([Type.Literal('allow'), Type.Literal('deny')], {
    description: 'Allow the requested tool call to proceed, or deny it.',
  }),
})

function approveSpec(manager: ClaudeCodeManager): ToolSpec {
  return {
    group: GROUP,
    name: 'cc_approve',
    risk: 'high',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'cc_approve',
      label: 'Approve Claude Code tool',
      description:
        'Allow or deny a tool call Claude Code requested (when status is needs_approval). Resolves the pending request and returns the events up to the next pause.',
      parameters: ApproveParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { handle: string; requestId: string; decision: 'allow' | 'deny' }
        const obs = await manager.approve(p.handle, p.requestId, p.decision)
        chargeUsage(ctx, obs)
        return { content: [{ type: 'text', text: render(obs) }], details: { status: obs.status } }
      },
    }),
  }
}

function observeSpec(manager: ClaudeCodeManager): ToolSpec {
  return {
    group: GROUP,
    name: 'cc_observe',
    risk: 'low',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'cc_observe',
      label: 'Observe Claude Code',
      description:
        'Read the latest events from a Claude Code session without sending anything. Use to check what it is doing while a turn runs.',
      parameters: HandleParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { handle: string }
        const obs = manager.observe(p.handle)
        return { content: [{ type: 'text', text: render(obs) }], details: { status: obs.status } }
      },
    }),
  }
}

function interruptSpec(manager: ClaudeCodeManager): ToolSpec {
  return {
    group: GROUP,
    name: 'cc_interrupt',
    risk: 'low',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'cc_interrupt',
      label: 'Interrupt Claude Code',
      description:
        'Interrupt the current Claude Code turn (e.g. it went the wrong way). The session stays open for cc_send.',
      parameters: HandleParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { handle: string }
        const obs = await manager.interrupt(p.handle)
        chargeUsage(ctx, obs)
        return { content: [{ type: 'text', text: render(obs) }], details: { status: obs.status } }
      },
    }),
  }
}

function stopSpec(manager: ClaudeCodeManager): ToolSpec {
  return {
    group: GROUP,
    name: 'cc_stop',
    risk: 'low',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'cc_stop',
      label: 'Stop Claude Code session',
      description: 'End a Claude Code session and release its process. The handle is no longer usable afterward.',
      parameters: HandleParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { handle: string }
        const obs = manager.stop(p.handle)
        return { content: [{ type: 'text', text: render(obs) }], details: { status: obs.status } }
      },
    }),
  }
}

export function claudeCodeSpecs(manager: ClaudeCodeManager): ToolSpec[] {
  return [
    startSpec(manager),
    sendSpec(manager),
    observeSpec(manager),
    approveSpec(manager),
    interruptSpec(manager),
    stopSpec(manager),
  ]
}
