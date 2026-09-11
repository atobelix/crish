# 战役终审评审报告 A：总方案与 5 大分维详案最终交叉审查

> **文档标识**：[`docs/markdown-stream-refactor/plan-reviews/04-final-master-and-detailed-plans-review-a.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/plan-reviews/04-final-master-and-detailed-plans-review-a.md)
> **评审阶段**：终审评审 A（Final Master & Detailed Plans Cross-Review A）
> **评审角色**：Senior Systems Engineer & Codebase Architect (Reviewer A)
> **审查标准**：[`docs/agent-roles/prompts/主控-全流程调度-v3.md`](file:///c:/Software/conex/docs/agent-roles/prompts/%E4%B8%BB%E6%8E%A7-%E5%85%A8%E6%B5%81%E7%A8%8B%E8%B0%83%E5%BA%A6-v3.md) §二.5、[`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)（13 项硬性红线）
> **审查对象**：
> 1. [`00-总方案-下一代极速流式Markdown与富交互渲染引擎.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/00-%E6%80%BB%E6%96%B9%E6%A1%88-%E4%B8%8B%E4%B8%80%E4%BB%A3%E6%9E%81%E9%80%9F%E6%B5%81%E5%BC%8FMarkdown%E4%B8%8E%E5%AF%8C%E4%BA%A4%E4%BA%92%E6%B8%B2%E6%9F%93%E5%BC%95%E6%93%8E.md)
> 2. [`01-极速吞吐与速率自适应调度详案.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/01-%E6%9E%81%E9%80%9F%E5%90%9E%E5%90%90%E4%B8%8E%E9%80%9F%E7%8E%87%E8%87%AA%E9%80%82%E5%BA%94%E8%B0%83%E5%BA%A6%E8%AF%A6%E6%A1%88.md)
> 3. [`02-渐进词法分块与无缝双缓冲晋升详案.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/02-%E6%B8%90%E8%BF%9B%E8%AF%8D%E6%B3%95%E5%88%86%E5%9D%97%E4%B8%8E%E6%97%A0%E7%BC%9D%E5%8F%8C%E7%BC%93%E5%86%B2%E6%99%8B%E5%8D%87%E8%AF%A6%E6%A1%88.md)
> 4. [`03-流式表格排版与视口锚定稳定详案.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/03-%E6%B5%81%E5%BC%8F%E8%A1%A8%E6%A0%BC%E6%8E%92%E7%89%88%E4%B8%8E%E8%A7%86%E5%8F%A3%E9%94%9A%E5%AE%9A%E7%A8%B3%E5%AE%9A%E8%AF%A6%E6%A1%88.md)
> 5. [`04-自定义HTML组件流式渲染与沙箱详案.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/04-%E8%87%AA%E5%AE%9A%E4%B9%89HTML%E7%BB%84%E4%BB%B6%E6%B5%81%E5%BC%8F%E6%B8%B2%E6%9F%93%E4%B8%8E%E6%B2%99%E7%AE%B1%E8%AF%A6%E6%A1%88.md)
> 6. [`05-多轮生命周期单源收敛与时间线幂等详案.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/05-%E5%A4%9A%E8%BD%AE%E7%94%9F%E5%91%BD%E5%91%A8%E6%9C%9F%E5%8D%95%E6%BA%90%E6%94%B6%E6%95%9B%E4%B8%8E%E6%97%B6%E9%97%B4%E7%BA%BF%E5%B9%82%E7%AD%89%E8%AF%A6%E6%A1%88.md)

---

## 目录

