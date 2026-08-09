# 前端性能与渲染效率审计（apps/crish-desktop）

- 审计日期：2026-08-09
- 审计范围：React 19 + zustand 5 + tiptap 3 + xterm 6 + 自研虚拟列表（MessageVirtualizer / VirtualScrollManager）
- 审计方式：只读源码 + 实读证据（文件:行号），无运行时实测数据（见 §7 诚实边界）
- 已知线索复核：props drilling（ChatCard / MessageVirtualizer 40+ props ✅ 确认）、巨型组件 ModelConfigEditor 869 行 ✅ 确认、store 订阅粒度 ✅ 总体良好但有结构性问题

---

## ① 渲染性能

### 1.1 虚拟列表实现（MessageVirtualizer + VirtualScrollManager）— 实现质量高

**正确性要点（实读确认）：**

- **以 messageId 为键的高度缓存**：`VirtualScrollManager` 内部 `heightsById = Map<string, {estimated, actual}>`（`apps/crish-desktop/src/api/VirtualScrollManager.ts:32`），`syncOrder(ids)` 全等快路径跳过（同文件 :57-66），`clear()` 时 generation 递增防过时回写（:158-166）。
- **offset 惰性缓存 + 二分查找**：`rebuildOffsets` O(n) 重建、`findIndexAtOffset` O(log n)（:246-260、:219-237），`computeVisibleRange` 带 overscan（:191-213）。
- **key 稳定性**：虚拟行 key = `msg.id`（`apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx:330`、:350），ResizeObserver 用 `data-vindex={msg.id}` 做稳定键（同文件 :143-147）——「流式与 final 共用同一行 id」的 C2 约定（:316 注释）是正确设计。
- **RO 回写走 rAF 批量**：`setActual` 先入 `pendingActualRef`，单帧内多次 RO 回调合并一次 flush（`apps/crish-desktop/src/hooks/useVirtualScroll.ts:141-160`）。
- **滚动事件 rAF 合并**：`onScroll` 只记录 scrollTop，rAF 统一 setState（useVirtualScroll.ts:121-129）。
- **行级 memo 隔离**：`assistantRowPropsEqual` 逐字段比较（`apps/crish-desktop/src/components/chat-message-row/ChatAssistantMessageRow.tsx:53-91`）；`MessageVirtualizer` 自写 40 字段比较器（MessageVirtualizer.tsx:398-460）；`ChatMessageList` React.memo（`apps/crish-desktop/src/components/chat-message-list/ChatMessageList.tsx:327`）。
- **尾部窗口**：默认只挂载最近 80 条（`DEFAULT_RECENT_MESSAGE_COUNT = 80`，`apps/crish-desktop/src/api/messageWindow.ts:50`），`windowMessages` 纯函数切片（:90-142），待审批/pin/搜索命中自动抬升窗口（:163-186）。
- **思考秒数计时**：ThinkingTimer 行内自管，不经列表 props 重渲染（ChatAssistantMessageRow.tsx:57-58 注释）。
- **流式期间不 invalidate 高度**：`useEffect` 在 processing 时跳过 `invalidateActual`，避免每 token 布局失效（ChatAssistantMessageRow.tsx:170-173）。

### 1.2 局限与风险

