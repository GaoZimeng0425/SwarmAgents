# 文章收集服务(Article Collection)— 设计文档

- **日期**: 2026-07-07
- **状态**: Approved (design)
- **范围**: 新增一个"文章收集"服务入口,导航/结构与 Bilibili/Gmail 同级。浏览器插件抽取页面正文推送到 desktop,desktop 提供卡片网格 + 详情面板的收集视图与 AI 分析。

---

## 1. 目标与非目标

### 目标

1. 浏览器插件(Chrome MV3)在任意文章页一键抽取干净正文(readability),发送到 desktop。
2. desktop 提供独立的「文章」导航入口(与 Gmail / Bilibili 同级),卡片网格展示已收集文章,右侧 472px 详情面板阅读与分析。
3. 详情面板内点「AI 分析」触发 `article-analyst` 内置 agent,结构化输出(gist / points / takeaways),流式回传并缓存,可复看。

### 非目标(YAGNI)

- **不沉淀成 agent 会话**。分析结果走广播流 + 文件缓存(像 bili),不进 session store。*(用户最初提及"沉淀成会话",但在后续决策中明确选择"像 bili 的收集+分析视图",此需求已被本设计覆盖。)*
- **不做自定义分析指令**。固定使用 `article-analyst` agent,点按钮即分析。
- **不做多 peer / 远程桌面**。沿用现有单 peer loopback WS。
- **不做插件侧富 UI**。popup 只做"收集当前页"+ 状态反馈;阅读/分析都在 desktop。

---

## 2. 架构定位:一个"原创组合"

现有两个"收集 + 分析"服务用了两套不同架构。文章收集是两者的组合:

| | Gmail 模式 | Bilibili 模式 | **文章收集(本设计)** |
|---|---|---|---|
| 数据来源 | desktop OAuth 后台拉 | desktop 后台拉 | **插件推送** |
| 代码位置 | `service/`(WS 可达) | `main/`(renderer only) | **`service/`(WS 可达)** |
| WS 可达? | ✅ | ❌ | ✅(插件要调) |
| 分析实现 | `launchRun` + agent + 广播流 | 裸 `summarize()` | **`launchRun` + agent + 广播流** |
| 持久化 | — | JSON 文件 | **JSON 文件** |
| UI 结构 | 收件箱列表 + 助手卡片 | 卡片网格 + 472px 详情面板 | **卡片网格 + 472px 详情面板** |

**结论:UI 像 Bilibili,后端像 Gmail。** 后端放在 `service/`(因为 extension 要 WS 可达),而非 `main/`(bili 的位置,extension 碰不到)。这是与 bili 最重要的差异,实现时不可照搬 bili 的目录归属。

---

## 3. 数据流(端到端)

```
浏览器文章页
   │ ① content script: @mozilla/readability + turndown
   ▼
Extension background
   │ ② WS: ServiceClient.collectArticle(input)  — 不带 provider
   ▼
Desktop host bridge (透传,纯 JSON ferry)
   │
   ▼
service/article/collect.ts  ──③──▶  collected-articles.json (持久化)
   │ 返回 { ok, articleId }

   ─────────── 用户在 desktop renderer 选中文章卡片 ───────────

Desktop renderer (article-view)
   │ ④ useQuery(['articles','list'])  → 卡片网格
   │ ⑤ 点「AI 分析」→ window.swarm.article.analyze(id)
   ▼
Desktop main (article-ipc.ts)
   │ ⑥ providers.getInjection() 代注入 active provider
   │    转发给 service.analyzeArticle({ articleId, provider })
   ▼
service/article/analyze.ts
   │ ⑦ launchRun(article-analyst, prompt)  → 广播 article.analysisDelta/Complete/Error
   │ ⑧ analysisComplete 时解析 JSON → saveAnalysis 挂回 store(可复看)
   ▼
Desktop renderer 详情面板(订阅广播,流式渲染 → 完成后切结构化卡片)
```

**两条调用路径(关键):**
- **`collectArticle`**:插件 → WS → service(透传,不需 provider)。
- **`analyzeArticle`**:renderer → main IPC(代注入 provider)→ service。因为插件没有 apiKey,provider 必须由 desktop main 补全后转发。

