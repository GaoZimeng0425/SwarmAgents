# 把原生弹窗改为 web 实现 + 权限申请改为输入框上方滑出

**日期**: 2026-06-17
**状态**: 设计已确认,待评审

## 背景与问题

当前应用有三类"弹窗"机制:

1. **Web 组件**(`@base-ui/react`):`Dialog` / `AlertDialog` / `Popover` / `ContextMenu` / `CommandDialog` 等,渲染层实现。
2. **Electron 原生 `dialog.showMessageBox`**:经 `window.swarm.showConfirm` → IPC → `showNativeConfirm`。体验差(系统级阻塞弹窗,样式不可控)。
3. **独立 BrowserWindow**:设置窗口(本次不涉及)。

原生 `showConfirm` 只有两个调用点:

- **高风险权限申请**:`use-events-subscription.ts` 的 `handleHighRisk` —— `risk: 'high'` 的权限请求走原生弹窗;`risk: 'medium'` 走渲染层的 `PermissionDrawer`,`low` 在主进程自动放行。
- **删除自定义供应商确认**:`providers-view.tsx` 的 `DeleteButton`。

此外 `PermissionDrawer` 虽已在输入框上方区域,但实现为 `position: fixed; inset-x-0; bottom-0` 浮在整个窗口底部、带 `role="dialog"`、无滑出动画——既不是真正"贴着输入框",也不像"滑出"。

## 目标

1. 删除所有原生 `showMessageBox` 调用,改为 web 实现。
2. 权限申请(含高风险)统一为**输入框正上方滑出的内联面板**,不是 dialog。
3. 删除供应商这类用户主动发起的确认,复用已有的 web `AlertDialog`。
4. 清理整条原生确认 IPC 链路,不留孤儿。

## 非目标(YAGNI)

- 不改设置窗口(独立 BrowserWindow)的形态。
- 不为权限面板做退场动画(条件渲染即卸载,进场滑出已满足观感)。
- 不动其他 web 弹窗组件(Dialog/Popover/ContextMenu 等)。
- 不重命名 `permission-drawer.tsx` 文件(避免改动一批 import)。

## 设计

### 单元 1:权限滑出面板(改造 `src/renderer/src/components/permission-drawer.tsx`)

**职责**:在 chat 列内、紧贴 composer 上方,展示一条待决权限请求并采集 grant/skip/deny 决策。

**改动**:

- 去掉 `position: fixed; inset-x-0; bottom-0`,改为普通 flex 子项。它在 `tasks-view.tsx` 的 JSX 中本就排在 `ConversationThread`(`flex-1`)与 `ChatInput` 之间,改为内联后自然位于输入框正上方,`ConversationThread` 自动让出垂直空间。
- 进场动画复用项目既有工具类:`animate-in slide-in-from-bottom-3 fade-in-0 duration-200`(与 dialog/popover 同款),上滑淡入。无退场动画。
- 移除 `role="dialog"`(不再是模态),改为 `role="region"` + `aria-label`。保留 Escape = skip 的键盘行为。
- **高风险视觉区分**(已确认:仅视觉,不加二次确认门槛):当 `prompt.risk === 'high'` 时,顶边/标题使用 destructive 红色样式,默认焦点落在 **Deny** 按钮。按钮集合不变:Skip / Allow / Deny。

**依赖**:`usePermissionStore`(形状不变)、`Button`。
**接口**:`Props { prompt: PermissionPrompt | null; onDecide(actionId, decision) }`(不变)。

### 单元 2:事件订阅去掉原生分支(`src/renderer/src/hooks/use-events-subscription.ts`)

- 删除 `handleHighRisk` 函数及对 `window.swarm.showConfirm` 的调用。
- `task.permission_request` 分支去掉 `if (e.risk === 'high')` 判断,所有风险等级统一 `push(buildPrompt(e))`。
- 去掉因此变为未使用的 import。