- **R-04（P2）同值 setActual 仍触发全列表重算**：`setActual` 无同值去重，RO 每次回调（即使高度没变）都进 pending → rAF flush → `setActualTick(t+1)` → `visibleRange`/`totalHeight` 两个 useMemo 全列表重算（useVirtualScroll.ts:105-116、145-160）。流式期间每帧高度都在变，全列表重算是必要的；但**完成态后高度稳定的行**仍会因 RO 触发的重复回调反复 tick。`VirtualScrollManager.setActual` 内部同样无「同值跳过」（VirtualScrollManager.ts:110-124），连续同高度写入会重复 `markDirty` → offset 缓存重建。
- **R-05（P2）会话 store 任何变更 → 全链重渲染**：`MessageVirtualizer` 比较器最后一条是 `prev.messages !== next.messages` 即放行（MessageVirtualizer.tsx:436-438）。immer 下对 session 内任何 message 的修改都会产生新 messages 数组引用（`sessionMessageActions.ts:143-179` `updateMessageText` 等 + `rebindSessionById`，`sessionIndex.ts:145-159`）→ ChatCard → ChatMessageList → MessageVirtualizer 全链重渲染（行级 memo 兜底，频率 = 工具快照/审批/commit，非每 token）。
- **R-06（P2）手写比较器漂移风险**：MessageVirtualizer 比较器有 40 个字段（MessageVirtualizer.tsx:398-460），新增 prop 若忘加比较器 → 恒 false → 每帧全量重渲染，无测试守卫（`MessageVirtualizer.memo.test.tsx` 存在但覆盖面有限）。
- **Props drilling 确认**：MessageVirtualizer 45 个 props（:28-74）、ChatMessageList 25 个 props（`ChatMessageList.tsx:33-65`）、ChatCard 经 `useChatCardState` 收口但向子组件透传 30+ 参数（`apps/crish-desktop/src/components/chat-card/ChatCard.tsx:172-197`）。`toolStackProps` 聚合对象每次 useMemo 依赖变更即重建（`apps/crish-desktop/src/components/chat-message-list/useChatMessageState.ts:269-300`），靠 `toolStackSharedPropsEqual` 兜底。
- **搜索激活时的每帧全量扫描（R-02，P1）**：搜索激活后 `windowScanKey = messages`（ChatMessageList.tsx:160-161）→ 流式期间每帧（48ms batcher + rAF flush）都跑 `collectMustIncludeIndices` + `resolveExpandedForKeepAlive` 的 O(n) 全量扫描（:163-186），且 `messageMatchesSearch` 含 NFKC normalize + 全字段匹配（`apps/crish-desktop/src/api/sessionSearch.ts:345-358`、:70-81）。消息量大时是每帧长任务。搜索未激活时用 id 签名 memo 做了正确隔离（ChatMessageList.tsx:156-159），这是好设计，仅搜索态退化。

### 1.3 memo/useMemo/useCallback 使用面评估

- **合理面**：ChatCard 整体 React.memo（ChatCard.tsx:32）；`useChatCardState` 的 9 个 selector 全部 useCallback 包裹（`useChatCardState.ts:63-131`）；`jumpToPinned` 用 ref 桥接保持身份稳定防流式期间击穿 memo（`useScrollAnchor.ts:67-78`）——这是教科书级正确用法。
- **无滥用**：未发现「memo 阻碍更新」的反模式；`visibleMsgIds`/`pinnedIdSet` 等 useMemo 依赖正确。
- **风险仅在于比较器维护成本**（R-06）。

---

## ② store 订阅粒度

### 2.1 整体面：无整 store 裸订阅（✅）

grep 全库未发现 `useLayoutStore()` 无 selector 调用面；`useSessionStore` 全部经 `useSessionField`/`useShallow`（`apps/crish-desktop/src/store/sessionStore.ts:70-74`）。侧栏用 `sidebarSessionsEqual` 拦截消息正文变化（sessionStore.ts:76-101），`useActiveSession`/`useSessions` 用 `useShallow`（:103-113）。

### 2.2 streamingStore：订阅者极窄（✅ 优秀）

- 高频热路径 store 为纯 zustand（无 immer），全文覆盖写（`apps/crish-desktop/src/store/streamingStore.ts:129`）。
- **同值 no-op 覆盖度**：`setStreamText`（:135）、`setStreamThinking`（:152）、`setStreamTool`（:175 经 `toolLiveEqual` :115-127）、`setStreamImages`（:196）、`updateStreamImage`（:229）——五处全部有同值拦截，覆盖度高。
- **订阅者仅 2 处**：`MessageContent`（`apps/crish-desktop/src/components/chat-message/MessageContent.tsx:47-54`，useShallow 单次订阅 text+tools）、`ChatAssistantMessageRow`（:126-129，仅 thinking）。byKey 整体替换对象（`...state.byKey, [key]: {...}`）会通知全部订阅者，但订阅者总量小，通知成本可控。
- **思考与正文分通道订阅**（S4.4 设计）：正文在 MessageContent、thinking 在 Row，互不 thrash（MessageContent.tsx:44-46 注释）。