---

## 4. 协议类型(`packages/protocol`)

新增文件 `packages/protocol/src/types/article.ts`。

```ts
import { z } from 'zod'
import { ProviderInjection } from './provider'

// 正文来源(readability 抽取后)。author/siteName/publishedTime 都可空,
// 因为 readability 不保证抽到;url/title/contentMarkdown 必需。
export const ArticleSource = z.object({
  url: z.string().url().max(4096),
  title: z.string().min(1).max(500),
  author: z.string().max(200).nullable().default(null),
  siteName: z.string().max(200).nullable().default(null),
  publishedTime: z.string().datetime().nullable().default(null),
  contentMarkdown: z.string().min(1).max(200_000), // 200k chars 上限,防滥用
})
export type ArticleSource = z.infer<typeof ArticleSource>

// 持久化的已收集文章(collected-articles.json 一条记录)。
export const CollectedArticle = ArticleSource.extend({
  id: z.string(),                       // ulid
  collectedAt: z.string().datetime(),
  excerpt: z.string().max(300),         // 正文前 300 字,卡片预览用
})
export type CollectedArticle = z.infer<typeof CollectedArticle>

// article-analyst 的结构化输出。
export const ArticleSummary = z.object({
  gist: z.string(),                     // 一句话结论
  points: z.array(z.string()),          // 核心要点
  takeaways: z.array(z.string()),       // 可带走的洞察/经验
})
export type ArticleSummary = z.infer<typeof ArticleSummary>

// 带分析缓存的完整记录(列表查询返回)。
export const CollectedArticleWithAnalysis = CollectedArticle.extend({
  summary: ArticleSummary.nullable().default(null),
  analyzedAt: z.string().datetime().nullable().default(null),
})
export type CollectedArticleWithAnalysis = z.infer<typeof CollectedArticleWithAnalysis>

// ── RPC ───────────────────────────────────────────────────────────────
// collectArticle: WS 可达(插件),不需 provider。
export const CollectArticleRequest = ArticleSource
export type CollectArticleRequest = z.infer<typeof CollectArticleRequest>
export const CollectArticleResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), articleId: z.string() }),
  z.object({ ok: z.literal(false), code: z.literal('invalid'), message: z.string() }),
])
export type CollectArticleResult = z.infer<typeof CollectArticleResult>

// analyzeArticle: renderer→main→service(main 代注入 provider)。
// fire-and-forget + 广播流,与 analyzeEmail 一致。
export const AnalyzeArticleRequest = z.object({
  articleId: z.string(),
  provider: ProviderInjection,
})
export type AnalyzeArticleRequest = z.infer<typeof AnalyzeArticleRequest>
export const AnalyzeArticleResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['no_provider', 'no_agent', 'no_article']),
    message: z.string(),
  }),
])
export type AnalyzeArticleResult = z.infer<typeof AnalyzeArticleResult>
```

**广播事件**(走 `UIEvent`,对称于 `gmail.analysisDelta`):
- `article.analysisDelta` `{ articleId, text, ts }`
- `article.analysisComplete` `{ articleId, summary: ArticleSummary, ts }`
- `article.analysisError` `{ articleId, error, ts }`

**`ServiceMethod`(`types/service-ipc.ts`)新增:**
```ts
| 'collectArticle'
| 'analyzeArticle'
| 'listArticles'
| 'getArticleAnalysis'   // → { summary: ArticleSummary | null, analyzedAt: string | null }
| 'deleteArticle'
```

**`ServiceClient`(`service-client.ts`)新增方法:**
```ts
collectArticle(input: ArticleSource): Promise<CollectArticleResult>
analyzeArticle(req: AnalyzeArticleRequest): Promise<AnalyzeArticleResult>
listArticles(): Promise<CollectedArticleWithAnalysis[]>
getArticleAnalysis(articleId: string): Promise<{ summary: ArticleSummary | null; analyzedAt: string | null }>
deleteArticle(articleId: string): Promise<void>
```

