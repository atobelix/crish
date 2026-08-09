# 性能与渲染维度修复方案（07）

- 方案日期：2026-08-09
- 输入：`docs/frontend-audit/10-analysis/07-performance-rendering-audit.md`（15 项风险点）+ `docs/frontend-audit/00-cross-analysis.md`（P0-6 为全前端最高优先级性能缺陷）
- 协同：02 组件方案（props/memo 面）、06 工程化方案（chunk/CI 面）、04 通信方案（highlight 接线）
- 性质：只读 + 本方案文档（无代码改动）
- 编码：UTF-8 无 BOM，中文

---

## ① 目标态

| 维度 | 现状 | 目标态 |
|---|---|---|
| 流式渲染 | 48ms 节流的全量重渲染：每帧 `setStreamText(full)` → 全量 `buildAssistantTimeline` + 全量 `stripThoughtPlaceholders` + React 文本节点全量替换（`useStreamCallbacks.ts:298`、`MessageContent.tsx:56-68`、`:119-120`） | **每帧成本 O(增量)**：增量文本经 ref 桥接 appendText 直写文本节点（绕开 React 全文 diff）；timeline/strip 有签名缓存或增量窗口；主线程每帧在预算内 |
| complete 收口 | `push('',true)+flush(true)` 单帧全量输出 + 同帧 commit/normalize/Rust IPC 连发（`useStreamCallbacks.ts:716-718`） | 收口分帧（残余按预算出完），commit 与最终 HTML 渲染不挤在同一帧；无 >50ms 长任务 |
| 搜索态 | 搜索激活后 `windowScanKey = messages` → 流式期间每次重渲染都 O(n) 全量扫描（`ChatMessageList.tsx:160-186`） | 命中索引/缓存：query 预 tokenize + 按消息 id 增量求值；流式期间每帧扫描成本 ≤1ms |
| 重渲染热点 | `setActual` 无同值去重、会话 store 任何变更全链重渲染、40 字段手写比较器无守卫（R-04/R-05/R-06） | 同值写入 no-op；会话级订阅短路；比较器字段清单测试兜底 |
| 回归防线 | perf bench 与前端渲染管线零交集；无浏览器端性能轨（R-14） | 前端渲染模块进 bench 轨 + Playwright FPS/longtask 断言进 CI |

---

## ② P0-6 流式渲染修复路径

### 2.1 现状偏差（读代码确认）

**设计意图 vs 实现：**

`StreamRenderBuffer` 的头注释明确设计了「增量承诺」——`frame.html` 预留给 JS 增量解析器（IncrementalMarkdownParser）产出的 HTML、`frame.chunkUpdates` 预留给 chunk 级 DOM patch（`StreamRenderBuffer.ts:14-19`）。但实际实现：

1. **`html` 恒为 `''`、`chunkUpdates` 恒为空数组**（`StreamRenderBuffer.ts:197-198`），注释自认「解析器尚未接入」；`AsyncMarkdownBlock.tsx:24` 记录该路径已删除（D0 residual）。→ 增量渲染通道从未接线。
2. **onFrame 只写全量文本**：`setStreamText(sid, assistantMsgId, frame.full)`（`useStreamCallbacks.ts:298`）——帧预算只限制了 **set 频率**，每帧 payload 仍是全文。
3. **消费端每帧全量重算**：`MessageContent` 订阅 streamingStore 后每帧执行 `applyStreamTextToMessage`（O(blocks)）→ `buildAssistantTimeline`（O(tools+blocks)，`timelineNormalizer.ts:168-229`）→ `stripThoughtPlaceholders(全文)`（约 8 个 `gm` 正则整文扫描，`markdownRenderLite.ts:35-73`）→ `AsyncMarkdownBlock` 纯文本分支渲染（React 对单文本节点执行 `textContent` 全量替换，O(全文)）。
4. **isStreaming 只覆盖最后一项**：`const streaming = isThinkingMsg && item.key === lastTextKey`（`MessageContent.tsx:122`）——只有「最后一个 text 块」走零 IPC 纯文本路径；`AsyncMarkdownBlock` 本身无 `React.memo`，每帧整棵块树重渲染（历史块靠 `useAsyncMarkdownHtml` 缓存命中同步返回兜住 IPC，但组件树遍历成本仍在）。

