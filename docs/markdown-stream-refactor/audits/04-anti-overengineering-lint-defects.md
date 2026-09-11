# 挑刺审查报告 04：反过度设计与 CI 门禁解耦严苛审查

> **审查范围**：全量新增/修改的 Rust 与 TypeScript 代码、`ANTI_OVERENGINEERING_GUARDRAILS.md`、前端行数基线、组件架构层级与依赖拓扑
> **审查原则**：严禁夸奖套话与中立总结，仅挑刺、仅记录超标违规、过度设计、死代码及架构缺陷项。

---

## 1. 单文件代码行数超标与门禁违规 (Line Budget Defect)

### 1.1 业务逻辑文件超标阻断（487 行 > 400 行业务逻辑门禁上限）
- **违规文件**：[`apps/crish-desktop/src/api/tool-presentation/timelineNormalizer.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/tool-presentation/timelineNormalizer.ts)
- **门禁定性**：**❌ [VIOLATION]**，有效代码行 487 行（总行数 616 行），超出门禁上限（≤ 400 行）达 +87 行（超标 +21.7%），直接导致 `npm run check:line-counts` 退出码 1 阻断。
- **根因解剖**：
  1. 违背单一职责原则，将 AST 块对齐 (`alignToolCallBlocks`)、三元组持久块保全 (`reconcileAssistantMessageBlocks`)、代码栅栏扫描 (`findMarkdownCodeRanges`)、字符串安全内联提取 (`parseInlineThoughtAndTextSafely`)、时间线构建 (`buildAssistantTimeline`) 与缓存签名 (`timelineSignature`) 堆砌于单文件。
  2. 包含未下沉的正则模式匹配与字符串切片逻辑，未按 `toolRenderItems.ts` 模式进行叶子节点物理拆分。

### 1.2 高危临界预警文件（> 85% 预警阈值）
- [`apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx)：有效行 467 行（93.4% / ≤ 500 行 UI 档），⚠️ [WARNING]。
- [`apps/crish-desktop/src/components/ui/internal/layer-stack/LayerStackManager.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/internal/layer-stack/LayerStackManager.ts)：有效行 466 行（93.2% / ≤ 500 行 UI 档），⚠️ [WARNING]。
- [`apps/crish-desktop/src/components/workspace/PreviewCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.tsx)：有效行 477 行（95.4% / ≤ 500 行 UI 档），⚠️ [WARNING]。
- [`apps/crish-desktop/src/components/workspace/previewDomInspector.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/previewDomInspector.ts)：有效行 434 行（86.8% / ≤ 500 行 UI 档），⚠️ [WARNING]。
- [`apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx)：有效行 434 行（86.8% / ≤ 500 行 UI 档），⚠️ [WARNING]。
- [`apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts)：有效行 380 行（95.0% / ≤ 400 行业务逻辑档），⚠️ [WARNING]。
- [`apps/crish-desktop/src/api/sessionTitle.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionTitle.ts)：有效行 348 行（87.0% / ≤ 400 行业务逻辑档），⚠️ [WARNING]。
- [`apps/crish-desktop/src/hooks/chat-stream/helpers.ts`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/helpers.ts)：有效行 348 行（87.0% / ≤ 400 行业务逻辑档），⚠️ [WARNING]。
- [`apps/crish-desktop/src/store/workspace-shell/adapterShapeTreeOps.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/workspace-shell/adapterShapeTreeOps.ts)：有效行 345 行（86.3% / ≤ 400 行业务逻辑档），⚠️ [WARNING]。

### 1.3 基线标记区数据断裂缺陷
- **违规文件**：[`docs/multi-agent-repair/基线记录/frontend-line-counts-baseline.md`](file:///c:/Software/conex/docs/multi-agent-repair/基线记录/frontend-line-counts-baseline.md)
- **缺陷**：底部 `<!-- BASELINE_START -->` 至 `<!-- BASELINE_END -->` 仅有 1 条登记记录，正文中记载的 60+ 项存量冻结数据未同步至标记区，导致脚本无法执行增量冻结比对。

---

## 2. 过度设计与废弃重型组件残留 (Overengineering & Dead Code)

### 2.1 废弃沉浸式思考弹窗全套重型基建残留
- **违背禁令**：`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 11（同进程微服务套娃）与行内折叠流规范。
- **缺陷代码清单**：
  1. [`apps/crish-desktop/src/components/chat-message-row/FullThoughtModal.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/FullThoughtModal.tsx)（283 行）及其样式表 [`FullThoughtModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/FullThoughtModal.module.css)：构建了庞大的全屏弹窗。
  2. [`apps/crish-desktop/src/components/chat-message-row/ThoughtOutline.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ThoughtOutline.tsx)（82 行）：为临时推理文本生成目录树（TOC）。
  3. [`apps/crish-desktop/src/components/chat-message-row/ThoughtSearchBar.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ThoughtSearchBar.tsx)（104 行）：为弹窗内部实现全文正则搜索与高亮跳转。
  4. [`apps/crish-desktop/src/workers/thoughtWorker.ts`](file:///c:/Software/conex/apps/crish-desktop/src/workers/thoughtWorker.ts)（283 行）：专门为了在独立 Web Worker 中多线程解析 Markdown 标题提取大纲。
  5. [`apps/crish-desktop/src/store/thoughtInspectorStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/thoughtInspectorStore.ts)（80 行）：独立的全局 Zustand 状态树。
  6. [`apps/crish-desktop/src/app/AppGlobalDialogs.tsx:152`](file:///c:/Software/conex/apps/crish-desktop/src/app/AppGlobalDialogs.tsx#L152)：全局常驻挂载 `<FullThoughtModal />`。
  7. [`apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx:88-96, 145-155, 191-210`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx#L88-L96)：在行内思维链中依然保留 `thoughtExpandModalBtn`（悬浮放大按钮）、`thoughtWords` 与底部的「查看完整思考链」大按钮。
- **过度设计本质**：针对只读、次要的推理过程，过度设计了「独立 Worker + 独立 Store + 独立搜索栏 + 独立大纲树 + 全局常驻弹窗」五层套娃，制造了 800+ 行非必要代码。

### 2.2 `parseMarkdownIntoBlocks.ts` 未使用的死函数与无界缓存
- **缺陷位置**：[`apps/crish-desktop/src/api/markdown/parseMarkdownIntoBlocks.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdown/parseMarkdownIntoBlocks.ts)
- **死代码清单**：
  1. `hasIncompleteCodeFence` (lines 148–178)：31 行完整代码，分块主流程内部完全未调用，全仓库仅自身导出和测试文件引用。
  2. `hasTable` (lines 183–199)：17 行完整代码，分块主流程内部完全未调用。
- **内存泄漏隐患**：
  - lines 56–57：`openTagPatternCache` 与 `closeTagPatternCache` 为全局无界 `Map<string, RegExp>`，当模型流式生成任意未知自定义 XML 标签时，正则对象无淘汰机制（无 LRU/无上限），存在内存无界膨胀隐患。

### 2.3 `updateMessageTimeline` 双重 Reconciliation 冗余计算
- **缺陷位置**：[`apps/crish-desktop/src/store/sessionMessageActionsTools.ts:204-209`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionMessageActionsTools.ts#L204-L209)
- **冗余逻辑**：
  ```typescript
  const n = normalizeAssistantTimeline({ ...hit.message });
  hit.message.blocks = reconcileAssistantMessageBlocks(
    hit.message.blocks,
    n.blocks || []
  );
  ```
- **根因**：`normalizeAssistantTimeline` 内部在 [`timelineNormalizer.ts:186-189`](file:///c:/Software/conex/apps/crish-desktop/src/api/tool-presentation/timelineNormalizer.ts#L186-L189) 已经调用过 `reconcileAssistantMessageBlocks(msg.blocks, alignedBlocks)`。外部 action 对其返回值再次执行 `reconcileAssistantMessageBlocks`，造成同一事务内执行两遍 $O(N)$ 哈希重排与排序计算。

### 2.4 全局滑动窗口断路器残留 (`circuitBanners`)
- **违背禁令**：`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 9（严禁使用全系统滑动窗口断路器）。
- **缺陷位置**：[`apps/crish-desktop/src/api/continuity/continuityUiStore.ts:44, 54-62, 105-132`](file:///c:/Software/conex/apps/crish-desktop/src/api/continuity/continuityUiStore.ts#L44) 仍保留 `circuitBanners`、`raiseCircuitBanner`、`dismissCircuitBanner`、`isCircuitTripDetail`，并在测试中通过 raw `setState` 复位。

---

## 3. 越层引用、逆向依赖与循环依赖 (Layer & Dependency Defects)

### 3.1 Chat Bridge 内部循环引用环 (Cyclic Import Loop)
- **闭环路径**：
  ```mermaid
  graph LR
      A[streamState.ts] -->|import MessageCacheMetrics| B[messageHandlers.ts]
      B -->|import HandlerEnv| C[handlerEnv.ts]
      C -->|import StreamState| A
  ```
- **代码定位**：
  - [`apps/crish-desktop/src/api/chat-bridge/handlers/streamState.ts:1`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/streamState.ts#L1) $\to$ `import type { MessageCacheMetrics } from './messageHandlers'`
  - [`apps/crish-desktop/src/api/chat-bridge/handlers/messageHandlers.ts:11`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/messageHandlers.ts#L11) $\to$ `import type { HandlerEnv } from './handlerEnv'`
  - [`apps/crish-desktop/src/api/chat-bridge/handlers/handlerEnv.ts:9`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/handlerEnv.ts#L9) $\to$ `import type { StreamState } from './streamState'`
- **根因**：`MessageCacheMetrics` 定义于 `cacheMetricsCompute.ts`，`streamState.ts` 错误地从中间协调者 `messageHandlers.ts` 引入，诱发循环依赖。

### 3.2 UI 原子层逆向依赖业务服务层 (Reverse Layer Boundary Defect)
- **违规定性**：UI 原子组件反向依赖业务层服务，导致 `node scripts/check-ui-layer.mjs` 门禁失败。
- **违规位置**：
  - [`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx:7`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx#L7) $\to$ `import "../../../services/ResizeObserverManager"`
  - [`apps/crish-desktop/src/components/ui/TabStrip/TabStrip.tsx:8`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/TabStrip/TabStrip.tsx#L8) $\to$ `import "../../../services/ResizeObserverManager"`

### 3.3 组件层越过 Facade 门面直引内部 Store (Store Facade Violations)
- **违规定性**：违背 `check-store-facade.mjs` 门禁（发现 13 处组件直连内部 store 切片，基线要求为 0）。
- **典型违规**：
  - `components/agent-card/AgentCard.tsx:14` $\to$ `../../store/sessionStore`
  - `components/chat-card/DynamicChipBar.tsx:3` $\to$ `../../store/layoutStore`
  - `components/chat-card/useChatInput.ts:2` $\to$ `../../store/sessionStore`
  - `components/chat-composer/ComposerFusedTrigger.tsx:24` $\to$ `../../store/settingsStore`
  - `components/provider/ModelBadgePickerMenu.tsx:17` $\to$ `../../store/settingsStore`
  - `components/shell/sessionTabDropCommit.ts:6` $\to$ `../../store/workspace-shell`
  - `components/workspace/TrashSection.tsx:14` $\to$ `../../store/sessionStore`

### 3.4 UI Hook 倒置导出底层 API 纯函数 (Layer Confusion)
- **违规位置**：[`apps/crish-desktop/src/components/chat-message-row/useStreamingBlocks.ts:102`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/useStreamingBlocks.ts#L102)
- **缺陷**：`export { parseMarkdownIntoBlocks };` 将属于 API 层的纯解析算法由组件级 Hook 重新导出，造成层级语义混乱与调用倒置。

---

## 4. 前端样式收敛与 CI 门禁失败项 (CI Gate Violations)

### 4.1 裸数字高位 z-index 违规 (Rule 5 / G-05)
- [`apps/crish-desktop/src/components/workspace/previewDomInspector.ts:372, 381, 387`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/previewDomInspector.ts#L372)：使用了裸数字 `z-index`，未收敛至 7 级标准 Token（上限 9000）。

### 4.2 业务样式表 `!important` 污染 (Rule 6 / G-06)
- [`PreviewCard.module.css:21, 202-207`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.module.css#L202)
- [`LeafToolTabStrip.module.css:21, 37`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css#L21)
- [`UnitChromeActions.module.css:46, 47, 138, 139`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/UnitChromeActions.module.css#L46)
- [`DiffCard.module.css:379`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L379)
- [`ModelBadgePickerMenu.module.css:115-130`](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css#L115)

### 4.3 废弃 `onShowToast` 透传 (Rule 11 / G-11)
- [`useModelProfilesState.ts:49`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/useModelProfilesState.ts#L49)、[`SkillCardList.tsx:39`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillCardList.tsx#L39)、[`RuntimePanel.tsx:38`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/RuntimePanel.tsx#L38)、[`TrashSection.tsx:25`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/TrashSection.tsx#L25) 违规声明 `onShowToast`，未统一接入 `useToast()` 单例。

### 4.4 原生 HTML `title` 悬浮提示违规 (Rule 12 / G-12)
- [`ModelBadgePickerMenu.tsx:180`](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx#L180)、[`ModelConfigPanel.tsx:107`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelConfigPanel.tsx#L107)、[`SkillCardList.tsx:88, 112`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillCardList.tsx#L88)、[`SmartPanelHeader.tsx:44`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartPanelHeader.tsx#L44) 直接使用 HTML 原生 `title` 属性，未封装为 `<Tooltip>`。

### 4.5 生产代码直调 raw `*Store.setState` (Store Mutation Violation)
- [`apps/crish-desktop/src/api/continuity/continuityUiStore.ts:137`](file:///c:/Software/conex/apps/crish-desktop/src/api/continuity/continuityUiStore.ts#L137) 在导出函数中直接执行 `useContinuityUiStore.setState(...)`，违背统一经 store action 派发的规范。

---

## 5. Rust 状态机过度设计与内存平移开销 (Rust FSM Smells)

### 5.1 `StreamingTagExtractor` 频繁 `String::drain` 诱发 $O(M^2)$ 内存平移
- **缺陷位置**：[`crates/agent-provider/src/parse/think_tags.rs:235, 287`](file:///c:/Software/conex/crates/agent-provider/src/parse/think_tags.rs#L235)
- **缺陷根因**：在前瞻匹配未命中弹出首字符时，状态机每次循环均调用 `self.lookahead_buf.drain(..char_len)`。对 `String` 频繁执行头部 `drain` 会导致底层字节数组发生连续物理内存前移（memmove），当缓冲区累积较长前缀时产生 $O(M^2)$ 额外开销，未采用基于只读切片游标或固定缓冲区的轻量滑动机制。

### 5.2 状态机收尾脏状态 (`TagState::Thinking` 无索引孤立态)
- **缺陷位置**：[`crates/agent-provider/src/parse/think_tags.rs:179-182, 186`](file:///c:/Software/conex/crates/agent-provider/src/parse/think_tags.rs#L179)
- **缺陷根因**：`finish_pieces` 中将 `state` 置为 `TagState::Thinking`，但随后无条件将 `self.active_tag_index` 赋值为 `None`。若外部复用该实例，状态机将进入“处于思考态却无任何激活标签”的不可达非稳态。

---

## 6. 挑刺审查缺陷汇总表 (Defect Matrix)

| 编号 | 缺陷分类 | 严重度 | 涉及核心文件 | 核心缺陷与违规事实 |
|:---|:---|:---|:---|:---|
| **D4-01** | 单文件行数超标 | **P0 (阻断)** | `timelineNormalizer.ts` | 有效代码行 487 行，超标 400 行业务逻辑门禁 +21.7%，CI 门禁必 fail |
| **D4-02** | 废弃重型组件残留 | **P1 (过度设计)** | `FullThoughtModal.tsx` / `thoughtWorker.ts` / `thoughtInspectorStore.ts` | 思考链全套独立 Worker、Store、TOC 生成器与全屏弹窗过度设计（800+ 行非必要代码） |
| **D4-03** | 死代码与无界缓存 | **P1 (资源隐患)** | `parseMarkdownIntoBlocks.ts` | `hasIncompleteCodeFence` 与 `hasTable` 未被任何流程调用；全局正则 Map 无淘汰机制 |
| **D4-04** | 循环依赖闭环 | **P1 (架构违规)** | `streamState.ts` $\leftrightarrow$ `messageHandlers.ts` $\leftrightarrow$ `handlerEnv.ts` | 三模块形成类型/模块循环引用闭环 |
| **D4-05** | UI 逆向依赖业务层 | **P0 (阻断)** | `SegmentedControl.tsx` / `TabStrip.tsx` | 原子 UI 组件直接反向 import 业务服务 `ResizeObserverManager`，check:ui-layer 阻断 |
| **D4-06** | 状态双重计算 | **P2 (性能浪费)** | `sessionMessageActionsTools.ts` | `updateMessageTimeline` 对已归一化结果二次执行 `reconcileAssistantMessageBlocks` |
| **D4-07** | 组件越层直连 Store | **P1 (门禁违规)** | `AgentCard.tsx` / `DynamicChipBar.tsx` 等 13 处 | 越过 Store Facade 直引内部 Store 切片，check:store-facade 阻断 |
| **D4-08** | CSS !important 与 Token 违规 | **P2 (规范违规)** | `PreviewCard.module.css` / `previewDomInspector.ts` | 出现裸数字 z-index 与多处 `!important` 覆盖，check:convergence 阻断 |
| **D4-09** | Rust 状态机内存平移 | **P2 (代码异味)** | `think_tags.rs` | 逐字 `lookahead_buf.drain` 引发多次内存前移；finish 后状态与 tag index 不一致 |
| **D4-10** | 断路器过度设计残留 | **P2 (红线违规)** | `continuityUiStore.ts` | 违背禁令 9 仍残留 `circuitBanners` 熔断横幅与 raw `setState` 状态复位 |