### 单元 3:删除供应商确认改用 AlertDialog(`src/renderer/src/components/views/providers-view.tsx`)

- `DeleteButton` 内命令式 `await window.swarm.showConfirm({...})` 改为声明式 `AlertDialog`:
  - 删除按钮作为 `AlertDialogTrigger`。
  - `AlertDialogContent` + `Header`(`Title` / `Description`)沿用现有中文文案(标题"删除供应商 {name}?",描述"这会移除该供应商及其 API Key。")。
  - `AlertDialogAction`(destructive 样式,文案"删除")调用 `removeCustomProvider`,成功后 `onDeleted()`。
  - `AlertDialogCancel`(文案"取消")。
- 组件局部状态从"await 返回值"改为受控 `open` 即可;删除成功后关闭。

### 单元 4:移除原生确认 IPC 链路

两个调用点迁走后,按以下站点全部清理(已用 grep 定位):

| 文件 | 处理 |
|---|---|
| `src/main/system/confirm.ts` | 删除整个文件(`showNativeConfirm`) |
| `src/main/system/confirm.test.ts` | 删除整个文件 |
| `src/renderer/src/hooks/use-native-confirm.ts` | 删除整个文件(迁移后变死代码) |
| `src/main/ipc/swarm-ipc.ts` | 删除 `handleShowConfirm`、`ipcMain.handle('system:showConfirm', …)`(:172)、`removeHandler('system:showConfirm')`(:232),以及 `ConfirmRequest`/`ConfirmRequestSchema`/`ConfirmResponse`、`showNativeConfirm` 的 import |
| `src/preload/index.ts` | 删除 `showConfirm` 桥接(:165) |
| `src/shared/types/ui.ts` | 删除 `SwarmBridge.showConfirm`(:208)及 `ConfirmRequest`/`ConfirmResponse` import(:10) |
| `src/shared/types/ipc.ts` | 删除 `ConfirmRequestSchema`/`ConfirmRequest`/`ConfirmResponseSchema`/`ConfirmResponse`(:89–108) |
| `src/shared/types/ipc.test.ts` | 删除 `ConfirmRequestSchema`/`ConfirmResponseSchema` 两个 describe 块(:79–104)及相应 import |

实施时再用 codegraph 复核一遍,确认无遗漏引用。

## 数据流

```
agent tool → permission-registry.request() → broadcast 'task.permission_request'
  → use-events-subscription → usePermissionStore.push (所有 risk 等级)
  → tasks-view 选出本 session 的 currentPrompt → PermissionDrawer(内联滑出)
  → 用户点击 → onDecide → useDecidePermission → IPC → permission-registry.resolve()
```

原生 `showConfirm` 路径整体删除。

## 错误处理

- 权限请求 30s 超时仍由 `permission-registry` 自动 `deny`(不变)。
- 删除供应商失败时 `removeCustomProvider` 返回 `!ok`,不调用 `onDeleted`,AlertDialog 关闭即可(沿用现有行为,不新增 toast)。

## 测试

- `permission.test.ts`(store):形状不变,保留。
- `confirm.test.ts`:随文件删除。
- `ipc.test.ts`:删除 Confirm 相关 describe 块。
- **新增**轻量渲染测试(`permission-drawer.test.tsx`):
  1. `risk: 'high'` 渲染出 destructive 样式标记。
  2. 按 Escape 触发 `onDecide(actionId, 'skip')`。

## 日志

纯 UI 改动 + 删除一条 IPC 路径,不新增业务路径。`decidePermission` 现有日志不动。

## 影响面 / 风险

- `showConfirm` 是 `SwarmBridge` 公开 API,删除后任何遗漏的调用方会 TypeScript 报错——可作为"删干净"的验证手段。
- 高风险权限从"原生阻塞弹窗"变为"非模态滑出面板",用户可在不决策的情况下继续操作其他 UI;但 agent run 仍被 `permission-registry` 阻塞等待,且 `awaiting_user` 状态保持,行为语义不变。
