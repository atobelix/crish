# Conex / Crish — Select 与 Combobox 浮层解算及无障碍严苛审查报告

> **审查目标**：`apps/crish-desktop/src/components/ui/Select/`（`Select.tsx`, `Combobox.tsx`, `useFloatingPosition.ts`, `Select.module.css`, `Combobox.module.css`, `types.ts`, `index.ts`, `Select.test.tsx`, `Combobox.test.tsx`）
> **对齐基准**：`docs/ui-component-modernization/independent-plans/03-Select与Combobox同心圆角与原生搜索方案.md`、WAI-ARIA 1.2、LayerStack 调度中枢契约、Zero-Blue 墨阶设计令牌与工程红线（RL-03）。
> **审查模式**：零废话，直奔问题、缺陷、潜在 Bug 与漏洞。

---

## 一、审查问题清单与缺陷剖析

### [严重级别: 严重] LayerStack `onDismiss` 漏判 `'programmatic'` 导致同级互斥驱逐失效为游离浮层
- **文件路径**：`apps/crish-desktop/src/components/ui/Select/Select.tsx:679-683` / `apps/crish-desktop/src/components/ui/Select/Combobox.tsx:980-984`
- **缺陷剖析**：
  在 `SelectContent` 与 `ComboboxContent` 中，调用 `useFloatingPosition` 时传入的 `onDismiss` 回调为：
  ```typescript
  onDismiss: (reason) => {
    if (reason === 'outside-pointer' || reason === 'escape' || reason === 'parent-dismissed') {
      setOpen(false);
    }
  }
  ```
  然而在 `LayerStackManager.ts:276` 中，当用户打开另一个属于 `exclusive-peer` 的下拉菜单或上下文菜单时，LayerStack 会通过 `evictExclusivePeers()` 调用 `this.dismissLayer(peer.id, 'programmatic')`。
  由于此处白名单**遗漏了 `'programmatic'`**，原已打开的 Select / Combobox 在接收到驱逐信号后**拒绝执行 `setOpen(false)`**！这导致旧浮层脱离 LayerStack 调度（在 LayerStack 中已被 unregister），但仍孤立驻留在 DOM 视口中，且不再响应 Esc 或外部点击，彻底破坏多浮层排他互斥机制。
- **极致修复方案**：
  允许所有合法的 LayerStack 驱逐原因触发关闭，或在 `onDismiss` 中全量捕获非 `item-select` 的解散行为：
  ```typescript
  onDismiss: (reason) => {
    // 覆盖 outside-pointer, escape, parent-dismissed 以及同级互斥的 programmatic 驱逐
    if (reason !== 'item-select') {
      setOpen(false);
    }
  },
  ```

---

### [严重级别: 严重] 首帧 `(0, 0)` 坐标瞬态裸露与 `isPositioned` 门闩缺失导致的视觉闪烁
- **文件路径**：`apps/crish-desktop/src/components/ui/Select/useFloatingPosition.ts:157-165` & `apps/crish-desktop/src/components/ui/Select/Select.tsx:754-771`
- **缺陷剖析**：
  1. `useFloatingPosition` 初始化状态为 `{ x: 0, y: 0, isPositioned: false }`；
  2. 当 `open` 变为 `true` 时，`SelectContent` 立即在 Portal 中挂载渲染 `<div style={{ left: '0px', top: '0px' }} className={styles.content}>`；
  3. `Select.module.css:205` 定义了 `animation: popupEnter 180ms cubic-bezier(0.175, 0.885, 0.32, 1.25)`；
  4. 虽然 `useLayoutEffect` 会在挂载后同步测量并更新坐标，但在浏览器初次布局与 CSS 动画初始化帧，浮层会在屏幕左上角 `(0, 0)` 短暂实例化 1 帧后突变至计算位置，产生肉眼可见的瞬态跳跃与位移闪烁；
  5. `SelectContent` 与 `ComboboxContent` 均未消费 `position.isPositioned` 来控制首帧的 `visibility: hidden` 或 `opacity: 0`。
