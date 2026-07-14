# Agent 集群:可寻址 + 同辈消息(计划 A)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Agent 引入稳定地址(Actor)与持久化收件箱,让同一 session 内的 Agent 能通过 `send_message`(投递即走)和 `send_and_wait`(RPC,等回信)互相通信;每条消息激活目标 actor 一次,跑完休眠。

**Architecture:** 在 `conversation-store` 同一 SQLite 上新增 `actors` / `messages` 两张表(纯持久化)。session-manager 新增「激活管理器」:`sendMessage(to, payload, kind)` 解析目标地址 → 复用现有 `acquireSlot`+`createAgentRunner` 那条路把目标 actor 跑一次。`send_and_wait` 是「激活并 await summary」(现有 `spawnChild` 的推广);`send` 是「激活但不 await」。本计划**不改** `AgentRunner.run()` 的循环(常驻虚拟 actor 留给计划 B)。

**Tech Stack:** TypeScript / Electron 主+service 进程;`better-sqlite3`(prepared statements);`@earendil-works/pi-agent-core`(Agent loop);`@earendil-works/pi-ai`(`Type.*` 工具参数 schema);Vitest(经 Electron node 运行);`pino` 结构化日志;`ulid` 生成 id。

## Global Constraints

- **语言**:代码注释与 commit message 一律英文;不写日文。
- **日志**(CLAUDE.md §5):每个业务路径有 `pino` 结构化日志;每个 `catch` 至少 `error` 级、绝不静默吞掉;入口 `info`、异常分支 `warn`。新模块用 `createLogger({ process: 'service' }).child({ component: '<module>' })`。
- **测试运行**:`npm test`(经 Electron node);**禁止** `pnpm rebuild better-sqlite3`(破坏 app ABI),误装后用 `npm run postinstall` 恢复;不要用裸 `npx vitest`。
- **typecheck 盲区**:`src/service/**` 不在 tsconfig typecheck 范围(electron-vite 打包),靠 vitest 兜类型错误。
- **格式化**:scoped 格式化用 `npx biome check --write <file>`(`pnpm check`/`format` 会重排整个 repo)。
- **代码风格**:外科手术式改动,匹配现有风格(factory + closure 的 store/manager 写法);不顺手重构无关代码。
- **worktree**(CLAUDE.md §6):本计划在专用 git worktree 的独立分支上实现。
- **id 生成**:用 `ulid()`(与现有 `session-manager.ts` 一致),勿用 `Date.now()` 之外的随机源混入。

---

## File Structure

- **新增** `src/shared/types/actor.ts` —— `Actor`、`ActorMessage` 类型 + zod schema(若现有 types 用 zod);仅类型则纯 TS。
- **修改** `src/service/conversation-store.ts` —— `db.exec` 加 `actors`/`messages` 表;`ConversationStore` 接口加 actor/message CRUD 方法 + 实现。
- **修改** `src/service/session-manager.ts` —— 新增 `sendMessage` / 地址解析 / 激活逻辑;`spawnChild` 复用激活路;`runHandles` 暂不改键(仍按 taskId,计划 B 再升级为按 address)。
- **修改** `src/service/agent-runner.ts` —— `AgentRunnerDeps` 加 `selfAddress`、`sendMessage` 回调;**不改** `run()` 循环。
- **修改** `src/service/tools/registry.ts` —— `ToolRunContext` 加 `selfAddress`、`sendMessage`、`sendAndWait`。
- **新增** `src/service/tools/messaging.ts` —— `sendMessageSpec`、`sendAndWaitSpec`、`whoamiSpec` 三个 `ToolSpec`,归 `agent` 组。
- **修改** `src/service/tools/builtins.ts` —— 注册上面三个工具。
- **修改** `src/main/dispatcher`(submitGoal 链路)—— 透传 `agentDef`(场景① 缺陷修复)。具体文件名实现时确认(疑似 `src/main/*dispatch*` 或 ipc 层)。

> **实现前置动作**:本计划基于 3 天内的代码快照。开工第一步先 `git log`/读取上述文件确认现状,尤其 `dispatcher.submitGoal` 是否真的丢 `agentDef`、`ToolRunContext` 的确切形状。以实际代码为准,有出入则就地调整任务。

---

## Task 1: Actor / ActorMessage 类型

**Files:**
- Create: `src/shared/types/actor.ts`
- Test: `src/shared/types/actor.test.ts`

**Interfaces:**
- Produces:
  - `type Actor = { address: string; agentDefId: string; sessionId: string | null; name: string | null; state: string | null; lastTaskId: string | null; createdAt: number; updatedAt: number }`
  - `type ActorMessage = { id: string; toAddr: string; fromAddr: string | null; kind: 'send' | 'rpc'; correlationId: string | null; payload: string; consumed: boolean; retries: number; dead: boolean; ts: number }`
  - `MessageKindSchema`(zod enum `['send','rpc']`)

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/types/actor.test.ts
import { describe, expect, it } from 'vitest'
import { MessageKindSchema } from './actor'

