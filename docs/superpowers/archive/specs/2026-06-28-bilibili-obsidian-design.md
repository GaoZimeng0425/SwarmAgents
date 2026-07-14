# Bilibili → AI 总结 → Obsidian 设计文档

日期：2026-06-28
分支：`worktree-bilibili-obsidian`

## 1. 目标

连接用户的 Bilibili 账号，在应用内展示其**收藏夹**与**稍后再看**的视频列表；点击某个视频时，由 AI 梳理总结视频内容，并将总结整理成"经验型"笔记保存到用户的 Obsidian 库中。

成功标准：
- 用户可在应用内扫码/登录 Bilibili，登录态持久化。
- 收藏夹（含多个收藏夹）与稍后再看列表能正常拉取并展示。
- 点击任一视频，能稳定产出一篇 Markdown 笔记落入 Obsidian 库；视频无字幕时通过本地转写兜底。
- 任一处理阶段失败时，仅看 `swarm-dev.log` 即可定位失败发生在哪个阶段、哪个视频。

## 2. 关键决策（已与用户确认）

| 决策点 | 选择 |
|---|---|
| 内容提取 | 字幕优先；无字幕时下载 DASH 音轨 → ffmpeg 转 16kHz 单声道 → 本地转写兜底 |
| 本地 ASR | sherpa-onnx，模型用 SenseVoice（中文准、自带标点、快） |
| 转写运行位置 | Electron `utilityProcess` 独立子进程（不阻塞主进程，隔离原生模块） |
| 处理触发方式 | 混合：默认点一个跑一个，底层轻量顺序队列允许排队几个 |
| 笔记形态 | 结构化知识卡片 + 可复用经验/踩坑/步骤提炼（两者合体） |
| 登录方式 | Electron `BrowserWindow` 打开 B 站登录页，从 `session.cookies` 抽取凭证 |

## 3. 整体架构

沿用现有 `trending` 子系统的分层模式（`service` 抓数 + 缓存 → `ipc` 暴露 → renderer view）。

- 主进程新增 `src/main/bilibili/` 模块。
- 渲染层新增独立视图：路由 `src/renderer/src/routes/bilibili.tsx` + 组件 `src/renderer/src/components/views/bilibili-view.tsx`，结构对齐 `trending-view`。
- 转写在 Electron `utilityProcess` 中运行 sherpa-onnx。
- AI 总结复用现有 provider 基建（`src/main/providers`）。

## 4. 模块拆分（单一职责，可独立测试）

`src/main/bilibili/`：

| 文件 | 职责 | 依赖 |
|---|---|---|
| `auth.ts` | 开 `BrowserWindow` 登录 → 从 `session.cookies` 抽 `SESSDATA`/`bili_jct`/`DedeUserID`，持久化 + 校验有效性 | electron, store |
| `wbi.ts` | WBI 签名（计算 `w_rid`），供需要的接口调用 | — |
| `api.ts` | 拉收藏夹列表、收藏夹内容、稍后再看、视频 cid / 分 P 信息 | auth, wbi |
| `subtitle.ts` | 查字幕接口，有则拉 JSON 转纯文本 | api |
| `audio.ts` | 取 DASH 音轨 URL（WBI）→ 下载 → ffmpeg 转 16kHz 单声道 wav | api, wbi, ffmpeg |
| `transcribe.ts` | utilityProcess 内包装 sherpa-onnx (SenseVoice) | sherpa-onnx-node |
| `summarize.ts` | 组 prompt → 调现有 provider → 解析结构化结果 {主旨, 要点, 经验, 踩坑, 步骤} | providers |
| `obsidian.ts` | 按模板渲染 md + 写入库目录 | fs, store |
| `queue.ts` | 轻量顺序队列（默认点一个跑一个，可排几个） | — |
| `pipeline.ts` | 串联：取内容 → 总结 → 写盘，发进度事件 | 上述全部 |
| `ipc.ts` | IPC 端点：登录、列表、process(video)、队列状态 | pipeline, api, auth |
| `store.ts` | 配置持久化（cookies、库路径、模型路径等） | electron |
| `index.ts` | 装配 | — |

渲染层：`routes/bilibili.tsx`、`components/views/bilibili-view.tsx`，以及 Settings 中新增的 Bilibili 配置栏。

## 5. 数据流

### 列表展示
```
登录态有效 → api 拉收藏夹列表 + 各夹内容 + 稍后再看 → 缓存（仿 trending TTL）→ renderer 分 Tab 展示
```

### 单视频处理
```
点击视频
 → 入队（顺序执行）
 → 取 cid → 试字幕接口
      有字幕：拉 JSON → 文本
      无字幕：取音轨 → 下载 → ffmpeg → wav → utilityProcess 转写 → 文本
 → 文本 + 元数据 → LLM 总结（结构化）
 → 渲染 md → 写入 Obsidian 库
 → 全程 emit 进度事件，完成后给出笔记路径 / 可一键打开
失败：记录失败阶段（取字幕 / 转写 / 总结 / 写盘），UI 提示，队列继续下一个
```

## 6. Obsidian 笔记模板

```markdown
---
title: <视频标题>
bvid: <BVID>
url: <视频链接>
author: <UP 主>
duration: <时长>
source: <收藏夹名 / 稍后再看>
processed: <处理日期>
tags: [bilibili, ...]
---

## 一句话主旨

## 核心要点          ← 结构化知识卡片
- ...

## 可复用经验 / 方法论   ← 经验提炼
- ...

## 踩坑 / 注意
- ...

## 可执行步骤
1. ...

## 原视频
[<标题>](<链接>) （关键时间戳）
```

## 7. 设置项（Settings 新增 Bilibili 栏）

- Obsidian 库路径 + 笔记子目录 + 文件名模板
- sherpa-onnx 模型目录、ffmpeg 路径（默认走 PATH）
- 登录状态展示 / 退出登录

## 8. 日志与错误处理

遵循 CLAUDE.md §5：

- pipeline 每个阶段 `info` 记进出，带 `bvid` 与阶段名；完成记 `durationMs`。
- 每个 `catch` 记 `error`，带 `{ msg, err, bvid, stage }`，不吞异常。
- 分支意外（无字幕回退转写、登录态失效、队列限额）记 `warn`。
- 仅凭 `swarm-dev.log` 即可判断某次处理跑到了哪、在哪崩。

## 9. 测试

- 单测（mock 网络/文件）：WBI 签名、字幕 JSON 解析、md 渲染、队列顺序与失败续跑。
- 手动冒烟：扫码登录、真实视频字幕路径、无字幕转写路径、写入 Obsidian。

## 10. 风险与依赖

- **WBI 签名**：部分新接口需 `w_rid`，社区文档齐全（bilibili-API-collect），约 50 行实现。
- **sherpa-onnx-node**：N-API，ABI 跨 Node 版本稳定，Electron 下基本无需 rebuild（区别于 better-sqlite3）。
- **模型体积**：SenseVoice 模型数百 MB，需单独下载并在设置中配置路径。
- **转写耗时**：长视频转写可能数分钟，故强制后台 + 顺序队列，避免阻塞 UI。
- **登录态有效期**：SESSDATA 约数月，失效需重新登录；需检测并提示。
```

