# Agent 集群跨休眠长期状态(阶段 3)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让可寻址 actor 跨休眠保留连续记忆——激活时从 `actors.state` 重放对话历史,每轮处理后与 `markConsumed` 原子持久化,配套 off-the-shelf pi 压缩防止 state 无限增长。

**Architecture:** 在已合并的 actor 基石(计划 A)+ 常驻 run-loop(计划 B)上加三件事:(1) `actor-state.ts` 编解码 helper;(2) `runResident` 每轮压缩检查后经扩展的 `onConsumed(msgId, state)` hook 持久化;(3) `conversation-store.consumeAndPersist` 把 `markConsumed` 与 `actors.state` 写入合并进一个 SQLite 事务。`spawnResident` 的 `initialMessages` 从 `[]` 改为 `decodeActorState(actor.state)`。持久化只作用于 `runResident`(可寻址 actor),一次性 `run()`/`spawnChild` 零回归。

**Tech Stack:** TypeScript,Electron(service 进程),`@earendil-works/pi-agent-core`(`Agent.compact`/`shouldCompact`/`DEFAULT_COMPACTION_SETTINGS`),`better-sqlite3`(`conversation-store`),`vitest`(经 `npm test` 跑),`pino`(结构化日志)。

## Global Constraints

- **Reply in Chinese;代码注释与 commit message 必须英文。**(CLAUDE.md §0)
- **每个业务路径打结构化日志**,pino child `component: 'actor-state'`;每个 `catch` 至少 `error` 级;结构化首参 `log.info({ msg, address })`,不做字符串插值。(CLAUDE.md §5)
- **测试经 Electron node 运行**:`npm test`。**勿**裸 `npx vitest`;**勿** `pnpm rebuild better-sqlite3`(破坏 app ABI,需 `npm run postinstall` 恢复)。(memory `project_run_tests_via_electron_node`)
- **`src/service/**` 不在 tsconfig typecheck 范围**,靠 vitest 兜类型错误。
- **外科手术式改动**,保持现有 factory+closure 风格;一次性 `run()` / 顶层 `submitGoal` / 旧式 `spawnChild` 行为**零回归**是验收硬指标。(CLAUDE.md §3)
- **TDD**:每个任务先写失败测试,再最小实现,频繁提交。
- **持久化不变量**:消息被 `markConsumed` 的那一刻,产生它的推理(`actor.state`)也已在**同一事务**落库——消费状态与记忆永不分叉。
- **biome scoped 格式化**:用 `npx biome check --write <file>`,**勿** `pnpm check/format`(会重排全仓)。(memory `reference_biome_check_hardcodes_dot`)
- **在专用 git worktree 的独立分支实现(基于 `develop`)。**(CLAUDE.md §6)

---

### Task 1: `actor-state.ts` 编解码 helper

带版本薄包装 `{ v: 1, messages }` 的纯函数编解码。`decodeActorState` 永不抛:`null`/坏 JSON/版本不符 → `[]`。

**Files:**
- Create: `src/service/actor-state.ts`
- Test: `src/service/actor-state.test.ts`

**Interfaces:**
- Consumes: `AgentMessage` from `@earendil-works/pi-agent-core`.
- Produces:
  - `encodeActorState(messages: AgentMessage[]): string`
  - `decodeActorState(raw: string | null): AgentMessage[]`
  - `ACTOR_STATE_VERSION = 1`(const,供测试断言)

- [ ] **Step 1: Write the failing test**

