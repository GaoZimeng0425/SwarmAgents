// src/service/calendar/tools.ts
//
// calendar.* built-in tools. Reads (list_upcoming, get_event) are low risk;
// local mutations (create/update/delete_local) are medium. Google is never
// written. Each tool is a thin client over the local cache via the
// service->main rpc.
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { MainMethod } from '@swarm/protocol'

import type { ToolSpec } from '../tools/registry'

type CallMainFn = (method: MainMethod, args: unknown[]) => Promise<unknown>

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

type EventLike = {
  title?: string
  startMs?: number
  endMs?: number
  location?: string | null
  source?: string
  allDay?: boolean
}

function renderEvent(e: EventLike): string {
  const when = e.allDay ? '(all day)' : `${fmtTime(e.startMs ?? 0)} -> ${fmtTime(e.endMs ?? 0)}`
  return `• [${e.source ?? ''}] ${e.title ?? '(untitled)'}\n  ${when}${e.location ? ` @ ${e.location}` : ''}`
}

const ListParams = Type.Object({
  days: Type.Optional(Type.Number({ description: 'Forward window in days (default 14).' })),
})
const GetParams = Type.Object({ id: Type.String({ description: 'Event id.' }) })
const CreateParams = Type.Object({
  title: Type.String({ description: 'Event title.' }),
  startMs: Type.Number({ description: 'Start, epoch ms.' }),
  endMs: Type.Number({ description: 'End, epoch ms.' }),
  allDay: Type.Optional(Type.Boolean({ description: 'All-day flag.' })),
  description: Type.Optional(Type.String({ description: 'Optional description.' })),
  location: Type.Optional(Type.String({ description: 'Optional location.' })),
})
const UpdateParams = Type.Object({
  id: Type.String({ description: 'Local event id.' }),
  title: Type.Optional(Type.String()),
  startMs: Type.Optional(Type.Number()),
  endMs: Type.Optional(Type.Number()),
  allDay: Type.Optional(Type.Boolean()),
  description: Type.Optional(Type.String()),
  location: Type.Optional(Type.String()),
})
const DeleteParams = Type.Object({ id: Type.String({ description: 'Local event id.' }) })

export function calendarSpecs(callMain: CallMainFn): ToolSpec[] {
  const listUpcoming: ToolSpec = {
    group: 'calendar',
    name: 'list_upcoming',
    risk: 'low',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'list_upcoming',
      label: 'List upcoming calendar',
      description:
        'List upcoming calendar events (Google + local) within a forward window (default 14 days). Returns title, time, location, source.',
      parameters: ListParams,
      execute: async (_id, params) => {
        const p = (params as { days?: number }) ?? {}
        try {
          const rows = (await callMain('calendar.list_upcoming', [p.days ?? 14])) as EventLike[]
          if (rows.length === 0) return ok('(no upcoming events)', { count: 0 })
          return ok(rows.map((r) => renderEvent(r)).join('\n'), { count: rows.length })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }

  const getEvent: ToolSpec = {
    group: 'calendar',
    name: 'get_event',
    risk: 'low',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'get_event',
      label: 'Get calendar event',
      description: 'Return a single calendar event by id (from either Google cache or local).',
      parameters: GetParams,
      execute: async (_id, params) => {
        const id = ((params as { id?: string })?.id ?? '').trim()
        if (!id) return err('missing id')
        try {
          const e = (await callMain('calendar.get_event', [id])) as EventLike | null
          if (!e) return ok('(event not found)', { id })
          return ok(renderEvent(e), { id })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }

  const createLocal: ToolSpec = {
    group: 'calendar',
    name: 'create_local',
    risk: 'medium',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'create_local',
      label: 'Create local calendar event',
      description:
        'Create an event on the app-local calendar (not Google). Use for reminders/schedules the agent owns.',
      parameters: CreateParams,
      execute: async (_id, params) => {
        const p = (params as {
          title?: string
          startMs?: number
          endMs?: number
          allDay?: boolean
          description?: string | null
          location?: string | null
        }) ?? { title: '' }
        if (!p.title || p.startMs == null || p.endMs == null) return err('title, startMs, endMs required')
        const input = {
          title: p.title,
          startMs: p.startMs,
          endMs: p.endMs,
          allDay: p.allDay,
          description: p.description,
          location: p.location,
        }
        try {
          const e = (await callMain('calendar.create_local', [input])) as { id?: string }
          return ok(`created local event (${e.id ?? '?'})`, { id: e.id })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }

  const updateLocal: ToolSpec = {
    group: 'calendar',
    name: 'update_local',
    risk: 'medium',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'update_local',
      label: 'Update local calendar event',
      description: 'Update fields of a local calendar event by id (Google events cannot be edited from here).',
      parameters: UpdateParams,
      execute: async (_id, params) => {
        const p = (params as { id?: string } & Record<string, unknown>) ?? { id: '' }
        const id = (p.id ?? '').toString()
        if (!id) return err('missing id')
        const { id: _omit, ...patch } = p
        try {
          const e = (await callMain('calendar.update_local', [id, patch])) as { id?: string } | null
          if (!e) return ok('(local event not found)', { id })
          return ok(`updated local event (${e.id})`, { id: e.id })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }

  const deleteLocal: ToolSpec = {
    group: 'calendar',
    name: 'delete_local',
    risk: 'medium',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'delete_local',
      label: 'Delete local calendar event',
      description: 'Delete a local calendar event by id (Google events cannot be deleted from here).',
      parameters: DeleteParams,
      execute: async (_id, params) => {
        const id = ((params as { id?: string })?.id ?? '').trim()
        if (!id) return err('missing id')
        try {
          const removed = (await callMain('calendar.delete_local', [id])) as boolean
          return ok(removed ? `deleted local event ${id}` : `(not found: ${id})`, { id, removed })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }

  return [listUpcoming, getEvent, createLocal, updateLocal, deleteLocal]
}
