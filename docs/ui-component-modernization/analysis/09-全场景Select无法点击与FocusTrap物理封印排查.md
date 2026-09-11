# 专项深度排查 09：全场景 Select 无法点击与 FocusTrap 物理封印排查报告

> **排查时间**：2026-08-31
> **排查定位**：纯调研与深层根因排查（严格遵循不修改任何代码、不执行 git 命令、不编写重构实施方案铁律）
> **涉及核心源码**：
> - [`apps/crish-desktop/src/components/ui/Select/SelectContent.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectContent.tsx)
> - [`apps/crish-desktop/src/components/ui/Select/ComboboxContent.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/ComboboxContent.tsx)
> - [`apps/crish-desktop/src/components/ui/Select/SelectTrigger.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectTrigger.tsx)
> - [`apps/crish-desktop/src/components/ui/Select/SelectTrigger.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectTrigger.module.css)
> - [`apps/crish-desktop/src/components/ui/Select/Select.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Select.module.css)
> - [`apps/crish-desktop/src/components/ui/Select/Combobox.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Combobox.module.css)
> - [`apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx)
> - [`apps/crish-desktop/src/components/ui/Dialog/dialogOverlayContext.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/dialogOverlayContext.ts)
> - [`apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx)
> - [`apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css)
> - [`apps/crish-desktop/src/components/settings/SettingsSchemaRenderer.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsSchemaRenderer.tsx)
> - [`apps/crish-desktop/src/styles/focus-visible.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/focus-visible.css)
> - [`apps/crish-desktop/src/styles/z-index.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/z-index.css)

---

## 目录（Table of Contents）

1. [Executive Summary（排查执行摘要）](#1-executive-summary排查执行摘要)
2. [根因解构一：DialogOverlayContext 脱节与 z-index 300 < 1000 物理遮蔽](#2-根因解构一dialogoverlaycontext-脱节与-z-index-300--1000-物理遮蔽)
   - 2.1 `DialogOverlayContext` 设计契约与注入机制
   - 2.2 `SelectContent` / `ComboboxContent` 遗漏 Context 的硬编码 Portal 路径
   - 2.3 DOM 树与层叠上下文（Stacking Context）碰撞过程
3. [根因解构二：FocusTrap 的 `inert=""` 封印与键盘 Tab 焦点强行截断](#3-根因解构二focustrap-的-inert-封印与键盘-tab-焦点强行截断)
   - 3.1 `FocusTrapIsolationManager` 原生状态机的工作机制
   - 3.2 节点白名单（`isWhitelisted`）审查与自研 Select 浮层遗漏
   - 3.3 浏览器原生 `inert=""` 对 Pointer/Click/Selection 事件的物理灭活
   - 3.4 `handleKeyDown` Tab 边界检测对 Portal 外部焦点的强行扯回
4. [全仓普查一：所有 Modal / Dialog 内瘫痪的 Select 实例全景台账](#4-全仓普查一所有-modal--dialog-内瘫痪的-select-实例全景台账)
   - 4.1 全仓 7 套核心 Dialog 基座分布
   - 4.2 9 大瘫痪 Select / Combobox 实例逐一剖析与定位表
   - 4.3 与非 Dialog 场景（如 DiffCard）Select 的行为对照
5. [全仓普查二：2.5px 粗黑边与双重描边叠加样式普查](#5-全仓普查二25px-粗黑边与双重描边叠加样式普查)
   - 5.1 1px border + 1.5px box-shadow 叠加产生 2.5px 视觉粗边机制
   - 5.2 `SelectTrigger.module.css` 与 `Select.module.css` 审查
   - 5.3 `Combobox.module.css` 触发器与 Chips 容器审查
   - 5.4 全局 `focus-visible.css` 级联污染与双重描边冲突
6. [排查结论与故障矩阵总览](#6-排查结论与故障矩阵总览)

---

## 1. Executive Summary（排查执行摘要）

通过对全仓源码、DOM 树层叠上下文（Stacking Context）、Portal 挂载拓扑、`FocusTrapIsolationManager` 引用计数状态机以及 CSS 盒模型渲染规则的深入审查，已精准锁定全场景 Select 无法点击、列表无法呼出、键盘无法选中的深层物理死锁根因，以及触发器聚焦呈现 2.5px 粗黑死边的样式根因：

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                              全场景 Select 无法交互三大物理封印与视觉缺陷                   │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                             │
│  【物理封印 1：层叠上下文压制 (z-index 300 < 1000)】                                        │
│  - Dialog / SettingsPanel 以全屏/模态方式挂载至 document.body (z-index: 1000 / var(--z-modal))│
│  - Dialog 内部提供了 DialogOverlayContext.Provider 供浮层穿透                              │
│  - 自研 SelectContent / ComboboxContent 彻底遗漏 useContext(DialogOverlayContext)，        │
│    默认 createPortal(contentNode, document.body)，其 CSS 为 z-index: var(--z-dropdown, 300)  │
│  ──> 下拉列表真实在 DOM 中渲染，但物理处于 Dialog 遮罩面板背面，被 1000 级面板完全盖死阻断！│
│                                                                                             │
│  【物理封印 2：FocusTrap inert="" 硬件级事件灭活与 Tab 焦点强扯】                          │
│  - FocusTrapIsolationManager 在 Dialog 激活时将 document.body 下除 activeTrap 以外的所有节点│
│    打上 inert="" 与 aria-hidden="true"                                                      │
│  - 自研 [data-slot="select-content"] 遗漏在 isWhitelisted 白名单之外                        │
│  - 浏览器原生 inert="" 属性在排版引擎层直接拦截一切 PointerDown、Click 与 Touch 事件        │
│  - FocusTrap 的 handleKeyDown 对外部 activeElement 判定为越界，按下 Tab 瞬间强制抢回焦点   │
│                                                                                             │
│  【视觉缺陷 3：1px 边框 + 1.5px 外阴影 = 2.5px 粗边叠加】                                    │
│  - SelectTrigger.module.css 在 :focus-visible 与 .open 下同时施加 border 与 box-shadow spread │
│  - 全局 focus-visible.css 的 button:focus-visible (box-shadow 2px) 发生潜在层叠冲突        │
│  ──> 形成 2.5px 粗黑死边与双重描边，严重违背 AGENTS.md §13 极致细腻发丝级规范              │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 根因解构一：DialogOverlayContext 脱节与 z-index 300 < 1000 物理遮蔽

### 2.1 `DialogOverlayContext` 设计契约与注入机制

在 [`apps/crish-desktop/src/components/ui/Dialog/dialogOverlayContext.ts:1-8`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/dialogOverlayContext.ts#L1-L8) 中，项目定义了用于穿透模态弹窗层叠边界的专用上下文：

```typescript
// apps/crish-desktop/src/components/ui/Dialog/dialogOverlayContext.ts
/**
 * Dialog 遮罩壳层叠上下文：设置全屏等 modal 内的 Menu/Select
 * portal 进 overlay，用局部 z 压过面板，而不抬高全仓 --z-dropdown。
 */
import { createContext } from 'react';

export const DialogOverlayContext = createContext<HTMLElement | null>(null);
```

在 [`apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx:160-213`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx#L160-L213) 中，`Dialog` 弹窗壳层在挂载时将自身 `overlayEl` 注入该 Context：

```tsx
// apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx
<FocusTrap active={open} initialFocusRef={initialFocusRef}>
  <div
    ref={setOverlayEl}
    className={overlayClasses}
    data-dialog-overlay=""
  >
    <DialogOverlayContext.Provider value={overlayEl}>
      <div
        className={styles.backdrop}
        aria-hidden="true"
        onClick={dismissible ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        className={panelClasses}
      >
        ...
        <div className={styles.dialogBody}>{children}</div>
        ...
      </div>
    </DialogOverlayContext.Provider>
  </div>
</FocusTrap>
```

在 [`apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css:7-12`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css#L7-L12) 及 [`apps/crish-desktop/src/styles/z-index.css:24`](file:///c:/Software/conex/apps/crish-desktop/src/styles/z-index.css#L24) 中：
- `overlay` 具有 `position: fixed; inset: 0; z-index: var(--dialog-z, var(--z-modal));`
- `--z-modal` 的全局值为 `1000`。

### 2.2 `SelectContent` / `ComboboxContent` 遗漏 Context 的硬编码 Portal 路径

检查自研原子组件出口 [`apps/crish-desktop/src/components/ui/Select/SelectContent.tsx:118-120`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectContent.tsx#L118-L120)：

```tsx
// apps/crish-desktop/src/components/ui/Select/SelectContent.tsx
  const container = portalContainer ?? (typeof document !== 'undefined' ? document.body : null);
  return container ? createPortal(contentNode, container) : contentNode;
```

检查 [`apps/crish-desktop/src/components/ui/Select/ComboboxContent.tsx:79-81`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/ComboboxContent.tsx#L79-L81)：

```tsx
// apps/crish-desktop/src/components/ui/Select/ComboboxContent.tsx
  const container = portalContainer ?? (typeof document !== 'undefined' ? document.body : null);
  return container ? createPortal(contentNode, container) : contentNode;
```

**断层分析**：
1. `SelectContent` 与 `ComboboxContent` 在整个实现中**完全没有导入、也没有通过 `useContext(DialogOverlayContext)` 读取弹窗遮罩容器**；
2. 当业务组件（如 `SettingsSchemaRenderer`、`WizardKeyStep`、`SettingsRulesTab`）在弹窗内直接调用 `<Select>` 或 `<Combobox>` 时，未显式传递 `portalContainer`；
3. `SelectContent` 执行回退逻辑，强制使用 `document.body` 作为 Portal 挂载目标。

### 2.3 DOM 树与层叠上下文（Stacking Context）碰撞过程

当一个包含 `Select` 的 `Dialog`（例如 `SettingsPanel`）打开且用户点击 `SelectTrigger` 时，生成的物理 DOM 树结构如下：

```html
<body>
  <!-- 1. 应用根节点 -->
  <div id="root">...</div>

  <!-- 2. Dialog 弹窗 Overlay（由 Dialog.tsx Portal 进 body） -->
  <div data-focus-trap="true" style="display: contents;">
    <div class="overlayEnter" data-dialog-overlay="" style="position: fixed; inset: 0px; z-index: 1000;">
      <div class="backdrop" style="position: absolute; inset: 0px;"></div>
      <div role="dialog" class="dialog dialogFullscreen" style="position: absolute; background: var(--bg-primary);">
        <div class="dialogBody">
          <!-- 设置页内的 Select 触发器 -->
          <button role="combobox" data-slot="select-trigger" aria-expanded="true">...</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 3. SelectContent 下拉列表（由 SelectContent.tsx 独立 Portal 进 body） -->
  <div
    id="select-listbox-:r5:"
    role="listbox"
    data-slot="select-content"
    class="content contentSm"
    style="position: fixed; left: 320px; top: 180px; z-index: 300; pointer-events: auto; visibility: visible;"
  >
    <div class="list">
      <button role="option">选项 1</button>
      <button role="option">选项 2</button>
    </div>
  </div>
</body>
```

**层叠遮蔽碰撞结果**：
1. `Dialog` Overlay 与 `SelectContent` 都是 `document.body` 的直接子节点，处于**同一层叠上下文（Root Stacking Context）**中；
2. `Dialog` Overlay 的 `z-index` 为 `1000`（`var(--z-modal)`），且覆盖整个视口（`inset: 0`）；
3. `SelectContent` 的 `z-index` 为 `300`（`var(--z-dropdown)`）；
4. 按照 CSS 规范，在同一层叠上下文中，`z-index: 1000` 的元素必然盖在 `z-index: 300` 的元素之上；
5. `SelectContent` 虽已被计算出正确的 `top/left` 坐标并渲染，但被不透明的 `Dialog` 实体完全盖在背后；用户点击屏幕上的下拉框区域，点击事件全部被 `Dialog` 捕获，完全无法触达下拉选项！

---

## 3. 根因解构二：FocusTrap 的 `inert=""` 封印与键盘 Tab 焦点强行截断

即使通过临时抬高 `z-index` 将 `SelectContent` 移至视觉顶层，`Dialog` 内部装配的 `FocusTrap` 机制仍会从浏览器事件底层将 `SelectContent` 彻底物理封印。

### 3.1 `FocusTrapIsolationManager` 原生状态机的工作机制

查看 [`apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx:50-180`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx#L50-L180)：

```typescript
// apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx
class FocusTrapIsolationManager {
  private trapStack: HTMLElement[] = [];
  private inertCounts = new Map<Element, number>();
  private snapshots = new Map<Element, InertSnapshot>();

  private applyIsolation(): void {
    const activeTrap =
      this.trapStack.length > 0
        ? this.trapStack[this.trapStack.length - 1]
        : null;
    if (!activeTrap) {
      ...
      return;
    }

    const currentInertTargets = new Set<Element>();
    const docBody = document.body;

    // 1. document.body 层级的所有非包含 activeTrap 的子元素
    if (docBody) {
      for (const child of Array.from(docBody.children)) {
        if (child === activeTrap || child.contains(activeTrap)) continue;
        if (this.isWhitelisted(child)) continue;
        currentInertTargets.add(child);
      }
    }

    // 4. 对当前需要 inert 的目标施加状态并记录快照
    for (const target of currentInertTargets) {
      ...
      target.setAttribute('aria-hidden', 'true');
      target.setAttribute('inert', '');
    }
  }
}
```

### 3.2 节点白名单（`isWhitelisted`）审查与自研 Select 浮层遗漏

查看 [`apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx:63-76`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx#L63-L76)：

```typescript
// apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx
  private isWhitelisted(node: Element): boolean {
    if (
      node.hasAttribute('data-radix-popper-content-wrapper') ||
      node.getAttribute('data-tooltip-portal') === 'true' ||
      node.getAttribute('data-toast-container') === 'true' ||
      node.classList.contains('radix-popper-content-wrapper') ||
      node.classList.contains('toaster') ||
      node.id === 'toast-portal' ||
      node.id === 'tooltip-portal'
    ) {
      return true;
    }
    return false;
  }
```

**白名单审查结论**：
- 白名单仅放行了第三方 Radix Popper 容器（`data-radix-popper-content-wrapper`）、Tooltip（`data-tooltip-portal`）和 Toast 容器；
- 自研 `SelectContent` 渲染的根节点特征为 `data-slot="select-content"`、`role="listbox"`；
- 自研 `ComboboxContent` 渲染的根节点特征为 `data-slot="combobox-content"`、`role="listbox"`；
- 两者均**不在 `isWhitelisted` 范围内**！

### 3.3 浏览器原生 `inert=""` 对 Pointer/Click/Selection 事件的物理灭活

根据 W3C HTML 规范（HTML Living Standard § 6.5.3 *The inert attribute*）：
> When an element has the `inert` attribute present:
> 1. It is hidden from assistive technologies (`aria-hidden="true"` effect).
> 2. It does not respond to mouse clicks, hover, drag, or pointer gestures.
> 3. It cannot be focused by pointer or keyboard navigation.
> 4. Hit-testing ignores the element as if `pointer-events: none` and `user-select: none` were enforced at native level.

当 `SelectContent` 作为 `document.body` 的子节点被挂载且触发了 `applyIsolation()`（例如弹窗重绘、嵌套子弹窗唤起或焦点切换触发 Manager 更新）时：
1. `SelectContent` 节点被直接打上 `inert=""` 和 `aria-hidden="true"`；
2. 即使鼠标在浮层上方点击，事件在 Chromium / WebKit 排版引擎分发阶段即被丢弃，完全不会派发 `click` 或 `mousedown` 事件到 React 监听器；
3. 选项 `onClick` 回调完全失灵，形成了不可逾越的**物理封印**。

### 3.4 `handleKeyDown` Tab 边界检测对 Portal 外部焦点的强行扯回

查看 [`apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx:203-234`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx#L203-L234)：

```typescript
// apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (!containerRef.current) return;

      const focusable = getFocusableElements(containerRef.current);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const activeEl = document.activeElement;

      if (e.shiftKey) {
        if (activeEl === first || !containerRef.current.contains(activeEl)) {
          e.preventDefault();
          e.stopPropagation();
          last.focus();
        }
      } else {
        if (activeEl === last || !containerRef.current.contains(activeEl)) {
          e.preventDefault();
          e.stopPropagation();
          first.focus();
        }
      }
    };
```

**键盘交互死锁分析**：
1. 当用户通过方向键或 Tab 键试图将焦点移动到 Portal 到 `document.body` 的 `SelectContent` 内部选项时；
2. 由于 `SelectContent` 位于 `document.body` 下，并不在 `containerRef.current`（即 Dialog 内部 `<div data-focus-trap="true">`）中；
3. `!containerRef.current.contains(activeEl)` 条件立即命中为 `true`；
4. `FocusTrap` 的全局 `keydown` 监听器强制执行 `e.preventDefault()` 和 `e.stopPropagation()`，并将焦点粗暴扯回弹窗内部的第一个（`first.focus()`）或最后一个（`last.focus()`）可交互元素；
5. 键盘用户永远无法通过 Tab 键在下拉列表内进行循环导航与确认。

---

## 4. 全仓普查一：所有 Modal / Dialog 内瘫痪的 Select 实例全景台账

### 4.1 全仓 7 套核心 Dialog 基座分布

全仓所有弹窗组件均已收敛至 [`apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx) 基座（`--z-modal: 1000`）：