### 2.3 结构性问题（R-05 相关）

- **layoutStore 是 god-object**：sessions 挂在 layoutStore 上（`sessionStore.ts:5-8` 明示 "intentional residual"）。所有 session 域变更共享同一订阅面——`useChatCardState` 的 messages selector（`useChatCardState.ts:69-77`）在**任何** session 变更（含其他会话、agent 事件 `onSubagentEvent` 的 immer patch，`useStreamCallbacks.ts:487-497`）时重新求值。多会话多 Tab 场景下，非活跃会话的更新也会触发所有 ChatCard 的 selector 求值（zustand selector 求值本身轻，但 messages 数组引用比较失败 → 全链重渲染）。
- **频率量化**：流式 token 热路径被 streamingStore 完全隔离（每 token 只碰 byKey，见 §3）；但**工具切换/审批/快照**会写 session store：`snapshotStreamTextToSession` 每次工具开始调用 `updateMessageText`（`apps/crish-desktop/src/hooks/chat-stream/helpers.ts:224-237`）→ messages 新引用 → 全链重渲染。工具密集会话（几十个工具）该路径频率不低。
- **StoreFreq 覆盖面**（R-13，P3）：只统计各 store 60s 更新次数（`apps/crish-desktop/src/store/bootstrapStores.ts:26-44`），且 `NODE_ENV !== 'development'` 直接 return（:27）——无订阅者数量、无重渲染范围统计，无法回答「一次 set 触发多少组件重渲染」。

---

## ③ 流式渲染管线

### 3.1 管线总览（实读确认）

```
SSE onChunk → StreamRenderBuffer.push(delta)          useStreamCallbacks.ts:604-616
             → rAF flushFrame（6ms / 8192B 帧预算）     StreamRenderBuffer.ts:146-208, 241-279
             → onFrame → setStreamText(byKey, frame.full)  useStreamCallbacks.ts:293-300
             → streamingStore 同值拦截 → MessageContent 订阅
             → applyStreamTextToMessage + buildAssistantTimeline（渲染路径同步） MessageContent.tsx:56-68
```

### 3.2 StreamRenderBuffer 正确性（✅ 良好）

- `flushFrame` 纯函数单实现，预算/字节双约束正确（StreamRenderBuffer.ts:241-279）；UTF-16 代理对安全截断 `safeUnicodeCutPosition`（:221-230）；积压降级 `degraded` 帧（:189）；final 语义（:195）；F5-06 根因修复说明（:164-168）。纯函数测试锁定（`StreamRenderBuffer.test.ts`、`StreamRenderBuffer.framing.test.ts`、`stressFuzzing.test.ts:70`）。

### 3.3 缺陷与风险

- **R-03（P1）渲染管线「增量承诺」未兑现——实际是「48ms 节流的全量重渲染」**：
  - `frame.html` 恒为 `''`（StreamRenderBuffer.ts:197，注释 :15-17 明示解析器尚未接入）→ `chunkUpdates` 恒空（:198）；
  - onFrame 只做 `setStreamText(sid, assistantMsgId, frame.full)`（useStreamCallbacks.ts:298）——**全量文本**每帧写入；
  - MessageContent 每帧执行 `applyStreamTextToMessage`（全量合并）→ `buildAssistantTimeline(displayMsg)`（`apps/crish-desktop/src/api/toolPresentation.ts` 入口，MessageContent.tsx:68）→ 同步 strip（`markdownRenderLite.ts:35`）——全部在主线程渲染路径上，文本越大每帧成本越高（>100KB 时每帧同步重算 timeline 数毫秒级）。
  - 结论：rAF/帧预算只限制了 **set 频率**，没有实现增量解析/增量 DOM patch；设计文档中的 IncrementalMarkdownParser 是 D0 residual（`AsyncMarkdownBlock.tsx:24` 注释 "已删除路径：IncrementalMarkdownParser / Bridge / domPatch"）——管线退化为「流式期纯文本 + 全量重建」，需要接受或重新评估。
