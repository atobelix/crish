# 10 — Stage 10（冷启动链路与构建拆包）与 Stage 01（状态管理与重渲染）独立架构详案

> **方案编号**：`10-agent10-stage10-1`  
> **负责人**：Agent-10（冷启动水合与全局状态拓扑架构专家）  
> **覆盖阶段**：Stage 10（冷启动链路与构建拆包优化）& Stage 01（状态管理与重渲染优化）  
> **权威依据**：`docs/frontend-performance-revamp/00-总方案-前端全栈性能重构与最先进单轨收敛总规划.md`、`00-DISCIPLINE.md`、`.agents/LOGIC_PLAN_NO_RETREAT.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`。  
> **核心战略铁律**：最先进单轨代码落地、零无谓伪兼容、全链路 120fps、TTI ≤ 120ms、物理拆分与纯逻辑推进。

---

## 方案导言与架构师使命

作为 **Agent-10（冷启动水合与全局状态拓扑架构专家）**，本方案承接两项关乎整个前端生命周期起点与核心数据流转命脉的重构重任：

1. **Stage 10（冷启动链路与构建拆包优化）**：主宰应用从首字节解析到首帧绘制（LCP < 80ms）、从静态骨架到完全可交互（TTI ≤ 120ms）的全生命周期时序收敛，根治首屏白屏断层、pre-hydration 死点击与磁盘慢响应下的数据冲刷丢失，重构 Vite 动态拆包管线使静态图 JS 合计体积压降至 ≤ 900 KiB。
2. **Stage 01（状态管理与重渲染优化）**：主宰会话核心数据拓扑，彻底打破会话元数据（`metaById`）与超万级消息树（`messagesBySessionId`）的同体粘连，确立标量版本代数槽位（Epoch Slots）与直接寻址选择器，达成 100 Token/s 流式推流下非活跃视图 0 重渲染、单消息变动 0 对象深克隆，统一 300ms 持久化防抖。

本方案严格践行**反退避原则**与**反过度设计红线**，只论逻辑依赖、数据不变量、物理状态机与可验证断言，杜绝用工期和困难作为借口，坚决拔除一切伪兼容补丁层。

---

# 第一部分：Stage 10 — 冷启动链路与构建拆包优化实施方案

## 1.1 现状深度审查与核心架构断层（文件行号级证据）

对现有冷启动链路（`index.html`、`loader.js`、`entry-core.tsx`、`UnifiedAppHydrationCoordinator.ts`、`store-persistence.ts` 及 `vite.config.ts`）进行行级审查，发现以下四项严重影响性能与数据安全的架构断层：

### 痛点 1：首屏骨架静态度严重不足与认知白屏断层

- **源码位置**：`apps/crish-desktop/index.html:22-44` 与 `public/loader.css:62-85`
- **现状缺陷**：当前 `index.html` 的 `#root` 内部仅内联了一个极其简陋的居中旋转 SVG 动画卡片（`.app-initial-loader`，包含一个绿点和几根线条）。在低配机型或冷启动场景下，WebView 从加载该图标到 React 依赖下载、模块解析、Coordinator 预取、React `createRoot().render` 挂载完成，中间存在长达 200~450ms 的“图标假死”状态。页面既无顶部窗口控制条（TopBar），也无侧边栏（Sidebar）与主分屏骨架，用户产生强烈的“应用卡死在启动图”的不良认知体验。

### 痛点 2：Pre-Hydration 交互真空期与死点击丢事件（Dead Clicks）

- **源码位置**：`apps/crish-desktop/index.html:25` 与 `src/entry-core.tsx:180-250`
- **现状缺陷**：在首屏骨架渲染后至 React 水合挂载（`tMounted`）前的数百毫秒窗口期内，DOM 树上未绑定任何全局交互代理。用户若在此阶段点击窗口操作、侧边栏项目或尝试使用快捷键，由于无事件捕获队列，所有原生操作直接被静默丢弃。React 挂载后没有任何代偿机制回放这些用户意图，导致“点击无响应”的严重交互断层。

### 痛点 3：SQLite 慢响应下的数据覆盖灾难与增量写屏障缺陷

- **源码位置**：`apps/crish-desktop/src/store/layout-helpers/store-persistence.ts:273-319`
- **现状缺陷**：冷启动时若底层 SQLite 读取受磁盘 I/O 阻塞迟到（耗时 > 300ms），而用户在首帧已快速创建了一个新会话，导致内存中 `state.sessions.length > 0`。此时迟到的 `hydrateSessionsFromRust()` 返回，代码执行：
  ```typescript
  // store-persistence.ts:283
  const next = state.sessions.map((s) => { ... });
  ```
  该逻辑仅遍历当前内存的 `state.sessions`（即仅包含用户新建的会话），而从 SQLite 恢复的存量历史会话如果不在 `state.sessions` 中，**直接被完全丢弃**！
  更致命的是：紧接着在 300ms 后（`store-persistence.ts:204-215`），防抖持久化定时器触发，调用 `persistAllSessions(next, ...)`，将仅包含新会话的数组写回 SQLite，**彻底擦除用户的全部存量历史会话**！这是灾难级的数据丢失风险。