`index.ts` 加 `export * from './types/article'`。

---

## 5. 后端实现(`apps/desktop/src/service/article/`)

### 5.1 持久化:`store.ts`

照 bili 的 `analysis-store.ts` / `archive-store.ts` / `pin-store.ts` 模式:JSON 文件 + zod 校验 + 原子写(tmp→rename)+ 单飞 saveQueue。文件路径 `userData/collected-articles.json`。

```ts
type StoreDeps = { userDataDir: string }

// collected-articles.json: Record<articleId, ArticleRecord>
// 分析缓存直接挂在记录上(summary/analyzedAt)。
type ArticleRecord = CollectedArticle & {
  summary: ArticleSummary | null
  analyzedAt: string | null
}

export function createArticleStore(deps: StoreDeps) {
  const file = join(deps.userDataDir, 'collected-articles.json')
  let cache: Map<string, ArticleRecord> = load()
  let saveQueue: Promise<void> = Promise.resolve()

  // load(): 读文件 → z.record 校验 → Map;失败返回空 Map
  // persist(): saveQueue 链式 → writeFileSync(tmp) → renameSync(tmp, file)

  return {
    add(input: ArticleSource): CollectedArticle {
      const id = ulid()
      const record: ArticleRecord = {
        ...input,
        id,
        collectedAt: new Date().toISOString(),
        excerpt: input.contentMarkdown.slice(0, 300),
        summary: null,
        analyzedAt: null,
      }
      cache.set(id, record)
      persist()
      return record
    },
    list(): CollectedArticleWithAnalysis[] {
      return [...cache.values()]
        .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt)) // 新→旧
        .map(toWithAnalysis)
    },
    get(id: string): ArticleRecord | null,
    saveAnalysis(id: string, summary: ArticleSummary): void, // 挂回记录 + persist
    delete(id: string): void,
  }
}
```

### 5.2 收集:`collect.ts`

校验 + 入库,极简。

```ts
export function createCollectArticle(deps: { store: ArticleStore }) {
  return (input: ArticleSource): CollectArticleResult => {
    const parsed = ArticleSource.safeParse(input)
    if (!parsed.success) {
      log.warn({ msg: 'article rejected', reason: parsed.error.message })
      return { ok: false, code: 'invalid', message: parsed.error.message }
    }
    const article = deps.store.add(parsed.data)
    log.info({
      msg: 'article collected',
      articleId: article.id,
      url: article.url,
      titleLen: article.title.length,
    })
    return { ok: true, articleId: article.id }
  }
}
```

### 5.3 分析:`analyze.ts`

**整个后端最关键的一段**——照搬 `service/gmail/analyze.ts` 的 `launchRun` + 广播流模式,换 agent / prompt,并在 `run.complete` 处解析 JSON 输出。

