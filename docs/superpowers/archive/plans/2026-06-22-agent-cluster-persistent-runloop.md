# Agent 集群:常驻虚拟 actor(计划 B)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把计划 A 的「每消息一次性激活」升级为常驻虚拟 actor + 收件箱循环:actor 收到消息后常驻、循环 drain 收件箱、空闲超时休眠;并发槽收窄到「单次 LLM turn」并在等待 rpc 回信时让出,从根上消除死锁;rpc 回信经 `correlationId` 路由;启动时重放未消费消息修复崩溃孤儿。

**Architecture:** 抽出 `buildAgentSession`(复用 pi `Agent` 实例,上下文跨消息累积)+ 新增 `runResident(mailbox)`;新增纯内存 `actor-mailbox.ts` 与仿 `permission-registry.ts` 的 `reply-registry.ts`;session-manager 把 `runHandles` 升级为按 address、`acquireSlot` 收窄到 turn 粒度、`send` 接 mailbox+拉起常驻循环、`send_and_wait` 等信时让出/重获槽、启动扫描重放。**一次常驻期 = 一个 Task + 一个 agent**,多条消息是该 Task 下的 turn。

**Tech Stack:** TypeScript / Electron service 进程;`@earendil-works/pi-agent-core`(`Agent`);`better-sqlite3`;Vitest(经 Electron node);`pino`;`ulid`。

## Global Constraints

- **语言**:代码注释与 commit message 一律英文;不写日文。
- **日志**(CLAUDE.md §5):每个业务路径 `pino` 结构化日志;每个 `catch` 至少 `error`、绝不静默;入口 `info`、异常分支 `warn`。新模块用 `createLogger({ process: 'service' }).child({ component: '<module>' })`。
- **测试运行**:`npm test -- <path>`(经 Electron node);**禁止** `pnpm rebuild better-sqlite3`(误装后 `npm run postinstall` 恢复);不用裸 `npx vitest`。
- **typecheck 盲区**:`src/service/**` 不在 tsconfig typecheck 范围,靠 vitest 兜类型;`src/shared/types/**` 在范围内,改它要干净。
- **格式化**:scoped 用 `npx biome check --write <file>`(勿 `pnpm check`/`format`)。
- **代码风格**:外科手术式,匹配现有 factory+closure 风格;不顺手重构无关代码。
- **id 生成**:`ulid()`;时间戳 `Date.now()`(service 代码允许)。
- **worktree**(CLAUDE.md §6):本计划在专用 git worktree 的独立分支(基于 `develop`)实现。
- **承重不变量**:一次性 `run()` / 顶层 `submitGoal` / 旧式 `spawnChild` 行为**零回归**;常驻 actor = 一个 Task + 一个 agent。
- **死锁回归测试是验收核心**(Task 8):新并发模型必须在 `maxConcurrent=1` 下让互发 rpc 不死锁。

---

## File Structure

- **新增** `src/service/actor-mailbox.ts` —— `createMailbox()`:内存队列,`deliver(msg)` / `receive({ idleMs }): Promise<ActorMessage>`(空队列挂起;超时 reject `IdleTimeoutError`)。纯、可单测。
- **新增** `src/service/reply-registry.ts` —— `createReplyRegistry()`:`awaitReply(correlationId, timeoutMs)` / `resolve(correlationId, payload)`。仿 `permission-registry.ts`。
- **修改** `src/service/agent-runner.ts` —— 抽 `buildAgentSession(deps)`(持 agent + translator + budget/used + stop 机制,暴露 `promptOnce(goal, images?)` 与 `agent`/`getUsed`/`abort`);`run()` 改为薄封装;新增 `runResident(deps, mailbox, hooks)`。
- **修改** `src/service/session-manager.ts` —— `runHandles` 升级为按 address;turn-slot 句柄;`sendMessage` 接 mailbox + 拉起 `runResident`;`send_and_wait` 让出/重获槽 + `ReplyRegistry`;启动崩溃重放。
- **可能修改** `src/service/index.ts` —— 触发启动重放(若 session-manager 不在构造时自行扫描)。

> **实现前置动作**:本计划基于 `develop`(计划 A 已合并)。开工先 `git log` + 读 `agent-runner.ts` 的 `run()`(`createAgentRunner` 约 `:290-650`)、`session-manager.ts` 的 `acquireSlot`/`activateActor`/`sendMessage`、`permission-registry.ts` 全文,以实际代码为准;有出入就地调整。注意主仓库工作树可能有他人并行改动 —— 只在你的 worktree 内工作。

---

## Task 1: `createMailbox`(内存收件箱)

**Files:**
- Create: `src/service/actor-mailbox.ts`
- Test: `src/service/actor-mailbox.test.ts`

**Interfaces:**
- Consumes: `ActorMessage` from `@shared/types/actor`.
- Produces:
  - `class IdleTimeoutError extends Error`
  - `type Mailbox = { deliver(msg: ActorMessage): void; receive(opts: { idleMs: number }): Promise<ActorMessage>; size(): number }`
  - `function createMailbox(): Mailbox`

- [ ] **Step 1: Write the failing test**

```typescript
// src/service/actor-mailbox.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createMailbox, IdleTimeoutError } from './actor-mailbox'
import type { ActorMessage } from '@shared/types/actor'

const msg = (id: string): ActorMessage => ({
  id, toAddr: 'a', fromAddr: null, kind: 'send', correlationId: null,
  payload: '{}', consumed: false, retries: 0, dead: false, ts: 1,
})

describe('createMailbox', () => {
  it('returns an already-queued message immediately', async () => {
    const mb = createMailbox()
    mb.deliver(msg('m1'))
    expect((await mb.receive({ idleMs: 1000 })).id).toBe('m1')
  })

  it('blocks until a message is delivered, then resolves it', async () => {
    const mb = createMailbox()
    const p = mb.receive({ idleMs: 1000 })
    mb.deliver(msg('m2'))
    expect((await p).id).toBe('m2')
  })

  it('rejects with IdleTimeoutError when no message arrives in idleMs', async () => {
    vi.useFakeTimers()
    const mb = createMailbox()
    const p = mb.receive({ idleMs: 50 })
    const assertion = expect(p).rejects.toBeInstanceOf(IdleTimeoutError)
    await vi.advanceTimersByTimeAsync(60)
    await assertion
    vi.useRealTimers()
  })

  it('delivers in FIFO order', async () => {
    const mb = createMailbox()
    mb.deliver(msg('m1'))
    mb.deliver(msg('m2'))
    expect((await mb.receive({ idleMs: 1000 })).id).toBe('m1')
    expect((await mb.receive({ idleMs: 1000 })).id).toBe('m2')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/actor-mailbox.test.ts`
Expected: FAIL — cannot resolve `./actor-mailbox`.

- [ ] **Step 3: Implement**