### 痛点 4：静态依赖图体积冗余与伪动态拆包

- **源码位置**：`apps/crish-desktop/vite.config.ts:814-880` 与 `scripts/check-startup-budget.mjs:59-63`
- **现状缺陷**：当前静态图预算处于 1800 KiB 的宽松过渡态，`vite.config.ts` 中的 `manualChunks` 缺乏细粒度静态依赖拦截。重型依赖（如代码高亮、Markdown 渲染流水线、复杂 AST 解析器）仍极易通过多层透传渗入首屏 entry graph。首屏必须遵循 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 11 & 12，实施三阶刚性动态拆包，将静态依赖图压降至 ≤ 900 KiB。

---

## 1.2 Shell-Zero 动态代偿水合架构设计（TTI ≤ 120ms）

为了彻底抹平白屏到可交互的认知缝隙，设计 **Shell-Zero 动态代偿水合架构**。该架构由四大递进生命周期物理层构成：

```
+------------------------------------------------------------------------------------------------------------------------------------------+
|                                         Shell-Zero 动态代偿水合全生命周期时序拓扑 (TTI <= 120ms)                                         |
+------------------------------------------------------------------------------------------------------------------------------------------+
|  时间轴 (ms)   0ms                     20ms                    50ms                      80ms (LCP)                110ms (TTI)    120ms  |
+------------------------------------------------------------------------------------------------------------------------------------------+
| [Layer 0: CRP 静态骨架]                                                                                                                  |
|   index.html 解析 -> loader.css/js 内联解析 -> 渲染 Shell-Zero 静态三栏骨架 (<60KB) (Header+Sidebar+BinaryTree+Composer)                 |
+------------------------------------------------------------------------------------------------------------------------------------------+
| [Layer 1: 代偿捕获总线]                                                                                                                  |
|   PreHydrationCompensationQueue 激活 -> 全局捕获 click/keydown/focusin (<1.5KB) -> 写入环形捕获队列 (Max 32 slots)                       |
+------------------------------------------------------------------------------------------------------------------------------------------+
| [Layer 2: 并发预取通道]                                                                                                                  |
|   entry-core.tsx 求值 -> UnifiedAppHydrationCoordinator 并发预取 (getSettings / getAllPreferences / listProjects)                      |
|                                                              \-- 软超时看门狗 (250ms fallback 兜底，绝不丢弃后置真数据)                  |
+------------------------------------------------------------------------------------------------------------------------------------------+
| [Layer 3: 单拍原子水合与代偿回放]                                                                                                        |
|   applyAtomicCommit (纯内存状态注入) -> createRoot.render (<App />) -> rAF 代偿队列全量回放 -> 移除 .preload 门闩 -> 解锁 WorkerPool JIT|
+------------------------------------------------------------------------------------------------------------------------------------------+
```

### 1.2.1 Layer 0：Shell-Zero ≤60KB 纯静态骨架规范

在 `apps/crish-desktop/index.html` 中，彻底替换原有单一旋转图标，直接内联高仿真全景骨架：

- **布局结构**：
  1. **TopBar 骨架**：高度 38px，包含左侧 Logo 占位、中部窗口拖拽区（`data-tauri-drag-region`）与右侧最小化/最大化/关闭按钮占位；
  2. **Sidebar 骨架**：宽度 240px，包含顶部新建会话按钮占位与 5 个会话列表项骨架（带脉冲渐变背景，`animation: skeleton-shimmer 1.8s infinite`）；
  3. **Main Content 骨架**：包含二叉树分屏双窗格占位、对话流消息占位骨架及底部输入框卡片（ChatComposer 轮廓，高度 80px）。
- **色彩空间约束**：骨架内所有颜色使用 `hsl()` 或 `var(--...)` 变量，0 裸 Hex，完全继承 `loader.js` 同步写出的 `data-theme` 属性，实现 0ms 暗黑/浅色自适应，绝对无闪烁。

### 1.2.2 Layer 1：Pre-Hydration <1.5KB 原生代偿事件捕获队列

在 `apps/crish-desktop/public/loader.js` 中内联超轻量级全局代偿代理探针：

```typescript
interface PreHydrationEvent {
  type: 'click' | 'keydown' | 'focusin';
  targetSelector: string;
  timestamp: number;
  args: {
    key?: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    button?: number;
    clientX?: number;
    clientY?: number;
  };
}

// 全局环形代偿队列，最大深度 32，防止极端情况内存膨胀
window.__CRISH_PRE_HYDRATION_QUEUE__ = {
  queue: [] as PreHydrationEvent[],
  maxSize: 32,
  record(evt: Event) {
    if (this.queue.length >= this.maxSize) return;
    const target = evt.target as HTMLElement | null;
    if (!target) return;

    // 生成精确的选择器特征或 data-action 标记
    const action =
      target
        .closest('[data-shell-action]')
        ?.getAttribute('data-shell-action') ||
      target.id ||
      target.className;

    this.queue.push({
      type: evt.type as any,
      targetSelector: action ? String(action) : '',
      timestamp: performance.now(),
      args: {
        key: (evt as KeyboardEvent).key,
        ctrlKey: (evt as MouseEvent).ctrlKey,
        metaKey: (evt as MouseEvent).metaKey,
        button: (evt as MouseEvent).button,
        clientX: (evt as MouseEvent).clientX,
        clientY: (evt as MouseEvent).clientY,
      },
    });
  },
};
```

