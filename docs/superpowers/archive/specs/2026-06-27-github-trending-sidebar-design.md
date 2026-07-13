# GitHub 趋势侧栏 — 设计文档

日期：2026-06-27
状态：待实现

## 1. 背景与目标

在左侧栏新增 "GitHub 趋势" 入口，展示近期热门开源仓库的排行榜，参考
`references/ossinsight` 的 trending 实现（即 github.com/trending 的增强替代品：
按时间段内 stars/forks/PR/push 的加权得分排名，可按语言筛选）。

OSSInsight 的趋势数据来自一个 TiDB 数据仓库（100 亿+ GitHub 事件 + API server +
数据管道），桌面 app 无法也不需要复刻这套后端。本功能**直接消费 OSSInsight 的
公开 REST API**，复用其算法与数据。

成功标准：
- 侧栏底部出现 "GitHub 趋势" 图标，点击进入 `/trending` 全屏视图。
- 视图支持按周期（4 档）和语言筛选，展示排行榜列表。
- 点击某个仓库 → 新建一个会话，自动投喂调研该仓库的 prompt 并跳转。
- 网络请求走主进程，与现有 IPC 架构一致；含结构化日志与基本测试。

## 2. 数据源

OSSInsight 公开 REST API：

```
GET https://api.ossinsight.io/v1/trends/repos/?period={period}&language={language}
```

- `period`：`past_24_hours` | `past_week` | `past_month` | `past_3_months`，默认 `past_24_hours`
- `language`：`All` | `JavaScript` | `Python` | `Rust` | … （需 URI 编码，如 `C++` → `C%2B%2B`），默认 `All`
- 响应体：`{ type, data: { columns, rows, result } }`，`rows` 每项含
  `repo_id / repo_name / language / description / stars / forks / pull_requests /
  pushes / total_score / contributor_logins / collection_names`。

服务端每日刷新（`@daily`），所以客户端按 `(period, language)` 做内存缓存，TTL 1 小时。

语言枚举取 OSSInsight `trending-repos` 查询 params 中的列表，作为常量内置。

## 3. 架构

所有数据走主进程 + IPC（`window.swarm.*`），与 `web-search` 等子系统一致。渲染层
不直接对外发 HTTP。趋势功能比 web-search 更简单：只读、无加密 store、无状态广播。

```
renderer (react-query)  →  window.swarm.trending.get(period, language)
                        →  ipcMain 'trending:get'
                        →  trending-service.fetchTrending(period, language)
                        →  https://api.ossinsight.io/v1/trends/repos/
```

### 3.1 共享类型 — `src/shared/types/trending.ts`

- `TrendingPeriod`（4 档联合类型）、`TRENDING_PERIODS` 常量。
- `TrendingLanguage`（语言联合/字符串）、`TRENDING_LANGUAGES` 常量数组（含 `All`）。
- `TrendingRepo`：`{ repoName, description, language, stars, forks, pullRequests, totalScore, contributorLogins }`（从 API 的 snake_case rows 映射为 camelCase；数值字段解析为 number）。
- `TrendingResult`：`{ repos: TrendingRepo[] }`（预留错误/元信息扩展位）。

### 3.2 主进程服务 — `src/main/trending/`

- `service.ts` — `fetchTrending(period, language): Promise<TrendingRepo[]>`：
  - 校验/规整 `period`、`language`，URI 编码 language 拼 URL。
  - `fetch` API，非 2xx 抛错；解析 `data.rows` → `TrendingRepo[]`（字符串数值转 number）。
  - 内存缓存 `Map<"{period}|{language}", { at, repos }>`，命中且未过期（< 1h）直接返回。
  - 日志（pino，`component: 'trending'`）：入口 `info`（`{ msg, period, language }`）、
    缓存命中 `debug`、出口 `info`（`{ msg, count, durationMs }`）、`catch` `error`
    （`{ msg, err, period, language }`）后抛出、`rows` 为空 `warn`。
- `ipc.ts` — `wireTrendingIpc({ service })`：注册 `ipcMain.handle('trending:get', ...)`，
  校验参数（非法 period/language 回退默认），返回 `service.fetchTrending(...)`；
  `dispose()` 移除 handler。
- `index.ts` — `initTrending(): TrendingHandle`，创建 service 并 `wireTrendingIpc`，
  在 app 启动 wiring 处调用（仿 `initWebSearch`）。