```typescript
// src/service/actor-mailbox.ts
import type { ActorMessage } from '@shared/types/actor'

// Thrown by receive() when no message arrives within idleMs — the resident
// loop treats this as the signal to sleep (destroy the actor).
export class IdleTimeoutError extends Error {
  constructor() {
    super('mailbox idle timeout')
    this.name = 'IdleTimeoutError'
  }
}

export type Mailbox = {
  deliver(msg: ActorMessage): void
  receive(opts: { idleMs: number }): Promise<ActorMessage>
  size(): number
}

// In-memory FIFO inbox for one resident actor. One pending receiver at a time
// (the resident loop processes messages serially), so a single waiter slot.
export function createMailbox(): Mailbox {
  const queue: ActorMessage[] = []
  let waiter: { resolve: (m: ActorMessage) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout } | null = null

  return {
    deliver(msg) {
      if (waiter) {
        clearTimeout(waiter.timer)
        const w = waiter
        waiter = null
        w.resolve(msg)
        return
      }
      queue.push(msg)
    },
    receive({ idleMs }) {
      const queued = queue.shift()
      if (queued) return Promise.resolve(queued)
      return new Promise<ActorMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (waiter) {
            waiter = null
            reject(new IdleTimeoutError())
          }
        }, idleMs)
        timer.unref?.()
        waiter = { resolve, reject, timer }
      })
    },
    size: () => queue.length,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/actor-mailbox.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
npx biome check --write src/service/actor-mailbox.ts src/service/actor-mailbox.test.ts
git add src/service/actor-mailbox.ts src/service/actor-mailbox.test.ts
git commit -m "feat(actor): in-memory mailbox with idle-timeout receive"
```

---

## Task 2: `createReplyRegistry`(rpc 回信路由)

**Files:**
- Create: `src/service/reply-registry.ts`
- Test: `src/service/reply-registry.test.ts`

**Interfaces:**
- Produces:
  - `type ReplyRegistry = { awaitReply(correlationId: string, timeoutMs: number): Promise<string>; resolve(correlationId: string, payload: string): void }`
  - `function createReplyRegistry(): ReplyRegistry`
- 设计:仿 `src/service/permission-registry.ts`。`awaitReply` 注册一次性等待 + 超时(超时 resolve 为空串 `''`,与计划 A 的「rpc 拿不到回信返回空串」一致,调用方不抛);`resolve` 唤醒等待者;无等待者(调用方已销毁)→ no-op + `warn`。

- [ ] **Step 1: Write the failing test**

```typescript
// src/service/reply-registry.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createReplyRegistry } from './reply-registry'

describe('createReplyRegistry', () => {
  it('resolve wakes a pending awaitReply with the payload', async () => {
    const r = createReplyRegistry()
    const p = r.awaitReply('c1', 1000)
    r.resolve('c1', 'the-reply')
    expect(await p).toBe('the-reply')
  })

  it('awaitReply resolves to empty string on timeout', async () => {
    vi.useFakeTimers()
    const r = createReplyRegistry()
    const p = r.awaitReply('c2', 50)
    await vi.advanceTimersByTimeAsync(60)
    expect(await p).toBe('')
    vi.useRealTimers()
  })

  it('resolve for an unknown correlationId is a no-op (does not throw)', () => {
    const r = createReplyRegistry()
    expect(() => r.resolve('ghost', 'x')).not.toThrow()
  })

  it('a resolved correlationId only fires once', async () => {
    const r = createReplyRegistry()
    const p = r.awaitReply('c3', 1000)
    r.resolve('c3', 'first')
    r.resolve('c3', 'second') // no pending waiter anymore — ignored
    expect(await p).toBe('first')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/reply-registry.test.ts`
Expected: FAIL — cannot resolve `./reply-registry`.

- [ ] **Step 3: Implement**

```typescript
// src/service/reply-registry.ts
import { createLogger } from '@shared/logger'

const log = createLogger({ process: 'service' }).child({ component: 'reply' })

type PendingReply = { resolve: (payload: string) => void; timer: NodeJS.Timeout }

export type ReplyRegistry = {
  // Register a one-shot wait for an rpc reply. Resolves to the reply payload,
  // or to '' on timeout (mirrors plan A: an rpc that gets no reply returns '').
  awaitReply(correlationId: string, timeoutMs: number): Promise<string>
  // Deliver a reply. No-op if no one is waiting (the caller was destroyed).
  resolve(correlationId: string, payload: string): void
}

export function createReplyRegistry(): ReplyRegistry {
  const pending = new Map<string, PendingReply>()

  return {
    awaitReply(correlationId, timeoutMs) {
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          if (pending.delete(correlationId)) {
            log.warn({ msg: 'rpc reply timed out', correlationId, timeoutMs })
            resolve('')
          }
        }, timeoutMs)
        timer.unref?.()
        pending.set(correlationId, { resolve, timer })
      })
    },
    resolve(correlationId, payload) {
      const p = pending.get(correlationId)
      if (!p) {
        log.warn({ msg: 'rpc reply has no waiter (caller gone)', correlationId })
        return
      }
      clearTimeout(p.timer)
      pending.delete(correlationId)
      p.resolve(payload)
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/reply-registry.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
npx biome check --write src/service/reply-registry.ts src/service/reply-registry.test.ts
git add src/service/reply-registry.ts src/service/reply-registry.test.ts
git commit -m "feat(actor): reply registry for correlationId-routed rpc replies"
```

---

## Task 3: 抽取 `buildAgentSession` + `promptOnce`,`run()` 改薄封装

**Files:**
- Modify: `src/service/agent-runner.ts`(`createAgentRunner.run`,约 `:290-650`)
- Test: `src/service/agent-runner.session.test.ts`

**Interfaces:**
- Produces (exported from `agent-runner.ts`):
  - `type AgentSession = { promptOnce(goal: string, images?: ImageContent[]): Promise<{ status: 'completed' | 'failed' | 'cancelled'; summary: string }>; readonly agent: Agent; getUsed(): ConsumedResources; abort(): void }`
  - `function buildAgentSession(deps: AgentRunnerDeps): AgentSession`
- Consumes: existing `AgentRunnerDeps`, `buildToolContext`, `resolveModel`, `composeSystemPrompt`, `createEventTranslator`.
- `run()` (unchanged external contract) becomes: `const s = buildAgentSession(deps); const r = await s.promptOnce(deps.task.goal, images); return { ...r, messages: s.agent.state.messages, used: s.getUsed() }`.

**重构性质**:纯抽取 —— 把 `createAgentRunner.run()` 当前内联的 setup(tools/model 解析 `:300-337`、`Agent` 构造 `:403-479`、signal 接线 + `agent.subscribe` `:481-544`、budget/used/stop 机制 `:361-401`)移入 `buildAgentSession`;把 prompt+stop-cause 返回(`:546-647`)移入 `promptOnce`。**一次常驻 = 一个 Task** 的决定让 agent 的 `task`/`emit`/`budget` 绑定在整个 session 固定,无需逐 turn 重绑。`used`/`contextTokens`/`startedAt` 成为 session 级累加器(跨 `promptOnce` 累积 —— 一个常驻期一个 budget 包络)。

