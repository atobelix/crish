# 07 — 前端重型工具视图：终端、内置预览、大文件 Diff、文件树与编排运行态性能审计

> **审计维度**：维度 07（前端重型工具视图：终端 / 内置预览 / 大文件 Diff / 文件树 / 编排图谱与运行态面板）
> **覆盖代码域**：
>
> - `apps/crish-desktop/src/components/workspace/`（`TerminalCard*`、`useXtermTerminal.ts`、`ptyLifecycle.ts`、`ptyWriteGate.ts`、`activePortDetector.ts`、`PreviewCard*`、`previewHostBridge.ts`、`usePreviewNavigation.ts`、`useBrowserSession.ts`、`FlowDagView.tsx`、`flowDagLayout.ts`、`flowDagStore.ts`、`RuntimePanel.tsx`、`useRuntimePanelData.ts`、`*Section.tsx`）
> - `apps/crish-desktop/src/api/`（`ptySessionApi.ts`、`ptyRegistry.ts`、`perfBudgets.ts`、`codeHighlight.ts`、`codeHighlightBatch.ts`、`intralineDiff.ts`、`diffPairMatcher.ts`、`diffPanelHelpers.ts`、`engineStatus.ts`、`previewBrowserStore.ts`）
> - `apps/crish-desktop/src/components/diff/`（`DiffCard*`、`useDiffData.ts`、`VirtualPlainCodeViewer.tsx`、`VirtualCodeEngine.ts`、`LineBuffer.ts`、`useDiffGitActions.ts`）
> - `apps/crish-desktop/src/components/files/`（`FilesCard.tsx`、`FileTreeView.tsx`、`FileViewerCard.tsx`、`FilePreview.tsx`、`FileBreadcrumb.tsx`、`FileAnnotationPopover.tsx`、`FileViewerHistoryDrawer.tsx`、`hooks/useFileNavigation.ts`、`hooks/useFilePreview.ts`）
> - `apps/crish-desktop/src/components/overview/`（`OverviewCard.tsx`、`useOverviewState.ts`、`OverviewChangesList.tsx`、`changes/*`、`*Section.tsx`）
> - `apps/crish-desktop/src/components/agent-card/`（`AgentCard.tsx`、`AgentTeamBoard.tsx`、`agentTeamBoardUtils.ts`、`AgentBrowsePad.tsx`、`InlineAgentPanel.tsx`、`InlineAgentTimeline.tsx`、`useAgentCardStatusPoll.ts`、`useApprovalCountdown.ts`）
> - `apps/crish-desktop/src/components/custom-tags/` 与 `chat-tool-call/`（`FileTree.tsx`、`WidgetDiff.tsx`、`ModernTerminalToolCall.tsx`、`ToolCallDiffPreview.tsx`、`ModernCodeBlock.tsx`、`utils/parseAnsi.ts`）
> - `apps/crish-desktop/dev-server/previewBridgeScript.ts`、`apps/crish-desktop/src/hooks/useEngineState.ts`
>
> **审计准则**：遵循《三原则》与《00-DISCIPLINE.md》反退避纪律。全量问题同权列出，不设 P0/P1/P2 优先级裁剪；每一项均附精确 `文件路径:行号`、源码证据、极限负载推演及根因级修复方案，严格遵守 `ANTI_OVERENGINEERING_GUARDRAILS.md`。

---

## 一、全维问题总览矩阵

| 编号     | 所属子域                      | 问题定性                                                                                                                                                                                                                                                                                                                                                                                           | 精确代码定位                                                                                                                                                                                 | 复杂度 / 资源劣化特征                                                                                                       |
| :------- | :---------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| **T-01** | 终端与 PTY 管线               | 后台隐藏终端 `ptyWriteGate` 缓存无字节上限，切回前台时 `pending.join('')` 同步单次灌入 xterm 引发主线程假死与内存暴涨                                                                                                                                                                                                                                                                              | `components/workspace/ptyWriteGate.ts:35-65`                                                                                                                                                 | 内存 $O(\text{TotalBgBytes})$ 无界增长；切回前台时单帧合并分配 + 同步解析 $O(B)$ 阻塞主线程数百毫秒至数秒                   |
| **T-02** | 终端与 PTY 管线               | `observeTerminalHostVisibility` 在父级容器挂 `subtree: true` 监听 `style`/`class`，子樹内高频样式变动触发同步 `offsetParent` / `getComputedStyle` 强制回流                                                                                                                                                                                                                                         | `components/workspace/ptyWriteGate.ts:77-122`                                                                                                                                                | 每次子树属性变动触发 DOM 向上寻祖 + 强制同步布局（Forced Reflow）                                                           |
| **T-03** | 终端与 PTY 管线               | 切换终端分屏（`isSplit`）改变 JSX 父级包装层级，导致主终端 `InteractiveXtermTerminal` 被卸载重建、WebGL 上下文销毁及 256KB 历史重放，且双重触发 `fit()` + `ptyResize` IPC                                                                                                                                                                                                                          | `components/workspace/TerminalCard.tsx:65-78, 132-144, 212-264`、`useXtermTerminal.ts:345-364`、`ptyLifecycle.ts:176-215`                                                                    | WebGL 纹理图集销毁重建 + 256KB 文本重解析 + 4 次冗余 `ptyResize` IPC                                                        |
| **T-04** | 终端与 PTY 管线               | `useXtermTerminal` 监听 `<html style>` 属性变化，每次触发 20 个 CSS 变量递归最多 5 层的 `getComputedStyle` 读取与全屏 `term.refresh`                                                                                                                                                                                                                                                               | `components/workspace/useXtermTerminal.ts:35-144, 238-264`                                                                                                                                   | 单次触发最多 $20 \times 5 = 100$ 次 `getComputedStyle` 调用 × 挂载终端数                                                    |
| **T-05** | 终端与 PTY 管线               | `recordPtyOutputHistory` 每次用 `TextEncoder.encode(chunk)` 分配 `Uint8Array` 测长、`chunks.shift()` 重复编码，且 `trimToUtf8ByteLimit` 逐字符调用 `textEncoder.encode`                                                                                                                                                                                                                            | `api/ptySessionApi.ts:57-60, 78-141`                                                                                                                                                         | 驱逐阶段双倍 UTF-8 编码 + $O(K)$ 数组平移；单大块截断最坏分配 $262,144$ 个 `Uint8Array`                                     |
| **T-06** | 终端工具卡与 ANSI             | `ModernTerminalToolCall` 流式输出每帧全量 `.replace` + `.split('\n')`，渲染期裸调 `parseAnsi` 无行级记忆化，展开态無虚拟滚动且跨行丢失 SGR 状态                                                                                                                                                                                                                                                    | `components/chat-tool-call/ModernTerminalToolCall.tsx:41-65, 129-163`、`utils/parseAnsi.ts:52-121`                                                                                           | 流式累计 $O(N^2)$ 字符串切分；展开 2000+ 行直接挂载上万个内联样式 `<span>`                                                  |
| **D-01** | 大文件 Diff 视图              | `useDiffData` 对文件列表中所有 $M$ 个文件急切计算 `computedChangesByFile`、`unifiedRenderCache` 与 `splitRenderCache`；单文件展开折叠块触发全量文件重算                                                                                                                                                                                                                                            | `components/diff/useDiffData.ts:295-302, 360-419`、`DiffCardFileList.tsx:191, 381`                                                                                                           | 仅展示 1 个激活文件却付出 $O(\sum_{i=1}^M L_i)$ 内存与 CPU；单次点击展开触发 $M$ 个文件全量重算                             |
| **D-02** | 大文件 Diff 视图              | `useDiffData` 订阅 `session.messages`，流式对话每个 Token 触发全历史消息扫描与 `mergeDiff` 数组拼接，且无条件击穿 Git 模式的 Diff 渲染缓存                                                                                                                                                                                                                                                         | `components/diff/useDiffData.ts:238-293`、`api/diffPanelHelpers.ts:30-74`                                                                                                                    | 流式每帧 $O(\text{Messages} \times \text{ToolCalls} \times 400)$ 拷贝，并连带触发全量 Diff 缓存失效                         |
| **D-03** | 大文件 Diff 高亮              | `useDiffHighlightMap` 在虚拟滚动窗口移动 1 行时，先用未高亮的 `escapeHtml` 覆盖整张 Map，导致视口已高亮的 ~49 行瞬间闪烁回纯文本并重复派发 Worker 批处理                                                                                                                                                                                                                                           | `api/codeHighlightBatch.ts:102-143`、`components/diff/DiffCardUnifiedView.tsx:167-178`、`DiffCardSplitView.tsx:181-186`                                                                      | 每次滚动 1 行触发 ~50 行高亮丢失闪烁 + 全窗口重复 IPC/Worker 序列化                                                         |
| **D-04** | 大文件 Diff 高亮              | `renderTokens` 在 `hlHtml` 未就绪帧回退同步调用 `highlightCode(fallbackText, lang)`，绕过 Worker 异步管线与 4000 字符安全门禁                                                                                                                                                                                                                                                                      | `components/diff/DiffCardUnifiedView.tsx:25-33`、`DiffCardSplitView.tsx:28-36`                                                                                                               | 滚动进入新行首帧在主线程同步执行 `hljs.highlight`，长行存在 ReDoS 卡顿风险                                                  |
| **D-05** | 大文件 Diff 渲染              | `renderTokens` 双层 DOM 叠加渲染（透明绝对定位 Token 层 + 相对定位 `hljs` HTML 层），使含字符级差异的行 DOM 节点翻倍                                                                                                                                                                                                                                                                               | `components/diff/DiffCardUnifiedView.tsx:46-99`、`DiffCardSplitView.tsx:50-104`                                                                                                              | 每条修改行产生双份完整文本与 `<span>` 树，DOM 节点数与样式计算开销 2×                                                       |
| **D-06** | 大文件 Diff 搜索              | `getSplitItems` 在存在搜索词 `qt` 时未过滤非匹配行反而展开全部折叠块；`DiffCodeViewer` 在渲染期重复 `.filter()` 判空                                                                                                                                                                                                                                                                               | `components/diff/useDiffData.ts:149-155`、`DiffCodeViewer.tsx:50-54`                                                                                                                         | Split 模式下搜索功能失效且全量行被推入渲染项；主线程每次渲染冗余分配过滤数组                                                |
| **D-07** | 虚拟代码查看器                | `VirtualPlainCodeViewer` 渲染期同步调用 `highlightCodeSafe`，而 `highlightCache` 拒绝缓存 $>500$ 字符的行，导致 501–4000 字符中等长行在滚动时每帧重复同步高亮 1500 字符                                                                                                                                                                                                                            | `components/diff/VirtualPlainCodeViewer.tsx:380`、`api/codeHighlight.ts:152-186`                                                                                                             | 含 501–4000 字符行的文件滚动时缓存命中率 0%，每帧同步执行数十次 1500 字符 `hljs.highlight`                                  |
| **D-08** | 内嵌 Diff 与代码块            | `<widget-diff>` 流式每帧全量重解析并同时构建 Unified + Split 双倍高亮任务且无虚拟化；`DiffCardFileList`、`ModernCodeBlock`、`FileViewerHistoryDrawer` 列表无虚拟化                                                                                                                                                                                                                                 | `components/custom-tags/WidgetDiff.tsx:44-70, 170-273`、`DiffCardFileList.tsx:390-462`、`ModernCodeBlock.tsx:26, 61-66`、`FileViewerHistoryDrawer.tsx:166-194`                               | 流式 $O(N^2)$ 解析 + 2×–3× 高亮任务量 + 數千行 DOM 直接挂载                                                                 |
| **F-01** | 文件树与导航                  | `useFileNavigation` 的 `flatTree` 将 `filter` 混入树遍历 `useMemo`，每次搜索按键对所有展开目录克隆数组并调用未缓存的 `localeCompare` 重排整棵树                                                                                                                                                                                                                                                    | `components/files/hooks/useFileNavigation.ts:196-232`                                                                                                                                        | 每次按键 $O(N \log N)$ 多语言字符串比较重排（`localeCompare` 无共享 `Intl.Collator`）                                       |
| **F-02** | 文件树虚拟滚动                | `FileTreeView` 在校验 `isNewSelection` 前先执行全树 $O(N)$ `findIndex(isSameFsPath)`；固定行高列表未启用 `heightOnly: true` 而是每次重映射 `ids` 数组；`<file-tree>` 标签无虚拟化                                                                                                                                                                                                                  | `components/files/FileTreeView.tsx:58-67, 89-105`、`components/custom-tags/FileTree.tsx:147-207`                                                                                             | 展开/过滤每次触发 $O(N)$ 路径归一化扫描 + 冗余 `ids` 数组分配与 ResizeObserver 管理                                         |
| **F-03** | 文件面包屑与分栏预览          | `FileBreadcrumb` 弹出层每帧对所有展开目录重复 `localeCompare` 排序且无虚拟化；`FilesCard` 分割线拖拽同时绑定 `pointermove` + `mousemove` 双倍触发全树 React 状态重渲染；CSV 预览无 `useMemo` 且无虚拟化；`onPreviewScroll` 绑在非滚动外层容器失效                                                                                                                                                  | `components/files/FileBreadcrumb.tsx:270-328`、`FilesCard.tsx:78-113`、`FilePreview.tsx:90-98, 136, 166-182, 236`                                                                            | 拖拽每帧 2 次全组件树重渲染；大 CSV 每次渲染同步解析全表并挂载 $R \times C$ 个 `<td>`                                       |
| **G-01** | 编排图谱 `FlowDagView`        | `useFlowDagStore` 为全局单例未按 `sessionId` 分区，多分屏不同会话的 3s 轮询互相覆盖；`FlowDagGraph` 无 `useMemo` 每次渲染调用两遍 `layerNodes`，且含环图未对环上游记忆化导致最坏 $O(2^V)$ 指数级遍历                                                                                                                                                                                               | `components/workspace/flowDagStore.ts:26-45`、`FlowDagView.tsx:50-52, 130-161`、`flowDagLayout.ts:72-110, 157-167`                                                                           | 多分屏跨会话数据污染与乒乓重渲染；单次渲染双倍布局计算，病态有环图 $O(2^V)$                                                 |
| **R-01** | 运行态面板 `RuntimePanel`     | `RuntimePanel` 与 `useRuntimePanelData` 各自启动一个 1000ms `setInterval`（共 2 个 1Hz 定时器），空闲态下每秒仍扫描全量会话与消息并创建新数组/函数引用，叠加 `state.sessions` 全表订阅，引发全面板 10 个子区段每秒 1–2 次无意义重渲染                                                                                                                                                              | `components/workspace/RuntimePanel.tsx:48, 58-65`、`useRuntimePanelData.ts:48, 51-110`、`ApprovalSection.tsx:25`                                                                             | 零任务空闲态下每秒 2 次全面板重渲染；流式输出期间每个 Token 触发全面板重渲染                                                |
| **R-02** | 总览面板 `OverviewCard`       | `useOverviewState` 无条件运行 1Hz 定时器刷新 `now`，而 `WorkspaceGitChangesView` 与 `SessionChangesView` 未对 `treeGitFiles` / `gitStatusFiles` 做 `useMemo`，每秒生成新数组引用击穿 `OverviewChangesList` 的 `React.memo`，导致最多 1000 条未虚拟化的 Git 变更行每秒全量重解析与重渲染                                                                                                            | `components/overview/useOverviewState.ts:62-65, 74-130`、`changes/WorkspaceGitChangesView.tsx:39-46, 107`、`changes/SessionChangesView.tsx:38-43`、`OverviewChangesList.tsx:35-131`          | 1000 个 Git 变更文件场景下，即便面板无活动任务，每秒触发 1000 行路径切分与 DOM 重渲染                                       |
| **R-03** | 引擎状态轮询 `useEngineState` | `fetchEngineLiveStatus` 每次返回新分配的 `activeRuns` 与 `pendingApprovals` 数组，导致 `_setState` 的引用相等性守卫恒为 `false`，每 4s 强制唤醒全部订阅组件                                                                                                                                                                                                                                        | `hooks/useEngineState.ts:142-160, 218-229`、`api/engineStatus.ts:159-192`                                                                                                                    | 引擎完全空闲时每 4s 仍擊穿 `_setState` 短路守卫，广播全量订阅者重渲染                                                       |
| **A-01** | 协作智能体卡片 `AgentCard`    | `AgentCard` 与 `AgentBrowsePad` 订阅 `selectSessionsById` 整表且消息列表 `agent.messages.map` 无虚拟化；`useApprovalCountdown` 以 100ms（10Hz）`setInterval` 更新浮点 state 驱动高频重渲染；`AgentTeamBoard` 在渲染期重复 `flatMap` 工具调用且混入非纯 `Date.now()`                                                                                                                                | `components/agent-card/AgentCard.tsx:57-79, 129-133, 248-261`、`AgentBrowsePad.tsx:36`、`useApprovalCountdown.ts:57-75`、`AgentTeamBoard.tsx:74-84, 249-262`、`agentTeamBoardUtils.ts:49-83` | 任意会话流式 Token 唤醒 `AgentCard`；子代理长对话全量挂载無虚拟化；审批倒计时 10Hz 整卡重渲染                               |
| **P-01** | 内置预览 `PreviewCard` 与桥接 | `PreviewCard` 订阅整张 `session` 对象且 `INSPECT_HOVER` 直接写入顶层 `useState` 引发每次鼠标移动全卡重渲染；`<iframe key={activeUrl}>` 在 URL 变化时强制销毁重建 iframe 实例；`usePreviewNavigation` 的 `history`/`bookmarks` `useMemo(..., [])` 空依赖冻结初始快照导致 `histTick` 空转重渲染；`previewBridgeScript.ts` 在点击拾取时直接读取 `el.outerHTML`/`el.textContent` 序列化整棵大 DOM 子树 | `components/workspace/PreviewCard.tsx:72-84, 186-189, 478-489`、`usePreviewNavigation.ts:128, 135-136, 198-199`、`dev-server/previewBridgeScript.ts:122-140, 183-185`                        | 拾取悬停每帧触发整卡 React 重渲染；点击根节点级容器序列化数 MB `outerHTML` 阻塞 iframe 主线程；URL 变更销毁重建浏览器上下文 |

