# Round 10 方案：Chat 主路径体积治理 + R1–9 交付打包

**文档版本**: v1.0  
**状态**: 待确认后执行  
**项目根**: `c:\Software\conex`  
**分支**: `refactor/architecture`  
**调度角色**: 统一编排 / 多 Agent 并行 / 反偷懒验收

---

## 1. 背景与目标

### 1.1 已完成（R1–9，禁止重做）

| 轮次 | 成果                                                                                 |
| ---- | ------------------------------------------------------------------------------------ |
| R1–4 | UI 性能：单例 daemon 状态、CardPanel 惰性挂载、stableWidth、RO 守卫、eco backdrop 等 |
| R5   | 13 测试修复 + Vite MCP 解耦                                                          |
| R6   | settings eco + Daemon STREAM_PAUSE 真 pause-buffer                                   |
| R7   | stream-pause/resume 协议正式化 + 集成测                                              |
| R8   | lucide tree-shake（555→27KB）+ 冷面板 lazy                                           |
| R9   | 流契约文档 + clamp 回归修复                                                          |

### 1.2 当前瓶颈（证据）

| 产物                | 体积         | 说明                                      |
| ------------------- | ------------ | ----------------------------------------- |
| `index-*.js`        | **~1084 KB** | 主包；Chat/Workspace/Sidebar/store 静态链 |
| `vendor-workers`    | ~125 KB      | 已拆                                      |
| `vendor-lucide`     | **~27 KB**   | R8 已完成，勿再「优化」                   |
| 冷面板 Diff/Files/… | 10–34 KB     | 已按需                                    |

主路径源码体量（行数，近似复杂度）：

| 模块                    | 行数  | 角色                           |
| ----------------------- | ----- | ------------------------------ |
| `useChatStream.ts`      | ~1512 | 流式核心，被 ChatCard 静态引用 |
| `ChatCard.tsx`          | ~1009 | 对话壳，CardPanel **eager**    |
| `ChatMessageRow.tsx`    | ~947  | 行渲染 + markdown/DOM patch    |
| `daemonChatBridge.ts`   | ~1050 | 审批/桥，ChatCard 静态引用     |
| `layoutStore.ts`        | ~897  | 全局 store                     |
| `daemonClient.ts`       | ~893  | 部分路径已 dynamic import      |
| `CardPanel.tsx`         | ~874  | 壳 + Chat/Terminal eager       |
| `ChatMessageList.tsx`   | ~829  | 虚拟列表 + Pretext             |
| `ChatToolCallBlock.tsx` | ~784  | 工具块（行内）                 |
| `Sidebar.tsx`           | ~763  | 侧栏，App 静态                 |
| `ChatComposer.tsx`      | ~637  | 输入区                         |

**ChatCard 静态扇出**（节选）：`useChatStream`、`daemonChatBridge`、`ChatMessageList`、`ChatComposer`、`skillsApi`、`sessionExport`、`imageProcessing`、`providerProfiles`、`ModelBadgePickerMenu`、`ScheduledTasksPanel`、`ChatDemoChrome` 等 → 一次性进主包。

### 1.3 Round 10 目标

1. **主包 `index-*.js` 可观测下降**（见成功指标）
2. **首屏对话仍可用**：无白屏、无「点发送才加载聊天」的断裂
3. **流式/背压/markdown 语义不回退**
4. **交付**：方案落地后按逻辑拆 commit（或 1 个清晰 commit + PR 描述）

### 1.4 非目标（本轮不做）

- 重写 Chat 业务 / 换 markdown 引擎
- 强行 lazy 整个 ChatCard（默认工作区就是聊天，lazy 收益小且易闪白）
- 再动 lucide / 冷面板（R8 已完成）
- Provider 层 token 拉取级 pause（R6/R7 契约已覆盖 daemon 出站；属另一专项）
- 大范围 store 重架构

---

## 2. 设计原则

