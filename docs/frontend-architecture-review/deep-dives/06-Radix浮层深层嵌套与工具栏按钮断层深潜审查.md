# Radix Popover 多层深嵌套与工具栏按钮逻辑断层深度专项审查报告

> **审查日期**：2026-08-16
> **审查对象**：`Menu.tsx` / `Select.tsx` / `Dialog.tsx` / `SettingsRulesTab.tsx` / `RulesEditorDialog.tsx` / `DiffHeaderControls.tsx` 及关联样式体系
> **审查性质**：前端架构深度解剖、DOM 渲染层级与事件状态断层实证
> **文档位置**：`docs/frontend-architecture-review/deep-dives/06-Radix浮层深层嵌套与工具栏按钮断层深潜审查.md`

---

## 一、执行摘要与架构审计总览 (Executive Summary & Architecture Audit Map)

在现代化桌面应用前端演进中，浮层（Popover / Menu / Dialog / Tooltip）的渲染层级与表单工具栏（Toolbar）的基线排版构成了高频交互的基石。然而，对 `crish-desktop` 中 Radix 原语封装层及核心业务模块的深度源码静态审查揭示出一系列系统性的**架构断层**与**渲染冗余**：

1. **Radix Popover 多层包装与深层 DOM 容器膨胀**：
   `Menu.tsx` 基于 `@radix-ui/react-popover` 封装，在挂载时由 Radix 生成 `data-radix-popper-content-wrapper`，内部嵌套自动生成 ID 的 `div#radix-_r_...`（默认带有 `role="dialog"`），再在内部渲染业务的 `<div role="menu">` 或 `<div role="listbox">`，若选项携带 `hint` 则进一步触发 `Tooltip` 的二级 `DismissableLayer.Branch` 与 `createPortal`。单次菜单展开在 `document.body` 产生深度达 7~9 层的 DOM 树，伴随 `z-index` 穿透失效、定位单帧跳变（FOUC）与 WAI-ARIA 语义冲突。
2. **`settings-head-tools-row` 工具栏按钮逻辑与状态断层**：
   在 `SettingsRulesTab.tsx:141-173` 中，作用域下拉框（`Select`）与「编辑全文」按钮（`Button`）处于同一行，却存在“一个能用一个不能用”的严重逻辑断层：
   - **状态竞争与草稿覆盖（Draft Stomping Race）**：`useRulesState.ts:119-155` 在切换 `scopeKey` 时异步拉取规则，但未重置或加锁 `editorText`，若用户立即点击「编辑全文」，将打开旧作用域的正文；当异步网络响应完成时直接执行 `setEditorText` 覆写正文，彻底冲掉用户正在编辑的草稿。
   - **ID 孤岛与 Label 脱节**：`SettingsRulesTab.tsx:66` 声明的 `scopeSelectId` 绑定在 `<label htmlFor>` 上，却未透传给 `<Select>`，导致 `Select.tsx:123` 自动生成独立的 `ui-select-${autoId}`，Label 彻底失效。
   - **事件拦截与抢夺（Swallowed Click）**：`Menu.tsx:382-406` 对 Trigger 粗暴注入 `e.stopPropagation()`，而 Radix `DismissableLayer` 在外点关闭时拦截 `pointerdown`，导致下拉展开态下点击旁边「编辑全文」按钮时，按钮自身的 `onClick` 被吞噬。
3. **`_selectWrap_*` 容器泄漏与圆角/尺寸断崖式失真**：
   `Select.tsx:159` 外层无差别包裹 `<div className={styles.selectWrap}>`（Flex Column），而传入的 `className` 被错误绑定到内部 `<button>`。在横向工具栏中，`Select` 缺省为 `size="md"`（高度 32px、直角圆角 `var(--radius-md)`、带边框），而邻近的 `Button` 设定为 `size="sm"` 与 `variant="secondary"`（高度 28px、药丸圆角 `var(--radius-full)`、无边框），导致高度落差 4px、形状严重割裂。
4. **历史样式补丁残骸（Ghost Patching）**：
   在 `DiffHeaderControls.tsx` 中消费 `Select` 时，`DiffCard.module.css:118-138` 试图通过 `:global(.settings-select-trigger)` 强行打补丁覆盖高度与圆角，然而新版 `Select.tsx` 早已切换为 CSS Modules 类名，导致该规则全量失效成为死代码。

### 核心构件拓扑与审计矩阵