> 因 `agent-runner.ts` 的真实 `run()` 当前**无单测覆盖**(codegraph: "no covering tests found";session 层测试 `vi.mock('./agent-runner')`),本任务的回归保障 = ①全套 `npm test` 绿(编译 + mocked 集成路径不破);②新增下方单测,**mock pi `Agent`** 验证抽取后的行为(尤其 `promptOnce` 两次复用同一 `agent.state`)。

- [ ] **Step 1: Write the failing test (mock pi Agent)**

```typescript
// src/service/agent-runner.session.test.ts
import { describe, expect, it, vi } from 'vitest'

// Mock the pi Agent so promptOnce runs without an LLM. The mock records each
// prompt and accumulates them into state.messages, and emits an agent_end so
// the event translator produces a summary.
const prompts: string[] = []
vi.mock('@earendil-works/pi-agent-core', () => {
  class Agent {
    state = { messages: [] as Array<{ role: string; content: string }> }
    private subscriber: ((e: unknown) => void) | null = null
    constructor(_cfg: unknown) {}
    subscribe(fn: (e: unknown) => void) { this.subscriber = fn }
    abort() {}
    async prompt(goal: string) {
      prompts.push(goal)
      this.state.messages.push({ role: 'user', content: goal })
      this.state.messages.push({ role: 'assistant', content: `ack:${goal}` })
      // Minimal event stream: a text delta then agent_end so the translator
      // assembles a summary.
      this.subscriber?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `ack:${goal}` } })
      this.subscriber?.({ type: 'agent_end' })
    }
  }
  return { Agent }
})

import { buildAgentSession } from './agent-runner'
import type { AgentRunnerDeps } from './agent-runner'

const deps = (): AgentRunnerDeps => ({
  task: { id: 't1', goal: 'hello', cwd: undefined, attachments: [], budget: { calls: 100, wallMs: 60000, usdCents: 1000, tokens: 1e9 }, permissionMode: 'full' } as any,
  provider: { model: 'test', apiStyle: 'anthropic' } as any,
  agentDefinition: { id: 'default', systemPrompt: 'sys', toolScope: 'all', maxIterations: 25 } as any,
  sessionId: 's1',
  emit: () => {},
  permissionRegistry: { request: async () => 'grant', resolve: () => {} } as any,
  toolRegistry: { resolve: () => ({ tools: [], riskOf: () => 'low' }) } as any,
  initialMessages: [],
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
})

describe('buildAgentSession', () => {
  it('promptOnce returns a completed summary for the prompt', async () => {
    prompts.length = 0
    const s = buildAgentSession(deps())
    const r = await s.promptOnce('first')
    expect(r.status).toBe('completed')
    expect(r.summary).toContain('ack:first')
    expect(prompts).toEqual(['first'])
  })

  it('two promptOnce calls reuse the same agent state (context accumulates)', async () => {
    prompts.length = 0
    const s = buildAgentSession(deps())
    await s.promptOnce('first')
    await s.promptOnce('second')
    // Both prompts went to the SAME agent; its message history holds both turns.
    expect(prompts).toEqual(['first', 'second'])
    expect(s.agent.state.messages.map((m) => m.content)).toEqual([
      'first', 'ack:first', 'second', 'ack:second',
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/agent-runner.session.test.ts`
Expected: FAIL — `buildAgentSession` is not exported.

- [ ] **Step 3: Perform the extraction**

In `src/service/agent-runner.ts`:
1. Add exported `buildAgentSession(deps: AgentRunnerDeps): AgentSession`. Move into it (verbatim, from the current `run()` body): the deps destructure, `taskLog`, tools/model resolution (with its try/catch that on setup failure makes `promptOnce` return `{status:'failed', summary:''}`), the `budget`/`used`/`contextTokens`/`stopCause` machinery, the `Agent` construction, the `deps.signal` wiring, and `agent.subscribe(...)`. Keep these as closure state of `buildAgentSession`.
2. Expose `promptOnce(goal, images?)`: the body currently at `:546-647` (the `agent.prompt(...)` call + the `stopCause` branches + the final `return { status, summary }`), but returning only `{ status, summary }` (NOT messages/used — those come from the session getters). Reset `stopCause`/`startedAt`-for-this-turn as appropriate so a second call starts clean for cancel/budget detection while `used` keeps accumulating.
3. Expose `agent`, `getUsed(): ConsumedResources` (returns `snapshotUsed()`), `abort()` (calls `agent.abort()`).
4. Rewrite `createAgentRunner().run()` to:
```typescript
async run() {
  const s = buildAgentSession(deps)
  const images = deps.task.attachments.map((a) => ({ type: 'image', data: a.data, mimeType: a.mimeType })) as ImageContent[]
  const r = await s.promptOnce(deps.task.goal, images.length ? images : undefined)
  return { status: r.status, summary: r.summary, messages: s.agent.state.messages, used: s.getUsed() }
}
```
Preserve the existing `saveSnapshot` call (it fires in the `turn_end` subscriber — keep it inside `buildAgentSession`).

> If during extraction the `stopCause` reset semantics across multiple `promptOnce` calls are unclear, STOP and report NEEDS_CONTEXT — do not guess. For the one-shot path (Task 3) only one `promptOnce` is ever called, so the multi-call reset only matters for Task 4; it is acceptable to make `promptOnce` reset `stopCause = null` and `startedAt`-for-wall-budget at its start.

- [ ] **Step 4: Run tests**

Run: `npm test -- src/service/agent-runner.session.test.ts`
Expected: PASS (2 tests)
Then run the full suite: `npm test`
Expected: PASS, no regressions (the `vi.mock('./agent-runner')` session tests still pass; one-shot `run()` unchanged).

- [ ] **Step 5: Commit**

```bash
npx biome check --write src/service/agent-runner.ts src/service/agent-runner.session.test.ts
git add src/service/agent-runner.ts src/service/agent-runner.session.test.ts
git commit -m "refactor(agent-runner): extract buildAgentSession/promptOnce; run() is a thin wrapper"
```

---

## Task 4: `runResident(deps, mailbox, hooks)`(常驻循环)

**Files:**
- Modify: `src/service/agent-runner.ts`
- Test: `src/service/agent-runner.resident.test.ts`

**Interfaces:**
- Consumes: `buildAgentSession` (Task 3), `Mailbox` + `IdleTimeoutError` (Task 1).
- Produces (exported):
  - `type ResidentHooks = { acquireTurnSlot(): Promise<void>; releaseTurnSlot(): void; onConsumed(msgId: string): void; onReply(correlationId: string, summary: string): void }`
  - `function runResident(deps: AgentRunnerDeps, mailbox: Mailbox, hooks: ResidentHooks, idleMs: number): Promise<void>` — builds the session once, loops `receive→promptOnce`, returns when the mailbox idles out or `deps.signal` aborts.