```ts
const ARTICLE_ANALYST_ID = 'article-analyst'

export type AnalyzeDeps = {
  broadcaster: Broadcaster
  agentStore: Pick<AgentStore, 'get'>
  store: ArticleStore
  getBudgetConfig(): BudgetConfig
  launch?: typeof launchRun // 可注入,测试用
}

export function createAnalyzeArticle(deps: AnalyzeDeps) {
  const run = deps.launch ?? launchRun
  return (req: AnalyzeArticleRequest): AnalyzeArticleResult => {
    // ① 三个 early return(照 gmail)
    if (!req.provider) return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    const def = deps.agentStore.get(ARTICLE_ANALYST_ID)
      ?? defaultAgents.find((a) => a.id === ARTICLE_ANALYST_ID)
    if (!def) return { ok: false, code: 'no_agent', message: 'article-analyst agent 不可用。' }
    const article = deps.store.get(req.articleId)
    if (!article) return { ok: false, code: 'no_article', message: '文章不存在。' }

    // ② 私有 emit ports:静默 seq,无 store append,广播适配器 run.* → article.*
    let seq = 0
    const emitPorts: RunEmitPorts = {
      nextSeq: () => seq++,
      appendEvent: () => undefined,
      markTerminal: () => undefined,
      broadcast: (evt) => {
        if (evt.kind === 'run.progress') {
          const ev = evt.event
          if (ev?.kind === 'llm.message' && typeof ev.content === 'string') {
            deps.broadcaster.broadcast('article.analysisDelta', {
              articleId: req.articleId, text: ev.content, ts: Date.now(),
            })
          }
        } else if (evt.kind === 'run.complete') {
          // article-analyst 输出 JSON;解析失败 → analysisError。
          const summary = parseSummary(evt.summary)
          if (summary) {
            deps.store.saveAnalysis(req.articleId, summary) // 缓存
            deps.broadcaster.broadcast('article.analysisComplete', {
              articleId: req.articleId, summary, ts: Date.now(),
            })
          } else {
            deps.broadcaster.broadcast('article.analysisError', {
              articleId: req.articleId, error: '分析结果解析失败', ts: Date.now(),
            })
          }
        } else if (evt.kind === 'run.error') {
          deps.broadcaster.broadcast('article.analysisError', {
            articleId: req.articleId,
            error: evt.error?.message ?? 'analysis failed',
            ts: Date.now(),
          })
        }
      },
    }

    // ③ no-op slot/abort/permission ports(照 gmail,tool-less 自包含 run)
    const ports: LaunchPorts = {
      emit: emitPorts,
      toolRegistry: deps.toolRegistry,
      permissionRegistry: createPermissionRegistry(() => undefined),
      acquireSlot: async () => () => undefined,
      registerAbort: () => undefined,
      unregisterAbort: () => undefined,
    }

    // ④ prompt:正文塞进去,systemPrompt 负责约束 JSON 输出格式
    const analyzePrompt =
      `分析下面这篇文章。\n\nTitle: ${article.title}\nSource: ${article.url}\n\n${article.contentMarkdown}`
    const spec: RunSpec = {
      kind: 'work',
      sessionId: `analyze-article:${ulid()}`, // 临时会话,不进 session store(像 gmail)
      agent: def,
      provider: applyAgentModel(req.provider, def),
      prompt: analyzePrompt,
      budget: deps.getBudgetConfig().sub,
      tools: [],
      maxIterationsOverride: def.maxIterations,
    }

    const t0 = Date.now()
    log.info({ msg: 'article analyze started', articleId: req.articleId, contentLen: article.contentMarkdown.length })
    void run(spec, ports)
      .then((r) => log.info({
        msg: 'article analyze complete',
        articleId: req.articleId,
        status: r.status,
        durationMs: Date.now() - t0,
      }))
      .catch((err) => log.error({
        msg: 'article analyze run failed',
        articleId: req.articleId,
        err: err instanceof Error ? err.message : String(err),
      }))
    return { ok: true }
  }
}

// 解析 agent 输出的 JSON 为 ArticleSummary。容错:剥离 markdown code fence。
function parseSummary(raw: string): ArticleSummary | null {
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  try {
    return ArticleSummary.parse(JSON.parse(cleaned))
  } catch {
    return null
  }
}
```

**与 `gmail/analyze.ts` 的两个关键差异:**
1. **临时会话**:`sessionId: 'analyze-article:${ulid()}'`,不进 session store。分析结果走广播 + 缓存回 article store。
2. **解析 JSON 输出**:gmail 直接广播 markdown 文本;article 要解析成 `ArticleSummary`,以渲染结构化卡片。

### 5.4 article-analyst agent

`packages/shared/src/constants/agents.ts` 加(紧邻 gmail-analyst):

```ts
{
  id: 'article-analyst',
  name: '文章分析',
  description: '分析用户收集的文章,输出结构化中文摘要(一句话结论/核心要点/可带走洞察)。',
  systemPrompt: ARTICLE_ANALYST_SYSTEM_PROMPT,
  maxIterations: 2,
  role: 'article-analyst',
  capabilities: ['article-analyze'],
  skills: [],
}
```

`ARTICLE_ANALYST_SYSTEM_PROMPT` 定义于 `packages/shared/src/agents/default-prompt.ts`(照 `GMAIL_ANALYST_SYSTEM_PROMPT` 风格):