---

## 二、逐项深度剖析与根因修复方案

---

### 方向一：终端视图（`TerminalCard` / `useXtermTerminal` / `ptyWriteGate` / `ptySessionApi` / `parseAnsi`）

#### [T-01] 后台隐藏终端 `ptyWriteGate` 缓存无字节上限，切回前台时 `pending.join('')` 同步单次灌入 xterm 引发主线程假死与内存暴涨

- **精确位置**：`apps/crish-desktop/src/components/workspace/ptyWriteGate.ts:35-65`
- **源码证据**：
  ```ts
  // apps/crish-desktop/src/components/workspace/ptyWriteGate.ts:35-65
  const pending: string[] = [];
  let hidden = Boolean(initialHidden);

  const flush = () => {
    if (pending.length === 0) return;
    // 合并为单次 write：减少 xterm 解析批次，且顺序严格保持
    const merged = pending.join('');
    pending.length = 0;
    try {
      sink.write(merged);
    } catch {
      // 终端已 dispose 时忽略，不抛到全局
    }
  };
  ...
  write(data: string) {
    if (!data) return;
    if (hidden) {
      pending.push(data);
      return;
    }
    sink.write(data);
  },
  ```
- **运行机制与极限负载推演**：
  1. 当终端面板处于非激活标签或隐藏态（`hidden === true`）时，后台命令（如 `cargo test`、大型构建、日志 `tail -f`、模型训练输出）通过 PTY 持续推送数据流。
  2. 与 `ptySessionApi.ts:32` 中设有 `PTY_HISTORY_MAX_BYTES = 256 * 1024`（256KB）上限的 `ptyHistoryMap` 不同，`ptyWriteGate.ts:35` 的 `pending: string[]` **没有任何字节上限或环形淘汰机制**。若后台任务持续输出 50MB 日志，`pending` 数组将无限驻留这 50MB 字符串，直接造成渲染进程内存泄漏式膨胀。
  3. 更严重的是，当用户点击切回该终端标签页时，`setHidden(false)`（第 47 行）立即调用 `flush()`：
     - `const merged = pending.join('')` 在 V8 堆上一次性分配一块 50MB 的连续大字符串（峰值内存瞬间翻倍至 100MB）；
     - 紧接着 `sink.write(merged)` 将 50MB 字符串单次同步塞入 `term.write(merged)`。虽然 xterm.js 内部解析器有分片逻辑，但单次传入数十 MB 字符串仍会同步执行巨大的 UTF-16 缓冲拷贝与解析调度，且 xterm 的 `scrollback`（`useXtermTerminal.ts:224` 设为 `5000` 行）最终只会保留最后 5000 行，前面 99% 的数据解析与行缓冲构建全部是无用功，导致切回标签页时 UI 冻结数百毫秒乃至数秒。
- **根因级修复方案**：
  1. **引入字节上限与尾部截断环形缓冲**：在 `createPtyWriteGate` 中维护累计字节数（或字符上限，如对齐 `scrollback: 5000` 约 `512KB` 上限 `PTY_GATE_MAX_CHARS = 512 * 1024`）。当 `hidden` 态下累计长度超过上限时，从头部弹出旧分片（使用游标索引 `headIdx` 代替 `Array.prototype.shift()` 以保持 $O(1)$ 入队/出队），并在截断处插入一行轻量提示或保留最新完整行，避免解析注定被 `scrollback` 丢弃的历史输出。
  2. **分帧流式排空（Chunked rAF Drain）**：`flush()` 时若待写入总量超过单帧预算（如 `32KB`），禁止执行 `pending.join('')` 一次性全量合并，而是按每帧 `32KB–64KB` 分片通过 `requestAnimationFrame` 渐进调用 `sink.write(chunk)`（若排空期间再次切为 `hidden` 则暂停排空），彻底消除切回终端时的单帧长任务阻塞。

---

#### [T-02] `observeTerminalHostVisibility` 在父级容器挂 `subtree: true` 监听 `style`/`class`，子树内高频样式变动触发同步 `offsetParent` / `getComputedStyle` 强制回流

- **精确位置**：`apps/crish-desktop/src/components/workspace/ptyWriteGate.ts:77-122`
- **源码证据**：
  ```ts
  // apps/crish-desktop/src/components/workspace/ptyWriteGate.ts:77-122
  export function isTerminalHostHidden(el: HTMLElement | null): boolean {
    if (!el || typeof document === 'undefined') return false;
    if (!el.isConnected) return true;
    if (el.closest('[aria-hidden="true"]')) return true;
    const panelHost = el.closest<HTMLElement>('[data-panel-id]');
    if (panelHost) {
      const activeRoot = panelHost.closest<HTMLElement>('[data-active-panel]');
      if (activeRoot) {
        const active = activeRoot.getAttribute('data-active-panel');
        const myId = panelHost.getAttribute('data-panel-id');
        if (active && myId && active !== myId) return true;
      }
    }
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') {
      return true;
    }
    return false;
  }
  ...
  const root =
    el.closest('[data-panel-id]')?.parentElement ??
    el.parentElement ??
    document.body;
  observer.observe(root, {
    attributes: true,
    subtree: true,
    attributeFilter: ['style', 'data-active-panel', 'aria-hidden', 'class'],
  });
  ```
- **运行机制与极限负载推演**：
  1. `observeTerminalHostVisibility` 在 `root`（`[data-panel-id]` 的父节点，即包含所有侧栏面板或整个工作区分屏的容器，回退时甚至是 `document.body`）上挂载了 `subtree: true` 的 `MutationObserver`，且过滤属性包含极高频变化的 `'style'` 和 `'class'`。
  2. 当终端处于可见状态时，以下任何高频操作都会触发该 `MutationObserver` 回调 `check()`：
     - xterm.js 自身在输入、光标移动、IME 组合输入或无障碍层更新时修改内部 `.xterm-helper-textarea` / `.xterm-accessibility` / 光标元素的 `style` 或 `class`；
     - 同属一个 `root` 下的兄弟面板（如虚拟滚动列表更新 `style="transform: translateY(...)"`、拖拽分割线修改宽度、按钮 hover 切换 `class`）。
  3. 每次 `check()` 执行 `isTerminalHostHidden(el)`，当前台可见时前几个条件均为 `false`，必定落入第 91 行：`if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed')`。读取 `el.offsetParent` 在刚发生 `style`/`class` 变更之后会**强制浏览器立即执行同步样式重算与布局回流（Forced Synchronous Layout / Reflow）**！在高频终端输出或分屏虚拟滚动时，每次 DOM 样式更新都被迫同步结算布局。
- **根因级修复方案**：
  1. **消除 `subtree: true` 全子树样式监听**：面板显隐只由祖先链上的容器状态决定（如 `panelHost` 及 `activeRoot` 的 `data-active-panel`、`aria-hidden`、`class`、`style`）。仅收集从 `el` 到 `root` 的有限个祖先元素（通常 3–6 个节点），对每个祖先节点以 `subtree: false` 单独调用 `observer.observe(ancestor, { attributes: true, attributeFilter: ['data-active-panel', 'aria-hidden', 'style', 'class'] })`，彻底隔离 xterm 内部子树与兄弟面板的高频 DOM 变动。
  2. **使用 `el.checkVisibility?.()` 或缓存布局判定**：在现代 WebView2 / Chromium 内核中，或通过 `IntersectionObserver` 监听可见性交叉状态，替代在 `MutationObserver` 微任务中频繁读取 `el.offsetParent` 触发的同步回流。

---

#### [T-03] 切换终端分屏（`isSplit`）改变 JSX 父级包装层级，导致主终端卸载重建、WebGL 上下文销毁及 256KB 历史重放，且多重冗余触发 `fit()` + `ptyResize` IPC

- **精确位置**：
  - `apps/crish-desktop/src/components/workspace/TerminalCard.tsx:65-78, 132-144, 212-264`
  - `apps/crish-desktop/src/components/workspace/useXtermTerminal.ts:345-364`
  - `apps/crish-desktop/src/components/workspace/ptyLifecycle.ts:176-215`
- **源码证据**：
  ```tsx
  // apps/crish-desktop/src/components/workspace/TerminalCard.tsx:212-239
  <div className={styles.body}>
    {!isSplit ? (
      <div className={styles.xtermWrap}>
        <InteractiveXtermTerminal
          ref={termHandleRef1}
          wsId={wsKey}
          sessionSlot="1"
          ...
        />
      </div>
    ) : (
      <div className={`${styles.splitContainer} ${splitMode === 'vertical' ? styles.splitVertical : styles.splitHorizontal}`}>
        <div
          className={`${styles.splitPane} ${activePane === 1 ? styles.activePane : ''}`}
          onMouseDown={() => setActivePane(1)}
        >
          <InteractiveXtermTerminal
            ref={termHandleRef1}
            wsId={wsKey}
            sessionSlot="1"
            ...
          />
        </div>
  ```
