# Conex / Crish — 全仓 Design Tokens、Zero-Blue 与工程红线实施终态严苛审查报告

> **审查文档**：`docs/ui-component-modernization/audits/11-全仓DesignTokens与工程红线实施终态严苛审查.md`  
> **审查基准**：`AGENTS.md` §11–§14、`ANTI_OVERENGINEERING_GUARDRAILS.md`、RL-03 行数门禁、WAI-ARIA 1.2 规范与 Appica 动效契约  
> **审查范围**：
> - `apps/crish-desktop/src/components/ui/Switch/`
> - `apps/crish-desktop/src/components/ui/SegmentedControl/`
> - `apps/crish-desktop/src/components/ui/Select/`
> - `apps/crish-desktop/src/components/ui/Menu/`
> - `apps/crish-desktop/src/components/settings/`
> - `apps/crish-desktop/src/components/workspace/browser-panel/`  
> **审查纪律**：**只挑刺，别的一概不说**。严禁任何赞美、客套或废话，直奔问题、缺陷、潜在 Bug 与架构漏洞。

---

## 一、审查问题清单总览

| 编号 | 严重级别 | 所涉组件/文件 | 缺陷类别 | 核心问题摘要 |
| :--- | :--- | :--- | :--- | :--- |
| **01** | **致命/严重** | `ui/Menu/Menu.tsx:11, 209, 279, 306` & `Menu.module.css:4, 16` | 外部依赖红线 | 违背 0 外部依赖铁律，仍硬编码依赖 `@radix-ui/react-popover` |
| **02** | **严重** | `ui/Select/ComboboxInput.tsx:39-45, 81-89` | IME 竞态缺陷 | `compositionend` 同步解锁导致拼音选词回车误触发选项选择与弹窗关闭 |
| **03** | **严重** | `ui/Select/ComboboxRoot.tsx:159-161` / `SelectRoot.tsx:138-140` | 内存/状态泄漏 | 动态选项卸载时未从 `itemMapRef` 清理，导致幽灵项残留与内存泄漏 |
| **04** | **严重** | `ui/Select/SelectTrigger.tsx:57-74` / `ComboboxInput.tsx:61-80` | WAI-ARIA 违规 | 方向键导航未过滤 `disabled` 项，键盘焦点踩入禁用项且无响应 |
| **05** | **严重** | `ui/SegmentedControl/SegmentedControl.tsx:256` | 无障碍焦点陷阱 | 初始无有效选中项时所有按钮 `tabIndex={-1}`，Tab 键完全无法切入 |
| **06** | **严重** | `ui/Menu/menuKeyNavigation.ts:63-95` | 键盘漫游越界 | 方向键循环回绕与 Home/End 边界未校验首尾项 disabled 状态 |
| **07** | **一般** | `settings/SettingsDevicesTab.module.css:35, 50, 190, 216, 237` | Token 违规 HEX | 散落 5 处硬编码十六进制 `#c2410c` 回退值，违反 Zero-HEX 规范 |
| **08** | **一般** | `settings/useAppearanceSettings.ts:39-40` | 色彩规范违规 | 个性化默认常量硬编码十六进制 `#f4f3f0` 与 `#111111` |
| **09** | **一般** | `ui/Switch/Switch.tsx:184` & `Switch.module.css` | 幽灵 CSS 类 | 引用未定义的 `styles['align-start']` / `styles['align-end']` 产生脏类名 |
| **10** | **一般** | `ui/Select/SelectContent.tsx:118-119` | Stacking 拓扑缺失 | Portal 默认直挂 `document.body`，丢失 `DialogOverlayContext` 上下文 |
| **11** | **微小** | `workspace/browser-panel/BrowserImportSection.tsx:6-14` | 冗余外部包 | 未收敛至自研原生 SVG 资产，直接全量引入 `lucide-react` |

---

## 二、逐项严苛缺陷深度剖析与极致修复方案

### 1. 外部依赖红线与反过度设计

