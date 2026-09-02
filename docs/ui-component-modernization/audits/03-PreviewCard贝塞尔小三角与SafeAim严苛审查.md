# PreviewCard 贝塞尔小三角与 Safe-Aim 严苛审查报告

> **审查对象**：`apps/crish-desktop/src/components/ui/PreviewCard/`（`PreviewCard.tsx`, `PreviewCardArrow.tsx`, `PreviewCard.module.css`, `types.ts`, `PreviewCard.test.tsx`）及相关几何引擎 `SafeTriangle.ts`  
> **审查标准**：Conex / Crish 桌面客户端现代化 UI 规范、WAI-ARIA 1.2、AGENTS.md、RL-03 单文件行数红线  
> **审查结论**：发现 3 处致命缺陷、3 处严重缺陷、3 处一般缺陷、2 处微小缺陷。整体架构存在全局监听器内存泄漏、跨组件定时器竞态、小三角横向旋转错位与穿模、单文件行数严重超标等严重问题。

---

## 缺陷清册与深度剖析

### [严重级别: 致命]
- **文件路径:行号**：`apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.tsx:389-411` 与 `apps/crish-desktop/src/components/ui/internal/SafeTriangle.ts:166-169`
- **缺陷剖析**：
  1. **全局 `mousemove` 监听器内存泄漏**：在 `PreviewCardTrigger` 的 `handleMouseLeave` 中，当鼠标离开触发器时向 `window` 注册了 `mousemove` 监听器 `onWindowMouseMove`。当光标在安全三角形内部停滞不动、或者用户将光标直接移出操作系统窗口（Window Blur/Leave）时，`onWindowMouseMove` 将不再被触发；虽然 `SafeTriangleTracker` 内部的 300ms `graceTimer` 会超时并重置内部数据，但是挂载在全局 `window` 上的 `mouseMoveListenerRef.current` **没有任何外部超时机制去注销移除它**！每次鼠标移出若不再次移动划出边界，就会在 `window` 上永久堆积一个无主事件监听器，导致严重的内存泄漏。
  2. **Grace Period 超时卡片状态停滞**：当 300ms `graceTimer` 在 `SafeTriangleTracker` 内部触发重置后，`SafeTriangleTracker` 没有向 `PreviewCard` 派发任何回调。如果鼠标静止停留在触发器与卡片之间的空白区域，卡片将永远保持打开悬空状态，直到鼠标下一次晃动才会被动关闭，彻底破坏了「300ms 意图保护超时自动关闭」的状态机契约。
- **极致修复方案/代码片段**：
  让 `SafeTriangleTracker` 支持超时回调，并在 `PreviewCardTrigger` 中将 Grace 定时器由 Trigger 统一控制与清理，确保超时时同步移除 `window` 监听器并执行 `setIsOpen(false)`：
  ```tsx
  // apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.tsx
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cleanupSafeAim = useCallback(() => {
    if (mouseMoveListenerRef.current) {
      window.removeEventListener('mousemove', mouseMoveListenerRef.current);
      mouseMoveListenerRef.current = null;
    }
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = undefined;
    }
    safeAimTrackerRef.current.reset();
  }, []);

  const handleMouseLeave = (e: React.MouseEvent<HTMLElement>) => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = undefined;
    }
    if (!isOpenRef.current || !contentEl) {
      setIsOpen(false);
      return;
    }

    const cursor = { x: e.clientX, y: e.clientY };
    const contentRect = contentEl.getBoundingClientRect();
    safeAimTrackerRef.current.enter(cursor, contentRect, effectiveSide);

    cleanupSafeAim();

    // 启动严格受控的 300ms Grace Period 兜底定时器
    graceTimerRef.current = setTimeout(() => {
      cleanupSafeAim();
      setIsOpen(false);
    }, 300);

    const onWindowMouseMove = (moveEvent: MouseEvent) => {
      const p = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (safeAimTrackerRef.current.check(p)) {
        return;
      }
      // 光标滑出锥区：立即清理并启动 hideTimer
      cleanupSafeAim();
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = undefined;
        setIsOpen(false);
      }, delayHide);
    };

    mouseMoveListenerRef.current = onWindowMouseMove;
    window.addEventListener('mousemove', onWindowMouseMove, { passive: true });
  };
  ```

