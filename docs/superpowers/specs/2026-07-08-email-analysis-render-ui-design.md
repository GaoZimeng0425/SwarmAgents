# 邮件/文章分析改用 render_ui 结构化输出

**Date:** 2026-07-08
**Status:** Design approved, pending spec review

## 背景 / 问题

Gmail 线程分析和文章分析都是 `tools: []` 的一次性文本生成 run,通过私有 emit ports
把 `run.*` 流翻译成 `gmail.threadAnalysis*` / `article.analysis*` 广播事件,渲染到各自
的 bespoke 面板(非 transcript)。

它们靠**把结构化数据夹在文本里**来同时产出「给人看的摘要」和「给程序用的字段」:

- **线程** (`analyze-thread.ts`):agent 先流式一段 markdown 摘要,末尾追加一行
  `<!--ANALYSIS:{"summary","todos","suggest"}-->`。渲染端流式显示摘要(检测到 sentinel
  就截断),`run.complete` 时 `parseThreadPayload` 用正则+`JSON.parse` 抽出结构化字段,
  **卡片 snap 到 JSON 里的一句话 `summary` + todos + suggest**。
- **文章** (`analyze.ts`):agent 整段输出就是 JSON `{gist,points,takeaways}`,流式阶段
  用户看到**裸 JSON 在刷**,`run.complete` 时 `parseSummary` 解析后 snap 到结构化面板。

两个问题:

1. **信息突变**:流式看到的长摘要(线程)/裸 JSON(文章)在完成瞬间被丢弃,替换成
   结构化内容,体感像「换了个 agent」。
2. **解析脆弱**:结构化字段靠 prompt 求模型吐合法 JSON(无换行、无尾逗号),靠正则/
   `JSON.parse` 抽取,失败就降级。

## 方案

统一改用**工具作为结构化输出通道**:agent 先流式写自然语言 markdown 摘要(信息不丢),
**最后一步**调用现成的 `render_ui` 工具吐结构化数据(schema 约束,准确)。适配器从
`tool.call` 事件里取 props,不再解析正文。

### 关键设计点

- **复用 `render_ui`**,card `type: 'analysis'`。props 是 `Type.Any()`,线程放
  `{todos, suggest}`、文章放 `{gist, points, takeaways}` 都合法;各自适配器读各自字段。
- **不渲染 transcript card**:这两个分析 run 是 bespoke 面板,不是 transcript。`render_ui`
  在此仅作结构化输出通道 —— 适配器拦截 `tool.call` 读 props,现有面板照常渲染。不为
  `analysis` 类型新增 transcript 渲染器(YAGNI;真出现在普通 transcript 时走 fallback)。
- **`analysis` 卡收尾终止回合**:`render-ui.ts` 现有 `INTERACTIVE_CARD_TYPES` 同时控制
  `terminate` 和提示文案。新增一个「非交互但收尾」分类(如 `TERMINAL_CARD_TYPES`),让
  `analysis` 卡返回 `terminate: true` 但用中性文案,使模型「写散文 + 调 card」同一回合
  干净结束,不浪费一次空 LLM 回合、也不会在第二回合追加重复散文。

## 改动清单

### 1. `apps/desktop/src/service/tools/render-ui.ts`
- 新增 `TERMINAL_CARD_TYPES = new Set(['analysis'])`(非交互、收尾即终止)。
- `terminate` 判定改为 `interactive || TERMINAL_CARD_TYPES.has(type)`;终止但非交互时用
  中性 tool-result 文案(区别于 choice 的「用户选择稍后到达」文案)。
- 导出共享 helper `readAnalysisCard(evt): Record<string, unknown> | null`:命中
  `evt.kind === 'run.progress' && evt.event.kind === 'tool.call' && evt.event.tool ===
  'render_ui' && args.type === 'analysis'` 时,coerce `args.props`(对象直接用;字符串
  `JSON.parse`,失败返回 null)返回;否则 null。

### 2. `apps/desktop/src/service/gmail/analyze-thread.ts`
- `RunSpec.tools`: `[]` → `['render_ui']`。
- `emitPorts.broadcast`:
  - `llm.message` → 累积 `accumulated` + `threadAnalysisDelta`(不变)。
  - 新增:`readAnalysisCard(evt)` 命中 → 存 `card = {todos, suggest}`(容错取值)。
  - `run.complete` → `threadAnalysisComplete { summary: accumulated, todos: card?.todos
    ?? [], suggest: card?.suggest ?? '' }`。