- **极致修复方案**：
  在浮层完成首次精准几何物理测量前，设置样式门闩，仅当 `isPositioned` 为 `true` 时才展示并激活进场动画：
  ```tsx
  const popupElement = (
    <div
      ref={contentRef as React.RefObject<HTMLDivElement>}
      id={listboxId}
      role="listbox"
      tabIndex={-1}
      aria-multiselectable={multiple}
      data-slot="select-content"
      className={contentClass}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transformOrigin: position.transformOrigin,
        visibility: position.isPositioned ? 'visible' : 'hidden',
        pointerEvents: position.isPositioned ? 'auto' : 'none',
      }}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.list}>{children}</div>
    </div>
  );
  ```

---

### [严重级别: 严重] 缺少水平方向 Flip X 碰撞避让机制且 `transformOrigin` 与 Clamped 坐标脱节
- **文件路径**：`apps/crish-desktop/src/components/ui/Select/useFloatingPosition.ts:108-136`
- **缺陷剖析**：
  1. `computeFloatingPosition` 仅实现了垂直方向的 `Flip Y`（`spaceBelow` vs `spaceAbove`），水平方向仅计算了简单的 `targetX`，**完全缺失水平方向空间评估（Flip X）**；
  2. 当 `align === 'start'` 且触发器靠近屏幕右边缘时，Popup 宽度超出视口右边界，虽然通过 `clampedX = Math.min(..., maxX)` 强制把 X 坐标拉回到视口内，但 `actualAlign` 仍然保持 `'start'`；
  3. `transformOrigin` 计算逻辑硬编码为：`actualAlign === 'end' ? 'right' : actualAlign === 'center' ? 'center' : 'left'`；
  4. 结果导致：Popup 实际靠右贴边展示，但其弹性动画的原点却依然挂在 `'left'`（脱离了 Trigger 的相对对齐锚点），在进场缩放动画时呈现出诡异的悬空斜向拉伸。
- **极致修复方案**：
  在 `computeFloatingPosition` 中加入水平可用空间评估，当 `start` 对齐溢出且右侧空间不足时，自动翻折至 `end` 对齐并动态同步 `transformOrigin`：
  ```typescript
  // 水平方向空间评估与 Flip X
  const spaceRight = vp.width - (triggerRect.left - offsetLeft) - edgePadding;
  const spaceLeft = triggerRect.right - offsetLeft - edgePadding;

  let actualAlign = align;
  if (align === 'start' && popupWidth > spaceRight && spaceLeft > spaceRight) {
    actualAlign = 'end';
  } else if (align === 'end' && popupWidth > spaceLeft && spaceRight > spaceLeft) {
    actualAlign = 'start';
  }

  let targetX = triggerRect.left;
  if (actualAlign === 'end') {
    targetX = triggerRect.right - popupWidth;
  } else if (actualAlign === 'center') {
    targetX = triggerRect.left + (triggerRect.width - popupWidth) / 2;
  }
  ```

---

### [严重级别: 严重] `highlightMatches` 全局正则 `gi` 在 `.map()` 中多次 `test()` 导致 `lastIndex` 状态变异
- **文件路径**：`apps/crish-desktop/src/components/ui/Select/Combobox.tsx:56-73`
- **缺陷剖析**：
  ```typescript
  export function highlightMatches(text: string, query: string): React.ReactNode {
    if (!query || !query.trim()) return text;
    const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    const parts = text.split(regex);

    if (parts.length <= 1) return text;

    return parts.map((part, i) =>
      regex.test(part) ? (
        <span key={i} className={comboboxStyles.highlightText}>
          {part}
        </span>
      ) : (
        part
      )
    );
  }
  ```
  带有 `g`（global）标志的 `RegExp` 对象是有状态的（Stateful），每次调用 `regex.test(str)` 都会修改并推进 `regex.lastIndex`。
  在 `parts.map` 循环中，当某一段匹配成功后，`lastIndex` 被置为非 0 值；下一轮迭代测试新的子串 `part` 时，`test()` 将从非零索引开始查找，直接导致本应命中的关键词返回 `false`，出现偶发性高亮丢失、高亮错位或跳词 Bug！