---

### [严重级别: 致命]
- **文件路径:行号**：`apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.tsx:305-307, 538-540, 676-692`
- **缺陷剖析**：
  **跨组件定时器状态割裂与竞态闪退覆盖**：`PreviewCardTrigger` 与 `PreviewCardContent` 分别独立维护了各自私有的 `hideTimerRef`。当鼠标从 Content 快速划回 Trigger 时，Content 的 `handleMouseLeave` 启动了自身的 `hideTimerRef`（`delayHide=150ms`）；虽然此时 Trigger 捕获了 `handleMouseEnter` 并清空了 Trigger 自身的 `hideTimerRef`，但 **无法清空 Content 内部正在倒计时的 `hideTimerRef`**！导致 150ms 后 Content 的定时器强制触发 `setIsOpen(false)`，使用户刚刚悬停回 Trigger 的预览卡片发生不可预期的突发闪退。
- **极致修复方案/代码片段**：
  将打开/关闭防抖定时器、Safe-Aim 状态机统一收敛至 `PreviewCardContext` 中，由上下文唯一控制器（Single Source of Truth）集中调度：
  ```tsx
  // 在 Context 中集中暴露统一调度函数
  export interface PreviewCardContextValue {
    // ...
    scheduleOpen: (el: HTMLElement) => void;
    scheduleClose: (delay?: number) => void;
    cancelPendingClose: () => void;
  }
  ```

---

### [严重级别: 致命]
- **文件路径:行号**：`apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.tsx:1-767`
- **缺陷剖析**：
  **严重违反 RL-03 单文件行数红线（UI ≤ 500 行）**：`PreviewCard.tsx` 单文件代码量达到 767 行，超出限制 53.4%。该文件混杂了视口几何计算、Ref 合并工具、Context 状态机、Trigger 代理劫持、Content 浮层渲染、Portal 挂载以及 Title/Description 排版原子组件，违反单一职责原则，使得几何维护与渲染测试极其脆弱。
- **极致修复方案/代码片段**：
  按照模块化解耦重构为精简架构：
  1. `previewCardPositioning.ts`（约 120 行）：提取 `computePreviewCardPosition`、`PREVIEW_CARD_EDGE_PAD` 与几何边界钳位；
  2. `PreviewCardContext.tsx`（约 80 行）：提取 Context 状态机、统一定时器管理器；
  3. `PreviewCard.tsx`（约 180 行）：纯净的主组件编排、Trigger 与 Content 拆分。

---

### [严重级别: 严重]
- **文件路径:行号**：`apps/crish-desktop/src/components/ui/PreviewCard/PreviewCardArrow.tsx:16-24` 与 `apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.module.css:83-113`
- **缺陷剖析**：
  1. **小三角横向（left/right）旋转后几何包围盒错位**：小三角 SVG 原始尺寸为 `26 × 18`（宽 26px，高 18px，突出高度 9px，插入深度 9px）。当 `side="left"` 或 `side="right"` 时，CSS 使用 `transform: rotate(90deg)` 或 `rotate(-90deg)`，旋转中心为 `(50%, 50%)` 即 `(13, 9)`。旋转后，视觉宽度变为 18px，视觉高度变为 26px。而在 CSS 中写死 `right: -13px` / `left: -13px`，导致突出的尖端距离卡片边缘产生了 `13 - 9 = 4px` 的几何错位（小三角悬空或底色断层）。
  2. **高分屏（125%、150% DPI）亚像素黑线/白缝**：CSS `transform: rotate(...)` 会导致坐标落在非整数像素栅格上；同时 `.popup[data-side='...']` 的 `border-width: 2px` 与小三角基础边框在旋转后与抗锯齿引擎冲突，在 Windows 125%/150% 缩放比例下极易在三角底座与卡片边缘之间撕裂出 1px 的半透明白缝或重影黑线。