- **运行机制与极限负载推演**：
  1. **React 协调树深度改变导致主终端完全卸载与重建**：当 `isSplit` 从 `false` 切换到 `true`（或从分屏关闭回单屏）时，`.body` 下的第一个子元素从 `<div className={styles.xtermWrap}>`（内含 `<InteractiveXtermTerminal>`）变成了 `<div className={styles.splitContainer}>`（内含 `<div className={styles.splitPane}>` 再内含 `<InteractiveXtermTerminal>`）。由于组件在 JSX 树中的层级位置发生了改变，React 无法复用原有的 `InteractiveXtermTerminal` 实例，而是**彻底卸载（unmount）第 1 窗格的终端并在新层级下重新挂载（mount）**！
  2. **连锁代价**：
     - 原有 `Terminal` 实例与 `WebglAddon`（含 GPU 纹理图集和着色器上下文）被销毁；
     - 重新执行 `new Terminal(...)` + `new WebglAddon()` + `getXtermTheme()`（20 次 CSS 变量读取）；
     - 在 `ptyLifecycle.ts:176-185` 中从 `getPtyOutputHistory(ptyId)` 取出最多 256KB 的历史输出重新灌入新 `Terminal` 实例解析，造成明显的分屏切换闪白与卡顿。
  3. **四重冗余 `fit()` 与 `ptyResize` IPC 风暴**：
     - 在 `TerminalCard.tsx:136, 143` 中，`handleSplitHorizontal` / `handleSplitVertical` 手动调用了一次 `fitAll()`（内含双层 `requestAnimationFrame`）；
     - 紧接着 `splitMode` 改变触发 `TerminalCard.tsx:76-78` 的 `useEffect(() => { fitAll(); }, [fitAll, splitMode])`，再次调用一次 `fitAll()`；
     - 同时 `useXtermTerminal.ts:345-364` 挂载时执行双层 `rAF` 的 `fitAndSyncPtySize` + `ResizeObserver`，而 `ptyLifecycle.ts:196-215` 的 `schedulePostConnectFit` 又执行了一次双层 `rAF` + `setTimeout(..., 80)` 的 `fitAddon.fit()` 与 `ptyResize` IPC 调用！一次分屏切换在 80ms 内向后端连续发送 4–6 次 `ptyResize` IPC（触发 ConPTY / Unix PTY 反复发送 `SIGWINCH` 重绘终端内容）。
- **根因级修复方案**：
  1. **统一单屏与分屏的 DOM 包装结构**：始终保持 `<div className={styles.splitContainer}>` -> `<div className={styles.splitPane} key="pane-1">` -> `<InteractiveXtermTerminal sessionSlot="1" />` 的固定树层级；单屏模式下仅通过 CSS 类隐藏/不渲染 `pane-2`，确保 `pane-1` 的 `InteractiveXtermTerminal` 在分屏切换时 100% 原地复用，零卸载、零 WebGL 重建、零历史重放。
  2. **收敛 `fit` 与 `ptyResize` 到单一入口**：删除 `handleSplitHorizontal` / `handleSplitVertical` 中的手动 `fitAll()` 调用，并在 `ptyResize` 发射前增加行列去重守卫（记录上次已发送给后端的 `lastSentCols` / `lastSentRows`，若 `term.cols === lastSentCols && term.rows === lastSentRows` 则跳过 `ptyResize` IPC）。

---

#### [T-04] `useXtermTerminal` 监听 `<html style>` 属性变化，每次触发 20 个 CSS 变量递归最多 5 层的 `getComputedStyle` 读取与全屏 `term.refresh`

- **精确位置**：`apps/crish-desktop/src/components/workspace/useXtermTerminal.ts:35-144, 238-264`
- **源码证据**：
  ```ts
  // apps/crish-desktop/src/components/workspace/useXtermTerminal.ts:35-54, 258-264
  function readCssVar(name: string, fallback: string, depth = 0): string {
    if (typeof document === 'undefined' || depth > 4) return fallback;
    try {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
      if (!v) return fallback;
      if (v.startsWith('var(')) {
        const match = v.match(/var\(\s*(--[^,\s)]+)\s*(?:,\s*([^)]+))?\)/);
        if (match && match[1]) {
          return readCssVar(match[1], match[2]?.trim() || fallback, depth + 1);
        }
      }
      return v;
    } catch {
      return fallback;
    }
  }
  ...
  const themeObserver = new MutationObserver(() => {
    updateTerminalStyles();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'style'],
  });
  ```
- **运行机制与极限负载推演**：
  1. `getXtermTheme()`（第 62–144 行）连续调用 `readCssVar` **20 次**，每次内部都调用 `getComputedStyle(document.documentElement).getPropertyValue(name)`（若遇到 `var(--...)` 还会递归调用最多 5 层），随后还调用 `parseColorToOklch` 解析背景色与前景色。
  2. `useXtermTerminal` 在每个挂载的终端实例内不仅监听了 `crish-fonts-changed`、`crish-tokens-updated`、`crish-canvas-recolor` 三个自定义事件，还对 `document.documentElement` 挂载了监听 `['data-theme', 'style']` 的 `MutationObserver`。
  3. 当应用内任何逻辑修改 `document.documentElement.style`（例如全局缩放、拖拽时的临时 CSS 变量注入或主题过渡脚本逐个设置 `--*` 属性）时，若分屏挂载了 2–4 个终端实例，每次 `<html style>` 变动都会同步触发所有终端执行 `updateTerminalStyles()` → $20 \times N$ 次 `getComputedStyle` 读取 + `term.refresh(0, term.rows - 1)` 全画布强制重绘；且当主题切换同时修改 `data-theme`、`style` 并派发 `crish-tokens-updated` / `crish-canvas-recolor` 事件时，`updateTerminalStyles()` 会在同一帧内被重复同步执行 3–4 次。
- **根因级修复方案**：
  1. **单次获取 `CSSStyleDeclaration` 引用**：在 `getXtermTheme()` 入口处仅调用一次 `const rootStyle = getComputedStyle(document.documentElement)`，将 `rootStyle` 传入 `readCssVar(rootStyle, name, fallback)` 复用，避免 20+ 次重复调用 `getComputedStyle`。
  2. **按帧合并（`requestAnimationFrame` Coalescing）与模块级主题缓存**：将 `updateTerminalStyles` 用单帧 `rAF` 合并去重（同一帧内 `MutationObserver` + 多个 `window` 事件只执行一次重算），並在模块级缓存当前主题快照（比较 `data-theme` 与关键 token 签名未变时直接复用 `ITheme` 对象）。

---

#### [T-05] `recordPtyOutputHistory` 每次用 `TextEncoder.encode(chunk)` 分配 `Uint8Array` 测长、`chunks.shift()` 重复编码，且 `trimToUtf8ByteLimit` 逐字符调用 `textEncoder.encode`

- **精确位置**：`apps/crish-desktop/src/api/ptySessionApi.ts:57-60, 78-141`
- **源码证据**：
  ```ts
  // apps/crish-desktop/src/api/ptySessionApi.ts:57-60, 78-141
  interface PtyHistoryEntry {
    chunks: string[];
    totalBytes: number;
  }
  ...
  function getChunkBytes(chunk: string): number {
    if (!textEncoder) {
      return chunk.length * 2;
    }
    return textEncoder.encode(chunk).length;
  }
  ...
  while (entry.chunks.length > 0 && entry.totalBytes > PTY_HISTORY_MAX_BYTES) {
    const oldest = entry.chunks.shift();
    if (!oldest) break;
    entry.totalBytes = Math.max(0, entry.totalBytes - getChunkBytes(oldest));
  }
  ...
  function trimToUtf8ByteLimit(input: string, maxBytes: number): string {
    if (maxBytes <= 0 || !input) return '';
    if (getChunkBytes(input) <= maxBytes) return input;
    const points = Array.from(input);
    let bytes = 0;
    let startIdx = points.length;
    for (let i = points.length - 1; i >= 0; i -= 1) {
      const charBytes = getChunkBytes(points[i]);
      if (bytes + charBytes > maxBytes) {
        break;
      }
      bytes += charBytes;
      startIdx = i;
    }
    return points.slice(startIdx).join('');
  }
  ```
- **运行机制与极限负载推演**：
  1. **无缓存的重复 `Uint8Array` 分配与 $O(K)$ `shift()`**：每收到一个 PTY 输出块，`recordPtyOutputHistory` 调用 `getChunkBytes(chunk)`，内部执行 `textEncoder.encode(chunk).length`——这会在堆上分配一整个 `Uint8Array` 字节数组仅仅为了读取 `.length`（随后立即变成 GC 垃圾）。更糟的是，`PtyHistoryEntry` 只存了 `chunks: string[]` 而没有记录每个 chunk 对应的 `byteLength`。当历史达到 256KB 上限后，后续**每一个新 chunk 到来**都会进入 `while` 淘汰循环：调用 `entry.chunks.shift()`（触发 $O(K)$ 数组元素前移），并对彈出的 `oldest` **再次调用 `getChunkBytes(oldest)` 重新分配 `Uint8Array` 编码一次**！
  2. **`trimToUtf8ByteLimit` 的灾难性逐字符编码**：当单次 chunk 超过 `PTY_HISTORY_MAX_BYTES`（256KB）时，`trimToUtf8ByteLimit` 执行：
     - `const points = Array.from(input)`：将 >256KB 的字符串拆解成数十万个单字符字符串组成的庞大数组；
     - 在 `for` 循环中，对每一个字符调用 `getChunkBytes(points[i])` -> **`textEncoder.encode(points[i]).length`**！这意味着截断一个 256KB 的块会连续执行最多 **262,144 次 `textEncoder.encode()` 调用，在主线程瞬间分配 26 万个微型 `Uint8Array` 对象**，直接引爆 V8 新生代 GC 停顿（Scavenge Pause）！
- **根因级修复方案**：
  1. **缓存分片字节数 + 游标式环形队列**：将 `PtyHistoryEntry` 改为存储 `{ text: string; bytes: number }[]`（或平行数组 + `head` 游标），入队时计算一次字节数并保存，淘汰时直接减去 `oldest.bytes`，零二次编码、零 `shift()` 数组搬移。
  2. **零分配 UTF-8 字节计数与 $O(1)$ 尾部切片**：计算字符串 UTF-8 字节数无需调用 `textEncoder.encode` 分配 `Uint8Array`；或对 `trimToUtf8ByteLimit` 直接从字符串末尾截取 `input.slice(-maxBytes)`（因为 UTF-8 单字符字节数 $\ge$ UTF-16 码元数除以 2，先截取末尾最多 `maxBytes` 个 UTF-16 码元并跳过首个孤立低代理项 `[\uDC00-\uDFFF]`，再从末尾按码点码值判断 UTF-8 字节数：`code <= 0x7F ? 1 : code <= 0x7FF ? 2 : code >= 0xD800 && code <= 0xDFFF ? 2 : 3`），完全消除 `Array.from(input)` 与 26 万次 `textEncoder.encode` 分配。

---

#### [T-06] `ModernTerminalToolCall` 流式输出每帧全量 `.replace` + `.split('\n')`，渲染期裸调 `parseAnsi` 无行级记忆化，展开态无虚拟滚动且跨行丢失 SGR 状态

- **精确位置**：
  - `apps/crish-desktop/src/components/chat-tool-call/ModernTerminalToolCall.tsx:41-65, 129-163`
  - `apps/crish-desktop/src/utils/parseAnsi.ts:52-121`
- **源码证据**：
  ```tsx
  // apps/crish-desktop/src/components/chat-tool-call/ModernTerminalToolCall.tsx:41-65, 129-163
  const cleanOutput = useMemo(() => {
    if (!output) return '';
    return output.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }, [output]);
  ...
  const { allLines, totalLines, shouldFold } = useMemo(() => {
    if (!cleanOutput) return { allLines: [], totalLines: 0, shouldFold: false };
    const lines = cleanOutput.split('\n');
    const total = lines.length;
    return {
      allLines: lines,
      totalLines: total,
      shouldFold: total > FOLD_THRESHOLD,
    };
  }, [cleanOutput]);
  ...
  {shouldFold && !isFullExpanded ? (
    <>
      {allLines.slice(0, HEAD_LINES).map((line, i) => (
        <div key={`head-${i}`} className="terminal-line">{parseAnsi(line)}</div>
      ))}
      ...
      {allLines.slice(-TAIL_LINES).map((line, i) => (
        <div key={`tail-${i}`} className="terminal-line">{parseAnsi(line)}</div>
      ))}
    </>
  ) : (
    allLines.map((line, i) => (
      <div key={i} className="terminal-line">{parseAnsi(line)}</div>
    ))
  )}
  ```
- **运行机制与极限负载推演**：
  1. **流式输出期 $O(N^2)$ 全量字符串替换与切分**：当命令正在执行（`status === 'running'`）且折叠显示（仅展示头 15 行 + 尾 15 行）时，每收到一次增量输出，`cleanOutput` 都会对整段累积文本执行两次全量正则替换 `.replace(/\r\n/g, '\n').replace(/\r/g, '\n')` 并通过 `.split('\n')` 分配包含数千个字符串元素的 `allLines` 数组。
  2. **渲染期无缓存裸调 `parseAnsi`**：`parseAnsi(line)` 直接写在 JSX `.map()` 内部而非 `useMemo` 中。当用户点击复制命令或复制输出按钮（修改 `copied` / `copiedOutput` state）或父组件重渲染时，所有可见行都会重新执行正则匹配与 `React.createElement('span', { style: ... })`。
  3. **展开态无虚拟滚动 + 跨行 SGR 颜色丢失**：点击「展开隐藏的 N 行输出」后（`isFullExpanded = true`），高达 2000+ 行输出（每行含多个 `parseAnsi` 生成的内联样式 `<span>`）一次性直接挂载到聊天消息列表 DOM 中，无任何虚拟滚动或 `content-visibility: auto` 隔离；且由于按行独立调用 `parseAnsi(line)`，跨行的 ANSI 颜色序列（如第 1 行开启 `\x1b[31m` 红色、第 10 行才 `\x1b[0m` 重置）在第 2–10 行全部丢失颜色状态。
- **根因级修复方案**：
  1. **折叠态头尾 O(1) 切片提取**：当 `!isFullExpanded` 时，无需对全量文本执行 `.split('\n')`，仅用 `indexOf('\n')` 提取前 `HEAD_LINES`（15 行）及 `lastIndexOf('\n')` 提取后 `TAIL_LINES`（15 行），将流式折叠态复杂度从 $O(N)$ 降至 $O(1)$。
  2. **有状态跨行 ANSI 解析与 `useMemo` 缓存 + 展开态虚拟化**：将 `parseAnsi` 升级为支持传入/返回 `AnsiState` 的流式状态机并放入 `useMemo`（仅依赖可见行集合），对展开态 >100 行的输出容器接入固定行高虚拟滚动或设置行级 `content-visibility: auto; contain-intrinsic-size: auto 18px`。

---

### 方向二：大文件 Diff、代码查看器与文件树（`components/diff/**` / `components/files/**`）

#### [D-01] `useDiffData` 对文件列表中所有 $M$ 个文件急切计算 `computedChangesByFile`、`unifiedRenderCache` 与 `splitRenderCache`；单文件展开折叠块触发全量文件重算

