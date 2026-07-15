# pi 与 SwarmAgents 的集成对比调查

> 调查对象:
> - **pi**:`/Users/gaozimeng/learn/AI/pi`(monorepo,`pi-monorepo` v0.0.3,workspace 包统一 v0.80.6,作者 Mario Zechner / earendil-works,MIT)
> - **SwarmAgents**:`/Users/gaozimeng/Learn/macOS/SwarmAgents`(私有 monorepo,Electron 桌面 host + 浏览器扩展 + RN 客户端)
>
> 调查日期:2026-07-15。所有引用为 `file:line`,pi 侧指向源码 `packages/*/src`,SwarmAgents 侧指向 `apps/desktop/src` 等。本文未修改任何代码,纯只读调查。

---

## 0. 一句话结论

SwarmAgents **没有使用 pi 的成品 CLI/TUI(`pi-coding-agent`),而是把 pi 的两个底层库 `@earendil-works/pi-agent-core`(agent 主循环)和 `@earendil-works/pi-ai`(LLM 抽象层)当作 SDK 嵌入**到自己的 Electron 桌面 agent runtime 中;在此之上,它完全跳过了 pi 面向终端产品的高层封装(`AgentSession` / `SessionManager` / `pi-tui` / 内置 CLI tools),自建了一套面向"桌面 + 多 agent 组织(swarm)"的运行时、工具体系、权限/预算/重试策略和组织架构式委派模型。

一句话:**pi 提供发动机(`Agent` + `pi-ai`),SwarmAgents 自己造整车(车架、传动、调度系统),且只装发动机不装 pi 的整车件。**

---

## 1. 两边是什么关系:依赖拓扑

### 1.1 pi 的内部分层(monorepo packages)

pi 把能力拆成 5 个 workspace 包,严格自下而上分层:

```
pi-ai                LLM 抽象层:Model / Api / Type(typebox)/ providers / compat
  ↑ 依赖
pi-agent-core        agent 运行时:Agent 类 / agent-loop / AgentTool / AgentMessage / AgentEvent
  ↑ 依赖              (agent-core 只依赖 pi-ai,框架无关、IO 无关)
pi-tui               终端 UI 组件库(Text / Container / Box / theme / 语法高亮)
  ↑ 依赖
pi-coding-agent      完整 CLI/TUI 产品:AgentSession + 内置 tools(read/bash/edit/write/grep/find/ls)
  ↑ 依赖                + SessionManager + ModelRegistry + system-prompt + modes(interactive/print/rpc)
pi-orchestrator      多实例编排:OrchestratorSupervisor(管多个独立 RPC 进程实例)
```

依赖证据(`packages/*/package.json`):
- `pi-agent-core` deps:`@earendil-works/pi-ai`
- `pi-coding-agent` deps:`pi-agent-core` + `pi-ai` + `pi-tui`
- `pi-orchestrator` deps:`pi-coding-agent`

关键设计:pi 把"模型调用"和"agent 循环"做成了**框架无关、IO 无关、UI 无关**的两个纯库包(agent-core 甚至不直接 import 任何 provider —— 模型注入靠 `streamFn` 回调,见 §3.2)。这正是 SwarmAgents 能复用它们的前提。

### 1.2 SwarmAgents 取了哪一层、舍了哪一层

SwarmAgents `apps/desktop/package.json:36-37` 只声明两条依赖:

```json
"@earendil-works/pi-agent-core": "^0.80.6",
"@earendil-works/pi-ai": "^0.80.6",
```

并且 `electron.vite.config.ts:25,32` 专门把这两个包(及 `chokidar`)标为 ESM-only 需内联处理:

```ts
// @earendil-works/pi-agent-core and @earendil-works/pi-ai are ESM-only
const ESM_ONLY_BUNDLE_INLINE = new Set(['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', 'chokidar'])
```

**明确舍弃的 pi 能力**(全仓库零引用,grep 确认 `AgentSession`/`SessionManager`/`pi-coding-agent`/`pi-tui`/`pi-orchestrator` 在 SwarmAgents 源码中无导入):

| pi 包 | 是否用 | 原因 |
|---|---|---|
| `pi-ai` | ✅ 用 | LLM 抽象,UI 无关,可直接复用 |
| `pi-agent-core` | ✅ 用 | agent 循环,IO/UI 无关,可直接复用 |
| `pi-tui` | ❌ 不用 | SwarmAgents 是 Electron + React,不做终端渲染 |
| `pi-coding-agent` | ❌ 不用 | 面向 CLI/TUI 的 `AgentSession` 与 SwarmAgents 的桌面/swarm 模型冲突,自建等价物 |
| `pi-orchestrator` | ❌ 不用 | 多进程 RPC 实例模型 ≠ SwarmAgents 的单进程组织委派模型 |

SwarmAgents 实际 import 的 pi 符号频次(grep 统计,非 test 文件):`AgentTool`×24、`Type`×20、`AgentMessage`×4、`Model`×3、`Api`×3、`Agent`×1(仅 `engine.ts`)、`AgentEvent`×1、`KnownProvider`×2、`clampThinkingLevel`×2 等。**`Agent` 只在一处被实例化**(`message-engine/engine.ts:151`),这是整个集成的"接缝"。

---

## 2. 核心对比:Agent 是怎么被构造和驱动的

这是整份调查的枢纽。两边都在"某个文件里 `new Agent({...})`",但构造的方式、注入的回调、外层包装完全不同。

### 2.1 pi 原生:`Agent` 被 `AgentSession` 包成成品

pi 的 coding-agent 里,`new Agent({...})` **唯一构造点**在 `packages/coding-agent/src/core/sdk.ts:294-369` 的 `createAgentSession()` 内。它注入:

- `initialState: { model, thinkingLevel: clampThinkingLevel(...), tools: [] }`
- `convertToLlm`:把 coding-agent 的自定义消息(`bashExecution`/`custom`/`branchSummary`/`compactionSummary`)翻译成 LLM 消息(`core/messages.ts:148`)
- `streamFn`:**自定义闭包**(没用 agent-core 默认值)—— 每次调用先 `modelRegistry.getApiKeyAndHeaders(model)` 解析 auth/header/env,合并 provider 归因 header 和扩展钩子(`before_provider_headers`),再调 `streamSimple`(`sdk.ts:302-339`)。这是 pi 的"模型如何被调用"的核心接缝。
- `transformContext` / `onPayload` / `onResponse`:接扩展事件
- `steeringMode` / `followUpMode` / `thinkingBudgets` 等:从 `settingsManager` 读