- [ ] **Step 1: Write the failing test**

```typescript
// src/service/agent-runner.resident.test.ts
import { describe, expect, it, vi } from 'vitest'

const prompts: string[] = []
vi.mock('@earendil-works/pi-agent-core', () => {
  class Agent {
    state = { messages: [] as Array<{ role: string; content: string }> }
    private sub: ((e: unknown) => void) | null = null
    constructor(_c: unknown) {}
    subscribe(fn: (e: unknown) => void) { this.sub = fn }
    abort() {}
    async prompt(goal: string) {
      prompts.push(goal)
      this.state.messages.push({ role: 'assistant', content: `ack:${goal}` })
      this.sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `ack:${goal}` } })
      this.sub?.({ type: 'agent_end' })
    }
  }
  return { Agent }
})

import { runResident } from './agent-runner'
import { createMailbox } from './actor-mailbox'
import type { AgentRunnerDeps } from './agent-runner'
import type { ActorMessage } from '@shared/types/actor'

const deps = (): AgentRunnerDeps => ({
  task: { id: 't1', goal: '', cwd: undefined, attachments: [], budget: { calls: 1000, wallMs: 600000, usdCents: 100000, tokens: 1e9 }, permissionMode: 'full' } as any,
  provider: { model: 'test', apiStyle: 'anthropic' } as any,
  agentDefinition: { id: 'default', systemPrompt: 'sys', toolScope: 'all', maxIterations: 25 } as any,
  sessionId: 's1', emit: () => {},
  permissionRegistry: { request: async () => 'grant', resolve: () => {} } as any,
  toolRegistry: { resolve: () => ({ tools: [], riskOf: () => 'low' }) } as any,
  initialMessages: [],
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
})

const m = (id: string, kind: 'send' | 'rpc', correlationId: string | null, payload: string): ActorMessage => ({
  id, toAddr: 'a', fromAddr: null, kind, correlationId, payload, consumed: false, retries: 0, dead: false, ts: 1,
})

describe('runResident', () => {
  it('drains queued messages onto one shared agent, marks each consumed, exits on idle', async () => {
    prompts.length = 0
    const consumed: string[] = []
    const mb = createMailbox()
    mb.deliver(m('m1', 'send', null, 'first'))
    mb.deliver(m('m2', 'send', null, 'second'))
    await runResident(deps(), mb, {
      acquireTurnSlot: async () => {}, releaseTurnSlot: () => {},
      onConsumed: (id) => consumed.push(id), onReply: () => {},
    }, 20) // tiny idle so the loop exits quickly after draining
    expect(prompts).toEqual(['first', 'second'])
    expect(consumed).toEqual(['m1', 'm2'])
  })

  it('routes an rpc message turn result via onReply(correlationId)', async () => {
    prompts.length = 0
    const replies: Array<[string, string]> = []
    const mb = createMailbox()
    mb.deliver(m('m1', 'rpc', 'corr-1', 'review'))
    await runResident(deps(), mb, {
      acquireTurnSlot: async () => {}, releaseTurnSlot: () => {},
      onConsumed: () => {}, onReply: (c, s) => replies.push([c, s]),
    }, 20)
    expect(replies[0][0]).toBe('corr-1')
    expect(replies[0][1]).toContain('ack:review')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/agent-runner.resident.test.ts`
Expected: FAIL — `runResident` is not exported.

- [ ] **Step 3: Implement**

```typescript
// in src/service/agent-runner.ts
export type ResidentHooks = {
  acquireTurnSlot(): Promise<void>
  releaseTurnSlot(): void
  onConsumed(msgId: string): void
  onReply(correlationId: string, summary: string): void
}

// A resident virtual actor: build the agent session once (so its conversation
// accumulates across messages), then drain the mailbox one message per turn.
// Returns when the mailbox idles out (sleep) or deps.signal aborts.
export async function runResident(
  deps: AgentRunnerDeps,
  mailbox: Mailbox,
  hooks: ResidentHooks,
  idleMs: number
): Promise<void> {
  const log = createLogger({ process: 'service' }).child({ component: 'actor-runtime' })
  const session = buildAgentSession(deps)
  log.info({ msg: 'resident-start', address: deps.selfAddress, taskId: deps.task.id })
  for (;;) {
    if (deps.signal?.aborted) { log.info({ msg: 'resident aborted', address: deps.selfAddress }); return }
    let msg: ActorMessage
    try {
      msg = await mailbox.receive({ idleMs })
    } catch (err) {
      if (err instanceof IdleTimeoutError) { log.info({ msg: 'idle-sleep', address: deps.selfAddress }); return }
      throw err
    }
    await hooks.acquireTurnSlot()
    try {
      log.info({ msg: 'turn-start', address: deps.selfAddress, msgId: msg.id, kind: msg.kind })
      const { summary } = await session.promptOnce(JSON.parse(msg.payload)?.text ?? msg.payload)
      hooks.onConsumed(msg.id)
      if (msg.kind === 'rpc' && msg.correlationId) hooks.onReply(msg.correlationId, summary)
      log.info({ msg: 'turn-end', address: deps.selfAddress, msgId: msg.id })
    } catch (err) {
      log.error({ msg: 'resident turn failed', address: deps.selfAddress, msgId: msg.id, err: err instanceof Error ? err.message : String(err) })
      // Surface the failure to the orchestrator via onConsumed semantics handled
      // there (retry/deadletter decided by session-manager — see Task 6/8).
      throw err
    } finally {
      hooks.releaseTurnSlot()
    }
  }
}
```

> Payload convention: the test delivers a plain string payload; production `send` enqueues `payload` as the goal text. The `JSON.parse(...)?.text ?? msg.payload` guard tolerates both a JSON `{text}` envelope and a raw string. Confirm the actual `sendMessage` payload shape from Task 6 and align (if Task 6 stores raw goal text, simplify to `msg.payload`).

- [ ] **Step 4: Run tests**

Run: `npm test -- src/service/agent-runner.resident.test.ts`
Expected: PASS (2 tests)
Then: `npm test` — full suite green.

- [ ] **Step 5: Commit**

```bash
npx biome check --write src/service/agent-runner.ts src/service/agent-runner.resident.test.ts
git add src/service/agent-runner.ts src/service/agent-runner.resident.test.ts
git commit -m "feat(agent-runner): runResident drains a mailbox onto one shared agent session"
```

---

## Task 5: session-manager —— turn-slot 句柄 + 按 address 的 runHandles

**Files:**
- Modify: `src/service/session-manager.ts`
- Test: `src/service/session-manager.turnslot.test.ts`