- **极致修复方案**：
  移除 `test` 时对带 `g` 全局正则的复用，改用字符串无大小写比较，或使用纯函数无状态测试：
  ```typescript
  export function highlightMatches(text: string, query: string): React.ReactNode {
    const trimmed = query.trim();
    if (!trimmed || !text) return text;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'i');
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'));

    if (parts.length <= 1) return text;

    return parts.map((part, i) =>
      regex.test(part) ? (
        <span key={i} className={comboboxStyles.highlightText}>
          {part}
        </span>
      ) : (
        part
      )
    );
  }
  ```

---

### [严重级别: 严重] 中文输入法选词 `Enter` 触发 `compositionend` 导致紧随的 `keydown` 误判为选项提交
- **文件路径**：`apps/crish-desktop/src/components/ui/Select/Combobox.tsx:501-510, 627-632`
- **缺陷剖析**：
  在 Chromium 及 WebKit 内核中，用户使用中文拼音输入法输入英文字母并按下 `Enter` 键上屏原字符（非选词）时，浏览器的事件触发顺序为：
  1. `compositionend`（输入法合成结束）；
  2. `keydown`（键值为 `Enter`，`keyCode: 13`，`isComposing: false`）。

  在 `ComboboxInput` 中：
  ```typescript
  onCompositionEnd={() => {
    isComposingRef.current = false;
  }}
  ```
  `compositionend` 瞬间将 `isComposingRef.current` 设为了 `false`。紧接着到来的 `keydown(Enter)` 检测到 `isComposingRef.current === false` 且 `e.nativeEvent.isComposing === false`，直接执行了 `selectValue(target.value)`！
  导致用户原本只是想确认输入的拼音字符，输入框却意外选中了下拉列表中高亮的第一项并强行关闭了下拉菜单。
- **极致修复方案**：
  增加时间戳/微任务合成锁门闩（Composition Guard），在 `compositionend` 发生后的 20ms 内阻断一切 `Enter` 提交：
  ```typescript
  const compositionEndTimeRef = useRef(0);

  // onCompositionEnd:
  onCompositionEnd={() => {
    isComposingRef.current = false;
    compositionEndTimeRef.current = performance.now();
  }}

  // handleKeyDown:
  if (
    isComposingRef.current ||
    e.nativeEvent.isComposing ||
    e.keyCode === 229 ||
    e.key === 'Process' ||
    performance.now() - compositionEndTimeRef.current < 50
  ) {
    return;
  }
  ```

---

### [严重级别: 严重] `ComboboxChips` Backspace 倒格删除异步闭包竞态导致 `activeChipIndex` 越界与光标丢失
- **文件路径**：`apps/crish-desktop/src/components/ui/Select/Combobox.tsx:726-751`
- **缺陷剖析**：
  在多选 Chips 的倒格删除逻辑中：
  ```typescript
  if (e.key === 'Backspace' && query === '' && valuesArray.length > 0) {
    if (activeChipIndex === -1) {
      setActiveChipIndex(valuesArray.length - 1);
    } else {
      const valToRemove = valuesArray[activeChipIndex];
      if (valToRemove) {
        removeChip(valToRemove);
        setActiveChipIndex(
          activeChipIndex > 0 ? activeChipIndex - 1 : valuesArray.length > 1 ? 0 : -1
        );
      }
    }
    return;
  }
  ```
  1. `removeChip` 会触发父级 `onValueChange`（异步状态变更）；
  2. 当用户连续快速敲击两次 `Backspace` 时，第二次 `handleKeyDown` 执行时当前闭包中的 `valuesArray` 仍是上一帧旧数组（例如长度为 2）；
  3. `valuesArray.length > 1 ? 0 : -1` 错误将 `activeChipIndex` 赋为 `0`；
  4. 当 React 重新渲染且 `valuesArray` 变为空数组 `[]` 时，`activeChipIndex` 依然停留在 `0`（悬空越界索引）；
  5. 此时若用户再次输入字符或按 Delete 键，`valuesArray[activeChipIndex]` 为 `undefined`，且界面胶囊高亮状态异常；
  6. 此外，点击 `ComboboxChip` 内的 `chipRemove` 按钮后，由于调用了 `e.stopPropagation()`，焦点滞留在已被销毁的按钮上，导致 DOM 焦点掉落回 `document.body`，用户必须重新鼠标点击输入框才能继续键入。