- **极致修复方案/代码片段**：
  严格消除 CSS 任意旋转中心带来的错位，采用 `transform-origin` 精确对齐或在 SVG 级别通过 viewBox/坐标变换完成四向定位，并设置亚像素重叠保护（Overlap Stitching）：
  ```css
  /* apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.module.css */
  .arrowContainer {
    position: absolute;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 18px;
    pointer-events: none;
    z-index: 2;
  }

  .arrowContainer[data-side='top'] {
    bottom: -8.5px; /* 0.5px 亚像素深插抗锯齿 */
    transform: rotate(180deg);
  }

  .arrowContainer[data-side='bottom'] {
    top: -8.5px;
    transform: rotate(0deg);
  }

  .arrowContainer[data-side='left'] {
    right: -12.5px;
    transform: rotate(90deg);
    transform-origin: center center;
  }

  .arrowContainer[data-side='right'] {
    left: -12.5px;
    transform: rotate(-90deg);
    transform-origin: center center;
  }
  ```
  在 `PreviewCardArrow.tsx` 中准确计算旋转后的中心偏置：
  ```tsx
  const isHorizontal = side === 'left' || side === 'right';
  // 横向旋转后，视觉高度是 26px，自身中心对齐偏置应使用 -13px
  const posOffset = offset - 13;
  const sign = posOffset >= 0 ? '+' : '-';
  const absOffset = Math.abs(posOffset);

  const positionStyle: React.CSSProperties = isHorizontal
    ? { top: `calc(50% ${sign} ${absOffset}px)`, ...style }
    : { left: `calc(50% ${sign} ${absOffset}px)`, ...style };
  ```

---

### [严重级别: 严重]
- **文件路径:行号**：`apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.tsx:127-128, 165-166`
- **缺陷剖析**：
  **Corner Clipping（小三角脱出卡片圆角边界穿模）**：
  在 `computePreviewCardPosition` 中：
  ```ts
  const maxOffset = Math.max(0, cardWidth / 2 - 20);
  arrowOffset = Math.max(-maxOffset, Math.min(rawOffset, maxOffset));
  ```
  卡片的圆角半径为 `border-radius: var(--radius-xl, 12px)`（$R = 12\text{px}$），小三角宽度为 26px（半宽 13px）。当 `maxOffset = cardWidth / 2 - 20` 时，小三角最外侧边缘距离卡片边缘仅为：  
  $$\text{Margin} = \frac{\text{cardWidth}}{2} - \left(\frac{\text{cardWidth}}{2} - 20\right) - 13 = 7\text{px} < 12\text{px}$$  
  小三角已经侵入卡片 12px 圆角弧度弯曲区域！小三角底部的平直背景色与 2px 描边将直接“悬空突出”在卡片圆角之外，形成极为难看的破角穿模刺角。
- **极致修复方案/代码片段**：
  根据同心几何安全边界，安全裕量必须严格满足：  
  $$\text{SafePadding} = \text{BorderRadius}(12\text{px}) + \text{ArrowHalfWidth}(13\text{px}) + \text{SafetyMargin}(3\text{px}) = 28\text{px}$$
  ```ts
  // apps/crish-desktop/src/components/ui/PreviewCard/previewCardPositioning.ts
  export const ARROW_SAFE_PADDING = 28;

  const maxOffsetH = Math.max(0, cardWidth / 2 - ARROW_SAFE_PADDING);
  arrowOffset = Math.max(-maxOffsetH, Math.min(rawOffset, maxOffsetH));

  const maxOffsetV = Math.max(0, cardHeight / 2 - ARROW_SAFE_PADDING);
  arrowOffset = Math.max(-maxOffsetV, Math.min(rawOffset, maxOffsetV));
  ```

---