- **R-01（P1）complete 单帧全量 flush**：`buffer.push('', true); buffer.flush(true);`（useStreamCallbacks.ts:716-718）→ force 路径无视预算单帧输出全部（StreamRenderBuffer.ts:95-102、:164-208）→ 大文本（>100KB）complete 瞬间：一帧内全量 setStreamText → MessageContent 全量 timeline 构建 + Rust md_render IPC（`scheduleRunFinalHtml` → `parseMarkdownToHtmlAsync`，helpers.ts:53-74）→ 完成瞬间卡顿窗口（与用户「输出到一半停一下再出最终版」的体感一致）。
- **R-08（P2）serializeToMarkdown 150ms 防抖是全量同步序列化**：`onUpdate` 防抖 150ms 后 `serializeToMarkdown(editor.getJSON())`（`apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx:172-182`）；`getJSON()` 本身是深拷贝 + 递归序列化（`markdownSerializer.ts:218-230`）。防抖防止了连续输入卡顿，但**大文档（粘贴/长文）在防抖窗口结束时的一帧仍是全量同步长任务**。发送路径 `getMarkdownSync()` 绕过防抖立即全量序列化（TiptapEditorField.tsx:479）——发送瞬间大文档同步序列化，属可接受但需知晓的面。
- **双通道频率不一致（观察项，非缺陷）**：text 走 rAF（~16ms 帧）、thinking 走 48ms 定时 batcher（`useStreamBatchers.ts:51`、:67）、tool 走 48ms（:106）——思考与正文更新节奏不同，属设计意图（思考比正文便宜）。

### 3.4 大文本（>100KB）路径

- 流式期：纯文本 div + caret，零 IPC（`AsyncMarkdownBlock.tsx:51-61`）✅；
- 完成态：Rust `md_render` 走 spawn_blocking（`markdownRenderAsync.ts:37-43`），主线程不阻塞 ✅；LRU 缓存带条目/字节双预算 + memoryManager 注册（`markdownCache.ts:32-36`、:271），1MiB 单条上限（:20）✅；
- 残余面：`el.innerHTML = html`（AsyncMarkdownBlock.tsx:45）大 HTML 写入后的布局重排；缓存键 = 完整正文（markdownCache.ts:75-79）→ 大文本缓存条目本身占用预算，命中率低。

---

## ④ 启动性能

### 4.1 时序链路（实读确认）

```
main.tsx startup
  ├─ Phase 0: await import(bootstrap-orchestrator).ready   main.tsx:15
  │     configService.init + registerConfigSchemas + serviceRegistry.startAll  bootstrap-orchestrator.ts:5-20
  ├─ Phase 1: await import(bootstrap-core)                  main.tsx:19
  │     initPerformanceAttributes + 并行(detectPlatform / initMinimalPool / loadMinimalConfig+OAuth)  bootstrap-core.ts:6-39
  ├─ Phase 1.5: 动态 import react / react-dom / App        main.tsx:40-63
  ├─ 渲染: await import(AppErrorBoundary) 后 root.render     main.tsx:72-80
  └─ Phase 2: requestIdleCallback(2s 超时) 后台 bootstrapFull main.tsx:92-101
        ensureEngineConnected + getSettings + fetchCatalogSnapshot + scaleUpPool  bootstrap-full.ts:4-36
```

### 4.2 优点（✅）