**Interfaces:**
- Consumes: existing `acquireSlot`/`releaseSlot`/`activeRunners`/`waitQueue`.
- Produces (internal): keep `acquireSlot`/`releaseSlot` as-is (they already model the semaphore at turn granularity once callers acquire per-turn). Add `runHandles: Map<string, ResidentHandle>` where
  `type ResidentHandle = { abort(): void; deliver(msg: ActorMessage): void }` keyed by **address** for resident actors; one-shot tasks keep using a separate `oneShotHandles: Map<taskId, AbortController>` (rename the existing `runHandles` to `oneShotHandles` and route `cancelTask`/`deleteSession` through it — pure rename, behavior unchanged).

- [ ] **Step 1: Write the failing test**

```typescript
// src/service/session-manager.turnslot.test.ts
// Verifies the rename is behavior-preserving: cancelTask still aborts a one-shot run.
import { describe, expect, it, vi } from 'vitest'
vi.mock('./agent-runner', () => ({
  createAgentRunner: (deps: any) => ({
    run: () => new Promise(() => {}), // never resolves — stays "running" so we can cancel
  }),
  // runResident/buildAgentSession referenced later; stub to satisfy imports
  runResident: async () => {},
  buildAgentSession: () => ({}),
}))
import { createConversationStore } from './conversation-store'
import { createSessionManager } from './session-manager'

const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any
it('cancelTask aborts a running one-shot task (oneShotHandles rename intact)', async () => {
  const store = createConversationStore(':memory:')
  const events: string[] = []
  const mgr = createSessionManager({
    store, broadcaster: { broadcast: (e: string) => events.push(e) }, maxConcurrent: 4, getProvider: () => fakeProvider,
  })
  const { sessionId } = mgr.createSession(fakeProvider)
  const { taskId } = mgr.submitGoal(sessionId, 'go')
  await new Promise((r) => setTimeout(r, 10))
  mgr.cancelTask(sessionId, taskId) // must not throw; aborts the controller
  expect(events).toContain('task.created')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/session-manager.turnslot.test.ts`
Expected: FAIL initially only if the rename/imports aren't in place — if it passes pre-change, treat it as a guard that the rename keeps behavior. (Write it, run it; it should pass before AND after the rename — its job is regression protection.)

- [ ] **Step 3: Implement the rename + new map**

