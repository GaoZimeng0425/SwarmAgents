// src/service/e2e/delegate-tree.e2e.test.ts
//
// End-to-end guard for the `delegate` tool itself, over the REAL SessionService
// + launch + engine + a real (non-stubbed) ToolRegistry carrying the REAL
// delegate tool (delegateSpec, unmodified). Unlike multi-level-verify.e2e.test.ts
// (which drives ctx.spawnChild directly), the mocked pi Agent here calls the
// actual AgentTool it was handed via initialState.tools — so delegate.ts's
// `[failed] ` prefix logic and details.status run for real, not simulated.
//
// Scenario: a CEO-def run delegates to two agentTypes CONCURRENTLY (Promise.all
// of two `delegate` tool calls) — this is what exercises launch.ts's slot-yield
// path (withSlotReleased): the CEO gives up its own pool slot before either
// child starts, so both children can run within maxConcurrent: 2 without the
// CEO holding a third slot hostage. One child (child-fail) scripts a give-up
// failure (stopReason 'error' with a permanent-looking message, per
// retry.ts's isPermanentModelFailure — see the Style-B mock in engine.test.ts
// for the failure event shape); the other (child-ok) completes normally.

import type { AgentDefinition, ProviderInjection } from '@swarm/protocol'
import { terminalStatusForMessageEvent } from '@swarm/protocol'
import { describe, expect, it, vi } from 'vitest'

const MockAgent = vi.hoisted(() => vi.fn())
vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: MockAgent }))

import { createConversationStore } from '../conversation/store'
import { createSessionService } from '../session/session-service'
import { delegateSpec } from '../tools/delegate'
import { createToolRegistry } from '../tools/registry'

// Marker text embedded in each fixture agent's systemPrompt. The mocked Agent
// picks its behavior off this marker (present verbatim in the composed
// systemPrompt handed to `new Agent(...)`), NOT off call order — the CEO
// delegates to both children concurrently, so which child's `new Agent(...)`
// runs first is not deterministic.
const CEO_MARK = 'CEO_MARK_DELEGATE_TREE'
const CHILD_OK_MARK = 'CHILD_OK_MARK_DELEGATE_TREE'
const CHILD_FAIL_MARK = 'CHILD_FAIL_MARK_DELEGATE_TREE'

const fixtureAgent = (id: string, marker: string): AgentDefinition => ({
  id,
  name: id,
  description: id,
  systemPrompt: marker,
  toolScope: 'all',
  maxIterations: 10,
})

const CEO_DEF = fixtureAgent('ceo-test', CEO_MARK)
const CHILD_OK_DEF = fixtureAgent('child-ok-test', CHILD_OK_MARK)
const CHILD_FAIL_DEF = fixtureAgent('child-fail-test', CHILD_FAIL_MARK)

const roleStore = {
  get: (id: string) => [CEO_DEF, CHILD_OK_DEF, CHILD_FAIL_DEF].find((a) => a.id === id),
  list: () => [CEO_DEF, CHILD_OK_DEF, CHILD_FAIL_DEF],
}

const fakeProvider = { id: 'p', model: 'test', apiStyle: 'anthropic', apiKey: 'k' } as unknown as ProviderInjection

type ToolExecResult = { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }
type MockTool = { name: string; execute: (id: string, params: unknown) => Promise<ToolExecResult> }

function findDelegateTool(tools: unknown): MockTool {
  const found = (tools as MockTool[] | undefined)?.find((t) => t.name === 'delegate')
  if (!found) throw new Error('delegate tool not resolved for this run')
  return found
}