```ts
// src/service/actor-state.test.ts
import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

import { ACTOR_STATE_VERSION, decodeActorState, encodeActorState } from './actor-state'

const sample = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
] as unknown as AgentMessage[]

describe('actor-state codec', () => {
  it('round-trips messages through encode/decode', () => {
    const blob = encodeActorState(sample)
    expect(JSON.parse(blob)).toEqual({ v: ACTOR_STATE_VERSION, messages: sample })
    expect(decodeActorState(blob)).toEqual(sample)
  })

  it('decodes null to empty history', () => {
    expect(decodeActorState(null)).toEqual([])
  })

  it('decodes malformed JSON to empty history without throwing', () => {
    expect(decodeActorState('{not json')).toEqual([])
  })

  it('decodes a version mismatch to empty history', () => {
    const stale = JSON.stringify({ v: 999, messages: sample })
    expect(decodeActorState(stale)).toEqual([])
  })

  it('decodes a blob missing messages to empty history', () => {
    const bad = JSON.stringify({ v: ACTOR_STATE_VERSION })
    expect(decodeActorState(bad)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/actor-state.test.ts`
Expected: FAIL — `Cannot find module './actor-state'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/service/actor-state.ts
import type { AgentMessage } from '@earendil-works/pi-agent-core'

// Cross-dormancy actor memory: the addressable actor's conversation history is
// externalized to actors.state as a versioned JSON blob, replayed on activation
// and persisted each turn. The version tag lets a future pi message-format
// change be detected on replay and discarded gracefully rather than crashing
// deserialization.
export const ACTOR_STATE_VERSION = 1

type ActorStateBlob = { v: number; messages: AgentMessage[] }

export function encodeActorState(messages: AgentMessage[]): string {
  return JSON.stringify({ v: ACTOR_STATE_VERSION, messages } satisfies ActorStateBlob)
}

// Never throws: a null/corrupt/version-mismatched blob yields an empty history
// so the actor restarts clean (caller logs a warn). A clean restart beats a
// crash on replay.
export function decodeActorState(raw: string | null): AgentMessage[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Partial<ActorStateBlob>
    if (parsed.v !== ACTOR_STATE_VERSION || !Array.isArray(parsed.messages)) return []
    return parsed.messages
  } catch {
    return []
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/actor-state.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Format + commit**

```bash
npx biome check --write src/service/actor-state.ts src/service/actor-state.test.ts
git add src/service/actor-state.ts src/service/actor-state.test.ts
git commit -m "feat(actor-state): versioned encode/decode for cross-dormancy memory"
```

---

### Task 2: `conversation-store.consumeAndPersist`(原子事务)

新增一个事务方法,把 `markConsumed` 与 `actors.state` 的定向 UPDATE 合并进一个 SQLite 事务。用定向 `UPDATE actors SET state=?, updated_at=?`,**不**走全行 `upsertActor`(避免覆盖 `last_task_id`/`name`)。

**Files:**
- Modify: `src/service/conversation-store.ts`(接口 `:78-90` 加方法;实现处加 prepared statement + `db.transaction`,与 `markAndGetInterrupted`(`:388`)/`deleteSessionTx`(`:433`)同风格;`return {}` 对象暴露)
- Test: `src/service/conversation-store.actor-state.test.ts`

**Interfaces:**
- Consumes: 既有 `db`、`stmtMarkConsumed`(`:328`)、`enqueueMessage`/`upsertActor`/`getActor`/`getMessageById`(若无取消息按 id 的方法,本任务用 `nextUnconsumedFor` 验证 consumed 翻转)。
- Produces(加到 `ConversationStore` 接口与返回对象):
  - `consumeAndPersist(msgId: string, address: string, state: string, updatedAt: number): void`

- [ ] **Step 1: Write the failing test**

```ts
// src/service/conversation-store.actor-state.test.ts
import { describe, expect, it } from 'vitest'

import { createConversationStore } from './conversation-store'

function freshStore() {
  // In-memory SQLite: dbPath ':memory:' (matches existing store tests).
  return createConversationStore(':memory:')
}