### 3.3 preload — `src/preload/index.ts` + `index.d.ts`

`window.swarm.trending = { get: (period, language) => ipcRenderer.invoke('trending:get', period, language) }`，
返回 `Promise<TrendingRepo[]>`。在 `index.d.ts` 补类型。

### 3.4 渲染层 API — `src/renderer/src/lib/api.ts`

`getTrendingRepos: (period, language) => window.swarm.trending.get(period, language)`。

## 4. 渲染层 UI

### 4.1 路由 — `src/renderer/src/routes/trending.tsx`

与 `usage.tsx` 同构：`createFileRoute('/trending')({ component: TrendingView })`。

### 4.2 视图 — `src/renderer/src/components/views/trending-view.tsx`

- 顶部工具条：
  - 周期切换（4 档，可用 button-group 或 native-select）。
  - 语言选择器（下拉，复用 `ui/native-select` 或 `ui/combobox`；选项来自 `TRENDING_LANGUAGES`）。
- 列表区：react-query，key `['trending', period, language]`，`queryFn` 调 `getTrendingRepos`。
  - loading：骨架/占位。
  - error：错误提示 + 重试按钮（`refetch`）。
  - 空：空态提示。
  - 成功：每个仓库一行卡片——排名序号、`owner/repo`、描述（截断）、语言色点 + 语言名、
    ⭐ stars / forks / PR / score 指标。
- 卡片主点击区 → 发起研究会话（见 §5）。卡片右侧次要 "在浏览器打开" 外链按钮 →
  `https://github.com/{repo_name}`（`target="_blank"` / `window.open`，经 `main-window.ts` 的
  `setWindowOpenHandler` → `shell.openExternal` 在系统浏览器打开，不抢主点击）。

### 4.3 侧栏入口 — `src/renderer/src/components/app-sidebar.tsx`

在底部图标区（`/scheduled`、`/usage` 旁）新增一个 `<Link to="/trending">`，
图标用 lucide `TrendingUp`，tooltip 文案「GitHub 趋势」，沿用现有 `iconBtn` 样式与
`activeProps` 高亮模式。

## 5. 点击仓库 → 发起 Agent 研究会话

新增 hook `useResearchRepo`（`src/renderer/src/hooks/`），复用 `useSubmitGoal` 中的
`createSession → select → submitGoal → navigate` 片段，但**强制新建会话**（不复用当前
选中会话）：

1. `swarmApi.createSession()` → `sessionId`
2. `useSessionsStore.getState().select(sessionId)`
3. `swarmApi.submitGoal(sessionId, prompt, undefined, { permissionMode: 'ask', executionMode: 'goal', agentType: 'ceo' })`
4. `navigate({ to: '/session/$sessionId', params: { sessionId } })`

prompt（中文）模板：

```
调研 GitHub 仓库 {repo_name}（https://github.com/{repo_name}）：
它解决什么问题、核心技术栈、近期活跃度（{periodLabel} 内新增 {stars}⭐ / {forks} forks / {pullRequests} PR）、
以及值得关注的点。
```

`periodLabel` 为周期的中文展示（如 "过去 24 小时"）。

## 6. 错误处理

- API 失败（网络/非 2xx/解析失败）：service 抛错并记 `error` 日志；视图捕获后展示错误态 + 重试。
- 非法参数：IPC 层回退默认（`past_24_hours` / `All`），并记 `warn`。
- 会话启动失败：沿用 `useSubmitGoal` 的 mutation 错误路径，不静默吞错。

## 7. 测试

1. `service` 单测（mock `fetch`）：
   - 正常响应解析为 `TrendingRepo[]`，snake_case→camelCase、字符串数值转 number。
   - 缓存命中：同参第二次调用不再 fetch；TTL 过期后重新 fetch。
   - 非 2xx / 解析失败抛错。
2. `trending-view` 渲染态测试（mock `swarmApi.getTrendingRepos`）：loading / error+重试 / 列表 / 空态。
3. 研究会话拼装测试：给定一个 `TrendingRepo` + period，`useResearchRepo` 产出的 prompt
   含正确的 `owner/repo`、URL 与指标。

## 8. 不做（YAGNI）

- 不复刻 OSSInsight 的事件采集/打分后端。
- 不做 stars 历史曲线、贡献者地图等富图表（仅排行榜列表）。
- 不做趋势数据的本地持久化（仅内存缓存）。
- 暂不做收藏/订阅某仓库的功能。