构造出的 `Agent` 立刻被塞进 `new AgentSession({...})`(`sdk.ts:385-397`)。**`AgentSession`(`core/agent-session.ts`)才是 pi 的会话抽象**,它在 `Agent` 之上叠加:

- `agent.subscribe(this._handleAgentEvent)`:每条 `message_end` 按 role 写入 `SessionManager`(JSONL 持久化,`agent-session.ts:548-619`)
- `_runAgentPrompt`(`agent-session.ts:1023-1035`):`await agent.prompt()` 后循环 `while (_handlePostAgentRun()) agent.continue()` —— 把 loop 包成"run → 善后(retry/compaction/续跑)→ 续跑"
- tool hooks(`agent-session.ts:423-471`):`beforeToolCall`/`afterToolCall` 接扩展事件
- next-turn refresh(`agent-session.ts:473-494`):每轮刷新 systemPrompt/tools/model/thinkingLevel

再外面是 `AgentSessionRuntime`(`core/agent-session-runtime.ts`)管"当前 session + cwd 绑定"的生命周期(`switchSession`/`newSession`/`fork`/`importFromJsonl`,每个都是 teardown→重建 runtime)。

最后由三种 **mode** 驱动(`modes/index.ts`):`InteractiveMode`(TUI)、`runPrintMode`(一次性输出)、`runRpcMode`(RPC server,被 orchestrator 用)。三者共用同一套 `AgentSession`,只差 I/O 层。

**调用链(用户输入 → provider):**
```
AgentSession.prompt() → _runAgentPrompt → Agent.prompt()
  → runAgentLoop → runLoop(双层 while)→ streamAssistantResponse
  → convertToLlm + transformContext → streamFn(sdk.ts:302: auth 解析 + streamSimple)
  → provider 流 → AgentEvent → Agent.processEvents → AgentSession._handleAgentEvent(写 SessionManager)→ mode UI
```

### 2.2 SwarmAgents:`Agent` 被直接驱动,自建 engine 当"AgentSession 等价物"

SwarmAgents **完全不用 `AgentSession`**。它把 pi 的 `Agent` 当一个"裸发动机",在 `apps/desktop/src/service/message-engine/engine.ts` 里自建了一个 engine 作为会话驱动层。`engine.ts:2` 直接:

```ts
import { Agent } from '@earendil-works/pi-agent-core'
```

`engine.ts:151-237` 的 `new Agent({...})` 注入了 pi 的**全部生命周期 hook**,但实现都是 SwarmAgents 自己的业务逻辑:

```ts
const agent = new Agent({
  getApiKey: () => deps.provider.apiKey,
  onPayload: (payload, m) => { /* HTTP 请求体 trace 到 debug */ },
  onResponse: (response) => { /* HTTP 响应行 trace 到 info */ },
  initialState: {
    systemPrompt: composeSystemPrompt(deps.agentDefinition.systemPrompt, { cwd, executionMode }),
    model,                       // 来自 resolveModel,见 §4
    tools: deps.tools,           // 来自 ToolSpec.build(ctx),见 §3
    messages: deps.history,      // 仅先验历史,prompt 由 run() 时追加(spec D4)
    thinkingLevel: clampThinkingLevel(model, deps.provider.thinkingLevel ?? 'high'),
  },
  prepareNextTurn: () => {       // 每轮熔断:迭代上限
    turns += 1
    if (turns >= maxTurns) { stopCause = 'iterations'; agent.abort() }
  },
  beforeToolCall: async ({ toolCall, args }) => {
    // 五重熔断 + 权限拦截,见下
  },
})
```

**SwarmAgents 在 `beforeToolCall` 里自建的"五重熔断 + 权限"链**(`engine.ts:199-236`)是 pi 原生 `AgentSession` 没有的增值:

```ts
beforeToolCall: async ({ toolCall, args }) => {
  if (deps.signal?.aborted) { stopCause = 'cancelled'; return { block: true, reason: 'Stopped by user.' } }
  used.calls += 1
  const dim = overBudget()                        // ① calls ② wallMs ③ usdCents
  if (dim) { stopCause = 'budget'; agent.abort(); return { block: true, reason: `Budget exhausted (${dim}).` } }
  if (model.contextWindow && contextTokens > model.contextWindow) {  // ④ context window
    stopCause = 'context'; agent.abort(); return { block: true, ... }
  }
  const risk = deps.riskOf(toolCall.name, args)   // 风险分级
  if (risk === 'low') return undefined
  const permissionMode = deps.getPermissionMode?.() ?? deps.permissionMode ?? 'ask'
  if (permissionMode === 'full') return undefined
  const decision = await deps.permissionRegistry.request(  // ⑤ 人工审批
    { taskId: deps.messageId, toolName: toolCall.name, risk, summary, payload: args }, deps.signal)
  if (decision === 'grant') return undefined
  return { block: true, reason: `User ${decision} the action.` }
}
```

**事件翻译**(`engine.ts:256-281`):`agent.subscribe((e) => translator.handle(e))`,把 pi 的 `AgentEvent` 翻译成 SwarmAgents 自己的 `TaskEvent`(经 `translator.ts`),再由 `emit.ts` 发到 IPC/UI。`turn_end` 时从 `e.message.usage` 抽 token/cost 写入 `used`。

**运行 + 模型 fallback + 重试**(`engine.ts:301-364`):这是 SwarmAgents 相对 pi 最显著的增值之一。`run(prompt)` 里是双层循环:

```ts
for (let modelIdx = 0; modelIdx < modelChain.length; modelIdx++) {   // 模型 fallback 链
  if (modelIdx > 0) { model = modelChain[modelIdx]; agent.state.model = model }  // 原地换模型
  for (let attempt = 0; attempt <= maxRetries; attempt++) {           // 重试
    ...
    await agent.prompt(prompt, images)                                // pi 的 prompt()
    // 处理 stopCause: cancelled / budget / iterations / context → 各自 terminal
    // 否则按 decideNextAttempt 重试策略决定是否换模型/重试
  }
}
```