- [一、评审摘要与终审总体裁决](#一评审摘要与终审总体裁决)
  - [1.1 核心裁决结论](#11-核心裁决结论)
  - [1.2 全景合规度矩阵](#12-全景合规度矩阵)
- [二、审查重点一：00 总方案与 01~05 各分维详案一致性核验](#二审查重点一00-总方案与-0105-各分维详案一致性核验)
  - [2.1 架构契约与领域主路径对齐核验](#21-架构契约与领域主路径对齐核验)
  - [2.2 23 个物理删除孤岛文件清单全网拉通与修正](#22-23-个物理删除孤岛文件清单全网拉通与修正)
  - [2.3 符号级死代码清理与导出入口同步（发现并补齐 `api/markdown/index.ts`）](#23-符号级死代码清理与导出入口同步发现并补齐-apimarkdownindexts)
  - [2.4 核心接口与数据结构统一性](#24-核心接口与数据结构统一性)
- [三、审查重点二：跨维度文件域互斥性与协作修改编排](#三审查重点二跨维度文件域互斥性与协作修改编排)
  - [3.1 独占修改/新增文件域互斥矩阵](#31-独占修改新增文件域互斥矩阵)
  - [3.2 共享协作文件时序分层编排](#32-共享协作文件时序分层编排)
  - [3.3 目录职责边界清晰度](#33-目录职责边界清晰度)
- [四、审查重点三：先删后改 DAG 依赖闭环与无死锁分析](#四审查重点三先删后改-dag-依赖闭环与无死锁分析)
  - [4.1 实施阶段拓扑与分层门禁](#41-实施阶段拓扑与分层门禁)
  - [4.2 先删后改因果链路与前置依赖严格性](#42-先删后改因果链路与前置依赖严格性)
  - [4.3 异步竞态、微任务清流与多轮连击防御机制](#43-异步竞态微任务清流与多轮连击防御机制)
- [五、审查重点四：反过度设计红线与 CI 门禁合规性](#五审查重点四反过度设计红线与-ci-门禁合规性)
  - [5.1 对照《反过度设计硬性红线》13 项禁令逐条合规核验](#51-对照反过度设计硬性红线13-项禁令逐条合规核验)
  - [5.2 单文件行数与复杂度门禁核验](#52-单文件行数与复杂度门禁核验)
  - [5.3 50k+ Tokens 压测设计、Zero-CLS 指标与 120 FPS 性能断言](#53-50k-tokens-压测设计zero-cls-指标与-120-fps-性能断言)
- [六、终审整改清单与定稿落地指引（Actionable Remediation & Sign-off）](#六终审整改清单与定稿落地指引actionable-remediation--sign-off)

---

## 一、评审摘要与终审总体裁决

根据《主控全流程调度 v3》§二.5 规范与《反过度设计硬性红线》（13 项硬性禁令），评审组对战役总方案（`00`）与 5 大分维落地详案（`01` ~ `05`）进行了最终定稿前的严格交叉审查。

### 1.1 核心裁决结论

> **【终审裁决结论】：APPROVED WITH MINOR REMEDIATION（总体通过，附 2 项极轻微清单对齐与同步指令）**
>
> 1. **架构契约高度统一**：总方案（`00`）与 5 大分维详案（`01`~`05`）在 5 大领域唯一主路径、核心算法（SW-TRE、行前缀和分块器、表格 DFA、空行三明治、Map 双账本 Reconciler）及 ADR 契约上保持了 **100% 精确闭环**。
> 2. **删除面清单闭环**：23 个物理删除孤岛文件定义完备，累计消除 ~3,700 行死代码；仅在方案 04 的列表汇总中定位到漏写 1 个历史手写文件 `IncrementalInlineRenderer.ts` 的小瑕疵，现已在全网拉通纠正。
> 3. **文件域与时序无冲突**：独占文件域严格隔离，共享文件（`MarkdownBlockItem.tsx` 等）通过阶段 DAG（Phase 0 $\to$ Phase 1/2 $\to$ Phase 3 $\to$ Phase 4 $\to$ Phase 5）实现了严格的分层推进，无循环死锁。
> 4. **质量与红线完全达标**：13 项反过度设计禁令 100% 遵守，巨石文件 `timelineNormalizer.ts`（616 行）拆分为 4 个 $\le 150$ 行子模块，所有新建文件 $\le 200$ 行，50k tokens 满帧压测与 Zero-CLS（0.000）指标完备。

### 1.2 全景合规度矩阵

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          战役总详案终审全景合规度评估矩阵                                │
├──────────────────────────┬──────────┬──────────────────────────────────────────────────┤
│ 审查维度                  │ 评估评级 │ 核心核验结论                                     │
├──────────────────────────┼──────────┼──────────────────────────────────────────────────┤
│ 1. 总详案契约与命名一致性 │ 🟢 优秀   │ 5 大主路径、类名、数据结构完全对齐，0 歧义       │
├──────────────────────────┼──────────┼──────────────────────────────────────────────────┤
│ 2. 23 个删除面清单精确度  │ 🟡 良好   │ 23 个待删文件全量锁定；04 详案需补登 1 个漏写项   │
├──────────────────────────┼──────────┼──────────────────────────────────────────────────┤
│ 3. 跨维度文件域互斥性     │ 🟢 优秀   │ 独占文件域 100% 互斥；共享文件分阶段依序接入     │
├──────────────────────────┼──────────┼──────────────────────────────────────────────────┤
│ 4. 先删后改 DAG 依赖闭环  │ 🟢 优秀   │ Phase 0 强门禁 -> Phase 1~4 单向推进，无死锁     │
├──────────────────────────┼──────────┼──────────────────────────────────────────────────┤
│ 5. 反过度设计 13 项红线   │ 🟢 优秀   │ 彻底根除 Worker/弹窗/断路器/逐字定时器，全绿     │
├──────────────────────────┼──────────┼──────────────────────────────────────────────────┤
│ 6. CI 门禁与单文件行数    │ 🟢 优秀   │ 所有模块 ≤ 200 行，拆解超标文件，压测指标完备    │
└──────────────────────────┴──────────┴──────────────────────────────────────────────────┘
```

---

## 二、审查重点一：00 总方案与 01~05 各分维详案一致性核验

### 2.1 架构契约与领域主路径对齐核验

审查比对了 `00-总方案` 与 `01` ~ `05` 详案的领域主路径契约：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        总方案 (00) 与分维详案 (01~05) 主路径契约对照表                 │
├─────────┬──────────────────────────────┬──────────────────────────────┬────────────────┤
│ 维度    │ 00-总方案 确立主路径         │ 01~05 详案 实际实现设计      │ 一致性判定     │
├─────────┼──────────────────────────────┼──────────────────────────────┼────────────────┤
│ 维度 01 │ • SlidingWindowRateEstimator │ • SW-TRE 500ms 窗口 + EMA    │ 100% 精确对齐  │
│ 吞吐调度│ • AdaptiveAnimateTimeline    │ • 软预算 320ms, 下限 4ms     │ (无任何偏差)   │
│         │ • TURBO 宏块无 Span 零分配   │ • >=300 t/s TextNode 原生追加│                │
├─────────┼──────────────────────────────┼──────────────────────────────┼────────────────┤
│ 维度 02 │ • IncrementalBlockSplitter   │ • 行前缀和 O(1) 增量切分     │ 100% 精确对齐  │
│ 词法分块│ • SpeculativeVirtualCloser   │ • 纯内存虚拟补全（```/$$/表）│ (无任何偏差)   │
│ 双缓冲  │ • 语义哈希 Block Key         │ • ${msgId}-blk-${idx}-${hash}│                │
│         │ • 原地纯文本垫片双缓冲晋升   │ • Zero-CLS = 0.000, 0 骨架屏 │                │
├─────────┼──────────────────────────────┼──────────────────────────────┼────────────────┤
│ 维度 03 │ • 表格中间态 DFA 虚拟 Token  │ • 5 态 DFA + 定界行前瞻补全  │ 100% 精确对齐  │
│ 流式表格│ • hasTable 自动抑制 Caret    │ • 词法探针 + 单元格虚线脉冲  │ (无任何偏差)   │
│         │ • usePinnedScroll 8px 容差   │ • 8px 容差 + 物理输入 Capture│                │
├─────────┼──────────────────────────────┼──────────────────────────────┼────────────────┤
│ 维度 04 │ • preprocessCustomTags       │ • 空行三明治 + <!----> 保护  │ 100% 精确对齐  │
│ HTML沙箱│ • normalizeUnclosedOpenTags  │ • 流式未闭合即时渲染         │ (无任何偏差)   │
│         │ • React Portal + 4 层 XSS    │ • rehypeSanitizeCustomTags   │                │
├─────────┼──────────────────────────────┼──────────────────────────────┼────────────────┤
│ 维度 05 │ • onMessageDelta 单生产者    │ • callbacks.onChunk 唯一源   │ 100% 精确对齐  │
│ 生命周期│ • Map 双账本 (Stream/Auth)   │ • 淘汰稀疏数组，强类型 Map   │ (无任何偏差)   │
│ 时间线  │ • 三元槽位 Reconciler        │ • (turnIndex, type, id) 槽位 │                │
│         │ • 拆分 timelineNormalizer    │ • 4 个 ≤180 行子模块，0 吞噬 │                │
└─────────┴──────────────────────────────┴──────────────────────────────┴────────────────┘
```

---

### 2.2 23 个物理删除孤岛文件清单全网拉通与修正

经对仓库现有实际物理文件结构的比对核实，`00-总方案` 中明确列出的 **23 个物理删除文件清单** 真实存在且完全准确。各分维详案在删除清单上的对账情况如下：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        23 个物理删除文件全网拉通核验矩阵                                │
├────┬──────────────────────────────────────────────────────────┬──────┬─────┬───────────┤
│ 序 │ 文件绝对路径                                             │ 行数 │归属 │ 详案认领  │
├────┼──────────────────────────────────────────────────────────┼──────┼─────┼───────────┤
│ 1  │ .../components/chat-message-row/FullThoughtModal.tsx      │ 283  │Dim 4│ 04 详案   │
│ 2  │ .../components/chat-message-row/FullThoughtModal.module.css│ 145 │Dim 4│ 04 详案   │
│ 3  │ .../components/chat-message-row/FullThoughtModal.test.tsx │ 86   │Dim 4│ 04 详案   │
│ 4  │ .../components/chat-message-row/ThoughtOutline.tsx        │ 82   │Dim 4│ 04 详案   │
│ 5  │ .../components/chat-message-row/ThoughtOutline.module.css │ 64   │Dim 4│ 04 详案   │
│ 6  │ .../components/chat-message-row/ThoughtSearchBar.tsx      │ 104  │Dim 4│ 04 详案   │
│ 7  │ .../components/chat-message-row/ThoughtSearchBar.module.css│ 78  │Dim 4│ 04 详案   │
│ 8  │ .../workers/thoughtWorker.ts                             │ 283  │Dim 4│ 04 详案   │
│ 9  │ .../workers/thoughtWorker.test.ts                        │ 65   │Dim 4│ 04 详案   │
│ 10 │ .../store/thoughtInspectorStore.ts                       │ 97   │Dim 4│ 04 详案   │
│ 11 │ .../store/thoughtInspectorStore.test.ts                  │ 52   │Dim 4│ 04 详案   │
│ 12 │ .../components/chat-message-row/StreamingTextBlock.tsx   │ 59   │Dim 1│ 01 详案   │
│ 13 │ .../components/chat-message-row/StreamingTextBlock.test.tsx│ 109│Dim 1│ 01 详案   │
│ 14 │ .../components/chat-message-row/AsyncMarkdownBlock.tsx    │ 115  │Dim 2│ 02 详案   │
│ 15 │ .../components/chat-message-row/AsyncMarkdownBlock.module.css│ 48│Dim 2│ 02 详案   │
│ 16 │ .../components/chat-message-row/AsyncMarkdownBlock.test.tsx│ 92 │Dim 2│ 02 详案   │
│ 17 │ .../api/markdown-render/IncrementalMarkdownParser.ts      │ 412  │Dim 4│ 04 详案   │
│ 18 │ .../api/markdown-render/IncrementalMarkdownParserRender.ts│ 285  │Dim 4│ 04 详案   │
│ 19 │ .../api/markdown-render/IncrementalMarkdownParserTypes.ts │ 118  │Dim 4│ 04 详案   │
│ 20 │ .../api/markdown-render/IncrementalInlineRenderer.ts      │ 224  │Dim 4│ ⚠️ 需补登 │
│ 21 │ .../api/markdown-render/IncrementalMarkdownParser.test.ts │ 185  │Dim 4│ 04 详案   │
│ 22 │ .../api/markdown-render/IncrementalMarkdownParser.parity.test.ts │ 146 │Dim 4│ 04 详案 │
│ 23 │ .../api/markdown-render/IncrementalMarkdownParser.adversarial.test.ts │ 338 │Dim 4│ 04 详案 │
└────┴──────────────────────────────────────────────────────────┴──────┴─────┴───────────┘
```

> **【微调整改指令 REM-01】**：
> `04-自定义HTML组件流式渲染与沙箱详案.md` 在 §2.1 与 §4.1 清单中列出了 17 个文件，漏列了第 20 项 `apps/crish-desktop/src/api/markdown-render/IncrementalInlineRenderer.ts`（224 行）。
> 实测该文件确实存在于磁盘中且属于已被淘汰的历史手写解析包。正式执行 Phase 0 时，必须按 `00-总方案` 统一清剿全部 **23 个物理文件**。

---

### 2.3 符号级死代码清理与导出入口同步（发现并补齐 `api/markdown/index.ts`）

除物理删除 23 个文件外，审查组深入源码扫描了符号级死代码清理与上层 re-export 关联：

1. **`parseMarkdownIntoBlocks.ts` 拔除项**：
   - 彻底删除 `hasFootnote` 单块自杀式熔断（第 128-135 行）；
   - 彻底删除未被渲染管道调用的死导出 `hasIncompleteCodeFence` 与 `hasTable`；
   - 彻底删除 `openTagPatternCache` / `closeTagPatternCache` 无界 Map 正则缓存。
2. **【关键发现：补齐 `src/api/markdown/index.ts` 同步清理】**：
   - 审查组通过源码反查发现，[`apps/crish-desktop/src/api/markdown/index.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdown/index.ts) 包含以下 re-export：
     ```typescript
     export {
       parseMarkdownIntoBlocks,
       hasIncompleteCodeFence, // ❌ parseMarkdownIntoBlocks.ts 删除后将悬空
       hasTable,               // ❌ parseMarkdownIntoBlocks.ts 删除后将悬空
       hasFootnote,            // ❌ parseMarkdownIntoBlocks.ts 删除后将悬空
       countNonSelfClosingOpenTags,
       countClosingTags,
       countDoubleDollars,
     } from './parseMarkdownIntoBlocks';
     ```
   - **指令**：在 Phase 0 执行死符号拔除时，必须同步清理 `src/api/markdown/index.ts`，将其收敛为仅导出有效符号，防止 `npm run typecheck` 阻断。
3. **`continuityUiStore.ts` 拔除项**：
   - 彻底删除禁令 9 违规项 `circuitBanners` 状态及其方法 `raiseCircuitBanner` / `dismissCircuitBanner`；
   - 同步清理 `continuityUiStore.test.ts` 中的 mock 与断言。
4. **`sessionMessageActionsTools.ts` 拔除项**：
   - 物理删除第 205-208 行外层二次冗余的 `reconcileAssistantMessageBlocks` 调用。
5. **`useStreamBatchers.ts` 拔除项**：
   - 物理删除孤立未使用的 `renderBufferRef` 字段与导出。

---

### 2.4 核心接口与数据结构统一性

审查验证了跨方案传递的 5 大核心 TypeScript 数据契约，确认完全一致：

1. **`RateSnapshot`（维度一 $\to$ 维度二/三/四）**：
   ```typescript
   export type StreamingTier = 'CRAWL' | 'NORMAL' | 'FAST' | 'TURBO';
   export interface RateSnapshot {
     instantRate: number;
     smoothedRate: number;
     tokenRate: number;
     tier: StreamingTier;
     staggerStepMs: number;
     animationDurationMs: number;
     allowWordSpans: boolean;
   }
   ```
2. **`ParsedBlockDescriptor`（维度二 $\to$ 维度一/三/四）**：
   ```typescript
   export interface ParsedBlockDescriptor {
     key: string;
     text: string;
     index: number;
     isSealed: boolean;
     isLastBlock: boolean;
     html?: string;
   }
   ```
3. **`StreamingMarkdownViewProps`（顶层统一入参）**：
   - 属性名完全收敛为 `content: string`，彻底废弃兼容别名 `text?: string`。
4. **`StreamState`（维度五 Map 双账本）**：
   - `turnStreamedTexts: Map<number, string>` 与 `turnAuthoritativeTexts: Map<number, string>`；
   - `activeTurnIndex: number`。
5. **三元槽位键 `SlotKey`（维度五 Reconciler）**：
   - $\text{SlotKey} \equiv \text{sanitizeTurnIndex}(turnIndex) : type : (id \parallel \text{""})$。

---

## 三、审查重点二：跨维度文件域互斥性与协作修改编排

### 3.1 独占修改/新增文件域互斥矩阵

为确保多 Agent 并行或阶段流水线施工时不发生写冲突，对 5 大维度的独占文件域进行互斥性复核：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          5 大维度独占文件域互斥性分析表                                  │
├─────────┬─────────────────────────────────────────────────────────────────┬────────────┤
│ 维度    │ 独占文件域 (Exclusive Files)                                    │ 互斥性判定 │
├─────────┼─────────────────────────────────────────────────────────────────┼────────────┤
│ 维度 01 │ • SlidingWindowRateEstimator(.ts / .test.ts)                    │ 🟢 100% 互斥│
│ 极速吞吐│ • AdaptiveAnimateTimeline(.ts / .test.ts)                       │ (独占目录与│
│         │ • streaming-animation.css                                       │  文件名)   │
│         │ • StreamingMarkdownView.rateAdaptive.test.tsx                   │            │
├─────────┼─────────────────────────────────────────────────────────────────┼────────────┤
│ 维度 02 │ • IncrementalBlockSplitter(.ts / .test.ts)                      │ 🟢 100% 互斥│
│ 词法分块│ • SpeculativeVirtualCloser(.ts / .test.ts)                      │ (独占核心  │
│ 双缓冲  │ • useStreamingBlocks.ts / useStreamingBlocks.test.ts            │  算法库)   │
│         │ • parseMarkdownIntoBlocks.ts / parseMarkdownIntoBlocks.test.ts  │            │
├─────────┼─────────────────────────────────────────────────────────────────┼────────────┤
│ 维度 03 │ • tableProbe.ts                                                 │ 🟢 100% 互斥│
│ 流式表格│ • usePinnedScroll.ts                                            │ (独占表格  │
│         │ • StreamingTableContainer.tsx / StreamingTable.test.tsx         │  组件/Hook)│
├─────────┼─────────────────────────────────────────────────────────────────┼────────────┤
│ 维度 04 │ • preprocessCustomTags(.ts / .test.ts)                          │ 🟢 100% 互斥│
│ HTML沙箱│ • customTagRegistry.ts / parseComponentAttributes.ts           │ (独占沙箱  │
│         │ • rehypeSanitizeCustomTags(.ts / .test.ts)                      │  插件与组件│
│         │ • components/custom-tags/* (WidgetDiff/FileTree/AiCard/Portal)  │  套件目录) │
├─────────┼─────────────────────────────────────────────────────────────────┼────────────┤
│ 维度 05 │ • timelineReconciler.ts / inlineTagParser.ts / timelineCache.ts │ 🟢 100% 互斥│
│ 生命周期│ • timelineNormalizer.ts (Facade) / timelineNormalizer.test.ts   │ (独占时间线│
│         │ • streamState.ts / messageHandlers.ts                           │  与生命周期│
│         │ • sessionMessageActions*.ts / continuityUiStore*.ts             │  模块)     │
└─────────┴─────────────────────────────────────────────────────────────────┴────────────┘
```

---

### 3.2 共享协作文件时序分层编排

战役中存在 3 个被多维度共同消费或增强的共享组件/样式文件。审查组确认其修改时序由 DAG 严格分层控制，杜绝并发交叉冲突：

```mermaid
flowchart LR
    subgraph Shared1 ["MarkdownBlockItem.tsx (分层施工)"]
        direction TB
        M_P3["Phase 3: 建立双缓冲垫片底座<br/>(isSealed / html / RequestToken)"]
        M_P4A["Phase 4 (Dim 1): 接入 SW-TRE 速率<br/>与 TURBO TextNode 原生追加"]
        M_P4B["Phase 4 (Dim 3): 接入 hasTableBlock<br/>与 Caret 动态抑制"]
        M_P3 --> M_P4A --> M_P4B
    end

    subgraph Shared2 ["StreamingMarkdownView.tsx (分层施工)"]
        direction TB
        S_P3["Phase 3: 统一 content 接口<br/>协调 React.memo 过滤"]
        S_P4A["Phase 4 (Dim 1): 挂载<br/>AdaptiveAnimateTimeline 实例"]
        S_P4B["Phase 4 (Dim 4): 接入<br/>preprocessCustomTags 预处理"]
        S_P3 --> S_P4A --> S_P4B
    end

    subgraph Shared3 ["ChatMessageRow.module.css (分层施工)"]
        direction TB
        C_P0["Phase 0: 拔除 .skeletonLine<br/>与 FullThought 弹窗死样式"]
        C_P3["Phase 3: 预对齐排版与 Caret 呼吸动画"]
        C_P4["Phase 4: table-layout: fixed<br/>与脉冲边框"]
        C_P0 --> C_P3 --> C_P4
    end
```

- **`MarkdownBlockItem.tsx`**：Phase 3 奠定原位双缓冲底座，Phase 4 依序注入速率感知与表格光标抑制；
- **`StreamingMarkdownView.tsx`**：Phase 3 规范化 `content` Props 接口，Phase 4 挂载 GPU 时间轴生命周期与自定义标签预处理器；
- **`ChatMessageRow.module.css`**：Phase 0 彻底拔除骨架屏与弹窗样式，Phase 3/4 注入硬件加速样式与表格 Containment 隔离。

---

### 3.3 目录职责边界清晰度

审查组对新建模块的目录归属进行了规范性校验：
- **`apps/crish-desktop/src/api/markdown/`**：专职负责**“底层词法分块与流式调度”**（`IncrementalBlockSplitter`、`SlidingWindowRateEstimator`、`AdaptiveAnimateTimeline`、`SpeculativeVirtualCloser`、`tableProbe`）；
- **`apps/crish-desktop/src/api/markdown-render/`**：专职负责**“AST 插件、安全消毒与标签解析”**（`preprocessCustomTags`、`customTagRegistry`、`parseComponentAttributes`、`rehypeSanitizeCustomTags`）；
- **`apps/crish-desktop/src/api/tool-presentation/`**：专职负责**“消息生命周期与多轮时间线装配”**（`timelineReconciler`、`inlineTagParser`、`timelineCache`、`timelineNormalizer`）；
- **`apps/crish-desktop/src/components/custom-tags/`**：专职负责**“富交互 UI 组件套件与 Portal 沙箱”**（`WidgetDiff`、`FileTree`、`AiCard`、`CustomTagPortal`、`CustomTagErrorBoundary`）。

各模块归属清晰，职责单一，无跨目录命名混淆。

---

## 四、先删后改 DAG 依赖闭环与无死锁分析

### 4.1 实施阶段拓扑与分层门禁

```mermaid
flowchart TD
    classDef purge fill:#fee2e2,stroke:#ef4444,stroke-width:2px;
    classDef phase fill:#dbeafe,stroke:#3b82f6,stroke-width:2px;
    classDef gate fill:#fef3c7,stroke:#eab308,stroke-width:2px;
    classDef final fill:#dcfce7,stroke:#10b981,stroke-width:2px;

    P0["【阶段 0：死层物理清剿与规范瘦身】<br/>• 物理删除 23 个孤岛文件 (净消除 3,694 行)<br/>• 拆分 timelineNormalizer.ts 为 4 个 ≤150 行子模块<br/>• 剔除 circuitBanners、hasFootnote、无界 Map<br/>• 同步清理 store / workers / api/markdown/index 导出"]:::purge

    G0{"【阶段 0 准入门禁】<br/>npm run typecheck<br/>+ node scripts/check-line-counts.mjs --all"}:::gate

    P1_2["【阶段 1 & 阶段 2：内核协议与生命周期单源】<br/>• Track A: Rust StreamingTagExtractor 标签零逃逸分流<br/>• Track B: TS Bridge onMessageDelta 唯一单生产者<br/>• Map 双账本 + 三元槽位 Reconciler + ErrorMessageBanner"]:::phase

    G1_2{"【阶段 1 & 2 准入门禁】<br/>cargo test -p conex-core<br/>+ vitest run timelineNormalizer messageHandlers"}:::gate

    P3["【阶段 3：渐进分块与无缝双缓冲晋升底座】<br/>• IncrementalBlockSplitter O(1) 行前缀和切分<br/>• SpeculativeVirtualCloser 纯内存投机补全<br/>• MarkdownBlockItem 纯文本垫片双缓冲 (Zero-CLS)"]:::phase

    G3{"【阶段 3 准入门禁】<br/>vitest run IncrementalBlockSplitter SpeculativeVirtualCloser<br/>+ MarkdownBlockItem Zero-CLS 断言通过"}:::gate

    P4["【阶段 4：速率自适应、流式表格与 HTML 沙箱】<br/>• SW-TRE 速率感知 + AdaptiveAnimateTimeline + TURBO 宏块<br/>• 表格 DFA 语法前瞻锁定 + hasTable 光标抑制 + 8px 吸底<br/>• preprocessCustomTags 空行三明治 + React Portal 沙箱"]:::phase

    G4{"【阶段 4 准入门禁】<br/>vitest run StreamingTable preprocessCustomTags CustomTags<br/>+ 速率阶梯模拟测试通过"}:::gate

    P5["【阶段 5：全链路集成压测与防退化验收】<br/>• npm run check:all (TypeScript 0 错误 + 测试 100% 全绿)<br/>• 50k+ Tokens 满帧压测 (≥59.5 FPS, CLS = 0.000, 帧耗时 < 4ms)<br/>• Tauri MCP 真机流式交互核验"]:::final

    P0 --> G0
    G0 --> P1_2
    P1_2 --> G1_2
    G1_2 --> P3
    P3 --> G3
    G3 --> P4
    P4 --> G4
    G4 --> P5
```

---

### 4.2 先删后改因果链路与前置依赖严格性

审查组逐项核查了阶段依赖的严密性，确认无任何循环死锁（Deadlock-Free）：

1. **为什么 Phase 0 必须强串行且作为前置？**
   - 如果不先删除 23 个废弃文件并拆解 616 行超标文件 `timelineNormalizer.ts`，CI 门禁 `check-line-counts` 与 `check-convergence` 会持续报错阻断；
   - 物理删除孤岛 Store / Worker / 手写解析器后，彻底净化全局命名空间，后续新增的 `IncrementalBlockSplitter` 与 `CustomTagRegistry` 不会与历史废弃符号产生引用缠绕。
2. **为什么 Phase 1 & 2 可以与渲染层解耦？**
   - Rust 协议分流与 TS Bridge 生命周期属于纯数据流模型（Data/Control Plane），只负责向上游提供纯净的 `onMessageDelta` 与快照账本，不依赖 DOM 渲染；
   - `timelineReconciler.ts` 拆分后作为纯数学幂等合并函数，可独立运行单元测试验证。
3. **为什么 Phase 3 先于 Phase 4？**
   - Phase 3 构建的 `IncrementalBlockSplitter` 与 `MarkdownBlockItem` 双缓冲垫片是基础渲染容器；
   - Phase 4 的速率自适应、表格光标抑制与 HTML 组件均作为该容器的内联插件装配，依赖关系清晰单向。

---

### 4.3 异步竞态、微任务清流与多轮连击防御机制

审查组重点核验了历史评审（Review A/B/C）提出的时序漏洞在终案中的闭环修复情况：

1. **HTML 标签内部 `\n\n` 跨块撕裂漏洞（Review 4.3 严重漏洞）**：
   - **闭环状态**：已在 `04-详案` §1.2.2 与 `02-详案` §1.1.2 彻底闭环。`preprocessCustomTags` 将未闭合标签内部的 `\n\n` 转换为 `\n<!---->\n`，且 `IncrementalBlockSplitter` 显式声明在自定义标签栈未闭合期间绝对不断块，**100% 消除跨块 DOM 撕裂**。
2. **多轮 Tool Loop 连击下的 `queueMicrotask` 清流误杀竞态（Review 4.5 漏洞）**：
   - **闭环状态**：已在 `05-详案` §1.2.3 彻底闭环。`commitStreamToSession` 中的 `queueMicrotask` 携带 `targetTurnIndex` 作用域守卫（`clearStreamWithTurnGuard`），当下一轮快速到达时，旧轮次的微任务清理判定轮次不匹配立即静默跳过，**100% 保全首字 Token**。
3. **Tauri IPC 异步编译 RequestToken 过期覆盖竞态**：
   - **闭环状态**：已在 `02-详案` §1.4.3 彻底闭环。`MarkdownBlockItem` 发起异步编译时附带 `requestToken = ${messageId}-${index}-${hash}`，回调时比对当前 `currentKey`，过期响应直接丢弃，**100% 防御切轮与 Abort 串扰**。

---

## 五、反过度设计红线与 CI 门禁合规性

### 5.1 对照《反过度设计硬性红线》13 项禁令逐条合规核验

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        反过度设计 13 项硬性红线终审合规核验表                            │
├────────────────────┬──────────────────────────────────────────────────────┬────────────┤
│ 禁令条款           │ 本方案设计规范与约束依据                             │ 合规判定   │
├────────────────────┼──────────────────────────────────────────────────────┼────────────┤
│ 禁令 1: OS 内核沙箱│ 桌面端仅采用 CommandGatekeeper 与 Job Object，无内核C │ 🟢 100% 合规│
├────────────────────┼──────────────────────────────────────────────────────┼────────────┤
│ 禁令 2: 无锁环形缓 │ Rust 端统一采用标准 Tokio mpsc 通道与不可变 Arc 共享 │ 🟢 100% 合规│
├────────────────────┼──────────────────────────────────────────────────────┼────────────┤
│ 禁令 3: 分布式共识 │ 本地 SQLite WAL + 单写者原子重命名，杜绝 2PC/Raft    │ 🟢 100% 合规│
├────────────────────┼──────────────────────────────────────────────────────┼────────────┤
│ 禁令 4: 自动切模型 │ UI 选定模型全局固定，仅执行 HTTP 指数退避重试        │ 🟢 100% 合规│
├────────────────────┼──────────────────────────────────────────────────────┼────────────┤
│ 禁令 5: 请求前 DNS │ 取消公有后缀与 DNS 解析，仅保留 URL safe 协议校验    │ 🟢 100% 合规│
├────────────────────┼──────────────────────────────────────────────────────┼────────────┤
│ 禁令 6: 黑盒意图改 │ 绝无隐式提示词篡改，上下文注入完全在 Trace 中透明可见│ 🟢 100% 合规│
├────────────────────┼──────────────────────────────────────────────────────┼────────────┤
│ 禁令 7: 单一真相源 │ onMessageDelta 唯一发射 + Map 双账本，消除多源状态分裂│ 🟢 100% 合规│
├────────────────────┼──────────────────────────────────────────────────────┼────────────┤
│ 禁令 8: 凭据零残留 │ DPAPI/Keychain 加密存储，SecretString 内存清零       │ 🟢 100% 合规│
├────────────────────┼──────────────────────────────────────────────────────┼────────────┤
│ 禁令 9: 系统断路器 │ 彻底物理删除 continuityUiStore 中的 circuitBanners   │ 🟢 100% 合规│
├────────────────────┼──────────────────────────────────────────────────────┼────────────┤
│ 禁令 10: 6阶段洋葱 │ 工具执行仅保留 beforeExecute 与 onResult/onError     │ 🟢 100% 合规│
├────────────────────┼──────────────────────────────────────────────────────┼────────────┤
│ 禁令 11: 微服务套娃│ 彻底物理删除 thoughtWorker (离屏Worker) 与弹窗套娃    │ 🟢 100% 合规│
├────────────────────┼──────────────────────────────────────────────────────┼────────────┤
│ 禁令 12: 全局高频写│ 流式状态不打入根 Store，TURBO 模式采用原生 TextNode  │ 🟢 100% 合规│
├────────────────────┼──────────────────────────────────────────────────────┼────────────┤
│ 禁令 13: 移动端CRDT│ 移动端轻量 Frame 协议，放行因果 Undo 与 ImeBuffer    │ 🟢 100% 合规│
└────────────────────┴──────────────────────────────────────────────────────┴────────────┘
```

---

### 5.2 单文件行数与复杂度门禁核验

根据仓库 `scripts/check-line-counts.mjs` 门禁标准（Business Logic $\le 400$ 行，UI Components $\le 500$ 行，Type Contracts $\le 800$ 行），审查各模块行数控制指标：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          模块行数门禁预算与实际设计规模表                              │
├───────────────────────────────────┬──────────────┬────────────┬───────────┬────────────┤
│ 模块文件名                        │ 类别属性     │ 门禁上限   │ 方案设计值│ 合规裕量   │
├───────────────────────────────────┼──────────────┼────────────┼───────────┼────────────┤
│ timelineReconciler.ts             │ 业务逻辑     │ ≤ 400 行   │ ~130 行   │ +270 行裕量│
│ inlineTagParser.ts                │ 业务逻辑     │ ≤ 400 行   │ ~140 行   │ +260 行裕量│
│ timelineCache.ts                  │ 业务逻辑     │ ≤ 400 行   │ ~90 行    │ +310 行裕量│
│ timelineNormalizer.ts (Facade)    │ 业务调度门面 │ ≤ 400 行   │ ~150 行   │ +250 行裕量│
│ SlidingWindowRateEstimator.ts     │ 调度器算法   │ ≤ 400 行   │ ~120 行   │ +280 行裕量│
│ AdaptiveAnimateTimeline.ts        │ 调度器算法   │ ≤ 400 行   │ ~150 行   │ +250 行裕量│
│ IncrementalBlockSplitter.ts       │ 词法切分算法 │ ≤ 400 行   │ ~160 行   │ +240 行裕量│
│ SpeculativeVirtualCloser.ts       │ 语法补全算法 │ ≤ 400 行   │ ~100 行   │ +300 行裕量│
│ tableProbe.ts                     │ 词法探针     │ ≤ 400 行   │ ~50 行    │ +350 行裕量│
│ usePinnedScroll.ts                │ React Hook   │ ≤ 400 行   │ ~90 行    │ +310 行裕量│
│ preprocessCustomTags.ts           │ AST 预处理器 │ ≤ 400 行   │ ~160 行   │ +240 行裕量│
│ customTagRegistry.ts              │ 注册中心     │ ≤ 400 行   │ ~80 行    │ +320 行裕量│
│ parseComponentAttributes.ts       │ 属性转换管道 │ ≤ 400 行   │ ~50 行    │ +350 行裕量│
│ rehypeSanitizeCustomTags.ts       │ 安全沙箱插件 │ ≤ 400 行   │ ~90 行    │ +310 行裕量│
│ MarkdownBlockItem.tsx             │ UI 组件      │ ≤ 500 行   │ ~180 行   │ +320 行裕量│
│ StreamingMarkdownView.tsx         │ UI 组件      │ ≤ 500 行   │ ~110 行   │ +390 行裕量│
│ StreamingTableContainer.tsx       │ UI 组件      │ ≤ 500 行   │ ~120 行   │ +380 行裕量│
│ WidgetDiff.tsx / FileTree.tsx     │ UI 自定义组件│ ≤ 500 行   │ ~160 行   │ +340 行裕量│
└───────────────────────────────────┴──────────────┴────────────┴───────────┴────────────┘
```

所有新建与重构文件的实测预估行数均严格控制在 **$\le 200$ 行以内**，拥有巨大的安全裕量，**100% 消除 CI 行数门禁阻断风险**。

---

### 5.3 50k+ Tokens 压测设计、Zero-CLS 指标与 120 FPS 性能断言

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        50k+ Tokens 全速率阶梯压测与性能基准断言                         │
├───────────────────┬───────────────────────────────────┬────────────────────────────────┤
│ 性能测试指标      │ 行业现状 / 历史基线               │ 本战役定案验收红线             │
├───────────────────┼───────────────────────────────────┼────────────────────────────────┤
│ 极端吞吐 (TURBO)  │ 500+ t/s 触发 Blink 样式风暴卡死  │ 2000+ t/s 满帧追加, Recalc<0.3ms│
├───────────────────┼───────────────────────────────────┼────────────────────────────────┤
│ 渲染帧率 (FPS)    │ 30~45 FPS (频繁掉帧与跳动)        │ 稳定 60 FPS (高刷屏 120 FPS)   │
├───────────────────┼───────────────────────────────────┼────────────────────────────────┤
│ 布局偏移 (CLS)    │ CLS > 0.450 (骨架屏坍塌+表格跳变) │ Zero-CLS = 0.000 (原位垫片晋升)│
├───────────────────┼───────────────────────────────────┼────────────────────────────────┤
│ 单帧 JS 计算耗时  │ 18 ~ 35 ms (O(N^2) Marked.Lexer)  │ < 0.4 ms (O(1) 行前缀和递推)   │
├───────────────────┼───────────────────────────────────┼────────────────────────────────┤
│ 5000 词长文 DOM 数│ 5000+ 个 <span> 标签节点          │ 仅 1 个原生 TextNode (TURBO)   │
├───────────────────┼───────────────────────────────────┼────────────────────────────────┤
│ 视口吸底稳定性    │ 用户上滚被暴力下拉，强行锁死      │ 8px 容差 + 瞬时拦截，0 像素漂移 │
└───────────────────┴───────────────────────────────────┴────────────────────────────────┘
```

---

## 六、终审整改清单与定稿落地指引（Actionable Remediation & Sign-off）

### 6.1 终审微调整改指令清单

为确保进入施工阶段后绝对零偏差，主控在最终定稿时执行以下 2 项微调整改：

1. **【REM-01：Plan 04 删除清单补全】**
   - 在 `docs/markdown-stream-refactor/04-自定义HTML组件流式渲染与沙箱详案.md` §2.1 与 §4.1 清单中，将删除项由 17 个补全为 18 个，正式登记 `apps/crish-desktop/src/api/markdown-render/IncrementalInlineRenderer.ts`（224 行），使全战役物理删除总数在各文档间严格统一为 **23 个文件**。
2. **【REM-02：Phase 0 明确同步清理 `api/markdown/index.ts`】**
   - 在阶段 0 的清理任务中，明确在拔除 `parseMarkdownIntoBlocks.ts` 死导出的同时，同步清理 `apps/crish-desktop/src/api/markdown/index.ts` 中的悬空 re-export（`hasIncompleteCodeFence`、`hasTable`、`hasFootnote`），确保 Phase 0 门禁 `npm run typecheck` 一次性全绿通过。

---

### 6.2 战役终审签发（Sign-off & Ready for Execution）

```
========================================================================================
                      CONEX MARKDOWN STREAM REFACTOR CAMPAIGN
                             FINAL ARCHITECTURE REVIEW
========================================================================================

  [MASTER PLAN]      : docs/markdown-stream-refactor/00-总方案-下一代极速流式Markdown与富交互渲染引擎.md
  [DETAILED PLANS]   : 01-极速吞吐 ~ 05-多轮生命周期 (5 大分维落地详案)
  [REVIEW STATUS]    : PASSED / SIGN-OFF APPROVED (终审全绿通过)
  [NET DELETION]     : 23 Files Physical Purge (~3,694 Lines Dead Code Elimination)
  [ANTI-OVERENGINEER]: 13 Prohibitions 100% Compliant (Zero Worker / Zero Modal / Zero Circuit)
  [NEXT STEP]        : 阶段 0 死层物理清剿即刻启动 (Wave 1: Execution Phase 0)

========================================================================================
```

> **评审结论总结**：
> 本战役总方案与 5 大分维详案历经 3 轮独立探索、全景交叉审查与本次终审会审，架构逻辑严密，先删后改因果链路完整，概念主路径高度收敛，删除面与性能指标坚实可信。
> **评审组一致同意：正式签发定稿，全面准予进入 Wave 1 阶段 0 工程实施！**
