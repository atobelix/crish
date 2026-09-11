# Conex / Crish — Select、Combobox 与多行自适应详案严苛审查报告

> **审查文档**：
> 1. `docs/ui-component-modernization/plan-improvements/02-Select与Combobox大圆角同心架构与解耦拆分详案.md`
> 2. `docs/ui-component-modernization/plan-improvements/03-多行Select文字重叠根治与Menu弹性自适应详案.md`
>
> **审查基准**：WAI-ARIA 1.2、Design Tokens 规范、Zero-Blue 纯净墨阶、RL-03 单文件行数门禁、纯原生 0 第三方依赖架构。

---

## 目录

- [一、架构解耦、Context 状态机与闭包擦除缺陷](#一架构解耦context-状态机与闭包擦除缺陷)
  - [CR-01 【致命】闭合态 ItemMap 被彻底擦除致 SelectValue 回退裸 ID 缺陷](#cr-01-致命闭合态-itemmap-被彻底擦除致-selectvalue-回退裸-id-缺陷)
  - [CR-02 【严重】Context Value 无 useMemo 导致 O(N) 级级联重渲染与性能雪崩](#cr-02-严重context-value-无-usememo-导致-on-级级联重渲染与性能雪崩)
  - [CR-03 【严重】浮层内容动态缩放时缺失 Content ResizeObserver 致高空悬空停滞](#cr-03-严重浮层内容动态缩放时缺失-content-resizeobserver-致高空悬空停滞)
- [二、存量兼容层（Legacy Adapter）契约破坏与类型遗漏](#二存量兼容层legacy-adapter契约破坏与类型遗漏)
  - [CR-04 【严重】SelectLegacyAdapter 遗漏 align/side/icon 导致存量调用表现退化](#cr-04-严重selectlegacyadapter-遗漏-alignsideicon-导致存量调用表现退化)
  - [CR-05 【严重】清空操作向 Legacy onChange 传递 null 触发类型崩塌](#cr-05-严重清空操作向-legacy-onchange-传递-null-触发类型崩塌)
  - [CR-06 【一般】ComboboxLegacyAdapter 缺失 filter/query/className 属性透传](#cr-06-一般comboboxlegacyadapter-缺失-filterqueryclassname-属性透传)
- [三、多行自适应、几何解算与视口边缘碰撞缺陷](#三多行自适应几何解算与视口边缘碰撞缺陷)
  - [CR-07 【严重】极窄视口下未设置视口相对最大宽度致浮层右侧溢出截断](#cr-07-严重极窄视口下未设置视口相对最大宽度致浮层右侧溢出截断)
  - [CR-08 【严重】边界极限钳位导致浮层完全反向遮挡触发器（Trigger Occlusion）](#cr-08-严重边界极限钳位导致浮层完全反向遮挡触发器trigger-occlusion)
  - [CR-09 【一般】海量多行数据下无动态虚拟测量致滚动抖动与首开卡顿（TBT 超标）](#cr-09-一般海量多行数据下无动态虚拟测量致滚动抖动与首开卡顿tbt-超标)
- [四、IME 输入法门闩与正则高亮漏洞](#四ime-输入法门闩与正则高亮漏洞)
  - [CR-10 【严重】50ms 硬编码时间戳在掉帧场景下锁提前失效导致误选](#cr-10-严重50ms-硬编码时间戳在掉帧场景下锁提前失效导致误选)
  - [CR-11 【致命】ComboboxInput 键盘事件完全缺失 Enter/ArrowUp 选项确认分支](#cr-11-致命comboboxinput-键盘事件完全缺失-enterarrowup-选项确认分支)
  - [CR-12 【严重】highlightMatches 非字符串子节点导致 text.split 运行时白屏崩塌](#cr-12-严重highlightmatches-非字符串子节点导致-textsplit-运行时白屏崩塌)
  - [CR-13 【微小】多连续空格与字符集 `-` 转义不全导致高亮失真](#cr-13-微小多连续空格与字符集---转义不全导致高亮失真)
- [五、无障碍（WAI-ARIA）断层与键盘交互缺失](#五无障碍wai-aria断层与键盘交互缺失)
  - [CR-14 【致命】SelectContent 夺取焦点后缺失 Listbox 键盘漫游事件处理器](#cr-14-致命selectcontent-夺取焦点后缺失-listbox-键盘漫游事件处理器)
  - [CR-15 【严重】ComboboxInput 缺失 aria-activedescendant 导致读屏器断联](#cr-15-严重comboboxinput-缺失-aria-activedescendant-导致读屏器断联)
  - [CR-16 【一般】ComboboxChips 键盘选定删除态无视觉反馈与索引空洞](#cr-16-一般comboboxchips-键盘选定删除态无视觉反馈与索引空洞)
- [六、工程红线违规、第三方依赖矛盾与 Token 违规](#六工程红线违规第三方依赖矛盾与-token-违规)
  - [CR-17 【致命】03 详案 Menu.tsx 违规引入 @radix-ui 违反“零外部依赖”铁律](#cr-17-致命03-详案-menutsx-违规引入-radix-ui-违反零外部依赖铁律)
  - [CR-18 【一般】硬编码非 Token 色值与 !important 滥用违反设计规范](#cr-18-一般硬编码非-token-色值与-important-滥用违反设计规范)

---

## 一、架构解耦、Context 状态机与闭包擦除缺陷

### CR-01 【致命】闭合态 ItemMap 被彻底擦除致 SelectValue 回退裸 ID 缺陷
- **文件路径**：`02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L671-L680`, `L955`, `L869-L874`
- **缺陷剖析**：
  在详案中，`SelectContent.tsx` 声明了闭合时直接卸载的保护：`if (!open) return null;`。
  当 `SelectItem` 随浮层销毁卸载时，其 `useEffect` cleanup 函数被触发：`return () => { currentMap.delete(itemValue); };`。
  这意味着：**只要 Select 处于闭合状态，`itemMap` 就会被完全清空！**
  在 `SelectValue.tsx` 中，选值 Label 计算逻辑为：
  `const singleLabel = itemMap.get(value as string)?.label || (value as string);`
  由于 `itemMap` 在闭合状态下为空，`SelectValue` 永远无法命中映射，导致界面在关闭时直接回退显示原始 ID 字符串（例如显示 `"claude-3-5-sonnet"` 而非 `"Claude 3.5 Sonnet (Latest)"`），严重破坏用户体验。原单体代码使用的 JSX 静态预扫描 `extractItemsFromChildren` 在拆分中被完全遗弃。
- **极致修复方案**：
  在 `SelectRoot` 挂载期保留双重注册策略：静态扫描 JSX 获得初始元数据保底，同时动态 `registerItem` 支持动态更新；并且卸载 cleanup 时仅标记 `mounted: false`，绝不直接删除已选中的 label 映射。
```tsx
// SelectRoot.tsx
const itemMapRef = useRef<Map<string, RegisteredItemData>>(new Map());

// 初始化与静态扫描融合
const registerItem = useCallback(
  (id: string, itemValue: string, disabledItem?: boolean, label = '') => {
    itemMapRef.current.set(itemValue, {
      id,
      value: itemValue,
      disabled: disabledItem,
      label: label || itemValue,
      index: itemMapRef.current.size,
    });
    return () => {
      // 严禁 delete！仅保留 label 映射供 SelectValue 闭合展示
    };
  },
  []
);
```

---

### CR-02 【严重】Context Value 无 useMemo 导致 O(N) 级级联重渲染与性能雪崩
- **文件路径**：`02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L697-L718`, `L1025-L1034`
- **缺陷剖析**：
  `SelectRoot` 内的 `contextValue` 是一个在每次组件渲染时直接字面量声明的对象，未经过 `useMemo` 包裹。
  当键盘漫游触发 `highlightedIndex` 改变，或者外部任意父级更新引发 `SelectRoot` 重渲染时，`contextValue` 的对象引用必然发生突变。
  所有消费 `useSelectContext()` 的子组件（`SelectTrigger`, `SelectValue`, `SelectContent` 以及几百个 `SelectItem`）都将被强行触发全部重新渲染。在 100+ 选项列表中，用户每按一次上下键漫游都会导致数百个 DOM 节点发生 O(N) 级全量 Virtual DOM Diff，产生严重掉帧（FPS < 30）。
- **极致修复方案**：
  将高频变动的 `highlightedIndex` 与低频稳定的组件状态拆分，或对 `contextValue` 进行严格 `useMemo` 缓存，并在 `SelectItem` 处使用 `React.memo` 阻断渲染穿透。
```tsx
// SelectRoot.tsx
const contextValue = useMemo<SelectContextValue>(
  () => ({
    value,
    defaultValue,
    onValueChange: handleValueChange,
    open,
    setOpen: handleOpenChange,
    size,
    variant,
    multiple,
    clearable,
    disabled,
    selectId,
    highlightedIndex,
    setHighlightedIndex,
    triggerRef,
    contentRef,
    registerItem,
    itemMap: itemMapRef.current,
    clear,
  }),
  [
    value,
    defaultValue,
    handleValueChange,
    open,
    handleOpenChange,
    size,
    variant,
    multiple,
    clearable,
    disabled,
    selectId,
    highlightedIndex,
    clear,
  ]
);
```

---

### CR-03 【严重】浮层内容动态缩放时缺失 Content ResizeObserver 致高空悬空停滞
- **文件路径**：`02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L2276-L2287`
- **缺陷剖析**：
  在 `useFloatingPosition.ts` 中，`ResizeObserver` **仅监听了 `triggerRef.current`**，完全没有监听 `contentRef.current`：
  ```typescript
  if (typeof ResizeObserver !== 'undefined' && triggerRef.current) {
    resizeObserver = new ResizeObserver(throttledUpdate);
    resizeObserver.observe(triggerRef.current);
  }
  ```
  在 Combobox 搜索过滤场景中，当用户输入关键词使列表从 20 项筛选为 1 项时，浮层高度从 `280px` 骤缩为 `40px`。
  如果此时浮层处于向上翻折状态（`actualSide === 'top'`），其 `y` 坐标在打开时是按照 `280px` 计算的（`y = top - 280 - offset`）。由于 `contentRef` 缺少 Resize 监听，`y` 坐标不会更新，导致 `40px` 的微型浮层直接悬浮在高空中，与输入框之间出现 `240px` 的巨大空白断层！
- **极致修复方案**：
  `ResizeObserver` 必须同时监听 `triggerRef.current` 和 `contentRef.current`。
```typescript
// useFloatingPosition.ts
let resizeObserver: ResizeObserver | null = null;
if (typeof ResizeObserver !== 'undefined') {
  resizeObserver = new ResizeObserver(throttledUpdate);
  if (triggerRef.current) resizeObserver.observe(triggerRef.current);
  if (contentRef.current) resizeObserver.observe(contentRef.current);
}
```

---

## 二、存量兼容层（Legacy Adapter）契约破坏与类型遗漏

### CR-04 【严重】SelectLegacyAdapter 遗漏 align/side/icon 导致存量调用表现退化
- **文件路径**：`02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L1189-L1237`
- **缺陷剖析**：
  1. `LegacySelectProps` 类型定义中包含 `align?: 'start' | 'center' | 'end'` 与 `side?: 'top' | 'bottom'`，但在 `SelectLegacyAdapter` 的实现中，这两个 Props **被完全忽略丢弃**，未传递给内部的 `SelectContent`；
  2. 当 `options` 中传入自定义图标 `icon` 并在单选选中时，`SelectLegacyAdapter` 的 `SelectTrigger` 内部仅放置了 `<SelectValue placeholder={placeholder} />`，而 `SelectValue` 根本不会渲染选中项的 `icon`，导致存量带图标的下拉选择框在选中后图标离奇丢失。
- **极致修复方案**：
  在适配器中全面透传几何配置，并通过 `SelectValue` 自定义渲染函数恢复选中态图标展示。
```tsx
// SelectLegacyAdapter.tsx
export function SelectLegacyAdapter({
  value,
  onChange,
  options = [],
  placeholder = '请选择...',
  disabled = false,
  error,
  label,
  size = 'md',
  id,
  className,
  clearable = false,
  align = 'start',
  side = 'bottom',
}: LegacySelectProps) {
  const currentOption = options.find((o) => o.id === value);

  return (
    <div className={styles.legacyWrapper}>
      {label && <label className={styles.legacyLabel} htmlFor={id}>{label}</label>}
      <SelectRoot
        value={value}
        onValueChange={(v) => onChange?.(v as string)}
        size={size}
        disabled={disabled}
        clearable={clearable}
        id={id}
      >
        <SelectTrigger className={`${error ? styles.triggerError : ''} ${className ?? ''}`}>
          <SelectValue placeholder={placeholder}>
            {currentOption ? (
              <span className={styles.legacySelectedValue}>
                {currentOption.icon && <span className={styles.itemIcon}>{currentOption.icon}</span>}
                <span>{currentOption.label}</span>
              </span>
            ) : null}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align={align} side={side}>
          {options.map((opt) => (
            <SelectItem key={opt.id} value={opt.id} disabled={opt.disabled} icon={opt.icon} hint={opt.hint}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectRoot>
      {error && <p className={styles.legacyErrorText}>{error}</p>}
    </div>
  );
}
```

---

### CR-05 【严重】清空操作向 Legacy onChange 传递 null 触发类型崩塌
- **文件路径**：`02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L1211`, `L1929`
- **缺陷剖析**：
  存量业务代码中 `onChange` 的类型契约为 `(value: string) => void`，存量业务处理器通常直接执行 `val.trim()` 或 `val.toLowerCase()`。
  在 `SelectLegacyAdapter` 与 `ComboboxLegacyAdapter` 中：
  `onValueChange={(v) => onChange?.(v as string)}`
  当用户触发清空按钮时，`SelectRoot` 派发 `handleValueChange(null)`，导致适配器强行将 `null` 断言为 `string` 并直接传给存量 `onChange` 回调，立刻导致业务代码抛出 `TypeError: Cannot read properties of null`。存量代码中 `newVal === null ? onChange('') : onChange(newVal)` 的空值安全保护被抹杀。
- **极致修复方案**：
```tsx
onValueChange={(v) => {
  if (v === null || v === undefined) {
    onChange?.('');
  } else if (typeof v === 'string') {
    onChange?.(v);
  }
}}
```

---

### CR-06 【一般】ComboboxLegacyAdapter 缺失 filter/query/className 属性透传
- **文件路径**：`02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L1906-L1948`
- **缺陷剖析**：
  `ComboboxLegacyAdapter` 接收签名中丢弃了 `className`, `filter`, `query`, `onQueryChange`, `error`, `label` 等关键 Props，并且未对 `ComboboxItem` 传递 `hint` 或 `description`，导致存量使用配置项的 Combobox 无法自定义过滤函数与附加样式。
- **极致修复方案**：
  补齐完整 Props 接口透传并注入 `filter` 与错误信息展示。

---

## 三、多行自适应、几何解算与视口边缘碰撞缺陷

### CR-07 【严重】极窄视口下未设置视口相对最大宽度致浮层右侧溢出截断
- **文件路径**：`03-多行Select文字重叠根治与Menu弹性自适应详案.md:L1341-L1342`, `02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L2454-L2456`
- **缺陷剖析**：
  在 `03` 详案中，浮层样式被设置为：
  ```css
  min-width: 260px;
  max-width: 340px;
  ```
  在桌面端侧边栏、分屏模式（SplitPane 折叠至 280px）或窄窗口环境下，视口有效宽度可能仅为 `300px`。
  `positionGeometry.ts` 的水平钳位仅将 `x` 坐标钳制在 `offsetLeft + edgePadding`（8px），但由于 CSS 中未设置针对视口宽度的响应式上限 `max-width: calc(100vw - 16px)`，浮层以 `340px` 渲染时，右侧将直接超出屏幕边缘 48px，导致右侧翡翠绿对勾、滚动条与多行文字被硬生生切断在屏幕外！
- **极致修复方案**：
  在所有浮层 CSS Modules 中注入视口安全宽度限制。
```css
/* SelectContent.module.css / PermissionModeMenu.module.css */
.content,
.permMenu {
  min-width: min(260px, calc(100vw - 16px));
  max-width: min(340px, calc(100vw - 16px));
  width: var(--anchor-width, auto);
}
```

---

### CR-08 【严重】边界极限钳位导致浮层完全反向遮挡触发器（Trigger Occlusion）
- **文件路径**：`02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L2135-L2142`
- **缺陷剖析**：
  在 `computeFloatingPosition` 算法中：
  ```typescript
  const minY = offsetTop + edgePadding;
  const maxY = offsetTop + vp.height - popupHeight - edgePadding;
  const clampedY = Math.min(Math.max(minY, targetY), Math.max(minY, maxY));
  ```
  当 Trigger 位于视口顶部偏下（如 $Y = 40\text{px}$）且下方空间被其他面板遮挡，算法决定向上翻折（Flip Y），`targetY = 40 - 200 - 6 = -166px`。
  由于 `targetY < minY`，钳位方程将其强行拉回至 `clampedY = 8px`。
  此时浮层位于 $Y = 8\text{px} \dots 208\text{px}$，而 Trigger 位于 $Y = 40\text{px} \dots 72\text{px}$。**浮层直接将触发器完全压在身下，形成 100% 遮挡！**
  用户完全看不到自己点击的是什么，且再次点击 Trigger 的关闭操作被浮层本体阻截。
- **极致修复方案**：
  在空间双向均极度不足时，优先选择空间更大的一侧，并通过动态 `max-height` 压缩浮层高度，杜绝覆盖 Trigger 本身。
```typescript
// positionGeometry.ts 优化
let actualSide: 'bottom' | 'top' = side;
let finalMaxHeight = popupHeight;

if (side === 'bottom') {
  if (popupHeight > spaceBelow && spaceAbove > spaceBelow) {
    actualSide = 'top';
    finalMaxHeight = Math.min(popupHeight, spaceAbove);
    targetY = triggerRect.top - finalMaxHeight - sideOffset;
  } else {
    finalMaxHeight = Math.min(popupHeight, spaceBelow);
    targetY = triggerRect.bottom + sideOffset;
  }
}
```

---

### CR-09 【一般】海量多行数据下无动态虚拟测量致滚动抖动与首开卡顿（TBT 超标）
- **文件路径**：`03-多行Select文字重叠根治与Menu弹性自适应详案.md:L560-L584`, `L937-L945`
- **缺陷剖析**：
  将 `.menuItem` 解锁为 `height: auto` 虽消除了文字重叠，但当选项数量超过 100 项且每项包含 1~3 行动态说明时：
  1. `Menu.tsx` 中的 `target?.scrollIntoView?.({ block: 'nearest' });` 在高度未定且包含滚动条时，会引发父级视口产生连续 Layout Thrashing 与滚动条瞬跳；
  2. 方案未给出超过 80 项时的虚拟化兜底策略（虚拟列表若缺少动态高度测量缓存 `measureElement` 将直接白屏撕裂）。
- **极致修复方案**：
  在多行场景下，为 `scrollIntoView` 增加平滑边界判断，并在详案中明确长列表阈值（超过 50 项推荐虚拟滚动测量缓存）。

---

## 四、IME 输入法门闩与正则高亮漏洞

### CR-10 【严重】50ms 硬编码时间戳在掉帧场景下锁提前失效导致误选
- **文件路径**：`02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L385-L408`, `L1456-L1473`
- **缺陷剖析**：
  方案采用 `performance.now() - compositionEndTimeRef.current < 50` 作为输入法合成防误触锁。
  在低配机器或 CPU 重载（如并发编译、大模型流式解析、GC 停顿）时，主线程卡顿掉帧达到 60ms~200ms 极其常见。
  当 `compositionend` 触发后，主线程发生 70ms 阻塞，随后的 `keydown (Enter)` 执行时，时间差计算结果为 $70\text{ms} > 50\text{ms}$，门闩锁已被提前判定失效！随后该 Enter 事件穿透进入提交逻辑，误选中列表第一项并强行关闭弹窗。
- **极致修复方案**：
  摒弃脆弱的固定毫秒时间差对比，改用**事件循环宏任务队列锁（Macrotask / RAF Lock）+ Keyup 状态机**，确保合成结束引发的同批次键盘事件 100% 被清空。
```typescript
// ComboboxInput.tsx
const isComposingRef = useRef(false);
const justComposedRef = useRef(false);

const handleCompositionStart = useCallback(() => {
  isComposingRef.current = true;
  justComposedRef.current = false;
}, []);

const handleCompositionEnd = useCallback(() => {
  isComposingRef.current = false;
  justComposedRef.current = true;
  // 必须在下一个宏任务事件循环中释放锁，物理阻断当帧紧随的 keydown
  setTimeout(() => {
    justComposedRef.current = false;
  }, 100);
}, []);

const handleKeyDown = useCallback(
  (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (
      isComposingRef.current ||
      justComposedRef.current ||
      e.nativeEvent.isComposing ||
      e.keyCode === 229 ||
      e.key === 'Process'
    ) {
      return;
    }
    // 正常业务逻辑...
  },
  []
);
```

---

### CR-11 【致命】ComboboxInput 键盘事件完全缺失 Enter/ArrowUp 选项确认分支
- **文件路径**：`02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L1461-L1483`
- **缺陷剖析**：
  审查 `ComboboxInput.tsx` 的 `handleKeyDown` 实现源码：
  ```typescript
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    ctx.setOpen(true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    ctx.setOpen(false);
  }
  ```
  **`handleKeyDown` 中根本没有任何关于 `Enter`（确认选中当前高亮项）、`ArrowUp`（向上漫游）、`Home`、`End` 的逻辑！**
  用户在 Combobox 输入框中通过键盘操作时，按 `Enter` 无法选中任何选项，按 `ArrowUp` 无法向上选择。这使得整个 Combobox 沦为半瘫痪状态，WAI-ARIA Combobox 键盘交互完全失效。
- **极致修复方案**：
  在 `ComboboxInput` 中补齐完备的键盘漫游与选值确认逻辑。
```typescript
// ComboboxInput.tsx
if (e.key === 'ArrowDown') {
  e.preventDefault();
  if (!ctx.open) {
    ctx.setOpen(true);
  } else {
    ctx.setHighlightedIndex((prev) =>
      prev < ctx.filteredItems.length - 1 ? prev + 1 : 0
    );
  }
} else if (e.key === 'ArrowUp') {
  e.preventDefault();
  if (ctx.open) {
    ctx.setHighlightedIndex((prev) =>
      prev > 0 ? prev - 1 : ctx.filteredItems.length - 1
    );
  }
} else if (e.key === 'Enter') {
  if (ctx.open && ctx.highlightedIndex >= 0) {
    const targetItem = ctx.filteredItems[ctx.highlightedIndex];
    if (targetItem && !targetItem.disabled) {
      e.preventDefault();
      ctx.onValueChange(targetItem.id ?? targetItem.value);
      ctx.setOpen(false);
    }
  }
} else if (e.key === 'Escape') {
  e.preventDefault();
  ctx.setOpen(false);
}
```

---

### CR-12 【严重】highlightMatches 非字符串子节点导致 text.split 运行时白屏崩塌
- **文件路径**：`02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L347-L370`, `L1853-L1866`
- **缺陷剖析**：
  在 `ComboboxItem.tsx` 中：
  ```tsx
  const labelText = typeof children === 'string' ? children : itemValue;
  // ...
  <span className={styles.itemLabel}>{highlightMatches(labelText, ctx.query)}</span>
  ```
  如果调用方传递了 JSX 节点作为 children（例如 `<ComboboxItem value="1"><span>Item 1</span></ComboboxItem>`）且没有显式传递字符串型的 `itemValue`（或者 `itemValue` 是对象），`labelText` 将为非字符串。
  进入 `highlightMatches` 执行 `text.split(splitRegex)` 时，立即抛出致命错误：`TypeError: text.split is not a function`，引发 React 渲染树 Crash 白屏。
- **极致修复方案**：
  在 `highlightMatches` 入口增加防御性类型守卫，强制转换为纯文本处理。
```typescript
// comboboxHighlight.tsx
export function highlightMatches(text: unknown, query: string): React.ReactNode {
  if (text == null) return '';
  if (typeof text !== 'string') {
    if (React.isValidElement(text)) return text;
    text = String(text);
  }
  const str = text as string;
  const trimmed = query.trim();
  if (!trimmed || !str) return str;
  // ... 正则拆分
}
```

---

### CR-13 【微小】多连续空格与字符集 `-` 转义不全导致高亮失真
- **文件路径**：`02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L351`
- **缺陷剖析**：
  `escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` 中字符集未对 `-` 转义，且当搜索词包含多个空格（如 `"Claude   3.5"`）而正文为单空格时，由于未做空格折叠规范化，导致高亮匹配失败。
- **极致修复方案**：
  采用全字符转义：`replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')`。

---

## 五、无障碍（WAI-ARIA）断层与键盘交互缺失

### CR-14 【致命】SelectContent 夺取焦点后缺失 Listbox 键盘漫游事件处理器
- **文件路径**：`02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L935-L954`
- **缺陷剖析**：
  `SelectContent.tsx` 中在打开后将焦点强行转入浮层：`contentRef.current?.focus();`。
  但在其 `onKeyDown` 处理函数中：
  ```tsx
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        // ... 关闭
      } else if (e.key === 'Tab') {
        setOpen(false);
      }
    },
    [setOpen, triggerRef]
  );
  ```
  **该组件没有处理 ArrowDown, ArrowUp, Enter, Space！**
  一旦焦点进入 `contentRef`，用户在键盘上按上下方向键试图切换选项时，由于事件被浮层捕获且无任何处理分支，光标完全卡死，用户无法使用键盘选择任何选项，直接违反 WAI-ARIA 1.2 Authoring Practices 规范。
- **极致修复方案**：
  在 `SelectContent` 中接入标准 Listbox 键盘漫游状态机，联动 `highlightedIndex` 与 `onValueChange`。
```tsx
// SelectContent.tsx
const handleKeyDown = useCallback(
  (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ctx.itemMap.values()).filter((i) => !i.disabled);
    if (items.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      ctx.setHighlightedIndex((prev) => (prev < items.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      ctx.setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : items.length - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (ctx.highlightedIndex >= 0 && items[ctx.highlightedIndex]) {
        ctx.onValueChange(items[ctx.highlightedIndex].value);
        if (!ctx.multiple) {
          ctx.setOpen(false);
          (ctx.triggerRef.current as HTMLElement | null)?.focus();
        }
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      ctx.setOpen(false);
      (ctx.triggerRef.current as HTMLElement | null)?.focus();
    }
  },
  [ctx]
);
```

---

### CR-15 【严重】ComboboxInput 缺失 aria-activedescendant 导致读屏器断联
- **文件路径**：`02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L1526-L1533`
- **缺陷剖析**：
  在 `ComboboxInput.tsx` 中，`<input role="combobox" ... />` 元素缺少 `aria-activedescendant` 属性。在盲人及无障碍读屏软件中，焦点停留在 input 框，但虚拟焦点漫游时若无 `aria-activedescendant={currentOptionId}` 联动，读屏器无法播报当前选中的候选项。
- **极致修复方案**：
  绑定动态 `aria-activedescendant={ctx.highlightedIndex >= 0 ? `${ctx.selectId}-opt-${ctx.highlightedIndex}` : undefined}`。

---

### CR-16 【一般】ComboboxChips 键盘选定删除态无视觉反馈与索引空洞
- **文件路径**：`02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L1583-L1620`, `L1686-L1698`
- **缺陷剖析**：
  在 `ComboboxChips.tsx` 中维护了 `activeChipIndex`，但在子组件 `ComboboxChip.tsx` 中**根本没有接收 `isActive` 或 `selected` 类名**。
  当用户按 Backspace 高亮最后一个胶囊时，界面上没有任何描边或背景变化（视觉不可见），用户再次按 Backspace 删除项时会产生“按键无提示直接被删”的突兀感。
- **极致修复方案**：
  在 `ComboboxChip` 增加 `isActive?: boolean` 支持，高亮时施加 `var(--select-focus-ring)`。

---

## 六、工程红线违规、第三方依赖矛盾与 Token 违规

### CR-17 【致命】03 详案 Menu.tsx 违规引入 @radix-ui 违反“零外部依赖”铁律
- **文件路径**：`03-多行Select文字重叠根治与Menu弹性自适应详案.md:L17`, `L762`, `L1035-L1040`
- **缺陷剖析**：
  `03` 详案在第 17 行明文列出工程铁律：
  `“零外部 npm 组件库依赖：绝对禁止引入第三方组件库（如 @base-ui, @radix-ui, framer-motion 等），所有物理动效、手势、浮层几何与无障碍交互均采用纯原生 React 18+ 与 CSS Modules 100% 纯净自研”`
  但在第 5.3 节 `Menu.tsx` 源码规格中（第 762 行与 1035 行），**赫然导入并直接使用了 `import * as Popover from '@radix-ui/react-popover'`！**
  这构成了方案自身的严重前后逻辑矛盾与工程红线违规。
- **极致修复方案**：
  彻底清退 `Menu.tsx` 中的 `@radix-ui/react-popover`，收敛统一接入项目自研的 `useFloatingPosition` 与 `LayerStack` 浮层体系。

---

### CR-18 【一般】硬编码非 Token 色值与 !important 滥用违反设计规范
- **文件路径**：`02-Select与Combobox大圆角同心架构与解耦拆分详案.md:L2430`, `03-多行Select文字重叠根治与Menu弹性自适应详案.md:L1311`
- **缺陷剖析**：
  1. `02` 详案 `SelectTrigger.module.css:2430` 使用了 `border-color: ... !important;`，违反纯净 CSS 权重管理规范；
  2. `03` 详案 `PermissionModeMenu.module.css:1311` 出现了硬编码色值 `color: #c25e2e;`，未接入 `tokens.css` 设计令牌。
- **极致修复方案**：
  移除 `!important`，将硬编码色值重构为 `var(--color-warning-text)` 或 `var(--color-accent-terracotta)`。

---

## 结论与行动项

| 缺陷总数 | 致命 (Fatal) | 严重 (Critical) | 一般 (Major) | 微小 (Minor) |
| :---: | :---: | :---: | :---: | :---: |
| **18 项** | **4 项** | **8 项** | **5 项** | **1 项** |

详案文档必须立即按上述【极致修复方案】全面修正 **CR-01（ItemMap 擦除导致裸 ID）**、**CR-11（ComboboxInput 键盘回车失效）**、**CR-14（SelectContent 键盘方向键无响应）** 与 **CR-17（Radix 依赖冲突）** 四大致命级设计缺陷，严禁带病投入编码实施！