### 1.2.3 Layer 3：代偿回放与水合交接协议（Compensated Replay Handoff）

在 `entry-core.tsx` 的 `hydrateAndMount` 流程中：

1. `root.render(<App />)` 挂载完成后，不立即销毁队列；
2. 调度单帧 `requestAnimationFrame`，此时 React 真实 DOM 树已上屏；
3. 取出 `window.__CRISH_PRE_HYDRATION_QUEUE__.queue` 中的事件按时间戳顺序回放：
   - 若匹配到新建会话快捷键（如 `Ctrl+N` / `Cmd+N`），派发真实 Store Action；
   - 若匹配到侧边栏项目点击，派发定位会话 Action；
   - 若匹配到底部输入框聚焦，立即执行 `activeElement.focus()`；
4. 排空后彻底注销 `loader.js` 的临时事件监听器，解冻所有交互。

---

## 1.3 3-Way Merge 增量写屏障防止空数据覆盖与磁盘慢响应丢失

为了根治 `store-persistence.ts:283` 的数据冲刷毁灭性缺陷，必须建立基于**集合论与因果序的 3-Way Merge 增量写屏障**。

### 1.3.1 3-Way 集合论合并算法规范

定义系统冷启动时的三个状态快照：

- $B$ (Base Snapshot)：应用初始化启动时的基线空集（或上次已知持久化索引摘要）；
- $L$ (Local Memory State)：用户在应用冷启动首帧期间产生的本地内存状态（包含本地新建的 Draft 会话、新输入的 Message 等）；
- $R$ (Remote Disk Snapshot)：SQLite 异步 I/O 慢响应迟到的真实磁盘数据。

合并结果状态机定义为：$M = \text{Merge3Way}(B, L, R)$，其核心代数不变量为：

$$\text{Sessions}(M) = L.\text{sessions} \cup \{ s \in R.\text{sessions} \mid s.id \notin L.\text{sessions} \}$$

对于两端均存在的同名会话 $s \in L \cap R$：

1. **元数据合并**：若 $L$ 仅为本地初始化的轻量壳（`messagesHydrated = false`），则全量继承 $R$ 的元数据与序列号（`engineCursor`, `seq`）；若用户在 $L$ 中修改了标题，保留 $L$ 的修改，时间戳取 $\max(L.timestamp, R.timestamp)$；
2. **正文合并**：若 $L$ 拥有刚追加的消息 $[m_{new}]$，而 $R$ 拥有磁盘已落盘消息 $[m_1, m_2, \dots, m_k]$，则正文按单调递增因果序列号（`engineSequence` / `timestamp`）执行去重并集归并：

   $$\text{Messages}(s) = \text{DeduplicateByMsgId}(R.messages \cup L.messages)$$

### 1.3.2 三道物理增量写屏障（Incremental Write Barriers）

```
+---------------------------------------------------------------------------------------------------+
|                            三道物理增量写屏障 (Triple Write Barrier)                              |
+---------------------------------------------------------------------------------------------------+
|  [用户状态变异 / Store Action]                                                                    |
|           |                                                                                       |
|           v                                                                                       |
|  [Barrier 1: BootHoldBarrier (启动持有屏障)]                                                      |
|    - 判定: hydrationComplete === false                                                            |
|    - 动作: 挂起全量 persist 调度；仅允许内存写入，拦截向 SQLite 发起全盘覆写定时器                    |
|           |                                                                                       |
|           v                                                                                       |
|  [Barrier 2: DeltaWriteBarrier (增量写屏障)]                                                      |
|    - 判定: 单会话发生变异 (新消息 / 状态变动)                                                     |
|    - 动作: 严禁触发全量 SAVE_ALL_SESSIONS；仅向底层提交单会话增量 append_session_message / patch     |
|           |                                                                                       |
|           v                                                                                       |
|  [Barrier 3: EmptySanitizeBarrier (防空冲刷刚性屏障)]                                             |
|    - 判定: sessions.length === 0 或 messages.length === 0                                          |
|    - 动作: 抛出 FATAL_CORRUPTION_GUARD 警告，绝对禁止将空集合覆盖到非空的 SQLite 数据库表中           |
+---------------------------------------------------------------------------------------------------+
```

1. **Barrier 1: BootHoldBarrier（启动持有屏障）**：
   在 `store-persistence.ts` 中，当 `hydrationComplete === false` 时，任何通过 `store.subscribe` 触发的持久化均被严格锁存。只有当 SQLite 水合握手完成、且 3-Way Merge 成功将远端数据与本地增量融合完成后，才将 `hydrationComplete` 置为 `true` 并释放屏障。
2. **Barrier 2: DeltaWriteBarrier（增量写屏障）**：
   废除原 `persistAllSessions` 全量覆盖写盘的粗暴机制，收敛为按 `sessionId` 粒度的增量变异提交（`persistSessionDelta`），单会话的消息更新绝不触发全量会话表的重写。