In `createSessionManager`:
1. Rename the existing `const runHandles = new Map<string, AbortController>()` to `const oneShotHandles = new Map<string, AbortController>()`. Update all current references (`runHandles.set/get/delete` in `submitGoal`'s `runTurn`, `activateActor`, `cancelTask`, `deleteSession`) to `oneShotHandles`.
2. Add `const residentHandles = new Map<string, { abort(): void; deliver(msg: ActorMessage): void }>()` (keyed by address) — declared now, populated in Task 6.
3. `cancelTask(sessionId, taskId)`: keep aborting via `oneShotHandles.get(taskId)?.abort()`.

- [ ] **Step 4: Run tests**

Run: `npm test -- src/service/session-manager.turnslot.test.ts`
Expected: PASS
Then: `npm test` — full suite green (the rename touches messaging/actors tests' code paths; confirm no regression).

- [ ] **Step 5: Commit**

```bash
npx biome check --write src/service/session-manager.ts src/service/session-manager.turnslot.test.ts
git add src/service/session-manager.ts src/service/session-manager.turnslot.test.ts
git commit -m "refactor(session): split oneShotHandles vs residentHandles (by address)"
```

---

## Task 6: session-manager —— `send` 接 mailbox + 拉起常驻循环

**Files:**
- Modify: `src/service/session-manager.ts`
- Test: `src/service/session-manager.resident.test.ts`

**Interfaces:**
- Consumes: `createMailbox` (Task 1), `runResident`/`ResidentHooks` (Task 4), `residentHandles` (Task 5), `ensureActor`/`resolveAddress`/store (plan A).
- Produces (internal): `spawnResident(sessionId, actor): void` — creates the residency Task (one per residency), a mailbox, registers `residentHandles[address] = { abort, deliver }`, and runs `runResident(...)`; on return (idle/abort) marks the Task completed and deletes the handle. `sendMessage(...)` rpc/send paths now route through mailbox.

- [ ] **Step 1: Write the failing test**

```typescript
// src/service/session-manager.resident.test.ts
import { describe, expect, it, vi } from 'vitest'

// Stub runResident to simulate a resident actor: drain whatever is delivered,
// call onConsumed + onReply, and resolve when told to idle.
const delivered: any[] = []
vi.mock('./agent-runner', () => ({
  createAgentRunner: (d: any) => ({ run: async () => ({ status: 'completed', summary: `ran:${d.task.goal}`, messages: [], used: {} }) }),
  buildAgentSession: () => ({}),
  runResident: async (deps: any, mailbox: any, hooks: any, idleMs: number) => {
    // process exactly the messages already queued, then idle out
    for (;;) {
      let msg
      try { msg = await mailbox.receive({ idleMs: 5 }) } catch { return }
      delivered.push(msg.id)
      await hooks.acquireTurnSlot(); hooks.releaseTurnSlot()
      hooks.onConsumed(msg.id)
      if (msg.kind === 'rpc' && msg.correlationId) hooks.onReply(msg.correlationId, `reply:${msg.id}`)
    }
  },
}))
import { createConversationStore } from './conversation-store'
import { createSessionManager } from './session-manager'

const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any
const mk = () => {
  const store = createConversationStore(':memory:')
  const mgr = createSessionManager({ store, broadcaster: { broadcast: () => {} }, maxConcurrent: 4, getProvider: () => fakeProvider })
  return { store, mgr }
}

describe('resident send wiring', () => {
  it('fire-and-forget send spawns a resident loop that consumes the message', async () => {
    delivered.length = 0
    const { store, mgr } = mk()
    const { sessionId } = mgr.createSession(fakeProvider)
    const a = (mgr as any).__ensureActorForTest(sessionId, 'default', 'worker')
    await (mgr as any).__sendMessageForTest(sessionId, null, 'worker', 'do-it', 'send')
    await new Promise((r) => setTimeout(r, 30))
    expect(delivered.length).toBeGreaterThanOrEqual(1)
    expect(store.nextUnconsumedFor(a.address)).toBeUndefined() // marked consumed
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/session-manager.resident.test.ts`
Expected: FAIL — `send` doesn't yet spawn a resident loop / consume.

- [ ] **Step 3: Implement `spawnResident` + rewire `sendMessage`**

Replace plan A's `activateActor` usage in `sendMessage` with mailbox delivery:

```typescript
const IDLE_TIMEOUT_MS = 30_000

const spawnResident = (sessionId: string, actor: Actor): { deliver: (m: ActorMessage) => void } => {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`session ${sessionId} not found`)
  const def = cfg.agentStore?.get(actor.agentDefId) ?? DEFAULT_AGENT_DEF
  // One Task per residency.
  const taskId = ulid(); const now = Date.now()
  const task: Task = { id: taskId, parentId: null, agentDefId: def.id, goal: `actor:${actor.address}`, status: 'pending',
    assignedWorkerId: null, toolAllowlist: deriveAllowlist(def.toolScope), budget: budgets().sub,
    used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 }, history: [], attachments: [], result: null,
    createdAt: now, startedAt: null, endedAt: null }
  store.saveTask(task, sessionId)
  store.upsertActor({ ...actor, lastTaskId: taskId, updatedAt: now })
  broadcaster.broadcast('task.created', { sessionId, taskId, goal: task.goal, attachments: [], agentDefId: def.id, ts: now })

  const mailbox = createMailbox()
  const abort = new AbortController()
  const handle = { abort: () => abort.abort(), deliver: (m: ActorMessage) => mailbox.deliver(m) }
  residentHandles.set(actor.address, handle)
  log.info({ msg: 'resident spawned', sessionId, address: actor.address, taskId })

  const hooks: ResidentHooks = {
    acquireTurnSlot: () => acquireSlot(),
    releaseTurnSlot: () => releaseSlot(),
    onConsumed: (msgId) => store.markConsumed(msgId),
    onReply: (correlationId, summary) => replyRegistry.resolve(correlationId, summary),
  }
  const deps: AgentRunnerDeps = {
    task, provider: def.model ? { ...session.provider, model: def.model } : session.provider,
    agentDefinition: withPrompt(def), sessionId, emit: makeEmit(sessionId),
    permissionRegistry: session.permissionRegistry, toolRegistry, initialMessages: [],
    signal: abort.signal, selfAddress: actor.address,
    sendMessage: (from, to, payload, kind) => sendMessage(sessionId, from, to, payload, kind),
    spawnChild: (pt, ng, st, pk, at) => spawnChild(sessionId, pt, ng, st, pk, at),
  }
  void runResident(deps, mailbox, hooks, IDLE_TIMEOUT_MS)
    .then(() => store.updateTaskStatus(taskId, 'completed'))
    .catch((err) => { log.error({ msg: 'resident loop failed', address: actor.address, err: String(err) }); store.updateTaskStatus(taskId, 'failed') })
    .finally(() => residentHandles.delete(actor.address))
  return handle
}
```

Rewrite `sendMessage`'s delivery section (after enqueue + dead-letter check):

```typescript
// resolve-or-spawn the resident loop, then deliver
const handle = residentHandles.get(target.address) ?? spawnResident(sessionId, target)
handle.deliver({ id: msgId, toAddr: target.address, fromAddr, kind,
  correlationId: kind === 'rpc' ? msgId : null, payload, consumed: false, retries: 0, dead: false, ts: now })
if (kind === 'rpc') return { reply: await replyRegistry.awaitReply(msgId, RPC_TIMEOUT_MS) }
return { delivered: true }
```

Add `const replyRegistry = createReplyRegistry()` near the top of `createSessionManager`, and `const RPC_TIMEOUT_MS = 120_000`. Payload: store the raw goal text as `payload` (align `runResident` to use `msg.payload` directly — simplify Task 4's parse guard if so).

> Race note: deliver-after-spawn is safe because `spawnResident` registers the handle synchronously before `runResident`'s first `await mailbox.receive()`; the delivered message is queued and picked up on the first receive.

- [ ] **Step 4: Run tests**

Run: `npm test -- src/service/session-manager.resident.test.ts`
Expected: PASS
Then: `npm test` — full suite green (plan A messaging tests now go through the resident path; confirm they still pass; if `activateActor` is fully replaced, delete it and any now-dead references).

- [ ] **Step 5: Commit**

```bash
npx biome check --write src/service/session-manager.ts src/service/session-manager.resident.test.ts
git add src/service/session-manager.ts src/service/session-manager.resident.test.ts
git commit -m "feat(session): send routes through a resident mailbox loop (replaces per-message activation)"
```

---

## Task 7: session-manager —— `send_and_wait` 等信时让出/重获 turn-slot

**Files:**
- Modify: `src/service/session-manager.ts`
- Test: `src/service/session-manager.deadlock.test.ts`

**Interfaces:**
- Consumes: `residentHandles`, `acquireSlot`/`releaseSlot`, `replyRegistry`.
- Produces (internal): the rpc branch of `sendMessage`, when called by an actor whose resident loop currently holds a turn-slot, **releases that slot before awaiting the reply and re-acquires after**. Mechanism: the rpc-caller's address is `fromAddr`; while it awaits, release one slot (so the callee can acquire) and re-acquire before returning.

- [ ] **Step 1: Write the failing test (the deadlock regression — acceptance core)**

```typescript
// src/service/session-manager.deadlock.test.ts
import { describe, expect, it, vi } from 'vitest'

// Real runResident + real mailbox; mock pi Agent. Actor 'a' sends_and_wait to
// 'b'; 'b' replies. With maxConcurrent=1 this MUST NOT deadlock.
vi.mock('@earendil-works/pi-agent-core', () => {
  class Agent {
    state = { messages: [] as any[] }
    private sub: ((e: unknown) => void) | null = null
    constructor(_c: unknown) {}
    subscribe(fn: (e: unknown) => void) { this.sub = fn }
    abort() {}
    async prompt(goal: string) {
      this.sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `done:${goal}` } })
      this.sub?.({ type: 'agent_end' })
    }
  }
  return { Agent }
})
import { createConversationStore } from './conversation-store'
import { createSessionManager } from './session-manager'

const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any
it('maxConcurrent=1: actor rpc to a peer does not deadlock', async () => {
  const store = createConversationStore(':memory:')
  const mgr = createSessionManager({ store, broadcaster: { broadcast: () => {} }, maxConcurrent: 1, getProvider: () => fakeProvider })
  const { sessionId } = mgr.createSession(fakeProvider)
  ;(mgr as any).__ensureActorForTest(sessionId, 'default', 'b')
  const res = await Promise.race([
    (mgr as any).__sendMessageForTest(sessionId, 'a', 'b', 'please', 'rpc'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('DEADLOCK')), 2000)),
  ])
  expect((res as any).reply).toContain('done:please')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/session-manager.deadlock.test.ts`
Expected: FAIL — times out with "DEADLOCK" (the rpc caller holds the only slot while 'b' waits for one).

> If it does NOT deadlock pre-change (because the top-level `__sendMessageForTest` caller holds no slot), construct the test so the caller IS inside a held slot: deliver an initial `send` to actor 'a' whose turn does `send_and_wait('b')`, with `maxConcurrent=1`. Adjust the test to route through an actor turn so the slot is genuinely held. The acceptance criterion is unchanged: an rpc issued from within a slot-holding turn must not deadlock at `maxConcurrent=1`.

- [ ] **Step 3: Implement slot yield/reacquire in the rpc branch**

```typescript
if (kind === 'rpc') {
  // The caller (fromAddr) is mid-turn and holds a turn-slot. Yield it while we
  // wait for the reply so the callee can acquire a slot — this is what prevents
  // deadlock under maxConcurrent. Re-acquire before returning to the caller's loop.
  const callerHoldsSlot = !!fromAddr && residentHandles.has(fromAddr)
  if (callerHoldsSlot) releaseSlot()
  try {
    return { reply: await replyRegistry.awaitReply(msgId, RPC_TIMEOUT_MS) }
  } finally {
    if (callerHoldsSlot) await acquireSlot()
  }
}
```

> Caveat: `releaseSlot()`/`acquireSlot()` operate on the global semaphore; releasing here transfers the caller's slot to the wait queue and re-acquiring rejoins it. Because the caller is blocked (awaiting reply) it is not running an LLM turn, so it correctly should not count against `maxConcurrent`. Confirm `acquireSlot`/`releaseSlot`'s counter math handles release-then-acquire by the same logical holder without underflow (the existing `waitQueue`/`activeRunners` logic in `:115-128` already supports transfer).

- [ ] **Step 4: Run tests**

Run: `npm test -- src/service/session-manager.deadlock.test.ts`
Expected: PASS (no deadlock; reply received)
Then: `npm test` — full suite green.

- [ ] **Step 5: Commit**

```bash
npx biome check --write src/service/session-manager.ts src/service/session-manager.deadlock.test.ts
git add src/service/session-manager.ts src/service/session-manager.deadlock.test.ts
git commit -m "feat(session): rpc caller yields its turn-slot while awaiting reply (deadlock fix)"
```

---

## Task 8: session-manager —— 启动崩溃重放 + 重试/死信

**Files:**
- Modify: `src/service/session-manager.ts`
- Modify: `src/service/conversation-store.ts`(加 `listUnconsumedAddresses(): string[]`)
- Test: `src/service/session-manager.redrain.test.ts`, `src/service/conversation-store.actors.test.ts`(扩充)

**Interfaces:**
- Produces:
  - `ConversationStore.listUnconsumedAddresses(): string[]` — distinct `to_addr` of messages with `consumed=0 AND dead=0`, whose actor still exists.
  - On `createSessionManager` init: for each such address, look up its actor + session and `spawnResident` to drain.
  - Retry/deadletter: the resident loop's failure path (Task 4 throws) is caught in `spawnResident`'s `.catch`; on a per-message failure, `store.bumpRetries(msgId)` and `markDead` if `> MAX_RETRIES (3)`. (Implement by passing an `onError(msgId)` hook or handling inside `onConsumed` semantics — extend `ResidentHooks` with `onError(msgId): 'retry' | 'dead'` and have `runResident` consult it instead of throwing the whole loop.)

> Design refinement for retries: rather than letting one bad message kill the whole resident loop, extend `ResidentHooks` with `onError(msgId: string, err: unknown): void` and wrap each turn's `promptOnce` in try/catch inside `runResident` so a single failure is recorded (bumpRetries/deadletter in session-manager) and the loop continues. Update Task 4's resident loop accordingly if not already (this task may amend it).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/service/conversation-store.actors.test.ts — ADD
it('listUnconsumedAddresses returns distinct addrs with pending, non-dead messages', () => {
  const store = createConversationStore(':memory:')
  store.upsertActor({ address: 'a1', agentDefId: 'default', sessionId: 's1', name: null, state: null, lastTaskId: null, createdAt: 1, updatedAt: 1 })
  store.enqueueMessage({ id: 'm1', toAddr: 'a1', fromAddr: null, kind: 'send', correlationId: null, payload: 'x', consumed: false, retries: 0, dead: false, ts: 1 })
  store.enqueueMessage({ id: 'm2', toAddr: 'a1', fromAddr: null, kind: 'send', correlationId: null, payload: 'y', consumed: true, retries: 0, dead: false, ts: 2 })
  expect(store.listUnconsumedAddresses()).toEqual(['a1'])
})
```

```typescript
// src/service/session-manager.redrain.test.ts
import { describe, expect, it, vi } from 'vitest'
const delivered: string[] = []
vi.mock('./agent-runner', () => ({
  createAgentRunner: (d: any) => ({ run: async () => ({ status: 'completed', summary: '', messages: [], used: {} }) }),
  buildAgentSession: () => ({}),
  runResident: async (_d: any, mailbox: any, hooks: any) => {
    for (;;) { let m; try { m = await mailbox.receive({ idleMs: 5 }) } catch { return }
      delivered.push(m.id); await hooks.acquireTurnSlot(); hooks.releaseTurnSlot(); hooks.onConsumed(m.id) }
  },
}))
import { createConversationStore } from './conversation-store'
import { createSessionManager } from './session-manager'
const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any

it('re-drains unconsumed messages for a known actor on startup', async () => {
  const store = createConversationStore(':memory:')
  // Pre-seed a session, actor, and an unconsumed message (simulating a crash).
  const mgr0 = createSessionManager({ store, broadcaster: { broadcast: () => {} }, maxConcurrent: 4, getProvider: () => fakeProvider })
  const { sessionId } = mgr0.createSession(fakeProvider)
  const a = (mgr0 as any).__ensureActorForTest(sessionId, 'default', 'w')
  store.enqueueMessage({ id: 'orphan', toAddr: a.address, fromAddr: null, kind: 'send', correlationId: null, payload: 'z', consumed: false, retries: 0, dead: false, ts: 1 })
  delivered.length = 0
  // New manager over the same store → should re-drain on init.
  createSessionManager({ store, broadcaster: { broadcast: () => {} }, maxConcurrent: 4, getProvider: () => fakeProvider })
  await new Promise((r) => setTimeout(r, 30))
  expect(delivered).toContain('orphan')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/service/conversation-store.actors.test.ts src/service/session-manager.redrain.test.ts`
Expected: FAIL — `listUnconsumedAddresses` undefined; no re-drain on init.

- [ ] **Step 3: Implement**

Store (`conversation-store.ts`): add to the type + impl:
```typescript
// type:
listUnconsumedAddresses(): string[]
// impl:
const stmtUnconsumedAddrs = db.prepare(
  `SELECT DISTINCT m.to_addr AS addr FROM messages m
   JOIN actors a ON a.address = m.to_addr
   WHERE m.consumed = 0 AND m.dead = 0`
)
// in returned object:
listUnconsumedAddresses: () => (stmtUnconsumedAddrs.all() as { addr: string }[]).map((r) => r.addr),
```

session-manager: at the end of `createSessionManager` setup (near the `getInterruptedSessions` loop), add a re-drain pass:
```typescript
// Crash recovery: re-activate actors that still have undelivered messages.
for (const address of store.listUnconsumedAddresses()) {
  const actor = store.getActor(address)
  if (!actor || !actor.sessionId) continue
  const session = getOrRehydrate(actor.sessionId)
  if (!session) continue
  const handle = residentHandles.get(address) ?? spawnResident(actor.sessionId, actor)
  const pending = store.nextUnconsumedFor(address)
  if (pending) handle.deliver(pending) // first unconsumed; loop drains the rest via store on subsequent receives
  log.info({ msg: 'redrain', address, sessionId: actor.sessionId })
}
```

> Refinement: `spawnResident`'s mailbox is fed by `deliver`, but on re-drain there may be multiple unconsumed messages already in the DB (not the mailbox). Either (a) deliver ALL unconsumed for the address into the mailbox here, or (b) have `runResident`, on each `receive` idle/empty, also poll `store.nextUnconsumedFor`. Choose (a) for simplicity: load `store` all unconsumed for the address and `deliver` each in ts order. Add `ConversationStore.allUnconsumedFor(address): ActorMessage[]` if `nextUnconsumedFor` (single) is insufficient.

Retry/deadletter (amend Task 4's loop): wrap each turn so a single `promptOnce` failure does `store.bumpRetries(msg.id)`; if the returned count `> 3`, `store.markDead(msg.id)` + `error` log; else leave unconsumed for a future drain. Continue the loop (do not throw).

- [ ] **Step 4: Run tests**

Run: `npm test -- src/service/conversation-store.actors.test.ts src/service/session-manager.redrain.test.ts`
Expected: PASS
Then: `npm test` — full suite green.

- [ ] **Step 5: Commit**

```bash
npx biome check --write src/service/conversation-store.ts src/service/session-manager.ts src/service/conversation-store.actors.test.ts src/service/session-manager.redrain.test.ts
git add -A
git commit -m "feat(session): startup crash re-drain of unconsumed messages + per-message retry/deadletter"
```

---

## Task 9: 端到端集成测试(并发兄弟协作 + 上下文累积)

**Files:**
- Test: `src/service/agent-cluster-runloop.e2e.test.ts`

**Interfaces:**
- Consumes: real `createSessionManager` + real `runResident` + real mailbox/reply-registry; mock pi `Agent`.

- [ ] **Step 1: Write the integration test**

```typescript
// src/service/agent-cluster-runloop.e2e.test.ts
import { describe, expect, it, vi } from 'vitest'

// pi Agent mock: echoes a per-actor message count so we can prove the SAME
// resident agent handled multiple messages (context accumulation within a residency).
vi.mock('@earendil-works/pi-agent-core', () => {
  class Agent {
    state = { messages: [] as any[] }
    private sub: ((e: unknown) => void) | null = null
    private n = 0
    constructor(_c: unknown) {}
    subscribe(fn: (e: unknown) => void) { this.sub = fn }
    abort() {}
    async prompt(goal: string) {
      this.n += 1
      this.sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `turn${this.n}:${goal}` } })
      this.sub?.({ type: 'agent_end' })
    }
  }
  return { Agent }
})
import { createConversationStore } from './conversation-store'
import { createSessionManager } from './session-manager'
const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any

describe('run-loop e2e', () => {
  it('two messages to the same resident actor are handled by one agent (turn count grows)', async () => {
    const store = createConversationStore(':memory:')
    const mgr = createSessionManager({ store, broadcaster: { broadcast: () => {} }, maxConcurrent: 4, getProvider: () => fakeProvider })
    const { sessionId } = mgr.createSession(fakeProvider)
    ;(mgr as any).__ensureActorForTest(sessionId, 'default', 'w')
    const r1 = await (mgr as any).__sendMessageForTest(sessionId, 'x', 'w', 'one', 'rpc')
    const r2 = await (mgr as any).__sendMessageForTest(sessionId, 'x', 'w', 'two', 'rpc')
    expect(r1.reply).toContain('turn1:one')
    expect(r2.reply).toContain('turn2:two') // same agent instance → turn count advanced
  })

  it('maxConcurrent=1 mutual-ish rpc completes (no deadlock)', async () => {
    const store = createConversationStore(':memory:')
    const mgr = createSessionManager({ store, broadcaster: { broadcast: () => {} }, maxConcurrent: 1, getProvider: () => fakeProvider })
    const { sessionId } = mgr.createSession(fakeProvider)
    ;(mgr as any).__ensureActorForTest(sessionId, 'default', 'b')
    const res = await Promise.race([
      (mgr as any).__sendMessageForTest(sessionId, 'a', 'b', 'go', 'rpc'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('DEADLOCK')), 2000)),
    ])
    expect((res as any).reply).toContain('turn1:go')
  })
})
```

- [ ] **Step 2: Run it**

Run: `npm test -- src/service/agent-cluster-runloop.e2e.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 3: Full suite + commit**