> 注:pi 原生 `AgentSession` 也内置了 `modelFallbackMessage`、`auto_retry`、`isRetryableAssistantError`(`agent-session.ts:298-300` 等),即 fallback/retry **不是 SwarmAgents 独有**。但 SwarmAgents 选择不用 `AgentSession`,而是用更底层、更可控的 `Agent` + 自写策略(`retry.ts` 的 `decideNextAttempt`/`isPermanentModelFailure`/`MAX_PROMPT_RETRIES`),原因是它要把预算、权限、swarm 子任务开销统一纳入自己的熔断链。

### 2.3 构造方式对比小结

| 维度 | pi 原生(coding-agent) | SwarmAgents |
|---|---|---|
| 构造点 | `core/sdk.ts:294` 的 `createAgentSession()` | `message-engine/engine.ts:151` 的 `createEngine()` |
| 直接 new 的类 | `Agent`(然后包进 `AgentSession`) | `Agent`(不包 `AgentSession`) |
| 会话抽象 | `AgentSession` + `AgentSessionRuntime`(pi 提供) | 自建 `engine` + `session-service.ts`(SwarmAgents) |
| `streamFn` | 自定义闭包,接 `ModelRegistry` auth + 扩展钩子 | 用 pi 默认(由 `models.ts` 的 `resolveModel` 准备 `Model`) |
| `convertToLlm` | 自定义,翻译 coding-agent 专有消息类型 | 用 pi 默认(SwarmAgents 的消息就是标准 user/assistant/toolResult) |
| fallback/retry | `AgentSession` 内置 auto-retry + modelFallback | engine 自写 `modelChain` + `decideNextAttempt` |
| 预算熔断 | 无内置(靠 settings 的 token 限制) | 五重熔断:calls / wallMs / usdCents / maxTurns / context |
| 权限拦截 | 扩展 `tool_call` 事件(可选) | `beforeToolCall` 内强制 `permissionRegistry.request` |
| 模型循环结构 | `while (_handlePostAgentRun()) agent.continue()` | 双层 for:`for model in chain { for attempt in retries { agent.prompt() }}` |

---

## 3. 工具(Tools)体系对比

两边都用 pi 的 `AgentTool` 接口定义工具,但定义方式、返回内容、上下文注入完全不同。

### 3.1 pi 的 `AgentTool` 接口(共同基座)

来自 `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:325-345`(即 `packages/agent/src/types.ts`):

```ts
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  label: string                                                              // UI 显示名
  prepareArguments?: (args: unknown) => Static<TParameters>                  // schema 校验前垫片
  execute: (toolCallId: string, params: Static<TParameters>, signal?: AbortSignal,
            onUpdate?: AgentToolUpdateCallback<TDetails>) => Promise<AgentToolResult<TDetails>>
  executionMode?: 'sequential' | 'parallel'                                  // 执行模式
}
// Tool 基类(pi-ai): { name, description, parameters: TSchema }
// AgentToolResult<T>: { content: (TextContent|ImageContent)[]; details: T; terminate? }
```

pi 的循环负责:查表 → `prepareArguments` → schema 校验 → `beforeToolCall`(可 block)→ `execute`(捕获抛错转 error result)→ `afterToolCall`(可覆盖 content/details/isError/terminate)→ 顺序/并行调度(`agent-loop.ts:413-755`)。**这些循环细节 SwarmAgents 全部白嫖** —— 它不需要重写工具调度。

### 3.2 pi 原生工具:两层抽象 + TUI 耦合

pi 的内置工具在 `packages/coding-agent/src/core/tools/`,共 7 个:`read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`(`tools/index.ts:83-84`)。默认活跃集 `createCodingTools = [read, bash, edit, write]`(`tools/index.ts:138-145`)。

pi 有**两层抽象**:
- `ToolDefinition`:应用层,带 UI 渲染 / `promptSnippet` / `promptGuidelines` / 可插拔 `Operations`
- `AgentTool`:核心层(§3.1)
- 桥接在 `tools/tool-definition-wrapper.ts`:`wrapToolDefinition(def, ctxFactory)`

以 `bash` 为例(`tools/bash.ts`):
- `bashSchema = Type.Object({ command: Type.String(...), timeout: Type.Optional(...) })`(`bash.ts:40-43`)
- `execute` 内部用可插拔 `BashOperations`(默认 `createLocalBashOperations`,通过 `spawn` 跑;可换 SSH 等远端,`bash.ts:56-74`)
- 流式输出经 `OutputAccumulator` 节流,通过 `onUpdate` 上报;返回 `AgentToolResult<{truncation, fullOutputPath}>`(截断时存临时文件)

**关键耦合:pi 原生工具大量 import `@earendil-works/pi-tui`**:
- `read.ts`:`import { Text } from "@earendil-works/pi-tui"` + `highlightCode` + `theme`
- `bash.ts`:`import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui"`
- `edit.ts`:`import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui"` + `renderDiff`
- `write.ts`:`import { Container, Text } from "@earendil-works/pi-tui"`

也就是说,pi 工具的**返回内容里直接嵌入了 TUI 渲染组件**(`content` 是给模型看的纯文本,但 `details` / 渲染路径是终端组件)。这决定了它们无法被 Electron 应用直接复用 —— SwarmAgents 必须自建工具集。

### 3.3 SwarmAgents 工具:`ToolSpec` 工厂 + 上下文注入 + swarm 能力

SwarmAgents 在 `apps/desktop/src/service/tools/`(及 `service/calendar`、`service/gmail` 等)自建了完整工具集。核心抽象是 `ToolSpec`(`tools/registry.ts`):