3. **Barrier 3: EmptySanitizeBarrier（防空冲刷刚性屏障）**：
   在 Rust IPC 桥接层与前端持久化层加入硬性守卫：如果待写盘会话列表为空，且底层既有会话数大于 0，直接阻断写入并上报防御性审计事件。

---

## 1.4 Vite 动态拆包重构方案

针对 `apps/crish-desktop/vite.config.ts` 中的构建配置，实施彻底的单轨动态拆包方案，确保首屏静态导入图体积从 1800 KiB 压缩至 **≤ 900 KiB**，达成 `STARTUP_STATIC_GRAPH_BUDGET_KB_FROZEN` 严苛门禁。

### 1.4.1 重型模块剥离清单与动态拆包策略

必须从静态首屏引用链中 100% 剥离并转为异步 Dynamic Import（`lazy`）的四大重型领域：

1. **Markdown 高亮与语法分析引擎**：
   - 依赖项：`highlight.js`（~280KB）、AST 处理包、数学公式 Katex 渲染器；
   - 拆解点：`ChatMessageRow` 中的代码块与复杂格式，首屏仅挂载纯文本/简单骨架，增量高亮与富文本解析完全委托给 Stage 04 的 Web Worker 流水线按需拉取。
2. **富文本与 ProseMirror/Tiptap 编辑器**：
   - 依赖项：`@tiptap/*`（~420KB）、`prosemirror-*`、`@crish/block-paper`；
   - 拆解点：`ChatComposer.tsx` 保持 `TiptapComposerFieldLazy`，并在首屏加载前渲染基于原生轻量 CSS 的静态占位输入框，只有当用户发生聚焦（`focusin`）或点击输入区时，才并行完成 Tiptap Chunk 加载。
3. **终端模拟器**：
   - 依赖项：`@xterm/xterm`（~440KB）、`@xterm/addon-*`；
   - 拆解点：`TerminalCard.tsx` 100% 维持惰性，严禁任何终端 CSS 或 JS 模块出现在首屏入口依赖图中。
4. **大文件 Diff 视图**：
   - 依赖项：`DiffCard.tsx`、CodeMirror diff 扩展；
   - 拆解点：归入 `secondaryViews`，仅在用户首次点击展开 Diff 面板时异步加载。

### 1.4.2 `vite.config.ts` 中的 Rollup `manualChunks` 精准配置

```typescript
// vite.config.ts output.manualChunks 优化方案
manualChunks(id) {
  const n = id.replace(/\\/g, '/');

  if (n.includes('node_modules')) {
    // 基础 React 运行时 (必须保持极致纯净，严禁混入 tiptap/icons)
    if (n.includes('node_modules/react/') || n.includes('node_modules/react-dom/')) {
      return 'vendor-react-core';
    }
    // 状态原语
    if (n.includes('zustand') || n.includes('use-sync-external-store')) {
      return 'vendor-state-primitives';
    }
    // 重型隔离 Chunk：严禁进入 entry static graph
    if (n.includes('@tiptap') || n.includes('prosemirror')) return 'vendor-tiptap-bundle';
    if (n.includes('@xterm')) return 'vendor-xterm-bundle';
    if (n.includes('highlight.js')) return 'vendor-highlight-bundle';
    if (n.includes('@hugeicons')) return 'vendor-icons-bundle';
    if (n.includes('dompurify')) return 'vendor-dompurify';
    if (n.includes('@chenglou')) return 'vendor-pretext';
  }

  // 跨层共享包
  if (n.includes('/packages/shared-utils/')) return 'vendor-shared-utils';
  if (n.includes('/packages/shared-types/')) return 'vendor-shared-types';

  // 聊天流核心与模型元数据 (切断双向依赖环)
  if (n.includes('/src/api/modelCatalog') || n.includes('/src/api/providerProfiles')) {
    return 'chat-provider-catalog';
  }
  if (n.includes('/src/api/chat-bridge/') || n.includes('/src/api/StreamRenderBuffer')) {
    return 'chat-runtime-core';
  }
}
```

---

# 第二部分：Stage 01 — 状态管理与重渲染优化实施方案

## 2.1 现状审查与伪兼容架构毒点（代码行号级证据）

对现有 `apps/crish-desktop/src/store/` 下的状态拓扑进行深度代码剖析，发现以下四大伪兼容与性能瓶颈毒点：

### 毒点 1：元数据与万级消息树物理粘连（The Monolithic State Antipattern）

- **源码位置**：`apps/crish-desktop/src/store/types.ts:728-780` 与 `src/store/sessionStore.ts:29-39`
- **现状缺陷**：
  ```typescript
  // types.ts:728
  export interface SessionState {
    id: string;
    title: string;
    folder: string;
    // ... 低频元数据
    messages: SessionMessage[]; // <--- 致命设计！高频变动的大型消息数组与元数据粘连
    agents?: SessionAgent[];
  }
  ```
  `SessionState` 既承载侧边栏高频需要的低频变更字段（`title`, `folder`, `isPinned`, `timestamp`），又直接绑定了包含数千条对话记录、图文块及工具调用的 `messages: SessionMessage[]`。
  当流式推送大模型 Token 或更新某个工具调用的执行状态时，Immer 的 Proxy 机制强制克隆 `SessionState` 实例，导致 `sessionsById[id]` 产生全新的对象引用，同时触发 `state.sessions` 数组重排或重赋值。
  **结果**：侧边栏、标题栏等本应静止的 UI 组件因对象引用变更而被动触发 React 重新协调（Reconciliation）。