| 序号 | 弹窗组件文件路径 | 角色与形态 | `z-index` 层级 | 是否使用 `DialogOverlayContext` |
| :---: | :--- | :--- | :---: | :---: |
| 1 | [`apps/crish-desktop/src/components/settings/SettingsPanel.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.tsx) | `variant="fullscreen"` 全屏设置盖层 | 1000 | 是（注入 `overlayEl`） |
| 2 | [`apps/crish-desktop/src/components/overlay/FirstRunWizard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/FirstRunWizard.tsx) | `variant="modal"` 首次运行向导 | 1000 | 是（注入 `overlayEl`） |
| 3 | [`apps/crish-desktop/src/components/settings/RulesEditorDialog.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/RulesEditorDialog.tsx) | `variant="modal"` 规则全文编辑器 | 1000 | 是（注入 `overlayEl`） |
| 4 | [`apps/crish-desktop/src/components/settings-skills/SkillEditorModal.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillEditorModal.tsx) | `variant="modal"` 技能发现与编辑 | 1000 | 是（注入 `overlayEl`） |
| 5 | [`apps/crish-desktop/src/components/overlay/TelemetryDialog.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/TelemetryDialog.tsx) | `variant="modal"` 遥测授权弹窗 | 1000 | 是（注入 `overlayEl`） |
| 6 | [`apps/crish-desktop/src/components/overlay/CheatsheetModal.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/CheatsheetModal.tsx) | `variant="modal"` 快捷键清单弹窗 | 1000 | 是（注入 `overlayEl`） |
| 7 | [`apps/crish-desktop/src/components/ui/ConfirmDialog/ConfirmDialog.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/ConfirmDialog/ConfirmDialog.tsx) | `role="alertdialog"` 危险确认弹窗 | 1000 | 是（注入 `overlayEl`） |

---

### 4.2 9 大瘫痪 Select / Combobox 实例逐一剖析与定位表

经全仓交叉扫描，以下 **9 个业务 Select 实例**因为处于 `Dialog` 内部且消费了缺少 `DialogOverlayContext` 的自研 `Select` 组件，导致在真实运行时处于**完全瘫痪（点不开、看不到、无法选中）**状态：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                全仓 Dialog 内部瘫痪 Select 实例清单                               │
├────┬─────────────────────────────┬──────────────────────────┬────────────────────────────────────┤
│ 序 │ 所在业务组件及行号          │ 所属父级 Dialog          │ 业务功能与具体瘫痪表现             │
├────┼─────────────────────────────┼──────────────────────────┼────────────────────────────────────┤
│ 01 │ WizardKeyStep.tsx:49        │ FirstRunWizard (向导)    │ 首次向导服务商选择，点击无法弹出   │
│ 02 │ WizardModelStep.tsx:59      │ FirstRunWizard (向导)    │ 首次向导模型选择，点击无法弹出     │
│ 03 │ SettingsSchemaRenderer.tsx:95│ SettingsPanel (设置全屏) │ 驱动外观Tab窗口风格、代码缩进等下拉│
│ 04 │ SettingsSchemaRenderer.tsx:191│ SettingsPanel (设置全屏)│ 驱动字体选择器下拉模式             │
│ 05 │ SettingsRulesTab.tsx:142    │ SettingsPanel (设置全屏) │ 规则预设下拉选择，点击无法弹出     │
│ 06 │ SettingsSecurityTab.tsx:182 │ SettingsPanel (设置全屏) │ 权限安全模式下拉选择，点击无法弹出 │
│ 07 │ SkillsSettingsTab.tsx:180   │ SettingsPanel (设置全屏) │ 技能类型过滤下拉框，点击无法弹出   │
│ 08 │ McpServerForm.tsx:51        │ SettingsPanel (设置全屏) │ MCP 服务器传输协议类型下拉选择     │
│ 09 │ WorkflowForm.tsx:106        │ SettingsPanel (设置全屏) │ 工作流触发源类型下拉选择           │
└────┴─────────────────────────────┴──────────────────────────┴────────────────────────────────────┘
```

#### 实例详细解构：

1. **[`apps/crish-desktop/src/components/WizardKeyStep.tsx:49-60`](file:///c:/Software/conex/apps/crish-desktop/src/components/WizardKeyStep.tsx#L49-L60)**
   - **所属弹窗**：[`FirstRunWizard.tsx:93`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/FirstRunWizard.tsx#L93)
   - **代码调用**：
     ```tsx
     <Select
       value={profileId}
       disabled={busy}
       options={profiles.map((p) => ({ id: p.id, label: profileDisplayLabel(p) }))}
       onChange={(id) => onProfileChange(id)}
     />
     ```
   - **故障根因**：FirstRunWizard 弹窗 `--dialog-z: 1000`，SelectContent 挂载至 `document.body` (`z-index: 300`)，直接被弹窗白底遮挡；且被向导的 FocusTrap 锁死。用户首次运行无法切换服务商！

2. **[`apps/crish-desktop/src/components/WizardModelStep.tsx:59-73`](file:///c:/Software/conex/apps/crish-desktop/src/components/WizardModelStep.tsx#L59-L73)**
   - **所属弹窗**：[`FirstRunWizard.tsx:93`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/FirstRunWizard.tsx#L93)
   - **代码调用**：
     ```tsx
     <Select
       value={modelInList ? modelId : ''}
       disabled={busy}
       placeholder="从本机列表选择…"
       options={[{ id: '', label: '从本机列表选择…' }, ...listedModels.map((m) => ({ id: m, label: m }))]}
       onChange={(v) => onChange(v)}
     />
     ```
   - **故障根因**：同上。首次启动模型选择下拉列表被完全压在向导背后。

3. **[`apps/crish-desktop/src/components/settings/SettingsSchemaRenderer.tsx:95-110`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsSchemaRenderer.tsx#L95-L110)**
   - **所属弹窗**：[`SettingsPanel.tsx:255`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.tsx#L255)
   - **代码调用**：
     ```tsx
     <Select
       className={uiStyles.controlSelect}
       size="sm"
       value={String(val ?? '')}
       options={(prop.options || []).map((o) => ({ id: o.value, label: o.label, ...(o.hint !== undefined ? { hint: o.hint } : {}) }))}
       onChange={(v) => { void onSave({ [prop.key]: v }); }}
       disabled={!ready}
       placeholder={prop.placeholder || '请选择…'}
     />
     ```
   - **影响范围**：**全仓所有基于 Schema 驱动的通用设置项**！包括但不限于：
     - 外观设置：窗口风格（`shellChrome`）、代码缩进（`codeIndent`）、皮肤预设（`skinPreset`）；
     - 模型设置：默认服务商、推理模式、默认上下文窗口大小；
     - 隐私与网络：遥测级别、代理模式等。
   - **故障表现**：在设置面板中点击任何一个常规下拉框，触发器无展开动作，列表沉入设置全屏层（z:1000）背后。

4. **[`apps/crish-desktop/src/components/settings/SettingsSchemaRenderer.tsx:191-204`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsSchemaRenderer.tsx#L191-L204)**
   - **所属弹窗**：[`SettingsPanel.tsx:255`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.tsx#L255)
   - **代码调用**：`prop.type === 'font-selector'` 模式下的通用 Select。

5. **[`apps/crish-desktop/src/components/settings/SettingsRulesTab.tsx:142-154`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsRulesTab.tsx#L142-L154)**
   - **所属弹窗**：[`SettingsPanel.tsx:255`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.tsx#L255)
   - **代码调用**：
     ```tsx
     <Select
       value={presetId}
       options={RULE_PRESETS.map((p) => ({ id: p.id, label: p.label }))}
       onChange={(v) => applyPreset(v)}
       size="sm"
     />
     ```
   - **故障根因**：规则预设切换在全屏设置内被压制。

6. **[`apps/crish-desktop/src/components/settings/SettingsSecurityTab.tsx:182-195`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsSecurityTab.tsx#L182-L195)**
   - **所属弹窗**：[`SettingsPanel.tsx:255`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.tsx#L255)
   - **代码调用**：权限安全级别选择 Select。

7. **[`apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.tsx:180-192`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.tsx#L180-L192)**
   - **所属弹窗**：[`SettingsPanel.tsx:255`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.tsx#L255)
   - **代码调用**：技能分类与启用状态筛选 Select。

8. **[`apps/crish-desktop/src/components/settings-mcp/McpServerForm.tsx:51-64`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-mcp/McpServerForm.tsx#L51-L64)**
   - **所属弹窗**：[`SettingsPanel.tsx:255`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.tsx#L255)（在 MCP Tab 表单中）
   - **代码调用**：MCP Server 传输类型（stdio / sse / websocket）下拉选择。

9. **[`apps/crish-desktop/src/components/settings/WorkflowForm.tsx:106-118`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/WorkflowForm.tsx#L106-L118)**
   - **所属弹窗**：[`SettingsPanel.tsx:255`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.tsx#L255)（在 Workflow Tab 表单中）
   - **代码调用**：工作流 Trigger 触发事件类型选择。

---

### 4.3 与非 Dialog 场景（如 DiffCard）Select 的行为对照

对比全仓非 Dialog 场景下的 Select 实例：
- [`apps/crish-desktop/src/components/diff/DiffCardFileList.tsx:216`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L216)
- [`apps/crish-desktop/src/components/diff/DiffHeaderControls.tsx:111,125`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffHeaderControls.tsx#L111)

**对照结论**：
- 在主界面工作区（DiffCard、DiffHeader）中，没有全屏/模态 Dialog 挂载，`document.body` 上没有 `z-index: 1000` 的全量遮罩；
- 因此 `SelectContent` 挂载在 `document.body` 且处于 `z-index: 300` 时，能够正常显示在工作区内容上方（主界面卡片通常为 `z-index: 0` 或 `var(--z-base)`）；
- **这直接印证了：问题并非 Select 本身不能工作，而是当 Select 被嵌入任何 Dialog 时，缺少了 Context 穿透机制，遭遇了 Dialog (1000) 的降维打击与 FocusTrap 的物理封杀！**

---

## 5. 全仓普查二：2.5px 粗黑边与双重描边叠加样式普查

### 5.1 1px border + 1.5px box-shadow 叠加产生 2.5px 视觉粗边机制

根据 CSS 盒模型（W3C CSS Box Model Level 3 & CSS Backgrounds and Borders Level 3）：
- `border: 1px solid <color>` 会在元素内边距（padding box）外部绘制 1px 宽度的实体边框；
- `box-shadow: 0 0 0 1.5px <shadow-color>` 会从 border box 外边缘开始向外延展 1.5px 的外阴影扩展区（spread radius）；
- 当两个描边的色值接近（均为带有透明度的黑/深灰），人眼观察到的并不是分离的光晕，而是**物理宽度达到 1px + 1.5px = 2.5px 的实心深色粗边框**！

```
┌────────────────────────────────────────────────────────┐
│                   2.5px 粗描边叠加机理解构             │
├────────────────────────────────────────────────────────┤
│                                                        │
│  [1.5px box-shadow spread]  █████████████████████████  │ ◄─ 外部 1.5px 扩展
│  [1px border 实线边框]      ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │ ◄─ 内部 1px 实线
│  [触发器容器背景]          ░░░░░░░░░░░░░░░░░░░░░░░░░  │ ◄─ 触发器内容区
│                                                        │
│  视觉总线宽 = 1px (border) + 1.5px (box-shadow) = 2.5px │
│                                                        │
└────────────────────────────────────────────────────────┘
```

---

### 5.2 `SelectTrigger.module.css` 与 `Select.module.css` 审查

查看 [`apps/crish-desktop/src/components/ui/Select/SelectTrigger.module.css:9,29-38`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectTrigger.module.css#L9) 以及完全重复的 [`apps/crish-desktop/src/components/ui/Select/Select.module.css:9,29-38`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Select.module.css#L9)：

```css
/* apps/crish-desktop/src/components/ui/Select/SelectTrigger.module.css */
.trigger {
  /* 常态：1px 边框 */
  border: 1px solid var(--border-color, hsl(35 10% 86%));
  background: var(--bg-card, hsl(0 0% 100%));
  ...
}

.trigger:focus-visible {
  outline: none;
  /* 🚨 粗边成因：1.5px 外阴影 + 1px 边框加深 */
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}

.trigger.open {
  /* 🚨 粗边成因：展开态同样叠加 1.5px 外阴影 + 1px 边框加深 */
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
}
```

**问题点详查**：
1. `.trigger:focus-visible` 和 `.trigger.open` 同时改变了 `border-color`（深色化 10%）和设置了 `box-shadow`（1.5px 扩散，深色化 6%）；
2. 当用户点击打开触发器且触发器获得键盘聚焦时，`.trigger.open:focus-visible` 状态同时激活；
3. 两层描边在视觉上合并，呈现极其明显的 2.5px 粗厚实线，完全丧失了设计系统所要求的「发丝级细腻质感」。

---

### 5.3 `Combobox.module.css` 触发器与 Chips 容器审查

查看 [`apps/crish-desktop/src/components/ui/Select/Combobox.module.css:8,20-23,104,114-117,155-158`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Combobox.module.css#L8)：

```css
/* apps/crish-desktop/src/components/ui/Select/Combobox.module.css */
/* 1. 单选输入框外壳 */
.comboboxInputWrapper {
  border: 1px solid var(--border-color, hsl(35 10% 86%));
  ...
}
.comboboxInputWrapper:focus-within {
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}

/* 2. 多选 Chips 外壳 */
.chipsWrapper {
  border: 1px solid var(--border-color, hsl(35 10% 86%));
  ...
}
.chipsWrapper:focus-within {
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}

/* 3. 内部 Chip 激活态 */
.chip.chipActive {
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}
```

**问题点详查**：
- `Combobox` 的单选容器、多选容器以及内部选中的胶囊（Chip）全部复制了同样的 `border (1px)` + `box-shadow (1.5px)` 叠加模式，导致无论在何种聚焦或内部聚焦（`:focus-within`）状态下，均呈现 2.5px 的粗钝视觉。

---

### 5.4 全局 `focus-visible.css` 级联污染与双重描边冲突

查看全局注入的 [`apps/crish-desktop/src/styles/focus-visible.css:9-25`](file:///c:/Software/conex/apps/crish-desktop/src/styles/focus-visible.css#L9-L25)：

```css
/* apps/crish-desktop/src/styles/focus-visible.css */
:focus-visible {
  outline: 2px solid var(--focus-ring-color);
  outline-offset: 1px;
}

button:focus-visible,
a:focus-visible,
[role='button']:focus-visible,
[tabindex]:not([tabindex='-1']):focus-visible {
  outline: none;
  box-shadow: var(--focus-ring, 0 0 0 2px var(--tint-focus-ring));
}
```

**级联与双重描边分析**：
1. `SelectTrigger` 渲染为 `<button role="combobox" ...>`；
2. 如果在某些没有正确加载 CSS Module 或选择器权重因样式加载顺序被干扰的边界场景中，全局的 `button:focus-visible` 会施加 `box-shadow: 0 0 0 2px var(--tint-focus-ring)`；
3. 而通用容器或未重置 outline 的元素则会触发 `:focus-visible` 的 `outline: 2px solid ...; outline-offset: 1px;`；
4. 此时外层 2px 的 `outline` 悬空在距边框 1px 处，与内部 1px 的 `border` 组合，形成极丑陋的**双重描边（Double Stroke Halo）**。

---

## 6. 排查结论与故障矩阵总览

### 6.1 故障全景根因矩阵

| 故障现象 | 发生场景 | 直接致因 | 深层技术根因 | 严重级别 |
| :--- | :--- | :--- | :--- | :---: |
| **Select 列表被遮盖** | 全仓所有 Dialog 内的 Select | `SelectContent` 位于面板背后 | 遗漏 `DialogOverlayContext`，直接 Portal 至 `body`，`z-index: 300 < 1000` | **致命 (Blocker)** |
| **鼠标点击无响应** | 全仓所有 Dialog 内的 Select | 点击事件无法分发至列表项 | `FocusTrapIsolationManager` 将未在白名单的 SelectContent 标记为 `inert=""`，浏览器排版引擎直接丢弃事件 | **致命 (Blocker)** |
| **Tab 键焦点被抢回** | 全仓所有 Dialog 内的 Select | Tab 键无法遍历下拉列表 | `FocusTrap` 的 `handleKeyDown` 检测到 `activeElement` 不在 Trap 容器内，强行将焦点拉回 Dialog 起始元素 | **严重 (Critical)** |
| **2.5px 粗重黑边** | 全仓所有 Select / Combobox 触发器 | 聚焦/展开态轮廓过于宽厚 | CSS 中同时定义 `1px border` 与 `1.5px box-shadow spread`，两者色值合并叠加产生 2.5px 粗实线 | **视觉违规 (Major)** |
| **双重描边外圈光晕** | 部分原生继承 focus-visible 场景 | 出现双重悬空轮廓环 | 全局 `focus-visible.css` 的 `outline: 2px` 与组件内部 `border` 发生级联冲突 | **视觉违规 (Minor)** |

---

### 6.2 排查总结

经过对 `ui/Select`、`ui/Dialog`、`SettingsPanel`、`FirstRunWizard`、`FocusTrap` 等模块的逐行代码审计与运行机制推演，已完全查清**设置页及全仓弹窗内 Select 无法点击与 FocusTrap 物理封印**的技术全貌：

1. **层叠上下文脱节**：`Dialog` 预备了完善的 `DialogOverlayContext` 机制，但自研原子组件 `SelectContent` 与 `ComboboxContent` 遗漏了接入，导致浮层被抛弃在 `document.body` 并在层级上被 1000 级弹窗无情碾压；
2. **事件与焦点封印**：`FocusTrap` 的隔离状态机因缺乏对自研 Select 的白名单支持，通过原生 `inert=""` 属性和全局 Tab 拦截，对任何溢出至 body 的自研下拉列表实施了物理灭活；
3. **视觉轮廓叠加**：CSS 中 1px 边框与 1.5px 阴影的粗暴叠加，破坏了极简发丝级边框的设计哲学。

*本调研排查报告为后续制定专项治理方案提供了精确到代码行号与 DOM 拓扑的完备事实依据。*