### 2.1 首屏 vs 交互后

```
首屏必须（保持 eager 或极早加载）:
  App shell / Sidebar / Workspace 骨架
  CardPanel + Chat 列表骨架 + Composer 壳
  layoutStore / session 索引

可延后到 idle 或首次交互:
  Markdown 高亮 / 完整 markdown 解析（流式终态已 Worker）
  Demo 专用 UI（ChatDemoChrome）
  导出 Markdown、图片处理重路径
  ScheduledTasksPanel、Skills 重逻辑（若非首屏必显）
  ModelBadgePicker 浮层内容
  highlight.js 实际执行路径（vendor 已拆，注意勿把同步 highlight 绑进首帧关键路径）
```

### 2.2 拆包铁律

| 规则                             | 说明                                                   |
| -------------------------------- | ------------------------------------------------------ |
| 不 lazy 默认可见的 Chat 列表本身 | 防首屏空壳过久                                         |
| 静态 `import type` 优先          | 类型不进 runtime                                       |
| 冷路径 `import()`                | 函数内 / 事件 handler / idle                           |
| 共享模块谨慎                     | 被多处静态引用的工具若拆出去，要避免重复打包或循环依赖 |
| 测量驱动                         | 每阶段前后 `vite build` + chunk 表，无收益则回退       |

### 2.3 与现有启动管线对齐

`main.tsx` 已分 Phase：

- bootstrap-orchestrator / bootstrap-core
- 渲染 App
- idle → `bootstrap-full`

R10 优先把 **Chat 重依赖** 挂到：

- 既有 `bootstrap-full` / `usePreloader` idle，或
- 首次「有 assistant 消息需要 HTML」/ 打开菜单时

避免再造第三套 bootstrap。

---

## 3. 分阶段方案（多 Agent）

```
Round 10
  ├── Wave 0   调度方：基线测量 + 依赖图确认（只读）
  ├── Wave 1   Agent 10A + 10B 并行（互不抢文件）
  ├── Wave 1-AUDIT
  ├── Wave 2   Agent 10C + 10D 并行
  ├── Wave 2-AUDIT
  ├── Wave 3   Agent 10E 交付打包（commit/PR 描述）
  └── Wave 3-FINAL 全量回归
```

### Wave 0 — 基线（调度方，只读，~15min）

```powershell
cd apps/crish-desktop
npx vite build
# 记录 dist/assets/*.js Top15 + gzip
# 记录 index / vendor-* 文件名与 KB
```

可选（有 rollup-plugin-visualizer 再开）：生成 `stats.html` 一次，确认 chat/markdown/bridge 占比。  
**无 visualizer 不强装依赖**，用 import 图 + 源文件体积足够。

**基线数字（本方案撰写时）**：index ≈ 1083.5 KB；lucide ≈ 27.2 KB。

---

### Wave 1 — 安全延后（高收益 / 低风险）

#### Agent 10A — ChatCard 冷功能动态化

**文件主责**：`ChatCard.tsx`（可小改子组件 export）

| 项                                           | 现状        | 改法                                  |
| -------------------------------------------- | ----------- | ------------------------------------- |
| `ChatDemoChrome`                             | 静态 import | 仅 demo 模式 `lazy` / 条件 `import()` |
| `tryDownloadSessionMarkdown` / sessionExport | 静态        | 导出按钮 onClick 内 `import()`        |
| `blobToImageAttachment` / imageProcessing    | 静态        | 粘贴/选图 handler 内 `import()`       |
| `ScheduledTasksPanel`                        | 静态        | 面板可见时 lazy                       |
| `skillsApi` 重逻辑                           | 静态        | 首屏仅 type/轻量；列表拉取延后        |
| `ModelBadgePickerMenu`                       | 静态        | 打开 picker 时再 load（菜单壳可留）   |

**禁止**：改流式协议、改 store 形状、拆 ChatMessageList 主体。