> 你是文章分析助手。阅读用户提供的文章正文,输出**严格的 JSON**(不要 markdown code fence),格式为:
> `{"gist": "一句话结论", "points": ["核心要点1", ...], "takeaways": ["可带走的洞察1", ...]}`
> 用中文。gist 控制在 50 字内。points 3-6 条。takeaways 0-4 条,侧重可迁移的经验/认知。

### 5.5 装配 + 路由

- `service/index.ts`:照 gmail 装配 `createCollectArticle` / `createAnalyzeArticle` / `listArticles` / `getArticleAnalysis` / `deleteArticle`,注入 dispatcher。
- `dispatcher.ts`:照 `case 'analyzeEmail'` 加 5 个 case。

### 5.6 Main 侧 IPC(`apps/desktop/src/main/ipc/article-ipc.ts`)

照 `swarm-ipc.ts` 的 `analyzeEmail` 块,代注入 provider:

```ts
const analyzeArticle = async (_e: unknown, articleId: string): Promise<AnalyzeArticleResult> => {
  const injection = providers.getInjection()
  if (!injection) {
    return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
  }
  return serviceClient.analyzeArticle({ articleId, provider: injection })
}

ipcMain.handle('swarm:article:list', () => serviceClient.listArticles())
ipcMain.handle('swarm:article:analyze', analyzeArticle)
ipcMain.handle('swarm:article:getAnalysis', (_e, id) => serviceClient.getArticleAnalysis(id))
ipcMain.handle('swarm:article:delete', (_e, id) => serviceClient.deleteArticle(id))
```

> `collectArticle` **不**在 main 注册 ipcMain —— 它走 WS(插件调用),renderer 不需要 collect。

### 5.7 Logging(遵循 AGENTS.md §5)

每个业务路径打日志,日志文件即可回溯:
- `collect.ts`:入库 `info { msg:'article collected', articleId, url, titleLen }`。
- `analyze.ts`:启动 `info { msg:'article analyze started', articleId, contentLen }`;完成 `info { msg:'article analyze complete', articleId, status, durationMs }`;失败 `error { msg:'article analyze run failed', articleId, err }`。
- `store.ts`:原子写失败 `error`(照 bili)。

---

## 6. 浏览器插件(`apps/extension`)

### 6.1 Content script(新增 `entrypoints/content/extract.ts`)

注入到页面,跑 readability 抽正文。响应 popup 经 `chrome.tabs.sendMessage` 发来的 `{ type: 'extract' }`。

```ts
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'

export default defineContentScript({
  matches: ['<all_urls>'],
  async main() {
    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type !== 'extract') return false
      try {
        const doc = document.cloneNode(true) as Document
        const article = new Readability(doc).parse()
        if (!article?.content) {
          sendResponse(null) // 非文章页
          return false
        }
        const contentMarkdown = new TurndownService().turndown(article.content)
        sendResponse({
          url: location.href,
          title: article.title ?? document.title,
          author: article.byline ?? null,
          siteName: article.siteName ?? null,
          publishedTime: null,
          contentMarkdown,
        })
      } catch {
        sendResponse(null)
      }
      return false
    })
  },
})
```

**依赖**:`@mozilla/readability` + `turndown` 加入 `apps/extension/package.json`(desktop 已用,版本对齐)。

### 6.2 Background(`entrypoints/background.ts` 增量)

在现有 `onMessage` listener 加 `collectCurrentPage` 分支(保留现有 `listAgents` 分支):

```ts
if (msg?.type === 'collectCurrentPage' && client) {
  ;(async () => {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
      if (!tab.id) return sendResponse({ ok: false, error: 'no active tab' })
      const input = await browser.tabs.sendMessage(tab.id, { type: 'extract' })
      if (!input) return sendResponse({ ok: false, error: 'extract failed (非文章页?)' })
      const res = await client.collectArticle(input)
      sendResponse({
        ok: res.ok,
        articleId: res.ok ? res.articleId : undefined,
        error: res.ok ? undefined : res.message,
      })
    } catch (err) {
      sendResponse({ ok: false, error: String(err) })
    }
  })()
  return true
}
```

