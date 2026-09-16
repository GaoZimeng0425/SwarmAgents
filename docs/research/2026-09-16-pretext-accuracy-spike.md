# Pretext 准确性 spike 报告(Phase 0)

- Date: 2026-09-16
- Branch: `spike/pretext-accuracy`
- Harness: `scripts/spike-pretext/`(独立 Electron 应用,`<desktop>/node_modules/.bin/electron .` 运行)
- Raw data: `scripts/spike-pretext/results.json`

## 结论(TL;DR)

**决策点 D2 拍板:采用策略 B——维持现有字体栈(`-apple-system, BlinkMacSystemFont, …`)不变,不引入具名字体。** pretext 官方"macOS 上 system-ui 系测量不安全"的告警,在本项目的真实环境(Electron/Chromium、Retina DPR 2、真实中文语料、真实聊天宽度)下**未成立**:736px 与 500px 下全部 68 条语料预测误差为 0,100% ≤ 1px。性能亦远低于预算(prepare p50 ≈ 0.1ms,layout ≈ 0.002ms)。继续保留 `measureElement` 作残差兜底(混合架构,同 2026-09-10 spec §3)。

## 实验设置

- 语料:60 条仓库 docs 真实段落(两份中英混排技术 spec,含路径/行内代码/链接/标点)+ 8 条合成边界用例(emoji、CJK+latin 混排、纯 CJK 长段、超长单词、空白等),共 68 条。
- 字号/行高:14px/20px(与消息区 `text-sm` 一致);`word-break: normal`、`overflow-wrap: break-word`,与消息 CSS 同步。
- 宽度:736px(聊天区 `max-w-3xl` 实际文本宽)、500px、320px(极窄分栏)。
- 字体策略:当前栈 as-is、`system-ui`、`Helvetica Neue`、`Hiragino Sans GB`、`SF Pro Text`(具名候选)。
- 环境:macOS arm64,Electron(Chromium),DPR 2,`prepare('warmup')` 预热后计时。

## 结果

| 字体策略 | 736px | 500px | 320px |
|---|---|---|---|
| **stack-as-css(现用栈)** | **maxDrift 0,100% ≤1px** | **maxDrift 0,100% ≤1px** | 1 条 -20px 离群,98.5% ≤1px |
| system-ui | 同上 | 同上 | 同上 |
| Helvetica Neue | 同上 | 同上 | 1 条 -20px 离群 |
| Hiragino Sans GB | 同上 | 同上 | 2 条离群,97.1% ≤1px |
| SF Pro Text(具名) | maxDrift 0,100% ≤1px | 同上 | **maxDrift 0,100% ≤1px** |

性能(全字体/宽度):`prepare` p50 0–0.2ms、max 3.7ms(首条冷启动);`layout` 平均 ≈0.002ms。远优于验收线(prepare <2ms、layout <0.1ms)。

## 离群值分析

320px 下的 -20px 漂移(恰好一行)来自合成用例"中英混排 + 文件路径 `src/renderer/src/app.tsx` + `行号 :42`"(82 字符):DOM 折 4 行,pretext 折 3 行——即路径斜杠/冒号附近的断行机会差异,属 pretext README 已声明的边界类别。评估:

- 当前布局聊天文本宽度恒为 736px(窄窗口下 `max-w-3xl` 收缩,320px 仅出现在极窄分栏),触发面极小;
- 漂移量级为一行,混合架构下首帧后即被 `measureElement` 实测纠正;
- 无需为此改字体栈。若未来发现真实会话中窄宽度高频触发,再评估策略 A(`SF Pro Text` 在全部宽度 100% 精确,是已验证的兜底选项)。

## 对后续阶段的影响

- Phase 1(text-metrics 模块)可以直接以当前字体栈探测(`getComputedStyle` → canvas font shorthand),无需字体迁移与设计评审。
- 估计值质量预期:736px 常规内容下逐段 0 误差 → 滚动条稳定性与 scrollToItem 落点精度直接受益。
- 未覆盖项(留待 Phase 1 验证):`pre-wrap` 代码块外文本、Electron zoom 级别、用户替换系统字号;这些继续由实测兜底覆盖。

## 复现

```bash
cd scripts/spike-pretext
npm install
../../apps/desktop/node_modules/.bin/electron .
```