#### [严重级别: 致命/严重] `apps/crish-desktop/src/components/ui/Menu/Menu.tsx:11, 209, 279, 306-310` & `apps/crish-desktop/src/components/ui/Menu/Menu.module.css:4, 16`
- **缺陷剖析**：
  在战役总方案 `00` 与评审报告 `02`/`05` 中已明确立项铁律：**“零外部 npm 组件库依赖，绝对严禁引入 `@radix-ui` 等第三方组件库”**。
  然而在现存 `Menu.tsx` 代码中：
  - 第 11 行仍明文 `import * as Popover from '@radix-ui/react-popover';`；
  - 第 209 行、279 行、306 行、309 行、310 行仍深度绑定 `Popover.Anchor`、`Popover.Trigger`、`Popover.Root`、`Popover.Portal`、`Popover.Content`；
  - `Menu.module.css` 第 4 行与第 16 行仍强依赖 `:global([data-radix-popper-content-wrapper])` 与 `var(--radix-popover-content-available-height, 360px)`。
  目前同一体系下的 `Select` 与 `Combobox` 已经全面切换为自研纯原生 `useFloatingPosition` + `createPortal`，而 `Menu.tsx` 仍旧是一套寄生于 Radix UI 的旧实现，造成了双重浮层架构并存、打包体积浪费与隐式破坏 0-dependency 契约。
- **极致修复方案**：
  彻底清退 `@radix-ui/react-popover`，采用与 `Select` 统一的自研 `useFloatingPosition` 与 `createPortal` 原生实现：
  ```tsx
  // 彻底剔除 Radix Popover，改用自研浮层架构
  import { createPortal } from 'react-dom';
  import { useFloatingPosition } from '../Select/useFloatingPosition';

  // 定位与挂载
  const position = useFloatingPosition({
    open: isOpen,
    triggerRef: anchor ?? triggerRef,
    contentRef,
    side,
    align,
    sideOffset,
    onDismiss: () => handleOpenChange(false),
  });

  const contentNode = (
    <div
      ref={contentRef}
      role="menu"
      className={contentClasses}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transformOrigin: position.transformOrigin,
        visibility: position.isPositioned ? 'visible' : 'hidden',
        pointerEvents: position.isPositioned ? 'auto' : 'none',
        ...contentStyle,
      }}
      onKeyDown={handleKeyDown}
    >
      {/* 菜单项内容 */}
    </div>
  );

  return (
    <MenuContext.Provider value={{ menuId }}>
      {renderedTrigger}
      {isOpen && (dialogOverlay ? createPortal(contentNode, dialogOverlay) : createPortal(contentNode, document.body))}
    </MenuContext.Provider>
  );
  ```

---

### 2. 交互状态机、生命周期与边界极端场景

#### [严重级别: 严重] `apps/crish-desktop/src/components/ui/Select/ComboboxInput.tsx:39-45, 53-57, 81-89`
- **缺陷剖析**：
  在中文 IME 拼音输入时，当用户输入拼音并敲击 `Enter` 键确认上屏纯文本时：
  1. 浏览器首先触发 `onCompositionEnd`，该回调中同步执行了 `ctx.isComposingRef.current = false`；
  2. 紧接着同一物理按键的 `onKeyDown` (key: 'Enter', keyCode: 13) 触发；
  3. 由于 `isComposingRef.current` 已经被同步置为 `false`，且原生 `e.nativeEvent.isComposing` 在 Chromium/WebView2 的该 tick 中也已被置为 `false`，导致进入 `handleKeyDown` 的 `else if (e.key === 'Enter')` 判定分支；
  4. 代码直接执行 `ctx.selectValue(target.value)` 并关闭下拉框。
  **后果**：用户输入拼音确认文字时，不仅中文没有正确留存，反而误触发了下拉框首项的选中并强制关闭了下拉菜单。