describe('actor types', () => {
  it('MessageKindSchema accepts send and rpc, rejects others', () => {
    expect(MessageKindSchema.parse('send')).toBe('send')
    expect(MessageKindSchema.parse('rpc')).toBe('rpc')
    expect(MessageKindSchema.safeParse('broadcast').success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/shared/types/actor.test.ts`
Expected: FAIL — cannot resolve `./actor`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/shared/types/actor.ts
import { z } from 'zod'

export const MessageKindSchema = z.enum(['send', 'rpc'])
export type MessageKind = z.infer<typeof MessageKindSchema>

// A long-lived addressable identity. One Actor maps to many Tasks (activations).
export type Actor = {
  address: string // ULID, or a user/agent-chosen readable name
  agentDefId: string
  sessionId: string | null
  name: string | null
  state: string | null // JSON; reserved for phase 3 (stateful collaboration), unused here
  lastTaskId: string | null
  createdAt: number
  updatedAt: number
}

// A persisted inbox entry addressed to an Actor.
export type ActorMessage = {
  id: string
  toAddr: string
  fromAddr: string | null
  kind: MessageKind
  correlationId: string | null // links an rpc reply back to its caller
  payload: string // JSON
  consumed: boolean
  retries: number
  dead: boolean
  ts: number
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/shared/types/actor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/actor.ts src/shared/types/actor.test.ts
git commit -m "feat(types): add Actor and ActorMessage types"
```

---

## Task 2: `actors` / `messages` 表 + Store CRUD

**Files:**
- Modify: `src/service/conversation-store.ts`(`db.exec` schema 块;`ConversationStore` 接口与实现)
- Test: `src/service/conversation-store.actors.test.ts`

**Interfaces:**
- Consumes: `Actor`, `ActorMessage` from Task 1.
- Produces (新增到 `ConversationStore`):
  - `upsertActor(actor: Actor): void`
  - `getActor(address: string): Actor | undefined`
  - `getActorByName(sessionId: string, name: string): Actor | undefined`
  - `enqueueMessage(msg: ActorMessage): void`
  - `nextUnconsumedFor(address: string): ActorMessage | undefined`(按 `ts` 升序、`dead=0`、`consumed=0`)
  - `markConsumed(id: string): void`
  - `markDead(id: string): void`
  - `bumpRetries(id: string): number`(返回新 retries 值)

- [ ] **Step 1: Write the failing test**

```typescript
// src/service/conversation-store.actors.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createConversationStore, type ConversationStore } from './conversation-store'

let store: ConversationStore
beforeEach(() => {
  store = createConversationStore(':memory:')
})
afterEach(() => store.close())

const now = 1_000

describe('actor persistence', () => {
  it('upserts and reads an actor by address and by name', () => {
    store.upsertActor({
      address: 'addr-1', agentDefId: 'default', sessionId: 's1', name: 'researcher-1',
      state: null, lastTaskId: null, createdAt: now, updatedAt: now,
    })
    expect(store.getActor('addr-1')?.agentDefId).toBe('default')
    expect(store.getActorByName('s1', 'researcher-1')?.address).toBe('addr-1')
    expect(store.getActorByName('s1', 'nope')).toBeUndefined()
  })

  it('enqueues, reads next unconsumed in ts order, and marks consumed', () => {
    store.upsertActor({
      address: 'addr-1', agentDefId: 'default', sessionId: 's1', name: null,
      state: null, lastTaskId: null, createdAt: now, updatedAt: now,
    })
    store.enqueueMessage({ id: 'm2', toAddr: 'addr-1', fromAddr: null, kind: 'send', correlationId: null, payload: '{}', consumed: false, retries: 0, dead: false, ts: 20 })
    store.enqueueMessage({ id: 'm1', toAddr: 'addr-1', fromAddr: null, kind: 'send', correlationId: null, payload: '{}', consumed: false, retries: 0, dead: false, ts: 10 })
    expect(store.nextUnconsumedFor('addr-1')?.id).toBe('m1') // earliest ts first
    store.markConsumed('m1')
    expect(store.nextUnconsumedFor('addr-1')?.id).toBe('m2')
  })

  it('marks dead and bumps retries', () => {
    store.enqueueMessage({ id: 'm1', toAddr: 'ghost', fromAddr: null, kind: 'send', correlationId: null, payload: '{}', consumed: false, retries: 0, dead: false, ts: 10 })
    expect(store.bumpRetries('m1')).toBe(1)
    store.markDead('m1')
    expect(store.nextUnconsumedFor('ghost')).toBeUndefined() // dead excluded
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/conversation-store.actors.test.ts`
Expected: FAIL — `upsertActor` is not a function.

- [ ] **Step 3: Add tables to the `db.exec` block**

在 `conversation-store.ts` 的 `db.exec(\`...\`)` schema 块末尾(`tool_state_snapshots` 之后、cron 表附近)追加:

```sql
    CREATE TABLE IF NOT EXISTS actors (
      address       TEXT PRIMARY KEY,
      agent_def_id  TEXT NOT NULL,
      session_id    TEXT,
      name          TEXT,
      state         TEXT,
      last_task_id  TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_actors_session_name ON actors(session_id, name);
    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      to_addr         TEXT NOT NULL,
      from_addr       TEXT,
      kind            TEXT NOT NULL,
      correlation_id  TEXT,
      payload         TEXT NOT NULL,
      consumed        INTEGER NOT NULL DEFAULT 0,
      retries         INTEGER NOT NULL DEFAULT 0,
      dead            INTEGER NOT NULL DEFAULT 0,
      ts              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_addr, consumed, dead, ts);
```

- [ ] **Step 4: Add the methods to the interface and implementation**

在 `ConversationStore` type 中加方法签名(Task 2 Interfaces 段所列)。在 `createConversationStore` 内,prepared statements + 方法实现(沿用文件现有 prepared-statement 风格):

```typescript
  const upsertActorStmt = db.prepare(`
    INSERT INTO actors (address, agent_def_id, session_id, name, state, last_task_id, created_at, updated_at)
    VALUES (@address, @agentDefId, @sessionId, @name, @state, @lastTaskId, @createdAt, @updatedAt)
    ON CONFLICT(address) DO UPDATE SET
      agent_def_id = excluded.agent_def_id, session_id = excluded.session_id, name = excluded.name,
      state = excluded.state, last_task_id = excluded.last_task_id, updated_at = excluded.updated_at
  `)
  const getActorStmt = db.prepare('SELECT * FROM actors WHERE address = ?')
  const getActorByNameStmt = db.prepare('SELECT * FROM actors WHERE session_id = ? AND name = ?')
  const enqueueMessageStmt = db.prepare(`
    INSERT INTO messages (id, to_addr, from_addr, kind, correlation_id, payload, consumed, retries, dead, ts)
    VALUES (@id, @toAddr, @fromAddr, @kind, @correlationId, @payload, @consumed, @retries, @dead, @ts)
  `)
  const nextUnconsumedStmt = db.prepare(
    'SELECT * FROM messages WHERE to_addr = ? AND consumed = 0 AND dead = 0 ORDER BY ts ASC LIMIT 1'
  )
  const markConsumedStmt = db.prepare('UPDATE messages SET consumed = 1 WHERE id = ?')
  const markDeadStmt = db.prepare('UPDATE messages SET dead = 1 WHERE id = ?')
  const bumpRetriesStmt = db.prepare('UPDATE messages SET retries = retries + 1 WHERE id = ?')
  const getRetriesStmt = db.prepare('SELECT retries FROM messages WHERE id = ?')

  type ActorRow = {
    address: string; agent_def_id: string; session_id: string | null; name: string | null
    state: string | null; last_task_id: string | null; created_at: number; updated_at: number
  }
  const rowToActor = (r: ActorRow): import('@shared/types/actor').Actor => ({
    address: r.address, agentDefId: r.agent_def_id, sessionId: r.session_id, name: r.name,
    state: r.state, lastTaskId: r.last_task_id, createdAt: r.created_at, updatedAt: r.updated_at,
  })
  type MessageRow = {
    id: string; to_addr: string; from_addr: string | null; kind: string; correlation_id: string | null
    payload: string; consumed: number; retries: number; dead: number; ts: number
  }
  const rowToMessage = (r: MessageRow): import('@shared/types/actor').ActorMessage => ({
    id: r.id, toAddr: r.to_addr, fromAddr: r.from_addr, kind: r.kind as 'send' | 'rpc',
    correlationId: r.correlation_id, payload: r.payload, consumed: !!r.consumed,
    retries: r.retries, dead: !!r.dead, ts: r.ts,
  })
```

方法体(放进返回的对象里):

```typescript
    upsertActor(actor) {
      upsertActorStmt.run(actor)
    },
    getActor(address) {
      const row = getActorStmt.get(address) as ActorRow | undefined
      return row ? rowToActor(row) : undefined
    },
    getActorByName(sessionId, name) {
      const row = getActorByNameStmt.get(sessionId, name) as ActorRow | undefined
      return row ? rowToActor(row) : undefined
    },
    enqueueMessage(msg) {
      enqueueMessageStmt.run({
        ...msg, consumed: msg.consumed ? 1 : 0, dead: msg.dead ? 1 : 0,
      })
    },
    nextUnconsumedFor(address) {
      const row = nextUnconsumedStmt.get(address) as MessageRow | undefined
      return row ? rowToMessage(row) : undefined
    },
    markConsumed(id) {
      markConsumedStmt.run(id)
    },
    markDead(id) {
      markDeadStmt.run(id)
    },
    bumpRetries(id) {
      bumpRetriesStmt.run(id)
      return (getRetriesStmt.get(id) as { retries: number } | undefined)?.retries ?? 0
    },
```

> 注:`enqueueMessage` 的 `payload`/`correlationId`/`fromAddr` 可空,better-sqlite3 接受 `null`。`@name`/`@state` 等命名参数对象传 `null` 即写 NULL。

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/service/conversation-store.actors.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
npx biome check --write src/service/conversation-store.ts src/service/conversation-store.actors.test.ts
git add src/service/conversation-store.ts src/service/conversation-store.actors.test.ts
git commit -m "feat(store): persist actors and message inbox tables"
```

---

## Task 3: 地址解析助手(ULID + 可读命名)

**Files:**
- Modify: `src/service/session-manager.ts`(新增内部 `resolveActor` / `ensureActor` 助手)
- Test: `src/service/session-manager.actors.test.ts`

**Interfaces:**
- Consumes: `ConversationStore` actor 方法(Task 2)。
- Produces(session-manager 内部,非导出;通过 sendMessage 行为间接测试):
  - `ensureActor(sessionId, agentDefId, name?): Actor` —— 有 name 且已存在则复用,否则新建(ULID 地址 + 可选 name)。
  - 地址解析:`send` 的 `to` 既可是 ULID 地址,也可是 `name`(同 session 内)。

- [ ] **Step 1: Write the failing test**

```typescript
// src/service/session-manager.actors.test.ts
import { describe, expect, it } from 'vitest'
import { createConversationStore } from './conversation-store'
import { createSessionManager } from './session-manager'

// Minimal broadcaster + provider stubs (mirror existing session-manager tests).
const noopBroadcaster = { broadcast: () => {} }
const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any

function makeManager() {
  const store = createConversationStore(':memory:')
  const mgr = createSessionManager({
    store, broadcaster: noopBroadcaster, maxConcurrent: 2,
    getProvider: () => fakeProvider,
  })
  return { store, mgr }
}

describe('actor addressing', () => {
  it('ensureActor reuses an actor with the same session+name', () => {
    const { store, mgr } = makeManager()
    const { sessionId } = mgr.createSession(fakeProvider)
    // __ensureActorForTest is a test-only hook exported from session-manager (see Step 3).
    const a = (mgr as any).__ensureActorForTest(sessionId, 'default', 'researcher-1')
    const b = (mgr as any).__ensureActorForTest(sessionId, 'default', 'researcher-1')
    expect(a.address).toBe(b.address)
    expect(store.getActorByName(sessionId, 'researcher-1')?.address).toBe(a.address)
  })

  it('ensureActor without a name mints a fresh ULID address each call', () => {
    const { mgr } = makeManager()
    const { sessionId } = mgr.createSession(fakeProvider)
    const a = (mgr as any).__ensureActorForTest(sessionId, 'default')
    const b = (mgr as any).__ensureActorForTest(sessionId, 'default')
    expect(a.address).not.toBe(b.address)
  })
})
```

> 若现有 session-manager 测试用了不同的 broadcaster/provider 构造,以现有测试文件的 stub 形状为准。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/session-manager.actors.test.ts`
Expected: FAIL — `__ensureActorForTest` is not a function.

- [ ] **Step 3: Implement `ensureActor` + test hook**

在 `createSessionManager` 内、`spawnChild` 之前加:

```typescript
  // Resolve-or-create an addressable identity. With a name, an existing actor in
  // the same session is reused (so `send('researcher-1', …)` keeps hitting the
  // same identity); without a name a fresh ULID address is minted each time.
  const ensureActor = (sessionId: string, agentDefId: string, name?: string): import('@shared/types/actor').Actor => {
    if (name) {
      const existing = store.getActorByName(sessionId, name)
      if (existing) return existing
    }
    const now = Date.now()
    const actor: import('@shared/types/actor').Actor = {
      address: ulid(), agentDefId, sessionId, name: name ?? null,
      state: null, lastTaskId: null, createdAt: now, updatedAt: now,
    }
    store.upsertActor(actor)
    log.info({ msg: 'actor created', sessionId, address: actor.address, agentDefId, name: name ?? null })
    return actor
  }
```

在返回对象里加测试钩子(紧贴其它方法,注释说明仅测试用):

```typescript
    // Test-only: exercise actor resolution without driving a full run.
    __ensureActorForTest(sessionId: string, agentDefId: string, name?: string) {
      return ensureActor(sessionId, agentDefId, name)
    },
```

并在 `SessionManager` type 上加可选签名:

```typescript
  /** @internal test hook */
  __ensureActorForTest?(sessionId: string, agentDefId: string, name?: string): import('@shared/types/actor').Actor
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/session-manager.actors.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx biome check --write src/service/session-manager.ts src/service/session-manager.actors.test.ts
git add src/service/session-manager.ts src/service/session-manager.actors.test.ts
git commit -m "feat(session): actor resolve-or-create with optional named addresses"
```

---

## Task 4: `sendMessage` 激活逻辑(RPC + fire-and-forget)

**Files:**
- Modify: `src/service/session-manager.ts`
- Test: `src/service/session-manager.messaging.test.ts`

**Interfaces:**
- Consumes: `ensureActor`(Task 3)、store 方法(Task 2)、现有 `acquireSlot`/`releaseSlot`/`createAgentRunner`/`runHandles`。
- Produces(session-manager 内部 + 暴露给 spawnChild/工具桥):
  - `sendMessage(sessionId, fromAddr, toAddr, payload, kind): Promise<{ reply: string } | { delivered: true }>`
    - `kind:'rpc'` → 激活目标 actor,以 `payload` 为 goal 跑一次,返回 `{ reply: summary }`。
    - `kind:'send'` → 入库 + 激活但不 await,立即返回 `{ delivered: true }`。
    - 目标地址不存在 → 入库标记 `dead` + warn;rpc 返回 `{ reply: '' }`(不抛)。

- [ ] **Step 1: Write the failing test**

```typescript
// src/service/session-manager.messaging.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createConversationStore } from './conversation-store'
import { createSessionManager } from './session-manager'

// Stub createAgentRunner so a "run" just echoes the goal as its summary.
vi.mock('./agent-runner', () => ({
  createAgentRunner: (deps: any) => ({
    run: async () => ({ status: 'completed', summary: `ran:${deps.task.goal}`, messages: [], used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 } }),
  }),
}))

const noopBroadcaster = { broadcast: () => {} }
const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any

function makeManager() {
  const store = createConversationStore(':memory:')
  const mgr = createSessionManager({ store, broadcaster: noopBroadcaster, maxConcurrent: 4, getProvider: () => fakeProvider })
  return { store, mgr }
}

describe('sendMessage', () => {
  it('rpc activates the target actor and returns its summary as reply', async () => {
    const { mgr } = makeManager()
    const { sessionId } = mgr.createSession(fakeProvider)
    const target = (mgr as any).__ensureActorForTest(sessionId, 'default', 'b')
    const res = await (mgr as any).__sendMessageForTest(sessionId, null, target.address, 'review X', 'rpc')
    expect(res.reply).toBe('ran:review X')
  })

  it('send to a non-existent address dead-letters and does not throw', async () => {
    const { store, mgr } = makeManager()
    const { sessionId } = mgr.createSession(fakeProvider)
    const res = await (mgr as any).__sendMessageForTest(sessionId, null, 'ghost-addr', 'hi', 'send')
    expect(res).toEqual({ delivered: true })
    // The message is persisted dead; no unconsumed work remains for the ghost.
    expect(store.nextUnconsumedFor('ghost-addr')).toBeUndefined()
  })

  it('resolves a target by readable name within the session', async () => {
    const { mgr } = makeManager()
    const { sessionId } = mgr.createSession(fakeProvider)
    ;(mgr as any).__ensureActorForTest(sessionId, 'default', 'reviewer')
    const res = await (mgr as any).__sendMessageForTest(sessionId, null, 'reviewer', 'check', 'rpc')
    expect(res.reply).toBe('ran:check')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/session-manager.messaging.test.ts`
Expected: FAIL — `__sendMessageForTest` is not a function.

- [ ] **Step 3: Implement `sendMessage` + activation**

在 `createSessionManager` 内,`ensureActor` 之后加。激活体抽出一个 `activateActor`,供 rpc(await)与 send(不 await)共用:

```typescript
  // Resolve a `to` that is either a raw address or a session-scoped readable name.
  const resolveAddress = (sessionId: string, to: string): import('@shared/types/actor').Actor | undefined =>
    store.getActor(to) ?? store.getActorByName(sessionId, to)

  // Run one activation of an actor with `goal` as its input. Mirrors spawnChild's
  // run path: acquire a slot, build a runner, run once, persist terminal status.
  // Returns the run summary (the reply for an rpc).
  const activateActor = async (
    sessionId: string,
    actor: import('@shared/types/actor').Actor,
    goal: string
  ): Promise<string> => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)
    const def = cfg.agentStore?.get(actor.agentDefId) ?? DEFAULT_AGENT_DEF
    const taskId = ulid()
    const now = Date.now()
    const task: Task = {
      id: taskId, parentId: null, agentDefId: def.id, goal, status: 'pending',
      assignedWorkerId: null, toolAllowlist: deriveAllowlist(def.toolScope),
      budget: budgets().sub, used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
      history: [], attachments: [], result: null, createdAt: now, startedAt: null, endedAt: null,
    }
    store.saveTask(task, sessionId)
    store.upsertActor({ ...actor, lastTaskId: taskId, updatedAt: now })
    broadcaster.broadcast('task.created', { sessionId, taskId, goal, attachments: [], agentDefId: def.id, ts: now })
    log.info({ msg: 'actor activated', sessionId, address: actor.address, taskId, agentDefId: def.id })

    await acquireSlot()
    const abort = new AbortController()
    runHandles.set(taskId, abort)
    const runner = createAgentRunner({
      task, provider: def.model ? { ...session.provider, model: def.model } : session.provider,
      agentDefinition: withPrompt(def), sessionId, emit: makeEmit(sessionId),
      permissionRegistry: session.permissionRegistry, toolRegistry, initialMessages: [],
      signal: abort.signal, selfAddress: actor.address,
      sendMessage: (from, to, payload, kind) => sendMessage(sessionId, from, to, payload, kind),
      spawnChild: (pt, ng, st, pk, at) => spawnChild(sessionId, pt, ng, st, pk, at),
    })
    try {
      const { status, summary } = await runner.run()
      store.updateTaskStatus(taskId, status)
      return summary
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ msg: 'actor activation failed', address: actor.address, taskId, err: message })
      try {
        store.appendTaskEvent(taskId, { kind: 'error', error: { code: 'run_failed', message, tier: 'fatal' }, ts: Date.now() })
        store.updateTaskStatus(taskId, 'failed')
      } catch (persistErr) {
        log.error({ msg: 'failed to persist activation error', taskId, err: String(persistErr) })
      }
      return ''
    } finally {
      runHandles.delete(taskId)
      releaseSlot()
    }
  }

  const sendMessage = async (
    sessionId: string,
    fromAddr: string | null,
    toAddr: string,
    payload: string,
    kind: 'send' | 'rpc'
  ): Promise<{ reply: string } | { delivered: true }> => {
    const target = resolveAddress(sessionId, toAddr)
    const now = Date.now()
    const msgId = ulid()
    store.enqueueMessage({
      id: msgId, toAddr: target?.address ?? toAddr, fromAddr, kind,
      correlationId: kind === 'rpc' ? msgId : null, payload,
      consumed: false, retries: 0, dead: !target, ts: now,
    })
    if (!target) {
      log.warn({ msg: 'message to unknown address dead-lettered', sessionId, toAddr, kind })
      return kind === 'rpc' ? { reply: '' } : { delivered: true }
    }
    log.info({ msg: 'message sent', sessionId, fromAddr, toAddr: target.address, kind, correlationId: msgId })

    if (kind === 'rpc') {
      const reply = await activateActor(sessionId, target, payload)
      store.markConsumed(msgId)
      return { reply }
    }
    // fire-and-forget: activate without blocking the caller; mark consumed when done.
    void activateActor(sessionId, target, payload)
      .then(() => store.markConsumed(msgId))
      .catch((err) => log.error({ msg: 'fire-and-forget activation rejected', msgId, err: String(err) }))
    return { delivered: true }
  }
```

加测试钩子到返回对象:

```typescript
    // Test-only: drive sendMessage directly.
    __sendMessageForTest(sessionId: string, fromAddr: string | null, toAddr: string, payload: string, kind: 'send' | 'rpc') {
      return sendMessage(sessionId, fromAddr, toAddr, payload, kind)
    },
```

> **deadlock 注记**:`activateActor` 与现有 `spawnChild` 一样在持有调用方 slot 时再 `acquireSlot`,`maxConcurrent` 耗尽时可能等待——这是既有性质,本计划不引入新风险;计划 B 的常驻循环会改善。测试用 `maxConcurrent: 4` 规避。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/session-manager.messaging.test.ts`
Expected: PASS（3 个用例)

- [ ] **Step 5: Commit**

```bash
npx biome check --write src/service/session-manager.ts src/service/session-manager.messaging.test.ts
git add src/service/session-manager.ts src/service/session-manager.messaging.test.ts
git commit -m "feat(session): sendMessage with rpc (activate-and-reply) and fire-and-forget"
```

---

## Task 5: AgentRunnerDeps / ToolRunContext 加 `selfAddress` + `sendMessage`

**Files:**
- Modify: `src/service/agent-runner.ts`(`AgentRunnerDeps` 加字段;透传到 `ToolRunContext`)
- Modify: `src/service/tools/registry.ts`(`ToolRunContext` 加 `selfAddress`、`sendMessage`、`sendAndWait`)
- Test: `src/service/agent-runner.context.test.ts`(或并入现有 agent-runner 测试)

**Interfaces:**
- Consumes: `sendMessage` 回调(Task 4 的 `AgentRunnerDeps.sendMessage`)。
- Produces(`ToolRunContext` 新增):
  - `selfAddress?: string`
  - `sendMessage(to: string, payload: string): Promise<void>`(fire-and-forget)
  - `sendAndWait(to: string, payload: string): Promise<string>`(rpc,返回 reply)

- [ ] **Step 1: Write the failing test**

```typescript
// src/service/agent-runner.context.test.ts
import { describe, expect, it, vi } from 'vitest'

// Verify the runner builds a ToolRunContext exposing selfAddress + messaging,
// bridged onto the deps.sendMessage callback.
describe('agent-runner tool context messaging bridge', () => {
  it('sendAndWait bridges to deps.sendMessage with kind rpc and returns reply', async () => {
    const sendMessage = vi.fn(async (_from: string | null, _to: string, _payload: string, kind: string) =>
      kind === 'rpc' ? { reply: 'pong' } : { delivered: true }
    )
    // buildToolContext is the (exported-for-test) helper that assembles ToolRunContext from deps.
    const { buildToolContext } = await import('./agent-runner')
    const ctx = buildToolContext({ selfAddress: 'me', sendMessage } as any)
    const reply = await ctx.sendAndWait('peer', 'ping')
    expect(reply).toBe('pong')
    expect(sendMessage).toHaveBeenCalledWith('me', 'peer', 'ping', 'rpc')
  })
})
```

> 若 `agent-runner.ts` 当前内联构造 ctx 而非用一个 `buildToolContext` 助手,本任务顺带把 ctx 组装抽成可测的 `buildToolContext(deps)` 导出函数(外科手术式,纯抽取不改行为)。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/agent-runner.context.test.ts`
Expected: FAIL — `buildToolContext` not exported / `sendAndWait` undefined.

- [ ] **Step 3: Extend types and build the context**

`src/service/tools/registry.ts` 的 `ToolRunContext` 加:

```typescript
  /** This agent's stable address, if it was activated as an addressable actor. */
  selfAddress?: string
  /** Fire-and-forget message to another actor (by address or session-scoped name). */
  sendMessage(to: string, payload: string): Promise<void>
  /** RPC: deliver to another actor and await its reply summary. */
  sendAndWait(to: string, payload: string): Promise<string>
```

`src/service/agent-runner.ts` 的 `AgentRunnerDeps` 加:

```typescript
  /** This run's actor address, when activated via sendMessage/activateActor. */
  selfAddress?: string
  /** Deliver a message to another actor. rpc awaits a reply; send is fire-and-forget. */
  sendMessage?(
    from: string | null,
    to: string,
    payload: string,
    kind: 'send' | 'rpc'
  ): Promise<{ reply: string } | { delivered: true }>
```

抽取/新增 `buildToolContext`(导出),在其中桥接:

```typescript
export function buildToolContext(deps: AgentRunnerDeps): ToolRunContext {
  return {
    // ... existing ctx fields (cwd, spawnChild bridge, etc.) preserved ...
    selfAddress: deps.selfAddress,
    sendMessage: async (to, payload) => {
      await deps.sendMessage?.(deps.selfAddress ?? null, to, payload, 'send')
    },
    sendAndWait: async (to, payload) => {
      const res = await deps.sendMessage?.(deps.selfAddress ?? null, to, payload, 'rpc')
      return res && 'reply' in res ? res.reply : ''
    },
  }
}
```

并把原内联 ctx 构造改为调用 `buildToolContext(deps)`(保持其余字段不变)。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/agent-runner.context.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite to catch regressions**

Run: `npm test`
Expected: PASS（既有 agent-runner / session-manager 测试不回归)

- [ ] **Step 6: Commit**

```bash
npx biome check --write src/service/agent-runner.ts src/service/tools/registry.ts src/service/agent-runner.context.test.ts
git add src/service/agent-runner.ts src/service/tools/registry.ts src/service/agent-runner.context.test.ts
git commit -m "feat(agent-runner): expose selfAddress + messaging on ToolRunContext"
```

---

## Task 6: `send_message` / `send_and_wait` / `whoami` 工具

**Files:**
- Create: `src/service/tools/messaging.ts`
- Modify: `src/service/tools/builtins.ts`(注册)
- Test: `src/service/tools/messaging.test.ts`

**Interfaces:**
- Consumes: `ToolRunContext.{selfAddress, sendMessage, sendAndWait}`(Task 5)、`ToolSpec`(`./registry`)、`Type`（`@earendil-works/pi-ai`)。
- Produces: `sendMessageSpec(): ToolSpec`、`sendAndWaitSpec(): ToolSpec`、`whoamiSpec(): ToolSpec`(均 `group: 'agent'`)。

- [ ] **Step 1: Write the failing test**

```typescript
// src/service/tools/messaging.test.ts
import { describe, expect, it, vi } from 'vitest'
import { sendAndWaitSpec, sendMessageSpec, whoamiSpec } from './messaging'

const ctx = (over: Partial<any> = {}) => ({
  selfAddress: 'me',
  sendMessage: vi.fn(async () => {}),
  sendAndWait: vi.fn(async () => 'the-reply'),
  ...over,
}) as any

describe('messaging tools', () => {
  it('send_message calls ctx.sendMessage and reports delivery', async () => {
    const c = ctx()
    const tool = sendMessageSpec().build(c)
    const res = await tool.execute('id', { to: 'peer', payload: 'hi' })
    expect(c.sendMessage).toHaveBeenCalledWith('peer', 'hi')
    expect(res.content[0].text).toMatch(/delivered/i)
  })

  it('send_and_wait returns the reply text', async () => {
    const c = ctx()
    const tool = sendAndWaitSpec().build(c)
    const res = await tool.execute('id', { to: 'peer', payload: 'ping' })
    expect(c.sendAndWait).toHaveBeenCalledWith('peer', 'ping')
    expect(res.content[0].text).toBe('the-reply')
  })

  it('whoami returns the agent self address', async () => {
    const tool = whoamiSpec().build(ctx())
    const res = await tool.execute('id', {})
    expect(res.content[0].text).toContain('me')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/tools/messaging.test.ts`
Expected: FAIL — cannot resolve `./messaging`.

- [ ] **Step 3: Implement the tools**

```typescript
// src/service/tools/messaging.ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { ToolRunContext, ToolSpec } from './registry'

const SendParams = Type.Object({
  to: Type.String({ description: 'Target actor address (ULID) or its session-scoped readable name.' }),
  payload: Type.String({ description: 'The message / instruction for the target actor.' }),
})

export function sendMessageSpec(): ToolSpec {
  return {
    group: 'agent', name: 'send_message', risk: 'medium', source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'send_message',
      label: 'Send message',
      description:
        'Fire-and-forget: deliver a message to another agent by address or name and continue immediately without waiting for a reply. Use for notifications or async hand-offs.',
      parameters: SendParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { to: string; payload: string }
        await ctx.sendMessage(p.to, p.payload)
        return { content: [{ type: 'text', text: `Message delivered to ${p.to}.` }] }
      },
    }),
  }
}

export function sendAndWaitSpec(): ToolSpec {
  return {
    group: 'agent', name: 'send_and_wait', risk: 'medium', source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'send_and_wait',
      label: 'Send and wait for reply',
      description:
        'RPC: deliver a message to another agent by address or name and wait for its reply. Use when you need the other agent to do something and return a result to you (e.g. ask a reviewer to critique a draft).',
      parameters: SendParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { to: string; payload: string }
        const reply = await ctx.sendAndWait(p.to, p.payload)
        return { content: [{ type: 'text', text: reply }], details: { to: p.to } }
      },
    }),
  }
}

export function whoamiSpec(): ToolSpec {
  return {
    group: 'agent', name: 'whoami', risk: 'low', source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'whoami',
      label: 'Get my address',
      description:
        'Return your own actor address so you can share it with peers who should message you back.',
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: 'text', text: ctx.selfAddress ?? '(no address: this agent is not addressable)' }],
      }),
    }),
  }
}
```

- [ ] **Step 4: Register in builtins**

`src/service/tools/builtins.ts`,在已注册 `spawnAgentSpec()` 处旁边加(import + register,匹配现有写法):

```typescript
import { sendAndWaitSpec, sendMessageSpec, whoamiSpec } from './messaging'
// ... inside the registration body, alongside registry.register(spawnAgentSpec()):
registry.register(sendMessageSpec())
registry.register(sendAndWaitSpec())
registry.register(whoamiSpec())
```

> `deriveAllowlist` 已用 `agent.*` 通配(见 `src/shared/types/agent.ts:47-51`),三个新工具属 `agent` 组,自动进入相应 allowlist,无需改 allowlist。确认实现时核实工具的完整限定名前缀(`agent.send_message` 等)与现有 `agent.spawn_sub_agent` 一致。

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/service/tools/messaging.test.ts`
Expected: PASS（3 个用例)

- [ ] **Step 6: Commit**

```bash
npx biome check --write src/service/tools/messaging.ts src/service/tools/builtins.ts src/service/tools/messaging.test.ts
git add src/service/tools/messaging.ts src/service/tools/builtins.ts src/service/tools/messaging.test.ts
git commit -m "feat(tools): add send_message, send_and_wait, whoami agent tools"
```

---

## Task 7: 场景① 缺陷修复 —— `submitGoal` 透传 `agentDef`

**Files:**
- Modify: dispatcher / ipc submitGoal 链路(实现时定位;疑似 `src/main/` 下的 ipc handler 调用 `serviceClient.submitGoal` / service 侧 `submitGoal`)
- Test: 对应 dispatcher 测试(若存在 `*.test.ts`)或新增

**Interfaces:**
- Consumes: `SessionManager.submitGoal(sessionId, goal, attachments?, agentDef?, onComplete?, options?)`(已支持 `agentDef` 第 4 参)。
- Produces: UI 选定的 agentType 能真正传到 `submitGoal` 的 `agentDef`,使顶层任务不再被强制 `default`。

- [ ] **Step 1: 定位与确认**

Run: `git grep -n "submitGoal" src/main src/service`
判断 `agentDef` 是否在 UI→dispatcher→service 链路中途丢失。**若当前代码已正确透传**(记忆可能过时),把本任务标记为「已满足」并补一个回归测试即可。

- [ ] **Step 2: Write the failing test**

```typescript
// 形如 src/main/<dispatcher>.test.ts —— 断言 dispatcher 把 agentDef 透传给 service.submitGoal
import { describe, expect, it, vi } from 'vitest'
// import { handleSubmitGoal } from './<dispatcher>'  // 实现时按真实导出名调整

it('passes the selected agentDef through to service.submitGoal', async () => {
  const submitGoal = vi.fn(() => ({ taskId: 't1' }))
  const service = { submitGoal } as any
  const agentDef = { id: 'researcher', name: 'R', description: 'x', systemPrompt: '', toolScope: 'web', maxIterations: 25 }
  // call the dispatcher path with a chosen agentDef:
  // handleSubmitGoal(service, { sessionId: 's1', goal: 'g', agentDef })
  // expect submitGoal called with agentDef in the agentDef position:
  // expect(submitGoal).toHaveBeenCalledWith('s1', 'g', expect.anything(), agentDef, expect.anything(), expect.anything())
})
```

> 该测试的精确形状取决于 Step 1 查到的真实函数签名;按实际接口补全(上面是结构模板,实现时填入真实导出名与参数顺序)。

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- <dispatcher test path>`
Expected: FAIL —— `agentDef` 未透传(若缺陷确实存在)。

- [ ] **Step 4: Fix the passthrough**

在 dispatcher/ipc 处把 UI 传入的 agentType 解析为 `AgentDefinition`(经 `agentStore.get`)并放到 `submitGoal` 的 `agentDef` 参;同时确认 service 侧 ipc 方法签名带上 `agentDef`(若 `ServiceClient.submitGoal` 当前只透传 `options` 而无 `agentDef`,补上)。

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- <dispatcher test path>`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "fix(dispatcher): thread selected agentDef through submitGoal"
```

---

## Task 8: 端到端集成测试(同辈 RPC)

**Files:**
- Test: `src/service/agent-cluster.e2e.test.ts`

**Interfaces:**
- Consumes: 全部上面任务(真实 `createSessionManager` + stub runner)。

- [ ] **Step 1: Write the integration test**

```typescript
// src/service/agent-cluster.e2e.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createConversationStore } from './conversation-store'
import { createSessionManager } from './session-manager'

// Runner stub: an actor named 'reviewer' replies "LGTM"; everyone else echoes.
vi.mock('./agent-runner', () => ({
  createAgentRunner: (deps: any) => ({
    run: async () => ({
      status: 'completed',
      summary: deps.task.goal.includes('review') ? 'LGTM' : `echo:${deps.task.goal}`,
      messages: [], used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    }),
  }),
}))

const noopBroadcaster = { broadcast: () => {} }
const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any

describe('agent cluster — sibling RPC', () => {
  it('an actor can rpc a named peer and get its reply, persisted as consumed', async () => {
    const store = createConversationStore(':memory:')
    const mgr = createSessionManager({ store, broadcaster: noopBroadcaster, maxConcurrent: 4, getProvider: () => fakeProvider })
    const { sessionId } = mgr.createSession(fakeProvider)
    ;(mgr as any).__ensureActorForTest(sessionId, 'default', 'reviewer')

    const { reply } = await (mgr as any).__sendMessageForTest(sessionId, 'author', 'reviewer', 'please review the draft', 'rpc')
    expect(reply).toBe('LGTM')
    // the reviewer actor recorded a lastTaskId activation:
    expect(store.getActorByName(sessionId, 'reviewer')?.lastTaskId).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it**

Run: `npm test -- src/service/agent-cluster.e2e.test.ts`
Expected: PASS

- [ ] **Step 3: Full suite + commit**

```bash
npm test
npx biome check --write src/service/agent-cluster.e2e.test.ts
git add src/service/agent-cluster.e2e.test.ts
git commit -m "test(cluster): e2e sibling rpc messaging"
```

---

## Self-Review(已执行)

- **Spec 覆盖**:§4.1 地址模型 → Task 1/2/3;§4.2 收件箱 → Task 2;§4.3 激活管理器 → Task 4;§4.4 RPC 关联 → Task 4(`correlationId` 入库)+ Task 5/6;§4.6 工具 → Task 6;§4.5 Runner 循环 → **明确不在本计划**(计划 B);场景① 缺陷 → Task 7;测试策略 → 各 task + Task 8。`actors.state` 仅建列不读写(YAGNI,留阶段 3)——一致。
- **类型一致性**:`Actor`/`ActorMessage` 字段在 Task 1 定义,Task 2 store、Task 3/4 session-manager、Task 5 deps 全程引用同名字段(`address`/`agentDefId`/`correlationId`/`toAddr`)。`sendMessage(from,to,payload,kind)` 签名在 Task 4(deps)、Task 5(bridge)一致;`ToolRunContext.sendAndWait(to,payload)→Promise<string>` 在 Task 5 定义、Task 6 消费一致。
- **占位符**:Task 7 因 dispatcher 文件名未定而留「实现时定位」——这是有意的核实步骤(记忆为旧快照),Step 1 给了 `git grep` 定位命令,非空泛占位。
- **范围**:聚焦「可寻址 + 激活式消息」单一子系统,自成可测增量;常驻 run 循环已隔离为计划 B。

## 计划 A 已知局限(延至计划 B)

- **`maxConcurrent` 下的死锁**:激活持有调用方并发槽位的同时,`send_and_wait`(rpc)再请求一个槽位;rpc 链深度超过 `maxConcurrent`,或两个 actor 互相 rpc 且 session 的 `maxConcurrent` 较小时,可能永久死锁。此行为继承自现有的嵌套 `spawnChild`——计划 A 引入了新触发路径,但并非新机制。计划 B 的常驻 run 循环将解决此问题。
- **fire-and-forget 崩溃孤儿**:对于 `kind:'send'`,消息仅在异步激活 resolve 后才标记为 `consumed`;若激活中途崩溃,消息会停留在 `consumed=0, dead=0` 状态。当前尚无 run 循环,没有任何机制重新排空它。计划 B 的收件箱排空循环将负责恢复。

## 计划 B 预告(不在本计划)

`AgentRunner.run()` 跑完后 `await mailbox.receive()` —— 把 `runHandles` 升级为 `Map<address, { abort, deliver }>`,活着的 actor 不退出、直接消费排队消息(省去每条消息重新激活的开销),实现真正常驻虚拟 actor,支撑场景③事件驱动的低延迟与场景④长期状态。需单独 spec→plan。