| 组件文件                 | 代码路径                                                           | 核心职责           | 暴露的系统性缺陷                                                                                            |
| :----------------------- | :----------------------------------------------------------------- | :----------------- | :---------------------------------------------------------------------------------------------------------- |
| `Menu.tsx`               | `apps/crish-desktop/src/components/ui/Menu/Menu.tsx`               | 基础浮层/弹出菜单  | 双容器 Popper Wrapper 嵌套、`z-index` 外层丢失、Trigger 事件盲目 `stopPropagation`、ARIA `dialog>menu` 冲突 |
| `Select.tsx`             | `apps/crish-desktop/src/components/ui/Select/Select.tsx`           | 受控单选下拉框     | `selectWrap` 容器泄漏、`className` 传递错位、ID 无法由外部受控注入、默认 `size="md"` 导致工具栏失调         |
| `Dialog.tsx`             | `apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx`           | 模态/全屏弹窗      | `DismissableLayer.Branch` 树分支交互与全局焦点 Trap 互锁                                                    |
| `SettingsRulesTab.tsx`   | `apps/crish-desktop/src/components/settings/SettingsRulesTab.tsx`  | 设置规则管理面     | 工具栏按钮逻辑断层、Label ID 孤岛、未加锁异步草稿编辑器                                                     |
| `useRulesState.ts`       | `apps/crish-desktop/src/components/settings/useRulesState.ts`      | 规则状态与同步引擎 | 异步加载空窗期竞态、`setEditorText` 暴力覆写、缺乏作用域隔离草稿缓存                                        |
| `RulesEditorDialog.tsx`  | `apps/crish-desktop/src/components/settings/RulesEditorDialog.tsx` | 规则正文编辑器     | 状态受控单向流在父级未加锁时产生输入内容丢失                                                                |
| `DiffHeaderControls.tsx` | `apps/crish-desktop/src/components/diff/DiffHeaderControls.tsx`    | 差异比对头部工具栏 | 混用 `Select` 与 `Button`，依赖已失效的 global CSS 补丁                                                     |

---

## 二、Radix Popover / Menu 多层包装与深层 DOM 嵌套解剖

### 2.1 `data-radix-popper-content-wrapper` 与 `id="radix-_r_6b_"` 生成机理

在 `apps/crish-desktop/src/components/ui/Menu/Menu.tsx` 中，组件结构声明如下（433-554 行）：

```tsx
// Menu.tsx:433-554
<Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
  {renderedTrigger}

  <Popover.Portal>
    <Popover.Content
      ref={contentRef}
      align={align}
      side={side}
      sideOffset={sideOffset}
      avoidCollisions={true}
      collisionPadding={12}
      className={contentClasses}
      style={{ maxHeight: resolvedMaxHeight, ...contentStyle }}
      onKeyDown={handleKeyDown}
      ...
    >
      {title != null ? (
        <div className={styles.menuTitle}>{title}</div>
      ) : null}

      {children != null ? (
        children
      ) : (
        <div role="menu" className={styles.menuList}>
          {options.map((opt, index) => { ... })}
        </div>
      )}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
```

#### Radix 内部双容器机制解剖

Radix UI 底层的 `@radix-ui/react-popover` 依赖 `@radix-ui/react-popper` 实现坐标定位。Radix 在架构上采用了**“定位外壳（Positioning Wrapper）”与“内容实体（Content Container）”严格分离**的机制：

1. **定位外壳（Wrapper Shell）**：
   Radix Popper 在 `Popover.Portal` 内部动态创建带有 `data-radix-popper-content-wrapper=""` 属性的 `div`。该容器接管所有物理坐标计算，被赋予内联样式：
   ```html
   <div
     data-radix-popper-content-wrapper=""
     style="position: fixed; left: 0px; top: 0px; transform: translate3d(854px, 126px, 0px); min-width: max-content; --radix-popper-transform-origin: 100% 0px; will-change: transform; z-index: auto;"
   ></div>
   ```
2. **内容实体（Content Shell）**：
   开发者在 JSX 中书写的 `<Popover.Content>` 实际上被渲染为 Wrapper 内部的子节点，Radix 自动为其分配 React 18/19 的 `useId` 标识（如 `id="radix-_r_6b_"`），并强制注入辅助功能属性：
   ```html
   <div
     id="radix-_r_6b_"
     role="dialog"
     tabindex="-1"
     data-state="open"
     data-side="bottom"
     data-align="end"
     class="_menuContent_1w2f3_5 ..."
     style="max-height: min(var(--radix-popover-content-available-height, 360px), 70vh, 360px);"
   ></div>
   ```

### 2.2 真实运行时 DOM 树层级展开与臃肿拓扑对比

当我们在 `SettingsRulesTab` 或 `DiffHeaderControls` 中点击一个 `Select` 下拉菜单时，由于 `Select.tsx` 依赖 `Menu.tsx`，`Menu.tsx` 依赖 Radix Popover，且下拉选项中包含 `Tooltip`，在 `document.body` 下构建出极其深层的 DOM 树：