### 毒点 2：选择器层打补丁与 $O(K)$ 运行时深层比对

- **源码位置**：`apps/crish-desktop/src/store/sessionSelectors.ts:94-177`
- **现状缺陷**：为了缓解毒点 1 带来的全屏重渲染，历史代码在 `sessionSelectors.ts` 中手写了极其复杂的 `isSessionMetaEqual` 函数，并在组件调用 `useSessionMeta(sessionId)` 时执行：
  ```typescript
  // sessionSelectors.ts:244
  if (cached && isSessionMetaEqual(cached, sess)) {
    return cached;
  }
  ```
  每次全局 store 哪怕仅追加了单个字符的 Token，所有活跃的 `useSessionMeta` hook 都会触发一次 `isSessionMetaEqual` 执行！该函数需要遍历对象的每一个键（排除 messages/agents），并调用 `shallowArrayEqual` 和 `shallowRecordEqual`。
  这是典型的**“在糟糕的数据拓扑上贴运行时深层比对创可贴”**，白白浪费了宝贵的 CPU 主线程时间（单帧消耗 > 0.8ms），严重违背 120fps 目标。

### 毒点 3：代数槽位未物理闭环（伪代数槽位与脱节的 Map 缓存）

- **源码位置**：`apps/crish-desktop/src/store/sessionSelectors.ts:193-224`
- **现状缺陷**：`epochBySessionId` 和 `lastMessagesRefBySessionId` 居然是定义在 store 外部的裸 `Map<string, number>`！它们脱离了 Zustand 的事务快照生命周期，不是 Store State 的一部分。在并发渲染或时间旅行调试下极易发生代数漂移与竞态，无法真正为 `useSyncExternalStore` 提供确定性的不可变标量快照。

### 毒点 4：持久化防抖常量割裂与竞争定时器

- **源码位置**：`store/persistenceConstants.ts:5` vs `api/beforeunloadFlush.ts:89` vs `services/WindowResizeBridge.ts:8`
- **现状缺陷**：虽定义了 `STORAGE_PERSIST_DEBOUNCE_MS = 300`，但仓内散落着 “正文由 350ms debounce”、“150ms resize debounce”、“1000ms idle timer” 等互不知晓的割裂定时器，导致在多窗口分屏或极端快速切换时产生时序交叉竞态。

---

## 2.2 状态树物理拆分架构设计（Physical Subtree Decoupling）

彻底废除单体巨型 `SessionState`，在内存物理结构上将**会话元数据（Metadata Subtree）**与**会话消息树（Messages Subtree）**彻底物理分割为两个正交的哈希表：

```
+---------------------------------------------------------------------------------------------------------------------------------+
|                                        Zustand SessionStore 物理拆分拓扑架构                                                    |
+---------------------------------------------------------------------------------------------------------------------------------+
|  [SessionStoreState]                                                                                                            |
|                                                                                                                                 |
|  +-- [子树 A: 会话元数据子树 (Session Metadata Subtree)] <----------------------- 专供 Sidebar / Title / Tabs 订阅             |
|  |     |-- sessionOrder: string[]                     (严格保持会话排序因果列表)                                                 |
|  |     |-- metaById: Record<string, SessionMeta>      (纯轻量标量元数据: id, title, folder, isPinned, timestamp...)              |
|  |     |-- activeSessionId: string                    (当前活跃会话 ID)                                                          |
|  |     |-- folderOrder: string[]                      (侧边栏文件夹排序)                                                         |
|  |     \-- composerDrafts: Record<string, string>     (草稿字典)                                                                 |
|  |                                                                                                                              |
|  +-- [子树 B: 消息与协同子树 (Session Messages Subtree)] <----------------------- 专供 ChatMessageList / Stream 订阅            |
|  |     |-- messagesBySessionId: Record<string, SessionMessage[]>  (会话全量消息数组，按 sessionId 物理独立存储)                  |
|  |     |-- agentsBySessionId: Record<string, SessionAgent[]>      (协同子 Agent 数组)                                            |
|  |     \-- epochBySessionId: Record<string, number>              (标量版本代数槽位，32位无符号整数)                              |
|  |                                                                                                                              |
|  \-- [生命周期锁存]                                                                                                              |
|        \-- hydrationComplete: boolean                                                                                           |
+---------------------------------------------------------------------------------------------------------------------------------+
```

### 2.2.1 物理拆分核心类型契约（TypeScript SOTA Definitions）