### [严重级别: 严重]
- **文件路径:行号**：`apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.tsx:670-703`
- **缺陷剖析**：
  **自定义 Container 挂载导致 `fixed` 定位坐标双重叠加与严重漂移**：
  `PreviewCardContent` 支持 `container` 属性。当用户传入非 `document.body` 的局部容器（例如一个 Modal 对话框或具有 CSS `transform` / `filter` / `perspective` 的父容器）时，浏览器的 CSS 规范会使 `position: fixed` 的包含块（Containing Block）变成该父容器，而非全局视口。然而 `computePreviewCardPosition` 计算得出的 `pos.left` / `pos.top` 是基于**全局视口（Visual Viewport）**的绝对像素坐标，这会导致卡片位置被叠加上父容器的相对坐标，发生上百像素的严重位置漂移甚至直接飞出屏幕。
- **极致修复方案/代码片段**：
  当挂载到自定义 `container` 时，必须获取容器的 `containerRect` 并做相对坐标减除归一化：
  ```tsx
  let targetLeft = result.left;
  let targetTop = result.top;

  if (portalTarget && portalTarget !== document.body) {
    const containerRect = portalTarget.getBoundingClientRect();
    targetLeft = result.left - containerRect.left + portalTarget.scrollLeft;
    targetTop = result.top - containerRect.top + portalTarget.scrollTop;
  }

  setPos({ top: targetTop, left: targetLeft });
  ```

---

### [严重级别: 一般]
- **文件路径:行号**：`apps/crish-desktop/src/components/ui/internal/SafeTriangle.ts:45-53`
- **缺陷剖析**：
  **朴素 2D 向量叉积在浮点微小误差下导致边缘失效**：
  `isPointInTriangle` 采用了无容差的 `!(hasNeg && hasPos)` 判定。在 Windows 高 DPI 缩放（如 125%、150%）及子像素光标轨迹下，浮点计算可能产生 `1e-16` 与 `-1e-16` 的符号突变，导致本应在三角形边缘上的轨迹点被判定为外部点，导致 Safe-Aim 保护提前终止。
- **极致修复方案/代码片段**：
  引入 `EPSILON = 1e-7` 容差或统一采用 `SafeAimEngine` 的重心坐标算法：
  ```ts
  export function isPointInTriangle(
    m: Point2D,
    a: Point2D,
    b: Point2D,
    c: Point2D,
    eps = 1e-6
  ): boolean {
    const cp1 = crossProduct(a, b, m);
    const cp2 = crossProduct(b, c, m);
    const cp3 = crossProduct(c, a, m);

    const hasNeg = cp1 < -eps || cp2 < -eps || cp3 < -eps;
    const hasPos = cp1 > eps || cp2 > eps || cp3 > eps;

    return !(hasNeg && hasPos);
  }
  ```

---

### [严重级别: 一般]
- **文件路径:行号**：`apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.tsx:439-441, 708` 与 `PreviewCardTitle.tsx`
- **缺陷剖析**：
  1. **ARIA 契约语义偏离**：`PreviewCardTrigger` 标记了 `'aria-haspopup': 'dialog'`。在 WAI-ARIA 规范中，非模态 Hover 预览浮层不应使用 `dialog`，以免导致屏幕阅读器误认为打开了独占式模态窗口。
  2. **Dialog 缺失 Accessible Name 关联**：`PreviewCardContent` 上标有 `role="dialog"`，但未通过 `aria-labelledby` 关联到 `PreviewCardTitle`，未通过 `aria-describedby` 关联到 `PreviewCardDescription`，违反无障碍规范。
- **极致修复方案/代码片段**：
  在 Context 中派发 `titleId` 与 `descriptionId`，建立精确的 ARIA 双向绑定：
  ```tsx
  const titleId = `${cardId}-title`;
  const descId = `${cardId}-desc`;

  // 在 PreviewCardContent 上：
  <div
    ref={mergedRef}
    id={cardId}
    role="region"
    aria-labelledby={titleId}
    aria-describedby={descId}
    data-slot="preview-card-content"
    tabIndex={-1}
    ...
  />
  ```

---

### [严重级别: 一般]
- **文件路径:行号**：`apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.tsx:573`
- **缺陷剖析**：
  **过于激进的 `window.blur` 导致富文本内交互闪退**：
  `PreviewCardContent` 在 `window.addEventListener('blur', handleDismiss)` 监听窗口失焦。当 PreviewCard 内部包含输入框、文件选择器、或者调用剪贴板/ContextMenu 时，Webkit/Blink 会短暂触发 `window.blur`，导致预览卡片被直接销毁，破坏复杂富媒体卡片的用户操作流。