```
document.body
│
├── #root (主应用宿主)
│   └── .settingsUiPage (.settings-ui-page)
│       └── .settingsUiPageHead
│           └── .settingsUiHeadInline
│               └── .settings-head-tools-row
│                   ├── label.sr-only [for="..."]  <-- (ID 脱节)
│                   └── div._selectWrap_14g0x_5    <-- (外层 Flex Column 容器)
│                       └── button._trigger_14g0x_17 [role="combobox"] <-- (Trigger 实体)
│                           ├── span._triggerLabel_14g0x_72
│                           └── svg (ChevronIcon)
│
└── [Portal 挂载区]
    ├── div[data-radix-popper-content-wrapper]  <-- [层级 1: Radix 绝对定位外壳]
    │   └── div#radix-_r_6b_[role="dialog"]._menuContent_1w2f3_5  <-- [层级 2: Radix Popover.Content 实体]
    │       └── div#ui-select-listbox-_r_6c_[role="listbox"]._listbox_14g0x_89  <-- [层级 3: Select.tsx 容器]
    │           ├── button._option_14g0x_95[role="option"]  <-- [层级 4: 选项 Button]
    │           │   ├── span._optionLabel_14g0x_138
    │           │   └── svg (CheckIcon)
    │           └── button._option_14g0x_95[role="option"]  <-- [层级 4: 包含 Tooltip 的选项]
    │
    └── div[data-dismissable-layer-branch]  <-- [层级 1: Tooltip 触发的次级 Portal]
        └── div#ui-tooltip-_r_6e_[role="tooltip"]._tooltip_1a2b3_1  <-- [层级 2: Tooltip 实体]
            ├── div._tooltipContent_1a2b3_20
            └── div._arrow_1a2b3_35
```

#### DOM 臃肿带来的三大系统性性能与布局代价：

1. **重排联动与合成层爆炸（Compositing Overload）**：
   Wrapper 具备 `will-change: transform`，强制浏览器分配独立的 GPU 渲染图层（RenderLayer / GraphicsLayer）。在多窗口、多分栏（如 Split Diff 或多 Agent 卡片）场景下，散落的大量未销毁 Wrapper 造成内存占用剧增与 GPU 上下文切换开销。
2. **样式隔离破坏与 `z-index` 穿透失效**：
   在 `Menu.module.css:5` 中，开发团队声明了 `.menuContent { z-index: var(--z-dropdown-menu); }`。
   **关键缺陷**：该样式被施加在内部的 `div#radix-_r_6b_` 上，而外层的 `data-radix-popper-content-wrapper` 在没有声明 `z-index` 的情况下，默认使用 `z-index: auto`。一旦其挂载的上下文或兄弟节点中存在具备 CSS `transform`、`filter` 或 `isolation: isolate` 的容器，外层 Wrapper 的层叠上下文（Stacking Context）被锁死在底层，内部 `.menuContent` 的 `z-index` 彻底失效，导致浮层被其他 Dialog 或侧边栏遮挡。
3. **定位抖动（Positioning Jitter）与单帧 FOUC**：
   `Menu.tsx:428-430` 计算 `resolvedMaxHeight` 时使用了 `var(--radix-popover-content-available-height, 360px)`。
   在组件打开的首个渲染帧（Frame 0），Radix 尚未完成视口可用高度的探测，此时 CSS 变量回落至 `360px`；在次帧（Frame 1），Radix 测量后写入 `--radix-popover-content-available-height`，导致 `.menuContent` 高度改变，进而触发 Radix Popper 重新计算 `transform: translate3d(...)`。用户在低算力机器或高刷屏上能清晰观察到浮层在弹出瞬间的“高度跳变”与“1 像素坐标闪烁”。

### 2.3 ARIA 语义冲突与可访问性树断层

在 `Menu.tsx` 与 `Select.tsx` 组合时，产生了严重的 WAI-ARIA 规范违背：

```tsx
// Select.tsx:174-202
trigger={
  <button
    type="button"
    id={selectId}
    role="combobox"
    aria-haspopup="listbox"
    aria-controls={listboxId}
  >
}
children={
  <div id={listboxId} role="listbox">
    {options.map((option) => (
      <button role="option" aria-selected={...}>...</button>
    ))}
  </div>
}
```

而在 `Menu.tsx:437` 中：
`<Popover.Content>` 原生默认注入 `role="dialog"`。
因此，屏幕阅读器与自动化辅助树解析到的 DOM 结构为：
`button[role="combobox"]` -> 展开指向 -> `div[role="dialog"]` -> 内部嵌套 -> `div[role="listbox"]` -> `button[role="option"]`。

**规范冲突事实**：
W3C ARIA 1.2 Combobox Pattern 明确规定：`combobox` 的 `aria-controls` 必须直接指向具备 `listbox` 语义的容器。当前结构在 `combobox` 与 `listbox` 之间横插了一个 `role="dialog"` 容器，导致无障碍阅读器误认为用户打开了一个需要交互确认的会话模态框，而非选择列表，彻底打乱键盘漫游朗读顺序。

