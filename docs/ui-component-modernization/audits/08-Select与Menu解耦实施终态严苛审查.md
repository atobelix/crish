# Select、Combobox 与 Menu 解耦实施终态严苛审查报告

> **审查基准**：
> - `docs/ui-component-modernization/independent-plans/02-Select与Combobox浮层解算与自研React实现方案.md`
> - `docs/ui-component-modernization/plan-improvements/02-Select大圆角同心架构与浮层视口解算改进详案.md`
> - `docs/ui-component-modernization/plan-improvements/05-统一Select与Menu解耦架构详案.md`
> - `AGENTS.md`（§13 焦点环规范、§14 现代色彩空间、反过度设计红线、RL-03 单文件行数 $\le 190$ 行约束）
>
> **审查对象**：
> - `apps/crish-desktop/src/components/ui/Select/`（全部拆分后的子组件、适配器、定位几何引擎与样式）
> - `apps/crish-desktop/src/components/ui/Menu/`（[`Menu.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.tsx), [`Menu.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css), [`types.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/types.ts), [`position.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/position.ts), [`menuKeyNavigation.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/menuKeyNavigation.ts)）
> - `apps/crish-desktop/src/components/chat-composer/`（[`PermissionModeMenu.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx), [`PermissionModeMenu.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css)）
>
> **审查立场**：只挑刺，别的一概不说。严禁任何赞美、客套或废话，直奔问题、缺陷、潜在 Bug 与漏洞！

---

## 缺陷统计矩阵

| 审查领域 / 模块 | 致命 (Fatal) | 严重 (Critical) | 一般 (Major) | 微小 (Minor) | 合计 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **1. 依赖纯净度与 RL-03 门禁** | 1 | 2 | 0 | 0 | **3** |
| **2. 交互状态机与二次展开漏洞** | 1 | 2 | 0 | 0 | **3** |
| **3. 几何计算与浮层生命周期** | 0 | 2 | 1 | 0 | **3** |
| **4. 多行排版与 ARIA / HTML 红线** | 0 | 2 | 1 | 1 | **4** |
| **总计** | **2** | **8** | **2** | **1** | **13** |

---

## 一、依赖纯净度与 RL-03 单文件行数门禁

### 1. [严重级别: 致命] `Menu.tsx` 违规引入 `@radix-ui/react-popover` 外部包，彻底击穿 100% 纯原生自研底线
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/Menu/Menu.tsx:11`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.tsx#L11)
- **缺陷剖析**：
  代码第 11 行显式声明了：
  ```tsx
  import * as Popover from '@radix-ui/react-popover';
  ```
  整套 `Menu.tsx` 基座依然重度绑定 `@radix-ui/react-popover` 的 `Popover.Root`, `Popover.Anchor`, `Popover.Trigger`, `Popover.Portal`, `Popover.Content`。
  重构方案明确要求将 `Menu` 全面统一至自研的 `useFloatingPosition` / `calculateMenuPosition` + `createPortal` 纯原生浮层引擎，彻底消灭 Radix UI 外部依赖。
  当前实现属于**未完成纯原生迁移的半吊子实现**，导致打包产物体积虚增，且 Radix 内部事件劫持与 LayerStack 机制产生多处冲突（如 `onPointerDownOutside` 与 `onInteractOutside` 的重复兜底）。
- **极致修复方案/代码片段**：
  全面剥离 `@radix-ui/react-popover`，采用与 `SelectContent` 同构的原生 Portal + `useFloatingPosition` 架构：
  ```tsx
  // 移除 Radix 引用，改用原生 Portal 与浮层解算
  import { createPortal } from 'react-dom';
  import { useFloatingPosition } from '../Select/useFloatingPosition';

  // 原生挂载节点
  const contentNode = (
    <div
      ref={contentRef}
      role="menu"
      className={contentClasses}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transformOrigin: position.transformOrigin,
        maxHeight: resolvedMaxHeight,
        ...contentStyle,
      }}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
  return isOpen ? createPortal(contentNode, portalContainer ?? document.body) : null;
  ```

---

### 2. [严重级别: 严重] `PermissionModeMenu.tsx` 违规直接引入 `lucide-react` 外部图标包
- **文件路径与行号**：[`apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx:2`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx#L2)
- **缺陷剖析**：
  代码第 2 行：
  ```tsx
  import * as Lucide from 'lucide-react';
  ```
  在第 14-19 行及组件各处使用了 `<Lucide.ShieldCheck>`, `<Lucide.Search>`, `<Lucide.Target>`, `<Lucide.Zap>`, `<Lucide.Shield>`, `<Lucide.ChevronDown>`, `<Lucide.Check>`。
  项目在现代化战役中严格禁止任何外部图标库直接散落引入（必须统一使用自研内联 SVG 或 `SelectIcons.tsx` 中定义的轻量资产）。`PermissionModeMenu` 违反了依赖纯净度红线。
- **极致修复方案/代码片段**：
  在 `PermissionModeMenu.tsx` 内部或 `SelectIcons.tsx` 中声明纯内联原生 SVG 资产，彻底移除 `lucide-react`：
  ```tsx
  // 替换为原生轻量无外部依赖 SVG
  const ShieldCheckIcon = ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.5l5.5 2v4.5c0 3.5-2.5 6-5.5 7-3-1-5.5-3.5-5.5-7V3.5L8 1.5z" />
      <path d="M5.5 8l2 2 3.5-3.5" />
    </svg>
  );
  ```

---

### 3. [严重级别: 严重] 多个核心子组件单文件行数严重超标，违反 RL-03 拆分门禁（$\le 190$ 行）
- **文件路径与行号**：
  - [`apps/crish-desktop/src/components/ui/Select/ComboboxRoot.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/ComboboxRoot.tsx) —— **309 行**（超标 63%）
  - [`apps/crish-desktop/src/components/ui/Select/SelectRoot.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectRoot.tsx) —— **250 行**（超标 32%）
  - [`apps/crish-desktop/src/components/ui/Select/ComboboxInput.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/ComboboxInput.tsx) —— **193 行**（超标）
  - [`apps/crish-desktop/src/components/ui/Menu/menuKeyNavigation.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/menuKeyNavigation.ts) —— **200 行**（超标）
  - [`apps/crish-desktop/src/components/ui/Menu/Menu.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.tsx) —— **459 行**
- **缺陷剖析**：
  虽然对 `Select` 实施了多文件拆分，但 `SelectRoot.tsx`（250 行）与 `ComboboxRoot.tsx`（309 行）依然将“受控/非受控状态管理”、“JSX 静态子节点提取”、“Item 动态注册器”、“高亮索引计算”与“Context 打包”全部强耦合在单一文件中。
  未将逻辑下沉为独立的自定义 Hook（如 `useItemRegistry`、`useComboboxFilter`），违反了 RL-03 单个子组件文件 $\le 190$ 行的门禁红线。
- **极致修复方案/代码片段**：
  抽离 `useItemRegistry.ts` 处理 `registerItem` 与 `mergedItemMap`，使 `SelectRoot.tsx` 与 `ComboboxRoot.tsx` 纯化为仅剩 120 行以内的纯净上下文 Provider 容器。

---

## 二、交互状态机与闭合/二次展开致命漏洞

### 4. [严重级别: 致命] `registerItem` 脏缓存阻断 `setItems`，导致二次展开后键盘漫游与高亮彻底瘫痪
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/Select/SelectRoot.tsx:101-143`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectRoot.tsx#L101-L143) 与 [`ComboboxRoot.tsx:122-164`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/ComboboxRoot.tsx#L122-L164)
- **缺陷剖析**：
  1. 当 `Select` 或 `Combobox` 打开时，`SelectContent` 挂载，子项 `SelectItem` 执行 `registerItem`，此时 `itemMapRef.current` 写入映射，且 `setItems` 将项目推入 `items` 状态数组（`items.length > 0`）；
  2. 当用户选中或失焦导致浮层关闭时，`SelectContent` 卸载（`if (!ctx.open) return null`），所有 `SelectItem` 执行卸载清理函数：
     ```tsx
     return () => {
       setItems((prev) => prev.filter((i) => i.id !== itemId));
     };
     ```
     此时 `items` 状态被彻底清空为 `[]`。**但是 `itemMapRef.current` 中对应的键值对并没有被清除（为了在闭合态保底显示 Label）**；
  3. 当用户**第二次点击触发器展开浮层**时，`SelectItem` 再次挂载，调用 `registerItem`；
  4. `registerItem` 执行了前置短路判断：
     ```tsx
     const existing = itemMapRef.current.get(itemValue);
     if (
       existing &&
       existing.id === itemId &&
       existing.disabled === itemDisabled &&
       existing.label === (itemLabel || itemValue)
     ) {
       return () => {}; // 致命短路：直接返回空函数！
     }
     ```
  5. 由于 `useId()` 在相同组件树结构下生成的 `itemId` 完全一致，`itemMapRef.current.get(itemValue)` 完美命中 `existing`，导致 `registerItem` 直接提前返回，**完全没有调用 `setItems`**！
  6. **结果：在第二次及后续所有展开中，`items` 状态永久处于空数组 `[]`！**
  7. **连锁崩溃**：
     - `SelectContent.tsx:39` 中 `if (ctx.items.length > 0)` 恒为 `false`，键盘 ↑↓ 方向键、Home、End 漫游完全失效；
     - `SelectItem.tsx:38` 中 `const itemIndex = ctx.items.findIndex(...)` 恒为 `-1`，`data-index="-1"`，鼠标 Hover 无法触发高亮；
     - 键盘按下 Enter 无法选中任何项目。
- **极致修复方案/代码片段**：
  必须将“闭合态持久 Label 字典”与“展开态活跃 DOM 项列表”在状态机层完全解耦，或者在 `registerItem` 中检测 `items` 状态中是否缺失该项并重新注入：
  ```tsx
  // 修复方案：双轨制解耦
  const labelMapRef = useRef<Map<string, string>>(new Map()); // 仅持久化 value -> label

  const registerItem = useCallback(
    (itemId: string, itemValue: string, itemDisabled = false, itemLabel = '') => {
      const label = itemLabel || itemValue;
      labelMapRef.current.set(itemValue, label);

      const newItem: RegisteredItemData = {
        id: itemId,
        value: itemValue,
        disabled: itemDisabled,
        label,
        index: 0,
      };

      setItems((prev) => {
        const existingIdx = prev.findIndex((i) => i.id === itemId);
        if (
          existingIdx >= 0 &&
          prev[existingIdx]?.disabled === itemDisabled &&
          prev[existingIdx]?.label === label
        ) {
          return prev;
        }
        const filtered = prev.filter((i) => i.id !== itemId);
        const next = [...filtered, newItem];
        return next.map((item, i) => ({ ...item, index: i }));
      });

      return () => {
        setItems((prev) => prev.filter((i) => i.id !== itemId));
      };
    },
    []
  );
  ```

---

### 5. [严重级别: 严重] `ComboboxChips` 遗漏中文拼音 IME 合成锁，拼音退格误删已选胶囊
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/Select/ComboboxChips.tsx:46-69`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/ComboboxChips.tsx#L46-L69)
- **缺陷剖析**：
  在 `ComboboxInput.tsx` 中正确实现了 `handleCompositionStart`、`handleCompositionEnd` 以及 `isComposingRef` 守卫。
  但在 `ComboboxChips.tsx` 中：
  1. `<input className={styles.chipsInput}>` 根本没有绑定 `onCompositionStart` 与 `onCompositionEnd`；
  2. `handleInputKeyDown` 仅判断了 `if (e.defaultPrevented || ctx.disabled) return;`，没有校验 `ctx.isComposingRef.current`、`e.nativeEvent.isComposing` 或 `keyCode === 229`；
  3. 当用户在多选搜索框输入中文拼音（如输入 "shenru" 时按 Backspace 退格修改拼音字母），若此时 `ctx.query` 处于中间状态，Backspace 事件直接落入 `handleInputKeyDown` 的 `e.key === 'Backspace' && !ctx.query` 分支；
  4. **输入法中的正常退格直接暴力激活并删除了前面已选择的 Chip 胶囊！**
- **极致修复方案/代码片段**：
  为 `ComboboxChips` 补齐 IME 合成状态感知与拦截：
  ```tsx
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      inputProps?.onKeyDown?.(e);
      if (
        e.defaultPrevented ||
        ctx.disabled ||
        ctx.isComposingRef.current ||
        Boolean((e.nativeEvent as unknown as { isComposing?: boolean })?.isComposing) ||
        e.keyCode === 229 ||
        e.key === 'Process'
      ) {
        return;
      }
      // ... 胶囊退格与左右切换逻辑
    },
    [inputProps, ctx, valuesArray]
  );
  ```

---

### 6. [严重级别: 严重] 键盘漫游未跳过禁用项，且回绕越界时强行停留在 disabled 项上
- **文件路径与行号**：
  - [`apps/crish-desktop/src/components/ui/Select/SelectContent.tsx:37-52`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectContent.tsx#L37-L52)
  - [`apps/crish-desktop/src/components/ui/Select/SelectTrigger.tsx:59-74`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectTrigger.tsx#L59-L74)
  - [`apps/crish-desktop/src/components/ui/Select/ComboboxInput.tsx:63-80`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/ComboboxInput.tsx#L63-L80)
  - [`apps/crish-desktop/src/components/ui/Menu/menuKeyNavigation.ts:66-81`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/menuKeyNavigation.ts#L66-L81)
- **缺陷剖析**：
  1. 在 `SelectContent.tsx` 和 `SelectTrigger.tsx` 中，虽然执行了 `const items = ctx.items.filter((i) => !i.disabled);`，但在实际改变 `highlightedIndex` 时，却写成了：
     ```tsx
     ctx.setHighlightedIndex((prev) => {
       const next = prev + 1;
       return next >= ctx.items.length ? 0 : next;
     });
     ```
     不仅没有使用过滤后的 `items`，而且直接以 `1` 为步长线性递增，**键盘焦点会直接停留在被禁用的项上**！
  2. 在 `menuKeyNavigation.ts` 中，虽然使用了 `while (next < options.length && options[next]?.disabled) next++`，但当 `next >= options.length` 回绕到 `0` 时，**完全没有检查 `options[0]` 是否也是 disabled**！
  3. 违反 WAI-ARIA 1.2 Listbox / Menu 规范中“键盘导航必须跳过所有被禁用项目”的刚性要求。
- **极致修复方案/代码片段**：
  编写跳过禁用项的通用纯函数并在所有组件中复用：
  ```tsx
  export function getNextEnabledIndex<T extends { disabled?: boolean }>(
    items: ReadonlyArray<T>,
    currentIndex: number,
    direction: 1 | -1
  ): number {
    const len = items.length;
    if (len === 0) return -1;
    let next = currentIndex;
    for (let i = 0; i < len; i++) {
      next = (next + direction + len) % len;
      if (!items[next]?.disabled) {
        return next;
      }
    }
    return -1;
  }
  ```

---

## 三、几何计算、尺寸感知与浮层生命周期

### 7. [严重级别: 严重] `useFloatingPosition` 未监听 `contentRef` 尺寸变化，动态搜索时产生巨大悬空断层
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/Select/useFloatingPosition.ts:154-165`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/useFloatingPosition.ts#L154-L165)
- **缺陷剖析**：
  `ResizeObserver` 只对 `triggerRef.current` 进行了监听：
  ```tsx
  if (typeof ResizeObserver !== 'undefined' && triggerRef.current) {
    resizeObserver = new ResizeObserver(() => throttledUpdate());
    resizeObserver.observe(triggerRef.current);
  }
  ```
  在 `Combobox` 输入过滤词时，列表从 20 项过滤到 1 项，或者从 0 项恢复为多项，`contentRef.current` 的尺寸剧烈变化（如高度从 360px 变为 36px）。
  若浮层此前判定空间不足而向上翻转（`side: 'top'`），高度变小后，由于没有 ResizeObserver 重新触发解算，浮层依然基于 360px 计算的 top 坐标固定在上方，**导致浮层与输入框之间产生 300px 以上的巨大悬空空白！**
- **极致修复方案/代码片段**：
  同时将 `contentRef.current` 纳入 `ResizeObserver` 观测：
  ```tsx
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => throttledUpdate());
    if (triggerRef.current) resizeObserver.observe(triggerRef.current);
    if (contentRef.current) resizeObserver.observe(contentRef.current);
  }
  ```

---

### 8. [严重级别: 严重] `SelectContent` 进场动画在坐标解算前提前播放，导致 (0, 0) 瞬态闪烁与原点形变穿帮
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/Select/SelectContent.tsx:101-113`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectContent.tsx#L101-L113) 与 [`SelectContent.module.css:25`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectContent.module.css#L25)
- **缺陷剖析**：
  1. `SelectContent.module.css` 中的 `.content` 类默认声明了 `animation: cds-popover-enter 150ms ... forwards;`；
  2. 当 `ctx.open === true` 初次挂载时，`position.isPositioned` 为 `false`，DOM 节点被赋予 `left: 0px, top: 0px, visibility: hidden`；
  3. CSS 动画在元素插入 DOM 的瞬间立即在 `(0, 0)` 坐标启动并消耗时间；
  4. 当 `useLayoutEffect` 完成物理尺寸测量并将 `isPositioned` 置为 `true`（`visibility: visible`）时，CSS 进场动画可能已运行完毕或正在中途，**导致用户看不到完整的进场缩放/淡入动效，或在低性能设备上闪现从屏幕左上角跳跃至目标位置的瑕疵**。
- **极致修复方案/代码片段**：
  仅当 `position.isPositioned === true` 时才激活动画类名：
  ```tsx
  const contentClass = [
    styles.content,
    position.isPositioned ? styles.contentAnimated : styles.contentMeasuring,
    sizeClass,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  ```

---

### 9. [严重级别: 一般] `positionGeometry.ts` 水平刚性钳位发生后未修正 `transformOrigin`，导致缩放锚点错位
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/Select/internal/positionGeometry.ts:67-96`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/internal/positionGeometry.ts#L67-L96)
- **缺陷剖析**：
  当触发器位于视口极右侧，浮层因超出视口边界触发 `clampedX = Math.min(..., maxX)` 刚性向左平移钳位时：
  `actualAlign` 依然保持默认的 `'start'`，因此输出的 `transformOrigin` 依然计算为 `'top left'`。
  **结果：浮层进场动画从其左侧（悬空位置）放大，而不是从紧贴触发器的右侧锚点放大，造成视觉锚点严重脱节**。
- **极致修复方案/代码片段**：
  根据刚性钳位是否发生位移动态校准 `originX`：
  ```tsx
  let originX = 'left';
  if (clampedX < targetX) {
    originX = 'right'; // 右侧受阻向左钳位，原点应在右侧
  } else if (clampedX > targetX) {
    originX = 'left'; // 左侧受阻向右钳位，原点应在左侧
  } else {
    originX = actualAlign === 'end' ? 'right' : actualAlign === 'center' ? 'center' : 'left';
  }
  ```

---

## 四、多行排版、文字防穿透与 HTML / ARIA 规范

### 10. [严重级别: 严重] `PermissionModeMenu` 自定义 `renderItem` 完全阻断键盘焦点与鼠标 Hover 联动
- **文件路径与行号**：[`apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx:127-165`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx#L127-L165)
- **缺陷剖析**：
  `PermissionModeMenu` 传入了 `renderItem` 自定义渲染，但在实现中存在三大致命断链：
  1. `renderItem` 回调签名提供了 `(opt, index, isFocused)`，但其内部实现**完全忽略了 `isFocused` 参数**；
  2. 生成的 `<button className={styles.permMenuItem}>` **没有挂载 `onMouseEnter` 回调**；
  3. 当用户通过键盘 ↑↓ 键移动菜单光标时，按钮没有任何高亮类名或属性变化；当用户移动鼠标时，`focusedIndex` 无法同步更新，导致键盘 Enter 选中的项目与鼠标悬停项完全不一致。
- **极致修复方案/代码片段**：
  在 `renderItem` 中使用 `isFocused` 并绑定悬停同步：
  ```tsx
  renderItem={(opt, index, isFocused) => {
    // ...
    return (
      <Tooltip key={opt.id} content={itemMeta.matrixHint}>
        <button
          type="button"
          className={[
            styles.permMenuItem,
            isSelected ? styles.isSelected : null,
            isFocused ? styles.isFocused : null,
          ].filter(Boolean).join(' ')}
          data-highlighted={isFocused ? '' : undefined}
          role="menuitem"
          onMouseEnter={() => {
            // 触发 Menu 内部 setFocusedIndex
          }}
          onClick={(e) => {
            e.stopPropagation();
            opt.onClick?.();
          }}
        >
          {/* 项内容 */}
        </button>
      </Tooltip>
    );
  }}
  ```

---

### 11. [严重级别: 严重] `SelectTrigger` 在 `<button>` 内嵌套 `<span role="button">` 违反 HTML5 交互元素嵌套红线
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/Select/SelectTrigger.tsx:147-149`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectTrigger.tsx#L147-L149) 与 [`SelectClearButton.tsx:8-13`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectClearButton.tsx#L8-L13)
- **缺陷剖析**：
  `SelectTrigger` 的外层标签为 `<button type="button" role="combobox">`。
  其内部子节点渲染了 `<SelectClearButton />`，而 `SelectClearButton` 渲染了 `<span role="button" tabIndex={-1}>`。
  根据 W3C HTML5 规范（Section 4.10.6 The button element）：**`<button>` 元素的子树中严禁包含任何 Interactive Content（可交互内容，包括 button, a, 或具有 button role 的元素）**。
  在 `<button>` 内部嵌套 `role="button"` 会导致屏幕阅读器无法正确构建辅助功能无障碍树（Accessibility Tree），并在部分浏览器中引发事件冒泡紊乱与 Hydration Mismatch 警告。
- **极致修复方案/代码片段**：
  将 `SelectTrigger` 的外层包裹容器改造为 `<div role="combobox" tabIndex={disabled ? -1 : 0}>`，内部包含清除按钮与下拉指示箭头；或者将 ClearButton 移出 Trigger，采用 Flex 兄弟容器并列组合。

---

### 12. [严重级别: 一般] `SelectGroup` 与 `SelectGroupLabel` 缺少 `aria-labelledby` 语义关联
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/Select/SelectGroup.tsx:5-26`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectGroup.tsx#L5-L26)
- **缺陷剖析**：
  `SelectGroup` 声明了 `role="group"`，但未设置 `aria-labelledby`；`SelectGroupLabel` 也没有分配 ID。
  视障用户在使用屏幕阅读器导航选项时，读屏软件只能报读选项本身的文本，**无法获知当前选项属于哪个分组类别（如“主流模型”或“自定义微调”）**，违背了 WAI-ARIA 1.2 Group 规范。
- **极致修复方案/代码片段**：
  通过 `useId` 为 Group Label 生成全局唯一 ID，并在 Group 容器上绑定 `aria-labelledby`：
  ```tsx
  export function SelectGroup({ className, label, children }: SelectGroupProps) {
    const autoId = useId();
    const labelId = `select-group-${autoId}`;
    return (
      <div role="group" aria-labelledby={label ? labelId : undefined} className={styles.group}>
        {label && <SelectGroupLabel id={labelId}>{label}</SelectGroupLabel>}
        {children}
      </div>
    );
  }
  ```

---

### 13. [严重级别: 微小] `SelectContent` 与 `Menu` 浮层最大宽度定义割裂（420px ↔ 340px）
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/Select/SelectContent.module.css:23`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectContent.module.css#L23) vs [`apps/crish-desktop/src/components/ui/Menu/Menu.module.css:13`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L13)
- **缺陷剖析**：
  - `SelectContent.module.css` 声明 `max-width: min(420px, calc(100vw - 16px));`
  - `Menu.module.css` 声明 `max-width: min(340px, calc(100vw - 16px));`
  - 两者均为承载多行标题+次级描述（`.textCol`）的弹出浮层，但 `Menu` 的 340px 限制过窄，导致如 `PermissionModeMenu`（含 24 字次级说明）在小屏下出现 3-4 行严重折行，而 `Select` 却能舒展排版，破坏了全局浮层组件库的视觉规范一致性。
- **极致修复方案/代码片段**：
  统一收敛到 Design Tokens 变量 `--popover-max-width: min(420px, calc(100vw - 16px))`。

---

## 审查结论与整改裁决

| 审查模块 | 致命缺陷 (Blocker) | 严重缺陷 (Critical) | 一般缺陷 (Major) | 微小缺陷 (Minor) | 终态审查裁决 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **ui/Select (全部拆分子组件)** | **1** 项 | **4** 项 | **1** 项 | 0 项 | ❌ **未达终态，需就地整改** |
| **ui/Menu (基座与导航)** | **1** 项 | **2** 项 | **0** 项 | **1** 项 | ❌ **未达终态，需就地整改** |
| **PermissionModeMenu** | 0 项 | **2** 项 | **1** 项 | 0 项 | ❌ **未达终态，需就地整改** |

**核心整改底线**：
1. **彻底修复 `registerItem` 在二次展开时的状态机失效 Bug，杜绝 `items` 状态清空导致的键盘漫游与高亮完全瘫痪；**
2. **彻底剥离 `Menu.tsx` 中的 `@radix-ui/react-popover` 与 `PermissionModeMenu.tsx` 中的 `lucide-react`，达成 100% 原生自研纯净度；**
3. **补齐 `ComboboxChips` 的中文拼音 IME 合成锁，修正 `SelectTrigger` 的 HTML5 button 嵌套红线，拆分 `ComboboxRoot` 与 `SelectRoot` 使其严格满足 $\le 190$ 行门禁。**