**结果**：管线退化为「rAF 节流的全量重渲染」，>100KB 文本时每帧同步成本数毫秒级（R-03/R-10）；complete 瞬间双重重渲染 + Rust IPC（R-01）。

### 2.2 修复设计

**总体决策：不复活 D0 的 IncrementalMarkdownParser（阶段 1）。** 理由：①完成态 SoT 已是 Rust `md_render`（`markdownRenderAsync.ts:37-43`），流式期只是「预览」，双实现增量解析器会引入 JS/Rust 渲染双轨漂移成本；②「每帧 O(增量)」目标用纯文本增量即可达成（覆盖 95% 收益），HTML 增量解析收益仅剩「流式期就地预览代码高亮」，性价比低。阶段 2 如需可再评估（见 ⑥ 风险 1）。

**四条修复路径（分层实施，互为依赖）：**

**(A) 增量通道：frame.delta 直达渲染层**
- `StreamRenderBuffer` 的 `RenderFrame` 已有 `delta` 字段（`StreamRenderBuffer.ts:21-33`）且 `flushFrame` 保证 8192B/6ms 预算切帧（:241-279）——帧控制无需改动；
- 改动点在消费端：`onFrame` 不再只写全文（全文仍写，供 copy/commit），新增「增量字段」或由订阅方自持 `lastShownLength`，用 `text.slice(lastShownLength)` 求 delta（O(1) 切片，字符串常量时间切片）；
- `streamingStore` 保持「全文覆盖 + 同值拦截」不变（`streamingStore.ts:132-147`）——store 契约不动，避免波及 copy/commit/stop 等既有消费者；增量只在渲染组件内派生。

**(B) 文本节点更新策略：ref 桥接 appendText**
- 新增 `StreamingTextBlock` 组件：props 仅 `{ delta }`（每帧新增量），render 返回空壳 div（ref），`useLayoutEffect` 中 `node.appendChild(document.createTextNode(delta))`——**DOM 写入 O(增量)**；
- 关键：增量文本**不进 React children**，绕开 React 对单文本节点的全量 `textContent` 替换（React 对 `{text}` 子节点更新是整节点重写，O(全文)）；组件本身每次 re-render 只是 O(1) 空壳；
- caret/滚动跟随保持现有 CSS 实现；复制路径仍读 store 全文（`ChatAssistantMessageRow.tsx:177-199` 的 `getStreamText` 通道不动）。

**(C) strip/时序构建增量窗口化**
- `stripThoughtPlaceholders` 改为「尾部增量窗口」语义：流式期只对 delta 到达后的末段（如 1KB 窗口 + 消息头）做占位剥离，避免整文 8 正则扫描；剥离后的历史部分缓存在组件 ref 中，仅拼接待显示串（O(增量) 拼接）；
- `buildAssistantTimeline` 增加**签名缓存**：`blocks`/`toolCalls` 结构签名（id 序列 + status + 文本块引用）不变时直接复用上次 timeline 结果（工具密集会话中 blocks 只在工具事件时变，流式 token 不碰）；
- `MessageContent` 结构拆分：timeline 主体（工具卡 + 稳定文本块）与最后 text 项的流式区域分离——流式区每帧只重渲染 `StreamingTextBlock`，主体块 `React.memo` 按签名短路（R-10 落点）。

**(D) complete 收口分帧 + 主块瘦身**
- `onComplete` 的 `flush(true)` 改为：残余 pending 按预算分帧刷出（≤2 帧场景直接刷完，单帧成本 ≈ 帧预算；大量残余时走正常 flushFrame 预算循环），最后 isFinal 帧单独小帧——不再一帧输出全部（R-01）；
- 同帧主块内的非 UI 关键段（`recordStreamDiag`、`checkAndAlertSilentComplete`、usage 估算）移出同步主块（微任务/`requestIdleCallback`），保留 commit + status + normalize 在关键路径。

**目标态验证口径**：每 token 更新 O(增量)（DOM append + 局部 strip），complete 收口无 >50ms 长任务，搜索态有命中缓存。

---

## ③ 分步方案

> 执行顺序仅表示逻辑依赖（后步依赖前步产物），不写时间/人员/优先级（00 交叉分析的批次划分由主控调度）。每步独立提交、独立门禁；每步「输出」即下一步「输入」。

### 步骤 0：性能基线实测（前置锚点）