### 6.3 Popup(`entrypoints/popup/Popup.tsx`)

照现有连接探针风格,加"收集当前页"主按钮 + 状态反馈:

```
┌─────────────────────────────────┐
│  🐝 SwarmAgents                 │
├─────────────────────────────────┤
│  ● 已连接 desktop (3 个 agent)  │  ← 现有 listAgents 探针
├─────────────────────────────────┤
│                                 │
│  ┌───────────────────────────┐  │
│  │  📄 收集当前页到文章库    │  │  primary 全宽按钮
│  └───────────────────────────┘  │
│  抽取正文并发送到 desktop        │
│                                 │
│  状态:✓ 已收集,去 desktop 查看 │  成功(绿)/ ✗ 抽取失败(红)/ ◷ 发送中
├─────────────────────────────────┤
│  ⚙ 打开 Options                 │
└─────────────────────────────────┘
```

按钮 disabled 条件:未连接 / 正在发送 / 当前页是 `chrome://` 等不可注入 URL。

### 6.4 Options

不动。现有 token 配置足够。

---

## 7. Desktop renderer UI

### 7.1 导航入口(`components/rail-config.ts`)

`services` 段加一项(排在 bilibili 之后):

```ts
{ key: 'article', label: '文章', icon: Newspaper, target: { kind: 'route', to: '/articles', match: 'exact' } },
```

`Newspaper` 来自 `lucide-react`(项目已用)。

### 7.2 路由(`routes/article.tsx`,照 `routes/bilibili.tsx`)

```ts
import { createFileRoute } from '@tanstack/react-router'
import { ArticleView } from '@/components/views/article-view'
export const Route = createFileRoute('/articles')({ component: ArticleView })
```

### 7.3 视图(`components/views/article-view.tsx`,照 `bilibili-view.tsx`)

**与 bili 的结构差异:**
- bili 有 3 个 tab(收藏夹/稍后再看/本地存档)→ 文章只需 **1 个列表**(无来源分类)。
- bili 有登录态 → 文章无登录态(数据本地)。
- 顶部「AI 已解析 N / M」统计 pill → **保留**。

```
┌──────────────────────────────────────────────────────────────────────┐
│  文章收集                              [✨ AI 已解析 3/12]            │
├──────────────────────────────────────────────────────────────────────┤
│                                                       ┌──────────────┐│
│  ┌──────────┐ ┌──────────┐ ┌──────────┐              │  详情面板    ││
│  │ 站点色块 │ │ 站点色块 │ │ 站点色块 │              │  (472px)     ││
│  │ +首字母  │ │ +首字母  │ │ +首字母  │              │              ││
│  │ 文章标题 │ │ 文章标题 │ │ 文章标题 │   选中 →     │  标题        ││
│  │ 站点·日期│ │ 站点·日期│ │ 站点·日期│              │  作者·站点   ││
│  └──────────┘ └──────────┘ └──────────┘              │  [AI 分析]   ││
│                                                       │  [打开原文]  ││
│  ┌──────────┐ ┌──────────┐                           │  [删除]      ││
│  │ ...      │ │ ...      │                           │  摘要/原文    ││
│  └──────────┘ └──────────┘                           │  (tab 切换)  ││
│                                                       └──────────────┘│
│  (卡片网格,响应式列数,照 bili 的 measureRef 虚拟化)                 │
└──────────────────────────────────────────────────────────────────────┘
```

### 7.4 文章卡片(`ArticleCard`,照 bili 的 `VideoCard`)

文章无封面图。用 **站点色块 + 首字母** 占位(站点名 hash → 调色板取色),favicon 可选覆盖(`https://www.google.com/s2/favicons?domain=...`)。

```
┌────────────────────────┐
│  ┌──────────────────┐  │
│  │  H               │  │  16:9 色块,H = 站点名首字母
│  │   (站点色)       │  │  背景:站点名 hash → 调色板
│  └──────────────────┘  │
│  [AI]                  │  已分析徽章(右上角,照 bili)
│  文章标题(2 行截断)   │
│  站点名 · 7月7日        │
└────────────────────────┘
```