- **精确位置**：
  - `apps/crish-desktop/src/components/diff/useDiffData.ts:295-302, 360-419`
  - `apps/crish-desktop/src/components/diff/DiffCardFileList.tsx:191, 381`
- **源码证据**：
  ```ts
  // apps/crish-desktop/src/components/diff/useDiffData.ts:295-302, 360-419
  const computedChangesByFile = useMemo(() => {
    const map = new Map<string, ComputedChange[]>();
    for (const f of fileList) {
      const d = getFileDiffData(f.filePath);
      map.set(f.filePath, computeDiffLines(d?.changes || []));
    }
    return map;
  }, [fileList, getFileDiffData]);
  ...
  const handleExpandBlock = useCallback((filePath: string, blockId: string) => {
    setExpandedBlocks((prev) => {
      const set = new Set(prev[filePath] || []);
      set.add(blockId);
      return { ...prev, [filePath]: set };
    });
  }, []);

  const unifiedRenderCache = useMemo(() => {
    const map = new Map<string, UnifiedRenderItem[]>();
    for (const f of fileList) {
      const comp = computedChangesByFile.get(f.filePath) || [];
      const exp = expandedBlocks[f.filePath] || new Set<string>();
      map.set(f.filePath, getUnifiedItems(comp, searchQuery, exp, f.filePath));
    }
    return map;
  }, [fileList, computedChangesByFile, searchQuery, expandedBlocks]);

  const splitRenderCache = useMemo(() => {
    const map = new Map<string, SplitRenderItem[]>();
    for (const f of fileList) {
      const comp = computedChangesByFile.get(f.filePath) || [];
      const exp = expandedBlocks[f.filePath] || new Set<string>();
      map.set(f.filePath, getSplitItems(comp, searchQuery, exp, f.filePath));
    }
    return map;
  }, [fileList, computedChangesByFile, searchQuery, expandedBlocks]);
  ```
- **运行机制与极限负载推演**：
  1. **UI 只展示 1 个激活文件，数据层却对全部 $M$ 个文件同時构建 Unified 和 Split 两套完整缓存**：在 `DiffCardFileList.tsx:191, 381` 中，只有 `active = current?.filePath === f.filePath` 的**唯一一个当前选中文件**会渲染 `DiffCodeViewer`，且同一时刻用户只处于 `viewMode === 'unified'` 或 `'split'` 之一。然而 `useDiffData` 却在 `useMemo` 中遍历 `fileList` 的所有 $M$ 个文件，同时计算 `computedChangesByFile`、`unifiedRenderCache`（内含 `annotateIntralineTokens` 字符级 Myers/LCS 差异计算！）和 `splitRenderCache`（内含 `buildSplitPairs` 配对与字符级差异计算！）。
  2. **单文件点击「展开其余 N 行」引发全量 $M$ 个文件级联重算**：当用户在当前文件中点击折叠条触发 `handleExpandBlock(filePath, blockId)` 时，`expandedBlocks` 的根对象引用改变。由于 `unifiedRenderCache` 和 `splitRenderCache` 依赖整个 `expandedBlocks`，它会把**其余 $M-1$ 个根本没有变动的文件**全部重新执行一遍 `getUnifiedItems` 和 `getSplitItems`！
- **根因级修复方案**：
  1. **按需惰性计算（Lazy Per-Active-File & Active-ViewMode Derivation）**：仅针对当前激活的 `currentFile?.filePath` 以及当前激活的 `viewMode`（`'unified'` 或 `'split'`）计算渲染项；或者维护按 `filePath` 独立缓存的 `Map<string, { changesRef, expRef, searchQuery, items }>`，当 `expandedBlocks[filePath]` 引用未变时直接复用该文件的缓存结果，使单文件展开操作的时间复杂度严格收敛为 $O(L_{\text{active}})$。

---

#### [D-02] `useDiffData` 订阅 `session.messages`，流式对话每个 Token 触发全历史消息扫描与 `mergeDiff` 数组拼接，且无条件击穿 Git 模式的 Diff 渲染缓存

- **精确位置**：
  - `apps/crish-desktop/src/components/diff/useDiffData.ts:238-293`
  - `apps/crish-desktop/src/api/diffPanelHelpers.ts:30-74`
- **源码证据**：
  ```ts
  // apps/crish-desktop/src/components/diff/useDiffData.ts:238-293
  const aiTurns = useMemo<AiTurnDiffGroup[]>(() => {
    const msgs = session?.messages || [];
    return msgs
      .filter((m) => m.sender === 'assistant')
      .map((m, idx) => {
        const files = collectMessageDiffs(m);
        return {
          messageId: m.id,
          turnIndex: idx + 1,
          timestamp: m.timestamp,
          summary: (m.text || '').replace(/\s+/g, ' ').trim().slice(0, 48) || `第 ${idx + 1} 轮修改`,
          files,
        };
      })
      .filter((g) => g.files.length > 0);
  }, [session?.messages]);
  ...
  const getFileDiffData = useCallback(
    (filePath: string): FileDiff | undefined => {
      if (sourceMode === 'git') {
        return gitDiffCache[filePath];
      }
      ...
      return mergedSessionFiles.find((d) => d.filePath === filePath);
    },
    [sourceMode, gitDiffCache, selectedTurnId, aiTurns, mergedSessionFiles]
  );
  ```
- **运行机制与极限负载推演**：
  1. **流式输出期每个 Token 触发全历史消息扫描与 Diff 重解析**：当主对话正在流式输出正文（`m.text` 每秒更新数十次）时，`session.messages` 数组引用随之每帧变化。`aiTurns` 没有任何提前短路机制，每帧遍历会话中所有历史助手消息，对每条消息执行 `(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 48)`（对数万字长消息做全串正则替换！）并调用 `collectMessageDiffs(m)`（当 `tc.diffs` 为空时调用 `resolveToolDiffs` 从工具参数/结果重新解析 Diff，并通过 `[...(prev.changes || []), ...(d.changes || [])].slice(0, 400)` 反复拷贝数组）。
  2. **Git 模式下被 `aiTurns` / `mergedSessionFiles` 假依赖连坐击穿**：看第 279–293 行的 `getFileDiffData`：当 `sourceMode === 'git'`（默认模式！）时，函数体第一行就直接 `return gitDiffCache[filePath];`，根本不使用 `aiTurns` 和 `mergedSessionFiles`！但เพราะ `useCallback` 依赖数组同时列出了 `[sourceMode, gitDiffCache, selectedTurnId, aiTurns, mergedSessionFiles]`，导致流式对话每吐出一个 Token，`aiTurns` 引用变化 → `mergedSessionFiles` 引用变化 → `getFileDiffData` 引用变化 → **`computedChangesByFile`、`unifiedRenderCache`、`splitRenderCache` 在 Git 模式下被每帧全量推倒重算**！
- **根因级修复方案**：
  1. **切断 `sourceMode === 'git'` 时的会话消息依赖**：将 `aiTurns` 的计算门控在 `sourceMode === 'session'` 下（当 `sourceMode === 'git'` 时直接返回空数组 `EMPTY_TURNS`），并在 `getFileDiffData` 中当 `sourceMode === 'git'` 时不依赖 `aiTurns` / `mergedSessionFiles`。
  2. **按消息引用缓存 `collectMessageDiffs`**：使用 `WeakMap<SessionMessage, FileDiff[]>` 缓存已封口历史消息的 `collectMessageDiffs(m)` 结果，且提取摘要时先截取 ` (m.text || '').slice(0, 120).replace(/\s+/g, ' ').trim().slice(0, 48)`，避免对数万字正文做全串正则替换。

---

#### [D-03] `useDiffHighlightMap` 在虚拟滚动窗口移动 1 行时，先用未高亮的 `escapeHtml` 覆盖整张 Map，导致视口已高亮的 ~49 行瞬间闪烁回纯文本并重复派发 Worker 批处理

- **精确位置**：
  - `apps/crish-desktop/src/api/codeHighlightBatch.ts:102-143`
  - `apps/crish-desktop/src/components/diff/DiffCardUnifiedView.tsx:167-178`
  - `apps/crish-desktop/src/components/diff/DiffCardSplitView.tsx:181-186`
- **源码证据**：
  ```ts
  // apps/crish-desktop/src/api/codeHighlightBatch.ts:102-143
  export function useDiffHighlightMap(
    items: readonly HighlightBatchItem[]
  ): ReadonlyMap<string, string> {
    const [map, setMap] = useState<ReadonlyMap<string, string>>(
      () => new Map()
    );

    const itemsKey = useMemo(
      () =>
        items
          .map((i) => `${i.id}:${i.filePath ?? ''}:${i.code.length}`)
          .join('|'),
      [items]
    );

    useEffect(() => {
      if (items.length === 0) {
        setMap((prev) => (prev.size === 0 ? prev : new Map()));
        return;
      }
      let cancelled = false;
      // 先同步填轉义兜底（首帧立即可读，不阻塞文本显示）
      setMap(new Map(items.map((i) => [i.id, escapeHtml(i.code)])));

      void highlightBatchAsync(items).then((res) => {
        if (cancelled) return;
        setMap(res);
      });

      return () => {
        cancelled = true;
      };
    }, [itemsKey]);

    return map;
  }
  ```
- **运行机制与极限负载推演**：
  1. `DiffCardUnifiedView.tsx:167-178` 与 `DiffCardSplitView.tsx:181-186` 将当前虚拟滚动窗口切片 `hlItems`（即 `startIndex` 到 `endIndex` 的约 50 行）传入 `useDiffHighlightMap(hlItems)`。
  2. 当用户滚动哪怕 **1 行**（例如窗口从 `[0..50]` 移动到 `[1..51]`）时：
     - 窗口内第 `1..50` 行（共 49 行）原本已经完成了语法高亮，存储在 `map` 中；
     - 但因为新增了第 `51` 行，`itemsKey` 发生变化，触发 `useEffect`；
     - 第 125 行立即同步执行：`setMap(new Map(items.map((i) => [i.id, escapeHtml(i.code)])))`——**把第 `1..50` 行已经渲染好的彩色语法高亮 HTML 全部抹掉，瞬间重置为无高亮的纯文本 `escapeHtml(i.code)`**！
     - 紧接着第 127 行调用 `highlightBatchAsync(items)`，将全部 50 行（包括已经算过的 49 行）重新打包发给 Worker 高亮；当异步 Promise 返回时再调一次 `setMap(res)` 把颜色刷回来！
  3. **后果**：用户在滚动 Diff 视图时，不仅每滚 1 行触发 **2 次额外的 React 重渲染**和 **50 行重复的 Worker 高亮计算**，而且屏幕上原本已经有颜色的代码行会在每次滚动时**疯狂闪烁（彩色 → 纯白无高亮 → 彩色）**！
- **根因级修复方案**：
  1. **增量合并保留已有高亮结果，仅对缺失项发起异步高亮**：
     - 在 `useDiffHighlightMap` 中，先对照当前 `map`（或模块级 LRU 高亮缓存）：对已经存在于缓存中的 `item.id`，直接保留其高亮 HTML；
     - 挑出真正未命中的增量行 `missingItems = items.filter(i => !cachedMap.has(i.id))`；
     - 若 `missingItems.length === 0`，无需发起异步请求；若存在未命中行，仅对 `missingItems` 填充 `escapeHtml` 初始值并仅将 `missingItems` 发送给 `highlightBatchAsync(missingItems)`，返回后以 `setMap(prev => { const next = new Map(prev); ... })` 增量合并（并限制 Map 最大容量如 1000 条防内存泄漏）。

---

#### [D-04] `renderTokens` 在 `hlHtml` 未就绪帧回退同步调用 `highlightCode(fallbackText, lang)`，绕过 Worker 异步管线与 4000 字符安全门禁

- **精确位置**：
  - `apps/crish-desktop/src/components/diff/DiffCardUnifiedView.tsx:25-33`
  - `apps/crish-desktop/src/components/diff/DiffCardSplitView.tsx:28-36`
- **源码证据**：
  ```tsx
  // apps/crish-desktop/src/components/diff/DiffCardUnifiedView.tsx:25-33
  function renderTokens(
    tokens: DiffToken[] | undefined,
    fallbackText: string,
    filePath: string,
    hlHtml?: string
  ) {
    const lang = guessLang(filePath);
    const html = hlHtml ?? highlightCode(fallbackText, lang);
    if (!tokens || tokens.length === 0) {
      return <span dangerouslySetInnerHTML={{ __html: html }} />;
    }
  ```
- **运行机制与极限负载推演**：
  1. 当用户滚动 Diff 视图使新行进入视口的那一帧（React render 阶段），`useDiffHighlightMap` 的 `useEffect` 尚未执行，因此 `hlMap.get(stableKey)` 返回 `undefined`，传入 `renderTokens` 的 `hlHtml` 为 `undefined`。
  2. 在 `DiffCardUnifiedView.tsx:271-278` 中，虽然无 `tokens` 的普通行加了 `item.tokens ? renderTokens(...) : hlHtml ? <span dangerouslySetInnerHTML={{ __html: hlHtml }} /> : <span>{item.change.content}</span>` 分支，但**所有带行内差异 `item.tokens` 的修改行**，以及 **`DiffCardSplitView.tsx:266, 326` 中的所有行（无论有无 `tokens` 都无条件调用 `renderTokens`！）**，在 `hlHtml` 为 `undefined` 的首帧都会直接命中第 32 行：`const html = hlHtml ?? highlightCode(fallbackText, lang)`！
  3. 这意味着：
     - `DiffCardSplitView` 中新滚入视口的每一行，在首帧都会**在主线程同步执行 `highlightCode`**，然后再在 `useEffect` 中被重置为 `escapeHtml`，再由 Worker 算一遍！
     - 更危险的是，这里调用的是裸 `highlightCode(fallbackText, lang)` 而非 `highlightCodeSafe`，**完全绕过了 `MAX_HIGHLIGHT_LEN = 4000` 与 `HEAD_HIGHLIGHT_LEN = 1500` 的超长行 ReDoS 防护门禁**！若 Diff 中包含一行 50KB 的 minified JS/JSON，滚动到该行的瞬间主线程将直接同步卡死在 `hljs.highlight` 中。