| 项 | 内容 |
|---|---|
| 任务 | 1. 搭「流式大文本压测场景」：mock SSE 流（chatApi 注入）推送 100KB 文本 + 20 个工具事件；2. 用 Performance trace（Performance 面板 + longtask API）采样三锚点：流式期平均帧间隔 / 最长任务 / complete 帧耗时；3. 把采样做成可重复脚本（`tests/perf/` 下 capture 工具，输出 JSON + 阈值文件），作为步骤 1-3 的对比基线。审计的诚实边界（无运行时数据）在本步闭合。 |
| 文件面 | `tests/perf/`（新建 capture 脚本 + 基线 JSON）；`apps/crish-desktop/src/api/chatApi.ts`（仅确认注入点，不改） |
| 验证 | 基线 JSON 落盘；脚本可在本机重复运行产出同构数据 |
| 完成判据 | 三锚点基线数值确定（预期：流式期长任务随文本增长、complete 帧 >50ms 长任务、搜索态每帧扫描随消息数线性）；基线文件入库 |
| 输出 | 基线报告 + 压测场景脚本（步骤 1/2/3 的验证工具与判据锚点） |

### 步骤 1：流式渲染恢复（帧级增量，P0-6 主体）

| 项 | 内容 |
|---|---|
| 任务 | ① 渲染通道加增量：`MessageContent` 自持 `lastShownLengthRef`，从 `streamText.slice(lastShownLength)` 派生每帧 delta；② 新增 `StreamingTextBlock`（ref + appendText 增量写节点）；③ `stripThoughtPlaceholders` 增量窗口化（尾部窗口 + 头部一次性剥离，历史部分 ref 缓存拼接）；④ `buildAssistantTimeline` 签名缓存 + `MessageContent` 拆分（流式区独立、主体 `React.memo`）；⑤ `AsyncMarkdownBlock` 补 `React.memo`（props：text/isStreaming/priority）；⑥ 保留 store 全文契约，不动 copy/commit/stop 路径 |
| 文件面 | `MessageContent.tsx`、`AsyncMarkdownBlock.tsx`、`markdownRenderLite.ts`（新增增量窗口函数，全量版保留给 complete/fallback）、`timelineNormalizer.ts`（签名缓存辅助）、新增 `StreamingTextBlock.tsx`（chat-message-row 下）；`StreamRenderBuffer.ts`/`streamingStore.ts` 不改（契约稳定） |
| 依赖 | 与 02 无阻塞冲突（`ChatAssistantMessageRow` props 分组为 02 阶段 C 事项，本步只动 `MessageContent` 内部；同文件串行注意：若 02 C1 同时改 `MessageContent` 消费面，协商先合本步） |
| 验证 | ① 单测：`StreamingTextBlock` append 语义（累积文本 = 各 delta 拼接，重挂载复位）；增量窗口 strip 与全量 strip 的等价性（多组 fixture 含 CJK/占位行/总结标题，property 式对拍）；timeline 签名缓存命中/失效用例；② `reRenderMonitoring` 扩展断言：流式帧期间 `AsyncMarkdownBlock` 非流式块渲染次数 = 0（有签名缓存时）；③ 性能采样：跑步骤 0 压测脚本对比基线 |
| 完成判据 | 100KB 流式 60s 采样：平均帧间隔较基线不劣化且无 >50ms 长任务；`StreamingTextBlock` 每帧 DOM 写入量 = delta 长度（O(增量)）；增量 strip 对拍测试全绿；`npm run typecheck` + `npm run test:coverage -- --project=unit` 全绿 |
| 输出 | 增量渲染通道 + 组件；对拍测试；步骤 2 的前置（complete 分帧不再被全量渲染放大） |

### 步骤 2：complete flush 收口优化（R-01）