- 骨架屏由 index.html 内联，createRoot 前无白屏（main.tsx:69-70 注释）；
- 懒加载覆盖面好：CardPanelLayout 6 面板（`apps/crish-desktop/src/components/card-panel/CardPanelLayout.tsx:21-36`）、SettingsPanel 11 tab（`SettingsPanel.tsx:27-57`）、TreeLeafPanel 7 面板（`TreeLeafPanel.tsx:34-52`）、ChatCard 内 ScheduledTasksPanel（ChatCard.tsx:13-17）、MessageToolCallsSection 内 InlineAgentPanel（`MessageToolCallsSection.tsx:12`）；
- bootstrap-full 非阻塞 + 失败不阻断（main.tsx:93-96）；
- Worker 池两级初始化：core 只建最小池、idle 后 scaleUpPool（bootstrap-core.ts:22-25、bootstrap-full.ts:32-33）。

### 4.3 问题

- **R-09（P2）首屏 import 链串行 + 无渲染完成标记**：
  - Phase 0 → Phase 1 → Phase 1.5 全串行 await（main.tsx:15、:19、:45-51），每步一个 chunk 网络往返；
  - `AppErrorBoundary` 在 `root.render` **前**单独 await（main.tsx:72-80）→ 首屏渲染被该 chunk 加载阻塞一拍（React 已加载完、App 已加载完，但 boundary chunk 未到就 render 不了）；
  - perf 标记只有 `orchestratorReady / coreReady / fullReady / firstPaint`（bootstrap-orchestrator.ts:18、bootstrap-core.ts:38、bootstrap-full.ts:35、main.tsx:104-107）——**没有 React 首帧渲染完成（interactive）标记**，`window.__crish_perf` 无法回答「App 何时可交互」。
- **字体加载（✅ 影响小）**：fontsource 按偏好**按需**动态 import，仅 latin-400 子集（`apps/crish-desktop/src/api/fontStore.ts:363-394`），非首屏强制路径；`ensureFontsLoaded` 只 await `document.fonts.ready`（:406）不阻塞渲染。中文走系统回退栈（:366 注释）。
- **R-15（P3）startup-runner 代表性有限**：测量对象是 Node 子进程 spawn（`tests/startup/startup-runner.ts:93-100`），非 Tauri/浏览器真实环境，skeleton/interactive/full 阈值与真实首屏体验脱节。

---

## ⑤ 长任务/卡顿面

### 5.1 已规避的面（✅）

- **Markdown 渲染**：Rust `md_render`（spawn_blocking）优先，worker highlight.js 仅 fallback（markdownRenderAsync.ts:37-48）；流式期零 IPC（AsyncMarkdownBlock.tsx:33-38）；
- **代码高亮**：highlight.js 同步入口带 LRU + 内存预算（`apps/crish-desktop/src/api/codeHighlight.ts:123-152`），`IncrementalInlineRenderer` 行级 FIFO 缓存（`markdown-render/IncrementalInlineRenderer.ts:30`、:177-187）；
- **树遍历**：layout-tree operations 已从 O(N²) 优化为 O(N)（`apps/crish-desktop/src/store/layout-tree/operations.ts:1021` 注释）；
- **xterm**：WebglAddon 渲染（`TerminalCard.xterm.tsx:194-205`）、scrollback 5000（:182）、拖拽降采样（:405 注释）、终端行缓冲硬上限 800（`apps/crish-desktop/src/store/layout-helpers/diff-selectors.ts:13-16`）；
- **窗口化扫描**：非搜索态下 `collectMustIncludeIndices` 用 id 签名 memo（ChatMessageList.tsx:156-171）。

### 5.2 长任务风险点

- R-01（complete 全量 flush）、R-02（搜索态每帧扫描）、R-03（流式期主线程全量 timeline 构建）、R-08（序列化全量）见 §1/§3 详述。
- **R-10（P2）单条超长消息的渲染成本**：`buildAssistantTimeline` 与 `stripThoughtPlaceholders` 在 MessageContent 每次渲染同步执行（MessageContent.tsx:67-70、:119-120），无 memo（displayMsg 每帧因 streamText 变化重建，:56-65）——单条 100KB+ 消息（长代码块/长日志输出）在流式期每帧全量重跑，且 `AsyncMarkdownBlock` 完成态 innerHTML 写入后无行内缓存再渲染。
- **无限循环风险评估（✅ 未发现高危）**：
  - `useChatAutoScroll` effect 依赖 `[messages, isProcessing]`，内部 rAF 合并（`useChatAutoScroll.ts:36-81`），setState 只发生在 handleScroll（被动）；无 setState→effect→setState 环；
  - `visibleRange`/`totalHeight` useMemo 依赖 `actualTick`，setActualTick 仅在 RO 回调后发生，RO 在高度稳定后不再触发 → 收敛（但见 R-04 同值浪费）；
  - `useScrollAnchor`/`useChatMessageState` 全部 ref 桥接，无渲染期写 store 的副作用。

