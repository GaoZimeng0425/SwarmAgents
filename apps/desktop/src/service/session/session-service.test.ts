import { createLogger } from '@shared/logger'
import type { ProviderInjection } from '@swarm/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock ONLY the pi Agent so continue() is fully controllable (blocking for the
// slot-pool tests, direct tool-call for delegate, forced stopReason for
// failure). uuidv7 etc. pass through untouched — session-service uses them.
const MockAgent = vi.hoisted(() => vi.fn())
vi.mock('@earendil-works/pi-agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-agent-core')>()
  return { ...actual, Agent: MockAgent }
})

import { createConversationStore } from '../conversation/store'
import { createBroadcaster } from '../ipc/broadcaster'
import { createSessionService } from './session-service'

// Per-prompt-text behavior for the mocked Agent.continue().
type Behavior = {
  block?: Promise<void>
  delegatePrompt?: string
  stopReason?: 'stop' | 'error' | 'aborted'
  onContinue?: () => void
}
const behaviors = new Map<string, Behavior>()

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const t = content.find((c) => (c as { type?: string })?.type === 'text') as { text?: string } | undefined
    return t?.text ?? ''
  }
  return ''
}

function installMockAgent(): void {
  MockAgent.mockImplementation(function (
    this: Record<string, unknown>,
    opts: { initialState: { messages: unknown[] } }
  ) {
    let listener: (e: unknown) => void = () => undefined
    const state = {
      messages: [...opts.initialState.messages],
      model: undefined,
      tools: [] as Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }>,
    }
    this.subscribe = (fn: (e: unknown) => void) => {
      listener = fn
      return () => undefined
    }
    this.abort = vi.fn()
    this.state = state
    this.continue = vi.fn(async () => {
      const msgs = state.messages as Array<{ role?: string; content?: unknown }>
      const lastUser = [...msgs].reverse().find((m) => m?.role === 'user')
      const text = textOf(lastUser?.content)
      const b = behaviors.get(text)
      b?.onContinue?.()
      if (b?.block) await b.block
      if (b?.delegatePrompt !== undefined) {
        const delegate = state.tools.find((t) => t.name === 'delegate')
        if (!delegate) throw new Error('delegate tool not resolved into agent state')
        await delegate.execute('call-1', { prompt: b.delegatePrompt })
      }
      const stopReason = b?.stopReason ?? 'stop'
      const assistant = { role: 'assistant', content: [{ type: 'text', text: `reply:${text}` }], stopReason }
      state.messages.push(assistant)
      listener({ type: 'message_end', message: assistant })
      listener({ type: 'agent_end', messages: [assistant] })
    })
  })
}

function silentLog(): void {
  const l = createLogger({ process: 'test' })
  l.level = 'silent'
}

const PROVIDER: ProviderInjection = {
  id: 'anthropic',
  registry: 'anthropic',
  apiStyle: 'anthropic',
  model: 'claude-haiku-4-5',
  apiKey: 'k',
}

type Rec = { event: string; data: unknown }

function makeService(maxConcurrent = 4) {
  const events: Rec[] = []
  const store = createConversationStore(':memory:')
  const broadcaster = createBroadcaster((event, data) => events.push({ event, data }))
  const service = createSessionService({ store, broadcaster, maxConcurrent, getProvider: () => undefined })
  return { service, store, events }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  silentLog()
  behaviors.clear()
  MockAgent.mockReset()
  installMockAgent()
})
afterEach(() => {
  behaviors.clear()
})