- **根因级修复方案**：
  1. 将 `renderTokens` 中的回退逻辑改为 `const html = hlHtml ?? escapeHtml(fallbackText)`（或先查内存 `highlightCache`，未命中时一律回退轻量 `escapeHtml(fallbackText)` 等待 `useDiffHighlightMap` 异步回填），**严禁在渲染函数内回退调用同步 `highlightCode`**。

---

#### [D-05] `renderTokens` 双层 DOM 叠加渲染（透明绝对定位 Token 层 + 相对定位 `hljs` HTML 层），使含字符级差异的行 DOM 节点翻倍

- **精确位置**：
  - `apps/crish-desktop/src/components/diff/DiffCardUnifiedView.tsx:46-99`
  - `apps/crish-desktop/src/components/diff/DiffCardSplitView.tsx:50-104`
- **源码证据**：
  ```tsx
  // apps/crish-desktop/src/components/diff/DiffCardUnifiedView.tsx:46-99
  return (
    <span style={{ position: 'relative', display: 'inline' }}>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
           inset: 0,
          color: 'transparent',
          pointerEvents: 'none',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {tokens.map((t, i) => { ... })}
      </span>
      <span
        style={{ position: 'relative' }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </span>
  );
  ```
- **运行机制与极限负载推演**：
  1. 为了同时展示语法高亮（`hljs` HTML）和行内字符级增删背景（`tokens`），`renderTokens` 采用了一个绝对定位的透明文本层（渲染一遍完整的 `tokens.map` 文本与背景色 `<span>`）叠加在相对定位的 `dangerouslySetInnerHTML` 语法高亮层之上。
  2. 这导致每一条带行内差异的代码行在 DOM 中都存在**两份完整的文本内容与双倍的 `<span>` 节点树**；且在自动换行（`whiteSpace: 'pre-wrap', wordBreak: 'break-all'`）场景下，浏览器必须对两套完全相同的长文本独立执行两次行框布局（Line Box Layout），极易在亚像素字体度量或伪元素差异下出现高亮背景与上层文字错位，同时使合成与布局开销翻倍。
- **根因级修复方案**：
  1. **使用 CSS Custom Highlight API 或单树区间切片合并**：对于单行字符级高亮，可将 `tokens` 的变更区间 `[startOffset, endOffset]` 在生成/消费 `html` 时按文本偏移量注入 `<mark class="diff-intraline-mark">` 标签（单树单次布局），或使用原生 `CSS.highlights`（`Range` 对象注册背景高亮），消除双层重复文本 DOM 树。

---

#### [D-06] `getSplitItems` 在存在搜索词 `qt` 时未过滤非匹配行反而展开全部折叠块；`DiffCodeViewer` 在渲染期重复 `.filter()` 判空

- **精确位置**：
  - `apps/crish-desktop/src/components/diff/useDiffData.ts:149-155`
  - `apps/crish-desktop/src/components/diff/DiffCodeViewer.tsx:50-54`
- **源码证据**：
  ```ts
  // apps/crish-desktop/src/components/diff/useDiffData.ts:149-155
  export function getSplitItems(
    computed: ComputedChange[],
    searchQuery: string,
    expandedSet: Set<string>,
    filePath: string
  ): SplitRenderItem[] {
    const pairs = annotateSplitIntraline(buildSplitPairs(computed));
    const qt = searchQuery.trim().toLowerCase();
    if (qt) {
      return pairs.map((p, idx) => ({
        kind: 'pair' as const,
        id: `${filePath}-sp-${idx}`,
        left: p.left,
        right: p.right,
        leftTokens: p.leftTokens,
        rightTokens: p.rightTokens,
      }));
    }
  ```
  ```tsx
  // apps/crish-desktop/src/components/diff/DiffCodeViewer.tsx:50-54
  const q = searchQuery.trim();
  if (
    q &&
    computed.filter((item) =>
      item.change.content.toLowerCase().includes(q.toLowerCase())
    ).length === 0
  ) {
  ```
- **运行机制与极限负载推演**：
  1. 在 `useDiffData.ts:75-86` 中，`getUnifiedItems` 当 `if (qt)` 时会通过 `computed.filter((item) => item.change.content.toLowerCase().includes(qt))` 过滤出匹配搜索词的行。
  2. 然而在 `getSplitItems`（第 149–155 行）中，当 `if (qt)` 为真时，代码**完全漏掉了 `.filter(...)`**，而是直接把所有的 `pairs` 原封不动映射返回（甚至跳过了后面的 `COLLAPSE_THRESHOLD` 折叠逻辑，导致搜索时不仅没过滤，反而把未展开的数千行上下文全部展开塞进列表）！
  3. 此外，在 `DiffCodeViewer.tsx:50-54` 中，每次渲染都对全量 `computed` 数组执行 `.filter((item) => item.change.content.toLowerCase().includes(q.toLowerCase())).length === 0`（在每次循环迭代中重复调用 `q.toLowerCase()` 并分配完整过滤数组），而实际上 `unifiedRenderItems.length === 0` 已经计算好了该结果。
- **根因级修复方案**：
  1. 在 `getSplitItems` 的 `if (qt)` 分支中补齐过滤条件：`return pairs.filter((p) => (p.left?.change.content.toLowerCase().includes(qt) ?? false) || (p.right?.change.content.toLowerCase().includes(qt) ?? false)).map(...)`。
  2. 在 `DiffCodeViewer.tsx:50-54` 中直接判断 `(viewMode === 'unified' ? unifiedRenderItems.length === 0 : splitRenderItems.length === 0)`，消除渲染期冗余的全量 `.filter()` 遍历与数组分配。

---

#### [D-07] `VirtualPlainCodeViewer` 渲染期同步调用 `highlightCodeSafe`，而 `highlightCache` 拒绝缓存 $>500$ 字符的行，导致 501–4000 字符中等长行在滚动时每帧重复同步高亮 1500 字符

- **精确位置**：
  - `apps/crish-desktop/src/components/diff/VirtualPlainCodeViewer.tsx:380`
  - `apps/crish-desktop/src/api/codeHighlight.ts:152-186`
- **源码证据**：
  ```ts
  // apps/crish-desktop/src/api/codeHighlight.ts:144-186
  export function highlightCode(code: string, lang: string): string {
    const raw = code || '';
    if (!raw.trim()) return escapeHtml(raw);
    const cacheKey = `${lang}:${raw}`;
    const cached = highlightCache.get(cacheKey);
    if (cached !== undefined) return cached;
    ...
    if (raw.length <= 500) {
      if (highlightCache.size >= MAX_CACHE_SIZE) { ... }
      highlightCache.set(cacheKey, html);
    }
    return html;
  }
  ...
  export function highlightCodeSafe(code: string, filePath: string): string {
    const raw = code || '';
    if (!raw) return '';
    if (raw.length > MAX_HIGHLIGHT_LEN) {
      return escapeHtml(raw);
    }
    const lang = guessLang(filePath);
    if (raw.length > HEAD_HIGHLIGHT_LEN) {
      const head = raw.slice(0, HEAD_HIGHLIGHT_LEN);
      const tail = raw.slice(HEAD_HIGHLIGHT_LEN);
      return highlightCode(head, lang) + escapeHtml(tail);
    }
    return highlightCode(raw, lang);
  }
  ```
- **运行机制与极限负载推演**：
  1. `VirtualPlainCodeViewer.tsx:380` 在 React 同步渲染阶段对视口及上下缓冲区（`OVERSCAN = 20`，共约 70 行）的每一行直接调用 `highlightCodeSafe(l.text, filePath)`。
  2. 看 `codeHighlight.ts:152`与 `178-184` 的阈值矛盾：
     - `highlightCodeSafe` 允许最多 `MAX_HIGHLIGHT_LEN = 4000` 字符的行进入 `highlightCode`，并对 `1501..4000` 字符的行截取前 `HEAD_HIGHLIGHT_LEN = 1500` 字符送入 `highlightCode(head, lang)`；
     - 但是 `highlightCode` 第 152 行却写着 **`if (raw.length <= 500) { highlightCache.set(cacheKey, html); }`**！
  3. **后果**：任何长度在 **501 到 4000 字符之间**的代码行（例如含长 SVG 路径、长正则、长类型定义、长日志或宽表数据的代码行），每次调用 `highlightCodeSafe` 都会同步执行耗时最重的 `hljs.highlight(1500 chars)`，但**计算结果因为 `raw.length > 500` 永远不会被写入 `highlightCache`**！当用户在 `VirtualPlainCodeViewer` 中上下滚动浏览包含此类行的文件时，缓存命中率为 **0%**，每一个滚动帧都会在主线程重复同步执行数十次 1500 字符的 `hljs.highlight`，造成严重的滚动掉帧。
- **根因级修复方案**：
  1. **对齐缓存阈值与高亮上限**：既然 `highlightCode` 的输入在 `highlightCodeSafe` 下最大为 `HEAD_HIGHLIGHT_LEN = 1500` 字符，应将 `codeHighlight.ts:152` 的缓存准入条件提升至 `if (raw.length <= HEAD_HIGHLIGHT_LEN)`（即 `1500`），使最耗时的 501–1500 字符高亮结果能够被 `highlightCache` 100% 命中复用。

---

#### [D-08] `<widget-diff>` 流式每帧全量重解析并同时构建 Unified + Split 双倍高亮任务且无虚拟化；`DiffCardFileList`、`ModernCodeBlock`、`FileViewerHistoryDrawer` 列表无虚拟化

- **精确位置**：
  - `apps/crish-desktop/src/components/custom-tags/WidgetDiff.tsx:44-70, 170-273`
  - `apps/crish-desktop/src/components/diff/DiffCardFileList.tsx:390-462`
  - `apps/crish-desktop/src/components/chat-tool-call/ModernCodeBlock.tsx:26, 61-66`
  - `apps/crish-desktop/src/components/files/FileViewerHistoryDrawer.tsx:166-194`
- **源码证据**：
  ```tsx
  // apps/crish-desktop/src/components/custom-tags/WidgetDiff.tsx:44-69
  const parsedLines = useMemo(() => parseDiffText(rawDiffText), [rawDiffText]);
  const splitPairs = useMemo(() => buildSplitLinePairs(parsedLines), [parsedLines]);
  ...
  const hlItems = useMemo<HighlightBatchItem[]>(() => {
    const out: HighlightBatchItem[] = [];
    parsedLines.forEach((line, idx) => {
      if (line.type === 'hunk') return;
      out.push({ id: `u:${idx}`, code: line.content, filePath });
    });
    splitPairs.forEach((pair, idx) => {
      if (pair.isHunk) return;
      if (pair.left) {
        out.push({ id: `s:${idx}:L`, code: pair.left.content, filePath });
      }
      if (pair.right) {
        out.push({ id: `s:${idx}:R`, code: pair.right.content, filePath });
      }
    });
    return out;
  }, [parsedLines, splitPairs, filePath]);
  ```
- **运行机制与极限负载推演**：
  1. **`WidgetDiff.tsx` 双倍高亮与无虚拟化**：
     - 无论当前 `viewMode` 是 `'unified'` 还是 `'split'`，`hlItems` 都会把 `parsedLines`（`u:${idx}`）和 `splitPairs`（`s:${idx}:L`, `s:${idx}:R`）**同时塞进同一个高亮批次**（而且 `splitPairs` 中的左右行内容本就来自 `parsedLines` 的同一批行，内容完全重复！），导致高亮计算量无故膨胀 **2–3 倍**。
     - 流式输出期间（`isStreaming === true`），`rawDiffText` 每帧增长都会触发全量 `parseDiffText` + `buildSplitLinePairs` + `useDiffHighlightMap` 全量重置闪烁（见 [D-03]），且第 170–273 行将所有 Diff 行全量挂载到 DOM，无任何行数上限或虚拟滚动。
  2. **`DiffCardFileList.tsx:390-462`、`ModernCodeBlock.tsx:26, 61-66`、`FileViewerHistoryDrawer.tsx:166-194` 无虚拟化**：
     - `DiffCardFileList` 在大仓库重构（如 300+ 个变更文件）时全量挂载所有文件卡片，每行挂载 4–5 个 `<Tooltip>` + `<IconButton>` + `<AppIcon>`（约 40 个 DOM 节点/行，300 文件即 12,000+ 节点）；
     - `ModernCodeBlock.tsx:26` 在组件函数体内无 `useMemo` 直接 `const lines = code.replace(/\n$/, '').split('\n')`，并在第 62 行 `lines.map((_, i) => <div key={i}>{i + 1}</div>)` 为每一行创建一个独立行号 `<div>`；
     - `FileViewerHistoryDrawer.tsx:166-194` 在展开某次历史快照的 `entry.diff` 时，直接 `entry.diff.split('\n').map(...)` 全量渲染所有 Diff 行且在渲染函数内即时 `.split('\n')`。
- **根因级修复方案**：
  1. 在 `WidgetDiff.tsx` 中仅对 `parsedLines` 按行索引生成一份高亮请求 `id: L:${idx}`，Unified 与 Split 视图共享同一份行高亮结果（减少 50%–66% 高亮负载），在 `isStreaming` 期间对 `rawDiffText` 施加 80ms 节流或仅高亮可见行，并对超过 80 行的 `<widget-diff>` 启用折叠/虚拟滚动。
  2. 对 `ModernCodeBlock` 的 `lines` 计数使用 `useMemo` 并用 CSS `counter-increment` 或单文本节点换行代替数千个独立 `<div>` 行号节点；对 `DiffCardFileList` 未展开行使用固定高度虚拟列表或 `content-visibility: auto`。

---

#### [F-01] `useFileNavigation` 的 `flatTree` 将 `filter` 混入树遍历 `useMemo`，每次搜索按键对所有展开目录克隆数组并调用未缓存的 `localeCompare` 重排整棵树