| 项 | 内容 |
|---|---|
| 任务 | ① `onComplete` 收口改分帧：残余 pending 按 `maxBytesPerFrame` 预算出完（残余 ≤ 2 帧直接刷完，避免 isFinal 帧悬空），`StreamRenderBuffer` 增加「预算式 final flush」路径（force 保留给 stop，但 stop 也登记预算选项）；② onComplete 主块瘦身：`recordStreamDiag`/`checkAndAlertSilentComplete`/usage 估算移出同步主块（微任务或 rIC）；③ commit 与最终 HTML 渲染解耦确认：`scheduleRunFinalHtml` 已走 `parseMarkdownToHtmlAsync`（spawn_blocking 异步，`helpers.ts:53-74`），仅需确保其完成回调的 `updateMessageText`（`helpers.ts:71`）不与 commit 同帧竞争布局 |
| 文件面 | `useStreamCallbacks.ts`（onComplete/finalizeStopGeneration）、`StreamRenderBuffer.ts`（final flush 预算语义 + 单测）、`helpers.ts`（不动或仅注释） |
| 依赖 | 依赖步骤 1（增量通道后 complete 残余帧成本降低，分帧更稳）；与 06 无冲突 |
| 验证 | ① `StreamRenderBuffer` 单测扩展：final 标记 + 大残余场景下「无单帧超限输出」断言（force=false 预算恒成立）；② Playwright/压测脚本断言：complete 帧内无 >50ms 长任务（100KB 场景）；③ 人工验证：观察「输出到一半停一下再出最终版」体感是否消失（complete 后 1 帧内出最终态） |
| 完成判据 | 100KB 场景 complete 帧最大任务 <50ms（步骤 0 基线对照）；收口后 2 帧内流式态切完成态；既有 e2e 冒烟（ast-block-tables 等 5 个 markdown-editor 专项）全绿 |
| 输出 | 收口语义修正 + 长任务断言样例（步骤 5 防线雏形） |

### 步骤 3：搜索态优化（R-02）

| 项 | 内容 |
|---|---|
| 任务 | ① query 预计算：`tokenizeSearchQuery(query)` 与 NFKC 折叠结果在 `searchMatch` useMemo 内一次算好，`messageMatchesSearch` 改为接收预折叠 query 的纯匹配（消除每消息重复 normalize——当前 `sessionSearch.ts:345-358` 每消息内部重 tokenize）；② 命中缓存增量更新：`collectMustIncludeIndices` 的 match 分支改为「msgId → boolean」缓存（key：query + messages 引用），只对新增/变更 id 求值，命中首个即短路（`matchOnlyFirst` 已有）；③ 搜索态 keep-alive 重扫节流：流式期间（processing 存在）`resolveExpandedForKeepAlive` 从每 render 降为 rAF 合并（500ms 窗口内只扫一次）——流式期间搜索命中结果不随 token 变化，每帧重扫收益为零；④ 命中高亮保持不变（`isSearchHit` 行级，读缓存） |
| 文件面 | `sessionSearch.ts`（预折叠匹配函数 + 命中缓存）、`messageWindow.ts`（collectMustIncludeIndices 缓存注入点）、`ChatMessageList.tsx`（:160-186 窗口扫描编排 + 节流） |
| 依赖 | 与 02 无冲突；注意 `ChatMessageList.tsx` 与步骤 1 共用（同文件串行，先合步骤 1） |
| 验证 | ① 单测：预折叠匹配与现行为等价（对拍既有 `messageMatchesSearch` 用例集）；命中缓存命中/失效/query 变更刷新用例；节流窗口合并次数断言；② 压测脚本：100 消息会话 + 搜索激活 + 流式期间，每帧扫描成本采样 |
| 完成判据 | 100 消息 + 搜索激活 + 流式 60s：每帧扫描耗时 ≤1ms（步骤 0 对照）；搜索高亮/跳转行为无回归（既有 e2e 专项 keyboard-navigation/wysiwyg-interaction 全绿） |
| 输出 | 搜索态性能面修复 + 命中缓存（步骤 5 的 bench 场景素材之一） |

### 步骤 4：重渲染热点治理（R-04/R-05/R-06，结合 02 的 props/memo 面）