```bash
npm test
npx biome check --write src/service/agent-cluster-runloop.e2e.test.ts
git add src/service/agent-cluster-runloop.e2e.test.ts
git commit -m "test(cluster): run-loop e2e — context accumulation + no-deadlock at maxConcurrent=1"
```

---

## Self-Review(已执行)

- **Spec 覆盖**:§4.1 常驻循环 → Task 3+4;§4.2 mailbox/激活管理 → Task 1+6;§4.3 turn-slot → Task 5+7;§4.4 回信路由 → Task 2+6+7;§4.5 崩溃重放 → Task 8;§4.6 session 队列(顶层串行 / actor 并发) → Task 6(actor 走 mailbox 不进 session.queue);§6 错误处理(重试/死信/超时/孤儿回信) → Task 2+8;§7 测试(死锁回归、上下文累积、重放) → Task 7+8+9。一次常驻=一个 Task → Task 6 `spawnResident`。
- **类型一致性**:`Mailbox`/`IdleTimeoutError`(T1)被 T4/T6 引用;`ReplyRegistry`(T2)被 T6/T7;`AgentSession`/`buildAgentSession`(T3)被 T4;`ResidentHooks`/`runResident`(T4)被 T6;`residentHandles`(T5)被 T6/T7;`listUnconsumedAddresses`(T8)。签名贯穿一致。
- **占位符**:无 TBD/TODO。两处「实现时确认/可能 STOP 报告」是有意的核实点(payload 形状对齐、stopCause 重置语义、acquire/release 计数),非空泛占位 —— 各自给了判定依据与回退。
- **范围**:聚焦常驻 run-loop 单一子系统;跨休眠状态恢复明确不在内(spec §2,阶段 3)。Task 间多为 session-manager 连续改动,但每个以独立可测交付物收口(rename 回归、send 接 mailbox、死锁回归、重放)。

## 已知实现风险(给最终 review)

- `agent-runner.ts` 的 `run()` 抽取无既有单测护栏,靠 mock pi `Agent` 的新测 + 全套绿;抽取需逐行核对真实 `run()` 主体。
- turn-slot 让出/重获依赖 `acquireSlot`/`releaseSlot` 既有计数在「同一逻辑持有者 release-then-acquire」下不下溢 —— Task 7 已标注需确认。
- payload 形状(JSON 信封 vs 原始 goal 文本)需 T4/T6 对齐,计划中已标注以 T6 的 `payload = 原始 goal 文本` 为准。