- **极致修复方案/代码片段**：
  增加文档激活状态判定，过滤内部控件引起的临时失焦：
  ```tsx
  useEffect(() => {
    if (!isOpen) return;
    const handleDismiss = () => {
      // 若当前焦点仍在卡片内部，则忽略失焦
      if (popupRef.current?.contains(document.activeElement)) return;
      setIsOpen(false);
    };
    window.addEventListener('scroll', handleDismiss, true);
    window.addEventListener('resize', handleDismiss);
    return () => {
      window.removeEventListener('scroll', handleDismiss, true);
      window.removeEventListener('resize', handleDismiss);
    };
  }, [isOpen, setIsOpen]);
  ```

---

### [严重级别: 微小]
- **文件路径:行号**：`apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.module.css:16-18, 126, 133`
- **缺陷剖析**：
  **硬编码非标 fallback 颜色与缺失 `:focus-visible` 焦点环规范**：
  CSS Modules 中出现了 `hsl(0 0% 100%)`、`#111111`、`#555555`、`hsl(35 10% 86%)` 等非标准 fallback 色值；且未对可聚焦的 PreviewCard 提供标准的微弱发丝焦点环，违反 AGENTS.md 视觉红线。
- **极致修复方案/代码片段**：
  完全映射至 Conex 标准 Design Tokens：
  ```css
  .popup {
    background: var(--bg-elevated, #18181b);
    color: var(--text-primary, #f4f4f5);
    border: 1px solid var(--border-overlay, rgba(255, 255, 255, 0.1));
  }

  .popup:focus-visible {
    outline: 2px solid var(--focus-ring, rgba(255, 255, 255, 0.2));
    outline-offset: 2px;
  }
  ```

---

### [严重级别: 微小]
- **文件路径:行号**：`apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.test.tsx:1-469`
- **缺陷剖析**：
  **单元测试覆盖盲区**：单测未包含 Grace Timer 300ms 超时自动注销 `window.mousemove` 的断言，缺少 Corner Clipping（28px 安全边界）的边界几何断言，以及多层嵌套容器偏移测试。
- **极致修复方案/代码片段**：
  在 `PreviewCard.test.tsx` 中补充对应断言套件，锁定内存清理与穿模保护。

---

## 审查总结表

| 序号 | 缺陷名称 | 严重级别 | 影响范围 |
| :--- | :--- | :--- | :--- |
| 1 | 全局 mousemove 监听器与 Grace 定时器内存泄漏 | **致命** | 内存与事件系统 |
| 2 | Trigger 与 Content 双重 hideTimer 跨组件竞态闪退 | **致命** | 交互体验与状态机 |
| 3 | PreviewCard.tsx 达 767 行（超标 53.4% 违反 RL-03） | **致命** | 代码架构与工程规范 |
| 4 | 小三角 90° 旋转包围盒错位与亚像素白缝 | **严重** | 视觉渲染与几何精度 |
| 5 | 小三角偏置裕量不足致 12px 圆角 Corner Clipping 穿模 | **严重** | 几何边界与视觉美观 |
| 6 | 自定义 Container 挂载致 fixed 坐标双重叠加严重漂移 | **严重** | 图层栈与 Portal 挂载 |
| 7 | 2D 向量叉积无 Epsilon 容差导致边界判定失效 | **一般** | 算法稳健性 |
| 8 | WAI-ARIA 语义偏离与 Accessible Name 关联缺失 | **一般** | 无障碍合规 |
| 9 | 激进 window.blur 导致富文本内部交互误销毁 | **一般** | 复杂业务场景 |
| 10 | CSS 模块非标 fallback 颜色与焦点环缺失 | **微小** | Design Tokens 规范 |
| 11 | 单元测试缺少 Grace 内存释放与穿模边界断言 | **微小** | 质量保障与回归防护 |