| 项 | 内容 |
|---|---|
| 任务 | ① R-04：`useVirtualScroll.setActual` 在 rAF flush 时与 `manager` 现高度对拍（同值跳过 `manager.setActual`）；`VirtualScrollManager.setActual` 内部高度比较后再 `markDirty`（`VirtualScrollManager.ts:110-124`）——完成态高度稳定的行不再反复重建 offset 缓存；② R-05：`useChatCardState` messages selector 增加 sessionId 短路（非活跃会话变更不重求值）；`snapshotStreamTextToSession`（`helpers.ts:224-237`）同值短路——streamedFullText 与 msg.text 相同时跳过 `updateMessageText`（工具开始调用时文本常未变）；③ R-06：新增「比较器字段清单测试」（MessageVirtualizer 比较器字段数 = 组件 props 数校验，扩展 `MessageVirtualizer.memo.test.tsx`），并随 02 C1 props 聚合落地后收窄比较器面 |
| 文件面 | `useVirtualScroll.ts`、`VirtualScrollManager.ts`、`useChatCardState.ts`、`helpers.ts`、`MessageVirtualizer.tsx`、测试：`useVirtualScroll`/`VirtualScrollManager`/`reRenderMonitoring`/`MessageVirtualizer.memo` 扩展 |
| 依赖 | ③ 的「收窄」部分依赖 02 阶段 C（C1 props 聚合）——本步先落地清单测试与聚合前置（比较器生成/字段提取），02 C1 完成后收窄；② 与 03 状态方案（store 访问边界）无冲突（不改 store 结构，只改订阅表达式） |
| 验证 | ① 单测：同高度 setActual 不触发 actualTick/不 markDirty；sessionId 短路后其他会话 patch 不触发本会话 selector 重求值（subscribe spy）；比较器清单测试：加 prop 忘比较器 → 红；② `reRenderMonitoring`：工具密集会话（20 工具）流式期全链重渲染次数 = 工具事件数（而非帧数）；③ 压测对照 |
| 完成判据 | 工具密集会话流式期全链重渲染次数与帧数解耦；同值 setActual 零重算；比较器清单测试进 CI 快层；既有虚拟列表测试（MessageVirtualizer.perf.test 1500 条）全绿 |
| 输出 | 重渲染热点消除 + 比较器守卫（步骤 5 防线的一部分）；02 C1 的接缝就绪 |

### 步骤 5：perf 基建补浏览器端回归防线（R-13/R-14/R-15 + 小项收尾）

| 项 | 内容 |
|---|---|
| 任务 | ① 前端 bench 场景进 bench 轨（R-14）：`StreamRenderBuffer`（分帧/预算）、`StreamTextBatcher`（合并）、`VirtualScrollManager`（offset 重建）、markdown serializer、timeline 构建——复用 `scripts/compare-benchmarks` 的 threshold 机制（新增 `apps/crish-desktop/perf/` vitest bench 场景 + 与 shared-utils bench 同格式输出）；② Playwright 性能断言 spec（R-14 缺口的核心）：mock SSE 流，rAF 采样帧率 + `PerformanceObserver('longtask')`，断言流式期 ≥45fps 且无 >50ms 长任务、complete 帧 ≤30ms、搜索态流式每帧扫描 ≤1ms；挂在 ci-mid e2e job（或 perf-test.yml 联动）；③ StoreFreq 增强（R-13）：dev overlay 补订阅者数与重渲染范围统计（采样 subscribe 回调计数）；④ R-09：`main.tsx` 补 `reactInteractiveReady` perf 标记（root.render 后首个 rAF 打点）+ `AppErrorBoundary` 与 App chunk 并行预取；⑤ 小项收尾：R-11（onRunError 路径补 `generationMapRef.delete`，`useStreamCallbacks.ts:627-703`）、R-12（EventBus 泄漏单测扩展 memoryLeak）、R-08（`TiptapEditorField` 发送路径大文档（>阈值）先警告 + 序列化防抖窗口末帧预算提示）、R-15（startup-runner 增 Playwright 真实环境档位，阈值与真实首屏对齐） |
| 文件面 | `apps/crish-desktop/perf/`（新建）、`playwright.config.ts`/e2e specs、`.github/workflows/ci-mid.yml`（或 perf-test.yml）、`bootstrapStores.ts`、`main.tsx`、`bootstrap-core.ts`、`useStreamCallbacks.ts`、`TiptapEditorField.tsx`、`tests/startup/`、`memoryLeak.test.tsx` |
| 依赖 | ② 的判据精度依赖 06 P1-1（生产 build 进 CI + e2e preview 模式）——未落地前 perf spec 跑 dev server 并在阈值上留余量（dev 与 prod 渲染行为差异见 ⑥ 风险 3）；R-08 与 06 P2-4（chunk 拆分）无直接依赖 |
| 验证 | 全量门禁：`npm run typecheck` + vitest 全量 + e2e（含新 perf spec）+ bench compare；CI 快层/中层全绿 |
| 完成判据 | perf-test.yml 含前端渲染场景（阈值 + baseline）；Playwright perf spec 在 CI 可重复红绿（人为引入 O(n) 回归 → 红）；R-09 标记在 `__crish_perf` 可查；R-11/12/13/15 各自测试与统计就位 |
| 输出 | 浏览器端回归防线闭环；后续迭代的持续基线 |

