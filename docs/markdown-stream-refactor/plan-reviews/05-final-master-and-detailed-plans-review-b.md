# 战役终审评审 B：总方案与 5 大分维详案最终交叉审查报告

> **评审标识**：[`docs/markdown-stream-refactor/plan-reviews/05-final-master-and-detailed-plans-review-b.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/plan-reviews/05-final-master-and-detailed-plans-review-b.md)
> **评审角色**：Senior Systems Engineer & Codebase Architect (Final Reviewer B · Architecture Consistency & Master Cross-Audit Lead)
> **审查基准**：
> - 核心总案：[`docs/markdown-stream-refactor/00-总方案-下一代极速流式Markdown与富交互渲染引擎.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/00-%E6%80%BB%E6%96%B9%E6%A1%88-%E4%B8%8B%E4%B8%80%E4%BB%A3%E6%9E%81%E9%80%9F%E6%B5%81%E5%BC%8FMarkdown%E4%B8%8E%E5%AF%8C%E4%BA%A4%E4%BA%92%E6%B8%B2%E6%9F%93%E5%BC%95%E6%93%8E.md)
> - 核心定案：[`docs/markdown-stream-refactor/00-定案-核心维度与删除面决策.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/00-%E5%AE%9A%E6%A1%88-%E6%A0%B8%E5%BF%83%E7%BB%B4%E5%BA%A6%E4%B8%8E%E5%88%A0%E9%99%A4%E9%9D%A2%E5%86%B3%E7%AD%96.md)
> - 5 大分维详案：[`01-极速吞吐与速率自适应调度详案.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/01-%E6%9E%81%E9%80%9F%E5%90%9E%E5%90%90%E4%B8%8E%E9%80%9F%E7%8E%87%E8%87%AA%E9%80%82%E5%BA%94%E8%B0%83%E5%BA%A6%E8%AF%A6%E6%A1%88.md)、[`02-渐进词法分块与无缝双缓冲晋升详案.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/02-%E6%B8%90%E8%BF%9B%E8%AF%8D%E6%B3%95%E5%88%86%E5%9D%97%E4%B8%8E%E6%97%A0%E7%BC%9D%E5%8F%8C%E7%BC%93%E5%86%B2%E6%99%8B%E5%8D%87%E8%AF%A6%E6%A1%88.md)、[`03-流式表格排版与视口锚定稳定详案.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/03-%E6%B5%81%E5%BC%8F%E8%A1%A8%E6%A0%BC%E6%8E%92%E7%89%88%E4%B8%8E%E8%A7%86%E5%8F%A3%E9%94%9A%E5%AE%9A%E7%A8%B3%E5%AE%9A%E8%AF%A6%E6%A1%88.md)、[`04-自定义HTML组件流式渲染与沙箱详案.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/04-%E8%87%AA%E5%AE%9A%E4%B9%89HTML%E7%BB%84%E4%BB%B6%E6%B5%81%E5%BC%8F%E6%B8%B2%E6%9F%93%E4%B8%8E%E6%B2%99%E7%AE%B1%E8%AF%A6%E6%A1%88.md)、[`05-多轮生命周期单源收敛与时间线幂等详案.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/05-%E5%A4%9A%E8%BD%AE%E7%94%9F%E5%91%BD%E5%91%A8%E6%9C%9F%E5%8D%95%E6%BA%90%E6%94%B6%E6%95%9B%E4%B8%8E%E6%97%B6%E9%97%B4%E7%BA%BF%E5%B9%82%E7%AD%89%E8%AF%A6%E6%A1%88.md)
> - 纪律与规范：[`docs/agent-roles/prompts/主控-全流程调度-v3.md`](file:///c:/Software/conex/docs/agent-roles/prompts/%E4%B8%BB%E6%8E%A7-%E5%85%A8%E6%B5%81%E7%A8%8B%E8%B0%83%E5%BA%A6-v3.md) §二.5、[`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)（13 项硬性红线）
> **审查宗旨**：**以最高标准执行定稿前终审裁决**。全面核验总方案与 5 大分维详案的契约一致性、删除面清单（23 个孤岛文件）对齐度、文件域互斥性、先删后改 DAG 拓扑闭环及反过度设计红线，确保方案进入实施阶段时 0 概念冲突、0 依赖死锁、0 悬空死层。

---

## 目录

- [一、终审评审摘要与全景结论矩阵](#一终审评审摘要与全景结论矩阵)
- [二、审查重点一：00 总方案与 01~05 分维详案一致性深度核验](#二审查重点一00-总方案与-0105-分维详案一致性深度核验)
  - [2.1 五大领域概念与唯一主路径对齐审查](#21-五大领域概念与唯一主路径对齐审查)
  - [2.2 模块命名、核心接口与数据模型契约一致性](#22-模块命名核心接口与数据模型契约一致性)
  - [2.3 【强制核验】全战役 23 个待物理删除孤岛文件全网对账](#23-强制核验全战役-23-个待物理删除孤岛文件全网对账)
  - [2.4 符号级死代码与反模式清理清单一致性](#24-符号级死代码与反模式清理清单一致性)
- [三、审查重点二：跨维度文件域互斥性与共享协作边界核查](#三审查重点二跨维度文件域互斥性与共享协作边界核查)
  - [3.1 五大维度独占文件域矩阵（Exclusive Manifests）](#31-五大维度独占文件域矩阵exclusive-manifests)
  - [3.2 共享协作文件装配时序与职责边界解耦](#32-共享协作文件装配时序与职责边界解耦)
  - [3.3 目录规范归一化建议（`api/markdown` 体系收敛）](#33-目录规范归一化建议apimarkdown-体系收敛)
- [四、审查重点三：先删后改 DAG 依赖闭环与无死锁时序审查](#四审查重点三先删后改-dag-依赖闭环与无死锁时序审查)
  - [4.1 全战役 5 阶段强门禁 DAG 拓扑全景](#41-全战役-5-阶段强门禁-dag-拓扑全景)
  - [4.2 Phase 0 强阻断门禁与先删后改执行保障](#42-phase-0-强阻断门禁与先删后改执行保障)
  - [4.3 Phase 1 & Phase 2 双轨无锁并行与 IPC 契约解耦](#43-phase-1--phase-2-双轨无锁并行与-ipc-契约解耦)
  - [4.4 Phase 3 底座晋升与 Phase 4 三维装配时序](#44-phase-3-底座晋升与-phase-4-三维装配时序)
- [五、审查重点四：反过度设计 13 项禁令与 CI 门禁红线全量审查](#五审查重点四反过度设计-13-项禁令与-ci-门禁红线全量审查)
  - [5.1 对照《反过度设计硬性红线》13 项禁令逐条合规核验](#51-对照反过度设计硬性红线13-项禁令逐条合规核验)
  - [5.2 变相过度设计防复活审查（弹窗、Worker、断路器与逆向解析器）](#52-变相过度设计防复活审查弹窗worker断路器与逆向解析器)
  - [5.3 单文件行数限制（$\le 300$ 行）与超标文件拆分合规性](#53-单文件行数限制le-300-行与超标文件拆分合规性)
  - [5.4 50k+ Tokens 阶梯压测与 120 FPS / Zero-CLS 门禁指标](#54-50k-tokens-阶梯压测与-120-fps--zero-cls-门禁指标)
- [六、终审评审 B 结论与主控定稿指令](#六终审评审-b-结论与主控定稿指令)

---

## 一、终审评审摘要与全景结论矩阵

按照《主控全流程调度 v3》§二.5 规范，评审组以**“架构一致性、死层删除面对账、文件域互斥性、DAG 依赖闭环与反过度设计红线”**为五大核心基准，对《00-总方案》与《01》~《05》全部 5 份分维实施详案展开了最终定稿前交叉审查。

### 1.1 审查结论全景矩阵

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 Conex 下一代流式 Markdown 终审评审 B 审查结论全景矩阵                                  │
├─────────────────┬──────────────────────────────────────────┬──────────┬────────────────────────────────────────┤
│ 审查维度        │ 核心审查对象                             │ 评审结论 │ 关键发现与裁决说明                     │
├─────────────────┼──────────────────────────────────────────┼──────────┼────────────────────────────────────────┤
│ 1. 总详案一致性 │ • 5 大概念主路径与 ADR 架构决策          │ 🟢 优秀  │ 00 总方案与 01~05 详案核心契约 100% 吻合│
│                 │ • 模块命名、类型定义与对外接口           │ 🟢 优秀  │ 命名统一收敛（如 4 个拆分子模块完全一致）│
│                 │ • 23 个待物理删除孤岛文件清单            │ 🟡 微调  │ 00 总案精确无误；04 详案需补全 1 处漏记 │
├─────────────────┼──────────────────────────────────────────┼──────────┼────────────────────────────────────────┤
│ 2. 文件域互斥性 │ • 5 大维度独占文件清单 (Exclusive)       │ 🟢 优秀  │ 独占文件 100% 互不重叠，无并发写冲突   │
│                 │ • 协作装配文件 (MarkdownBlockItem 等)    │ 🟢 优秀  │ 阶段 3 筑基、阶段 4 分支装配，时序解耦  │
│                 │ • 目录命名体系规范 (`api/markdown`)      │ 🟡 建议  │ 建议将 04 详案统一至 `api/markdown/`    │
├─────────────────┼──────────────────────────────────────────┼──────────┼────────────────────────────────────────┤
│ 3. 先删后改 DAG │ • Phase 0 强阻断物理删除门禁             │ 🟢 优秀  │ 严格执行先删后改，门禁通过后方可准入   │
│                 │ • Phase 1/2 双轨并行与 Phase 3/4 依赖    │ 🟢 优秀  │ 拓扑结构清晰，不存在任何循环等待与死锁 │
├─────────────────┼──────────────────────────────────────────┼──────────┼────────────────────────────────────────┤
│ 4. 反过度设计   │ • 对照 13 项硬性红线逐条核验             │ 🟢 优秀  │ 13 项禁令 100% 遵守，0 违规抽象引入    │
│    与 CI 门禁   │ • 单文件行数限制 ($\le 300$ 行)          │ 🟢 优秀  │ 616 行巨石文件彻底拆解为 4 个 $\le 180$ 行│
│                 │ • 50k Tokens 压测与 120 FPS / Zero-CLS   │ 🟢 优秀  │ 指标严苛量化，配备详尽测试断言蓝图     │
└─────────────────┴───────────────────────────────┴──────────┴────────────────────────────────────────┘
```

> **终审总体裁决**：**全票通过（APPROVED WITH MINOR HARMONIZATION）**。
> 《00-总方案》与《01》~《05》分维详案逻辑严密、架构清晰、工程度极高，彻底根治了正文伪流式退化、多轮大段文字重复、骨架屏跳变与思维链弹窗过度设计四大历史顽疾。仅需在实施阶段对 2 处极微小文本口径与目录规范进行统一步调即可无缝开工。

---

## 二、审查重点一：00 总方案与 01~05 分维详案一致性深度核验

### 2.1 五大领域概念与唯一主路径对齐审查

审查组逐一比对了《00-总方案》§一 与 01~05 各分维详案的“概念收敛矩阵”与“唯一主路径”，确认其在架构哲学与实现细节上达到 **100% 精确吻合**：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   总方案 vs 分维详案 领域收敛与主路径比对矩阵                                    │
├─────────────────────┬─────────────────────────────────────┬─────────────────────────────────────┬────────┤
│ 领域概念 (Domain)   │ 《00-总方案》收敛主路径             │ 分维详案 (01~05) 对应设计规格       │ 判定   │
├─────────────────────┼─────────────────────────────────────┼─────────────────────────────────────┼────────┤
│ 1. 速率自适应与调度 │ • SlidingWindowRateEstimator (SW-TRE│ • 01 详案 §2.1: 500ms 滑窗+非对称EMA│ 🟢 对齐│
│                     │ • AdaptiveAnimateTimeline (GPU CSS) │ • 01 详案 §2.2: B=320ms, Smin=4ms   │        │
│                     │ • TURBO 宏块零 Span 硬件加速        │ • 01 详案 §2.3: ≥300t/s 原生追加    │        │
├─────────────────────┼─────────────────────────────────────┼─────────────────────────────────────┼────────┤
│ 2. 词法分块与双缓冲 │ • IncrementalBlockSplitter O(1) 前缀│ • 02 详案 §1.1: 行前缀和递推+DFA状态│ 🟢 对齐│
│                     │ • SpeculativeVirtualCloser 投机补全 │ • 02 详案 §1.2: 纯内存虚拟语法补全  │        │
│                     │ • 原地纯文本垫片双缓冲晋升 (Zero-CLS│ • 02 详案 §1.4: 彻底销毁骨架屏      │        │
├─────────────────────┼─────────────────────────────────────┼─────────────────────────────────────┼────────┤
│ 3. 流式表格与视口   │ • 表格 DFA 状态机虚拟前瞻锁定       │ • 03 详案 §1.1: 首行字符即锁定 Table│ 🟢 对齐│
│                     │ • hasTable 抑制 Caret + 脉冲边框    │ • 03 详案 §1.2: 匿名盒保护+单元格脉冲│ 🟢 对齐│
│                     │ • usePinnedScroll 8px 容差双向吸底  │ • 03 详案 §1.3: 物理输入 Capture 拦截│        │
├─────────────────────┼─────────────────────────────────────┼─────────────────────────────────────┼────────┤
│ 4. 自定义 HTML 沙箱 │ • preprocessCustomTags 空行三明治   │ • 04 详案 §1.2: 代码栅栏保护+<!---->│ 🟢 对齐│
│                     │ • normalizeUnclosedOpenTags 即时呈现 │ • 04 详案 §1.3: 换行注入\n\n激活渲染 │ 🟢 对齐│
│                     │ • React Portal + 4 层 XSS 防御沙箱  │ • 04 详案 §1.5: 标签/属性/协议/边界 │        │
├─────────────────────┼─────────────────────────────────────┼─────────────────────────────────────┼────────┤
│ 5. 生命周期与幂等   │ • onMessageDelta 唯一增量生产者     │ • 05 详案 §1.1: callbacks.onChunk单源│ 🟢 对齐│
│                     │ • Map 双账本 (Streamed/Authoritative│ • 05 详案 §1.2: 废除稀疏数组越界    │ 🟢 对齐│
│                     │ • (turnIndex, type, id) 三元 Reconcile│ • 05 详案 §1.3: 历史孤岛 100% 保全  │        │
│                     │ • timelineNormalizer 拆分 4 子模块   │ • 05 详案 §2.4: 拆分为 4 个 ≤180 行 │        │
└─────────────────────┴─────────────────────────────────────┴─────────────────────────────────────┴────────┘
```

---

### 2.2 模块命名、核心接口与数据模型契约一致性

审查组对跨方案共享的关键类型、函数签名与拆分子模块进行了代码级交叉比对：

1. **`timelineNormalizer.ts` 拆分子模块命名全网一致性**：
   - 00 总方案 §一.5、§二.4、§三；
   - 05 详案 §2.4、§4、§5.2；
   - 命名完全锁定为：
     1. [`timelineReconciler.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/tool-presentation/timelineReconciler.ts)（三元槽位无损保全、工具块对齐、`sanitizeTurnIndex`）
     2. [`inlineTagParser.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/tool-presentation/inlineTagParser.ts)（Markdown 栅栏免疫扫描、内联思考标签安全分拣）
     3. [`timelineCache.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/tool-presentation/timelineCache.ts)（流式 0 重排签名计算与 `buildAssistantTimelineCached`）
     4. [`timelineNormalizer.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/tool-presentation/timelineNormalizer.ts)（门面调度入口、双向重水合、向后兼容导出）
   - **核验结论**：彻底消除了早期草案中 `timelineBlockReconcile.ts` 等命名分歧，实现 100% 统一。

2. **渲染组件与 Props 接口契约一致性**：
   - 全链路统一采用 `StreamingMarkdownView` 作为协调入口，`MarkdownBlockItem` 作为叶子容器；
   - 统一将废弃的 `text?: string` 属性收敛为标准的 `content: string`；
   - Block Key 格式在 00 总方案、02 详案与 05 详案中严格统一定义为：
     - 封口固化块：`${msgId}-blk-${index}-${fastContentHash(text)}`
     - 末尾活动块：`${msgId}-blk-${tailIndex}-active`

3. **双账本模型数据契约一致性**：
   - 00 总方案与 05 详案统一将 `StreamState` 中的稀疏数组废除，替换为：
     - `turnStreamedTexts: Map<number, string>`
     - `turnAuthoritativeTexts: Map<number, string>`
     - `activeTurnIndex: number`

---

### 2.3 【强制核验】全战役 23 个待物理删除孤岛文件全网对账

按照《主控调度 v3》与《核心维度与删除面决策》，战役必须在阶段 0 执行“彻底物理清算”，净删除 23 个孤岛死文件。审查组对代码仓库现场文件、00 总方案与 01~05 各分维详案进行了**逐文件全网穿透对账**：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 全战役 23 个待物理删除文件全网穿透对账大表                                             │
├────┬──────────────────────────────────────────────────────────────────────────────────────┬──────┬─────┬────┬────┬────┤
│ 序 │ 待物理删除文件相对路径                                                               │ 仓内 │ 00  │ 01 │ 02 │ 04 │
│    │ (`apps/crish-desktop/src/...`)                                                       │ 存在 │ 总案│详案│详案│详案│
├────┼──────────────────────────────────────────────────────────────────────────────────────┼──────┼─────┼────┼────┼────┤
│ 1  │ `components/chat-message-row/FullThoughtModal.tsx`                                   │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 2  │ `components/chat-message-row/FullThoughtModal.module.css`                            │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 3  │ `components/chat-message-row/FullThoughtModal.test.tsx`                              │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 4  │ `components/chat-message-row/ThoughtOutline.tsx`                                     │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 5  │ `components/chat-message-row/ThoughtOutline.module.css`                             │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 6  │ `components/chat-message-row/ThoughtSearchBar.tsx`                                   │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 7  │ `components/chat-message-row/ThoughtSearchBar.module.css`                           │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 8  │ `workers/thoughtWorker.ts`                                                           │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 9  │ `workers/thoughtWorker.test.ts`                                                      │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 10 │ `store/thoughtInspectorStore.ts`                                                     │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 11 │ `store/thoughtInspectorStore.test.ts`                                                │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 12 │ `components/chat-message-row/StreamingTextBlock.tsx`                                 │  ✅  │ ✅  │ ✅ │ -  │ -  │
│ 13 │ `components/chat-message-row/StreamingTextBlock.test.tsx`                            │  ✅  │ ✅  │ ✅ │ -  │ -  │
│ 14 │ `components/chat-message-row/AsyncMarkdownBlock.tsx`                                 │  ✅  │ ✅  │ -  │ ✅ │ -  │
│ 15 │ `components/chat-message-row/AsyncMarkdownBlock.module.css`                         │  ✅  │ ✅  │ -  │ ✅ │ -  │
│ 16 │ `components/chat-message-row/AsyncMarkdownBlock.test.tsx`                            │  ✅  │ ✅  │ -  │ ✅ │ -  │
│ 17 │ `api/markdown-render/IncrementalMarkdownParser.ts`                                   │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 18 │ `api/markdown-render/IncrementalMarkdownParserRender.ts`                             │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 19 │ `api/markdown-render/IncrementalMarkdownParserTypes.ts`                              │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 20 │ `api/markdown-render/IncrementalInlineRenderer.ts`                                  │  ✅  │ ✅  │ -  │ -  │ ⚠️  │
│ 21 │ `api/markdown-render/IncrementalMarkdownParser.test.ts`                              │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 22 │ `api/markdown-render/IncrementalMarkdownParser.parity.test.ts`                       │  ✅  │ ✅  │ -  │ -  │ ✅ │
│ 23 │ `api/markdown-render/IncrementalMarkdownParser.adversarial.test.ts`                  │  ✅  │ ✅  │ -  │ -  │ ✅ │
└────┴──────────────────────────────────────────────────────────────────────────────────────┴──────┴─────┴────┴────┴────┘
```

> [!NOTE]
> **关于序号 20 `IncrementalInlineRenderer.ts` 的审查发现与微调指示**：
> 1. **代码事实**：经调用工具扫描代码仓库，`apps/crish-desktop/src/api/markdown-render/IncrementalInlineRenderer.ts` 真实存在（11,681 字节，224 行），属于历史手写 Markdown 解析器的一部分；
> 2. **总方案对照**：《00-总方案》第 68 行准确包含了该文件（序号 20），总删除清单为 **23 个文件**，100% 准确；
> 3. **分维详案 04 微调指示**：详案 04 在 §2.1 大表中仅列出 17 个文件，偶然遗漏了该文件的单行记录。在阶段 0 执行删除时，统一以《00-总方案》锁定的 **23 个物理删除清单**为唯一准则，确保 `IncrementalInlineRenderer.ts` 随同其他 6 个历史手写解析器文件一并 `git rm` 销毁，绝不留死层孤岛。

---

### 2.4 符号级死代码与反模式清理清单一致性

审查组核验了各方案关于符号级死代码与反模式的清理规约，确认以下 4 项在总案与分案中均已精确对齐：

1. **`parseMarkdownIntoBlocks.ts`**：
   - 彻底删除 `hasFootnote` 粗暴退化单块的自杀式熔断逻辑（00 总案 §二、02 详案 §2.2）；
   - 彻底删除未被生产管道调用的死导出 `hasIncompleteCodeFence` 与 `hasTable`（00 总案 §二、02 详案 §2.2、03 详案 §2.1）；
   - 清除 `openTagPatternCache` / `closeTagPatternCache` 静态无界 Map 正则缓存，杜绝内存泄漏（02 详案 §2.2）。
2. **`continuityUiStore.ts`**：
   - 彻底删除违反禁令 9 的 `circuitBanners` 熔断状态与方法，并在单测中清除对应的 `setState` hack（00 总案 §二、05 详案 §2.3）。
3. **`sessionMessageActionsTools.ts`**：
   - 彻底删除第 205-208 行外层二次冗余的 `reconcileAssistantMessageBlocks` 调用（00 总案 §二、05 详案 §2.2）。
4. **`useStreamBatchers.ts`**：
   - 彻底删除未使用的 `renderBufferRef` 死引用与死接口（00 总案 §二、01 详案 §3.2）。

---

## 三、审查重点二：跨维度文件域互斥性与共享协作边界核查

### 3.1 五大维度独占文件域矩阵（Exclusive Manifests）

为保证多 Agent 在实施阶段并行开发时 **0 Git 写冲突**，审查组对 5 大维度的独占文件域进行了严格排他性校验：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 五大维度独占文件域矩阵 (100% 互斥与无重叠清单)                                        │
├──────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 维度编号 │ 独占新增 / 修改 / 删除文件清单 (Exclusive Files)                                                         │
├──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ **维度一**│ • `api/markdown/SlidingWindowRateEstimator.ts` & `.test.ts` (新增)                                       │
│          │ • `api/markdown/AdaptiveAnimateTimeline.ts` & `.test.ts` (新增)                                          │
│          │ • `api/markdown/streaming-animation.css` (新增)                                                          │
│          │ • `components/chat-message-row/StreamingMarkdownView.rateAdaptive.test.tsx` (新增)                        │
│          │ • `hooks/chat-stream/useStreamBatchers.ts` (独占修改: 拔除 renderBufferRef)                              │
│          │ • `api/StreamRenderBuffer.ts` (独占修改: 清除 html/chunkUpdates 死字段)                                  │
│          │ • `components/chat-message-row/StreamingTextBlock.tsx` & `.test.tsx` (独占物理删除)                      │
├──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ **维度二**│ • `api/markdown/IncrementalBlockSplitter.ts` & `.test.ts` (新增)                                         │
│          │ • `api/markdown/SpeculativeVirtualCloser.ts` & `.test.ts` (新增)                                         │
│          │ • `components/chat-message-row/MarkdownBlockItem.test.tsx` (新增)                                        │
│          │ • `components/chat-message-row/useStreamingBlocks.ts` & `.test.ts` (独占修改/新增)                         │
│          │ • `api/markdown/parseMarkdownIntoBlocks.ts` & `.test.ts` (独占修改: 拔除 hasFootnote/死导出)              │
│          │ • `components/chat-message-row/AsyncMarkdownBlock.tsx` & `.module.css` & `.test.tsx` (独占物理删除)      │
├──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ **维度三**│ • `api/markdown/tableProbe.ts` (新增: hasTableBlock 探针)                                                │
│          │ • `components/chat-message-row/usePinnedScroll.ts` (新增: 8px 容差吸底 Hook)                             │
│          │ • `components/chat-message-row/StreamingTableContainer.tsx` (新增: 局部视口容器)                         │
│          │ • `components/chat-message-row/StreamingTable.test.tsx` (新增)                                           │
├──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ **维度四**│ • `api/markdown/preprocessCustomTags.ts` & `.test.ts` (新增)                                             │
│          │ • `api/markdown/customTagRegistry.ts` (新增)                                                             │
│          │ • `api/markdown/parseComponentAttributes.ts` (新增)                                                      │
│          │ • `api/markdown/rehypeSanitizeCustomTags.ts` & `.test.ts` (新增)                                          │
│          │ • `components/chat-message-row/custom-tags/*` (全部 7 个富交互组件、Portal 与错误边界)                     │
│          │ • `components/chat-message-row/TimelineThoughtSection.tsx` (独占修改: 拔除放大按钮与字数)                │
│          │ • `store/thoughtInspectorStore.*`、`workers/thoughtWorker.*` 等 18 个孤岛文件 (独占物理删除)             │
│          │ • `store/index.ts`、`store/storeAccess.ts`、`workers/index.ts` (独占修改: 清理废弃导出)                  │
├──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ **维度五**│ • `api/tool-presentation/timelineReconciler.ts` (新增)                                                   │
│          │ • `api/tool-presentation/inlineTagParser.ts` (新增)                                                      │
│          │ • `api/tool-presentation/timelineCache.ts` (新增)                                                         │
│          │ • `api/tool-presentation/timelineNormalizer.ts` & `.test.ts` (独占重构瘦身)                              │
│          │ • `api/chat-bridge/handlers/streamState.ts` (独占修改: Map 双账本)                                       │
│          │ • `api/chat-bridge/handlers/messageHandlers.ts` (独占修改: 彻底拔除 prevLen 切片伪增量)                  │
│          │ • `store/sessionMessageActionsTools.ts` (独占修改: 拔除二次 reconcile)                                   │
│          │ • `store/sessionMessageActionsCore.ts` (独占修改: 保护 thought 块)                                       │
│          │ • `api/continuity/continuityUiStore.ts` & `.test.ts` (独占修改: 彻底物理清除 circuitBanners)             │
│          │ • `components/chat-message/MessageContent.tsx` (独占修改: ErrorMessageBanner 兜底)                       │
│          │ • `hooks/chat-stream/helpers.ts` (独占修改: commitStreamToSession 增加 turnGuard)                        │
└──────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 3.2 共享协作文件装配时序与职责边界解耦

在 5 大维度的实施过程中，仅有 3 个顶层叶子组件/样式表存在跨维度协作装配诉求。审查组核实其在先删后改 DAG 中的执行时序，确认**完全实现了生命周期解耦**：

```mermaid
flowchart TD
    classDef base fill:#dbeafe,stroke:#3b82f6,stroke-width:2px;
    classDef feat fill:#fef3c7,stroke:#eab308,stroke-width:2px;
    classDef style fill:#f3e8ff,stroke:#9333ea,stroke-width:2px;

    subgraph Phase3Build ["【阶段 3：底座构建】(维度二主导)"]
        B1["MarkdownBlockItem.tsx (基础双缓冲垫片容器)"]:::base
        B2["StreamingMarkdownView.tsx (统一 content 接口与分块挂载)"]:::base
        B3["ChatMessageRow.module.css (拔除 .skeletonLine 骨架屏样式)"]:::style
    end

    subgraph Phase4Assemble ["【阶段 4：三维装配】(维度一/三/四并行注入独立分支)"]
        F1["维度一: 注入 GPU CSS 变量与 TURBO 原生追加分支"]:::feat
        F2["维度三: 注入 hasTableBlock 探针与 suppressCaret 样式"]:::feat
        F3["维度四: 注入 preprocessCustomTags 预处理与 CustomTag 路由"]:::feat
    end

    B1 --> F1
    B1 --> F2
    B2 --> F3
    B3 --> F1
    B3 --> F2
```

1. **`MarkdownBlockItem.tsx` 协作规约**：
   - **阶段 3（维度二）**：负责创建标准双缓冲容器骨架（`isSealed` 状态切换、`useLayoutEffect` 文本垫片锁定高度、Rust 异步编译返回原子替换）；
   - **阶段 4（维度一 & 维度三）**：维度一接入 `tier === 'TURBO'` 零 Span 原生追加逻辑与 GPU CSS 变量；维度三接入 `hasTableBlock` 探针联动以激活 `suppressCaret`。两者属于独立的 `props` 分支与 CSS 类切换，逻辑完全正交。
2. **`StreamingMarkdownView.tsx` 协作规约**：
   - **阶段 3（维度二）**：统一接口为 `content: string`，挂载 `useStreamingBlocks` 与语义哈希 Key；
   - **阶段 4（维度一 & 维度四）**：维度一挂载 `AdaptiveAnimateTimeline` 挂钟时间轴生命周期；维度四在分块前接入 `preprocessCustomTags` 预处理。管线流转清晰：`content -> preprocessCustomTags -> useStreamingBlocks -> MarkdownBlockItem(Timeline)`。
3. **`ChatMessageRow.module.css` 协作规约**：
   - **阶段 0 & 阶段 3（维度二 & 维度四）**：阶段 0 物理拔除 `.skeletonLine`、`@keyframes skeletonPulse` 以及思维链弹窗关联样式；
   - **阶段 4（维度一 & 维度三）**：维度三追加 `table-layout: fixed`、`contain: layout paint` 与单元格呼吸边框；维度一追加 GPU 硬件加速类。无 CSS 选择器冲突。

---

### 3.3 目录规范归一化建议（`api/markdown` 体系收敛）

- **现状事实**：当前仓库中历史代码分散在 `api/markdown/`（`parseMarkdownIntoBlocks.ts`）与 `api/markdown-render/`（历史手写解析器 `IncrementalMarkdownParser*`）两个目录中；
- **审查建议**：随着阶段 0 彻底物理删除 `api/markdown-render/` 目录下的全部历史手写解析器文件，**建议维度四的新增文件（`preprocessCustomTags.ts`、`customTagRegistry.ts`、`parseComponentAttributes.ts`、`rehypeSanitizeCustomTags.ts`）统一放置在 `apps/crish-desktop/src/api/markdown/` 目录下**。这样可将所有 Markdown 相关的底层算法与插件收敛于单一目录 `api/markdown/`，彻底废除 `api/markdown-render/` 目录，消除多目录并存的割裂感。

---

## 四、审查重点三：先删后改 DAG 依赖闭环与无死锁时序审查

### 4.1 全战役 5 阶段强门禁 DAG 拓扑全景

审查组绘制并核实了全战役从阶段 0 到阶段 5 的完整执行 DAG，确认各阶段具备强准入门禁，全图无环无死锁：

```mermaid
flowchart TD
    classDef gate fill:#fee2e2,stroke:#ef4444,stroke-width:2px;
    classDef track fill:#dbeafe,stroke:#3b82f6,stroke-width:2px;
    classDef core fill:#e0e7ff,stroke:#6366f1,stroke-width:2px;
    classDef feat fill:#fef3c7,stroke:#eab308,stroke-width:2px;
    classDef verify fill:#dcfce7,stroke:#10b981,stroke-width:2px;

    subgraph Phase0 ["【阶段 0：死层物理清剿与规范瘦身】(强串行门禁 · 先删后改)"]
        P0_1["1. git rm 物理删除 23 个孤岛废弃文件 (消除 3,694 行死代码)"]:::gate
        P0_2["2. 清除 store / workers / storeAccess 废弃 re-export 导出"]:::gate
        P0_3["3. 拆分 timelineNormalizer.ts 为 4 个 <=180 行子模块"]:::gate
        P0_4["4. 彻底物理拔除 circuitBanners 熔断器与 parseMarkdown 死函数"]:::gate
        P0_1 --> P0_2 --> P0_3 --> P0_4
    end

    Gate0{"【门禁 0 校验】<br/>npm run typecheck (0 错误)<br/>npm run check:line-counts (全绿)"}:::gate

    subgraph Phase12 ["【阶段 1 & 阶段 2：双轨无锁并行推进】"]
        subgraph TrackA ["Track A: Rust 内核流式分流 (维度一/五)"]
            T_A1["StreamingTagExtractor 标签零逃逸分流"]:::track
            T_A2["stream.rs 纯思考流判空与 Abort 抢救"]:::track
            T_A1 --> T_A2
        end

        subgraph TrackB ["Track B: TS Bridge 与生命周期幂等 (维度五)"]
            T_B1["streamState.ts 引入 Map 双账本 (Streamed/Authoritative)"]:::track
            T_B2["messageHandlers.ts 彻底拔除 prevLen 切片伪增量"]:::track
            T_B3["onMessageDelta 单生产者 + onMessageEnd 权威收口"]:::track
            T_B4["sessionMessageActions 剔除二次 reconcile 与锁定 thought"]:::track
            T_B1 --> T_B2 --> T_B3 --> T_B4
        end
    end

    Gate1{"【门禁 1 校验】<br/>cargo test --workspace (100% Pass)<br/>messageHandlers.idempotent.test.ts (100% Pass)"}:::gate

    subgraph Phase3 ["【阶段 3：增量分块与双缓冲无缝晋升底座】(维度二)"]
        P3_1["1. IncrementalBlockSplitter O(1) 行前缀和增量切分器"]:::core
        P3_2["2. SpeculativeVirtualCloser 纯内存投机语法虚拟补全器"]:::core
        P3_3["3. MarkdownBlockItem 原地纯文本垫片锁定高度 (Zero-CLS)"]:::core
        P3_4["4. 迁移 InlineAgentPanel 调用端并物理删除 AsyncMarkdownBlock.*"]:::core
        P3_1 --> P3_2 --> P3_3 --> P3_4
    end

    Gate2{"【门禁 2 校验】<br/>IncrementalBlockSplitter / Closer 单测 100% Pass<br/>MarkdownBlockItem 零骨架屏断言通过"}:::gate

    subgraph Phase4 ["【阶段 4：三维特性协同装配】(维度一、三、四)"]
        subgraph P4_Dim1 ["维度一: 速率自适应与调度"]
            D1_1["SW-TRE 滑动窗口估计器"]:::feat
            D1_2["AdaptiveAnimateTimeline (GPU CSS)"]:::feat
            D1_3["TURBO 宏块零 Span 原生追加"]:::feat
            D1_1 --> D1_2 --> D1_3
        end

        subgraph P4_Dim3 ["维度三: 流式表格与视口稳定"]
            D3_1["tableProbe.ts & 表格 DFA 补全"]:::feat
            D3_2["hasTable Caret 抑制 + 脉冲边框"]:::feat
            D3_3["usePinnedScroll 8px 容差吸底"]:::feat
            D3_1 --> D3_2 --> D3_3
        end

        subgraph P4_Dim4 ["维度四: HTML 组件与沙箱"]
            D4_1["preprocessCustomTags 预处理"]:::feat
            D4_2["normalizeUnclosedOpenTags 即时呈现"]:::feat
            D4_3["4 层 XSS 防御沙箱 + React Portal"]:::feat
            D4_1 --> D4_2 --> D4_3
        end
    end

    Gate3{"【门禁 3 校验】<br/>5~2000 t/s 阶梯压测<br/>大表格列宽防抖 & 沙箱 XSS 拦截单测全绿"}:::gate

    subgraph Phase5 ["【阶段 5：全链路集成压测与交付总验收】"]
        P5_1["1. cargo test --workspace (Rust 全量 100% 通过)"]:::verify
        P5_2["2. npm run typecheck + npm test (前端全量 100% 通过)"]:::verify
        P5_3["3. 50k+ Tokens 满帧压测 (≥59.5 FPS, CLS = 0.000, 内存降低 98.5%)"]:::verify
        P5_4["4. Tauri MCP 真机 UI 视觉实机断言 (桌面端无跳变、零重复)"]:::verify
        P5_1 --> P5_2 --> P5_3 --> P5_4
    end

    Phase0 --> Gate0
    Gate0 --> Phase12
    TrackA --> Gate1
    TrackB --> Gate1
    Gate1 --> Phase3
    Phase3 --> Gate2
    Gate2 --> Phase4
    P4_Dim1 --> Gate3
    P4_Dim3 --> Gate3
    P4_Dim4 --> Gate3
    Gate3 --> Phase5
```

---

### 4.2 Phase 0 强阻断门禁与先删后改执行保障

- **铁律要求**：在编写任何新增算法代码前，必须先物理删除 23 个孤岛死文件、清除悬空导出并拆分超标文件；
- **死锁防护**：由于 Phase 0 的所有动作均为纯删除与纯代码结构迁移，不引入任何外部依赖，执行完毕后立即运行 `npm run typecheck` 与 `npm run check:line-counts`。门禁绿灯后方可准入 Phase 1/2。

### 4.3 Phase 1 & Phase 2 双轨无锁并行与 IPC 契约解耦

- **并行安全性**：
  - **Track A（Rust 内核）**：在 `crates/conex-core/` 内部重构 `StreamingTagExtractor` 与 `stream.rs`，产出标准的 IPC 事件流（`ThoughtDelta`、`message-delta`）；
  - **Track B（TS Bridge & Store）**：在 `apps/crish-desktop/src/api/chat-bridge/` 中重构 `messageHandlers.ts` 与 `streamState.ts`，基于冻结的 IPC 契约实现单生产者与 Map 双账本。
- **无锁保证**：两轨分别位于 Rust 与 TypeScript 代码域，文件域 100% 物理隔离，由标准 IPC JSON 协议对接，不存在任何互相等待与并发冲突。

### 4.4 Phase 3 底座晋升与 Phase 4 三维装配时序

- **时序依赖关系**：
  - Phase 3 必须优先完成 `IncrementalBlockSplitter` 与 `MarkdownBlockItem` 基础双缓冲垫片容器的构建；
  - Phase 4 的速率自适应（Dim 1）、流式表格（Dim 3）与 HTML 沙箱（Dim 4）均直接装配在 Phase 3 的底座组件之上；
  - 这种“底座先行、特性并装”的分层依赖，确保了各特性开发者面对的是同一个稳定且经过测试的 DOM 容器，杜绝了多套组件派生与 DOM 撕裂。

---

## 五、审查重点四：反过度设计 13 项禁令与 CI 门禁红线全量审查

### 5.1 对照《反过度设计硬性红线》13 项禁令逐条合规核验

审查组对照 [`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md) 中的 13 项硬性禁令，对《00-总方案》与 01~05 详案进行了逐条严格审查：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              反过度设计硬性红线 (Anti-Overengineering) 13 项禁令全量审查表                              │
├────┬──────────────────────────────────┬──────────────────────────────────────────────────────────────┬────────┬────────┤
│ 禁 │ 红线禁令名称                     │ 00 总方案与 01~05 分维详案合规落地依据                       │ 违规数 │ 判定   │
├────┼──────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────┼────────┤
│ 1  │ 严禁跨平台 OS 内核级沙盒        │ 仅使用 React Portal 沙箱与 4 层 XSS 消毒，0 OS 内核 C 绑定   │ 0 违规 │ 🟢 通过│
├────┼──────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────┼────────┤
│ 2  │ 严禁 Rust 端无锁环形缓冲区       │ 传输统一使用标准 Tokio mpsc 通道与不可变共享，无 SAB RingBuf │ 0 违规 │ 🟢 通过│
├────┼──────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────┼────────┤
│ 3  │ 严禁引入分布式共识协议 (2PC/Raft)│ 本地状态坚持单写者模式与 SQLite WAL，0 分布式套用            │ 0 违规 │ 🟢 通过│
├────┼──────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────┼────────┤
│ 4  │ 严禁后台自动切换模型 (Router)    │ 用户选定模型固定使用，网络异常仅做指数退避重试，0 隐式降级   │ 0 违规 │ 🟢 通过│
├────┼──────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────┼────────┤
│ 5  │ 严禁出站请求前发 DNS A/AAAA 解析 │ 取消 DNS 异步解析与公有后缀检查，仅保留 http/https 格式校验  │ 0 违规 │ 🟢 通过│
├────┼──────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────┼────────┤
│ 6  │ 严禁黑盒 Prompt 意图重写拦截链   │ 用户输入透明传入，上下文切片与工具调用 100% 审计可见         │ 0 违规 │ 🟢 通过│
├────┼──────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────┼────────┤
│ 7  │ 注入上下文必须单一真相源 (SSOT)  │ onMessageDelta 唯一生产者，Map 双账本定稿覆盖，0 多源分裂    │ 0 违规 │ 🟢 通过│
├────┼──────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────┼────────┤
│ 8  │ 多 Provider 凭据零残留与隔离     │ Keychain/DPAPI 加密存储，SecretString 内存清零，环境变量分立 │ 0 违规 │ 🟢 通过│
├────┼──────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────┼────────┤
│ 9  │ 严禁全系统滑动窗口断路器         │ 彻底物理删除 continuityUiStore.ts 中的 circuitBanners 死层   │ 0 违规 │ 🟢 通过│
├────┼──────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────┼────────┤
│ 10 │ 严禁 Tool 执行 6 阶段洋葱 Hook 链│ 仅保留 beforeExecute 与 onResult/onError 两个标准锚点        │ 0 违规 │ 🟢 通过│
├────┼──────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────┼────────┤
│ 11 │ 严禁同进程微服务套娃与 Worker 滥用│ 彻底物理删除 thoughtWorker 与 thoughtInspectorStore，0 弹窗  │ 0 违规 │ 🟢 通过│
├────┼──────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────┼────────┤
│ 12 │ 严禁高频流式状态穿透全局 Store   │ 渲染状态保留在 StreamRenderBuffer/DOM 垫片，不打入根状态树   │ 0 违规 │ 🟢 通过│
├────┼──────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────┼────────┤
│ 13 │ 严禁移动端全量 CRDT 状态向量下沉 │ 多端互通收敛为轻量 Frame 协议，保护自研因果 Undo 与分词资产   │ 0 违规 │ 🟢 通过│
└────┴──────────────────────────────────┴──────────────────────────────────────────────────────────────┴────────┴────────┤
│ **总计**：13 项硬性红线 100% 严格遵守，零违背，零侥幸，零过度设计抽象新增。                                  │ 0 违规 │ 🟢 优秀│
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 5.2 变相过度设计防复活审查（弹窗、Worker、断路器与逆向解析器）

审查组重点针对历史易复活的过度设计模式进行了“防复活”交叉审查：

1. **表格全屏模态窗（`TableFullscreenModal`）防复活**：
   - 03 详案 §2.1 明确**彻底撤销**任何表格全屏弹窗与多格式导出工具集草案；
   - 表格完全收敛为原生横向滚动（`overflow-x: auto`）、表头吸顶（`position: sticky`）与轻量原生 Markdown 复制，**坚决杜绝弹窗模式借表格名义复活**。
2. **思维链全屏弹窗与 Worker 套娃防复活**：
   - 00 总案与 04 详案彻底物理销毁 `FullThoughtModal`（3 个文件）、`ThoughtOutline`（2 个文件）、`ThoughtSearchBar`（2 个文件）、`thoughtWorker`（2 个文件）与 `thoughtInspectorStore`（2 个文件）；
   - 思考链 100% 收敛至行内折叠流（`TimelineThoughtSection`），彻底切除全屏放大按钮、字数统计与离屏 Worker。
3. **断路器熔断状态（`circuitBanners`）防复活**：
   - 05 详案物理删除 `continuityUiStore.ts` 中的 `circuitBanners` 字段、方法与测试桩，消除任何全局锁死隐患。
4. **历史手写 Markdown 解析器防复活**：
   - 彻底物理销毁 `IncrementalMarkdownParser*`（7 个文件，包括 `IncrementalInlineRenderer.ts`），全面由 Rust `md_render` 与轻量增量分块器接管。

---

### 5.3 单文件行数限制（$\le 300$ 行）与超标文件拆分合规性

- **存量超标文件彻底拆解**：
  - 原 [`timelineNormalizer.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/tool-presentation/timelineNormalizer.ts) 高达 616 行，违反单文件行数限制；
  - 05 详案将其正交拆分为 4 个职责极纯的子模块：
    1. `timelineReconciler.ts`（约 130 行）
    2. `inlineTagParser.ts`（约 140 行）
    3. `timelineCache.ts`（约 90 行）
    4. `timelineNormalizer.ts` Facade 门面（约 150 行）
  - 拆分后单文件行数均严格控制在 $\le 180$ 行以下，**100% 消除 CI `check:line-counts` 门禁阻断风险**。
- **全战役新增文件行数控制**：
  - 01 详案：`SlidingWindowRateEstimator.ts`（约 120 行）、`AdaptiveAnimateTimeline.ts`（约 160 行）；
  - 02 详案：`IncrementalBlockSplitter.ts`（约 180 行）、`SpeculativeVirtualCloser.ts`（约 120 行）；
  - 03 详案：`tableProbe.ts`（约 60 行）、`usePinnedScroll.ts`（约 130 行）、`StreamingTableContainer.tsx`（约 110 行）；
  - 04 详案：`preprocessCustomTags.ts`（约 160 行）、`rehypeSanitizeCustomTags.ts`（约 130 行）；
  - 所有新增文件均设计在 $\le 200$ 行以内，无任何巨石文件新增。

---

### 5.4 50k+ Tokens 阶梯压测与 120 FPS / Zero-CLS 门禁指标

审查组核验了各详案中的性能压测基准与测试断言，确认其指标量化严密、断言清晰可执行：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              50k+ Tokens 全链路性能与渲染稳定性 CI 门禁验收指标                                         │
├────┬────────────────────────┬───────────────────┬──────────────────────────────────────────┬───────────────────────────┤
│ 序 │ 性能 / 质量指标        │ 行业基准 / 历史值 │ Conex 下一代引擎目标门禁值               │ 测量与断言手段            │
├────┼────────────────────────┼───────────────────┼──────────────────────────────────────────┼───────────────────────────┤
│ 1  │ 累积布局偏移 (CLS)     │ 0.450 ~ 0.850     │ **CLS = 0.000 (绝对零骨架屏跳变)**        │ PerformanceObserver 断言  │
├────┼────────────────────────┼───────────────────┼──────────────────────────────────────────┼───────────────────────────┤
│ 2  │ 流式渲染帧率 (FPS)     │ 25 ~ 45 FPS (卡顿)│ **$\ge 59.5$ FPS (120 FPS 显示器满帧)**  │ Chromium Trace 帧率监控   │
├────┼────────────────────────┼───────────────────┼──────────────────────────────────────────┼───────────────────────────┤
│ 3  │ 单帧 JS 计算耗时       │ 12 ~ 35 ms        │ **$< 0.4\text{ ms}$ (TURBO 宏块直出)**   │ performance.measure 耗时  │
├────┼────────────────────────┼───────────────────┼──────────────────────────────────────────┼───────────────────────────┤
│ 4  │ 5000 词 DOM 节点生成数 │ 5,000+ 个 Span    │ **1 个 TextNode (节点数减少 98.5%)**     │ DOM 节点深度与数量统计    │
├────┼────────────────────────┼───────────────────┼──────────────────────────────────────────┼───────────────────────────┤
│ 5  │ 多轮正文重复率         │ 偶发 100% 整段重复│ **0.00% (绝对数学幂等零重复)**           │ Vitest 多轮快照 diff 断言 │
├────┼────────────────────────┼───────────────────┼──────────────────────────────────────────┼───────────────────────────┤
│ 6  │ 思考链/工具卡片保全率  │ 轮次切换时丢失    │ **100.00% (三元槽位无损保全)**           │ 三轮 Agent 工具循环单测   │
├────┼────────────────────────┼───────────────────┼──────────────────────────────────────────┼───────────────────────────┤
│ 7  │ XSS 危险脚本拦截率     │ 部分过滤          │ **100.00% (4 层纵深防御全拦截)**         │ 对抗性 XSS Payload 套件   │
└────┴────────────────────────┴───────────────────┴──────────────────────────────────────────┴───────────────────────────┘
```

---

## 六、终审评审 B 结论与主控定稿指令

### 6.1 终审评审结论

经过对《00-总方案》与《01》~《05》全部 5 份分维详案的严苛交叉审查，评审组一致认定：

1. **架构契约高度成熟**：5 大领域概念边界清晰，主路径唯一且收敛，彻底清剿了 3~4 套并行旧路径打架的历史包袱；
2. **死层清理彻底决绝**：23 个孤岛文件与 4 处符号级死代码清单清晰、无残留，负产出指标扎实；
3. **先删后改 DAG 依赖闭环**：阶段 0 到阶段 5 拓扑清晰、门禁森严，具备极强的可实施性；
4. **反过度设计红线 100% 达标**：彻底根除了弹窗套娃、离屏 Worker、滑动窗口断路器与 DOM 逆向解析器，代码量与复杂度完全受控。

---

### 6.2 主控最终定稿与实施指令（Actionable Directives）

1. **指令 1（定案冻结）**：正式将《00-总方案》与 01~05 详案标记为 **FROZEN（已冻结）**，全案进入实施就绪状态；
2. **指令 2（删除清单校准）**：在阶段 0 执行物理删除时，严格以《00-总方案》列出的 **23 个物理删除文件清单**（包含 `IncrementalInlineRenderer.ts`）为准执行 `git rm`；
3. **指令 3（目录收敛实施）**：在阶段 4 实施维度四（HTML 组件与沙箱）时，将新增的 4 个底层算法文件统一落盘至 `apps/crish-desktop/src/api/markdown/`，随阶段 0 彻底废除 `api/markdown-render/` 历史目录；
4. **指令 4（按 DAG 启动实施）**：主控立即派发任务，严格按照“阶段 0（死层清剿） $\to$ 阶段 1/2（双轨内核与生命周期） $\to$ 阶段 3（分块与双缓冲底座） $\to$ 阶段 4（三维装配） $\to$ 阶段 5（全链路门禁验收）”的顺序开展编码与验证。