```typescript
/** 权威纯净会话元数据（绝对不包含 messages 与 agents 数组） */
export interface SessionMeta {
  readonly id: string;
  title: string;
  titleSource?: 'auto-trivial' | 'auto' | 'user';
  folder: string;
  isPinned: boolean;
  isArchived: boolean;
  branchParentId?: string;
  timestamp: string;
  timestampSource?: 'local' | 'remote';
  engineCursor?: number;
  engineLastRunId?: string;
  messagesHydrated: boolean;
  messageCount: number;
  hasOlderMessages?: boolean;
  oldestLoadedSeq?: number;
  hydrateTruncated?: boolean;
}

/** 物理拆分后的 SOTA SessionStoreState */
export interface SessionStoreState {
  // ── 子树 A: 元数据（低频更新，绝对稳定引用） ──
  sessionOrder: string[];
  metaById: Record<string, SessionMeta>;
  activeSessionId: string;
  folderOrder: string[];
  draftFolder: string;
  activeAgentId: string | null;
  panelAgentId: string | null;
  composerDrafts: Record<string, string>;
  hydrationComplete: boolean;

  // ── 子树 B: 消息实体与版本代数（高频更新，局部隔离） ──
  messagesBySessionId: Record<string, SessionMessage[]>;
  agentsBySessionId: Record<string, SessionAgent[]>;
  epochBySessionId: Record<string, number>;
}
```

### 2.2.2 物理拆分产生的架构不变量与零克隆保证

1. **不变量 1（元数据引用恒定）**：
   无论大模型以多么极速的吞吐（100 Token/s）向会话 `S_1` 推送流式文本或更新工具状态，Store Action 仅且只会变异 `state.messagesBySessionId['S_1']` 与递增 `state.epochBySessionId['S_1']`。
   `state.metaById`、`state.sessionOrder` 以及 `state.metaById['S_1']` 的引用保持 **100% 恒定不变**！
2. **不变量 2（侧边栏 0 重渲染断言）**：
   订阅 `useSessionMeta(sessionId)` 的侧边栏组件在流式推流期间，其选择器 `s => s.metaById[sessionId]` 经 `Object.is` 比对直接返回 `true`，**整个 React 子树协调消耗严格为 0ms，完全消除 $O(K)$ 递归 diff 运算**！
3. **不变量 3（单消息更新零对象深克隆）**：
   当一条消息的文本被追加时，变异严格局限在 `messagesBySessionId[sessionId][msgIdx]` 内部，不再引起全量会话树的连锁深拷贝。

---

## 2.3 标量版本代数槽位（Epoch Slots）与 useSyncExternalStore 驱动

为了让消息消费层组件获得极致的响应性能，引入 **标量版本代数槽位（Epoch Slots）**。

### 2.3.1 代数版本设计模型

每个会话在 `epochBySessionId` 中维护一个 32 位整型标量（Revision Epoch）：

- **初始化**：会话创建或全量回灌时，`epochBySessionId[sessionId] = 1`；
- **递增时机**：当且仅当该会话的消息发生新增、修改、删除、撤回或思考流推进时，执行原子整型递增：
  ```typescript
  state.epochBySessionId[sessionId] =
    ((state.epochBySessionId[sessionId] ?? 0) + 1) | 0;
  ```

### 2.3.2 基于标量整数比对的组件订阅

在视图层，组件通过订阅标量代数槽位，将原本复杂的数组或对象比对降维为单一 CPU 寄存器级别的整数比较：

```typescript
/**
 * 极速标量代数选择器：仅返回当前会话的 32 位整型版本号
 */
export const selectSessionEpoch =
  (sessionId: string) =>
  (state: SessionStoreState): number => {
    return state.epochBySessionId[sessionId] ?? 0;
  };

/**
 * 驱动极速更新的 Epoch Hook
 */
export function useSessionEpoch(sessionId: string): number {
  return useSessionStore(
    useCallback(selectSessionEpoch(sessionId), [sessionId])
  );
}
```

当流式引擎向活跃会话追加数据时，非活跃会话的 `epoch` 恒定不变；活跃会话的消费组件通过标量比对以 0 内存开销判定更新，彻底规避了 `useShallow` 在万级消息列表上的遍历开销。

---

## 2.4 持久化防抖 300ms 单轨大一统

依据总纲与架构审查裁决，全仓所有持久化防抖一律收敛为单一常量：

```typescript
// persistenceConstants.ts
export const STORAGE_PERSIST_DEBOUNCE_MS = 300;
```

### 2.4.1 单轨持久化协调状态机

```
+---------------------------------------------------------------------------------------------+
|                            单轨持久化防抖协调状态机 (300ms)                                 |
+---------------------------------------------------------------------------------------------+
|  [状态变异发生]                                                                             |
|         |                                                                                   |
|         v                                                                                   |
|  [检查 BootHoldBarrier] --- 未完成水合 ---> 挂起持久化 (防止空数据覆写)                     |
|         |                                                                                   |
|      已完成                                                                                 |
|         v                                                                                   |
|  [清除既有 Timer]                                                                           |
|         |                                                                                   |
|         v                                                                                   |
|  [启动单一 300ms Trailing 定时器]                                                           |
|         |                                                                                   |
|         +-- (在 300ms 内又有新变异) ------> 重置定时器 (合并高频写入)                       |
|         |                                                                                   |
|         v                                                                                   |
|  [300ms 到期触发] -> 提取变更元数据/正文增量 -> 执行 SQLite WAL 增量写入 -> Commit          |
|                                                                                             |
|  * 特殊通道: window.onbeforeunload 触发时 -> clearTimeout -> 同步执行 flushImmediately()    |
+---------------------------------------------------------------------------------------------+
```