- **精确位置**：`apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts:196-232`
- **源码证据**：
  ```ts
  // apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts:196-232
  const flatTree = useMemo(() => {
    const out: FlatNode[] = [];
    const walk = (dir: string, depth: number) => {
      const list = entries[dir] || [];
      const sorted = [...list].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      });
      for (const item of sorted) {
        const exp = Boolean(expanded[item.path]);
        const childrenLoaded = Boolean(entries[item.path]);
        out.push({
          ...item,
          depth,
          expanded: exp,
          hasChildren:
            item.type === 'directory'
              ? childrenLoaded
                ? (entries[item.path]?.length ?? 0) > 0
                : true
              : false,
        });
        if (item.type === 'directory' && exp && entries[item.path]) {
          walk(item.path, depth + 1);
        }
      }
    };
    walk('', 0);
    return filterFlatTreeByQuery(out, filter);
  }, [entries, expanded, filter]);
  ```
- **运行机制与极限负载推演**：
  1. **每次输入过滤字符都重排整棵目录树**：注意 `flatTree` 的 `useMemo` 同时依赖 `[entries, expanded, filter]`，且在最后一行才调用 `filterFlatTreeByQuery(out, filter)`。这意味着用户在文件树搜索框每敲击一个字母（`filter` 改变，而 `entries` 和 `expanded` 完全没变），都会重新执行 `walk('', 0)`，对所有已展开目录克隆数组 `[...list]` 并重新排序，还为每个节点解构创建新的 `FlatNode` 对象 `{ ...item, depth, ... }`！
  2. **未复用 `Intl.Collator` 的高频 `localeCompare`**：在 `sort` 比较器内部直接调用 `a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })`。在 V8 中，带 `options` 参数的 `String.prototype.localeCompare` 若不复用预先实例化的 `Intl.Collator`，每次比较都需要解析区域设置与排序选项，比共享 `new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare` 慢 **10–25 倍**！在展开 5,000 个文件的仓库中，每次按键触发数万次 `localeCompare`，造成搜索框输入明显粘滞。
- **根因级修复方案**：
  1. **拆分 `unfilteredFlatTree` 与 `flatTree` 两级 `useMemo`**：
     - 第一级 `unfilteredFlatTree = useMemo(() => ..., [entries, expanded])`：仅在目录数据或展开态变化时遍历构建扁平树；
     - 第二级 `flatTree = useMemo(() => filterFlatTreeByQuery(unfilteredFlatTree, filter), [unfilteredFlatTree, filter])`：搜索按键时只执行 $O(N)$ 轻量过滤，彻底消除树遍历与重排。
  2. **模块级单例 `Intl.Collator` + 入库预排序**：在模块顶层创建单例 `const FILE_NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`，并在 `entries[dir]` 写入状态时直接完成一次排序，使树遍历阶段彻底零排序开销。

---

#### [F-02] `FileTreeView` 在校验 `isNewSelection` 前先执行全树 $O(N)$ `findIndex(isSameFsPath)`；固定行高列表未启用 `heightOnly: true`；`<file-tree>` 标签无虚拟化

- **精确位置**：
  - `apps/crish-desktop/src/components/files/FileTreeView.tsx:58-67, 89-105`
  - `apps/crish-desktop/src/components/custom-tags/FileTree.tsx:147-207`
- **源码证据**：
  ```ts
  // apps/crish-desktop/src/components/files/FileTreeView.tsx:58-67, 89-105
  const ids = useMemo(() => flatTree.map((n) => n.path), [flatTree]);

  const { totalHeight, visibleItems, measureRef } = useVirtualScroll({
    ids,
    estimateHeight: () => ITEM_HEIGHT,
    overscan: 10,
    scrollParentRef: treeScrollRef,
    enabled: flatTree.length > 0,
  });
  ...
  useEffect(() => {
    if (!selected) {
      prevSelectedRef.current = null;
      return;
    }
    const el = treeScrollRef.current;
    const targetIndex = flatTree.findIndex((n) => isSameFsPath(n.path, selected));
    if (!el || targetIndex < 0) return;

    const isNewSelection = prevSelectedRef.current !== selected;
    prevSelectedRef.current = selected;

    // 仅在选中项真正改变时才触发自动滚动，防止展开文件夹等操作导致视角乱跳
    if (!isNewSelection) return;
  ```
- **运行机制与极限负载推演**：
  1. **守卫顺序颠倒导致每次展开文件夹/输入搜索词都执行 $O(N)$ 路径归一化查找**：在 `FileTreeView.tsx:89-105` 的 `useEffect` 中，依赖项是 `[selected, flatTree, totalHeight]`。当用户展开任意文件夹或输入搜索词时，`flatTree` 和 `totalHeight` 改变但 `selected` 根本没变（`isNewSelection === false`）。然而代码却在**第 95 行先执行了 `flatTree.findIndex((n) => isSameFsPath(n.path, selected))`**（对数千个节点逐一调用正则路径归一化 `normalizeFsPath`），算完之后才在第 104 行检查 `if (!isNewSelection) return;` 将结果直接丢弃！
  2. **固定行高列表未启用 `heightOnly: true`**：文件树每一行都是严格固定的 `ITEM_HEIGHT = 28`（第 34 行），但第 60 行调用 `useVirtualScroll` 时没有传 `heightOnly: true`，导致每次 `flatTree` 变化都要额外 `flatTree.map((n) => n.path)` 分配 `ids` 数组，并在 `VirtualScrollManager` 中维护数千个 ID 字符串映射与 `measureRef` `ResizeObserver` 回调（第 284 行 `ref={measureRef(node.path)}`）。
  3. **`custom-tags/FileTree.tsx:147-207` 无虚拟化**：聊天流中的 `<file-tree>` 组件递归渲染所有展开节点，当 AI 输出大型目录结构（如 1,000+ 行文件树）时无任何虚拟化或高度上限。
- **根因级修复方案**：
  1. 在 `FileTreeView.tsx:93` 立即先判断 `if (prevSelectedRef.current === selected) return; prevSelectedRef.current = selected;`，然后再执行 `flatTree.findIndex(...)`（且由于已归一化，可直接 `n.path === normalizedSelected` 精确比对）。
  2. 为 `FileTreeView` 的 `useVirtualScroll` 传入 `heightOnly: true, itemCount: flatTree.length` 并移除每行的 `ref={measureRef(node.path)}`，将虚拟滚动索引更新从 $O(N)$ 降至 $O(1)$。

---

#### [F-03] `FileBreadcrumb` 弹出层每帧重复 `localeCompare` 排序且无虚拟化；`FilesCard` 分割线拖拽同时绑定 `pointermove` + `mousemove` 双倍触发全树重渲染；CSV 预览无 `useMemo` 且无虚拟化；`onPreviewScroll` 绑在非滚动容器失效

- **精确位置**：
  - `apps/crish-desktop/src/components/files/FileBreadcrumb.tsx:270-328`
  - `apps/crish-desktop/src/components/files/FilesCard.tsx:78-113`
  - `apps/crish-desktop/src/components/files/FilePreview.tsx:90-98, 136, 166-182, 236`
- **源码证据**：
  ```tsx
  // apps/crish-desktop/src/components/files/FilesCard.tsx:95-103
  window.addEventListener('pointermove', handleMove);
  window.addEventListener('pointerup', handleUp);
  window.addEventListener('pointercancel', handleUp);
  window.addEventListener('mousemove', handleMove);
  window.addEventListener('mouseup', handleUp);
  ```
  ```tsx
  // apps/crish-desktop/src/components/files/FilePreview.tsx:166-182
  if (isCsvFile(selected)) {
    const rows = parseCsvPreview(content);
    return (
      <div className={styles.filesCsvWrap} data-testid="files-csv-preview">
        <table className={styles.filesCsvTable}>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((cell, ci) =>
                  ri === 0 ? <th key={ci}>{cell}</th> : <td key={ci}>{cell}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  ```
- **运行机制与极限负载推演**：
  1. **`FilesCard.tsx:78-113` 分割线拖拽双倍事件 + 全树 React 重渲染**：`FilesCard` 在拖拽分栏时，同时在 `window` 上注册了 `pointermove` 和 `mousemove` 指向同一个 `handleMove`。在现代浏览器中，一次鼠标移动会连续触发 `pointermove` 和 `mousemove` 两个事件，导致每帧调用两次 `setListWidthRatio(ratio)`，进而触发整个 `FilesCard`（包含 `FileBreadcrumb`、`FileActions`、`FileTreeView`、`FilePreview`）的完整 React 协调重渲染，而它的唯一作用仅仅是更新第 440 行的 CSS 变量 `'--files-list-ratio': `${listWidthRatio}%``！
  2. **`FileBreadcrumb.tsx:275` 弹出层无记忆化排序与无虚拟化**：`renderFlyoutEntries` 是普通递归渲染函数，每次 `FileBreadcrumb` 重渲染（包括 hover、loading 变化或父组件拖拽重渲染）都会对弹出菜单中所有展开层级的目录重新执行 `sortEntries(entries)`（含 `localeCompare`），且目录项无虚拟化。
  3. **`FilePreview.tsx:170` CSV 预览无 `useMemo` 且全表无虚拟化挂载**：当预览 CSV 文件时，每次组件重渲染都会在渲染函数内同步执行 `parseCsvPreview(content)`，并将所有行列一次性渲染为原生 `<tr>`/`<td>`（例如 5,000 行 × 20 列的 CSV 将直接创建 **100,000 个 DOM 节点**，瞬间卡死页面）。
  4. **`FilePreview.tsx:90-98, 136, 236` 滚动位置持久化失效**：`onScroll={onPreviewScroll}` 被绑定在外层 `<div className={styles.filesDetailBody}>` 上，但当渲染代码文件时，真正的滚动容器是 `VirtualPlainCodeViewer` 内部的 `.plainScrollParent`（而 DOM 的 `scroll` 事件不冒泡！），导致 `el.scrollTop` 恒为 0，代码预览滚动位置恢复机制失效。
- **根因级修复方案**：
  1. **拖拽分割线走 DOM Ref 直接更新 CSS 变量**：在 `FilesCard.tsx` 中移除冗余的 `mousemove`/`mouseup` 监听，拖拽过程中仅通过 `bodyRef.current?.style.setProperty('--files-list-ratio', `${ratio}%`)` 直接驱动 CSS 布局（零 React 重渲染），仅在 `pointerup` 结束拖拽时调用一次 `setListWidthRatio` 同步状态。
  2. **CSV 预览 `useMemo` 化 + 行列上限/虚拟化**：用 `useMemo` 缓存 `parseCsvPreview(content)`，并对 CSV 表格接入虚拟滚动或限制首屏渲染行数（如前 200 行 + 展开/虚拟滚动）。
  3. **复用预排序目录项与穿透滚动容器回调**：`FileBreadcrumb` 弹出层复用 `Intl.Collator` 与 `useMemo` 缓存排序结果；将 `onPreviewScroll` 透传至 `VirtualPlainCodeViewer` 的内部滚动容器。

---

### 方向三：编排图谱、运行态面板与后台任务轮询（`FlowDagView` / `RuntimePanel` / `OverviewCard` / `useEngineState`）

#### [G-01] `useFlowDagStore` 为全局单例未按 `sessionId` 分区，多分屏不同会话的 3s 轮询互相覆盖；`FlowDagGraph` 无 `useMemo` 每次渲染调用两遍 `layerNodes`，且含环图未对环上游记忆化导致最坏 $O(2^V)$ 指数级遍历

- **精确位置**：
  - `apps/crish-desktop/src/components/workspace/flowDagStore.ts:26-45`
  - `apps/crish-desktop/src/components/workspace/FlowDagView.tsx:50-52, 130-161`
  - `apps/crish-desktop/src/components/workspace/flowDagLayout.ts:72-110, 157-167`
- **源码证据**：
  ```ts
  // apps/crish-desktop/src/components/workspace/flowDagStore.ts:26-45
  export const useFlowDagStore = create<FlowDagState>((set) => ({
    nodes: null,
    loading: false,
    error: null,
    setNodes: (nodes) => set({ nodes, loading: false, error: null }),
    ...
  }));
  ```
  ```tsx
  // apps/crish-desktop/src/components/workspace/FlowDagView.tsx:50-52
  const layers = layerNodes(list);
  const edges = buildEdges(list);
  const countLabel = dagCountLabel(list); // 内部在 flowDagLayout.ts:162 再次调用 layerNodes(nodes)!
  ```
  ```ts
  // apps/crish-desktop/src/components/workspace/flowDagLayout.ts:79-101
  const resolveLayer = (id: string, stack: string[]): number => {
    const cached = layerOf.get(id);
    if (cached !== undefined) return cached;
    if (stack.includes(id)) return -1;
    ...
    for (const dep of node.deps) {
      if (!byId.has(dep)) continue;
      const dl = resolveLayer(dep, [...stack, id]);
      if (dl < 0) {
        sawCycle = true;
      } else if (dl > maxDep) {
        maxDep = dl;
      }
    }
    if (sawCycle) {
      return -1; // 未写入 layerOf.set(id, -1)！
    }
    const layer = maxDep + 1;
    layerOf.set(id, layer);
    return layer;
  };
  ```
- **运行机制与极限负载推演**：
  1. **全局单例 Store 跨分屏会话互相覆盖**：`useFlowDagStore` 只有一个全局 `nodes` 字段，未按 `sessionId` 分桶。当用户在左右分屏打开两个不同会话的 `FlowDagView` 时，两个组件各自的 `3000ms` `setInterval`（`FlowDagView.tsx:157`）交替调用 `setNodes(res.nodes)`，导致两个分屏的编排图每隔 1–3 秒互相篡改对方显示的节点并触发乒乓重渲染；此外即使全图所有节点均已 `completed` 或为空，3s 轮询也永不停止，且每次 `setNodes(res.nodes)` 传入新数组引用都会无条件触发重渲染。
  2. **单次渲染重复执行两遍 `layerNodes` 且无 `useMemo`**：`FlowDagGraph`（第 50–52 行）既未包裹 `useMemo`，又在调用 `layerNodes(list)` 后紧接着调用 `dagCountLabel(list)`——而 `dagCountLabel`（`flowDagLayout.ts:162`）内部**又调用了一遍 `layerNodes(nodes)`**！
  3. **含环依赖图下未缓存 `-1` 导致 $O(2^V)$ 指数级爆炸**：在 `flowDagLayout.ts:79-101` 中，每次递归都通过 `[...stack, id]` 拷贝栈数组并 `stack.includes(id)` 线性查找；更重要的是，当某个子依赖存在环（`sawCycle === true`，第 97 行）时，函数直接 `return -1` 而**没有将 `-1`（或特殊标记）记入 `layerOf`**。如果一个含 30 个节点的菱形/稠密 DAG 底部依赖了一个二元环，所有上游节点在每次被不同父节点访问时都会全路径重算，时间复杂度从 $O(V + E)$ 退化为 **$O(2^V)$（$2^{30} \approx 10^9$ 次递归，直接死锁主线程）**！