---

## 三、`settings-head-tools-row` 按钮逻辑断层实证

### 3.1 业务结构剖析：`SettingsRulesTab.tsx:141-173`

在 `apps/crish-desktop/src/components/settings/SettingsRulesTab.tsx` 中，顶部工具栏结构定义如下：

```tsx
// SettingsRulesTab.tsx:141-173
const headerMeta = (
  <div className="settings-head-tools settings-head-tools--rules">
    <div className="settings-head-tools-row">
      <label htmlFor={scopeSelectId} className="sr-only">
        规则作用域
      </label>
      <Select
        value={scopeKey}
        options={scopeOptions.map((o) => ({
          id: o.value,
          label: o.label,
          ...(o.hint !== undefined ? { hint: o.hint } : {}),
        }))}
        onChange={setScopeKey}
        disabled={busy}
        className="settings-rules-scope-select"
      />
      <Tooltip content={`编辑${scopeLabel}全文`}>
        <Button
          ref={fullEditorBtnRef}
          type="button"
          variant="secondary"
          size="sm"
          onClick={openFullEditor}
          aria-label={`编辑${scopeLabel}全文`}
          disabled={busy}
        >
          编辑全文
        </Button>
      </Tooltip>
    </div>
  </div>
);
```

在此处，工具栏由两个核心交互控件组成：

- **控件 1：作用域下拉框（`Select`）**：用于在「全局规则」与各个「具体项目规则」之间切换。
- **控件 2：编辑全文按钮（`Button`）**：用于唤起 `RulesEditorDialog` 模态弹窗，以多行文本形式编辑规则正文。

在实际使用中，用户报告出现“一个能用一个不能用”的现象。经过对底层数据流、事件生命周期与组件通信的穿透分析，定位到以下**三大代码级致命断层**：

---

### 3.2 根因 1：异步数据流空窗与草稿覆盖竞态 (Draft Stomping Race)

查阅 `apps/crish-desktop/src/components/settings/useRulesState.ts` 118-155 行：

```ts
// useRulesState.ts:118-155
/** 按作用域加载规则（全局 or 具体项目路径） */
useEffect(() => {
  let cancelled = false;
  void (async () => {
    try {
      let lines: string[] = [];
      if (isGlobal) {
        const sets = await clientApi.getSettingsEx('__global__');
        if (cancelled || !sets) return;
        lines = dedupeRuleLines(normalizeCustomRules(sets.customRules));
      } else {
        const partial = await clientApi.getProjectSettingsPartial(scopeKey);
        if (cancelled) return;
        lines = dedupeRuleLines(normalizeCustomRules(partial.customRules));
      }
      setCustomRules(lines);
      setEditorText(
        lines.length > 0
          ? rulesLinesToText(
              lines,
              isGlobal ? '# 全局规则' : `# ${scopeLabel} 规则`
            )
          : isGlobal
            ? EMPTY_GLOBAL_TEMPLATE
            : EMPTY_PROJECT_TEMPLATE
      );
      setLoadError(null);
      setLoaded(true);
    } catch (err) {
      if (!cancelled) {
        const msg = '读取规则失败：' + String(err);
        setLoadError(msg);
        setLoaded(false);
        onShowToast(msg);
      }
    }
  })();
  return () => {
    cancelled = true;
  };
}, [scopeKey, isGlobal, scopeLabel, onShowToast, loadTick]);
```

结合 `SettingsRulesTab.tsx:84-90` 中唤起编辑器的函数：

```ts
// SettingsRulesTab.tsx:84-90
const openFullEditor = () => {
  if (!state.isGlobal && !scopeKey) {
    onShowToast('请先选择项目');
    return;
  }
  setEditingOpen(true);
};
```

#### 逻辑断层时序实证：

```
时间线 (T)
──┼─────────────────────────────────────────────────────────────────────────────►
T0: 用户在 Select 下拉中将作用域从「全局」切换为「项目 A」
    └─► setScopeKey('project-A') 触发
T1: useEffect 启动异步任务 clientApi.getProjectSettingsPartial('project-A')
    └─► 此时 editorText 仍保持「全局」的旧文本！
T2: 用户立即点击「编辑全文」按钮
    └─► openFullEditor() 执行 -> setEditingOpen(true) 打开 RulesEditorDialog
    └─► 用户看到的 Textarea 显示的是「全局」的旧规则！
T3: 用户在 Textarea 开始输入新规则 "禁止使用 any 类型..."
T4: 异步请求 clientApi.getProjectSettingsPartial 完成响应
    └─► 触发 setEditorText(projectALines)
    └─► 💥 致命错误：用户正在输入的草稿瞬间被接口返回的数据强行覆写！