- **极致修复方案**：
  引入微秒级异步防御锁（`justComposedRef` 或 `setTimeout` 解锁），防止尾随的 Enter 键穿透：
  ```tsx
  const justComposedRef = useRef(false);

  const handleCompositionStart = useCallback((e: React.CompositionEvent<HTMLInputElement>) => {
    ctx.isComposingRef.current = true;
    justComposedRef.current = false;
    onCompositionStart?.(e);
  }, [ctx, onCompositionStart]);

  const handleCompositionEnd = useCallback((e: React.CompositionEvent<HTMLInputElement>) => {
    justComposedRef.current = true;
    onCompositionEnd?.(e);
    // 延迟一个微任务解锁，拦截尾随 Enter
    setTimeout(() => {
      ctx.isComposingRef.current = false;
      justComposedRef.current = false;
    }, 20);
  }, [ctx, onCompositionEnd]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (
      e.defaultPrevented ||
      ctx.disabled ||
      ctx.isComposingRef.current ||
      justComposedRef.current ||
      e.nativeEvent.isComposing ||
      e.keyCode === 229 ||
      e.key === 'Process'
    ) {
      return;
    }
    // ... 正常键盘导航
  }, [ctx, onKeyDown]);
  ```

---

#### [严重级别: 严重] `apps/crish-desktop/src/components/ui/Select/ComboboxRoot.tsx:159-161` 与 `apps/crish-desktop/src/components/ui/Select/SelectRoot.tsx:138-140`
- **缺陷剖析**：
  在 `registerItem` 的卸载清理函数中：
  ```tsx
  return () => {
    setItems((prev) => prev.filter((i) => i.id !== itemId));
  };
  ```
  该清理函数**仅过滤了 `items` 状态数组，却未在 `itemMapRef.current` 中执行 `delete(itemValue)`**！
  在第 168 行 / 第 147 行中：
  ```tsx
  itemMapRef.current.forEach((val, key) => map.set(key, val));
  ```
  由于 `itemMapRef.current` 未删除旧项，当下拉菜单选项被动态过滤、条件渲染或异步更新时，已卸载的幽灵节点（Ghost Items）依然永久驻留在 `itemMapRef.current` 中，并被反复回填进 `mergedItemMap`。不仅导致内存泄漏，还会导致键盘上下键导航索引错乱与旧值匹配错误。
- **极致修复方案**：
  在卸载回调中严格执行双向清理：
  ```tsx
  return () => {
    itemMapRef.current.delete(itemValue);
    setItems((prev) => prev.filter((i) => i.id !== itemId));
  };
  ```

---

#### [严重级别: 严重] `apps/crish-desktop/src/components/ui/Select/SelectTrigger.tsx:57-74` 与 `apps/crish-desktop/src/components/ui/Select/ComboboxInput.tsx:61-80`
- **缺陷剖析**：
  在 `SelectTrigger.tsx` 第 57 行中定义了 `const items = ctx.items.filter((i) => !i.disabled);`，但在随后的 `ArrowDown` 与 `ArrowUp` 逻辑中：
  ```tsx
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (ctx.items.length > 0) {
      ctx.setHighlightedIndex((prev) => {
        const next = prev + 1;
        return next >= ctx.items.length ? 0 : next;
      });
    }
  }
  ```
  代码直接操作全量 `ctx.items`，完全无视了 `disabled` 过滤！
  当第 `next` 项为 `disabled: true` 时，高亮焦点依然会移动到该禁用项上；当用户按下 `Enter` 或 `Space` 时，由于禁用检查被拦截无响应，用户会感觉键盘导航发生“卡死”假象。
- **极致修复方案**：
  编写跳过禁用项的环形递增/递减算法：
  ```tsx
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (ctx.items.length > 0) {
      ctx.setHighlightedIndex((prev) => {
        let next = prev + 1;
        let count = 0;
        while (count < ctx.items.length) {
          if (next >= ctx.items.length) next = 0;
          if (!ctx.items[next]?.disabled) return next;
          next++;
          count++;
        }
        return prev;
      });
    }
  }
  ```