彻底清退散落在 `WindowResizeBridge`（150ms）、`beforeunloadFlush`（350ms）等模块中的魔术数字，所有涉及状态持久化的调用点 100% 接入 `STORAGE_PERSIST_DEBOUNCE_MS`。

---

## 2.5 清退伪兼容选择器，确立原子状态直接定位（SOTA Selectors）

彻底拔除 `sessionSelectors.ts` 中基于历史过渡期的繁琐别名与深度缓存比对逻辑，确立最先进原子单轨选择器矩阵：

| 被拔除的历史伪兼容选择器 / 缓存      | 替代的最先进 SOTA 原子选择器                    | 复杂度 | 性能跃迁与消除的毒点                         |
| :----------------------------------- | :---------------------------------------------- | :----- | :------------------------------------------- |
| `isSessionMetaEqual` (40行递归比对)  | **彻底拔除**（不再需要）                        | $O(1)$ | 消除单帧高达 0.8ms 的深层属性遍历开销        |
| `metaCache` (外部裸 Map 缓存)        | **彻底拔除**（直接读 `state.metaById`）         | $O(1)$ | 消除 Store 外部状态分裂与内存泄漏隐患        |
| `lastMessagesRefBySessionId`         | **彻底拔除**（直接读 `state.epochBySessionId`） | $O(1)$ | 标量代数槽位原生闭环，0 引用对比             |
| `makeSelectSessionMessages(id)`      | `selectSessionMessages(id)`                     | $O(1)$ | 消除闭包工厂函数，直接定位独立子树消息数组   |
| `useSidebarSessions` (双重 ref 拦截) | `useSessionOrder()` + `useSessionMeta()`        | $O(1)$ | 细粒度拆分，列表顺序变动不影响单个会话元数据 |

---

# 第三部分：工程实施单元、文件域与测试验证矩阵

## 3.1 受影响文件清单与职责边界（无冲突白名单）

严格遵循仓库 `AGENTS.md` 纪律，所有改动限定在明确的文件域中，禁止跨文件越界修改：

| 实施单元编号 | 目标文件路径                                                       | 操作性质 | 核心修改职责与架构契约                                                              |
| :----------- | :----------------------------------------------------------------- | :------- | :---------------------------------------------------------------------------------- |
| **U-10-01**  | `apps/crish-desktop/index.html`                                    | 重构     | 内联 Shell-Zero ≤60KB 纯静态三栏骨架，注入 Pre-Hydration 代偿事件捕获探针。         |
| **U-10-02**  | `apps/crish-desktop/public/loader.css`                             | 重构     | 支持全景骨架微调与现代色彩 Token，确保 0ms 多主题自适应，0 闪白。                   |
| **U-10-03**  | `apps/crish-desktop/public/loader.js`                              | 重构     | 实现 <1.5KB 全局代偿事件捕获队列（`window.__CRISH_PRE_HYDRATION_QUEUE__`）。        |
| **U-10-04**  | `apps/crish-desktop/src/entry-core.tsx`                            | 重构     | 水合完成帧执行代偿事件有序回放，解除 `.preload` 门闩，解锁 JIT Worker。             |
| **U-10-05**  | `apps/crish-desktop/src/app/UnifiedAppHydrationCoordinator.ts`     | 强化     | 落实 3-Way Merge 增量写屏障，强化 `canPersistToDisk` 拦截空数据冲刷。               |
| **U-10-06**  | `apps/crish-desktop/src/store/layout-helpers/store-persistence.ts` | 重构     | 彻底消除 `next = sessions.map` 丢失存量会话 bug，接入 3-Way Merge 与三道写屏障。    |
| **U-10-07**  | `apps/crish-desktop/vite.config.ts`                                | 重构     | 优化 Rollup `manualChunks`，剥离编辑器/终端/高亮重型模块，静态图预算 ≤ 900 KiB。    |
| **U-01-01**  | `apps/crish-desktop/src/store/types.ts`                            | 重构     | 物理拆分契约：定义 `SessionMeta` 与 `SessionStoreState`，解耦 messages。            |
| **U-01-02**  | `apps/crish-desktop/src/store/sessionStore.ts`                     | 重构     | 实施双子树物理拆分（`metaById` + `messagesBySessionId`），挂载 `epochBySessionId`。 |
| **U-01-03**  | `apps/crish-desktop/src/store/sessionSelectors.ts`                 | 重构     | 拔除 `isSessionMetaEqual` 与外部 Map，确立 SOTA 原子直接寻址选择器。                |
| **U-01-04**  | `apps/crish-desktop/src/store/sessionMessageActionsCore.ts`        | 重构     | 消息变异仅操作 `messagesBySessionId` 并原子自增 `epoch`，保证元数据引用绝对静止。   |
| **U-01-05**  | `apps/crish-desktop/src/store/persistenceConstants.ts`             | 统一     | 全仓锁定单一 `STORAGE_PERSIST_DEBOUNCE_MS = 300` 常量，清退分散定时器。             |