---

## ④ perf 回归防线设计

### 4.1 三层防线

| 层 | 工具 | 覆盖 | 时机 |
|---|---|---|---|
| L1 单测 | vitest（reRenderMonitoring / 增量 strip 对拍 / 比较器清单 / setActual 同值） | 增量渲染语义、memo 面、同值 no-op | 快层（提交） |
| L2 bench | `apps/crish-desktop/perf/` + compare-benchmarks（threshold 0.2） | 前端渲染管线模块（batcher/buffer/virtual/序列化/timeline） | perf-test.yml（PR/夜间） |
| L3 浏览器 | Playwright perf spec（rAF FPS + longtask observer + complete 帧计时） | 真实渲染链路（流式/complete/搜索态）端到端 | ci-mid e2e job（PR）→ perf-test.yml 夜间全量 |

### 4.2 关键设计点

- **L3 断言不测绝对值测回归**：FPS/长任务阈值受机器影响，基线存 JSON（步骤 0 产物），CI 断言 = 与基线比值（如长任务数 ≤ 基线 ×1.5、FPS ≥ 基线 ×0.8）——比硬编码阈值稳定；阈值文件允许按机器档位（performanceEngine 的 tier 语义）分档。
- **压测场景统一**：步骤 0 的 mock SSE 场景（100KB + 20 工具）为 L2/L3 共用 fixture，保证各层可比。
- **防线自身防噪**：perf spec 用 `page.clock` 或固定 rAF 采样窗口；CI 运行时并发 job 降级判定（标注 `[perf-flaky]` 与 rerun 策略），避免假红磨灭信任。

---

## ⑤ 新发现补充（读代码时新增，审计未覆盖）

1. **N1（P2）`AsyncMarkdownBlock` 无 `React.memo`**：`MessageContent` 每帧重建 `displayMsg` → 整棵块树（含非流式历史块）每帧重渲染；历史块靠 `useAsyncMarkdownHtml` 缓存同步返回兜住 IPC（`markdownRenderAsync.ts:95-100`），但组件树遍历与 `useEffect(innerHTML)` 依赖比较每帧都在跑。已并入步骤 1 ⑤。
2. **N2（P2）流式文本的 React children 更新是整节点 `textContent` 替换**：即便 store 通道改增量，`<div>{text}</div>` 的 React 文本节点 diff 仍是 O(全文)——「文本节点更新策略」必须走 ref + appendText（本方案 ②-B 的设计依据）；若只改 store 不改 DOM 写入方式，收益为零。
3. **N3（P2）全文三份并存**：流式期间同一段文本同时存在于 `streamedFullText`（`useStreamCallbacks.ts:608`，onChunk 内每 token `+=`）、`StreamRenderBuffer.fullText`、`streamingStore.byKey.text`——R-07 的「双份」实为三份（streamedFullText 仅作 buffer 缺失 fallback 与 commit 兜底用，可改为惰性读取 `buffer.currentText()` 消除其中一份）。
4. **N4（P3）`tokenizeSearchQuery` 每消息重复执行**：`messageMatchesSearch` 内部每次调用都重新 tokenize（`sessionSearch.ts:347`），N 条消息 × 每帧 = N 次 NFKC 预处理（query 本身不变）——并入步骤 3 ① 的预折叠修复。
5. **N5（P3）`messagesIdsKey` join 每次 messages 变化 O(n) 重建**：`ChatMessageList.tsx:156-159` 的 id 签名 join 在搜索态每帧（引用变化）重跑——量级小（窗口 ≤80 条）但可并入步骤 3 ② 的增量缓存统一处理。
6. **N6（P3）complete 后 `stripThoughtPlaceholders` 至少跑 3 遍**：`onComplete`（:799）、`scheduleRunFinalHtml`（`helpers.ts:58`）、`MessageContent` 渲染路径（:70/:119）各一次——同输入全量 regex 重复，可统一为「complete 时算一次，渲染路径读缓存」（并入步骤 2 主块瘦身）。

---