- **极致修复方案**：
  1. 在 `Combobox` 渲染中建立 `useEffect` 自动纠偏越界的 `activeChipIndex`；
  2. 移除 Chip 后自动调用 `inputRef.current?.focus()` 确保光标永不掉落：
  ```typescript
  useEffect(() => {
    if (activeChipIndex >= valuesArray.length) {
      setActiveChipIndex(valuesArray.length - 1);
    }
  }, [valuesArray.length, activeChipIndex]);

  const handleChipRemove = (val: string) => {
    removeChip(val);
    setActiveChipIndex(-1);
    inputRef.current?.focus();
  };
  ```

---

### [严重级别: 严重] `<SelectTrigger>` (`<button>`) 内部嵌套 `<SelectClearButton>` (`role="button"`) 违反 HTML/WAI-ARIA 规范
- **文件路径**：`apps/crish-desktop/src/components/ui/Select/Select.tsx:546-574, 923-944`
- **缺陷剖析**：
  1. `SelectTrigger` 渲染为原生 `<button type="button">`；
  2. 当 `clearable={true}` 且存在选值时，`SelectTrigger` 的子树内直接渲染了 `<SelectClearButton>`，其内部输出 `<span role="button" tabIndex={-1} aria-label="清空选值">`；
  3. **W3C HTML5 与 WAI-ARIA 规范严格禁止在 `<button>` 或 interactive element 内部嵌套任何具有交互语义的子元素（如 `<button>`, `<a>`, 或带有 `role="button"` 的节点）**；
  4. 该结构会导致屏幕阅读器（NVDA / VoiceOver）朗读混乱，在某些浏览器下会引发点击事件穿透失灵，并在任何自动化可访问性检测工具（Axe / Lighthouse）中被判定为致命违规。
- **极致修复方案**：
  将 `SelectClearButton` 从 `SelectTrigger` 按钮内部移出，采用外部包装容器将 Trigger 与 Clear Button 并列组合，或将 Clear Button 作为 Trigger 的同级绝对定位兄弟节点，使用统一的 Frame 容器承载视觉边框。

---

### [严重级别: 严重] 严重违反 RL-03 单文件行数限制（`Select.tsx` 1081 行，`Combobox.tsx` 1340 行）
- **文件路径**：`apps/crish-desktop/src/components/ui/Select/Select.tsx` & `apps/crish-desktop/src/components/ui/Select/Combobox.tsx`
- **缺陷剖析**：
  1. 违反项目工程红线 RL-03（UI 组件单文件不得超过 500 行）；
  2. `Select.tsx` 达 1081 行，`Combobox.tsx` 达 1340 行；
  3. 两个文件各自拷贝了完全相同的微图标实现（`ChevronIcon`, `CheckIcon`, `ClearIcon`，重复约 120 行）；
  4. 两个文件各自拷贝了完全相同的 AST 树遍历元数据提取函数（`extractItemsFromChildren` vs `extractComboboxItemsFromChildren`，重复约 60 行）；
  5. 复合子组件（Trigger, Value, Content, Item, Group, Chips, Input 等）未进行合理物理拆分，全部塞入单文件，严重阻碍可维护性与单元测试隔离度。
- **极致修复方案**：
  建立 `apps/crish-desktop/src/components/ui/Select/internal/` 目录：
  - `SelectIcons.tsx`：共享微图标；
  - `extractChildrenItems.ts`：统一提取 Item 元数据；
  - 将 `SelectTrigger.tsx`, `SelectContent.tsx`, `SelectItem.tsx`, `ComboboxChips.tsx`, `ComboboxInput.tsx` 等按原子职责独立成单文件（每个文件均控制在 100~250 行以内）。

---