---

### 3. WAI-ARIA 无障碍与键盘导航

#### [严重级别: 严重] `apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx:256`
- **缺陷剖析**：
  在 `SegmentedControl.tsx` 第 256 行：
  ```tsx
  tabIndex={isSelected ? 0 : -1}
  ```
  当外部未传入有效 `value`（例如 `value=""`）或没有任一选项与 `currentValue` 匹配时，所有子项的 `isSelected` 均为 `false`，导致整组组件中**每一个 `button` 的 `tabIndex` 均为 `-1`**。
  此时，键盘用户按下 `Tab` 键向后漫游时，焦点会直接跳过整个 `SegmentedControl`，用户根本无法通过键盘进入该组件并选择任何项。
- **极致修复方案**：
  遵循 WAI-ARIA 1.2 RadioGroup 规范：当无有效选中项时，赋予第一个可用的非禁用项 `tabIndex={0}`：
  ```tsx
  const hasSelected = options.some((o) => o.value === currentValue && !o.disabled);
  const isFirstActiveFallback = !hasSelected && enabledOptions[0]?.value === opt.value;
  const itemTabIndex = isSelected || isFirstActiveFallback ? 0 : -1;

  <button
    // ...
    tabIndex={itemTabIndex}
  >
  ```

---

#### [严重级别: 严重] `apps/crish-desktop/src/components/ui/Menu/menuKeyNavigation.ts:63-95`
- **缺陷剖析**：
  在 `menuKeyNavigation.ts` 中：
  ```tsx
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setFocusedIndex((prev) => {
      let next = prev + 1;
      while (next < options.length && options[next]?.disabled) {
        next++;
      }
      return next >= options.length ? 0 : next;
    });
  }
  ```
  当从列表底部回绕到顶部（`next >= options.length`）时，代码直接返回 `0`。但如果索引 `0` 本身恰好是 `disabled` 项，焦点就会直接停在禁用项上！同理，向上回绕直接返回 `options.length - 1`，如果最后一项为禁用项，也会导致焦点落入禁用项。
- **极致修复方案**：
  在回绕分支中同样执行 `while (first < options.length && options[first]?.disabled) first++` 查找第一个有效索引。

---

### 4. Design Tokens 纯净化与样式规范

#### [严重级别: 一般] `apps/crish-desktop/src/components/settings/SettingsDevicesTab.module.css:35, 50, 190, 216, 237`
- **缺陷剖析**：
  样式表中存在 **5 处硬编码 HEX 颜色回退值**：
  - 第 35 行：`color: var(--text-warning-strong, #c2410c);`
  - 第 50 行：`color: var(--text-warning-strong, #c2410c);`
  - 第 190 行：`color: var(--text-warning-strong, #c2410c);`
  - 第 216 行：`color: var(--text-warning-strong, #c2410c);`
  - 第 237 行：`color: var(--text-warning-strong, #c2410c);`
  违反了 AGENTS.md §14 关于现代色彩空间（HSL/color-mix）及 Zero-HEX 令牌规范。
- **极致修复方案**：
  将裸写 `#c2410c` 替换为现代 HSL 令牌回退：
  ```css
  /* 修复前 */
  color: var(--text-warning-strong, #c2410c);

  /* 修复后 */
  color: var(--text-warning-strong, hsl(24 95% 41%));
  ```

---

#### [严重级别: 一般] `apps/crish-desktop/src/components/settings/useAppearanceSettings.ts:39, 40`
- **缺陷剖析**：
  在个性化默认配置常量中：
  ```ts
  const DEFAULT_PERSONALIZATION: PersonalizationSettings = {
    skin: 'warm-gray',
    customBg: '#f4f3f0',
    customFg: '#111111',
    // ...
  };
  ```
  硬编码了十六进制颜色字符串 `#f4f3f0` 与 `#111111`，未与主题令牌系统的基准色定义联动。