```ts
export type ToolRisk = 'low' | 'medium' | 'high'
export interface ToolRunContext {
  sessionId: string; taskId?: string; cwd?: string
  spawnChild(prompt, opts?): Promise<DelegateResult & { messageId: string }>     // 派生子 agent
  createTask?(prompt, agentType?): Promise<...>                                   // top-level work
  requestPermission(args): Promise<PermissionDecision>
  findPeers(q: PeerQuery): Peer[]                                                 // 发现同伴 agent
  analyzeImage?(prompt, image): Promise<string>                                   // 视觉/OCR
  writeAgent?(def): AgentMutationResult; writeSkill?(skill): SkillMutationResult  // 训练团队专用
  reportExternalUsage?(usage): void                                               // 外部开销记账
  setDelegationPlan?(plan): void; mergeDelegationResult?(...): void               // 委派 DAG
  reportResult?(artifacts): void                                                  // 子 agent 上报结果
}
export interface ToolSpec {
  group: string          // 'peekaboo' | 'agent' | 'fs' | 'web' | 'memory' | 'skill' | <mcp-server>
  name: string           // 模型面见的裸名
  risk: ToolRisk
  riskFor?: (args) => ToolRisk          // 按参数动态定级
  source: 'builtin' | 'mcp'
  build(ctx: ToolRunContext): AgentTool  // 工厂:接收运行时上下文,产出 pi AgentTool
}
```

**设计差异要点**:
1. **工厂模式**:`ToolSpec.build(ctx)` 是工厂 —— 每个 tool 是一个接收 `ToolRunContext` 的工厂,产出 pi 的 `AgentTool`。pi 原生工具是无上下文的纯函数风格(或带 `Operations` 注入)。这因为 SwarmAgents 的每个工具调用都需要拿到当前 session/task/权限/swarm 能力。
2. **swarm 能力注入**:`ToolRunContext` 把整个 swarm 生态注入到每个工具里 —— `spawnChild`(派生子 agent)、`findPeers`(发现同伴)、`createTask`(top-level work)、`setDelegationPlan`/`mergeDelegationResult`(委派 DAG)、`reportExternalUsage`(外部开销记账)。**pi 原生工具完全没有这些概念** —— 它们是单 agent 的文件/命令操作。
3. **风险分级**:`risk: 'low'|'medium'|'high'` + `riskFor(args)` 动态定级,直接驱动 §2.2 的权限熔断。pi 原生没有风险分级概念(靠扩展事件可选拦截)。

**SwarmAgents 工具清单**(按 group,代表性,非完整):

| group | tools | pi 有无对应 |
|---|---|---|
| `fs` | `read_file` `edit_file` `write_file` `list_dir` `grep` `glob` | ✅ pi 有 read/edit/write/ls/grep/find(SwarmAgents 自实现,无 TUI 耦合) |
| `shell` | `run_shell` | ✅ pi 有 bash |
| `web` | `fetch` `web_search`(brave/duckduckgo/searxng/tavily) | ❌ pi 无(靠扩展) |
| `agent` | `delegate` `find_agents` `report_result` `set_delegation_plan` `update_plan` | ❌ pi 无(swarm 专有) |
| `memory` | `remember` `recall` `forget` | ❌ pi 无 |
| `vision` | `analyze_image` `ocr_image` | ❌ pi 无 |
| `ui` | `render_ui` `see_screen`(peekaboo) `click`/`type`/`scroll`/`hotkey`/`list_apps` | ❌ pi 无(桌面操控) |
| `claude-code` (`cc_*`) | `cc_start` `cc_send` `cc_observe` `cc_approve` `cc_stop` `cc_interrupt` | ❌ pi 无(外部 CLI 嵌入) |
| `authoring` | `write_agent` | ❌ pi 无(训练团队) |
| `skill` | `use_skill` | ⚠️ pi 有 skills 概念但实现不同 |
| `cron` | `schedule_task` `cancel_scheduled_task` `list_scheduled_tasks` `list_task_runs` | ❌ pi 无 |
| `time` | `current_time` | ❌ pi 无 |
| `weather` | `get_weather` | ❌ pi 无 |
| `calendar` | `list_upcoming` `get_event` `create_local` `update_local` `delete_local` | ❌ pi 无 |
| `gmail` | `search` `get_thread` `list_recent` | ❌ pi 无 |

以 `delegate`(`tools/delegate.ts`)为例,它直接用 `Type.Object` 定义 schema,`execute` 里调 `ctx.spawnChild()` 或 `ctx.createTask()`,并把子任务 `status`(completed/failed/cancelled)前缀到返回文本,避免模型把失败子任务的摘要误读为成功 —— 这是 swarm 语义特有的细节。

### 3.4 工具对比小结

| 维度 | pi 原生 | SwarmAgents |
|---|---|---|
| 抽象 | `ToolDefinition` + `AgentTool` 两层 | `ToolSpec`(工厂)+ `AgentTool` 一层 |
| schema 库 | typebox `Type`(pi-ai) | 同:typebox `Type`(pi-ai)—— **完全一致** |
| 定义方式 | 无上下文纯函数 + 可选 `Operations` 注入 | `build(ctx: ToolRunContext)` 工厂,强上下文 |
| 渲染耦合 | 强耦合 `pi-tui`(Text/Container/theme/高亮) | 无 TUI 耦合,返回纯数据,UI 在 React renderer |
| 数量 | 7 个(read/bash/edit/write/grep/find/ls) | 50+(含 calendar/gmail/web/vision/ui/claude-code/memory/cron...) |
| swarm 能力 | 无 | `spawnChild`/`findPeers`/`setDelegationPlan` 等注入每个工具 |
| 风险分级 | 无 | `low/medium/high` + 动态 `riskFor`,驱动权限 |
| 调度(顺序/并行) | pi loop 内置 | **复用 pi loop 内置**(白嫖) |

---

## 4. Provider / 模型层对比

### 4.1 pi 的 provider 体系(`pi-ai`)

pi-ai 的 provider 是工厂函数,返回 `Provider<TApi>`(`packages/ai/src/models.ts:33-73`),通过 `createProvider()` 组装,挂 auth + models 列表 + `api: ProviderStreams`(`stream`/`streamSimple`)。核心概念:

- **`Api`**(`packages/ai/src/types.ts:15-26`):协议而非厂商,枚举 9 种:`openai-completions`、`openai-responses`、`openai-codex-responses`、`azure-openai-responses`、`anthropic-messages`、`google-generative-ai`、`google-vertex`、`mistral-conversations`、`bedrock-converse-stream`
- **`Model<TApi>`**(`types.ts:697-722`):含 `id/name/api/provider/baseUrl/reasoning/input[]/cost/contextWindow/maxTokens` + `thinkingLevelMap` + `compat`
- **兼容层三套**:`OpenAICompletionsCompat`(`types.ts:477-524`,一堆开关:`supportsStore`/`maxTokensField`/`thinkingFormat: "openai"|"openrouter"|"deepseek"|"zai"|"qwen"|...`)、`OpenAIResponsesCompat`、`AnthropicMessagesCompat`
- **运行时 `Models`**(`models.ts:80-129`):`createModels()` 持有多 provider,负责 auth 解析(`applyAuth`,`models.ts:231-257`)并 dispatch。`stream`/`streamSimple` 用 `lazyStream` 延迟到 auth 解析完成
- **旧全局 API**(`compat.ts`):`streamSimple`/`completeSimple` + `apiProviderRegistry`,注释标明是 ModelManager 迁移前的过渡层

**thinking/reasoning**:`ThinkingLevel = "minimal"|"low"|"medium"|"high"|"xhigh"|"max"`(agent-core 加 `"off"`);`ThinkingLevelMap` 把抽象 level 映射到 provider 具体值;`clampThinkingLevel(model, level)`(`models.ts:421-440`)在不支持时向后/向前找最近 level,兜底 `"off"`;`getSupportedThinkingLevels(model)` 列出支持项。

### 4.2 SwarmAgents 的 provider 层

SwarmAgents 在 `apps/desktop/src/main/providers/` 自建了 provider 管理:

- `service.ts` / `store.ts`:provider 配置的持久化与读写
- `openrouter.ts`:OpenRouter 适配(SwarmAgents 的主 provider 之一)
- `capabilities.ts`:用 pi-ai 的 `KnownProvider` 判定能力
- `redact.ts`:敏感信息脱敏
- `test-connection.ts`:连通性测试

`packages/shared/src/constants/models.ts`:定义 SwarmAgents 自己的模型常量目录。

**模型如何注入 engine**:`message-engine/models.ts` 的 `resolveModel` 把 SwarmAgents 的 provider 配置 + agent definition 解析成 pi-ai 的 `Model` 对象,喂给 `engine.ts:182` 的 `initialState.model`。SwarmAgents 直接复用 pi-ai 的 `clampThinkingLevel`(`engine.ts:187`)、`Model`、`Api`、`ImageContent`、`Usage` 类型。

**对比要点**:SwarmAgents **没有复用 pi-ai 的 provider 工厂和 `Models` 运行时**,而是自己管 provider 配置(store),只借用 pi-ai 的 `Model`/`Api` 数据类型和 `clampThinkingLevel` 等纯函数。`getApiKey` 由 `engine.ts:152` 的 `() => deps.provider.apiKey` 直接返回,不走 pi 的 `ModelRegistry.getApiKeyAndHeaders`。

### 4.3 thinking level 的处理

| 维度 | pi 原生 | SwarmAgents |
|---|---|---|
| level 定义 | pi-ai 提供(同源) | 复用 pi-ai(同源) |
| 钳制函数 | `clampThinkingLevel`(`models.ts:421`) | 复用(`engine.ts:187`) |
| 默认值 | settings 配置 | `deps.provider.thinkingLevel ?? 'high'`(`engine.ts:187`) |
| 注入点 | `Agent.initialState.thinkingLevel`(`sdk.ts:240`) | `Agent.initialState.thinkingLevel`(`engine.ts:187`)—— **同接口** |

---

## 5. 多 Agent / swarm 编排对比(最大差异点)

这是两边设计哲学分歧最大的地方。

### 5.1 pi-orchestrator:多进程 RPC 实例管理

pi-orchestrator(`packages/orchestrator/src`)的 `OrchestratorSupervisor`(`supervisor.ts`)管理的是**多个独立的 coding-agent 进程实例**:

- `InstanceRecord`(`types.ts`):`{ id, status: "starting"|"online"|"stopping"|"stopped"|"error", cwd, sessionId, sessionFile, radiusPiId }`
- 每个 instance 是一个 `RpcProcessInstance`(独立 RPC 子进程,跑完整 `pi-coding-agent` 的 `runRpcMode`)
- 通信走 IPC/RPC 协议(`ipc/protocol.ts`、`ipc/server.ts`、`ipc/client.ts`),命令集:`new_session`/`switch_session`/`fork`/`clone`/`prompt`/`get_state` 等
- `radius.ts` + `RadiusRegistration`:跨机器发现(`radiusPiId`),即 orchestrator 可管多台机器上的 pi 实例
- `SESSION_METADATA_COMMANDS`(`supervisor.ts:33-41`):只有会改变 session 身份的命令后才刷新持久化元数据

**本质**:orchestrator 是"管理一群独立 CLI 实例的 supervisor",agent 之间是**松耦合的独立进程**,通过 RPC 通信,没有"组织架构"或"角色委派"概念。它面向的是"在多台机器/多个项目上并行跑多个 pi 会话"。

### 5.2 SwarmAgents:单进程内组织架构式委派

SwarmAgents 的 swarm 是**单进程内**的轻量递归委派,核心是"组织架构 + 角色委派"模型:

**组织树**(`packages/shared/src/agents/org-tree.ts`):
- `AgentDefinition` 有 `role`(`'ceo'`/...)/`team`/`teamRole`(`'head'`/成员)/`parentId`/`capabilities`
- `buildOrgForest(agents)` 构建组织森林:CEO → team head → team member;无 parentId 时按 role/team 推断父节点;**环检测**:父链会自环的 agent 提升为 root,保证结果总是森林不循环

**委派图**(`packages/shared/src/agents/delegation.ts`):
- `buildDelegationEdges(agents)`:**静态分析**每个 agent 的 `systemPrompt` 里的 `find_agents({role, team, capability, ...})` 调用,解析出"谁想委派给谁"的**设计意图边**(`DelegationEdge = {from, to}`)。注意这是设计意图,不是运行时观测,也不是强制的能力边界