### 7.5 详情面板(`components/views/article-detail-panel.tsx`,照 `bilibili-detail-panel.tsx`)

```
┌──────────── 472px ───────────────┐
│  文章标题                        [×]│
│  作者 · 站点名 · 2026-07-07        │
├───────────────────────────────────│
│  ┌── 280px ──┐  ┌── 剩余 ────────┐│
│  │ 站点色块  │  │ [AI 解析][原文]││  tab 切换
│  │           │  ├────────────────┤│
│  │ excerpt   │  │ ┌──────────┐   ││
│  │ 预览文…   │  │ │一句话结论│   ││  SummaryView(照 bili)
│  │           │  │ │ gist     │   ││
│  │ ──────    │  │ └──────────┘   ││
│  │ [AI 分析] │  │ 核心要点        ││
│  │ [打开原文]│  │ • ...           ││
│  │ [删除]    │  │ 可带走洞察      ││
│  └───────────┘  │ • ...           ││
│                 └────────────────┘│
└───────────────────────────────────┘
```

**与 bili 详情面板的差异:**
- 左栏:视频封面 → **站点色块**;视频简介 → **excerpt 预览**。
- 按钮:`[AI 分析]`(触发 `window.swarm.article.analyze(id)`)、`[打开原文]`(`window.open(url)`)、`[删除]`(`window.swarm.article.delete(id)`)。
- 去掉 bili 的"转写 / 保存到 Obsidian"。
- 右栏 tab:`[AI 解析]` / `[原文]`。原文 = `contentMarkdown`,用 `<Streamdown>` 渲染。

### 7.6 分析流式渲染

详情面板挂载时订阅广播(照 `gmail-inbox-view.tsx` 的 `MessageAnalysis` 模式):

```ts
useEffect(() => {
  return window.swarm.subscribeEvents((e: UIEvent) => {
    if (e.kind === 'article.analysisDelta' && e.articleId === article.id) {
      setStreamingText((prev) => prev + e.text)
    } else if (e.kind === 'article.analysisComplete' && e.articleId === article.id) {
      setSummary(e.summary)
      queryClient.invalidateQueries({ queryKey: ['articles', 'list'] }) // 刷新卡片 AI 徽章
    } else if (e.kind === 'article.analysisError' && e.articleId === article.id) {
      setError(e.error)
    }
  })
}, [article.id])
```

流式态:左栏按钮 → `分析中…`,右栏显示 streaming 文本(`<Streamdown>`,照 `gmail-assistant-card`)。完成后切换到 `SummaryView` 结构化卡片。

### 7.7 API 层(`lib/api.ts` + preload bridge)

照 `swarmApi.bilibili*` 加:`articleList()` / `articleAnalyze(id)` / `articleGetAnalysis(id)` / `articleDelete(id)`。preload bridge(`@swarm/protocol` 的 `SwarmBridge`)加对应 `article` 命名空间。

### 7.8 空状态(照 `DashboardEmpty` 风格)

列表为空时:
```
┌──────────────────────────────────────┐
│                                      │
│           📰                         │
│        还没有收集的文章              │
│   安装浏览器插件,在任意文章页点击    │
│   「收集当前页」,文章会出现在这里    │
│                                      │
└──────────────────────────────────────┘
```

---

## 8. 文件清单