---

## 3.2 验收断言与立体验证矩阵（魔鬼用例与性能基准）

根据 `AGENTS.md` §7.1 立体验证纪律，交付前必须通过以下刚性断言，禁止凭猜测宣称完成：

| 验证维度           | 断言标识         | 验证场景与测试用例                                                             | 刚性指标与验收断言                                                                    |
| :----------------- | :--------------- | :----------------------------------------------------------------------------- | :------------------------------------------------------------------------------------ |
| **冷启动性能**     | **ASSERT-10-01** | 模拟冷启动（清空缓存），通过 `performance.mark` 与自动化脚本测试首屏时间       | 首帧骨架 LCP **< 80ms**；完全可交互 TTI **≤ 120ms**。                                 |
| **代偿事件完整性** | **ASSERT-10-02** | 在 React 挂载前的 100ms 窗口期内，模拟派发 5 次点击与 1 次快捷键               | React 挂载首帧 100% 顺序回放，死点击率为 **0%**。                                     |
| **3-Way 数据防丢** | **ASSERT-10-03** | 模拟 SQLite 延迟 500ms 慢响应；用户在 50ms 内新建会话并在内存写入 1 条消息     | SQLite 迟到后 3-Way Merge 成功合并存量与新会话，会话总数与消息数 **0 丢失，0 覆写**。 |
| **构建体积门禁**   | **ASSERT-10-04** | 执行 `npm run build` 并运行 `node scripts/check-startup-budget.mjs --strict`   | entry 单文件 ≤ 520 KiB，静态图合计 **≤ 900 KiB**，零 deny 命中。                      |
| **流式零重渲染**   | **ASSERT-01-01** | 模拟 100 Token/s 高频推流持续 10 秒，使用 Profiler 观测侧边栏 SessionItem 组件 | 侧边栏所有低频组件的重渲染次数恒等于 **0 次**。                                       |
| **单消息零克隆**   | **ASSERT-01-02** | 包含 1000 条消息的长会话中追加 1 条消息，测量 Store 操作微秒耗时               | 操作耗时 **< 0.1ms**，`metaById` 与 `sessionOrder` 引用保持全等（`===`）。            |
| **防抖大一统**     | **ASSERT-01-03** | 静态扫描代码库中涉及会话与状态持久化的防抖常量引用                             | 100% 引用 `STORAGE_PERSIST_DEBOUNCE_MS`（300ms），散落定时器清零。                    |

---

## 3.3 纯逻辑阶段依赖拓扑与演进路线

本实施方案完全依据**逻辑因果依赖**排序，不涉及任何排期人天，问题同权推进：

```
[Wave 0: 类型与契约锚定]
  - U-01-01: types.ts 物理拆分契约与 SessionMeta 形状锁定
  - U-01-05: persistenceConstants.ts 300ms 防抖单一真源锁定
         |
         v
[Wave 1: 状态拓扑物理重构]
  - U-01-02: sessionStore.ts 双子树拓扑实施 (metaById + messagesBySessionId + epoch)
  - U-01-04: sessionMessageActionsCore.ts 独立消息子树变异与代数自增
  - U-01-03: sessionSelectors.ts 拔除伪兼容比对层，建立原子定位选择器
         |
         v
[Wave 2: 存储屏障与 3-Way Merge 闭环]
  - U-10-06: store-persistence.ts 接入 3-Way Merge 集合论算法，消灭会话覆盖 bug
  - U-10-05: UnifiedAppHydrationCoordinator.ts 三道写屏障与迟到数据平滑融合
         |
         v
[Wave 3: Shell-Zero 骨架与代偿事件总线]
  - U-10-01 & U-10-02: index.html 与 loader.css 极速骨架内联 (<=60KB)
  - U-10-03: loader.js <1.5KB Pre-Hydration 代偿捕获总线
  - U-10-04: entry-core.tsx 水合交接与有序回放
         |
         v
[Wave 4: Vite 构建动态拆包与门禁刚性验收]
  - U-10-07: vite.config.ts 动态拆包重构，静态图预算降至 <= 900 KiB
  - 全量运行 check-startup-budget.mjs 与性能测试矩阵闭环收口
```

---

## 3.4 方案自检与反退避声明

1. **效果锁定反退避**：本方案未对任何性能指标（TTI ≤ 120ms、LCP < 80ms、120fps、单轨防抖 300ms）进行降级，亦未采用任何偷懒的“延时等待”或“坐标测距”补丁；
2. **最先进单轨代码**：彻底消除了 `isSessionMetaEqual` 伪兼容比对层与 `sessions.map` 粗暴覆写逻辑，新代码 100% 覆盖且更强健；
3. **反过度设计红线守门**：未引入任何内核沙盒、无锁共享内存或复杂 2PC 协议，完全基于原生 DOM 代偿队列与双子树哈希存储，轻量优雅。

至此，**Agent-10（冷启动水合与全局状态拓扑架构专家）** 第一轮 Stage 10 与 Stage 01 独立规划方案编制完成，文档唯一落地至 `docs/frontend-performance-revamp/independent-plans/10-agent10-stage10-1.md`。