**运行时委派**(`session-service.ts` + `tools/delegate.ts`):
- `delegate` tool 的 `execute` 调 `ctx.spawnChild(prompt, {agentType, suggestedTools, providerKey})`(子任务)或 `ctx.createTask(prompt)`(top-level work)
- `spawnChild` 的实现就是 `session-service.ts:523` 的 `delegate()` —— **递归调用 `launchMessage({kind:'child'})`**,在同一 session 内启动一个子 message:
  ```ts
  const delegate = async (session, parentMessageId, prompt, opts) => {
    const def = cfg.agentStore?.get(opts.agentType) ?? DEFAULT_AGENT_DEF   // 按角色找 agent 定义
    const resolvedProvider = applyAgentModel(lookedUp ?? session.provider, def)
    const r = await launchMessage({
      kind: 'child', sessionId: session.id, parentMessageId,
      agent: withPrompt(def), provider: resolvedProvider, prompt,
      budget: budgets().sub,                                              // 子预算
      tools: opts.suggestedTools ?? allowlistForAgent(def),
      getPermissionMode: () => resolvePermissionMode(session.id),         // 继承 session 权限模式
      maxIterationsOverride: budgets().maxIterations,
      onDelegationPlan: (plan) => setDelegationPlanForSession(...),       // 委派 DAG 回写
      onDelegationUpdate: (itemId, delta) => mergeDelegationResultForSession(...),
    }, basePorts(session))
    return { messageId: r.messageId, status: r.status, summary: r.summary, artifacts: r.artifacts ?? [] }
  }
  ```
- 子 agent = 同进程、同 session 里递归跑的新 message;用子预算(`budgets().sub`);继承 session 的权限模式(一旦用户给 session 授 `full`,委派的子 agent 不再二次打扰);按 `agentType` 切换角色(每个角色有独立 systemPrompt/tools allowlist/model tier)

**委派计划**(`tools/delegation-plan.ts` + `agent.set_delegation_plan`):agent 可以先声明一个委派 DAG(多项 `{id, prompt, agentType}`,带状态 running/completed/failed),然后逐项 `delegate(..., itemId)` 执行,结果经 `mergeDelegationResult` 回写计划状态。

**外部 agent 嵌入**(`service/claude-code/` + `tools/claude-code.ts`):SwarmAgents 还能把外部 **Claude Code CLI** 当作一个工具组嵌入(`cc_start`/`cc_send`/`cc_observe`/`cc_approve`/`cc_stop`/`cc_interrupt`)。`cc_start` 通过 `ClaudeCodeManager` 启动一个 Claude Code session,`cc_approve` 处理其工具审批请求,`chargeUsage` 把 Claude Code 的增量成本记账到任务预算(`tools/claude-code.ts` 的 `chargeUsage`)。这是"在 pi agent 循环里调用另一个厂家的 agent CLI"的集成模式。

### 5.3 编排对比小结

| 维度 | pi-orchestrator | SwarmAgents swarm |
|---|---|---|
| 编排粒度 | 多个独立 **进程** 实例(完整 coding-agent) | 单进程内 **message** 递归(子任务) |
| 通信 | IPC/RPC 协议(`new_session`/`prompt`/`get_state` 等) | 直接函数调用 + `ToolRunContext` 闭包 |
| agent 关系 | 松耦合独立进程,无角色概念 | 组织架构(CEO/head/member)+ 角色委派 |
| 角色定义 | 无 | `AgentDefinition`(role/team/teamRole/capabilities/parentId) |
| 委派触发 | 用户/RPC 命令显式 | `delegate` tool + `find_agents` 自动发现 + `set_delegation_plan` |
| 发现机制 | `radius`(跨机器) | `findPeers`(按 role/team/capability 查目录 `receptionist`) |
| 跨机器 | ✅ 支持 | ❌ 单机单进程 |
| 外部 agent | 不支持(只管 pi 实例) | ✅ Claude Code CLI 作为工具组嵌入 |
| 预算继承 | 无 | 子任务用 `budgets().sub`,权限继承 session |
| 持久化 | `instances.json` + 各实例 session JSONL | SwarmAgents 自己的 session/消息持久化 |

**哲学差异**:pi-orchestrator 是"管理一群独立 CLI 进程的 ops supervisor"(横向扩展、运维导向);SwarmAgents swarm 是"一个公司组织架构内的任务分解与委派"(纵向层级、业务导向)。

---

## 6. 会话持久化与生命周期对比

| 维度 | pi 原生 | SwarmAgents |
|---|---|---|
| 持久化 | `SessionManager`(JSONL 流式,`session-manager.ts:487-529`) | 自建 session service(`session-service.ts`) + IPC |
| 分支 | `getBranch()`/`fork`/`switchSession`(树状分支) | 通过 message 树 + delegate 父子关系 |
| compaction | `AgentSession` 内置 auto-compaction(`compaction/`,`shouldCompact`/`compact`/`generateBranchSummary`) | 见近期 commit 有 analysis-run factory 迁移(自建) |
| session 切换 | `AgentSessionRuntime.switchSession`(teardown→重建) | `createAgentDirectory` + `session-service` 管理 |
| 模式 | interactive/print/rpc 三种 mode 驱动同一 `AgentSession` | Electron main↔renderer IPC 驱动 |

SwarmAgents 舍弃 pi 的 `SessionManager`/`AgentSession` 是必然的:pi 的 session 抽象深度绑定了 JSONL 文件、compaction 算法、branch 树和 CLI 交互模式,而 SwarmAgents 需要 Electron IPC、自己的预算/权限/swarm 语义。

---

## 7. 事件流与 UI 渲染对比

**pi**:agent loop 发 `AgentEvent`(`agent_start`/`turn_*`/`message_*`/`tool_execution_*`,`types.ts:415-430`)→ `Agent.processEvents` reduce 内部 state → 按订阅顺序 await listener。listener 在 coding-agent 里是 `AgentSession._handleAgentEvent`(写 SessionManager),在 mode 里是 TUI 渲染器。`AssistantMessageEvent`(pi-ai)是 provider 流协议(`start`/`text_*`/`thinking_*`/`toolcall_*`/`done`/`error`),loop 把它翻成 `AgentEvent`。