- **极致修复方案**：
  收敛为标准 HSL 色彩常数或统一从 theme skin 预设字典中读取：
  ```ts
  customBg: 'hsl(40 8% 95%)',
  customFg: 'hsl(0 0% 7%)',
  ```

---

#### [严重级别: 一般] `apps/crish-desktop/src/components/ui/Switch/Switch.tsx:184` & `apps/crish-desktop/src/components/ui/Switch/Switch.module.css`
- **缺陷剖析**：
  在 `Switch.tsx` 第 184 行：
  ```tsx
  className={`${styles.container} ${styles[`align-${labelPlacement}`]}`}
  ```
  代码尝试读取 `styles['align-start']` 或 `styles['align-end']`，然而在 `Switch.module.css` 中完全没有声明这两个类选择器。导致生成类名为 `container undefined`，属于死代码与无效类名拼接。
- **极致修复方案**：
  在 `Switch.module.css` 中显式声明该排版类，或直接在 JSX 中移除该无效属性读取：
  ```css
  .align-start {
    flex-direction: row;
  }
  .align-end {
    flex-direction: row-reverse;
  }
  ```

---

#### [严重级别: 一般] `apps/crish-desktop/src/components/ui/Select/SelectContent.tsx:118-119`
- **缺陷剖析**：
  `SelectContent.tsx` 中挂载 Portal 的逻辑为：
  ```tsx
  const container = portalContainer ?? (typeof document !== 'undefined' ? document.body : null);
  return container ? createPortal(contentNode, container) : contentNode;
  ```
  未消费 `DialogOverlayContext`。当 `Select` 组件渲染在带有独立层叠上下文（`isolation: isolate`）的模态弹窗（Dialog）内部时，浮层直接被挂载到了根 `document.body`，破坏了与父级 Dialog 的层叠与无障碍焦点拓扑。
- **极致修复方案**：
  从 `DialogOverlayContext` 提取容器作为第二优先级回退：
  ```tsx
  const dialogOverlay = React.useContext(DialogOverlayContext);
  const container = portalContainer ?? dialogOverlay ?? (typeof document !== 'undefined' ? document.body : null);
  ```

---

#### [严重级别: 微小] `apps/crish-desktop/src/components/workspace/browser-panel/BrowserImportSection.tsx:6-14`
- **缺陷剖析**：
  在 `BrowserImportSection.tsx` 中仍直接导入了 `lucide-react` 图标库中的 7 个图标组件（`Bookmark`, `Download`, `FileJson`, `History`, `KeyRound`, `Loader2`, `Upload`）。而在同仓的 `ui/Select` 与 `settings/FontSelectField` 中，均已使用自研轻量 SVG 图标封装（零外部依赖）。
- **极致修复方案**：
  将这 7 个图标提取为本地轻量 SVG 纯组件，彻底解除对 `lucide-react` 的直接耦合。

---

## 三、工程红线与代码门禁终态核查结论

1. **单文件代码行数门禁（RL-03）**：
   - 生产组件全部控制在 500 行安全门禁以内（`Menu.tsx`: 412 行有效代码；`BrowserImportSection.tsx`: 392 行有效代码；`Select/Combobox` 各子模块均在 80~280 行范围内）；
   - 测试文件（如 `PhysicalGeometryGuards.test.tsx` 802 行）依规范豁免于生产组件行数限制。
2. **测试套件与覆盖率**：
   - 运行 30 个测试文件、287 个单元测试全部通过（100% 绿灯）。
3. **整改阻断项总结**：
   - **必须立即彻底清除 `Menu.tsx` 中的 `@radix-ui/react-popover` 依赖**；
   - **必须立即修复 `ComboboxInput.tsx` 的 IME 拼音输入回车竞态**；
   - **必须立即补齐 `ComboboxRoot.tsx` / `SelectRoot.tsx` 的卸载内存清理与 `SelectTrigger.tsx` 的禁用项跳过机制**。