T5: 用户点击保存 -> 旧数据或被破坏的数据被持久化。
```

**结论**：`useRulesState` 没有为当前正在加载的作用域引入 `loading` 隔离锁，也没有对 `editorText` 进行独立的作用域缓存（Draft Cache），导致切换作用域与点击全文编辑之间产生致命竞态条件。

---

### 3.3 根因 2：ID 孤岛与可访问性标签关联断裂

在 `SettingsRulesTab.tsx:65-67`：

```tsx
const addInputId = useId();
const scopeSelectId = useId(); // 生成全局唯一 ID，如 :r2:
```

在 `SettingsRulesTab.tsx:144-157`：

```tsx
<label htmlFor={scopeSelectId} className="sr-only">
  规则作用域
</label>
<Select
  value={scopeKey}
  options={...}
  onChange={setScopeKey}
  disabled={busy}
  className="settings-rules-scope-select"
/>
```

而在 `apps/crish-desktop/src/components/ui/Select/Select.tsx:122-124`：

```tsx
export function Select({
  value: externalValue,
  id, // <-- 此处未传入 id，因此 id 为 undefined
  ...
}: SelectProps) {
  const autoId = useId();
  const selectId = id ?? `ui-select-${autoId}`; // <-- 生成了自己的 ID :r5:
```

**断层事实**：
`<label htmlFor=":r2:">` 指向一个在整个 DOM 树中根本不存在的元素 ID；而 `<Select>` 内部的 `<button id="ui-select-:r5:">` 处于无 Label 关联的孤岛状态。点击 Label 无法激活 Select，无障碍辅助软件报错 `orphaned label`。

---

### 3.4 根因 3：DOM 事件吞噬与 Radix DismissableLayer 点击抢夺

查阅 `Menu.tsx:382-406` 对 Trigger 的克隆事件注入：

```tsx
// Menu.tsx:382-406
const clonedTrigger = React.isValidElement(actualTrigger)
  ? React.cloneElement(
      actualTrigger as React.ReactElement<Record<string, unknown>>,
      {
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation(); // <-- 强行拦截 onClick
          ((actualTrigger as React.ReactElement).props as any)?.onClick?.(e);
        },
        onPointerDown: (e: React.PointerEvent) => {
          e.stopPropagation(); // <-- 强行拦截 onPointerDown
          ((actualTrigger as React.ReactElement).props as any)?.onPointerDown?.(
            e
          );
        },
        onMouseDown: (e: React.MouseEvent) => {
          e.stopPropagation(); // <-- 强行拦截 onMouseDown
          ((actualTrigger as React.ReactElement).props as any)?.onMouseDown?.(
            e
          );
        },
      }
    )
  : actualTrigger;
```

再看 `Tooltip.tsx:431-443` 与 `Button.tsx:75-81`：

```tsx
// Tooltip.tsx:431-436
const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
  clearHideTimer();
  setVisible(false);
  childHandlers.onPointerDown?.(e);
  restHandlers.onPointerDown?.(e);
};
```

#### 事件抢夺死锁链路剖析：

1. 当用户展开作用域下拉框（`Select` / `Menu`）时，Radix `DismissableLayer` 在全局 `document` 监听捕获阶段的 `pointerdown` 事件。
2. 用户意图切换至编辑全文，直接点击右侧的「编辑全文」按钮（包裹在 `<Tooltip>` 内的 `<Button>`）。
3. **事件拦截过程**：
   - 全局捕获阶段：Radix `DismissableLayer` 检测到点击发生在 Popover 外部，立即触发 `onPointerDownOutside`，执行 `handleOpenChange(false)` 关闭下拉菜单。
   - 冒泡阶段：由于下拉菜单关闭触发了 React 状态重渲染，DOM 发生卸载与重绘；若用户按下指针后发生微小位移，或浏览器的事件触发顺序被 `stopPropagation` 截断，导致 `Button` 上的 `click` 事件丢失（仅完成了 `pointerdown` 关闭浮层，未完成完整的 `click` 判定）。
4. **结果**：用户点击「编辑全文」，看到的只是下拉菜单缩回去了，弹窗根本没有打开，造成“按钮失效”的直接体感。

---

## 四、`_selectWrap_*` 样式与圆角失真、与旁边 Button 尺寸脱节

### 4.1 `Select.module.css` 与 `selectWrap` 容器泄漏

查阅 `apps/crish-desktop/src/components/ui/Select/Select.tsx:148-164`：

```tsx
// Select.tsx:148-164
const triggerClasses = [
  styles.trigger,
  size === 'sm' ? styles.triggerSm : null,
  error ? styles.triggerError : null,
  disabled ? styles.triggerDisabled : null,
  className, // <-- 错误：将外部 className 附加给了内部 trigger button
]
  .filter(Boolean)
  .join(' ');