- 删除 `parseThreadPayload` + 其测试。

### 3. `packages/shared/src/constants/agents.ts` — `GMAIL_THREAD_ANALYST_SYSTEM_PROMPT`
- 删掉 tail-JSON 段。改为:先写自然语言 markdown 摘要(一句话 gist + 3–6 条要点);
  **最后一步**调 `render_ui({ type: 'analysis', props: { todos: [...], suggest: '...' } })`
  作为收尾动作。todos 为 `{t, due, dueLabel}` 结构;无待办 `[]`;无需回复 suggest `''`。

### 4. `apps/desktop/src/service/article/analyze.ts`
- `RunSpec.tools`: `[]` → `['render_ui']`。
- `emitPorts.broadcast`:
  - `llm.message` → `article.analysisDelta`(现在是可读散文,不再是裸 JSON)。
  - 新增:`readAnalysisCard(evt)` 命中 → 存 `card = {gist, points, takeaways}`。
  - `run.complete` → 校验 card 形状,合法则 `ArticleSummary`,`saveAnalysis` +
    `analysisComplete`;无 card/形状不符 → `analysisError('分析结果解析失败')`(保持现状)。
- 删除 `parseSummary`(校验逻辑内联到 card 消费处),对应测试改为断言 card 路径。

### 5. `packages/shared/src/agents/default-prompt.ts` — `ARTICLE_ANALYST_SYSTEM_PROMPT`
- 不再「只输出 JSON」。改为:先写 markdown 摘要(gist 一句话 + points 列表 +
  takeaways 列表);**最后一步**调
  `render_ui({ type: 'analysis', props: { gist, points, takeaways } })`。字段规则不变
  (gist ≤50 汉字、points 3–6、takeaways 0–4、中文)。

### 6. `apps/desktop/src/renderer/src/hooks/use-thread-analysis.ts`
- 删掉 `<!--ANALYSIS` 截断逻辑(结构化不再走正文,已成死代码):`threadAnalysisDelta`
  直接累积全文。`threadAnalysisComplete` 的 `summary` 现在等于流式全文,done 不再缩水。
- 更新 `use-thread-analysis.test.tsx` 里 sentinel 截断相关用例。

### 7. `packages/shared/src/constants/agents.ts` — maxIterations
- 保持已改的 `gmail-thread-analyst` / `article-analyst` = 1000(有 terminate 后实际
  ~1–2 回合,无害)。

## 数据流(改动后)

```
model 回合 1:
  流式 text  ──run.progress llm.message──▶ analysisDelta  (可读散文,流式显示)
  render_ui({type:'analysis', props}) ──run.progress tool.call──▶ readAnalysisCard 捕获 props
  tool 返回 terminate:true ──▶ 回合结束
run.complete ──▶ analysisComplete { summary=流式全文(线程) / 结构化(文章), ...card props }
```

## 边界 / 容错

- 模型未调 `render_ui`:线程 → todos `[]`/suggest `''`(摘要仍完整);文章 →
  `analysisError('分析结果解析失败')`(同现状)。
- props 是 JSON 字符串:`readAnalysisCard` coerce;解析失败当未提供。
- 每个 `catch` / 降级分支保留现有 `log.warn`/`error`(遵循项目日志规范)。

## 不做(YAGNI)

- 不给 `analysis` 加 transcript 渲染器(这两个 run 不进 transcript)。
- 不动单封邮件分析(`gmail-analyst`:纯 markdown,无结构化,无此问题)。
- 不改 bilibili 等其他分析路径。

## 验证

- 单测:`render-ui.test.ts`(terminate + readAnalysisCard)、`analyze-thread` 适配器
  (card→complete)、`analyze`(article)适配器、`use-thread-analysis.test.tsx`。
- 端到端:`run-desktop` 起应用,对一个真实线程 / 文章点分析,确认流式散文完整、完成后
  todos/suggest(线程)、gist/points/takeaways(文章)正确,且无「突变缩水」。