**SwarmAgents**:复用同一套 `AgentEvent`(`engine.ts:256` 的 `agent.subscribe`),但经 `message-engine/translator.ts` 翻成 SwarmAgents 的 `TaskEvent`,再由 `emit.ts` 经 IPC 发到 React renderer 渲染。`turn_end` 时抽 `usage` 更新 `used`(token/cost)。还会把 pi 的泛化 "Operation aborted" 工具结果改写成真实 stopCause(`engine.ts:270-279`),让 transcript 与终止原因一致。

**渲染差异**:pi 的渲染绑定 `pi-tui`(终端组件);SwarmAgents 的渲染是 React(`apps/desktop/src/renderer`,用 `Streamdown` 渲染流式 markdown,见 `article-detail-panel.tsx` 等)。这是舍弃 `pi-tui` 的根本原因。

---

## 8. 系统提示词组装对比

**pi**(`core/system-prompt.ts:28-173` 的 `buildSystemPrompt`):按需拼接 customPrompt(否则内置"expert coding assistant operating inside pi"模板)→ Available tools 列表(只列有 snippet 的)→ Guidelines(动态:如只有 bash 没 grep/find/ls 时提示用 bash 做文件操作)→ `<project_context>`(如 AGENTS.md)→ skills → Current date/cwd。`AgentSession._rebuildSystemPrompt()` 每轮刷新,扩展可在 `before_agent_start` 改写。

**SwarmAgents**(`message-engine/models.ts` 的 `composeSystemPrompt`):`composeSystemPrompt(deps.agentDefinition.systemPrompt, { cwd, executionMode })` —— 每个 agent 角色有自己的 `systemPrompt`(`AgentDefinition.systemPrompt`),加上 cwd 和执行模式(direct/plan)。`shared/src/agents/default-prompt.ts` 提供默认 prompt。组织架构角色(CEO/PM/工程师等)的 prompt 在 agent 定义里。

---

## 9. 接缝总结:SwarmAgents 复用 pi 的精确边界

把所有对比收敛成一张"接缝图":

```
┌─ pi-ai ─────────────────────────────────────────────┐
│  ✅ Type(typebox schema)        ← 两边工具定义共用    │
│  ✅ Model / Api / ImageContent / Usage 类型          │ ← SwarmAgents 借用数据类型
│  ✅ clampThinkingLevel / getSupportedThinkingLevels  │ ← SwarmAgents 复用纯函数
│  ⚠️ KnownProvider(仅 capabilities 判定)              │
│  ❌ provider 工厂 / Models 运行时 / compat 全局 API   │ ← SwarmAgents 自建 provider store
└──────────────────────────────────────────────────────┘
┌─ pi-agent-core ─────────────────────────────────────┐
│  ✅ Agent 类(唯一实例化点 engine.ts:151)             │
│     ✅ initialState / prompt() / abort() / subscribe │
│     ✅ beforeToolCall / prepareNextTurn / onPayload   │ ← SwarmAgents 注入自己的熔断/权限
│  ✅ AgentTool 接口(所有工具实现这个)                 │
│  ✅ agent-loop 主循环(顺序/并行调度,白嫖)            │
│  ✅ AgentMessage / AgentEvent / AgentToolResult 类型  │
│  ✅ schema 校验 / prepareArguments / afterToolCall    │
└──────────────────────────────────────────────────────┘
┌─ pi-coding-agent ───────────────────────────────────┐
│  ❌ AgentSession / AgentSessionRuntime                │ ← SwarmAgents 自建 engine
│  ❌ SessionManager(JSONL/branch/compaction)           │ ← SwarmAgents 自建 session service
│  ❌ ModelRegistry / model-resolver                    │ ← SwarmAgents 自建 provider store + resolveModel
│  ❌ system-prompt buildSystemPrompt                   │ ← SwarmAgents 自建 composeSystemPrompt
│  ❌ 内置 tools(read/bash/edit/write/grep/find/ls)     │ ← TUI 耦合,SwarmAgents 全自建
│  ❌ modes(interactive/print/rpc)                      │ ← SwarmAgents 用 Electron IPC
│  ❌ sdk.ts 的 streamFn 闭包(auth/header/扩展钩子)     │ ← SwarmAgents 用 getApiKey 直返
└──────────────────────────────────────────────────────┘
┌─ pi-tui / pi-orchestrator ──────────────────────────┐
│  ❌ 全部不用                                          │
└──────────────────────────────────────────────────────┘
```

**一句话:SwarmAgents 复用 pi 的"agent 主循环 + 工具调度 + LLM 数据类型与纯函数",自建"会话、provider、工具内容、权限/预算/重试、swarm 组织委派、UI"。**

---

## 10. 评价与观察

### 10.1 这种集成模式的合理性

SwarmAgents 的选择是**理性且必要的**:
- pi 的 `Agent`/`agent-loop`/`AgentTool` 是真正框架无关的(无 IO、无 UI、无持久化),复用成本低、收益高(省去重写一个带顺序/并行调度、schema 校验、事件流、steering 队列的 agent 循环)。
- pi 的 `AgentSession`/`SessionManager`/内置 tools 深度绑定 CLI/TUI/JSONL,与 Electron 桌面 + swarm 组织模型不兼容,复用反而要大量打洞,不如自建。
- pi-ai 的 `Model`/`Api`/`Type`/`clampThinkingLevel` 是稳定的数据类型和纯函数,几乎零成本复用。

### 10.2 潜在风险与耦合点