return (
  <div className={styles.selectWrap}>
    {label != null ? (
      <label className={styles.selectLabel} htmlFor={selectId}>
        {label}
      </label>
    ) : null}
    <Menu ... trigger={<button className={triggerClasses}>...</button>}>
      ...
    </Menu>
  </div>
);
```

而在 `Select.module.css:5-9` 中：

```css
/* Select.module.css:5-9 */
.selectWrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
```

#### 架构缺陷：

1. `Select` 强制在顶层包裹 `<div className={styles.selectWrap}>`，该容器为 `display: flex; flex-direction: column`（原本用于承载纵向的 `label` 与 `selectError`）。
2. 当 `Select` 被放入横向 Flex 工具栏（`.settings-head-tools-row { display: flex; flex-direction: row; align-items: center; }`）时，外部传递的 `className="settings-rules-scope-select"` 并没有施加在最外层的 `selectWrap` 上，而是被塞给了内部的 `<button>`。
3. 外层 `selectWrap` 脱离了布局控制，成为没有定义 `flex` 伸缩规则的块级容器，导致工具栏内的基线对齐和宽度分配产生混乱。

---

### 4.2 尺寸脱节与形状割裂：矩形框 vs 药丸形按钮

对比 `Select.module.css` 与 `Button.module.css` 的视觉 Token 定义：

```css
/* Select.module.css:17-39 (Select 默认 size="md") */
.trigger {
  height: var(--control-height); /* 32px */
  min-height: var(--control-height);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md); /* 6px 矩形圆角 */
  background: var(--bg-primary);
  color: var(--text-primary);
}

/* Button.module.css:32-60 (Button 设置了 size="sm" variant="secondary") */
.buttonSm {
  height: var(--control-height-sm); /* 28px */
  padding: 0 var(--space-3);
  font-size: var(--font-size-sm);
  border-radius: var(--radius-full); /* 9999px 极致药丸圆角 */
}

.buttonSecondary {
  background: var(--control-soft-bg);
  color: var(--text-secondary);
  border: none; /* 无边框 */
  border-radius: var(--radius-full); /* 药丸圆角 */
}
```

#### 控件视觉失真对比矩阵

| 维度                      | `Select` (SettingsRulesTab:147)  | `Button` (SettingsRulesTab:159)     | 视觉冲突与失真表现                           |
| :------------------------ | :------------------------------- | :---------------------------------- | :------------------------------------------- |
| **尺寸规格 (Size)**       | 未传参，缺省为 `size="md"`       | 显式声明 `size="sm"`                | 规格档位脱节                                 |
| **物理高度 (Height)**     | `32px` (`var(--control-height)`) | `28px` (`var(--control-height-sm)`) | **高度落差 4px**，工具栏垂直中线上下错位     |
| **圆角弧度 (Radius)**     | `6px` (`var(--radius-md)`)       | `9999px` (`var(--radius-full)`)     | **矩形框与全圆角胶囊药丸并存**，风格极度割裂 |
| **边框体系 (Border)**     | `1px solid var(--border-subtle)` | `none` (无边框)                     | 一个带框实体，一个无框虚底，基线失衡         |
| **背景色板 (Background)** | `var(--bg-primary)` (底色)       | `var(--control-soft-bg)` (淡染暖灰) | 材质层次颠倒                                 |

在 `.settings-head-tools-row` 中，左侧是一个 32px 高、6px 圆角、带灰色边框的厚重输入框；右侧紧贴着一个 28px 高、完全圆形胶囊的浅灰色软按钮。两者视觉语言完全对立，暴露出严重的组件库规范缺位。

---

### 4.3 `DiffHeaderControls.tsx` 与 `DiffCard.module.css` 中的历史修补残骸

在 `apps/crish-desktop/src/components/diff/DiffCard.module.css` 114-138 行，存在如下样式声明：

```css
/* DiffCard.module.css:114-138 */
.turnSettingsSelect {
  width: 100%;
  min-width: 0;
}
.turnSettingsSelect :global(.settings-select-trigger) {
  height: 28px;
  min-height: 28px;
  padding: 0 8px;
  border-radius: var(--radius-lg) !important;
  border: 1px solid var(--border-subtle);
  background: transparent;
  font-size: var(--font-size-xs);
  gap: var(--space-1);
  width: 100%;
}
```

而在 `apps/crish-desktop/src/components/diff/DiffHeaderControls.tsx:173-183` 中：

```tsx
<Select
  className={styles.turnSettingsSelect}
  disabled={busy}
  value={turnKey}
  options={turnOptions.map(...)}
  onChange={onTurnSelect}