## ⑥ 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | **阶段 1 只做纯文本增量、不复活 HTML 增量解析** | 流式期无法就地预览代码高亮等富样式（现状已是纯文本，无行为回退）；若未来要流式富预览需引入 JS 增量解析器双轨 | 本方案明确记录为「阶段 2 可选增强」，触发条件（用户可感知的流式富预览需求）与评估项（JS/Rust 渲染双实现漂移成本）写入提案；01/02 样式方案不依赖流式富渲染 |
| 2 | **增量窗口 strip 与全量 strip 语义漂移** | 流式期与完成态显示不一致（占位行/总结标题残留或过度剥离） | 对拍测试用同一 fixture 集（含 CJK、占位行、总结标题、空行边界）强制等价；偏差仅允许在「流式期尾部窗口」内出现且 complete 后自动收敛 |
| 3 | **perf spec 跑 dev server 的偏差**（06 P1-1 未落地前） | L3 断言在 dev（无 minify、无 chunk 拆分）下测不出生产态真实性能 | 阈值按 dev 留余量 + 基线同环境同机器采集；06 P1-1 落地后切 production preview 模式并重采基线（显式登记依赖） |
| 4 | **步骤 1 与 02 C1 同文件冲突**（`MessageContent.tsx`/`ChatMessageList.tsx`） | 并行改造成本高、合并冲突 | 调度上同文件串行：先合本方案步骤 1/3，02 C1 在其后；或 02 的 props 聚合仅保留到 `ChatMessageList` 消费面（聚合对象 + 解构），不触碰 `MessageContent` 内部 |
| 5 | **步骤 3 命中缓存的失效时机** | 缓存键（query + messages 引用）若漏失效面（如 toolCalls 字段变化但引用未变——immer 下不会发生）会导致搜索命中残留 | 缓存与 `messageMatchesSearch` 共享同一求值函数；失效断言单测覆盖 query 变更 / 消息增删 / 工具状态终态三条路径 |
| 6 | **complete 分帧后 isFinal 语义延迟** | 残余多时 isFinal 帧晚 1-2 帧到达，`commitStreamToSession` 的文本来源（`getStreamText` 优先）仍取全文，不受影响；仅流式态切完成态视觉延迟 ≤2 帧 | 残余 ≤2 帧直接刷完（主路径，延迟 0）；大量残余（异常积压）时接受分帧并在 commit 前确保 buffer 余量已出完（commit 兜底 `buffer.currentText()` 已含 pending，`useStreamCallbacks.ts:720-726`） |
| 7 | **R-05 会话级订阅短路改变跨会话行为** | 非活跃会话的 agent 事件（`onSubagentEvent` immer patch）当前会触发所有 ChatCard selector 求值——短路后仅活跃会话受影响，视觉无变化，但依赖「activeSessionId 恒与渲染中的 ChatCard 一致」的既有假设 | 短路实现前先确认 `useChatCardState` 的 activeSessionId 来源与多 Tab 场景语义（现状多会话多 Tab 已在 R-05 中被判定为浪费而非功能依赖） |

---

## 附：与 02/06 方案依赖关系汇总

| 本方案步骤 | 依赖 02 | 依赖 06 | 说明 |
|---|---|---|---|
| 步骤 1（流式增量） | 无阻塞（同文件串行纪律） | 无 | `MessageContent.tsx` 与 02 C1 同文件串行 |
| 步骤 2（complete 收口） | 无 | 无 | 独立 |
| 步骤 3（搜索态） | 无阻塞 | 无 | `ChatMessageList.tsx` 同文件串行（先步骤 1） |
| 步骤 4（重渲染热点） | **C1 props 聚合（收窄比较器）**；02 E1 虚拟列表引擎与 R-04 共享 `useVirtualScroll` 面 | 无 | 清单测试先行，收窄等 02 C1 |
| 步骤 5（perf 防线） | 无 | **P1-1 生产 build 进 CI + e2e preview**（L3 精度）；P2-4 chunk 拆分（间接，渲染路径受益） | 06 未落地前 L3 跑 dev 留余量 |

> 04 方案的高亮接线（`streamingCodeHighlighter` 改走 Rust）与本方案「流式期零 IPC」约束方向相反（步骤 1 目标是把主线程渲染成本降到 O(增量)，高亮属于可延迟到 complete 后由 Rust 渲染承载的工作）——04 接线应**在步骤 1 完成、流式纯文本路径定稿后**再评估，避免流式期引入每帧 IPC（登记为 04-07 交叉决策点）。