### [严重级别: 一般] 滚动监听缺失节流（RAF Throttle）且容器 Resize 未接入 `ResizeObserver`
- **文件路径**：`apps/crish-desktop/src/components/ui/Select/useFloatingPosition.ts:226-240`
- **缺陷剖析**：
  1. `useFloatingPosition` 使用了 `window.addEventListener('scroll', handleScrollOrResize, { passive: true, capture: true })`；
  2. 在全视口任何滚动事件发生时，直接同步执行 `updatePosition()`（包含 `triggerEl.getBoundingClientRect()`、`contentEl.offsetWidth`、`style.setProperty` 等强制同步布局重流）；
  3. 在 120Hz/144Hz 触控板或惯性滚动下，每秒触发数百次无节流的 DOM 测量与重绘，引发严重的 Layout Thrashing 与掉帧；
  4. 更严重的是：**完全没有对 `triggerRef.current` 挂载 `ResizeObserver`**。当浮层展开期间，侧边栏折叠/展开、SplitPane 拖拽或容器宽度变化时，`--anchor-width` 不会重新解算，下拉浮层与 Trigger 宽度立刻发生脱节与错位。
- **极致修复方案**：
  1. 使用 `requestAnimationFrame` 对滚动事件进行调度节流；
  2. 为 `triggerEl` 挂载 `ResizeObserver` 实时监听物理盒模型变动：
  ```typescript
  useEffect(() => {
    if (!open) return;

    let rafId: number | null = null;
    const throttledUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        updatePosition();
        rafId = null;
      });
    };

    window.addEventListener('resize', throttledUpdate, { passive: true });
    window.addEventListener('scroll', throttledUpdate, { passive: true, capture: true });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && triggerRef.current) {
      resizeObserver = new ResizeObserver(throttledUpdate);
      resizeObserver.observe(triggerRef.current);
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', throttledUpdate);
      window.removeEventListener('scroll', throttledUpdate, true);
      resizeObserver?.disconnect();
    };
  }, [open, updatePosition, triggerRef]);
  ```

---

### [严重级别: 一般] 单选 Combobox 选值后将 Label 写入 `query` 导致二次展开时被自身过滤仅剩 1 项
- **文件路径**：`apps/crish-desktop/src/components/ui/Select/Combobox.tsx:337-342`
- **缺陷剖析**：
  在单选模式下选中某个项目时：
  ```typescript
  handleValueChange(val);
  const itemLabel = itemMap.get(val)?.label || val;
  setQuery(itemLabel);
  setOpen(false);
  ```
  代码直接将选中项的显示文案（如 `"Claude 3.5 Sonnet"`）写入了 `query` 搜索过滤词。
  当用户再次点击该输入框准备切换模型时，`query` 依然为 `"Claude 3.5 Sonnet"`，`filteredItems` 将此作为关键字进行全量过滤，导致弹出的下拉列表**只包含当前选中的这 1 项**！用户必须手动将输入框内的字逐个删光才能重新看到完整模型列表，交互极其反人性。
- **极致修复方案**：
  分离「已选值展示文案（Display Value）」与「当前瞬态搜索词（Search Query）」：
  - 当输入框获得焦点或下拉面板展开时，选中文本文本域（`input.select()`），或在展开时重置过滤词；
  - 仅在用户实际发生键盘键入（`onChange`）时才驱动 `filteredItems` 的缩减。

---

### [严重级别: 一般] `ComboboxChip` 内微型删除按钮未设置 `tabIndex={-1}` 导致 Tab 焦点穿行深坑
- **文件路径**：`apps/crish-desktop/src/components/ui/Select/Combobox.tsx:931-938`
- **缺陷剖析**：
  `ComboboxChip` 中的删除按钮定义为：
  ```tsx
  <button
    type="button"
    aria-label={`Remove ${typeof displayContent === 'string' ? displayContent : value}`}
    className={comboboxStyles.chipRemove}
    onClick={handleRemove}
  >
    <ClearIcon />
  </button>
  ```
  该 `<button>` 未声明 `tabIndex={-1}`，默认会进入页面的 Tab 焦点序列。
  当一个多选 Combobox 选中了 10 个项目时，用户在表单中使用 `Tab` 键向后导航，光标必须依次聚焦这 10 个微型叉号按钮（按 10 次 Tab），才能到达搜索输入框或下一个表单控件，严重破坏键盘导航效率。