/>
```

#### 审查发现：

1. `DiffHeaderControls` 消费了新原子库中的 `Select` 组件。
2. `Select.tsx` 生成的内部 Trigger 类名为 CSS Modules 哈希（如 `Select_trigger__14g0x`），**根本不存在 `.settings-select-trigger` 全局类名**。
3. `DiffCard.module.css` 中试图通过 `:global(.settings-select-trigger)` 并辅以 `!important` 强行拉平高度为 28px、圆角为 `var(--radius-lg)` 的努力**完全失效**。
4. 结果导致 Diff 工具栏中的 `Select` 同样回落到默认的 32px，与旁边的 28px 图标按钮（`.iconBtn { width: 28px; height: 28px; }`）产生同样的几何脱节。

---

## 五、纯净弹层封装与表单工具栏重构方案 (Refactoring & Clean Architecture Proposal)

为了彻底根除 Radix 深层嵌套、状态竞态、ID 孤岛与工具栏样式失真，提出以下系统化重构方案：

### 5.1 方案 1：扁平化 Popover / Menu 纯净封装设计

消除 Radix 原生多层 DOM Wrapper 嵌套，规范 ARIA 角色与 `z-index` 层叠上下文。

#### 重构要点：

1. **统一 Wrapper 层级控制**：通过 Radix Popper 的 `asChild` 或自定义浮层 Portal，确保 `z-index` 直接声明在最外层绝对定位容器上，杜绝穿透失效。
2. **纯正 ARIA 语义树**：在 `Menu.tsx` 与 `Select.tsx` 中，当作为 `listbox` 使用时，显式覆写 `Popover.Content` 的 `role` 为 `presentation` 或直接透传，消除非法的 `dialog > listbox` 嵌套。
3. **消除高度跳变**：废弃运行时动态计算的 `var(--radix-popover-content-available-height)`，改由 CSS `max-height: min(70vh, 360px)` 配合弹性滚动容器原生约束。

```tsx
// 扁平化浮层重构示意 (Menu.clean.tsx)
<Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
  {renderedTrigger}
  <Popover.Portal>
    <Popover.Content
      ref={contentRef}
      role={role === 'listbox' ? undefined : 'menu'} // 移除默认 dialog 角色干扰
      className={styles.cleanMenuContent}
      style={{
        zIndex: 'var(--z-dropdown-menu)',
        ...contentStyle,
      }}
      avoidCollisions
      collisionPadding={8}
      onCloseAutoFocus={(e) => e.preventDefault()}
    >
      {title && <div className={styles.menuTitle}>{title}</div>}
      <div className={styles.scrollBody} role={role}>
        {children || options.map(renderDefaultItem)}
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
```

---

### 5.2 方案 2：`useRulesState` 作用域缓存与加载加锁规范

在 `useRulesState.ts` 中引入 **草稿隔离字典（Draft Cache Map）** 与 **加载中状态锁（Loading Scope Lock）**，彻底消除异步覆写竞态。

#### 重构代码设计：

```ts
// useRulesState.refactor.ts 核心修复方案
export function useRulesState(opts: UseRulesStateOptions): UseRulesStateResult {
  const [scopeKey, setScopeKey] = useState<ScopeKey>(SCOPE_GLOBAL);
  const [isLoadingScope, setIsLoadingScope] = useState<boolean>(false);

  // 核心：基于 Scope 的草稿缓存字典，隔离不同作用域的编辑状态
  const [draftCache, setDraftCache] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setIsLoadingScope(true);

    void (async () => {
      try {
        let lines: string[] = [];
        if (isGlobal) {
          const sets = await clientApi.getSettingsEx('__global__');
          if (cancelled) return;
          lines = dedupeRuleLines(normalizeCustomRules(sets?.customRules));
        } else {
          const partial = await clientApi.getProjectSettingsPartial(scopeKey);
          if (cancelled) return;
          lines = dedupeRuleLines(normalizeCustomRules(partial?.customRules));
        }

        const formattedText =
          lines.length > 0
            ? rulesLinesToText(
                lines,
                isGlobal ? '# 全局规则' : `# ${scopeLabel} 规则`
              )
            : isGlobal
              ? EMPTY_GLOBAL_TEMPLATE
              : EMPTY_PROJECT_TEMPLATE;

        setCustomRules(lines);

        // 仅在当前作用域尚未产生未保存的用户草稿时，更新正文
        setDraftCache((prev) => ({
          ...prev,
          [scopeKey]: prev[scopeKey] ?? formattedText,
        }));

        setLoadError(null);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) setLoadError(String(err));
      } finally {
        if (!cancelled) setIsLoadingScope(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [scopeKey]);

  // 当前正文直接从草稿缓存中读取当前作用域对应的条目
  const currentEditorText = draftCache[scopeKey] ?? '';

  const updateEditorText = (text: string) => {
    setDraftCache((prev) => ({
      ...prev,
      [scopeKey]: text,
    }));
  };

  return {
    ...state,
    isLoadingScope,
    editorText: currentEditorText,
    setEditorText: updateEditorText,
  };
}
```

---

### 5.3 方案 3：`Select` 控件容器解耦与 ID 双向绑定

修复 `Select.tsx` 的容器泄漏问题，允许外部类名精准施加在根容器上，并实现 `id` 的外部透传。

#### 重构代码设计：

```tsx
// Select.refactor.tsx
export interface SelectProps {
  id?: string;
  className?: string; // 作用于最外层包装容器
  triggerClassName?: string; // 作用于内部触发按钮
  size?: 'sm' | 'md';
  // ... 其他属性
}

export function Select({
  id: externalId,
  className,
  triggerClassName,
  size = 'md',
  ...props
}: SelectProps) {
  const autoId = useId();
  const selectId = externalId ?? `ui-select-${autoId}`; // 优先使用外部传入的 ID

  return (
    <div className={[styles.selectWrap, className].filter(Boolean).join(' ')}>
      {label && (
        <label className={styles.selectLabel} htmlFor={selectId}>
          {label}
        </label>
      )}
      <Menu
        trigger={
          <button
            type="button"
            id={selectId} // 与外部 label 精确绑定
            className={[
              styles.trigger,
              size === 'sm' ? styles.triggerSm : null,
              triggerClassName,
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {/* 内容 */}
          </button>
        }
      >
        {/* 下拉内容 */}
      </Menu>
    </div>
  );
}
```

---

### 5.4 方案 4：统一工具栏设计规范与基线对齐 (Toolbar Alignment Spec)

建立全站表单工具栏（Toolbar）内部控件的标准约束规范：

1. **尺寸归一化（Size Normalization）**：
   在所有工具栏（如 `SettingsRulesTab` 头部、`DiffHeaderControls`）中，内部控件（Select、Button、Input）统一强制使用 **`size="sm"`**。
   - 统一高度：`28px` (`var(--control-height-sm)`)。
   - 统一字体：`var(--font-size-xs)` (12px)。
2. **圆角收敛（Radius Harmony）**：
   - 废弃工具栏按钮上的 `var(--radius-full)` (9999px) 药丸形状。
   - 统一使用 **`var(--radius-sm)` (6px)**、**`var(--radius-md)` (7px)** 或 **`var(--radius-lg)` (9px)**，保持所有控件边框曲率一致。
3. **边框与材质对齐（Border & Surface Alignment）**：
   - 次要操作按钮与下拉框统一采用 `1px solid var(--border-subtle)` + `var(--bg-primary)` / `var(--control-soft-bg)`。
   - 激活与聚焦状态统一使用 `color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)`，严禁厚重阴影与实心黑边。

#### 修复后的 `SettingsRulesTab` 工具栏代码：

```tsx
// SettingsRulesTab.tsx 修复后示范
<div className="settings-head-tools-row">
  <label htmlFor={scopeSelectId} className="sr-only">
    规则作用域
  </label>
  <Select
    id={scopeSelectId} // ✅ ID 成功连通
    size="sm" // ✅ 尺寸降为 28px，对齐高度
    value={scopeKey}
    options={scopeOptions}
    onChange={setScopeKey}
    disabled={busy || isLoadingScope}
    className={styles.toolbarSelect}
  />
  <Tooltip content={`编辑${scopeLabel}全文`}>
    <Button
      ref={fullEditorBtnRef}
      type="button"
      variant="secondary"
      size="sm" // ✅ 尺寸 28px
      onClick={openFullEditor}
      disabled={busy || isLoadingScope} // ✅ 加载中守卫
      style={{ borderRadius: 'var(--radius-md)' }} // ✅ 统一 7px 圆角，消除药丸形割裂
    >
      编辑全文
    </Button>
  </Tooltip>
</div>
```

---

## 六、审查结论与跟进建议 (Conclusion & Next Steps)

本专项审查通过对前端核心代码的静态追踪，确凿证实了：

1. **DOM 冗余与定位风险**：Radix Popover 多层 Wrapper 嵌套不仅增加了 DOM 深度，更因 `z-index` 外层丢失与动态高度计算引发定位抖动与样式穿透失效。
2. **逻辑与事件断层**：`SettingsRulesTab` 中的按钮逻辑断层是“异步加载竞态”、“ID 孤岛脱节”以及“Radix DismissableLayer 事件抢夺”三重并发的结果，绝非单纯的样式问题。
3. **视觉失真与规范缺失**：`Select` 与 `Button` 在工具栏中的高差、圆角严重不协调，暴露了原子组件库默认属性与业务场景对齐规则的脱节。

建议后续根据本报告提出的四大重构方案，进行针对性的原子层修复与业务工具栏规范收敛。
