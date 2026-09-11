# 虚拟滚动与动态测高深度调研报告

> **战役主题**：正文交错过程折叠战役（Assistant Process Folding Campaign）  
> **文档定位**：虚拟滚动与动态测高深度调研（`05-virtual-scroll-height-survey.md`）  
> **调研角色**：虚拟滚动与动态测高调研员  
> **核心使命**：彻底解剖用户讨论中的“双通道测高”死锁根因，审查展开/折叠全链路几何形变与 VSM 树状数组（BIT）联动机制，评估 ResizeObserver 循环风险，输出多段交错折叠新架构下的自愈与测高联动契约。

---

## 一、用户图五核心技术问题复盘与“双通道测高”根因剖析

### 1.1 问题现场复盘

在正文交错过程折叠与工具/思考链展开收拢交互中，曾出现极其顽固的渲染异常：
> **用户现场描述**：“展开后滚动条不变、底部内容被裁，说明行高膨胀没有写回总高。正在查展开->测高->BIT 更新链路。根因：行内直接 manager.setActual 改了 BIT，却不触发 React actualTick；随后 useVirtualScroll.setActual 因同值短路，总高永不更新。修好了。根因是双通道测高：”

该现象具有三个鲜明表征：
1. **视觉截断（Content Clipping）**：当用户点击展开某个折叠过程块后，DOM 节点高度从数十像素急剧膨胀至数百甚至数千像素，但消息列表下方内容被硬生生截断，或无法滚到底部完整查看；
2. **滚动条僵死（Frozen Scrollbar）**：虽然 DOM 已经实质变高，但滚动条滑块（thumb）尺寸与滚动轨道（scrollHeight）完全无变化；
3. **视口切片撕裂（Viewport Tearing）**：向上或向下滚动后，虚拟列表二分查找计算出的 `visibleRange` 发生坐标偏离，出现空白占位或突然跳跃。

---

### 1.2 “双通道测高”机制冲突深度解剖

通过追踪 `apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx`、`apps/crish-desktop/src/hooks/useVirtualScroll.ts` 与 `apps/crish-desktop/src/api/VirtualScrollManager.ts`，这一缺陷的完整因果锁链被彻底还原：

```
                    【用户点击展开过程块】
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
    【通道一：行内私有直接通道】               【通道二：宿主虚拟滚动官方通道】
 (Row/Section 私自调用 VSM)               (Host ResizeObserver 观测容器)
              │                               │
              ▼                               ▼
调用 manager.setActual(id, h)           监听到 div[data-vindex] 高度膨胀
直接写入 BIT 树与 heightsById             调用 vs.setActual(id, h)
              │                               │
              ▼                               ▼
   VSM 是纯 TS 类，非 React State!         useVirtualScroll 内部检查：
 ⚠️ 绝不触发 actualTick! ⚠️              cur = manager.getActualHeight(id)
React totalHeight 保持陈旧旧值!                │
              │                               ▼
              │                     此时 cur === h 已经成立！
              │                     ⚠️ 命中同值短路提前 return! ⚠️
              │                     pending 队列未入队，rAF 未调度
              │                               │
              └───────────────┬───────────────┘
                              ▼
                【双通道致命死锁结果】
        • actualTick 永久不递增
        • React useMemo 依赖未更新，totalHeight 永远锁死在旧值
        • MessageVirtualizer 的 .listInner 高度不增加 (style.height)
        • 滚动条不更新，物理 DOM 溢出 .listInner (overflow: hidden) 底部被裁！
```

#### 1. 通道一：行内私有越权直接改写（Bypassing React State Machine）
- **代码位置**：历史版本中存在于行级或子组件（如 `ChatAssistantMessageRow`、`MessageToolCallsSection`、或独立的折叠卡片）。
- **执行逻辑**：组件通过 props 持有了 `virtualScrollManager` 实例，在折叠状态切换、或者行内私有 `ResizeObserver` 触发时，直接调用：
  ```ts
  // 危险代码：行内越权直写 VSM
  virtualScrollManager.setActual(msg.id, measuredHeight);
  ```