| 模块 | 文件 | 动作 |
|---|---|---|
| protocol | `packages/protocol/src/types/article.ts` | 新增 |
| protocol | `packages/protocol/src/types/service-ipc.ts` | 改(ServiceMethod) |
| protocol | `packages/protocol/src/service-client.ts` | 改(加方法) |
| protocol | `packages/protocol/src/index.ts` | 改(re-export) |
| shared | `packages/shared/src/constants/agents.ts` | 改(加 article-analyst) |
| shared | `packages/shared/src/agents/default-prompt.ts` | 改(加 prompt 常量) |
| service | `apps/desktop/src/service/article/store.ts` | 新增 |
| service | `apps/desktop/src/service/article/collect.ts` | 新增 |
| service | `apps/desktop/src/service/article/analyze.ts` | 新增 |
| service | `apps/desktop/src/service/index.ts` | 改(装配) |
| service | `apps/desktop/src/service/ipc/dispatcher.ts` | 改(路由) |
| main | `apps/desktop/src/main/ipc/article-ipc.ts` | 新增 |
| main | `apps/desktop/src/main/index.ts` | 改(wire article-ipc) |
| main | `apps/desktop/src/main/constants.ts` | 改(collected-articles.json 路径,若需集中声明) |
| preload | `apps/desktop/src/preload/index.ts` + `.d.ts` | 改(article bridge) |
| renderer | `apps/desktop/src/renderer/src/components/rail-config.ts` | 改(导航项) |
| renderer | `apps/desktop/src/renderer/src/routes/article.tsx` | 新增 |
| renderer | `apps/desktop/src/renderer/src/components/views/article-view.tsx` | 新增 |
| renderer | `apps/desktop/src/renderer/src/components/views/article-detail-panel.tsx` | 新增 |
| renderer | `apps/desktop/src/renderer/src/lib/api.ts` | 改(swarmApi.article*) |
| renderer | `apps/desktop/src/renderer/src/routeTree.gen.ts` | 自动生成(TanStack Router) |
| extension | `apps/extension/entrypoints/content/extract.ts` | 新增 |
| extension | `apps/extension/entrypoints/background.ts` | 改(collectCurrentPage) |
| extension | `apps/extension/entrypoints/popup/Popup.tsx` | 改(收集按钮) |
| extension | `apps/extension/package.json` | 改(readability + turndown deps) |
| extension | `apps/extension/wxt.config.ts` | 改(content script permissions) |

---

## 9. 测试策略

照现有项目的 vitest 模式,关键测试点:

- **protocol**:`article.ts` 的 zod schema 解析(合法/非法 `CollectArticleRequest`)。
- **service store**:`store.ts` 的 add/list/get/saveAnalysis/delete + 原子写(注入 tmpdir)。
- **service analyze**:`analyze.ts` 注入 fake `launch`(返回固定 JSON),断言广播事件序列 + store 缓存写入;覆盖三个 early return(no_provider / no_agent / no_article)+ JSON 解析失败路径。
- **service collect**:非法 input → `{ ok:false, code:'invalid' }`。
- **renderer**:`article-view.tsx` 的 `buildRows`/卡片渲染(照 `bilibili-view.test.tsx`);详情面板的状态机(idle/streaming/done/error)。
- **extension**:`transport-ws.test.ts` 已覆盖传输;content script 的 extract 逻辑用 jsdom 抽离成纯函数测试。

E2E(desktop playwright,照 `e2e/*.spec.ts`):插件推送 → 卡片出现 → 点分析 → 结构化摘要渲染。E2E 需 mock WS peer。

---

## 10. 风险与取舍

1. **"原创组合"风险**:UI 像 bili、后端像 gmail 是现有代码里没有的组合。缓解:每个组件都严格照单一范例(gmail 的 run-engine + bili 的 store/视图),不发明新模式。
2. **article-analyst JSON 输出不稳定**:LLM 可能不严格输出 JSON。缓解:`parseSummary` 容错(剥离 code fence);失败 → `analysisError` 事件,用户可重试。systemPrompt 明确"不要 code fence"。
3. **200k chars 上限**:个别超长文章可能超限。缓解:readability 输出通常远小于此;超限时 collect 返回 `invalid`(可后续加截断策略,非本范围)。
4. **content script 注入失败**:`chrome://` 等页面不可注入。缓解:popup 按钮 disabled + 失败状态文案"非文章页?"。
5. **MV3 service worker 杀进程**:`background.ts` 已有 keepalive alarm + 重连逻辑,复用即可。

---

## 11. 开放问题(实现阶段决定)

- 站点色块的调色板取色算法(可复用现有任何 hash→color 工具,或简单实现)。实现时选取,不阻塞设计。
- favicon 失败时的 fallback(已有首字母色块,足够)。
