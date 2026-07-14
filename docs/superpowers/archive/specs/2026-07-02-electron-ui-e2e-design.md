# Electron UI E2E 测试设计

- **日期**: 2026-07-02
- **状态**: Draft（待 review）
- **分支**: `worktree-electron-ui-e2e`
- **范围**: `apps/desktop`

## 背景与动机

项目当前测试体系成熟，但全部跑在 vitest 上：

- **单元测试**: ~160 个文件（main / renderer / service / packages）。
- **集成测试**: 散落在 `service/` 下，靠 `.integration.test.ts` 后缀或跨模块的
  `manager.*.test.ts` 标记。
- **服务层 e2e**: `apps/desktop/src/service/e2e/` 下 6 个文件（`company`、
  `multi-team-company`、`multi-level-verify`、`agent-cluster` 等），在 Node 进程内跑
  完整业务流程，覆盖**业务正确性**。

**缺口**: 没有任何测试驱动真实的 Electron 窗口。渲染进程只靠 jsdom 单测覆盖，
"窗口能否启动、IPC 契约在真实 preload 下是否通、用户能否点到看到、原生模块在
electron runtime 下能否加载"——这些层面无人验证。本设计补这一层。

## 目标

补一层**薄交互层 UI e2e**，只覆盖 service 层 e2e 够不到的东西：

1. 窗口能启动并渲染主界面。
2. preload 暴露的 `window.swarm.*` IPC 契约在真实环境通且返回结构正确。
3. composer 能输入、能提交、提交后 UI 能正确反馈。
4. 设置面板能打开、能配置 provider。
5. 路由导航正常。

## 非目标

- **不**重复测 service 层 e2e 已覆盖的业务流程（multi-team、verify 流程等）。
- **不**依赖真实 LLM 响应（见"边界决策"）。
- **不**做视觉回归 / 截图对比。
- **不**在本期写 CI workflow yaml（只保证本地 `test:e2e` 可跑，CI 集成留接口）。

## 边界决策：测到提交为止

UI e2e 的 composer 提交用例**不调用真实 LLM API**。验证止于：

> composer 输入 → submit → `submitGoal` IPC 发出 → task 创建 → UI 反馈（user 消息进
> transcript、task 条目出现、error 状态不崩溃）。

**理由**: 业务正确性已由 service 层 e2e 覆盖；UI e2e 聚焦"用户能点到看到能交互成功"，
保持薄、快、CI 稳定。若后续需要验证消息流式渲染，再以"mock provider server"形式
单独引入，不在本期范围。

## 方案选型

采用 **Playwright 的 Electron 模式**（`_electron.launch`）。理由：

- 业界标准方案，API 成熟：`_electron.launch({ executablePath: electron,
  args: ['out/main/index.js'] })` → `electronApp.firstWindow()` → 标准 Playwright
  locator API。
- 复用项目 electron binary，**不需要额外下载浏览器二进制**。
- 项目脚手架（electron-vite + `electron-builder install-app-deps` + main 入口在
  `out/main/index.js`）正是该模式最舒服的组合：
  - `postinstall` 里的 `electron-builder install-app-deps` 已把 `better-sqlite3@12`
    重建为 electron@43 ABI，Playwright 用真实 electron runtime 跑 main 时可直接加载。
  - prod 模式 `main-window.ts:74` 走 `win.loadFile('../renderer/index.html')`，Playwright
    指向 `out/main/index.js` 即可，main 自行加载打包后的 renderer，无需 dev server。

## 设计

### 用例清单（6 条）

| # | 文件 | 用例 | 断言重点 |
|---|------|------|----------|
| 1 | `smoke.spec.ts` | 启动 app → 等 firstWindow | 窗口标题、composer 容器可见。**验证构建链 + better-sqlite3 + sqlite-vec 在 electron runtime 下 load 成功** |
| 2 | `onboarding.spec.ts` | 全新 userData 启动 | `no-provider-banner` 可见；点配置入口后 settings dialog 打开、`providers-view` 可见 |
| 3 | `onboarding.spec.ts` | 在 providers-view 填假 key `sk-e2e-dummy` 并提交 | banner 消失 / composer 解锁；`window.swarm.providers.get()` 的 `active` provider `hasKey === true` |
| 4 | `ipc-contract.spec.ts` | `page.evaluate` 调多个 bridge 方法 | `providers.get()` 返回 `{ active, providers[] }`；`agents.list()` 返回数组；`budgets.get()` 返回对象；`mcp.list()` 返回数组。验证 preload → main IPC 契约稳定 |
| 5 | `composer.spec.ts` | 配好 provider → composer 输入 "hello" → 发送 | user 消息进入 transcript；task 条目出现。不等待 LLM 响应；若假 key 触发 provider error，断言 error UI 不崩溃（无白屏、有错误提示） |
| 6 | `navigation.spec.ts` | 点击 session 列表某项 | detail 视图加载；对应 session IPC 调用成功 |