- **根因级修复方案**：
  1. **按 `sessionId` 分桶存储 + 深度相等性短路 + 终态停轮询**：将 `flowDagStore` 改为 `bySessionId: Record<string, { nodes, loading, error }>`，在 `setNodes` 时比对节点列表签名（`id:status:deps`），若无变化则跳过 `set`；当会话无活跃任务且所有 DAG 节点已处于终态时暂停 3s 轮询。
  2. **修复 `layerNodes` 记忆化与三色标记 DFS**：用 `visiting: Set<string>`（灰色节点）替代 `[...stack, id]` 数组拷贝，并将检测到环的节点同样记入 `layerOf.set(id, -1)` 保证严格 $O(V + E)$ 线性复杂度；将已算出的 `layers` 直接传给 `dagCountLabel(list, layers)` 并在 `FlowDagGraph` 中用 `useMemo` 缓存。

---

#### [R-01] `RuntimePanel` 与 `useRuntimePanelData` 各自启动一个 1000ms `setInterval`（共 2 个 1Hz 定时器），空闲态下每秒仍扫描全量会话与消息并创建新引用，叠加 `state.sessions` 全表订阅，引发全面板 10 个子区段每秒 1–2 次无意义重渲染

- **精确位置**：
  - `apps/crish-desktop/src/components/workspace/RuntimePanel.tsx:48, 58-65`
  - `apps/crish-desktop/src/components/workspace/useRuntimePanelData.ts:48, 51-110`
  - `apps/crish-desktop/src/components/workspace/ApprovalSection.tsx:25`
- **源码证据**：
  ```tsx
  // apps/crish-desktop/src/components/workspace/RuntimePanel.tsx:48, 58-65
  const data = useRuntimePanelData();
  ...
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      useCacheEventsStore.getState().tickColdCheck(t);
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  ```
  ```ts
  // apps/crish-desktop/src/components/workspace/useRuntimePanelData.ts:48, 51-110
  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const fromMessages: LiveTaskRow[] = [];
  for (const s of sessions) {
    const processingMsg = [...(s.messages || [])]
      .reverse()
      .find((m) => m.status === 'processing');
    if (processingMsg) { ... }
  }
  ```
- **运行机制与极限负载推演**：
  1. **双倍 1Hz 定时器无条件空转**：`RuntimePanel.tsx:58-65` 启动了一个 1000ms `setInterval` 调用 `setNow(t)`（注意 `RuntimePanel` 自身除了把 `t` 传给 `tickColdCheck(t)` 外，**根本没有在任何 JSX 中使用 `now` 这个 state**！）；与此同时，它调用的 `useRuntimePanelData.ts:51-56` 内部**又启动了第二个无条件的 1000ms `setInterval(() => setNow(Date.now()), 1000)`**！
  2. **空闲态下每秒 2 次全会话历史逆序克隆扫描 + 全面板 10 个子区段重渲染**：
     - 即便当前没有任何运行中的任务（`engine.activeRuns.length === 0` 且没有任何 `processing` 消息），这两个 1Hz 定时器也会导致 `RuntimePanel` **每秒重渲染 1–2 次**；
     - 每次重渲染时，`useRuntimePanelData` 都会遍历所有会话 `for (const s of sessions)`，对每个会话的所有历史消息执行 **`[...(s.messages || [])].reverse().find(...)`（每秒克隆并翻转所有会话的完整消息数组！）**；
     - 且 `useRuntimePanelData` 每次都返回全新的 `liveTasks` 数组引用、全新的 `focusSession` 函数引用（未使用 `useCallback`），且 `LiveTasksSection`、`BgTasksSection`、`ApprovalSection`、`PlansSection`、`TimerCronSection`、`TrashSection`、`SecurityAuditSection`、`SessionCacheStatsPanel` 均未包裹 `React.memo`，导致整个 `RuntimePanel` 及其下属 10 个子组件每秒钟无休止地全量重渲染！
  3. **流式输出期每个 Token 触发全面板重渲染**：`useRuntimePanelData.ts:48` 和 `ApprovalSection.tsx:25` 直接订阅了 `useSessionStore((state) => state.sessions)`。当任意会话流式输出时，每个 Token 都会更新 `state.sessions` 引用，唤醒 `RuntimePanel` 与 `ApprovalSection` 重跑上述全会话消息逆序克隆循环。
- **根因级修复方案**：
  1. **彻底移除 `RuntimePanel.tsx:58` 的冗余 `now` state**：在 `RuntimePanel` 的 `useEffect` 中仅调用 `useCacheEventsStore.getState().tickColdCheck(Date.now())`，不调用 `setNow`（若状态过期，`cacheEventsStore` 内部变更会通过 `useCacheEventsStore` 选择器精准触发重渲染）。
  2. **按需门控 `useRuntimePanelData` 的 1Hz 定时器 + 消除 `.reverse()` 数组克隆**：
     - 仅当存在活跃运行任务（`hasActiveWork === true`）时才挂载 `useRuntimePanelData` 的 1000ms 定时器；空闲时零定时器、零重渲染；
     - 用从后往前的 `for (let i = msgs.length - 1; i >= 0; i--)` 替代 `[...(s.messages || [])].reverse().find(...)`，彻底消除消息数组克隆；
     - 用 `useCallback` 稳定 `focusSession`，并用 `useMemo` 稳定 `liveTasks`（空闲时返回常量空数组 `EMPTY_LIVE_TASKS`）。

---

#### [R-02] `useOverviewState` 无条件运行 1Hz 定时器刷新 `now`，而 `WorkspaceGitChangesView` 与 `SessionChangesView` 未对文件数组做 `useMemo`，每秒击穿 `OverviewChangesList` 的 `React.memo`，导致最多 1000 条未虚拟化的 Git 变更行每秒全量重解析与重渲染

- **精确位置**：
  - `apps/crish-desktop/src/components/overview/useOverviewState.ts:62-65, 74-130`
  - `apps/crish-desktop/src/components/overview/changes/WorkspaceGitChangesView.tsx:39-46, 107`
  - `apps/crish-desktop/src/components/overview/changes/SessionChangesView.tsx:38-43`
  - `apps/crish-desktop/src/components/overview/OverviewChangesList.tsx:35-131`
- **源码证据**：
  ```ts
  // apps/crish-desktop/src/components/overview/useOverviewState.ts:62-65
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  ```
  ```tsx
  // apps/crish-desktop/src/components/overview/changes/WorkspaceGitChangesView.tsx:39-46, 107
  // 转换为 OverviewChangesList 所需结构
  const treeGitFiles = rawGitFiles.map((f) => ({
    path: f.path,
    status: f.status,
    staged: f.staged,
    added: f.added,
    removed: f.removed,
  }));
  ...
  <OverviewChangesList
    rawGitFiles={treeGitFiles}
    onItemClick={onSelectFile}
    maxInitialFiles={1000}
  />
  ```
- **运行机制与极限负载推演**：
  1. `useOverviewState.ts:62-65` 无条件每秒调用一次 `setNow(Date.now())`（即便没有任何运行中的 `liveTasks`，或者「活动任务」折叠区处于关闭状态），并在第 82–97 行每秒对所有会话执行 `[...(s.messages || [])].reverse().find(...)`。
  2. 每次 `now` 递增都会触发 `OverviewCardInner` -> `ChangesSection` -> `WorkspaceGitChangesView`（及 `SessionChangesView`）重渲染。
  3. 在 `WorkspaceGitChangesView.tsx:39-46` 中，`const treeGitFiles = rawGitFiles.map(...)` **没有包裹 `useMemo`**！在 `SessionChangesView.tsx:38-43` 中，`const gitStatusFiles = files.map(...)` 和 `const handleItemClick = ...` **也没有包裹 `useMemo` / `useCallback`**！
  4. **灾难性连锁反应**：尽管 `OverviewChangesList`（`OverviewChangesList.tsx:35`）特意包裹了 `React.memo`，但因为父组件每秒钟都传入一个全新引用的 `treeGitFiles` 数组，`OverviewChangesList` 的 `React.memo` 與内部 `entries = React.useMemo(...)` **每秒钟被 100% 击穿**！当工作区有较多未提交改动（`maxInitialFiles={1000}`，最多展示 1,000 个文件且无虚拟滚动）时，即便用户什么都没做、AI 也没在运行，**总览面板每秒钟都会重新遍历 1,000 个文件路径（执行正则切分目录名/文件名）并重新协调渲染 1,000 行 DOM 节点（包含 1,000 个 `<Tooltip>` + `<Button>`）**！
- **根因级修复方案**：
  1. **门控 `useOverviewState` 的 1Hz 定时器**：仅当存在运行中的任务（`hasLiveWork`）且 `openSec.activeTasks` 展开时才运行 1000ms `setInterval`；或将 `now` 下沉到 `ActiveTasksSection` 内部独立驱动耗时文案，使 `OverviewCardInner` 彻底脱离 1Hz 渲染循环。
  2. **为 `WorkspaceGitChangesView` 与 `SessionChangesView` 补齐 `useMemo` / `useCallback`**：将 `treeGitFiles` 用 `useMemo(..., [rawGitFiles])` 缓存，`gitStatusFiles` 用 `useMemo(..., [files])` 缓存，`handleItemClick` 用 `useCallback` 缓存，使 `OverviewChangesList` 的 `React.memo` 真正生效；并对 `OverviewChangesList` 超过 50 行的变更列表接入虚拟滚动。

---

#### [R-03] `fetchEngineLiveStatus` 每次返回新分配的 `activeRuns` 与 `pendingApprovals` 数组，导致 `useEngineState` 的引用相等性守卫恒为 `false`，每 4s 强制唤醒全部订阅组件

- **精确位置**：
  - `apps/crish-desktop/src/hooks/useEngineState.ts:142-160, 218-229`
  - `apps/crish-desktop/src/api/engineStatus.ts:159-192`
- **源码证据**：
  ```ts
  // apps/crish-desktop/src/hooks/useEngineState.ts:142-160, 218-229
  function _setState(next: EngineRuntimeState): void {
    if (
      _state.online === next.online &&
      _state.activeRuns === next.activeRuns &&
      _state.pendingApprovals === next.pendingApprovals &&
      _state.bgTasks === next.bgTasks
    ) {
      return;
    }
    _state = next;
    for (const fn of _listeners) {
      try {
        fn();
      } catch { ... }
    }
  }
  ...
  _setState({
    online: live.online,
    activeRuns: live.activeRuns,
    pendingApprovals: live.pendingApprovals,
    bgTasks: normalizedBg,
    lastUpdatedAt: Date.now(),
  });
  ```
- **运行机制与极限负载推演**：
  1. `useEngineState.ts` 的设计者非常用心地为 `bgTasks` 编写了 `_normalizeBgTasks`（第 105–136 行），当 `bgTasks` 内容未变时复用 `_state.bgTasks` 引用，并在 `_setState`（第 142–150 行）中通过引用相等性 `_state.activeRuns === next.activeRuns && _state.pendingApprovals === next.pendingApprovals && _state.bgTasks === next.bgTasks` 短路无变化的通知。
  2. **然而这个短路守卫实际上 100% 失效**！因为 `fetchEngineLiveStatus()`（`engineStatus.ts:159-192`）在每次 4000ms 轮询返回时，总是创建全新的 `activeRuns` 和 `pendingApprovals` 数组（哪怕两者都是空数组 `[]`），而 `useEngineState.ts` 没有像 `_normalizeBgTasks` 那样对 `activeRuns` 和 `pendingApprovals` 做浅层内容相等复用！
  3. 因此，`_state.activeRuns === next.activeRuns` 永远为 `false`（`[] === []` 为 `false`），导致每 4 秒钟 `_setState` 都会无条件更新 `_state` 并遍历 `_listeners` 强制唤醒所有订阅了 `useEngineState()` 的组件（包括 `RuntimePanel`、`OverviewCard` 等）重渲染！
- **根因级修复方案**：
  1. 在 `useEngineState.ts` 中为 `activeRuns` 和 `pendingApprovals` 增加与 `_normalizeBgTasks` 对称的引用保持归一化函数 `_normalizeActiveRuns(prev, next)` 与 `_normalizePendingApprovals(prev, next)`（当数组均为空或元素字段一致时直接返回 `prev` 引用），使 `_setState` 的相等性守卫真正生效。

---

#### [A-01] `AgentCard` 与 `AgentBrowsePad` 订阅 `selectSessionsById` 整表且消息列表无虚拟化；`useApprovalCountdown` 以 100ms（10Hz）`setInterval` 更新浮点 state 驱动高频重渲染；`AgentTeamBoard` 渲染期重复 `flatMap` 工具调用且混入非纯 `Date.now()`

- **精确位置**：
  - `apps/crish-desktop/src/components/agent-card/AgentCard.tsx:57-79, 129-133, 248-261`
  - `apps/crish-desktop/src/components/agent-card/AgentBrowsePad.tsx:36-40`
  - `apps/crish-desktop/src/components/agent-card/useApprovalCountdown.ts:57-75`
  - `apps/crish-desktop/src/components/agent-card/AgentTeamBoard.tsx:74-84, 249-262`
  - `apps/crish-desktop/src/components/agent-card/agentTeamBoardUtils.ts:49-83`