// Captures the two `delegate` tool results the CEO's mocked turn produces, so
// the test can assert on the REAL tool-facing shape (prefix + details.status)
// without re-deriving it.
function installAgent(onDelegateResults: (ok: ToolExecResult, fail: ToolExecResult) => void): void {
  MockAgent.mockImplementation(function (
    this: Record<string, unknown>,
    opts: { initialState?: { messages?: unknown[]; systemPrompt?: string; tools?: unknown } }
  ) {
    const systemPrompt = opts.initialState?.systemPrompt ?? ''
    const tools = opts.initialState?.tools
    let sub: ((e: unknown) => void) | null = null
    this.state = { messages: [...((opts.initialState?.messages as unknown[]) ?? [])] }
    this.subscribe = (fn: (e: unknown) => void): void => {
      sub = fn
    }
    this.abort = (): void => undefined
    this.prompt = async (prompt: string): Promise<void> => {
      const msgs = (this.state as { messages: Array<Record<string, unknown>> }).messages
      msgs.push({ role: 'user', content: prompt })

      if (systemPrompt.includes(CEO_MARK)) {
        // Concurrent delegation: both spawnChild calls fire before either is
        // awaited, so the CEO's pool slot is released exactly once
        // (launch.ts's yieldDepth counting) while both children run.
        const delegate = findDelegateTool(tools)
        const [okResult, failResult] = await Promise.all([
          delegate.execute('call-ok', { prompt: 'do the ok child work', agentType: 'child-ok-test' }),
          delegate.execute('call-fail', { prompt: 'do the failing child work', agentType: 'child-fail-test' }),
        ])
        onDelegateResults(okResult, failResult)
        const ok = { role: 'assistant', content: [{ type: 'text', text: 'delegated both' }], stopReason: 'end_turn' }
        msgs.push(ok)
        sub?.({ type: 'turn_end', message: { usage: undefined } })
        sub?.({ type: 'agent_end', messages: [ok] })
        return
      }

      if (systemPrompt.includes(CHILD_FAIL_MARK)) {
        // Give-up: an assistant message with stopReason 'error' whose message
        // matches retry.ts's isPermanentModelFailure, so decideNextAttempt
        // returns 'give-up' on the first attempt (no retry delay burned here).
        const failure = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'invalid api key' }
        msgs.push(failure)
        sub?.({ type: 'agent_end', messages: [failure] })
        return
      }

      // CHILD_OK_MARK (and any other run): a normal completion.
      const ok = { role: 'assistant', content: [{ type: 'text', text: 'child done' }], stopReason: 'end_turn' }
      msgs.push(ok)
      sub?.({ type: 'turn_end', message: { usage: undefined } })
      sub?.({ type: 'agent_end', messages: [ok] })
    }
  })
}

// A real ToolRegistry carrying the REAL delegate tool only — every other
// builtin tool is irrelevant to this scenario and would only add unrelated
// setup surface (peekaboo/fs/shell/etc).
function realDelegateRegistry() {
  const registry = createToolRegistry()
  registry.register(delegateSpec())
  return registry
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('delegate tree — CEO delegates two children over the real delegate tool', () => {
  it('parentMessageId linkage, [failed] surfacing, slot sanity under maxConcurrent 2, all-run.* replay to terminal', async () => {
    const results: { ok?: ToolExecResult; fail?: ToolExecResult } = {}
    installAgent((ok, fail) => {
      results.ok = ok
      results.fail = fail
    })
    const store = createConversationStore(':memory:')
    const service = createSessionService({
      store,
      broadcaster: { broadcast: () => {} },
      maxConcurrent: 2,
      getProvider: () => fakeProvider,
      agentStore: roleStore as never,
      toolRegistry: realDelegateRegistry(),
    })
    const { sessionId } = service.createSession(fakeProvider)

    const ceo = await service.runWork(sessionId, 'ship it', { agentType: 'ceo-test' })
    await flush()

    expect(ceo.status).toBe('completed')
    expect(results.ok).toBeDefined()
    expect(results.fail).toBeDefined()

    const okRunId = results.ok!.details!.messageId as string
    const failRunId = results.fail!.details!.messageId as string

    // (b) the parent's tool result for the failed child carries the [failed]
    // prefix and details.status 'failed'; the ok child carries neither.
    const failText = results.fail!.content[0]
    expect(failText.type === 'text' && failText.text?.startsWith('[failed] ')).toBe(true)
    expect(results.fail!.details).toMatchObject({ status: 'failed' })
    const okText = results.ok!.content[0]
    expect(okText.type === 'text' && okText.text?.startsWith('[')).toBe(false)
    expect(results.ok!.details).toMatchObject({ status: 'completed' })

    const allEvents = store.getMessageEvents(sessionId)

    // (d) every persisted event kind starts with `run.` — no task.* leakage.
    for (const row of allEvents) {
      expect((row.event as { kind: string }).kind.startsWith('run.')).toBe(true)
    }

    // (a) both children's run.created carry parentMessageId = the CEO's messageId.
    const createdOf = (messageId: string) =>
      allEvents.find((r) => r.messageId === messageId && r.event.kind === 'message.created')
    expect(createdOf(okRunId)?.parentMessageId).toBe(ceo.messageId)
    expect(createdOf(failRunId)?.parentMessageId).toBe(ceo.messageId)

    // (c) slot sanity: with maxConcurrent 2 the tree above (1 parent + 2
    // children) completed at all — the CEO awaited above, so if the parent's
    // slot-yield (withSlotReleased) were broken, this call would have hung
    // instead of resolving.

    // (d) replay via getMessageEvents reaches a terminal for all three runs, and
    // the terminal statuses match what the tool result reported.
    const terminalStatusOf = (messageId: string): string | undefined => {
      for (const row of allEvents) {
        if (row.messageId !== messageId) continue
        const status = terminalStatusForMessageEvent(row.event as { kind: string; error?: unknown })
        if (status) return status
      }
      return undefined
    }
    expect(terminalStatusOf(ceo.messageId)).toBe('completed')
    expect(terminalStatusOf(okRunId)).toBe('completed')
    expect(terminalStatusOf(failRunId)).toBe('failed')

    store.close()
  })
})
