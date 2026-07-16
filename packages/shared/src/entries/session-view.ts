import type { AgentWireEvent, ConsumedResources, EntryRow } from '@swarm/protocol'

// Pure, framework-free reducer over the wire protocol v3 event stream. Mirrors
// a single session's live state: the finalized entry log (replay cursor),
// the in-flight run's streaming assistant message, and its pending tool
// calls. No React, no pi-agent-core — desktop/web/mobile all drive their
// renderer state from this + buildSegments (segments.ts).
export type PendingTool = { toolName: string; args: unknown; partialResult?: unknown }

export type SessionView = {
  entries: EntryRow[] // finalized transcript (ordered by rowId)
  cursor: number // max rowId seen; catch-up query key
  running: boolean
  runId?: string
  streaming?: unknown // partial assistant message (message_update)
  pendingTools: Record<string, PendingTool>
  lastError?: string
  usage?: { used: ConsumedResources; contextTokens?: number; contextWindow?: number; model?: string }
  gapDetected: boolean // true => client must re-pull from cursor
}

export const emptySessionView = (): SessionView => ({
  entries: [],
  cursor: 0,
  running: false,
  pendingTools: {},
  gapDetected: false,
})

/**
 * Merges a catch-up batch of rows (initial load, or a re-pull after
 * gapDetected) into the view. Rows at or before the current cursor are
 * dropped (already-seen replay), so calling this again with overlapping rows
 * is a no-op for them — idempotent. Always clears gapDetected: this is the
 * client's answer to "re-pull from cursor".
 */
export function hydrate(view: SessionView, rows: EntryRow[]): SessionView {
  const fresh = rows.filter((r) => r.rowId > view.cursor).sort((a, b) => a.rowId - b.rowId)
  if (fresh.length === 0) return { ...view, gapDetected: false }
  return {
    ...view,
    entries: [...view.entries, ...fresh],
    cursor: fresh[fresh.length - 1].rowId,
    gapDetected: false,
  }
}

export function applyWireEvent(view: SessionView, e: AgentWireEvent): SessionView {
  switch (e.kind) {
    case 'entry_appended': {
      // The very first entry this view has ever seen anchors the cursor at
      // its rowId, even if that rowId isn't 1 (a live subscription can start
      // mid-session, before the initial hydrate() catch-up lands).
      if (view.entries.length === 0 || e.rowId === view.cursor + 1) {
        return {
          ...view,
          entries: [...view.entries, { rowId: e.rowId, entry: e.entry }],
          cursor: e.rowId,
          gapDetected: false,
        }
      }
      if (e.rowId > view.cursor + 1) return { ...view, gapDetected: true }
      // rowId <= cursor: stale/duplicate replay — ignore.
      return view
    }

    case 'agent_start':
      return { ...view, running: true, runId: e.runId }

    case 'agent_end':
      return {
        ...view,
        running: false,
        lastError: e.status === 'failed' ? (e.errorMessage ?? 'agent failed') : undefined,
        streaming: undefined,
      }

    case 'turn_end':
      return {
        ...view,
        usage: { used: e.used, contextTokens: e.contextTokens, contextWindow: e.contextWindow, model: e.model },
      }

    case 'message_update':
      return { ...view, streaming: e.message }

    case 'message_end':
      return { ...view, streaming: undefined }

    case 'tool_execution_start':
      return {
        ...view,
        pendingTools: { ...view.pendingTools, [e.toolCallId]: { toolName: e.toolName, args: e.args } },
      }

    case 'tool_execution_update': {
      const existing = view.pendingTools[e.toolCallId]
      return {
        ...view,
        pendingTools: {
          ...view.pendingTools,
          [e.toolCallId]: {
            toolName: existing?.toolName ?? e.toolName,
            args: existing?.args,
            partialResult: e.partialResult,
          },
        },
      }
    }

    case 'tool_execution_end': {
      const { [e.toolCallId]: _removed, ...rest } = view.pendingTools
      return { ...view, pendingTools: rest }
    }

    // turn_start / message_start / permission_request carry no state this
    // view tracks (yet) — pass through unchanged.
    default:
      return view
  }
}