describe('SessionService', () => {
  it('submit creates entries and broadcasts through the broadcaster', async () => {
    const { service, events } = makeService()
    const { sessionId } = service.createSession(PROVIDER)

    const status = await new Promise<string>((resolve) => {
      service.submitPrompt(sessionId, 'hello', [], (s) => resolve(s))
    })
    expect(status).toBe('completed')

    const entries = service.getSessionEntries(sessionId)
    const messages = entries.filter((e) => e.entry.type === 'message')
    expect(messages).toHaveLength(2) // user + assistant

    const kinds = events.map((e) => e.event)
    expect(kinds).toContain('entry_appended')
    expect(kinds).toContain('agent_start')
    expect(kinds).toContain('agent_end')
  })

  it('runs two sessions under a 1-slot pool: the second queues until the first releases', async () => {
    const { service } = makeService(1)
    const a = service.createSession(PROVIDER).sessionId
    const b = service.createSession(PROVIDER).sessionId

    const continued: string[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => {
      releaseA = r
    })
    behaviors.set('A', { block: gateA, onContinue: () => continued.push('A') })
    behaviors.set('B', { onContinue: () => continued.push('B') })

    const doneA = new Promise<string>((resolve) => service.submitPrompt(a, 'A', [], (s) => resolve(s)))
    const doneB = new Promise<string>((resolve) => service.submitPrompt(b, 'B', [], (s) => resolve(s)))

    await tick()
    // A holds the only slot (its continue is blocked); B is still queued.
    expect(continued).toEqual(['A'])

    releaseA()
    expect(await doneA).toBe('completed')
    expect(await doneB).toBe('completed')
    expect(continued).toEqual(['A', 'B'])
  })

  it('cancelRun while a run waits for a slot settles it cancelled without calling continue', async () => {
    const { service } = makeService(1)
    const a = service.createSession(PROVIDER).sessionId
    const b = service.createSession(PROVIDER).sessionId

    let releaseA!: () => void
    const gateA = new Promise<void>((r) => {
      releaseA = r
    })
    let bContinued = false
    behaviors.set('A', { block: gateA })
    behaviors.set('B', { onContinue: () => (bContinued = true) })

    const doneA = new Promise<string>((resolve) => service.submitPrompt(a, 'A', [], (s) => resolve(s)))
    const doneB = new Promise<string>((resolve) => service.submitPrompt(b, 'B', [], (s) => resolve(s)))

    await tick()
    service.cancelRun(b)
    expect(await doneB).toBe('cancelled')
    expect(bContinued).toBe(false)

    releaseA()
    expect(await doneA).toBe('completed')
  })

  it('delegate creates a hidden child session; the parent gains delegation + delegation_result entries', async () => {
    const { service } = makeService()
    const parent = service.createSession(PROVIDER).sessionId

    behaviors.set('parent', { delegatePrompt: 'child' })
    behaviors.set('child', { stopReason: 'error' }) // the child run fails

    const status = await new Promise<string>((resolve) => service.submitPrompt(parent, 'parent', [], (s) => resolve(s)))
    expect(status).toBe('completed')

    const entries = service.getSessionEntries(parent)
    const delegation = entries.find((e) => e.entry.type === 'custom' && e.entry.customType === 'delegation')
    const result = entries.find((e) => e.entry.type === 'custom' && e.entry.customType === 'delegation_result')
    expect(delegation).toBeTruthy()
    if (!result) throw new Error('delegation_result entry missing')

    const resultData = (result.entry as { data: { childSessionId: string; status: string } }).data
    const childSessionId = resultData.childSessionId
    expect(resultData.status).toBe('failed')

    // The child session is hidden from listSessions but its entries exist.
    const listed = service.listSessions().map((s) => s.id)
    expect(listed).toContain(parent)
    expect(listed).not.toContain(childSessionId)
    expect(service.getSessionEntries(childSessionId).length).toBeGreaterThan(0)

    // The child's live in-memory state is freed once the delegate completes
    // (no leak under fan-out); only the parent's session stays live.
    const live = service.liveSessionIds()
    expect(live).toContain(parent)
    expect(live).not.toContain(childSessionId)
  })

  it('forkSession copies the source entries up to the given row', async () => {
    const { service } = makeService()
    const source = service.createSession(PROVIDER).sessionId
    await new Promise<string>((resolve) => service.submitPrompt(source, 'hello', [], (s) => resolve(s)))

    const sourceEntries = service.getSessionEntries(source)
    const upToRowId = sourceEntries[sourceEntries.length - 1].rowId

    const { sessionId: forked } = service.forkSession(source, upToRowId)
    const forkedEntries = service.getSessionEntries(forked)
    expect(forkedEntries).toHaveLength(sourceEntries.length)
    expect(forkedEntries.map((e) => e.entry.type)).toEqual(sourceEntries.map((e) => e.entry.type))
  })
})