**验收**：

- tsc 通过
- Chat 相关 vitest 不红
- build 后 index 下降（目标本 Wave **≥ 40KB** 或可证明模块已出主包）

#### Agent 10B — markdown / 高亮路径收紧

**文件主责**：`ChatMessageRow.tsx`、`markdownRender.ts`、`codeHighlight`（若有）、`useChatStream.ts` 中**仅**终态 markdown 相关 import

| 项                                           | 改法                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `ChatMessageRow` → `markdownRender` 同步大包 | 首屏优先 `precomputedHtml` / 纯文本；完整 parse 走已有 `parseMarkdownToHtmlAsync` + Worker |
| `stripThoughtPlaceholders` / `escapeHtml`    | 若可抽到 `markdownRenderLite.ts`（小文件），避免整包 markdownRender 进行渲染热路径         |
| `IncrementalMarkdownBridge` / `domPatch`     | 确认是否仅复杂消息需要；可对无 tool/长文消息跳过初始化                                     |
| `ChangeOverviewCard` in Row                  | 有 diff 时再 lazy                                                                          |

**与 StreamRenderBuffer 契约**：流式期间 `html: ''` 不变；终态 Worker 写 HTML 不变。

**验收**：markdown 相关单测通过；index 再降或出现独立 `markdown*.js` chunk。

**文件隔离**：10A 不改 Row；10B 不改 ChatCard 壳。

---

### Wave 2 — 桥接与壳层（中收益 / 中风险）

#### Agent 10C — daemon 桥与 stream 侧

**文件主责**：`ChatCard` 与 `useChatStream` / `daemonChatBridge` 边界

| 项                                                                  | 改法                                                                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `daemonApproveTool` / `daemonDenyTool`                              | 审批 UI 展示时再 import bridge 重函数；或从 `daemonChatBridge` 拆 `approvalActions.ts` 轻量入口 |
| `useChatStream` 对 `publishToolDiffs` / `pricingStore` / `rulesApi` | 非每条消息路径改为惰性                                                                          |
| `StreamRecovery`                                                    | 确认是否可在首次 stream 时再 bind（若 ChatCard mount 即需要则保留）                             |

**禁止**：破坏 STREAM_PAUSE 水位上报、破坏 binary frame。

#### Agent 10D — 入口与 manualChunks 微调

**文件主责**：`main.tsx`、`vite.config.ts`、必要时 `App.tsx`