**IPC 契约方法名以 preload 实际暴露的 `window.swarm.*` 为准**（实现时核对
`apps/desktop/src/preload/index.ts`，当前已确认 `providers` / `mcp` bridge 结构）。

### 目录结构与配置

```
apps/desktop/
  playwright.config.ts        # testDir: ./e2e, fullyParallel: false, retries: 1, timeout: 60s
  e2e/
    fixtures.ts               # launchElectron(testInfo) helper
    smoke.spec.ts
    onboarding.spec.ts
    ipc-contract.spec.ts
    composer.spec.ts
    navigation.spec.ts
  package.json                # + "test:e2e": "electron-vite build && playwright test"
```

`playwright.config.ts` 要点：

- `testDir: './e2e'`，`fullyParallel: false`（共享 electron 实例 / userData 隔离更简单）。
- `workers: 1`（Electron 单窗口，串行）。
- `timeout: 60_000`（首次 build 后启动可能慢）。
- `expect.timeout: 10_000`。
- `retries: 1`（CI flaky 兜底）。
- `use: { trace: 'on-first-retry', screenshot: 'only-on-failure', video: 'retain-on-failure' }`。
- `reporter: [['list'], ['html', { open: 'never' }]]`。

### 状态隔离与稳定性

- **独立 userData**: `fixtures.ts` 的 `launchElectron` 为每个用例 `fs.mkdtempSync` 一个
  临时目录（前缀 `swarm-e2e-`），通过 `args: ['--user-data-dir=<tmp>']` 传给 electron；
  `afterEach` 递归清理。
- **环境变量**: 启动时设 `SWARM_E2E=1`（绕过单例锁，见下）。
- **禁用 GPU**（CI 友好）: `args` 追加 `--disable-gpu`。
- **headless**: 本地 macOS 默认有头；Electron 无原生 headless，CI Linux 需 `xvfb-run`
  （仅在设计文档标注，本期不写 CI）。
- **build 依赖**: `test:e2e` 先跑 `electron-vite build`，保证 `out/main/index.js` 与
  `out/renderer/` 最新。开发期可手动先 `npm run build` 再 `playwright test` 跳过重建。

### 产品代码改动

仅一处，最小侵入：

`apps/desktop/src/main/index.ts:32`

```ts
// before
if (!app.requestSingleInstanceLock()) {
// after
if (!process.env.SWARM_E2E && !app.requestSingleInstanceLock()) {
```

作用: 本地开发时用户很可能正开着 app，单例锁会拒绝 e2e 启动的第二个实例；用环境变量
旁路。生产路径不受影响（`SWARM_E2E` 仅 e2e 启动时注入）。

无其他业务代码改动。

### 依赖与脚本

- `apps/desktop` devDependencies 新增: `@playwright/test`、`playwright`。
- 无需 `npx playwright install`（Electron 模式不下载浏览器二进制）。
- 新增 script: `"test:e2e": "electron-vite build && playwright test"`。
- 不并入 `verify` / `test`（e2e 慢、build 重，独立触发）。

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| sqlite-vec 在 prod build 下 `.load` 路径失效 | smoke 直接挂 | smoke 用例 1 即暴露；若挂，定位 loadable extension 路径并修 setup（属实现期发现项） |
| better-sqlite3 ABI 不匹配 electron runtime | main 启动即崩 | 已由 `electron-builder install-app-deps` 重建；smoke 即验证 |
| 本地正开 app → 单例锁挡 e2e | e2e 启动失败 | `SWARM_E2E` 旁路（见产品代码改动） |
| 假 key 提交后 provider 调用失败导致 UI 崩溃 | 用例 5 误判 | 断言 error UI 不白屏即可，不要求 LLM 成功 |
| Electron 无 headless，CI Linux 跑不起来 | CI 集成受阻 | 本期不集成 CI；后续用 `xvfb-run` 或 macOS runner |

## 验收标准

1. `cd apps/desktop && npm run test:e2e` 在干净本地 macOS 上全绿（首次会先 build）。
2. 6 个用例各自独立，可单独 `playwright test e2e/<file>` 跑。
3. 故意改坏一处 IPC 契约（如重命名 `providers:get` channel），用例 4 能失败。
4. 故意删除单例锁旁路并在本地同时开 app，用例 1 能失败（旁路确实生效）。
5. 失败用例产出 trace + screenshot，便于离线排查。

## 后续（不在本期）

- CI 集成（GitHub Actions + `xvfb-run` 或 macOS runner）。
- mock provider server（若需测消息流式渲染）。
- 视觉回归（若需要防 UI 意外变动）。