- **极致修复方案**：
  为微型删除按钮显式标记 `tabIndex={-1}`，通过 `Backspace` / `Delete` 键在输入框中进行键盘删除导航：
  ```tsx
  <button
    type="button"
    tabIndex={-1}
    aria-label={`Remove ${typeof displayContent === 'string' ? displayContent : value}`}
    className={comboboxStyles.chipRemove}
    onClick={handleRemove}
  >
    <ClearIcon />
  </button>
  ```

---

### [严重级别: 微小] `sm` 档位同心圆角方程偏离设计规范公式
- **文件路径**：`apps/crish-desktop/src/components/ui/Select/Select.module.css:209-212, 309`
- **缺陷剖析**：
  设计详案第 2.1 节严格规定数学同心圆角方程：$R_{\text{inner}} = R_{\text{outer}} - \text{Padding}$。
  - 在 `sm` 档位中：Popup 外壳 `.contentSm` 为 `border-radius: 12px`，内边距 `padding: 4px`；
  - 计算得出内部 Item 圆角应为：$R_{\text{item}} = 12 - 4 = 8\text{px}$；
  - 然而在 `Select.module.css:309` 中，`.itemSm` 却被设置成了 `border-radius: 6px`；
  - 这导致在 `sm` 尺寸下，Item 选项行的圆角曲率与外部浮层容器发生偏离。
- **极致修复方案**：
  调整 `.contentSm` 的圆角为 `10px`（对应 Item `6px` + Padding `4px`），或修正 `.itemSm` 的圆角为 `8px`。

---

## 二、审查综合结论与整改优先级建议

| 序号 | 缺陷模块 | 严重级别 | 核心问题概述 | 修复复杂度 |
|---|---|---|---|---|
| 1 | `Select` / `Combobox` | **严重** | `onDismiss` 漏判 `'programmatic'` 导致同级互斥驱逐失效，留下僵尸游离浮层 | 极低（1行） |
| 2 | `useFloatingPosition` | **严重** | 首帧 `(0, 0)` 坐标瞬态裸露与 `isPositioned` 门闩缺失导致的闪烁 | 低 |
| 3 | `useFloatingPosition` | **严重** | 缺少水平方向 Flip X 碰撞避让机制且 `transformOrigin` 与 Clamped 坐标脱节 | 中 |
| 4 | `Combobox` | **严重** | `highlightMatches` 全局正则 `gi` 在 `.map()` 中多次 `test()` 导致状态变异高亮失效 | 低 |
| 5 | `Combobox` | **严重** | 中文拼音输入法 `compositionend` 导致紧随的 `Enter` 误触发选项选中 | 低 |
| 6 | `Combobox` | **严重** | 多选 Chips Backspace 异步闭包竞态致 `activeChipIndex` 越界与焦点掉落 | 中 |
| 7 | `Select` | **严重** | Trigger `<button>` 内嵌套 Clear `<span role="button">` 违反 HTML/ARIA 规范 | 中 |
| 8 | `Select` / `Combobox` | **严重** | 严重超出 RL-03 单文件行数限制（1081 行 / 1340 行）与大量代码重复拷贝 | 中（文件拆分） |
| 9 | `useFloatingPosition` | **一般** | 滚动监听未接入 RAF 节流且容器 Resize 缺失 `ResizeObserver` 监听 | 低 |
| 10 | `Combobox` | **一般** | 单选模式选值强制将 Label 写入 `query` 导致二次展开时被自身过滤 | 中 |
| 11 | `Combobox` | **一般** | `ComboboxChip` 内微型删除按钮未设置 `tabIndex={-1}` 导致 Tab 焦点穿行深坑 | 极低（1行） |
| 12 | `Select.module.css` | **微小** | `sm` 档位同心圆角方程偏离设计规范公式 | 极低（1行） |

---
*报告生成于战役审查流水线，已写入 `docs/ui-component-modernization/audits/02-Select与Combobox浮层解算及无障碍严苛审查.md`。*