1. **版本绑定**:SwarmAgents 锁 `^0.80.6`,pi 还在快速迭代(0.80.x)。`Agent` 的 hook 签名(`beforeToolCall`/`prepareNextTurn`/`initialState`)、`AgentTool` 接口、`AgentEvent` union 一旦在 minor 版本变动,SwarmAgents 的 engine/tools/translator 都要跟。建议关注 pi 的 CHANGELOG(`packages/coding-agent/CHANGELOG.md` 45 万字符)。
2. **`Agent.state` 直接写**:SwarmAgents 在 `engine.ts:309` 直接 `agent.state.model = model` 做 fallback,在 `engine.ts:268` 读 `agent.state.messages`。这是依赖 pi 的 `AgentState` 是可变引用的内部约定,属较脆的耦合。
3. **消息翻译的脆弱性**:`translator.ts` 把 `AgentEvent` 翻成 `TaskEvent`,`engine.ts:270-279` 还魔改 "Operation aborted" 文本。pi 的 `AgentEvent` union 扩展时,翻译层需同步。
4. **双 skip 的重复实现**:SwarmAgents 自建的 fallback/retry/permission 与 pi `AgentSession` 内置的 auto-retry/modelFallback 功能重叠。若未来 pi 把这些能力下沉到 `Agent` 层(更底层),SwarmAgents 可能受益于直接用,减少自维护量;但也可能因接口变动而被迫改。

### 10.3 值得 SwarmAgents 借鉴的 pi 能力

- **compaction**:pi 的 `compaction/`(`shouldCompact`/`compact`/`generateBranchSummary`/`calculateContextTokens`)是一套成熟的上下文压缩方案。SwarmAgents 目前靠 `contextTokens > contextWindow` 熔断(§2.2 ④),但没有自动压缩续跑。若长会话变多,可考虑移植。
- **steering / followUp 队列**:pi 的 `Agent` 支持 `steer()`/`followUp()` + `PendingMessageQueue`(`"all"|"one-at-a-time"` 两种 drain)。SwarmAgents 若要做"会话中途插入指令"会更顺手。
- **`OpenAICompletionsCompat` 的 `thinkingFormat` 矩阵**:pi 已经处理了 openrouter/deepseek/zai/qwen/together 等一堆 OpenAI 兼容端点的 thinking 格式差异(`packages/ai/src/api/openai-completions.ts:600-643`)。SwarmAgents 若用 pi-ai 的 provider 而非自建,能省去自己处理这些兼容性。

### 10.4 值得 pi 借鉴的 SwarmAgents 能力

- **风险分级 + 强制权限**:`ToolRisk` + `riskFor(args)` + `permissionRegistry` 是一套干净的"工具危险性"模型,pi 的扩展事件机制相对松散。
- **五重熔断**:calls/wallMs/usdCents/maxTurns/contextWindow 统一在 `beforeToolCall` + `prepareNextTurn` 拦截,比 pi 的纯 token 限制更全面。
- **组织架构式 swarm**:`buildOrgForest` + `buildDelegationEdges` + `delegate`/`find_agents`/`set_delegation_plan` 是一种独特的多 agent 编排范式,比 pi-orchestrator 的多进程管理更贴近"团队协作"语义。

---

## 附录 A:关键文件索引

### pi 侧
- `packages/agent/src/agent.ts` — `Agent` 类(stateful wrapper)
- `packages/agent/src/agent-loop.ts` — 主循环(`runAgentLoop`/`runLoop`/`streamAssistantResponse`/工具执行)
- `packages/agent/src/types.ts` — `AgentTool`/`AgentState`/`AgentEvent`/`AgentToolResult`/各 Context
- `packages/ai/src/types.ts` — `Model`/`Api`/`Context`/`Tool`/三套 Compat/`ThinkingLevel`
- `packages/ai/src/models.ts` — `Models`/`Provider`/`clampThinkingLevel`/`getSupportedThinkingLevels`
- `packages/ai/src/compat.ts` — 旧全局 API + `apiProviderRegistry`
- `packages/coding-agent/src/core/sdk.ts` — **唯一 `new Agent` 点**(`createAgentSession`)
- `packages/coding-agent/src/core/agent-session.ts` — `AgentSession`(会话抽象,108KB)
- `packages/coding-agent/src/core/agent-session-runtime.ts` — 会话生命周期
- `packages/coding-agent/src/core/system-prompt.ts` — `buildSystemPrompt`
- `packages/coding-agent/src/core/session-manager.ts` — JSONL 持久化/分支/compaction
- `packages/coding-agent/src/core/model-registry.ts` — 模型/key 解析
- `packages/coding-agent/src/core/tools/{bash,read,edit,write,grep,find,ls}.ts` — 内置工具
- `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts` — `ToolDefinition↔AgentTool` 桥接
- `packages/coding-agent/src/modes/{interactive,print-mode,rpc}` — 三种驱动 mode
- `packages/orchestrator/src/supervisor.ts` — 多进程实例编排

### SwarmAgents 侧
- `apps/desktop/package.json:36-37` — pi 依赖声明
- `apps/desktop/electron.vite.config.ts:25,32` — ESM-only 内联配置
- `apps/desktop/src/service/message-engine/engine.ts` — **唯一 `new Agent` 点** + 五重熔断 + fallback/retry
- `apps/desktop/src/service/message-engine/translator.ts` — `AgentEvent`→`TaskEvent` 翻译
- `apps/desktop/src/service/message-engine/models.ts` — `resolveModel`/`composeSystemPrompt`
- `apps/desktop/src/service/message-engine/{launch,emit,retry}.ts` — 启动/事件发射/重试策略
- `apps/desktop/src/service/tools/registry.ts` — `ToolSpec`/`ToolRunContext` 定义
- `apps/desktop/src/service/tools/*.ts` — 全部自建工具(delegate/fs/shell/web/vision/ui/claude-code/memory/...)
- `apps/desktop/src/service/session/session-service.ts` — session 驱动 + `delegate()`/`spawnChild`
- `apps/desktop/src/service/claude-code/manager.ts` — Claude Code CLI 嵌入
- `apps/desktop/src/main/providers/` — provider store/openrouter/capabilities/test-connection
- `packages/shared/src/agents/org-tree.ts` — 组织森林构建
- `packages/shared/src/agents/delegation.ts` — 委派意图图(静态分析)
- `packages/shared/src/agents/default-prompt.ts` — 默认 system prompt
- `packages/shared/src/constants/models.ts` — 模型常量

---

*调查方法:只读代码分析(pi 源码 + SwarmAgents node_modules 中 pi 的编译产物 .d.ts + SwarmAgents 源码),未运行、未修改任何代码。pi 侧深度调查由并行 subagent 完成,SwarmAgents 侧由主调查直接完成。*