- **破坏点分析**：
  查阅 [`apps/crish-desktop/src/api/VirtualScrollManager.ts:252-283`](file:///c:/Software/conex/apps/crish-desktop/src/api/VirtualScrollManager.ts#L252-L283)：
  `setActual` 内部原子更新了 `this.heightsById`，并通过 `this.bitAdd(idx + 1, delta)` 将高度差累加到了 Fenwick Tree（树状数组）中。
  但是，`VirtualScrollManager` 是一个与 React 渲染管线解耦的**纯 TypeScript 内存数据结构类**，它根本不持有 React 的 `dispatch` / `setState` 句柄！直接调用 `manager.setActual` 只是修改了内存中的 C 语言风格 `Float64Array` 树状数组，**完全不会触发任何 React 组件的重渲染**。

#### 2. 通道二：宿主官方单轨通道遭“同值短路”（Short-Circuit Sabotage）
- **代码位置**：[`apps/crish-desktop/src/hooks/useVirtualScroll.ts:297-309`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useVirtualScroll.ts#L297-L309)：
  ```ts
  const setActual = useCallback(
    (id: string, height: number) => {
      const cur = manager.getActualHeight(id);
      if (cur !== null && cur === height) return; // <--- 关键短路防御逻辑
      pendingActualRef.current.set(id, height);
      if (gestureActiveRef.current) {
        bumpGestureEpoch();
        return;
      }
      scheduleActualFlush();
    },
    [bumpGestureEpoch, manager, scheduleActualFlush],
  );
  ```
- **设计初衷**：为了防止在 60Hz 渲染和多重微任务下，ResizeObserver 对未变动高度的元素反复提交相同尺寸，造成不必要的 rAF 批处理和 React 重渲染，`useVirtualScroll` 设置了 `cur !== null && cur === height` 的跳过保护。
- **死锁形成**：
  当通道一抢先一步调用了 `manager.setActual(id, height)` 后，`manager.getActualHeight(id)` 的返回值已经变成了 `height`。
  随后，宿主 `MessageVirtualizer` 的统一 ResizeObserver（[`apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx:192-204`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx#L192-L204)）或 commit 兜底逻辑（`MessageVirtualizer.tsx:236-248`）捕获到物理 DOM 膨胀，将测得的高度传入 `vs.setActual(msgId, measuredHeight)`。
  此时，`cur` 为 `height`，`cur === height` 判定为真，**通道二被通道一的偷跑写入直接短路并提前退出**！

#### 3. 终态断裂：`totalHeight` 与 `actualTick` 彻底休克
- 在 [`apps/crish-desktop/src/hooks/useVirtualScroll.ts:250-254`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useVirtualScroll.ts#L250-L254)：
  ```ts
  const totalHeight = useMemo(
    () => manager.getTotalHeight(itemCount),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manager, itemCount, actualTick],
  );
  ```
  `totalHeight` 的重新计算完全绑定在 `actualTick` 响应式状态上。
- 由于通道二被短路，`pendingActualRef` 为空，`applyPendingGeometry`（[`useVirtualScroll.ts:135-181`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useVirtualScroll.ts#L135-L181)）没有执行，`setActualTick((t) => t + 1)` 永远没有被调用。
- React 视图层看到的 `totalHeight` 依旧是展开前的几十像素。在 [`apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx:410-421`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx#L410-L421) 中：
  ```tsx
  <div
    className={styles.listInner}
    data-chat-list-inner=""
    data-vsm-spacer=""
    style={{
      height: `${totalHeight}px`,
      width: '100%',
      position: 'relative',
      overflow: 'hidden',
      overflowAnchor: 'none',
    }}
  >
  ```
  `.listInner` 的内联样式 `height` 维持原样，同时 `overflow: hidden` 强制截断，导致内部展开的数千像素内容被物理裁剪，滚动条长度纹丝不动！

---

## 二、虚拟滚动与测高核心实现及代码深度审查

为确保多段交错折叠新架构的稳健性，必须对虚拟滚动四层核心实现逐行审查。

### 2.1 宿主虚拟滚动渲染器：`MessageVirtualizer.tsx`

[`apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx)

#### 1. 单轨宿主 ResizeObserver（Single-Track Host RO）
- **代码位置**：[`MessageVirtualizer.tsx:186-223`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx#L186-L223)
- **核心逻辑**：
  ```ts
  roRef.current = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const el = entry.target;
      if (!(el instanceof HTMLElement)) continue;
      const msgId = el.dataset.vindex;
      // 统一度量入口（Plan 05 §2.2 / DEF-13）：使用 el.offsetHeight 度量完整盒模型外框高度
      const measuredHeight = el.offsetHeight || Math.ceil(entry.contentRect.height);
      if (msgId != null && measuredHeight > 0) {
        setActual(msgId, measuredHeight);
      }
    }
  });
  ```
- **关键设计断言**：
  - **唯一性**：整个虚拟滚动列表内部，只允许这一个 RO 负责度量真实高度并向 `useVirtualScroll` 写入；
  - **外框盒模型统一度量（DEF-13）**：使用 `el.offsetHeight` 作为主测高入口（包含 content + padding + border），严格规避了 `entry.contentRect.height` 丢失 padding/border 的历史缺陷；
  - **动态监听集合管理**：通过 `observedRowsRef` 与 DOM `querySelectorAll('[data-vindex]')` 对比，挂载新行即 `observe`，卸载离屏即 `unobserve`，杜绝游离 DOM 内存泄漏。

#### 2. 同帧兜底重测安全网（Commit-Phase Safety Net）
- **代码位置**：[`MessageVirtualizer.tsx:236-248`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx#L236-L248)
- **核心逻辑**：
  ```ts
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const nodes = container.querySelectorAll('[data-vindex]');
    nodes.forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      const msgId = node.dataset.vindex;
      const h = node.offsetHeight;
      if (msgId != null && h > 0) {
        setActual(msgId, h);
      }
    });
  });
  ```
- **作用**：ResizeObserver 属于浏览器事件循环末期的异步回调。在 React 提交 DOM 到 RO 回调派发的间隙，`useLayoutEffect` 在 commit 阶段同步同步扫一遍当前可见的 `[data-vindex]` 节点，调用 `setActual` 提前将高度压入 pending 队列，充当同帧兜底安全网。

#### 3. 几何占位与绝对切片容器
- **代码位置**：[`MessageVirtualizer.tsx:410-432`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx#L410-L432)
- **核心逻辑**：
  - `.listInner` 承载总高 `totalHeight`（经 `chatSpacerHeight(contentHeight)` 加上顶部 48px 与底部 32px 衬垫）；
  - 切片容器 `[data-chat-slice-container]` 使用 `transform: translateY(${startOffset}px)` 进行绝对定位，内部渲染 `messages.slice(startIndex, endIndex)`；
  - 所有行必须包裹在带 `data-vindex={msg.id}` 的外层容器中（[`MessageVirtualizer.tsx:448, 479`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx#L448)）。

---

### 2.2 虚拟滚动调度中枢：`useVirtualScroll.ts`

[`apps/crish-desktop/src/hooks/useVirtualScroll.ts`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useVirtualScroll.ts)

#### 1. 响应式时钟与缓冲池机制
- **代码位置**：[`useVirtualScroll.ts:79, 122, 124`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useVirtualScroll.ts#L79)
- **核心变量**：
  - `actualTick`：数字计数器，作为驱动 `totalHeight` 与 `visibleRange` 重新计算的唯一依赖；
  - `pendingActualRef`：`Map<string, number>`，暂存当帧收到的实测高度，天然去重去抖动；
  - `actualRafRef`：rAF 定时器句柄，确保一帧之内无论收到多少次测高回调，都仅在下一帧统一执行一次批量几何回写。

#### 2. Commit 纪元与视口上方锚点补偿（`applyPendingGeometry`）
- **代码位置**：[`useVirtualScroll.ts:135-181`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useVirtualScroll.ts#L135-L181)
- **核心算法分析**：
  ```ts
  for (const [msgId, h] of pendingActualRef.current) {
    const oldActual = manager.getActualHeight(msgId);
    const oldHeight = oldActual ?? manager.getHeight(msgId);
    const delta = h - oldHeight;
    const changed = manager.setActual(msgId, h);
    if (changed && Math.abs(delta) > SIGNIFICANT_HEIGHT_DELTA) {
      significantChanged = true;
    }
    const idx = manager.getIndex(msgId);
    if (idx !== undefined && idx < curStartIdx) {
      deltaAbove += delta; // 累加当前视口上方的所有高度增量
    }
  }
  pendingActualRef.current.clear();

  // 视口上方锚点绝对补偿（DEF-08 / DEF-11）
  if (deltaAbove !== 0 && containerRef.current) {
    const el = containerRef.current;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    const isNearBottom = maxScroll - el.scrollTop <= NEAR_BOTTOM_EPSILON;
    if (!isNearBottom && el.scrollTop > 0) {
      el.scrollTop += deltaAbove; // 关键：补偿 scrollTop，防止视口中阅读的内容跳动
      latestScrollTopRef.current = el.scrollTop;
      setScrollTop(el.scrollTop);
    }
  }

  if (significantChanged || estimatesChanged) {
    setActualTick((t) => t + 1); // 驱动 React 重算 totalHeight
  }
  ```
- **关键常数与机制**：
  - `SIGNIFICANT_HEIGHT_DELTA = 4`（px）：过滤亚像素和字体渲染细微误差，仅当高度差大于 4px 时才递增 `actualTick`，拦截高频空转；
  - `deltaAbove` 补偿机制：若上方历史消息被折叠（高度减少 500px），`deltaAbove` 为 -500px，立即将容器 `scrollTop` 同步扣减 500px。用户当前眼前正在阅读的消息行物理像素位置保持绝对不动，**实现无感折叠**！

#### 3. 手势纪元（Gesture Epoch）防护
- **代码位置**：[`useVirtualScroll.ts:198-209, 256-279`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useVirtualScroll.ts#L198-L209)
- **核心逻辑**：
  - 监听 `wheel`、`touchstart`、`pointerdown` 等物理输入事件，一旦触发立即标记 `gestureActiveRef.current = true`；
  - 在手势激活期间，所有流入的 `setActual` 仅暂存在 `pendingActualRef` 中，**暂停调用 `applyPendingGeometry`**；
  - 用户滚轮停歇超过 `GESTURE_IDLE_MS = 100ms` 或触发 `scrollend` 事件后，手势纪元结束，一次性提交所有几何变更。彻底防止用户滑轮翻看时高度突然跳变把滚动条“从手中弹飞”。

---

### 2.3 树状数组动态高度引擎：`VirtualScrollManager.ts`

[`apps/crish-desktop/src/api/VirtualScrollManager.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/VirtualScrollManager.ts)