---

## ⑥ 内存面

### 6.1 事件订阅泄漏（✅ 总体良好）

- `onUiEvent` 返回幂等 off，`useChatCardState` 的 6 个订阅全部在 cleanup 中卸载（`useChatCardState.ts:153-181`）；`onUiEvents` 批量卸载（`apps/crish-desktop/src/api/uiEvents.ts:246-273`）；
- EventBus 有 MAX_LISTENERS_WARN=10 警告（`apps/crish-desktop/src/services/EventBus.ts:85-87`）；
- **R-12（P3）无自动清理**：EventBus 只是 `console.warn`，不提供按 source 批量卸载、不驱逐泄漏者；`memoryLeak.test.tsx` 用 subscribe spy 只覆盖 zustand 层（`apps/crish-desktop/src/__tests__/memoryLeak.test.tsx:131-135`），EventBus/`sessionSearch` listeners Set（`sessionSearch.ts:560`）不在测试面内。

### 6.2 大对象常驻（R-07，P2）

- **双份大文本**：流式期间同一条消息的全文同时存在于 streamingStore `byKey`（streamingStore.ts:30-39）与 `StreamRenderBuffer.fullText`（StreamRenderBuffer.ts:37）；`commitStreamToSession` 后 streamingStore 条目清理（helpers.ts:213-216），但**多会话并行流式时 N 会话 × 2 份全文**常驻；
- **消息全文缓存**：session store 持久保存 messages 全文（god-object 单份），加上 `precomputedHtml`（sessionMessageActions.ts:148-153）——单条大消息 HTML 缓存由 markdownCache LRU 预算约束（markdownCache.ts:32-36）；
- **R-11（P3）generationMapRef 残留**：`generationMapRef` 在 complete 时 delete（useStreamCallbacks.ts:860）、stop 时 delete（:1014），但 **onRunError 路径无 delete**（:627-703 区间无清理调用）→ 多次 run error 的会话在 Map 中留条目（每会话一个整数，量级小但无界）。
- **SessionStreamManager 收口良好**：`clearSession`/`dispose` 幂等清理 streams/draining/goalCancelled（`sessionStreamManager.ts:156-175`）；
- `pendingRenders` Map `.finally` 必删（markdownRenderAsync.ts:50）✅；
- MessageVirtualizer 的 RO disconnect + observedRowsRef 清空（MessageVirtualizer.tsx:170-178）✅；
- 图片：`loading="lazy"`（MessageContent.tsx:142）+ 流式图片 ref 状态机（streamingStore.ts:212-243），未见显式 blob URL 回收——图片由引擎侧管理，未深查（诚实边界）。
- **产物体积**：`perf-report/stress-result.json` 79MB（2026-08-08）落盘工作区，靠 .gitignore 覆盖（knip.config.ts:16 注释），非泄漏但属磁盘卫生。

---

## ⑦ 性能测试与基准（perf 基建）

### 7.1 已覆盖面（✅）