- **源码证据**：
  ```tsx
  // apps/crish-desktop/src/components/agent-card/AgentCard.tsx:57, 248-260
  const sessionsById = useSessionField(selectSessionsById);
  ...
  agent.messages.map((msg, idx) => (
    <AgentMessageRow
      key={msg.id}
      msg={msg}
      ...
    />
  ))
  ```
  ```ts
  // apps/crish-desktop/src/components/agent-card/useApprovalCountdown.ts:57-75
  const interval = setInterval(() => {
    const remaining = endTime - Date.now();
    if (remaining <= 0) { ... }
    const pct = Math.max(
      0,
      Math.min(100, (remaining / timeoutTotalRef.current) * 100)
    );
    setTimeoutPercent(pct);
  }, 100);
  ```
- **运行机制与极限负载推演**：
  1. **`selectSessionsById` 整表订阅导致主会话流式输出连带重渲染 `AgentCard`**：`AgentCard.tsx:57` 和 `AgentBrowsePad.tsx:36` 直接订阅了 `selectSessionsById`。当主会话或其他分屏会话正在流式输出正文（子智能体本身根本没变化）时，`sessionsById` 根引用在每个流式 Token 到来时都会更新，触发 `AgentCard` 和 `AgentBrowsePad` 重渲染。
  2. **子智能体消息列表 `agent.messages.map` 无虚拟化 + 同步 `scrollTop = scrollHeight` 强制回流**：`AgentCard.tsx:248-260`（以及 `InlineAgentTimeline.tsx:205`）直接将所有 `agent.messages` 全量 `.map` 渲染（且传入 `virtualScrollManager={null}`），当子智能体执行了数十轮工具调用产生上百条消息时，所有消息与工具卡片全部驻留在 DOM 中；且第 130–133 行在 `useEffect` 中直接执行 `el.scrollTop = el.scrollHeight` 触发同步布局读取与写入。
  3. **`useApprovalCountdown` 的 10Hz（每 100ms）React 状态重渲染**：当存在待审批工具倒计时时，`useApprovalCountdown.ts:57-75` 每 100ms（每秒 10 次）计算一次浮点数 `pct` 并调用 `setTimeoutPercent(pct)`，驱动整个审批卡组件每秒执行 10 次完整的 React 渲染，仅仅为了更新一个进度条的宽度！
  4. **`AgentTeamBoard` 双重 `toolProgress(a)` 遍历**：`AgentTeamBoard.tsx:81` 在 `boardStats` 中对每个 agent 调用一次 `toolProgress(a)`（内部执行 `(agent.messages || []).flatMap((m) => m.toolCalls || [])`），紧接着在第 250 行渲染循环中又对每个 agent 调用第二次 `toolProgress(a)`，且 `formatCompactDuration(a)` 在渲染期直接读取 `Date.now()`。
- **根因级修复方案**：
  1. **精准选择器订阅目标 `SessionAgent`**：在 `AgentCard` 中使用精细选择器直接订阅目标 `agent` 与 `siblingAgents`（通过 `useShallow` 比较），隔离主会话正文 Token 流式更新对 `AgentCard` 的干扰；为 `AgentCard` 消息区接入 `useVirtualScroll`。
  2. **用纯 CSS 动画 + 单次 `setTimeout` 替代 10Hz React 轮询**：在 `useApprovalCountdown` 中使用单个 `setTimeout(..., remainingMs)` 触发超时回调，进度条视觉过渡改用 CSS `transform: scaleX(0)` + `transition: transform ${remainingMs}ms linear`（合成器线程 60/120fps 零主线程重渲染），或者仅在秒级整数变化时更新 state。
  3. 在 `AgentTeamBoard` 的 `useMemo` 中一次性预计算每个 agent 的 `prog = toolProgress(a)`，消除渲染期重复 `flatMap`。

---

### 方向四：内置预览面板与通信桥（`PreviewCard` / `previewHostBridge` / `usePreviewNavigation` / `previewBridgeScript`）

#### [P-01] `PreviewCard` 订阅整张 `session` 对象且 `INSPECT_HOVER` 直接写入顶层 `useState` 引发每次鼠标移动全卡重渲染；`<iframe key={activeUrl}>` 强制销毁重建 iframe 实例；`usePreviewNavigation` 的 `history`/`bookmarks` 空依赖 `useMemo` 冻结初始快照导致 `histTick` 空转；`previewBridgeScript.ts` 点击拾取时序列化整棵大 DOM 子树

- **精确位置**：
  - `apps/crish-desktop/src/components/workspace/PreviewCard.tsx:72-84, 186-189, 478-489`
  - `apps/crish-desktop/src/components/workspace/usePreviewNavigation.ts:128, 135-136, 198-199, 332-355`
  - `apps/crish-desktop/dev-server/previewBridgeScript.ts:122-140, 183-185`
- **源码证据**：
  ```tsx
  // apps/crish-desktop/src/components/workspace/PreviewCard.tsx:72-84, 186-189, 478-489
  const session = useSessionStore((s) =>
    scopedSessionId ? s.sessionsById[scopedSessionId] : null
  );
  const isAiStreaming = Boolean(
    session?.messages?.some((m) => m.status === 'processing') ||
      session?.agents?.some((a) => a.status === 'running')
  );

  const [isInspectorActive, setIsInspectorActive] = React.useState(false);
  const [hoverElement, setHoverElement] =
    React.useState<InspectHoverPayload | null>(null);
  ...
  if (event.type === 'INSPECT_HOVER') {
    setHoverElement(event.payload);
    return;
  }
  ...
  <iframe
    ref={iframeRef}
    key={activeUrl}
    aria-label="预览页面"
    src={frameSrc ?? undefined}
    ...
  />
  ```
  ```ts
  // apps/crish-desktop/src/components/workspace/usePreviewNavigation.ts:128, 135-136
  const [, setHistTick] = useState(0);
  ...
  const history = useMemo(() => getPreviewHistory(), []);
  const bookmarks = useMemo(() => getPreviewBookmarks(), []);
  ```
  ```ts
  // apps/crish-desktop/dev-server/previewBridgeScript.ts:183-185
  var outer = el.outerHTML || '';
  var outerSnippet = outer.length > 500 ? outer.slice(0, 500) + '...' : outer;
  var text = (el.textContent || '').trim().slice(0, 200);
  ```
- **运行机制与极限负载推演**：
  1. **`PreviewCard.tsx:72-78` 订阅整张 `session` 对象**：选择器直接返回 `s.sessionsById[scopedSessionId]`，然后在组件体内计算布尔值 `isAiStreaming`。当 AI 流式输出时，每个 Token 都改变 `session` 引用，导致整个 `PreviewCard`（含 `PreviewToolbar`、历史面板、浮层）在每个 Token 到来时重渲染并遍历 `session.messages.some(...)`。
  2. **`INSPECT_HOVER` 高频 `postMessage` 写入 `PreviewCard` 顶层 `useState` + 布局属性定位**：
     - 在 `previewBridgeScript.ts:122-140` 中，`pointermove` 监听器未做 `requestAnimationFrame` 节流，每次鼠标移动都同步调用 `document.elementFromPoint(e.clientX, e.clientY)` 与 `el.getBoundingClientRect()` 并向宿主 `postMessage`；
     - 宿主 `PreviewCard.tsx:186-188` 收到 `INSPECT_HOVER` 后直接调用顶层 `setHoverElement(event.payload)`，导致鼠标在预览页内划过元素时，`PreviewCard` 及其子组件 `PreviewToolbar` 等高频全量重渲染，且 `PreviewCardInspectorOverlay.tsx:39-44` 使用 `left`/`top`/`width`/`height` 触发几何布局重算而非合成器 `transform: translate3d(...)`。
  3. **`previewBridgeScript.ts:183-185` 点击容器节点时全量序列化 `el.outerHTML` 与 `el.textContent`**：当用户在开启拾取器时点击页面上较大的容器（如 `<div>` 根容器、长列表或画布包装层，包含上万个子 DOM 节点）时，`var outer = el.outerHTML` 会将**整棵成千上万节点的 DOM 子树完整序列化为一个数 MB 的大字符串**，`el.textContent` 又遍历整棵子树拼接全部文本，然后仅仅截取前 500 个字符 `.slice(0, 500)`！这会在点击瞬间直接卡死预览页主线程。
  4. **`<iframe key={activeUrl}>` 强制卸载重建整个浏览器上下文**：在 `PreviewCard.tsx:480` 中，`<iframe key={activeUrl} ... />` 将 `activeUrl` 作为 React `key`。每当地址发生任何改变（包括同源子路径跳转、查询参数变化、前进/后退），React 都会彻底销毁旧 `<iframe>` DOM 节点并挂载新 `<iframe>`，导致 iframe 内的 JS 虚拟机、WebSocket 连接和缓存上下文全部被连根拔起重建，而非通过更新 `src` 属性正常导航。
  5. **`usePreviewNavigation.ts:128, 135-136` 空依赖 `useMemo` 导致 `histTick` 重渲染完全空转（功能 Bug + 性能浪费）**：
     - `getPreviewHistory()` 与 `getPreviewBookmarks()`（`previewBrowserStore.ts:229, 307`）每次调用都会从 `localStorage` 解析并返回新数组；
     - `usePreviewNavigation.ts` 定义了 `const [histTick, setHistTick] = useState(0)` 并在添加/删除书签、清空历史、收到 `crish-preview-history`/`crish-preview-bookmarks` 事件时调用 `setHistTick((n) => n + 1)` 触发重渲染；
     - 但第 135–136 行却写成了 `const history = useMemo(() => getPreviewHistory(), []);` 和 `const bookmarks = useMemo(() => getPreviewBookmarks(), []);`（依赖数组为空 `[]`，漏写了 `[histTick, activeUrl]`）！结果 `setHistTick` 触发了全组件重渲染，而 `history` 和 `bookmarks` 却永远锁死在组件首次挂载时的旧快照！
- **根因级修复方案**：
  1. **选择器内联收敛布尔值**：将 `PreviewCard.tsx:72-78` 合并为返回原始布尔值的 Zustand 选择器：
     ```ts
     const isAiStreaming = useSessionStore((s) => {
       const sess = scopedSessionId ? s.sessionsById[scopedSessionId] : null;
       if (!sess) return false;
       return Boolean(
         sess.messages?.some((m) => m.status === 'processing') ||
         sess.agents?.some((a) => a.status === 'running')
       );
     });
     ```
  2. **下沉 `hoverElement` 状态至 `PreviewCardInspectorOverlay` + `rAF` 节流**：在 `previewBridgeScript.ts` 的 `pointermove` 中用 `requestAnimationFrame` 节流 `elementFromPoint`；将 `subscribeToInspector` 的 `INSPECT_HOVER` 处理下沉到 `PreviewCardInspectorOverlay` 内部（或直接用 `ref` 更新浮层 DOM 的 `transform: translate3d(x, y, 0)` 与 `width`/`height`），使鼠标移动期间 `PreviewCard` 零 React 重渲染。
  3. **有界浅层序列化替代全子树 `el.outerHTML`**：在 `previewBridgeScript.ts:183-185` 中，先通过 `const shallowClone = el.cloneNode(false)` 构造开标签签名（或仅在 `el.children.length <= 20` 时读取 `el.outerHTML`，否则仅序列化当前节点自身属性与前几个子节点的浅层摘要），防止点击大容器时序列化数 MB 的 DOM 树。
  4. **移除 `<iframe key={activeUrl}>` 并修复 `usePreviewNavigation` 的 `useMemo` 依赖**：移除 `<iframe>` 上的 `key={activeUrl}`（改用固定 `key="preview-iframe"`，由 `src={frameSrc}` 与 `reload()` 控制导航）；将 `usePreviewNavigation.ts:135-136` 的依赖修正为 `[histTick, activeUrl]`。

---

## 三、架构级净收敛总结

1. **有界环形缓冲与分帧流式排空（Terminal & PTY）**：统一前台 `ptyHistoryMap` 与后台 `ptyWriteGate` 的字节上限契约（杜绝无界 `pending.push` 与单帧 `pending.join('')` 全量灌入），在 `ptySessionApi` 中存储 `{ chunk, byteLength }` 元组彻底消除重复 `TextEncoder.encode` 分配与逐字符编码。
2. **固定 DOM 层级与观察器收敛（Terminal & Preview）**：消除 `TerminalCard` 单/分屏切换的 JSX 层级跳变与 `PreviewCard` 的 `<iframe key={activeUrl}>` 销毁重建；将 `ptyWriteGate` 的 `subtree: true` 样式观察器收敛为有限祖先链观察。
3. **按需惰性派生与增量高亮保留（Diff & Code Viewer）**：将 `useDiffData` 从「全量 $M$ 文件双模式急切计算」收敛为「仅当前激活文件 + 当前视图模式按需计算」，切断 Git 模式下对 `session.messages` 的伪依赖；修复 `useDiffHighlightMap` 滚动 1 行即全表抹除高亮的闪烁缺陷，移除 `renderTokens` 中的主线程同步 `highlightCode` 回退，并将 `highlightCache` 的单行缓存阈值从 500 字符对齐至 `HEAD_HIGHLIGHT_LEN = 1500` 字符。
4. **树遍历与过滤解耦、拖拽零重渲染（File Tree & Preview）**：在 `useFileNavigation` 中分离 `unfilteredFlatTree` 与 `filter` 过滤并共享单例 `Intl.Collator`；在 `FileTreeView` 中前置 `isNewSelection` 守卫并启用 `heightOnly: true`；将 `FilesCard` 分割线拖拽改为 DOM Ref 直接更新 CSS 变量。
5. **消除空闲态 1Hz/10Hz 定时器空转与引用击穿（Runtime / Overview / Engine / AgentCard）**：清理 `RuntimePanel`、`useRuntimePanelData`、`useOverviewState` 在无活跃任务时的 1Hz 空转定时器与 `[...messages].reverse()` 全量数组克隆；为 `WorkspaceGitChangesView` / `SessionChangesView` 补齐 `useMemo` 恢复 `OverviewChangesList` 的 `React.memo` 屏障；为 `useEngineState` 补齐 `activeRuns`/`pendingApprovals` 的引用归一化；将 `useApprovalCountdown` 的 10Hz state 轮询收敛为 CSS 硬件加速过渡动画。