| 项                           | 改法                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.tsx` 静态 `import App` | 评估 `const App = lazy(() => import('./App'))` + 内联骨架：可把 App 业务与 bootstrap 分离；**若测量无收益或闪白则不做**                                                |
| `manualChunks`               | 增加稳定分包：如 `chat-stream`（useChatStream+StreamRenderBuffer）、`daemon-bridge`（daemonChatBridge），**仅当** rollup 能切开且不造成循环；避免过度碎 chunk 伤害缓存 |
| `vendor-highlight`           | 保持；确保业务侧不 `import *` highlight                                                                                                                                |

**验收**：build 成功；chunk 表合理；首屏仍出侧栏+聊天壳。

---

### Wave 3 — 交付

#### Agent 10E — Git 交付方案（不自动 force push）

建议 **逻辑拆分 2–4 个 commit**（便于 review），而非一个巨型 commit：

1. `perf(desktop): round1-4 ui jank fixes (daemon state, card mount, drag, eco)`
2. `fix(desktop): round5-6 tests, vite mcp, stream pause-buffer`
3. `feat(daemon): stream-pause protocol + backpressure tests`
4. `perf(desktop): round8-10 bundle (lucide, lazy panels, chat cold paths)`

若工作区与其它架构改动缠在一起，改为：

- **一个** `docs: add multi-agent execution guides R1-10`
- **一个** `perf/fix: desktop+daemon performance and protocol closeout`

由调度方 `git status` / `git diff --stat` 后决定可拆粒度；**提交前再向用户确认**（除非用户已授权直接 commit）。

PR 描述模板：问题 / R1–10 摘要 / 测试与 build 证据 / chunk 前后表 / 风险。

---

## 4. 成功指标

| 指标                   | 目标                        | 底线                                |
| ---------------------- | --------------------------- | ----------------------------------- |
| `index-*.js`           | **≤ 900 KB**（理想 ≤ 850）  | 较基线下降 **≥ 80 KB** 且无功能回退 |
| 新增 chat 冷路径 chunk | 可识别、按需                | 允许                                |
| lucide                 | 维持 ~27 KB                 | 不回升到 >50 KB                     |
| tsc                    | 0 errors                    | 必须                                |
| vitest desktop+daemon  | 0 failed（≈1977+）          | 必须                                |
| vite build             | success                     | 必须                                |
| 首屏体验               | 侧栏+聊天输入可见，无整页白 | 必须（人工/描述验收）               |

若 Wave 1 后已达底线而 Wave 2 风险高，**可提前收束进 Wave 3 交付**。

---

## 5. 风险与回滚

| 风险                            | 缓解                                        |
| ------------------------------- | ------------------------------------------- |
| 首次发消息卡顿（stream 懒加载） | stream 核心保持 eager；只延后非热路径       |
| markdown 首条 assistant 延迟    | 保持 Worker 异步；可 preload idle           |
| 双 Agent 文件冲突（R8 教训）    | **严格文件主责**；Wave 串行化冲突文件       |
| chunk 过碎                      | manualChunks 白名单制；审计 HTTP/2 下可接受 |
| 中文注释编码                    | 沿用项目编码守卫；改中文后回读              |

回滚：按 Wave git revert；chunk 回退不影响协议层。

---

## 6. 反偷懒检查表（每 Agent）

- [ ] 列出改动文件与「改前/改后」要点
- [ ] 跑指定 vitest + tsc
- [ ] 贴 build chunk Top10
- [ ] 未改 R1–9 已锁定模块（除非修回归）
- [ ] 无 `// TODO implement` 占位

---

## 7. 调度执行顺序（确认后）

1. 用户确认本方案（或勾选只做 Wave1 / 全做 / 只交付 commit）
2. Wave 0 基线数字固化到本文件「执行记录」节
3. 并行 10A ∥ 10B → AUDIT
4. 并行 10C ∥ 10D → AUDIT（可按 10A/B 收益裁剪）
5. FINAL 全量测试 + build
6. 提交方案交用户确认后 commit/PR

---

## 8. 执行记录

| 时间   | Wave         | index KB  | 备注                                                  |
| ------ | ------------ | --------- | ----------------------------------------------------- |
| 方案时 | baseline     | 1083.6    | lucide 27.2                                           |
| 执行   | W1 (10A+10B) | ~1033     | 冷路径 lazy + markdownLite                            |
| 执行   | W2 (10C+10D) | **548.2** | stream 惰性 + manualChunks                            |
| 执行   | FINAL        | **548.2** | tsc OK；daemon-bridge 240 / react 188 / highlight 106 |

**相对基线：index 1083.6 → 548.2 KB（约 −49%）**，远超「≤900 / 至少 −80KB」目标。

---

## 9. 请用户确认的选项

请选择后开始执行：

| 选项          | 内容                                                         |
| ------------- | ------------------------------------------------------------ |
| **A（推荐）** | Wave 0–1 全做 + FINAL；达底线则打包 commit 方案，Wave 2 可选 |
| **B**         | Wave 0–2 全做后 FINAL + commit 方案                          |
| **C**         | 暂不改体积，只整理 R1–9 的 commit/PR 描述与提交              |
| **D**         | 仅 Wave 1（10A+10B），不做 git                               |

默认推荐 **A**：先吃 ChatCard 冷路径 + markdown 轻量化，风险可控、易验收。