| 层 | 内容 | 证据 |
|---|---|---|
| 基准 | 14 个 shared-utils 场景（LruMap/BoundedMap/jsonl/deep-equal/mutex/ring-buffer/clone/diff.parse/session.serialize/cache.*） | `packages/shared-utils/src/bench/bench-definitions.ts:78-312` |
| 内存 | mem-benchmarks（heap delta + 泄漏监听器） | `packages/shared-utils/src/bench/run-mem-benchmarks.ts:19` |
| 回归 | compare-benchmarks `--threshold 0.2` + baseline | `scripts/compare-benchmarks.ts:58-113` |
| CI | perf-test.yml：benchmark→stress→compare→acceptance→PR 评论 | `.github/workflows/perf-test.yml:10-137` |
| 压力 | stress-runner（AI 流/diff/会话切换 + verify 不变式钩子） | `tests/stress/stress-runner.ts:57-95` |
| 启动 | startup-runner（skeleton/interactive/full 三阈值） | `tests/startup/startup-runner.ts:5-38` |
| 前端单测 | reRenderMonitoring（重渲染计数/隔离）、memoryLeak（subscribe spy）、MessageVirtualizer.perf.test（1500 条窗口化）、StreamRenderBuffer 全测试、stressFuzzing | `src/__tests__/reRenderMonitoring.test.tsx:1-120`、`MessageVirtualizer.perf.test.tsx:127-151` |
| 运行期诊断 | StoreFreq（dev-only 60s 计数）、`__crish_perf` bootstrap 标记、performanceEngine FPS 探测 | `bootstrapStores.ts:26-44`、`performanceEngine.ts:33-54` |

### 7.2 缺口（R-14，P3）

1. **基准与前端渲染管线零交集**：14 个 bench 场景全部是 shared-utils 工具函数，**没有一个覆盖** StreamRenderBuffer / VirtualScrollManager / MessageVirtualizer / markdown serializer / batcher / timeline 构建——前端渲染回归不会在 CI perf 轨上暴露；
2. **无浏览器端性能轨**：无 Playwright 性能断言（FPS/长任务/LCP/TTI），`test:e2e` 与 perf-test.yml 未联动；
3. **无 bundle-size 门槛**：无 size-limit 类守卫，懒加载收益无法量化；
4. **Startup 测量非真实环境**（R-15）；
5. **StoreFreq dev-only**（R-13）；
6. **诚实边界**：本文档所有严重度判断基于静态代码分析，无浏览器实测数据佐证；P1 项建议用 Performance trace / longtask API 实测确认后再排期。

---

## ⑧ 严重度分级清单（P0–P3）

### P0（明显卡顿/掉帧，需实测确认）

**无静态证据充分的 P0。** 热路径（每 token）已被 streamingStore 隔离，未发现「每 token 全树重渲染」类硬伤。接近 P0 的是 R-01/R-03 的组合效应（大文本流式期间 + 完成瞬间的主线程长任务），归 P1 并建议实测量化。

### P1（高概率可感知卡顿）

| # | 风险 | 证据 | 建议 |
|---|---|---|---|
| R-01 | complete 单帧全量 flush：`push('',true)+flush(true)` 无视预算一帧输出全部，大文本完成瞬间主线程长任务（setStreamText 全量 + timeline 全量 + md_render IPC） | useStreamCallbacks.ts:716-718；StreamRenderBuffer.ts:95-102 | force flush 前按 budget 分帧 + 最后一块也走 maxBytesPerFrame；或 complete 路径先 commit session（走 Rust 渲染）再清 streaming，避免同帧双重全量 |
| R-02 | 搜索激活时流式期间每帧 O(n) 全量扫描（collectMustIncludeIndices + resolveExpandedForKeepAlive + messageMatchesSearch） | ChatMessageList.tsx:160-186；sessionSearch.ts:345-358 | 搜索态下窗口扫描降到节流（如 500ms）或增量位图；搜索命中仅需首个命中，可提前短路 |
| R-03 | 渲染管线退化为「48ms 节流的全量重渲染」：frame.html 恒空、onFrame 写全量文本、渲染路径同步 buildAssistantTimeline+strip | StreamRenderBuffer.ts:197-198；useStreamCallbacks.ts:298；MessageContent.tsx:56-68 | 要么接受现状并在大文本时降频（frameBudget 自适应），要么恢复增量解析（IncrementalMarkdownParser，D0 residual 重新评估） |

### P2