describe('consumeAndPersist', () => {
  it('marks the message consumed AND writes actor.state in one shot', () => {
    const store = freshStore()
    const now = 1_000
    store.upsertActor({
      address: 'a1',
      agentDefId: 'default',
      sessionId: 's1',
      name: null,
      state: null,
      lastTaskId: 't1',
      createdAt: now,
      updatedAt: now,
    })
    store.enqueueMessage({
      id: 'm1', toAddr: 'a1', fromAddr: null, kind: 'send',
      correlationId: null, payload: 'hi', consumed: false, retries: 0, dead: false, ts: now,
    })

    store.consumeAndPersist('m1', 'a1', '{"v":1,"messages":[]}', 2_000)

    expect(store.nextUnconsumedFor('a1')).toBeUndefined() // consumed
    const actor = store.getActor('a1')
    expect(actor?.state).toBe('{"v":1,"messages":[]}')
    expect(actor?.updatedAt).toBe(2_000)
    expect(actor?.lastTaskId).toBe('t1') // untouched by the targeted UPDATE
    store.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/conversation-store.actor-state.test.ts`
Expected: FAIL — `store.consumeAndPersist is not a function`.

> 若 `createConversationStore(':memory:')` 在既有 store 测试中不是这样初始化,照既有 store 测试的建库方式调整(查 `conversation-store.test.ts` 的 setup),保持一致。`ActorMessage`/`Actor` 字段名以 `src/shared/types/actor.ts` 为准。

- [ ] **Step 3: Add to the interface**

`src/service/conversation-store.ts` 接口块(`markConsumed(id: string): void` 之后,`:85` 附近):

```ts
  markConsumed(id: string): void
  // Atomically mark a message consumed AND persist the actor's conversation
  // state, so consumption and memory never diverge across a crash. Targeted
  // UPDATE on state/updated_at only — does not touch last_task_id/name.
  consumeAndPersist(msgId: string, address: string, state: string, updatedAt: number): void
```

- [ ] **Step 4: Implement the transaction**

在 prepared statements 区(`stmtMarkConsumed` 附近,`:328`)加:

```ts
  const stmtPersistActorState = db.prepare('UPDATE actors SET state = ?, updated_at = ? WHERE address = ?')
  const consumeAndPersistTx = db.transaction((msgId: string, address: string, state: string, updatedAt: number) => {
    stmtMarkConsumed.run(msgId)
    stmtPersistActorState.run(state, updatedAt, address)
  })
```

在返回对象里(`markConsumed` 暴露处附近)加:

```ts
    consumeAndPersist: (msgId, address, state, updatedAt) =>
      consumeAndPersistTx(msgId, address, state, updatedAt),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/service/conversation-store.actor-state.test.ts`
Expected: PASS.

- [ ] **Step 6: Format + commit**

```bash
npx biome check --write src/service/conversation-store.ts src/service/conversation-store.actor-state.test.ts
git add src/service/conversation-store.ts src/service/conversation-store.actor-state.test.ts
git commit -m "feat(store): consumeAndPersist — atomic markConsumed + actor.state write"
```

---

### Task 3: `AgentSession` 暴露 `contextWindow` + `getContextTokens`

`runResident` 的压缩检查需读最近 turn 的上下文占用。复用 `buildAgentSession` 内部已维护的 `contextTokens`(`:562`)与 `model.contextWindow`,不重算。

**Files:**
- Modify: `src/service/agent-runner.ts`（`AgentSession` 类型 `:139-147`;`buildAgentSession` 的两个 return：`failedSession()` `:369` 与正常 return `:680` 附近）
- Test: `src/service/agent-runner.session.test.ts`(既有文件追加;若不便则新建 `agent-runner.context-tokens.test.ts`)

**Interfaces:**
- Consumes: 内部 `contextTokens`(`:350` let)、`model.contextWindow`、`DEFAULT_CONTEXT_WINDOW`(setup 失败回退)。
- Produces(加到 `AgentSession`):
  - `readonly contextWindow: number`
  - `getContextTokens(): number`

- [ ] **Step 1: Write the failing test**

先查 `agent-runner.session.test.ts` 现有 stub/setup 怎么构造 `buildAgentSession`(provider、deps)。追加:

```ts
it('exposes contextWindow and a getContextTokens snapshot', () => {
  // Reuse this file's existing buildAgentSession setup (provider + deps stub).
  const session = buildAgentSession(deps)
  expect(typeof session.contextWindow).toBe('number')
  expect(session.contextWindow).toBeGreaterThan(0)
  expect(session.getContextTokens()).toBe(0) // no turn run yet
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/agent-runner.session.test.ts`
Expected: FAIL — `session.contextWindow` undefined / `getContextTokens is not a function`.

- [ ] **Step 3: Extend the AgentSession type**

`src/service/agent-runner.ts:139`:

```ts
export type AgentSession = {
  promptOnce(
    goal: string,
    images?: ImageContent[]
  ): Promise<{ status: 'completed' | 'failed' | 'cancelled'; summary: string }>
  readonly agent: Agent
  getUsed(): ConsumedResources
  abort(): void
  // Latest turn's context occupancy + the model window — drives the resident
  // loop's compaction check (reuses the snapshot refreshed at each turn_end).
  readonly contextWindow: number
  getContextTokens(): number
}
```

- [ ] **Step 4: Populate both return paths**

`failedSession()`(`:369`)加字段(setup 失败时窗口取默认,占用 0):

```ts
  const failedSession = (): AgentSession => ({
    promptOnce: async () => ({ status: 'failed', summary: '' }),
    agent: { state: { messages: initialMessages } } as unknown as Agent,
    getUsed: () => emptyUsed(),
    abort: () => undefined,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    getContextTokens: () => 0,
  })
```

正常 return（`:680` 附近，与 `promptOnce`/`agent`/`getUsed`/`abort` 并列）加:

```ts
    contextWindow: model.contextWindow,
    getContextTokens: () => contextTokens,
```

> `DEFAULT_CONTEXT_WINDOW` 已在本文件引用(`:72`)。`model`/`contextTokens` 在正常 return 作用域内可见。

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/service/agent-runner.session.test.ts`
Expected: PASS.

- [ ] **Step 6: Format + commit**

```bash
npx biome check --write src/service/agent-runner.ts src/service/agent-runner.session.test.ts
git add src/service/agent-runner.ts src/service/agent-runner.session.test.ts
git commit -m "feat(agent-runner): expose contextWindow + getContextTokens on AgentSession"
```

---

### Task 4: `runResident` 每轮压缩 + state 经 hook 持久化

`ResidentHooks.onConsumed` 加 `state` 参数;`runResident` 每轮 `promptOnce` 后做压缩检查,序列化 `agent.state.messages`,经 hook 持久化。压缩失败不致命。

**Files:**
- Modify: `src/service/agent-runner.ts`（`ResidentHooks` 类型 `:707-713`;`runResident` 循环 `:751-753`;顶部 import 加 `shouldCompact`/`DEFAULT_COMPACTION_SETTINGS`;import 加 `encodeActorState`）
- Test: `src/service/agent-runner.resident.test.ts`(既有文件追加)

**Interfaces:**
- Consumes: Task 1 `encodeActorState`;Task 3 `session.contextWindow`/`getContextTokens`;pi `shouldCompact(contextTokens, contextWindow, settings)`、`DEFAULT_COMPACTION_SETTINGS`、`Agent.compact()`。
- Produces:
  - `ResidentHooks.onConsumed(msgId: string, state: string): void`（签名变更）

- [ ] **Step 1: Write the failing test**

`agent-runner.resident.test.ts` 已有 stub agent（记录 `state.messages`)。追加:`onConsumed` 现在带 `state`,且能往返。

```ts
it('persists encoded actor state via onConsumed each turn', async () => {
  // Reuse this file's existing stub: a fake Agent whose state.messages grows
  // per promptOnce, a mailbox delivering one message then idling out.
  const consumed: Array<{ id: string; state: string }> = []
  const hooks = makeHooks({ onConsumed: (id: string, state: string) => consumed.push({ id, state }) })

  await runResident(deps, mailboxWithOneMessage('m1', 'hello'), hooks, 20)

  expect(consumed).toHaveLength(1)
  expect(consumed[0].id).toBe('m1')
  // State is the versioned blob carrying the stub agent's accumulated messages.
  expect(JSON.parse(consumed[0].state)).toMatchObject({ v: 1 })
  expect(JSON.parse(consumed[0].state).messages.length).toBeGreaterThan(0)
})
```

> 用本文件既有的 `deps`/stub-agent/`makeHooks`/mailbox 工具;若名字不同,照既有测试命名。压缩在此默认不触发(stub 的 `getContextTokens` 返回 0 < 阈值),故只验证持久化路径。

并追加压缩**触发**分支用例(覆盖 spec §6 压缩):

```ts
it('compacts before persisting when context exceeds threshold', async () => {
  // Stub session whose getContextTokens() reports above the window so
  // shouldCompact() returns true; stub agent.compact() bumps a counter.
  let compacts = 0
  const session = makeStubSession({
    getContextTokens: () => 10_000_000, // >> contextWindow
    contextWindow: 200_000,
    agent: { compact: async () => { compacts++; return { summary: 's', firstKeptEntryId: 'x', tokensBefore: 9_999 } } },
  })
  // Inject the stub session into runResident (via the same seam buildAgentSession
  // is stubbed in this file's existing tests).
  await runResidentWith(session, mailboxWithOneMessage('m1', 'x'), makeHooks(), 20)
  expect(compacts).toBe(1)
})
```

> 若本文件用 `vi.mock`/工厂注入 `buildAgentSession`,沿用既有注入方式喂入上面的 stub session;关键断言是 `agent.compact()` 恰被调一次。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/agent-runner.resident.test.ts`
Expected: FAIL — `onConsumed` 收到的 state 为 `undefined` / 类型不符 / `consumed[0].state` 解析失败。

- [ ] **Step 3: Update imports + ResidentHooks type**

`agent-runner.ts` 顶部 import(与既有 `import { Agent } from '@earendil-works/pi-agent-core'` 合并/相邻):

```ts
import { Agent, DEFAULT_COMPACTION_SETTINGS, shouldCompact } from '@earendil-works/pi-agent-core'
import { encodeActorState } from './actor-state'
```

`ResidentHooks`(`:707`):

```ts
export type ResidentHooks = {
  acquireTurnSlot(): Promise<void>
  releaseTurnSlot(): void
  // Atomic: mark the message consumed AND persist the actor's conversation
  // state (cross-dormancy memory). The loop serializes agent.state.messages
  // after an optional compaction and hands the blob here.
  onConsumed(msgId: string, state: string): void
  onReply(correlationId: string, summary: string): void
  onError(msgId: string): void
}
```

- [ ] **Step 4: Update the runResident loop body**

`runResident` 的 try 块(`:750-754`)替换为:

```ts
      residentLog.info({ msg: 'turn-start', address: deps.selfAddress, msgId: msg.id, kind: msg.kind })
      const { summary } = await session.promptOnce(msg.payload)
      // Compaction (off-the-shelf pi): keep persisted state bounded across
      // many activations. Failure is non-fatal — persist uncompacted; keeping
      // memory beats losing it.
      try {
        if (shouldCompact(session.getContextTokens(), session.contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
          const { tokensBefore } = await session.agent.compact()
          residentLog.info({ msg: 'compact', address: deps.selfAddress, tokensBefore, component: 'actor-state' })
        }
      } catch (err) {
        residentLog.error({
          msg: 'compact-failed',
          address: deps.selfAddress,
          err: err instanceof Error ? err.message : String(err),
          component: 'actor-state',
        })
      }
      const state = encodeActorState(session.agent.state.messages)
      residentLog.info({ msg: 'persist', address: deps.selfAddress, msgId: msg.id, component: 'actor-state' })
      hooks.onConsumed(msg.id, state)
      if (msg.kind === 'rpc' && msg.correlationId) hooks.onReply(msg.correlationId, summary)
      residentLog.info({ msg: 'turn-end', address: deps.selfAddress, msgId: msg.id })
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/service/agent-runner.resident.test.ts`
Expected: PASS.

- [ ] **Step 6: Format + commit**

```bash
npx biome check --write src/service/agent-runner.ts src/service/agent-runner.resident.test.ts
git add src/service/agent-runner.ts src/service/agent-runner.resident.test.ts
git commit -m "feat(agent-runner): resident loop compacts + persists actor state per turn"
```

---

### Task 5: `spawnResident` 接线——重放 + 改 hook

`session-manager.spawnResident` 的 `initialMessages` 从 `[]` 改为 `decodeActorState(actor.state)`(失败 warn);`onConsumed` hook 改调 `store.consumeAndPersist`。

**Files:**
- Modify: `src/service/session-manager.ts`（`spawnResident`：import `decodeActorState`;`onConsumed` hook `:268`;`initialMessages: []` `:290`)
- Test: `src/service/session-manager.cross-dormancy.test.ts`

**Interfaces:**
- Consumes: Task 1 `decodeActorState`;Task 2 `store.consumeAndPersist`;`store.getActor`(已有)。
- Produces: 无新导出（接线层）。

- [ ] **Step 1: Write the failing test**

端到端:首次激活落库 state → 休眠 → 再次激活时 prompt 能看到上次历史。用既有 session-manager 测试的 stub agent / fake clock / 短 idle。

```ts
// src/service/session-manager.cross-dormancy.test.ts
it('replays persisted actor state on re-activation (memory survives dormancy)', async () => {
  // Reuse the harness from session-manager's resident tests: a stub agent that
  // echoes the initialMessages it was built with, fake timers for idle-sleep.
  const sm = makeSessionManager(/* stub provider/store as in existing tests */)
  const addr = await sm.spawnNamedActor('s1', 'researcher-1', 'default')

  await sm.sendMessage('s1', null, addr, 'remember: sky is blue', 'send')
  await advanceToIdleSleep() // resident drains m1, persists state, idles out

  const seen: AgentMessage[][] = []
  // Second activation: stub records the initialMessages it receives.
  onStubBuild((init) => seen.push(init))
  await sm.sendMessage('s1', null, addr, 'what colour is the sky?', 'send')
  await advanceToIdleSleep()

  // The re-activation was seeded with the first turn's accumulated history.
  expect(seen.at(-1)?.length).toBeGreaterThan(0)
})
```

> 以 `session-manager` 既有 resident/idle 测试(`5f7f358`/`3b36cf3` 引入)的 helper 名称为准——`spawnNamedActor`/`advanceToIdleSleep`/`onStubBuild` 若不存在,用既有等价工具替换。重点是断言**第二次激活的 `initialMessages` 非空**。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/session-manager.cross-dormancy.test.ts`
Expected: FAIL — 第二次激活 `initialMessages` 为空(当前硬编码 `[]`)。

- [ ] **Step 3: Import the codec**

`session-manager.ts` 顶部 import(与既有 `import { ... runResident } from './agent-runner'` 相邻):

```ts
import { decodeActorState } from './actor-state'
```

- [ ] **Step 4: Replay on activation**

`spawnResident` 内,`deps` 组装前(`:282` 之前)加:

```ts
    const restored = decodeActorState(actor.state)
    if (actor.state && restored.length === 0) {
      log.warn({
        msg: 'actor state decode failed, starting fresh',
        sessionId,
        address: actor.address,
        component: 'actor-state',
      })
    } else if (restored.length > 0) {
      log.info({
        msg: 'actor state replayed',
        sessionId,
        address: actor.address,
        messageCount: restored.length,
        component: 'actor-state',
      })
    }
```

把 `deps` 的 `initialMessages: []`(`:290`)改为:

```ts
      initialMessages: restored,
```

- [ ] **Step 5: Persist via consumeAndPersist**

`hooks` 的 `onConsumed`(`:268`)改为:

```ts
      onConsumed: (msgId, state) => store.consumeAndPersist(msgId, actor.address, state, Date.now()),
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- src/service/session-manager.cross-dormancy.test.ts`
Expected: PASS.

- [ ] **Step 7: Format + commit**

```bash
npx biome check --write src/service/session-manager.ts src/service/session-manager.cross-dormancy.test.ts
git add src/service/session-manager.ts src/service/session-manager.cross-dormancy.test.ts
git commit -m "feat(session): replay actor state on activate + persist via consumeAndPersist"
```

---

### Task 6: 全量回归 + state 字段注释 + 收尾

确认计划 A/B 全绿、一次性路径零回归;更新 `Actor.state` 注释。

**Files:**
- Modify: `src/shared/types/actor.ts:13`(注释)

**Interfaces:** 无。

- [ ] **Step 1: 更新 state 字段注释**

`src/shared/types/actor.ts:13`:

```ts
  state: string | null // JSON {v,messages}: cross-dormancy conversation memory (phase 3)
```

- [ ] **Step 2: 跑全量测试套件**

Run: `npm test`
Expected: 全绿。重点核对:计划 A messaging 测试(`messaging.test.ts`/`builtins.test.ts`)、计划 B 死锁/常驻/重放/idle 测试、一次性 `run()`/`spawnChild` 测试均未回归。

- [ ] **Step 3: 若有回归则修复**

任一既有测试因 `onConsumed` 签名变更或 `initialMessages` 变更而失败:定位该调用点,按新签名修正(`onConsumed` 的所有桩/调用须传 `state`)。修完重跑 `npm test` 直到全绿。

- [ ] **Step 4: Format + commit**

```bash
npx biome check --write src/shared/types/actor.ts
git add src/shared/types/actor.ts
git commit -m "docs(actor): mark state column as cross-dormancy memory (phase 3 done)"
```

- [ ] **Step 5: 收尾(交给 finishing-a-development-branch)**

全绿后,用 `superpowers:finishing-a-development-branch` 决定合并/PR/清理 worktree。

---

## Self-Review

**1. Spec coverage:**
- spec §4.1 编解码 → Task 1 ✅
- spec §4.2 激活重放 → Task 5 Step 4 ✅
- spec §4.3 每轮压缩 + 持久化 + hook 签名 → Task 3(暴露 token)+ Task 4(循环) ✅
- spec §4.4 原子持久化(定向 UPDATE) → Task 2 ✅
- spec §5 错误边界:解码失败 warn(Task 5 Step 4)/ compact 失败兜底(Task 4 Step 4)/ 事务回滚(Task 2 走既有 retry)/ abort 自洽(无需代码,既有 `onError` 路径)/ 一次性路径隔离(Task 6 回归)✅
- spec §6 测试:编解码(T1)/ 原子性(T2)/ 重放连贯(T5)/ 压缩(T4 默认不触发已覆盖持久化路径;压缩触发分支见下方补充)/ 解码失败(T1 + T5 warn)/ 回归(T6)✅
- spec §7 文件结构 → Task 1-6 文件清单一致 ✅

**2. Placeholder scan:** 无 TBD/TODO;每个 code step 含完整代码;测试 helper 处明确标注"以既有测试命名为准"并给出回退,非占位。

**3. Type consistency:** `onConsumed(msgId, state)` 在 Task 4(定义)与 Task 5(调用 `consumeAndPersist(msgId, actor.address, state, Date.now())`)签名一致;`consumeAndPersist(msgId, address, state, updatedAt)` Task 2 定义与 Task 5 调用一致;`encodeActorState`/`decodeActorState` 跨 Task 1/4/5 一致;`getContextTokens()`/`contextWindow` Task 3 定义与 Task 4 使用一致。

**压缩两分支均覆盖**:Task 4 Step 1 含"不触发"(只验持久化)与"触发"(断言 `agent.compact()` 恰调一次)两个用例,对齐 spec §6。