#### 1. Fenwick Tree（树状数组）核心原语
- **代码位置**：[`VirtualScrollManager.ts:105-107, 478-491`](file:///c:/Software/conex/apps/crish-desktop/src/api/VirtualScrollManager.ts#L478-L491)
- **复杂度优势**：
  - `bitAdd(idx, delta)`：$O(\log N)$ 单点增量修改；
  - `bitQuery(idx)`：$O(\log N)$ 前缀和查询；
  - `getOffset(index)`：$O(\log N)$ 获取任意行上方偏移量；
  - `getTotalHeight(count)`：$O(\log N)$ 获取总高度；
  - `findIndexAtOffset(offset)`：$O(\log^2 N)$ 二分查找当前视口起始行。
- **性能意义**：在面对 10,000+ 条长会话时，毫秒级完成任何位置的高度更新与可见切片定位，杜绝常规数组 $O(N)$ 遍历导致的卡顿。

#### 2. 双态高度结构：`heightsById`
- **代码位置**：[`VirtualScrollManager.ts:89-92`](file:///c:/Software/conex/apps/crish-desktop/src/api/VirtualScrollManager.ts#L89-L92)
  ```ts
  private heightsById = new Map<
    string,
    { estimated: number; actual: number | null }
  >();
  ```
  - `estimated`：始终为有效正数（初始由 `estimateTimelineMessageHeight` 给出）；
  - `actual`：实测高度。未测量或已作废时为 `null`。

#### 3. 单轨核心枢纽：`invalidateActual(id)`
- **代码位置**：[`VirtualScrollManager.ts:332-341`](file:///c:/Software/conex/apps/crish-desktop/src/api/VirtualScrollManager.ts#L332-L341)
  ```ts
  /**
   * 作废 actual 时，保持 entry.estimated 为上一次测量值或已设值，
   * 绝对禁止无条件重置为 fallbackHeight (120px)！
   * 以便 ResizeObserver 重新测量期间平滑过渡，杜绝 120px 阶跃暴跌与视口抖动。
   */
  invalidateActual(id: string): void {
    const entry = this.heightsById.get(id);
    if (entry) {
      const lastKnownHeight = entry.actual ?? entry.estimated;
      entry.actual = null;
      entry.estimated =
        lastKnownHeight > 0 ? lastKnownHeight : this.fallbackHeight;
      // 保持当前高度与 BIT 树不变，平滑过渡防止视口抖动
    }
  }
  ```
- **核心机制与价值**：
  1. **清除实测状态**：`entry.actual = null`。这意味着后续 `manager.getActualHeight(id)` 返回 `null`，使得 `useVirtualScroll.setActual` 中的同值短路条件（`cur !== null && cur === height`）失效，为宿主 RO 的正向回写扫清道路；
  2. **保留过渡估计值**：将 `estimated` 置为 `lastKnownHeight`，**不修改 BIT 树**！在点击折叠/展开到新 DOM 渲染完成的 1~2 帧时间窗口内，总高度保持连续，绝不会暴跌至 120px 兜底高度造成视觉大跳跃；
  3. **单元测试验证**：[`VirtualScrollManager.test.ts:150-164`](file:///c:/Software/conex/apps/crish-desktop/src/api/VirtualScrollManager.test.ts#L150-L164) 明确固化了这一断言。

---

### 2.4 行级测高接入：`ChatAssistantMessageRow.tsx`

[`apps/crish-desktop/src/components/chat-message-row/ChatAssistantMessageRow.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatAssistantMessageRow.tsx)

#### 1. 测高单轨契约注释
- **代码位置**：[`ChatAssistantMessageRow.tsx:81-83`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatAssistantMessageRow.tsx#L81-L83)
  ```ts
  // 测高单轨：禁止行级私有 RO 直写 manager.setActual（会绕过 actualTick → 总高/滚动条不更新）。
  // 尺寸变化由 MessageVirtualizer 宿主 ResizeObserver → useVirtualScroll.setActual 统一回写。
  ```

#### 2. 内容变动与工具展开拦截链路
- **代码位置**：[`ChatAssistantMessageRow.tsx:85-99, 102-115`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatAssistantMessageRow.tsx#L85-L99)
  ```ts
  // 内容/折叠态变化 → 作废旧实测；宿主 RO 在尺寸变化时重测并触发 tick
  useEffect(() => {
    if (isThinkingMsg || msg.status === 'processing') return;
    virtualScrollManager?.invalidateActual(msg.id);
  }, [
    msg.text,
    msg.id,
    msg.status,
    msg.thinking,
    msg.toolCalls,
    msg.blocks,
    isThinkingMsg,
    hideThinkingBlock,
    toolStackProps?.expandedTools,
    virtualScrollManager,
  ]);

  // 增强 toolStackProps：工具展开/收起时立即作废旧测高，由宿主 RO 重测并触发 actualTick
  const augmentedToolStackProps = useMemo(() => {
    if (!toolStackProps) return toolStackProps;
    return {
      ...toolStackProps,
      onToggleTool: (toolId: string, currentlyOpen: boolean) => {
        toolStackProps.onToggleTool?.(toolId, currentlyOpen);
        virtualScrollManager?.invalidateActual(msg.id);
      },
      onToggleInjection: (injectionId: string, currentlyOpen: boolean) => {
        toolStackProps.onToggleInjection?.(injectionId, currentlyOpen);
        virtualScrollManager?.invalidateActual(msg.id);
      },
    };
  }, [toolStackProps, virtualScrollManager, msg.id]);
  ```
- **核心契约**：行级组件只做一件事——当自己的内容发生变化、或用户点击展开/收拢工具时，**仅调用 `invalidateActual(msg.id)`**，绝对不私自调用 `setActual`。

---

## 三、展开与折叠全链路时序与几何形变审查

### 3.1 展开/折叠完整生命周期时序追踪

当用户在某条助手消息中点击展开某个 `FoldableProcessSection`（例如将收拢的 `已搜索 3 次 · 已读取 5 个文件` 展开为详细操作列表）时，整条链路的时序跃迁如下表：

```
[ 用户点击展开按钮 ]
       │
       ▼ (T0: 交互事件触发)
[ 翻转展开状态 isExpanded = true ]
       │
       ▼ (T1: Phase A - Invalidate 作废)
[ 调用 virtualScrollManager.invalidateActual(msg.id) ]
   ├── heightsById[msg.id].actual = null
   ├── heightsById[msg.id].estimated = 上一次已知高度 (保持 BIT 树不变)
   └── 状态：原实际高度已注销，同值短路锁被解除
       │
       ▼ (T2: Phase B - React Commit & Browser Paint 布局重排)
[ React 渲染展开后的完整组件树，DOM 节点高度从 33px 膨胀到 650px ]
   ├── div[data-vindex="msg.id"] 物理 offsetHeight 变为 650px
   └── 浏览器触发该节点的 ResizeObserver 回调
       │
       ▼ (T3: Phase C - Host RO 捕获 & 调度)
[ MessageVirtualizer 的宿主 ResizeObserver 触发 ]
   ├── 提取 msgId = el.dataset.vindex
   ├── 读取 measuredHeight = el.offsetHeight (650px)
   └── 调用 vs.setActual(msgId, 650)
       │
       ▼ (T4: Phase D - useVirtualScroll 入队缓冲)
[ useVirtualScroll.setActual 校验 ]
   ├── 读取 cur = manager.getActualHeight(msgId) -> 得到 null (非 650!)
   ├── 短路条件 (cur !== null && cur === height) 为 false，放行！
   ├── pendingActualRef.set(msgId, 650)
   └── 调用 scheduleActualFlush() (请求 rAF)
       │
       ▼ (T5: Phase E - rAF 批量写入与代际递增)
[ applyPendingGeometry 执行 ]
   ├── 计算 delta = 650 - oldHeight (+617px)
   ├── 若该行在当前视口上方 (idx < curStartIdx)，el.scrollTop += delta
   ├── 调用 manager.setActual(msgId, 650) -> 更新 BIT 树
   └── 判定 Math.abs(delta) > 4px -> 调用 setActualTick(t => t + 1)
       │
       ▼ (T6: Phase F - 响应式几何自愈闭环)
[ React 重新执行 MessageVirtualizer 渲染 ]
   ├── totalHeight 依据更新后的 BIT 树重新计算，膨胀 +617px
   ├── .listInner 样式 height: ${totalHeight}px 拓展
   ├── visibleRange 重新二分计算，视口切片精准包含展开后的节点
   └── 滚动条滑块自然缩小，底部内容完整显露，零截断、零白屏！
```

---

### 3.2 ResizeObserver 循环告警风险评估与深度防范

#### 1. 循环告警成因（Browser Spec: `ResizeObserver loop limit exceeded`）
根据 W3C 规范，浏览器在单帧内的渲染流水线执行顺序为：
`Events -> rAF -> Style/Layout Recalc -> ResizeObserver Callbacks -> Paint`。  
如果在 `ResizeObserver` 回调内部执行了会引发 DOM 布局突变（如修改内联宽高、修改 `scrollTop` 引发滚动条显隐切换、动态插拔子节点等）的操作，且受影响的元素在 DOM 树中的层级深度小于或等于当前元素深度，浏览器将标记在同帧内存在未交付的通知。若超过迭代上限，就会抛出 `ResizeObserver loop limit exceeded`。

#### 2. 本仓架构的四重刚性防范盾牌

| 防范维度 | 规范与实现机制 | 代码位置 |
| :--- | :--- | :--- |
| **盾牌 1：压平为单轨 RO** | 全列表仅在 `MessageVirtualizer` 保留 1 个 RO，彻底拔除组件子树内的所有嵌套私有 RO。 | `MessageVirtualizer.tsx:186-223` |
| **盾牌 2：只读度量与 rAF 异步解耦** | RO 回调中**严格禁止任何 DOM 写入操作**；只读 `el.offsetHeight`，通过 `requestAnimationFrame` 将 BIT 写入与 React State 派发完全延迟到下一帧。 | `MessageVirtualizer.tsx:199-202`<br>`useVirtualScroll.ts:183-190` |
| **盾牌 3：4px 显著阈值拦截微震荡** | 仅当高度变化超过 `SIGNIFICANT_HEIGHT_DELTA = 4px` 时才触发 `actualTick`。防范因字体抗锯齿、边框四舍五入引发的 1px 反复横跳。 | `useVirtualScroll.ts:61, 157-159` |
| **盾牌 4：切除滚动直接副作用** | 严禁在 RO 回调中粗暴设置 `scrollTop = maxScroll`（历史 DEF-08 缺陷已根治），滚动吸底完全交由独立的物理事件捕获拦截器与 `useLayoutEffect` 状态机协调。 | `MessageVirtualizer.tsx:283-328, 379-392` |

经过上述四重防御，系统从数学和浏览器调度机制上**彻底杜绝了 ResizeObserver 循环告警的产生条件**。

---

## 四、多段交错折叠新架构下的断层排查与自愈契约

在正在规划的“正文交错过程折叠战役”中，单条助手消息内将支持**多段交错折叠**（例如：`思考过程 1` -> `中间文本` -> `多工具段 2` -> `用户插话` -> `思考过程 3` -> `总结文本`）。用户可以在同一条消息内独立、高频地展开/收拢不同片段。

### 4.1 现存代码断层深度排查

通过全面检视当前组件树实现，发现了 3 处可能危及多段折叠测高稳定的架构隐患：

#### 隐患 1：`MessageContent.tsx` 折叠状态未接入 `invalidateActual`
- **代码断层**：查阅 [`apps/crish-desktop/src/components/chat-message/MessageContent.tsx:310, 339-340`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx#L310)：
  ```tsx
  const [isProcessExpanded, setIsProcessExpanded] = useState(true);
  // ...
  <TurnProcessNodeView
    // ...
    isExpanded={isProcessExpanded}
    onToggleExpand={() => setIsProcessExpanded((prev) => !prev)}
    renderChildren={() => null}
  />
  ```
- **问题分析**：`isProcessExpanded` 是 `MessageContent` 内部私有的 `useState`，当用户点击折叠/展开时，组件虽然翻转了布尔值，但**完全没有通知父级 `ChatAssistantMessageRow`，也未调用 `virtualScrollManager?.invalidateActual(msg.id)`**！`virtualScrollManager` 甚至没有定义在 `MessageContentProps` 中！
- **后果**：当多段过程块在组件内部展开/收拢时，如果 `actual` 缓存未被作废，可能导致高度突变回写滞后或同值判断失效。

#### 隐患 2：折叠时组件被暴力 unmount 为 `null`（破坏 `until-found`）
- **代码断层**：查阅 [`apps/crish-desktop/src/components/chat-message/MessageContent.tsx:351-355`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx#L351-L355)：
  ```tsx
  {linearItems.map((item, idx) => {
    if (!isProcessExpanded && (item.kind === 'tools' || item.kind === 'thought')) {
      return null; // <--- 致命 DOM 脱落
    }
    return (
      <React.Fragment key={item.key}>
        <ProcessItemRenderer ... />
      </React.Fragment>
    );
  })}
  ```
- **问题分析**：
  1. 当 `isProcessExpanded === false` 时，直接返回 `null` 导致内部 DOM 节点完全被 React 卸载！
  2. 这直接破坏了战役核心效果锁——HTML5 `hidden="until-found"` 搜索穿透！当 DOM 节点不存在时，用户在页面上按下 `Ctrl+F` 根本无法搜索到被折叠的命令、代码或思考内容！
  3. 频繁卸载/重新挂载（Mount/Unmount）会带来巨大的垃圾回收（GC）和重排开销，当一条消息包含 30 个工具卡片时，展开瞬间会出现显著卡顿。

#### 隐患 3：缺少行级统一的高频多段失效节流总线
- **问题分析**：在多段交错架构下，如果用户快速连续点击 3 个不同的折叠块（例如在 100ms 内连击），或者多个流式工具段并行进入终态，每个块如果零散地触发状态更新，容易引发微任务风暴。

---

### 4.2 测高联动与自愈契约（Height Measurement Linkage & Self-Healing Contract）

为确保每一次展开/收拢都不会出现滚动条不更新、底部截断或视口撕裂，正式确立以下六大铁律契约：

#### 契约一：【行级单真理源（Single Truth Anchor）】
- 无论单条助手消息内部拆分出多少个交错过程块（Process Blocks）、思考段（Thinking Turns）或工具组（Tool Stacks），在虚拟滚动系统视角下，**`div[data-vindex="<msgId>"]` 始终是唯一的几何度量物理实体**；
- 严禁将内部各个过程块独立拆散成虚拟列表的一级子行（避免破坏 `hidden="until-found"` 容器连续性与状态复杂度）。

#### 契约二：【双向解耦与单轨回写（Invalidate Only, Host Measures）】
- **行内及子组件权限锁死**：行内所有子组件（`FoldableProcessSection`、`TurnProcessNodeView`、`ToolItem`、`ThinkingItem`）**绝对禁止调用 `manager.setActual`**；
- **唯一操作入口**：任何局部的展开、收拢、或者尺寸变化，行内组件**只允许向上派发或直接调用 `virtualScrollManager.invalidateActual(msgId)`**；
- **回写归宿**：实测高度回写权 100% 归属 `MessageVirtualizer` 的单轨宿主 ResizeObserver。

#### 契约三：【平滑过渡不变量（Smooth Transition Invariant）】
- `invalidateActual(id)` 必须坚守现有契约：
  $$\text{entry.actual} \leftarrow \text{null}$$
  $$\text{entry.estimated} \leftarrow \text{lastKnownHeight}$$
  $$\Delta \text{BIT Tree} = 0$$
- 严禁将 `estimated` 粗暴重置为 120px 兜底值；
- 确保从点击折叠到新 DOM 尺寸就绪的过渡帧内，列表滚动条几何与视口位置保持 100% 连续稳定。

#### 契约四：【视口上方展开锚点稳定性（Anchor Invariant Above Viewport）】
- 当发生折叠或展开的行位于当前可见视口上方时（`idx < curStartIdx`），`useVirtualScroll.ts` 中的 `applyPendingGeometry` 必须严格履行：
  $$\Delta_{\text{above}} = \sum (h_{\text{new}} - h_{\text{old}})$$
  $$\text{scrollTop}_{\text{new}} = \text{scrollTop}_{\text{old}} + \Delta_{\text{above}}$$
- 确保视口中用户正在阅读的文字行物理位置零偏移、零抖动。

#### 契约五：【HTML5 `hidden="until-found"` 与 `beforematch` 穿透自愈闭环】
- **槽位常驻**：折叠的过程块必须始终挂载在 DOM 树中，隐藏时施加原生属性：
  ```ts
  el.setAttribute('hidden', 'until-found');
  ```
  严禁使用 React 条件渲染返回 `null` 或 `display: none`；
- **事件闭环**：在过程块容器上原生监听 `beforematch` 事件：
  ```ts
  el.addEventListener('beforematch', () => {
    // 1. 状态翻转为展开
    setIsExpanded(true);
    // 2. 立即作废旧高度，迎接宿主 RO 测高
    virtualScrollManager?.invalidateActual(msgId);
  });
  ```
- **自愈效果**：当用户通过页面搜索（Ctrl+F）命中折叠内容时，浏览器原生揭示内容，触发 `beforematch`，系统瞬间同步展开状态并驱动宿主单轨 RO 重测，滚动条和虚拟切片自动自愈对齐。

#### 契约六：【手势纪元防护闭环（Gesture Epoch Shield）】
- 用户在进行滚轮高速滚动或触控拖拽时，任何因后台完成处理、状态转换或折叠变更产生的高度变动，一律锁入 `pendingActualRef` 缓冲池；
- 只有在物理手势停止（`GESTURE_IDLE_MS = 100ms`）后，才执行 `applyPendingGeometry` 批量写入，确保 60fps 极限滚动下物理手感丝般顺滑。

---

## 五、调研结论与落地方案建议（供第 2 波方案团队输入）

1. **根因定论**：用户反馈的“展开后滚动条不变、底部内容被裁”彻底确认为**双通道测高导致的 React 响应式断层与同值短路死锁**。当前仓库在核心主干上确立的“测高单轨（`invalidateActual` + 宿主单轨 RO 回写）”是正确且唯一合法的架构路径。
2. **待补齐落地项**：
   - 在 `MessageContentProps` 中显式补全 `virtualScrollManager` 传递，或建立行级 `HeightInvalidationContext` 上下文；
   - 改造 `MessageContent.tsx:351-355`，切除 `return null` 的暴力卸载代码，全面对齐 `hidden="until-found"` 槽位容器标准；
   - 为新设计的 `FoldableProcessSection` 统一接入标准 `handleToggle -> invalidateActual(msg.id)` 链路；
   - 增加多段高频交错折叠场景的自动化回归测试用例，覆盖连续快速展开多个过程块时的滚动条自愈与 BIT 树正确性。