| # | 风险 | 证据 | 建议 |
|---|---|---|---|
| R-04 | setActual 无同值去重，RO 重复回调触发 actualTick → 全列表 visibleRange/totalHeight 重算；VirtualScrollManager.setActual 同高度仍 markDirty 重建 offset 缓存 | useVirtualScroll.ts:145-160；VirtualScrollManager.ts:110-124 | pendingActualRef 同值跳过 + setActual 内高度比较后决定是否 markDirty |
| R-05 | 会话 store 任何变更（工具快照/审批/subagent 事件）→ ChatCard→MessageVirtualizer 全链重渲染（messages 引用比较）；非活跃会话更新也波及所有 ChatCard | useChatCardState.ts:69-77；MessageVirtualizer.tsx:436-438；useStreamCallbacks.ts:487-497、549-590 | 拆分会话级订阅（按 sessionId selector 短路）；snapshotStreamTextToSession 合并/节流 |
| R-06 | 手写 40 字段 memo 比较器漂移风险（新增 prop 忘加 → 每帧全量重渲染） | MessageVirtualizer.tsx:398-460；ChatAssistantMessageRow.tsx:53-91 | 比较器字段清单 + 组件 props 数量对齐测试（reRenderMonitoring 扩展）；或收窄 props 面 |
| R-07 | 流式期间双份大文本常驻（streamingStore byKey + buffer.fullText），多会话并行翻倍 | streamingStore.ts:30-39；StreamRenderBuffer.ts:37 | complete/cancel 确定性清理链已存在；补充「切换会话即 clearSession」审计与压力用例 |
| R-08 | serializeToMarkdown 150ms 防抖后仍是全量同步序列化（getJSON 深拷贝 + 递归），大文档/粘贴的窗口末帧长任务；发送路径同步全量 | TiptapEditorField.tsx:172-182、:479；markdownSerializer.ts:218-230 | 发送路径改 worker 或分片；粘贴超大文档先警告 |
| R-09 | 首屏 import 链串行（Phase0→1→1.5 逐 await）+ AppErrorBoundary 单独 await 阻塞 render + 无 React 首帧完成 perf 标记 | main.tsx:15-63、:72-80 | boundary chunk 与 App 并行预取；补 `reactInteractiveReady` 标记 |
| R-10 | 单条超长消息流式期每帧同步 timeline 构建 + strip，无内容级 memo | MessageContent.tsx:56-70、:119-120 | displayMsg 按 streamText 增量短路；长消息渲染走 worker/节流 |

### P3

| # | 风险 | 证据 | 建议 |
|---|---|---|---|
| R-11 | generationMapRef 在 onRunError 路径未 delete，run error 会话残留条目 | useStreamCallbacks.ts:219、:860、:1014（error 分支 :627-703 无清理） | onRunError 收口处补 delete |
| R-12 | EventBus 监听器 >10 仅 warn，无自动驱逐/按 source 批量卸载；sessionSearch listeners Set 无泄漏测试 | EventBus.ts:85-87；sessionSearch.ts:560-575 | 补 EventBus 泄漏单测（memoryLeak 扩展） |
| R-13 | StoreFreq dev-only + 无订阅者/重渲染范围统计 | bootstrapStores.ts:27 | 生产构建下采样统计或 DevHealthOverlay 增强 |
| R-14 | perf bench 不覆盖前端渲染管线；无浏览器端性能回归防线 | bench-definitions.ts:78-312；perf-test.yml | 增加前端 bench 场景（batcher/虚拟滚动/序列化）+ Playwright longtask 轨 |
| R-15 | startup-runner 为 Node 子进程测量，非真实浏览器/Tauri 环境 | startup-runner.ts:93-100 | 用 Playwright/WebDriver 测真实首屏 |

---

## 附：风险点统计

- 共 **15 个风险点**：P0 0 / P1 3 / P2 7 / P3 5
- 亮点项：streamingStore 同值拦截全覆盖、虚拟列表 id 键高度管理、streaming 订阅者极窄（2 处）、memo/ref 桥接使用规范、Rust 渲染主线程零解析、懒加载覆盖广。
